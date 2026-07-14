/**
 * REPORTE DE VENTAS: motor ÚNICO de la pantalla, la API y el Excel.
 *
 * Tres niveles que NO se mezclan, porque mezclarlos es exactamente como se cuenta el mismo
 * dinero dos veces:
 *
 *   · DOCUMENTO → una fila por venta (su total económico).
 *   · DETALLE   → una fila por línea (producto/servicio). La suma de las líneas de una venta es
 *                 su total: el total del documento NO se repite en cada línea.
 *   · PAGOS     → una fila por pago real (ver `services/salePayments`). La parte a crédito no es
 *                 un cobro: es CxC.
 *
 * Conciliación por venta, verificada en pruebas:
 *     Σ líneas = total del documento
 *     cobrado + saldo = total
 */
const mongoose = require('mongoose');
const Sale = require('../models/Sale');
const Invoice = require('../models/Invoice');
const Product = require('../models/Product');
const ServiceCategory = require('../models/ServiceCategory');
const SalesReportPreset = require('../models/SalesReportPreset');
const CostCenter = require('../models/CostCenter');
const { normalizeSalePayments, loadLaterCollections, METHODS, CREDITO } = require('./salePayments');

const r2 = (n) => +Number(n || 0).toFixed(2);
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const endOfDay = (d) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };

/** 'YYYY-MM-DD' → medianoche LOCAL (Ecuador). Ver docs/FLUJO_DE_CAJA.md. */
function parseLocalDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : new Date(value);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Resuelve la SELECCIÓN de ítems de un preset (o de los filtros sueltos):
 *     (categorías + incluidos) − excluidos
 * Devuelve `null` cuando no hay selección (= todos los ítems).
 */
async function resolveSelection(clinicId, { preset = null, categories = [], products = [] } = {}) {
  const incluidas = preset ? (preset.includeCategories || []) : categories;
  const excluidasCat = preset ? (preset.excludeCategories || []) : [];
  const incluidos = preset ? (preset.includeProducts || []) : products;
  const excluidos = preset ? (preset.excludeProducts || []) : [];

  if (!incluidas.length && !incluidos.length) return null;

  const ids = new Set(incluidos.map(String));
  if (incluidas.length) {
    const cats = await ServiceCategory.find({ clinic: clinicId, _id: { $in: incluidas } }).select('products').lean();
    for (const c of cats) for (const p of c.products || []) ids.add(String(p));
  }
  if (excluidasCat.length) {
    const cats = await ServiceCategory.find({ clinic: clinicId, _id: { $in: excluidasCat } }).select('products').lean();
    for (const c of cats) for (const p of c.products || []) ids.delete(String(p));
  }
  for (const p of excluidos) ids.delete(String(p));
  return [...ids];
}

/** Carga el preset (validando la clínica) y funde sus filtros con los del query. */
async function applyPreset(clinicId, presetId, filters = {}) {
  if (!presetId) return { preset: null, filters };
  const preset = await SalesReportPreset.findOne({ _id: presetId, clinic: clinicId }).lean();
  if (!preset) throw Object.assign(new Error('El preset no existe en esta clínica'), { status: 404 });
  const f = { ...preset.filters, ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) };
  return { preset, filters: f };
}

/**
 * Reporte completo.
 * @returns {{documentos, detalle, pagos, resumen, seleccion, filtros}}
 */
async function buildSalesReport(clinicId, query = {}) {
  const { preset, filters } = await applyPreset(clinicId, query.preset, {
    status: query.status,
    method: query.method,
    costCenter: query.costCenter,
    client: query.client,
    invoiceNumber: query.invoiceNumber,
    user: query.user,
    startDate: query.startDate || query.from,
    endDate: query.endDate || query.to,
  });

  const desde = filters.startDate ? startOfDay(parseLocalDate(filters.startDate)) : null;
  const hasta = filters.endDate ? endOfDay(parseLocalDate(filters.endDate)) : null;

  const match = { clinic: oid(clinicId) };
  if (desde || hasta) {
    match.createdAt = {};
    if (desde) match.createdAt.$gte = desde;
    if (hasta) match.createdAt.$lte = hasta;
  }
  // Por defecto se muestran las completadas Y las anuladas (una anulada se ve, con su estado,
  // pero no suma). Filtrar por estado acota.
  if (filters.status) match.status = filters.status;
  if (filters.client) match.clientName = new RegExp(String(filters.client), 'i');
  if (filters.user) match.createdBy = oid(filters.user);
  // Centro de costo de la VENTA (el que se resolvió contra su bodega al registrarla). El filtro
  // se recibía y no se aplicaba: el reporte "por centro" devolvía todo.
  if (filters.costCenter) match.costCenter = oid(filters.costCenter);
  if (filters.warehouse) match.warehouse = oid(filters.warehouse);

  const seleccion = await resolveSelection(clinicId, {
    preset,
    categories: query.categories ? String(query.categories).split(',').filter(Boolean) : [],
    products: query.products ? String(query.products).split(',').filter(Boolean) : [],
  });
  if (seleccion) {
    if (!seleccion.length) {
      // Selección vacía a propósito (todo excluido): el reporte no puede devolver "todo".
      return vacio(preset, filters, seleccion);
    }
    match['items.product'] = { $in: seleccion.map(oid) };
  }

  const ventas = await Sale.find(match).sort({ createdAt: 1 }).lean();
  if (!ventas.length) return vacio(preset, filters, seleccion);

  const saleIds = ventas.map((s) => s._id);
  // Sin N+1: una consulta para las facturas, una para los productos, una para los cobros y una
  // para los centros de costo (el reporte muestra el NOMBRE, no un id que nadie puede leer).
  const [facturas, productos, cobrosPorVenta, centros] = await Promise.all([
    Invoice.find({ clinic: clinicId, _id: { $in: ventas.map((s) => s.invoice).filter(Boolean) } })
      .select('estab ptoEmi secuencial autorizacion estado').lean(),
    Product.find({ clinic: clinicId, _id: { $in: [...new Set(ventas.flatMap((s) => (s.items || []).map((i) => i.product)))] } })
      .select('code name category categoria').lean(),
    loadLaterCollections(clinicId, saleIds),
    CostCenter.find({ clinic: clinicId, _id: { $in: [...new Set(ventas.map((s) => s.costCenter).filter(Boolean))] } })
      .select('code name').lean(),
  ]);
  const facturaPorId = new Map(facturas.map((f) => [String(f._id), f]));
  const prodPorId = new Map(productos.map((p) => [String(p._id), p]));
  const centroPorId = new Map(centros.map((c) => [String(c._id), `${c.code} - ${c.name}`]));
  const selSet = seleccion ? new Set(seleccion.map(String)) : null;

  const documentos = [];
  const detalle = [];
  const pagos = [];
  const alertas = [];

  for (const s of ventas) {
    const anulada = s.status === 'anulada';
    const f = s.invoice ? facturaPorId.get(String(s.invoice)) : null;
    const pay = normalizeSalePayments(s, cobrosPorVenta.get(String(s._id)) || []);

    // Filtro por método: se aplica al DOCUMENTO (una venta mixta entra si alguno de sus pagos
    // es del método pedido) y no rompe la conciliación, porque no se recorta el detalle.
    if (filters.method && !pay.rows.some((p) => p.method === filters.method)) continue;

    const doc = {
      id: String(s._id),
      date: s.createdAt,
      numero: s.saleNumber,
      factura: f ? `${f.estab}-${f.ptoEmi}-${f.secuencial}` : '',
      facturaId: f ? String(f._id) : null,
      autorizacion: f?.autorizacion || '',
      cliente: s.clientName || '',
      identificacion: s.clientCedula || '',
      subtotal0: r2(s.subtotal0 || 0),
      subtotalGravado: r2(s.taxableSubtotal ?? s.subtotal ?? 0),
      descuento: r2(s.discountTotal || 0),
      iva: r2(s.taxAmount || 0),
      total: r2(s.total),
      cobrado: anulada ? 0 : pay.cobrado,
      saldo: anulada ? 0 : pay.saldo,
      estado: s.status,
      anulada,
      legacy: pay.legacy,
      journalEntry: s.journalEntry || null,
      costCenter: s.costCenter || null,
      costCenterName: s.costCenter ? (centroPorId.get(String(s.costCenter)) || '') : '',
      warehouse: s.warehouse || null,
      porMetodo: anulada ? {} : pay.porMetodo,
      cuadra: pay.cuadra,
    };
    documentos.push(doc);
    if (!pay.cuadra) {
      alertas.push({
        tipo: 'VENTA_DESCUADRADA', venta: s.saleNumber, valor: pay.descuadre,
        mensaje: `La venta ${s.saleNumber} no concilia: total ${doc.total.toFixed(2)} ≠ cobrado `
          + `${pay.cobrado.toFixed(2)} + saldo ${pay.saldo.toFixed(2)}.`,
      });
    }

    let sumaLineas = 0;
    for (const it of s.items || []) {
      // Con una selección activa, el DETALLE solo muestra los ítems seleccionados; el documento
      // conserva su total real (por eso el detalle puede no sumar el total: se avisa abajo).
      if (selSet && !selSet.has(String(it.product))) continue;
      const p = prodPorId.get(String(it.product));
      const lineTotal = r2(it.lineTotal || it.subtotal);
      sumaLineas = r2(sumaLineas + lineTotal);
      detalle.push({
        venta: s.saleNumber,
        ventaId: String(s._id),
        factura: doc.factura,
        date: s.createdAt,
        categoria: p?.categoria || '',
        tipo: p?.category || '',
        productId: String(it.product),
        codigo: it.productCode || p?.code || '',
        producto: it.productName || p?.name || '',
        cantidad: it.quantity,
        precio: r2(it.unitPrice),
        descuento: r2(it.discount || 0),
        subtotal: r2(it.subtotal),
        iva: r2(it.taxAmount || 0),
        totalLinea: lineTotal,
        estado: s.status,
      });
    }
    // Conciliación documento ↔ detalle (solo tiene sentido sin selección parcial).
    doc.sumaLineas = sumaLineas;
    doc.detalleCuadra = !!selSet || Math.abs(sumaLineas - doc.total) <= 0.02;

    for (const row of pay.rows) {
      if (row.esCredito) continue;    // la CxC no es un pago: va en el saldo
      pagos.push({
        venta: s.saleNumber,
        ventaId: String(s._id),
        factura: doc.factura,
        date: row.date,
        method: row.method,
        methodRaw: row.methodRaw,
        cardType: row.cardType,
        cardBrand: row.cardBrand,
        bankAccount: row.bankAccount,
        referencia: row.reference,
        importe: row.amount,
        origen: row.origen,
        legacy: row.legacy,
        estado: row.estado,
      });
    }
  }

  // ── Resumen (de las ventas NO anuladas) ────────────────────────────────────────────────
  const vivas = documentos.filter((d) => !d.anulada);
  const resumen = {
    documentos: documentos.length,
    anuladas: documentos.filter((d) => d.anulada).length,
    subtotal0: r2(vivas.reduce((s, d) => s + d.subtotal0, 0)),
    subtotalGravado: r2(vivas.reduce((s, d) => s + d.subtotalGravado, 0)),
    descuento: r2(vivas.reduce((s, d) => s + d.descuento, 0)),
    iva: r2(vivas.reduce((s, d) => s + d.iva, 0)),
    total: r2(vivas.reduce((s, d) => s + d.total, 0)),
    cobrado: r2(vivas.reduce((s, d) => s + d.cobrado, 0)),
    pendiente: r2(vivas.reduce((s, d) => s + d.saldo, 0)),
    porMetodo: {},
    porCategoria: {},
    porProducto: {},
    porCentroCosto: {},
    legacy: vivas.filter((d) => d.legacy).length,
  };
  for (const m of [...METHODS, CREDITO, 'tarjeta_sin_tipo']) resumen.porMetodo[m] = 0;
  for (const p of pagos) {
    if (p.estado === 'ANULADA') continue;
    resumen.porMetodo[p.method] = r2((resumen.porMetodo[p.method] || 0) + p.importe);
  }
  resumen.porMetodo[CREDITO] = resumen.pendiente;

  for (const d of detalle) {
    if (d.estado === 'anulada') continue;
    const cat = d.categoria || '(sin categoría)';
    resumen.porCategoria[cat] = r2((resumen.porCategoria[cat] || 0) + d.totalLinea);
    const k = `${d.codigo}|${d.producto}`;
    resumen.porProducto[k] = r2((resumen.porProducto[k] || 0) + d.totalLinea);
  }
  for (const d of vivas) {
    // Se agrupa por el NOMBRE del centro: un id de Mongo no es un renglón de reporte.
    const cc = d.costCenterName || (d.costCenter ? String(d.costCenter) : '(sin centro)');
    resumen.porCentroCosto[cc] = r2((resumen.porCentroCosto[cc] || 0) + d.total);
  }

  // Conciliación global: cobrado + pendiente = total.
  resumen.cuadra = Math.abs(r2(resumen.cobrado + resumen.pendiente) - resumen.total) <= 0.02;
  if (!resumen.cuadra) {
    alertas.push({
      tipo: 'RESUMEN_DESCUADRADO', valor: r2(resumen.total - resumen.cobrado - resumen.pendiente),
      mensaje: 'El total no coincide con cobrado + pendiente.',
    });
  }
  if (resumen.legacy) {
    alertas.push({
      tipo: 'PAGOS_LEGACY', valor: resumen.legacy,
      mensaje: `${resumen.legacy} venta(s) no tienen desglose de pagos: su método se deduce del `
        + 'campo resumen (LEGACY_FALLBACK). En las de tarjeta no se puede saber si fue débito o crédito.',
    });
  }

  return {
    documentos, detalle, pagos, resumen, alertas,
    seleccion,
    preset: preset ? { id: String(preset._id), name: preset.name } : null,
    filtros: { ...filters, from: desde, to: hasta },
  };
}

function vacio(preset, filters, seleccion) {
  return {
    documentos: [], detalle: [], pagos: [],
    resumen: {
      documentos: 0, anuladas: 0, subtotal0: 0, subtotalGravado: 0, descuento: 0, iva: 0,
      total: 0, cobrado: 0, pendiente: 0, porMetodo: {}, porCategoria: {}, porProducto: {},
      porCentroCosto: {}, legacy: 0, cuadra: true,
    },
    alertas: [],
    seleccion,
    preset: preset ? { id: String(preset._id), name: preset.name } : null,
    filtros: filters,
  };
}

module.exports = { buildSalesReport, resolveSelection, applyPreset, parseLocalDate };
