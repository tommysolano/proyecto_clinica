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

// accountId(string) → { client, status, watchdog, gotQr, lastQr, percent }
// lastQr guarda el último QR (dataURL) para que la UI pueda recuperarlo por
// sondeo HTTP si el socket se cayó y el evento 'whatsapp:qr' se perdió.
const clients = new Map();

// Cierra y limpia un cliente, persiste el estado final y lo emite a la UI.
async function teardown(key, entry, { status = 'disconnected', error = '' } = {}) {
  if (entry.watchdog) { clearTimeout(entry.watchdog); entry.watchdog = null; }
  // Si ya hay OTRO cliente para este número (el usuario reconectó), solo se
  // destruye este: persistir/emitir aquí pisaría el estado de la conexión nueva.
  const replaced = clients.has(key) && clients.get(key) !== entry;
  if (!replaced) clients.delete(key);
  try { await entry.client.destroy(); } catch { /* noop */ }
  if (replaced) return;
  await setAccountStatus(key, { status });
  await emitStatus(key, { status, ...(error ? { error } : {}) });
}

/**
 * Verifica que una sesión 'connected' siga viva de verdad (getState).
 * - 'CONNECTED' → sigue viva.
 * - timeout → sin veredicto: NO se mata (Chrome puede estar ocupado).
 * - cualquier otro estado o error → sesión muerta (p.ej. desvinculada desde el
 *   teléfono sin que llegara el evento): se cierra y se marca 'disconnected'.
 */
async function verifyConnected(key, entry, timeoutMs = 8000) {
  let state = null;
  try {
    state = await withTimeout(entry.client.getState(), timeoutMs, '__timeout__');
  } catch (e) {
    if (String(e.message) === '__timeout__') return 'connected';
    state = null;
  }
  if (state === 'CONNECTED') return 'connected';
  if (clients.get(key) !== entry) return clients.get(key)?.status || 'disconnected';
  await teardown(key, entry, {
    error: 'La sesión se cerró (desvinculada desde el teléfono o expirada).',
  });
  return 'disconnected';
}

// Chequeo de salud periódico de todas las sesiones conectadas: es la red de
// seguridad para el caso "desvinculé desde el celular y no llegó ningún evento".
let healthTimer = null;
function ensureHealthTimer() {
  if (healthTimer) return;
  healthTimer = setInterval(async () => {
    for (const [key, entry] of Array.from(clients.entries())) {
      if (entry.status !== 'connected') continue;
      // eslint-disable-next-line no-await-in-loop
      await verifyConnected(key, entry, 10000).catch(() => {});
    }
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

function mapQrMediaType(t) {
  if (t === 'ptt') return 'audio';
  if (['image', 'audio', 'video', 'document', 'sticker'].includes(t)) return t;
  return 'document';
}

/**
 * Inicia (o reutiliza) el cliente de un número QR. `userId` se usa para mandarle
 * el QR directamente a quien pulsó "Conectar".
 */
async function connect(accountId, { userId } = {}) {
  const key = String(accountId);
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
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      },
    });
  } catch (e) {
    await setAccountStatus(accountId, { status: 'auth_failure' });
    return { ok: false, error: `No se pudo crear el cliente: ${e.message}` };
  }

  const entry = { client, status: 'connecting', watchdog: null, gotQr: false, lastQr: '', percent: null };
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
    try { await client.destroy(); } catch { /* noop */ }
    const fresh = await WhatsappAccount.findById(accountId).catch(() => null);
    if (fresh && !fresh.connectedPhone) await wipeLocalSession(sessionId);
    await setAccountStatus(accountId, { status: 'auth_failure' });
    await emitStatus(key, {
      status: 'auth_failure',
      error: 'No se pudo generar el QR en 90 segundos. Vuelve a pulsar "Conectar".',
    }, userId);
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
  });

  client.on('ready', async () => {
    entry.status = 'connected';
    entry.lastQr = '';
    entry.percent = null;
    if (entry.watchdog) { clearTimeout(entry.watchdog); entry.watchdog = null; }
    const connectedPhone = (client.info?.wid?.user || '').toString();
    await setAccountStatus(accountId, {
      status: 'connected',
      connectedPhone,
      lastConnectedAt: new Date(),
    });
    await emitStatus(key, { status: 'connected', connectedPhone }, userId);
  });

  // QR escaneado: WhatsApp sincroniza la sesión hasta 'ready'. Antes esta fase
  // era muda y la UI seguía diciendo "Escanea el QR" — ahora se avisa.
  client.on('authenticated', async () => {
    entry.status = 'syncing';
    entry.lastQr = '';
    await setAccountStatus(accountId, { status: 'syncing' });
    await emitStatus(key, { status: 'syncing' }, userId);
  });

  // Progreso de la sincronización (0-100). No se persiste; solo informa a la UI.
  client.on('loading_screen', async (percent) => {
    entry.status = 'syncing';
    entry.percent = Number(percent) || 0;
    await emitStatus(key, { status: 'syncing', percent: entry.percent }, userId);
  });

  client.on('auth_failure', async () => {
    entry.status = 'auth_failure';
    if (entry.watchdog) { clearTimeout(entry.watchdog); entry.watchdog = null; }
    await setAccountStatus(accountId, { status: 'auth_failure' });
    await emitStatus(key, { status: 'auth_failure' }, userId);
  });

  client.on('disconnected', async (reason) => {
    await teardown(key, entry, {
      error: String(reason || '').toUpperCase() === 'LOGOUT'
        ? 'La sesión se cerró desde el teléfono (dispositivo desvinculado).'
        : '',
    });
  });

  // Desvinculación detectada por cambio de estado (a veces 'disconnected' no llega).
  client.on('change_state', async (state) => {
    if (state === 'UNPAIRED' || state === 'UNPAIRED_IDLE') {
      if (clients.get(key) !== entry) return;
      await teardown(key, entry, { error: 'El teléfono desvinculó este dispositivo.' });
    }
  });

  // Mensaje entrante → mismo pipeline de ingesta que el webhook Cloud API.
  // Tipos con contenido real de un humano; el resto (e2e_notification al
  // renegociar cifrado, notification_template, ciphertext, llamadas, etc.)
  // NO debe crear conversaciones: al vincular una sesión nueva, WhatsApp
  // renegocia claves con muchos contactos y llegaba un "mensaje" vacío por
  // cada uno (chats fantasma "Sin mensajes" con el LID como nombre).
  const CONTENT_TYPES = ['chat', 'image', 'video', 'audio', 'ptt', 'document', 'sticker', 'location', 'vcard', 'multi_vcard'];
  client.on('message', async (msg) => {
    try {
      if (msg.fromMe || msg.isStatus) return;
      const from = typeof msg.from === 'string' ? msg.from : '';
      // Solo chats directos: personas (@c.us) o contactos con número oculto (@lid).
      // Fuera grupos (@g.us), canales (@newsletter) y listas (@broadcast).
      if (!/@(c\.us|lid)$/.test(from)) return;
      if (!CONTENT_TYPES.includes(msg.type)) return;
      const phone = from.replace(/@.*$/, '').replace(/[^\d]/g, '');
      if (!phone) return;

      let media = null;
      if (msg.hasMedia) {
        try {
          const m = await msg.downloadMedia();
          if (m && m.data) {
            media = {
              type: mapQrMediaType(msg.type),
              dataUrl: `data:${m.mimetype};base64,${m.data}`,
              caption: msg.body || '',
            };
          }
        } catch { /* media no disponible */ }
      }
      if (!String(msg.body || '').trim() && !media) return; // nada que mostrar

      const account2 = await WhatsappAccount.findById(accountId);
      const clinicId = await require('./callCenterClinic').resolveCallCenterClinicId();
      if (!clinicId) return;

      const { ingestExternalMessage } = require('../controllers/chatController');
      await ingestExternalMessage({
        clinicId,
        channel: 'whatsapp',
        account: account2,
        phone,
        // JID completo (…@c.us / …@lid): imprescindible para RESPONDER a
        // contactos con número oculto (a un LID no se le puede escribir @c.us).
        externalUserId: from,
        body: msg.body || '',
        media,
        contactName: msg._data?.notifyName || '',
        externalId: msg.id?._serialized || '',
      });
    } catch (e) {
      console.error('[whatsapp-qr message]', e.message);
    }
  });

  // Confirmaciones de entrega de los mensajes salientes.
  client.on('message_ack', async (msg, ack) => {
    try {
      const status = ACK_STATUS[String(ack)];
      const externalId = msg.id?._serialized;
      if (!status || !externalId) return;
      const clinicId = await require('./callCenterClinic').resolveCallCenterClinicId();
      if (!clinicId) return;
      const messaging = require('./messaging');
      await messaging.updateMessageStatus({ clinicId, externalId, status });
    } catch { /* noop */ }
  });

  client.initialize().catch(async (e) => {
    const noChrome = /Could not find Chrome|Failed to launch/i.test(e.message || '');
    const short = noChrome
      ? 'Chromium no disponible en este entorno: los números QR no se conectarán aquí. Usa Cloud API, o un servidor con Chrome (VPS). Puedes fijar PUPPETEER_EXECUTABLE_PATH.'
      : (e.message || '').split('\n')[0];
    console.error('[whatsapp-qr initialize]', short);
    if (entry.watchdog) { clearTimeout(entry.watchdog); entry.watchdog = null; }
    clients.delete(key);
    try { await client.destroy(); } catch { /* noop */ }
    const fresh = await WhatsappAccount.findById(accountId).catch(() => null);
    if (fresh && !fresh.connectedPhone) await wipeLocalSession(sessionId);
    await setAccountStatus(accountId, { status: 'auth_failure' });
    await emitStatus(key, { status: 'auth_failure', error: short }, userId);
  });

  return { ok: true, status: 'connecting' };
}

/** Cierra la sesión de un número (logout) y limpia su estado. */
async function disconnect(accountId) {
  const key = String(accountId);
  const entry = clients.get(key);
  if (entry && entry.client) {
    if (entry.watchdog) { clearTimeout(entry.watchdog); entry.watchdog = null; }
    try { await entry.client.logout(); } catch { /* noop */ }
    try { await entry.client.destroy(); } catch { /* noop */ }
  }
  clients.delete(key);
  await setAccountStatus(accountId, { status: 'disconnected' });
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

/** Envía texto por la sesión QR. Devuelve un shape compatible con messaging. */
async function sendText(account, to, body) {
  const key = String(account._id);
  const entry = clients.get(key);
  if (!entry || !entry.client || entry.status !== 'connected') {
    return { ok: false, errorCode: 'qr_not_connected', error: 'El número QR no está conectado' };
  }
  try {
    // Destino: JID completo si viene (…@c.us / …@lid, contactos con número
    // oculto); si solo hay dígitos, resolver el JID real con getNumberId —
    // valida que el número exista en WhatsApp y devuelve @c.us o @lid según
    // corresponda (un LID crudo enviado como @c.us se colgaba sin error).
    let chatId = String(to || '').trim();
    if (!chatId) return { ok: false, error: 'Destino vacío' };
    if (!chatId.includes('@')) {
      const digits = chatId.replace(/[^\d]/g, '');
      if (!digits) return { ok: false, error: 'Teléfono inválido' };
      const numberId = await withTimeout(
        entry.client.getNumberId(digits),
        15000,
        'Tiempo agotado verificando el número en WhatsApp'
      ).catch((e) => { throw new Error(e.message); });
      if (!numberId) {
        return { ok: false, errorCode: 'qr_invalid_number', error: `El número ${digits} no está en WhatsApp` };
      }
      chatId = numberId._serialized;
    }
    const sent = await withTimeout(
      entry.client.sendMessage(chatId, String(body || '').slice(0, 4096)),
      30000,
      'Tiempo agotado enviando el mensaje (la sesión puede estar inestable)'
    );
    return { ok: true, data: { messages: [{ id: sent?.id?._serialized || '' }] } };
  } catch (e) {
    return { ok: false, errorCode: 'qr_send_error', error: e.message };
  }
}

// La media entrante por QR llega inline (no se descarga por id): no-op.
async function downloadMedia() {
  return { ok: false };
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
 */
async function reconcileAccount(doc) {
  const key = String(doc._id);
  const entry = clients.get(key);
  if (!entry) {
    if (['connected', 'connecting', 'qr_pending', 'syncing'].includes(doc.status)) {
      doc.status = 'disconnected';
      await WhatsappAccount.updateOne({ _id: doc._id }, { status: 'disconnected' }).catch(() => {});
    }
    return doc;
  }
  doc.status = entry.status === 'connected'
    ? await verifyConnected(key, entry, 2500).catch(() => entry.status)
    : entry.status;
  return doc;
}

/** Reconecta al arrancar el server los números QR habilitados con sesión guardada. */
async function initEnabledOnBoot() {
  try {
    const accounts = await WhatsappAccount.find({ connectionType: 'qr', enabled: true });
    for (const acc of accounts) {
      // Solo cuentas que COMPLETARON una vinculación (connectedPhone se guarda en
      // 'ready'). Tener solo sessionId significa que hubo un intento fallido: si
      // se conecta al boot, queda un cliente zombi mostrando QRs que nadie ve.
      if (!acc.sessionId || !acc.connectedPhone) continue;
      // eslint-disable-next-line no-await-in-loop
      await connect(acc._id).catch(() => {});
    }
  } catch (e) {
    console.error('[whatsapp-qr boot]', e.message);
  }
}

module.exports = {
  connect,
  disconnect,
  sendText,
  downloadMedia,
  getLiveStatus,
  getLiveSnapshot,
  reconcileAccount,
  initEnabledOnBoot,
};
