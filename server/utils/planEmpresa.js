/**
 * UN PLAN DE CUENTAS POR EMPRESA (nov-2026).
 *
 * «Es una sola empresa»: todas las sucursales usan el mismo plan. Pero los asientos de cada
 * sucursal se guardan en su propio libro y apuntan a cuentas de SU plan (copias con el mismo
 * código). Resultado antes de esto:
 *   - La pantalla del plan, en una sucursal sin centro de costo (Odontología, Dermazen), leía
 *     el plan propio — vacío — y una cuenta creada allí no se veía en las demás.
 *   - Una cuenta nueva del plan de la empresa no existía en la sucursal: no aparecía en los
 *     selectores que trabajan por sucursal (vale de caja…) y el asiento la rechazaba con
 *     «Cuenta no encontrada».
 *
 * Ahora:
 *   - `clinicaDelPlan(clinicId)`: la sede que guarda EL plan de la empresa. En Shiluv, Central
 *     (el de Contífico); en las demás empresas, la sucursal con más cuentas.
 *   - `cuentaEnSucursal(acc, clinicId)`: una cuenta del plan de la empresa, en el libro de la
 *     sucursal (se copia con el mismo código si aún no está). La usa el registro de asientos.
 */
const ChartOfAccount = require('../models/ChartOfAccount');

const CACHE_MS = 60 * 1000;
const cache = new Map();

async function hermanas(clinicId) {
  const { sisterClinicsSync, ensureCompanyCache } = require('./companies');
  await ensureCompanyCache();
  const ids = sisterClinicsSync(clinicId, { includeInactive: true }).map(String);
  return ids.length ? ids : [String(clinicId)];
}

async function clinicaDelPlan(clinicId) {
  if (!clinicId) return clinicId;
  const key = String(clinicId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.id;
  const ids = await hermanas(clinicId);
  let id = key;
  try {
    const { contificoSourceClinic } = require('../services/contificoSourceClinic');
    const central = await contificoSourceClinic();
    if (central && ids.includes(String(central._id))) id = String(central._id);
    else if (ids.length > 1) {
      const conteo = await ChartOfAccount.aggregate([
        { $match: { clinic: { $in: ids.map((x) => new (require('mongoose').Types.ObjectId)(x)) } } },
        { $group: { _id: '$clinic', n: { $sum: 1 } } },
        { $sort: { n: -1 } },
      ]);
      if (conteo[0]?._id) id = String(conteo[0]._id);
    }
  } catch (e) {
    id = key;
  }
  cache.set(key, { at: Date.now(), id });
  return id;
}

/** ¿`otraClinic` es de la misma empresa que `clinicId`? */
async function mismaEmpresa(clinicId, otraClinic) {
  return (await hermanas(clinicId)).includes(String(otraClinic));
}

/**
 * Copia `acc` (y sus padres) al plan de `clinicId` con el mismo código; si ya está, la de allí.
 * Solo entre sedes de la MISMA empresa.
 */
async function cuentaEnSucursal(acc, clinicId, session = null) {
  if (!acc) return null;
  if (String(acc.clinic) === String(clinicId)) return acc;
  if (!(await mismaEmpresa(clinicId, acc.clinic))) return null;
  const { copiarAlPlan } = require('./accountMap');
  return copiarAlPlan(acc, clinicId, session);
}

module.exports = { clinicaDelPlan, cuentaEnSucursal, mismaEmpresa, hermanas };
