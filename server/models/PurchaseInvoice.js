const mongoose = require('mongoose');

// Distribución de un ítem de compra en varias cuentas contables.
const accountSplitSchema = new mongoose.Schema(
  {
    account: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', required: true },
    amount: { type: Number, default: 0 },
    description: { type: String, default: '' },
  },
  { _id: false }
);

// Datos del activo fijo capturados en la línea de compra cuando lineType = ACTIVO_FIJO.
// Reflejan el modal "Nuevo activo fijo"; al contabilizar se crea el FixedAsset.
const fixedAssetCaptureSchema = new mongoose.Schema(
  {
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryCategory', default: null },
    assetType: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryCategory', default: null },
    code: { type: String, default: '' },
    name: { type: String, default: '' },
    serial: { type: String, default: '' },
    location: { type: String, default: '' },
    locationClinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', default: null },
    responsible: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    acquisitionDate: { type: Date, default: null },
    startDate: { type: Date, default: null },
    depreciationRate: { type: Number, default: 0 },
    usefulLifeMonths: { type: Number, default: 0 },
    residualPercent: { type: Number, default: 0 },
    assetAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
    depreciationAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
    accumDepreciationAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
    // Referencia al FixedAsset creado (idempotencia al re-contabilizar/editar).
    createdAsset: { type: mongoose.Schema.Types.ObjectId, ref: 'FixedAsset', default: null },
  },
  { _id: false }
);

// Retención por LÍNEA basada en catálogo (RetentionRule). El usuario escoge el código
// (rule); el backend calcula base/monto y resuelve la cuenta. Guarda snapshot de
// código/descripción/rate/cuenta para auditoría histórica (si la regla cambia después,
// la factura ya contabilizada conserva el snapshot). `baseAmount`/`percentage` se
// conservan como alias legacy de `base`/`rate`.
const lineRetentionSchema = new mongoose.Schema(
  {
    rule: { type: mongoose.Schema.Types.ObjectId, ref: 'RetentionRule', default: null },
    type: { type: String, enum: ['IVA', 'RENTA'], default: 'RENTA' },
    code: { type: String, default: '' },
    description: { type: String, default: '' },
    rate: { type: Number, default: 0 },
    base: { type: Number, default: 0 },
    amount: { type: Number, default: 0 },
    account: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
    // Alias legacy (bloque anterior): se mantienen sincronizados con base/rate.
    baseAmount: { type: Number, default: 0 },
    percentage: { type: Number, default: 0 },
  },
  { _id: false }
);

const purchaseItemSchema = new mongoose.Schema(
  {
    /**
     * IDENTIDAD ESTABLE de la línea. El subdocumento es `_id:false` (histórico), así que sin
     * esto la única identidad posible era el ÍNDICE POSICIONAL: borrar o reordenar una línea
     * desplazaba los índices y los activos fijos de esa compra se rebindeaban a la línea
     * equivocada (se les sobrescribía costo y categoría). Se genera al crear la línea y no
     * cambia nunca. Las compras históricas no lo tienen: ahí se sigue usando el índice.
     */
    lineId: { type: String, default: () => new mongoose.Types.ObjectId().toString() },
    description: { type: String, required: true },
    quantity: { type: Number, default: 1, min: 0 },
    unitPrice: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    subtotal: { type: Number, required: true },
    ivaRate: { type: Number, default: 15 },
    ivaAmount: { type: Number, default: 0 },
    account: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount' },
    // Permite distribuir el ítem en varias cuentas contables. Si tiene elementos,
    // se usa en lugar de `account` y la suma de los montos debe igualar el subtotal.
    // Solo aplica a líneas GASTO (INVENTARIO/ACTIVO_FIJO no admiten distribución).
    accountSplits: { type: [accountSplitSchema], default: [] },
    // Clasificación de la línea: GASTO (cuenta de gasto), INVENTARIO (cuenta de activo
    // + producto que sube stock) o ACTIVO_FIJO (crea un activo fijo al contabilizar).
    lineType: { type: String, enum: ['GASTO', 'INVENTARIO', 'ACTIVO_FIJO'], default: 'GASTO' },
    // Centro de costo de la línea (opcional). Se propaga al asiento contable.
    costCenter: { type: mongoose.Schema.Types.ObjectId, ref: 'CostCenter', default: null },
    // Categoría contable del producto (líneas INVENTARIO). Denormalizada del producto;
    // fuente de la cuenta de inventario (no se pide cuenta manual).
    inventoryCategory: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryCategory', default: null },
    fixedAsset: { type: fixedAssetCaptureSchema, default: null },
    // Retenciones de la línea (varias: p.ej. RENTA + IVA sobre el mismo concepto).
    // Fuente principal en compras nuevas. Ver lineRetentionSchema.
    retentions: { type: [lineRetentionSchema], default: [] },
    // Retención singular LEGACY (commit anterior). Se conserva por compatibilidad; el
    // backend la convierte a `retentions[]` para cálculo/resumen/asiento.
    retention: { type: lineRetentionSchema, default: null },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', default: null },
    // Lote y caducidad opcionales para insumos/medicamentos (kardex FIFO por capas).
    lot: { type: String, default: '' },
    expiryDate: { type: Date, default: null },
  },
  { _id: false }
);

// Retención de CABECERA. En compras nuevas se DERIVA (agrupada) de las retenciones por
// línea; en compras legacy es la captura manual antigua. Los reportes SRI (103/104/ATS)
// leen este arreglo, así que es la fuente única para contabilizar/reportar (no se suma
// además por línea, para evitar doble conteo). `account`/`rule` se agregan para
// contabilizar cada código con su cuenta.
const retentionItemSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['IVA', 'RENTA'], required: true },
    code: String,        // 303, 312, etc.
    description: String,
    baseAmount: Number,
    percentage: Number,
    amount: Number,
    account: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
    rule: { type: mongoose.Schema.Types.ObjectId, ref: 'RetentionRule', default: null },
  },
  { _id: false }
);

/**
 * Factura recibida de un proveedor (compra).
 */
const purchaseInvoiceSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
    docType: { type: String, enum: ['FACTURA', 'NOTA_VENTA', 'LIQUIDACION', 'NOTA_DEBITO_REC', 'NOTA_CREDITO_REC'], default: 'FACTURA' },
    estab: String,
    ptoEmi: String,
    secuencial: String,
    serie: { type: String }, // 001-001-000000001
    claveAcceso: { type: String, index: true },
    fechaEmision: { type: Date, required: true },
    fechaRegistro: { type: Date, default: Date.now },
    fechaVencimiento: { type: Date, default: null },
    // Días de crédito acordados (para informar/recalcular el vencimiento).
    creditDays: { type: Number, default: 0 },
    // Centro de costo por defecto de la factura (se copia a las líneas sin centro).
    costCenter: { type: mongoose.Schema.Types.ObjectId, ref: 'CostCenter', default: null },
    autorizacion: { type: String, default: '' },
    items: { type: [purchaseItemSchema], default: [] },
    subtotal0: { type: Number, default: 0 },
    // Tarifa 5%: vigente en Ecuador para sectores específicos (p. ej. construcción). Antes no
    // existía bucket para ella y una línea al 5% quedaba FUERA del subtotal: el total de la
    // factura salía mal y su base no aparecía en el 104 ni en el ATS.
    subtotal5: { type: Number, default: 0 },
    subtotal12: { type: Number, default: 0 },   // histórico (tarifa derogada); se conserva para reportes de años anteriores
    subtotal15: { type: Number, default: 0 },
    subtotalNoObjeto: { type: Number, default: 0 },
    subtotalExento: { type: Number, default: 0 },
    subtotal: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    iva: { type: Number, default: 0 },
    // Desglose del IVA en compras: con derecho a crédito tributario vs no recuperable (al gasto)
    vatCreditAmount: { type: Number, default: 0 },
    vatNonCreditAmount: { type: Number, default: 0 },
    ice: { type: Number, default: 0 },
    propina: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    retentions: { type: [retentionItemSchema], default: [] },
    retentionTotal: { type: Number, default: 0 },
    retentionNumber: String, // nº comprobante retención emitida
    retentionVoucher: { type: mongoose.Schema.Types.ObjectId, ref: 'RetentionVoucher', default: null },
    /**
     * PERIODO FISCAL de la retención, elegido en el formulario de la compra (como en
     * Contífico: la pestaña «Retención» tiene su propio «P. Fiscal» mes/año). Por defecto es
     * el mes de la factura sustento; el contador puede moverlo dentro de lo que permite la
     * regla de los 5 días. Al emitir el comprobante, `retentionVoucherController` lo usa como
     * valor por defecto (el body de la emisión sigue mandando si envía otro).
     * Vacío (null) = «usa el mes de la factura sustento».
     */
    retentionPeriodMonth: { type: Number, default: null, min: 1, max: 12 },
    retentionPeriodYear: { type: Number, default: null, min: 2000, max: 3000 },
    balance: { type: Number, default: 0 }, // saldo por pagar
    paid: { type: Boolean, default: false },
    status: { type: String, enum: ['POR_AUTORIZAR', 'REGISTRADA', 'PAGADA', 'ANULADA'], default: 'REGISTRADA' },
    paymentMethodSri: { type: String, default: '' },
    notes: { type: String, default: '' },
    deductible: { type: Boolean, default: true },
    journalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    retentionJournalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    // Marca que la compra se contabilizó bajo el flujo ESTRICTO (cuentas de
    // inventario/activo resueltas SOLO desde la categoría contable). Se fija en
    // create/authorize. Los documentos legacy (creados antes de esta regla) no lo
    // tienen (false) y por eso al editarse siguen la ruta tolerante. Ver
    // classifyAndValidateItems({ strict }) y exports.update.
    strictAccounts: { type: Boolean, default: false },
    importedFromTxt: { type: Boolean, default: false },
    importedFromXml: { type: Boolean, default: false },
    // Totales ORIGINALES del comprobante según el SRI (snapshot al importar TXT/XML).
    // Nunca se recalculan: sirven para comparar contra lo editado al contabilizar.
    sriTotals: {
      subtotal: { type: Number, default: null },
      iva: { type: Number, default: null },
      total: { type: Number, default: null },
    },
    // El usuario confirmó contabilizar con totales distintos a los del SRI (auditoría).
    sriMismatchAccepted: { type: Boolean, default: false },
    // Datos crudos del XML del SRI para auditoría/verificación
    xmlClaveAcceso: { type: String, default: '' },
    authorizedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    authorizedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

/**
 * Base GRAVADA con IVA de la compra: la suma de todas las tarifas mayores que cero.
 * Fuente única para el 104 (casillero de adquisiciones gravadas), el ATS (`baseImpGrav`) y la
 * base de la retención de IVA. Antes cada sitio sumaba `subtotal12 + subtotal15` a mano y al
 * aparecer la tarifa del 5% habría quedado fuera en todos ellos.
 */
purchaseInvoiceSchema.virtual('baseGravada').get(function () {
  return +((Number(this.subtotal5) || 0) + (Number(this.subtotal12) || 0) + (Number(this.subtotal15) || 0)).toFixed(2);
});

/** Igual que el virtual, pero sobre un objeto plano (`.lean()`, agregaciones, importadores). */
purchaseInvoiceSchema.statics.baseGravadaOf = (p) =>
  +((Number(p?.subtotal5) || 0) + (Number(p?.subtotal12) || 0) + (Number(p?.subtotal15) || 0)).toFixed(2);

// Resumen de retenciones derivado de la cabecera (misma fuente que se contabiliza),
// con la forma que consume el frontend: { type, code, description, rate, base, amount, account }.
purchaseInvoiceSchema.virtual('retentionSummary').get(function () {
  return (this.retentions || []).map((r) => ({
    type: r.type,
    code: r.code || '',
    description: r.description || '',
    rate: Number(r.percentage) || 0,
    base: Number(r.baseAmount) || 0,
    amount: Number(r.amount) || 0,
    account: r.account || null,
  }));
});

purchaseInvoiceSchema.index({ clinic: 1, supplier: 1, serie: 1 }, { unique: true, partialFilterExpression: { serie: { $type: 'string' } } });

module.exports = mongoose.model('PurchaseInvoice', purchaseInvoiceSchema);
