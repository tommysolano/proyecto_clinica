const CallCenterWhatsappConfig = require('../models/CallCenterWhatsappConfig');

/**
 * El call center es ÚNICO para toda la organización: todos los agentes comparten la
 * misma bandeja, sin importar su sucursal activa. Para lograrlo, este middleware hace
 * que las rutas del call center (chats, tareas) operen sobre UNA sola clínica: la
 * "sede del call center" (callCenterClinic de la config global de WhatsApp).
 *
 * Así, aunque cada agente tenga una sucursal activa distinta en su sesión, todos ven
 * y atienden las mismas conversaciones (y los mensajes de TODOS los números entran a
 * esa misma bandeja). Guarda la sucursal real del agente en `req.userClinicId` por si
 * algún endpoint la necesita. Si no hay sede configurada, no cambia nada (fallback).
 *
 * Cachea la sede 30s para no consultar la BD en cada request.
 */
let cache = { clinicId: null, at: 0 };

module.exports = async function callCenterScope(req, res, next) {
  try {
    const now = Date.now();
    if (now - cache.at > 30000) {
      const cfg = await CallCenterWhatsappConfig.getSingleton();
      cache = { clinicId: cfg.callCenterClinic ? String(cfg.callCenterClinic) : null, at: now };
    }
    if (cache.clinicId) {
      req.userClinicId = req.clinicId; // sucursal real del agente
      req.clinicId = cache.clinicId; // bandeja única del call center
    }
  } catch {
    /* si falla, se mantiene la clínica activa del agente */
  }
  next();
};
