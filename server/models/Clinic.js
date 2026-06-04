const mongoose = require('mongoose');

const clinicSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    ruc: {
      type: String,
      trim: true,
      validate: {
        validator: (v) => !v || /^\d{13}$/.test(v),
        message: 'RUC debe tener 13 dígitos',
      },
    },
    razonSocial: { type: String, trim: true },
    nombreComercial: { type: String, trim: true },
    address: { type: String, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    logoUrl: { type: String, trim: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // Datos fiscales (cada sucursal puede ser su propia empresa / RUC).
    obligadoContabilidad: { type: Boolean, default: true },
    contribuyenteEspecial: { type: String, trim: true, default: '' }, // nº resolución, vacío si no aplica
    agenteRetencion: { type: String, trim: true, default: '' },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Clinic', clinicSchema);
