/**
 * VALOR FACTURADO DE LAS CITAS (nov-2026).
 *
 * Hasta el 29-10-2026 el valor de una cita lo ESCRIBÍA caja/administración (`agreedValue`, y
 * lo de productos en `itemsValue`). Con la facturación electrónica ya no se escribe: se cobra
 * desde la agenda y queda una VENTA enlazada a la cita (`Sale.appointment`). Todo lo que
 * sumaba el valor escrito (comisiones de doctores, «valor generado», Excel de la agenda,
 * analíticas de anuncios) tiene que sumar también lo facturado, o las citas nuevas cuentan $0.
 *
 * Regla única: si la cita tiene ventas vigentes, manda lo FACTURADO; si no (citas anteriores),
 * el valor escrito de siempre. Las líneas de servicio/programa equivalen al «valor de la cita»
 * y las de productos al «valor de productos» (`itemsValue`), para no mezclar en la comisión del
 * doctor lo que se vendió aparte.
 */
const Sale = require('../models/Sale');

const SERVICIO = new Set(['servicio', 'programa']);
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Importe de una línea de venta (con descuento), con respaldo para ventas antiguas. */
const importeLinea = (it) => (it.lineTotal != null && it.lineTotal !== 0
  ? Number(it.lineTotal)
  : (Number(it.unitPrice) || 0) * (Number(it.quantity) || 0) - (Number(it.discount) || 0));

/**
 * Lo facturado por cita: Map<idCita, { servicios, productos, total, ventas }>.
 * Solo ventas COMPLETADAS (una anulada no generó nada).
 */
async function facturadoPorCita(appointmentIds) {
  const ids = [...new Set((appointmentIds || []).filter(Boolean).map(String))];
  const out = new Map();
  if (!ids.length) return out;
  const ventas = await Sale.find({ appointment: { $in: ids }, status: 'completada' })
    .select('appointment items.product items.category items.lineTotal items.unitPrice items.quantity items.discount items.taxAmount total')
    .lean();
  for (const v of ventas) {
    const k = String(v.appointment);
    const fila = out.get(k) || { servicios: 0, serviciosSinIva: 0, productos: 0, total: 0, ventas: 0, porProducto: {} };
    let servicios = 0;
    let productos = 0;
    // IVA de las líneas de servicio: lo que se descuenta para la comisión «sin IVA».
    let ivaServicios = 0;
    for (const it of v.items || []) {
      // Sin categoría (líneas antiguas) cuenta como servicio: es el valor de la visita.
      if (!it.category || SERVICIO.has(it.category)) {
        servicios += importeLinea(it);
        ivaServicios += Number(it.taxAmount) || 0;
        // Lo facturado de CADA servicio (nov-2026): el porcentaje de comisión de un
        // servicio va sobre SU línea, no sobre toda la visita (ver basesPorServicio).
        if (it.product) {
          const pid = String(it.product);
          const pp = fila.porProducto[pid] || { importe: 0, sinIva: 0 };
          pp.importe += importeLinea(it);
          pp.sinIva += Math.max(0, importeLinea(it) - (Number(it.taxAmount) || 0));
          fila.porProducto[pid] = pp;
        }
      } else productos += importeLinea(it);
    }
    // El total de la venta manda (incluye IVA); las líneas solo reparten entre servicio y producto.
    const lineas = servicios + productos;
    const total = Number(v.total) || lineas;
    if (lineas > 0 && Math.abs(lineas - total) > 0.005) {
      servicios = (servicios / lineas) * total;
      productos = total - servicios;
    } else if (lineas === 0) {
      servicios = total;
    }
    fila.servicios += servicios;
    fila.serviciosSinIva += Math.max(0, servicios - ivaServicios);
    fila.productos += productos;
    fila.total += total;
    fila.ventas += 1;
    out.set(k, fila);
  }
  for (const f of out.values()) {
    f.servicios = r2(f.servicios);
    f.serviciosSinIva = r2(f.serviciosSinIva);
    f.productos = r2(f.productos);
    f.total = r2(f.total);
    for (const pp of Object.values(f.porProducto)) {
      pp.importe = r2(pp.importe);
      pp.sinIva = r2(pp.sinIva);
    }
  }
  return out;
}

/**
 * Anota en cada cita (documento o lean) lo facturado en `_facturado` (o null si no tiene
 * ventas). Devuelve la misma lista para poder encadenar.
 */
async function anotarFacturado(appts, { ivaCatalogo = false } = {}) {
  const lista = (appts || []).filter(Boolean);
  const mapa = await facturadoPorCita(lista.map((a) => a._id));
  for (const a of lista) a._facturado = mapa.get(String(a._id)) || null;
  if (ivaCatalogo) await anotarIvaCatalogo(lista.filter((a) => !(a._facturado?.ventas > 0)));
  return appts;
}

/**
 * IVA (%) del servicio principal de las citas SIN factura, según el producto del catálogo
 * al que está ligado el servicio de agenda. Queda en `_ivaCatalogo` (0 si no se sabe).
 * Solo lo pide quien necesita el valor sin IVA (comisiones por porcentaje).
 */
async function anotarIvaCatalogo(appts) {
  const ids = [...new Set(appts.map((a) => a.serviceItem && String(a.serviceItem._id || a.serviceItem)).filter(Boolean))];
  if (!ids.length) return;
  const AppointmentServiceItem = require('../models/AppointmentServiceItem');
  const Product = require('../models/Product');
  const items = await AppointmentServiceItem.find({ _id: { $in: ids } }).select('product').lean();
  const prodIds = items.map((s) => s.product).filter(Boolean);
  const prods = prodIds.length ? await Product.find({ _id: { $in: prodIds } }).select('taxRate taxCategory').lean() : [];
  const tasaPorProducto = new Map(prods.map((p) => [String(p._id), ['IVA_0', 'EXENTO', 'NO_OBJETO'].includes(p.taxCategory) ? 0 : Number(p.taxRate) || 0]));
  const tasaPorServicio = new Map(items.map((s) => [String(s._id), tasaPorProducto.get(String(s.product)) || 0]));
  for (const a of appts) a._ivaCatalogo = tasaPorServicio.get(String(a.serviceItem?._id || a.serviceItem)) || 0;
}

/**
 * VALOR DE LA CITA (servicios): lo facturado si la cita tiene ventas; si no, el escrito
 * (`agreedValue`, o el adelanto cuando no hay valor acordado). Canje y cortesía = 0 cuando
 * no se facturó nada. Devuelve null si no hay ningún dato (para «sin valor»).
 */
function valorDeCita(appt) {
  if (appt?._facturado && appt._facturado.ventas > 0) return appt._facturado.servicios;
  if (appt?.isCanje || appt?.isCortesia) return 0;
  if (appt?.agreedValue != null) return Number(appt.agreedValue) || 0;
  if (['abono', 'total'].includes(appt?.advancePayment)) return Number(appt.advanceAmount) || 0;
  return null;
}

/**
 * VALOR DE LA CITA SIN IVA (nov-2026), para las comisiones por porcentaje «sin IVA»: con
 * factura, lo facturado en servicios menos el IVA real de esas líneas; sin factura, el valor
 * escrito sin el IVA del producto del catálogo (necesita `anotarFacturado(..., { ivaCatalogo: true })`).
 */
function valorDeCitaSinIva(appt) {
  if (appt?._facturado && appt._facturado.ventas > 0) return appt._facturado.serviciosSinIva;
  const valor = valorDeCita(appt);
  if (valor == null) return null;
  const tasa = Number(appt?._ivaCatalogo) || 0;
  return tasa > 0 ? r2(valor / (1 + tasa / 100)) : valor;
}

/**
 * TODO LO FACTURADO EN LA CITA, servicios y productos (para analíticas de ingresos, donde
 * no hay que separar lo que se vendió aparte). Sin ventas, el valor escrito de siempre.
 */
function totalFacturadoDeCita(appt) {
  if (appt?._facturado && appt._facturado.ventas > 0) return appt._facturado.total;
  return valorDeCita(appt);
}

/** Valor de PRODUCTOS de la cita: lo facturado aparte del servicio o, si no hay ventas, `itemsValue`. */
function valorProductosDeCita(appt) {
  if (appt?._facturado && appt._facturado.ventas > 0) return appt._facturado.productos;
  return appt?.itemsValue != null ? Number(appt.itemsValue) || 0 : null;
}

module.exports = { facturadoPorCita, anotarFacturado, valorDeCita, valorDeCitaSinIva, totalFacturadoDeCita, valorProductosDeCita };
