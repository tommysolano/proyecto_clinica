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
const os = require('os');
const Contact = require('../models/Contact');
const ContactImport = require('../models/ContactImport');
const { iterateRows } = require('./contactFileReader');
const { mapRow } = require('./contactRowMapper');
const { emitToCallCenter } = require('../realtime');

const BATCH_SIZE = 500;      // filas por bulkWrite
const MAX_STORED_ERRORS = 200; // muestra para la UI: 47k errores no caben en un doc

// ── Resolución de la SUCURSAL por fila (columna "Sucursal" del Excel) ──
// El Excel trae el NOMBRE de la sede; se resuelve a la sucursal real para ubicar
// ahí al contacto y poder bifurcar el flujo por sucursal (nodo Dividir / condición
// clinic). Si el nombre no coincide con ninguna sede, el contacto cae en la sucursal
// por defecto del asistente (batch.clinic).
//
// El emparejamiento NO es sensible a mayúsculas NI a acentos ("GUAYAQUIL",
// "Guayaquil" y "guayaquíl" son la misma sede) y colapsa espacios: el usuario
// escribe el nombre a mano en el Excel y no debe cuadrar tildes ni mayúsculas.
const normClinicName = (s) => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '') // quita acentos/tildes
  .trim().toLowerCase().replace(/\s+/g, ' ');

async function buildClinicResolver() {
  const Clinic = require('../models/Clinic');
  const clinics = await Clinic.find({}).select('_id name').lean();
  const byName = new Map();
  for (const c of clinics) {
    const key = normClinicName(c.name);
    if (key && !byName.has(key)) byName.set(key, String(c._id));
  }
  return (name) => {
    const key = normClinicName(name);
    return key ? byName.get(key) || null : null;
  };
}

// ── Inscripción en workflows (disparador 'contact_import') ──
// Los arranques se ESCALONAN (goteo): entre un contacto y el siguiente se esperan
// `dripSeconds` (lo configura el usuario). Inscribir 47k contactos con arranque
// inmediato dispararía el primer paso de todos a la vez — la ráfaga que el goteo evita.
//
// CUÁNDO arranca el primer mensaje lo decide el LOTE (no una columna del Excel):
//   sendMode='now'  → de inmediato (goteo desde ahora)
//   sendMode='at'   → a la hora `batch.sendAt` ("HH:MM"; hoy si no pasó, mañana si sí)
//   sendMode='flow' → a la "Hora de envío" que trae el disparador del propio flujo
// La columna "Hora" del Excel es la hora de la CITA (variable de la plantilla), no
// la hora de disparo — mapearla a envío retrasaba toda la campaña a la mañana siguiente.
const DEFAULT_DRIP_SECONDS = 20;
const HHMM_RE = /^\d{1,2}:\d{2}$/;

/** dripSeconds válido y acotado (1s … 1h). */
function dripOf(batch) {
  return Math.min(3600, Math.max(1, Number(batch?.dripSeconds) || DEFAULT_DRIP_SECONDS));
}

/**
 * Próxima vez que ocurre la hora local "HH:MM": hoy si aún no pasó, mañana si ya pasó.
 * En hora de Ecuador (el proceso corre con TZ America/Guayaquil), así que "08:00" es
 * 8 am en Ecuador.
 */
function nextOccurrenceOfLocalTime(hhmm, now = new Date()) {
  const [h, m] = String(hhmm || '').split(':').map((n) => parseInt(n, 10));
  const t = new Date(now);
  t.setHours(h || 0, m || 0, 0, 0);
  if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1);
  return t;
}

/**
 * "Hora de envío" configurada en el disparador contact_import del flujo ("HH:MM") o
 * '' si no trae ninguna. Grafo (nodes) y legacy (trigger único).
 */
function flowSendHour(wf) {
  const triggerNodes = (wf?.nodes || []).filter((n) => n.type === 'trigger');
  const triggers = triggerNodes.length
    ? triggerNodes.flatMap((n) => n.data?.triggers || [])
    : [wf?.trigger].filter(Boolean);
  for (const tr of triggers) {
    if (tr?.type === 'contact_import' && HHMM_RE.test(tr.sendHour || '')) return tr.sendHour;
  }
  return '';
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
async function enrollInWorkflows(batch, phoneInfo, onProgress) {
  // phoneInfo: Map teléfono → { clinic }.  clinic = sucursal del contacto (para
  // bifurcar por sede). Retrocompat: también acepta Map tel→clinicId o un array de
  // teléfonos.
  const normInfo = (v) =>
    v && typeof v === 'object' && !(v instanceof Date)
      ? { clinic: v.clinic ? String(v.clinic) : '' }
      : { clinic: v ? String(v) : '' };
  const entries = phoneInfo instanceof Map
    ? [...phoneInfo].map(([p, v]) => [p, normInfo(v)])
    : (phoneInfo || []).map((p) => [p, { clinic: String(batch.clinic) }]);
  if (!batch.workflows?.length || !entries.length) return 0;
  const Workflow = require('../models/Workflow');
  const WorkflowEnrollment = require('../models/WorkflowEnrollment');
  const { matchingFlows } = require('./workflowEngine');

  const workflows = await Workflow.find({ _id: { $in: batch.workflows }, clinic: batch.clinic, active: true });

  // ── Hora de disparo del lote ──
  // sendMode decide a qué hora arranca cada contacto; se resuelve una hora "HH:MM"
  // (o '' = de inmediato) POR WORKFLOW, porque en modo 'flow' cada flujo trae la suya.
  const sendMode = ['now', 'at', 'flow'].includes(batch.sendMode) ? batch.sendMode : 'now';
  const sendAt = HHMM_RE.test(batch.sendAt || '') ? batch.sendAt : '';
  const hourForWorkflow = (wf) => {
    if (sendMode === 'at') return sendAt;
    if (sendMode === 'flow') return flowSendHour(wf);
    return ''; // 'now'
  };
  const perWorkflow = workflows
    .map((wf) => ({ wf, flows: matchingFlows(wf, (tr) => tr?.type === 'contact_import'), hour: hourForWorkflow(wf) }))
    .filter((x) => x.flows.length);
  if (!perWorkflow.length) return 0;

  // El contacto se busca por TELÉFONO (no por su sucursal): CRM global, y un contacto
  // que YA existía conserva su `clinic` original ($setOnInsert), que puede NO ser la
  // sucursal que trae el Excel de ESTA importación. Filtrar por (clinic resuelta,
  // phone) se saltaba a esos contactos actualizados → "solo se inscribió uno".
  // La sucursal del Excel (para bifurcar el flujo) viaja aparte en `infoByPhone`.
  const infoByPhone = new Map(entries); // teléfono → { clinic } (sede del Excel)
  const allPhones = entries.map(([p]) => p);

  // ── Programación del arranque (goteo) ──
  // Con hora ('at'/'flow'): se agrupa por hora y, dentro de cada hora, se separan por
  // `drip` para no dispararlos todos a la vez. De inmediato ('now'): se escalonan por
  // `drip` desde ahora.
  const drip = dripOf(batch);
  const startNow = new Date();
  let immediateSlot = new Date(startNow.getTime() - drip * 1000); // el 1º = ahora
  const hourCursor = new Map();                                   // "HH:MM" → siguiente Date libre
  const scheduleStart = (hour) => {
    if (hour) {
      const base = nextOccurrenceOfLocalTime(hour, startNow);
      let next = hourCursor.get(hour);
      if (!next || next.getTime() < base.getTime()) next = new Date(base);
      hourCursor.set(hour, new Date(next.getTime() + drip * 1000));
      return next;
    }
    immediateSlot = new Date(immediateSlot.getTime() + drip * 1000);
    return immediateSlot;
  };

  let enrolled = 0;
  let skipped = 0; // contactos NO inscritos por ya tener una inscripción viva (dedup)
  const createdByWf = new Map(); // workflowId → inscripciones creadas de verdad

  for (let i = 0; i < allPhones.length; i += BATCH_SIZE) {
    const chunk = allPhones.slice(i, i + BATCH_SIZE);
    // eslint-disable-next-line no-await-in-loop
    const contacts = await Contact.find({
      phone: { $in: chunk },
      active: true,
      'marketing.whatsappOptIn': true,
      'marketing.optOutAt': null,
    })
      .select('_id phone patient clinic')
      .lean();

    for (const contact of contacts) {
      // Sucursal a la que lo mandó el Excel de ESTE import (para bifurcar el flujo);
      // si no vino, la del propio contacto o la del asistente.
      const eventClinicId =
        infoByPhone.get(contact.phone)?.clinic || String(contact.clinic || batch.clinic);
      for (const { wf, flows, hour } of perWorkflow) {
        for (const flow of flows) {
          // eslint-disable-next-line no-await-in-loop
          const dup = await WorkflowEnrollment.findOne({
            workflow: wf._id,
            'context.contactId': String(contact._id),
            startNodeId: flow.startNodeId,
            status: { $in: ['active', 'waiting'] },
          }).select('_id');
          if (dup) { skipped++; continue; }

          const slot = scheduleStart(hour);
          // eslint-disable-next-line no-await-in-loop
          await WorkflowEnrollment.create({
            // La inscripción corre en la clínica del asistente (contexto del call
            // center / mensajería, sin cambios). La SUCURSAL del contacto viaja en
            // el contexto para bifurcar el flujo (nodo Dividir por sucursal / condición).
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
              eventClinicId,
            },
          });
          enrolled++;
          createdByWf.set(String(wf._id), (createdByWf.get(String(wf._id)) || 0) + 1);
        }
      }
    }
    if (onProgress) onProgress(enrolled);
  }

  if (batch && typeof batch === 'object') batch.enrollSkipped = skipped;
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
    // `clinic` (sucursal resuelta de la fila) va SOLO en el filtro y $setOnInsert,
    // nunca en $set: no se re-ubica a un contacto ya existente ni choca con
    // $setOnInsert. `clinicName` (crudo) tampoco se escribe como campo.
    const { phone, tags = [], customFields = {}, clinic: rowClinic, clinicName, ...fields } = c;
    const clinicId = rowClinic || batch.clinic;

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
        clinic: clinicId,
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
        filter: { clinic: clinicId, phone },
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
  // Con sucursal por fila, "existir" es por (sucursal, teléfono): se agrupa por
  // sede para consultar con el índice (clinic, phone) y no barrer por teléfono suelto.
  let toWrite = rows;
  let skipped = 0;
  if (batch.mode === 'create') {
    const byClinic = new Map();
    for (const r of rows) {
      const cid = String(r.clinic || batch.clinic);
      if (!byClinic.has(cid)) byClinic.set(cid, []);
      byClinic.get(cid).push(r.phone);
    }
    const known = new Set();
    for (const [cid, phones] of byClinic) {
      // eslint-disable-next-line no-await-in-loop
      const existing = await Contact.find({ clinic: cid, phone: { $in: phones } }).select('phone').lean();
      existing.forEach((e) => known.add(`${cid}:${e.phone}`));
    }
    toWrite = rows.filter((r) => !known.has(`${String(r.clinic || batch.clinic)}:${r.phone}`));
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
    // Guardia de máquina: el archivo está en el disco de UN host concreto. Un
    // server de desarrollo local conectado a la base de producción corría este
    // mismo job, agarraba el lote y lo mataba con "el archivo ya no está en el
    // servidor" (buscaba rutas del VPS en Windows). '' = lotes de antes del campo.
    { _id: batchId, status: 'pending', host: { $in: [os.hostname(), '', null] } },
    { $set: { status: 'running', startedAt: new Date() } },
    { new: true }
  );
  if (!batch) return null; // ya lo cogió otro tick del job, o es de otra máquina

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

    // Resolutor de sucursal por NOMBRE (columna "Sucursal" del Excel), cargado una
    // sola vez. Si la fila no trae sucursal (o no coincide), cae en batch.clinic.
    const resolveClinic = await buildClinicResolver();

    // Dentro del archivo puede venir el mismo número dos veces; sin esto, la misma
    // tanda haría dos upserts al mismo contacto y Mongo se queja. Se guarda además,
    // por teléfono, la sucursal resuelta para inscribir al terminar.
    const seen = new Map(); // phone → { clinic }

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
      // Resolver la sucursal de la fila (nombre → sede real). Sin coincidencia, se
      // deja sin `clinic` y buildOps usa la sucursal por defecto del asistente.
      if (mapped.contact.clinicName) {
        const resolved = resolveClinic(mapped.contact.clinicName);
        if (resolved) mapped.contact.clinic = resolved;
        delete mapped.contact.clinicName;
      }
      // Defensa: si un mapeo legacy trae "sendTime", NO es un campo del contacto —
      // se descarta para no escribirlo en el documento (la hora de disparo ya no
      // sale de una columna, la decide el lote con sendMode/sendAt).
      if ('sendTime' in mapped.contact) delete mapped.contact.sendTime;
      if (seen.has(mapped.contact.phone)) {
        batch.skipped++; // repetido dentro del propio archivo
        return;
      }
      seen.set(mapped.contact.phone, { clinic: String(mapped.contact.clinic || batch.clinic) });
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
        // `seen` = Map teléfono→{clinic} de todo el archivo (creados Y actualizados;
        // los actualizados no llevan importBatch, así que no hay otra forma de
        // encontrarlos). El filtro de consentimiento se aplica dentro.
        batch.enrolled = await enrollInWorkflows(batch, seen, (n) => {
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
    { status: 'running', host: { $in: [os.hostname(), '', null] }, updatedAt: { $lte: new Date(Date.now() - 5 * 60 * 1000) } },
    { $set: { status: 'pending' } }
  ).catch(() => {});

  // Solo los lotes de ESTA máquina (ver guardia en runImport).
  const pending = await ContactImport.find({ status: 'pending', host: { $in: [os.hostname(), '', null] } })
    .select('_id')
    .sort({ createdAt: 1 })
    .limit(3);
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

module.exports = { runImport, processPendingImports, revertImport, enrollInWorkflows, nextOccurrenceOfLocalTime, flowSendHour, BATCH_SIZE };
