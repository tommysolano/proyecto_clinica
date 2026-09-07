/**
 * ENVÍO MASIVO A LAS CITAS DE LA AGENDA (recordatorios).
 *
 * Es el gemelo de `contactImportRunner.enrollInWorkflows`, pero la audiencia no
 * sale de un Excel: son citas que ya están en el sistema. Por eso la inscripción
 * se hace sobre el PACIENTE y lleva `context.appointmentId`, y eso trae gratis
 * tres cosas que el Excel nunca tuvo:
 *
 *  1. Las variables de la plantilla ({{fecha}}, {{hora}}, {{servicio}},
 *     {{doctor}}, {{sede}}) salen de la CITA REAL — ver messaging.js. Nadie
 *     escribe la hora a mano, así que nadie la escribe mal.
 *  2. Si la cita se REAGENDA después de encolar el envío, el motor mueve la
 *     espera (syncEnrollmentsForAppointment).
 *  3. Si la cita se CANCELA, el envío se anula (cancelWaitingEnrollmentsForAppointment).
 *
 * Corre en un job y no dentro de la petición HTTP: con la latencia real contra la
 * base (~120 ms por consulta) un envío de 300 citas se comería el minuto que
 * nginx da de margen y quedaría a medias sin saber por dónde iba.
 */
const AppointmentBlast = require('../models/AppointmentBlast');
const Appointment = require('../models/Appointment');
const { emitToCallCenter } = require('../realtime');
const { appointmentDateTime } = require('./appointmentDate');
// Fuente única: la hora "HH:MM" y el "hoy si no ha pasado, mañana si ya pasó" son
// exactamente los mismos que en la importación de contactos.
const { nextOccurrenceOfLocalTime, flowSendHour } = require('./contactImportRunner');

const HHMM_RE = /^\d{1,2}:\d{2}$/;
const DEFAULT_DRIP_SECONDS = 20;
// Ventana en la que dos envíos al MISMO flujo se consideran el mismo botón
// apretado dos veces (y no una tanda nueva). Mismo criterio que la importación.
const REENROLL_GUARD_MS = 30 * 60 * 1000;
// Tope de seguridad: una tanda es "las citas de mañana", no la agenda del año.
const MAX_APPOINTMENTS = 5000;

/** ¿A este paciente se le puede escribir? (baja de marketing / sin consentimiento) */
const enviable = (p) => p?.marketing?.whatsappOptIn !== false && !p?.marketing?.optOutAt;

/** dripSeconds válido y acotado (1s … 1h). */
function dripOf(blast) {
  return Math.min(3600, Math.max(1, Number(blast?.dripSeconds) || DEFAULT_DRIP_SECONDS));
}

/** Teléfono de WhatsApp del paciente (el mismo orden que usa el motor). */
const phoneOf = (patient) => String(patient?.whatsapp || patient?.phone || '').trim();

/**
 * Inscribe las citas del lote en los flujos elegidos, ESCALONADAS (goteo).
 *
 * Igual que en la importación, la inscripción nace en 'waiting' con `nextRunAt`
 * futuro y NO en 'active': el job de recuperación reintenta cualquier 'active'
 * parada más de 5 min aunque su `nextRunAt` sea futuro, y dispararía toda la
 * tanda de golpe — justo la ráfaga que el goteo evita.
 */
async function enrollAppointments(blast) {
  const Workflow = require('../models/Workflow');
  const WorkflowEnrollment = require('../models/WorkflowEnrollment');
  const { matchingFlows } = require('./workflowEngine');

  const ids = (blast.appointments || []).slice(0, MAX_APPOINTMENTS);
  blast.total = ids.length;
  if (!ids.length || !blast.workflows?.length) return;

  const workflows = await Workflow.find({ _id: { $in: blast.workflows }, clinic: blast.clinic, active: true });

  // Hora de arranque de la tanda. Se resuelve POR FLUJO, porque en modo 'flow'
  // cada uno trae la suya configurada en su disparador.
  const sendMode = ['now', 'at', 'flow'].includes(blast.sendMode) ? blast.sendMode : 'now';
  const sendAt = HHMM_RE.test(blast.sendAt || '') ? blast.sendAt : '';
  const hourForWorkflow = (wf) => {
    if (sendMode === 'at') return sendAt;
    if (sendMode === 'flow') return flowSendHour(wf, 'appointment_bulk');
    return ''; // 'now'
  };

  // UN SOLO ARRANQUE POR FLUJO, por lo mismo que en la importación: el editor
  // permite dos disparadores "Citas de la agenda" en el mismo diagrama, y con
  // plantillas eso serían dos mensajes al mismo paciente y dos cobros de Meta.
  const avisos = [];
  const perWorkflow = workflows
    .map((wf) => {
      const flows = matchingFlows(wf, (tr) => tr?.type === 'appointment_bulk');
      if (flows.length > 1) {
        avisos.push(
          `La automatización "${wf.name}" tiene ${flows.length} disparadores "Citas de la agenda": se usó solo el primero para no enviar el mensaje ${flows.length} veces. Deja uno solo en el editor.`
        );
      }
      return { wf, flows: flows.slice(0, 1), hour: hourForWorkflow(wf) };
    })
    .filter((x) => x.flows.length);
  if (!perWorkflow.length) {
    blast.warning =
      'Ninguna de las automatizaciones elegidas tiene el disparador "Citas de la agenda" con pasos conectados: no se inscribió a nadie.';
    return;
  }

  // Lo que quedó a medias de la tanda anterior de estos mismos flujos. Sin esto,
  // el recordatorio de AYER sigue soltándose hoy y se mezcla con el de hoy: el
  // paciente recibe la fecha equivocada. Solo se anula lo que aún no ha salido.
  if (blast.cancelPending) {
    const r = await WorkflowEnrollment.updateMany(
      {
        workflow: { $in: perWorkflow.map((x) => x.wf._id) },
        status: { $in: ['active', 'waiting'] },
        'context.eventType': 'appointment_bulk',
        'context.blastId': { $ne: String(blast._id) },
      },
      { $set: { status: 'cancelled', nextRunAt: null } }
    );
    blast.cancelledPending = r.modifiedCount || 0;
  }

  // Las citas EN ORDEN DE AGENDA: el goteo sale en el mismo orden en que se
  // atienden, así que el de las 08:00 recibe su recordatorio antes que el de las
  // 18:00 si la tanda se corta a medias.
  const citas = await Appointment.find({ _id: { $in: ids } })
    .populate('patient', 'firstName lastName phone whatsapp marketing')
    .select('_id clinic date startTime patient status')
    .sort({ date: 1, startTime: 1 })
    .lean();

  // Programación del arranque (goteo).
  const drip = dripOf(blast);
  const startNow = new Date();
  let immediateSlot = new Date(startNow.getTime() - drip * 1000); // el 1.º = ahora
  const hourCursor = new Map(); // "HH:MM" -> siguiente hueco libre
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

  // UN MENSAJE POR NÚMERO Y POR FLUJO. Un paciente puede tener dos citas el mismo
  // día (la consulta y el suero de enfermería, una serie de detox): son dos citas
  // de verdad, pero el recordatorio lo recibe una persona, y recibir dos seguidos
  // se lee como un error del sistema. Se queda la PRIMERA de la agenda, que es la
  // que marca a qué hora tiene que salir de casa.
  const phonesPorFlujo = new Map(perWorkflow.map((x) => [String(x.wf._id), new Set()]));
  let mismoPaciente = 0;
  // Contador en memoria del `stats.enrolled` de cada flujo. Se suma de una sola
  // vez al final y no cita a cita: cada viaje a la base cuesta ~120 ms, y en una
  // tanda de 300 citas eso era medio minuto tirado en un contador.
  const creadasPorFlujo = new Map();

  // LATIDO. Dos motivos, y el segundo es el que muerde:
  //  · la pantalla ve avanzar el envío en vez de un "En cola" de veinte minutos;
  //  · `processPendingBlasts` da por MUERTO un lote 'running' que lleva 5 min sin
  //    tocarse, y una tanda grande tarda mucho más que eso (cada cita son dos
  //    viajes a la base). Sin guardar por el camino, el rescate lo devolvía a
  //    'pending' mientras seguía corriendo y arrancaba una segunda pasada encima.
  let desdeElUltimoLatido = 0;
  const latido = async () => {
    desdeElUltimoLatido = 0;
    await blast.save().catch(() => {});
    emitProgress(blast);
  };

  for (const apt of citas) {
    if (++desdeElUltimoLatido >= 50) await latido(); // eslint-disable-line no-await-in-loop
    const patient = apt.patient;
    if (!patient?._id) { blast.skippedNoPatient++; continue; }
    if (!enviable(patient)) { blast.skippedOptOut++; continue; }
    const phone = phoneOf(patient);
    if (!phone) { blast.skippedNoPhone++; continue; }

    for (const { wf, flows, hour } of perWorkflow) {
      const yaEsteNumero = phonesPorFlujo.get(String(wf._id));
      if (yaEsteNumero.has(phone)) { mismoPaciente++; blast.skippedDuplicate++; continue; }

      for (const flow of flows) {
        // EL CANDADO.
        // Se mira por CITA (no por paciente): otra cita del mismo paciente en otra
        // fecha es otro recordatorio legítimo. Y cuenta cualquier inscripción de
        // ESTE flujo para esa cita, incluida la que dejó el disparador automático
        // "Cita agendada": si el recordatorio automático ya está en cola, mandarlo
        // otra vez a mano es cobrar dos veces el mismo mensaje.
        //   - misma tanda         -> nunca dos veces, pase lo que pase (reintentos);
        //   - otra tanda reciente -> es el botón apretado dos veces, no una campaña nueva.
        // eslint-disable-next-line no-await-in-loop
        const dup = await WorkflowEnrollment.findOne({
          workflow: wf._id,
          'context.appointmentId': String(apt._id),
          $or: [
            { 'context.blastId': String(blast._id) },
            {
              status: { $in: ['active', 'waiting'] },
              createdAt: { $gte: new Date(Date.now() - REENROLL_GUARD_MS) },
            },
          ],
        }).select('_id');
        if (dup) { blast.skippedDuplicate++; continue; }

        const slot = scheduleStart(hour);
        // eslint-disable-next-line no-await-in-loop
        await WorkflowEnrollment.create({
          // La inscripción vive en la clínica ancla del CRM (donde están los
          // workflows y los chats); la SUCURSAL DE LA CITA viaja en el contexto
          // para poder bifurcar por sede (nodo Dividir / condición clinic).
          clinic: blast.clinic,
          workflow: wf._id,
          patient: patient._id,
          stepIndex: 0,
          currentNodeId: flow.currentNodeId,
          startNodeId: flow.startNodeId,
          status: 'waiting',
          nextRunAt: slot,
          context: {
            phone,
            eventType: 'appointment_bulk',
            blastId: String(blast._id),
            // Lo que hace que este envío sepa de qué cita habla: las variables de
            // la plantilla, los reagendamientos y las cancelaciones cuelgan de aquí.
            appointmentId: String(apt._id),
            appointmentDate: appointmentDateTime(apt.date, apt.startTime),
            eventClinicId: String(apt.clinic || blast.clinic),
            // Número FIJADO en el asistente. Vacío = automático: cada paciente lo
            // recibe por el número con el que él escribió la última vez. Viaja aquí
            // porque el envío ocurre horas después.
            ...(blast.whatsappAccount ? { whatsappAccountId: String(blast.whatsappAccount) } : {}),
          },
        });
        blast.enrolled++;
        yaEsteNumero.add(phone);
        creadasPorFlujo.set(String(wf._id), (creadasPorFlujo.get(String(wf._id)) || 0) + 1);
      }
    }
  }

  for (const [wfId, n] of creadasPorFlujo) {
    // eslint-disable-next-line no-await-in-loop
    await Workflow.updateOne({ _id: wfId }, { $inc: { 'stats.enrolled': n } }).catch(() => {});
  }

  // A ESTOS NO LES LLEGA NADA, y hay que decirlo. Un envío que se declara
  // "correcto" mientras media lista se queda fuera en silencio es exactamente lo
  // que hizo falta arreglar en la importación de contactos.
  if (mismoPaciente) {
    avisos.push(
      `${mismoPaciente} cita(s) eran del mismo paciente que otra de la tanda: se envió UN solo recordatorio por número (el de su primera cita del día).`
    );
  }
  if (blast.skippedNoPhone) {
    avisos.push(`${blast.skippedNoPhone} cita(s) no recibirán nada: el paciente no tiene teléfono en su ficha.`);
  }
  if (blast.skippedOptOut) {
    avisos.push(`${blast.skippedOptOut} cita(s) no recibirán nada: el paciente está dado de baja de los mensajes.`);
  }
  blast.warning = avisos.join(' ');
}

/** Emite el progreso a la bandeja del call center (la pantalla se refresca sola). */
function emitProgress(blast) {
  emitToCallCenter('appointmentBlast:progress', {
    blastId: String(blast._id),
    status: blast.status,
    total: blast.total,
    enrolled: blast.enrolled,
  });
}

/**
 * Procesa un lote. Lo toma con un reclamo ATÓMICO (pending -> running): el job de
 * cada minuto y el disparo inmediato de la petición HTTP compiten por él, y sin
 * reclamo los dos lo procesarían y cada paciente recibiría dos mensajes.
 */
async function runBlast(blastId) {
  const blast = await AppointmentBlast.findOneAndUpdate(
    { _id: blastId, status: 'pending' },
    { $set: { status: 'running', startedAt: new Date() } },
    { new: true }
  );
  if (!blast) return null; // ya lo cogió otro tick del job

  // Reprocesar el mismo lote (rescate tras un reinicio) no debe sumar dos veces:
  // los contadores se reinician y el candado anti-duplicado evita reinscribir.
  blast.enrolled = 0;
  blast.skippedDuplicate = 0;
  blast.skippedNoPhone = 0;
  blast.skippedOptOut = 0;
  blast.skippedNoPatient = 0;
  blast.cancelledPending = 0;
  blast.warning = '';

  try {
    await enrollAppointments(blast);
    blast.status = 'done';
  } catch (err) {
    blast.status = 'failed';
    blast.errorMessage = err.message;
    console.error('[appointmentBlast]', blastId, err.message);
  }
  blast.finishedAt = new Date();
  await blast.save();
  emitProgress(blast);
  return blast;
}

/** Job: lotes pendientes (y rescate de los que se quedaron a medias). */
async function processPendingBlasts() {
  // Un lote 'running' que lleva 5 min sin tocarse murió con un deploy o un
  // reinicio. Reprocesarlo es seguro: el candado anti-duplicado es por cita.
  await AppointmentBlast.updateMany(
    { status: 'running', updatedAt: { $lte: new Date(Date.now() - 5 * 60 * 1000) } },
    { $set: { status: 'pending' } }
  ).catch(() => {});

  const pending = await AppointmentBlast.find({ status: 'pending' })
    .select('_id')
    .sort({ createdAt: 1 })
    .limit(3);
  for (const p of pending) {
    // eslint-disable-next-line no-await-in-loop
    await runBlast(p._id).catch((e) => console.error('[appointmentBlast]', e.message));
  }
}

module.exports = { runBlast, processPendingBlasts, enrollAppointments, MAX_APPOINTMENTS };
