/**
 * CAJA SELECCIONADA (nov-2026) — «Caja e ingresos» para super administrador y contabilidad.
 *
 * Escogen cualquier caja ABIERTA de la empresa (de cualquier sucursal) y trabajan sobre ella:
 * el cuadre, las salidas, los vales y el paso de efectivo al banco. El navegador manda el id
 * de la caja en la cabecera `X-Caja` (o `?caja=`); aquí se valida y la petición pasa a operar
 * en la SUCURSAL de esa caja (`req.clinicId`) con la caja en `req.caja`.
 *
 * Sin la cabecera todo sigue como antes (la sucursal activa y la caja propia).
 */
const mongoose = require('mongoose');
const CashClosing = require('../models/CashClosing');

const puedeElegirCaja = (req) => !!req.user?.isSuperAdmin || ['contabilidad', 'asistente_contable'].includes(req.role);

module.exports = async function cajaSeleccionada(req, res, next) {
  try {
    const id = String(req.get('x-caja') || req.query.caja || '').trim();
    if (!id) return next();
    if (!puedeElegirCaja(req)) {
      return res.status(403).json({ message: 'Solo el super administrador y contabilidad pueden trabajar sobre otra caja.' });
    }
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'Caja no válida.' });
    const caja = await CashClosing.findById(id).select('clinic status openedBy openedAt puntoEmision').lean();
    if (!caja) return res.status(404).json({ message: 'Caja no encontrada.' });
    if (caja.status !== 'ABIERTA') return res.status(409).json({ message: 'Esa caja ya se cerró.', code: 'CAJA_CERRADA' });
    // Solo cajas de la misma empresa (el super administrador ve todas).
    if (!req.user?.isSuperAdmin) {
      const { hermanas } = require('../utils/planEmpresa');
      if (!(await hermanas(req.clinicId)).includes(String(caja.clinic))) {
        return res.status(403).json({ message: 'Esa caja es de otra empresa.' });
      }
    }
    req.clinicId = String(caja.clinic);
    req.caja = caja;
    next();
  } catch (e) { next(e); }
};

/** Usuario con el que se registran los asientos de Caja: el DUEÑO de la caja escogida
 *  (el arqueo de una caja por punto cuenta solo los asientos de quien la abrió). */
module.exports.operadorDeCaja = (req) => req.caja?.openedBy || req.user._id;
module.exports.puedeElegirCaja = puedeElegirCaja;
