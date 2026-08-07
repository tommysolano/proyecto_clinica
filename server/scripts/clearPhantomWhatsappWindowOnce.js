#!/usr/bin/env node
/**
 * BORRAR LAS VENTANAS DE 24 H FANTASMA — UNA SOLA VEZ.
 *
 * ─── POR QUÉ ───────────────────────────────────────────────────────────────────────
 * La ventana de 24 h de WhatsApp solo la abre un mensaje ENTRANTE del contacto. Pero
 * `Conversation` nacía con `lastMessageDirection:'in'` y `lastMessageAt:ahora` por
 * defecto, así que un chat creado por un envío NUESTRO (un workflow escribiéndole a
 * alguien que nunca nos ha escrito) parecía tener un entrante recién llegado. El
 * respaldo "si el último mensaje fue entrante, la ventana sale de él" se lo creía y
 * el envío GUARDABA esa ventana inventada en `window24hExpiresAt`.
 *
 * Resultado en producción: 76 chats con una ventana que Meta no reconoce. El agente
 * veía "Ventana de 24h abierta: te quedan 7 h", escribía, y Meta rechazaba el mensaje
 * con el error 131047 ("Re-engagement message") — el paciente NUNCA lo recibía.
 * Fueron 20 mensajes perdidos en 30 días.
 *
 * El código ya no inventa ventanas (ver `getWhatsappWindowExpiresAt` en
 * utils/messaging.js), pero las que quedaron GUARDADAS siguen mintiendo hasta que
 * caduquen solas. Esta tarea las borra.
 *
 * ─── QUÉ HACE ──────────────────────────────────────────────────────────────────────
 * Recorre las conversaciones de WhatsApp con `window24hExpiresAt` y sin `lastInboundAt`:
 *   · Si tienen algún mensaje ENTRANTE real → CURA: pone `lastInboundAt` con la fecha
 *     de ese mensaje y recalcula la ventana (la conversación era legítima, solo le
 *     faltaba el campo).
 *   · Si no tienen ninguno → FANTASMA: borra `window24hExpiresAt`. El chat pasa a
 *     mostrar "este contacto todavía no te ha escrito" y el compositor exige plantilla,
 *     que es la verdad.
 *
 * Nunca borra mensajes ni conversaciones, y jamás alarga una ventana: solo quita las
 * que no existen o rellena la fecha del entrante que ya estaba en la base.
 *
 * ─── "UNA SOLA VEZ" ────────────────────────────────────────────────────────────────
 * La marca vive en la base (colección `onetimetasks`, clave TASK_KEY): el despliegue la
 * ejecuta en cada push, pero solo el PRIMERO hace algo. Si falla queda FAILED y el
 * siguiente despliegue la reintenta.
 *
 * ─── USO ───────────────────────────────────────────────────────────────────────────
 *   node scripts/clearPhantomWhatsappWindowOnce.js             (DRY-RUN: solo informa)
 *   node scripts/clearPhantomWhatsappWindowOnce.js --commit    (aplica una vez y deja marca)
 *   node scripts/clearPhantomWhatsappWindowOnce.js --commit --force   (repite aunque esté DONE)
 *   node scripts/clearPhantomWhatsappWindowOnce.js --estado    (solo muestra la marca)
 */
const os = require('os');
const { connect, disconnect } = require('./_common');

const OneTimeTask = require('../models/OneTimeTask');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');

const TASK_KEY = 'limpiar-ventana-24h-fantasma-2026-08-07';
const STALE_RUNNING_MS = 30 * 60 * 1000;
const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Limpia (o informa de) las ventanas guardadas que no vienen de un entrante real.
 * Con `commit: false` no escribe nada.
 */
async function clearPhantomWindows({ commit = false, log = console.log } = {}) {
  const sospechosas = await Conversation.find({
    channel: 'whatsapp',
    lastInboundAt: null,
    window24hExpiresAt: { $ne: null },
  })
    .select('_id phone contactName window24hExpiresAt')
    .lean();
  log(`   • Conversaciones con ventana guardada y sin fecha de entrante: ${sospechosas.length}`);

  const ahora = Date.now();
  let fantasmas = 0;
  let curadas = 0;
  let abiertasAhora = 0;
  const ejemplos = [];

  for (const c of sospechosas) {
    // eslint-disable-next-line no-await-in-loop
    const ultimoEntrante = await Message.findOne({ conversation: c._id, direction: 'in' })
      .sort({ createdAt: -1 })
      .select('createdAt')
      .lean();

    if (ultimoEntrante) {
      // Conversación legítima a la que solo le faltaba `lastInboundAt`: se rellena y
      // la ventana pasa a salir del entrante de verdad, sea más corta o más larga que
      // la guardada. Manda el mensaje del contacto, que es lo que Meta cuenta.
      curadas += 1;
      const inboundAt = new Date(ultimoEntrante.createdAt);
      if (commit) {
        // eslint-disable-next-line no-await-in-loop
        await Conversation.updateOne(
          { _id: c._id },
          { $set: { lastInboundAt: inboundAt, window24hExpiresAt: new Date(inboundAt.getTime() + WINDOW_MS) } }
        );
      }
      continue;
    }

    fantasmas += 1;
    if (new Date(c.window24hExpiresAt).getTime() > ahora) abiertasAhora += 1;
    if (ejemplos.length < 10) {
      ejemplos.push(`${c.phone}${c.contactName ? ` (${c.contactName})` : ''} → decía abierta hasta ${new Date(c.window24hExpiresAt).toISOString()}`);
    }
    if (commit) {
      // eslint-disable-next-line no-await-in-loop
      await Conversation.updateOne({ _id: c._id }, { $set: { window24hExpiresAt: null } });
    }
  }

  for (const e of ejemplos) log(`   ${commit ? '🧹' : '•'} ${e}`);
  if (fantasmas > ejemplos.length) log(`   … y ${fantasmas - ejemplos.length} más.`);

  const stats = { revisadas: sospechosas.length, fantasmas, curadas, abiertasAhora };
  if (!commit) {
    log(`\nDRY-RUN: se borrarían ${fantasmas} ventanas fantasma (${abiertasAhora} de ellas seguían "abiertas" ahora mismo)`
      + `${curadas ? ` y se curarían ${curadas} conversaciones con entrante real` : ''}.`);
    log('Ejecuta con --commit para aplicar.');
    return { ...stats, dryRun: true };
  }
  log(`\n✅  ${fantasmas} ventana(s) fantasma borradas${curadas ? ` · ${curadas} conversación(es) curadas con su entrante real` : ''}.`);
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
    const result = await clearPhantomWindows({ commit: true, log });
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

  console.log('\n=== BORRAR VENTANAS DE 24 H FANTASMA (tarea de una sola vez) ===');
  console.log(`Clave de la tarea: ${key}`);
  console.log(commit ? 'MODO: COMMIT (borra las ventanas de verdad).' : 'MODO: DRY-RUN (solo informa). Usa --commit para aplicar.');
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
      await clearPhantomWindows({ commit: false });
      return;
    }
    await runOnce({ key, force });
  } finally {
    await disconnect();
  }
}

module.exports = { clearPhantomWindows, runOnce, TASK_KEY };

if (require.main === module) {
  main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}
