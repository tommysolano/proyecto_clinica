const { accountingScope } = require('../services/accountingScope');
const Clinic = require('../models/Clinic');

/**
 * Los documentos importados conservan su sucursal de archivo y su centro original.
 * Las operaciones nuevas pertenecen a la sucursal activa. Este middleware indica
 * dónde leer el archivo y qué centros históricos corresponden a la sucursal.
 * Lo que no tiene centro en Contífico (bancos, conciliaciones, plan de cuentas,
 * declaraciones) se ve igual, el de la empresa, desde cualquiera de ellas.
 *
 * `X-Accounting-Scope: company` (o `?scope=company`) quita el filtro de centro: la
 * empresa completa. Una sucursal sin centro ligado conserva su alcance normal.
 *
 * `reads` limita el cambio a GET/HEAD: en las rutas donde una sucursal también ESCRIBE
 * sus propios documentos (ventas, facturas), la escritura sigue en su sucursal.
 * `skip` excluye rutas operativas de la sucursal (p. ej. las opciones de cobro del cajero).
 */
module.exports = function accountingScopeMiddleware({ reads = false, skip = [] } = {}) {
  return async function accountingScopeHandler(req, res, next) {
    try {
      if (!req.clinicId || req.accountingScope) return next();
      if (reads && !['GET', 'HEAD'].includes(req.method)) return next();
      if (skip.some((path) => req.path === path || req.path.startsWith(`${path}/`))) return next();
      const company = String(req.get('x-accounting-scope') || req.query.scope || '').toLowerCase() === 'company';
      const scope = await accountingScope(req.clinicId, { company });
      if (!scope.linked) return next();
      req.userClinicId = req.clinicId;
      req.clinicId = String(scope.dataClinic);
      req.costCenterScope = scope.costCenter
        ? (scope.costCenterIds.length > 1 ? { $in: scope.costCenterIds } : scope.costCenter._id) : null;
      req.accountingScope = scope;
      if (scope.company) {
        const active = await Clinic.findById(req.userClinicId).select('company').lean();
        req.companyClinicIds = active?.company
          ? (await Clinic.find({ company: active.company }).select('_id').lean()).map((clinic) => clinic._id)
          : [req.clinicId, req.userClinicId];
      }
      next();
    } catch (error) {
      next(error);
    }
  };
};
