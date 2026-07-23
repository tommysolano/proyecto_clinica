/**
 * Registro de instancias del backend + elección de líder.
 *
 * PROBLEMA QUE RESUELVE (visto en producción):
 * dos procesos del backend corriendo a la vez contra la MISMA base de datos
 * — un pm2 antiguo que quedó vivo tras cambiar el despliegue de usuario —
 * producían, cada pocos minutos:
 *   · el MISMO mensaje enviado dos veces (los dos procesos recorrían la cola de
 *     inscripciones de workflows),
 *   · burbujas rojas de "no se envió" en chats donde el mensaje SÍ llegó: el
 *     proceso viejo no tenía SECRETS_KEY (fallaba con `token_undecryptable`) ni
 *     la sesión de WhatsApp Web (fallaba con `qr_not_connected`), mientras el
 *     proceso bueno entregaba el mensaje 50 ms después.
 * Desde la aplicación era indistinguible de un bug del chat.
 *
 * QUÉ HACE:
 *  1. Cada proceso publica un LATIDO en `ServerInstance` (host, pid, commit, si
 *     puede descifrar secretos). El panel de diagnóstico ve al instante si hay
 *     más de un backend vivo y en qué se diferencian.
 *  2. Elige un LÍDER mediante un arriendo con caducidad (`ServerLease`). Solo el
 *     líder ejecuta jobs periódicos y sesiones QR; los demás sirven la API pero
 *     no envían nada por su cuenta. Si el líder muere, el arriendo vence y otro
 *     lo toma solo.
 *
 * OJO: un proceso con código ANTERIOR a este módulo no participa en la elección
 * y seguirá duplicando. Por eso el punto 1 (detección + alerta) es tan importante
 * como el punto 2: hay que matar ese proceso a mano una vez.
 */
const os = require('os');
const ServerInstance = require('../models/ServerInstance');
const ServerLease = require('../models/ServerLease');

const HEARTBEAT_MS = 30 * 1000;
// El arriendo dura bastante más que el latido: un pico de carga o un GC largo no
// deben provocar que otro proceso se declare líder y acabe habiendo dos.
const LEASE_MS = 2 * 60 * 1000;
const JOBS_ROLE = 'jobs';

const HOST = os.hostname();
const PID = process.pid;
const STARTED_AT = new Date();
const INSTANCE_ID = `${HOST}:${PID}:${STARTED_AT.getTime()}`;

let leader = false;
let timer = null;
let lastPeers = [];

/** Commit desplegado (para detectar despliegues a medias). Se calcula una vez. */
let commitCache = null;
function currentCommit() {
  if (commitCache !== null) return commitCache;
  try {
    commitCache = require('child_process')
      .execSync('git rev-parse --short HEAD', { cwd: `${__dirname}/..`, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    commitCache = process.env.GIT_COMMIT || '';
  }
  return commitCache;
}

/** ¿Este proceso puede descifrar los tokens guardados? (SECRETS_KEY válida) */
function hasSecretsKey() {
  const k = process.env.SECRETS_KEY;
  if (typeof k !== 'string' || !k) return false;
  if (/^[0-9a-fA-F]{64}$/.test(k)) return true;
  try {
    return Buffer.from(k, 'base64').length === 32;
  } catch {
    return false;
  }
}

function jobsEnabled() {
  return process.env.JOBS_DISABLED !== '1';
}

/**
 * Intenta tomar (o renovar) el arriendo de los jobs. Atómico: el filtro solo
 * acepta el arriendo si YA es nuestro o si venció. Si otro lo tiene vivo, el
 * upsert intenta insertar un `_id` que ya existe y Mongo devuelve E11000 — que
 * aquí significa exactamente "no soy el líder".
 */
async function acquireJobsLease() {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LEASE_MS);
  try {
    await ServerLease.findOneAndUpdate(
      { _id: JOBS_ROLE, $or: [{ holder: INSTANCE_ID }, { expiresAt: { $lte: now } }] },
      { $set: { holder: INSTANCE_ID, host: HOST, pid: PID, expiresAt, renewedAt: now } },
      { upsert: true, new: true }
    );
    return true;
  } catch (err) {
    // 11000 = otro proceso tiene el arriendo vigente. Cualquier otro error se
    // registra: no queremos quedarnos sin jobs por un fallo mudo de la base.
    if (err?.code !== 11000) console.error('[instancias] error tomando el arriendo de jobs:', err.message);
    return false;
  }
}

/** Instancias vivas distintas de esta (según el TTL del latido). */
async function alivePeers() {
  const since = new Date(Date.now() - 3 * HEARTBEAT_MS);
  return ServerInstance.find({ instanceId: { $ne: INSTANCE_ID }, lastSeenAt: { $gte: since } }).lean();
}

async function beat() {
  const wasLeader = leader;
  leader = jobsEnabled() ? await acquireJobsLease() : false;
  if (wasLeader && !leader) {
    console.warn('[instancias] ⚠️  este proceso PERDIÓ el arriendo de jobs: deja de ejecutarlos.');
  }
  await ServerInstance.updateOne(
    { instanceId: INSTANCE_ID },
    {
      $set: {
        host: HOST,
        pid: PID,
        startedAt: STARTED_AT,
        commit: currentCommit(),
        nodeVersion: process.version,
        hasSecretsKey: hasSecretsKey(),
        jobsEnabled: jobsEnabled(),
        isLeader: leader,
        lastSeenAt: new Date(),
      },
    },
    { upsert: true }
  );

  // Aviso en los logs cuando aparece OTRO backend vivo: es la señal temprana de
  // los envíos duplicados y de los "fallidos" fantasma.
  const peers = await alivePeers();
  const ids = peers.map((p) => p.instanceId).sort().join(',');
  if (ids !== lastPeers.map((p) => p.instanceId).sort().join(',')) {
    lastPeers = peers;
    if (peers.length) {
      console.warn('\n' + '='.repeat(70));
      console.warn(`[instancias] ⚠️  hay ${peers.length + 1} backends VIVOS contra esta misma base de datos.`);
      peers.forEach((p) => {
        console.warn(
          `   · ${p.host} pid ${p.pid} — commit ${p.commit || '?'} — ` +
            `SECRETS_KEY ${p.hasSecretsKey ? 'ok' : 'FALTA'} — jobs ${p.jobsEnabled ? 'on' : 'off'}` +
            `${p.isLeader ? ' — LÍDER' : ''}`
        );
      });
      console.warn('   Un backend de sobra DUPLICA envíos y crea mensajes "fallidos" falsos.');
      console.warn('   Revisa los pm2 de TODOS los usuarios: `sudo -iu clinica pm2 ls` y `sudo pm2 ls`.');
      console.warn('='.repeat(70) + '\n');
    }
  }
}

/**
 * Arranca el latido. `onLeader` se invoca UNA sola vez, la primera vez que este
 * proceso consigue el arriendo (ahí es donde se registran los jobs).
 */
async function start(onLeader) {
  let fired = false;
  const tick = async () => {
    try {
      await beat();
      if (leader && !fired && typeof onLeader === 'function') {
        fired = true;
        console.log(`[instancias] este proceso (${INSTANCE_ID}) es el LÍDER: arrancando jobs y WhatsApp QR.`);
        onLeader();
      }
    } catch (err) {
      console.error('[instancias] latido fallido:', err.message);
    }
  };
  await tick();
  timer = setInterval(tick, HEARTBEAT_MS);
  timer.unref?.();
  if (!leader && jobsEnabled()) {
    console.warn(
      '[instancias] otro backend tiene el arriendo de jobs: este proceso servirá la API pero NO ejecutará jobs ni sesiones QR.'
    );
  }
}

/** ¿Este proceso es el líder AHORA? Los jobs lo consultan en cada vuelta. */
function isLeader() {
  return leader;
}

/**
 * Envuelve la función de un job para que solo corra si seguimos siendo líder.
 * Sin esto, un proceso que pierde el arriendo (porque otro lo tomó tras un
 * cuelgue) seguiría enviando en paralelo con el nuevo líder.
 */
function leaderOnly(fn) {
  return (...args) => {
    if (!leader) return undefined;
    return fn(...args);
  };
}

/** Suelta el arriendo al apagar, para que el relevo sea inmediato y no en 2 min. */
async function release() {
  if (timer) clearInterval(timer);
  try {
    await ServerLease.deleteOne({ _id: JOBS_ROLE, holder: INSTANCE_ID });
    await ServerInstance.deleteOne({ instanceId: INSTANCE_ID });
  } catch {
    /* apagando: da igual */
  }
}

/** Foto del clúster para el panel de diagnóstico. */
async function snapshot() {
  const since = new Date(Date.now() - 3 * HEARTBEAT_MS);
  const instances = await ServerInstance.find({ lastSeenAt: { $gte: since } }).sort({ startedAt: 1 }).lean();
  const lease = await ServerLease.findById(JOBS_ROLE).lean();
  return {
    instanceId: INSTANCE_ID,
    isLeader: leader,
    instances: instances.map((i) => ({ ...i, isMe: i.instanceId === INSTANCE_ID })),
    duplicated: instances.length > 1,
    lease: lease || null,
  };
}

module.exports = {
  INSTANCE_ID,
  HOST,
  PID,
  hasSecretsKey,
  isLeader,
  leaderOnly,
  release,
  snapshot,
  start,
};
