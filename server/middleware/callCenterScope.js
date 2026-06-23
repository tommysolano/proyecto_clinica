const { resolveCallCenterClinicId } = require('../utils/callCenterClinic');

/**
 * El CRM / call center es ÚNICO para toda la organización: NO funciona por sucursal.
 * Este middleware hace que las rutas del CRM (chats, tareas, campañas, segmentos,
 * plantillas, workflows, reseñas, auto-agendamiento) operen sobre la clínica "ancla"
 * del call center (resuelta automáticamente), sin importar la sucursal activa del
 * usuario. Así todos los agentes comparten la MISMA bandeja y la misma data de CRM.
 *
 * Guarda la sucursal real del agente en `req.userClinicId` por si algún endpoint la
 * necesita. Si no se puede resolver la clínica ancla, se mantiene la activa (fallback).
 */
module.exports = async function callCenterScope(req, res, next) {
  try {
    const clinicId = await resolveCallCenterClinicId();
    if (clinicId) {
      req.userClinicId = req.clinicId; // sucursal real del agente
      req.clinicId = clinicId; // clínica ancla del CRM (única)
    }
  } catch {
    /* si falla, se mantiene la clínica activa del agente */
  }
  next();
};
