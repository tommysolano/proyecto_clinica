'use strict';

// Sincroniza ventas, compras y su cartera (CxC/CxP) con los documentos de
// Contífico. El mayor contable lo sincroniza contificoFinancialSync; aquí se
// mantienen al día las pantallas operativas que se alimentan de los documentos.
//
// La API solo filtra por FECHA DE EMISIÓN: un cobro aplicado hoy a una factura de
// marzo cambia el saldo de un documento de marzo. Por eso el ciclo corto revisa
// el mes actual y el anterior, y el ciclo largo recorre todo el año.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');
const { randomUUID } = require('crypto');
// El EJSON del driver: el paquete `bson` suelto puede ser otra versión e
// incompatible con los ObjectId que entrega mongoose.
const { EJSON } = require('mongoose').mongo.BSON;
const Clinic = require('../models/Clinic');
const Record = require('../models/ContificoRecord');
const Sale = require('../models/Sale');
const Invoice = require('../models/Invoice');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const Receivable = require('../models/Receivable');
const Payable = require('../models/Payable');
const ServerLease = require('../models/ServerLease');
const Notification = require('../models/Notification');
const SyncState = require('../models/ContificoSyncState');
const { ContificoApi } = require('./contificoApi');
const { Extractor, checksum, fmt } = require('../scripts/migrateContifico');
const { Projector } = require('../scripts/migrateContificoProject');
const { monthRange, ecToday } = require('./contificoFinancialSync');

let running = false;
const LEASE_NAME = 'contifico-document-sync';
const STATE_ID = 'documents-Central';
const LEASE_MS = 10 * 60 * 1000;
const SALE_TYPES = new Set(['FAC', 'NVE']);
const PURCHASE_TYPES = new Set(['FAC', 'NVE', 'LQC', 'DNA', 'DAC', 'NCT']);
const r2 = (value) => +Number(value || 0).toFixed(2);
const dateKey = (date) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
const kind = (row) => String(row?.tipo_registro || '').toUpperCase();
const docType = (row) => String(row?.tipo_documento || '').toUpperCase();
const isSale = (row) => kind(row) === 'CLI' && SALE_TYPES.has(docType(row));
const isPurchase = (row) => kind(row) === 'PRO' && PURCHASE_TYPES.has(docType(row));
// Ventas y compras guardan el saldo de origen tal cual; la cartera lo cierra si
// el documento está anulado.
const sourceBalance = (row) => Math.max(0, r2(row.saldo));
const openBalance = (row) => (row.anulado ? 0 : sourceBalance(row));
const linkTo = (record, model) => (record?.projection?.links || []).find((link) => link.model === model && link.ref);

async function recordSyncState(patch) {
  try {
    await SyncState.updateOne({ _id: STATE_ID }, { $set: patch }, { upsert: true });
  } catch (error) {
    console.error('[contifico-document-sync] No pudo guardar estado:', error.message);
  }
}

async function fetchDocumentWindow(api, from, through) {
  const rows = new Map();
  const stats = {};
  for await (const page of api.pages('/api/v2/documento/',
    { fecha_inicial: fmt(from), fecha_final: fmt(through) }, 100, stats)) {
    for (const row of page.rows) rows.set(String(row.id), row);
  }
  if (!stats.complete || stats.expected !== rows.size) {
    throw new Error(`Documentos incompletos ${fmt(from)}–${fmt(through)}: ${rows.size}/${stats.expected}`);
  }
  return { rows: [...rows.values()], stats };
}

/**
 * Qué documentos hay que (re)archivar y (re)proyectar: los nuevos, los que
 * cambiaron en Contífico y los proyectables que perdieron su enlace local.
 */
function planDocumentChanges(rows, archivedById) {
  return rows.filter((row) => {
    const archived = archivedById.get(String(row.id));
    if (!archived || archived.checksum !== checksum(row)) return true;
    if (isSale(row)) return !linkTo(archived, 'Sale');
    if (isPurchase(row)) return !linkTo(archived, 'PurchaseInvoice');
    return false;
  });
}

/** Compara cada documento con su venta/compra y su CxC/CxP. Devuelve diferencias. */
function documentDifferences(rows, { archivedById, salesByKey, purchasesByRef, ledgerByRef }) {
  const differences = [];
  const add = (row, field, source, local) => differences.push({ id: String(row.id), number: row.documento, field, source, local });
  for (const row of rows) {
    const record = archivedById.get(String(row.id));
    if (!record) { add(row, 'archivo', 'presente', 'ausente'); continue; }
    if (isSale(row)) {
      const sale = salesByKey.get(`contifico:${row.id}`);
      if (!sale) add(row, 'venta', 'presente', 'ausente');
      else {
        if (r2(sale.total) !== r2(row.total)) add(row, 'total', r2(row.total), r2(sale.total));
        if (r2(sale.balance) !== sourceBalance(row)) add(row, 'saldo', sourceBalance(row), r2(sale.balance));
        if ((sale.status === 'anulada') !== Boolean(row.anulado)) add(row, 'estado', row.anulado ? 'anulada' : 'completada', sale.status);
      }
    } else if (isPurchase(row)) {
      const purchase = purchasesByRef.get(String(record._id));
      if (!purchase) add(row, 'compra', 'presente', 'ausente');
      else {
        if (r2(purchase.total) !== r2(row.total)) add(row, 'total', r2(row.total), r2(purchase.total));
        if (r2(purchase.balance) !== sourceBalance(row)) add(row, 'saldo', sourceBalance(row), r2(purchase.balance));
        if ((purchase.status === 'ANULADA') !== Boolean(row.anulado)) add(row, 'estado', row.anulado ? 'ANULADA' : 'vigente', purchase.status);
      }
    }
    const ledger = ledgerByRef.get(String(record._id));
    const balance = openBalance(row);
    if (balance > 0.005 && !ledger) add(row, 'cartera', balance, 'ausente');
    else if (ledger && r2(ledger.balance) !== balance) add(row, 'cartera', balance, r2(ledger.balance));
  }
  return differences;
}

function backupRows(clinic, key, rows) {
  const folder = process.env.CONTIFICO_BATCH_DIR || path.resolve(__dirname, '..', 'storage', 'contifico-batches');
  fs.mkdirSync(folder, { recursive: true });
  const filename = path.join(folder, `document-sync-${clinic.name}-${key}-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson.gz`);
  fs.writeFileSync(filename, zlib.gzipSync(Buffer.from(rows.map((row) => EJSON.stringify(row, { relaxed: false })).join('\n') + '\n'), { level: 9 }), { flag: 'wx' });
  return filename;
}

async function localState(clinic, rows) {
  const archived = await Record.find({ clinic: clinic._id, entity: 'document', externalId: { $in: rows.map((row) => String(row.id)) } })
    .select('_id externalId checksum projection').lean();
  const archivedById = new Map(archived.map((record) => [record.externalId, record]));
  const refs = archived.map((record) => record._id);
  const [sales, purchases, receivables, payables] = await Promise.all([
    Sale.find({ clinic: clinic._id, idempotencyKey: { $in: rows.filter(isSale).map((row) => `contifico:${row.id}`) } })
      .select('idempotencyKey total balance status').lean(),
    PurchaseInvoice.find({ clinic: clinic._id, sourceModel: 'ContificoRecord', sourceRef: { $in: refs } })
      .select('sourceRef total balance status').lean(),
    Receivable.find({ clinic: clinic._id, sourceModel: 'ContificoRecord', sourceRef: { $in: refs } }).select('sourceRef balance status').lean(),
    Payable.find({ clinic: clinic._id, sourceModel: 'ContificoRecord', sourceRef: { $in: refs } }).select('sourceRef balance status').lean(),
  ]);
  return {
    archivedById,
    salesByKey: new Map(sales.map((sale) => [sale.idempotencyKey, sale])),
    purchasesByRef: new Map(purchases.map((purchase) => [String(purchase.sourceRef), purchase])),
    ledgerByRef: new Map([...receivables, ...payables].map((row) => [String(row.sourceRef), row])),
  };
}

/** Archiva por ID las personas/productos citados que aún no tienen ficha local. */
async function prepareReferences({ clinic, api, extractor, changed }) {
  const projectable = changed.filter((row) => isSale(row) || isPurchase(row));
  const personNeeds = new Map();
  for (const row of projectable) {
    const id = String(row.persona_id || '');
    if (id) personNeeds.set(id, kind(row) === 'PRO' || personNeeds.get(id) === true);
  }
  const productIds = [...new Set(projectable.flatMap((row) => (row.detalles || [])
    .map((detail) => String(detail.producto_id || '')).filter(Boolean)))];
  const records = await Record.find({ clinic: clinic._id, $or: [
    { entity: 'person', externalId: { $in: [...personNeeds.keys()] } },
    { entity: 'product', externalId: { $in: productIds } }] }).select('entity externalId projection.links').lean();
  const byKey = new Map(records.map((record) => [`${record.entity}:${record.externalId}`, record]));
  const scope = { person: [], product: [] };
  for (const [id, provider] of personNeeds) {
    const record = byKey.get(`person:${id}`);
    if (!record || !linkTo(record, provider ? 'Supplier' : 'Patient')) scope.person.push(id);
  }
  for (const id of productIds) if (!linkTo(byKey.get(`product:${id}`), 'Product')) scope.product.push(id);
  for (const [entity, endpoint] of [['person', 'persona'], ['product', 'producto']]) {
    const missing = scope[entity].filter((id) => !byKey.has(`${entity}:${id}`));
    if (!missing.length) continue;
    const stage = extractor.stage(`${entity}_by_id`);
    const rows = [];
    for (const id of missing) rows.push(await api.get(`/api/v2/${endpoint}/${encodeURIComponent(id)}/`));
    await extractor.archive(entity, rows, stage);
    await extractor.saveStage(stage);
  }
  return scope;
}

/** Contífico ya no tiene el documento: anula su reflejo local, sin borrarlo. */
async function retireDocuments(clinic, records, snapshotId) {
  for (const record of records) {
    const refs = { sale: linkTo(record, 'Sale')?.ref, invoice: linkTo(record, 'Invoice')?.ref,
      purchase: linkTo(record, 'PurchaseInvoice')?.ref };
    if (refs.sale) await Sale.updateOne({ _id: refs.sale, clinic: clinic._id }, { $set: { status: 'anulada', balance: 0, paid: true } });
    if (refs.invoice) await Invoice.updateOne({ _id: refs.invoice }, { $set: { estado: 'ANULADA', anuladaAt: new Date(), motivoAnulacion: 'Documento retirado de Contifico' } });
    if (refs.purchase) await PurchaseInvoice.updateOne({ _id: refs.purchase, clinic: clinic._id }, { $set: { status: 'ANULADA', balance: 0 } });
    const ledger = { clinic: clinic._id, sourceModel: 'ContificoRecord', sourceRef: record._id };
    await Receivable.updateOne(ledger, { $set: { balance: 0, status: 'ANULADO' } });
    await Payable.updateOne(ledger, { $set: { balance: 0, status: 'ANULADO' } });
    await Record.updateOne({ _id: record._id }, { $set: { projection: { status: 'REVIEW', links: record.projection?.links || [],
      warnings: [`Ausente de la instantánea Contífico ${snapshotId}`], projectedAt: new Date() } } });
  }
}

async function syncDocumentMonth({ clinic, api, year, month, commit = true, assertLease = () => {} }) {
  const { from, through } = monthRange(year, month);
  const key = dateKey(from);
  const { rows: listed } = await fetchDocumentWindow(api, from, through);
  const rows = [...listed];
  const liveIds = new Set(rows.map((row) => String(row.id)));

  // El listado puede omitir documentos vivos aunque su `count` cuadre. Lo que
  // estaba archivado en este mes y no aparece se consulta uno por uno.
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  const absent = (await Record.find({ clinic: clinic._id, entity: 'document', 'search.date': { $gte: start, $lt: end } })
    .select('_id externalId projection').lean()).filter((record) => !liveIds.has(record.externalId)
    && record.projection?.status !== 'REVIEW');
  const removed = [];
  for (let offset = 0; offset < absent.length; offset += 5) {
    const batch = absent.slice(offset, offset + 5);
    const checked = await Promise.all(batch.map(async (record) => {
      try {
        const payload = await api.get(`/api/v2/documento/${encodeURIComponent(record.externalId)}/`);
        if (String(payload.id) !== record.externalId) throw new Error(`ID de respuesta distinto para ${record.externalId}`);
        return { payload };
      } catch (error) {
        if (error.status === 400 && error.message.includes('Documento no encontrado.')) return { removed: record };
        throw error;
      }
    }));
    for (const item of checked) if (item.payload) rows.push(item.payload); else removed.push(item.removed);
  }

  let state = await localState(clinic, rows);
  const before = documentDifferences(rows, state);
  // También se reproyecta lo que no cambió en Contífico pero quedó distinto aquí.
  const drifted = new Set(before.map((item) => item.id));
  const changed = [...new Map([...planDocumentChanges(rows, state.archivedById),
    ...rows.filter((row) => drifted.has(String(row.id)))].map((row) => [String(row.id), row])).values()];
  if (!commit || (!changed.length && !removed.length && !before.length)) {
    return { month: key, state: before.length || changed.length || removed.length ? 'DIFFERENT' : 'CURRENT',
      source: rows.length, changed: changed.length, removed: removed.length,
      differences: before.length, sample: before.slice(0, 20),
      removedIds: removed.map((record) => record.externalId) };
  }

  // Respaldo de todo lo que puede cambiar, antes de escribir.
  const touched = [...changed.map((row) => state.archivedById.get(String(row.id))).filter(Boolean), ...removed];
  const refs = touched.map((record) => record._id);
  const saleRefs = touched.map((record) => linkTo(record, 'Sale')?.ref).filter(Boolean);
  const [oldRecords, oldSales, oldPurchases, oldReceivables, oldPayables] = await Promise.all([
    Record.find({ _id: { $in: refs } }).lean(),
    Sale.find({ _id: { $in: saleRefs } }).lean(),
    PurchaseInvoice.find({ clinic: clinic._id, sourceModel: 'ContificoRecord', sourceRef: { $in: refs } }).lean(),
    Receivable.find({ clinic: clinic._id, sourceModel: 'ContificoRecord', sourceRef: { $in: refs } }).lean(),
    Payable.find({ clinic: clinic._id, sourceModel: 'ContificoRecord', sourceRef: { $in: refs } }).lean(),
  ]);
  assertLease();
  const backup = backupRows(clinic, key, [...oldRecords, ...oldSales, ...oldPurchases, ...oldReceivables, ...oldPayables]);
  console.log(`[contifico-document-sync] ${key} respaldo=${backup} cambiados=${changed.length} retirados=${removed.length} diferencias=${before.length}`);

  // Instantánea propia: la etapa NO se llama `documents` para que una proyección
  // completa posterior no la confunda con el listado íntegro de documentos.
  const extractor = new Extractor({ api, clinic, commit: true, from, through, cutoff: through });
  await extractor.begin();
  try {
    const stage = extractor.stage('documents_window');
    stage.expected = rows.length;
    await extractor.archive('document', changed, stage);
    await extractor.saveStage(stage);
    const scope = await prepareReferences({ clinic, api, extractor, changed });
    extractor.run.status = 'COMPLETED'; extractor.run.completedAt = new Date();
    await extractor.run.save();
    assertLease();
    if (removed.length) await retireDocuments(clinic, removed, extractor.run._id);
    if (changed.length) {
      const projector = new Projector({ clinic, commit: true, cutoff: through, only: 'documents',
        sourceIds: changed.map((row) => String(row.id)), scope, sourceSnapshotId: extractor.run._id });
      assertLease();
      const projected = await projector.execute();
      const failed = projected.issues.filter((issue) => !/item manual|sin desglose completo/.test(issue.message));
      if (failed.length) throw new Error(`Proyección ${key}: ${failed.slice(0, 3).map((issue) => `${issue.externalId} ${issue.message}`).join('; ')}`);
    }
  } catch (error) {
    if (extractor.run.status === 'RUNNING') {
      extractor.run.status = 'FAILED'; extractor.run.completedAt = new Date();
      extractor.run.issues = [{ message: error.message }];
      await extractor.run.save().catch(() => {});
    }
    throw error;
  }

  // Verificación posterior documento por documento.
  state = await localState(clinic, rows);
  const after = documentDifferences(rows, state);
  if (after.length) {
    const sample = after.slice(0, 3).map((item) => `${item.number || item.id} ${item.field}: ${item.source}≠${item.local}`).join('; ');
    throw new Error(`Verificación ${key}: ${after.length} diferencias (${sample})`);
  }
  return { month: key, state: 'SYNCED', source: rows.length, updated: changed.length,
    retired: removed.length, fixed: before.length, backup, snapshot: String(extractor.run._id) };
}

async function syncDocuments({ includeHistory = false, months: requestedMonths = null, commit = true, trigger = 'MANUAL' } = {}) {
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
      } catch (error) { leaseLost = true; console.error('[contifico-document-sync] Perdió arriendo:', error.message); }
    }, 60 * 1000);
    const assertLease = () => { if (leaseLost) throw new Error('Arriendo de sincronización perdido'); };
    const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
    if (!clinic) throw new Error('Clínica Central no encontrada');
    if (commit) await recordSyncState({ state: 'RUNNING', trigger, host: os.hostname(),
      startedAt: new Date(), completedAt: null, months: [], failures: [], lastError: '' });
    const api = new ContificoApi({ apiKey: process.env.CONTIFICO_API_KEY });
    const today = ecToday();
    const windows = [];
    if (requestedMonths) {
      for (const value of requestedMonths) {
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new Error(`Mes inválido ${value}`);
        windows.push(value.split('-').map(Number));
      }
    } else {
      windows.push([today.year, today.month], today.month === 1 ? [today.year - 1, 12] : [today.year, today.month - 1]);
      // Los meses futuros no tienen documentos emitidos: el histórico llega hasta hoy.
      if (includeHistory) for (let year = 2026; year <= today.year; year += 1) {
        for (let month = year === today.year ? today.month : 12; month >= 1; month -= 1) windows.push([year, month]);
      }
    }
    const seen = new Set();
    const result = [], failures = [];
    for (const [year, month] of windows) {
      const key = `${year}-${String(month).padStart(2, '0')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const alertKey = `docs-${key}`;
      try {
        assertLease();
        const outcome = await syncDocumentMonth({ clinic, api, year, month, commit, assertLease });
        result.push(outcome);
        console.log(`[contifico-document-sync] ${key}: ${outcome.state}, ${outcome.source} documentos`);
        if (commit) await Notification.updateMany({ clinic: clinic._id, type: 'contifico_sync_blocked',
          'meta.month': alertKey, read: false }, { $set: { read: true, readAt: new Date() } })
          .catch((error) => console.error('[contifico-document-sync] Aviso resuelto:', error.message));
      } catch (error) {
        failures.push({ month: key, error: error.message });
        console.error(`[contifico-document-sync] BLOQUEADO ${key}:`, error.stack || error.message);
        if (commit) await Notification.updateOne({ clinic: clinic._id, user: null, type: 'contifico_sync_blocked',
          'meta.month': alertKey, read: false }, { $setOnInsert: {
          clinic: clinic._id, user: null, type: 'contifico_sync_blocked', severity: 'error',
          meta: { month: alertKey },
          title: `Contífico: sincronización de ventas y compras detenida (${key})`,
          body: String(error.message).slice(0, 500),
        } }, { upsert: true }).catch((notificationError) =>
          console.error('[contifico-document-sync] No pudo crear aviso:', notificationError.message));
      }
    }
    const outcome = { state: failures.length ? 'PARTIAL' : 'COMPLETED', months: result, failures };
    if (commit) await recordSyncState({ ...outcome, completedAt: new Date(),
      ...(failures.length ? {} : { lastSuccessfulAt: new Date() }) });
    return outcome;
  } catch (error) {
    if (acquired && commit) await recordSyncState({ state: 'FAILED', completedAt: new Date(),
      lastError: String(error.message).slice(0, 500) });
    throw error;
  } finally {
    if (renewal) clearInterval(renewal);
    if (acquired) await ServerLease.deleteOne({ _id: LEASE_NAME, holder }).catch((error) =>
      console.error('[contifico-document-sync] No pudo soltar arriendo:', error.message));
    running = false;
  }
}

module.exports = { fetchDocumentWindow, planDocumentChanges, documentDifferences, syncDocumentMonth, syncDocuments };
