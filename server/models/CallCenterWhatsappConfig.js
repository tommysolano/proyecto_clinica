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
