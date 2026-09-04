#!/usr/bin/env node
/**
 * RECOMPRIMIR LOS ADJUNTOS QUE LA IMPORTACIÓN GUARDÓ A TAMAÑO COMPLETO.
 *
 * La importación adjunta copias REDUCIDAS de las fotos (1200 px, ~120 KB por
 * página). Pero cuando al VPS se le acaba la memoria y el kernel mata el Chromium
 * del reductor, este se rinde un rato y copia las fotos TAL CUAL para no frenar la
 * tanda. En la tanda de septiembre eso pasó a mitad de camino: los adjuntos saltaron
 * de 247 KB de media a más de 1 MB y el disco se llevó 3 GB de más.
 *
 * Este script arregla lo ya guardado: busca los adjuntos gordos de la importación,
 * les reduce las páginas y reescribe el archivo. NO toca el escáner —el original
 * sigue intacto en storage/scans, que es la única prueba de lo que decía el papel—
 * ni los adjuntos que subió una persona.
 *
 *   node scripts/recomprimirAdjuntosFichas.js               (dice cuánto ahorraría)
 *   node scripts/recomprimirAdjuntosFichas.js --commit      (lo hace)
 *   node scripts/recomprimirAdjuntosFichas.js --commit --minimo=400  (umbral en KB)
 *
 * Se puede parar y repetir: lo que ya está por debajo del umbral se salta.
 */
const path = require('path');
const fsp = require('fs/promises');

const { connect, disconnect } = require('./_common');
const ClinicalRecord = require('../models/ClinicalRecord');
const PatientObservation = require('../models/PatientObservation');
const { paginasJpeg, crearReductor, pdfDePaginas } = require('../utils/scanMedia');

const FOLLOWUPS_DIR = path.join(__dirname, '..', 'storage', 'followups');
const OBSERVATIONS_DIR = path.join(__dirname, '..', 'storage', 'observations');

/** Por debajo de esto ya está reducido: no hay nada que ganar. */
const MINIMO_KB = 400;

const mb = (b) => (b / 1024 / 1024).toFixed(1);

/**
 * Reescribe un PDF con sus páginas reducidas.
 * Devuelve el tamaño nuevo, o 0 si no se pudo o no valía la pena.
 *
 * Solo se pisa el archivo si el nuevo es MÁS PEQUEÑO. Un PDF que no se puede
 * despiezar (o cuyas páginas ya estaban al mínimo) se queda como está: el adjunto
 * que ve el doctor no se toca para nada que no sea ganar espacio.
 */
async function recomprimir(ruta, titulo, reductor) {
  const bruto = await fsp.readFile(ruta);
  const paginas = paginasJpeg(bruto);
  if (!paginas.length) return 0;

  const reducidas = [];
  for (const p of paginas) reducidas.push(await reductor.reducir(p));
  const nuevo = await pdfDePaginas(reducidas, titulo);
  if (nuevo.length >= bruto.length) return 0;

  // Se escribe al lado y se renombra: un corte de luz a media escritura dejaría el
  // adjunto del paciente truncado, y eso no se recupera del original reducido.
  const temporal = `${ruta}.nuevo`;
  await fsp.writeFile(temporal, nuevo);
  await fsp.rename(temporal, ruta);
  return nuevo.length;
}

async function main({ commit = false, minimoKb = MINIMO_KB, limite = 0 } = {}) {
  const minimo = minimoKb * 1024;
  const reductor = crearReductor();
  let vistos = 0;
  let hechos = 0;
  let antes = 0;
  let despues = 0;
  let fallos = 0;

  const procesar = async (ruta, titulo, tamaño, guardar) => {
    vistos += 1;
    antes += tamaño;
    if (!commit) { despues += Math.round(tamaño * 0.25); return; } // el ratio visto en la tanda
    try {
      const nuevo = await recomprimir(ruta, titulo, reductor);
      if (!nuevo) { despues += tamaño; return; }
      await guardar(nuevo);
      hechos += 1;
      despues += nuevo;
    } catch (e) {
      fallos += 1;
      despues += tamaño;
      if (fallos <= 10) console.log(`  · no se pudo con ${path.basename(ruta)}: ${e.message}`);
    }
    if (hechos && hechos % 100 === 0) {
      console.log(`  … ${hechos} adjuntos recomprimidos (${mb(antes - despues)} MB ahorrados)`);
    }
  };

  // ─── Seguimientos: la ficha de registro ───────────────────────────────────
  const historias = await ClinicalRecord.find({
    'followUps.attachments.originalName': /- ficha\.pdf$/,
  }).select('clinic followUps').lean();

  for (const h of historias) {
    for (const fu of h.followUps || []) {
      for (const a of fu.attachments || []) {
        if (!/- ficha\.pdf$/.test(a.originalName || '') || (a.size || 0) < minimo) continue;
        if (limite && vistos >= limite) break;
        // `a.clinic` manda: la ficha es del paciente y sus adjuntos pueden estar en
        // carpetas de sucursales distintas (ver `rutaDelAdjunto`).
        const ruta = path.join(FOLLOWUPS_DIR, String(a.clinic || h.clinic), a.filename);
        await procesar(ruta, a.originalName, a.size, (nuevo) =>
          ClinicalRecord.updateOne(
            { _id: h._id, 'followUps.attachments._id': a._id },
            { $set: { 'followUps.$[].attachments.$[adj].size': nuevo } },
            { arrayFilters: [{ 'adj._id': a._id }] }
          ));
      }
    }
  }

  // ─── Observaciones: las hojas de seguimiento ──────────────────────────────
  const observaciones = await PatientObservation.find({
    'scanImport.scan': { $ne: null },
  }).select('patient attachments').lean();

  for (const o of observaciones) {
    for (const a of o.attachments || []) {
      if ((a.size || 0) < minimo) continue;
      if (limite && vistos >= limite) break;
      const ruta = path.join(OBSERVATIONS_DIR, String(o.patient), a.filename);
      await procesar(ruta, a.originalName, a.size, (nuevo) =>
        PatientObservation.updateOne(
          { _id: o._id, 'attachments._id': a._id },
          { $set: { 'attachments.$.size': nuevo } }
        ));
    }
  }

  await reductor.cerrar?.();

  console.log('\n─── RESULTADO ───────────────────────────────────────');
  console.log(`Adjuntos por encima de ${minimoKb} KB: ${vistos} (${mb(antes)} MB)`);
  if (commit) {
    console.log(`Recomprimidos: ${hechos} · fallos: ${fallos}`);
    console.log(`Ahora ocupan ${mb(despues)} MB → ${mb(antes - despues)} MB liberados`);
  } else {
    console.log(`Ocuparían ~${mb(despues)} MB → ~${mb(antes - despues)} MB liberados`);
    console.log('(estimación; con --commit se recomprime de verdad)');
  }
  return { vistos, hechos, antes, despues, fallos };
}

module.exports = { main, recomprimir };

if (require.main === module) {
  const args = process.argv.slice(2);
  const valor = (n) => (args.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1];
  const commit = args.includes('--commit');
  console.log('\n=== RECOMPRIMIR ADJUNTOS DE LAS FICHAS ===');
  console.log(commit ? 'MODO: COMMIT (reescribe los archivos).' : 'MODO: DRY-RUN. Usa --commit para aplicar.');
  connect()
    .then(() => main({
      commit,
      minimoKb: Number(valor('minimo') || MINIMO_KB),
      limite: Number(valor('limite') || 0),
    }))
    .catch((e) => { console.error('ERROR:', e.message); process.exitCode = 1; })
    .finally(() => disconnect());
}
