const mongoose = require('mongoose');

/**
 * Configuración GLOBAL de WhatsApp del call center (singleton).
 *
 * Guarda los datos compartidos a nivel de app que NO son por número:
 *  - cloudApi.appSecret / verifyToken: validan el webhook único de Meta para
 *    TODOS los números Cloud API (el appSecret y el verify token son de la app,
 *    no del número). appSecret se cifra en reposo.
 *  - callCenterClinic: la "sede" del call center, es decir, en qué bandeja
 *    (clínica) caen las conversaciones de WhatsApp. El call center agenda para
 *    cualquier sucursal, pero las conversaciones viven bajo esta clínica.
 *
 * Es un único documento: se obtiene/crea con getSingleton().
 */
const callCenterWhatsappConfigSchema = new mongoose.Schema(
  {
    singleton: { type: String, default: 'main', unique: true },
    cloudApi: {
      appSecret: { type: String, default: '' }, // cifrado — valida firma X-Hub-Signature-256
      verifyToken: { type: String, default: '' }, // handshake del webhook GET
    },
    // Meta Conversions API (CAPI): reporta conversiones del chat (Lead/Schedule/
    // Purchase) al Administrador de Eventos para optimizar campañas (CRO).
    conversionsApi: {
      enabled: { type: Boolean, default: false },
      datasetId: { type: String, default: '' }, // Pixel ID / Dataset ID del Administrador de Eventos
      accessToken: { type: String, default: '' }, // cifrado — token de la Conversions API
      testEventCode: { type: String, default: '' }, // código "Probar eventos" (solo pruebas)
    },
    // Meta Marketing API: para añadir/quitar contactos de Públicos Personalizados
    // (retargeting) desde las automatizaciones. Necesita un token de Usuario del
    // Sistema con permiso `ads_management`. El token se cifra en reposo.
    marketingApi: {
      enabled: { type: Boolean, default: false },
      accessToken: { type: String, default: '' }, // cifrado — Usuario del Sistema con ads_management
    },
    callCenterClinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

callCenterWhatsappConfigSchema.statics.getSingleton = async function getSingleton() {
  let doc = await this.findOne({ singleton: 'main' });
  if (!doc) doc = await this.create({ singleton: 'main' });
  return doc;
};

module.exports = mongoose.model('CallCenterWhatsappConfig', callCenterWhatsappConfigSchema);
