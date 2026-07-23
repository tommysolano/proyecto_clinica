const mongoose = require('mongoose');

/**
 * Un backend VIVO apuntando a esta base de datos.
 *
 * POR QUÉ EXISTE: el sistema puede acabar con DOS procesos corriendo contra la
 * misma base (un pm2 viejo que nadie mató, un despliegue a medias, un `npm run
 * dev` local contra la base de producción). Los dos leen las mismas colas y los
 * dos intentan enviar: el resultado son mensajes DUPLICADOS y burbujas rojas de
 * "no se envió" en chats donde el mensaje sí llegó (lo mandó el proceso gemelo).
 * Era invisible desde la aplicación y costaba días diagnosticarlo.
 *
 * Cada proceso escribe aquí su latido. `lastSeenAt` tiene TTL: si un proceso
 * muere, su registro desaparece solo a los pocos minutos. Con esto el panel de
 * diagnóstico puede decir "hay 2 backends vivos" y señalar cuál está mal
 * configurado (p. ej. sin SECRETS_KEY, o con otro commit).
 */
const serverInstanceSchema = new mongoose.Schema(
  {
    // host:pid:arranque — identifica el proceso de forma estable entre latidos.
    instanceId: { type: String, required: true, unique: true },
    host: { type: String, default: '' },
    pid: { type: Number, default: 0 },
    startedAt: { type: Date, default: Date.now },
    // Commit desplegado: dos instancias con commits distintos = despliegue a medias.
    commit: { type: String, default: '' },
    nodeVersion: { type: String, default: '' },
    // ¿Puede descifrar los tokens de WhatsApp? Un proceso sin la clave falla TODO
    // envío por Cloud API con "no se pudo descifrar el token".
    hasSecretsKey: { type: Boolean, default: false },
    // ¿Tiene los jobs habilitados? (JOBS_DISABLED=1 los apaga en máquinas de dev.)
    jobsEnabled: { type: Boolean, default: true },
    // ¿Es el proceso que ahora mismo ejecuta los jobs y las sesiones QR?
    isLeader: { type: Boolean, default: false },
    // ¿Está marcado como PRIMARIO (IS_PRIMARY=1)? El host de producción que debe
    // correr el QR; arrebata el liderazgo a los procesos de sobra (p.ej. Render).
    primary: { type: Boolean, default: false },
    // Se renueva con cada latido; el TTL borra el registro si el proceso muere.
    lastSeenAt: { type: Date, default: Date.now, expires: 300 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ServerInstance', serverInstanceSchema);
