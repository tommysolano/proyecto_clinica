/**
 * Junta las oportunidades PARTIDAS EN DOS por los anuncios.
 *
 * EL PROBLEMA. Cuando un mensaje llegaba desde un anuncio pasaban dos cosas
 * seguidas, cada una por su lado:
 *   1. La ingesta creaba sola una oportunidad EN BLANCO con la atribución del
 *      anuncio y nada más: sin nombre, sin servicios y sin valor.
 *   2. Un segundo después, la automatización de ESE MISMO anuncio añadía OTRA
 *      oportunidad, esta con su nombre ("Prostata 1", "ECO 360 1"…), pero sin la
 *      atribución.
 * Resultado: cada chat de anuncio contaba por DOS oportunidades. El 21-ago-2026
 * había 9.447 en blanco de 16.394 (el 58%), la gráfica "Qué oportunidades son"
 * enseñaba «Sin nombre» como la barra más alta —mientras el chat mostraba la
 * oportunidad con su nombre— y el total de oportunidades creadas salía inflado.
 *
 * El origen ya está arreglado (workflowEngine.adPlaceholderFor: la automatización
 * RELLENA el hueco del anuncio en vez de crear otra). Este script arregla lo que
 * ya está guardado.
 *
 * QUÉ HACE. Por cada chat, busca huecos: oportunidad sin nombre, sin servicios,
 * sin valor, en etapa 'nuevo', sin cita y CON anuncio. Si justo después (dentro
 * de la ventana, 10 min por defecto) hay una oportunidad CON nombre y SIN
 * anuncio, entiende que son la misma: le pasa la atribución a la del nombre y
 * borra el hueco. Así el conteo deja de estar duplicado y —de regalo— se puede
 * saber qué anuncio trajo qué oportunidad.
 *
 * QUÉ NO TOCA:
 *   · Huecos sin ninguna oportunidad con nombre detrás (son leads reales de un
 *     anuncio que ninguna automatización llegó a identificar): se quedan.
 *   · Huecos ya trabajados (con etapa movida, cita, valor o servicios).
 *   · Las fechas: la oportunidad que se conserva mantiene SU createdAt, así
 *     ningún lead cambia de día en los informes.
 *
 *   node scripts/mergeAdPlaceholderOpportunities.js              (dry-run: informe)
 *   node scripts/mergeAdPlaceholderOpportunities.js --minutes=10 (ventana)
 *   node scripts/mergeAdPlaceholderOpportunities.js --commit     (aplica)
 */
const { parseArgs, connect, disconnect, banner } = require('./_common');
const Conversation = require('../models/Conversation');

/** ¿Es un hueco de anuncio sin trabajar? (misma regla que workflowEngine.adPlaceholderFor) */
const esHueco = (o) => (
  !!String(o?.attribution?.adId || '').trim()
  && !String(o?.name || '').trim()
  && !(o?.interestedIn || []).length
  && !Number(o?.expectedValue)
  && String(o?.stage || 'nuevo') === 'nuevo'
  && !o?.appointment
);

const ms = (v) => new Date(v || 0).getTime();

async function run() {
  const opts = parseArgs();
  const minutosArg = process.argv.find((a) => a.startsWith('--minutes='));
  const ventanaMin = Math.max(1, Number(minutosArg ? minutosArg.split('=')[1] : 10) || 10);
  banner(`Juntar oportunidades partidas por el anuncio (ventana ${ventanaMin} min)`, opts);

  await connect();
  try {
    const filtro = { 'opportunities.1': { $exists: true } };
    if (opts.clinic) filtro.clinic = opts.clinic;
    const convs = await Conversation.find(filtro).select('_id opportunities').lean();
    console.log(`Chats con más de una oportunidad: ${convs.length}`);

    let huecos = 0;
    let fusionados = 0;
    let sinPareja = 0;
    const ops = [];
    const ejemplos = [];

    for (const c of convs) {
      const opps = (c.opportunities || []).map((o) => ({ ...o }));
      const usados = new Set(); // una oportunidad con nombre no puede absorber dos huecos
      const aBorrar = new Set();

      opps.forEach((hueco, i) => {
        if (!esHueco(hueco)) return;
        huecos++;
        const t0 = ms(hueco.createdAt);
        // La PRIMERA con nombre y sin anuncio creada después del hueco, dentro
        // de la ventana. Se recorre por fecha, no por posición del array: hay
        // chats donde el orden de guardado no es el cronológico.
        const pareja = opps
          .map((o, j) => ({ o, j }))
          .filter(({ o, j }) => (
            j !== i && !usados.has(j) && !aBorrar.has(j)
            && String(o?.name || '').trim()
            && !String(o?.attribution?.adId || '').trim()
            && ms(o.createdAt) >= t0
            && ms(o.createdAt) - t0 <= ventanaMin * 60000
          ))
          .sort((a, b) => ms(a.o.createdAt) - ms(b.o.createdAt))[0];
        if (!pareja) { sinPareja++; return; }

        usados.add(pareja.j);
        aBorrar.add(i);
        // La atribución del anuncio pasa a la oportunidad que se conserva.
        pareja.o.attribution = {
          adId: hueco.attribution?.adId || '',
          campaign: hueco.attribution?.campaign || '',
          ctwaClid: hueco.attribution?.ctwaClid || '',
        };
        fusionados++;
        if (ejemplos.length < 5) {
          ejemplos.push(`  chat ${c._id}: hueco (anuncio ${pareja.o.attribution.adId}) → «${pareja.o.name}»`);
        }
      });

      if (!aBorrar.size) continue;
      const quedan = opps.filter((_, j) => !aBorrar.has(j));
      // Espejo legacy = la ÚLTIMA del array (regla única de utils/opportunities).
      const espejo = quedan.length
        ? { ...quedan[quedan.length - 1] }
        : { isOpportunity: false, stage: 'nuevo' };
      ops.push({
        updateOne: {
          filter: { _id: c._id },
          update: { $set: { opportunities: quedan, opportunity: espejo } },
        },
      });
    }

    console.log(`  · Huecos de anuncio sin trabajar: ${huecos}`);
    console.log(`  · Se juntan con su oportunidad con nombre: ${fusionados}`);
    console.log(`  · Huecos que se quedan como están (sin pareja en la ventana): ${sinPareja}`);
    console.log(`  · Chats a escribir: ${ops.length}`);
    if (ejemplos.length) console.log(`\nEjemplos:\n${ejemplos.join('\n')}`);

    if (!ops.length) {
      console.log('\nNada que hacer.');
    } else if (opts.dryRun) {
      console.log('\nDRY-RUN: no se escribió nada. Repite con --commit para aplicarlo.');
    } else {
      for (let i = 0; i < ops.length; i += 500) {
        // eslint-disable-next-line no-await-in-loop
        const r = await Conversation.bulkWrite(ops.slice(i, i + 500), { ordered: false });
        console.log(`  aplicados ${Math.min(i + 500, ops.length)}/${ops.length} (modificados: ${r.modifiedCount})`);
      }
      console.log('\nListo.');
    }
  } finally {
    await disconnect();
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
