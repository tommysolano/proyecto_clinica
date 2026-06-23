const Clinic = require('../models/Clinic');
const CallCenterWhatsappConfig = require('../models/CallCenterWhatsappConfig');

/**
 * El CRM / call center es ÚNICO para toda la organización (no por sucursal). Toda
 * su data (conversaciones, campañas, segmentos, plantillas, workflows, reseñas,
 * tareas) vive internamente bajo UNA clínica "ancla", transparente para el usuario.
 *
 * Esta clínica se resuelve automáticamente: si hay una configurada en la config
 * global la usa; si no, toma la clínica más antigua (principal). El usuario NO la
 * elige en ningún lado.
 *
 * Se cachea 30s para no consultar la BD en cada request.
 */
let cache = { id: null, at: 0 };

async function resolveCallCenterClinicId() {
  const now = Date.now();
  if (cache.id && now - cache.at < 30000) return cache.id;
  let id = null;
  try {
    const cfg = await CallCenterWhatsappConfig.getSingleton();
    if (cfg.callCenterClinic) id = String(cfg.callCenterClinic);
    if (!id) {
      const clinic = await Clinic.findOne().sort({ createdAt: 1 }).select('_id');
      id = clinic ? String(clinic._id) : null;
    }
  } catch {
    /* deja id en null → el caller hace fallback a su clínica activa */
  }
  cache = { id, at: now };
  return id;
}

function clearCache() {
  cache = { id: null, at: 0 };
}

module.exports = { resolveCallCenterClinicId, clearCache };
