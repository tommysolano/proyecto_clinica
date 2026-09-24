#!/usr/bin/env node
'use strict';

/**
 * Completa proyecciones históricas que no son asientos contables:
 *
 * - cobros/pagos de Contífico -> Payment (sin recrear asientos),
 * - roles de pago -> Employee + Payroll (sin recrear asientos),
 * - stock por bodega -> InventoryLayer de apertura, y
 * - notas de crédito/débito -> CreditDebitNote.
 *
 * La extracción original guarda el JSON íntegro en ContificoRecord; este script
 * solo proyecta esa copia. Es idempotente y no toca registros manuales.
 *
 *   node scripts/projectContificoSupplemental.js --clinic-name=Central
 *   node scripts/projectContificoSupplemental.js --clinic-name=Central --commit
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const ContificoRecord = require('../models/ContificoRecord');
const ContificoMigrationRun = require('../models/ContificoMigrationRun');
const Payment = require('../models/Payment');
const Sale = require('../models/Sale');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const BankAccount = require('../models/BankAccount');
const Employee = require('../models/Employee');
const Payroll = require('../models/Payroll');
const InventoryLayer = require('../models/InventoryLayer');
const Product = require('../models/Product');
const Invoice = require('../models/Invoice');
const CreditDebitNote = require('../models/CreditDebitNote');
const { parseDate, fmt } = require('./migrateContifico');
const { decodeCompressedJson } = require('../utils/compressedJson');

const num = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const r2 = (value) => +num(value).toFixed(2);
const idType = (id) => /^\d{13}$/.test(String(id)) ? 'RUC' : (/^\d{10}$/.test(String(id)) ? 'CEDULA' : 'PASAPORTE');
const splitName = (value) => {
  const parts = String(value || '').trim().split(/\s+/).filter(Boolean);
  return parts.length < 2
    ? { firstName: parts[0] || 'SIN NOMBRE', lastName: 'CONTIFICO' }
    : { firstName: parts.slice(0, -1).join(' '), lastName: parts.at(-1) };
};
const mapPaymentMethod = (value) => ({
  CAJA: 'EFECTIVO', TC: 'TARJETA', TRANSF: 'TRANSFERENCIA', CHEQUE: 'CHEQUE',
}[String(value || '').trim().toUpperCase()] || 'OTRO');
const payrollPeriod = (value) => ({ P: 'QUINCENA_1', S: 'CIERRE_MES', M: 'MENSUAL' }[String(value || '').toUpperCase()] || null);
const noteKind = (value) => ({ NCT: 'NC', DNA: 'ND', DAC: 'ND' }[String(value || '').toUpperCase()] || null);
const status = (row) => row?.anulado ? 'ANULADA' : (row?.autorizado_sri ? 'AUTORIZADO' : 'REGISTRADA');
const snapshotEntities = {
  documents: 'document', transactions: 'transaction', bank_movements: 'bank_movement',
  inventory_movements: 'inventory_movement', journal_entries: 'journal_entry',
};

function args(argv) {
  const values = {}, flags = new Set();
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const at = arg.indexOf('=');
    if (at < 0) flags.add(arg.slice(2)); else values[arg.slice(2, at)] = arg.slice(at + 1);
  }
  return {
    commit: flags.has('commit'),
    clinicId: values.clinic || null,
    clinicName: values['clinic-name'] || 'Central',
    cutoff: parseDate(values.cutoff) || new Date(),
    only: new Set(String(values.only || '').split(',').map((x) => x.trim()).filter(Boolean)),
  };
}

class SupplementalProjector {
  constructor({ clinic, commit, cutoff, only }) {
    this.clinic = clinic;
    this.commit = commit;
    this.cutoff = cutoff;
    this.only = only;
    this.stages = [];
    this.sourceSnapshot = null;
    this.snapshotEntities = new Set();
  }

  log(text) { console.log(`[contifico-supplemental] ${text}`); }
  stage(name) {
    const stage = { name, source: 0, projected: 0, created: 0, linked: 0, skipped: 0, warnings: 0, samples: [] };
    this.stages.push(stage);
    this.log(`inicio ${name}`);
    return stage;
  }
  warn(stage, record, message) {
    stage.warnings += 1;
    if (stage.samples.length < 20) stage.samples.push({ externalId: record.externalId, message });
  }
  finish(stage) {
    stage.status = stage.warnings ? 'COMPLETED_WITH_WARNINGS' : 'COMPLETED';
    this.log(`fin ${stage.name}: source=${stage.source} created=${stage.created} linked=${stage.linked} projected=${stage.projected} skipped=${stage.skipped} warnings=${stage.warnings}`);
  }
  async records(entity) {
    const filter = { clinic: this.clinic._id, entity };
    if (this.sourceSnapshot && this.snapshotEntities.has(entity)) filter.migrationRun = this.sourceSnapshot._id;
    const rows = await ContificoRecord.find(filter).sort({ externalId: 1 }).lean();
    return rows.map((record) => ({ ...record, payload: decodeCompressedJson(record.payloadCompressed) }));
  }
  async initialize() {
    this.sourceSnapshot = await ContificoMigrationRun.findOne({
      clinic: this.clinic._id, phase: 'EXTRACT', status: { $in: ['COMPLETED', 'COMPLETED_WITH_WARNINGS'] },
    }).sort({ completedAt: -1, createdAt: -1 }).lean();
    for (const stage of this.sourceSnapshot?.stages || []) {
      if (stage.status === 'COMPLETED' && snapshotEntities[stage.name]) this.snapshotEntities.add(snapshotEntities[stage.name]);
    }
    if (this.sourceSnapshot) this.log(`instantánea fuente ${this.sourceSnapshot._id}: ${[...this.snapshotEntities].join(', ')}`);
  }
  link(record, model) {
    return (record?.projection?.links || []).find((link) => link.model === model)?.ref || null;
  }
  async mark(items) {
    if (!this.commit || !items.length) return;
    const now = new Date();
    for (let offset = 0; offset < items.length; offset += 500) {
      await ContificoRecord.bulkWrite(items.slice(offset, offset + 500).map((item) => ({ updateOne: {
        filter: { _id: item.record._id },
        update: { $set: { projection: { status: item.status, links: item.links || [], warnings: item.warnings || [], projectedAt: now } } },
      } })), { ordered: false });
    }
  }
  enabled(name) { return !this.only.size || this.only.has(name); }

  async transactions() {
    const stage = this.stage('transactions');
    const [records, documents, persons, sales, purchases, banks] = await Promise.all([
      this.records('transaction'), this.records('document'), this.records('person'),
      Sale.find({ clinic: this.clinic._id }).select('_id idempotencyKey').lean(),
      PurchaseInvoice.find({ clinic: this.clinic._id, sourceModel: 'ContificoRecord' }).select('_id sourceRef').lean(),
      BankAccount.find({ clinic: this.clinic._id }).select('_id chartAccount').lean(),
    ]);
    stage.source = records.length;
    const documentById = new Map(documents.map((record) => [record.externalId, record]));
    const personById = new Map(persons.map((record) => [record.externalId, record]));
    const saleByDocument = new Map(sales
      .filter((sale) => String(sale.idempotencyKey || '').startsWith('contifico:'))
      .map((sale) => [String(sale.idempotencyKey).slice('contifico:'.length), sale]));
    const purchaseBySource = new Map(purchases.map((purchase) => [String(purchase.sourceRef), purchase]));
    const bankByChartAccount = new Map(banks.filter((bank) => bank.chartAccount).map((bank) => [String(bank.chartAccount), bank._id]));
    const operations = [], marks = [];

    for (const record of records) {
      const row = record.payload;
      const date = parseDate(row.fecha_emision);
      const total = r2(row.total);
      const type = String(row.tipo || '').toUpperCase();
      if (!date || total <= 0 || !['C', 'P'].includes(type)) {
        stage.skipped += 1;
        this.warn(stage, record, 'Transacción sin fecha, total o tipo C/P válido');
        marks.push({ record, status: 'REVIEW', warnings: ['Transacción sin fecha, total o tipo C/P válido'] });
        continue;
      }
      const person = personById.get(String(row.persona_id || ''));
      const partyModel = type === 'C' ? 'Patient' : 'Supplier';
      const partyRef = type === 'C' ? this.link(person, 'Patient') : this.link(person, 'Supplier');
      const applications = [];
      let bankAccount = null;
      for (const detail of row.detalles || []) {
        const doc = documentById.get(String(detail.documento_id || ''));
        const amount = r2(detail.valor_pago);
        if (amount <= 0 || !doc) continue;
        const isSale = String(doc.payload.tipo_registro || '').toUpperCase() === 'CLI';
        const target = isSale ? saleByDocument.get(doc.externalId) : purchaseBySource.get(String(doc._id));
        if (target) applications.push({
          docModel: isSale ? 'Sale' : 'PurchaseInvoice', docRef: target._id,
          docNumber: String(doc.payload.documento || ''), amount,
        });
        if (!bankAccount && detail.cuenta_id) bankAccount = bankByChartAccount.get(String(detail.cuenta_id)) || null;
      }
      const key = `contifico:transaction:${record.externalId}`;
      const fields = {
        clinic: this.clinic._id, type: type === 'C' ? 'COBRO' : 'PAGO', number: `CTF-TX-${record.externalId}`,
        date, partyModel, partyRef: partyRef || null, partyName: String(person?.payload?.razon_social || person?.payload?.nombre_comercial || ''),
        partyId: String(person?.payload?.cedula || person?.payload?.ruc || ''), method: mapPaymentMethod(row.forma),
        bankAccount, reference: String(row.numero_comprobante || ''), total, applications,
        appliedAmount: r2(applications.reduce((sum, item) => sum + item.amount, 0)),
        advanceAmount: r2(Math.max(0, total - applications.reduce((sum, item) => sum + item.amount, 0))),
        description: `Importado de Contifico (${record.externalId})`, status: 'REGISTRADO', idempotencyKey: key,
      };
      operations.push({ updateOne: { filter: { clinic: this.clinic._id, idempotencyKey: key }, update: { $set: fields }, upsert: true } });
      marks.push({ record, status: 'PROJECTED', links: [{ model: 'Payment', action: 'UPSERT' }] });
      stage.projected += 1;
    }
    if (this.commit) for (let offset = 0; offset < operations.length; offset += 500) await Payment.bulkWrite(operations.slice(offset, offset + 500), { ordered: false });
    stage.created = operations.length;
    await this.mark(marks); this.finish(stage);
  }

  async payroll() {
    const stage = this.stage('payroll');
    const [people, roles, existingEmployees] = await Promise.all([
      this.records('person'), this.records('payroll_role'), Employee.find({ clinic: this.clinic._id }).select('_id identificacion').lean(),
    ]);
    const employees = people.filter((record) => record.payload.es_empleado && (record.payload.cedula || record.payload.ruc));
    const employeeById = new Map(existingEmployees.map((employee) => [String(employee.identificacion), employee]));
    const employeeOps = [];
    for (const record of employees) {
      const row = record.payload, identification = String(row.cedula || row.ruc || '');
      if (!identification || employeeById.has(identification)) continue;
      const names = splitName(row.razon_social || row.nombre_comercial || identification);
      employeeOps.push({ updateOne: { filter: { clinic: this.clinic._id, identificacion: identification }, update: { $setOnInsert: {
        clinic: this.clinic._id, code: `CTF-${record.externalId}`, identificacion: identification, tipoIdentificacion: idType(identification),
        ...names, email: String(row.email || ''), phone: String(row.telefonos || ''), address: String(row.direccion || ''),
        // Contífico no expone fecha de ingreso en persona. El corte se marca como
        // aproximación explícita en notas, sin inventar antigüedad anterior.
        hireDate: this.cutoff, baseSalary: Math.max(0, num(row.sueldo)), active: true,
        notes: `Importado de Contifico (${record.externalId}); fecha de ingreso no disponible en origen.`,
      } }, upsert: true } });
    }
    if (this.commit && employeeOps.length) await Employee.bulkWrite(employeeOps, { ordered: false });
    const allEmployees = this.commit ? await Employee.find({ clinic: this.clinic._id }).select('_id identificacion').lean() : existingEmployees;
    const employeeMap = new Map(allEmployees.map((employee) => [String(employee.identificacion), employee]));
    const grouped = new Map();
    for (const record of roles) {
      const row = record.payload, year = Number(row.anio), month = Number(row.mes), periodType = payrollPeriod(row.periodo_consultado);
      if (!periodType || !Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) continue;
      const key = `${year}-${month}-${periodType}`;
      if (!grouped.has(key)) grouped.set(key, { year, month, periodType, records: [] });
      grouped.get(key).records.push(record);
    }
    stage.source = roles.length;
    const marks = [], operations = [];
    for (const group of grouped.values()) {
      const code = `CTF-ROL-${group.year}-${String(group.month).padStart(2, '0')}-${group.periodType}`;
      const items = [];
      const payments = [];
      const sourceRefs = [];
      for (const record of group.records) {
        const row = record.payload, identification = String(row.cedula || '');
        const employee = employeeMap.get(identification);
        if (!employee) { this.warn(stage, record, 'Empleado no mapeado'); marks.push({ record, status: 'REVIEW', warnings: ['Empleado no mapeado'] }); continue; }
        const ingresos = r2(row.total_ingresos), egresos = r2(row.total_egresos), neto = r2(row.total_pago);
        items.push({ employee: employee._id, employeeName: String(row.nombre_persona || ''), identificacion: identification,
          daysWorked: Math.max(0, num(row.dias_trabajados, 30)), baseSalary: ingresos, totalIngresos: ingresos,
          totalEgresos: egresos, netoPagar: neto,
          notes: `Importado de Contifico (${record.externalId}); detalle original preservado en archivo.` });
        if (neto > 0) payments.push({ date: parseDate(row.fecha) || this.cutoff, amount: neto, reference: String(row.comprobante || ''), idempotencyKey: `contifico:payroll:${record.externalId}` });
        sourceRefs.push(record);
      }
      if (!items.length) continue;
      const fields = { clinic: this.clinic._id, code, year: group.year, month: group.month, periodType: group.periodType,
        period: `${group.year}-${String(group.month).padStart(2, '0')}`, description: 'Importado de Contifico', items,
        totalIngresos: r2(items.reduce((sum, item) => sum + item.totalIngresos, 0)), totalEgresos: r2(items.reduce((sum, item) => sum + item.totalEgresos, 0)),
        totalNeto: r2(items.reduce((sum, item) => sum + item.netoPagar, 0)), totalProvisiones: 0,
        status: 'PAGADO', payments, paidAt: payments.length ? payments.at(-1).date : null,
      };
      operations.push({ updateOne: { filter: { clinic: this.clinic._id, year: group.year, month: group.month, periodType: group.periodType }, update: { $set: fields }, upsert: true } });
      for (const record of sourceRefs) { marks.push({ record, status: 'PROJECTED', links: [{ model: 'Payroll', action: 'UPSERT' }] }); stage.projected += 1; }
    }
    if (this.commit && operations.length) await Payroll.bulkWrite(operations, { ordered: false });
    stage.created = operations.length;
    await this.mark(marks); this.finish(stage);
  }

  async warehouseStock() {
    const stage = this.stage('warehouse_stock');
    const [records, products, warehouses] = await Promise.all([
      this.records('product_stock'), this.records('product'), this.records('warehouse'),
    ]);
    stage.source = records.length;
    const productBySource = new Map(products.map((record) => [record.externalId, this.link(record, 'Product')]).filter(([, id]) => id));
    const warehouseBySource = new Map(warehouses.map((record) => [record.externalId, this.link(record, 'Warehouse')]).filter(([, id]) => id));
    const nativeProducts = await Product.find({ clinic: this.clinic._id }).select('_id averageCost purchasePrice').lean();
    const costByProduct = new Map(nativeProducts.map((product) => [String(product._id), Math.max(0, num(product.averageCost || product.purchasePrice))]));
    const operations = [], marks = [];
    for (const record of records) {
      const product = productBySource.get(String(record.payload.product_id || ''));
      const lines = Array.isArray(record.payload.stock) ? record.payload.stock : [];
      if (!product || !lines.length) {
        stage.skipped += 1; this.warn(stage, record, 'Stock sin producto mapeado o sin detalle de bodega');
        marks.push({ record, status: 'REVIEW', warnings: ['Stock sin producto mapeado o sin detalle de bodega'] }); continue;
      }
      let created = 0;
      for (const line of lines) {
        const warehouse = warehouseBySource.get(String(line.bodega_id || ''));
        if (!warehouse) { this.warn(stage, record, `Bodega sin mapeo ${line.bodega_id || ''}`); continue; }
        // Se conserva el déficit histórico de Contífico y se deja agotado para
        // que una cantidad negativa no se use como disponibilidad en FIFO.
        const quantity = num(line.cantidad);
        operations.push({ updateOne: { filter: { clinic: this.clinic._id, product, warehouse, sourceModel: 'ContificoStock', sourceRef: record._id }, update: { $set: {
          clinic: this.clinic._id, product, warehouse, qtyInitial: quantity, qtyRemaining: quantity,
          unitCost: costByProduct.get(String(product)) || 0, date: this.cutoff,
          sourceModel: 'ContificoStock', sourceRef: record._id, exhausted: quantity <= 0,
        } }, upsert: true } });
        created += 1;
      }
      if (!created) { stage.skipped += 1; marks.push({ record, status: 'REVIEW', warnings: ['Ninguna bodega mapeada'] }); }
      else { stage.projected += 1; marks.push({ record, status: 'PROJECTED', links: [{ model: 'InventoryLayer', action: 'UPSERT' }], warnings: ['Stock global conserva la cifra del catálogo de Contífico; la bodega usa su snapshot específico.'] }); }
    }
    if (this.commit) for (let offset = 0; offset < operations.length; offset += 500) await InventoryLayer.bulkWrite(operations.slice(offset, offset + 500), { ordered: false });
    stage.created = operations.length;
    await this.mark(marks); this.finish(stage);
  }

  async notes() {
    const stage = this.stage('credit_debit_notes');
    const [documents, sales] = await Promise.all([
      this.records('document'), Sale.find({ clinic: this.clinic._id }).select('_id idempotencyKey invoice').lean(),
    ]);
    const byId = new Map(documents.map((record) => [record.externalId, record]));
    const invoiceByDocument = new Map(sales
      .filter((sale) => sale.invoice && String(sale.idempotencyKey || '').startsWith('contifico:'))
      .map((sale) => [String(sale.idempotencyKey).slice('contifico:'.length), sale.invoice]));
    const candidates = documents.filter((record) => noteKind(record.payload.tipo_documento)
      && String(record.payload.tipo_registro || '').toUpperCase() === 'CLI'
      && parseDate(record.payload.fecha_emision) && parseDate(record.payload.fecha_emision) <= this.cutoff);
    stage.source = candidates.length;
    const operations = [], marks = [];
    for (const record of candidates) {
      const row = record.payload, related = byId.get(String(row.documento_relacionado_id || ''));
      const refDoc = related ? invoiceByDocument.get(related.externalId) || null : null;
      const [estab = '', ptoEmi = '', secuencial = record.externalId] = String(row.documento || '').split('-');
      const fields = {
        clinic: this.clinic._id, kind: noteKind(row.tipo_documento), direction: 'EMITIDA',
        refModel: refDoc ? 'Invoice' : null, refDoc, serieAfecta: String(related?.payload?.documento || ''),
        fechaEmisionAfecta: related ? parseDate(related.payload.fecha_emision) : null,
        estab, ptoEmi, secuencial, serie: String(row.documento || `CTF-${record.externalId}`),
        claveAcceso: /^\d{49}$/.test(String(row.autorizacion || '')) ? String(row.autorizacion) : `CONTIFICO-${record.externalId}`,
        fechaEmision: parseDate(row.fecha_emision), autorizacion: String(row.autorizacion || ''), motivo: String(row.descripcion || row.referencia || ''),
        items: row.detalles || [], subtotal: r2(row.subtotal), iva: r2(row.iva), total: r2(row.total),
        ivaRate: r2(row.subtotal_12) > 0 && r2(row.iva) > 0 ? 12 : (r2(row.iva) > 0 ? 15 : 0),
        taxBreakdown: { base0: r2(row.subtotal_0), baseGravada: r2(row.subtotal_12), baseExento: 0, baseNoObjeto: 0, iva: r2(row.iva) },
        estado: status(row), sourceModel: 'ContificoRecord', sourceRef: record._id,
      };
      operations.push({ updateOne: { filter: { clinic: this.clinic._id, sourceModel: 'ContificoRecord', sourceRef: record._id }, update: { $set: fields }, upsert: true } });
      marks.push({ record, status: 'PROJECTED', links: [{ model: 'CreditDebitNote', action: 'UPSERT' }], warnings: refDoc ? [] : ['Nota histórica sin documento afectado en Contífico.'] });
      if (!refDoc) this.warn(stage, record, 'Nota histórica sin documento afectado en Contífico');
      stage.projected += 1;
    }
    if (this.commit && operations.length) {
      // No dependemos de autoIndex en producción: la llave de origen hace que el
      // reintento sea idempotente incluso si el proceso se interrumpe.
      await CreditDebitNote.collection.createIndex(
        { clinic: 1, sourceModel: 1, sourceRef: 1 },
        {
          name: 'clinic_1_sourceModel_1_sourceRef_1',
          unique: true,
          partialFilterExpression: { sourceModel: { $type: 'string' }, sourceRef: { $type: 'objectId' } },
        }
      );
      await CreditDebitNote.bulkWrite(operations, { ordered: false });
    }
    stage.created = operations.length;
    await this.mark(marks); this.finish(stage);
  }

  async execute() {
    await this.initialize();
    if (this.enabled('transactions')) await this.transactions();
    if (this.enabled('payroll')) await this.payroll();
    if (this.enabled('warehouse_stock')) await this.warehouseStock();
    if (this.enabled('credit_debit_notes')) await this.notes();
    return { stages: this.stages };
  }
}

async function main() {
  const options = args(process.argv.slice(2));
  if (!process.env.MONGODB_URI) throw new Error('Falta MONGODB_URI');
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = options.clinicId
    ? await Clinic.findById(options.clinicId).lean()
    : await Clinic.findOne({ name: new RegExp(`^${String(options.clinicName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).lean();
  if (!clinic) throw new Error('Clínica destino no encontrada');
  console.log(`MODO ${options.commit ? 'COMMIT' : 'DRY_RUN'} | PROYECCIÓN SUPLEMENTARIA | ${clinic.name}`);
  console.log(JSON.stringify(await new SupplementalProjector({ clinic, ...options }).execute(), null, 2));
}

if (require.main === module) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; }).finally(() => mongoose.disconnect().catch(() => {}));

module.exports = { SupplementalProjector, args, mapPaymentMethod, payrollPeriod, noteKind };
