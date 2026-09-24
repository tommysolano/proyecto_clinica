#!/usr/bin/env node
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const ContificoRecord = require('../models/ContificoRecord');
const ContificoMigrationRun = require('../models/ContificoMigrationRun');
const ChartOfAccount = require('../models/ChartOfAccount');
const CostCenter = require('../models/CostCenter');
const InventoryCategory = require('../models/InventoryCategory');
const Warehouse = require('../models/Warehouse');
const BankAccount = require('../models/BankAccount');
const Supplier = require('../models/Supplier');
const Patient = require('../models/Patient');
const Product = require('../models/Product');
const Sale = require('../models/Sale');
const Invoice = require('../models/Invoice');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const InventoryMovement = require('../models/InventoryMovement');
const BankTransaction = require('../models/BankTransaction');
const FiscalPeriod = require('../models/FiscalPeriod');
const JournalEntry = require('../models/JournalEntry');
const AccountBalance = require('../models/AccountBalance');
const Receivable = require('../models/Receivable');
const Payable = require('../models/Payable');
const { parseDate, fmt } = require('./migrateContifico');
const { decodeCompressedJson } = require('../utils/compressedJson');

const num = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const fakeId = () => new mongoose.Types.ObjectId();
const identification = (row) => String(row?.ruc || row?.cedula || '').trim();
const idType = (id) => /^\d{13}$/.test(id) ? 'RUC' : (/^\d{10}$/.test(id) ? 'CEDULA' : 'PASAPORTE');
const accountType = (code) => {
  const value = String(code);
  if (value === '1' || value.startsWith('1.')) return 'ACTIVO';
  if (value === '2' || value.startsWith('2.')) return 'PASIVO';
  if (value === '3' || value.startsWith('3.')) return 'PATRIMONIO';
  if (value === '4' || value.startsWith('4.')) return 'INGRESO';
  if (value === '5.1' || value.startsWith('5.1.')) return 'COSTO';
  if (value === '5' || value.startsWith('5.')) return 'GASTO';
  return 'ORDEN';
};
const nature = (type) => ['PASIVO', 'PATRIMONIO', 'INGRESO'].includes(type) ? 'CREDITO' : 'DEBITO';
const splitName = (value) => {
  const parts = String(value || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { firstName: parts[0] || 'SIN NOMBRE', lastName: 'CONTIFICO' };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts.at(-1) };
};
const tax = (value) => {
  const rate = num(value);
  if (rate === 15) return { taxRate: 15, taxCodeSri: '4', taxCategory: 'IVA_15' };
  if (rate === 12) return { taxRate: 12, taxCodeSri: '2', taxCategory: 'IVA_12' };
  if (rate === 5) return { taxRate: 5, taxCodeSri: '5', taxCategory: 'IVA_5' };
  return { taxRate: 0, taxCodeSri: '0', taxCategory: 'IVA_0' };
};
const ledgerDocType = (value) => ({ FAC: 'FACTURA', NVE: 'VENTA', NCT: 'NC', DAC: 'ND', DNA: 'ND' }[String(value).toUpperCase()] || 'OTRO');
const r2 = (value) => +num(value).toFixed(2);

/** Fecha/hora de Contifico interpretada en Ecuador (UTC-5), no en UTC. */
function contificoDate(row) {
  const match = String(row?.fecha_emision || row?.fecha_creacion || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return parseDate(row?.fecha_emision || row?.fecha_creacion);
  const time = /^\d{2}:\d{2}:\d{2}$/.test(String(row?.hora_emision || '')) ? row.hora_emision : '12:00:00';
  const iso = `${match[3]}-${String(match[2]).padStart(2, '0')}-${String(match[1]).padStart(2, '0')}T${time}-05:00`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? parseDate(row.fecha_emision) : date;
}

function contificoPayment(cobro, fallbackDate) {
  const raw = String(cobro?.forma_cobro || '').toUpperCase();
  const method = raw === 'TC' ? 'tarjeta' : (raw === 'TRANSF' ? 'transferencia' : 'efectivo');
  return {
    method,
    amount: r2(cobro?.monto),
    date: parseDate(cobro?.fecha) || fallbackDate,
    reference: String(cobro?.numero_comprobante || cobro?.numero_cheque || ''),
    cardBrandSnapshot: method === 'tarjeta' ? String(cobro?.nombre_tarjeta || '') : '',
    cardPos: method === 'tarjeta' ? String(cobro?.tipo_banco || '') : '',
    cardLote: method === 'tarjeta' ? String(cobro?.lote || '') : '',
    cardVoucher: method === 'tarjeta' ? String(cobro?.numero_comprobante || '') : '',
  };
}

function contificoSaleItem(detail, productId, product = {}) {
  const quantity = num(detail.cantidad, 1);
  const unitPrice = num(detail.precio);
  const grossAmount = r2(quantity * unitPrice);
  const rate = num(detail.porcentaje_iva);
  const taxBase = r2(num(detail.base_cero) + num(detail.base_no_gravable) + num(detail.base_gravable));
  const taxAmount = r2(num(detail.base_gravable) * rate / 100);
  const lineTotal = r2(taxBase + taxAmount + num(detail.valor_ice));
  const discount = r2(Math.max(0, grossAmount - taxBase));
  return {
    product: productId,
    productCode: String(product.code || ''),
    productName: String(detail.producto_nombre || detail.nombre_manual || product.name || 'Item manual de Contifico'),
    category: String(product.category || 'servicio'),
    quantity,
    unitPrice: r2(unitPrice),
    unitPriceExcludingTax: r2(unitPrice),
    grossAmount,
    taxBase,
    taxAmount,
    lineTotal,
    ...tax(rate),
    priceIncludesVat: false,
    discount,
    discountTaxBase: discount,
    subtotal: taxBase,
  };
}

function contificoSaleFields(record, maps, products, manualProductId) {
  const row = record.payload;
  const date = contificoDate(row);
  const items = (row.detalles || []).map((detail) => {
    const productId = maps.products.get(String(detail.producto_id || '')) || manualProductId;
    return contificoSaleItem(detail, productId, products.get(String(productId)) || {});
  });
  const total = r2(row.total);
  const balance = Math.max(0, r2(row.saldo));
  const payments = (row.cobros || []).map((payment) => contificoPayment(payment, date)).filter((payment) => payment.amount > 0);
  const recorded = r2(payments.reduce((sum, payment) => sum + payment.amount, 0));
  if (balance > 0) payments.push({ method: 'credito', amount: balance, date, reference: 'Saldo Contifico' });
  // Contifico no devuelve los cobros de varios documentos antiguos/anulados. En ventas vigentes,
  // completar la diferencia mantiene la conciliacion sin esconder que fue un fallback.
  const missing = r2(total - recorded - balance);
  if (!row.anulado && missing > 0.01) payments.push({ method: 'efectivo', amount: missing, date, reference: 'CONTIFICO_SIN_DESGLOSE' });
  const methods = [...new Set(payments.map((payment) => payment.method))];
  const client = row.cliente || {};
  const gross = r2(items.reduce((sum, item) => sum + item.grossAmount, 0));
  const discount = r2(items.reduce((sum, item) => sum + item.discount, 0));
  const costCenter = (row.detalles || []).map((detail) => maps.costCenters.get(String(detail.centro_costo_id || ''))).find(Boolean) || null;
  return {
    clinic: maps.clinic,
    saleNumber: String(row.documento || `CTF-${record.externalId}`),
    patient: maps.patients.get(String(row.persona_id || '')) || null,
    clientName: String(client.razon_social || client.nombre_comercial || 'Consumidor Final'),
    clientCedula: identification(client) || '9999999999999',
    clientEmail: String(client.email || '').toLowerCase(),
    clientPhone: String(client.telefonos || ''),
    clientAddress: String(client.direccion || ''),
    items,
    costCenter,
    subtotal: gross,
    taxableSubtotal: r2(row.subtotal_12),
    subtotal0: r2(row.subtotal_0),
    subtotalNoObjeto: r2(items.reduce((sum, item) => sum + (item.taxCategory === 'NO_OBJETO' ? item.taxBase : 0), 0)),
    discountTotal: discount,
    discountTaxBase: discount,
    taxAmount: r2(row.iva),
    total,
    paymentMethod: methods.length > 1 ? 'mixto' : (methods[0] || 'efectivo'),
    payments,
    creditDays: balance > 0 && parseDate(row.fecha_vencimiento) && date
      ? Math.max(0, Math.round((parseDate(row.fecha_vencimiento) - date) / 86400000)) : null,
    dueDate: balance > 0 ? parseDate(row.fecha_vencimiento) : null,
    balance,
    paid: balance <= 0.01,
    status: row.anulado ? 'anulada' : 'completada',
    notes: `Importado de Contifico (${record.externalId})${missing > 0.01 && !row.anulado ? '; pago sin desglose en origen' : ''}`,
    idempotencyKey: `contifico:${record.externalId}`,
    createdAt: date,
  };
}

function contificoInvoiceFields(record, saleId, sale) {
  const row = record.payload;
  const [estab = '000', ptoEmi = '000', secuencial = record.externalId] = String(row.documento || '').split('-');
  // Solo una clave SRI real (49 digitos) puede identificar globalmente una factura. Contifico
  // conserva en documentos legacy numeros cortos reutilizados que NO son autorizaciones.
  const authorization = /^\d{49}$/.test(String(row.autorizacion || '')) ? String(row.autorizacion) : null;
  return {
    clinic: sale.clinic,
    sale: saleId,
    claveAcceso: authorization || `CONTIFICO-${record.externalId}`,
    secuencial,
    estab,
    ptoEmi,
    ambiente: '2',
    fechaEmision: String(row.fecha_emision || ''),
    estado: row.anulado ? 'ANULADA' : (row.autorizado_sri ? 'AUTORIZADO' : 'RECIBIDA'),
    numeroAutorizacion: authorization,
    razonSocialComprador: sale.clientName,
    identificacionComprador: sale.clientCedula,
    direccionComprador: sale.clientAddress,
    emailComprador: sale.clientEmail,
    telefonoComprador: sale.clientPhone,
    subtotal: sale.subtotal,
    iva: sale.taxAmount,
    total: sale.total,
    totalSinImpuestos: r2(num(row.subtotal_12) + num(row.subtotal_0)),
    totalDescuento: sale.discountTotal,
    totalImpuesto: sale.taxAmount,
    importeTotal: sale.total,
    taxBreakdown: {
      base0: sale.subtotal0,
      baseGravada: sale.taxableSubtotal,
      baseExento: sale.subtotalExento || 0,
      baseNoObjeto: sale.subtotalNoObjeto || 0,
      iva: sale.taxAmount,
      computed: true,
    },
    balance: sale.balance,
    paid: sale.paid,
    formaPago: sale.paymentMethod,
    items: sale.items,
    anuladaAt: row.anulado ? sale.createdAt : null,
    motivoAnulacion: row.anulado ? 'Anulada en Contifico' : null,
    createdAt: sale.createdAt,
  };
}

function parseArgs(argv) {
  const values = {}, flags = new Set();
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const at = arg.indexOf('=');
    if (at < 0) flags.add(arg.slice(2)); else values[arg.slice(2, at)] = arg.slice(at + 1);
  }
  return {
    commit: flags.has('commit'),
    clinicId: values.clinic || null,
    clinicName: values['clinic-name'] || 'Shiluv',
    cutoff: parseDate(values.cutoff) || new Date(),
    stopAfter: values['stop-after'] || null,
    only: values.only || null,
    skipLinkedInventory: flags.has('skip-linked-inventory'),
  };
}

// Entidades que la extracción vigente recupera como una instantánea completa.
// Las demás (catálogos, personas, stock y nómina) conservan su última copia
// válida hasta que se ejecute su propio refresco.
const snapshotEntities = {
  documents: 'document', transactions: 'transaction', bank_movements: 'bank_movement',
  inventory_movements: 'inventory_movement', journal_entries: 'journal_entry',
};

class Projector {
  constructor({ clinic, commit, cutoff, stopAfter = null, only = null, skipLinkedInventory = false }) {
    this.clinic = clinic;
    this.commit = commit;
    this.cutoff = cutoff;
    this.stopAfter = stopAfter;
    this.only = only;
    this.skipLinkedInventory = skipLinkedInventory;
    this.run = null;
    this.sourceSnapshot = null;
    this.snapshotEntities = new Set();
    this.stages = [];
    this.issues = [];
    this.maps = { clinic: clinic._id, accounts: new Map(), costCenters: new Map(), categories: new Map(), warehouses: new Map(), banks: new Map(), suppliers: new Map(), patients: new Map(), products: new Map(), periods: new Map() };
  }
  log(text) { console.log(`[project] ${text}`); }
  stage(name) { const stage = { name, source: 0, created: 0, linked: 0, projected: 0, skipped: 0, warnings: 0, status: 'RUNNING' }; this.stages.push(stage); this.log(`inicio ${name}`); return stage; }
  issue(stage, externalId, message) { stage.warnings += 1; if (this.issues.length < 500) this.issues.push({ stage: stage.name, externalId, message }); }
  async finishStage(stage) { stage.status = stage.warnings ? 'COMPLETED_WITH_WARNINGS' : 'COMPLETED'; this.log(`fin ${stage.name}: source=${stage.source} created=${stage.created} linked=${stage.linked} projected=${stage.projected} skipped=${stage.skipped} warnings=${stage.warnings}`); if (this.run) { this.run.stages = this.stages; this.run.issues = this.issues; await this.run.save(); } }
  async records(entity) {
    const filter = { clinic: this.clinic._id, entity };
    if (this.sourceSnapshot && this.snapshotEntities.has(entity)) filter.migrationRun = this.sourceSnapshot._id;
    const records = await ContificoRecord.find(filter).sort({ externalId: 1 }).lean();
    return records.map((record) => ({
      ...record,
      payload: record.payload || decodeCompressedJson(record.payloadCompressed),
    }));
  }
  async mark(items) {
    if (!this.commit || !items.length) return;
    const now = new Date();
    for (let offset = 0; offset < items.length; offset += 1000) {
      await ContificoRecord.bulkWrite(items.slice(offset, offset + 1000).map((item) => ({ updateOne: {
        filter: { _id: item.recordId },
        update: { $set: { projection: { status: item.status, links: item.links || [], warnings: item.warnings || [], projectedAt: now } } },
      } })), { ordered: false });
    }
  }
  async begin() {
    this.sourceSnapshot = await ContificoMigrationRun.findOne({
      clinic: this.clinic._id, phase: 'EXTRACT', status: { $in: ['COMPLETED', 'COMPLETED_WITH_WARNINGS'] },
    }).sort({ completedAt: -1, createdAt: -1 }).lean();
    if (this.sourceSnapshot) {
      for (const stage of this.sourceSnapshot.stages || []) {
        if (stage.status === 'COMPLETED' && snapshotEntities[stage.name]) this.snapshotEntities.add(snapshotEntities[stage.name]);
      }
      this.log(`instantánea fuente ${this.sourceSnapshot._id}: ${[...this.snapshotEntities].join(', ')}`);
    }
    if (this.commit) this.run = await ContificoMigrationRun.create({ clinic: this.clinic._id, mode: 'COMMIT', phase: 'PROJECT', range: { cutoff: this.cutoff } });
  }

  async accounts() {
    const stage = this.stage('accounts');
    const records = await this.records('chart_account'); stage.source = records.length;
    const current = await ChartOfAccount.find({ clinic: this.clinic._id }).lean();
    const existingCodes = new Set(current.map((row) => String(row.code)));
    if (this.commit) {
      await ChartOfAccount.bulkWrite(records.map((record) => {
        const source = record.payload, type = accountType(source.codigo);
        return { updateOne: { filter: { clinic: this.clinic._id, code: String(source.codigo) }, update: { $setOnInsert: {
          clinic: this.clinic._id, code: String(source.codigo), name: String(source.nombre || source.codigo), type, nature: nature(type), level: String(source.codigo).split('.').length,
          allowsMovement: String(source.tipo).toUpperCase() === 'C', active: true, description: `Migrado desde Contifico (${record.externalId})`,
        } }, upsert: true } };
      }), { ordered: false });
    }
    let targets = this.commit ? await ChartOfAccount.find({ clinic: this.clinic._id }).lean() : current;
    const byCode = new Map(targets.map((row) => [String(row.code), row]));
    for (const record of records) if (!byCode.has(String(record.payload.codigo))) byCode.set(String(record.payload.codigo), { _id: fakeId(), code: String(record.payload.codigo) });
    if (this.commit) {
      const parentOps = [];
      for (const record of records) {
        const code = String(record.payload.codigo);
        if (existingCodes.has(code) || !code.includes('.')) continue;
        const parent = byCode.get(code.split('.').slice(0, -1).join('.'));
        if (parent) parentOps.push({ updateOne: { filter: { clinic: this.clinic._id, code }, update: { $set: { parent: parent._id } } } });
      }
      if (parentOps.length) await ChartOfAccount.bulkWrite(parentOps, { ordered: false });
    }
    const marks = [];
    for (const record of records) {
      const target = byCode.get(String(record.payload.codigo));
      this.maps.accounts.set(record.externalId, target._id);
      const existed = existingCodes.has(String(record.payload.codigo));
      if (existed) stage.linked += 1; else stage.created += 1;
      stage.projected += 1;
      marks.push({ recordId: record._id, status: existed ? 'LINKED_EXISTING' : 'PROJECTED', links: [{ model: 'ChartOfAccount', ref: target._id, action: existed ? 'LINK' : 'CREATE' }] });
    }
    await this.mark(marks); await this.finishStage(stage);
  }

  async costCenters() {
    const stage = this.stage('cost_centers'); const records = await this.records('cost_center'); stage.source = records.length;
    const current = await CostCenter.find({ clinic: this.clinic._id }).lean(); const existingCodes = new Set(current.map((row) => String(row.code)));
    if (this.commit) await CostCenter.bulkWrite(records.map((record) => ({ updateOne: { filter: { clinic: this.clinic._id, code: String(record.payload.codigo) }, update: { $setOnInsert: {
      clinic: this.clinic._id, code: String(record.payload.codigo), name: String(record.payload.nombre || record.payload.codigo), active: String(record.payload.estado || 'A') === 'A', description: `Contifico ${record.externalId}; tipo ${record.payload.tipo || ''}`,
    } }, upsert: true } })), { ordered: false });
    const targets = this.commit ? await CostCenter.find({ clinic: this.clinic._id }).lean() : current;
    const byCode = new Map(targets.map((row) => [String(row.code), row]));
    for (const record of records) if (!byCode.has(String(record.payload.codigo))) byCode.set(String(record.payload.codigo), { _id: fakeId() });
    const marks = records.map((record) => { const target = byCode.get(String(record.payload.codigo)); const existed = existingCodes.has(String(record.payload.codigo)); this.maps.costCenters.set(record.externalId, target._id); existed ? stage.linked++ : stage.created++; stage.projected++; return { recordId: record._id, status: existed ? 'LINKED_EXISTING' : 'PROJECTED', links: [{ model: 'CostCenter', ref: target._id, action: existed ? 'LINK' : 'CREATE' }] }; });
    await this.mark(marks); await this.finishStage(stage);
  }

  async categories() {
    const stage = this.stage('categories'); const records = await this.records('category'); stage.source = records.length;
    const current = await InventoryCategory.find({ clinic: this.clinic._id }).lean(); const existingCodes = new Set(current.map((row) => String(row.code)));
    const sourceById = new Map(records.map((record) => [record.externalId, record]));
    const makeFields = (record) => { const row = record.payload; return {
      clinic: this.clinic._id, code: `CTF-${record.externalId}`, name: String(row.nombre || record.externalId), kind: String(row.tipo_producto).toUpperCase() === 'SERV' ? 'SERVICIO' : 'INVENTARIO',
      assetAccount: this.maps.accounts.get(String(row.cuenta_inventario_id || row.cuenta_inventario || '')) || null,
      expenseAccount: this.maps.accounts.get(String(row.cuenta_compra_id || row.cuenta_compra || '')) || null,
      incomeAccount: this.maps.accounts.get(String(row.cuenta_venta_id || row.cuenta_venta || '')) || null, active: true,
    }; };
    if (this.commit) await InventoryCategory.bulkWrite(records.map((record) => ({ updateOne: { filter: { clinic: this.clinic._id, code: `CTF-${record.externalId}` }, update: { $set: makeFields(record) }, upsert: true } })), { ordered: false });
    let targets = this.commit ? await InventoryCategory.find({ clinic: this.clinic._id }).lean() : current;
    const byCode = new Map(targets.map((row) => [String(row.code), row]));
    for (const record of records) if (!byCode.has(`CTF-${record.externalId}`)) byCode.set(`CTF-${record.externalId}`, { _id: fakeId() });
    if (this.commit) {
      const parentOps = records.filter((record) => record.payload.padre_id && sourceById.has(String(record.payload.padre_id))).map((record) => ({ updateOne: { filter: { clinic: this.clinic._id, code: `CTF-${record.externalId}` }, update: { $set: { parent: byCode.get(`CTF-${record.payload.padre_id}`)?._id || null } } } }));
      if (parentOps.length) await InventoryCategory.bulkWrite(parentOps, { ordered: false });
    }
    const marks = records.map((record) => { const code = `CTF-${record.externalId}`, target = byCode.get(code), existed = existingCodes.has(code); this.maps.categories.set(record.externalId, target._id); existed ? stage.linked++ : stage.created++; stage.projected++; return { recordId: record._id, status: existed ? 'LINKED_EXISTING' : 'PROJECTED', links: [{ model: 'InventoryCategory', ref: target._id, action: existed ? 'LINK' : 'CREATE' }] }; });
    await this.mark(marks); await this.finishStage(stage);
  }

  async warehouses() {
    const stage = this.stage('warehouses'); const records = await this.records('warehouse'); stage.source = records.length;
    const current = await Warehouse.find({ clinic: this.clinic._id }).lean(); const existingCodes = new Set(current.map((row) => String(row.code)));
    const ccRecords = await this.records('cost_center'); const ccByCode = new Map(ccRecords.map((record) => [String(record.payload.codigo), this.maps.costCenters.get(record.externalId)]));
    const ccCode = { BOD001: '1', BOD004: '2', BOD005: '5' };
    if (this.commit) await Warehouse.bulkWrite(records.map((record) => { const code = String(record.payload.codigo || `CTF-${record.externalId}`); return { updateOne: { filter: { clinic: this.clinic._id, code }, update: { $setOnInsert: { clinic: this.clinic._id, code, name: String(record.payload.nombre || code), costCenter: ccByCode.get(ccCode[code]) || null, isMain: code === 'BOD001', active: true, address: 'Migrado desde Contifico' } }, upsert: true } }; }), { ordered: false });
    const targets = this.commit ? await Warehouse.find({ clinic: this.clinic._id }).lean() : current; const byCode = new Map(targets.map((row) => [String(row.code), row]));
    for (const record of records) { const code = String(record.payload.codigo || `CTF-${record.externalId}`); if (!byCode.has(code)) byCode.set(code, { _id: fakeId() }); }
    const marks = records.map((record) => { const code = String(record.payload.codigo || `CTF-${record.externalId}`), target = byCode.get(code), existed = existingCodes.has(code); this.maps.warehouses.set(record.externalId, target._id); existed ? stage.linked++ : stage.created++; stage.projected++; return { recordId: record._id, status: existed ? 'LINKED_EXISTING' : 'PROJECTED', links: [{ model: 'Warehouse', ref: target._id, action: existed ? 'LINK' : 'CREATE' }] }; });
    await this.mark(marks); await this.finishStage(stage);
  }

  async banks() {
    const stage = this.stage('bank_accounts'); const records = await this.records('bank_account'); stage.source = records.length;
    const current = await BankAccount.find({ clinic: this.clinic._id }).lean(); const byNumber = new Map(current.map((row) => [String(row.accountNumber), row])); const marks = [];
    const accountRecords = await this.records('chart_account');
    const accountByName = new Map(accountRecords.map((record) => [String(record.payload.nombre || '').trim().toLocaleLowerCase('es'), this.maps.accounts.get(record.externalId)]));
    for (const record of records) {
      const row = record.payload, number = String(row.numero || ''), sourceAccount = String(row.cuenta_contable?.id || row.cuenta_contable_id || row.cuenta_contable || '');
      const chartAccount = this.maps.accounts.get(sourceAccount) || accountByName.get(sourceAccount.trim().toLocaleLowerCase('es'));
      if (!number || !chartAccount) { stage.skipped++; this.issue(stage, record.externalId, 'Sin numero o cuenta contable mapeada'); marks.push({ recordId: record._id, status: 'REVIEW', warnings: ['Sin numero o cuenta contable mapeada'] }); continue; }
      let target = byNumber.get(number), existed = !!target;
      if (!target) {
        target = this.commit ? await BankAccount.create({ clinic: this.clinic._id, name: String(row.nombre || row.nombre_banco || number), bank: String(row.nombre_banco || row.nombre || 'Banco'), accountNumber: number, accountType: String(row.tipo_cuenta) === 'CA' ? 'AHORROS' : 'CORRIENTE', chartAccount, initialBalance: num(row.saldo_inicial), bookBalance: num(row.saldo_inicial), initialBalanceDate: parseDate(row.fecha_corte), active: String(row.estado || 'A') === 'A', notes: `Contifico ${record.externalId}` }) : { _id: fakeId() };
        byNumber.set(number, target);
      }
      existed ? stage.linked++ : stage.created++; stage.projected++; this.maps.banks.set(record.externalId, target._id); marks.push({ recordId: record._id, status: existed ? 'LINKED_EXISTING' : 'PROJECTED', links: [{ model: 'BankAccount', ref: target._id, action: existed ? 'LINK' : 'CREATE' }] });
    }
    await this.mark(marks); await this.finishStage(stage);
  }

  async persons() {
    const stage = this.stage('persons'); const records = await this.records('person'); stage.source = records.length;
    // Una persona puede haber perdido la marca `es_proveedor` después de emitir
    // una compra. El documento PRO sigue siendo evidencia suficiente para crear
    // su ficha de proveedor y no dejar ese comprobante sin importar.
    const providerPersonIds = new Set((await this.records('document'))
      .filter((record) => String(record.payload.tipo_registro || '').toUpperCase() === 'PRO')
      .map((record) => String(record.payload.persona_id || '')).filter(Boolean));
    const ids = [...new Set(records.map((record) => identification(record.payload)).filter(Boolean))];
    const oldSuppliers = await Supplier.find({ clinic: this.clinic._id, ruc: { $in: ids } }).lean(); const oldPatients = await Patient.find({ $or: [{ cedula: { $in: ids } }, { identificationAliases: { $in: ids } }] }).lean();
    const oldSupplierIds = new Set(oldSuppliers.map((row) => String(row.ruc))), oldPatientIds = new Set(oldPatients.flatMap((row) => [row.cedula, ...(row.identificationAliases || [])].map(String)));
    if (this.commit) {
      const supplierOps = [], patientOps = [];
      for (const record of records) {
        const row = record.payload, id = identification(row); if (!id) continue;
        const roles = [['es_cliente', 'CLIENTE'], ['es_proveedor', 'PROVEEDOR'], ['es_empleado', 'EMPLEADO'], ['es_vendedor', 'VENDEDOR']].filter(([field]) => row[field]).map(([, role]) => role);
        const appearsAsProvider = providerPersonIds.has(String(record.externalId));
        if (appearsAsProvider && !roles.includes('PROVEEDOR')) roles.push('PROVEEDOR');
        const needsSupplier = appearsAsProvider || row.es_proveedor || row.es_empleado || row.es_vendedor || !row.es_cliente;
        if (needsSupplier) supplierOps.push({ updateOne: { filter: { clinic: this.clinic._id, ruc: id }, update: {
          // Solo se refrescan los atributos que Contífico realmente proporciona;
          // no se borran campos locales de otros módulos.
          $set: { razonSocial: String(row.razon_social || row.nombre_comercial || id), nombreComercial: String(row.nombre_comercial || ''), roles: roles.length ? roles : ['CLIENTE'], address: String(row.direccion || ''), phone: String(row.telefonos || ''), email: String(row.email || ''), creditDays: num(row.dias_credito), active: true },
          $setOnInsert: { clinic: this.clinic._id, ruc: id, tipoIdentificacion: idType(id), notes: `Contifico ${record.externalId}` },
        }, upsert: true } });
        if (row.es_cliente) { const names = splitName(row.razon_social || row.nombre_comercial || id); patientOps.push({ updateOne: { filter: { $or: [{ cedula: id }, { identificationAliases: id }] }, update: {
          $set: { ...names, email: String(row.email || ''), phone: String(row.telefonos || ''), address: String(row.direccion || ''), active: true },
          $setOnInsert: { clinic: this.clinic._id, cedula: id, notes: `Contifico ${record.externalId}` },
        }, upsert: true } }); }
      }
      for (let i = 0; i < supplierOps.length; i += 1000) await Supplier.bulkWrite(supplierOps.slice(i, i + 1000), { ordered: false });
      for (let i = 0; i < patientOps.length; i += 1000) await Patient.bulkWrite(patientOps.slice(i, i + 1000), { ordered: false });
    }
    const suppliers = this.commit ? await Supplier.find({ clinic: this.clinic._id, ruc: { $in: ids } }).lean() : oldSuppliers;
    const patients = this.commit ? await Patient.find({ $or: [{ cedula: { $in: ids } }, { identificationAliases: { $in: ids } }] }).lean() : oldPatients;
    const supplierById = new Map(suppliers.map((row) => [String(row.ruc), row])), patientById = new Map(patients.flatMap((row) => [row.cedula, ...(row.identificationAliases || [])].filter(Boolean).map((id) => [String(id), row]))); const marks = [];
    for (const record of records) {
      const id = identification(record.payload); if (!id) { stage.skipped++; continue; }
      const needsSupplier = providerPersonIds.has(String(record.externalId)) || record.payload.es_proveedor || record.payload.es_empleado || record.payload.es_vendedor || !record.payload.es_cliente;
      let supplier = needsSupplier ? supplierById.get(id) : null; if (needsSupplier && !supplier) { supplier = { _id: fakeId() }; supplierById.set(id, supplier); }
      let patient = record.payload.es_cliente ? patientById.get(id) : null; if (record.payload.es_cliente && !patient) { patient = { _id: fakeId() }; patientById.set(id, patient); }
      if (supplier) this.maps.suppliers.set(record.externalId, supplier._id); if (patient) this.maps.patients.set(record.externalId, patient._id);
      const supplierNew = supplier && !oldSupplierIds.has(id), patientNew = patient && !oldPatientIds.has(id); stage.created += (supplierNew ? 1 : 0) + (patientNew ? 1 : 0); if (supplier && !supplierNew) stage.linked++; if (patient && !patientNew) stage.linked++; stage.projected++;
      const links = [supplier && { model: 'Supplier', ref: supplier._id, action: supplierNew ? 'CREATE' : 'LINK' }, patient && { model: 'Patient', ref: patient._id, action: patientNew ? 'CREATE' : 'LINK' }].filter(Boolean);
      marks.push({ recordId: record._id, status: supplierNew || patientNew ? 'PROJECTED' : 'LINKED_EXISTING', links });
    }
    await this.mark(marks); await this.finishStage(stage);
  }

  async products() {
    const stage = this.stage('products'); const records = await this.records('product'); stage.source = records.length;
    const codes = records.map((record) => String(record.payload.codigo || '')).filter(Boolean); const current = await Product.find({ clinic: this.clinic._id, code: { $in: codes } }).lean(); const existingCodes = new Set(current.map((row) => String(row.code)));
    const categoryRecords = await this.records('category'); const categoryNames = new Map(categoryRecords.map((record) => [record.externalId, String(record.payload.nombre || '')]));
    const categorySource = new Map(categoryRecords.map((record) => [record.externalId, record.payload]));
    const unitRecords = await this.records('unit'); const unitNames = new Map(unitRecords.map((record) => [record.externalId, String(record.payload.nombre || 'unidad')]));
    const fields = (record) => { const row = record.payload, physical = String(row.tipo).toUpperCase() === 'PRO', rawStock = num(row.cantidad_stock), salePrice = Math.max(0, num(row.pvp1)), sourceCategory = categorySource.get(String(row.categoria_id || '')) || {}; return {
      clinic: this.clinic._id, code: String(row.codigo), barcode: String(row.codigo_barra || row.codigo_auxiliar || ''), name: String(row.nombre || row.codigo), description: String(row.descripcion || ''), category: physical ? 'insumo' : 'servicio', categoria: categoryNames.get(String(row.categoria_id)) || '', isComposite: String(row.tipo_producto).toUpperCase() === 'COP',
      stock: rawStock, stockByClinic: [{ clinic: this.clinic._id, stock: rawStock }], availableInClinics: [], purchasePrice: Math.max(0, num(row.costo_maximo)), averageCost: Math.max(0, num(row.costo_maximo)), salePrice, salePrices: [{ name: 'General', price: salePrice, active: true }], minStock: Math.max(0, num(row.minimo)),
      inventoryAccount: this.maps.accounts.get(String(sourceCategory.cuenta_inventario_id || sourceCategory.cuenta_inventario || '')) || null,
      expenseAccount: this.maps.accounts.get(String(row.cuenta_costo_id || sourceCategory.cuenta_compra_id || sourceCategory.cuenta_compra || '')) || null,
      incomeAccount: this.maps.accounts.get(String(row.cuenta_venta_id || sourceCategory.cuenta_venta_id || sourceCategory.cuenta_venta || '')) || null,
      inventoryCategory: this.maps.categories.get(String(row.categoria_id || '')) || null, unlimited: !physical,
      unit: unitNames.get(String(row.unidad || '')) || String(row.unidad?.nombre || row.unidad || 'unidad'), ...tax(row.porcentaje_iva), active: String(row.estado || 'A') === 'A',
    }; };
    if (this.commit) { const ops = records.filter((record) => record.payload.codigo).map((record) => ({ updateOne: { filter: { clinic: this.clinic._id, code: String(record.payload.codigo) }, update: { $set: fields(record) }, upsert: true } })); for (let i = 0; i < ops.length; i += 500) await Product.bulkWrite(ops.slice(i, i + 500), { ordered: false }); }
    const targets = this.commit ? await Product.find({ clinic: this.clinic._id, code: { $in: codes } }).lean() : current; const byCode = new Map(targets.map((row) => [String(row.code), row])); const marks = [];
    for (const record of records) { const code = String(record.payload.codigo || ''); if (!code) { stage.skipped++; continue; } let target = byCode.get(code); if (!target) { target = { _id: fakeId() }; byCode.set(code, target); } const existed = existingCodes.has(code); existed ? stage.linked++ : stage.created++; stage.projected++; this.maps.products.set(record.externalId, target._id); const warnings = num(record.payload.cantidad_stock) < 0 ? [`Déficit de stock ${record.payload.cantidad_stock} importado y marcado para revisión`] : []; if (warnings.length) this.issue(stage, record.externalId, warnings[0]); marks.push({ recordId: record._id, status: existed ? 'LINKED_EXISTING' : 'PROJECTED', links: [{ model: 'Product', ref: target._id, action: existed ? 'LINK' : 'CREATE' }], warnings }); }
    await this.mark(marks); await this.finishStage(stage);
  }

  async sales() {
    const stage = this.stage('sales');
    const records = (await this.records('document')).filter((record) => {
      const row = record.payload;
      const date = parseDate(row.fecha_emision);
      return String(row.tipo_registro).toUpperCase() === 'CLI'
        && ['FAC', 'NVE'].includes(String(row.tipo_documento).toUpperCase())
        && date && date <= this.cutoff;
    });
    stage.source = records.length;

    let manualProduct = await Product.findOne({ clinic: this.clinic._id, code: 'CTF-ITEM-MANUAL' }).lean();
    if (!manualProduct && this.commit) manualProduct = (await Product.create({
      clinic: this.clinic._id, code: 'CTF-ITEM-MANUAL', name: 'Item manual de Contifico',
      description: 'Renglon historico sin producto_id en el documento de origen', category: 'servicio',
      salePrice: 0, unlimited: true, taxRate: 0, taxCodeSri: '0', taxCategory: 'IVA_0', active: false,
    })).toObject();
    if (!manualProduct) manualProduct = { _id: fakeId(), code: 'CTF-ITEM-MANUAL', name: 'Item manual de Contifico', category: 'servicio' };

    const productRows = await Product.find({ clinic: this.clinic._id }).select('code name category').lean();
    const products = new Map(productRows.map((product) => [String(product._id), product]));
    products.set(String(manualProduct._id), manualProduct);
    const candidates = records.map((record) => ({ record, fields: contificoSaleFields(record, this.maps, products, manualProduct._id) }));
    // La mayoría de ventas ya tiene su enlace de origen archivado. Reutilizarlo
    // evita una consulta $in masiva contra Atlas antes de poder hacer los upsert.
    const before = new Set();
    const saleByKey = new Map();
    for (const candidate of candidates) {
      const link = (candidate.record.projection?.links || []).find((item) => item.model === 'Sale' && item.ref);
      if (!link) continue;
      before.add(candidate.fields.idempotencyKey);
      saleByKey.set(candidate.fields.idempotencyKey, { _id: link.ref, ...candidate.fields });
    }
    if (this.commit) {
      for (let offset = 0; offset < candidates.length; offset += 500) {
        await Sale.bulkWrite(candidates.slice(offset, offset + 500).map(({ fields }) => {
          const { createdAt, ...current } = fields;
          return { updateOne: { filter: { clinic: this.clinic._id, idempotencyKey: fields.idempotencyKey }, update: { $set: { ...current, createdAt } }, upsert: true, timestamps: false } };
        }), { ordered: false, timestamps: false });
      }
      // `createdAt` es inmutable para Mongoose y el ODM lo elimina incluso con timestamps:false.
      // La coleccion nativa conserva la fecha historica del documento de Contifico.
      for (let offset = 0; offset < candidates.length; offset += 1000) {
        await Sale.collection.bulkWrite(candidates.slice(offset, offset + 1000).map(({ fields }) => ({ updateOne: {
          filter: { clinic: this.clinic._id, idempotencyKey: fields.idempotencyKey },
          update: { $set: { createdAt: fields.createdAt } },
        } })), { ordered: false });
      }
    }
    if (this.commit) {
      const unresolvedKeys = candidates.filter(({ fields }) => !saleByKey.has(fields.idempotencyKey)).map(({ fields }) => fields.idempotencyKey);
      for (let offset = 0; offset < unresolvedKeys.length; offset += 500) {
        const rows = await Sale.find({ clinic: this.clinic._id, idempotencyKey: { $in: unresolvedKeys.slice(offset, offset + 500) } }).lean();
        rows.forEach((sale) => saleByKey.set(sale.idempotencyKey, sale));
      }
    } else for (const candidate of candidates) {
      if (!saleByKey.has(candidate.fields.idempotencyKey)) saleByKey.set(candidate.fields.idempotencyKey, { _id: fakeId(), ...candidate.fields });
    }
    const invoices = [];
    for (const candidate of candidates) {
      if (String(candidate.record.payload.tipo_documento).toUpperCase() !== 'FAC') continue;
      const sale = saleByKey.get(candidate.fields.idempotencyKey);
      invoices.push({ candidate, sale, fields: contificoInvoiceFields(candidate.record, sale._id, sale) });
    }
    if (this.commit) {
      for (let offset = 0; offset < invoices.length; offset += 500) {
        await Invoice.bulkWrite(invoices.slice(offset, offset + 500).map(({ fields }) => {
          const { createdAt, ...current } = fields;
          return { updateOne: { filter: { claveAcceso: fields.claveAcceso }, update: { $set: { ...current, createdAt } }, upsert: true, timestamps: false } };
        }), { ordered: false, timestamps: false });
      }
      for (let offset = 0; offset < invoices.length; offset += 1000) {
        await Invoice.collection.bulkWrite(invoices.slice(offset, offset + 1000).map(({ fields }) => ({ updateOne: {
          filter: { claveAcceso: fields.claveAcceso }, update: { $set: { createdAt: fields.createdAt } },
        } })), { ordered: false });
      }
    }
    let invoiceByKey;
    if (this.commit) {
      invoiceByKey = new Map();
      const unresolvedInvoiceKeys = [];
      for (const item of invoices) {
        const link = (item.candidate.record.projection?.links || []).find((entry) => entry.model === 'Invoice' && entry.ref);
        if (link) invoiceByKey.set(item.fields.claveAcceso, { _id: link.ref, claveAcceso: item.fields.claveAcceso });
        else unresolvedInvoiceKeys.push(item.fields.claveAcceso);
      }
      for (let offset = 0; offset < unresolvedInvoiceKeys.length; offset += 500) {
        const rows = await Invoice.find({ claveAcceso: { $in: unresolvedInvoiceKeys.slice(offset, offset + 500) } }).select('_id claveAcceso').lean();
        rows.forEach((invoice) => invoiceByKey.set(invoice.claveAcceso, invoice));
      }
    } else invoiceByKey = new Map(invoices.map(({ fields }) => [fields.claveAcceso, { _id: fakeId(), claveAcceso: fields.claveAcceso }]));
    if (this.commit && invoices.length) {
      for (let offset = 0; offset < invoices.length; offset += 500) {
        await Sale.bulkWrite(invoices.slice(offset, offset + 500).map(({ sale, fields }) => ({ updateOne: {
          filter: { _id: sale._id }, update: { $set: { invoice: invoiceByKey.get(fields.claveAcceso)._id } },
        } })), { ordered: false });
      }
    }
    const marks = candidates.map(({ record, fields }) => {
      const sale = saleByKey.get(fields.idempotencyKey);
      const invoiceData = String(record.payload.tipo_documento).toUpperCase() === 'FAC'
        ? contificoInvoiceFields(record, sale._id, sale) : null;
      const invoice = invoiceData ? invoiceByKey.get(invoiceData.claveAcceso) : null;
      const existed = before.has(fields.idempotencyKey);
      existed ? stage.linked++ : stage.created++;
      stage.projected++;
      const warnings = [];
      if ((record.payload.detalles || []).some((detail) => !detail.producto_id || !this.maps.products.has(String(detail.producto_id)))) warnings.push('Documento con item manual sin producto_id');
      if (!record.payload.anulado && (fields.payments || []).some((payment) => payment.reference === 'CONTIFICO_SIN_DESGLOSE')) warnings.push('Venta sin desglose completo de cobro; diferencia asignada a efectivo');
      warnings.forEach((warning) => this.issue(stage, record.externalId, warning));
      return { recordId: record._id, status: existed ? 'LINKED_EXISTING' : 'PROJECTED', links: [
        { model: 'Sale', ref: sale._id, action: existed ? 'LINK' : 'CREATE' },
        invoice && { model: 'Invoice', ref: invoice._id, action: existed ? 'LINK' : 'CREATE' },
      ].filter(Boolean), warnings };
    });
    await this.mark(marks); await this.finishStage(stage);
  }

  async purchases() {
    const stage = this.stage('purchases');
    const allowed = new Set(['FAC', 'NVE', 'LQC', 'DNA', 'DAC', 'NCT']);
    const source = (await this.records('document')).filter((record) => {
      const row = record.payload, date = parseDate(row.fecha_emision);
      return String(row.tipo_registro).toUpperCase() === 'PRO'
        && allowed.has(String(row.tipo_documento).toUpperCase()) && date && date <= this.cutoff;
    });
    stage.source = source.length;
    // Cada registro de Contífico tiene un sourceRef distinto. Aunque dos históricos
    // compartan proveedor y serie, conservar ambos es necesario para que el sistema
    // replique el origen; la deduplicación de nuevas compras sigue ocurriendo en el
    // controlador de la interfaz, no en esta migración histórica.
    const productRows = await Product.find({ clinic: this.clinic._id }).select('category inventoryCategory').lean();
    const productById = new Map(productRows.map((product) => [String(product._id), product]));
    const docType = { FAC: 'FACTURA', NVE: 'NOTA_VENTA', LQC: 'LIQUIDACION', DNA: 'NOTA_DEBITO_REC', DAC: 'NOTA_DEBITO_REC', NCT: 'NOTA_CREDITO_REC' };
    const candidates = [];
    for (const record of source) {
      const row = record.payload, supplier = this.maps.suppliers.get(String(row.persona_id || ''));
      if (!supplier) { stage.skipped++; this.issue(stage, record.externalId, 'Proveedor sin mapeo'); continue; }
      const date = parseDate(row.fecha_emision), [estab = '', ptoEmi = '', secuencial = record.externalId] = String(row.documento || '').split('-');
      const items = (row.detalles || []).map((detail) => {
        const product = this.maps.products.get(String(detail.producto_id || '')) || null;
        const productMeta = product ? productById.get(String(product)) : null;
        const quantity = num(detail.cantidad, 1), unitPrice = num(detail.precio);
        const subtotal = r2(num(detail.base_cero) + num(detail.base_no_gravable) + num(detail.base_gravable));
        const ivaRate = num(detail.porcentaje_iva), ivaAmount = r2(num(detail.base_gravable) * ivaRate / 100);
        return {
          lineId: `${record.externalId}:${detail.producto_id || 'manual'}:${detail.documento || ''}:${quantity}:${unitPrice}`,
          description: String(detail.producto_nombre || detail.nombre_manual || detail.descripcion || 'Item manual de Contifico'),
          quantity, unitPrice: r2(unitPrice), discount: r2(Math.max(0, quantity * unitPrice - subtotal)), subtotal, ivaRate, ivaAmount,
          lineType: product && productMeta?.category === 'insumo' ? 'INVENTARIO' : 'GASTO',
          costCenter: this.maps.costCenters.get(String(detail.centro_costo_id || '')) || null,
          inventoryCategory: productMeta?.inventoryCategory || null, product,
        };
      });
      const bucket = (rate) => r2(items.filter((item) => item.ivaRate === rate).reduce((sum, item) => sum + item.subtotal, 0));
      const total = r2(row.total), balance = Math.max(0, r2(row.saldo));
      const authorization = /^\d{49}$/.test(String(row.autorizacion || '')) ? String(row.autorizacion) : '';
      const retentions = (row.retenciones || []).map((retention) => ({
        type: String(retention.tipo).toUpperCase() === 'IV' ? 'IVA' : 'RENTA', code: String(retention.codigo_sri || ''),
        description: 'Importado de Contifico', baseAmount: r2(retention.base), percentage: num(retention.porcentaje), amount: r2(retention.valor),
      }));
      candidates.push({ record, fields: {
        clinic: this.clinic._id, supplier, docType: docType[String(row.tipo_documento).toUpperCase()] || 'FACTURA',
        estab, ptoEmi, secuencial, serie: String(row.documento || `CTF-${record.externalId}`), claveAcceso: authorization,
        fechaEmision: date, fechaRegistro: parseDate(row.fecha_creacion) || date, fechaVencimiento: parseDate(row.fecha_vencimiento),
        creditDays: parseDate(row.fecha_vencimiento) ? Math.max(0, Math.round((parseDate(row.fecha_vencimiento) - date) / 86400000)) : 0,
        costCenter: items.map((item) => item.costCenter).find(Boolean) || null, autorizacion: authorization, items,
        subtotal0: bucket(0), subtotal5: bucket(5), subtotal12: bucket(12), subtotal15: bucket(15),
        subtotalNoObjeto: r2((row.detalles || []).reduce((sum, detail) => sum + num(detail.base_no_gravable), 0)),
        subtotal: r2(items.reduce((sum, item) => sum + item.subtotal, 0)), discount: r2(items.reduce((sum, item) => sum + item.discount, 0)),
        iva: r2(row.iva), ice: r2(row.ice), total, retentions, retentionTotal: r2(retentions.reduce((sum, item) => sum + item.amount, 0)),
        retentionNumber: String(row.retenciones?.[0]?.numero_comprobante || ''), balance, paid: balance <= 0.01,
        status: row.anulado ? 'ANULADA' : (balance <= 0.01 ? 'PAGADA' : 'REGISTRADA'),
        notes: `Importado de Contifico (${record.externalId})`, strictAccounts: false,
        sourceModel: 'ContificoRecord', sourceRef: record._id,
      } });
    }
    const refs = candidates.map(({ record }) => record._id);
    const before = new Set((await PurchaseInvoice.find({ clinic: this.clinic._id, sourceModel: 'ContificoRecord', sourceRef: { $in: refs } }).select('sourceRef').lean()).map((row) => String(row.sourceRef)));
    if (this.commit) for (let offset = 0; offset < candidates.length; offset += 300) {
      await PurchaseInvoice.bulkWrite(candidates.slice(offset, offset + 300).map(({ record, fields }) => ({ updateOne: {
        filter: { clinic: this.clinic._id, sourceModel: 'ContificoRecord', sourceRef: record._id }, update: { $set: fields }, upsert: true,
      } })), { ordered: false });
    }
    const targets = this.commit ? await PurchaseInvoice.find({ clinic: this.clinic._id, sourceModel: 'ContificoRecord', sourceRef: { $in: refs } }).select('sourceRef').lean() : candidates.map(({ record }) => ({ _id: fakeId(), sourceRef: record._id }));
    const targetByRef = new Map(targets.map((target) => [String(target.sourceRef), target]));
    const marks = candidates.map(({ record }) => {
      const existed = before.has(String(record._id)); existed ? stage.linked++ : stage.created++; stage.projected++;
      return { recordId: record._id, status: existed ? 'LINKED_EXISTING' : 'PROJECTED', links: [{ model: 'PurchaseInvoice', ref: targetByRef.get(String(record._id))._id, action: existed ? 'LINK' : 'CREATE' }] };
    });
    await this.mark(marks); await this.finishStage(stage);
  }

  async inventoryMovements() {
    const stage = this.stage('inventory_movements'); const records = await this.records('inventory_movement'); stage.source = records.length;
    const candidates = [], marks = [];
    for (const record of records) {
      const row = record.payload, date = parseDate(row.fecha);
      if (!date || date > this.cutoff) { stage.skipped++; continue; }
      const warehouse = this.maps.warehouses.get(String(row.bodega_id || '')) || null;
      const toWarehouse = this.maps.warehouses.get(String(row.bodega_destino_id || '')) || null;
      const links = [], warnings = [];
      for (const [index, detail] of (row.detalles || []).entries()) {
        const product = this.maps.products.get(String(detail.producto_id || '')), quantity = Math.abs(num(detail.cantidad));
        if (!product || quantity <= 0) { warnings.push(`Linea ${index + 1} sin producto o cantidad`); continue; }
        const unitCost = Math.max(0, num(detail.costo_promedio || detail.precio));
        const base = { clinic: this.clinic._id, product, movementDate: date, dateSource: 'MOVIMIENTO', costCenter: null,
          quantity, unitCost, totalCost: r2(quantity * unitCost), balanceAfter: 0, reason: String(row.descripcion || ''),
          sourceModel: 'ContificoRecord', sourceRef: record._id };
        if (String(row.tipo).toUpperCase() === 'TRA') {
          candidates.push({ record, key: `${row.codigo}:${index}:OUT`, fields: { ...base, type: 'salida', warehouse, toWarehouse, transferGroup: record._id, reference: `${row.codigo}:${index}:OUT` } });
          candidates.push({ record, key: `${row.codigo}:${index}:IN`, fields: { ...base, type: 'entrada', warehouse: toWarehouse, toWarehouse: warehouse, transferGroup: record._id, reference: `${row.codigo}:${index}:IN` } });
        } else candidates.push({ record, key: `${row.codigo}:${index}`, fields: { ...base, type: String(row.tipo).toUpperCase() === 'ING' ? 'entrada' : (String(row.tipo).toUpperCase() === 'EGR' ? 'salida' : 'ajuste'), warehouse, reference: `${row.codigo}:${index}` } });
      }
      if (warnings.length) warnings.forEach((warning) => this.issue(stage, record.externalId, warning));
      marks.push({ record, links, warnings });
    }
    // Los registros ya proyectados conservan sus enlaces en el archivo. No se
    // consulta una lista $in de miles de sourceRef; Atlas se degrada mucho con
    // ese patrón. Solo se recuperan los destinos de filas realmente nuevas.
    const linksByRecord = new Map(records.map((record) => [String(record._id), (record.projection?.links || [])
      .filter((link) => link.model === 'InventoryMovement' && link.ref)]));
    const writeCandidates = this.skipLinkedInventory
      ? candidates.filter((candidate) => !(linksByRecord.get(String(candidate.record._id)) || []).length)
      : candidates;
    if (this.commit) for (let offset = 0; offset < writeCandidates.length; offset += 500) await InventoryMovement.bulkWrite(writeCandidates.slice(offset, offset + 500).map(({ record, key, fields }) => ({ updateOne: {
      filter: { clinic: this.clinic._id, sourceModel: 'ContificoRecord', sourceRef: record._id, reference: key }, update: { $set: fields }, upsert: true,
    } })), { ordered: false });
    const unlinkedRecordIds = records.filter((record) => !(linksByRecord.get(String(record._id)) || []).length).map((record) => record._id);
    const targets = [];
    if (this.commit) for (let offset = 0; offset < unlinkedRecordIds.length; offset += 500) {
      targets.push(...await InventoryMovement.find({ clinic: this.clinic._id, sourceModel: 'ContificoRecord', sourceRef: { $in: unlinkedRecordIds.slice(offset, offset + 500) } }).select('sourceRef reference').lean());
    } else targets.push(...candidates.map(({ record, key }) => ({ _id: fakeId(), sourceRef: record._id, reference: key })));
    const targetMap = new Map(targets.map((target) => [`${target.sourceRef}|${target.reference}`, target]));
    const candidatesByRecord = new Map(); for (const candidate of candidates) { const key = String(candidate.record._id); if (!candidatesByRecord.has(key)) candidatesByRecord.set(key, []); candidatesByRecord.get(key).push(candidate); }
    const finalMarks = marks.map(({ record, warnings }) => {
      const priorLinks = linksByRecord.get(String(record._id)) || [];
      const rows = candidatesByRecord.get(String(record._id)) || [];
      const links = priorLinks.length
        ? priorLinks.map((link) => ({ model: 'InventoryMovement', ref: link.ref, action: 'LINK' }))
        : rows.map(({ key }) => ({ model: 'InventoryMovement', ref: targetMap.get(`${record._id}|${key}`)?._id, action: 'CREATE' })).filter((link) => link.ref);
      if (!links.length) { stage.skipped++; return { recordId: record._id, status: 'REVIEW', warnings: warnings.length ? warnings : ['Sin lineas proyectables'] }; }
      stage.projected++; if (priorLinks.length) stage.linked++; else stage.created++;
      return { recordId: record._id, status: links.every((link) => link.action === 'LINK') ? 'LINKED_EXISTING' : 'PROJECTED', links, warnings };
    });
    await this.mark(this.skipLinkedInventory ? finalMarks.filter((mark) => mark.status !== 'LINKED_EXISTING') : finalMarks); await this.finishStage(stage);
  }

  async bankMovements() {
    const stage = this.stage('bank_movements'); const records = await this.records('bank_movement'); stage.source = records.length;
    const persons = await this.records('person'), personNames = new Map(persons.map((record) => [record.externalId, String(record.payload.razon_social || record.payload.nombre_comercial || '')]));
    const candidates = [], marks = [];
    for (const record of records) {
      const row = record.payload, date = parseDate(row.fecha_emision), bankAccount = this.maps.banks.get(String(row.cuenta_bancaria_id || ''));
      const amount = r2((row.detalles || []).reduce((sum, detail) => sum + num(detail.monto), 0));
      if (!date || date > this.cutoff || !bankAccount || amount <= 0) { stage.skipped++; this.issue(stage, record.externalId, 'Movimiento bancario sin fecha, cuenta o importe'); marks.push({ record, warning: 'Movimiento bancario sin fecha, cuenta o importe' }); continue; }
      const income = String(row.tipo_registro).toUpperCase() === 'I', code = String(row.tipo).toUpperCase();
      const type = income ? (code === 'D' ? 'DEPOSITO' : (code === 'N' ? 'INTERES' : 'AJUSTE')) : (code === 'C' ? 'CHEQUE_EMITIDO' : (code === 'T' ? 'TRANSFERENCIA_OUT' : 'PAGO'));
      candidates.push({ record, fields: { clinic: this.clinic._id, bankAccount, date, type, amount, direction: income ? 1 : -1,
        description: `Importado de Contifico ${record.externalId}`, reference: String(row.numero_comprobante || ''), partyName: personNames.get(String(row.persona || '')) || '',
        costCenter: this.maps.costCenters.get(String(row.detalles?.[0]?.centro_costo_id || '')) || null, sourceModel: 'ContificoRecord', sourceRef: record._id } });
    }
    const before = new Set((await BankTransaction.find({ clinic: this.clinic._id, sourceModel: 'ContificoRecord', sourceRef: { $in: records.map((record) => record._id) } }).select('sourceRef').lean()).map((row) => String(row.sourceRef)));
    if (this.commit) for (let offset = 0; offset < candidates.length; offset += 500) await BankTransaction.bulkWrite(candidates.slice(offset, offset + 500).map(({ record, fields }) => ({ updateOne: {
      filter: { clinic: this.clinic._id, sourceModel: 'ContificoRecord', sourceRef: record._id }, update: { $set: fields }, upsert: true,
    } })), { ordered: false });
    const targets = this.commit ? await BankTransaction.find({ clinic: this.clinic._id, sourceModel: 'ContificoRecord', sourceRef: { $in: records.map((record) => record._id) } }).select('sourceRef').lean() : candidates.map(({ record }) => ({ _id: fakeId(), sourceRef: record._id }));
    const targetByRef = new Map(targets.map((target) => [String(target.sourceRef), target]));
    for (const { record } of candidates) { const existed = before.has(String(record._id)); existed ? stage.linked++ : stage.created++; stage.projected++; marks.push({ record, target: targetByRef.get(String(record._id)), existed }); }
    await this.mark(marks.map(({ record, target, existed, warning }) => warning ? { recordId: record._id, status: 'REVIEW', warnings: [warning] } : { recordId: record._id, status: existed ? 'LINKED_EXISTING' : 'PROJECTED', links: [{ model: 'BankTransaction', ref: target._id, action: existed ? 'LINK' : 'CREATE' }] }));
    await this.finishStage(stage);
  }

  async journals() {
    const stage = this.stage('journal_entries'); const records = await this.records('journal_entry'); stage.source = records.length;
    const accountRecords = await this.records('chart_account'); const accountMeta = new Map(accountRecords.map((record) => [record.externalId, record.payload]));
    const ccRecords = await this.records('cost_center'); const ccMap = new Map(ccRecords.map((record) => [record.externalId, this.maps.costCenters.get(record.externalId)]));
    const monthSet = new Map(); for (const record of records) { const date = parseDate(record.payload.fecha); if (date && date <= this.cutoff) monthSet.set(`${date.getUTCFullYear()}-${date.getUTCMonth() + 1}`, { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 }); }
    const oldPeriods = await FiscalPeriod.find({ clinic: this.clinic._id }).lean(); const oldKeys = new Set(oldPeriods.map((row) => `${row.year}-${row.month}`));
    // Un período se cierra por ser PASADO, no por quedar fuera del corte. Cerrar
    // según el corte dejaba octubre y noviembre cerrados de antemano y, como
    // `assertPeriodOpen` rechaza asientos en período cerrado, al llegar ese mes
    // la clínica no habría podido facturar.
    const hoy = new Date();
    const abierto = (value) => value.year > hoy.getFullYear() || (value.year === hoy.getFullYear() && value.month >= hoy.getMonth() + 1);
    if (this.commit) await FiscalPeriod.bulkWrite([...monthSet.values()].map((value) => ({ updateOne: { filter: { clinic: this.clinic._id, ...value }, update: { $setOnInsert: { clinic: this.clinic._id, ...value, status: abierto(value) ? 'ABIERTO' : 'CERRADO', notes: 'Migracion Contifico' } }, upsert: true } })), { ordered: false });
    const periods = this.commit ? await FiscalPeriod.find({ clinic: this.clinic._id }).lean() : oldPeriods; const periodByKey = new Map(periods.map((row) => [`${row.year}-${row.month}`, row])); for (const [key, value] of monthSet) if (!periodByKey.has(key)) periodByKey.set(key, { _id: fakeId(), ...value });
    const candidates = [], marks = [];
    for (const record of records) {
      const row = record.payload, date = parseDate(row.fecha);
      if (!date || date > this.cutoff) { stage.skipped++; marks.push({ recordId: record._id, status: 'REVIEW', warnings: [date ? `Posterior al corte ${fmt(this.cutoff)}` : 'Fecha invalida'] }); continue; }
      const warnings = [], lines = [];
      for (const detail of row.detalles || []) { const sourceAccount = String(detail.cuenta_id || ''), targetAccount = this.maps.accounts.get(sourceAccount); if (!targetAccount) { warnings.push(`Cuenta sin mapeo ${sourceAccount}`); continue; } const meta = accountMeta.get(sourceAccount) || {}, value = Math.max(0, num(detail.valor)); lines.push({ account: targetAccount, accountCode: String(meta.codigo || ''), accountName: String(meta.nombre || ''), costCenter: ccMap.get(String(detail.centro_costo_id || '')) || null, description: '', debit: String(detail.tipo).toUpperCase() === 'D' ? value : 0, credit: String(detail.tipo).toUpperCase() === 'H' ? value : 0 }); }
      const debit = +lines.reduce((sum, line) => sum + line.debit, 0).toFixed(2), credit = +lines.reduce((sum, line) => sum + line.credit, 0).toFixed(2);
      if (!lines.length || warnings.length || Math.abs(debit - credit) > 0.01) { if (!lines.length) warnings.push('Sin lineas'); if (Math.abs(debit - credit) > 0.01) warnings.push(`Descuadrado ${debit}/${credit}`); stage.skipped++; warnings.forEach((warning) => this.issue(stage, record.externalId, warning)); marks.push({ recordId: record._id, status: 'REVIEW', warnings }); continue; }
      candidates.push({ record, number: `CTF-${record.externalId}`, doc: { clinic: this.clinic._id, number: `CTF-${record.externalId}`, date, period: periodByKey.get(`${date.getUTCFullYear()}-${date.getUTCMonth() + 1}`)?._id || null, description: String(row.glosa || `Contifico ${record.externalId}`), source: 'MIGRACION', sourceRef: record._id, sourceModel: 'ContificoRecord', sourceAction: 'IMPORT', lines, totalDebit: debit, totalCredit: credit, status: 'CONTABILIZADO' } });
    }
    const oldNumbers = new Set();
    const targetByNumber = new Map();
    for (const item of candidates) {
      const link = (item.record.projection?.links || []).find((entry) => entry.model === 'JournalEntry' && entry.ref);
      if (!link) continue;
      oldNumbers.add(item.number);
      targetByNumber.set(item.number, { _id: link.ref, number: item.number });
    }
    // La llave CTF-* solo pertenece a asientos importados. Reaplicar el origen
    // actualiza correcciones hechas en Contífico, en vez de congelar el primer
    // valor que se importó.
    if (this.commit) { for (let i = 0; i < candidates.length; i += 300) await JournalEntry.bulkWrite(candidates.slice(i, i + 300).map((item) => ({ updateOne: { filter: { clinic: this.clinic._id, number: item.number }, update: { $set: item.doc }, upsert: true } })), { ordered: false }); }
    if (this.commit) {
      const unresolvedNumbers = candidates.filter((item) => !targetByNumber.has(item.number)).map((item) => item.number);
      for (let offset = 0; offset < unresolvedNumbers.length; offset += 500) {
        const rows = await JournalEntry.find({ clinic: this.clinic._id, number: { $in: unresolvedNumbers.slice(offset, offset + 500) } }).select('number').lean();
        rows.forEach((row) => targetByNumber.set(row.number, row));
      }
    }
    for (const item of candidates) { const existed = oldNumbers.has(item.number), target = targetByNumber.get(item.number) || { _id: fakeId() }; existed ? stage.linked++ : stage.created++; stage.projected++; marks.push({ recordId: item.record._id, status: existed ? 'LINKED_EXISTING' : 'PROJECTED', links: [{ model: 'JournalEntry', ref: target._id, action: existed ? 'LINK' : 'CREATE' }] }); }
    await this.mark(marks); await this.finishStage(stage);

    const balanceStage = this.stage('account_balances');
    if (this.commit) {
      // Es un resumen materializado de los asientos, no una fuente primaria.
      // Reconstruirlo evita que sobreviva un saldo de un asiento que Contífico
      // ya retiró de la instantánea actual.
      await AccountBalance.deleteMany({ clinic: this.clinic._id });
      const balances = await JournalEntry.aggregate([{ $match: { clinic: this.clinic._id, status: 'CONTABILIZADO' } }, { $unwind: '$lines' }, { $group: { _id: { account: '$lines.account', year: { $year: '$date' }, month: { $month: '$date' } }, debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } }]);
      balanceStage.source = balances.length; const result = balances.length ? await AccountBalance.bulkWrite(balances.map((row) => ({ updateOne: { filter: { clinic: this.clinic._id, account: row._id.account, year: row._id.year, month: row._id.month }, update: { $set: { debit: +num(row.debit).toFixed(2), credit: +num(row.credit).toFixed(2) } }, upsert: true } })), { ordered: false }) : null;
      balanceStage.created = result?.upsertedCount || 0; balanceStage.projected = balances.length; balanceStage.linked = (result?.matchedCount || 0);
    }
    await this.finishStage(balanceStage);
  }

  async subledger() {
    const stage = this.stage('open_subledger'); const documents = await this.records('document'), persons = await this.records('person'); const personById = new Map(persons.map((record) => [record.externalId, record]));
    const receivableOps = [], payableOps = [];
    for (const record of documents) { const row = record.payload, balance = num(row.saldo), date = parseDate(row.fecha_emision); if (balance <= 0.005 || row.anulado || !date || date > this.cutoff) continue; stage.source++; const person = personById.get(String(row.persona_id || '')), client = String(row.tipo_registro).toUpperCase() === 'CLI', patient = person ? this.maps.patients.get(person.externalId) : null, supplier = person ? this.maps.suppliers.get(person.externalId) : null, total = Math.max(balance, num(row.total)); const payload = { clinic: this.clinic._id, party: { model: client && patient ? 'Patient' : 'Supplier', ref: client ? (patient || supplier || null) : (supplier || null), name: String(row.cliente?.razon_social || person?.payload?.razon_social || '') }, sourceModel: 'ContificoRecord', sourceRef: record._id, docType: ledgerDocType(row.tipo_documento), number: String(row.documento || ''), issueDate: date, dueDate: parseDate(row.fecha_vencimiento), currency: 'USD', total, applied: +(total - balance).toFixed(2), balance, status: total - balance > 0 ? 'PARCIAL' : 'ABIERTO', account: person ? this.maps.accounts.get(String(client ? person.payload.cuenta_por_cobrar_id : person.payload.cuenta_por_pagar_id)) || null : null, notes: `Contifico ${record.externalId}` }; (client ? receivableOps : payableOps).push({ updateOne: { filter: { clinic: this.clinic._id, sourceModel: 'ContificoRecord', sourceRef: record._id }, update: { $set: payload }, upsert: true } }); }
    if (this.commit) { if (receivableOps.length) await Receivable.bulkWrite(receivableOps, { ordered: false }); if (payableOps.length) await Payable.bulkWrite(payableOps, { ordered: false }); }
    stage.created = receivableOps.length + payableOps.length; stage.projected = stage.created; this.log(`CxC=${receivableOps.length} CxP=${payableOps.length}`); await this.finishStage(stage);
  }

  async execute() {
    await this.begin();
    try {
      await this.accounts(); await this.costCenters(); await this.categories(); await this.warehouses(); await this.banks(); await this.persons(); await this.products();
      const operationalOnly = this.only === 'operational';
      const journalsOnly = this.only === 'journals';
      if (!operationalOnly && !journalsOnly) await this.sales();
      if (!journalsOnly && this.stopAfter !== 'sales') { await this.purchases(); await this.inventoryMovements(); await this.bankMovements(); }
      if (!operationalOnly && this.stopAfter !== 'sales' && this.stopAfter !== 'operational') { await this.journals(); await this.subledger(); }
      if (this.run) { this.run.status = this.issues.length ? 'COMPLETED_WITH_WARNINGS' : 'COMPLETED'; this.run.completedAt = new Date(); this.run.issues = this.issues; await this.run.save(); }
      return { stages: this.stages, issues: this.issues };
    }
    catch (error) { if (this.run) { this.run.status = 'FAILED'; this.run.completedAt = new Date(); this.run.issues = [...this.issues, { message: error.message }]; await this.run.save(); } throw error; }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2)); if (!process.env.MONGODB_URI) throw new Error('Falta MONGODB_URI');
  console.log(`MODO ${options.commit ? 'COMMIT' : 'DRY_RUN'} | PROJECT`); await mongoose.connect(process.env.MONGODB_URI);
  const clinic = options.clinicId ? await Clinic.findById(options.clinicId).lean() : await Clinic.findOne({ name: new RegExp(`^${options.clinicName}$`, 'i') }).lean(); if (!clinic) throw new Error('Clinica destino no encontrada');
  console.log(`Clinica: ${clinic.name} (${clinic._id})`); console.log(JSON.stringify(await new Projector({ clinic, ...options }).execute(), null, 2));
}
if (require.main === module) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; }).finally(() => mongoose.disconnect().catch(() => {}));
module.exports = { Projector, parseArgs, accountType, nature, splitName, tax, ledgerDocType, contificoDate, contificoPayment, contificoSaleItem, contificoSaleFields, contificoInvoiceFields };
