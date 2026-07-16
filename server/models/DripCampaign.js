const mongoose = require('mongoose');

/**
 * Envío masivo POR GOTEO a un grupo de contactos.
 *
 * Por qué a goteo y no de golpe:
 *  - Por **Cloud API**, Meta limita las conversaciones que inicia el negocio cada
 *    24 h según el nivel del número (250 / 1K / 10K / 100K). Pasarse no "encola":
 *    los mensajes fallan y la calidad del número cae.
 *  - Por **QR** (WhatsApp Web) no hay límite oficial, que es peor: una ráfaga de
 *    cientos de mensajes es exactamente el patrón por el que WhatsApp cierra la
 *    sesión y bloquea el número. El goteo imita el ritmo de una persona.
 *
 * El envío no se planifica de una vez: en cada tanda se resuelve la audiencia en
 * vivo y se salta a quien se haya dado de baja mientras tanto.
 */
const dripCampaignSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    name: { type: String, required: true, trim: true },

    // A quién: un grupo (fijo o por filtro). Sin grupo = todos los contactos a
    // los que se pueda escribir.
    group: { type: mongoose.Schema.Types.ObjectId, ref: 'ContactGroup', default: null },

    // Qué: por Cloud API hace falta una plantilla APROBADA (fuera de la ventana
    // de 24 h no hay otra). Por QR no existen las plantillas de Meta: se manda
    // `body` como texto libre.
    template: { type: mongoose.Schema.Types.ObjectId, ref: 'MessageTemplate', default: null },
    templateName: { type: String, trim: true, default: '' },
    templateLanguage: { type: String, trim: true, default: 'es' },
    body: { type: String, trim: true, default: '' },
    mediaUrl: { type: String, trim: true, default: '' },
    mediaType: { type: String, trim: true, default: '' },

    // Número por el que sale (si se deja vacío, el por defecto).
    whatsappAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'WhatsappAccount', default: null },

    // El goteo: cuántos mensajes por tanda y cada cuánto.
    batchSize: { type: Number, default: 20, min: 1, max: 500 },
    intervalMinutes: { type: Number, default: 15, min: 1 },
    // Franja horaria en la que se permite enviar (hora de Ecuador). Nadie quiere
    // recibir publicidad de una clínica a las 3 de la mañana.
    hourFrom: { type: String, trim: true, default: '09:00' },
    hourTo: { type: String, trim: true, default: '20:00' },
    // Días de la semana permitidos (0=domingo). Vacío = todos.
    days: { type: [Number], default: [] },

    // draft → running → paused → done | failed
    status: {
      type: String,
      enum: ['draft', 'running', 'paused', 'done', 'failed'],
      default: 'draft',
      index: true,
    },
    nextRunAt: { type: Date, default: null, index: true },

    // A quién ya se le mandó, para no repetir en la siguiente tanda. Se guardan
    // ids de contacto: con 47k son ~1 MB, aceptable frente a una colección aparte.
    sentContacts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Contact' }],

    stats: {
      total: { type: Number, default: 0 },   // audiencia estimada al arrancar
      sent: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      skipped: { type: Number, default: 0 }, // baja, sin opt-in, sin teléfono
    },
    lastError: { type: String, trim: true, default: '' },

    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdByName: { type: String, trim: true, default: '' },
  },
  { timestamps: true }
);

dripCampaignSchema.index({ clinic: 1, createdAt: -1 });

module.exports = mongoose.model('DripCampaign', dripCampaignSchema);
