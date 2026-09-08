#!/usr/bin/env node
/**
 * QUITAR EL «PACIENTE NUEVO» A QUIEN NO LO ERA — UNA SOLA VEZ.
 *
 * ─── POR QUÉ ───────────────────────────────────────────────────────────────────────
 * `Appointment.isFirstVisit` se CONGELA al agendar: es una foto, no un cálculo que se
 * rehaga al pintar. Hasta el 4-sep-2026 esa foto se sacaba mirando solo si el paciente
 * tenía CITAS anteriores, y eso marcaba como nuevos justo a los que llevaban años
 * viniendo: los que se atendían en papel (sus fichas se subieron con la importación,
 * con la captura del PDF como seguimiento) y los migrados de Contífico, que nunca
 * habían pasado por la agenda.
 *
 * El cálculo ya está arreglado (`utils/firstVisit.js` mira historia clínica, ventas y
 * la marca del archivo físico, no solo las citas), pero las citas agendadas ANTES de
 * ese arreglo siguen con la foto vieja: salen con el distintivo «Nuevo» en la agenda,
 * en el detalle de la cita y en los reportes de pacientes nuevos, y las que todavía no
 * se han cobrado pagarían una comisión de captación (`CommissionRule.patientScope:
 * 'new'`) por un paciente de toda la vida.
 *
 * ─── QUÉ HACE ──────────────────────────────────────────────────────────────────────
 * Recorre las citas marcadas como primera visita y le hace a cada una la MISMA pregunta
 * que `tieneHistorialPrevio`: ¿hay rastro de que a ese paciente ya se le hubiera
 * atendido antes de esta cita? Cuenta como rastro:
 *
 *   · otra cita anterior —de cualquier sucursal—;
 *   · una consulta en su historia clínica con FECHA anterior al día de la cita;
 *   · una venta a su nombre anterior;
 *   · la marca del archivo físico (`scanImport.importadoAt`), sea cual sea su fecha.
 *
 * Si lo hay, la cita deja de estar marcada como primera visita.
 *
 * ─── SE MIRA LA FECHA CLÍNICA, NO CUÁNDO SE TECLEÓ ─────────────────────────────────
 * Ésta es la parte que hay que entender para no volver a equivocarla. Las fichas de
 * papel se importaron el 3-sep-2026, así que su `createdAt` es de ese día aunque la
 * consulta fuera de 2023. Comparar contra la fecha de tecleo dejaba fuera justo el caso
 * que se está arreglando: al paciente agendado el 1 de septiembre —dos días antes de
 * que su historia entrara al sistema— le habría dicho que en ese momento era nuevo.
 *
 * Por eso se compara con `followUps[].fecha` (el día de la consulta, que es lo que
 * decía el papel) y por eso el ARCHIVO FÍSICO cuenta siempre: que exista una ficha
 * escaneada significa que a esa persona se le atendía desde antes, y la fecha de la
 * importación no dice nada sobre cuándo fue la primera vez.
 *
 * ─── LO QUE NO CUENTA COMO PASADO (y es la parte delicada) ─────────────────────────
 * Los seguimientos que escribió LA PROPIA CITA no son historia previa. Son dos:
 *
 *   · el suero de serie del servicio (`autoSerumFollowUp`) y el que indica mostrador al
 *     repartir la atención (`turns[].serumFollowUp`), que se escriben en el MISMO
 *     segundo en que se crea la cita;
 *   · el que redactó quien la atendió (`turns[].followUp`).
 *
 * Se excluyen por su id, y además solo cuenta lo fechado en un día ANTERIOR al de la
 * cita: los dos casos de arriba se escriben con la fecha de hoy, que es la de la cita.
 * Sin esta cautela, TODA cita de un servicio con suero se contestaría a sí misma que el
 * paciente ya tenía historia y ningún paciente volvería a ser nuevo nunca.
 *
 * No toca ninguna cita en el sentido contrario: nunca marca como nueva a una que no lo
 * estaba. Solo quita marcas de más.
 *
 * ─── "UNA SOLA VEZ" ────────────────────────────────────────────────────────────────
 * La marca vive en la base (colección `onetimetasks`, clave TASK_KEY): el despliegue la
 * ejecuta en cada push, pero solo el PRIMERO hace algo. Si falla queda FAILED y el
 * siguiente despliegue la reintenta.
 *
 * ─── USO ───────────────────────────────────────────────────────────────────────────
 *   node scripts/fixFirstVisitOnce.js             (DRY-RUN: solo informa)
 *   node scripts/fixFirstVisitOnce.js --commit    (corrige una vez y deja marca)
 *   node scripts/fixFirstVisitOnce.js --commit --force   (repite aunque esté DONE)
 *   node scripts/fixFirstVisitOnce.js --estado    (solo muestra la marca)
 */
const os = require('os');
const { connect, disconnect } = require('./_common');

const OneTimeTask = require('../models/OneTimeTask');
const Appointment = require('../models/Appointment');
const ClinicalRecord = require('../models/ClinicalRecord');
const Patient = require('../models/Patient');
const Sale = require('../models/Sale');

const TASK_KEY = 'corregir-paciente-nuevo-2026-09-08';
const STALE_RUNNING_MS = 30 * 60 * 1000;

const id = (v) => (v ? String(v._id || v) : '');

/**
 * El DÍA de una fecha, en UTC y a medianoche.
 *
 * En UTC porque es como se guardan y se leen los días en este sistema: las citas a las
 * 12:00 locales y los seguimientos importados a medianoche UTC caen los dos en el día
 * correcto leídos así (mismo criterio que `fechaDocumento` en clinicalRecordController).
 */
const dia = (v) => {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return NaN;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

/** Los seguimientos que escribió ESTA cita: no son historia previa suya. */
function seguimientosDeLaCita(cita) {
  const ids = new Set();
  if (cita.autoSerumFollowUp) ids.add(String(cita.autoSerumFollowUp));
  for (const t of cita.turns || []) {
    if (t.followUp) ids.add(String(t.followUp));
    if (t.serumFollowUp) ids.add(String(t.serumFollowUp));
  }
  return ids;
}

/**
 * ¿Había rastro de este paciente ANTES de que se creara esta cita?
 * Devuelve la lista de motivos (vacía = de verdad era nuevo).
 */
async function rastrosPrevios(cita, { historias, pacientes }) {
  const diaDeLaCita = dia(cita.date);
  const motivos = [];

  const otraCita = await Appointment.exists({
    patient: cita.patient,
    _id: { $ne: cita._id },
    createdAt: { $lt: cita.createdAt },
  });
  if (otraCita) motivos.push('cita anterior');

  const propios = seguimientosDeLaCita(cita);
  const historia = historias.get(String(cita.patient));
  const previo = (historia || []).some((fu) => {
    if (propios.has(String(fu._id))) return false;
    // La FECHA de la consulta, no la de tecleo: las fichas de papel se
    // importaron en septiembre y lo que interesa es el día que dice el papel.
    const d = dia(fu.fecha || fu.createdAt);
    return !Number.isNaN(d) && d < diaDeLaCita;
  });
  if (previo) motivos.push('historia clínica');

  const venta = await Sale.exists({
    patient: cita.patient,
    // La fecha del comprobante y, en su defecto, la de creación: las ventas
    // migradas se crearon todas el día de la migración.
    $or: [{ date: { $lt: cita.date } }, { date: null, createdAt: { $lt: cita.createdAt } }],
  });
  if (venta) motivos.push('venta anterior');

  // El archivo físico cuenta SIEMPRE: que exista una ficha escaneada significa
  // que a esa persona se le atendía desde antes de tener nada en el sistema, y
  // la fecha de la importación no dice cuándo fue la primera vez.
  if (pacientes.has(String(cita.patient))) motivos.push('ficha física escaneada');

  return motivos;
}

/** Corrige (o informa de) las citas mal marcadas. Con `commit: false` no escribe. */
async function fixFirstVisit({ commit = false, log = console.log } = {}) {
  const citas = await Appointment.find({ isFirstVisit: true })
    .select('_id patient date createdAt status turns autoSerumFollowUp')
    .lean();
  log(`   • Citas marcadas como «paciente nuevo»: ${citas.length}`);
  if (!citas.length) return { revisadas: 0, corregidas: 0, porMotivo: {} };

  // Se piden de golpe los dos datos que hacen falta por paciente, en vez de una
  // consulta por cita: son miles de citas y el M0 no está para ese paseo.
  const pacienteIds = [...new Set(citas.map((c) => String(c.patient)).filter(Boolean))];

  const historias = new Map();
  for (const rec of await ClinicalRecord.find({ patient: { $in: pacienteIds } })
    .select('patient followUps._id followUps.fecha followUps.createdAt')
    .lean()) {
    // Un paciente puede tener más de una ficha si alguna quedó suelta: se suman.
    const clave = String(rec.patient);
    historias.set(clave, [...(historias.get(clave) || []), ...(rec.followUps || [])]);
  }

  const pacientes = new Map();
  for (const p of await Patient.find({ _id: { $in: pacienteIds }, 'scanImport.importadoAt': { $ne: null } })
    .select('scanImport.importadoAt')
    .lean()) {
    pacientes.set(String(p._id), p.scanImport.importadoAt);
  }

  const porMotivo = {};
  const ejemplos = [];
  const aCorregir = [];

  for (const cita of citas) {
    // eslint-disable-next-line no-await-in-loop
    const motivos = await rastrosPrevios(cita, { historias, pacientes });
    if (!motivos.length) continue;
    aCorregir.push(cita._id);
    for (const m of motivos) porMotivo[m] = (porMotivo[m] || 0) + 1;
    if (ejemplos.length < 15) {
      ejemplos.push(
        `${new Date(cita.date).toISOString().slice(0, 10)} · paciente ${id(cita.patient)} · ${motivos.join(', ')}`
      );
    }
  }

  for (const e of ejemplos) log(`   ${commit ? '🧹' : '•'} ${e}`);
  if (aCorregir.length > ejemplos.length) log(`   … y ${aCorregir.length - ejemplos.length} más.`);

  if (!commit) {
    log(`\nDRY-RUN: se quitaría la marca de «paciente nuevo» a ${aCorregir.length} cita(s).`);
    log('Ejecuta con --commit para aplicar.');
    return { revisadas: citas.length, corregidas: aCorregir.length, porMotivo, dryRun: true };
  }

  if (aCorregir.length) {
    await Appointment.updateMany({ _id: { $in: aCorregir } }, { $set: { isFirstVisit: false } });
  }
  log(`\n✅  ${aCorregir.length} cita(s) dejaron de contar como «paciente nuevo».`);
  return { revisadas: citas.length, corregidas: aCorregir.length, porMotivo };
}

/** Envoltorio "una sola vez": reclama la marca de forma atómica y deja constancia. */
async function runOnce({ key = TASK_KEY, force = false, log = console.log } = {}) {
  const previa = await OneTimeTask.findById(key).lean();
  if (previa && !force) {
    if (previa.status === 'DONE') {
      log(`⏭️  Tarea "${key}" ya ejecutada el ${previa.finishedAt?.toISOString?.() || '—'}: no se hace nada.`);
      return { skipped: true, status: 'DONE' };
    }
    if (previa.status === 'RUNNING' && Date.now() - new Date(previa.startedAt).getTime() < STALE_RUNNING_MS) {
      log(`⏭️  Tarea "${key}" en ejecución por ${previa.host} (pid ${previa.pid}): no se hace nada.`);
      return { skipped: true, status: 'RUNNING' };
    }
    log(`↻  Intento anterior de "${key}" quedó en ${previa.status}: se reintenta.`);
  }

  const marca = {
    status: 'RUNNING', host: os.hostname(), pid: process.pid, startedAt: new Date(),
    finishedAt: null, error: '', result: null,
  };
  if (previa) {
    await OneTimeTask.updateOne({ _id: key }, { $set: marca, $inc: { attempts: 1 } });
  } else {
    try {
      await OneTimeTask.create({ _id: key, ...marca, attempts: 1 });
    } catch (e) {
      if (e.code === 11000) {
        log(`⏭️  Otro proceso reclamó "${key}" primero: no se hace nada.`);
        return { skipped: true, status: 'RUNNING' };
      }
      throw e;
    }
  }

  try {
    const result = await fixFirstVisit({ commit: true, log });
    await OneTimeTask.updateOne({ _id: key }, { $set: { status: 'DONE', finishedAt: new Date(), result } });
    log(`🔒  Marca "${key}" = DONE: no volverá a ejecutarse en los próximos despliegues.`);
    return { skipped: false, status: 'DONE', result };
  } catch (e) {
    await OneTimeTask.updateOne({ _id: key }, { $set: { status: 'FAILED', finishedAt: new Date(), error: e.message } });
    throw e;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const commit = args.includes('--commit');
  const force = args.includes('--force');
  const soloEstado = args.includes('--estado');
  const key = (args.find((a) => a.startsWith('--key=')) || '').split('=')[1] || TASK_KEY;

  console.log('\n=== CORREGIR «PACIENTE NUEVO» (tarea de una sola vez) ===');
  console.log(`Clave de la tarea: ${key}`);
  console.log(commit ? 'MODO: COMMIT (corrige las citas de verdad).' : 'MODO: DRY-RUN (solo informa). Usa --commit para aplicar.');
  console.log('');

  await connect();
  try {
    const previa = await OneTimeTask.findById(key).lean();
    if (soloEstado) {
      console.log(previa
        ? `Estado: ${previa.status} · intentos: ${previa.attempts} · host: ${previa.host} · fin: ${previa.finishedAt || '—'}`
        : 'Estado: sin marca (nunca se ejecutó).');
      return;
    }
    if (!commit) {
      if (previa) console.log(`(Marca existente: ${previa.status}. Con --commit ${previa.status === 'DONE' && !force ? 'NO' : 'SÍ'} se ejecutaría.)\n`);
      await fixFirstVisit({ commit: false });
      return;
    }
    await runOnce({ key, force });
  } finally {
    await disconnect();
  }
}

module.exports = { fixFirstVisit, runOnce, TASK_KEY };

if (require.main === module) {
  main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}
