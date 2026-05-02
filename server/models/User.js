const mongoose = require('mongoose');

const VALID_ROLES = ['admin', 'cajero', 'contabilidad', 'doctor', 'call_center'];

const userClinicSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true },
    role: { type: String, enum: VALID_ROLES, required: true },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'El nombre es requerido'], trim: true },
    email: {
      type: String,
      required: [true, 'El email es requerido'],
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: [true, 'La contraseña es requerida'],
      minlength: 6,
    },
    // Indica si es super-admin (dueño): puede crear/gestionar clínicas globalmente
    isSuperAdmin: { type: Boolean, default: false },
    // Asignaciones de clínicas con su rol en cada una
    clinics: { type: [userClinicSchema], default: [] },
    specialty: { type: String, trim: true },
    phone: { type: String, trim: true },
    cedula: { type: String, trim: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

userSchema.methods.getRoleForClinic = function (clinicId) {
  if (!clinicId) return null;
  const found = this.clinics.find((c) => String(c.clinic) === String(clinicId));
  return found ? found.role : null;
};

userSchema.statics.VALID_ROLES = VALID_ROLES;

module.exports = mongoose.model('User', userSchema);
