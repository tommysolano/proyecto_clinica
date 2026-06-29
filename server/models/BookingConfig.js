const mongoose = require('mongoose');

/**
 * Configuración del auto-agendamiento público (link que el paciente abre para
 * reservar una cita él mismo). Una por clínica. `token` es el slug público del link.
 */
const bookingServiceSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    name: { type: String, trim: true, default: '' },
    durationMinutes: { type: Number, default: 30, min: 5 },
  },
  { _id: false }
);

// Programa reservable que se muestra como "tarjeta" en la landing (estilo
// "Experiencias" de OpenTable). Referencia a un Product (category 'programa')
// con datos de presentación propios para la página pública.
const bookingProgramSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    name: { type: String, trim: true, default: '' },
    description: { type: String, trim: true, default: '' },
    imageUrl: { type: String, trim: true, default: '' },
    priceLabel: { type: String, trim: true, default: '' },
    durationMinutes: { type: Number, default: 60, min: 5 },
  },
  { _id: false }
);

const bookingConfigSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, unique: true, index: true },
    enabled: { type: Boolean, default: false },
    token: { type: String, trim: true, index: true },
    // Días laborables (0=dom..6=sáb) y horario.
    days: { type: [Number], default: [1, 2, 3, 4, 5] },
    hourFrom: { type: String, default: '09:00' },
    hourTo: { type: String, default: '18:00' },
    slotMinutes: { type: Number, default: 30, min: 5 },
    // Capacidad simultánea por slot (p.ej. nº de consultorios).
    maxPerSlot: { type: Number, default: 1, min: 1 },
    // Cuántos días hacia adelante se puede reservar.
    horizonDays: { type: Number, default: 30, min: 1, max: 120 },
    // Servicios reservables online.
    services: { type: [bookingServiceSchema], default: [] },
    confirmationMessage: {
      type: String,
      default: '¡Gracias! Tu cita quedó registrada. Te enviaremos la confirmación por WhatsApp.',
    },

    // ── Contenido de la landing pública (estilo OpenTable) ──────────────────
    // Subtítulo bajo el nombre de la clínica.
    tagline: { type: String, trim: true, default: 'Reserva tu cita en línea' },
    // Imagen de portada (hero) a pantalla completa. URL pública autoalojada.
    coverImageUrl: { type: String, trim: true, default: '' },
    // Logo opcional mostrado sobre el hero / en la tarjeta de reserva.
    logoUrl: { type: String, trim: true, default: '' },
    // Color de acento (botones, chips). Hex.
    primaryColor: { type: String, trim: true, default: '#059669' },
    // Sección "Acerca de".
    aboutTitle: { type: String, trim: true, default: 'Acerca de nosotros' },
    about: { type: String, trim: true, default: '' },
    // Chips/etiquetas destacadas (p.ej. "Atención personalizada").
    highlights: { type: [String], default: [] },
    // Galería de fotos (URLs públicas autoalojadas).
    gallery: { type: [String], default: [] },
    // Sección de programas reservables ("Experiencias").
    programsTitle: { type: String, trim: true, default: 'Nuestros programas' },
    programs: { type: [bookingProgramSchema], default: [] },
    // Contacto mostrado en el pie (si vacío, se usa el de la clínica).
    addressText: { type: String, trim: true, default: '' },
    phoneText: { type: String, trim: true, default: '' },
    instagram: { type: String, trim: true, default: '' },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('BookingConfig', bookingConfigSchema);
