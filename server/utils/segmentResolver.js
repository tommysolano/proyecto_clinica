const mongoose = require('mongoose');
const Patient = require('../models/Patient');
const Treatment = require('../models/Treatment');
const Appointment = require('../models/Appointment');
const Product = require('../models/Product');
const Sale = require('../models/Sale');

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

/**
 * Construye el match de Mongo para los filtros que viven directamente en Patient
 * (source, tags, género, edad, opt-in). Es PURO y testeable sin BD.
 */
function buildPatientMatch(filters = {}, now = new Date()) {
  const match = { active: true };

  if (Array.isArray(filters.sources) && filters.sources.length) {
    match.source = { $in: filters.sources };
  }
  if (Array.isArray(filters.tags) && filters.tags.length) {
    match.tags = { $all: filters.tags };
  }
  if (filters.gender) {
    match.gender = filters.gender;
  }

  // Edad → rango de birthDate (edad mayor = nacimiento más antiguo).
  const { min, max } = filters.ageRange || {};
  if (min != null || max != null) {
    match.birthDate = {};
    if (min != null) match.birthDate.$lte = new Date(now.getTime() - Number(min) * YEAR_MS);
    if (max != null) match.birthDate.$gte = new Date(now.getTime() - (Number(max) + 1) * YEAR_MS);
  }

  // Opt-in: excluye opt-out global y respeta el consentimiento del canal.
  if (filters.hasOptIn === 'whatsapp') {
    match['marketing.optOutAt'] = null;
    match['marketing.whatsappOptIn'] = { $ne: false };
  } else if (filters.hasOptIn === 'email') {
    match['marketing.optOutAt'] = null;
    match['marketing.emailOptIn'] = { $ne: false };
    match.email = { $nin: [null, ''] };
  }

  return match;
}

/** Expande un programa a la lista de productos/servicios que lo componen. */
async function resolveServiceIds(clinicId, filters) {
  if (filters.program) {
    const prog = await Product.findById(filters.program).select('programServices');
    const ids = (prog?.programServices || []).map((p) => p.product).filter(Boolean);
    return ids.length ? ids : null;
  }
  if (filters.service) return [new mongoose.Types.ObjectId(filters.service)];
  return null;
}

// CRM global: los cruces (tratamiento/inactividad/zona) abarcan TODA la organización,
// no una sucursal, para que los segmentos/campañas alcancen a todos los pacientes.

/** IDs de pacientes con un tratamiento que cumple estado/servicio. */
async function patientIdsByTreatment(_clinicObjId, filters, serviceIds) {
  const treatmentMatch = {};
  if (filters.treatmentStatus) treatmentMatch.status = filters.treatmentStatus;
  if (serviceIds) treatmentMatch['items.product'] = { $in: serviceIds };
  const rows = await Treatment.find(treatmentMatch).select('patient').lean();
  return rows.map((t) => String(t.patient)).filter(Boolean);
}

/** IDs de pacientes cuya última cita asistida fue hace >= N días. */
async function patientIdsByInactivity(_clinicObjId, days, now = new Date()) {
  const cutoff = new Date(now.getTime() - Number(days) * 24 * 60 * 60 * 1000);
  const rows = await Appointment.aggregate([
    { $match: { status: { $in: ['asistida', 'completada'] } } },
    { $group: { _id: '$patient', lastVisit: { $max: '$date' } } },
    { $match: { lastVisit: { $lte: cutoff } } },
  ]);
  return rows.map((r) => String(r._id)).filter(Boolean);
}

/** IDs de pacientes con ventas en una zona facturada. */
async function patientIdsByZone(_clinicObjId, zone) {
  const rows = await Sale.find({ clientZone: zone }).select('patient').lean();
  return rows.map((s) => String(s.patient)).filter(Boolean);
}

/** Intersección de varias listas de IDs (todas deben contener al paciente). */
function intersectIdLists(lists) {
  if (!lists.length) return null; // sin restricciones cruzadas
  return lists.reduce((acc, list) => {
    const set = new Set(list);
    return acc === null ? [...set] : acc.filter((id) => set.has(id));
  }, null);
}

/**
 * Resuelve un segmento a una lista de pacientes (documentos ligeros).
 * Devuelve { count, patients:[{ _id, name, phone, whatsapp, email, marketing }] }.
 */
async function resolveSegment(clinicId, filters = {}, { limit = 5000 } = {}) {
  const now = new Date();
  // CRM global: el segmento abarca a los pacientes de TODA la organización (no por sucursal).
  const match = buildPatientMatch(filters, now);

  // Restricciones que requieren cruzar colecciones → listas de patientId a intersectar.
  const crossLists = [];
  const serviceIds = await resolveServiceIds(clinicId, filters);
  if (filters.treatmentStatus || serviceIds) {
    crossLists.push(await patientIdsByTreatment(null, filters, serviceIds));
  }
  if (filters.daysSinceLastVisit != null) {
    crossLists.push(await patientIdsByInactivity(null, filters.daysSinceLastVisit, now));
  }
  if (filters.zone) {
    crossLists.push(await patientIdsByZone(null, filters.zone));
  }

  const intersected = intersectIdLists(crossLists);
  if (intersected !== null) {
    if (intersected.length === 0) return { count: 0, patients: [] };
    match._id = { $in: intersected.map((id) => new mongoose.Types.ObjectId(id)) };
  }

  const docs = await Patient.find(match)
    .select('firstName lastName phone whatsapp email marketing tags source')
    .limit(limit)
    .lean();

  const patients = docs.map((p) => ({
    _id: p._id,
    name: `${p.firstName || ''} ${p.lastName || ''}`.trim(),
    phone: p.phone || '',
    whatsapp: p.whatsapp || p.phone || '',
    email: p.email || '',
    marketing: p.marketing || {},
    tags: p.tags || [],
  }));

  return { count: patients.length, patients };
}

module.exports = {
  buildPatientMatch,
  intersectIdLists,
  resolveSegment,
  YEAR_MS,
};
