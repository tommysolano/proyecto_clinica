const RetentionRule = require('../models/RetentionRule');

/**
 * Seed inicial de reglas de retención (Ecuador, SRI). Es solo un PUNTO DE PARTIDA con
 * códigos comunes; las tarifas del SRI cambian, así que el catálogo es EDITABLE por la
 * clínica (crear/editar/activar/desactivar reglas y asignar cuenta). No debe tomarse
 * como la única fuente ni como tarifas oficiales vigentes; el contador debe validarlas.
 *
 * `payableAccount` se deja sin fijar: se resuelve por accountMap
 * (retIvaPorPagar / retRentaPorPagar) salvo que la clínica configure una cuenta propia.
 */
const DEFAULT_RETENTION_RULES = [
  // ── Retenciones en la fuente de RENTA (base = subtotal sin IVA) ──
  { type: 'RENTA', code: '312', description: 'Compra de bienes muebles', rate: 1.75, appliesTo: 'BIENES', baseType: 'SUBTOTAL_TOTAL' },
  { type: 'RENTA', code: '310', description: 'Transporte privado de pasajeros o carga', rate: 1, appliesTo: 'TRANSPORTE', baseType: 'SUBTOTAL_TOTAL' },
  { type: 'RENTA', code: '307', description: 'Servicios (predomina la mano de obra)', rate: 2, appliesTo: 'SERVICIOS', baseType: 'SUBTOTAL_TOTAL' },
  { type: 'RENTA', code: '304', description: 'Servicios (predomina el intelecto)', rate: 8, appliesTo: 'SERVICIOS', baseType: 'SUBTOTAL_TOTAL' },
  { type: 'RENTA', code: '303', description: 'Honorarios profesionales', rate: 10, appliesTo: 'HONORARIOS', baseType: 'SUBTOTAL_TOTAL' },
  { type: 'RENTA', code: '320', description: 'Arrendamiento de bienes inmuebles', rate: 8, appliesTo: 'ARRENDAMIENTO', baseType: 'SUBTOTAL_TOTAL' },
  // ── Retenciones de IVA (base = monto de IVA de la línea) ──
  { type: 'IVA', code: '721', description: 'Retención IVA 30% (bienes)', rate: 30, appliesTo: 'BIENES', baseType: 'IVA' },
  { type: 'IVA', code: '723', description: 'Retención IVA 70% (servicios)', rate: 70, appliesTo: 'SERVICIOS', baseType: 'IVA' },
  { type: 'IVA', code: '725', description: 'Retención IVA 100%', rate: 100, appliesTo: 'OTRO', baseType: 'IVA' },
];

/**
 * Crea (idempotente) las reglas por defecto que falten para una clínica. No pisa reglas
 * existentes (respeta ediciones del contador). Devuelve { created, existing }.
 */
async function seedRetentionRules(clinicId, { session, createdBy = null } = {}) {
  let created = 0;
  let existing = 0;
  for (const r of DEFAULT_RETENTION_RULES) {
    const found = await RetentionRule.findOne({ clinic: clinicId, type: r.type, code: r.code }).session(session || null);
    if (found) { existing++; continue; }
    await RetentionRule.create([{ ...r, clinic: clinicId, createdBy }], session ? { session } : undefined);
    created++;
  }
  return { created, existing };
}

module.exports = { DEFAULT_RETENTION_RULES, seedRetentionRules };
