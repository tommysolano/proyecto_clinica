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
  };
}

class Projector {
  constructor({ clinic, commit, cutoff }) {
    this.clinic = clinic;
    this.commit = commit;
    this.cutoff = cutoff;
    this.run = null;
    this.stages = [];
    this.issues = [];
    this.maps = { accounts: new Map(), costCenters: new Map(), categories: new Map(), warehouses: new Map(), banks: new Map(), suppliers: new Map(), patients: new Map(), products: new Map(), periods: new Map() };
  }
  log(text) { console.log(`[project] ${text}`); }
  stage(name) { const stage = { name, source: 0, created: 0, linked: 0, projected: 0, skipped: 0, warnings: 0, status: 'RUNNING' }; this.stages.push(stage); this.log(`inicio ${name}`); return stage; }
  issue(stage, externalId, message) { stage.warnings += 1; if (this.issues.length < 500) this.issues.push({ stage: stage.name, externalId, message }); }
  async finishStage(stage) { stage.status = stage.warnings ? 'COMPLETED_WITH_WARNINGS' : 'COMPLETED'; this.log(`fin ${stage.name}: source=${stage.source} created=${stage.created} linked=${stage.linked} projected=${stage.projected} skipped=${stage.skipped} warnings=${stage.warnings}`); if (this.run) { this.run.stages = this.stages; this.run.issues = this.issues; await this.run.save(); } }
  async records(entity) {
    const records = await ContificoRecord.find({ clinic: this.clinic._id, entity }).sort({ externalId: 1 }).lean();
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
  async begin() { if (this.commit) this.run = await ContificoMigrationRun.create({ clinic: this.clinic._id, mode: 'COMMIT', phase: 'PROJECT', range: { cutoff: this.cutoff } }); }

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
    if (this.commit) await InventoryCategory.bulkWrite(records.map((record) => ({ updateOne: { filter: { clinic: this.clinic._id, code: `CTF-${record.externalId}` }, update: { $setOnInsert: makeFields(record) }, upsert: true } })), { ordered: false });
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
    const ids = [...new Set(records.map((record) => identification(record.payload)).filter(Boolean))];
    const oldSuppliers = await Supplier.find({ clinic: this.clinic._id, ruc: { $in: ids } }).lean(); const oldPatients = await Patient.find({ cedula: { $in: ids } }).lean();
    const oldSupplierIds = new Set(oldSuppliers.map((row) => String(row.ruc))), oldPatientIds = new Set(oldPatients.map((row) => String(row.cedula)));
    if (this.commit) {
      const supplierOps = [], patientOps = [];
      for (const record of records) {
        const row = record.payload, id = identification(row); if (!id) continue;
        const roles = [['es_cliente', 'CLIENTE'], ['es_proveedor', 'PROVEEDOR'], ['es_empleado', 'EMPLEADO'], ['es_vendedor', 'VENDEDOR']].filter(([field]) => row[field]).map(([, role]) => role);
        const needsSupplier = row.es_proveedor || row.es_empleado || row.es_vendedor || !row.es_cliente;
        if (needsSupplier) supplierOps.push({ updateOne: { filter: { clinic: this.clinic._id, ruc: id }, update: { $setOnInsert: { clinic: this.clinic._id, ruc: id, tipoIdentificacion: idType(id), razonSocial: String(row.razon_social || row.nombre_comercial || id), nombreComercial: String(row.nombre_comercial || ''), roles: roles.length ? roles : ['CLIENTE'], address: String(row.direccion || ''), phone: String(row.telefonos || ''), email: String(row.email || ''), creditDays: num(row.dias_credito), active: true, notes: `Contifico ${record.externalId}` } }, upsert: true } });
        if (row.es_cliente) { const names = splitName(row.razon_social || row.nombre_comercial || id); patientOps.push({ updateOne: { filter: { cedula: id }, update: { $setOnInsert: { clinic: this.clinic._id, cedula: id, ...names, email: String(row.email || ''), phone: String(row.telefonos || ''), address: String(row.direccion || ''), notes: `Contifico ${record.externalId}`, active: true } }, upsert: true } }); }
      }
      for (let i = 0; i < supplierOps.length; i += 1000) await Supplier.bulkWrite(supplierOps.slice(i, i + 1000), { ordered: false });
      for (let i = 0; i < patientOps.length; i += 1000) await Patient.bulkWrite(patientOps.slice(i, i + 1000), { ordered: false });
    }
    const suppliers = this.commit ? await Supplier.find({ clinic: this.clinic._id, ruc: { $in: ids } }).lean() : oldSuppliers;
    const patients = this.commit ? await Patient.find({ cedula: { $in: ids } }).lean() : oldPatients;
    const supplierById = new Map(suppliers.map((row) => [String(row.ruc), row])), patientById = new Map(patients.map((row) => [String(row.cedula), row])); const marks = [];
    for (const record of records) {
      const id = identification(record.payload); if (!id) { stage.skipped++; continue; }
      const needsSupplier = record.payload.es_proveedor || record.payload.es_empleado || record.payload.es_vendedor || !record.payload.es_cliente;
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
    const codes = records.map((record) => String(record.payload.codigo || '')).filter(Boolean); const current = await Product.find({ code: { $in: codes } }).lean(); const existingCodes = new Set(current.map((row) => String(row.code)));
    const categoryRecords = await this.records('category'); const categoryNames = new Map(categoryRecords.map((record) => [record.externalId, String(record.payload.nombre || '')]));
    const categorySource = new Map(categoryRecords.map((record) => [record.externalId, record.payload]));
    const unitRecords = await this.records('unit'); const unitNames = new Map(unitRecords.map((record) => [record.externalId, String(record.payload.nombre || 'unidad')]));
    const fields = (record) => { const row = record.payload, physical = String(row.tipo).toUpperCase() === 'PRO', rawStock = num(row.cantidad_stock), salePrice = Math.max(0, num(row.pvp1)), sourceCategory = categorySource.get(String(row.categoria_id || '')) || {}; return {
      clinic: this.clinic._id, code: String(row.codigo), barcode: String(row.codigo_barra || row.codigo_auxiliar || ''), name: String(row.nombre || row.codigo), description: String(row.descripcion || ''), category: physical ? 'insumo' : 'servicio', categoria: categoryNames.get(String(row.categoria_id)) || '', isComposite: String(row.tipo_producto).toUpperCase() === 'COP',
      stock: Math.max(0, rawStock), stockByClinic: [{ clinic: this.clinic._id, stock: Math.max(0, rawStock) }], availableInClinics: [], purchasePrice: Math.max(0, num(row.costo_maximo)), averageCost: Math.max(0, num(row.costo_maximo)), salePrice, salePrices: [{ name: 'General', price: salePrice, active: true }], minStock: Math.max(0, num(row.minimo)),
      inventoryAccount: this.maps.accounts.get(String(sourceCategory.cuenta_inventario_id || sourceCategory.cuenta_inventario || '')) || null,
      expenseAccount: this.maps.accounts.get(String(row.cuenta_costo_id || sourceCategory.cuenta_compra_id || sourceCategory.cuenta_compra || '')) || null,
      incomeAccount: this.maps.accounts.get(String(row.cuenta_venta_id || sourceCategory.cuenta_venta_id || sourceCategory.cuenta_venta || '')) || null,
      inventoryCategory: this.maps.categories.get(String(row.categoria_id || '')) || null, unlimited: !physical,
      unit: unitNames.get(String(row.unidad || '')) || String(row.unidad?.nombre || row.unidad || 'unidad'), ...tax(row.porcentaje_iva), active: String(row.estado || 'A') === 'A',
    }; };
    if (this.commit) { const ops = records.filter((record) => record.payload.codigo).map((record) => ({ updateOne: { filter: { code: String(record.payload.codigo) }, update: { $setOnInsert: fields(record) }, upsert: true } })); for (let i = 0; i < ops.length; i += 500) await Product.bulkWrite(ops.slice(i, i + 500), { ordered: false }); }
    const targets = this.commit ? await Product.find({ code: { $in: codes } }).lean() : current; const byCode = new Map(targets.map((row) => [String(row.code), row])); const marks = [];
    for (const record of records) { const code = String(record.payload.codigo || ''); if (!code) { stage.skipped++; continue; } let target = byCode.get(code); if (!target) { target = { _id: fakeId() }; byCode.set(code, target); } const existed = existingCodes.has(code); existed ? stage.linked++ : stage.created++; stage.projected++; this.maps.products.set(record.externalId, target._id); const warnings = num(record.payload.cantidad_stock) < 0 ? [`Stock negativo ${record.payload.cantidad_stock}: saldo operativo en cero; original archivado`] : []; if (warnings.length) this.issue(stage, record.externalId, warnings[0]); marks.push({ recordId: record._id, status: existed ? 'LINKED_EXISTING' : 'PROJECTED', links: [{ model: 'Product', ref: target._id, action: existed ? 'LINK' : 'CREATE' }], warnings }); }
    await this.mark(marks); await this.finishStage(stage);
  }

  async journals() {
    const stage = this.stage('journal_entries'); const records = await this.records('journal_entry'); stage.source = records.length;
    const accountRecords = await this.records('chart_account'); const accountMeta = new Map(accountRecords.map((record) => [record.externalId, record.payload]));
    const ccRecords = await this.records('cost_center'); const ccMap = new Map(ccRecords.map((record) => [record.externalId, this.maps.costCenters.get(record.externalId)]));
    const monthSet = new Map(); for (const record of records) { const date = parseDate(record.payload.fecha); if (date && date <= this.cutoff) monthSet.set(`${date.getUTCFullYear()}-${date.getUTCMonth() + 1}`, { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 }); }
    const oldPeriods = await FiscalPeriod.find({ clinic: this.clinic._id }).lean(); const oldKeys = new Set(oldPeriods.map((row) => `${row.year}-${row.month}`));
    if (this.commit) await FiscalPeriod.bulkWrite([...monthSet.values()].map((value) => ({ updateOne: { filter: { clinic: this.clinic._id, ...value }, update: { $setOnInsert: { clinic: this.clinic._id, ...value, status: value.year === this.cutoff.getUTCFullYear() && value.month === this.cutoff.getUTCMonth() + 1 ? 'ABIERTO' : 'CERRADO', notes: 'Migracion Contifico' } }, upsert: true } })), { ordered: false });
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
    const oldNumbers = new Set(await JournalEntry.find({ clinic: this.clinic._id, number: { $in: candidates.map((item) => item.number) } }).distinct('number'));
    if (this.commit) { for (let i = 0; i < candidates.length; i += 300) await JournalEntry.bulkWrite(candidates.slice(i, i + 300).map((item) => ({ updateOne: { filter: { clinic: this.clinic._id, number: item.number }, update: { $setOnInsert: item.doc }, upsert: true } })), { ordered: false }); }
    const targets = this.commit ? await JournalEntry.find({ clinic: this.clinic._id, number: { $in: candidates.map((item) => item.number) } }).select('number').lean() : []; const targetByNumber = new Map(targets.map((row) => [row.number, row]));
    for (const item of candidates) { const existed = oldNumbers.has(item.number), target = targetByNumber.get(item.number) || { _id: fakeId() }; existed ? stage.linked++ : stage.created++; stage.projected++; marks.push({ recordId: item.record._id, status: existed ? 'LINKED_EXISTING' : 'PROJECTED', links: [{ model: 'JournalEntry', ref: target._id, action: existed ? 'LINK' : 'CREATE' }] }); }
    await this.mark(marks); await this.finishStage(stage);

    const balanceStage = this.stage('account_balances');
    if (this.commit) {
      const balances = await JournalEntry.aggregate([{ $match: { clinic: this.clinic._id, status: 'CONTABILIZADO' } }, { $unwind: '$lines' }, { $group: { _id: { account: '$lines.account', year: { $year: '$date' }, month: { $month: '$date' } }, debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } }]);
      balanceStage.source = balances.length; const result = balances.length ? await AccountBalance.bulkWrite(balances.map((row) => ({ updateOne: { filter: { clinic: this.clinic._id, account: row._id.account, year: row._id.year, month: row._id.month }, update: { $set: { debit: +num(row.debit).toFixed(2), credit: +num(row.credit).toFixed(2) } }, upsert: true } })), { ordered: false }) : null;
      balanceStage.created = result?.upsertedCount || 0; balanceStage.projected = balances.length; balanceStage.linked = (result?.matchedCount || 0);
    }
    await this.finishStage(balanceStage);
  }

  async subledger() {
    const stage = this.stage('open_subledger'); const documents = await this.records('document'), persons = await this.records('person'); const personById = new Map(persons.map((record) => [record.externalId, record]));
    const receivableOps = [], payableOps = [];
    for (const record of documents) { const row = record.payload, balance = num(row.saldo), date = parseDate(row.fecha_emision); if (balance <= 0.005 || row.anulado || !date || date > this.cutoff) continue; stage.source++; const person = personById.get(String(row.persona_id || '')), client = String(row.tipo_registro).toUpperCase() === 'CLI', patient = person ? this.maps.patients.get(person.externalId) : null, supplier = person ? this.maps.suppliers.get(person.externalId) : null, total = Math.max(balance, num(row.total)); const payload = { clinic: this.clinic._id, party: { model: client && patient ? 'Patient' : 'Supplier', ref: client ? (patient || supplier || null) : (supplier || null), name: String(row.cliente?.razon_social || person?.payload?.razon_social || '') }, sourceModel: 'ContificoRecord', sourceRef: record._id, docType: ledgerDocType(row.tipo_documento), number: String(row.documento || ''), issueDate: date, dueDate: parseDate(row.fecha_vencimiento), currency: 'USD', total, applied: +(total - balance).toFixed(2), balance, status: total - balance > 0 ? 'PARCIAL' : 'ABIERTO', account: person ? this.maps.accounts.get(String(client ? person.payload.cuenta_por_cobrar_id : person.payload.cuenta_por_pagar_id)) || null : null, notes: `Contifico ${record.externalId}` }; (client ? receivableOps : payableOps).push({ updateOne: { filter: { clinic: this.clinic._id, sourceModel: 'ContificoRecord', sourceRef: record._id }, update: { $setOnInsert: payload }, upsert: true } }); }
    if (this.commit) { if (receivableOps.length) await Receivable.bulkWrite(receivableOps, { ordered: false }); if (payableOps.length) await Payable.bulkWrite(payableOps, { ordered: false }); }
    stage.created = receivableOps.length + payableOps.length; stage.projected = stage.created; this.log(`CxC=${receivableOps.length} CxP=${payableOps.length}`); await this.finishStage(stage);
  }

  async execute() {
    await this.begin();
    try { await this.accounts(); await this.costCenters(); await this.categories(); await this.warehouses(); await this.banks(); await this.persons(); await this.products(); await this.journals(); await this.subledger(); if (this.run) { this.run.status = this.issues.length ? 'COMPLETED_WITH_WARNINGS' : 'COMPLETED'; this.run.completedAt = new Date(); this.run.issues = this.issues; await this.run.save(); } return { stages: this.stages, issues: this.issues }; }
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
module.exports = { Projector, parseArgs, accountType, nature, splitName, tax, ledgerDocType };
