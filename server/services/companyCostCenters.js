const Clinic = require('../models/Clinic');
const Company = require('../models/Company');

// Las sucursales sin empresa asignada pertenecen a la empresa predeterminada.
async function companyClinicIds(clinicId, session = null) {
  const query = (q) => (session ? q.session(session) : q);
  const clinic = await query(Clinic.findById(clinicId).select('company')).lean();
  if (!clinic) return [clinicId];
  const defaultCompany = await query(Company.findOne({ isDefault: true }).select('_id')).lean();
  const companyId = clinic.company || defaultCompany?._id;
  if (!companyId) return [clinicId];
  const isDefault = defaultCompany && String(defaultCompany._id) === String(companyId);
  const filter = isDefault ? { $or: [{ company: companyId }, { company: null }] } : { company: companyId };
  const clinics = await query(Clinic.find(filter).select('_id')).lean();
  return clinics.map((item) => item._id);
}

module.exports = { companyClinicIds };
