const mongoose = require('mongoose');

/**
 * PROGRAMA DE PUBLICIDAD (oct-2026) — la base de la página de Analíticas del CRM.
 *
 * Un programa es lo que marketing vende con sus anuncios («Detox», «Mujer Sana
 * 360»…). NO es un producto del inventario: lo escribe el usuario. Agrupa:
 *   · lo que se GASTA en publicidad, mes a mes;
 *   · los ANUNCIOS de Meta que lo promocionan (los mismos ids que se ponen en
 *     el disparador «Anuncio» de las automatizaciones);
 *   · los SERVICIOS del inventario que se agendan para él, y cuáles de ellos no
 *     generan ingresos (una valoración gratuita cuenta como cita, no como venta).
 *
 * Con eso la analítica cuenta las citas creadas desde el chat que salieron de
 * cada programa, cómo terminaron y cuánto dejaron (ver adProgramController).
 */
const gastoSchema = new mongoose.Schema(
  {
    // 'YYYY-MM': el gasto de publicidad se paga y se mira por mes.
    mes: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
    monto: { type: Number, required: true, min: 0 },
    nota: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

const anuncioSchema = new mongoose.Schema(
  {
    adId: { type: String, required: true, trim: true },
    // De qué automatización se tomó (solo informativo: el id manda).
    workflow: { type: mongoose.Schema.Types.ObjectId, ref: 'Workflow', default: null },
    workflowName: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

const servicioSchema = new mongoose.Schema(
  {
    serviceItem: { type: mongoose.Schema.Types.ObjectId, ref: 'AppointmentServiceItem', required: true },
    // Snapshot del nombre: sirve también para casar la copia del servicio en el
    // catálogo de otra empresa (cada empresa tiene el suyo, con otros ids).
    name: { type: String, trim: true, default: '' },
    // false = la cita cuenta, pero su valor no suma como ingreso.
    generaIngresos: { type: Boolean, default: true },
  },
  { _id: false }
);

const adProgramSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    name: { type: String, required: true, trim: true },
    color: { type: String, trim: true, default: '' },
    gastos: { type: [gastoSchema], default: [] },
    anuncios: { type: [anuncioSchema], default: [] },
    servicios: { type: [servicioSchema], default: [] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AdProgram', adProgramSchema);
