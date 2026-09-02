#!/usr/bin/env node
/**
 * RELLENAR «POR QUÉ NÚMERO ENTRÓ CADA CHAT» — UNA SOLA VEZ, EN EL DESPLIEGUE.
 *
 * ─── POR QUÉ ───────────────────────────────────────────────────────────────────
 * `Conversation.lastInboundAccount` (el número de la clínica al que el contacto
 * escribió por última vez) lo escribe la ingesta desde ago-2026, pero nace vacío
 * en todo el histórico anterior. Mientras la respuesta salía SIEMPRE por el
 * número enlazado al chat, ese hueco no molestaba.
 *
 * Desde el 02-sep-2026 sí molesta. WhatsApp bloqueó «Recepcion 2» —el número por
 * el que había entrado la mayor parte de la bandeja— y ahora un número que no
 * puede enviar DESVÍA la respuesta al principal. En un chat sin este dato, la
 * ventana de 24 h se calcularía solo por la fecha del último entrante: el CRM
 * diría "abierta, te quedan 8 h" mientras el mensaje sale por un número al que
 * ese paciente nunca escribió, y Meta lo rechazaría con 131047. Es el incidente
 * del 08-ago-2026 (156 mensajes perdidos en una mañana) otra vez, pero provocado
 * por el desvío y sobre media bandeja.
 *
 * El código ya no depende SOLO de este campo (`messaging.inboundAccountRef` cae
 * al número enlazado del chat cuando falta), pero rellenarlo es lo que deja el
 * dato exacto para todos, incluidos los chats sin enlace.
 *
 * ─── QUÉ HACE ──────────────────────────────────────────────────────────────────
 * Por cada conversación de WhatsApp con algún entrante, copia el
 * `whatsappAccount` de su ÚLTIMO mensaje entrante. Idempotente: solo escribe las
 * que no lo tienen o lo tienen distinto. De UNA agregación, no de una consulta
 * por chat: son decenas de miles y contra una base remota eso serían horas.
 *
 * NUNCA borra nada ni toca ventanas: solo rellena un campo que estaba vacío.
 *
 * ─── "UNA SOLA VEZ" ────────────────────────────────────────────────────────────
 * La marca vive en la base (colección `onetimetasks`, clave TASK_KEY): el
 * despliegue lo ejecuta en cada push, pero solo el PRIMERO hace algo. Si falla
 * queda FAILED y el siguiente despliegue lo reintenta.
 *
 * ─── USO ───────────────────────────────────────────────────────────────────────
 *   node scripts/backfillLastInboundAccountOnce.js            (DRY-RUN: informa)
 *   node scripts/backfillLastInboundAccountOnce.js --commit   (aplica y deja marca)
 *   node scripts/backfillLastInboundAccountOnce.js --commit --force  (repite)
 *   node scripts/backfillLastInboundAccountOnce.js --estado   (solo la marca)
 */
const os = require('os');
const { connect, disconnect } = require('./_common');

const OneTimeTask = require('../models/OneTimeTask');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');

const TASK_KEY = 'backfill-last-inbound-account-2026-09-02';
const STALE_RUNNING_MS = 30 * 60 * 1000;

/** Rellena (o informa de) el número de entrada de cada chat. Sin `commit` no escribe. */
async function backfillInboundAccounts({ commit = false, log = console.log } = {}) {
  const convs = await Conversation.find({ channel: 'whatsapp', lastInboundAt: { $ne: null } })
    .select('_id lastInboundAccount')
    .lean();
  log(`   • Conversaciones de WhatsApp con algún entrante: ${convs.length}`);

  const ultimos = await Message.aggregate([
    { $match: { direction: 'in', whatsappAccount: { $ne: null } } },
    { $sort: { conversation: 1, createdAt: -1 } },
    { $group: { _id: '$conversation', cuenta: { $first: '$whatsappAccount' } } },
  ]).allowDiskUse(true);
  const porConv = new Map(ultimos.map((u) => [String(u._id), u.cuenta]));
  log(`   • Con el número anotado en algún entrante: ${porConv.size}`);

  let sinNumero = 0;
  const ops = [];
  for (const c of convs) {
    const cuenta = porConv.get(String(c._id));
    if (!cuenta) { sinNumero++; continue; }
    if (String(c.lastInboundAccount || '') === String(cuenta)) continue;
    ops.push({ updateOne: { filter: { _id: c._id }, update: { $set: { lastInboundAccount: cuenta } } } });
  }

  log(`   • A rellenar: ${ops.length}`);
  // Estos son los que quedan a ciegas: ni el chat ni sus mensajes dicen por qué
  // número entraron. Para ellos manda el enlace del chat (ver inboundAccountRef).
  log(`   • Sin número anotado en ningún entrante: ${sinNumero}`);

  const stats = { revisadas: convs.length, rellenadas: ops.length, sinNumero };
  if (!commit) {
    log(`\nDRY-RUN: se rellenarían ${ops.length} conversación(es). Usa --commit para aplicar.`);
    return { ...stats, dryRun: true };
  }
  let hechos = 0;
  // Por lotes: son decenas de miles y un bulkWrite gigante se come la memoria.
  for (let i = 0; i < ops.length; i += 1000) {
    // eslint-disable-next-line no-await-in-loop
    const r = await Conversation.bulkWrite(ops.slice(i, i + 1000));
    hechos += r.modifiedCount ?? 0;
  }
  log(`\n✅  ${hechos} conversación(es) con su número de entrada anotado.`);
  return { ...stats, rellenadas: hechos };
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
    const result = await backfillInboundAccounts({ commit: true, log });
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

  console.log('\n=== NÚMERO DE ENTRADA DE CADA CHAT (tarea de una sola vez) ===');
  console.log(`Clave de la tarea: ${key}`);
  console.log(commit ? 'MODO: COMMIT (rellena de verdad).' : 'MODO: DRY-RUN (solo informa). Usa --commit para aplicar.');
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
      await backfillInboundAccounts({ commit: false });
      return;
    }
    await runOnce({ key, force });
  } finally {
    await disconnect();
  }
}

module.exports = { backfillInboundAccounts, runOnce, TASK_KEY };

if (require.main === module) {
  main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}
