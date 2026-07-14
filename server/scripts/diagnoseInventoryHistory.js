/**
 * DIAGNÓSTICOS HISTÓRICOS DE INVENTARIO (SOLO LECTURA).
 *
 * Tres males que dejó el código anterior y que NO se pueden corregir a ciegas:
 *
 *   1. CAPAS SIN BODEGA — las tomas físicas ajustaban sin bodega (`receiveStock` sin
 *      `warehouse`), así que crearon capas con `warehouse: null`. Esas unidades existen y valen
 *      dinero, pero no están en ninguna bodega. La bodega real solo se puede INFERIR (por la
 *      compra que las originó, o porque el producto solo vive en una bodega). Si no es
 *      demostrable, no se toca: adivinarla movería stock físico en los papeles.
 *
 *   2. MOVIMIENTOS SIN FECHA FUNCIONAL — `movementDate` no existía; el kardex caía a
 *      `createdAt` (la fecha de GRABACIÓN). La fecha real es la del documento origen (compra,
 *      venta, toma). Solo es inequívoca cuando el documento existe y tiene fecha.
 *
 *   3. STOCK GLOBAL ≠ SUMA POR BODEGA — `Product.stock` es un agregado de apoyo; la verdad son
 *      las capas. Si no cuadran, hay que saber POR QUÉ antes de tocar nada: sobrescribir
 *      `Product.stock` puede tapar un problema real de capas (o al revés).
 *
 * Uso:
 *   node scripts/diagnoseInventoryHistory.js --clinic=<id>                    (todo, dry-run)
 *   node scripts/diagnoseInventoryHistory.js --clinic=<id> --only=layers
 *   node scripts/diagnoseInventoryHistory.js --clinic=<id> --only=dates --commit
 *
 * `--commit` SOLO existe para las fechas, y solo para los casos INEQUÍVOCOS (un único documento
 * origen con fecha propia). Las capas sin bodega y el stock nunca se corrigen automáticamente.
 */
const mongoose = require('mongoose');
const { parseArgs, connect, disconnect, banner } = require('./_common');
const InventoryLayer = require('../models/InventoryLayer');
const InventoryMovement = require('../models/InventoryMovement');
const Product = require('../models/Product');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const Sale = require('../models/Sale');
const PhysicalCount = require('../models/PhysicalCount');

const r2 = (n) => +Number(n || 0).toFixed(2);
const r4 = (n) => +Number(n || 0).toFixed(4);
const money = (n) => Number(n || 0).toFixed(2);

// ═══════════════ 1 · CAPAS SIN BODEGA ═══════════════

/**
 * @returns {{total, conConsumo, inferibles, ambiguas, filas}} `filas[].confianza`:
 *   ALTA   → la compra origen declara una bodega, o el producto solo tiene capas en una.
 *   MEDIA  → el producto tiene una sola bodega con movimientos, pero el origen no lo dice.
 *   NINGUNA→ no hay forma de saberlo: NO se corrige.
 */
async function layersWithoutWarehouse({ clinic = null } = {}) {
  const base = clinic ? { clinic } : {};
  const capas = await InventoryLayer.find({ ...base, warehouse: null }).lean();
  const out = { total: capas.length, conConsumo: 0, inferibles: 0, ambiguas: 0, valor: 0, filas: [] };
  if (!capas.length) return out;

  const productIds = [...new Set(capas.map((c) => String(c.product)))];
  // Bodegas donde ESE producto sí tiene capas: si es exactamente una, es la candidata.
  const otras = await InventoryLayer.aggregate([
    {
      $match: {
        ...(clinic ? { clinic: new mongoose.Types.ObjectId(String(clinic)) } : {}),
        product: { $in: capas.map((c) => c.product) },
        warehouse: { $ne: null },
      },
    },
    { $group: { _id: { product: '$product', warehouse: '$warehouse' }, qty: { $sum: '$qtyInitial' } } },
  ]);
  const bodegasDe = new Map();
  for (const o of otras) {
    const k = String(o._id.product);
    bodegasDe.set(k, [...(bodegasDe.get(k) || []), o._id.warehouse]);
  }
  const compras = await PurchaseInvoice.find({
    ...base, _id: { $in: capas.filter((c) => c.sourceModel === 'PurchaseInvoice').map((c) => c.sourceRef) },
  }).select('serie fechaEmision items.warehouse items.product').lean();
  const compraPorId = new Map(compras.map((c) => [String(c._id), c]));

  for (const c of capas) {
    const consumida = r4(c.qtyInitial - c.qtyRemaining);
    if (consumida > 0.00001) out.conConsumo += 1;
    out.valor = r2(out.valor + c.qtyRemaining * c.unitCost);

    // ¿La compra origen declara bodega para ese producto?
    let inferida = null;
    let confianza = 'NINGUNA';
    let razon = 'No hay evidencia de a qué bodega pertenece.';
    const compra = c.sourceModel === 'PurchaseInvoice' ? compraPorId.get(String(c.sourceRef)) : null;
    const linea = compra?.items?.find((i) => String(i.product) === String(c.product) && i.warehouse);
    if (linea?.warehouse) {
      inferida = linea.warehouse;
      confianza = 'ALTA';
      razon = `La compra ${compra.serie || compra._id} declara esa bodega para el producto.`;
    } else {
      const candidatas = [...new Set((bodegasDe.get(String(c.product)) || []).map(String))];
      if (candidatas.length === 1) {
        [inferida] = candidatas;
        confianza = 'MEDIA';
        razon = 'El producto solo tiene capas en una bodega; es la única candidata.';
      } else if (candidatas.length > 1) {
        razon = `El producto vive en ${candidatas.length} bodegas: no se puede saber cuál.`;
      }
    }
    if (confianza === 'NINGUNA') out.ambiguas += 1;
    else out.inferibles += 1;

    out.filas.push({
      capa: String(c._id),
      product: String(c.product),
      origen: c.sourceModel ? `${c.sourceModel}:${c.sourceRef}` : '(sin origen)',
      date: c.date,
      qtyInitial: c.qtyInitial,
      qtyRemaining: c.qtyRemaining,
      consumida,
      unitCost: c.unitCost,
      bodegaInferida: inferida ? String(inferida) : null,
      confianza,
      razon,
      // Una capa YA CONSUMIDA no se puede reasignar sin reescribir el costo de las salidas.
      corregible: confianza === 'ALTA' && consumida <= 0.00001,
    });
  }
  void productIds;
  return out;
}

// ═══════════════ 2 · MOVIMIENTOS SIN FECHA FUNCIONAL ═══════════════

async function movementsWithoutDate({ clinic = null, commit = false } = {}) {
  const base = clinic ? { clinic } : {};
  const movs = await InventoryMovement.find({ ...base, movementDate: null }).lean();
  const out = { total: movs.length, inequivocos: 0, ambiguos: 0, corregidos: 0, filas: [] };
  if (!movs.length) return out;

  const idsPorModelo = (m) => movs.filter((x) => x.sourceModel === m).map((x) => x.sourceRef).filter(Boolean);
  const [compras, ventas, tomas] = await Promise.all([
    PurchaseInvoice.find({ ...base, _id: { $in: idsPorModelo('PurchaseInvoice') } }).select('serie fechaEmision').lean(),
    Sale.find({ ...base, _id: { $in: idsPorModelo('Sale') } }).select('saleNumber createdAt').lean(),
    PhysicalCount.find({ ...base, _id: { $in: idsPorModelo('PhysicalCount') } }).select('code date confirmedAt').lean(),
  ]);
  const fechaDoc = new Map([
    ...compras.map((c) => [String(c._id), { fecha: c.fechaEmision, doc: `Compra ${c.serie || ''}` }]),
    ...ventas.map((s) => [String(s._id), { fecha: s.createdAt, doc: `Venta ${s.saleNumber}` }]),
    ...tomas.map((t) => [String(t._id), { fecha: t.date || t.confirmedAt, doc: `Toma ${t.code}` }]),
  ]);

  for (const m of movs) {
    const cand = m.sourceRef ? fechaDoc.get(String(m.sourceRef)) : null;
    const inequivoco = !!cand?.fecha;
    if (inequivoco) out.inequivocos += 1; else out.ambiguos += 1;
    out.filas.push({
      movimiento: String(m._id),
      tipo: m.type,
      createdAt: m.createdAt,
      documento: cand?.doc || (m.sourceModel ? `${m.sourceModel} (no encontrado)` : '(sin documento origen)'),
      fechaCandidata: cand?.fecha || null,
      confianza: inequivoco ? 'ALTA' : 'NINGUNA',
      conflicto: inequivoco && cand.fecha > m.createdAt
        ? 'La fecha del documento es POSTERIOR a la de grabación: revisar.'
        : null,
    });
    if (commit && inequivoco) {
      // Solo lo inequívoco: un movimiento sin documento origen NO se inventa una fecha.
      /* eslint-disable no-await-in-loop */
      await InventoryMovement.updateOne(
        { _id: m._id, movementDate: null },
        { $set: { movementDate: cand.fecha, dateSource: 'DOCUMENTO' } }
      );
      /* eslint-enable no-await-in-loop */
      out.corregidos += 1;
    }
  }
  return out;
}

// ═══════════════ 3 · STOCK GLOBAL vs CAPAS POR BODEGA ═══════════════

async function stockConsistency({ clinic = null } = {}) {
  const base = clinic ? { clinic } : {};
  const productos = await Product.find({ ...base, unlimited: { $ne: true }, category: { $ne: 'servicio' } })
    .select('code name stock clinic').lean();
  const capas = await InventoryLayer.aggregate([
    // El `$match` de una agregación NO castea: la clínica va como ObjectId real.
    { $match: { ...(clinic ? { clinic: new mongoose.Types.ObjectId(String(clinic)) } : {}), qtyRemaining: { $gt: 0 } } },
    {
      $group: {
        _id: { product: '$product', warehouse: '$warehouse' },
        qty: { $sum: '$qtyRemaining' },
        value: { $sum: { $multiply: ['$qtyRemaining', '$unitCost'] } },
      },
    },
  ]);
  const porProducto = new Map();
  for (const c of capas) {
    const k = String(c._id.product);
    const cur = porProducto.get(k) || { qty: 0, value: 0, sinBodega: 0, bodegas: 0 };
    cur.qty = r4(cur.qty + c.qty);
    cur.value = r2(cur.value + c.value);
    if (!c._id.warehouse) cur.sinBodega = r4(cur.sinBodega + c.qty);
    else cur.bodegas += 1;
    porProducto.set(k, cur);
  }

  const out = { revisados: 0, descuadrados: 0, negativos: 0, conCapasSinBodega: 0, filas: [] };
  for (const p of productos) {
    const c = porProducto.get(String(p._id)) || { qty: 0, value: 0, sinBodega: 0, bodegas: 0 };
    const global = r4(p.stock || 0);
    const dif = r4(global - c.qty);
    out.revisados += 1;
    if (global < 0) out.negativos += 1;
    if (c.sinBodega > 0.00001) out.conCapasSinBodega += 1;
    if (Math.abs(dif) <= 0.00001 && c.sinBodega <= 0.00001) continue;
    out.descuadrados += 1;

    let clasificacion = 'DESCUADRE_SIN_EXPLICAR';
    if (c.sinBodega > 0.00001 && Math.abs(dif) <= 0.00001) clasificacion = 'CAPAS_SIN_BODEGA';
    else if (global > c.qty) clasificacion = 'STOCK_GLOBAL_MAYOR (faltan capas o hubo salidas sin capa)';
    else if (global < c.qty) clasificacion = 'CAPAS_MAYORES (el stock global se quedó atrás)';

    out.filas.push({
      product: String(p._id),
      code: p.code,
      name: p.name,
      stockGlobal: global,
      capasQty: c.qty,
      capasValor: c.value,
      sinBodega: c.sinBodega,
      bodegas: c.bodegas,
      diferencia: dif,
      clasificacion,
    });
  }
  return out;
}

/** Diagnóstico completo (puro: las pruebas ejercitan ESTE código). */
async function diagnose({ clinic = null, commit = false, only = null } = {}) {
  const res = {};
  if (!only || only === 'layers') {
    res.capas = await layersWithoutWarehouse({ clinic });
    console.log('\n1) CAPAS SIN BODEGA');
    console.log(`   total ................ ${res.capas.total} (valor vivo ${money(res.capas.valor)})`);
    console.log(`   con consumo posterior  ${res.capas.conConsumo}`);
    console.log(`   bodega inferible ..... ${res.capas.inferibles}`);
    console.log(`   AMBIGUAS (no se tocan) ${res.capas.ambiguas}`);
    for (const f of res.capas.filas.slice(0, 50)) {
      console.log(`   · capa ${f.capa} · ${f.origen} · ${f.qtyRemaining}/${f.qtyInitial} @ ${money(f.unitCost)}`
        + ` → ${f.bodegaInferida || '—'} [${f.confianza}] ${f.corregible ? '(corregible)' : ''}`);
      console.log(`     ${f.razon}`);
    }
    console.log('   NO se corrige automáticamente: mover stock a una bodega equivocada es peor que no moverlo.');
  }
  if (!only || only === 'dates') {
    res.fechas = await movementsWithoutDate({ clinic, commit });
    console.log('\n2) MOVIMIENTOS SIN FECHA FUNCIONAL');
    console.log(`   total ................ ${res.fechas.total}`);
    console.log(`   inequívocos .......... ${res.fechas.inequivocos}`);
    console.log(`   sin documento origen . ${res.fechas.ambiguos}`);
    if (commit) console.log(`   CORREGIDOS ........... ${res.fechas.corregidos}`);
    else if (res.fechas.inequivocos) console.log('   Usa --commit --only=dates para completar SOLO los inequívocos.');
  }
  if (!only || only === 'stock') {
    res.stock = await stockConsistency({ clinic });
    console.log('\n3) STOCK GLOBAL vs CAPAS POR BODEGA');
    console.log(`   productos revisados .. ${res.stock.revisados}`);
    console.log(`   descuadrados ......... ${res.stock.descuadrados}`);
    console.log(`   con capas sin bodega . ${res.stock.conCapasSinBodega}`);
    console.log(`   con stock negativo ... ${res.stock.negativos}`);
    for (const f of res.stock.filas.slice(0, 50)) {
      console.log(`   · ${f.code} ${f.name}: global ${f.stockGlobal} vs capas ${f.capasQty}`
        + ` (dif ${f.diferencia}, sin bodega ${f.sinBodega}) [${f.clasificacion}]`);
    }
    console.log('   `Product.stock` NO se sobrescribe: primero hay que saber qué fuente dice la verdad.');
  }
  return res;
}

async function run() {
  const { clinic, commit, dryRun } = parseArgs();
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const only = onlyArg ? onlyArg.split('=')[1] : null;
  banner('Diagnóstico histórico de inventario', { dryRun, clinic });
  await connect();
  try {
    return await diagnose({ clinic, commit, only });
  } finally {
    await disconnect();
  }
}

if (require.main === module) {
  run().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}

module.exports = { run, diagnose, layersWithoutWarehouse, movementsWithoutDate, stockConsistency };
