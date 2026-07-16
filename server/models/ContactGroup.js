const mongoose = require('mongoose');

/**
 * Grupo de contactos. Hay dos clases, y la diferencia importa al enviar:
 *
 *   - `static`  → LISTA FIJA. Los contactos se asignan a mano o al importar un
 *                 Excel ("Feria Julio 2026"). Solo cambia si alguien la cambia.
 *                 La pertenencia vive en `Contact.groups`.
 *   - `dynamic` → GRUPO POR FILTRO. Se define con condiciones (etiquetas, origen,
 *                 con opt-in, ya es paciente…) y se recalcula solo: si entra un
 *                 contacto que cumple, aparece en el grupo sin tocar nada.
 *                 No guarda miembros; se resuelven al consultarlo.
 *
 * `stats.count` es solo una foto para pintar la lista sin recalcular; el número
 * de verdad se resuelve al enviar.
 */
const contactGroupSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: '' },
    kind: { type: String, enum: ['static', 'dynamic'], default: 'static', index: true },

    // Solo para kind='dynamic'. Todos los criterios se combinan con Y.
    filters: {
      tags: { type: [String], default: [] },          // tiene TODAS estas etiquetas
      anyTags: { type: [String], default: [] },       // tiene ALGUNA de estas
      sources: { type: [String], default: [] },       // import | chat | manual | patient | ad
      // '' = da igual | 'yes' = solo con opt-in de WhatsApp | 'no' = solo sin él
      whatsappOptIn: { type: String, enum: ['', 'yes', 'no'], default: '' },
      // '' = da igual | 'yes' = solo los que ya son pacientes | 'no' = aún no
      isPatient: { type: String, enum: ['', 'yes', 'no'], default: '' },
      importBatch: { type: mongoose.Schema.Types.ObjectId, ref: 'ContactImport', default: null },
      createdFrom: { type: Date, default: null },
      createdTo: { type: Date, default: null },
    },

    stats: {
      count: { type: Number, default: 0 },
      countedAt: { type: Date, default: null },
    },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

contactGroupSchema.index({ clinic: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('ContactGroup', contactGroupSchema);
