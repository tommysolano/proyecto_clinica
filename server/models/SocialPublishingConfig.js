const mongoose = require('mongoose');

/**
 * Configuración del planificador de redes sociales. UN documento, bajo la
 * clínica ancla del CRM (igual que el resto de Fénix: no depende de la empresa).
 *
 * Guarda las credenciales de NUESTRAS apps en cada plataforma (las que se crean
 * en developers.facebook.com, developers.tiktok.com y Google Cloud) y las
 * preferencias del equipo. Los secretos van cifrados (utils/secretCrypto) y al
 * cliente solo le llega si están puestos o no.
 */
const socialPublishingConfigSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, unique: true },
    meta: {
      appId: { type: String, trim: true, default: '' },
      appSecret: { type: String, default: '' },
    },
    tiktok: {
      clientKey: { type: String, trim: true, default: '' },
      clientSecret: { type: String, default: '' },
    },
    google: {
      clientId: { type: String, trim: true, default: '' },
      clientSecret: { type: String, default: '' },
    },
    /**
     * Token de USUARIO de Meta recién autorizado (OAuth o pegado a mano), a la
     * espera de que se elijan qué Páginas y cuentas de Instagram se agregan. Se
     * borra al agregarlas. Las Páginas se guardan con SU token, no con este.
     */
    metaPending: {
      userToken: { type: String, default: '' },
      at: { type: Date, default: null },
      via: { type: String, enum: ['oauth', 'token'], default: 'oauth' },
    },
    // Si está activo, lo que programa alguien que no es admin queda «en revisión»
    // hasta que un admin lo apruebe.
    requireApproval: { type: Boolean, default: false },
    hashtagGroups: {
      type: [
        new mongoose.Schema(
          {
            name: { type: String, trim: true, required: true },
            tags: { type: [String], default: [] },
          },
          { _id: true }
        ),
      ],
      default: [],
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

socialPublishingConfigSchema.statics.forClinic = async function forClinic(clinicId) {
  return this.findOneAndUpdate(
    { clinic: clinicId },
    { $setOnInsert: { clinic: clinicId } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
};

module.exports = mongoose.model('SocialPublishingConfig', socialPublishingConfigSchema);
