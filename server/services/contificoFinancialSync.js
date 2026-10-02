'use strict';

// Sincroniza el mayor que alimenta Resultados, Situación Financiera y el flujo
// contable. Cada ventana se verifica completa antes de tocar la base local.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { randomUUID } = require('crypto');
const os = require('os');
// El EJSON del driver: el paquete `bson` suelto puede ser otra versión e
// incompatible con los ObjectId que entrega mongoose.
const { EJSON } = require('mongoose').mongo.BSON;
const Clinic = require('../models/Clinic');
const Record = require('../models/ContificoRecord');
const Journal = require('../models/JournalEntry');
const Account = require('../models/ChartOfAccount');
const CostCenter = require('../models/CostCenter');
const AccountBalance = require('../models/AccountBalance');
const ServerLease = require('../models/ServerLease');
const Notification = require('../models/Notification');
const SyncState = require('../models/ContificoSyncState');
const { ContificoApi } = require('./contificoApi');
const { Extractor, checksum, fmt, parseDate } = require('../scripts/migrateContifico');
const { Projector } = require('../scripts/migrateContificoProject');
const { entryDifference } = require('../scripts/auditContificoLedger');
const { decodeCompressedJson } = require('../utils/compressedJson');

let running = false;
let lastHistory = 0;
const LEASE_NAME = 'contifico-financial-sync';
const STATE_ID = 'financial-Central';
const LEASE_MS = 10 * 60 * 1000;
const eq = (left, right) => String(left) === String(right);
const dateKey = (date) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
const monthRange = (year, month) => ({
  from: new Date(Date.UTC(year, month - 1, 1, 12)),
  through: new Date(Date.UTC(year, month, 0, 12)),
});
const ecToday = () => {
  const pieces = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guayaquil', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = (part) => Number(pieces.find((piece) => piece.type === part).value);
  return { year: get('year'), month: get('month'), day: get('day') };
};

async function recordSyncState(patch) {
  try {
    await SyncState.updateOne({ _id: STATE_ID }, { $set: patch }, { upsert: true });
  } catch (error) {
    console.error('[contifico-financial-sync] No pudo guardar estado:', error.message);
  }
}

async function fetchWindow(api, from, through) {
  const rows = new Map();
  const stats = {};
  for await (const page of api.pages('/api/v2/contabilidad/asiento/',
    { fecha_inicial: fmt(from), fecha_final: fmt(through) }, 100, stats)) {
    for (const row of page.rows) rows.set(String(row.id), row);
  }
  if (!stats.complete || stats.expected !== rows.size) {
    throw new Error(`Asientos incompletos ${fmt(from)}–${fmt(through)}: ${rows.size}/${stats.expected}`);
  }
  return { rows: [...rows.values()], stats };
}

async function journalReferences(clinicId, journalId) {
  const modelFolder = path.join(__dirname, '..', 'models');
  for (const name of fs.readdirSync(modelFolder).filter((name) => name.endsWith('.js'))) require(path.join(modelFolder, name));
  const mongoose = require('mongoose');
  const found = [];
  for (const model of Object.values(mongoose.models)) {
    if (!model.schema.path('clinic')) continue;
    const fields = [];
    model.schema.eachPath((field, type) => {
      if (type.options?.ref === 'JournalEntry' || type.caster?.options?.ref === 'JournalEntry') fields.push(field);
    });
    for (const field of fields) {
      const query = { clinic: clinicId, [field]: journalId };
      if (model.modelName === 'JournalEntry') query._id = { $ne: journalId };
      const target = await model.findOne(query).select('_id').lean();
      if (target) found.push(`${model.modelName}.${field}:${target._id}`);
    }
  }
  return found;
}

async function ledgerMaps(clinicId) {
  const [sourceAccounts, accounts, sourceCenters, centers] = await Promise.all([
    Record.find({ clinic: clinicId, entity: 'chart_account' }).select('externalId payloadCompressed').lean(),
    Account.find({ clinic: clinicId }).select('code').lean(),
    Record.find({ clinic: clinicId, entity: 'cost_center' }).select('externalId payloadCompressed').lean(),
    CostCenter.find({ clinic: clinicId }).select('code').lean(),
  ]);
  return {
    sourceCodes: new Map(sourceAccounts.map((row) => [row.externalId, String(decodeCompressedJson(row.payloadCompressed).codigo)])),
    accountById: new Map(accounts.map((row) => [String(row._id), row])),
    centerCodes: new Map(sourceCenters.map((row) => [row.externalId, String(decodeCompressedJson(row.payloadCompressed).codigo)])),
    centerById: new Map(centers.map((row) => [String(row._id), row])),
  };
}

function backupRows(clinic, key, rows) {
  const folder = path.resolve(__dirname, '..', 'storage', 'contifico-batches');
  fs.mkdirSync(folder, { recursive: true });
  const filename = path.join(folder, `financial-sync-${clinic.name}-${key}-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson.gz`);
  fs.writeFileSync(filename, zlib.gzipSync(Buffer.from(rows.map((row) => EJSON.stringify(row, { relaxed: false })).join('\n') + '\n'), { level: 9 }), { flag: 'wx' });
  return filename;
}

async function syncMonth({ clinic, api, year, month, assertLease = () => {} }) {
  const { from, through } = monthRange(year, month);
  const key = dateKey(from);
  const { rows, stats } = await fetchWindow(api, from, through);
  const liveIds = new Set(rows.map((row) => String(row.id)));
  const archived = await Record.find({ clinic: clinic._id, entity: 'journal_entry', externalId: { $in: [...liveIds] } })
    .select('_id externalId checksum').lean();
  const byId = new Map(archived.map((record) => [record.externalId, record]));
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  const posted = await Journal.find({ clinic: clinic._id, status: 'CONTABILIZADO',
    date: { $gte: start, $lt: end } }).lean();
  const local = posted.filter((journal) => journal.source === 'MIGRACION' &&
    journal.sourceModel === 'ContificoRecord' && journal.number.startsWith('CTF-'));
  if (posted.length !== local.length) {
    const extras = posted.filter((journal) => !local.includes(journal)).map((journal) => journal.number);
    throw new Error(`Asientos locales ajenos a Contífico en ${key}: ${extras.slice(0, 10).join(', ')}`);
  }
  const localById = new Map(local.map((journal) => [journal.number.slice(4), journal]));
  const missing = local.filter((journal) => !liveIds.has(journal.number.slice(4)));
  const replacementPlan = [], retirePlan = [];
  const maps = await ledgerMaps(clinic._id);
  const changed = rows.filter((row) => {
    const id = String(row.id), source = byId.get(id), target = localById.get(id);
    if (!source || source.checksum !== checksum(row) || !target || !eq(target.sourceRef, source._id)) return true;
    const difference = entryDifference(row, target, maps.sourceCodes, maps.accountById,
      maps.centerCodes, maps.centerById);
    return Boolean(difference.date || difference.lines);
  });
  if (!changed.length && !missing.length) return { month: key, state: 'CURRENT', source: rows.length };

  // La ausencia del listado, incluso completo, no prueba una baja: verificar ID.
  // Si Contífico sustituyó un ID, conservar el ID local y sus relaciones solo
  // cuando fecha, glosa y líneas prueben un reemplazo único.
  const identity = (row) => JSON.stringify([row?.fecha, row?.glosa, row?.detalles]);
  for (const journal of missing) {
    const id = journal.number.slice(4);
    try {
      await api.get(`/api/v2/contabilidad/asiento/${id}/`);
      throw new Error(`Asiento ${id} sigue vivo fuera de su ventana; revisar fecha`);
    } catch (error) { if (error.status !== 404 && error.status !== 406) throw error; }
    const archived = await Record.findById(journal.sourceRef).select('externalId payloadCompressed').lean();
    if (!archived || archived.externalId !== id) throw new Error(`Asiento ${id} sin origen verificable`);
    const candidates = rows.filter((row) => identity(row) === identity(decodeCompressedJson(archived.payloadCompressed)) &&
      !localById.has(String(row.id)));
    if (candidates.length === 1 && !replacementPlan.some((item) => item.newId === String(candidates[0].id)) &&
        !(await Journal.exists({ clinic: clinic._id, number: `CTF-${candidates[0].id}` }))) {
      replacementPlan.push({ journal, oldId: id, newId: String(candidates[0].id) });
      continue;
    }
    const refs = await journalReferences(clinic._id, journal._id);
    if (refs.length) throw new Error(`Asiento retirado ${id} con relaciones ${refs.join(', ')}`);
    retirePlan.push(journal);
  }

  // Guardar el estado previo de todo lo que puede cambiar, incluido el resumen.
  const oldRecords = await Record.find({ clinic: clinic._id, entity: 'journal_entry',
    $or: [{ externalId: { $in: changed.map((row) => String(row.id)) } },
      { _id: { $in: missing.map((journal) => journal.sourceRef).filter(Boolean) } }] }).lean();
  const changedJournals = await Journal.find({ clinic: clinic._id,
    number: { $in: changed.map((row) => `CTF-${row.id}`) } }).lean();
  const balances = await AccountBalance.find({ clinic: clinic._id }).lean();
  assertLease();
  const affected = new Map([...local, ...changedJournals].map((journal) => [String(journal._id), journal]));
  const backup = backupRows(clinic, key, [...oldRecords, ...affected.values(), ...balances]);
  console.log(`[contifico-financial-sync] ${key} respaldo=${backup} nuevos/cambiados=${changed.length} reemplazos=${replacementPlan.length} retirados=${retirePlan.length}`);

  const extractor = new Extractor({ api, clinic, commit: true, from, through,
    cutoff: through, pageSize: 100, only: new Set(['journal_entries']),
    journalWindows: new Map([[key, { rows, stats }]]) });
  assertLease();
  await extractor.execute();
  if (extractor.run?.status !== 'COMPLETED' || extractor.stages[0]?.status !== 'COMPLETED')
    throw new Error(`Extracción de asientos ${key} no completada`);
  assertLease();
  for (const item of replacementPlan) {
    const newRecord = await Record.findOne({ clinic: clinic._id, entity: 'journal_entry',
      externalId: item.newId, migrationRun: extractor.run._id }).select('_id').lean();
    if (!newRecord) throw new Error(`Reemplazo ${item.oldId}→${item.newId} fuera de instantánea`);
    const result = await Journal.updateOne({ _id: item.journal._id, number: `CTF-${item.oldId}` },
      { $set: { number: `CTF-${item.newId}`, sourceRef: newRecord._id } });
    if (result.modifiedCount !== 1) throw new Error(`Cambio concurrente del asiento ${item.oldId}`);
    await Record.updateOne({ _id: item.journal.sourceRef }, { $set: { projection: {
      status: 'REVIEW', links: [], warnings: [`Reemplazado en Contífico por ${item.newId}`], projectedAt: new Date(),
    } } });
  }
  for (const journal of retirePlan) {
    const id = journal.number.slice(4);
    const result = await Journal.updateOne({ _id: journal._id, status: 'CONTABILIZADO' },
      { $set: { status: 'ANULADO', reversalReason: `ID ${id} retirado de Contífico; extracción ${extractor.run._id}` } });
    if (result.modifiedCount !== 1) throw new Error(`Cambio concurrente del asiento ${id}`);
    await Record.updateOne({ _id: journal.sourceRef }, { $set: { projection: {
      status: 'REVIEW', links: [], warnings: [`Ausente de la instantánea Contífico ${extractor.run._id}`], projectedAt: new Date(),
    } } });
  }
  const projector = new Projector({ clinic, commit: true, cutoff: through, only: 'journal_entries',
    sourceSnapshotId: extractor.run._id });
  assertLease();
  const projected = await projector.execute();
  if (projected.issues.length || projected.stages.find((stage) => stage.name === 'journal_entries')?.skipped)
    throw new Error(`Proyección ${key} con ${projected.issues.length} incidencias`);

  // Comprueba cada asiento y sus líneas, además del conteo. Los cambios de
  // centro de costo también deben aparecer en el mayor local.
  const [finalMaps, final] = await Promise.all([
    ledgerMaps(clinic._id),
    Journal.find({ clinic: clinic._id, source: 'MIGRACION', sourceModel: 'ContificoRecord',
      number: /^CTF-/, status: 'CONTABILIZADO', date: { $gte: start, $lt: end } }).lean(),
  ]);
  const finalById = new Map(final.map((journal) => [journal.number.slice(4), journal]));
  if (final.length !== rows.length) throw new Error(`Auditoría ${key}: ${final.length}/${rows.length} asientos`);
  for (const row of rows) {
    const journal = finalById.get(String(row.id));
    if (!journal) throw new Error(`Auditoría ${key}: falta ${row.id}`);
    const difference = entryDifference(row, journal, finalMaps.sourceCodes, finalMaps.accountById,
      finalMaps.centerCodes, finalMaps.centerById);
    if (difference.date || difference.lines) throw new Error(`Auditoría ${key}: diferencia en ${row.id}`);
  }
  return { month: key, state: 'SYNCED', source: rows.length, updated: changed.length,
    replaced: replacementPlan.length, retired: retirePlan.length,
    backup, snapshot: String(extractor.run._id) };
}

async function syncFinancialReports({ includeHistory = false, months: requestedMonths = null, trigger = 'MANUAL' } = {}) {
  if (running) return { state: 'ALREADY_RUNNING' };
  if (!process.env.CONTIFICO_API_KEY) return { state: 'NO_API_KEY' };
  running = true;
  const holder = `${process.pid}:${randomUUID()}`;
  let renewal, leaseLost = false, acquired = false;
  try {
    const now = new Date();
    try {
      const claim = await ServerLease.findOneAndUpdate(
        { _id: LEASE_NAME, expiresAt: { $lte: now } },
        { $set: { holder, expiresAt: new Date(now.getTime() + LEASE_MS), renewedAt: now } },
        { upsert: true, new: true }
      );
      acquired = claim?.holder === holder;
    } catch (error) { if (error.code !== 11000) throw error; }
    if (!acquired) return { state: 'ALREADY_RUNNING' };
    renewal = setInterval(async () => {
      try {
        const result = await ServerLease.updateOne({ _id: LEASE_NAME, holder },
          { $set: { expiresAt: new Date(Date.now() + LEASE_MS), renewedAt: new Date() } });
        if (result.matchedCount !== 1) leaseLost = true;
      } catch (error) { leaseLost = true; console.error('[contifico-financial-sync] Perdió arriendo:', error.message); }
    }, 60 * 1000);
    const assertLease = () => { if (leaseLost) throw new Error('Arriendo de sincronización perdido'); };
    const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
    if (!clinic) throw new Error('Clínica Central no encontrada');
    await recordSyncState({ state: 'RUNNING', trigger, host: os.hostname(),
      startedAt: new Date(), completedAt: null, months: [], failures: [], lastError: '' });
    await Notification.updateMany({ clinic: clinic._id, type: 'contifico_sync_blocked',
      'meta.month': 'CONFIG', read: false }, { $set: { read: true, readAt: new Date() } })
      .catch((error) => console.error('[contifico-financial-sync] Aviso de configuración resuelto:', error.message));
    const api = new ContificoApi({ apiKey: process.env.CONTIFICO_API_KEY });
    const today = ecToday();
    const recent = [monthRange(today.year, today.month).from,
      monthRange(today.month === 1 ? today.year - 1 : today.year, today.month === 1 ? 12 : today.month - 1).from];
    const history = [];
    if (includeHistory) for (let year = 2026; year <= today.year; year += 1) {
      for (let month = 1; month <= 12; month += 1) history.push(monthRange(year, month).from);
    }
    const seen = new Set();
    const requested = requestedMonths?.map((value) => {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new Error(`Mes inválido ${value}`);
      const [year, month] = value.split('-').map(Number);
      return monthRange(year, month).from;
    });
    const windows = (requested || [...recent, ...history]).filter((from) => {
      const key = dateKey(from);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const result = [], failures = [];
    for (const from of windows) {
      try {
        assertLease();
        const outcome = await syncMonth({ clinic, api, assertLease,
          year: from.getUTCFullYear(), month: from.getUTCMonth() + 1 });
        result.push(outcome);
        console.log(`[contifico-financial-sync] ${outcome.month}: ${outcome.state}, ${outcome.source} asientos`);
        await Notification.updateMany({ clinic: clinic._id, type: 'contifico_sync_blocked',
          'meta.month': outcome.month, read: false }, { $set: { read: true, readAt: new Date() } })
          .catch((error) => console.error('[contifico-financial-sync] Aviso resuelto:', error.message));
      }
      catch (error) {
        const month = dateKey(from);
        failures.push({ month, error: error.message });
        console.error(`[contifico-financial-sync] BLOQUEADO ${month}:`, error.stack || error.message);
        await Notification.updateOne({ clinic: clinic._id, user: null, type: 'contifico_sync_blocked',
          'meta.month': month, read: false }, { $setOnInsert: {
          clinic: clinic._id, user: null, type: 'contifico_sync_blocked', severity: 'error',
          meta: { month },
          title: `Contífico: sincronización financiera detenida (${month})`,
          body: String(error.message).slice(0, 500),
        } }, { upsert: true }).catch((notificationError) =>
          console.error('[contifico-financial-sync] No pudo crear aviso:', notificationError.message));
      }
    }
    const outcome = { state: failures.length ? 'PARTIAL' : 'COMPLETED', months: result, failures };
    await recordSyncState({ ...outcome, completedAt: new Date(),
      ...(failures.length ? {} : { lastSuccessfulAt: new Date() }) });
    return outcome;
  } catch (error) {
    if (acquired) await recordSyncState({ state: 'FAILED', completedAt: new Date(),
      lastError: String(error.message).slice(0, 500) });
    throw error;
  } finally {
    if (renewal) clearInterval(renewal);
    if (acquired) await ServerLease.deleteOne({ _id: LEASE_NAME, holder }).catch((error) =>
      console.error('[contifico-financial-sync] No pudo soltar arriendo:', error.message));
    running = false;
  }
}

function startFinancialSyncJob(leaderOnly) {
  if (process.env.CONTIFICO_AUTO_SYNC === '0') {
    console.error('[contifico-financial-sync] BLOQUEADO: CONTIFICO_AUTO_SYNC=0');
    recordSyncState({ state: 'DISABLED', trigger: 'AUTO', host: os.hostname(),
      completedAt: new Date(), lastError: 'CONTIFICO_AUTO_SYNC=0' });
    return;
  }
  if (!process.env.CONTIFICO_API_KEY) {
    console.error('[contifico-financial-sync] BLOQUEADO: falta CONTIFICO_API_KEY');
    recordSyncState({ state: 'NO_API_KEY', trigger: 'AUTO', host: os.hostname(),
      completedAt: new Date(), lastError: 'Falta CONTIFICO_API_KEY' });
    setTimeout(leaderOnly(async () => {
      try {
        const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
        if (clinic) await Notification.updateOne({ clinic: clinic._id, user: null,
          type: 'contifico_sync_blocked', 'meta.month': 'CONFIG', read: false },
        { $setOnInsert: { clinic: clinic._id, user: null, type: 'contifico_sync_blocked',
          meta: { month: 'CONFIG' },
          severity: 'error', title: 'Contífico: sincronización financiera sin configurar',
          body: 'Falta CONTIFICO_API_KEY en el servidor principal.' } }, { upsert: true });
      } catch (error) { console.error('[contifico-financial-sync] Aviso de configuración:', error.message); }
    }), 30 * 1000);
    return;
  }
  const run = leaderOnly(async () => {
    const history = Date.now() - lastHistory > 6 * 60 * 60 * 1000;
    try {
      const result = await syncFinancialReports({ includeHistory: history, trigger: 'AUTO' });
      if (history && ['COMPLETED', 'PARTIAL'].includes(result.state)) lastHistory = Date.now();
      console.log('[contifico-financial-sync]', JSON.stringify(result));
    } catch (error) { console.error('[contifico-financial-sync] BLOQUEADO:', error.stack || error.message); }
    // Ventas, compras y cartera van después del mayor, en el mismo ciclo, para
    // que las pantallas operativas sigan a Contífico igual que los reportes.
    try {
      const { syncDocuments } = require('./contificoDocumentSync');
      const documents = await syncDocuments({ includeHistory: history, trigger: 'AUTO' });
      console.log('[contifico-document-sync]', JSON.stringify({ state: documents.state,
        months: documents.months?.map((month) => `${month.month}:${month.state}`), failures: documents.failures }));
    } catch (error) { console.error('[contifico-document-sync] BLOQUEADO:', error.stack || error.message); }
    // Roles de pago: después del mayor, porque su control de completitud son los
    // sueldos contabilizados de cada mes.
    try {
      const { syncPayroll } = require('./contificoPayrollSync');
      const payroll = await syncPayroll({ includeHistory: history, trigger: 'AUTO' });
      console.log('[contifico-payroll-sync]', JSON.stringify({ state: payroll.state,
        months: payroll.months?.map((month) => `${month.month}:${month.state}`), failures: payroll.failures }));
    } catch (error) { console.error('[contifico-payroll-sync] BLOQUEADO:', error.stack || error.message); }
  });
  setTimeout(run, 30 * 1000);
  setInterval(run, 15 * 60 * 1000);
}

module.exports = { fetchWindow, ledgerMaps, syncMonth, syncFinancialReports, startFinancialSyncJob, monthRange, ecToday };
