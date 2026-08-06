#!/usr/bin/env node
/**
 * REENCOLAR LAS INSCRIPCIONES QUE IBAN A DISPARARSE EN PLENO SILENCIO — UNA SOLA VEZ.
 *
 * ─── POR QUÉ ───────────────────────────────────────────────────────────────────────
 * Hasta ago-2026 la franja de una ventana horaria era el horario PERMITIDO. Nadie lo
 * entendió así: las 15 ventanas configuradas en producción decían `23:00–06:20` con la
 * intención de "no molestar de noche", y el motor hacía lo contrario — retenía los
 * mensajes todo el día para soltarlos a las 23:00 (2.061 mensajes de madrugada en 5 días).
 *
 * Invertir el significado arregla lo que venga de ahora en adelante, pero NO lo que ya
 * está encolado: cada inscripción retenida guarda su `nextRunAt` calculado con la regla
 * vieja, y 44 de ellas estaban apuntando exactamente a las 23:00. Sin esta tarea, la
 * primera noche tras el despliegue volverían a sonar todos los teléfonos.
 *
 * ─── QUÉ HACE ──────────────────────────────────────────────────────────────────────
 * Recorre las inscripciones en espera y, si su `nextRunAt` cae DENTRO de una franja de
 * silencio de su propio workflow (la del workflow o la de cualquier nodo "Ventana
 * horaria"), la ADELANTA al final de esa franja.
 *
 * Solo mueve fechas HACIA ADELANTE y nunca fuera de un silencio configurado: en el peor
 * caso un paso que no enviaba nada se ejecuta unas horas más tarde. No borra, no crea y
 * no toca ninguna inscripción cuyo horario ya fuera correcto.
 *
 * ─── "UNA SOLA VEZ" ────────────────────────────────────────────────────────────────
 * La marca vive en la base (colección `onetimetasks`, clave TASK_KEY): el despliegue la
 * ejecuta en cada push, pero solo el PRIMERO hace algo. Si falla queda FAILED y el
 * siguiente despliegue la reintenta.
 *
 * ─── USO ───────────────────────────────────────────────────────────────────────────
 *   node scripts/rescheduleQuietWindowsOnce.js             (DRY-RUN: solo informa)
 *   node scripts/rescheduleQuietWindowsOnce.js --commit    (aplica una vez y deja marca)
 *   node scripts/rescheduleQuietWindowsOnce.js --commit --force   (repite aunque esté DONE)
 *   node scripts/rescheduleQuietWindowsOnce.js --estado    (solo muestra la marca)
 */
const os = require('os');
const { connect, disconnect } = require('./_common');

const OneTimeTask = require('../models/OneTimeTask');
const Workflow = require('../models/Workflow');
const WorkflowEnrollment = require('../models/WorkflowEnrollment');
const { isWindowActive, isQuietTime, nextAllowedTime, describeWindow } = require('../utils/sendWindow');

const TASK_KEY = 'reencolar-ventanas-silencio-2026-08-06';
const STALE_RUNNING_MS = 30 * 60 * 1000;

/** Todas las franjas de silencio que puede aplicar un workflow (la suya y las de sus nodos). */
function windowsOfWorkflow(wf) {
  const wins = [];
  if (isWindowActive(wf.sendWindow)) wins.push(wf.sendWindow);
  for (const n of wf.nodes || []) {
    if (n.type !== 'window') continue;
    const w = { mode: 'specific', days: n.data?.windowDays, from: n.data?.windowFrom, to: n.data?.windowTo };
    if (isWindowActive(w)) wins.push(w);
  }
  return wins;
}

/**
 * Reencola las inscripciones cuya reanudación cae en un silencio.
 * Con `commit: false` no escribe nada: solo informa lo que movería.
 */
async function reschedule({ commit = false, log = console.log } = {}) {
  const workflows = await Workflow.find({}).select('_id name sendWindow nodes').lean();
  const winsById = new Map();
  for (const wf of workflows) {
    const wins = windowsOfWorkflow(wf);
    if (wins.length) winsById.set(String(wf._id), { name: wf.name, wins });
  }
  log(`   • Automatizaciones con ventana horaria: ${winsById.size} de ${workflows.length}`);
  if (!winsById.size) {
    log('\nNinguna automatización usa ventanas: nada que reencolar.');
    return { conVentana: 0, revisadas: 0, movidas: 0, porWorkflow: {} };
  }

  const pendientes = await WorkflowEnrollment.find({
    status: 'waiting',
    workflow: { $in: [...winsById.keys()] },
    nextRunAt: { $ne: null, $gt: new Date() },
  }).select('_id workflow nextRunAt currentNodeId').lean();
  log(`   • Inscripciones en espera con reanudación futura: ${pendientes.length}`);

  const porWorkflow = {};
  let movidas = 0;
  for (const enr of pendientes) {
    const info = winsById.get(String(enr.workflow));
    const cuando = new Date(enr.nextRunAt);
    // La primera franja que silencia ese instante manda. Se toman todas las del
    // workflow porque no se puede saber por cuál de sus nodos venía la inscripción;
    // en el peor caso se retrasa un paso que no enviaba nada.
    const win = info.wins.find((w) => isQuietTime(w, cuando));
    if (!win) continue;
    const nuevo = nextAllowedTime(win, cuando);
    if (!nuevo || nuevo.getTime() <= cuando.getTime()) continue; // silencio imposible: no tocar
    porWorkflow[info.name] = porWorkflow[info.name] || { n: 0, ventana: describeWindow(win), ejemplo: '' };
    porWorkflow[info.name].n += 1;
    if (!porWorkflow[info.name].ejemplo) {
      porWorkflow[info.name].ejemplo = `${cuando.toISOString()} → ${nuevo.toISOString()}`;
    }
    movidas += 1;
    if (commit) {
      // eslint-disable-next-line no-await-in-loop
      await WorkflowEnrollment.updateOne({ _id: enr._id }, { $set: { nextRunAt: nuevo } });
    }
  }

  for (const [name, d] of Object.entries(porWorkflow)) {
    log(`   ${commit ? '⏩' : '•'} "${name}" (silencio ${d.ventana}): ${d.n} inscripción(es). Ej.: ${d.ejemplo}`);
  }
  const stats = { conVentana: winsById.size, revisadas: pendientes.length, movidas, porWorkflow };
  if (!commit) {
    log('\nDRY-RUN: no se movió nada. Ejecuta con --commit para aplicar.');
    return { ...stats, dryRun: true };
  }
  log(movidas
    ? `\n✅  ${movidas} inscripción(es) reencoladas al final de su franja de silencio.`
    : '\nNinguna inscripción caía en un silencio: nada que mover.');
  return stats;
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
    const result = await reschedule({ commit: true, log });
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

  console.log('\n=== REENCOLAR INSCRIPCIONES EN HORARIO DE SILENCIO (tarea de una sola vez) ===');
  console.log(`Clave de la tarea: ${key}`);
  console.log(commit ? 'MODO: COMMIT (mueve las fechas de verdad).' : 'MODO: DRY-RUN (solo informa). Usa --commit para aplicar.');
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
      await reschedule({ commit: false });
      return;
    }
    await runOnce({ key, force });
  } finally {
    await disconnect();
  }
}

module.exports = { reschedule, runOnce, windowsOfWorkflow, TASK_KEY };

if (require.main === module) {
  main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}
