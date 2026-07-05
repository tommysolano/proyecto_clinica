const mongoose = require('mongoose');

/**
 * Configuración de nómina por clínica. Centraliza tasas legales (configurables)
 * y el mapeo de cuentas contables que usa el cierre de rol.
 */
const payrollConfigSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, unique: true, index: true },
    paymentFrequency: { type: String, enum: ['MENSUAL', 'QUINCENAL'], default: 'MENSUAL' },
    // Tasas (en %, se dividen entre 100 al usarse)
    iessPersonal: { type: Number, default: 9.45 },
    iessPatronal: { type: Number, default: 11.15 },
    iece: { type: Number, default: 0.5 },
    secap: { type: Number, default: 0.5 },
    fondosReserva: { type: Number, default: 8.33 },
    sbu: { type: Number, default: 460 }, // Salario Básico Unificado
    // Mapeo de cuentas contables GENERALES (por código del plan). Se usan como
    // fallback cuando el departamento del empleado no define su propia cuenta.
    accounts: {
      sueldos: { type: String, default: '6.1.01' },
      beneficios: { type: String, default: '6.1.02' },
      iessPatronal: { type: String, default: '6.1.03' },
      gastoVacaciones: { type: String, default: '6.1.07' },
      iessPorPagar: { type: String, default: '2.1.03.02' },
      sueldosPorPagar: { type: String, default: '2.1.03.01' },
      irPorPagar: { type: String, default: '2.1.02.05' },
      prestamosPorCobrar: { type: String, default: '1.1.02.04' },
      cxcEmpleados: { type: String, default: '1.1.02.06' },
      // Provisiones por pagar desglosadas por beneficio (antes: una sola cuenta).
      provisionesPorPagar: { type: String, default: '2.1.03.03' },
      decimoTerceroPorPagar: { type: String, default: '2.1.03.03' },
      decimoCuartoPorPagar: { type: String, default: '2.1.03.04' },
      fondosReservaPorPagar: { type: String, default: '2.1.03.05' },
      vacacionesPorPagar: { type: String, default: '2.1.03.06' },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PayrollConfig', payrollConfigSchema);
