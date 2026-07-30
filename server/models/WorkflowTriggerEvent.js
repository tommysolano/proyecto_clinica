const mongoose = require('mongoose');

/**
 * Rastro de CADA evaluación de disparador de workflow por evento de dominio:
 * dice por qué un evento (cita agendada, pago, etc.) inscribió o NO inscribió
 * al paciente. Antes, un salto por duplicado o por filtro de audiencia/servicio
 * era invisible ("agendé una cita y no pasó nada") — esto lo hace visible en
 * Workflows → Actividad. Se limpia solo (TTL 30 días).
 *
 * DOS FORMAS DE FILA
 * ------------------
 *  1. INDIVIDUAL (`workflow` relleno): una decisión que le pasó a UN workflow
 *     concreto. Es el caso de `enrolled` y `skipped_duplicate`, que son pocas y
 *     valiosas: cada una cuenta algo distinto.
 *
 *  2. AGRUPADA (`workflows[]` relleno, `workflow` a null): UNA fila que recoge
 *     todos los workflows que NO coincidieron con el mismo evento.
 *
 * POR QUÉ LA FORMA AGRUPADA (medido en producción el 30-jul-2026):
 *   · 17 automatizaciones activas tienen disparador `ctwa_ad`. Cada mensaje que
 *     entraba desde un anuncio las evaluaba todas y escribía una fila por cada
 *     una que no casaba: hasta 23 escrituras en el mismo segundo por UN mensaje.
 *   · 1 302 mensajes entrantes en 24 h generaban 4 816 filas de rastro (3,7 por
 *     mensaje), y `no_match` de `ctwa_ad` era el 93% de toda la colección
 *     (37 887 de 40 532 filas).
 *   · Cada fila pesaba 395 bytes de los cuales casi todo era el MISMO párrafo de
 *     ayuda, guardado palabra por palabra 37 887 veces.
 * Es un cuaderno de bitácora que nadie lee tantas veces; en un Atlas M0 (disco y
 * CPU compartidos) esas escrituras compiten con las que sí importan. Agrupando no
 * se pierde ni un dato: la lista de workflows que no coincidieron sigue entera,
 * el motivo es común a todos ellos y `count` dice cuántos fueron.
 *
 * La pantalla de Actividad de un workflow busca por las DOS formas
 * (`$or: [{workflow}, {'workflows.workflow'}]`), así que desde cada workflow se
 * sigue viendo su propio "no coincidió" exactamente igual que antes.
 */
const workflowTriggerEventSchema = new mongoose.Schema({
  clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true },
  // Relleno solo en las filas INDIVIDUALES (enrolled / skipped_duplicate).
  workflow: { type: mongoose.Schema.Types.ObjectId, ref: 'Workflow', default: null },
  // Relleno solo en las filas AGRUPADAS (no_match de varios a la vez). Se guarda
  // el nombre además del id para poder listarlos sin un populate por fila.
  workflows: {
    type: [
      {
        _id: false,
        workflow: { type: mongoose.Schema.Types.ObjectId, ref: 'Workflow' },
        name: { type: String, trim: true, default: '' },
      },
    ],
    default: [],
  },
  // Cuántos workflows recoge la fila (1 en las individuales).
  count: { type: Number, default: 1 },
  patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', default: null },
  patientName: { type: String, trim: true, default: '' },
  eventType: { type: String, trim: true, default: '' }, // appointment_created, payment_received…
  decision: {
    type: String,
    enum: ['enrolled', 'skipped_duplicate', 'no_match'],
    required: true,
  },
  detail: { type: String, trim: true, default: '' },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 30 },
});

workflowTriggerEventSchema.index({ workflow: 1, createdAt: -1 });
// Las filas agrupadas se buscan por el workflow DENTRO del array; sin este índice
// la pantalla de Actividad recorrería toda la colección.
workflowTriggerEventSchema.index({ 'workflows.workflow': 1, createdAt: -1 });

module.exports = mongoose.model('WorkflowTriggerEvent', workflowTriggerEventSchema);
