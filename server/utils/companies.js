/**
 * EMPRESAS (oct-2026): a qué empresa pertenece cada sucursal, y qué alcanza cada persona.
 *
 * La empresa cuelga solo de la sucursal (`Clinic.company`). Casi todo el sistema ya
 * filtra por sucursal; lo que filtraba por «toda la organización» pasa a filtrar por
 * «toda la EMPRESA», salvo el CRM y los pacientes, que son de todas.
 *
 * Las preguntas de aquí se hacen en caliente y de forma síncrona (p. ej.
 * `User.getRoleForClinic`), así que el mapa sucursal → empresa vive en memoria. Son
 * unas pocas filas: se recarga cada 30 s y al instante cuando este proceso cambia una
 * sucursal o una empresa. `middleware/auth` lo calienta en cada petición.
 *
 * Si el mapa aún no está cargado (un script, un test que no lo pide), las respuestas
 * caen al comportamiento de antes de las empresas: nada se cierra a ciegas.
 */
const TTL_MS = 30 * 1000;

let state = { at: 0, clinicCompany: new Map(), companyClinics: new Map(), activeCompanyClinics: new Map(), defaultId: null };
let loading = null;

const str = (value) => (value ? String(value._id || value) : null);

async function refreshCompanyCache() {
  const Clinic = require('../models/Clinic');
  const Company = require('../models/Company');
  const [clinics, def] = await Promise.all([
    Clinic.find({}).select('_id company active').lean(),
    Company.findOne({ isDefault: true }).select('_id').lean(),
  ]);
  const clinicCompany = new Map();
  const companyClinics = new Map();
  const activeCompanyClinics = new Map();
  const defaultId = str(def);
  for (const clinic of clinics) {
    const company = str(clinic.company) || defaultId;
    clinicCompany.set(String(clinic._id), company);
    if (!company) continue;
    if (!companyClinics.has(company)) companyClinics.set(company, []);
    companyClinics.get(company).push(String(clinic._id));
    if (clinic.active !== false) {
      if (!activeCompanyClinics.has(company)) activeCompanyClinics.set(company, []);
      activeCompanyClinics.get(company).push(String(clinic._id));
    }
  }
  state = { at: Date.now(), clinicCompany, companyClinics, activeCompanyClinics, defaultId };
  return state;
}

/** Recarga si está viejo. Dos peticiones a la vez comparten la misma lectura. */
async function ensureCompanyCache() {
  if (Date.now() - state.at < TTL_MS) return state;
  if (!loading) loading = refreshCompanyCache().finally(() => { loading = null; });
  return loading;
}

/** Este proceso cambió una sucursal o una empresa: la próxima pregunta relee. */
function invalidateCompanyCache() {
  state = { ...state, at: 0 };
}

const isCompanyCacheLoaded = () => state.clinicCompany.size > 0;

/** Empresa de una sucursal (id en texto), o null si no se sabe. */
function companyOfClinicSync(clinicId) {
  if (!clinicId) return null;
  return state.clinicCompany.get(String(clinicId)) || null;
}

async function companyOfClinic(clinicId) {
  await ensureCompanyCache();
  return companyOfClinicSync(clinicId);
}

/** Sucursales de una empresa (ids en texto). `includeInactive` incluye las dadas de baja. */
function clinicsOfCompanySync(companyId, { includeInactive = false } = {}) {
  if (!companyId) return [];
  const map = includeInactive ? state.companyClinics : state.activeCompanyClinics;
  return [...(map.get(String(companyId)) || [])];
}

async function clinicsOfCompany(companyId, options) {
  await ensureCompanyCache();
  return clinicsOfCompanySync(companyId, options);
}

/** Sucursales de la empresa de esta sucursal (la propia incluida). */
function sisterClinicsSync(clinicId, options) {
  const company = companyOfClinicSync(clinicId);
  return company ? clinicsOfCompanySync(company, options) : [];
}

/**
 * EMPRESAS DE UNA PERSONA (ids en texto): las marcadas en `companies` más las de las
 * sucursales donde tiene rol. Las dos cosas cuentan: quien tiene rol en una sucursal
 * trabaja en esa empresa aunque nadie lo haya marcado a mano.
 */
function userCompanyIds(user) {
  const ids = new Set((user?.companies || []).map(str).filter(Boolean));
  for (const assignment of user?.clinics || []) {
    const company = companyOfClinicSync(assignment.clinic);
    if (company) ids.add(company);
  }
  return [...ids];
}

/**
 * ¿«TRABAJA EN TODAS LAS SUCURSALES» ALCANZA ESTA? Solo las de sus empresas. Sin
 * mapa cargado se responde como antes de las empresas (todas).
 */
function coversClinic(user, clinicId) {
  if (!user?.worksInAllClinics) return false;
  const company = companyOfClinicSync(clinicId);
  if (!company || !isCompanyCacheLoaded()) return true;
  return userCompanyIds(user).includes(company);
}

/**
 * Rol de alguien «en todas» en una sucursal que no tiene asignada: el de una sucursal
 * de la MISMA empresa si la hay (en otra empresa puede tener otro rol), si no el primero.
 */
function roleForCoveredClinic(user, clinicId) {
  const company = companyOfClinicSync(clinicId);
  const same = company
    ? (user?.clinics || []).find((assignment) => companyOfClinicSync(assignment.clinic) === company)
    : null;
  return (same || user?.clinics?.[0])?.role || null;
}

/**
 * MIGRACIÓN AL ARRANCAR (idempotente; la puede correr cualquier instancia):
 *   1. Crea la empresa principal si no hay ninguna, con los datos de Central.
 *   2. Lo que no tenga empresa (sucursales, servicios de agenda) pasa a ser suyo.
 *   3. Rellena `User.companies` con las empresas de sus sucursales.
 *   4. Cambia el índice único de los servicios de agenda: de global a por empresa.
 */
async function ensureCompanies() {
  const Company = require('../models/Company');
  const Clinic = require('../models/Clinic');
  const User = require('../models/User');
  const AppointmentServiceItem = require('../models/AppointmentServiceItem');

  let def = await Company.findOne({ isDefault: true }).lean();
  if (!def) {
    const source = await Clinic.findOne({ name: /^Central$/i }).lean()
      || await Clinic.findOne({}).sort({ createdAt: 1 }).lean();
    try {
      def = (await Company.findOneAndUpdate({ isDefault: true }, { $setOnInsert: {
        isDefault: true,
        // La razón social nombra a la empresa (el nombre comercial de Central es "Central").
        name: source?.razonSocial || source?.nombreComercial || source?.name || 'Empresa principal',
        ruc: source?.ruc || undefined,
        razonSocial: source?.razonSocial || '',
        nombreComercial: source?.nombreComercial || '',
        logoUrl: source?.logoUrl || '',
      } }, { upsert: true, new: true, runValidators: false })).toObject();
    } catch (error) {
      // Otra instancia la creó en el mismo instante.
      if (error.code !== 11000) throw error;
      def = await Company.findOne({ isDefault: true }).lean();
    }
  }
  await Clinic.updateMany({ company: null }, { $set: { company: def._id } });
  invalidateCompanyCache();
  await refreshCompanyCache();

  const users = await User.find({ $or: [{ companies: { $exists: false } }, { companies: { $size: 0 } }],
    'clinics.0': { $exists: true } }).select('clinics companies').lean();
  const userOps = users.map((user) => ({ updateOne: { filter: { _id: user._id },
    update: { $set: { companies: userCompanyIds(user) } } } })).filter((op) => op.updateOne.update.$set.companies.length);
  if (userOps.length) await User.bulkWrite(userOps, { ordered: false });

  const items = await AppointmentServiceItem.find({ company: null }).select('clinic').lean();
  if (items.length) {
    await AppointmentServiceItem.bulkWrite(items.map((item) => ({ updateOne: { filter: { _id: item._id },
      update: { $set: { company: companyOfClinicSync(item.clinic) || def._id } } } })), { ordered: false });
  }
  const indexes = await AppointmentServiceItem.collection.indexes().catch(() => []);
  if (indexes.some((index) => index.name === 'slug_1')) {
    await AppointmentServiceItem.collection.dropIndex('slug_1').catch(() => {});
  }
  await AppointmentServiceItem.syncIndexes().catch((error) =>
    console.error('[empresas] Índice de servicios de agenda:', error.message));
  return { company: String(def._id), users: userOps.length, serviceItems: items.length };
}

/** Empresa principal (id en texto), o null si aún no hay ninguna. */
const defaultCompanyIdSync = () => state.defaultId;

module.exports = {
  refreshCompanyCache,
  ensureCompanyCache,
  invalidateCompanyCache,
  isCompanyCacheLoaded,
  companyOfClinicSync,
  companyOfClinic,
  clinicsOfCompanySync,
  clinicsOfCompany,
  sisterClinicsSync,
  userCompanyIds,
  coversClinic,
  roleForCoveredClinic,
  ensureCompanies,
  defaultCompanyIdSync,
};
