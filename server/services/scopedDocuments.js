'use strict';

/**
 * La importación histórica sigue en el almacén contable de Contífico. Una venta
 * nueva se guarda en la sucursal que la efectuó. Ambos conjuntos deben ser
 * visibles en la sucursal, sin exponer documentos de otro centro histórico.
 */
function scopedDocuments(req, costCenterField = 'costCenter') {
  if (req.companyClinicIds?.length) return { clinic: { $in: req.companyClinicIds } };
  const historical = { clinic: req.clinicId };
  if (req.costCenterScope) historical[costCenterField] = req.costCenterScope;
  if (!req.userClinicId || String(req.userClinicId) === String(req.clinicId)) return historical;
  return { $or: [historical, { clinic: req.userClinicId }] };
}

module.exports = { scopedDocuments };
