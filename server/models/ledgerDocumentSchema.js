const mongoose = require('mongoose');

/**
 * Esquema compartido por la cartera por cobrar (Receivable / CxC) y por pagar
 * (Payable / CxP). Cada documento representa un saldo abierto contra una
 * contraparte (paciente, aseguradora, proveedor, empleado) originado por un
 * documento fuente (venta, factura, compra, nota de crédito, anticipo).
 *
 * Es el subledger único: el balance de estos documentos debe conciliar contra
 * la cuenta de control (Clientes / Proveedores) en el mayor.
 */
function buildLedgerDocumentSchema() {
  const schema = new mongoose.Schema(
    {
      clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
      // Contraparte. `model` es el nombre del modelo Mongoose (Patient, Supplier, Insurer, Employee).
      party: {
        model: { type: String, default: 'Patient' },
        ref: { type: mongoose.Schema.Types.ObjectId, default: null },
        name: { type: String, default: '' },
      },
      // Documento que originó el saldo.
      sourceModel: { type: String, required: true }, // Sale | Invoice | PurchaseInvoice | CreditDebitNote | Payment
      sourceRef: { type: mongoose.Schema.Types.ObjectId, required: true },
      docType: {
        type: String,
        enum: ['FACTURA', 'VENTA', 'NC', 'ND', 'ANTICIPO', 'COMPRA', 'OTRO'],
        default: 'FACTURA',
      },
      number: { type: String, default: '' },
      issueDate: { type: Date, required: true, index: true },
      // Vencimiento LEGAL pactado. No se desplaza por caer en día no hábil.
      dueDate: { type: Date, default: null },
      // Cuándo se PLANEA pagar/cobrar de verdad. Solo afecta a la proyección de flujo de
      // caja (prevalece sobre `dueDate` para estimar la fecha efectiva); no altera la
      // fecha legal ni la antigüedad de cartera. Ver utils/paymentSchedule.
      plannedPaymentDate: { type: Date, default: null },
      currency: { type: String, default: 'USD' },
      // Montos. `applied` es lo cobrado/pagado/aplicado (incluye NC y anticipos).
      total: { type: Number, required: true, min: 0 },
      applied: { type: Number, default: 0, min: 0 },
      balance: { type: Number, default: 0 },
      status: { type: String, enum: ['ABIERTO', 'PARCIAL', 'PAGADO', 'ANULADO'], default: 'ABIERTO', index: true },
      // Cuenta de control en el mayor (Clientes / Proveedores) para conciliación.
      account: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
      costCenter: { type: mongoose.Schema.Types.ObjectId, ref: 'CostCenter', default: null },
      notes: { type: String, default: '' },
    },
    { timestamps: true }
  );

  // Un solo documento de cartera por documento fuente.
  schema.index({ clinic: 1, sourceModel: 1, sourceRef: 1 }, { unique: true });
  schema.index({ clinic: 1, 'party.ref': 1, status: 1 });

  // Mantiene balance y estado coherentes con total/applied.
  schema.pre('validate', function (next) {
    const total = +Number(this.total || 0).toFixed(2);
    const applied = +Number(this.applied || 0).toFixed(2);
    this.total = total;
    this.applied = applied;
    this.balance = +(total - applied).toFixed(2);
    if (this.status !== 'ANULADO') {
      if (this.balance <= 0.005) this.status = 'PAGADO';
      else if (applied > 0) this.status = 'PARCIAL';
      else this.status = 'ABIERTO';
    }
    next();
  });

  return schema;
}

module.exports = { buildLedgerDocumentSchema };
