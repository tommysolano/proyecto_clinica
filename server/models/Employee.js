const mongoose = require('mongoose');

const employeeSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    code: { type: String, required: true },
    identificacion: { type: String, required: true },
    tipoIdentificacion: { type: String, enum: ['CEDULA', 'RUC', 'PASAPORTE'], default: 'CEDULA' },
    firstName: { type: String, required: true },
    lastName: { type: String, required: true },
    email: String,
    phone: String,
    address: String,
    birthDate: Date,
    hireDate: { type: Date, required: true },
    exitDate: Date,
    position: String,
    department: String,
    contractType: { type: String, enum: ['INDEFINIDO', 'FIJO', 'EVENTUAL', 'PRACTICAS', 'TIEMPO_PARCIAL'], default: 'INDEFINIDO' },
    paymentFrequency: { type: String, enum: ['MENSUAL', 'QUINCENAL', 'SEMANAL'], default: 'MENSUAL' },
    baseSalary: { type: Number, required: true },
    sectoralCode: String, // código comisión sectorial
    bankAccount: String,
    bankName: String,
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // si tiene login
    // Cargas familiares y beneficios
    chargesFamily: { type: Number, default: 0 },
    receivesUtilities: { type: Boolean, default: true },
    receivesDecimoTercero: { type: Boolean, default: true },
    receivesDecimoCuarto: { type: Boolean, default: true },
    receivesFondosReserva: { type: Boolean, default: false }, // se activa al cumplir 1 año
    decimoTerceroAcumulado: { type: String, enum: ['ACUMULADO', 'MENSUALIZADO'], default: 'MENSUALIZADO' },
    decimoCuartoAcumulado: { type: String, enum: ['ACUMULADO', 'MENSUALIZADO'], default: 'MENSUALIZADO' },
    fondosReservaAcumulado: { type: String, enum: ['ACUMULADO', 'MENSUALIZADO'], default: 'MENSUALIZADO' },
    active: { type: Boolean, default: true },
    notes: String,
  },
  { timestamps: true }
);

employeeSchema.index({ clinic: 1, code: 1 }, { unique: true });
employeeSchema.index({ clinic: 1, identificacion: 1 }, { unique: true });

module.exports = mongoose.model('Employee', employeeSchema);
