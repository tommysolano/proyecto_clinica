'use strict';

// Alcance contable de la sucursal activa. La contabilidad de Contífico vive en una
// sola sucursal (Central); Central, Extensión y Laboratorio están ligadas a su centro
// de costo (Clinic.accountingCostCenter). Una sucursal ligada lee los datos de la
// sucursal dueña del centro, filtrados por ese centro; `company` muestra la empresa
// entera. Una sucursal sin centro ligado conserva sus propios datos.
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
require('../models/CostCenter');

// Corre en cada petición contable: el vínculo sucursal-centro casi nunca cambia.
const CACHE_MS = 60 * 1000;
const cache = new Map();

async function linkedCostCenter(clinicId) {
  const key = String(clinicId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.costCenter;
  const clinic = await Clinic.findById(clinicId).select('name accountingCostCenter')
    .populate('accountingCostCenter', 'code name clinic').lean();
  const costCenter = clinic?.accountingCostCenter || null;
  cache.set(key, { at: Date.now(), costCenter });
  return costCenter;
}

async function accountingScope(clinicId, { company = false } = {}) {
  const costCenter = await linkedCostCenter(clinicId);
  if (!costCenter) {
    return { dataClinic: new mongoose.Types.ObjectId(String(clinicId)), costCenter: null, linked: false, company: false };
  }
  return { dataClinic: new mongoose.Types.ObjectId(String(costCenter.clinic)),
    costCenter: company ? null : costCenter, sucursalCostCenter: costCenter, linked: true, company: Boolean(company) };
}

/** Lo que el cliente necesita para mostrar el alcance activo. */
function describeScope(scope) {
  if (!scope?.linked) return { linked: false, company: false, costCenter: null, sucursalCostCenter: null };
  const pick = (center) => (center ? { _id: center._id, code: center.code, name: center.name } : null);
  return { linked: true, company: scope.company, costCenter: pick(scope.costCenter), sucursalCostCenter: pick(scope.sucursalCostCenter) };
}

module.exports = { accountingScope, describeScope };
