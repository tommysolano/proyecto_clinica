/**
 * PUNTOS DE EMISIÓN: de qué serie (estab-ptoEmi) emite cada usuario y cómo se reserva el número.
 *
 * Regla única para facturas, notas de crédito, ventas y caja:
 *  - Sucursal SIN puntos creados → modo anterior: la serie única de InvoicingConfig.
 *  - Sucursal CON puntos → cada usuario emite desde SU punto (uno por usuario); sin punto
 *    asignado no puede facturar ni abrir caja (400 SIN_PUNTO_EMISION).
 *
 * LA CONFIGURACIÓN SRI ES DE LA EMPRESA (29-10-2026). Emisor, certificado y puntos viven en
 * UNA sucursal de la empresa (la que tiene la configuración: hoy Central) y valen para todas
 * sus sucursales. Antes se buscaban en la sucursal activa y quien cobraba en otra (p.ej.
 * Laboratorio) guardaba la venta sin factura y sin aviso. `sucursalSri` resuelve esa sucursal.
 */
const PuntoEmision = require('../models/PuntoEmision');
const InvoicingConfig = require('../models/InvoicingConfig');

const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });

const MSG_SIN_PUNTO =
  'No tienes un punto de emisión asignado en esta empresa. Pide al administrador que te asigne uno en Configuración SRI → Puntos de emisión.';

/**
 * Sucursal que guarda la configuración SRI de la empresa de `clinicId`: la propia si tiene
 * una (empresas o sucursales con emisor propio) y, si no, la de su empresa que la tenga.
 * Sin ninguna, la misma sucursal (todo sigue como si no hubiera configuración).
 */
async function sucursalSri(clinicId) {
  if (!clinicId) return clinicId;
  if (await InvoicingConfig.exists({ clinic: clinicId })) return clinicId;
  const { ensureCompanyCache, sisterClinicsSync } = require('../utils/companies');
  await ensureCompanyCache();
  const hermanas = sisterClinicsSync(clinicId, { includeInactive: true }).filter((id) => id !== String(clinicId));
  if (!hermanas.length) return clinicId;
  const cfg = await InvoicingConfig.findOne({ clinic: { $in: hermanas } }).sort({ createdAt: 1 }).select('clinic').lean();
  return cfg ? cfg.clinic : clinicId;
}

/** Configuración SRI de la empresa de la sucursal (documento mongoose), o null. */
async function configDeEmpresa(clinicId) {
  return InvoicingConfig.findOne({ clinic: await sucursalSri(clinicId) });
}

/** ¿La empresa ya trabaja con puntos de emisión? (basta con que exista uno, activo o no). */
async function sucursalUsaPuntos(clinicId) {
  return !!(await PuntoEmision.exists({ clinic: await sucursalSri(clinicId) }));
}

/** Punto ACTIVO asignado al usuario en la empresa, o null. */
async function puntoDelUsuario(clinicId, userId) {
  if (!clinicId || !userId) return null;
  return PuntoEmision.findOne({ clinic: await sucursalSri(clinicId), usuario: userId, activo: true });
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

/** Ambiente del SRI de un punto: el suyo o, si no lo tiene definido, el de la configuración. */
function ambienteDelPunto(punto, config) {
  return punto?.ambiente || config?.ambiente || '1';
}

/**
 * Serie con la que emite `userId`: { punto, estab, ptoEmi, dirEstablecimiento, ambiente }.
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
      ambiente: config.ambiente || '1',
    };
  }
  return {
    punto,
    estab: punto.establecimiento,
    ptoEmi: punto.codigo,
    dirEstablecimiento: punto.direccionEstablecimiento || dirConfig,
    ambiente: ambienteDelPunto(punto, config),
  };
}

/**
 * Ambiente con el que se emite desde la serie `estab-ptoEmi` (retenciones, que eligen la
 * serie a mano): el del punto de esa serie; sin punto, el de la configuración.
 */
async function ambienteDeSerie(clinicId, estab, ptoEmi, config) {
  const punto = await PuntoEmision.findOne({ clinic: await sucursalSri(clinicId), establecimiento: estab, codigo: ptoEmi })
    .select('ambiente').lean();
  return ambienteDelPunto(punto, config);
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
    ? await PuntoEmision.find({ clinic: await sucursalSri(clinicId), activo: true }).sort({ establecimiento: 1, codigo: 1 }).lean()
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
  sucursalSri,
  configDeEmpresa,
  sucursalUsaPuntos,
  puntoDelUsuario,
  puntoRequerido,
  serieDelEmisor,
  ambienteDelPunto,
  ambienteDeSerie,
  reservarSecuencial,
  seriesDisponibles,
};
