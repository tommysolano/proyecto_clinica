'use strict';

const Company = require('../models/Company');
const Clinic = require('../models/Clinic');

/** Sucursal de archivo de Contífico, limitada a la empresa principal. */
async function contificoSourceClinic() {
  const company = await Company.findOne({ isDefault: true }).select('_id').lean();
  return Clinic.findOne({ name: /^Central$/i, ...(company ? { company: company._id } : {}) }).lean();
}

module.exports = { contificoSourceClinic };
