#!/usr/bin/env node
/**
 * PRECIOS DE CONTÍFICO CON IVA — UNA SOLA VEZ.
 *
 * ─── POR QUÉ ───────────────────────────────────────────────────────────────────────
 * Los productos importados de Contífico guardaron `salePrice = pvp1`. En Contífico pvp1 es la
 * BASE (sus facturas: HIDRAURE pvp1 14.35 → base 14.35 + IVA 2.15 = 16.50), pero aquí el
 * producto lleva `priceIncludesVat: true` y `salePrice` es lo que paga el paciente. Resultado:
 * el cobro mostraba 14.35 y cobraba 14.35 con el IVA sacado de dentro (12.48 + 1.87), un 15 %
 * menos que en Contífico. Solo afecta a productos con IVA > 0; los de tarifa 0 están bien.
 *
 * ─── QUÉ HACE ──────────────────────────────────────────────────────────────────────
 * Para cada producto con IVA > 0 y precio con IVA incluido que tenga en su sucursal un registro
 * de Contífico con el MISMO código y cuyo precio siga siendo exactamente el pvp1 (o sea, nadie
 * lo corrigió a mano), los precios de su lista iguales al pvp1 pasan a pvp1 × (1 + IVA) y
 * `salePrice` se resincroniza con el activo. Un precio que ya no es el pvp1 no se toca, por eso
 * repetirlo no vuelve a sumar el IVA. Los precios anteriores quedan en el `result` de la marca.
 *
 * ─── USO ───────────────────────────────────────────────────────────────────────────
 *   node scripts/preciosContificoConIvaOnce.js             (DRY-RUN: solo informa)
 *   node scripts/preciosContificoConIvaOnce.js --commit    (aplica una vez y deja marca)
 *   node scripts/preciosContificoConIvaOnce.js --commit --force   (repite aunque esté DONE)
 *   node scripts/preciosContificoConIvaOnce.js --estado    (solo muestra la marca)
 */
const os = require('os');
const { connect, disconnect } = require('./_common');

const OneTimeTask = require('../models/OneTimeTask');
const Product = require('../models/Product');
const ContificoRecord = require('../models/ContificoRecord');
const { decodeCompressedJson } = require('../utils/compressedJson');
const { pvpConIva } = require('../utils/contificoPrice');

const TASK_KEY = 'precios-contifico-con-iva-2026-10-13';
const STALE_RUNNING_MS = 30 * 60 * 1000;
const SIN_IVA = ['IVA_0', 'EXENTO', 'NO_OBJETO'];
const igual = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

async function corregirPrecios({ commit = false, log = console.log } = {}) {
  // pvp1 y tarifa de Contífico por código+sucursal (así se enlazan al importar).
  const contifico = new Map();
  const registros = await ContificoRecord.find({ entity: 'product' })
    .select('clinic payloadCompressed').lean();
  for (const r of registros) {
    let p;
    try { p = decodeCompressedJson(r.payloadCompressed); } catch { continue; }
    const code = String(p?.codigo || '').trim();
    if (code) contifico.set(`${code}|${r.clinic}`, { pvp1: Number(p.pvp1) || 0, iva: Number(p.porcentaje_iva) || 0 });
  }
  log(`   • Productos de Contífico leídos: ${contifico.size}`);

  const productos = await Product.find({
    taxRate: { $gt: 0 }, taxCategory: { $nin: SIN_IVA }, priceIncludesVat: { $ne: false },
  }).select('_id code name clinic salePrice salePrices taxRate').lean();

  const cambios = [];
  for (const p of productos) {
    const ctf = contifico.get(`${String(p.code || '').trim()}|${p.clinic}`);
    if (!ctf || ctf.iva <= 0 || !igual(p.salePrice, ctf.pvp1)) continue;
    const conIva = pvpConIva(ctf.pvp1, ctf.iva);
    const lista = (p.salePrices || []).length
      ? p.salePrices.map((s) => ({ ...s, price: igual(s.price, ctf.pvp1) ? conIva : s.price }))
      : [{ name: 'General', price: conIva, active: true }];
    const activo = lista.find((s) => s.active) || lista[0];
    cambios.push({ _id: p._id, code: p.code, name: p.name, antes: p.salePrice, despues: activo.price, lista });
  }

  for (const c of cambios.slice(0, 15)) log(`   ${commit ? '✅' : '•'} ${c.code} ${c.name}: $${c.antes.toFixed(2)} → $${c.despues.toFixed(2)}`);
  if (cambios.length > 15) log(`   … y ${cambios.length - 15} más`);

  if (!commit) {
    log(`\nDRY-RUN: se corregirían ${cambios.length} producto(s). Ejecuta con --commit para aplicar.`);
    return { productos: cambios.length, dryRun: true };
  }
  for (let i = 0; i < cambios.length; i += 500) {
    // eslint-disable-next-line no-await-in-loop
    await Product.bulkWrite(cambios.slice(i, i + 500).map((c) => ({
      updateOne: { filter: { _id: c._id }, update: { $set: { salePrices: c.lista, salePrice: c.despues } } },
    })), { ordered: false });
  }
  log(`\n✅  ${cambios.length} producto(s) pasaron a precio con IVA.`);
  return {
    productos: cambios.length,
    detalle: cambios.map((c) => ({ id: String(c._id), code: c.code, antes: c.antes, despues: c.despues })),
  };
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
    const result = await corregirPrecios({ commit: true, log });
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

  console.log('\n=== PRECIOS DE CONTÍFICO CON IVA (tarea de una sola vez) ===');
  console.log(`Clave de la tarea: ${key}`);
  console.log(commit ? 'MODO: COMMIT (cambia los precios de verdad).' : 'MODO: DRY-RUN (solo informa). Usa --commit para aplicar.');
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
      await corregirPrecios({ commit: false });
      return;
    }
    await runOnce({ key, force });
  } finally {
    await disconnect();
  }
}

module.exports = { corregirPrecios, runOnce, TASK_KEY };

if (require.main === module) {
  main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}
