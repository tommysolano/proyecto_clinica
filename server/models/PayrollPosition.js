const mongoose = require('mongoose');

/**
 * Cargo de nómina parametrizado, ligado a un departamento. Los empleados escogen
 * cargo/departamento de catálogo (no texto libre) para efectos contables.
 */
const payrollPositionSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    name: { type: String, required: true, trim: true },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'PayrollDepartment', default: null },
    active: { type: Boolean, default: true },
    notes: { type: String, default: '' },
  },
  { timestamps: true }
);

payrollPositionSchema.index({ clinic: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('PayrollPosition', payrollPositionSchema);
