const mongoose = require('mongoose');

/**
 * Marca de TAREA DE UNA SOLA VEZ.
 *
 * Sirve para las tareas que se disparan solas en un despliegue (deploy.sh) y que NO deben
 * repetirse en el siguiente push: un borrado de datos, una corrección puntual, una carga
 * inicial. La clave (`_id`) identifica la tarea; el propio índice primario da la exclusión
 * mutua, así que dos procesos que arranquen a la vez no pueden ejecutarla los dos (el
 * segundo choca con E11000 y se aparta), igual que hace `ServerLease` con el rol de jobs.
 *
 * Estados:
 *   RUNNING → alguien la está ejecutando (o murió a medias: ver `startedAt`).
 *   DONE    → terminó bien. NUNCA se vuelve a ejecutar.
 *   FAILED  → falló; el siguiente despliegue la reintenta (dejó el trabajo a medias).
 *
 * Para repetir a propósito una tarea ya DONE hay que cambiarle la clave (o pasar --force
 * en el script), que es justamente lo que la hace "de una sola vez" sin depender de un
 * archivo en disco ni de acordarse de borrar nada.
 */
const oneTimeTaskSchema = new mongoose.Schema(
  {
    _id: { type: String }, // clave estable de la tarea, p.ej. 'borrar-ventas-2026-07-31'
    status: { type: String, enum: ['RUNNING', 'DONE', 'FAILED'], default: 'RUNNING' },
    attempts: { type: Number, default: 1 },
    host: { type: String, default: '' },
    pid: { type: Number, default: 0 },
    startedAt: { type: Date, default: Date.now },
    finishedAt: { type: Date, default: null },
    // Resumen de lo que hizo (conteos), para poder auditar el despliegue después.
    result: { type: mongoose.Schema.Types.Mixed, default: null },
    error: { type: String, default: '' },
  },
  { _id: false, timestamps: true }
);

module.exports = mongoose.model('OneTimeTask', oneTimeTaskSchema);
