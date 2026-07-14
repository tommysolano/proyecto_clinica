/**
 * KARDEX VALORIZADO: motor ÚNICO de la pantalla, la API y el Excel.
 *
 * No es un listado de movimientos: es la historia valorada de un producto (opcionalmente en una
 * bodega), con su saldo en unidades Y en dinero, arrastrado desde antes del rango.
 *
 * ── Reglas duras ────────────────────────────────────────────────────────────────────────
 * · El rango NO empieza en cero: se calcula el SALDO INICIAL (unidades y valor) con todo lo
 *   anterior a `from`. Un kardex que arranca en cero miente sobre el inventario.
 * · La valoración sale de lo REAL: el costo grabado en el movimiento y el consumo FIFO de
 *   capas (`layerConsumption`). Nunca del `purchasePrice` actual del producto, que es el precio
 *   de HOY y no dice nada del costo histórico.
 * · La fecha es la FUNCIONAL (`movementDate`). Los movimientos históricos no la tienen: se cae a
 *   `createdAt` y se MARCA la fila (`dateSource: 'CREATED_AT'`), en vez de fingir.
 * · Un TRASLADO son dos movimientos (salida en origen, entrada en destino) con el mismo
 *   `transferGroup`: en el kardex de cada bodega se ve con su signo, y en el consolidado se
 *   reconoce como reubicación de efecto NETO CERO (no es compra ni venta).
 */
const mongoose = require('mongoose');
const InventoryMovement = require('../models/InventoryMovement');
const InventoryLayer = require('../models/InventoryLayer');
const Product = require('../models/Product');
const Warehouse = require('../models/Warehouse');
require('../models/User');   // el kardex popula el usuario del movimiento

const r2 = (n) => +Number(n || 0).toFixed(2);
const r4 = (n) => +Number(n || 0).toFixed(4);
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const endOfDay = (d) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };

/** 'YYYY-MM-DD' → medianoche LOCAL (Ecuador), no UTC. Ver docs/FLUJO_DE_CAJA.md. */
function parseLocalDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : new Date(value);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Fecha funcional de un movimiento y de dónde salió. */
function effectiveDate(m) {
  if (m.movementDate) return { date: m.movementDate, source: m.dateSource || 'MOVIMIENTO' };
  return { date: m.createdAt, source: 'CREATED_AT' };
}

/**
 * Efecto de un movimiento sobre una vista del kardex.
 *
 * `scope` es la bodega que se está mirando (o null = consolidado):
 *   · entrada / ajuste positivo → entra;
 *   · salida                    → sale;
 *   · traslado (legacy, sin patas): en el consolidado NO mueve nada; mirando una bodega,
 *     sale de la origen y entra en la destino.
 */
// La bodega puede venir populada (objeto) o como id: siempre se compara por id.
const idOf = (v) => String(v && typeof v === 'object' ? (v._id ?? v) : (v ?? ''));

function signedQty(m, scope) {
  const qty = r4(Math.abs(m.quantity));
  if (m.type === 'traslado') {
    if (!scope) return 0;                            // consolidado: reubicación, neto cero
    // La pata de SALIDA lleva `toWarehouse` (a dónde va); la de ENTRADA vive ya en su bodega
    // destino y no lo lleva. Así cada bodega ve su propio movimiento con el signo correcto.
    const esSalida = !!m.toWarehouse;
    if (idOf(m.warehouse) === idOf(scope)) return esSalida ? -qty : qty;
    return 0;
  }
  // Mirando UNA bodega, un movimiento de otra bodega no cuenta. (Los movimientos históricos sin
  // bodega solo se ven en el consolidado: no se pueden atribuir a ninguna.)
  if (scope && idOf(m.warehouse) !== idOf(scope)) return 0;
  if (m.type === 'salida') return -qty;
  if (m.type === 'entrada') return qty;
  // 'ajuste': el signo va en la cantidad (positivo sobrante, negativo faltante).
  return r4(m.quantity);
}

/** Costo unitario REAL del movimiento: el grabado, o el del consumo FIFO de capas. */
function unitCostOf(m) {
  const qty = Math.abs(Number(m.quantity) || 0);
  if (Number(m.unitCost) > 0) return r4(m.unitCost);
  if (Number(m.totalCost) > 0 && qty > 0) return r4(m.totalCost / qty);
  const cons = m.layerConsumption || [];
  if (cons.length) {
    const total = cons.reduce((s, c) => s + Number(c.qty || 0) * Number(c.unitCost || 0), 0);
    const q = cons.reduce((s, c) => s + Number(c.qty || 0), 0);
    if (q > 0) return r4(total / q);
  }
  return 0;
}

/**
 * SALDO INICIAL: unidades y valor ANTES de `from`.
 *
 * Las unidades salen de los movimientos (es la única historia completa). El valor sale del
 * costo real de cada movimiento. Cuando no hay corte de fechas, el saldo inicial es cero y el
 * kardex arranca desde el primer movimiento.
 */
async function openingBalance({ clinicId, product, warehouse = null, from = null }) {
  const base = { qty: 0, value: 0, unitCost: 0, movimientos: 0 };
  if (!from) return base;
  const match = { clinic: oid(clinicId), product: oid(product) };
  const previos = await InventoryMovement.find(match).lean();

  let qty = 0;
  let value = 0;
  let n = 0;
  for (const m of previos) {
    const { date } = effectiveDate(m);
    if (!date || date >= startOfDay(from)) continue;
    const q = signedQty(m, warehouse);
    if (!q) continue;
    n += 1;
    qty = r4(qty + q);
    value = r2(value + q * unitCostOf(m));
  }
  return {
    qty, value: r2(Math.max(0, value)), movimientos: n,
    unitCost: qty > 0 ? r4(Math.max(0, value) / qty) : 0,
  };
}

/**
 * Kardex completo. Devuelve saldo inicial, filas valorizadas, saldo final y totales.
 * De aquí salen la pantalla, la API y el Excel: no hay una segunda fórmula.
 */
async function buildKardex(clinicId, {
  product, warehouse = null, type = null, from = null, to = null,
  sourceModel = null, lot = null,
} = {}) {
  if (!product) throw Object.assign(new Error('Indica el producto'), { status: 400 });
  const desde = from ? startOfDay(parseLocalDate(from)) : null;
  const hasta = to ? endOfDay(parseLocalDate(to)) : null;

  const [prod, wh, todos] = await Promise.all([
    Product.findOne({ _id: product, clinic: clinicId })
      .select('code name unit stock averageCost category categoria inventoryCategory').lean(),
    warehouse ? Warehouse.findOne({ _id: warehouse, clinic: clinicId }).select('code name').lean() : null,
    InventoryMovement.find({ clinic: clinicId, product })
      .populate('warehouse toWarehouse', 'code name')
      .populate('createdBy', 'name')
      .lean(),
  ]);
  if (!prod) throw Object.assign(new Error('Producto no encontrado'), { status: 404 });

  const inicial = await openingBalance({ clinicId, product, warehouse, from: desde });

  // Orden cronológico por fecha FUNCIONAL (desempate estable por creación).
  const movimientos = todos
    .map((m) => ({ ...m, _eff: effectiveDate(m) }))
    .filter((m) => !!m._eff.date)
    .sort((a, b) => (a._eff.date - b._eff.date) || (new Date(a.createdAt) - new Date(b.createdAt)));

  let saldoQty = inicial.qty;
  let saldoValor = inicial.value;
  const rows = [];
  let entradasQty = 0;
  let salidasQty = 0;
  let entradasVal = 0;
  let salidasVal = 0;

  for (const m of movimientos) {
    const q = signedQty(m, warehouse);
    const dentroRango = (!desde || m._eff.date >= desde) && (!hasta || m._eff.date <= hasta);

    // Fuera del rango pero anterior: ya está en el saldo inicial. Posterior: no se muestra.
    if (!dentroRango) continue;
    // Filtros que no afectan al saldo inicial (son de presentación del detalle).
    if (warehouse && q === 0) continue;              // no toca esta bodega
    if (type && m.type !== type) continue;
    if (sourceModel && m.sourceModel !== sourceModel) continue;
    if (lot && (m.lot || '') !== lot) continue;

    const costo = unitCostOf(m);
    const valor = r2(Math.abs(q) * costo);
    const esEntrada = q > 0;
    saldoQty = r4(saldoQty + q);
    saldoValor = r2(saldoValor + q * costo);
    if (esEntrada) { entradasQty = r4(entradasQty + q); entradasVal = r2(entradasVal + valor); }
    else { salidasQty = r4(salidasQty + Math.abs(q)); salidasVal = r2(salidasVal + valor); }

    rows.push({
      id: String(m._id),
      date: m._eff.date,
      // La fila DICE de dónde salió su fecha: un histórico sin fecha funcional va marcado.
      dateSource: m._eff.source,
      fechaEstimada: m._eff.source === 'CREATED_AT',
      type: m.type,
      // Un traslado es una reubicación: se ve como tal, no como compra ni venta.
      esTraslado: m.type === 'traslado' || !!m.transferGroup,
      transferGroup: m.transferGroup ? String(m.transferGroup) : null,
      warehouse: m.warehouse || null,
      toWarehouse: m.toWarehouse || null,
      lot: m.lot || '',
      expiryDate: m.expiryDate || null,
      documento: m.sourceModel ? { model: m.sourceModel, ref: m.sourceRef } : null,
      journalEntry: m.journalEntry || null,
      referencia: m.reference || '',
      motivo: m.reason || '',
      tercero: m.reference || m.reason || '',
      entradaQty: esEntrada ? Math.abs(q) : 0,
      salidaQty: esEntrada ? 0 : Math.abs(q),
      unitCost: costo,
      entradaValor: esEntrada ? valor : 0,
      salidaValor: esEntrada ? 0 : valor,
      saldoQty,
      saldoValor: r2(Math.max(0, saldoValor)),
      costoPromedio: saldoQty > 0 ? r4(Math.max(0, saldoValor) / saldoQty) : 0,
      usuario: m.createdBy?.name || '',
      layerConsumption: (m.layerConsumption || []).map((c) => ({ qty: c.qty, unitCost: c.unitCost })),
    });
  }

  return {
    producto: prod,
    bodega: wh,
    rango: { from: desde, to: hasta },
    saldoInicial: inicial,
    rows,
    saldoFinal: {
      qty: saldoQty,
      value: r2(Math.max(0, saldoValor)),
      unitCost: saldoQty > 0 ? r4(Math.max(0, saldoValor) / saldoQty) : 0,
    },
    totales: {
      entradasQty, salidasQty, entradasValor: entradasVal, salidasValor: salidasVal,
      movimientos: rows.length,
      // Conciliación: inicial + entradas − salidas = final. Si no cuadra, se avisa.
      cuadra: Math.abs((inicial.qty + entradasQty - salidasQty) - saldoQty) <= 0.0001,
    },
  };
}

/**
 * Existencias VIVAS por bodega, leídas de las CAPAS (la fuente real del stock por bodega).
 * `Product.stock` es un agregado global de apoyo y NO se usa para decidir por bodega.
 */
async function stockByWarehouse({ clinicId, product = null, warehouse = null }) {
  const match = { clinic: oid(clinicId), qtyRemaining: { $gt: 0 } };
  if (product) match.product = oid(product);
  if (warehouse) match.warehouse = oid(warehouse);
  const agg = await InventoryLayer.aggregate([
    { $match: match },
    {
      $group: {
        _id: { product: '$product', warehouse: '$warehouse' },
        qty: { $sum: '$qtyRemaining' },
        value: { $sum: { $multiply: ['$qtyRemaining', '$unitCost'] } },
      },
    },
  ]);
  return agg.map((a) => ({
    product: a._id.product,
    warehouse: a._id.warehouse,
    qty: r4(a.qty),
    value: r2(a.value),
    unitCost: a.qty > 0 ? r4(a.value / a.qty) : 0,
  }));
}

/**
 * Quita TODO importe de un kardex ya calculado, para los roles sin `inventory.costs`.
 *
 * Se hace en el BACKEND, no ocultando columnas en React: lo que no se envía no se puede leer
 * abriendo la pestaña de red. Las cantidades se conservan (se puede trabajar con el inventario
 * sin ver cuánto costó).
 */
function stripCosts(data) {
  const sinDinero = (o) => ({ ...o, value: null, unitCost: null });
  return {
    ...data,
    costsHidden: true,
    saldoInicial: sinDinero(data.saldoInicial),
    saldoFinal: sinDinero(data.saldoFinal),
    rows: data.rows.map((r) => ({
      ...r,
      unitCost: null,
      entradaValor: null,
      salidaValor: null,
      saldoValor: null,
      costoPromedio: null,
      layerConsumption: [],
    })),
    totales: {
      ...data.totales,
      entradasValor: null,
      salidasValor: null,
    },
  };
}

module.exports = {
  buildKardex,
  stripCosts,
  openingBalance,
  stockByWarehouse,
  signedQty,
  unitCostOf,
  effectiveDate,
  parseLocalDate,
  r2,
  r4,
};
