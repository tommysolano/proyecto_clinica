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

// ── Inscripción en workflows (disparador 'contact_import') ──
// Los arranques se ESCALONAN: uno cada SLOT_SECONDS dentro de la franja horaria.
// Inscribir 47k contactos con arranque inmediato dispararía el primer paso de
// todos a la vez — la misma ráfaga que el goteo existe para evitar.
const SLOT_SECONDS = 20;      // ≈180 arranques/hora, ~2.000/día en la franja
const ENROLL_HOUR_FROM = 9;   // hora local Ecuador (TZ del proceso)
const ENROLL_HOUR_TO = 20;

/**
 * Siguiente hueco de arranque: `prev` + SLOT_SECONDS, movido a la franja
 * 09:00–20:00 (nadie quiere el primer mensaje de un workflow a las 3 am).
 */
function nextEnrollSlot(prev) {
  const t = new Date(prev.getTime() + SLOT_SECONDS * 1000);
  if (t.getHours() < ENROLL_HOUR_FROM) {
    t.setHours(ENROLL_HOUR_FROM, 0, 0, 0);
  } else if (t.getHours() >= ENROLL_HOUR_TO) {
    t.setDate(t.getDate() + 1);
    t.setHours(ENROLL_HOUR_FROM, 0, 0, 0);
  }
  return t;
}

/**
 * Inscribe los contactos del archivo en los workflows elegidos en el asistente.
 *
 * - Solo contactos con CONSENTIMIENTO (opt-in y sin baja): el motor de workflows
 *   valida opt-out de pacientes, pero no conoce el opt-out de contactos.
 * - status 'waiting' + nextRunAt escalonado. OJO: 'active' no sirve — el job de
 *   recuperación reintenta cualquier 'active' con >5 min sin avanzar AUNQUE su
 *   nextRunAt sea futuro, y dispararía todos los arranques de golpe.
 * - Dedup por (workflow, contacto) vivo: reimportar el archivo no duplica.
 */
async function enrollInWorkflows(batch, phones, onProgress) {
  if (!batch.workflows?.length || !phones.length) return 0;
  const Workflow = require('../models/Workflow');
  const WorkflowEnrollment = require('../models/WorkflowEnrollment');
  const { matchingFlows } = require('./workflowEngine');

  const workflows = await Workflow.find({ _id: { $in: batch.workflows }, clinic: batch.clinic, active: true });
  const perWorkflow = workflows
    .map((wf) => ({ wf, flows: matchingFlows(wf, (tr) => tr?.type === 'contact_import') }))
    .filter((x) => x.flows.length);
  if (!perWorkflow.length) return 0;

  let slot = new Date();
  let enrolled = 0;
  const createdByWf = new Map(); // workflowId → inscripciones creadas de verdad

  for (let i = 0; i < phones.length; i += BATCH_SIZE) {
    const chunk = phones.slice(i, i + BATCH_SIZE);
    // eslint-disable-next-line no-await-in-loop
    const contacts = await Contact.find({
      clinic: batch.clinic,
      phone: { $in: chunk },
      active: true,
      'marketing.whatsappOptIn': true,
      'marketing.optOutAt': null,
    })
      .select('_id phone patient')
      .lean();

    for (const contact of contacts) {
      for (const { wf, flows } of perWorkflow) {
        for (const flow of flows) {
          // eslint-disable-next-line no-await-in-loop
          const dup = await WorkflowEnrollment.findOne({
            workflow: wf._id,
            'context.contactId': String(contact._id),
            startNodeId: flow.startNodeId,
            status: { $in: ['active', 'waiting'] },
          }).select('_id');
          if (dup) continue;

          slot = nextEnrollSlot(slot);
          // eslint-disable-next-line no-await-in-loop
          await WorkflowEnrollment.create({
            clinic: batch.clinic,
            workflow: wf._id,
            patient: contact.patient || null,
            stepIndex: 0,
            currentNodeId: flow.currentNodeId,
            startNodeId: flow.startNodeId,
            status: 'waiting',
            nextRunAt: slot,
            context: {
              phone: contact.phone,
              contactId: String(contact._id),
              importBatchId: String(batch._id),
              eventType: 'contact_import',
            },
          });
          enrolled++;
          createdByWf.set(String(wf._id), (createdByWf.get(String(wf._id)) || 0) + 1);
        }
      }
    }
    if (onProgress) onProgress(enrolled);
  }

  for (const [wfId, n] of createdByWf) {
    // eslint-disable-next-line no-await-in-loop
    await Workflow.updateOne({ _id: wfId }, { $inc: { 'stats.enrolled': n } }).catch(() => {});
  }
  return enrolled;
}

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
      enrolled: batch.enrolled,
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

    // Inscribir en los workflows elegidos. DESPUÉS de marcar 'done': la
    // importación de datos ya terminó y esto es una fase aparte — si fallara, los
    // contactos ya están dentro y el error queda en el lote sin marcarlo fallido.
    if (batch.workflows?.length) {
      try {
        // `seen` = todos los teléfonos válidos del archivo (creados Y actualizados;
        // los actualizados no llevan importBatch, así que no hay otra forma de
        // encontrarlos). El filtro de consentimiento se aplica dentro.
        batch.enrolled = await enrollInWorkflows(batch, [...seen], (n) => {
          batch.enrolled = n;
          progress();
        });
        await batch.save();
        progress();
      } catch (e) {
        batch.errorMessage = `Contactos importados, pero la inscripción en workflows falló: ${e.message}`;
        await batch.save().catch(() => {});
      }
    }
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
  // Rescate: lotes que quedaron en 'running' porque un deploy o un reinicio mató
  // el proceso a mitad. Mientras procesa de verdad guarda cada 500 filas, así que
  // 5 min sin escribir = muerto. Reprocesar desde cero es seguro: los contadores
  // se resetean al arrancar, la escritura es por upsert (teléfono único) y las
  // inscripciones en workflows tienen dedup.
  await ContactImport.updateMany(
    { status: 'running', updatedAt: { $lte: new Date(Date.now() - 5 * 60 * 1000) } },
    { $set: { status: 'pending' } }
  ).catch(() => {});

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

  // Las inscripciones pendientes de este lote se cancelan: deshacer la
  // importación también significa que esos contactos no reciban el workflow.
  // Las 'done' se quedan (el mensaje ya salió; cancelarlas no lo des-envía).
  const WorkflowEnrollment = require('../models/WorkflowEnrollment');
  const cancelled = await WorkflowEnrollment.updateMany(
    { 'context.importBatchId': String(batch._id), status: { $in: ['active', 'waiting'] } },
    { $set: { status: 'cancelled', nextRunAt: null } }
  );

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
  return { ok: true, deleted: del.deletedCount || 0, cleaned, cancelledEnrollments: cancelled.modifiedCount || 0 };
}

module.exports = { runImport, processPendingImports, revertImport, enrollInWorkflows, nextEnrollSlot, BATCH_SIZE };
