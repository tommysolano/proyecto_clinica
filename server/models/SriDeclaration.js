const mongoose = require('mongoose');

/**
 * DECLARACIÓN TRIBUTARIA PERSISTENTE (Formularios SRI 103 y 104).
 *
 * Hasta ahora el 103/104 se recalculaban en cada request y no dejaban rastro: no
 * había borrador, ni snapshot de lo declarado, ni cierre contable, ni obligación
 * por pagar. Este modelo convierte la declaración en un DOCUMENTO con ciclo de vida:
 *
 *   DRAFT  → se recalcula libremente, no toca contabilidad ni cartera.
 *   FINALIZED → inmutable. Genera el asiento de cierre de impuestos y (si hay saldo
 *               a pagar) la CxP al SRI. El snapshot queda congelado.
 *   SUBSTITUTIVE → declaración FINALIZED que fue reemplazada por una versión posterior
 *               (sustitutiva). Conserva su snapshot y su asiento (que se reversa al
 *               finalizar la sustituta). Nunca se edita en el sitio.
 *   VOID   → anulada (asiento reversado, CxP anulada).
 *
 * Corregir una declaración finalizada NUNCA modifica su snapshot: se crea una nueva
 * VERSIÓN (`replaces` → anterior, `replacedBy` ← anterior).
 *
 * `computedCells` (calculados del sistema) y `editableCells` (capturados por el
 * contador) se guardan por separado para poder recalcular sin perder lo capturado.
 */

const cellValueSchema = new mongoose.Schema(
  { box: { type: String, required: true }, value: { type: Number, default: 0 } },
  { _id: false }
);

/**
 * Pago (total o parcial) de la obligación con el SRI. Mismo contrato que los pagos de
 * nómina: `idempotencyKey` identifica la INTENCIÓN (replay seguro ante doble clic o
 * reintento de red) y `fingerprint` la huella de su contenido (misma clave con otro
 * importe/banco/fecha ⇒ 409).
 */
const declarationPaymentSchema = new mongoose.Schema(
  {
    date: { type: Date, required: true },
    amount: { type: Number, required: true, min: 0 },
    bankAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount', default: null },
    journalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    bankTransaction: { type: mongoose.Schema.Types.ObjectId, ref: 'BankTransaction', default: null },
    reference: { type: String, default: '' },
    paidBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    idempotencyKey: { type: String, trim: true, default: null },
    fingerprint: { type: String, default: null },
  },
  { _id: false }
);

const sriDeclarationSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    formType: { type: String, enum: ['103', '104'], required: true },
    year: { type: Number, required: true },
    month: { type: Number, required: true, min: 1, max: 12 },
    // 'YYYY-MM' — clave de período (facilita agrupar historial/versiones).
    periodKey: { type: String, required: true, index: true },
    // Versión dentro del período: 1 = original, 2+ = sustitutivas.
    version: { type: Number, default: 1, min: 1 },
    status: {
      type: String,
      enum: ['DRAFT', 'FINALIZED', 'SUBSTITUTIVE', 'VOID'],
      default: 'DRAFT',
      index: true,
    },
    // Versión de la DEFINICIÓN de casilleros usada (utils/sriForms/definitions.js).
    // Congelada al finalizar: si mañana cambia el formulario, lo declarado se sigue
    // leyendo con la definición con la que se calculó.
    definitionVersion: { type: String, required: true },

    // Casilleros CALCULADOS por el sistema (ventas, compras, retenciones...).
    computedCells: { type: [cellValueSchema], default: [] },
    // Casilleros CAPTURADOS por el contador (solo los declarados `editable`).
    editableCells: { type: [cellValueSchema], default: [] },

    // Fotografía completa de los datos de origen y las conciliaciones al momento de
    // calcular (documentos incluidos/excluidos, factor, avisos). Inmutable tras finalizar.
    snapshot: { type: mongoose.Schema.Types.Mixed, default: {} },

    // Totales relevantes (denormalizados para listar/proyectar sin abrir el snapshot).
    totals: {
      ventasBase: { type: Number, default: 0 },
      ventasIva: { type: Number, default: 0 },
      comprasBase: { type: Number, default: 0 },
      comprasIva: { type: Number, default: 0 },
      ivaUtilizable: { type: Number, default: 0 },
      ivaAlGasto: { type: Number, default: 0 },
      retencionesEfectuadas: { type: Number, default: 0 },
      // Positivo = impuesto por pagar. Cero si el período cierra con saldo a favor.
      impuestoPorPagar: { type: Number, default: 0 },
      // Saldo a favor que se arrastra al mes siguiente (crédito tributario).
      creditoTributario: { type: Number, default: 0 },
      // Obligación total con el SRI generada por esta declaración (lo que se paga).
      totalAPagar: { type: Number, default: 0 },
    },

    // Representación técnica generada al finalizar (BORRADOR TÉCNICO, no oficial:
    // ver utils/sriForms/definitions.js → xmlDisclaimer) + hash para auditoría.
    xmlSnapshot: { type: String, default: '' },
    xmlHash: { type: String, default: '' },

    // Fechas del flujo de caja: vencimiento legal (9º dígito del RUC) y fecha en la
    // que la clínica planea pagar. `dueDate` NO se mueve por caer fin de semana.
    dueDate: { type: Date, default: null },
    plannedPaymentDate: { type: Date, default: null },
    // Fecha contable PREVISTA del cierre (devengo). Por defecto, el último día del período
    // declarado; se puede fijar al crear el borrador y `finalize` la usa si no se le pasa
    // otra. Forma parte de la huella de la solicitud (dos borradores con distinta fecha
    // contable NO son la misma intención).
    accountingDate: { type: Date, default: null },

    journalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    // CxP al SRI abierta al finalizar (submayor). El pasivo contable ya lo reconoció
    // el asiento: este documento NO genera un segundo crédito.
    payableRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Payable', default: null },
    // Asiento del PRIMER pago (compat). El detalle de los pagos vive en `payments[]`.
    paymentJournalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    // Pagos (totales o parciales) de la obligación con el SRI.
    payments: { type: [declarationPaymentSchema], default: [] },
    // Huella de la SOLICITUD que creó este documento (borrador o sustitutiva). Permite
    // distinguir, ante una colisión concurrente, si la petición perdedora era equivalente a
    // la ganadora (⇒ se devuelve la existente) o pedía algo distinto (⇒ 409).
    requestFingerprint: { type: String, default: null },

    finalizedAt: { type: Date, default: null },
    finalizedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // Encadenamiento de versiones (sustitutivas).
    replaces: { type: mongoose.Schema.Types.ObjectId, ref: 'SriDeclaration', default: null },
    replacedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'SriDeclaration', default: null },
    voidReason: { type: String, default: '' },
    notes: { type: String, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Una sola declaración por (clínica, formulario, período, versión): impide duplicados
// equivalentes y permite el historial de versiones/sustitutivas.
sriDeclarationSchema.index({ clinic: 1, formType: 1, periodKey: 1, version: 1 }, { unique: true });
// Un único BORRADOR abierto por período/formulario (los finalizados sí conviven).
sriDeclarationSchema.index(
  { clinic: 1, formType: 1, periodKey: 1 },
  { unique: true, partialFilterExpression: { status: 'DRAFT' } }
);
// Historial por clínica/formulario/período.
sriDeclarationSchema.index({ clinic: 1, formType: 1, year: -1, month: -1, version: -1 });
// Declaraciones vigentes con obligación pendiente (flujo de caja).
sriDeclarationSchema.index({ clinic: 1, status: 1, dueDate: 1 });
// Idempotencia de pagos: una clave no puede reutilizarse en otra declaración de la misma
// clínica. Dentro de la misma declaración la protección es el chequeo transaccional de
// `pay`, serializado por el conflicto de escritura sobre este documento.
sriDeclarationSchema.index(
  { clinic: 1, 'payments.idempotencyKey': 1 },
  { unique: true, partialFilterExpression: { 'payments.idempotencyKey': { $type: 'string' } } }
);

/** Mapa {box: value} de los casilleros efectivos (calculados + capturados). */
sriDeclarationSchema.methods.cellMap = function cellMap() {
  const out = {};
  for (const c of this.computedCells || []) out[c.box] = c.value;
  for (const c of this.editableCells || []) out[c.box] = c.value;
  return out;
};

module.exports = mongoose.model('SriDeclaration', sriDeclarationSchema);
