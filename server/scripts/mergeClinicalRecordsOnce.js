#!/usr/bin/env node
/**
 * UNA HISTORIA CLÍNICA POR PACIENTE — UNA SOLA VEZ.
 *
 * ─── POR QUÉ ───────────────────────────────────────────────────────────────────────
 * `clinicalrecords` nació con índice único (clinic, patient): UNA FICHA POR SUCURSAL.
 * Con una sola sede nadie lo notaba. Al abrir la segunda salió lo que tenía que salir:
 * el mismo paciente atendido en Central y en Extensión tenía DOS historias, cada una
 * invisible desde la otra. Y peor que invisible — `getOrCreateByPatient` no encontraba
 * la ficha de la otra sede y CREABA una nueva en blanco, así que el médico de Extensión
 * veía a un paciente sin alergias, sin antecedentes y sin ninguna consulta previa, sin
 * ninguna señal de que existieran.
 *
 * El código ya consulta por paciente a secas. Esta tarea arregla los datos que quedaron.
 *
 * ─── QUÉ HACE ──────────────────────────────────────────────────────────────────────
 *  1. Agrupa `clinicalrecords` por paciente y se queda con los que tienen más de una.
 *  2. Elige la ficha QUE SE QUEDA: la que más seguimientos tiene; a igualdad, la más
 *     antigua (es donde empezó la historia de esa persona).
 *  3. Le añade los seguimientos de las demás y los ORDENA POR FECHA. Una historia
 *     clínica se lee en orden: pegar un bloque al final la dejaría contando la consulta
 *     de marzo después de la de agosto.
 *  4. Rellena los huecos de la cabecera (alergias, antecedentes, hábitos, cédula…) con
 *     lo que dijera la otra ficha. NO PISA nada: si las dos tienen algo escrito en el
 *     mismo campo, gana la que se queda y lo de la otra se conserva en la copia.
 *  5. Borra las fichas absorbidas y deja el índice único correcto: fuera
 *     `clinic_1_patient_1`, dentro `patient_1` único. Ese candado es lo que impide que
 *     dos peticiones simultáneas desde sedes distintas vuelvan a crear dos historias.
 *
 * Los ADJUNTOS no se mueven de carpeta: cada uno guarda ahora en qué sucursal se subió
 * y `rutaDelAdjunto` los encuentra igual (los viejos, por nombre, que es único).
 *
 * ─── COPIA DE SEGURIDAD ────────────────────────────────────────────────────────────
 * Antes de borrar nada, cada ficha absorbida se guarda ENTERA en la colección
 * `clinicalrecords_merge_backup`. El M0 no tiene backups y esto es historia clínica.
 * Para deshacerlo basta con volver a insertarlas desde ahí.
 *
 * ─── "UNA SOLA VEZ" ────────────────────────────────────────────────────────────────
 * La marca vive en la base (colección `onetimetasks`, clave TASK_KEY): el despliegue la
 * ejecuta en cada push, pero solo el PRIMERO hace algo. Si falla queda FAILED y el
 * siguiente despliegue la reintenta.
 *
 * ─── USO ───────────────────────────────────────────────────────────────────────────
 *   node scripts/mergeClinicalRecordsOnce.js             (DRY-RUN: solo informa)
 *   node scripts/mergeClinicalRecordsOnce.js --commit    (funde y deja marca)
 *   node scripts/mergeClinicalRecordsOnce.js --commit --force   (repite aunque esté DONE)
 *   node scripts/mergeClinicalRecordsOnce.js --estado    (solo muestra la marca)
 */
const os = require('os');
const mongoose = require('mongoose');
const { connect, disconnect } = require('./_common');

const OneTimeTask = require('../models/OneTimeTask');
const ClinicalRecord = require('../models/ClinicalRecord');

const TASK_KEY = 'historia-clinica-unica-por-paciente-2026-09-04';
const STALE_RUNNING_MS = 30 * 60 * 1000;

const BACKUP_COLL = 'clinicalrecords_merge_backup';
const INDICE_VIEJO = 'clinic_1_patient_1';

/** Campos que NO se funden: identifican la ficha o se tratan aparte. */
const NO_FUNDIR = new Set(['_id', '__v', 'clinic', 'patient', 'followUps', 'createdAt', 'updatedAt']);

/** ¿Este valor cuenta como "no hay nada escrito"? */
const vacio = (v) => {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  if (v instanceof Date) return false;
  if (mongoose.Types.ObjectId.isValid(v) && typeof v !== 'object') return false;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
};

/**
 * Cuál de las fichas se queda. Más seguimientos gana; a igualdad, la más antigua.
 * Es la que menos se pierde por reordenar y la que más probablemente tiene los
 * antecedentes escritos.
 */
const elegirGanadora = (fichas) =>
  [...fichas].sort((a, b) => {
    const dif = (b.followUps?.length || 0) - (a.followUps?.length || 0);
    if (dif !== 0) return dif;
    return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
  })[0];

async function fundirHistorias({ commit = false, log = console.log } = {}) {
  const db = mongoose.connection.db;
  const coll = db.collection('clinicalrecords');

  const grupos = await coll
    .aggregate([{ $group: { _id: '$patient', ids: { $push: '$_id' }, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }])
    .toArray();

  log(`Pacientes con más de una ficha: ${grupos.length}`);

  let fundidas = 0;
  let seguimientosMovidos = 0;
  let camposRellenados = 0;

  for (const g of grupos) {
    const fichas = await coll.find({ _id: { $in: g.ids } }).toArray();
    const ganadora = elegirGanadora(fichas);
    const perdedoras = fichas.filter((f) => String(f._id) !== String(ganadora._id));

    const seguimientos = [...(ganadora.followUps || [])];
    const set = {};
    for (const p of perdedoras) {
      seguimientos.push(...(p.followUps || []));
      seguimientosMovidos += (p.followUps || []).length;
      for (const [k, v] of Object.entries(p)) {
        if (NO_FUNDIR.has(k)) continue;
        if (!vacio(ganadora[k]) || !vacio(set[k]) || vacio(v)) continue;
        set[k] = v;
        camposRellenados += 1;
      }
    }
    // Una historia clínica se lee en orden.
    seguimientos.sort((a, b) => new Date(a.fecha || a.createdAt || 0) - new Date(b.fecha || b.createdAt || 0));

    log(
      `  paciente ${g._id}: ${fichas.length} fichas → 1 ` +
        `(se queda ${ganadora._id} con ${ganadora.followUps?.length || 0}; ` +
        `quedan ${seguimientos.length} seguimientos)`
    );

    if (!commit) continue;

    if (perdedoras.length) {
      await db.collection(BACKUP_COLL).insertMany(
        perdedoras.map((p) => ({ ...p, _backupAt: new Date(), _mergedInto: ganadora._id })),
        { ordered: false }
      );
    }
    await coll.updateOne({ _id: ganadora._id }, { $set: { ...set, followUps: seguimientos } });
    await coll.deleteMany({ _id: { $in: perdedoras.map((p) => p._id) } });
    fundidas += perdedoras.length;
  }

  // ─── Los índices ───────────────────────────────────────────────────────────
  const indices = await coll.indexes();
  const tieneViejo = indices.some((i) => i.name === INDICE_VIEJO);
  const patientUnico = indices.find((i) => i.name === 'patient_1');
  const yaUnico = !!patientUnico?.unique;

  log('');
  log(`Índice ${INDICE_VIEJO}: ${tieneViejo ? 'existe, hay que borrarlo' : 'ya no está'}`);
  log(`Índice patient_1 único: ${yaUnico ? 'ya está' : 'hay que crearlo'}`);

  if (commit) {
    if (tieneViejo) {
      await coll.dropIndex(INDICE_VIEJO);
      log(`  ✔ borrado ${INDICE_VIEJO}`);
    }
    // El no-único de antes estorba: un índice no se convierte, se rehace.
    if (patientUnico && !yaUnico) {
      await coll.dropIndex('patient_1');
      log('  ✔ borrado patient_1 (no único)');
    }
    if (!yaUnico) {
      await coll.createIndex({ patient: 1 }, { unique: true, name: 'patient_1' });
      log('  ✔ creado patient_1 ÚNICO');
    }
  }

  const total = await coll.countDocuments({});
  log('');
  log(`RESUMEN: ${fundidas} ficha(s) absorbida(s), ${seguimientosMovidos} seguimiento(s) reunidos, ${camposRellenados} campo(s) rellenados.`);
  log(`Fichas en total: ${total}`);
  if (!commit) log('\n(DRY-RUN: no se ha escrito nada. Usa --commit para aplicarlo.)');

  return { pacientes: grupos.length, fundidas, seguimientosMovidos, camposRellenados, total };
}

async function runOnce({ key = TASK_KEY, force = false } = {}) {
  const log = (m) => console.log(m);
  const previa = await OneTimeTask.findById(key).lean();

  if (previa?.status === 'DONE' && !force) {
    log(`✅  La tarea "${key}" ya se ejecutó (${previa.finishedAt}). No se hace nada.`);
    return { skipped: true, status: 'DONE' };
  }
  if (previa?.status === 'RUNNING' && Date.now() - new Date(previa.startedAt).getTime() < STALE_RUNNING_MS && !force) {
    log(`⏳  La tarea "${key}" está en curso en ${previa.host}. No se hace nada.`);
    return { skipped: true, status: 'RUNNING' };
  }

  const marca = { status: 'RUNNING', startedAt: new Date(), host: os.hostname(), error: null };
  if (previa) {
    await OneTimeTask.updateOne({ _id: key }, { $set: marca, $inc: { attempts: 1 } });
  } else {
    await OneTimeTask.create({ _id: key, ...marca, attempts: 1 });
  }

  try {
    const result = await fundirHistorias({ commit: true, log });
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

  console.log('\n=== UNA historia clínica por paciente (tarea de una sola vez) ===');
  console.log(`Clave de la tarea: ${key}`);
  console.log(commit ? 'MODO: COMMIT (funde las fichas de verdad).' : 'MODO: DRY-RUN (solo informa). Usa --commit para aplicar.');
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
      await fundirHistorias({ commit: false });
      return;
    }
    await runOnce({ key, force });
  } finally {
    await disconnect();
  }
}

module.exports = { fundirHistorias, elegirGanadora, runOnce, TASK_KEY, BACKUP_COLL };

if (require.main === module) {
  main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}
