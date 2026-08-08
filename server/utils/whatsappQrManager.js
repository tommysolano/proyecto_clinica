/**
 * Gestor de números de WhatsApp conectados por QR (whatsapp-web.js).
 *
 * Cada WhatsappAccount con connectionType='qr' tiene un Client de whatsapp-web.js
 * que mantiene una sesión tipo WhatsApp Web. La sesión se persiste EN DISCO con
 * LocalAuth (server/.wwebjs_auth/, ignorado por git y a salvo del `git reset` del
 * deploy): en el VPS el filesystem es persistente, así que sobrevive a reinicios
 * y redeploys. NO usar RemoteAuth (zips a Mongo): comprimir el perfil de Chrome
 * mientras Chrome lo escribe fallaba (ENOENT del zip) con una promesa sin manejar
 * que TUMBABA el proceso entero 60s después de cada vinculación, y al reiniciar
 * borraba el perfil local para "restaurar" desde un Mongo vacío (sesión perdida).
 *
 * Eventos → estado del número + socket.io:
 *   qr            → estado 'qr_pending'  + emite 'whatsapp:qr' (dataURL del QR)
 *   authenticated → estado 'syncing'     (QR escaneado, sincronizando sesión)
 *   loading_screen→ emite 'syncing' con % de progreso
 *   ready         → estado 'connected'   + guarda connectedPhone
 *   auth_failure  → estado 'auth_failure'
 *   disconnected  → estado 'disconnected'
 *   change_state  → UNPAIRED (desvinculado desde el teléfono) → 'disconnected'
 *   message       → ingesta entrante (mismo pipeline que el webhook Cloud API)
 *   message_ack   → actualiza el estado de entrega del mensaje saliente
 *
 * Los eventos NO bastan: al desvincular desde el teléfono, whatsapp-web.js a
 * veces no emite 'disconnected' y la sesión queda "conectada" para siempre.
 * Por eso hay un chequeo de salud periódico (getState) y una reconciliación
 * al listar los números, que detectan la sesión muerta y corrigen el estado.
 *
 * LA SESIÓN NO PUEDE QUEDARSE CAÍDA (jul-2026). El número QR es el canal por el
 * que escriben los pacientes: que se caiga y espere a que alguien lo note es
 * inaceptable. Tres reglas, que son la razón de casi todo el código de arriba:
 *   1. NO se mata una sesión por un vistazo malo. `getState()` devuelve `null`
 *      mientras WhatsApp Web se recarga a sí misma y pasa por OPENING/TIMEOUT en
 *      cada bache de red; antes cualquiera de esas dos cosas la destruía. Solo se
 *      cierra con veredicto de muerte (ver DEAD_STATES) o tras MAX_MISSES
 *      vistazos seguidos sin respuesta.
 *   2. Toda caída que no exija un QR nuevo se RECONECTA SOLA (10s → 5min, sin
 *      rendirse), y un supervisor comprueba cada 45 s que todo número vinculado
 *      tenga sesión viva — incluso si se perdió por un camino imprevisto.
 *   3. Lo que sí necesita a una persona (desvinculado desde el teléfono) se avisa
 *      por la campana del header y queda escrito en la cuenta (lastDisconnect*).
 *   4. SESIÓN ZOMBI (ago-2026): `getState()` NO prueba que el sistema esté
 *      recibiendo. WhatsApp Web se recarga sola y whatsapp-web.js re-engancha sus
 *      listeners solo si detecta que `window.WWebJS` desapareció (Client.js:311);
 *      cuando no lo detecta, emite 'ready' igualmente y deja la sesión con el
 *      socket CONNECTED, los envíos funcionando… y NINGÚN mensaje entrante
 *      llegando a la app. Pasó en producción: el número quedó "conectado" casi 6
 *      horas sin ingresar un solo mensaje. Por eso el chequeo de salud ya no
 *      pregunta solo cómo está el socket, sino si la INGESTA está viva
 *      (verifyIngest): compara lo que WhatsApp Web tiene en memoria con lo último
 *      que guardamos, recupera lo que se perdió y reinicia la sesión si hace falta.
 *
 * IMPORTANTE (hosting): whatsapp-web.js levanta un Chromium headless por número
 * (~300–500 MB) y requiere un proceso SIEMPRE activo. En Render gratis (RAM baja,
 * se duerme, FS efímero) será inestable; es plenamente usable en un VPS. Las libs
 * pesadas se cargan de forma diferida para que el server arranque aunque falten.
 */
const path = require('path');
const fs = require('fs');
const WhatsappAccount = require('../models/WhatsappAccount');
const { emitToCallCenter, emitToUser } = require('../realtime');

// Carpeta de sesiones LocalAuth (una subcarpeta session-<id> por número).
// Anclada a server/ (no al cwd) para que no dependa de cómo arranque pm2.
const WA_DATA_PATH = path.join(__dirname, '..', '.wwebjs_auth');

// accountId(string) → { client, status, watchdog, syncWatchdog, gotQr, lastQr, percent }
// lastQr guarda el último QR (dataURL) para que la UI pueda recuperarlo por
// sondeo HTTP si el socket se cayó y el evento 'whatsapp:qr' se perdió.
const clients = new Map();

// Reintentos de una sincronización COLGADA (QR escaneado pero 'ready' nunca
// llega, típico tras un reinicio del server). Se resetea al conectar bien.
const syncRetries = new Map();
// Sin progreso de sincronización durante este tiempo → se reinicia el cliente.
const SYNC_STUCK_MS = 3 * 60 * 1000;

/**
 * ¿Qué dice `getState()` de la sesión?  (ver probeState)
 *
 * VIVOS: son EXACTAMENTE los estados que la propia whatsapp-web.js considera
 * aceptables (Client.js → ACCEPTED_STATES). WhatsApp pasa por OPENING/TIMEOUT en
 * cada bache de red y vuelve solo a CONNECTED; matar la sesión al primer vistazo
 * que no diga CONNECTED era lo que tumbaba el número varias veces al día.
 */
const LIVE_STATES = new Set(['CONNECTED', 'OPENING', 'PAIRING', 'TIMEOUT']);
// MUERTOS de verdad: WhatsApp cerró la sesión (la librería también emitiría
// 'disconnected' con cualquiera de estos).
const DEAD_STATES = new Set([
  'UNPAIRED', 'UNPAIRED_IDLE', 'CONFLICT', 'DEPRECATED_VERSION',
  'PROXYBLOCK', 'TOS_BLOCK', 'SMB_TOS_BLOCK',
]);
// Estados que EXIGEN escanear un QR nuevo: reconectar solo no sirve de nada.
const NEEDS_QR_STATES = new Set(['UNPAIRED', 'UNPAIRED_IDLE']);

// Vistazos SIN VEREDICTO seguidos que se toleran antes de dar la sesión por
// muerta. `getState()` devuelve `null` mientras WhatsApp Web se recarga a sí
// mismo (el Store todavía no está inyectado): esa ventana dura decenas de
// segundos y el chequeo cae dentro cada dos por tres. Con 4 vistazos son ~3
// minutos de silencio antes de tocar nada.
const MAX_MISSES = 4;

// ── Ingesta viva (detección de sesión ZOMBI) ────────────────────────────────
// Tipos de mensaje que SÍ ingresamos. Vive aquí arriba porque lo usan tanto el
// listener de mensajes como la sonda de ingesta: ambas tienen que mirar
// EXACTAMENTE los mismos mensajes o la comparación daría falsos positivos.
const CONTENT_TYPES = ['chat', 'image', 'video', 'audio', 'ptt', 'document', 'sticker', 'location', 'vcard', 'multi_vcard'];

// Desfase que se tolera entre el mensaje entrante más nuevo que WhatsApp Web
// tiene en memoria y el último que llegamos a guardar. Cubre el tiempo normal de
// ingesta (descargar la media de un mensaje puede tardar hasta 45 s).
const INGEST_LAG_MS = 3 * 60 * 1000;
// Huecos SEGUIDOS (uno por vuelta del chequeo, 45 s) con la sesión estructuralmente
// sana antes de reiniciarla. El primero se resuelve recuperando los mensajes; si
// el siguiente vuelve a aparecer es que los eventos no están llegando.
const MAX_INGEST_GAPS = 2;
// Ninguna sesión se reinicia por la ingesta más de una vez cada 10 min: si la
// sonda se equivocara, el número no puede entrar en un bucle de reinicios.
const INGEST_REPAIR_COOLDOWN_MS = 10 * 60 * 1000;
// Gracia tras el 'ready' antes de juzgar la ingesta. La sonda lee cosas que
// whatsapp-web.js inyecta en la página (window.WWebJS, la función expuesta
// onAddMessageEvent, el listener de la colección Msg) y que solo existen DESPUÉS
// de que la librería termine de inyectar. Preguntar antes es garantía de falso
// positivo, no diagnóstico. Ver verifyIngest.
const INGEST_GRACE_MS = 2 * 60 * 1000;

// ── Memoria del chequeo de ingesta, FUERA de la entrada de sesión ────────────
// Vivían en `entry` (`entry.lastIngestRepairAt`, `entry.ingestGaps`), y `entry` se
// tira entero en cada teardown: el freno de mano se borraba justo en el instante
// en que tenía que actuar, así que "no reiniciar más de una vez cada 10 min" no
// frenaba NADA — el número podía reiniciarse cada 45 s indefinidamente, que es
// exactamente el bucle que el freno existía para impedir. Van por número y
// sobreviven al reinicio de la sesión (no al del proceso, que es lo correcto).
const ingestRepairAt = new Map(); // key → ms del último reinicio por ingesta
const ingestGaps = new Map(); // key → señales de avería SEGUIDAS
// Cuánto hacia atrás se rescatan mensajes perdidos al reconectar. Más allá de un
// día, WhatsApp Web ya no tiene el mensaje en memoria y el chat estaría frío.
const RECOVER_LOOKBACK_MS = 24 * 60 * 60 * 1000;
// Tope de mensajes por pasada de rescate (protege la memoria del proceso). Se
// rescatan los MÁS NUEVOS y se avisa en el log si se dejó algo fuera.
const RECOVER_MAX = 1000;

// ── Reconexión automática ───────────────────────────────────────────────────
// Una sesión QR NO puede quedarse caída esperando a que un humano pulse
// "Conectar": es el canal por el que escriben los pacientes. Toda caída que no
// exija un QR nuevo (bache de red, WhatsApp Web recargándose, Chrome muerto por
// falta de memoria, reinicio del server) se reintenta sola con espera creciente.
const RECONNECT_DELAYS = [10000, 30000, 60000, 120000, 300000];
const reconnectTimers = new Map(); // key → Timeout del próximo intento
const reconnectTries = new Map(); // key → intentos consecutivos fallidos

/** ¿Este proceso es el que debe levantar sesiones QR? (líder del clúster) */
function amLeader() {
  try {
    return require('./instanceRegistry').isLeader();
  } catch {
    return false;
  }
}

/** Cancela un reintento pendiente (conexión manual, desconexión a propósito). */
function cancelReconnect(key) {
  const t = reconnectTimers.get(key);
  if (t) clearTimeout(t);
  reconnectTimers.delete(key);
  reconnectTries.delete(key);
}

/**
 * Programa un intento de reconexión con espera creciente (10s → 5min) y lo
 * repite indefinidamente hasta que la sesión vuelva. Solo el líder reconecta:
 * dos procesos levantando la misma sesión se pelean y WhatsApp expulsa a los dos.
 */
function scheduleReconnect(key, reason = '') {
  if (reconnectTimers.has(key) || clients.has(key)) return;
  const tries = reconnectTries.get(key) || 0;
  const delay = RECONNECT_DELAYS[Math.min(tries, RECONNECT_DELAYS.length - 1)];
  reconnectTries.set(key, tries + 1);
  console.warn(
    '[whatsappQr] %s caído (%s): reintento automático nº%d en %ds',
    key, reason || 'sin motivo', tries + 1, Math.round(delay / 1000)
  );
  // Tras agotar la escalera de esperas (~8 min) el número sigue sin volver: ya no
  // es un bache, hace falta que alguien mire. Se avisa por la campana.
  if (tries + 1 === RECONNECT_DELAYS.length) notifyQrDown(key, { needsQr: false, reason });
  const timer = setTimeout(async () => {
    reconnectTimers.delete(key);
    try {
      if (!amLeader() || clients.has(key)) return;
      const acc = await WhatsappAccount.findById(key).catch(() => null);
      // Cuenta borrada/apagada, o que nunca llegó a vincularse: nada que reconectar.
      if (!acc || acc.connectionType !== 'qr' || !acc.enabled || !acc.connectedPhone) {
        cancelReconnect(key);
        return;
      }
      const r = await connect(key).catch((e) => ({ ok: false, error: e.message }));
      // Si el arranque falló, el propio connect deja la cuenta en auth_failure;
      // se vuelve a programar para no rendirse nunca.
      if (!r || r.ok === false) scheduleReconnect(key, r?.error || 'el arranque falló');
    } catch (e) {
      scheduleReconnect(key, e.message);
    }
  }, delay);
  timer.unref?.();
  reconnectTimers.set(key, timer);
}

/**
 * Avisa por la campana del header cuando un número QR se cae. Solo cuando hace
 * falta una persona: o exige escanear el QR, o los reintentos automáticos ya
 * llevan un rato sin conseguirlo. Se agrupa por hora para no llenar la bandeja.
 */
async function notifyQrDown(key, { needsQr = false, reason = '' } = {}) {
  try {
    const acc = await WhatsappAccount.findById(key).lean().catch(() => null);
    if (!acc) return;
    const clinicId = await require('./callCenterClinic').resolveCallCenterClinicId();
    if (!clinicId) return;
    const Notification = require('../models/Notification');
    const since = new Date(Date.now() - 60 * 60 * 1000);
    const already = await Notification.findOne({
      clinic: clinicId,
      type: 'whatsapp_qr_disconnected',
      'meta.accountId': String(key),
      createdAt: { $gte: since },
    }).lean();
    if (already) return;
    const name = acc.label || acc.connectedPhone || 'Número QR';
    await Notification.create({
      clinic: clinicId,
      type: 'whatsapp_qr_disconnected',
      severity: 'error',
      title: `WhatsApp "${name}" desconectado`,
      body: needsQr
        ? 'La sesión se cerró desde el teléfono: hay que entrar a Config. Call Center y escanear el QR otra vez.'
        : `No se ha podido reconectar solo (${reason || 'motivo desconocido'}). Se sigue reintentando; si no vuelve, entra a Config. Call Center.`,
      meta: { accountId: String(key), needsQr, reason },
    });
  } catch {
    /* la alerta nunca puede romper la reconexión */
  }
}

/**
 * Cierra y limpia un cliente, persiste el estado final y lo emite a la UI.
 * `reason` queda en el log y en la cuenta (para poder ver POR QUÉ se cayó), y
 * salvo que la caída exija un QR nuevo se programa la reconexión automática.
 */
async function teardown(key, entry, {
  status = 'disconnected', error = '', reason = '', needsQr = false, retry = true,
} = {}) {
  if (entry.watchdog) { clearTimeout(entry.watchdog); entry.watchdog = null; }
  if (entry.syncWatchdog) { clearTimeout(entry.syncWatchdog); entry.syncWatchdog = null; }
  // Si ya hay OTRO cliente para este número (el usuario reconectó), solo se
  // destruye este: persistir/emitir aquí pisaría el estado de la conexión nueva.
  const replaced = clients.has(key) && clients.get(key) !== entry;
  if (!replaced) clients.delete(key);
  entry.closing = true; // el cierre es nuestro: que el vigía del navegador no reaccione
  try { await entry.client.destroy(); } catch { /* noop */ }
  if (replaced) return;
  console.warn('[whatsappQr] %s → %s (%s)', key, status, reason || error || 'sin motivo');
  await setAccountStatus(key, {
    status,
    lastDisconnectAt: new Date(),
    lastDisconnectReason: reason || error || '',
    lastDisconnectNeedsQr: !!needsQr,
  });
  await emitStatus(key, { status, ...(error ? { error } : {}) });
  if (needsQr) {
    cancelReconnect(key);
    notifyQrDown(key, { needsQr: true, reason });
    return;
  }
  if (retry) scheduleReconnect(key, reason || error || 'caída');
}

/**
 * Pregunta a la sesión cómo está, con veredicto explícito:
 *   'connected' → viva y conectada.
 *   'transient' → viva pero reconectando sola (OPENING/PAIRING/TIMEOUT).
 *   'busy'      → no contestó a tiempo (Chrome ocupado): sin veredicto.
 *   'unknown'   → contestó `null` o reventó: típico MIENTRAS WhatsApp Web se
 *                 recarga y aún no se ha re-inyectado el Store. NO es muerte.
 *   'dead'      → WhatsApp cerró la sesión (ver DEAD_STATES).
 *   'gone'      → el navegador ya no existe (lo mató el sistema por memoria…).
 */
async function probeState(entry, timeoutMs = 8000) {
  const client = entry.client;
  const browser = client?.pupBrowser;
  const browserDead = browser
    ? (typeof browser.connected === 'boolean' ? !browser.connected : browser.isConnected?.() === false)
    : false;
  if (browserDead || client?.pupPage?.isClosed?.() === true) {
    return { verdict: 'gone', state: '', detail: 'el navegador de la sesión ya no está vivo' };
  }
  let state = null;
  try {
    state = await withTimeout(client.getState(), timeoutMs, '__timeout__');
  } catch (e) {
    if (String(e.message) === '__timeout__') return { verdict: 'busy', state: '' };
    return { verdict: 'unknown', state: '', detail: String(e.message || e).slice(0, 120) };
  }
  if (state === 'CONNECTED') return { verdict: 'connected', state };
  if (LIVE_STATES.has(state)) return { verdict: 'transient', state };
  if (DEAD_STATES.has(state)) return { verdict: 'dead', state };
  return { verdict: 'unknown', state: state || 'null' };
}

/**
 * Verifica que una sesión 'connected' siga viva de verdad, con TOLERANCIA.
 *
 * Antes bastaba UN `getState()` que no dijera 'CONNECTED' para destruir la
 * sesión — y `getState()` devuelve `null` durante toda la recarga que WhatsApp
 * Web se hace a sí misma (por eso existe el parche de re-inyección), además de
 * pasar por OPENING/TIMEOUT en cada bache de red. Resultado: el número se
 * desconectaba varias veces al día y, como nada lo volvía a levantar, había que
 * pulsar "Conectar" a mano. Ahora solo se cierra con veredicto de muerte o tras
 * MAX_MISSES vistazos seguidos sin respuesta, y siempre se reintenta solo.
 */
async function verifyConnected(key, entry, timeoutMs = 8000) {
  const probe = await probeState(entry, timeoutMs);
  if (clients.get(key) !== entry) return clients.get(key)?.status || 'disconnected';

  if (probe.verdict === 'connected') { entry.misses = 0; return 'connected'; }
  // Viva y reconectando sola (OPENING/PAIRING/TIMEOUT): es un veredicto REAL de
  // vida, así que borra los vistazos fallidos.
  if (probe.verdict === 'transient') {
    entry.misses = 0;
    if (probe.state) console.log('[whatsappQr] %s en estado %s: sigue viva, no se toca.', key, probe.state);
    return entry.status;
  }
  // 'busy' (getState no contestó a tiempo) NO es prueba de vida: es silencio. Se
  // toleraba borrando el contador, y eso dejaba una sesión con Chrome atascado
  // en 'connected' PARA SIEMPRE — nunca acumulaba vistazos y nunca se cerraba.
  // Ahora cuenta igual que un vistazo sin veredicto: se aguanta MAX_MISSES.
  if (probe.verdict === 'unknown' || probe.verdict === 'busy') {
    entry.misses = (entry.misses || 0) + 1;
    if (entry.misses < MAX_MISSES) {
      console.log(
        '[whatsappQr] %s sin veredicto (%s) %d/%d: se espera (WhatsApp Web puede estar recargándose).',
        key, probe.detail || probe.state || 'null', entry.misses, MAX_MISSES
      );
      return entry.status;
    }
  }
  const needsQr = NEEDS_QR_STATES.has(probe.state);
  await teardown(key, entry, {
    reason: probe.verdict === 'gone'
      ? 'el navegador de la sesión murió'
      : `getState=${probe.state || 'sin respuesta'}${probe.detail ? ` (${probe.detail})` : ''}`,
    needsQr,
    error: needsQr
      ? 'La sesión se cerró (desvinculada desde el teléfono). Hay que escanear el QR otra vez.'
      : 'La sesión se cerró; reconectando automáticamente…',
  });
  return 'disconnected';
}

/**
 * Vigía del NAVEGADOR: si el Chromium de la sesión se muere (lo típico: el
 * kernel lo mata por falta de memoria), whatsapp-web.js no emite nada y la
 * sesión queda muerta en silencio. Aquí se detecta al instante y se reconecta.
 */
function watchBrowser(key, entry) {
  const browser = entry.client?.pupBrowser;
  if (!browser || entry.browserWatched || typeof browser.on !== 'function') return;
  entry.browserWatched = true;
  browser.on('disconnected', () => {
    if (entry.closing || clients.get(key) !== entry) return; // cierre nuestro o sesión ya reemplazada
    clients.delete(key);
    console.error('[whatsappQr] %s: el navegador de la sesión MURIÓ solo (¿memoria del VPS?). Reconectando…', key);
    setAccountStatus(key, {
      status: 'disconnected',
      lastDisconnectAt: new Date(),
      lastDisconnectReason: 'el navegador de la sesión se cerró solo',
      lastDisconnectNeedsQr: false,
    }).catch(() => {});
    emitStatus(key, {
      status: 'disconnected',
      error: 'El navegador de la sesión se cerró solo. Reconectando…',
    }).catch(() => {});
    scheduleReconnect(key, 'el navegador se cerró solo');
  });
}

/**
 * SUPERVISOR: cada vuelta comprueba que TODA cuenta QR habilitada y ya vinculada
 * tenga una sesión viva; si no la tiene, programa la reconexión. Es la red final
 * — cubre cualquier camino por el que una sesión se pierda sin pasar por
 * `teardown` (excepciones, reinicios a medias, sesiones cerradas por una versión
 * anterior del código). Solo corre en el líder.
 */
async function superviseSessions() {
  if (!amLeader()) return;
  const accounts = await WhatsappAccount.find({ connectionType: 'qr', enabled: true })
    .select('_id sessionId connectedPhone lastDisconnectNeedsQr status')
    .lean()
    .catch(() => []);
  for (const acc of accounts) {
    const key = String(acc._id);
    if (!acc.sessionId || !acc.connectedPhone) continue; // nunca se llegó a vincular
    if (clients.has(key) || reconnectTimers.has(key)) continue;
    // Desvinculado desde el teléfono: reconectar no sirve, hace falta un QR nuevo.
    if (acc.lastDisconnectNeedsQr) continue;
    scheduleReconnect(key, 'sin sesión viva (supervisor)');
  }
}

// Chequeo de salud periódico de todas las sesiones. Cuatro redes de seguridad:
//  - Sesión 'connected': verifica que siga viva, con tolerancia (verifyConnected).
//  - Sesión 'connected' Y viva: verifica además que esté RECIBIENDO (verifyIngest).
//    Que el socket esté CONNECTED no prueba nada: la sesión puede quedar zombi
//    (envía pero no recibe) y sin esto se queda así hasta que alguien lo note.
//  - Sesión con cliente pero estado NO 'connected' (pegada en 'syncing'/
//    'connecting' porque whatsapp-web.js re-sincronizó sin re-emitir 'ready'):
//    si getState dice CONNECTED, se CURA a 'connected'. Sin esto, un número que
//    en realidad funciona (recibe mensajes, el teléfono envía) rechazaba todos
//    los envíos del sistema con "QR no conectado".
//  - Cuentas vinculadas SIN sesión viva → se reconectan solas (superviseSessions).
let healthTimer = null;
function ensureHealthTimer() {
  if (healthTimer) return;
  healthTimer = setInterval(async () => {
    for (const [key, entry] of Array.from(clients.entries())) {
      if (entry.status === 'connected') {
        // eslint-disable-next-line no-await-in-loop
        const vivo = await verifyConnected(key, entry, 10000).catch(() => null);
        // Solo tiene sentido preguntar por la ingesta si la sesión sigue en pie:
        // si verifyConnected la cerró, ya está en manos de la reconexión.
        if (vivo === 'connected' && clients.get(key) === entry) {
          // eslint-disable-next-line no-await-in-loop
          await verifyIngest(key, entry).catch((e) =>
            console.warn('[whatsapp-qr ingesta] %s: el chequeo falló (%s)', key, e.message)
          );
        }
      } else if (entry.client && ['syncing', 'connecting'].includes(entry.status)) {
        // eslint-disable-next-line no-await-in-loop
        const probe = await probeState(entry, 8000).catch(() => ({ verdict: 'unknown' }));
        if (probe.verdict === 'connected') healToConnected(key, entry);
      }
    }
    await superviseSessions().catch(() => {});
  }, 45000);
  healthTimer.unref?.();
}

// Borra la sesión local de un número. Solo se usa para cuentas que nunca
// llegaron a vincularse: un perfil a medias/corrupto haría fallar los
// intentos siguientes.
async function wipeLocalSession(sessionId) {
  try {
    await fs.promises.rm(path.join(WA_DATA_PATH, `session-${sessionId}`), {
      recursive: true,
      force: true,
      maxRetries: 3,
    });
  } catch {
    /* noop */
  }
}

// Ruta al ejecutable de Chrome para whatsapp-web.js. Por defecto reutiliza el
// MISMO Chromium que el proyecto ya usa para generar PDFs (puppeteer), evitando
// que whatsapp-web.js busque el Chrome de su propio puppeteer (que no se descarga
// en Render). En el VPS se puede forzar con PUPPETEER_EXECUTABLE_PATH.
function resolveChromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  try {
    return require('puppeteer').executablePath();
  } catch {
    return undefined;
  }
}

// Emite el estado de un número a la UI del call center (sala global) y al usuario.
async function emitStatus(accountId, payload, userId) {
  try {
    emitToCallCenter('whatsapp:status', { accountId: String(accountId), ...payload });
    if (userId) emitToUser(userId, 'whatsapp:status', { accountId: String(accountId), ...payload });
  } catch {
    /* noop */
  }
}

async function setAccountStatus(accountId, patch) {
  return WhatsappAccount.findByIdAndUpdate(accountId, patch, { new: true }).catch(() => null);
}

const ACK_STATUS = { '-1': 'failed', 1: 'sent', 2: 'delivered', 3: 'read', 4: 'read' };

// Tipo de whatsapp-web.js → enum de Message.mediaType. 'ptt' es la nota de voz.
// 'sticker' se conserva como tal para pintarlo pequeño/transparente en el chat.
function mapQrMediaType(t) {
  if (t === 'ptt') return 'audio';
  if (['image', 'audio', 'video', 'document', 'sticker'].includes(t)) return t;
  return 'document';
}

// Tope de bytes de una media entrante que se guarda en Mongo: el mensaje lleva el
// data URL base64 embebido y un documento BSON no puede pasar de 16 MB. Por encima
// de esto el mensaje se guarda SIN los bytes (pero se ve en el chat qué llegó).
const MAX_QR_MEDIA_BYTES = 8 * 1024 * 1024;

// Reintentos de descarga. WhatsApp Web emite el mensaje ANTES de terminar de bajar
// la media (mediaData.mediaStage = 'FETCHING') y whatsapp-web.js devuelve
// `undefined` en ese instante. Con un solo intento se perdía TODA la media entrante
// del número QR: 1600+ mensajes recibidos y ni una sola foto/audio guardados.
const MEDIA_RETRY_DELAYS = [0, 900, 2200, 4000, 6000];

// Tiempo máximo total esperando el archivo de UN mensaje (el resto de mensajes
// sigue entrando en paralelo; esto solo evita esperas eternas si el navegador
// se queda colgado).
const MAX_MEDIA_WAIT_MS = 45000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms).unref?.());
}

// El mime de whatsapp-web.js puede traer parámetros ('audio/ogg; codecs=opus').
// En la cabecera de un data URL eso rompe a los navegadores (y a nuestro servidor
// de media), así que se guarda solo el tipo base.
function cleanMime(mimeType, fallback) {
  const m = String(mimeType || '').split(';')[0].trim().toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(m) ? m : fallback;
}

/** Un identificador de WhatsApp (Wid) como texto: '5939…@c.us' / '2044…@lid'. */
function widToString(w) {
  if (!w) return '';
  if (typeof w === 'string') return w;
  if (w._serialized) return w._serialized;
  if (w.user && w.server) return `${w.user}@${w.server}`;
  return '';
}

/**
 * Clave COMPLETA de un mensaje ('false_2044…@lid_ACE14EA2…').
 *
 * En los chats de número oculto (@lid) whatsapp-web.js NO expone `id._serialized`,
 * y todo lo que identifica un mensaje por id se rompía: la descarga de archivos
 * (`downloadMedia` busca `Msg.get(this.id._serialized)` → undefined) y el botón de
 * reintentar ("Invalid serialized message id specified"). Por eso en el número QR
 * no entraba NI UNA foto ni nota de voz de esos contactos. Aquí se reconstruye a
 * partir de sus piezas, que sí vienen (`fromMe`, `remote`, `id`).
 */
function serializeMsgKey(idObj) {
  if (!idObj) return '';
  if (typeof idObj === 'string') return idObj;
  if (idObj._serialized) return idObj._serialized;
  const remote = widToString(idObj.remote);
  const hash = idObj.id || '';
  if (!remote || !hash) return '';
  const parts = [idObj.fromMe ? 'true' : 'false', remote, hash];
  const participant = widToString(idObj.participant);
  if (participant) parts.push(participant);
  return parts.join('_');
}

/** Clave completa de un mensaje de whatsapp-web.js (ver serializeMsgKey). */
function qrMessageId(msg) {
  return msg?.id?._serialized || serializeMsgKey(msg?.id) || serializeMsgKey(msg?._data?.id) || '';
}

/** Parte única (hash) de la clave de un mensaje, sirva o no el resto. */
function qrMessageHash(msg) {
  const raw = msg?.id?.id || msg?._data?.id?.id || '';
  if (raw) return String(raw);
  const parts = String(qrMessageId(msg) || '').split('_');
  return parts.length >= 3 ? parts[2] : '';
}

/**
 * Descarga la media POR EL CAMINO DE LA PROPIA APP de WhatsApp Web, dentro del
 * navegador. Es el plan B cuando `msg.downloadMedia()` de whatsapp-web.js falla.
 *
 * La librería llama directamente a `WAWebDownloadManager.downloadAndMaybeDecrypt`
 * con un puñado de campos del mensaje; cuando WhatsApp cambia esa función interna
 * (pasa en cada actualización de WhatsApp Web) revienta con un error MINIFICADO
 * —en producción llegaba literalmente como "r"— y se perdía todo archivo entrante
 * del número QR.
 *
 * Aquí se hace lo mismo que hace la app cuando pulsas "descargar": se le pide al
 * modelo del mensaje que RESUELVA su media (`msg.downloadMedia`, el método del
 * propio WhatsApp, no el de la librería) y luego se leen los bytes ya descifrados
 * del blob que queda en memoria (`mediaData.mediaBlob`). Al no depender de firmas
 * internas, sobrevive a los cambios de WhatsApp Web.
 *
 * @returns {{ok:boolean, data?:string, mimetype?:string, filename?:string, filesize?:number, via?:string, error?:string}}
 */
async function downloadQrMediaInPage(client, serializedId, hash = '') {
  if (!client?.pupPage || (!serializedId && !hash)) return { ok: false, error: 'sin sesión o sin id de mensaje' };
  return withTimeout(
    client.pupPage.evaluate(async (id, msgHash) => {
      // Descripción legible de un error del navegador (suelen venir minificados).
      const desc = (e) => {
        const parts = [e && e.message, e && e.name, e && e.constructor && e.constructor.name, String(e)];
        return parts.filter(Boolean).join(' / ').slice(0, 200);
      };
      try {
        const col = window.require('WAWebCollections');
        let msg = null;
        if (id) {
          try {
            msg = col.Msg.get(id) || (await col.Msg.getMessagesById([id]))?.messages?.[0] || null;
          } catch (e) {
            msg = null; // id no serializable (chats @lid): se busca por el hash
          }
        }
        // Rescate por HASH: identifica el mensaje aunque su clave completa no sirva.
        if (!msg && msgHash) {
          const models = typeof col.Msg.getModelsArray === 'function'
            ? col.Msg.getModelsArray()
            : (col.Msg.models || []);
          msg = models.find((m) => m && m.id && m.id.id === msgHash) || null;
        }
        if (!msg) return { ok: false, error: 'el mensaje no está en el store de WhatsApp Web' };

        // 1) Que WhatsApp resuelva su propia media (descarga + descifrado).
        let resolveError = '';
        try {
          if (!msg.mediaData || msg.mediaData.mediaStage !== 'RESOLVED') {
            await msg.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 });
          }
        } catch (e) {
          resolveError = desc(e);
        }

        // 2) Bytes ya descifrados en memoria. `url()` (un blob: del navegador) es
        //    la vía que usa la propia librería para pintar la media, así que es la
        //    más estable; se dejan alternativas por si cambia el objeto.
        const blob = msg.mediaData && msg.mediaData.mediaBlob;
        let real = null;
        if (blob) {
          try {
            if (typeof Blob !== 'undefined' && blob instanceof Blob) real = blob;
            else if (typeof blob.forceToBlob === 'function') real = await blob.forceToBlob();
            else if (blob._blob) real = blob._blob;
            else if (typeof blob.url === 'function') {
              const u = blob.url();
              if (u) real = await (await fetch(u)).blob();
            }
          } catch (e) {
            return { ok: false, error: `no se pudieron leer los bytes (${desc(e)})` };
          }
        }
        if (!real) {
          const stage = (msg.mediaData && msg.mediaData.mediaStage) || '(sin mediaData)';
          return { ok: false, error: `sin bytes en memoria — mediaStage=${stage}${resolveError ? ` resolve=${resolveError}` : ''}` };
        }

        const buf = await real.arrayBuffer();
        const data = await window.WWebJS.arrayBufferToBase64Async(buf);
        return {
          ok: true,
          data,
          mimetype: msg.mimetype || real.type || 'application/octet-stream',
          filename: msg.filename || '',
          filesize: Number(msg.size) || buf.byteLength,
          via: 'mediaBlob',
        };
      } catch (e) {
        return { ok: false, error: desc(e) };
      }
    }, serializedId || '', hash || ''),
    30000,
    'timeout descargando la media desde el navegador'
  ).catch((e) => ({ ok: false, error: e.message }));
}

// Etiqueta de derivación de claves de WhatsApp por tipo de archivo. Es parte del
// protocolo (la usan todas las librerías de WhatsApp) y no cambia con las
// versiones de WhatsApp Web.
const WA_MEDIA_KEY_INFO = {
  image: 'WhatsApp Image Keys',
  sticker: 'WhatsApp Image Keys',
  video: 'WhatsApp Video Keys',
  gif: 'WhatsApp Video Keys',
  audio: 'WhatsApp Audio Keys',
  ptt: 'WhatsApp Audio Keys',
  document: 'WhatsApp Document Keys',
};

/**
 * Datos MÍNIMOS con los que se puede bajar un archivo de WhatsApp por nuestra
 * cuenta: la ruta en el CDN y la clave con la que viene cifrado. Ambos están en
 * el propio mensaje y no dependen de ninguna función interna del navegador.
 */
async function fetchQrMediaKeys(client, serializedId, hash) {
  if (!client?.pupPage) return null;
  return withTimeout(
    client.pupPage.evaluate(async (id, msgHash) => {
      try {
        const col = window.require('WAWebCollections');
        let m = null;
        if (id) {
          try {
            m = col.Msg.get(id) || (await col.Msg.getMessagesById([id]))?.messages?.[0] || null;
          } catch (e) {
            m = null;
          }
        }
        if (!m && msgHash) {
          const models = typeof col.Msg.getModelsArray === 'function' ? col.Msg.getModelsArray() : (col.Msg.models || []);
          m = models.find((x) => x && x.id && x.id.id === msgHash) || null;
        }
        if (!m) return null;
        const str = (v) => (typeof v === 'string' ? v : v && v.toString ? String(v) : '');
        return {
          directPath: str(m.directPath),
          mediaKey: str(m.mediaKey),
          filehash: str(m.filehash),
          type: str(m.type),
          mimetype: str(m.mimetype),
          filename: str(m.filename),
          size: Number(m.size) || 0,
          mediaStage: (m.mediaData && m.mediaData.mediaStage) || '',
        };
      } catch (e) {
        return null;
      }
    }, serializedId || '', hash || ''),
    15000,
    'timeout leyendo los datos del archivo'
  ).catch(() => null);
}

/**
 * Baja el archivo del CDN de WhatsApp y lo DESCIFRA aquí, en el servidor.
 *
 * Es la vía definitiva cuando el navegador no suelta los bytes: la media de
 * WhatsApp es un fichero cifrado (AES-256-CBC) que cualquiera puede descargar con
 * su `directPath`, y solo se puede abrir con la `mediaKey` que viene en el
 * mensaje. El esquema (HKDF-SHA256 → iv + clave + clave de firma) es parte del
 * protocolo, así que —al revés que las funciones internas de WhatsApp Web— no se
 * rompe cuando WhatsApp actualiza su web.
 *
 * Se comprueba la firma (MAC) y la huella del archivo: si algo no cuadra se
 * devuelve error en vez de guardar un archivo corrupto.
 */
async function downloadAndDecryptWaMedia({ directPath, mediaKey, filehash, type }) {
  if (!directPath || !mediaKey) return { ok: false, error: 'el mensaje no trae la ruta o la clave del archivo' };
  const crypto = require('crypto');
  try {
    const info = WA_MEDIA_KEY_INFO[type] || WA_MEDIA_KEY_INFO.image;
    const expanded = Buffer.from(
      crypto.hkdfSync('sha256', Buffer.from(mediaKey, 'base64'), Buffer.alloc(32), Buffer.from(info, 'utf8'), 112)
    );
    const iv = expanded.subarray(0, 16);
    const cipherKey = expanded.subarray(16, 48);
    const macKey = expanded.subarray(48, 80);

    const url = /^https?:\/\//i.test(directPath) ? directPath : `https://mmg.whatsapp.net${directPath}`;
    const res = await withTimeout(
      fetch(url, { headers: { Origin: 'https://web.whatsapp.com', Referer: 'https://web.whatsapp.com/' } }),
      30000,
      'timeout descargando el archivo cifrado'
    );
    if (!res.ok) return { ok: false, error: `el CDN de WhatsApp respondió HTTP ${res.status}` };
    const enc = Buffer.from(await res.arrayBuffer());
    if (enc.length <= 10) return { ok: false, error: 'el archivo cifrado llegó vacío' };

    const body = enc.subarray(0, enc.length - 10);
    const mac = enc.subarray(enc.length - 10);
    const expected = crypto.createHmac('sha256', macKey).update(Buffer.concat([iv, body])).digest().subarray(0, 10);
    if (!crypto.timingSafeEqual(mac, expected)) {
      return { ok: false, error: 'el archivo no pasó la verificación de firma' };
    }
    const decipher = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv);
    const out = Buffer.concat([decipher.update(body), decipher.final()]);
    if (filehash && crypto.createHash('sha256').update(out).digest('base64') !== filehash) {
      return { ok: false, error: 'el archivo descifrado no coincide con su huella' };
    }
    return { ok: true, buffer: out };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

/**
 * Por qué WhatsApp Web no entregó la media (queda en el log del VPS para poder
 * arreglar la causa exacta sin acceso al navegador). Pregunta al store en qué
 * estado quedó el mensaje: 'FETCHING' = seguía bajando, 'ERROR…' = falló la
 * descarga, 'REUPLOADING' = media caducada en el teléfono del contacto.
 */
async function describeMediaFailure(client, serializedId) {
  if (!client?.pupPage || !serializedId) return '';
  try {
    const info = await withTimeout(
      client.pupPage.evaluate(async (id) => {
        try {
          const col = window.require('WAWebCollections');
          const m = col.Msg.get(id) || (await col.Msg.getMessagesById([id]))?.messages?.[0];
          if (!m) return 'el mensaje no está en el store de WhatsApp Web';
          return `mediaStage=${m.mediaData?.mediaStage || '(sin mediaData)'} directPath=${m.directPath ? 'sí' : 'no'} mediaKey=${m.mediaKey ? 'sí' : 'no'}`;
        } catch (e) {
          return `no se pudo inspeccionar (${e.message})`;
        }
      }, serializedId),
      8000,
      'timeout inspeccionando el mensaje'
    );
    return String(info || '');
  } catch (e) {
    return `no se pudo inspeccionar (${e.message})`;
  }
}

/**
 * Descarga la media inline de un mensaje QR y arma el objeto media para la
 * ingesta ({ type, dataUrl, caption, filename, size }).
 *
 * Devuelve `null` SOLO si el mensaje no trae media. Si la trae pero no se pudo
 * bajar, devuelve el objeto con `unavailable: true` y SIN dataUrl: el mensaje se
 * guarda igual y el agente ve "📷 Foto (no disponible)" en el chat. Nunca se
 * descarta un mensaje con media —desaparecía del chat sin dejar rastro—.
 */
async function extractQrMedia(msg, client, { retryDelays = MEDIA_RETRY_DELAYS } = {}) {
  if (!msg.hasMedia) return null;
  const type = mapQrMediaType(msg.type);
  const filename = msg._data?.filename || '';
  const size = Number(msg._data?.size) || 0;
  const base = { type, caption: msg.body || '', filename, size };
  // Clave RECONSTRUIDA si hace falta: en chats @lid la librería no la expone y sin
  // ella no se puede localizar el mensaje para bajar su archivo (ver qrMessageId).
  const serializedId = qrMessageId(msg);
  const hash = qrMessageHash(msg);
  let lastError = '';
  // Tope total: el mensaje espera a su archivo, así que reintentar no puede
  // retrasarlo eternamente si cada llamada al navegador se queda colgada.
  const deadline = Date.now() + MAX_MEDIA_WAIT_MS;

  // Empaqueta los bytes ya en base64 (vengan de donde vengan) para la ingesta.
  const pack = (data, mimetype, name, informedSize) => {
    const bytes = Math.floor(data.length * 0.75);
    if (bytes > MAX_QR_MEDIA_BYTES) {
      console.warn('[whatsapp-qr media] %s demasiado grande (%d bytes): se guarda sin el archivo', type, bytes);
      return { ...base, size: bytes, unavailable: true, error: 'El archivo es demasiado grande para guardarlo.' };
    }
    return {
      ...base,
      dataUrl: `data:${cleanMime(mimetype, 'application/octet-stream')};base64,${data}`,
      filename: name || filename,
      size: bytes || informedSize || size,
    };
  };

  for (let i = 0; i < retryDelays.length; i += 1) {
    if (i > 0 && Date.now() > deadline) {
      lastError = lastError || 'WhatsApp Web tardó demasiado en entregar el archivo';
      break;
    }
    if (retryDelays[i]) await sleep(retryDelays[i]);
    try {
      // Desde el 2º intento se RELEE el mensaje del store: el objeto que llegó con
      // el evento puede quedarse con un modelo viejo cuya media nunca se resuelve.
      let target = msg;
      if (i > 0 && serializedId && client) {
        const fresh = await withTimeout(client.getMessageById(serializedId), 10000, 'timeout releyendo el mensaje')
          .catch(() => null);
        if (fresh && fresh.hasMedia) target = fresh;
      }
      // eslint-disable-next-line no-await-in-loop
      const m = await withTimeout(target.downloadMedia(), 15000, 'timeout descargando la media');
      if (m && m.data) return pack(m.data, m.mimetype, m.filename);
      lastError = 'WhatsApp Web aún no tenía la media descargada';
    } catch (e) {
      lastError = e.message || String(e);
    }

    // Plan B: la vía de la propia app (ver downloadQrMediaInPage). Se intenta en
    // CADA vuelta porque cuando WhatsApp cambia sus funciones internas el camino
    // de la librería falla SIEMPRE, y sin esto no entraría ni un archivo.
    if (client && (serializedId || hash)) {
      // eslint-disable-next-line no-await-in-loop
      const alt = await downloadQrMediaInPage(client, serializedId, hash);
      if (alt.ok && alt.data) {
        console.log('[whatsapp-qr media] descargada por la vía alterna (%s) type=%s', alt.via, type);
        return pack(alt.data, alt.mimetype, alt.filename, alt.filesize);
      }
      if (alt.error) lastError = `${lastError} | alterna: ${alt.error}`;

      // Plan C — el definitivo: bajar el archivo CIFRADO del CDN de WhatsApp y
      // descifrarlo aquí. No depende de nada interno del navegador.
      // eslint-disable-next-line no-await-in-loop
      const keys = await fetchQrMediaKeys(client, serializedId, hash);
      if (keys && keys.directPath && keys.mediaKey) {
        // eslint-disable-next-line no-await-in-loop
        const direct = await downloadAndDecryptWaMedia(keys);
        if (direct.ok) {
          console.log('[whatsapp-qr media] descargada y descifrada desde el CDN type=%s bytes=%d', type, direct.buffer.length);
          return pack(
            direct.buffer.toString('base64'),
            keys.mimetype || msg.mimetype,
            keys.filename || filename,
            keys.size
          );
        }
        lastError = `${lastError} | CDN: ${direct.error}`;
      } else if (keys) {
        lastError = `${lastError} | CDN: el mensaje no trae ruta/clave (mediaStage=${keys.mediaStage || '?'})`;
      }
    }
  }

  const why = await describeMediaFailure(client, serializedId);
  console.warn(
    '[whatsapp-qr media] NO se pudo descargar type=%s id=%s tras %d intentos: %s | %s',
    msg.type, serializedId || '(sin id)', retryDelays.length, lastError, why
  );
  return { ...base, unavailable: true, error: lastError || 'No se pudo descargar la media de WhatsApp.' };
}

/**
 * Texto legible para los mensajes QR que no son texto ni media (ubicación,
 * tarjeta de contacto). Sin esto se descartaban en silencio por "no tener nada
 * que mostrar" y el agente nunca se enteraba de que el paciente le mandó algo.
 */
function describeQrNonMedia(msg) {
  if (msg.type === 'location') {
    const loc = msg.location || msg._data?.location || {};
    const name = loc.name || loc.description || loc.address || '';
    return `📍 Ubicación${name ? `: ${String(name).slice(0, 120)}` : ''}`;
  }
  if (msg.type === 'vcard' || msg.type === 'multi_vcard') {
    const raw = String(msg.body || msg._data?.vcard || '');
    const fn = /(?:^|\n)FN:(.+)/i.exec(raw);
    return `👤 Contacto compartido${fn ? `: ${fn[1].trim().slice(0, 80)}` : ''}`;
  }
  return '';
}

// Atribución click-to-WhatsApp (anuncios Meta) para números QR. En Cloud API el
// webhook trae `referral`; en QR, whatsapp-web.js 1.34.x NO expone el contexto del
// anuncio como propiedad, pero `getMessageModel` vuelca el modelo COMPLETO en
// `_data`, así que —si WhatsApp Web lo incluye— llega ahí en crudo bajo algún
// campo. Lo buscamos de forma defensiva (varias formas conocidas/probables) y lo
// devolvemos con la MISMA forma que espera ingestExternalMessage (adId, headline…).
// Devuelve null si no hay señales de anuncio.
// ¿Este objeto parece el contexto de un anuncio? (trae id o url de la fuente).
function looksLikeAdCtx(o) {
  return !!(o && typeof o === 'object' &&
    (o.sourceUrl || o.source_url || o.sourceId || o.source_id || o.ctwaClid || o.ctwa_clid || o.ctwaSignals));
}

function extractQrReferral(msg) {
  const d = msg && msg._data;
  if (!d || typeof d !== 'object') return null;

  // Ubicaciones conocidas/probables (plano y anidado en contextInfo/quoted).
  const candidates = [
    d.ctwaContext, d.ctwaContextData, d.adReplyMetadata, d.externalAdReply,
    d.contextInfo && d.contextInfo.externalAdReply, d.contextInfo && d.contextInfo.ctwaContext,
    d.quotedAd && (d.quotedAd.ctwaContext || d.quotedAd),
  ];
  let ctx = candidates.find(looksLikeAdCtx) || null;

  // Rescate: barre un nivel (por si la clave cambió entre versiones de la librería).
  if (!ctx) {
    for (const v of Object.values(d)) {
      if (looksLikeAdCtx(v)) { ctx = v; break; }
      if (v && typeof v === 'object' && (looksLikeAdCtx(v.externalAdReply) || looksLikeAdCtx(v.ctwaContext))) {
        ctx = v.externalAdReply || v.ctwaContext; break;
      }
    }
  }
  if (!ctx || typeof ctx !== 'object') return null;

  const adId = ctx.sourceId || ctx.source_id || ctx.adId || '';
  const sourceUrl = ctx.sourceUrl || ctx.source_url || ctx.url || '';
  const headline = ctx.title || ctx.headline || '';
  const body = ctx.description || ctx.body || '';
  const sourceType = ctx.sourceType || ctx.source_type || (ctx.mediaType != null ? String(ctx.mediaType) : '');
  const ctwaClid = ctx.ctwaClid || ctx.ctwa_clid || '';
  if (!adId && !sourceUrl && !headline && !body) return null;
  return { adId, sourceUrl, headline, body, sourceType, ctwaClid, campaign: headline || body };
}

// Caché lid→teléfono real (el mapeo es estable, se guarda por proceso).
const lidPhoneCache = new Map();

/**
 * Busca el teléfono REAL (…@c.us) dentro del modelo crudo del mensaje.
 *
 * En los chats de número oculto WhatsApp manda igualmente el número del remitente
 * en algún campo del mensaje (`senderPn`, `participantPn`, `author`…, cambia entre
 * versiones), así que se barre el modelo de forma defensiva. Es la vía más fiable:
 * llega con CADA mensaje y no depende de que el mapa lid→teléfono esté cargado.
 *
 * `ownPhone` son los dígitos de NUESTRO número: hay que excluirlos porque campos
 * como `to` traen nuestro propio JID y acabaríamos guardando nuestro número como
 * el del paciente.
 */
function phoneFromMsgData(msg, ownPhone = '') {
  const d = msg && msg._data;
  if (!d || typeof d !== 'object') return { phone: '', where: '' };
  const own = String(ownPhone || '').replace(/\D/g, '');
  const SKIP = new Set(['to', 'self', 'me', 'recipient']);
  const asPhone = (v) => {
    let s = '';
    if (typeof v === 'string') s = v;
    else if (v && typeof v === 'object') {
      if (v._serialized) s = String(v._serialized);
      else if (v.user && v.server) s = `${v.user}@${v.server}`;
    }
    const m = /^(\d{7,15})@c\.us$/.exec(s);
    if (!m) return '';
    return own && m[1] === own ? '' : m[1];
  };
  for (const [k, v] of Object.entries(d)) {
    if (SKIP.has(k)) continue;
    const p = asPhone(v);
    if (p) return { phone: p, where: k };
  }
  for (const [k, v] of Object.entries(d)) {
    if (SKIP.has(k) || !v || typeof v !== 'object' || Array.isArray(v)) continue;
    for (const [k2, v2] of Object.entries(v)) {
      if (SKIP.has(k2)) continue;
      const p = asPhone(v2);
      if (p) return { phone: p, where: `${k}.${k2}` };
    }
  }
  return { phone: '', where: '' };
}

/**
 * Pregunta a WhatsApp Web, por varias vías, cuál es el teléfono de un LID.
 * `getContactLidAndPhone` (lo que usa la librería) devuelve vacío cuando el mapa
 * lid→teléfono aún no está cargado, así que además se consulta el contacto del
 * store y se fuerza la consulta al servidor.
 */
async function lookupLidPhoneInPage(client, lid) {
  if (!client?.pupPage) return '';
  const out = await withTimeout(
    client.pupPage.evaluate(async (jid) => {
      const digits = (v) => {
        let s = '';
        if (typeof v === 'string') s = v;
        else if (v && typeof v === 'object') {
          if (v._serialized) s = String(v._serialized);
          else if (v.user) s = `${v.user}@${v.server || 'c.us'}`;
        }
        const m = /^(\d{7,15})@c\.us$/.exec(s);
        return m ? m[1] : '';
      };
      try {
        const wid = window.require('WAWebWidFactory').createWid(jid);
        const api = window.require('WAWebApiContact');
        let p = digits(api.getPhoneNumber && api.getPhoneNumber(wid));
        if (p) return p;
        // Forzar la consulta al servidor y volver a preguntar.
        try {
          await window.require('WAWebQueryExistsJob').queryWidExists(wid);
          p = digits(api.getPhoneNumber && api.getPhoneNumber(wid));
          if (p) return p;
        } catch (e) { /* sigue con el store local */ }
        // El contacto del store puede tener ya el número asociado.
        const col = window.require('WAWebCollections');
        const c = col.Contact && col.Contact.get(jid);
        if (c) {
          for (const k of ['phoneNumber', 'pn', 'userid', 'id', 'displayPhone']) {
            const v = digits(c[k]);
            if (v) return v;
          }
        }
        return '';
      } catch (e) {
        return '';
      }
    }, lid),
    10000,
    'timeout resolviendo el número'
  ).catch(() => '');
  return String(out || '');
}

/**
 * Devuelve los DÍGITOS del número real de un contacto QR a partir de su JID.
 *  - `…@c.us`: los dígitos ya SON el número real.
 *  - `…@lid` (número oculto): el identificador largo NO es un teléfono y no le
 *    sirve de nada al agente. Se resuelve, por este orden: caché → el propio
 *    mensaje (`phoneFromMsgData`, la vía más fiable) → `getContactLidAndPhone` de
 *    la librería → consulta directa a WhatsApp Web. Si nada funciona se devuelve
 *    el LID (como antes) y se reintenta con el siguiente mensaje.
 */
async function resolveQrPhone(client, jid, msg = null) {
  const s = String(jid || '');
  const raw = s.replace(/@.*$/, '').replace(/\D/g, '');
  if (!s.endsWith('@lid')) return raw;
  if (lidPhoneCache.has(s)) return lidPhoneCache.get(s) || raw;

  const remember = (digits, via) => {
    lidPhoneCache.set(s, digits);
    console.log('[whatsapp-qr lid] %s → %s (vía %s)', s, digits, via);
    return digits;
  };

  // 1) El propio mensaje trae el número del remitente en algún campo. Solo se
  //    usa si sabemos cuál es NUESTRO número: en un mensaje saliente el modelo
  //    lleva nuestro propio JID y, sin excluirlo, guardaríamos nuestro número
  //    como el del paciente.
  const own = String(client?.info?.wid?.user || '').replace(/\D/g, '');
  if (msg && own) {
    const found = phoneFromMsgData(msg, own);
    if (found.phone) return remember(found.phone, `mensaje.${found.where}`);
  }
  // 2) El mapa lid→teléfono de la librería.
  try {
    const out = await withTimeout(client.getContactLidAndPhone([s]), 8000, null);
    const res = Array.isArray(out) ? out[0] : null;
    const pn = res && res.pn ? String(res.pn) : '';
    if (pn.endsWith('@c.us')) {
      const digits = pn.replace(/@.*$/, '').replace(/\D/g, '');
      if (digits) return remember(digits, 'getContactLidAndPhone');
    }
  } catch { /* sigue con la consulta directa */ }
  // 3) Consulta directa a WhatsApp Web (fuerza la resolución en el servidor).
  const direct = await lookupLidPhoneInPage(client, s);
  if (direct) return remember(direct, 'consulta directa');

  console.warn('[whatsapp-qr lid] no se pudo resolver el teléfono de %s (se muestra el identificador)', s);
  return raw;
}

/**
 * Ingresa UN mensaje entrante del número QR (mismo pipeline que el webhook de
 * Cloud API). Está a nivel de módulo, y no dentro del listener, porque el rescate
 * de mensajes perdidos (recoverMissedInbound) tiene que pasar por EXACTAMENTE el
 * mismo camino: si un mensaje se reingresa por otra vía acaba duplicado o con
 * campos distintos.
 *
 * Filtra los tipos con contenido real de un humano; el resto (e2e_notification al
 * renegociar cifrado, notification_template, ciphertext, llamadas…) NO debe crear
 * conversaciones: al vincular una sesión nueva, WhatsApp renegocia claves con
 * muchos contactos y llegaba un "mensaje" vacío por cada uno (chats fantasma
 * "Sin mensajes" con el LID como nombre).
 *
 * @returns {boolean} true si el mensaje llegó a la ingesta (aunque fuera duplicado).
 */
async function ingestIncomingQrMessage(msg, client, accountId) {
  if (msg.fromMe || msg.isStatus) return false;
  const from = typeof msg.from === 'string' ? msg.from : widToString(msg.from);
  // Solo chats directos: personas (@c.us) o contactos con número oculto (@lid).
  // Fuera grupos (@g.us), canales (@newsletter) y listas (@broadcast).
  if (!/@(c\.us|lid)$/.test(from)) return false;
  if (!CONTENT_TYPES.includes(msg.type)) return false;

  // ¿Ya lo tenemos? La ingesta también deduplica, pero AHÍ dentro ya sería tarde:
  // antes de llegar habríamos vuelto a descargar el archivo del mensaje (hasta 45 s
  // por mensaje). En un rescate de cientos de mensajes eso sería inviable.
  const yaGuardado = qrMessageId(msg);
  if (yaGuardado) {
    const Message = require('../models/Message');
    const dup = await Message.findOne({ externalId: yaGuardado, direction: 'in' })
      .select('_id').lean().catch(() => null);
    if (dup) return false;
  }

  // Número real: si el contacto tiene número oculto (@lid) lo resolvemos a su
  // teléfono verdadero (si no, se mostraría el identificador largo del LID).
  const phone = await resolveQrPhone(client, from, msg);
  if (!phone) return false;

  const media = await extractQrMedia(msg, client);
  // Ubicación / tarjeta de contacto: no traen texto ni media, pero SÍ son un
  // mensaje real del paciente; se describen en vez de descartarse (y en el
  // vcard se muestra el nombre, no el volcado crudo del contacto).
  const described = describeQrNonMedia(msg);
  const bodyText = described || String(msg.body || '').trim();
  if (!bodyText && !media) return false; // nada que mostrar

  const account2 = await WhatsappAccount.findById(accountId);
  const clinicId = await require('./callCenterClinic').resolveCallCenterClinicId();
  if (!clinicId) {
    // Sin clínica ancla el mensaje se PIERDE. Antes era un `return` mudo: el
    // número parecía sano y los mensajes se evaporaban sin dejar rastro.
    console.error('[whatsapp-qr] mensaje DESCARTADO: no hay clínica de call center resuelta (from=%s)', from);
    return false;
  }

  // Cita: si el contacto respondió a un mensaje, whatsapp-web.js expone el
  // wamid citado en _data.quotedStanzaID (o hasQuotedMsg + getQuotedMessage).
  let contextId = '';
  if (msg.hasQuotedMsg) {
    try {
      const q = await msg.getQuotedMessage();
      contextId = qrMessageId(q) || msg._data?.quotedStanzaID || '';
    } catch {
      contextId = msg._data?.quotedStanzaID || '';
    }
  }

  // Clave del mensaje: imprescindible para citarlo Y para volver a pedirle su
  // archivo a WhatsApp. En chats LID (número oculto) la librería no expone
  // `id._serialized`, así que se RECONSTRUYE (ver qrMessageId); antes se
  // guardaba solo el hash suelto y cualquier búsqueda por id fallaba con
  // "Invalid serialized message id specified".
  const serializedId = qrMessageId(msg);
  if (!serializedId) {
    console.warn(
      '[whatsapp-qr] mensaje entrante SIN wamid (no se podrá citar). type=%s from=%s id=%j',
      msg.type, from, msg.id
    );
  }

  // Anuncio click-to-WhatsApp (solo lo trae el 1er mensaje tras tocar el anuncio).
  const referral = extractQrReferral(msg);
  if (referral) {
    console.log('[ctwa_ad][qr] mensaje desde anuncio — source_id=%s url=%s de %s',
      referral.adId || '(vacío)', referral.sourceUrl || '(sin url)', from);
  } else if (msg._data && typeof msg._data === 'object') {
    // Sin mapear: si hay SEÑALES de anuncio (clave sospechosa arriba o dentro de
    // contextInfo) deja las claves reales en el log para ajustar el mapeo con
    // datos de producción (no se vuelca el cuerpo del mensaje, solo nombres).
    const adRe = /ctwa|ad_?reply|externalad|source_?url/i;
    const ci = msg._data.contextInfo;
    const ciObj = ci && typeof ci === 'object' ? ci : null;
    const topAdish = Object.keys(msg._data).some((k) => adRe.test(k));
    const ciAdish = ciObj && Object.keys(ciObj).some((k) => adRe.test(k));
    if (topAdish || ciAdish) {
      console.log('[ctwa_ad][qr] posible anuncio NO mapeado — _data:[%s] contextInfo:[%s]',
        Object.keys(msg._data).join(','), ciObj ? Object.keys(ciObj).join(',') : '—');
    }
  }

  const { ingestExternalMessage } = require('../controllers/chatController');
  await ingestExternalMessage({
    clinicId,
    channel: 'whatsapp',
    account: account2,
    phone,
    // JID completo (…@c.us / …@lid): imprescindible para RESPONDER a
    // contactos con número oculto (a un LID no se le puede escribir @c.us).
    externalUserId: from,
    body: bodyText,
    media,
    contactName: msg._data?.notifyName || '',
    externalId: serializedId,
    contextId,
    referral,
  });
  // Marca de INGESTA VIVA: es la referencia contra la que el chequeo de salud
  // compara lo que WhatsApp Web tiene en memoria. Se usa la hora del PROPIO
  // mensaje (no `now`) para que ambas magnitudes sean comparables. `$max` evita
  // que un mensaje viejo rescatado haga retroceder la marca.
  const t = Number(msg.timestamp) > 0 ? new Date(Number(msg.timestamp) * 1000) : new Date();
  await WhatsappAccount.updateOne({ _id: accountId }, { $max: { lastInboundAt: t } }).catch(() => {});
  return true;
}

// ── Sesión ZOMBI: la ingesta puede morir con el socket CONNECTED ─────────────

/**
 * Pregunta DENTRO de la página si la ingesta está viva y qué mensajes entrantes
 * tiene WhatsApp Web que nosotros no hemos guardado.
 *
 * Dos señales independientes:
 *  - ESTRUCTURAL: `window.WWebJS` inyectado, la función expuesta
 *    `onAddMessageEvent` presente y el evento 'add' de la colección Msg todavía
 *    enganchado. Si algo de esto falta, la sesión NO puede recibir: es certeza,
 *    no sospecha.
 *  - DE HECHO: el mensaje entrante más nuevo que la página tiene en memoria. Si
 *    es más nuevo que el último que guardamos, los mensajes están llegando al
 *    navegador y muriendo antes de la app.
 *
 * Los filtros (fromMe, JID directo, tipo con contenido) son LOS MISMOS que aplica
 * ingestIncomingQrMessage: si divergen, la comparación daría falsos positivos con
 * mensajes que descartamos a propósito.
 */
async function probeIngest(entry, desdeMs = 0, timeoutMs = 12000) {
  const client = entry.client;
  if (!client?.pupPage || client.pupPage.isClosed?.() === true) {
    return { ok: false, sinRespuesta: true, detalle: 'la página de la sesión no está disponible' };
  }
  try {
    const r = await withTimeout(
      client.pupPage.evaluate((tipos, desdeSeg) => {
        const out = {
          wwebjs: false, expuesta: false, enganchado: null,
          ultimoEntranteSeg: 0, pendientes: 0, error: '',
        };
        try {
          out.wwebjs = typeof window.WWebJS !== 'undefined';
          out.expuesta = typeof window.onAddMessageEvent === 'function';
          const { Msg } = window.require('WAWebCollections');
          // ¿Sigue enganchado el listener 'add' de whatsapp-web.js? El registro de
          // eventos cambia de forma entre versiones de WhatsApp Web, así que se
          // prueban las conocidas; si ninguna se puede leer queda `null`
          // (= "no se sabe") y NUNCA se da la sesión por muerta por esto.
          const reg = Msg && (Msg._events || Msg._callbacks || Msg.__events);
          if (reg && typeof reg === 'object') {
            const add = reg.add;
            out.enganchado = Array.isArray(add) ? add.length > 0 : !!add;
          }
          const models = typeof Msg.getModelsArray === 'function'
            ? Msg.getModelsArray()
            : (Msg.models || []);
          for (const m of models) {
            if (!m || !m.id || m.id.fromMe) continue;
            if (m.isStatusV3 || m.isStatus) continue;
            if (tipos.indexOf(m.type) === -1) continue;
            const rem = m.id.remote;
            const jid = !rem ? ''
              : typeof rem === 'string' ? rem
                : rem._serialized ? String(rem._serialized)
                  : rem.user && rem.server ? rem.user + '@' + rem.server : '';
            if (!/@(c\.us|lid)$/.test(jid)) continue;
            const t = Number(m.t) || 0;
            if (t > out.ultimoEntranteSeg) out.ultimoEntranteSeg = t;
            if (desdeSeg && t > desdeSeg) out.pendientes += 1;
          }
        } catch (e) {
          out.error = String((e && e.message) || e).slice(0, 140);
        }
        return out;
      }, CONTENT_TYPES, Math.floor(desdeMs / 1000)),
      timeoutMs,
      '__timeout__'
    );
    if (r.error) return { ok: false, sinRespuesta: true, detalle: r.error };
    return { ok: true, ...r, ultimoEntranteMs: (r.ultimoEntranteSeg || 0) * 1000 };
  } catch (e) {
    // Chrome ocupado o la página recargándose: SIN veredicto, no se toca nada.
    return { ok: false, sinRespuesta: true, detalle: String(e.message || e).slice(0, 140) };
  }
}

/**
 * Rescata los mensajes entrantes que WhatsApp Web tiene en memoria y nosotros no
 * llegamos a guardar, y los mete por el pipeline normal.
 *
 * Es lo que convierte el incidente en algo REVERSIBLE: mientras la sesión estuvo
 * zombi, los mensajes sí llegaron al navegador (por eso el paciente los ve como
 * entregados) — solo se perdió el puente hacia la app. La ingesta deduplica por
 * `externalId`, así que rescatar de más nunca duplica un chat.
 *
 * @returns {number} mensajes rescatados que la ingesta aceptó.
 */
async function recoverMissedInbound(client, accountId, desdeMs) {
  if (!client?.pupPage || !desdeMs) return 0;
  let hallado = { total: 0, modelos: [] };
  try {
    hallado = await withTimeout(
      client.pupPage.evaluate((tipos, desdeSeg, tope) => {
        if (typeof window.WWebJS === 'undefined') return { total: 0, modelos: [] };
        const { Msg } = window.require('WAWebCollections');
        const models = typeof Msg.getModelsArray === 'function'
          ? Msg.getModelsArray()
          : (Msg.models || []);
        const sel = [];
        for (const m of models) {
          if (!m || !m.id || m.id.fromMe) continue;
          if (m.isStatusV3 || m.isStatus) continue;
          if (tipos.indexOf(m.type) === -1) continue;
          const rem = m.id.remote;
          const jid = !rem ? ''
            : typeof rem === 'string' ? rem
              : rem._serialized ? String(rem._serialized)
                : rem.user && rem.server ? rem.user + '@' + rem.server : '';
          if (!/@(c\.us|lid)$/.test(jid)) continue;
          if ((Number(m.t) || 0) <= desdeSeg) continue;
          sel.push(m);
        }
        sel.sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0));
        return { total: sel.length, modelos: sel.slice(-tope).map((m) => window.WWebJS.getMessageModel(m)) };
      }, CONTENT_TYPES, Math.floor(desdeMs / 1000), RECOVER_MAX),
      30000,
      'timeout leyendo los mensajes perdidos'
    );
  } catch (e) {
    console.warn('[whatsapp-qr rescate] no se pudieron leer los mensajes de la página: %s', e.message);
    return 0;
  }
  const modelos = hallado?.modelos || [];
  if (!modelos.length) return 0;
  if ((hallado.total || 0) > modelos.length) {
    // Nada de topes silenciosos: si se dejaron mensajes fuera, tiene que constar.
    console.warn('[whatsapp-qr rescate] la sesión tenía %d mensajes sin guardar; se rescatan los %d más nuevos.',
      hallado.total, modelos.length);
  }

  // Descarte en BLOQUE de los que ya están guardados. Preguntar uno a uno también
  // funciona (ingestIncomingQrMessage lo hace), pero con la base en Atlas cada ida
  // y vuelta cuesta ~100 ms: en un rescate de cientos de mensajes eso son minutos.
  // Una sola consulta deja la lista en los que de verdad faltan.
  const conId = modelos.map((m) => ({ modelo: m, id: serializeMsgKey(m?.id) }));
  const ids = conId.map((x) => x.id).filter(Boolean);
  let guardados = new Set();
  if (ids.length) {
    const Message = require('../models/Message');
    const filas = await Message.find({ externalId: { $in: ids }, direction: 'in' })
      .select('externalId').lean().catch(() => []);
    guardados = new Set(filas.map((f) => f.externalId));
  }
  const faltan = conId.filter((x) => !x.id || !guardados.has(x.id));
  if (!faltan.length) return 0;

  // Los modelos crudos se envuelven en la MISMA clase Message que usa la
  // librería al emitir el evento: así el mensaje rescatado recorre el pipeline
  // con downloadMedia(), getQuotedMessage() y todo lo demás igual que el normal.
  const { Message: LibMessage } = require('whatsapp-web.js');
  let n = 0;
  for (const { modelo } of faltan) {
    try {
      // eslint-disable-next-line no-await-in-loop
      if (await ingestIncomingQrMessage(new LibMessage(client, modelo), client, accountId)) n += 1;
    } catch (e) {
      console.warn('[whatsapp-qr rescate] un mensaje no se pudo reingresar: %s', e.message);
    }
  }
  console.log('[whatsapp-qr rescate] %d de %d que faltaban (%d en la sesión) recuperados desde %s',
    n, faltan.length, modelos.length, new Date(desdeMs).toISOString());
  return n;
}

/**
 * Comprueba que la sesión esté RECIBIENDO, no solo conectada, y actúa.
 *
 * El caso real (ago-2026): el número figuró 'connected' casi 6 horas —`getState()`
 * decía CONNECTED y los envíos salían— sin ingresar un solo mensaje entrante,
 * porque whatsapp-web.js perdió sus listeners al recargarse WhatsApp Web y no los
 * volvió a enganchar. Nada lo detectaba: el chequeo de salud solo miraba el socket.
 *
 * Escalada:
 *   0. La sesión todavía no ha emitido 'ready' (o lo hizo hace menos de
 *      INGEST_GRACE_MS) → no se juzga: la página aún no está inyectada y la sonda
 *      solo puede dar un falso positivo.
 *   1. Sin veredicto (Chrome ocupado, página recargándose) → no se toca nada.
 *   2. Rota ESTRUCTURALMENTE (sin WWebJS / sin función expuesta / sin listener) o
 *      con HUECO (mensajes que llegan al navegador y no a la app) → se rescata lo
 *      perdido y se cuenta; solo si la señal se repite MAX_INGEST_GAPS vueltas
 *      SEGUIDAS se reinicia la sesión.
 *   3. Y aun así, nunca más de un reinicio cada INGEST_REPAIR_COOLDOWN_MS.
 * Reiniciar deja el estado en 'disconnected' (honesto) y la reconexión automática
 * la levanta en ~10 s.
 */
async function verifyIngest(key, entry) {
  // ── Puerta de entrada: solo se juzga una sesión ya INYECTADA ────────────────
  // La sonda pregunta por window.WWebJS, la función expuesta onAddMessageEvent y
  // el listener de la colección Msg. whatsapp-web.js crea las tres AL FINAL de su
  // arranque (Client.js: inyecta LoadUtils → espera a que window.WWebJS exista →
  // attachEventListeners → recién entonces emite 'ready'). Mientras el número
  // sincroniza, lo NORMAL es `WWebJS=false expuesta=false`, y esta función lo leía
  // como "ingesta muerta" y tiraba la sesión.
  //
  // Bastaba con que `healToConnected` marcara 'connected' una sesión que aún
  // sincronizaba (solo mira el socket, que sí está vivo mucho antes) para que
  // este chequeo entrara: se reiniciaba el número, volvía a sincronizar, y otra
  // vez — y como no llegaba nunca a 'ready', el número NO SE PODÍA CONECTAR.
  // Por eso la condición es el evento 'ready' de la librería, no el estado.
  if (!entry.readyAt) {
    // Una sesión curada a 'connected' por el socket nunca pasó por 'ready', y sin
    // esto se quedaría sin vigilancia para siempre. Se le pregunta a la página: si
    // resulta estar inyectada de verdad, se la adopta como lista y desde la
    // próxima vuelta se vigila como a cualquier otra. Adoptar exige PRUEBA de que
    // está inyectada, así que nunca puede convertirse en un falso positivo.
    const arranque = await probeIngest(entry, 0);
    if (arranque.ok && arranque.wwebjs === true && arranque.expuesta === true) {
      entry.readyAt = Date.now();
      console.log('[whatsapp-qr ingesta] %s: sesión ya inyectada sin evento ready; se adopta y se vigila.', key);
    }
    return;
  }
  if (Date.now() - entry.readyAt < INGEST_GRACE_MS) return;

  const acc = await WhatsappAccount.findById(key).select('lastInboundAt').lean().catch(() => null);
  if (!acc) return;
  const dbLast = acc.lastInboundAt ? new Date(acc.lastInboundAt).getTime() : 0;
  const probe = await probeIngest(entry, dbLast);
  if (clients.get(key) !== entry) return; // la sesión ya fue reemplazada

  if (!probe.ok) {
    // Igual que con getState: la falta de respuesta NO es muerte.
    console.log('[whatsapp-qr ingesta] %s sin veredicto (%s): no se toca.', key, probe.detalle || '');
    return;
  }

  const rota = probe.wwebjs === false || probe.expuesta === false || probe.enganchado === false;
  // Sin marca de recepción no hay con qué comparar (número que aún no ha recibido
  // nada nunca). No se inventa una: escribir aquí `lastInboundAt` con lo que haya
  // en la memoria del navegador marcaba como "ya guardados" mensajes que jamás
  // entraron, y de paso adelantaba la ventana de rescate, que es lo único que
  // podía recuperarlos. La marca la escribe la ingesta con la hora del mensaje.
  const hueco = dbLast > 0 && probe.pendientes > 0 && probe.ultimoEntranteMs - dbLast > INGEST_LAG_MS;

  if (!rota && !hueco) {
    ingestGaps.delete(key);
    return;
  }

  const motivo = rota
    ? `la sesión perdió el enganche de mensajes (WWebJS=${probe.wwebjs} expuesta=${probe.expuesta} listener=${probe.enganchado})`
    : `WhatsApp Web tiene ${probe.pendientes} mensajes que el sistema no guardó (${Math.round((probe.ultimoEntranteMs - dbLast) / 60000)} min de retraso)`;
  console.error('[whatsapp-qr ingesta] %s: %s', key, motivo);

  // Se rescata SIEMPRE primero: los mensajes están ahí y reiniciar la sesión no
  // los volvería a entregar.
  const rescatados = dbLast
    ? await recoverMissedInbound(entry.client, key, dbLast).catch(() => 0)
    : 0;

  // Dos vueltas SEGUIDAS (90 s) también para la avería estructural. WhatsApp Web
  // se recarga solo cada tanto y en esa ventana la página aparece sin inyectar;
  // la propia librería la re-engancha al siguiente app-state-sync. Confirmarlo
  // una vez más cuesta 45 s y evita tirar una sesión que se estaba curando sola.
  const seguidas = (ingestGaps.get(key) || 0) + 1;
  ingestGaps.set(key, seguidas);
  if (seguidas < MAX_INGEST_GAPS) {
    console.warn('[whatsapp-qr ingesta] %s: aviso %d/%d, se rescataron %d mensajes y se vuelve a mirar.',
      key, seguidas, MAX_INGEST_GAPS, rescatados);
    return;
  }

  // Freno de mano: una sonda equivocada no puede meter al número en un bucle de
  // reinicios (cada reinicio deja el canal caído ~30-60 s).
  const ahora = Date.now();
  const ultimoArreglo = ingestRepairAt.get(key);
  if (ultimoArreglo && ahora - ultimoArreglo < INGEST_REPAIR_COOLDOWN_MS) {
    console.warn('[whatsapp-qr ingesta] %s: reinicio omitido (hace menos de %d min del anterior).',
      key, Math.round(INGEST_REPAIR_COOLDOWN_MS / 60000));
    return;
  }
  ingestRepairAt.set(key, ahora);
  ingestGaps.delete(key);

  notifyQrDown(key, { needsQr: false, reason: motivo });
  await teardown(key, entry, {
    reason: `ingesta muerta — ${motivo}${rescatados ? ` (${rescatados} mensajes rescatados)` : ''}`,
    needsQr: false,
    error: 'El número figuraba conectado pero había dejado de recibir mensajes. Reconectando automáticamente…',
  });
}

// Cuándo se intenta el rescate tras conectar. Son VARIAS pasadas porque WhatsApp
// Web trae el historial poco a poco: a los 30 s la colección Msg todavía está a
// medias y un solo intento dejaría fuera casi todo lo de un apagón largo.
const RECOVER_AFTER_READY_MS = [30000, 3 * 60 * 1000, 10 * 60 * 1000];

/**
 * Tras un 'ready', reingresa los mensajes entrantes que se perdieron mientras la
 * sesión no estuvo operativa (caída, reiniciada por un deploy o zombi).
 *
 * La ventana se calcula UNA vez, ANTES de reingresar nada: si se recalculara en
 * cada pasada, el primer mensaje rescatado adelantaría `lastInboundAt` y los más
 * viejos —que WhatsApp Web todavía estaba cargando— quedarían fuera para siempre.
 * No se retrocede más de RECOVER_LOOKBACK_MS: más atrás la sesión ya no tiene el
 * mensaje en memoria.
 */
function scheduleRecoveryAfterReady(key, accountId, entry) {
  const arranque = setTimeout(async () => {
    try {
      if (clients.get(key) !== entry) return;
      const acc = await WhatsappAccount.findById(key).select('lastInboundAt').lean().catch(() => null);
      if (!acc) return;
      const dbLast = acc.lastInboundAt ? new Date(acc.lastInboundAt).getTime() : 0;
      // Sin referencia (cuenta nueva, o primera vez con este campo) se barre el
      // día entero: es lo que recupera el apagón que nadie llegó a registrar.
      const desde = Math.max(dbLast || 0, Date.now() - RECOVER_LOOKBACK_MS);
      let transcurrido = 0;
      for (const marca of RECOVER_AFTER_READY_MS) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(marca - transcurrido);
        transcurrido = marca;
        if (clients.get(key) !== entry || entry.status !== 'connected') return;
        // eslint-disable-next-line no-await-in-loop
        const n = await recoverMissedInbound(entry.client, accountId, desde);
        if (n) console.log('[whatsapp-qr] %s: %d mensajes recuperados tras reconectar.', key, n);
      }
    } catch (e) {
      console.warn('[whatsapp-qr rescate] tras conectar falló: %s', e.message);
    }
  }, 0);
  arranque.unref?.();
}

// Números cuyo arranque está EN CURSO (ver connect).
const starting = new Set();

/**
 * Inicia (o reutiliza) el cliente de un número QR. `userId` se usa para mandarle
 * el QR directamente a quien pulsó "Conectar".
 */
async function connect(accountId, { userId } = {}) {
  const key = String(accountId);
  // Dos arranques a la vez para el MISMO número (el botón "Conectar" mientras
  // entra un reintento automático) levantarían dos Chromium sobre la misma
  // carpeta de sesión: Chrome no admite dos procesos en el mismo perfil y la
  // sesión guardada acaba corrupta. El segundo intento se descarta.
  if (starting.has(key)) return { ok: true, status: 'connecting' };
  starting.add(key);
  try {
    return await startClient(key, accountId, userId);
  } finally {
    starting.delete(key);
  }
}

async function startClient(key, accountId, userId) {
  // Un reintento pendiente ya no hace falta: o lo estamos ejecutando nosotros, o
  // alguien pulsó "Conectar". Los intentos acumulados se conservan (los borra el
  // 'ready', que es la única prueba de que la sesión volvió).
  const pending = reconnectTimers.get(key);
  if (pending) { clearTimeout(pending); reconnectTimers.delete(key); }
  const existing = clients.get(key);
  if (existing && existing.client) {
    if (existing.status === 'connected') {
      // Ya figura conectado: verificar que la sesión siga VIVA antes de reusarla
      // (si se desvinculó desde el teléfono sin evento, aquí se detecta y se
      // sigue con una conexión desde cero en vez de reemitir un estado falso).
      const still = await verifyConnected(key, existing, 6000).catch(() => 'connected');
      if (still === 'connected') {
        await emitStatus(key, { status: 'connected' }, userId);
        return { ok: true, status: 'connected' };
      }
    } else {
      // Cliente vivo pero NO conectado (p.ej. quedó en 'connecting' colgado, o en
      // 'qr_pending' con un QR que ya caducó — típico tras initEnabledOnBoot).
      // Antes se reusaba y solo se reemitía el estado, sin volver a generar el QR:
      // el botón "Conectar" quedaba muerto hasta reiniciar el server. Ahora se
      // destruye y se arranca de cero para garantizar un QR fresco.
      clients.delete(key);
      if (existing.watchdog) clearTimeout(existing.watchdog);
      if (existing.syncWatchdog) clearTimeout(existing.syncWatchdog);
      try { await existing.client.destroy(); } catch { /* noop */ }
    }
  }

  const account = await WhatsappAccount.findById(accountId);
  if (!account || account.connectionType !== 'qr') {
    return { ok: false, error: 'Número QR no encontrado' };
  }

  let Client;
  let LocalAuth;
  let QRCode;
  try {
    ({ Client, LocalAuth } = require('whatsapp-web.js'));
    QRCode = require('qrcode');
  } catch (e) {
    await setAccountStatus(accountId, { status: 'auth_failure' });
    return { ok: false, error: `No se pudo cargar whatsapp-web.js: ${e.message}` };
  }

  const sessionId = account.sessionId || `wa_${key}`;
  if (!account.sessionId) {
    account.sessionId = sessionId;
    await account.save();
  }

  let client;
  try {
    client = new Client({
      authStrategy: new LocalAuth({
        clientId: sessionId,
        dataPath: WA_DATA_PATH,
      }),
      // El UA por defecto de whatsapp-web.js es Chrome 101 (2022): WhatsApp Web
      // rechaza navegadores tan viejos y expulsa la sesión antes de dar el QR.
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
      // 'local' (default) intercepta y sirve un HTML viejo de WhatsApp Web
      // (webVersion 2.3000.1017054665) que el servidor de WhatsApp ya no acepta.
      webVersionCache: { type: 'none' },
      puppeteer: {
        headless: true,
        executablePath: resolveChromePath() || undefined,
        // Banderas de ESTABILIDAD en un VPS pequeño. Las tres primeras son las de
        // siempre (sandbox y /dev/shm); el resto le quitan a Chrome trabajo y
        // memoria que aquí no sirven para nada, y —importante— le prohíben
        // "dormir" la pestaña por estar en segundo plano: una pestaña dormida
        // deja de renovar el socket de WhatsApp y la sesión se cae sola.
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-extensions',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-features=site-per-process,TranslateUI',
          '--no-first-run',
          '--no-default-browser-check',
          '--mute-audio',
        ],
      },
    });
  } catch (e) {
    await setAccountStatus(accountId, { status: 'auth_failure' });
    return { ok: false, error: `No se pudo crear el cliente: ${e.message}` };
  }

  const entry = { client, status: 'connecting', watchdog: null, syncWatchdog: null, gotQr: false, lastQr: '', percent: null };
  clients.set(key, entry);
  ensureHealthTimer();
  await setAccountStatus(accountId, { status: 'connecting' });
  await emitStatus(key, { status: 'connecting' }, userId);

  // Watchdog: si en 90s no salió ni un QR ni conectó (Chrome colgado, sesión
  // corrupta, red), se mata el cliente y se avisa, en vez de dejar la UI en
  // "Generando código QR…" para siempre. No aplica si ya hubo QR (el usuario
  // puede tardar en escanear y la sincronización posterior también toma tiempo).
  entry.watchdog = setTimeout(async () => {
    const cur = clients.get(key);
    if (!cur || cur.client !== client || cur.gotQr || cur.status !== 'connecting') return;
    clients.delete(key);
    entry.closing = true;
    try { await client.destroy(); } catch { /* noop */ }
    const fresh = await WhatsappAccount.findById(accountId).catch(() => null);
    if (fresh && !fresh.connectedPhone) await wipeLocalSession(sessionId);
    await setAccountStatus(accountId, { status: 'auth_failure' });
    await emitStatus(key, {
      status: 'auth_failure',
      error: 'No se pudo generar el QR en 90 segundos. Vuelve a pulsar "Conectar".',
    }, userId);
    // Un número YA vinculado que no arranca casi siempre es Chrome atascado, no
    // una sesión inválida: se sigue reintentando solo (con espera creciente).
    if (fresh && fresh.connectedPhone) scheduleReconnect(key, 'el arranque no llegó a conectar en 90s');
  }, 90000);

  client.on('qr', async (qr) => {
    entry.status = 'qr_pending';
    entry.gotQr = true;
    if (entry.watchdog) { clearTimeout(entry.watchdog); entry.watchdog = null; }
    await setAccountStatus(accountId, { status: 'qr_pending', lastQrAt: new Date() });
    let dataUrl = '';
    try {
      dataUrl = await QRCode.toDataURL(qr);
    } catch {
      /* noop */
    }
    entry.lastQr = dataUrl; // respaldo para el sondeo HTTP si el socket está caído
    const payload = { status: 'qr_pending', qr: dataUrl };
    emitToCallCenter('whatsapp:qr', { accountId: key, ...payload });
    if (userId) emitToUser(userId, 'whatsapp:qr', { accountId: key, ...payload });
    // Un número YA vinculado que vuelve a pedir QR = la sesión guardada dejó de
    // servir: nadie lo va a reconectar solo, así que hay que avisar (antes esto
    // era mudo y el número se quedaba pidiendo un QR que nadie miraba).
    if (!userId) {
      const acc = await WhatsappAccount.findById(accountId).lean().catch(() => null);
      if (acc?.connectedPhone) {
        await setAccountStatus(accountId, { lastDisconnectNeedsQr: true });
        notifyQrDown(key, { needsQr: true, reason: 'la sesión guardada dejó de servir' });
      }
    }
  });

  // Watchdog de SINCRONIZACIÓN: tras escanear el QR (o al reconectar con la
  // sesión guardada), whatsapp-web.js a veces nunca emite 'ready' y el número
  // queda "sincronizando…" para siempre (típico tras un deploy) — y con él
  // fallan todos los envíos de las automatizaciones. Cada señal de progreso
  // re-arma el timer; si pasa SYNC_STUCK_MS sin llegar a 'ready', se destruye
  // el cliente y se reintenta UNA vez desde la sesión guardada (sin QR nuevo);
  // si vuelve a colgarse, queda 'disconnected' con el motivo visible.
  const armSyncWatchdog = () => {
    if (entry.syncWatchdog) clearTimeout(entry.syncWatchdog);
    entry.syncWatchdog = setTimeout(async () => {
      const cur = clients.get(key);
      if (!cur || cur.client !== client || cur.status !== 'syncing') return;
      clients.delete(key);
      entry.closing = true;
      try { await client.destroy(); } catch { /* noop */ }
      const retries = syncRetries.get(key) || 0;
      if (retries < 1) {
        syncRetries.set(key, retries + 1);
        console.warn(`[whatsappQr] sincronización colgada en ${key}; reintentando desde la sesión guardada`);
        await emitStatus(key, { status: 'connecting' }, userId);
        connect(accountId, { userId }).catch(() => {});
        return;
      }
      syncRetries.delete(key);
      await setAccountStatus(accountId, {
        status: 'disconnected',
        lastDisconnectAt: new Date(),
        lastDisconnectReason: 'la sincronización no terminó',
      });
      await emitStatus(key, {
        status: 'disconnected',
        error: 'La sincronización no terminó (WhatsApp no confirmó la sesión). Reconectando automáticamente…',
      }, userId);
      // Ya no se abandona: se sigue intentando solo con espera creciente.
      scheduleReconnect(key, 'la sincronización no terminó');
    }, SYNC_STUCK_MS);
    entry.syncWatchdog.unref?.();
  };

  client.on('ready', async () => {
    entry.status = 'connected';
    entry.lastQr = '';
    entry.percent = null;
    entry.misses = 0;
    // Único momento en el que se puede afirmar que la página está INYECTADA:
    // whatsapp-web.js emite 'ready' después de cargar window.WWebJS y enganchar
    // los listeners de mensajes. El chequeo de ingesta se apoya en esta marca
    // para no juzgar (y matar) una sesión que todavía estaba arrancando.
    entry.readyAt = Date.now();
    ingestGaps.delete(key);
    if (entry.watchdog) { clearTimeout(entry.watchdog); entry.watchdog = null; }
    if (entry.syncWatchdog) { clearTimeout(entry.syncWatchdog); entry.syncWatchdog = null; }
    syncRetries.delete(key);
    // La sesión volvió: se borra la cuenta de reintentos (y el motivo de la
    // última caída) para que la próxima empiece otra vez por los 10 segundos.
    cancelReconnect(key);
    watchBrowser(key, entry);
    const connectedPhone = (client.info?.wid?.user || '').toString();
    await setAccountStatus(accountId, {
      status: 'connected',
      connectedPhone,
      lastConnectedAt: new Date(),
      lastDisconnectNeedsQr: false,
    });
    await emitStatus(key, { status: 'connected', connectedPhone }, userId);
    // Todo lo que entró mientras la sesión estuvo caída (o zombi) sigue en el
    // teléfono del contacto y WhatsApp Web lo trae al sincronizar: se reingresa
    // en vez de darlo por perdido. Ver scheduleRecoveryAfterReady.
    scheduleRecoveryAfterReady(key, accountId, entry);
  });

  // QR escaneado: WhatsApp sincroniza la sesión hasta 'ready'. Antes esta fase
  // era muda y la UI seguía diciendo "Escanea el QR" — ahora se avisa.
  client.on('authenticated', async () => {
    entry.status = 'syncing';
    entry.lastQr = '';
    armSyncWatchdog();
    await setAccountStatus(accountId, { status: 'syncing' });
    await emitStatus(key, { status: 'syncing' }, userId);
  });

  // Progreso de la sincronización (0-100). No se persiste; solo informa a la UI.
  // Cada avance re-arma el watchdog (hay vida: no matar una sync lenta).
  client.on('loading_screen', async (percent) => {
    entry.status = 'syncing';
    entry.percent = Number(percent) || 0;
    armSyncWatchdog();
    await emitStatus(key, { status: 'syncing', percent: entry.percent }, userId);
  });

  // Credenciales guardadas rechazadas: no hay reconexión posible sin un QR nuevo.
  client.on('auth_failure', async (message) => {
    entry.status = 'auth_failure';
    if (entry.watchdog) { clearTimeout(entry.watchdog); entry.watchdog = null; }
    if (entry.syncWatchdog) { clearTimeout(entry.syncWatchdog); entry.syncWatchdog = null; }
    cancelReconnect(key);
    console.error('[whatsappQr] %s: WhatsApp rechazó la sesión guardada (%s). Hace falta escanear el QR.', key, message || 'sin detalle');
    await setAccountStatus(accountId, {
      status: 'auth_failure',
      lastDisconnectAt: new Date(),
      lastDisconnectReason: `auth_failure: ${message || 'sesión rechazada'}`,
      lastDisconnectNeedsQr: true,
    });
    await emitStatus(key, { status: 'auth_failure' }, userId);
    notifyQrDown(key, { needsQr: true, reason: 'WhatsApp rechazó la sesión guardada' });
  });

  // La librería emite 'disconnected' con el ESTADO que provocó la caída (o
  // 'LOGOUT'). Solo un logout/desvinculación exige un QR nuevo; lo demás
  // (CONFLICT, versión vieja, un tropiezo de la página) se reconecta solo.
  client.on('disconnected', async (reason) => {
    const r = String(reason || '').toUpperCase();
    const needsQr = r === 'LOGOUT' || NEEDS_QR_STATES.has(r);
    await teardown(key, entry, {
      reason: `evento disconnected: ${r || 'sin motivo'}`,
      needsQr,
      error: needsQr
        ? 'La sesión se cerró desde el teléfono (dispositivo desvinculado). Escanea el QR otra vez.'
        : 'La sesión se cortó; reconectando automáticamente…',
    });
  });

  // Desvinculación detectada por cambio de estado (a veces 'disconnected' no llega).
  client.on('change_state', async (state) => {
    if (NEEDS_QR_STATES.has(state)) {
      if (clients.get(key) !== entry) return;
      await teardown(key, entry, {
        reason: `change_state: ${state}`,
        needsQr: true,
        error: 'El teléfono desvinculó este dispositivo. Escanea el QR otra vez.',
      });
    }
  });

  // Mensaje entrante → mismo pipeline de ingesta que el webhook Cloud API.
  // El cuerpo vive en ingestIncomingQrMessage (nivel de módulo) porque el rescate
  // de mensajes perdidos tiene que pasar por EXACTAMENTE el mismo camino.
  client.on('message', (msg) => {
    ingestIncomingQrMessage(msg, client, accountId).catch((e) =>
      console.error('[whatsapp-qr message]', e.message)
    );
  });

  // Mensaje SALIENTE creado (incluye los que el agente escribe desde el teléfono,
  // fuera del CRM). Solo nos interesan los `fromMe`: los entrantes ya los maneja
  // el evento 'message'. La ingesta deduplica los que envió el propio sistema.
  client.on('message_create', async (msg) => {
    try {
      if (!msg.fromMe || msg.isStatus) return;
      const to = typeof msg.to === 'string' ? msg.to : '';
      if (!/@(c\.us|lid)$/.test(to)) return; // solo chats directos (no grupos)
      if (!CONTENT_TYPES.includes(msg.type)) return;
      // Mismo número real que en el entrante, para casar el saliente con SU chat.
      const phone = await resolveQrPhone(client, to, msg);
      if (!phone) return;

      const media = await extractQrMedia(msg, client);
      if (!String(msg.body || '').trim() && !media) return;

      const account2 = await WhatsappAccount.findById(accountId);
      const clinicId = await require('./callCenterClinic').resolveCallCenterClinicId();
      if (!clinicId) return;

      const serializedId = qrMessageId(msg);

      const { ingestExternalOutbound } = require('../controllers/chatController');
      await ingestExternalOutbound({
        clinicId,
        account: account2,
        phone,
        externalUserId: to,
        body: msg.body || '',
        media,
        externalId: serializedId,
        contactName: msg._data?.notifyName || '',
      });
    } catch (e) {
      console.error('[whatsapp-qr message_create]', e.message);
    }
  });

  // Confirmaciones de entrega de los mensajes salientes.
  client.on('message_ack', async (msg, ack) => {
    try {
      const status = ACK_STATUS[String(ack)];
      const externalId = qrMessageId(msg);
      if (!status || !externalId) return;
      const clinicId = await require('./callCenterClinic').resolveCallCenterClinicId();
      if (!clinicId) return;
      const messaging = require('./messaging');
      await messaging.updateMessageStatus({ clinicId, externalId, status });
    } catch { /* noop */ }
  });

  client
    .initialize()
    // Vigilar el navegador en cuanto exista: si el Chromium muere (falta de
    // memoria en el VPS), la sesión se reconecta sin esperar al chequeo de salud.
    .then(() => watchBrowser(key, entry))
    .catch(async (e) => {
      const noChrome = /Could not find Chrome|Failed to launch/i.test(e.message || '');
      const short = noChrome
        ? 'Chromium no disponible en este entorno: los números QR no se conectarán aquí. Usa Cloud API, o un servidor con Chrome (VPS). Puedes fijar PUPPETEER_EXECUTABLE_PATH.'
        : (e.message || '').split('\n')[0];
      console.error('[whatsapp-qr initialize]', short);
      if (entry.watchdog) { clearTimeout(entry.watchdog); entry.watchdog = null; }
      clients.delete(key);
      entry.closing = true;
      try { await client.destroy(); } catch { /* noop */ }
      const fresh = await WhatsappAccount.findById(accountId).catch(() => null);
      if (fresh && !fresh.connectedPhone) await wipeLocalSession(sessionId);
      await setAccountStatus(accountId, {
        status: 'auth_failure',
        lastDisconnectAt: new Date(),
        lastDisconnectReason: short,
      });
      await emitStatus(key, { status: 'auth_failure', error: short }, userId);
      // Arrancar Chrome puede fallar por algo pasajero (el VPS sin memoria en ese
      // instante). Si el número ya estaba vinculado, se reintenta solo.
      if (fresh && fresh.connectedPhone) scheduleReconnect(key, short);
    });

  return { ok: true, status: 'connecting' };
}

/**
 * Cierra la sesión de un número (logout) y limpia su estado. Es la desconexión
 * DELIBERADA (botón "Desconectar" / borrar el número): se cancela la reconexión
 * automática y se marca que hará falta un QR nuevo — el logout borra la sesión
 * guardada, así que el supervisor no debe intentar levantarla otra vez.
 */
async function disconnect(accountId) {
  const key = String(accountId);
  cancelReconnect(key);
  const entry = clients.get(key);
  if (entry && entry.client) {
    if (entry.watchdog) { clearTimeout(entry.watchdog); entry.watchdog = null; }
    if (entry.syncWatchdog) { clearTimeout(entry.syncWatchdog); entry.syncWatchdog = null; }
    entry.closing = true;
    try { await entry.client.logout(); } catch { /* noop */ }
    try { await entry.client.destroy(); } catch { /* noop */ }
  }
  clients.delete(key);
  syncRetries.delete(key);
  await setAccountStatus(accountId, {
    status: 'disconnected',
    lastDisconnectAt: new Date(),
    lastDisconnectReason: 'desconectado a mano desde la app',
    lastDisconnectNeedsQr: true,
  });
  await emitStatus(key, { status: 'disconnected' });
  return { ok: true };
}

// sendMessage de whatsapp-web.js puede COLGARSE indefinidamente (p.ej. chatId
// inexistente): sin límite, la petición HTTP moría en 504 de nginx y el
// mensaje quedaba "en cola" para siempre.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms).unref?.()),
  ]);
}

/**
 * Resuelve el chatId destino. JID completo si viene (…@c.us / …@lid, contactos
 * con número oculto); si solo hay dígitos, resolver el JID real con getNumberId —
 * valida que el número exista en WhatsApp y devuelve @c.us o @lid según
 * corresponda (un LID crudo enviado como @c.us se colgaba sin error).
 */
async function resolveChatId(entry, to) {
  let chatId = String(to || '').trim();
  if (!chatId) return { ok: false, error: 'Destino vacío' };
  if (!chatId.includes('@')) {
    const digits = chatId.replace(/[^\d]/g, '');
    if (!digits) return { ok: false, error: 'Teléfono inválido' };
    const numberId = await withTimeout(
      entry.client.getNumberId(digits),
      15000,
      'Tiempo agotado verificando el número en WhatsApp'
    );
    if (!numberId) {
      return { ok: false, errorCode: 'qr_invalid_number', error: `El número ${digits} no está en WhatsApp` };
    }
    chatId = numberId._serialized;
  }
  return { ok: true, chatId };
}

/**
 * Espera (hasta timeoutMs) a que la sesión termine de conectar. Tras un deploy
 * (pm2 restart) la sesión guardada tarda ~30-60 s en volver a 'connected';
 * los envíos de workflows que caían en esa ventana fallaban con "el número QR
 * no está conectado" aunque el número apareciera conectado minutos después.
 * Solo espera estados que se resuelven solos (connecting/syncing); si hace
 * falta escanear un QR o la sesión murió, devuelve null de inmediato.
 */
async function waitForConnected(key, timeoutMs = 45000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const entry = clients.get(key);
    if (entry && entry.status === 'connected') return entry;
    if (!entry || !['connecting', 'syncing'].includes(entry.status)) return null;
    if (Date.now() > until) return null;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/**
 * Cura una entrada a 'connected' cuando la sesión resultó estar viva de verdad,
 * pero el estado cacheado se había quedado atrás. Desarma los watchdogs de
 * sincronización (si no, el destructivo podría cerrar una sesión que SÍ funciona)
 * y refleja el estado en la BD + la UI.
 */
function healToConnected(key, entry) {
  if (!entry || entry.status === 'connected') return;
  // ── Hace falta PRUEBA de que la sesión está VINCULADA, no solo de que el
  // socket contesta. `getState()` responde CONNECTED mientras WhatsApp Web
  // sincroniza un número recién escaneado, que todavía no es una sesión usable.
  //
  // whatsapp-web.js construye `client.info` (el wid del número) justo antes de
  // emitir 'ready', así que su ausencia significa "aún no está vinculada".
  // Sin esta guarda, un número a medio vincular pasaba a 'connected': la app
  // decía CONECTADO, el equipo daba el número por bueno y los mensajes de los
  // pacientes NUNCA entraban (no hay sesión que los ingiera). Peor: curar el
  // estado desarma el watchdog de sincronización, que era justo quien tenía que
  // reintentar o reportar el fallo — el número se quedaba mintiendo para siempre.
  const connectedPhone = (entry.client?.info?.wid?.user || '').toString();
  if (!connectedPhone && !entry.readyAt) {
    console.warn(
      '[whatsappQr] %s: getState dice CONNECTED pero la sesión aún no está vinculada (sin client.info): NO se cura a conectado.',
      key
    );
    return;
  }
  // OJO: aquí NO se toca `entry.readyAt`. Estar vinculada no prueba que la página
  // esté inyectada; de eso se encarga el chequeo de ingesta (ver verifyIngest).
  entry.status = 'connected';
  entry.percent = null;
  entry.misses = 0;
  cancelReconnect(key); // la sesión está viva: no hay nada que reintentar
  watchBrowser(key, entry);
  if (entry.syncWatchdog) { clearTimeout(entry.syncWatchdog); entry.syncWatchdog = null; }
  if (entry.watchdog) { clearTimeout(entry.watchdog); entry.watchdog = null; }
  setAccountStatus(key, {
    status: 'connected',
    ...(connectedPhone ? { connectedPhone, lastConnectedAt: new Date() } : {}),
  }).catch(() => {});
  emitStatus(key, { status: 'connected', ...(connectedPhone ? { connectedPhone } : {}) }).catch(() => {});
  console.log(`[whatsappQr] estado curado a 'connected' para ${key} (la sesión estaba viva; getState=CONNECTED).`);
}

/**
 * Devuelve una entrada LISTA PARA ENVIAR, o null si de verdad no hay sesión.
 *
 * POR QUÉ: el estado cacheado (`entry.status`) NO es fiable. whatsapp-web.js
 * re-emite 'authenticated'/'loading_screen' al RE-SINCRONIZAR (tras reiniciar el
 * VPS, un bache de red, etc.) y deja el estado pegado en 'syncing'/'connecting'
 * aunque la sesión SÍ funcione — recibe mensajes y el teléfono envía, pero los
 * envíos del sistema fallaban con "el número QR no está conectado" y el chat
 * mostraba burbujas rojas con la sesión perfectamente viva. Antes de rendirnos,
 * preguntamos el estado REAL a la sesión (getState); si responde CONNECTED,
 * curamos el estado y enviamos igual.
 */
async function acquireSendableEntry(key) {
  let entry = clients.get(key);
  if (entry && entry.status === 'connected') return entry;
  if (entry && entry.client) {
    // timeout = Chrome ocupado (no muerto): se asume viva y el envío, con su
    // propio timeout, decide. 'transient' (OPENING/TIMEOUT) = está volviendo
    // sola: se espera abajo en vez de fallar con "el número no está conectado".
    const probe = await probeState(entry, 6000).catch(() => ({ verdict: 'unknown' }));
    if (probe.verdict === 'connected' || probe.verdict === 'busy') {
      healToConnected(key, entry);
      return entry;
    }
  }
  // Sin veredicto de "conectado": si hay una sincronización en curso, espera a que
  // termine; si no, no está disponible.
  entry = await waitForConnected(key);
  return entry && entry.client && entry.status === 'connected' ? entry : null;
}

/**
 * Localiza DENTRO de la página de WhatsApp Web el mensaje a citar y devuelve su
 * id serializado REAL en el store (`{ id, step }`). NO usa los helpers de alto
 * nivel de whatsapp-web.js (getChatById/fetchMessages/getMessageById): esos
 * serializan modelos enteros (frágil) y exigen el id con la MISMA forma de JID
 * con que el store lo guardó — en chats LID (número oculto) el store puede
 * tener el mensaje bajo el número real (@c.us) aunque nosotros lo guardamos
 * como @lid, o al revés, y por eso "no se encontraba" ni un mensaje recién
 * enviado. Trabaja directo sobre el store con el mismo WWebJS.getChat del
 * envío normal (que sí funciona en estos chats). Estrategias, en orden:
 *   1) Msg.get(wamid) exacto.
 *   2) Por la parte ÚNICA del wamid (el hash), ignorando la forma del JID.
 *   3) Por TEXTO exacto del mensaje citado (cuando no hay wamid guardado).
 */
function findQuoteTargetId(entry, chatId, wamid, quoteBody) {
  return entry.client.pupPage.evaluate(async (chatId, wamid, body) => {
    // En chats LID el modelo del store puede NO exponer `id._serialized`
    // (probado en producción: se encontraba el mensaje por texto y el id salía
    // vacío). Se serializa de forma tolerante y, si hace falta, se reconstruye
    // a mano: fromMe_remoto_id[_participante].
    const widStr = (w) => {
      if (!w) return '';
      if (typeof w === 'string') return w;
      if (w._serialized) return String(w._serialized);
      if (w.user && w.server) return w.user + '@' + w.server;
      const s = typeof w.toString === 'function' ? w.toString() : '';
      return s && s !== '[object Object]' ? s : '';
    };
    const keyStr = (k) => {
      if (!k) return '';
      if (k._serialized) return String(k._serialized);
      const s = typeof k.toString === 'function' ? k.toString() : '';
      if (s && s !== '[object Object]') return s;
      const remote = widStr(k.remote);
      if (k.id && remote) {
        const part = widStr(k.participant);
        return (k.fromMe ? 'true' : 'false') + '_' + remote + '_' + k.id + (part ? '_' + part : '');
      }
      return '';
    };
    try {
      const Coll = window.require('WAWebCollections');
      // Devuelve el id del modelo encontrado, asegurando que el lookup que hará
      // whatsapp-web.js al citar (Msg.get global) lo pueda resolver.
      const finish = (m, step) => {
        const id = keyStr(m.id);
        if (!id) {
          const shape = m.id ? Object.keys(m.id).slice(0, 8).join(',') : 'sin_id';
          return { id: '', step: step + '_sin_serializar(' + shape + ')' };
        }
        let extra = '';
        if (!Coll.Msg.get(id)) {
          try { Coll.Msg.add(m); } catch (e) { /* colección no admite add */ }
          if (!Coll.Msg.get(id)) extra = '+fuera_del_store_global';
        }
        return { id, step: step + extra };
      };
      if (wamid) {
        const direct = Coll.Msg.get(wamid);
        if (direct && direct.id) return finish(direct, 'store');
      }
      const chat = await window.WWebJS.getChat(chatId, { getAsModel: false });
      if (!chat || !chat.msgs) return { id: '', step: 'chat_no_encontrado' };
      let msgs = chat.msgs.getModelsArray();
      try {
        const loader = window.require('WAWebChatLoadMessages');
        for (let i = 0; i < 5 && msgs.length < 50; i++) {
          const more = await loader.loadEarlierMsgs({ chat });
          if (!more || !more.length) break;
          msgs = chat.msgs.getModelsArray();
        }
      } catch (e) { /* seguir con lo que haya en memoria */ }
      // El hash es la 3ª parte del wamid (fromMe_remoto_HASH): idéntico en
      // ambas formas del JID.
      const hash = wamid ? String(wamid).split('_')[2] || '' : '';
      if (hash) {
        const byHash = msgs.filter((m) => m.id && m.id.id === hash);
        if (byHash.length) return finish(byHash[byHash.length - 1], 'hash');
      }
      const needle = String(body || '').trim();
      if (needle) {
        const byBody = msgs.filter((m) => String(m.body || '').trim() === needle);
        if (byBody.length) return finish(byBody[byBody.length - 1], 'texto');
      }
      return { id: '', step: 'sin_coincidencia(' + msgs.length + ' mensajes)' };
    } catch (e) {
      return { id: '', step: 'error:' + String((e && e.message) || e).slice(0, 120) };
    }
  }, chatId, wamid || '', quoteBody || '');
}

/**
 * Cuando WhatsApp Web envió el mensaje pero DESCARTÓ la cita en silencio,
 * pregunta dentro de la página el porqué (canReplyMsg / msgContextInfo). Es
 * solo diagnóstico: nunca lanza, devuelve un código corto.
 */
async function diagnoseQuoteDrop(entry, wamid) {
  if (!wamid) return 'sin_wamid';
  try {
    return await withTimeout(entry.client.pupPage.evaluate((mid) => {
      try {
        const m = window.require('WAWebCollections').Msg.get(mid);
        if (!m) return 'no_en_store';
        try {
          const R = window.require('WAWebMsgReply');
          const can = R && R.canReplyMsg
            ? !!R.canReplyMsg(m.unsafe ? m.unsafe() : m)
            : (typeof m.canReply === 'function' ? !!m.canReply() : null);
          if (can === false) return 'cannot_reply';
        } catch (e) { return 'canReply_error'; }
        if (typeof m.msgContextInfo !== 'function') return 'sin_msgContextInfo';
        return 'motivo_desconocido';
      } catch (e) { return 'eval_error'; }
    }, wamid), 8000, 'diagnose timeout');
  } catch (e) {
    return 'diagnose_timeout';
  }
}

/**
 * Envía `content` citando el mensaje indicado si se puede resolver (por wamid o
 * por texto). Si no, envía normal — nunca se pierde el mensaje. Devuelve
 * `{ sent, quote }` donde `quote` es el resultado REAL de la cita:
 *   { applied, how: 'id'|'text', reason, wamid }
 * `applied` se verifica DESPUÉS de enviar con `sent.hasQuotedMsg`: whatsapp-web.js
 * puede descartar la cita en silencio aun con el mensaje localizado (p.ej.
 * canReplyMsg=false), y esa era una caja negra — ahora queda registrado.
 */
async function sendResolvingQuote(entry, chatId, content, quotedMessageId, opts = {}, quoteBody = '') {
  const quote = { applied: false, how: '', reason: '', wamid: '' };
  if (quotedMessageId || String(quoteBody || '').trim()) {
    let found = { id: '', step: 'error:desconocido' };
    try {
      found = await withTimeout(
        findQuoteTargetId(entry, chatId, quotedMessageId, quoteBody),
        20000,
        'timeout buscando el mensaje a citar'
      );
    } catch (e) {
      found = { id: '', step: `error:${e.message}` };
    }
    if (found.id) {
      quote.how = found.step;
      quote.wamid = found.id;
      try {
        // El id encontrado es el REAL del store: Msg.get lo resolverá dentro de
        // la página. ignoreQuoteErrors:false → si aun así no lo localiza,
        // LANZA (default: manda normal en silencio) y aquí queda el motivo.
        const sent = await entry.client.sendMessage(chatId, content, {
          ...opts,
          quotedMessageId: found.id,
          ignoreQuoteErrors: false,
        });
        if (sent && sent.hasQuotedMsg === false) {
          quote.reason = `library_dropped:${await diagnoseQuoteDrop(entry, found.id)}`;
          console.warn('[whatsapp-qr quote] WhatsApp Web descartó la cita:', quote.reason);
        } else {
          quote.applied = true;
        }
        return { sent, quote };
      } catch (e) {
        quote.reason = `reply_error:${String(e.message || '').slice(0, 160)}`;
        console.warn('[whatsapp-qr quote] envío citando falló, se envía normal:', e.message);
      }
    } else {
      quote.reason = `not_found:${found.step}`;
      console.warn('[whatsapp-qr quote] mensaje a citar no localizado:', found.step);
    }
  }
  const sent = await entry.client.sendMessage(chatId, content, opts);
  return { sent, quote };
}

/** Envía texto por la sesión QR. Devuelve un shape compatible con messaging. */
/**
 * El error de un envío por QR, en castellano y diciendo qué hacer.
 *
 * Los fallos de whatsapp-web.js llegan como errores crudos de Puppeteer
 * ("Protocol error (Runtime.callFunctionOn): Promise was collected", "Target
 * closed", "Session closed"…) y se pintaban tal cual en la burbuja roja del
 * chat: el agente no puede saber si el mensaje salió o no, ni si reintentar.
 * Todos esos significan lo mismo: la pestaña de WhatsApp Web se recargó o se
 * cayó EN MITAD del envío.
 *
 * Y sí, hay que decir que puede haber salido: no se puede confirmar, y un
 * "reintenta" a secas es como se mandan mensajes duplicados a un paciente.
 */
function qrSendErrorText(err) {
  const raw = String(err?.message || err || '');
  if (/Protocol error|Promise was collected|Target closed|Session closed|detached Frame|Execution context/i.test(raw)) {
    return (
      'La sesión de WhatsApp Web se recargó en mitad del envío, así que no se pudo confirmar. ' +
      'Mira el chat en el teléfono antes de reintentar: puede que el mensaje sí haya salido.'
    );
  }
  return raw;
}

async function sendText(account, to, body, quotedMessageId, quoteBody) {
  const key = String(account._id);
  const entry = await acquireSendableEntry(key);
  if (!entry) {
    return { ok: false, errorCode: 'qr_not_connected', error: 'El número QR no está conectado' };
  }
  try {
    const r = await resolveChatId(entry, to);
    if (!r.ok) return r;
    const { sent, quote } = await withTimeout(
      sendResolvingQuote(entry, r.chatId, String(body || '').slice(0, 4096), quotedMessageId, {}, quoteBody),
      50000,
      'Tiempo agotado enviando el mensaje (la sesión puede estar inestable)'
    );
    return {
      ok: true,
      data: { messages: [{ id: qrMessageId(sent) }] },
      ...(quotedMessageId || quoteBody ? { quote } : {}),
    };
  } catch (e) {
    return { ok: false, errorCode: 'qr_send_error', error: qrSendErrorText(e) };
  }
}

/**
 * ¿Salió de verdad el adjunto? Busca en el propio chat un mensaje NUESTRO con
 * media creado desde que empezó el envío y devuelve su wamid.
 *
 * whatsapp-web.js devuelve `undefined` cuando su colección interna todavía no
 * tiene el mensaje al terminar `sendMessage`, aunque ya lo haya encolado para
 * enviar — más probable cuanto más pesa el archivo. Sin esta comprobación el
 * video salía al contacto pero el sistema lo marcaba FALLIDO, y reintentarlo lo
 * enviaba DOS veces.
 */
async function findRecentlySentMedia(entry, chatId, startedAtMs) {
  // Margen por el desfase de reloj entre el servidor y WhatsApp Web.
  const sinceSec = Math.floor(startedAtMs / 1000) - 30;
  for (const wait of [1500, 3000]) {
    await sleep(wait);
    try {
      // eslint-disable-next-line no-await-in-loop
      const chat = await withTimeout(entry.client.getChatById(chatId), 15000, 'timeout abriendo el chat');
      // eslint-disable-next-line no-await-in-loop
      const msgs = await withTimeout(chat.fetchMessages({ limit: 8 }), 20000, 'timeout leyendo el chat');
      const mine = (msgs || []).filter((m) => m.fromMe && m.hasMedia && Number(m.timestamp || 0) >= sinceSec);
      const last = mine[mine.length - 1];
      const id = qrMessageId(last);
      if (id) return id;
    } catch (e) {
      console.warn('[wa-qr sendMedia] no se pudo verificar el envío en el chat: %s', e.message);
    }
  }
  return '';
}

/**
 * Escucha el evento `message_create` de la sesión mientras dura un envío y se
 * queda con el mensaje NUESTRO con adjunto que WhatsApp acaba de crear en ese
 * chat. Devuelve `{ id(), stop() }`.
 *
 * Es la confirmación MÁS fiable de que el adjunto salió: no busca nada por id ni
 * abre el chat (en los chats de número oculto, @lid, esas búsquedas fallan), sino
 * que escucha lo que la propia sesión anuncia. Sin esto, un envío que sí llegaba
 * al contacto se marcaba "no se envió" y al reintentarlo se mandaba dos veces.
 */
function watchOutgoingMedia(entry, chatId) {
  let found = '';
  const target = String(chatId || '');
  const onCreate = (m) => {
    try {
      if (found || !m?.fromMe || !m.hasMedia) return;
      const to = typeof m.to === 'string' ? m.to : widToString(m.to);
      if (to && target && to !== target) return;
      found = qrMessageId(m);
    } catch {
      /* noop */
    }
  };
  entry.client.on('message_create', onCreate);
  return {
    id: () => found,
    stop: () => {
      try { entry.client.off('message_create', onCreate); } catch { /* noop */ }
    },
  };
}

/**
 * Envía media (URL) con texto de pie por la sesión QR. Lo usan la cabecera de
 * imagen de las plantillas (por QR no existen plantillas de Meta: se manda la
 * imagen real con el cuerpo como caption), los adjuntos del compositor y las
 * notas de voz.
 *
 * `type` decide la forma del mensaje: con 'audio' se envía como NOTA DE VOZ
 * (sendAudioAsVoice) en vez de como archivo adjunto, igual que en la app.
 */
async function sendMedia(account, to, url, caption, type = 'image', quotedMessageId, quoteBody) {
  const key = String(account._id);
  const entry = await acquireSendableEntry(key);
  if (!entry) {
    return { ok: false, errorCode: 'qr_not_connected', error: 'El número QR no está conectado' };
  }
  const isVoice = type === 'audio';
  const isDoc = type === 'document';
  const isVideo = type === 'video';
  const what = isVoice ? 'la nota de voz' : isDoc ? 'el archivo' : isVideo ? 'el video' : 'la imagen';
  try {
    const r = await resolveChatId(entry, to);
    if (!r.ok) return r;
    // Bytes del adjunto: la URL autoalojada (/api/public/media/:id) se lee
    // directo de Mongo; una URL externa se descarga.
    let mime = isVoice ? 'audio/ogg' : 'image/jpeg';
    let b64 = '';
    let fileName = ''; // nombre real del documento (lo ve el contacto)
    const m = String(url || '').match(/\/api\/public\/media\/([a-f0-9]{24})/i);
    if (m) {
      // Puerta única: resuelve el adjunto esté en disco (lo normal) o todavía en
      // base64 dentro de Mongo (anterior a la migración). Ver utils/mediaStore.
      const att = await require('./mediaStore').loadAttachment(m[1]);
      if (!att) return { ok: false, errorCode: 'qr_media_unreadable', error: `No se pudo leer ${what} guardado` };
      mime = att.mimeType || mime;
      b64 = att.buffer.toString('base64');
      fileName = att.name || '';
    } else {
      const resp = await withTimeout(fetch(url), 20000, `Tiempo agotado descargando ${what}`);
      if (!resp.ok) return { ok: false, error: `No se pudo descargar ${what} (HTTP ${resp.status})` };
      mime = resp.headers.get('content-type') || mime;
      b64 = Buffer.from(await resp.arrayBuffer()).toString('base64');
    }
    if (!b64) {
      return { ok: false, errorCode: 'qr_media_unreadable', error: `No se pudo leer ${what} para enviarlo.` };
    }
    const { MessageMedia } = require('whatsapp-web.js');
    // El 3er argumento es el NOMBRE del archivo: un documento debe llevar el suyo
    // real (contrato.pdf) para que el contacto lo vea y lo pueda abrir.
    const mediaName = isVoice ? 'nota-de-voz.ogg' : isDoc ? (fileName || 'archivo') : isVideo ? (fileName || 'video.mp4') : 'imagen';
    const media = new MessageMedia(mime, b64, mediaName);
    // Nota de voz: sin pie. Documento: se fuerza a enviarse como ADJUNTO (no como
    // una vista previa) con `sendMediaAsDocument`, así llega con su nombre e icono.
    const opts = isVoice
      ? { sendAudioAsVoice: true }
      : isDoc
        ? { sendMediaAsDocument: true, caption: String(caption || '').slice(0, 1024) }
        : { caption: String(caption || '').slice(0, 1024) };
    const bytes = Math.floor(b64.length * 0.75);
    console.log('[wa-qr sendMedia] enviando kind=%s mime=%s bytes≈%d chat=%s', type, mime, bytes, r.chatId);
    // El tiempo de espera CRECE con el tamaño: un video de 10 MB tiene que
    // cifrarse y subirse desde el navegador headless, y con el minuto fijo de
    // antes los videos se marcaban fallidos a mitad de la subida.
    const sendTimeout = Math.min(300000, 60000 + Math.ceil(bytes / (1024 * 1024)) * 20000);
    // La cita se resuelve igual que en texto: getMessageById + reply() para que
    // el contacto vea el adjunto como respuesta al mensaje citado.
    const startedAt = Date.now();
    // Se empieza a escuchar ANTES de enviar: si la librería no devuelve el id, el
    // evento de la propia sesión confirma que el adjunto salió (ver watchOutgoingMedia).
    const watcher = watchOutgoingMedia(entry, r.chatId);
    let sent;
    let quote;
    try {
      ({ sent, quote } = await withTimeout(
        sendResolvingQuote(entry, r.chatId, media, quotedMessageId, opts, quoteBody),
        sendTimeout,
        `Tiempo agotado enviando ${what} (${Math.round(bytes / 1048576)} MB): la sesión puede estar inestable o la conexión es lenta`
      ));
    } catch (e) {
      // Aunque el envío "falle" por tiempo, WhatsApp puede haberlo mandado igual:
      // si la sesión anunció el mensaje, se da por enviado (y no se duplica).
      await sleep(1500);
      const late = watcher.id();
      watcher.stop();
      if (!late) throw e;
      console.warn('[wa-qr sendMedia] %s — pero la sesión SÍ creó el mensaje (wamid=%s)', e.message, late);
      return {
        ok: true,
        data: { messages: [{ id: late }] },
        ...(quotedMessageId || quoteBody ? { quote: { applied: false, how: '', reason: 'timeout', wamid: '' } } : {}),
      };
    }
    let wamid = qrMessageId(sent);
    if (!wamid) {
      // whatsapp-web.js devuelve `undefined` cuando, al terminar, el mensaje aún
      // no está en su colección interna — aunque YA lo haya puesto a enviar. Antes
      // se daba por fallido sin más: el video le llegaba al contacto y el chat lo
      // marcaba en rojo (y "Reintentar" lo enviaba DOS veces).
      console.warn('[wa-qr sendMedia] la sesión no devolvió wamid; verificando… chat=%s', r.chatId);
      await sleep(1500);
      wamid = watcher.id() || (await findRecentlySentMedia(entry, r.chatId, startedAt));
      if (!wamid) {
        watcher.stop();
        return {
          ok: false,
          errorCode: 'qr_media_unconfirmed',
          error: `WhatsApp no confirmó el envío de ${what} (la sesión puede estar inestable). Reintenta.`,
        };
      }
      console.log('[wa-qr sendMedia] confirmado por verificación wamid=%s', wamid);
    }
    watcher.stop();
    console.log('[wa-qr sendMedia] enviado OK wamid=%s en %ds', wamid, Math.round((Date.now() - startedAt) / 1000));
    return {
      ok: true,
      data: { messages: [{ id: wamid }] },
      ...(quotedMessageId || quoteBody ? { quote } : {}),
    };
  } catch (e) {
    return { ok: false, errorCode: 'qr_send_error', error: qrSendErrorText(e) };
  }
}

// La media entrante por QR llega inline (no se descarga por id): no-op.
async function downloadMedia() {
  return { ok: false };
}

/**
 * Vuelve a bajar el archivo de un mensaje que ya está en el chat, a partir de su
 * wamid. Lo usa el botón "Reintentar descarga" de la burbuja: el archivo sigue en
 * WhatsApp, así que un fallo puntual de la sesión no tiene por qué perderlo.
 */
async function redownloadMedia(account, serializedId) {
  if (!serializedId) return { ok: false, error: 'El mensaje no tiene identificador de WhatsApp.' };
  const entry = await acquireSendableEntry(String(account._id));
  if (!entry) return { ok: false, error: 'El número QR no está conectado.' };

  // Hash del mensaje: los mensajes guardados ANTES de reconstruir la clave (chats
  // @lid) tienen solo el hash, y `getMessageById` los rechaza con "Invalid
  // serialized message id specified". Con el hash se localizan igual en el store.
  const parts = String(serializedId).split('_');
  const hash = parts.length >= 3 ? parts[2] : String(serializedId);

  let msg = null;
  try {
    msg = await withTimeout(entry.client.getMessageById(serializedId), 15000, 'timeout buscando el mensaje');
  } catch {
    msg = null; // id no serializable: se va por la vía del navegador (abajo)
  }
  if (msg) {
    const media = await extractQrMedia(msg, entry.client, { retryDelays: [0, 1500, 3000] });
    if (media && media.dataUrl) {
      return { ok: true, dataUrl: media.dataUrl, size: media.size || 0, mediaName: media.filename || '' };
    }
  }

  const pageId = parts.length >= 3 ? serializedId : '';
  const alt = await downloadQrMediaInPage(entry.client, pageId, hash);
  if (alt.ok && alt.data) {
    const bytes = Math.floor(alt.data.length * 0.75);
    if (bytes > MAX_QR_MEDIA_BYTES) return { ok: false, error: 'El archivo es demasiado grande para guardarlo.' };
    return {
      ok: true,
      dataUrl: `data:${cleanMime(alt.mimetype, 'application/octet-stream')};base64,${alt.data}`,
      size: bytes,
      mediaName: alt.filename || '',
    };
  }

  // Vía definitiva: bajar el archivo cifrado del CDN y descifrarlo aquí.
  const keys = await fetchQrMediaKeys(entry.client, pageId, hash);
  if (keys && keys.directPath && keys.mediaKey) {
    const direct = await downloadAndDecryptWaMedia(keys);
    if (direct.ok) {
      if (direct.buffer.length > MAX_QR_MEDIA_BYTES) {
        return { ok: false, error: 'El archivo es demasiado grande para guardarlo.' };
      }
      return {
        ok: true,
        dataUrl: `data:${cleanMime(keys.mimetype, 'application/octet-stream')};base64,${direct.buffer.toString('base64')}`,
        size: direct.buffer.length,
        mediaName: keys.filename || '',
      };
    }
    return { ok: false, error: `${alt.error || ''} | CDN: ${direct.error}`.replace(/^ \| /, '') };
  }
  return { ok: false, error: alt.error || 'WhatsApp no entregó el archivo.' };
}

/** Estado vivo de un número (para la UI / endpoints). */
function getLiveStatus(accountId) {
  return clients.get(String(accountId))?.status || null;
}

/**
 * Foto del estado vivo para el sondeo HTTP del modal de conexión: estado, el
 * último QR generado y el % de sincronización. Devuelve null si no hay cliente.
 */
function getLiveSnapshot(accountId) {
  const entry = clients.get(String(accountId));
  if (!entry) return null;
  return { status: entry.status, qr: entry.lastQr || '', percent: entry.percent ?? null };
}

/**
 * Reconcilia el estado guardado de una cuenta QR con la realidad, mutando
 * `doc.status`. Se usa al listar los números para que la página nunca muestre
 * "conectado" con una sesión muerta:
 * - Sin cliente en memoria → cualquier estado activo en BD es viejo → 'disconnected'.
 * - Cliente 'connected' → verificación rápida con getState (2.5s de presupuesto;
 *   si no responde a tiempo se deja como está y el chequeo periódico decide).
 * - Cliente pegado en 'syncing'/'connecting' pero VIVO (getState=CONNECTED) → se
 *   CURA a 'connected'. Así la lista y los envíos coinciden con la realidad.
 */
async function reconcileAccount(doc) {
  const key = String(doc._id);
  const entry = clients.get(key);
  if (!entry) {
    if (['connected', 'connecting', 'qr_pending', 'syncing'].includes(doc.status)) {
      doc.status = 'disconnected';
      await WhatsappAccount.updateOne({ _id: doc._id }, { status: 'disconnected' }).catch(() => {});
    }
    // Número vinculado y habilitado pero sin sesión viva: se pone en marcha la
    // reconexión automática (abrir la pantalla nunca puede dejarlo caído).
    if (doc.enabled && doc.connectedPhone && !doc.lastDisconnectNeedsQr) {
      scheduleReconnect(key, 'sin sesión viva (al listar los números)');
    }
    return doc;
  }
  if (entry.status === 'connected') {
    doc.status = await verifyConnected(key, entry, 2500).catch(() => entry.status);
  } else if (entry.client && ['syncing', 'connecting'].includes(entry.status)) {
    const probe = await probeState(entry, 2500).catch(() => ({ verdict: 'unknown' }));
    if (probe.verdict === 'connected') healToConnected(key, entry);
    doc.status = entry.status;
  } else {
    doc.status = entry.status;
  }
  return doc;
}

/** Reconecta al arrancar el server los números QR habilitados con sesión guardada. */
async function initEnabledOnBoot() {
  try {
    ensureHealthTimer(); // el supervisor debe correr aunque hoy no haya sesiones
    const accounts = await WhatsappAccount.find({ connectionType: 'qr', enabled: true });
    for (const acc of accounts) {
      // Solo cuentas que COMPLETARON una vinculación (connectedPhone se guarda en
      // 'ready'). Tener solo sessionId significa que hubo un intento fallido: si
      // se conecta al boot, queda un cliente zombi mostrando QRs que nadie ve.
      if (!acc.sessionId || !acc.connectedPhone) continue;
      // Desvinculado desde el teléfono: sin QR nuevo no hay nada que reconectar
      // (arrancarlo solo dejaría un cliente pidiendo un QR que nadie mira).
      if (acc.lastDisconnectNeedsQr) {
        console.warn('[whatsapp-qr boot] "%s" quedó desvinculado: hay que escanear el QR.', acc.label || acc._id);
        // eslint-disable-next-line no-await-in-loop
        await notifyQrDown(String(acc._id), { needsQr: true, reason: 'el número sigue desvinculado tras reiniciar' });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      await connect(acc._id).catch(() => {});
    }
  } catch (e) {
    console.error('[whatsapp-qr boot]', e.message);
  }
}

/**
 * Apagado ordenado del proceso (pm2 manda SIGINT en cada deploy): cierra TODOS
 * los Chromium con destroy() para que la sesión de WhatsApp se termine de
 * escribir en disco. Matarlos a lo bruto a mitad de escritura era lo que, tras
 * varios deploys seguidos, corrompía la sesión guardada y acababa en
 * auth_failure (tocaba re-escanear el QR). NO toca el estado en BD: al arrancar,
 * initEnabledOnBoot reconecta desde la sesión guardada.
 */
async function shutdownAll() {
  const entries = [...clients.values()];
  clients.clear();
  // Cierre nuestro: ni los vigías del navegador ni los reintentos deben saltar.
  for (const key of Array.from(reconnectTimers.keys())) {
    clearTimeout(reconnectTimers.get(key));
    reconnectTimers.delete(key);
  }
  await Promise.allSettled(
    entries.map((e) => {
      if (e.watchdog) clearTimeout(e.watchdog);
      if (e.syncWatchdog) clearTimeout(e.syncWatchdog);
      e.closing = true;
      return e.client.destroy().catch(() => {});
    })
  );
}

module.exports = {
  connect,
  disconnect,
  sendText,
  sendMedia,
  downloadMedia,
  redownloadMedia,
  getLiveStatus,
  getLiveSnapshot,
  reconcileAccount,
  initEnabledOnBoot,
  shutdownAll,
  // Solo para pruebas: acceso al mapa de sesiones y a la recuperación de estado.
  __test: {
    clients, reconnectTimers, reconnectTries, probeState, verifyConnected, teardown,
    scheduleReconnect, cancelReconnect, superviseSessions, MAX_MISSES,
    acquireSendableEntry, healToConnected, extractQrMedia, describeQrNonMedia,
    findRecentlySentMedia, watchOutgoingMedia, qrMessageId, qrMessageHash, serializeMsgKey,
    downloadAndDecryptWaMedia, phoneFromMsgData,
    probeIngest, verifyIngest, recoverMissedInbound, ingestIncomingQrMessage,
    ingestRepairAt, ingestGaps,
    INGEST_LAG_MS, MAX_INGEST_GAPS, INGEST_REPAIR_COOLDOWN_MS, INGEST_GRACE_MS, CONTENT_TYPES,
  },
};
