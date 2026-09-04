const mongoose = require('mongoose');

const saleItemSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true,
  },
  productCode: String,
  productName: String,
  category: String,
  quantity: { type: Number, required: true, min: 1 },
  unitPrice: { type: Number, required: true },
  taxRate: { type: Number, default: 15 },
  taxCodeSri: { type: String, default: '4' },
  taxCategory: {
    type: String,
    // IVA_12 se conserva SOLO por las ventas anteriores a la derogación de esa tarifa.
    enum: ['IVA_15', 'IVA_5', 'IVA_12', 'IVA_0', 'EXENTO', 'NO_OBJETO', 'ICE'],
    default: 'IVA_15',
  },
  priceIncludesVat: { type: Boolean, default: true },
  unitPriceExcludingTax: { type: Number, default: 0 },
  grossAmount: { type: Number, default: 0 },
  taxBase: { type: Number, default: 0 },
  taxAmount: { type: Number, default: 0 },
  lineTotal: { type: Number, default: 0 },
  discountTaxBase: { type: Number, default: 0 },
  // Descuento aplicado al ítem (en valor absoluto, ya calculado).
  discount: { type: Number, default: 0 },
  // Referencia opcional al descuento maestro aplicado.
  discountRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Discount' },
  // Tratamiento al que aporta este ítem (avance automático).
  treatment: { type: mongoose.Schema.Types.ObjectId, ref: 'Treatment' },
  // Bodega de la que SALIÓ este ítem (copiada de la cabecera de la venta al registrarla).
  // Es la que consume las capas FIFO y la que ve el kardex por bodega. Vacía = stock general
  // (ventas anteriores a las bodegas: no se les inventa una).
  warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', default: null },
  subtotal: { type: Number, required: true },
});

// Un renglón de pago. Una venta puede pagarse con VARIOS métodos a la vez
// (p.ej. mitad efectivo + mitad tarjeta) o dejar una parte a crédito (CxC).
// Cada renglón lleva sus propios datos de banco/tarjeta según el método.
const salePaymentSchema = new mongoose.Schema(
  {
    method: { type: String, enum: ['efectivo', 'tarjeta', 'transferencia', 'credito'], required: true },
    amount: { type: Number, required: true, min: 0 },
    // Fecha del pago (por defecto la de la venta). Un cobro posterior de la CxC NO va aquí:
    // vive en su propio `Payment` y se une al reporte desde allí.
    date: { type: Date, default: null },
    bankAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount', default: null },
    reference: { type: String, default: '', trim: true },
    creditCard: { type: mongoose.Schema.Types.ObjectId, ref: 'CreditCard', default: null },
    /**
     * SNAPSHOT del tipo de tarjeta (`CreditCard.accountType`) en el momento de la venta.
     * Si mañana alguien cambia la tarjeta de DÉBITO a CRÉDITO, los reportes históricos no
     * pueden moverse: lo que se cobró, se cobró como lo que era ese día.
     * Vacío en las ventas antiguas: ahí no hay evidencia y NO se inventa.
     */
    cardTypeSnapshot: { type: String, enum: ['DEBITO', 'CREDITO', 'CORRIENTE', ''], default: '' },
    cardBrandSnapshot: { type: String, default: '' },
    cardPos: { type: String, default: '' },
    cardLote: { type: String, default: '', trim: true },
    cardVoucher: { type: String, default: '', trim: true },
    /**
     * DIFERIDO de tarjeta de crédito (Datafast/Medianet): corriente, diferido sin intereses o
     * diferido con intereses, y a cuántos meses. Es INFORMATIVO para la contabilidad —el asiento
     * de la venta debita el bruto igual— pero determina la comisión que cobra el adquirente, así
     * que sin este dato la liquidación de tarjeta no se puede cuadrar contra el recap.
     * Solo aplica a tarjeta de CRÉDITO: en débito queda 'CORRIENTE'.
     */
    cardDeferredType: { type: String, enum: ['CORRIENTE', 'SIN_INTERES', 'CON_INTERES'], default: 'CORRIENTE' },
    cardDeferredMonths: { type: Number, default: 0, min: 0, max: 48 },
  },
  { _id: false }
);

const saleSchema = new mongoose.Schema(
  {
    clinic: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Clinic',
      required: true,
      index: true,
    },
    saleNumber: { type: String },
    patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient' },
    clientName: { type: String, default: 'Consumidor Final', trim: true },
    clientCedula: { type: String, default: '9999999999999', trim: true },
    clientEmail: { type: String, trim: true, lowercase: true },
    clientPhone: { type: String, trim: true },
    clientAddress: { type: String, trim: true },
    // Ciudad del cliente (para análisis de procedencia/heatmap)
    clientCity: { type: String, trim: true, default: 'Guayaquil' },
    // Zona/sector dentro de la ciudad (zonas de Guayaquil pre-cargadas)
    clientZone: { type: String, trim: true },
    items: [saleItemSchema],
    /**
     * Bodega de la que sale la mercadería y CENTRO DE COSTO con el que se registra la venta.
     * El centro se PROPONE desde la bodega (`Warehouse.costCenter`) y se puede cambiar
     * confirmando la diferencia (`services/costCenterPolicy`). Es el que llevan el asiento de
     * ingreso, el de costo, los movimientos de inventario y el reporte de ventas.
     * Un servicio no tiene bodega: entonces no hay centro de bodega que proponer.
     */
    warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', default: null },
    costCenter: { type: mongoose.Schema.Types.ObjectId, ref: 'CostCenter', default: null },
    subtotal: { type: Number, required: true },
    taxableSubtotal: { type: Number, default: 0 },
    subtotal0: { type: Number, default: 0 },
    subtotalExento: { type: Number, default: 0 },
    subtotalNoObjeto: { type: Number, default: 0 },
    discountTotal: { type: Number, default: 0 },
    discountTaxBase: { type: Number, default: 0 },
    taxAmount: { type: Number, required: true },
    total: { type: Number, required: true },
    // Método de pago RESUMEN: el método único usado, o 'mixto' si se pagó con
    // varios. El desglose real está en `payments`.
    paymentMethod: {
      type: String,
      enum: ['efectivo', 'tarjeta', 'transferencia', 'credito', 'mixto'],
      default: 'efectivo',
    },
    // Desglose de pago (uno o varios métodos). Fuente de verdad del cómo se pagó.
    // Para ventas antiguas (antes del pago dividido) queda vacío y se interpreta
    // como un solo pago = { method: paymentMethod, amount: total }.
    payments: { type: [salePaymentSchema], default: [] },
    // Detalle del medio de pago según configuración contable:
    //  - transferencia/deposito -> cuenta bancaria destino
    //  - tarjeta -> tarjeta/POS configurado en bancos
    bankAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount', default: null },
    creditCard: { type: mongoose.Schema.Types.ObjectId, ref: 'CreditCard', default: null },
    cardPos: { type: String, default: '' },
    // N° de lote y voucher del POS (para reconciliar en la liquidación del adquirente).
    cardLote: { type: String, default: '', trim: true, index: true },
    cardVoucher: { type: String, default: '', trim: true },
    // Liquidación de tarjeta que ya incluyó esta venta (evita liquidarla dos veces).
    cardSettlement: { type: mongoose.Schema.Types.ObjectId, ref: 'CardSettlement', default: null },
    // Depósito bancario que ya se llevó el EFECTIVO de esta venta (evita depositarlo dos veces).
    // Antes esto se marcaba cambiando `paymentMethod` a 'transferencia', lo que falseaba la forma
    // de pago de la venta para siempre (y con ella el desglose del Excel y los reportes).
    cashDeposit: { type: mongoose.Schema.Types.ObjectId, ref: 'CashDeposit', default: null },
    // Diferido de la primera tarjeta de crédito de la venta (espejo de `payments[]`, igual que
    // cardLote/cardVoucher): lo consultan la liquidación de tarjeta y el Excel de ventas.
    cardDeferredType: { type: String, enum: ['CORRIENTE', 'SIN_INTERES', 'CON_INTERES'], default: 'CORRIENTE' },
    cardDeferredMonths: { type: Number, default: 0 },
    // Ventas a crédito (CxC): PLAZO pactado en días, vencimiento y saldo pendiente de cobro.
    // El plazo es lo que elige el cajero (5, 15, 30…); `dueDate` se calcula desde él. Se guardan
    // los dos porque la cartera y el SRI razonan con la fecha, y el reporte con el plazo.
    creditDays: { type: Number, default: null },
    dueDate: { type: Date, default: null },
    balance: { type: Number, default: 0 },
    paid: { type: Boolean, default: true },
    status: {
      type: String,
      enum: ['completada', 'anulada'],
      default: 'completada',
    },
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
    // Asiento contable de la VENTA (ingresos + IVA + cobro/CxC). El costo de venta va en un
    // asiento SEPARADO (`costJournalEntry`): la contadora pidió dos asientos por venta —el de
    // la venta y el del costo— en vez de uno combinado. El endpoint by-source trae ambos.
    journalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    // Asiento de COSTO DE VENTA (débito costo / crédito inventario, valorado por kardex FIFO).
    // Solo existe cuando la venta mueve inventario (no en ventas de puro servicio).
    costJournalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    notes: String,
    // Marca si es la primera venta/servicio del paciente (paciente nuevo).
    isFirstVisit: { type: Boolean, default: false },
    // Trazabilidad: quién atendió en cada eslabón del proceso.
    callCenter: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    cashier: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    doctor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    nurse: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // Personal (doctor/enfermero/otro) que recomendó la compra al paciente.
    // Sirve para atribuir comisiones por recomendación.
    recommendedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    appointment: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' },
    // Clave de idempotencia provista por el cliente para evitar ventas duplicadas
    // por doble-submit / reintento de red. Único por clínica (índice parcial).
    idempotencyKey: { type: String, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Evita duplicar la venta si llega dos veces la misma idempotencyKey.
saleSchema.index(
  { clinic: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
);

// Mismo motivo que en Appointment: 'firstVisit' pregunta si el paciente ya compró
// aquí alguna vez, sin filtrar por sucursal, en cada agendamiento.
saleSchema.index({ patient: 1 });

// Generar saleNumber por clínica
saleSchema.pre('save', async function (next) {
  if (!this.saleNumber) {
    const Sale = mongoose.model('Sale');
    const count = await Sale.countDocuments({ clinic: this.clinic });
    this.saleNumber = `V-${String(count + 1).padStart(6, '0')}`;
  }
  next();
});

module.exports = mongoose.model('Sale', saleSchema);
