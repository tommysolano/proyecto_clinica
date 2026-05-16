const mongoose = require('mongoose');

const installmentSchema = new mongoose.Schema(
  {
    number: Number,
    dueDate: Date,
    amount: Number,
    paid: { type: Boolean, default: false },
    paidIn: String, // YYYY-MM (período de rol que descontó)
    paidAt: Date,
  },
  { _id: false }
);

const employeeLoanSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    code: String,
    type: { type: String, enum: ['QUIROGRAFARIO', 'HIPOTECARIO', 'EMPRESA', 'ANTICIPO'], default: 'EMPRESA' },
    grantDate: { type: Date, default: Date.now },
    principal: { type: Number, required: true },
    installmentsCount: { type: Number, required: true },
    installmentAmount: Number,
    interestRate: { type: Number, default: 0 },
    description: String,
    installments: { type: [installmentSchema], default: [] },
    paidAmount: { type: Number, default: 0 },
    balance: { type: Number, default: 0 },
    status: { type: String, enum: ['ACTIVO', 'CANCELADO', 'ANULADO'], default: 'ACTIVO' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('EmployeeLoan', employeeLoanSchema);
