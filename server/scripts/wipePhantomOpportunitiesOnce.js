#!/usr/bin/env node
/**
 * BORRADO DE LAS OPORTUNIDADES FANTASMA — TAREA DE UNA SOLA VEZ.
 *
 * ─── QUÉ ES UNA OPORTUNIDAD FANTASMA ───────────────────────────────────────────────
 * Hasta ago-2026, ABRIR UN CHAT creaba una oportunidad. Cuando un mensaje llegaba desde
 * un anuncio (click-to-WhatsApp), la ingesta metía sola una oportunidad EN BLANCO —sin
 * nombre, sin servicios, sin valor, etapa 'nuevo'— con la atribución del anuncio, a la
 * espera de que la automatización de ese anuncio la rellenara. Casi nunca se rellenaba:
 * el chat no entraba en ninguna automatización, o entraba en una que no crea oportunidad.
 *
 * Resultado: el embudo se llenó de oportunidades «Sin nombre» que nadie sabe de qué son.
 * Inflaban el total de oportunidades creadas, la gráfica "Qué oportunidades son" las
 * enseñaba como la barra más alta y el conteo por etapa no cuadraba con la realidad.
 *
 * La ingesta YA NO las crea (ver chatController, "abrir un chat NO crea una oportunidad").
 * Este script limpia las que quedaron en la base.
 *
 * ─── SE BORRA ──────────────────────────────────────────────────────────────────────
 * Solo las oportunidades que están VACÍAS (sin nombre, sin servicios de interés, sin
 * valor, sin cita, sin etiquetas, sin motivo de pérdida y sin fecha de conversión) Y
 * ADEMÁS llevan la firma de haberlas creado el sistema:
 *   · nota "Desde anuncio: …" / "Desde anuncio (click-to-WhatsApp)"  → el hueco del anuncio
 *   · atribución de anuncio + etapa 'nuevo' + sin nota               → el mismo hueco, sin nota
 *   · nota "Creada automáticamente por flujo …"                      → AutoMessage / MessageFlow
 *     (los dos motores legacy, ya desconectados del frontend)
 *
 * ─── NO SE TOCA (a propósito) ──────────────────────────────────────────────────────
 *   · Cualquier oportunidad con nombre, servicios, valor, cita, etiquetas o motivo de
 *     pérdida: alguien la trabajó, da igual quién la creara.
 *   · Las que creó una AUTOMATIZACIÓN (paso "Crear oportunidad"): siempre llevan nombre.
 *   · Las vacías SIN firma del sistema. Pueden venir del nodo "Mover etapa" de una
 *     automatización o del alta manual desde el panel del chat, y no hay forma de
 *     distinguirlas de un hueco del sistema. Se conservan y el informe las cuenta aparte
 *     para que se decida a mano.
 *   · La CONVERSACIÓN nunca se borra, ni sus mensajes, ni su atribución de anuncio
 *     (`conv.attribution`): el desglose "de qué anuncio vino cada chat" cuenta chats, no
 *     oportunidades, así que sigue igual de completo después de la limpieza.
 *
 * ─── "UNA SOLA VEZ" ────────────────────────────────────────────────────────────────
 * La marca vive en la base (colección `onetimetasks`, clave TASK_KEY), no en disco: el
 * despliegue lo ejecuta en cada push, pero solo el PRIMERO hace algo. Si falla a medias
 * queda FAILED y el siguiente despliegue lo reintenta (es idempotente: lo ya borrado no
 * vuelve a aparecer). Una vez DONE no corre nunca más.
 *
 * `--sin-marca` limpia AHORA sin gastar la marca. Sirve para el caso en que se quiera
 * dejar el embudo limpio antes de desplegar el arreglo que corta la fuente: mientras el
 * VPS siga con el código viejo, cada chat de anuncio nuevo crea otro hueco. Se limpia hoy
 * con `--sin-marca` y el despliegue vuelve a pasar la escoba (esta vez sí, marcada) sobre
 * los que se hayan colado entremedias.
 *
 * ─── SE PUEDE DESHACER ─────────────────────────────────────────────────────────────
 * Antes de quitar nada, cada oportunidad borrada se copia entera a la colección
 * `oportunidades_fantasma_backup` junto con el id de su conversación. El clúster es un
 * Atlas M0 y **no tiene copias de seguridad**, así que sin este respaldo el borrado sería
 * irreversible. Para devolverlas a su sitio:
 *
 *   node scripts/wipePhantomOpportunitiesOnce.js --restaurar --commit
 *
 * La restauración vuelve a insertar cada oportunidad en su chat (sin duplicar: si ya
 * está, la salta) y recalcula el espejo legacy. Cuando se tenga claro que no hace falta,
 * la colección de respaldo se puede tirar a mano desde Atlas.
 *
 * ─── USO ───────────────────────────────────────────────────────────────────────────
 *   node scripts/wipePhantomOpportunitiesOnce.js                 (DRY-RUN: informe, no escribe)
 *   node scripts/wipePhantomOpportunitiesOnce.js --commit        (BORRA una vez y deja la marca)
 *   node scripts/wipePhantomOpportunitiesOnce.js --commit --sin-marca  (limpia SIN gastar la marca)
 *   node scripts/wipePhantomOpportunitiesOnce.js --commit --force (repite aunque esté DONE)
 *   node scripts/wipePhantomOpportunitiesOnce.js --estado        (solo el estado de la marca)
 *   node scripts/wipePhantomOpportunitiesOnce.js --restaurar          (qué se restauraría)
 *   node scripts/wipePhantomOpportunitiesOnce.js --restaurar --commit (deshace el borrado)
 *
 * Requiere MONGODB_URI en el entorno (server/.env) y se ejecuta desde `server/`.
 */
const os = require('os');
require('dotenv').config();
const mongoose = require('mongoose');

const OneTimeTask = require('../models/OneTimeTask');
const Conversation = require('../models/Conversation');

/** Colección de respaldo (cruda, sin modelo: es un volcado, no una entidad del dominio). */
const BACKUP_COLLECTION = 'oportunidades_fantasma_backup';
const backupCol = () => mongoose.connection.collection(BACKUP_COLLECTION);

/**
 * Clave de la tarea. Mientras no cambie, cualquier despliegue posterior encuentra la
 * marca DONE y no borra nada. Para volver a limpiar en el futuro se sube la fecha.
 */
const TASK_KEY = 'borrar-oportunidades-fantasma-2026-08-24';

/** Un proceso que lleva más de esto en RUNNING se da por muerto y se puede reintentar. */
const STALE_RUNNING_MS = 30 * 60 * 1000;

const CHUNK = 500;

// ─────────────────────────── clasificación ───────────────────────────

/**
 * ¿Nadie ha tocado esta oportunidad? Es la misma definición de "hueco" que usa
 * `adPlaceholderFor` en utils/workflowEngine.js, ampliada con los campos que también
 * significan trabajo hecho (etiquetas, motivo de pérdida, fecha de conversión).
 * En cuanto uno de ellos tiene algo, la oportunidad es de alguien y no se toca.
 */
function estaVacia(o) {
  return (
    !String(o?.name || '').trim() &&
    !(o?.interestedIn || []).length &&
    !Number(o?.expectedValue) &&
    !o?.appointment &&
    !(o?.tags || []).length &&
    !String(o?.lostReason || '').trim() &&
    !o?.convertedAt
  );
}

const NOTA_ANUNCIO = /^desde anuncio/i;
const NOTA_FLUJO_LEGACY = /creada autom[aá]ticamente por flujo/i;

/**
 * Categoría de una oportunidad. Devuelve la clave de borrado ('anuncio' /
 * 'flujo-legacy'), o una etiqueta de las que se CONSERVAN.
 */
function clasificar(o) {
  if (!estaVacia(o)) return 'conservar:trabajada';
  const nota = String(o?.notes || '').trim();
  const adId = String(o?.attribution?.adId || '').trim();
  const etapa = String(o?.stage || 'nuevo');
  if (NOTA_ANUNCIO.test(nota)) return 'borrar:anuncio';
  if (adId && etapa === 'nuevo' && !nota) return 'borrar:anuncio';
  if (NOTA_FLUJO_LEGACY.test(nota)) return 'borrar:flujo-legacy';
  // Vacía pero sin firma del sistema: puede ser el nodo "Mover etapa" de una
  // automatización o un alta manual. No se puede distinguir → se conserva.
  return etapa === 'nuevo' ? 'conservar:vacia-sin-firma' : 'conservar:vacia-etapa-movida';
}

const esBorrable = (o) => clasificar(o).startsWith('borrar:');

/**
 * Las oportunidades de un chat, con la MISMA regla que lee el CRM: manda el array y,
 * si no hay array, el espejo legacy `opportunity`. Sumar los dos contaría la principal
 * dos veces (ver utils/opportunities.js).
 */
const soloEspejo = (c) => !(Array.isArray(c.opportunities) && c.opportunities.length) && !!c.opportunity?.isOpportunity;

// ─────────────────────────── marca de una sola vez ───────────────────────────

async function reclamarTarea({ force }) {
  const existente = await OneTimeTask.findById(TASK_KEY).lean();
  if (existente) {
    if (existente.status === 'DONE' && !force) return { ok: false, motivo: 'DONE', marca: existente };
    if (existente.status === 'RUNNING' && !force) {
      const edad = Date.now() - new Date(existente.startedAt || 0).getTime();
      if (edad < STALE_RUNNING_MS) return { ok: false, motivo: 'RUNNING', marca: existente };
    }
    await OneTimeTask.updateOne(
      { _id: TASK_KEY },
      {
        $set: { status: 'RUNNING', host: os.hostname(), pid: process.pid, startedAt: new Date(), finishedAt: null, error: '' },
        $inc: { attempts: 1 },
      }
    );
    return { ok: true, marca: existente };
  }
  try {
    // El índice primario da la exclusión mutua: dos despliegues a la vez y solo uno entra.
    await OneTimeTask.create({
      _id: TASK_KEY, status: 'RUNNING', host: os.hostname(), pid: process.pid, startedAt: new Date(),
    });
    return { ok: true, marca: null };
  } catch (e) {
    if (e.code === 11000) return { ok: false, motivo: 'RUNNING', marca: await OneTimeTask.findById(TASK_KEY).lean() };
    throw e;
  }
}

// ─────────────────────────── informe / borrado ───────────────────────────

/**
 * Recorre las conversaciones con oportunidad y devuelve el informe. Si `commit`, además
 * quita las fantasma y deja el espejo legacy al día.
 */
async function procesar({ commit, clinic }) {
  const filtro = {
    ...(clinic ? { clinic: new mongoose.Types.ObjectId(String(clinic)) } : {}),
    $or: [{ 'opportunities.0': { $exists: true } }, { 'opportunity.isOpportunity': true }],
  };

  const stats = {
    chatsRevisados: 0,
    oportunidadesTotales: 0,
    porCategoria: {},
    porAnuncio: new Map(),
    borradas: 0,
    chatsTocados: 0,
    chatsQueQuedanSinOportunidad: 0,
  };
  const ejemplos = { borrar: [], conservarVacia: [] };
  const bump = (k) => { stats.porCategoria[k] = (stats.porCategoria[k] || 0) + 1; };

  const cursor = Conversation.find(filtro)
    .select('_id clinic phone contactName opportunities opportunity attribution')
    .cursor({ batchSize: CHUNK });

  let pendientes = [];
  let respaldos = [];
  // El RESPALDO se escribe ANTES que el borrado, siempre. Si el proceso muere entre
  // las dos escrituras se queda una copia de más (inofensiva: la restauración no
  // duplica), nunca una oportunidad perdida sin copia.
  const volcar = async () => {
    if (!pendientes.length) return;
    if (commit) {
      if (respaldos.length) await backupCol().insertMany(respaldos, { ordered: false });
      await Conversation.bulkWrite(pendientes, { ordered: false });
    }
    pendientes = [];
    respaldos = [];
  };

  for await (const conv of cursor) {
    stats.chatsRevisados++;
    const espejoSolo = soloEspejo(conv);
    const lista = espejoSolo ? [conv.opportunity] : (conv.opportunities || []);
    stats.oportunidadesTotales += lista.length;

    let quitadasAqui = 0;
    const conservadas = [];
    for (const o of lista) {
      const cat = clasificar(o);
      bump(cat);
      if (cat.startsWith('borrar:')) {
        quitadasAqui++;
        const adId = String(o?.attribution?.adId || '').trim();
        if (adId) stats.porAnuncio.set(adId, (stats.porAnuncio.get(adId) || 0) + 1);
        respaldos.push({
          taskKey: TASK_KEY,
          conversation: conv._id,
          clinic: conv.clinic || null,
          phone: conv.phone || '',
          categoria: cat,
          removedAt: new Date(),
          opportunity: o?.toObject ? o.toObject() : o,
        });
        if (ejemplos.borrar.length < 5) {
          ejemplos.borrar.push({ chat: conv.phone, etapa: o.stage, nota: String(o.notes || '').slice(0, 50), adId });
        }
      } else {
        conservadas.push(o);
        if (cat.startsWith('conservar:vacia') && ejemplos.conservarVacia.length < 5) {
          ejemplos.conservarVacia.push({ chat: conv.phone, etapa: o.stage, nota: String(o.notes || '').slice(0, 50) });
        }
      }
    }
    if (!quitadasAqui) continue;

    stats.borradas += quitadasAqui;
    stats.chatsTocados++;
    if (!conservadas.length) stats.chatsQueQuedanSinOportunidad++;

    // El array es la fuente y el espejo se DERIVA de él (regla única en
    // utils/opportunities.js): se recalcula siempre, también cuando queda vacío.
    // Con `espejoSolo` esto sube al array la que vivía solo en el espejo, que es
    // exactamente lo que hace `ensureArray`.
    const plano = (o) => (o?.toObject ? o.toObject() : o);
    const arraySiguiente = conservadas.map(plano);
    const espejoSiguiente = arraySiguiente.length
      ? arraySiguiente[arraySiguiente.length - 1]
      : { isOpportunity: false, stage: 'nuevo' };

    pendientes.push({
      updateOne: {
        filter: { _id: conv._id },
        update: { $set: { opportunities: arraySiguiente, opportunity: espejoSiguiente } },
      },
    });
    if (pendientes.length >= CHUNK) await volcar();
  }
  await volcar();
  return { stats, ejemplos };
}

/**
 * DESHACER: devuelve a su chat las oportunidades guardadas en el respaldo.
 *
 * Idempotente: si la oportunidad ya está en el chat (mismo `_id` de subdocumento) no se
 * inserta otra vez, así que se puede ejecutar dos veces sin duplicar nada. Respeta el
 * orden original poniéndolas al final y recalcula el espejo legacy.
 */
async function restaurar({ commit }) {
  const total = await backupCol().countDocuments({ taskKey: TASK_KEY });
  if (!total) {
    console.log('No hay respaldo que restaurar (colección vacía o inexistente).');
    return;
  }
  const porChat = new Map();
  const cursor = backupCol().find({ taskKey: TASK_KEY });
  for await (const doc of cursor) {
    const k = String(doc.conversation);
    if (!porChat.has(k)) porChat.set(k, []);
    porChat.get(k).push(doc.opportunity);
  }

  let devueltas = 0;
  let chats = 0;
  let sinChat = 0;
  const ops = [];
  for (const [convId, lista] of porChat) {
    // eslint-disable-next-line no-await-in-loop
    const conv = await Conversation.findById(convId).select('opportunities opportunity').lean();
    if (!conv) { sinChat += lista.length; continue; }
    const yaEstan = new Set((conv.opportunities || []).map((o) => String(o._id)));
    const faltan = lista.filter((o) => !yaEstan.has(String(o._id)));
    if (!faltan.length) continue;
    const siguiente = [...(conv.opportunities || []), ...faltan];
    devueltas += faltan.length;
    chats++;
    ops.push({
      updateOne: {
        filter: { _id: conv._id },
        update: { $set: { opportunities: siguiente, opportunity: siguiente[siguiente.length - 1] } },
      },
    });
    if (ops.length >= CHUNK && commit) {
      // eslint-disable-next-line no-await-in-loop
      await Conversation.bulkWrite(ops.splice(0, ops.length), { ordered: false });
    }
  }
  if (commit && ops.length) await Conversation.bulkWrite(ops, { ordered: false });

  console.log(`\n===== RESTAURAR "${TASK_KEY}" =====`);
  console.log(`  En el respaldo        : ${total.toLocaleString('es-EC')}`);
  console.log(`  Se devuelven          : ${devueltas.toLocaleString('es-EC')} (en ${chats.toLocaleString('es-EC')} chats)`);
  console.log(`  Ya estaban / sin chat : ${(total - devueltas - sinChat).toLocaleString('es-EC')} / ${sinChat.toLocaleString('es-EC')}`);
  if (commit) {
    await OneTimeTask.updateOne({ _id: TASK_KEY }, { $set: { status: 'FAILED', error: 'restaurado a mano' } }).catch(() => {});
    console.log('>>> RESTAURADO. La marca queda en FAILED por si se quiere volver a intentar el borrado.');
  } else {
    console.log('>>> DRY-RUN: no se ha escrito nada. Añade --commit para restaurar de verdad.');
  }
}

function imprimirInforme({ stats, ejemplos }, { commit }) {
  const n = (v) => Number(v || 0).toLocaleString('es-EC');
  const total = stats.oportunidadesTotales || 1;
  const pct = (v) => `${((v / total) * 100).toFixed(1)}%`;

  console.log('\n===== OPORTUNIDADES FANTASMA =====');
  console.log(`Chats con oportunidad revisados : ${n(stats.chatsRevisados)}`);
  console.log(`Oportunidades totales           : ${n(stats.oportunidadesTotales)}`);
  console.log('\n--- Clasificación ---');
  for (const [k, v] of Object.entries(stats.porCategoria).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n(v)).padStart(8)}  ${pct(v).padStart(6)}  ${k}`);
  }
  console.log('\n--- Resultado ---');
  console.log(`  A BORRAR (fantasma)   : ${n(stats.borradas)}  (${pct(stats.borradas)})`);
  console.log(`  Se conservan          : ${n(stats.oportunidadesTotales - stats.borradas)}`);
  console.log(`  Chats afectados       : ${n(stats.chatsTocados)}`);
  console.log(`  Chats que se quedan sin ninguna oportunidad: ${n(stats.chatsQueQuedanSinOportunidad)}`);
  console.log(`  Anuncios distintos implicados: ${n(stats.porAnuncio.size)}`);
  if (ejemplos.borrar.length) {
    console.log('\n--- Ejemplos de lo que se BORRA ---');
    for (const e of ejemplos.borrar) console.log('   ', JSON.stringify(e));
  }
  if (ejemplos.conservarVacia.length) {
    console.log('\n--- Ejemplos de VACÍAS que se CONSERVAN (sin firma del sistema) ---');
    for (const e of ejemplos.conservarVacia) console.log('   ', JSON.stringify(e));
  }
  console.log(commit ? '\n>>> APLICADO (los cambios están escritos).' : '\n>>> DRY-RUN: no se ha escrito nada. Usa --commit para aplicar.');
}

// ─────────────────────────── main ───────────────────────────

(async () => {
  const args = process.argv.slice(2);
  const commit = args.includes('--commit');
  const force = args.includes('--force');
  const soloEstado = args.includes('--estado');
  const pideRestaurar = args.includes('--restaurar');
  const sinMarca = args.includes('--sin-marca');
  const clinicArg = args.find((a) => a.startsWith('--clinic='));
  const clinic = clinicArg ? clinicArg.split('=')[1] : null;

  if (!process.env.MONGODB_URI) throw new Error('Falta MONGODB_URI en el entorno (.env)');
  await mongoose.connect(process.env.MONGODB_URI);

  try {
    if (soloEstado) {
      const marca = await OneTimeTask.findById(TASK_KEY).lean();
      console.log(marca ? JSON.stringify(marca, null, 2) : `Sin marca para "${TASK_KEY}" (nunca se ha ejecutado).`);
      return;
    }

    if (pideRestaurar) {
      await restaurar({ commit });
      return;
    }

    console.log(`\n=== ${TASK_KEY} ===`);
    console.log(commit ? 'MODO: COMMIT (aplica cambios).' : 'MODO: DRY-RUN (no escribe).');
    if (clinic) console.log(`Clínica: ${clinic}`);

    // La marca solo se reclama al APLICAR: un dry-run se puede repetir todas las veces
    // que haga falta sin gastar la única ejecución. Y con `--sin-marca` tampoco se gasta
    // (limpieza previa al despliegue; ver la cabecera).
    if (commit && !sinMarca) {
      const reclamo = await reclamarTarea({ force });
      if (!reclamo.ok) {
        console.log(
          reclamo.motivo === 'DONE'
            ? `La tarea ya se ejecutó (${reclamo.marca?.finishedAt || 'sin fecha'}). No se borra nada. Usa --force para repetirla.`
            : 'Otra ejecución la tiene tomada ahora mismo (RUNNING). No se hace nada.'
        );
        console.log(reclamo.marca?.result ? JSON.stringify(reclamo.marca.result, null, 2) : '');
        return;
      }
    }

    let informe;
    try {
      informe = await procesar({ commit, clinic });
    } catch (e) {
      if (commit && !sinMarca) {
        await OneTimeTask.updateOne(
          { _id: TASK_KEY },
          { $set: { status: 'FAILED', error: String(e.message).slice(0, 500), finishedAt: new Date() } }
        ).catch(() => {});
      }
      throw e;
    }

    imprimirInforme(informe, { commit });

    if (commit && sinMarca) {
      console.log(`Marca "${TASK_KEY}" INTACTA (--sin-marca): el despliegue volverá a pasar la escoba una vez.`);
    }
    if (commit && !sinMarca) {
      const { stats } = informe;
      await OneTimeTask.updateOne(
        { _id: TASK_KEY },
        {
          $set: {
            status: 'DONE',
            finishedAt: new Date(),
            error: '',
            result: {
              chatsRevisados: stats.chatsRevisados,
              oportunidadesTotales: stats.oportunidadesTotales,
              borradas: stats.borradas,
              chatsTocados: stats.chatsTocados,
              chatsQueQuedanSinOportunidad: stats.chatsQueQuedanSinOportunidad,
              porCategoria: stats.porCategoria,
            },
          },
        }
      );
      console.log(`Marca "${TASK_KEY}" = DONE. Los siguientes despliegues no volverán a ejecutarla.`);
    }
  } finally {
    await mongoose.disconnect();
  }
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
