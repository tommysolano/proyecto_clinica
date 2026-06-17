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
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('BookingConfig', bookingConfigSchema);
