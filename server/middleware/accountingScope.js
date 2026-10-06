const { accountingScope } = require('../services/accountingScope');

/**
 * La contabilidad es UNA empresa: todo lo de Contífico vive en la sucursal dueña de
 * los centros de costo (Central). Este middleware hace que las pantallas contables de
 * una sucursal ligada a un centro (Central, Extensión, Laboratorio) lean esos datos:
 * cambia `req.clinicId` a la sucursal de datos y deja en `req.costCenterScope` el
 * centro de la sucursal, con el que filtran los listados que tienen centro (compras,
 * ventas, cartera, cobros y pagos, reportes de ventas, resultados, bodegas).
 * Lo que no tiene centro en Contífico (bancos, conciliaciones, plan de cuentas,
 * declaraciones) se ve igual, el de la empresa, desde cualquiera de ellas.
 *
 * `X-Accounting-Scope: company` (o `?scope=company`) quita el filtro de centro: la
 * empresa completa. Una sucursal sin centro ligado (Odontología, Dermazen) no cambia.
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
      req.costCenterScope = scope.costCenter ? scope.costCenter._id : null;
      req.accountingScope = scope;
      next();
    } catch (error) {
      next(error);
    }
  };
};
