/**
 * REPORTE DE VENTAS DE UN PRODUCTO (nov-2026) — réplica del «Reporte de Ventas» de Contífico
 * filtrado por producto, que se abre al hacer clic en un ítem de Bodegas → Existencias.
 *
 * Igual que en Contífico se leen DOS cosas distintas:
 *  - Resumen general y gráfico por producto/categoría/cliente: solo las LÍNEAS del producto (o de
 *    la categoría) dentro de las ventas: lo que se vendió de él.
 *  - Resumen de cobros, cantidad de documentos y gráfico por hora: los DOCUMENTOS completos que
 *    incluyen el producto (cómo se cobraron esas ventas). Por eso el total cobrado es mayor que
 *    el total del producto cuando la venta llevaba otras cosas.
 *
 * Filtros (query): startDate, endDate (YYYY-MM-DD), product (ids separados por coma),
 * category (InventoryCategory), costCenter, client (cédula/RUC o nombre), chart
 * (producto | categoria | cliente | vendedor | sucursal).
 */
const mongoose = require('mongoose');
const Sale = require('../models/Sale');
const Product = require('../models/Product');
require('../models/InventoryCategory');
require('../models/Invoice');
const { breakdownFromItems } = require('../utils/invoiceTaxBreakdown');

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const r2 = (n) => +(Number(n) || 0).toFixed(2);
const r4 = (n) => +(Number(n) || 0).toFixed(4);
const TZ = 'America/Guayaquil';
const escRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Valores de una línea de venta: base (sin IVA, ya con descuento), IVA y total. */
function valoresLinea(it) {
  const iva = Number(it.taxAmount) || 0;
  let base = Number(it.taxBase);
  if (!Number.isFinite(base) || (!base && Number(it.lineTotal))) base = (Number(it.lineTotal) || 0) - iva;
  return { base: r2(base), iva: r2(iva), total: r2(base + iva), descuento: r2(it.discountTaxBase ?? it.discount ?? 0) };
}

const pagosDe = (s) => (s.payments?.length ? s.payments : [{ method: s.paymentMethod, amount: s.total }]);

/**
 * @param {object} baseMatch filtro de alcance (empresa/sucursal/centro) que arma el controlador.
 * @param {object} q query del reporte.
 */
async function buildProductSalesReport(baseMatch, q = {}, catalogoClinicIds = []) {
  const match = { ...baseMatch };
  if (q.startDate || q.endDate) {
    match.createdAt = {};
    if (q.startDate) match.createdAt.$gte = new Date(`${String(q.startDate).slice(0, 10)}T00:00:00.000-05:00`);
    if (q.endDate) match.createdAt.$lte = new Date(`${String(q.endDate).slice(0, 10)}T23:59:59.999-05:00`);
  }
  if (q.costCenter && mongoose.isValidObjectId(q.costCenter)) {
    match.$and = [...(match.$and || []), { costCenter: oid(q.costCenter) }];
  }
  const client = String(q.client || '').trim();
  if (client) {
    match.$and = [...(match.$and || []), /^\d{10,13}$/.test(client)
      ? { clientCedula: client }
      : { $or: [{ clientName: { $regex: escRegex(client), $options: 'i' } }, { clientCedula: { $regex: `^${escRegex(client)}` } }] }];
  }

  // Productos del filtro: los escogidos y/o los de la categoría.
  const ids = new Set(String(q.product || '').split(',').map((s) => s.trim()).filter((s) => mongoose.isValidObjectId(s)));
  let categoria = null;
  if (q.category && mongoose.isValidObjectId(q.category)) {
    const prodFiltro = { inventoryCategory: oid(q.category) };
    if (catalogoClinicIds.length) prodFiltro.clinic = { $in: catalogoClinicIds.map(oid) };
    const deCat = await Product.find(prodFiltro).select('_id').lean();
    categoria = String(q.category);
    // Producto y categoría a la vez: los del producto que además sean de esa categoría.
    const enCat = new Set(deCat.map((p) => String(p._id)));
    if (ids.size) for (const id of [...ids]) { if (!enCat.has(id)) ids.delete(id); }
    else enCat.forEach((id) => ids.add(id));
    if (!ids.size) ids.add('000000000000000000000000'); // categoría vacía: nada
  }
  const filtraLineas = ids.size > 0;
  if (filtraLineas) match['items.product'] = { $in: [...ids].map(oid) };

  const ventas = await Sale.find(match)
    .select('clinic saleNumber clientName clientCedula items total taxAmount payments paymentMethod status createdAt createdBy invoice costCenter')
    .populate('invoice', 'estab ptoEmi secuencial estado')
    .populate('createdBy', 'name')
    .populate('clinic', 'name')
    .sort({ createdAt: 1 })
    .lean();

  const esDelFiltro = (it) => !filtraLineas || ids.has(String(it.product));
  const completadas = ventas.filter((s) => s.status === 'completada');
  const anuladas = ventas.filter((s) => s.status === 'anulada');

  // Categorías de los productos vendidos (para el gráfico por categoría).
  const prodIds = [...new Set(completadas.flatMap((s) => (s.items || []).filter(esDelFiltro).map((it) => String(it.product))))];
  const prods = await Product.find({ _id: { $in: prodIds.map(oid) } }).select('name code inventoryCategory').populate('inventoryCategory', 'name').lean();
  const prodInfo = new Map(prods.map((p) => [String(p._id), p]));

  // ── Resumen general: líneas del producto ──
  const lineas = [];
  for (const s of completadas) for (const it of s.items || []) if (esDelFiltro(it)) lineas.push({ s, it });
  const desglose = breakdownFromItems(lineas.map((l) => l.it));
  const general = { subtotal0: 0, subtotalIva: 0, iva: 0, descuento: 0, total: 0, cantidad: 0 };
  for (const { it } of lineas) {
    const v = valoresLinea(it);
    general.iva += v.iva; general.descuento += v.descuento; general.total += v.total;
    general.cantidad += Number(it.quantity) || 0;
  }
  general.subtotal0 = r2(desglose.base0 + desglose.baseExento + desglose.baseNoObjeto);
  general.subtotalIva = r2(desglose.baseGravada);
  general.iva = r2(general.iva); general.descuento = r2(general.descuento); general.total = r2(general.total);
  general.cantidad = r4(general.cantidad);

  // Notas de crédito emitidas sobre las facturas de estas ventas.
  const facturas = completadas.map((s) => s.invoice?._id).filter(Boolean);
  let notasCredito = 0;
  if (facturas.length) {
    const CreditDebitNote = require('../models/CreditDebitNote');
    const [nc] = await CreditDebitNote.aggregate([
      { $match: { kind: 'NC', direction: 'EMITIDA', refModel: 'Invoice', refDoc: { $in: facturas }, estado: { $in: ['AUTORIZADO', 'REGISTRADA', 'EN_COLA', 'RECIBIDA', 'EN_PROCESO'] } } },
      { $group: { _id: null, total: { $sum: '$total' } } },
    ]);
    notasCredito = r2(nc?.total);
  }
  general.notasCredito = notasCredito;

  // ── Resumen de cobros y documentos: documentos completos ──
  const cobros = { efectivo: 0, tarjeta: 0, transferencia: 0, anticipo: 0, credito: 0, otros: 0 };
  let pendientesDocs = 0;
  for (const s of completadas) {
    let conCredito = false;
    for (const p of pagosDe(s)) {
      const k = p.method in cobros ? p.method : 'otros';
      cobros[k] += Number(p.amount) || 0;
      if (p.method === 'credito' && Number(p.amount) > 0) conCredito = true;
    }
    if (conCredito) pendientesDocs += 1;
  }
  Object.keys(cobros).forEach((k) => { cobros[k] = r2(cobros[k]); });
  const totalCobros = r2(Object.values(cobros).reduce((a, b) => a + b, 0));
  const resumenCobros = { ...cobros, total: totalCobros, pendiente: cobros.credito, cobrado: r2(totalCobros - cobros.credito) };
  const emitidos = completadas.length;
  const documentos = {
    cobrados: emitidos - pendientesDocs,
    pendientes: pendientesDocs,
    anulados: anuladas.length,
    total: ventas.length,
    promedio: emitidos ? r2(totalCobros / emitidos) : 0,
  };

  // ── Gráfico por hora: total de los documentos por hora del día (hora de Ecuador) ──
  const horas = Array.from({ length: 24 }, (_, h) => ({ hour: h, total: 0, count: 0 }));
  for (const s of completadas) {
    const h = Number(new Date(s.createdAt).toLocaleString('en-US', { hour: '2-digit', hour12: false, timeZone: TZ })) % 24;
    horas[h].total += Number(s.total) || 0;
    horas[h].count += 1;
  }
  horas.forEach((h) => { h.total = r2(h.total); });

  // ── Gráfico de torta según «tipo gráfico»: sobre las líneas del producto ──
  const tipo = ['producto', 'categoria', 'cliente', 'vendedor', 'sucursal'].includes(q.chart) ? q.chart : 'producto';
  const grupos = new Map();
  for (const { s, it } of lineas) {
    let key; let label;
    if (tipo === 'categoria') {
      const cat = prodInfo.get(String(it.product))?.inventoryCategory;
      key = String(cat?._id || 'sin'); label = cat?.name || 'Sin categoría';
    } else if (tipo === 'cliente') {
      key = s.clientCedula || s.clientName || 'cf'; label = s.clientName || 'Consumidor final';
    } else if (tipo === 'vendedor') {
      key = String(s.createdBy?._id || 'x'); label = s.createdBy?.name || 'Sin registrar';
    } else if (tipo === 'sucursal') {
      key = String(s.clinic?._id || s.clinic); label = s.clinic?.name || 'Sucursal';
    } else {
      key = String(it.product); label = it.productName || prodInfo.get(String(it.product))?.name || '—';
    }
    const g = grupos.get(key) || { key, label, total: 0, cantidad: 0 };
    g.total += valoresLinea(it).total;
    g.cantidad += Number(it.quantity) || 0;
    grupos.set(key, g);
  }
  const grafico = [...grupos.values()].map((g) => ({ ...g, total: r2(g.total), cantidad: r4(g.cantidad) })).sort((a, b) => b.total - a.total);

  // ── Detalle por documento ──
  const docs = ventas.slice().reverse().map((s) => {
    const mias = (s.items || []).filter(esDelFiltro);
    const inv = s.invoice;
    return {
      _id: s._id,
      fecha: s.createdAt,
      venta: s.saleNumber,
      factura: inv?.secuencial ? `${inv.estab}-${inv.ptoEmi}-${String(inv.secuencial).padStart(9, '0')}` : '',
      facturaEstado: inv?.estado || '',
      cliente: s.clientName || 'Consumidor final',
      cedula: s.clientCedula || '',
      sucursal: s.clinic?.name || '',
      vendedor: s.createdBy?.name || '',
      cantidad: r4(mias.reduce((a, it) => a + (Number(it.quantity) || 0), 0)),
      valorProducto: r2(mias.reduce((a, it) => a + valoresLinea(it).total, 0)),
      totalDocumento: r2(s.total),
      pagos: pagosDe(s).map((p) => ({ method: p.method, amount: r2(p.amount) })),
      estado: s.status,
    };
  });

  return { tipoGrafico: tipo, categoria, general, notasCredito, cobros: resumenCobros, documentos, porHora: horas, grafico, detalle: docs };
}

module.exports = { buildProductSalesReport, valoresLinea };
