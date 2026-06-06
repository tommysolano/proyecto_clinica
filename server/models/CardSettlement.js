const mongoose = require('mongoose');

/**
 * Transacción (recap) de una liquidación de tarjeta de crédito.
 * Cada transacción puede llevar su propio centro de costo (requerimiento:
 * el centro de costo se elige por transacción, no de forma general).
 */
const settlementTxnSchema = new mongoose.Schema(
  {
    date: { type: Date },                 // fecha
    recap: { type: String, default: '' }, // #recap
    account: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null }, // cuenta contable de la transacción
    costCenter: { type: mongoose.Schema.Types.ObjectId, ref: 'CostCenter', default: null },  // centro de costo (por transacción)
    deposit: { type: Number, default: 0 },     // deposito (bruto acreditado)
    commission: { type: Number, default: 0 },  // comisión
    iva: { type: Number, default: 0 },         // iva (sobre la comisión)
    baseRetIr: { type: Number, default: 0 },   // base ret ir
    baseRetIva: { type: Number, default: 0 },  // base ret iva
    baseIr: { type: Number, default: 0 },      // base ir
    retIva: { type: Number, default: 0 },      // ret iva
    toPay: { type: Number, default: 0 },       // a pagar (neto)
  },
  { _id: true }
);

/**
 * Retención asociada a la liquidación.
 */
const settlementRetentionSchema = new mongoose.Schema(
  {
    issueDate: { type: Date },                       // fecha emisión
    retentionNumber: { type: String, default: '' },  // numero retención
    authorization: { type: String, default: '' },    // autorización
    type: { type: String, enum: ['IVA', 'RENTA'], default: 'RENTA' }, // tipo
    sriCode: { type: String, default: '' },          // cod sri
    base: { type: Number, default: 0 },              // base
    percentage: { type: Number, default: 0 },        // %
    value: { type: Number, default: 0 },             // valor
  },
  { _id: true }
);

/**
 * Liquidación de tarjeta de crédito.
 * Representa el comprobante con el que el adquirente (Datafast, Medianet,
 * Pacificard...) liquida las ventas con tarjeta: comisión, IVA de la comisión,
 * retenciones y la acreditación del neto en el banco.
 */
const cardSettlementSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    code: { type: String, required: true },

    // Datos de registro de la liquidación (cabecera)
    issueDate: { type: Date, required: true },          // fecha de emisión
    docType: { type: String, default: 'LIQUIDACION' },  // tipo de documento
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', default: null }, // proveedor (adquirente)
    bankAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount', default: null }, // banco
    docNumber: { type: String, default: '' },           // numero de documento
    commissionToSettle: { type: Number, default: 0 },   // comisión por liquidar

    transactions: { type: [settlementTxnSchema], default: [] },
    retentions: { type: [settlementRetentionSchema], default: [] },

    // Ventas con tarjeta que esta liquidación incluye (cargadas por lote/fecha).
    // Sirve para trazabilidad y para no liquidar dos veces la misma factura.
    sourceSales: {
      type: [
        new mongoose.Schema(
          {
            sale: { type: mongoose.Schema.Types.ObjectId, ref: 'Sale' },
            saleNumber: { type: String, default: '' },
            date: { type: Date },
            lote: { type: String, default: '' },
            voucher: { type: String, default: '' },
            amount: { type: Number, default: 0 },
          },
          { _id: false }
        ),
      ],
      default: [],
    },

    // Cuentas contables seleccionables (el sistema no las elige automáticamente)
    receivableAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null }, // tarjetas por cobrar/liquidar
    commissionAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
    ivaAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
    retIvaAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
    retIrAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },

    // Totales calculados
    totalDeposit: { type: Number, default: 0 },
    totalCommission: { type: Number, default: 0 },
    totalIva: { type: Number, default: 0 },
    totalRetIva: { type: Number, default: 0 },
    totalRetIr: { type: Number, default: 0 },
    totalToPay: { type: Number, default: 0 },

    status: { type: String, enum: ['BORRADOR', 'CONTABILIZADO', 'ANULADO'], default: 'BORRADOR' },
    accreditedAt: { type: Date, default: null }, // fecha de acreditación en banco
    journalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    bankTransaction: { type: mongoose.Schema.Types.ObjectId, ref: 'BankTransaction', default: null },
    notes: { type: String, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

cardSettlementSchema.index({ clinic: 1, code: 1 }, { unique: true });

module.exports = mongoose.model('CardSettlement', cardSettlementSchema);
