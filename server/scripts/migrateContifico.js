#!/usr/bin/env node
'use strict';

require('dotenv').config();
const crypto = require('crypto');
const zlib = require('zlib');
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const ContificoRecord = require('../models/ContificoRecord');
const ContificoMigrationRun = require('../models/ContificoMigrationRun');
const { ContificoApi } = require('../services/contificoApi');
const { decodeCompressedJson } = require('../utils/compressedJson');

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}
function checksum(value) { return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex'); }
function num(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const match = String(value).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) return new Date(Date.UTC(+match[3], +match[2] - 1, +match[1], 12));
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
function fmt(date) { return `${String(date.getUTCDate()).padStart(2, '0')}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${date.getUTCFullYear()}`; }
function months(from, through) {
  const result = [];
  for (let cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1, 12)); cursor <= through; cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1, 12))) {
    const end = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0, 12));
    result.push({ key: `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`, from: cursor < from ? from : cursor, through: end > through ? through : end });
  }
  return result;
}
function externalId(entity, row, index = 0) {
  if (row?.id !== undefined && row?.id !== null && String(row.id)) return String(row.id);
  if (entity === 'company_parameters') return 'current';
  if (entity === 'product_stock') return String(row.product_id);
  if (entity === 'payroll_role') return [row.cedula, row.anio, row.mes, row.periodo_consultado, row.comprobante].filter(Boolean).join(':');
  return `hash:${checksum(row).slice(0, 30)}:${index}`;
}
function identification(row) { return String(row?.ruc || row?.cedula || row?.identificacion || row?.cliente?.ruc || row?.cliente?.cedula || '').trim(); }
function search(entity, row) {
  let amount = row.total ?? row.valor ?? row.monto ?? row.saldo ?? null;
  if (entity === 'journal_entry') amount = (row.detalles || []).reduce((sum, line) => sum + (line.tipo === 'D' ? num(line.valor) : 0), 0);
  return {
    date: parseDate(row.fecha || row.fecha_emision || row.fecha_creacion || row.fecha_corte),
    number: String(row.documento || row.numero_comprobante || row.codigo || row.comprobante || ''),
    identification: identification(row),
    name: String(row.nombre || row.razon_social || row.nombre_comercial || row.cliente?.razon_social || row.glosa || ''),
    type: String(row.tipo_documento || row.tipo_registro || row.tipo || row.forma || ''),
    status: String(row.estado || (row.anulado ? 'ANULADO' : '')),
    amount: amount === null || amount === '' ? null : num(amount, null),
  };
}

function parseArgs(argv) {
  const values = {}, flags = new Set();
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const at = arg.indexOf('=');
    if (at < 0) flags.add(arg.slice(2)); else values[arg.slice(2, at)] = arg.slice(at + 1);
  }
  const now = new Date();
  return {
    commit: flags.has('commit'),
    phase: String(values.phase || 'extract').toLowerCase(),
    clinicName: values['clinic-name'] || 'Shiluv',
    clinicId: values.clinic || null,
    from: parseDate(values.from || '01/01/2015'),
    through: parseDate(values.through) || new Date(Date.UTC(now.getUTCFullYear(), 11, 31, 12)),
    cutoff: parseDate(values.cutoff) || now,
    // La API v2 de Contífico rechaza valores superiores a 100.
    pageSize: Math.min(100, Math.max(10, num(values['page-size'], 100))),
    only: new Set(String(values.only || '').split(',').map((value) => value.trim()).filter(Boolean)),
    payrollPeriods: String(values['payroll-periods'] || 'P,S,M').split(',').map((value) => value.trim().toUpperCase()).filter(Boolean),
  };
}

class Extractor {
  constructor({ api, clinic, commit, from, through, cutoff, pageSize, only = new Set(), payrollPeriods = ['P', 'S', 'M'] }) {
    this.api = api; this.clinic = clinic; this.commit = commit;
    this.from = from; this.through = through; this.cutoff = cutoff; this.pageSize = pageSize;
    this.only = only;
    this.payrollPeriods = payrollPeriods;
    this.stages = []; this.issues = []; this.run = null; this.cache = {}; this.earliestJournal = null;
  }
  log(text) { console.log(`[contifico] ${text}`); }
  async begin() {
    if (this.commit) this.run = await ContificoMigrationRun.create({ clinic: this.clinic._id, mode: 'COMMIT', phase: 'EXTRACT', range: { from: this.from, through: this.through, cutoff: this.cutoff } });
  }
  stage(name) { const stage = { name, fetched: 0, unique: 0, created: 0, updated: 0, unchanged: 0, duplicates: 0, status: 'RUNNING' }; this.stages.push(stage); this.log(`inicio ${name}`); return stage; }
  /**
   * Anota si una ventana paginada quedo corta frente al total que informa
   * Contifico. Una etapa incompleta NO puede marcarse COMPLETED: la proyeccion
   * trata las etapas completas como instantanea y retira lo que no aparece en
   * ellas, asi que declararla completa borraria registros vivos.
   */
  track(stage, stats) {
    if (stats.expected === null || stats.expected === undefined) return;
    stage.expected = (stage.expected || 0) + stats.expected;
    stage.recovered = (stage.recovered || 0) + (stats.recovered || 0);
    if (stats.complete) return;
    const missing = stats.expected - stats.unique;
    stage.missing = (stage.missing || 0) + missing;
    const message = `Contifico informo ${stats.expected} filas y solo entrego ${stats.unique} tras ${stats.attempts} pasadas`;
    this.issues.push({ stage: stage.name, message });
    this.log(`AVISO ${stage.name}: ${message}`);
  }
  async saveStage(stage) {
    stage.status = stage.missing ? 'INCOMPLETE' : 'COMPLETED';
    this.log(`fin ${stage.name}: fetched=${stage.fetched} unique=${stage.unique} new=${stage.created} updated=${stage.updated} unchanged=${stage.unchanged} duplicates=${stage.duplicates} esperados=${stage.expected ?? '-'} recuperados=${stage.recovered || 0} faltantes=${stage.missing || 0}`);
    if (this.run) { this.run.stages = this.stages; this.run.issues = this.issues; await this.run.save(); }
  }
  async archive(entity, rows, stage, idFunction = externalId) {
    stage.fetched += rows.length;
    stage._seen ||= new Set();
    const unique = new Map();
    rows.forEach((row, index) => {
      const id = idFunction(entity, row, index);
      if (stage._seen.has(id)) { stage.duplicates += 1; return; }
      stage._seen.add(id); unique.set(id, row);
    });
    stage.unique = stage._seen.size;
    if (!unique.size) return;
    const ids = [...unique.keys()];
    const existing = await ContificoRecord.find({ clinic: this.clinic._id, entity, externalId: { $in: ids } }).select('externalId checksum').lean();
    const existingMap = new Map(existing.map((record) => [record.externalId, record.checksum]));
    const operations = [];
    for (const [id, payload] of unique) {
      const hash = checksum(payload);
      const payloadCompressed = zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'), { level: 9 });
      if (!existingMap.has(id)) stage.created += 1;
      else if (existingMap.get(id) === hash) stage.unchanged += 1;
      else stage.updated += 1;
      if (this.commit) operations.push({ updateOne: {
        filter: { clinic: this.clinic._id, entity, externalId: id },
        update: {
          $set: { payloadCompressed, payloadEncoding: 'gzip-json', checksum: hash, capturedAt: new Date(), migrationRun: this.run?._id || null, search: search(entity, payload) },
          $setOnInsert: { clinic: this.clinic._id, entity, externalId: id, projection: { status: 'ARCHIVED', links: [], warnings: [] } },
        },
        upsert: true,
      } });
    }
    if (operations.length) await ContificoRecord.bulkWrite(operations, { ordered: false });
  }
  async v1(name, entity, path, { cache = false } = {}) {
    const stage = this.stage(name);
    const rows = await this.api.listV1(path);
    await this.archive(entity, rows, stage);
    if (cache) this.cache[entity] = rows;
    await this.saveStage(stage);
  }
  async v2(name, entity, path, { cache = false } = {}) {
    const stage = this.stage(name); const cached = []; const stats = {};
    for await (const page of this.api.pages(path, {}, this.pageSize, stats)) {
      await this.archive(entity, page.rows, stage);
      if (cache) cached.push(...page.rows);
      if (stage.fetched && stage.fetched % 1000 < page.rows.length) this.log(`${name}: ${stage.fetched}/${page.count}`);
    }
    this.track(stage, stats);
    if (cache) this.cache[entity] = cached;
    await this.saveStage(stage);
  }
  async transactions() {
    const stage = this.stage('transactions');
    for (let page = 1; ; page += 1) {
      const rows = await this.api.listV1('/api/v1/registro/transaccion/', { result_size: 1000, result_page: page });
      await this.archive('transaction', rows, stage);
      this.log(`transactions pagina=${page} rows=${rows.length}`);
      if (rows.length < 1000) break;
    }
    await this.saveStage(stage);
  }
  async stocks() {
    const stage = this.stage('product_stock');
    let products = this.cache.product;
    if (!products) products = (await ContificoRecord.find({ clinic: this.clinic._id, entity: 'product' }).select('payloadCompressed').lean()).map((record) => decodeCompressedJson(record.payloadCompressed));
    const physical = products.filter((product) => String(product.tipo).toUpperCase() === 'PRO');
    for (let offset = 0; offset < physical.length; offset += 5) {
      const slice = physical.slice(offset, offset + 5);
      const rows = await Promise.all(slice.map(async (product) => ({ product_id: product.id, stock: await this.api.get(`/api/v2/producto/${product.id}/stock/`) })));
      await this.archive('product_stock', rows, stage, (_entity, row) => String(row.product_id));
      if ((offset + slice.length) % 50 < 5) this.log(`product_stock ${offset + slice.length}/${physical.length}`);
    }
    await this.saveStage(stage);
  }
  async journals() {
    const stage = this.stage('journal_entries');
    for (const month of months(this.from, this.through)) {
      let count = 0; const stats = {};
      for await (const page of this.api.pages('/api/v2/contabilidad/asiento/', { fecha_inicial: fmt(month.from), fecha_final: fmt(month.through) }, this.pageSize, stats)) {
        count = page.count;
        if (count && !this.earliestJournal) this.earliestJournal = month.from;
        await this.archive('journal_entry', page.rows, stage);
      }
      this.track(stage, stats);
      if (count) this.log(`journal_entries ${month.key}: ${count}`);
    }
    await this.saveStage(stage);
  }
  async payroll() {
    const stage = this.stage('payroll_roles');
    let persons = this.cache.person;
    if (!persons) persons = (await ContificoRecord.find({ clinic: this.clinic._id, entity: 'person' }).select('payloadCompressed').lean()).map((record) => decodeCompressedJson(record.payloadCompressed));
    const employees = persons.filter((person) => person.es_empleado && (person.cedula || person.ruc));
    const ranges = months(this.earliestJournal || this.from || parseDate('01/11/2025'), this.cutoff);
    for (const employee of employees) for (const month of ranges) for (const period of this.payrollPeriods) {
      const rows = await this.api.listV1(
        '/api/v1/rrhh/rol-pago/',
        { cedula: employee.cedula || employee.ruc, periodo: period, anio: month.from.getUTCFullYear(), mes: month.from.getUTCMonth() + 1 },
        { singleObject: true }
      );
      await this.archive('payroll_role', rows.map((row) => ({ ...row, periodo_consultado: period })), stage);
    }
    await this.saveStage(stage);
  }
  async execute() {
    await this.begin();
    try {
      const enabled = (name) => !this.only.size || this.only.has(name);
      if (enabled('chart_of_accounts')) await this.v1('chart_of_accounts', 'chart_account', '/api/v1/contabilidad/cuenta-contable/');
      if (enabled('cost_centers')) await this.v1('cost_centers', 'cost_center', '/api/v1/contabilidad/centro-costo/');
      if (enabled('categories')) await this.v1('categories', 'category', '/api/v1/categoria/');
      if (enabled('warehouses')) await this.v2('warehouses', 'warehouse', '/api/v2/bodega/');
      if (enabled('units')) await this.v2('units', 'unit', '/api/v2/unidad/');
      if (enabled('variants')) await this.v1('variants', 'variant', '/api/v1/variante/');
      if (enabled('brands')) await this.v1('brands', 'brand', '/api/v1/marca/');
      if (enabled('bank_accounts')) await this.v2('bank_accounts', 'bank_account', '/api/v2/banco/cuenta/');
      if (enabled('company_parameters')) {
        const companyStage = this.stage('company_parameters');
        await this.archive('company_parameters', [await this.api.get('/api/v2/empresa/parametros')], companyStage, () => 'current');
        await this.saveStage(companyStage);
      }
      if (enabled('persons')) await this.v2('persons', 'person', '/api/v2/persona/', { cache: true });
      if (enabled('products')) await this.v2('products', 'product', '/api/v2/producto/', { cache: true });
      if (enabled('product_stock')) await this.stocks();
      if (enabled('documents')) await this.v2('documents', 'document', '/api/v2/documento/');
      if (enabled('transactions')) await this.transactions();
      if (enabled('bank_movements')) await this.v1('bank_movements', 'bank_movement', '/api/v1/banco/movimiento/');
      if (enabled('inventory_movements')) await this.v2('inventory_movements', 'inventory_movement', '/api/v2/movimiento-inventario/');
      if (enabled('journal_entries')) await this.journals();
      if (enabled('payroll_roles')) await this.payroll();
      if (this.run) { this.run.status = this.stages.some((stage) => stage.duplicates || stage.missing) ? 'COMPLETED_WITH_WARNINGS' : 'COMPLETED'; this.run.completedAt = new Date(); this.run.issues = this.issues; await this.run.save(); }
      return { stages: this.stages.map(({ _seen, ...stage }) => stage), metrics: this.api.metrics };
    } catch (error) {
      if (this.run) { this.run.status = 'FAILED'; this.run.completedAt = new Date(); this.run.issues = [{ message: error.message }]; await this.run.save(); }
      throw error;
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.phase !== 'extract') throw new Error('Use --phase=extract; la proyeccion se ejecuta con migrateContificoProject.js');
  if (!process.env.MONGODB_URI) throw new Error('Falta MONGODB_URI');
  if (!process.env.CONTIFICO_API_KEY) throw new Error('Falta CONTIFICO_API_KEY');
  console.log(`MODO ${options.commit ? 'COMMIT' : 'DRY_RUN'} | EXTRACT`);
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = options.clinicId ? await Clinic.findById(options.clinicId).lean() : await Clinic.findOne({ name: new RegExp(`^${options.clinicName}$`, 'i') }).lean();
  if (!clinic) throw new Error('Clinica destino no encontrada');
  console.log(`Clinica: ${clinic.name} (${clinic._id})`);
  const extractor = new Extractor({ api: new ContificoApi({ apiKey: process.env.CONTIFICO_API_KEY }), clinic, ...options });
  console.log(JSON.stringify(await extractor.execute(), null, 2));
}

if (require.main === module) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; }).finally(() => mongoose.disconnect().catch(() => {}));

module.exports = { stable, checksum, parseDate, fmt, months, externalId, search, parseArgs, Extractor };
