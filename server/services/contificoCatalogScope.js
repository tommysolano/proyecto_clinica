'use strict';

const Clinic = require('../models/Clinic');

/** Catálogos de una única empresa de Contífico; excluye otras empresas. */
async function catalogClinics(sourceClinicId) {
  const source = await Clinic.findById(sourceClinicId).select('_id company name').lean();
  // Algunas tareas prueban mapas con un ID de sucursal aún no persistido.
  if (!source) return { ids: [sourceClinicId], byName: new Map(), source: sourceClinicId };
  if (!source.company) return { ids: [source._id], byName: new Map([[source.name, source._id]]), source: source._id };
  const clinics = await Clinic.find({ company: source.company }).select('_id name').lean();
  return { ids: clinics.map((clinic) => clinic._id),
    byName: new Map(clinics.map((clinic) => [clinic.name, clinic._id])), source: source._id };
}

function ownerForCostCenter(scope, code) {
  const branch = { '2': 'Extensión', '3': 'Extensión', '5': 'Laboratorio' }[String(code)];
  return (branch && scope.byName.get(branch)) || scope.source;
}

function ownerForWarehouse(scope, code) {
  const branch = { BOD004: 'Extensión', BOD005: 'Laboratorio' }[String(code)];
  return (branch && scope.byName.get(branch)) || scope.source;
}

module.exports = { catalogClinics, ownerForCostCenter, ownerForWarehouse };
