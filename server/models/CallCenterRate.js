const mongoose = require('mongoose');

/**
 * TARIFA DEL CALL CENTER POR PACIENTE NUEVO (nov-2026).
 *
 * Cuánto gana un agente por cada paciente nuevo que agendó (ver
 * `clasificarAgendamientos` en commissionController: cuenta su primera cita
 * atendida). Las tarifas se escriben con VIGENCIA: «desde el 01-11 son $0,25».
 * Para un paciente vale la última tarifa vigente el día en que contó como nuevo
 * (cuando asistió), así subir la tarifa no cambia lo ya ganado antes.
 *
 * `user: null` = la tarifa general de todos los agentes. La de un agente concreto
 * manda sobre la general mientras esté vigente.
 *
 * Es de toda la organización (sin `clinic`): el call center agenda para todas las
 * sucursales, igual que su resumen.
 */
const callCenterRateSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    amount: { type: Number, required: true, min: 0 },
    // Inicio del día (hora de Ecuador) desde el que rige.
    validFrom: { type: Date, required: true },
    note: { type: String, default: '', trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('CallCenterRate', callCenterRateSchema);
