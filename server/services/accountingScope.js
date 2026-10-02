'use strict';

// Alcance contable de la sucursal activa. La contabilidad de Contífico vive en una
// sola sucursal (Central); Central, Extensión y Laboratorio están ligadas a su centro
// de costo (Clinic.accountingCostCenter). Una sucursal ligada lee los datos de la
// sucursal dueña del centro, filtrados por ese centro; `company` muestra la empresa
// entera. Una sucursal sin centro ligado conserva sus propios datos.
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
require('../models/CostCenter');

async function accountingScope(clinicId, { company = false } = {}) {
  const clinic = await Clinic.findById(clinicId).select('name accountingCostCenter')
    .populate('accountingCostCenter', 'code name clinic').lean();
  const costCenter = clinic?.accountingCostCenter || null;
  if (!costCenter) {
    return { dataClinic: new mongoose.Types.ObjectId(String(clinicId)), costCenter: null, linked: false, company: false };
  }
  return { dataClinic: new mongoose.Types.ObjectId(String(costCenter.clinic)),
    costCenter: company ? null : costCenter, sucursalCostCenter: costCenter, linked: true, company: Boolean(company) };
}

module.exports = { accountingScope };
