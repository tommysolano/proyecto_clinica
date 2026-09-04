#!/usr/bin/env node
/**
 * DESATASCAR LA IMPORTACIÓN DE FICHAS ESCANEADAS.
 *
 * La importación de miles de fichas puede quedarse ATASCADA sin morirse, que es el
 * peor de los estados posibles:
 *
 *   · el reductor de fotos trabaja con Chromium y, cuando al VPS se le acaba la
 *     memoria, el kernel se lo lleva por delante;
 *   · cada foto contra ese navegador muerto tarda en rendirse lo que tarde el
 *     `protocolTimeout` de puppeteer —tres minutos— así que la tanda sigue
 *     "avanzando" a razón de una ficha cada seis minutos: 16 días para terminar;
 *   · y como el proceso sigue vivo, su latido sigue refrescando la marca de
 *     `onetimetasks`, que se queda en RUNNING y FRESCA para siempre. Ningún
 *     despliegue posterior se atreve a relanzar encima. Nadie avisa de nada.
 *
 * Este script es el vigilante: mira si la tanda de verdad avanza y, si no, la mata
 * y deja la marca en FAILED para que el siguiente `--once` la reanude sola. Como
 * reanudar salta sin abrir el PDF lo que ya está hecho, no se repite trabajo.
 *
 *   node scripts/desatascarImportacionFichas.js            (solo mira y dice)
 *   node scripts/desatascarImportacionFichas.js --commit   (mata y desbloquea)
 *
 * Código de salida 0 siempre: es un vigilante, no un test. Que no haya nada
 * atascado es el caso NORMAL, no un fallo del despliegue.
 */
const os = require('os');
const { execFileSync } = require('child_process');

const { connect, disconnect, mongoose } = require('./_common');
const Patient = require('../models/Patient');
const PatientObservation = require('../models/PatientObservation');

const CLAVE = 'importar-fichas-escaneadas-2026-09-03';
/** Cuánto se mira antes de dictaminar. Sana hace ~30 fichas/min: 90 s sobran. */
const ESPERA_MS = 90 * 1000;

/**
 * Cuánto ha avanzado la tanda. Se cuentan las OBSERVACIONES creadas por
 * importación y los pacientes ya enlazados a un escaneo: las dos crecen ficha a
 * ficha, así que si ninguna se mueve es que no se está haciendo nada.
 */
async function progreso() {
  const [obs, pac] = await Promise.all([
    PatientObservation.countDocuments({ 'scanImport.scan': { $ne: null } }),
    Patient.countDocuments({ 'scanImport.scan': { $ne: null } }),
  ]);
  return { obs, pac, suma: obs + pac };
}

/** Mata al proceso atascado y a los Chromium que deje huérfanos. */
function matar(pid) {
  const muertos = [];
  try {
    process.kill(pid, 'SIGKILL');
    muertos.push(`proceso ${pid}`);
  } catch (e) {
    if (e.code !== 'ESRCH') throw e; // ESRCH = ya no estaba
  }
  // Un Chromium sin quien lo cierre se queda ocupando memoria, que es justo lo que
  // provocó el atasco. `pkill` puede no estar: no es motivo para fallar.
  try {
    execFileSync('pkill', ['-f', 'chrome.*--headless'], { stdio: 'ignore' });
    muertos.push('chromium huérfano');
  } catch (_) { /* no había ninguno, o no hay pkill */ }
  return muertos;
}

async function main({
  commit = false,
  clave = CLAVE,
  esperaMs = ESPERA_MS,
  // Inyectable: un test no puede andar mandando SIGKILL ni pkill de verdad.
  matarProceso = matar,
} = {}) {
  const tareas = mongoose.connection.db.collection('onetimetasks');
  const marca = await tareas.findOne({ _id: clave });

  if (!marca || marca.status !== 'RUNNING') {
    console.log(`Importación "${clave}": ${marca ? marca.status : 'sin empezar'}. Nada que desatascar.`);
    return { atascada: false };
  }

  const antes = await progreso();
  console.log(`Importación en curso (host ${marca.host}, pid ${marca.pid}). Midiendo ${esperaMs / 1000} s…`);
  await new Promise((r) => setTimeout(r, esperaMs));
  const despues = await progreso();
  const avance = despues.suma - antes.suma;

  if (avance > 0) {
    console.log(`Avanza: +${avance} en ${esperaMs / 1000} s (${despues.pac} fichas). Se la deja trabajar.`);
    return { atascada: false, avance };
  }

  console.log(`ATASCADA: ni un movimiento en ${esperaMs / 1000} s, con la marca RUNNING y latiendo.`);
  if (!commit) {
    console.log('(sin --commit no se toca nada; con --commit la mata y la deja lista para reanudar)');
    return { atascada: true, commit: false };
  }

  // Solo se mata lo que corre en ESTA máquina: el pid de otra no es este proceso.
  if (marca.host && marca.host !== os.hostname()) {
    console.log(`La tanda corre en "${marca.host}" y esto es "${os.hostname()}": no se mata nada desde aquí.`);
    return { atascada: true, matada: false };
  }

  const muertos = marca.pid ? matarProceso(marca.pid) : [];
  console.log(muertos.length ? `Terminado: ${muertos.join(', ')}.` : 'El proceso ya no estaba.');

  // FAILED —y no DONE— es lo que hace que el siguiente `--once` la reanude sola,
  // sin necesidad de --force ni de que nadie entre al servidor.
  await tareas.updateOne({ _id: clave }, {
    $set: {
      status: 'FAILED',
      finishedAt: new Date(),
      error: 'atascada: el navegador del reductor murió y la tanda dejó de avanzar; desbloqueada para reanudar',
    },
  });
  console.log(`Marca "${clave}" = FAILED: el próximo intento la reanuda desde donde se quedó.`);
  return { atascada: true, matada: true };
}

module.exports = { main, progreso, CLAVE };

if (require.main === module) {
  const args = process.argv.slice(2);
  const valor = (n) => (args.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1];
  const commit = args.includes('--commit');
  console.log('\n=== VIGILANTE DE LA IMPORTACIÓN DE FICHAS ===');
  connect()
    .then(() => main({ commit, clave: valor('key') || CLAVE }))
    .catch((e) => { console.error('ERROR:', e.message); })
    .finally(() => disconnect());
}
