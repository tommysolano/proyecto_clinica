/**
 * PUNTOS DE EMISIÓN: de qué serie (estab-ptoEmi) emite cada usuario y cómo se reserva el número.
 *
 * Regla única para facturas, notas de crédito, ventas y caja:
 *  - Sucursal SIN puntos creados → modo anterior: la serie única de InvoicingConfig.
 *  - Sucursal CON puntos → cada usuario emite desde SU punto (uno por usuario); sin punto
 *    asignado no puede facturar ni abrir caja (400 SIN_PUNTO_EMISION).
 */
const PuntoEmision = require('../models/PuntoEmision');
const InvoicingConfig = require('../models/InvoicingConfig');

const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });

const MSG_SIN_PUNTO =
  'No tienes un punto de emisión asignado en esta sucursal. Pide al administrador que te asigne uno en Configuración SRI → Puntos de emisión.';

/** ¿La sucursal ya trabaja con puntos de emisión? (basta con que exista uno, activo o no). */
async function sucursalUsaPuntos(clinicId) {
  return !!(await PuntoEmision.exists({ clinic: clinicId }));
}

/** Punto ACTIVO asignado al usuario en la sucursal, o null. */
async function puntoDelUsuario(clinicId, userId) {
  if (!clinicId || !userId) return null;
  return PuntoEmision.findOne({ clinic: clinicId, usuario: userId, activo: true });
}

/**
 * Punto obligatorio del usuario cuando la sucursal usa puntos. Devuelve null si la sucursal
 * aún no tiene puntos (modo anterior) y lanza 400 si los tiene pero el usuario no tiene uno.
 */
async function puntoRequerido(clinicId, userId) {
  if (!(await sucursalUsaPuntos(clinicId))) return null;
  const punto = await puntoDelUsuario(clinicId, userId);
  if (!punto) throw httpError(400, MSG_SIN_PUNTO, 'SIN_PUNTO_EMISION');
  return punto;
}

/**
 * Serie con la que emite `userId`: { punto, estab, ptoEmi, dirEstablecimiento }.
 * `punto` es null en el modo anterior (serie de la configuración).
 */
async function serieDelEmisor(clinicId, userId, config) {
  const punto = await puntoRequerido(clinicId, userId);
  const dirConfig = config.direccionEstablecimiento || config.direccionMatriz || '';
  if (!punto) {
    return {
      punto: null,
      estab: config.establecimiento || '001',
      ptoEmi: config.puntoEmision || '001',
      dirEstablecimiento: dirConfig,
    };
  }
  return {
    punto,
    estab: punto.establecimiento,
    ptoEmi: punto.codigo,
    dirEstablecimiento: punto.direccionEstablecimiento || dirConfig,
  };
}

const CAMPO = { factura: 'secuencialFactura', notaCredito: 'secuencialNotaCredito' };

/**
 * Reserva ATÓMICA del siguiente secuencial (9 dígitos) de la serie para `tipo`
 * ('factura' | 'notaCredito'). Nunca entrega el mismo número dos veces, aunque dos cajas
 * emitan en el mismo instante.
 */
async function reservarSecuencial(serie, tipo, config) {
  if (!serie.punto) {
    return tipo === 'factura' ? config.reserveSequential() : config.reserveCreditNoteSequential();
  }
  const campo = CAMPO[tipo];
  if (!campo) throw new Error(`Tipo de comprobante desconocido: ${tipo}`);
  const antes = await PuntoEmision.findOneAndUpdate(
    { _id: serie.punto._id, activo: true },
    { $inc: { [campo]: 1 } },
    { new: false }
  );
  if (!antes) throw httpError(400, 'Tu punto de emisión fue desactivado. Pide al administrador que lo revise.', 'SIN_PUNTO_EMISION');
  // Contadores informativos de la configuración (no numeran nada).
  const stats = tipo === 'factura'
    ? { $inc: { invoiceCount: 1 }, $set: { lastInvoiceDate: new Date() } }
    : { $inc: { creditNoteCount: 1 } };
  await InvoicingConfig.updateOne({ clinic: config.clinic }, stats);
  return String(antes[campo]).padStart(9, '0');
}

/**
 * Series para elegir al emitir retenciones: las de `establishments[]`/par único de la
 * configuración más las de los puntos de emisión activos, agrupadas por establecimiento.
 */
async function seriesDisponibles(clinicId, config) {
  const porEstab = new Map();
  const add = (estab, pto, name = '') => {
    if (!estab || !pto) return;
    const cur = porEstab.get(estab) || { estab, name, puntosEmision: [] };
    if (!cur.name && name) cur.name = name;
    if (!cur.puntosEmision.includes(pto)) cur.puntosEmision.push(pto);
    porEstab.set(estab, cur);
  };
  const usaPuntos = await sucursalUsaPuntos(clinicId);
  const puntos = usaPuntos
    ? await PuntoEmision.find({ clinic: clinicId, activo: true }).sort({ establecimiento: 1, codigo: 1 }).lean()
    : [];
  if (!usaPuntos) {
    for (const s of config.availableSeries()) for (const p of s.puntosEmision) add(s.estab, p, s.name);
  } else {
    // Con puntos, la lista suelta de la configuración solo suma lo que esté declarado a mano.
    for (const s of (config.establishments || [])) for (const p of (s.puntosEmision || [])) add(s.estab, p, s.name);
  }
  for (const p of puntos) add(p.establecimiento, p.codigo);
  for (const v of porEstab.values()) v.puntosEmision.sort();
  return [...porEstab.values()].sort((a, b) => a.estab.localeCompare(b.estab));
}

module.exports = {
  MSG_SIN_PUNTO,
  sucursalUsaPuntos,
  puntoDelUsuario,
  puntoRequerido,
  serieDelEmisor,
  reservarSecuencial,
  seriesDisponibles,
};
