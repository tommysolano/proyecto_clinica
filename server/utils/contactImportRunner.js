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
const ContactImportRow = require('../models/ContactImportRow');
const { iterateRows } = require('./contactFileReader');
const { mapRow } = require('./contactRowMapper');
const { emitToCallCenter } = require('../realtime');

const BATCH_SIZE = 500;      // filas por bulkWrite
const MAX_STORED_ERRORS = 200; // muestra para la UI: 47k errores no caben en un doc

function sourceValue(row, mapping, field) {
  const mapped = (mapping || []).find((item) => item.field === field);
  return mapped ? String(row?.[mapped.column] ?? '').trim() : '';
}

/** Datos identificativos aun cuando la fila no logró mapearse. */
function sourceSnapshot(row, mapping) {
  const firstName = sourceValue(row, mapping, 'firstName');
  const lastName = sourceValue(row, mapping, 'lastName');
  const displayName = sourceValue(row, mapping, 'displayName') || `${firstName} ${lastName}`.trim();
  return {
    phone: sourceValue(row, mapping, 'phone'),
    email: sourceValue(row, mapping, 'email'),
    firstName,
    lastName,
    displayName,
  };
}

function resultDocument(batch, entry, outcome, reason = '', contactId = null) {
  const c = entry?.contact || {};
  return {
    clinic: batch.clinic,
    importBatch: batch._id,
    row: Number(entry?.row) || 0,
    outcome,
    contact: contactId || null,
    phone: String(c.phone || ''),
    email: String(c.email || ''),
    firstName: String(c.firstName || ''),
    lastName: String(c.lastName || ''),
    displayName: String(c.displayName || `${c.firstName || ''} ${c.lastName || ''}`.trim()),
    value: String(entry?.value || c.phone || ''),
    reason,
  };
}

async function storeResultDocuments(documents) {
  if (!documents.length) return;
  await ContactImportRow.insertMany(documents, { ordered: false });
}

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
// Ventana en la que dos importaciones al MISMO flujo se consideran el mismo
// archivo subido dos veces por error (y no una campaña nueva). Ver el candado
// anti-duplicado de enrollInWorkflows.
const REENROLL_GUARD_MS = 30 * 60 * 1000;

/**
 * ¿A esta ficha se le puede escribir? Consentimiento de WhatsApp, sin baja y
 * activa. Se evalúa en memoria (no en la consulta) para poder elegir entre
 * fichas gemelas del mismo número: si una está dada de baja y la otra no, se
 * usa la buena en vez de dejar al número fuera del envío.
 */
const enviable = (c) =>
  c?.active !== false && c?.marketing?.whatsappOptIn !== false && !c?.marketing?.optOutAt;

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
  // UN SOLO ARRANQUE POR FLUJO. `matchingFlows` devuelve un arranque por cada nodo
  // disparador que case, y el editor visual permite tener varios disparadores
  // "Contactos importados" en el mismo diagrama. Inscribir por cada uno mandaba el
  // MISMO mensaje dos veces al mismo contacto — y con plantillas, Meta cobra las dos.
  // Para una importación eso nunca es lo deseado: el contacto entra una vez.
  const avisos = [];
  const perWorkflow = workflows
    .map((wf) => {
      const flows = matchingFlows(wf, (tr) => tr?.type === 'contact_import');
      if (flows.length > 1) {
        avisos.push(
          `El flujo "${wf.name}" tiene ${flows.length} disparadores "Contactos importados": se usó solo el primero para no enviar el mensaje ${flows.length} veces. Deja uno solo en el editor.`
        );
      }
      return { wf, flows: flows.slice(0, 1), hour: hourForWorkflow(wf) };
    })
    .filter((x) => x.flows.length);
  if (batch && typeof batch === 'object') batch.enrollWarning = avisos.join(' ');
  if (!perWorkflow.length) return 0;

  // Cancelar lo que quedó pendiente de importaciones ANTERIORES de estos mismos
  // flujos: si no, una prueba con goteo sigue soltando su mensaje durante horas y
  // se mezcla con el envío de verdad ("me llegó el mensaje del Excel anterior").
  // Solo lo que aún no ha salido; lo ya enviado no se toca.
  if (batch.cancelPending) {
    const r = await WorkflowEnrollment.updateMany(
      {
        workflow: { $in: perWorkflow.map((x) => x.wf._id) },
        status: { $in: ['active', 'waiting'] },
        'context.eventType': 'contact_import',
        'context.importBatchId': { $ne: String(batch._id) },
      },
      { $set: { status: 'cancelled', nextRunAt: null } }
    );
    batch.enrollCancelled = r.modifiedCount || 0;
  }

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
  let duplicatedContacts = 0; // fichas gemelas (mismo teléfono, otra sede) descartadas
  let optedOut = 0;           // números del archivo dados de baja / inactivos
  let missingContacts = 0;    // números del archivo sin ninguna ficha (fila fallida)
  const createdByWf = new Map(); // workflowId → inscripciones creadas de verdad

  for (let i = 0; i < allPhones.length; i += BATCH_SIZE) {
    const chunk = allPhones.slice(i, i + BATCH_SIZE);
    // Se traen TODAS las fichas del número, con o sin consentimiento: hace falta
    // ver las descartadas para poder elegir bien entre gemelas y para saber
    // decirle al usuario por qué a alguien no le llegó nada.
    // eslint-disable-next-line no-await-in-loop
    const found = await Contact.find({ phone: { $in: chunk } })
      .select('_id phone patient clinic updatedAt active marketing')
      .lean();

    // UN CONTACTO POR TELÉFONO. El mismo número puede tener dos fichas (una por
    // sede) de importaciones antiguas: `Contact` es único por (sede, teléfono),
    // no por teléfono. Inscribir las dos manda el MISMO mensaje dos veces al
    // mismo WhatsApp y Meta cobra los dos. Se queda la ficha con los datos de
    // ESTA campaña: la actualizada más recientemente (el Excel que se acaba de
    // importar). Las nuevas importaciones ya no crean gemelos (findExistingByPhone),
    // pero los que ya existían siguen ahí.
    //
    // PERO SE ELIGE ENTRE LAS QUE **SÍ** SE PUEDEN CONTACTAR. Antes el filtro de
    // consentimiento iba en la consulta, así que si la ficha más reciente estaba
    // dada de baja (o inactiva) y su gemela no, el número se quedaba fuera del
    // envío entero: dos fichas del mismo celular y el mensaje no le llegaba a
    // ninguna. Ahora la baja de una ficha solo descarta ESA ficha.
    const bestByPhone = new Map();
    const sinConsentimiento = new Set();
    for (const c of found) {
      if (!enviable(c)) { sinConsentimiento.add(c.phone); continue; }
      const prev = bestByPhone.get(c.phone);
      if (!prev || new Date(c.updatedAt || 0) > new Date(prev.updatedAt || 0)) bestByPhone.set(c.phone, c);
    }
    const contacts = [...bestByPhone.values()];
    // Fichas gemelas descartadas (contactables, pero del mismo número que otra).
    const contactables = found.filter(enviable).length;
    if (contacts.length < contactables) duplicatedContacts += contactables - contacts.length;
    // Números del archivo a los que NO se les va a mandar nada, y por qué. Sin
    // esto la campaña salía "correcta" y el usuario no tenía forma de saber que a
    // media lista no le había llegado el mensaje.
    for (const phone of chunk) {
      if (bestByPhone.has(phone)) continue;
      if (sinConsentimiento.has(phone)) optedOut++;
      else missingContacts++;
    }

    for (const contact of contacts) {
      // Sucursal a la que lo mandó el Excel de ESTE import (para bifurcar el flujo);
      // si no vino, la del propio contacto o la del asistente.
      const eventClinicId =
        infoByPhone.get(contact.phone)?.clinic || String(contact.clinic || batch.clinic);
      for (const { wf, flows, hour } of perWorkflow) {
        for (const flow of flows) {
          // ══ EL CANDADO ES CONTRA REPETIR **ESTA** IMPORTACIÓN ══
          //
          // Antes bastaba con que el número tuviera CUALQUIER inscripción viva en
          // este flujo para no volver a inscribirlo. Y una campaña con goteo deja
          // inscripciones 'waiting' durante horas o días (5.000 contactos a 20 s
          // son 27 h), así que la siguiente importación al mismo flujo se saltaba
          // a media lista: el usuario subía el Excel, veía "N contactos NO se
          // volvieron a encolar" y a esa gente no le llegaba NADA. Lo mismo con
          // una persona que sale en dos archivos seguidos ("el contacto se
          // duplica y no le llega a ninguno").
          //
          // Una importación NUEVA es un envío NUEVO: se inscribe. Lo que el
          // candado tiene que evitar es lo otro — que el MISMO lote inscriba dos
          // veces (el job se reanuda tras un reinicio, dos ticks a la vez) y que
          // una subida repetida por error a los pocos minutos duplique el gasto.
          // Para dejar de arrastrar lo pendiente de campañas anteriores está la
          // opción "cancelar lo pendiente" del asistente (batch.cancelPending).
          //
          // Se mira el TELÉFONO además de la ficha: el mensaje lo recibe un
          // número, y el mismo número puede tener ficha gemela en otra sede.
          // eslint-disable-next-line no-await-in-loop
          const dup = await WorkflowEnrollment.findOne({
            workflow: wf._id,
            $and: [
              {
                $or: [
                  { 'context.phone': contact.phone },
                  { 'context.contactId': String(contact._id) },
                ],
              },
              {
                $or: [
                  // Este mismo lote: nunca dos veces, pase lo que pase.
                  { 'context.importBatchId': String(batch._id) },
                  // Otro lote, pero de hace un momento: es el mismo archivo subido
                  // dos veces por error, no una campaña distinta.
                  {
                    status: { $in: ['active', 'waiting'] },
                    createdAt: { $gte: new Date(Date.now() - REENROLL_GUARD_MS) },
                  },
                ],
              },
            ],
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
              // Número FIJADO en el asistente. Vacío = automático: cada contacto
              // recibirá el mensaje por el número con el que él escribió la última
              // vez. Viaja aquí porque el envío ocurre horas después.
              ...(batch.whatsappAccount ? { whatsappAccountId: String(batch.whatsappAccount) } : {}),
            },
          });
          enrolled++;
          createdByWf.set(String(wf._id), (createdByWf.get(String(wf._id)) || 0) + 1);
        }
      }
    }
    if (onProgress) onProgress(enrolled);
  }

  if (batch && typeof batch === 'object') {
    batch.enrollSkipped = skipped;
    if (duplicatedContacts) {
      avisos.push(
        `${duplicatedContacts} contacto(s) del archivo tenían una ficha repetida en otra sucursal (mismo teléfono): se usó la más reciente que sí acepta mensajes y se envió UN solo mensaje a cada número.`
      );
    }
    // A ESTOS NO LES LLEGA NADA, y hay que decirlo: antes desaparecían en
    // silencio y la campaña parecía haber salido completa.
    if (optedOut) {
      avisos.push(
        `${optedOut} número(s) del archivo NO recibirán el mensaje porque su ficha está dada de baja o inactiva (se respeta el opt-out). Búscalos en Contactos si crees que es un error.`
      );
    }
    if (missingContacts) {
      avisos.push(
        `${missingContacts} número(s) del archivo NO se pudieron encolar porque no quedó ninguna ficha de contacto creada (revisa las filas fallidas del lote).`
      );
    }
    if (avisos.length) batch.enrollWarning = avisos.join(' ');
  }
  for (const [wfId, n] of createdByWf) {
    // eslint-disable-next-line no-await-in-loop
    await Workflow.updateOne({ _id: wfId }, { $inc: { 'stats.enrolled': n } }).catch(() => {});
  }
  return enrolled;
}

/**
 * Contactos que YA existen con esos teléfonos, EN CUALQUIER SEDE. Devuelve
 * Map teléfono → { _id, clinic }.
 *
 * POR QUÉ mira todas las sedes: `Contact` es único por (sede, teléfono), así que
 * el mismo número puede acabar como DOS contactos si dos importaciones lo mandan
 * a sucursales distintas (la columna "Sucursal" del Excel). Y eso no es un detalle
 * cosmético: a WhatsApp se le escribe a un TELÉFONO, no a una sucursal, así que
 * dos contactos = la misma persona inscrita dos veces = **el mismo mensaje dos
 * veces, cobrado dos veces por Meta** — y con los datos de la campaña partidos
 * entre las dos fichas (una con el {{servicio}} de este Excel y otra con el del
 * anterior). Pasó en producción el 27-jul-2026: 3 filas → 4 inscripciones.
 *
 * Con esto, un teléfono = UN contacto en toda la organización: si ya existe, la
 * fila lo ACTUALIZA donde esté en vez de crear un gemelo en otra sede.
 */
async function findExistingByPhone(phones) {
  const found = await Contact.find({ phone: { $in: phones } })
    .select('_id phone clinic createdAt')
    .sort({ createdAt: 1 })
    .lean();
  const byPhone = new Map();
  for (const c of found) {
    // El más antiguo manda (es el que tiene el histórico y las conversaciones).
    if (!byPhone.has(c.phone)) byPhone.set(c.phone, { _id: c._id, clinic: String(c.clinic) });
  }
  return byPhone;
}

/** Construye el bulkWrite de una tanda respetando el modo de importación. */
function buildOps(rows, batch, existingByPhone = new Map()) {
  const ops = [];
  for (const c of rows) {
    // `clinic` (sucursal resuelta de la fila) va SOLO en el filtro y $setOnInsert,
    // nunca en $set: no se re-ubica a un contacto ya existente ni choca con
    // $setOnInsert. `clinicName` (crudo) tampoco se escribe como campo.
    const { phone, tags = [], customFields = {}, clinic: rowClinic, clinicName, ...fields } = c;
    const clinicId = rowClinic || batch.clinic;
    const already = existingByPhone.get(phone);

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
        // Si ya existe (en la sede que sea), se actualiza ESE documento: un
        // teléfono = un contacto. Si no, se crea en la sucursal de la fila.
        filter: already ? { _id: already._id } : { clinic: clinicId, phone },
        update,
        // Con `_id` en el filtro nunca se hace upsert (el documento ya existe).
        upsert: !already && batch.mode !== 'update',
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
  const entries = rows.map((entry) => (entry?.contact ? entry : { row: 0, contact: entry }));

  // Quién existe YA, mirando el teléfono en TODA la organización (no por sede):
  // es lo que evita el contacto gemelo en otra sucursal. Ver findExistingByPhone.
  const existingByPhone = await findExistingByPhone(entries.map((entry) => entry.contact.phone));

  // Modo 'create' (solo crear): los que ya existen no se tocan.
  let toWrite = entries;
  if (batch.mode === 'create') {
    toWrite = entries.filter((entry) => !existingByPhone.has(entry.contact.phone));
  } else if (batch.mode === 'update') {
    toWrite = entries.filter((entry) => existingByPhone.has(entry.contact.phone));
  }
  if (toWrite.length) {
    await Contact.bulkWrite(buildOps(toWrite.map((entry) => entry.contact), batch, existingByPhone), { ordered: false });
  }

  // Resuelve también los ids recién creados para que el detalle pueda enlazar
  // con la ficha del contacto sin guardar documentos enormes en el lote.
  const afterByPhone = await findExistingByPhone(entries.map((entry) => entry.contact.phone));
  const documents = [];
  let created = 0;
  let updated = 0;
  let skipped = 0;
  for (const entry of entries) {
    const existed = existingByPhone.has(entry.contact.phone);
    let outcome;
    let reason = '';
    if (batch.mode === 'create' && existed) {
      outcome = 'skipped';
      reason = 'El contacto ya existía; el modo «Solo crear» no modifica contactos existentes.';
      skipped++;
    } else if (batch.mode === 'update' && !existed) {
      outcome = 'skipped';
      reason = 'El contacto no existía; el modo «Solo actualizar» no crea contactos nuevos.';
      skipped++;
    } else if (existed) {
      outcome = 'updated';
      reason = 'Se actualizó el contacto existente.';
      updated++;
    } else {
      outcome = 'created';
      reason = 'Se creó un contacto nuevo.';
      created++;
    }
    documents.push(resultDocument(batch, entry, outcome, reason, afterByPhone.get(entry.contact.phone)?._id));
  }
  await storeResultDocuments(documents);
  await applyNamesToConversations(entries);
  return { created, updated, skipped };
}

/**
 * EL NOMBRE DEL EXCEL PASA AL CHAT.
 *
 * En la bandeja los chats se veían con el apodo del PERFIL de WhatsApp ("Yo…!!!",
 * emojis, el número pelado) aunque el Excel trajera el nombre real: el nombre solo
 * se copiaba al chat si estaba VACÍO, así que reimportar no arreglaba nada y el
 * asesor abría el chat sin saber con quién hablaba.
 *
 * Se escribe aquí, al importar —no solo al enviar—, para que el nombre esté bien
 * desde que termina la carga. Reglas (las mismas de messaging.applyContactName):
 *   · nunca pisa un nombre escrito a mano (`contactNameEditedAt` / origen 'manual');
 *   · alcanza también los chats de "número oculto" (@lid) enlazados a ese teléfono;
 *   · sin filtro de sucursal: el CRM es global y la misma persona puede tener chat
 *     en varias sedes.
 * Un solo bulkWrite por tanda de 500 filas.
 */
async function applyNamesToConversations(entries) {
  const Conversation = require('../models/Conversation');
  const ops = [];
  const vistos = new Set();
  for (const { contact } of entries) {
    const nombre =
      `${contact.firstName || ''} ${contact.lastName || ''}`.trim() ||
      String(contact.displayName || '').trim();
    if (!nombre || !contact.phone || vistos.has(contact.phone)) continue;
    vistos.add(contact.phone);
    ops.push({
      updateMany: {
        filter: {
          $or: [{ phone: contact.phone }, { linkedPhone: contact.phone }],
          contactNameEditedAt: null,
          contactNameSource: { $ne: 'manual' },
          contactName: { $ne: nombre },
        },
        update: { $set: { contactName: nombre, contactNameSource: 'contact' } },
      },
    });
  }
  if (!ops.length) return;
  await Conversation.bulkWrite(ops, { ordered: false }).catch((e) =>
    console.error('[contactImport] no se pudo actualizar el nombre de los chats:', e.message)
  );
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
    batch.rowDetailsVersion = 1;
    // Un lote rescatado tras un reinicio se procesa desde cero; su auditoría
    // también, para que cada fila tenga exactamente un resultado.
    await ContactImportRow.deleteMany({ importBatch: batch._id });
    await batch.save();

    let pending = [];
    let pendingDetails = [];
    const flushDetails = async () => {
      await storeResultDocuments(pendingDetails);
      pendingDetails = [];
    };
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

    // Valores de la columna "sucursal" que no son ninguna sede dada de alta: se
    // guardan como etiqueta y se avisa al final, para que el usuario sepa con qué
    // nombre exacto ramificar en la automatización.
    const unresolvedClinicNames = new Set();

    await iterateRows(batch.filePath, batch.fileName, async (row, rowNo) => {
      batch.processedRows++;
      const mapped = mapRow(row, batch.mapping);
      if (!mapped.ok) {
        batch.failed++;
        pendingDetails.push(resultDocument(
          batch,
          { row: rowNo, contact: sourceSnapshot(row, batch.mapping), value: mapped.value || '' },
          'failed',
          mapped.reason
        ));
        if (pendingDetails.length >= BATCH_SIZE) await flushDetails();
        if (batch.rowErrors.length < MAX_STORED_ERRORS) {
          batch.rowErrors.push({ row: rowNo, value: mapped.value || '', reason: mapped.reason });
        }
        return;
      }
      // Resolver la sucursal de la fila (nombre → sede real). Sin coincidencia, se
      // deja sin `clinic` y buildOps usa la sucursal por defecto del asistente.
      //
      // Y si NO casa con ninguna sede, el valor se guarda como ETIQUETA en vez de
      // tirarse. Columnas como "AGENCIA" se auto-proponen como sucursal (la regla
      // de contactRowMapper incluye "agencia"), pero sus valores suelen ser
      // categorías del propio cliente —PRINCIPAL, EXTENSION— que no son sedes
      // dadas de alta. Antes ese dato desaparecía en silencio y la condición del
      // workflow que ramificaba por él no se cumplía nunca; ahora queda como
      // etiqueta del contacto, que es justo lo que las condiciones saben leer.
      if (mapped.contact.clinicName) {
        const resolved = resolveClinic(mapped.contact.clinicName);
        if (resolved) {
          mapped.contact.clinic = resolved;
        } else {
          mapped.contact.tags = [...(mapped.contact.tags || []), mapped.contact.clinicName];
          unresolvedClinicNames.add(mapped.contact.clinicName);
        }
        delete mapped.contact.clinicName;
      }
      // Defensa: si un mapeo legacy trae "sendTime", NO es un campo del contacto —
      // se descarta para no escribirlo en el documento (la hora de disparo ya no
      // sale de una columna, la decide el lote con sendMode/sendAt).
      if ('sendTime' in mapped.contact) delete mapped.contact.sendTime;
      if (seen.has(mapped.contact.phone)) {
        batch.skipped++; // repetido dentro del propio archivo
        pendingDetails.push(resultDocument(
          batch,
          { row: rowNo, contact: mapped.contact },
          'skipped',
          `Teléfono repetido dentro del archivo; su primera aparición está en la fila ${seen.get(mapped.contact.phone).row}.`
        ));
        if (pendingDetails.length >= BATCH_SIZE) await flushDetails();
        return;
      }
      seen.set(mapped.contact.phone, { clinic: String(mapped.contact.clinic || batch.clinic), row: rowNo });
      pending.push({ row: rowNo, contact: mapped.contact });
      if (pending.length >= BATCH_SIZE) await flush();
    });
    await flush();
    await flushDetails();

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

    // Se avisa AQUÍ (no antes) porque enrollInWorkflows reescribe enrollWarning
    // con sus propios avisos y borraría este.
    if (unresolvedClinicNames.size) {
      const nombres = [...unresolvedClinicNames].slice(0, 8).join(', ');
      batch.enrollWarning = [
        batch.enrollWarning || '',
        `La columna de sucursal traía valores que no son ninguna sede dada de alta (${nombres}). Se guardaron como ETIQUETA del contacto: para enviar un mensaje u otro según ese valor, usa en la automatización una condición «Etiqueta del paciente o contacto» con ese mismo texto.`,
      ].filter(Boolean).join(' ');
      await batch.save().catch(() => {});
      progress();
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
