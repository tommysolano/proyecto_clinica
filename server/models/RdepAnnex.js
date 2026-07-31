const mongoose = require('mongoose');

/**
 * ANEXO RDEP (Retenciones en la fuente por relación de dependencia) — datos CAPTURADOS.
 *
 * El RDEP es ANUAL y acompaña al Formulario 103 (el 103 declara mes a mes lo retenido en
 * relación de dependencia; el RDEP detalla, empleado por empleado, de dónde salió esa
 * retención al cierre del ejercicio).
 *
 * La mayor parte del anexo el sistema la CALCULA de las nóminas cerradas del año
 * (utils/sriForms/computeRdep). Lo que el sistema NO puede saber vive aquí:
 *   - gastos personales proyectados/reales que el empleado declaró (vivienda, salud,
 *     educación, alimentación, vestimenta, turismo);
 *   - ingresos, aportes IESS e impuesto retenido por OTROS empleadores;
 *   - exoneraciones por discapacidad y tercera edad.
 *
 * Se guarda como OVERRIDES por empleado (clave = identificación, que es lo que el anexo
 * reporta y no cambia aunque se rehaga la ficha del empleado). Nunca se guardan aquí los
 * valores calculados: se recalculan siempre de la nómina, de modo que cerrar un rol tarde
 * no deja el anexo con datos rancios.
 */

const rdepEntrySchema = new mongoose.Schema(
  {
    // Identificación del empleado (cédula/pasaporte). Es la clave del anexo.
    identificacion: { type: String, required: true, trim: true },
    // Ingresos y retenciones de OTROS empleadores (los declara el empleado en su formulario).
    ingresosOtrosEmpleadores: { type: Number, default: 0, min: 0 },
    iessOtrosEmpleadores: { type: Number, default: 0, min: 0 },
    retenidoOtrosEmpleadores: { type: Number, default: 0, min: 0 },
    // Gastos personales deducibles declarados por el empleado.
    gastosVivienda: { type: Number, default: 0, min: 0 },
    gastosSalud: { type: Number, default: 0, min: 0 },
    gastosEducacion: { type: Number, default: 0, min: 0 },
    gastosAlimentacion: { type: Number, default: 0, min: 0 },
    gastosVestimenta: { type: Number, default: 0, min: 0 },
    gastosTurismo: { type: Number, default: 0, min: 0 },
    // Exoneraciones (discapacidad / tercera edad).
    exoneracionDiscapacidad: { type: Number, default: 0, min: 0 },
    exoneracionTerceraEdad: { type: Number, default: 0, min: 0 },
    notes: { type: String, default: '' },
  },
  { _id: false }
);

const rdepAnnexSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    year: { type: Number, required: true, min: 2000, max: 2100 },
    entries: { type: [rdepEntrySchema], default: [] },
    notes: { type: String, default: '' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

// Un solo anexo de datos capturados por clínica y ejercicio fiscal.
rdepAnnexSchema.index({ clinic: 1, year: 1 }, { unique: true });

/** Mapa {identificacion: entry} de lo capturado. */
rdepAnnexSchema.methods.entryMap = function entryMap() {
  const out = {};
  for (const e of this.entries || []) out[String(e.identificacion)] = e.toObject ? e.toObject() : e;
  return out;
};

module.exports = mongoose.model('RdepAnnex', rdepAnnexSchema);
module.exports.EDITABLE_FIELDS = [
  'ingresosOtrosEmpleadores', 'iessOtrosEmpleadores', 'retenidoOtrosEmpleadores',
  'gastosVivienda', 'gastosSalud', 'gastosEducacion', 'gastosAlimentacion',
  'gastosVestimenta', 'gastosTurismo', 'exoneracionDiscapacidad', 'exoneracionTerceraEdad',
];
