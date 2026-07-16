const mongoose = require('mongoose');

/**
 * Contacto del CRM: la identidad de MENSAJERÍA, separada del paciente.
 *
 * La regla del negocio: "un paciente puede ser un contacto, pero un contacto no
 * necesariamente es un paciente" — el trabajo del CRM es justamente convertir
 * contactos en pacientes. Por eso:
 *
 *   - Un contacto puede existir con solo un teléfono (sin nombre ni cédula), que
 *     es lo que trae un Excel de WhatsApp. `Patient` no sirve para esto: exige
 *     nombre y apellido, y llenar la base clínica de 47k desconocidos rompería
 *     reportes, dashboard y hasta el job de cumpleaños.
 *   - Cuando el contacto agenda, se enlaza con su paciente (`patient`), sin
 *     duplicar la ficha clínica.
 *   - Todo paciente con teléfono tiene su contacto espejo, para poder mandarle
 *     campañas desde el mismo sitio que a los importados.
 *
 * El TELÉFONO es la identidad: se guarda normalizado a E.164 sin '+' (mismo
 * formato que `Conversation.phone`), y es único por sede. Ver utils/phoneNormalize.
 */
const contactSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },

    // E.164 sin '+' (593999111222). Es la clave de deduplicación.
    phone: { type: String, required: true, trim: true },
    email: { type: String, lowercase: true, trim: true, default: '' },

    // Opcionales a propósito: un contacto importado puede ser solo un número.
    firstName: { type: String, trim: true, default: '' },
    lastName: { type: String, trim: true, default: '' },
    // Nombre tal cual venía en el archivo cuando no se puede partir en nombre y
    // apellido (en WhatsApp la gente se guarda como "Emily 🍓" o "Dome").
    displayName: { type: String, trim: true, default: '' },

    tags: { type: [String], default: [], index: true },
    // Listas FIJAS a las que pertenece (los grupos por filtro se resuelven solos).
    groups: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ContactGroup', index: true }],

    // Ficha clínica, si este contacto ya se convirtió en paciente.
    patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', default: null, index: true },
    convertedAt: { type: Date, default: null },

    marketing: {
      whatsappOptIn: { type: Boolean, default: true },
      emailOptIn: { type: Boolean, default: true },
      optOutAt: { type: Date, default: null },
      optOutReason: { type: String, trim: true, default: '' },
      // De dónde salió el consentimiento (formulario, feria, cliente previo…).
      // Es la defensa si Meta pregunta por qué se escribe a este número.
      consentSource: { type: String, trim: true, default: '' },
    },

    // De dónde salió el contacto.
    source: {
      type: String,
      enum: ['import', 'chat', 'manual', 'patient', 'ad'],
      default: 'manual',
      index: true,
    },
    // Lote de importación del que vino: permite deshacer una importación entera.
    importBatch: { type: mongoose.Schema.Types.ObjectId, ref: 'ContactImport', default: null, index: true },

    // Columnas del Excel que el usuario mapeó a "campo personalizado" (ciudad,
    // interés…). Clave → valor, sin esquema fijo: cada clínica trae las suyas.
    customFields: { type: Map, of: String, default: () => new Map() },

    notes: { type: String, trim: true, default: '' },
    active: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Identidad: un teléfono = un contacto por sede. Es lo que hace que reimportar
// el mismo Excel actualice en vez de duplicar.
contactSchema.index({ clinic: 1, phone: 1 }, { unique: true });
// Listado por defecto (los más nuevos primero) y búsqueda por nombre.
contactSchema.index({ clinic: 1, createdAt: -1 });

/** Nombre para mostrar: lo que haya, y si no el teléfono. */
contactSchema.virtual('name').get(function () {
  const full = `${this.firstName || ''} ${this.lastName || ''}`.trim();
  return full || this.displayName || this.phone;
});

contactSchema.set('toJSON', { virtuals: true });
contactSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Contact', contactSchema);
