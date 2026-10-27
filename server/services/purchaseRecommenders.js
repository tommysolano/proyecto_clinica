const User = require('../models/User');
const { DOCTOR_LIKE_ROLES, NURSE_ROLE } = require('../constants/roles');
const { ensureCompanyCache, companyOfClinicSync, sisterClinicsSync, coversClinic, roleForCoveredClinic } = require('../utils/companies');

const CLINICAL_ROLES = [...DOCTOR_LIKE_ROLES, NURSE_ROLE];

// La recomendación puede venir de cualquier sucursal de la misma empresa.
async function recommendersForClinic(clinicId) {
  await ensureCompanyCache();
  const companyId = companyOfClinicSync(clinicId);
  const clinicIds = sisterClinicsSync(clinicId);
  const ids = clinicIds.length ? clinicIds : [clinicId];
  const users = await User.find({
    active: true,
    $or: [
      { clinics: { $elemMatch: { clinic: { $in: ids }, role: { $in: CLINICAL_ROLES } } } },
      ...(companyId ? [{
        worksInAllClinics: true,
        companies: companyId,
        clinics: { $elemMatch: { role: { $in: CLINICAL_ROLES } } },
      }] : []),
    ],
  }).select('_id name clinics worksInAllClinics companies').sort({ name: 1 }).lean();
  return users.flatMap((user) => {
    const directRole = user.clinics.find((assignment) => ids.some((id) => String(id) === String(assignment.clinic))
      && CLINICAL_ROLES.includes(assignment.role))?.role;
    const coveredRole = coversClinic(user, clinicId) ? roleForCoveredClinic(user, clinicId) : null;
    const role = directRole || (CLINICAL_ROLES.includes(coveredRole) ? coveredRole : null);
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
