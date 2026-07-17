const mongoose = require('mongoose');

/**
 * Un lote de importación de contactos desde Excel/CSV.
 *
 * Existe por tres razones:
 *  1. **Escala.** 47k filas no se pueden procesar dentro de la petición HTTP
 *     (nginx corta a los 60 s y la importación quedaría a medias sin saber por
 *     dónde iba). El lote guarda el estado y un job lo procesa por tandas.
 *  2. **Trazabilidad.** Qué archivo, quién lo subió, qué mapeo se usó y qué filas
 *     fallaron y por qué.
 *  3. **Deshacer.** `Contact.importBatch` apunta aquí: una importación mal mapeada
 *     se puede revertir sin tocar el resto de contactos.
 *
 * El archivo se guarda en disco (no en Mongo): un CSV de 30 MB no cabe cómodo en
 * un documento y solo hace falta mientras se procesa.
 */
const importErrorSchema = new mongoose.Schema(
  {
    row: { type: Number },        // nº de fila en el archivo (1 = cabecera)
    value: { type: String, default: '' }, // el dato que falló (p.ej. el teléfono)
    reason: { type: String, default: '' },
  },
  { _id: false }
);

const contactImportSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    fileName: { type: String, trim: true, default: '' },
    filePath: { type: String, trim: true, default: '' }, // temporal, se borra al terminar
    fileSize: { type: Number, default: 0 },

    // pending  → subido y mapeado, esperando al job
    // running  → procesándose
    // done     → terminado (mira los contadores)
    // failed   → se rompió (mira errorMessage)
    // reverted → se deshizo: sus contactos se borraron
    status: {
      type: String,
      enum: ['pending', 'running', 'done', 'failed', 'reverted'],
      default: 'pending',
      index: true,
    },

    // Mapeo columna del archivo → campo del sistema, tal como lo dejó el usuario
    // en el paso "Asignar". `field` vacío = columna ignorada.
    //   { column: 'Celular', field: 'phone', skipEmpty: true }
    //   { column: 'Ciudad',  field: 'custom:ciudad' }
    mapping: {
      type: [
        {
          column: { type: String, default: '' },
          field: { type: String, default: '' },
          skipEmpty: { type: Boolean, default: true },
          _id: false,
        },
      ],
      default: [],
    },

    // crear y actualizar | solo crear | solo actualizar
    mode: { type: String, enum: ['upsert', 'create', 'update'], default: 'upsert' },

    // Se aplican a todo lo importado (así el Excel se conecta con las campañas).
    tags: { type: [String], default: [] },
    groups: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ContactGroup' }],
    // Workflows (con disparador 'contact_import') que trabajarán estos contactos.
    // Al terminar la importación, el runner inscribe a los contactos del archivo
    // de forma ESCALONADA (no de golpe: sería la ráfaga que el goteo evita).
    workflows: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Workflow' }],
    whatsappOptIn: { type: Boolean, default: true },
    consentSource: { type: String, trim: true, default: '' },

    totalRows: { type: Number, default: 0 },
    processedRows: { type: Number, default: 0 },
    created: { type: Number, default: 0 },
    updated: { type: Number, default: 0 },
    skipped: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    // Inscripciones en workflows creadas por este lote (solo contactos con
    // consentimiento; el arranque de cada una queda escalonado en el tiempo).
    enrolled: { type: Number, default: 0 },
    // Muestra acotada: 47k errores no caben en un documento. No se llama `errors`
    // porque es un nombre reservado de mongoose (choca con la validación del doc).
    rowErrors: { type: [importErrorSchema], default: [] },
    errorMessage: { type: String, trim: true, default: '' },

    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    revertedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdByName: { type: String, trim: true, default: '' },
  },
  { timestamps: true }
);

contactImportSchema.index({ clinic: 1, createdAt: -1 });

module.exports = mongoose.model('ContactImport', contactImportSchema);
