/**
 * FILTROS DE LA LISTA DE FACTURAS (nov-2026): los mismos para la pantalla de
 * Facturación y para su Excel, así lo que se exporta es lo que se ve.
 *
 *   · `startDate` / `endDate` ('AAAA-MM-DD'): días completos en hora de Ecuador y
 *     cada uno por separado. Antes solo filtraba con las dos fechas y `endDate` se
 *     leía como medianoche UTC: ese día quedaba fuera.
 *   · `estado`.
 *   · `puntoEmision` (la CAJA): por su id y, para las facturas emitidas antes de que
 *     existieran los puntos (sin enlace), por su establecimiento y punto («001-002»).
 *   · `q`: número de factura (completo «001-002-000003344» o solo el secuencial
 *     «3344»), cliente (por palabras, sin tildes) o su identificación.
 */
const mongoose = require('mongoose');
const PuntoEmision = require('../models/PuntoEmision');
const { nameSearchFilter } = require('./nameSearch');

/** Inicio o fin del día local de 'AAAA-MM-DD' (el servidor corre en America/Guayaquil). */
function dia(v, fin) {
  const m = String(v || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (fin) d.setHours(23, 59, 59, 999);
  return d;
}

const secuencialRegex = (n) => new RegExp(`^0*${String(Number(n))}$`);

async function invoiceListFilter(query = {}) {
  const and = [];
  const desde = dia(query.startDate, false);
  const hasta = dia(query.endDate, true);
  if (desde || hasta) {
    and.push({ createdAt: { ...(desde ? { $gte: desde } : {}), ...(hasta ? { $lte: hasta } : {}) } });
  }
  if (query.estado) and.push({ estado: String(query.estado) });

  if (query.puntoEmision) {
    if (!mongoose.Types.ObjectId.isValid(query.puntoEmision)) {
      and.push({ _id: null });
    } else {
      const punto = await PuntoEmision.findById(query.puntoEmision).select('establecimiento codigo').lean();
      const opciones = [{ puntoEmision: new mongoose.Types.ObjectId(query.puntoEmision) }];
      if (punto) opciones.push({ puntoEmision: null, estab: punto.establecimiento, ptoEmi: punto.codigo });
      and.push({ $or: opciones });
    }
  }

  const q = String(query.q || '').trim();
  if (q) {
    const numero = q.match(/^(\d{1,3})-(\d{1,3})-(\d{1,9})$/);
    const opciones = [];
    if (numero) {
      opciones.push({
        estab: numero[1].padStart(3, '0'),
        ptoEmi: numero[2].padStart(3, '0'),
        secuencial: secuencialRegex(numero[3]),
      });
    } else {
      if (/^\d{1,9}$/.test(q)) opciones.push({ secuencial: secuencialRegex(q) });
      if (/^\d{5,}$/.test(q)) opciones.push({ identificacionComprador: q });
      const porNombre = nameSearchFilter(q, ['razonSocialComprador', 'identificacionComprador']);
      if (porNombre) opciones.push(porNombre);
    }
    and.push(opciones.length ? { $or: opciones } : { _id: null });
  }
  return and.length ? { $and: and } : {};
}

module.exports = { invoiceListFilter };
