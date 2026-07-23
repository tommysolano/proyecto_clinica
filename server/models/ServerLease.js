const mongoose = require('mongoose');

/**
 * Arriendo (lease) de un rol único en el clúster. Hoy solo existe el rol 'jobs':
 * el proceso que lo posee es el ÚNICO que ejecuta los jobs periódicos
 * (recordatorios, workflows, goteo, no-show…) y el que levanta las sesiones de
 * WhatsApp QR.
 *
 * POR QUÉ: con dos backends vivos contra la misma base, los dos recorrían las
 * mismas colas y el paciente recibía el mismo recordatorio dos veces; además, la
 * sesión de WhatsApp Web solo puede vivir en UN proceso, así que el segundo
 * fallaba todos sus envíos con "el número QR no está conectado" y ensuciaba el
 * chat con mensajes en rojo aunque el contacto sí lo hubiera recibido.
 *
 * El arriendo caduca (`expiresAt`): si el líder muere, otro proceso lo toma solo
 * en cuanto vence, sin intervención manual.
 */
const serverLeaseSchema = new mongoose.Schema(
  {
    // Nombre del rol. Con `_id` fijo, el propio índice primario da la exclusión mutua.
    _id: { type: String },
    holder: { type: String, default: '' }, // instanceId del poseedor
    host: { type: String, default: '' },
    pid: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
    renewedAt: { type: Date, default: Date.now },
  },
  { _id: false, timestamps: true }
);

module.exports = mongoose.model('ServerLease', serverLeaseSchema);
