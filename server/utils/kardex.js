const InventoryLayer = require('../models/InventoryLayer');

function round2(n) {
  return +Number(n || 0).toFixed(2);
}
function round4(n) {
  return +Number(n || 0).toFixed(4);
}

/**
 * Planifica el consumo FIFO de una cantidad contra una lista de capas (ya
 * ordenadas por fecha asc). Función pura, sin DB, para poder probarla aislada.
 *
 * @returns {{ plan: Array<{layerId, qty, unitCost}>, totalCost, shortfall }}
 */
function planConsumption(layers, qty) {
  let remaining = round4(qty);
  const plan = [];
  let totalCost = 0;
  for (const layer of layers) {
    if (remaining <= 0.00001) break;
    const available = round4(layer.qtyRemaining);
    if (available <= 0) continue;
    const take = Math.min(available, remaining);
    plan.push({ layerId: layer._id || layer.id || null, qty: round4(take), unitCost: layer.unitCost });
    totalCost = round2(totalCost + take * layer.unitCost);
    remaining = round4(remaining - take);
  }
  return { plan, totalCost, shortfall: round4(Math.max(0, remaining)) };
}

function withSession(query, session) {
  return session ? query.session(session) : query;
}

/**
 * Registra una entrada de stock creando una capa valorada.
 */
async function receiveStock({ clinicId, product, warehouse = null, lot = '', expiryDate = null,
  quantity, unitCost, date = new Date(), sourceModel = null, sourceRef = null, userId = null }, session) {
  const qty = round4(quantity);
  if (qty <= 0) throw Object.assign(new Error('Cantidad de entrada inválida'), { status: 400 });
  const [layer] = await InventoryLayer.create([{
    clinic: clinicId,
    product,
    warehouse,
    lot: lot || '',
    expiryDate: expiryDate || null,
    qtyInitial: qty,
    qtyRemaining: qty,
    unitCost: round4(Math.max(0, unitCost)),
    date,
    sourceModel,
    sourceRef,
    createdBy: userId,
  }], session ? { session } : {});
  return layer;
}

/**
 * Consume stock por FIFO (o por lote específico si se indica). Aplica el plan a
 * las capas y devuelve el costo total de la salida y el detalle consumido.
 */
async function issueStock({ clinicId, product, warehouse = null, quantity, lot = null, allowNegative = false }, session) {
  const qty = round4(quantity);
  if (qty <= 0) throw Object.assign(new Error('Cantidad de salida inválida'), { status: 400 });

  const filter = { clinic: clinicId, product, qtyRemaining: { $gt: 0 } };
  if (warehouse) filter.warehouse = warehouse;
  if (lot) filter.lot = lot;
  const layers = await withSession(
    InventoryLayer.find(filter).sort({ date: 1, createdAt: 1 }),
    session
  );

  const { plan, totalCost, shortfall } = planConsumption(layers, qty);
  if (shortfall > 0.00001 && !allowNegative) {
    throw Object.assign(new Error('Stock insuficiente en capas de inventario'), { status: 400 });
  }

  const byId = new Map(layers.map((l) => [String(l._id), l]));
  for (const p of plan) {
    const layer = byId.get(String(p.layerId));
    if (!layer) continue;
    layer.qtyRemaining = round4(layer.qtyRemaining - p.qty);
    if (layer.qtyRemaining <= 0.00001) {
      layer.qtyRemaining = 0;
      layer.exhausted = true;
    }
    await layer.save({ session });
  }

  return { totalCost: round2(totalCost), consumption: plan, shortfall };
}

/**
 * Revierte una salida devolviendo las cantidades a sus capas originales.
 * `consumption` es el detalle guardado al emitir (layerId + qty).
 */
async function reverseIssue({ consumption }, session) {
  for (const c of consumption || []) {
    if (!c.layerId) continue;
    const layer = await withSession(InventoryLayer.findById(c.layerId), session);
    if (!layer) continue;
    layer.qtyRemaining = round4(layer.qtyRemaining + c.qty);
    if (layer.qtyRemaining > 0) layer.exhausted = false;
    await layer.save({ session });
  }
}

/**
 * Revierte entradas creadas por un documento fuente (p.ej. anulación de compra):
 * descuenta de cada capa lo que aún queda. Si una capa ya fue consumida en parte,
 * solo se puede retirar lo remanente (limitación conocida del FIFO ante consumo
 * cruzado; el resto debería corregirse con un ajuste/merma explícito).
 */
async function reverseReceiptBySource({ clinicId, sourceModel, sourceRef }, session) {
  const layers = await withSession(
    InventoryLayer.find({ clinic: clinicId, sourceModel, sourceRef }),
    session
  );
  let removed = 0;
  let blocked = 0;
  for (const layer of layers) {
    const consumed = round4(layer.qtyInitial - layer.qtyRemaining);
    blocked = round4(blocked + consumed);
    removed = round4(removed + layer.qtyRemaining);
    layer.qtyRemaining = 0;
    layer.exhausted = true;
    await layer.save({ session });
  }
  return { removed, blocked };
}

/**
 * Stock y valor actuales (suma de capas vivas).
 */
async function currentStock({ clinicId, product, warehouse = null }, session) {
  const match = { clinic: clinicId, product, qtyRemaining: { $gt: 0 } };
  if (warehouse) match.warehouse = warehouse;
  const layers = await withSession(InventoryLayer.find(match), session);
  let qty = 0;
  let value = 0;
  for (const l of layers) {
    qty = round4(qty + l.qtyRemaining);
    value = round2(value + l.qtyRemaining * l.unitCost);
  }
  return { qty, value, averageCost: qty > 0 ? round4(value / qty) : 0 };
}

module.exports = {
  planConsumption,
  receiveStock,
  issueStock,
  reverseIssue,
  reverseReceiptBySource,
  currentStock,
  round2,
  round4,
};
