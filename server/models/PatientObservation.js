const mongoose = require('mongoose');

/**
 * OBSERVACIONES del paciente (pestaña «Observaciones» de la ficha de Clientes).
 *
 * Es la bitácora libre del paciente: cualquiera del equipo con acceso a la ficha
 * anota lo que haga falta ("vino con la mamá", "pidió factura a nombre de la
 * empresa", "no contesta por las mañanas") y adjunta archivos. NO es la ficha
 * clínica ni un seguimiento: no tiene formato MSP, no imprime receta y no entra
 * en el historial médico.
 *
 * Reglas de escritura (las aplica el controlador):
 *  · La escribe cualquiera; se listan de la MÁS NUEVA a la más vieja.
 *  · La edita SOLO quien la creó… y el administrador.
 *  · Cuando la toca alguien que no es el autor, queda constancia: la observación
 *    guarda `createdBy` y `updatedBy`, y la ficha muestra ambos ("Creado por…",
 *    "Modificado por…"). Por eso `updatedBy` es un campo propio y no se deduce de
 *    los timestamps: `updatedAt` cambia también al adjuntar un archivo.
 */
const observationAttachmentSchema = new mongoose.Schema(
  {
    filename: { type: String, required: true },      // nombre en disco (storage/observations)
    originalName: { type: String, required: true },  // nombre con el que lo subieron
    mimeType: { type: String, default: 'application/octet-stream' },
    size: { type: Number, default: 0 },
    uploadedAt: { type: Date, default: Date.now },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { _id: true }
);

const patientObservationSchema = new mongoose.Schema(
  {
    // Sucursal donde se escribió. La ficha del paciente es global (ver
    // patientController), así que las observaciones se listan de todas las
    // sucursales: esto queda como referencia de dónde nació.
    clinic: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Clinic',
      required: true,
      index: true,
    },
    patient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Patient',
      required: true,
      index: true,
    },
    text: { type: String, trim: true, default: '' },
    attachments: { type: [observationAttachmentSchema], default: [] },
    /**
     * Escaneo del que salió esta observación (importación de fichas físicas).
     *
     * Es la MARCA DE IDEMPOTENCIA de scripts/importPatientsFromScans.js: la
     * importación de 6.000 fichas se hace por tandas y se reintenta, y sin una
     * clave única en la base cada reintento le colgaría al paciente otra copia
     * de la misma hoja de seguimiento. Vacío en todo lo que escribe una persona.
     */
    scanImport: {
      scan: { type: mongoose.Schema.Types.ObjectId, ref: 'ScannedDocument', default: null },
      importadoAt: { type: Date, default: null },
    },
    /**
     * REGISTRO AUTOMÁTICO (sep-2026): la escribe el sistema, no una persona.
     *
     *  · 'visita' → una por cita (`ref`): servicios, quién atendió, valor o canje,
     *    adelanto y quién registró el cobro. Se REESCRIBE cada vez que la cita
     *    cambia, así que siempre dice lo último.
     *  · 'venta'  → una por venta (`ref`): qué se llevó, cuánto, cómo pagó y
     *    quién cobró. Al anularse la venta, lo dice.
     *  · 'compra' → lo que caja registra de la receta desde la agenda (una por
     *    guardado, sin `ref`).
     *
     * Solo el administrador la corrige o la borra: es la constancia de lo que
     * pasó, y el cajero que figura como autor no puede reescribir su propio cobro.
     */
    auto: {
      kind: { type: String, enum: ['visita', 'venta', 'compra', null], default: null },
      ref: { type: mongoose.Schema.Types.ObjectId, default: null },
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // Última persona que la modificó. Vacío = nadie la ha tocado desde que se creó.
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    editedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// La pestaña siempre pide "las de este paciente, la más nueva primero".
patientObservationSchema.index({ patient: 1, createdAt: -1 });

// Un escaneo deja UNA observación y solo una, pase lo que pase con los reintentos.
// Parcial porque lo que escribe una persona no lleva `scanImport.scan` y, sin el
// filtro, todas esas observaciones chocarían entre sí por tener el campo a null.
patientObservationSchema.index(
  { 'scanImport.scan': 1 },
  { unique: true, partialFilterExpression: { 'scanImport.scan': { $type: 'objectId' } } }
);

// Un registro automático por cita / por venta: los reintentos lo reescriben, no lo duplican.
patientObservationSchema.index(
  { 'auto.kind': 1, 'auto.ref': 1 },
  { unique: true, partialFilterExpression: { 'auto.ref': { $type: 'objectId' } } }
);

module.exports = mongoose.model('PatientObservation', patientObservationSchema);
