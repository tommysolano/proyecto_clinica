'use strict';

// El histórico de Contífico se conserva en su almacén de importación, con los
// centros originales. Los centros y bodegas operativos pertenecen a cada sucursal.
// accountingDataClinic indica dónde leer el histórico; los documentos nuevos se
// escriben en la sucursal. `company` muestra el histórico completo.
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
require('../models/CostCenter');

// Corre en cada petición contable: el vínculo sucursal-centro casi nunca cambia.
const CACHE_MS = 60 * 1000;
const cache = new Map();

async function linkedCostCenter(clinicId) {
  const key = String(clinicId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.mapping;
  const clinic = await Clinic.findById(clinicId).select('name accountingCostCenter accountingDataClinic accountingImportCostCenters')
    .populate('accountingCostCenter', 'code name clinic').lean();
  const mapping = { costCenter: clinic?.accountingCostCenter || null,
    dataClinic: clinic?.accountingDataClinic || null,
    importCostCenters: clinic?.accountingImportCostCenters || [] };
  cache.set(key, { at: Date.now(), mapping });
  return mapping;
}

async function accountingScope(clinicId, { company = false } = {}) {
  const { costCenter, dataClinic, importCostCenters } = await linkedCostCenter(clinicId);
  if (!costCenter) {
    return { dataClinic: new mongoose.Types.ObjectId(String(clinicId)), costCenter: null, linked: false, company: false };
  }
  return { dataClinic: new mongoose.Types.ObjectId(String(dataClinic || costCenter.clinic)),
    costCenter: company ? null : costCenter,
    costCenterIds: company ? [] : (importCostCenters.length ? importCostCenters : [costCenter._id]),
    sucursalCostCenter: costCenter, linked: true, company: Boolean(company) };
}

/** Lo que el cliente necesita para mostrar el alcance activo. */
function describeScope(scope) {
  if (!scope?.linked) return { linked: false, company: false, costCenter: null, sucursalCostCenter: null };
  const pick = (center) => (center ? { _id: center._id, code: center.code, name: center.name } : null);
  return { linked: true, company: scope.company, costCenter: pick(scope.costCenter), sucursalCostCenter: pick(scope.sucursalCostCenter) };
}

module.exports = { accountingScope, describeScope };
