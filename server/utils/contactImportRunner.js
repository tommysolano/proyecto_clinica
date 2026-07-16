/**
 * Procesa un lote de importación de contactos (ContactImport).
 *
 * Lo ejecuta un job cada minuto, NO la petición HTTP: 47k filas tardan minutos y
 * nginx corta a los 60 s, dejando la importación a medias y sin saber por dónde
 * iba. Aquí el estado vive en el lote, así que se puede seguir el progreso desde
 * la UI y reanudar si el server se reinicia a mitad.
 *
 * Escribe por TANDAS con bulkWrite (no un save por fila): con 47k contactos, una
 * escritura por fila son 47k viajes a Mongo.
 */
const fs = require('fs');
const Contact = require('../models/Contact');
const ContactImport = require('../models/ContactImport');
const { iterateRows } = require('./contactFileReader');
const { mapRow } = require('./contactRowMapper');
const { emitToCallCenter } = require('../realtime');

const BATCH_SIZE = 500;      // filas por bulkWrite
const MAX_STORED_ERRORS = 200; // muestra para la UI: 47k errores no caben en un doc

/** Construye el bulkWrite de una tanda respetando el modo de importación. */
function buildOps(rows, batch) {
  const ops = [];
  for (const c of rows) {
    const { phone, tags = [], customFields = {}, ...fields } = c;

    // Los campos del archivo que sí venían. Los ausentes NO se tocan: así
    // reimportar un archivo sin la columna Nombre no borra los nombres.
    const set = { ...fields };
    for (const [k, v] of Object.entries(customFields)) set[`customFields.${k}`] = v;

    // Las etiquetas del lote se suman a las de la fila, y $addToSet no duplica
    // ni pisa las que el contacto ya tuviera de otra importación.
    const allTags = [...new Set([...(batch.tags || []), ...tags])];
    const addToSet = {};
    if (allTags.length) addToSet.tags = { $each: allTags };
    if (batch.groups?.length) addToSet.groups = { $each: batch.groups };

    const update = {
      ...(Object.keys(set).length ? { $set: set } : {}),
      ...(Object.keys(addToSet).length ? { $addToSet: addToSet } : {}),
      // Solo al CREAR: no se le cambia el consentimiento a un contacto que ya
      // existe (puede haberse dado de baja, y una reimportación no puede
      // resucitarle el opt-in en silencio).
      $setOnInsert: {
        clinic: batch.clinic,
        phone,
        source: 'import',
        importBatch: batch._id,
        'marketing.whatsappOptIn': batch.whatsappOptIn !== false,
        'marketing.consentSource': batch.consentSource || '',
        createdBy: batch.createdBy || null,
      },
    };

    ops.push({
      updateOne: {
        filter: { clinic: batch.clinic, phone },
        update,
        upsert: batch.mode !== 'update', // 'update' = solo tocar los que ya existen
      },
    });
  }
  return ops;
}

/**
 * Aplica una tanda. Devuelve { created, updated, skipped }.
 * En modo 'create' se descartan los que ya existían; en 'update', los que no.
 */
async function flushBatch(rows, batch) {
  if (!rows.length) return { created: 0, updated: 0, skipped: 0 };

  // Modo 'create' (solo crear): hay que saber cuáles ya existen para no tocarlos.
  let toWrite = rows;
  let skipped = 0;
  if (batch.mode === 'create') {
    const phones = rows.map((r) => r.phone);
    const existing = await Contact.find({ clinic: batch.clinic, phone: { $in: phones } })
      .select('phone')
      .lean();
    const known = new Set(existing.map((e) => e.phone));
    toWrite = rows.filter((r) => !known.has(r.phone));
    skipped = rows.length - toWrite.length;
  }
  if (!toWrite.length) return { created: 0, updated: 0, skipped };

  const res = await Contact.bulkWrite(buildOps(toWrite, batch), { ordered: false });
  const created = res.upsertedCount || 0;
  const matched = res.matchedCount || 0;
  // En modo 'update' los que no existían no se escriben: cuentan como omitidos.
  if (batch.mode === 'update') skipped += toWrite.length - matched;
  return { created, updated: matched, skipped };
}

/**
 * Procesa un lote entero. Idempotente por estado: solo corre si está 'pending'.
 */
async function runImport(batchId) {
  const batch = await ContactImport.findOneAndUpdate(
    { _id: batchId, status: 'pending' },
    { $set: { status: 'running', startedAt: new Date() } },
    { new: true }
  );
  if (!batch) return null; // ya lo cogió otro tick del job

  const progress = () =>
    emitToCallCenter('contactImport:progress', {
      importId: String(batch._id),
      status: batch.status,
      processedRows: batch.processedRows,
      created: batch.created,
      updated: batch.updated,
      skipped: batch.skipped,
      failed: batch.failed,
    });

  try {
    if (!batch.filePath || !fs.existsSync(batch.filePath)) {
      throw new Error('El archivo subido ya no está en el servidor. Vuelve a subirlo.');
    }
    // Una reimportación del mismo lote duplicaría los contadores.
    batch.processedRows = 0;
    batch.created = 0;
    batch.updated = 0;
    batch.skipped = 0;
    batch.failed = 0;
    batch.rowErrors = [];

    let pending = [];
    const flush = async () => {
      const r = await flushBatch(pending, batch);
      batch.created += r.created;
      batch.updated += r.updated;
      batch.skipped += r.skipped;
      pending = [];
      await batch.save();
      progress();
    };

    // Dentro del archivo puede venir el mismo número dos veces; sin esto, la
    // misma tanda haría dos upserts al mismo contacto y Mongo se queja.
    const seen = new Set();

    await iterateRows(batch.filePath, batch.fileName, async (row, rowNo) => {
      batch.processedRows++;
      const mapped = mapRow(row, batch.mapping);
      if (!mapped.ok) {
        batch.failed++;
        if (batch.rowErrors.length < MAX_STORED_ERRORS) {
          batch.rowErrors.push({ row: rowNo, value: mapped.value || '', reason: mapped.reason });
        }
        return;
      }
      if (seen.has(mapped.contact.phone)) {
        batch.skipped++; // repetido dentro del propio archivo
        return;
      }
      seen.add(mapped.contact.phone);
      pending.push(mapped.contact);
      if (pending.length >= BATCH_SIZE) await flush();
    });
    await flush();

    batch.status = 'done';
    batch.totalRows = batch.processedRows;
    batch.finishedAt = new Date();
    await batch.save();
    progress();
  } catch (e) {
    batch.status = 'failed';
    batch.errorMessage = e.message;
    batch.finishedAt = new Date();
    await batch.save();
    progress();
  } finally {
    // El archivo solo hace falta mientras se procesa.
    if (batch.filePath) {
      fs.promises.unlink(batch.filePath).catch(() => {});
      batch.filePath = '';
      await batch.save().catch(() => {});
    }
  }
  return batch;
}

/** Job: coge los lotes que están esperando. */
async function processPendingImports() {
  const pending = await ContactImport.find({ status: 'pending' }).select('_id').sort({ createdAt: 1 }).limit(3);
  for (const p of pending) {
    // eslint-disable-next-line no-await-in-loop
    await runImport(p._id).catch((e) => console.error('[contactImport]', e.message));
  }
}

/**
 * Deshace una importación: borra los contactos que creó y quita sus etiquetas y
 * grupos de los que ya existían (a esos NO se les borra: existían antes).
 */
async function revertImport(batchId) {
  const batch = await ContactImport.findById(batchId);
  if (!batch) return { ok: false, error: 'Importación no encontrada' };
  if (batch.status === 'running') return { ok: false, error: 'La importación está en curso.' };
  if (batch.status === 'reverted') return { ok: false, error: 'Esa importación ya se deshizo.' };

  const del = await Contact.deleteMany({ importBatch: batch._id, patient: null });
  // Un contacto que ya se convirtió en paciente NO se borra: se le quitan las
  // marcas del lote, pero la persona se queda.
  const pull = {};
  if (batch.tags?.length) pull.tags = { $in: batch.tags };
  if (batch.groups?.length) pull.groups = { $in: batch.groups };
  let cleaned = 0;
  if (Object.keys(pull).length) {
    const r = await Contact.updateMany({ importBatch: batch._id }, { $pull: pull });
    cleaned = r.modifiedCount || 0;
  }
  batch.status = 'reverted';
  batch.revertedAt = new Date();
  await batch.save();
  return { ok: true, deleted: del.deletedCount || 0, cleaned };
}

module.exports = { runImport, processPendingImports, revertImport, BATCH_SIZE };
