const User = require('../models/User');
const { ensureCompanyCache, companyOfClinicSync, sisterClinicsSync, coversClinic, roleForCoveredClinic } = require('../utils/companies');

/**
 * Quién puede figurar como «Recomendado por (comisión)» en un cobro: CUALQUIER usuario
 * activo del sistema con rol en alguna sucursal de la misma empresa (nov-2026: antes solo
 * doctores y enfermería, pero la venta también la atribuyen a caja, call center, marketing…).
 */
async function recommendersForClinic(clinicId) {
  await ensureCompanyCache();
  const companyId = companyOfClinicSync(clinicId);
  const clinicIds = sisterClinicsSync(clinicId);
  const ids = clinicIds.length ? clinicIds : [clinicId];
  const users = await User.find({
    active: true,
    $or: [
      { clinics: { $elemMatch: { clinic: { $in: ids } } } },
      ...(companyId ? [{ worksInAllClinics: true, companies: companyId }] : []),
    ],
  }).select('_id name clinics worksInAllClinics companies').sort({ name: 1 }).lean();
  return users.flatMap((user) => {
    // Rol para mostrar: el de esta sucursal si lo tiene; si no, el de otra sede de la empresa.
    const enEsta = user.clinics.find((a) => String(a.clinic) === String(clinicId))?.role;
    const enLaEmpresa = user.clinics.find((a) => ids.some((id) => String(id) === String(a.clinic)))?.role;
    const cubierta = coversClinic(user, clinicId) ? roleForCoveredClinic(user, clinicId) : null;
    const role = enEsta || enLaEmpresa || cubierta;
    return role ? [{ ...user, recommendationRole: role }] : [];
  });
}

async function findRecommender(clinicId, userId) {
  if (!userId) return null;
  if (!User.db.base.Types.ObjectId.isValid(userId)) return null;
  const users = await recommendersForClinic(clinicId);
  return users.find((user) => String(user._id) === String(userId)) || null;
}

module.exports = { recommendersForClinic, findRecommender };
