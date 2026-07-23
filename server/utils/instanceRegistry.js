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

// ¿Este proceso es el PRIMARIO? El servidor de producción que SÍ puede correr las
// sesiones QR (Chromium) y los jobs. Se marca con IS_PRIMARY=1 en su .env. Un
// primario arrebata el liderazgo a cualquier proceso NO primario (p.ej. un
// despliegue de sobra en Render), así el número de WhatsApp deja de pelearse
// entre dos servidores y la conexión QR se estabiliza.
const AM_PRIMARY = process.env.IS_PRIMARY === '1';

/**
 * Intenta tomar (o renovar) el arriendo de los jobs. Atómico: el filtro acepta el
 * arriendo si YA es nuestro, si venció, o —si somos PRIMARIO— si lo tiene un
 * proceso NO primario (preempción). Si otro lo tiene vigente y no podemos
 * arrebatarlo, el upsert choca con el `_id` existente y Mongo devuelve E11000 —
 * que aquí significa exactamente "no soy el líder".
 */
async function acquireJobsLease() {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LEASE_MS);
  const or = [{ holder: INSTANCE_ID }, { expiresAt: { $lte: now } }];
  if (AM_PRIMARY) or.push({ primary: { $ne: true } });
  try {
    await ServerLease.findOneAndUpdate(
      { _id: JOBS_ROLE, $or: or },
      { $set: { holder: INSTANCE_ID, host: HOST, pid: PID, primary: AM_PRIMARY, expiresAt, renewedAt: now } },
      { upsert: true, new: true }
    );
    return true;
  } catch (err) {
    // 11000 = otro proceso tiene el arriendo vigente (y no lo podemos arrebatar).
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
  // La transición de liderazgo (ganar/perder) la detecta y registra `start`.
  leader = jobsEnabled() ? await acquireJobsLease() : false;
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
        primary: AM_PRIMARY,
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
 * Arranca el latido y avisa de las TRANSICIONES de liderazgo:
 *   - `onGainLeadership()` al pasar a ser líder (arranca jobs + sesiones QR).
 *   - `onLoseLeadership()` al dejar de serlo (APAGA las sesiones QR para no
 *     pelearse con el nuevo líder — clave para que WhatsApp Web no haga flapping
 *     cuando hay dos servidores).
 * Ambas pueden dispararse VARIAS veces (el liderazgo puede ir y volver).
 */
async function start(onGainLeadership, onLoseLeadership) {
  const tick = async () => {
    try {
      const was = leader;
      await beat();
      if (leader && !was) {
        console.log(`[instancias] ${INSTANCE_ID} GANÓ el liderazgo: arrancando jobs y sesiones QR.`);
        if (typeof onGainLeadership === 'function') onGainLeadership();
      } else if (!leader && was) {
        console.warn(`[instancias] ${INSTANCE_ID} PERDIÓ el liderazgo: apagando sesiones QR (otro proceso las tomará).`);
        if (typeof onLoseLeadership === 'function') onLoseLeadership();
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
