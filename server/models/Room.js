const mongoose = require('mongoose');

/**
 * Room = "consultorio" físico (sala) dentro de una clínica.
 * El admin puede crear consultorios y asignarles un encargado.
 */
const roomSchema = new mongoose.Schema(
  {
    clinic: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Clinic',
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    code: { type: String, trim: true },
    description: { type: String, trim: true },
    // Encargado del consultorio (asignado por admin)
    manager: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

roomSchema.index({ clinic: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('Room', roomSchema);
