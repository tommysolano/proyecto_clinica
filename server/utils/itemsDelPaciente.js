/**
 * ÍTEMS DEL PACIENTE E ÍTEMS VINCULADOS (oct-2026). Ver models/PatientItem y
 * `Product.linkedItems`.
 *
 * Regla de la clínica (20-10-2026): el inventario se descuenta AL COBRAR. La única
 * excepción es lo que el paciente compra y NO se lleva: queda a su nombre en la
 * clínica y sale del inventario cuando vuelve a aplicárselo (en el cobro del servicio
 * que lo usa, o con «Aplicar» desde su perfil). Así no se le cobra dos veces.
 *
 * Con stock corto NO se traba la caja (el stock local se iguala con Contífico cada
 * hora y a veces dice 0 teniendo): se descuenta lo que haya, el kardex valora el
 * faltante al costo promedio y se devuelve un aviso.
 */
const PatientItem = require('../models/PatientItem');
const Product = require('../models/Product');
const InventoryMovement = require('../models/InventoryMovement');
const kardex = require('./kardex');

const idDe = (v) => (v ? String(v._id || v) : null);
const esIlimitado = (p) => !p || p.unlimited === true || p.category === 'servicio' || p.category === 'programa';
const r2 = (n) => +Number(n || 0).toFixed(2);
const err = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

/** De estos productos, los que son ítem vinculado de algún otro (Set de ids). */
async function componentesVinculados(productIds, session = null) {
  const ids = [...new Set((productIds || []).map(idDe).filter(Boolean))];
  if (!ids.length) return new Set();
  const filas = await Product.find({ 'linkedItems.product': { $in: ids } })
    .select('linkedItems.product').session(session).lean();
  const buscados = new Set(ids);
  const out = new Set();
  for (const f of filas) for (const l of f.linkedItems || []) if (buscados.has(idDe(l.product))) out.add(idDe(l.product));
  return out;
}

/**
 * Deja a nombre del paciente lo que compró en esta venta: lo que NO se lleva
 * ('en_clinica') y lo que se lleva siendo ítem vinculado de algún servicio
 * ('llevado', para avisar el día que lo traiga).
 */
async function crearDesdeVenta({ sale, items, userId, session }) {
  if (!sale.patient) return [];
  const llevados = items.filter((i) => i.delivery === 'llevado').map((i) => i.product);
  const comps = llevados.length ? await componentesVinculados(llevados, session) : new Set();
  const docs = items
    .filter((i) => i.delivery === 'en_clinica' || (i.delivery === 'llevado' && comps.has(idDe(i.product))))
    .map((i) => ({
      clinic: sale.clinic,
      patient: sale.patient,
      product: i.product,
      productCode: i.productCode || '',
      productName: i.productName || '',
      mode: i.delivery,
      quantity: Number(i.quantity),
      remaining: Number(i.quantity),
      sale: sale._id,
      saleNumber: sale.saleNumber || '',
      date: sale.createdAt || new Date(),
      createdBy: userId,
    }));
  if (!docs.length) return [];
  return PatientItem.insertMany(docs, { session });
}

/**
 * Gasta `quantity` de las compras del paciente de ese producto y modo, de la más
 * antigua a la más nueva. Con `strict` falla si no alcanza; sin él gasta lo que
 * haya (lo que «trajo» puede venir de una compra en otra parte).
 * Devuelve { usados: [{holding, quantity}], falta }.
 */
async function consumir({
  patient, product, productName = '', quantity, mode, clinics = null, strict = false,
  sale = null, saleNumber = '', detail = '', clinic = null, userId = null, userName = '', stockMoved = 0, session = null,
}) {
  let falta = Number(quantity) || 0;
  const usados = [];
  if (!patient || falta <= 0) return { usados, falta };
  const candidatos = await PatientItem.find({
    patient, product, mode, status: 'activo', remaining: { $gt: 0 },
    ...(clinics ? { clinic: { $in: clinics } } : {}),
  }).sort({ date: 1, _id: 1 }).session(session);
  for (const c of candidatos) {
    if (falta <= 1e-9) break;
    const toma = Math.min(falta, Number(c.remaining));
    // Condicional: dos cobros a la vez no pueden gastar la misma ampolla.
    const hecho = await PatientItem.findOneAndUpdate(
      { _id: c._id, status: 'activo', remaining: { $gte: toma } },
      {
        $inc: { remaining: -toma },
        $push: { uses: { at: new Date(), quantity: toma, sale, saleNumber, detail, clinic, by: userId, byName: userName, stockMoved: stockMoved ? toma : 0 } },
      },
      { new: true, session },
    );
    if (!hecho) continue;
    usados.push({ holding: c._id, quantity: toma });
    falta = +(falta - toma).toFixed(6);
  }
  if (strict && falta > 1e-9) {
    const tiene = +(Number(quantity) - falta).toFixed(4);
    throw err(400, `El paciente tiene ${tiene} de «${productName || 'este ítem'}» guardado${tiene === 1 ? '' : 's'} en la clínica; no alcanza para ${quantity}.`, { code: 'PATIENT_ITEM_INSUFICIENTE' });
  }
  return { usados, falta };
}

/**
 * SALIDA DE INVENTARIO de un ítem que se usa (vinculado de una venta o aplicado a
 * mano): baja `Product.stock` (sin pasar de 0), consume capas FIFO del kardex (lo
 * que falte se valora al costo promedio) y deja el movimiento. No traba por stock:
 * devuelve un `aviso`.
 */
async function salidaDeInventario({
  clinicId, product, quantity, warehouse = null, costCenter = null, reason, reference = '',
  sourceModel, sourceRef, movementDate = new Date(), userId, session,
}) {
  const qty = Number(quantity) || 0;
  if (qty <= 0 || esIlimitado(product)) return { stockMoved: 0, cost: 0, aviso: null };
  const fresco = await Product.findById(product._id).select('name stock averageCost purchasePrice').session(session);
  const disponible = Math.max(0, Number(fresco?.stock || 0));
  const toma = Math.min(qty, disponible);
  if (toma > 0) await Product.updateOne({ _id: product._id }, { $inc: { stock: -toma } }, { session });
  const aviso = toma < qty
    ? `«${fresco?.name || product.name}»: se usaron ${qty} y el inventario tenía ${disponible}. Revisa el stock de ese ítem.`
    : null;
  const issue = await kardex.issueStock({
    clinicId, product: product._id, warehouse, quantity: qty, allowNegative: true,
  }, session);
  let cost = issue.totalCost;
  if (issue.shortfall > 0.00001) {
    cost = r2(cost + issue.shortfall * Number(fresco?.averageCost || fresco?.purchasePrice || 0));
  }
  const cur = await kardex.currentStock({ clinicId, product: product._id }, session);
  await Product.updateOne({ _id: product._id, clinic: clinicId }, { $set: { averageCost: cur.averageCost } }, { session });
  await InventoryMovement.create([{
    clinic: clinicId,
    product: product._id,
    type: 'salida',
    quantity: qty,
    unitCost: qty > 0 ? +(cost / qty).toFixed(4) : 0,
    totalCost: cost,
    balanceAfter: cur.qty,
    layerConsumption: issue.consumption.map((c) => ({ layer: c.layerId, qty: c.qty, unitCost: c.unitCost })),
    warehouse: warehouse || null,
    costCenter: costCenter || null,
    movementDate,
    dateSource: 'DOCUMENTO',
    reason,
    reference,
    sourceModel,
    sourceRef,
    createdBy: userId,
  }], { session });
  return { stockMoved: toma, cost: r2(cost), aviso };
}

/** Lo que el paciente tiene a su nombre (con saldo), de las sucursales indicadas. */
async function delPaciente(patientId, clinics = null, { soloConSaldo = true } = {}) {
  const filas = await PatientItem.find({
    patient: patientId,
    status: 'activo',
    ...(soloConSaldo ? { remaining: { $gt: 0 } } : {}),
    ...(clinics ? { clinic: { $in: clinics } } : {}),
  }).sort({ date: 1, _id: 1 }).lean();
  return filas.map((f) => ({
    _id: f._id,
    product: f.product,
    productCode: f.productCode,
    productName: f.productName,
    mode: f.mode,
    quantity: f.quantity,
    remaining: f.remaining,
    saleNumber: f.saleNumber,
    sale: f.sale,
    date: f.date,
    clinic: f.clinic,
    uses: (f.uses || []).map((u) => ({
      at: u.at, quantity: u.quantity, saleNumber: u.saleNumber, detail: u.detail, byName: u.byName,
    })),
  }));
}

/**
 * Anular una venta: lo que DEJÓ a nombre del paciente se anula —salvo que ya se
 * haya usado fuera de esta misma venta (se le aplicó: eso no se devuelve)— y lo
 * que GASTÓ de compras anteriores vuelve a estar disponible.
 */
async function anularDeVenta({ saleId, session }) {
  const sid = idDe(saleId);
  const propios = await PatientItem.find({ sale: sid, status: 'activo' }).session(session);
  for (const p of propios) {
    const ajeno = (p.uses || []).find((u) => !u.sale || idDe(u.sale) !== sid);
    if (ajeno) {
      const donde = ajeno.sale
        ? `en la venta ${ajeno.saleNumber || ''}`.trim()
        : `el ${new Date(ajeno.at).toLocaleDateString('es-EC', { timeZone: 'America/Guayaquil' })}`;
      throw err(409, `«${p.productName}» que el paciente dejó en esta venta ya se le aplicó (${donde}). No se puede anular.`, { code: 'PATIENT_ITEM_USADO' });
    }
  }
  for (const p of propios) {
    p.status = 'anulado';
    p.remaining = 0;
    p.voidedAt = new Date();
    await p.save({ session });
  }
  const gastados = await PatientItem.find({ 'uses.sale': sid }).session(session);
  for (const g of gastados) {
    const mios = (g.uses || []).filter((u) => idDe(u.sale) === sid);
    if (!mios.length) continue;
    g.uses = (g.uses || []).filter((u) => idDe(u.sale) !== sid);
    if (g.status === 'activo') g.remaining = +(Number(g.remaining) + mios.reduce((s, u) => s + Number(u.quantity || 0), 0)).toFixed(6);
    await g.save({ session });
  }
}

module.exports = {
  componentesVinculados,
  crearDesdeVenta,
  consumir,
  salidaDeInventario,
  delPaciente,
  anularDeVenta,
  esIlimitado,
};
