/**
 * Gestor de números de WhatsApp conectados por QR (whatsapp-web.js).
 *
 * Cada WhatsappAccount con connectionType='qr' tiene un Client de whatsapp-web.js
 * que mantiene una sesión tipo WhatsApp Web. La sesión se persiste en Mongo con
 * RemoteAuth + wwebjs-mongo, de modo que sobrevive a reinicios/redeploys (clave en
 * el filesystem efímero de Render; útil también en el VPS).
 *
 * Eventos → estado del número + socket.io:
 *   qr            → estado 'qr_pending'  + emite 'whatsapp:qr' (dataURL del QR)
 *   ready         → estado 'connected'   + guarda connectedPhone
 *   auth_failure  → estado 'auth_failure'
 *   disconnected  → estado 'disconnected'
 *   message       → ingesta entrante (mismo pipeline que el webhook Cloud API)
 *   message_ack   → actualiza el estado de entrega del mensaje saliente
 *
 * IMPORTANTE (hosting): whatsapp-web.js levanta un Chromium headless por número
 * (~300–500 MB) y requiere un proceso SIEMPRE activo. En Render gratis (RAM baja,
 * se duerme, FS efímero) será inestable; es plenamente usable en un VPS. Las libs
 * pesadas se cargan de forma diferida para que el server arranque aunque falten.
 */
const mongoose = require('mongoose');
const WhatsappAccount = require('../models/WhatsappAccount');
const { emitToCallCenter, emitToUser } = require('../realtime');

// accountId(string) → { client, status }
const clients = new Map();
let mongoStore = null;

function getStore() {
  if (!mongoStore) {
    const { MongoStore } = require('wwebjs-mongo');
    mongoStore = new MongoStore({ mongoose });
  }
  return mongoStore;
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
    // Ya hay un cliente vivo: reusar y reemitir el estado conocido.
    await emitStatus(key, { status: existing.status || 'connecting' }, userId);
    return { ok: true, status: existing.status || 'connecting' };
  }

  const account = await WhatsappAccount.findById(accountId);
  if (!account || account.connectionType !== 'qr') {
    return { ok: false, error: 'Número QR no encontrado' };
  }

  let Client;
  let RemoteAuth;
  let QRCode;
  try {
    ({ Client, RemoteAuth } = require('whatsapp-web.js'));
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
      authStrategy: new RemoteAuth({
        clientId: sessionId,
        store: getStore(),
        backupSyncIntervalMs: 300000, // 5 min (mínimo permitido por la librería)
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

  clients.set(key, { client, status: 'connecting' });
  await setAccountStatus(accountId, { status: 'connecting' });
  await emitStatus(key, { status: 'connecting' }, userId);

  client.on('qr', async (qr) => {
    clients.set(key, { client, status: 'qr_pending' });
    await setAccountStatus(accountId, { status: 'qr_pending', lastQrAt: new Date() });
    let dataUrl = '';
    try {
      dataUrl = await QRCode.toDataURL(qr);
    } catch {
      /* noop */
    }
    const payload = { status: 'qr_pending', qr: dataUrl };
    emitToCallCenter('whatsapp:qr', { accountId: key, ...payload });
    if (userId) emitToUser(userId, 'whatsapp:qr', { accountId: key, ...payload });
  });

  client.on('ready', async () => {
    clients.set(key, { client, status: 'connected' });
    const connectedPhone = (client.info?.wid?.user || '').toString();
    await setAccountStatus(accountId, {
      status: 'connected',
      connectedPhone,
      lastConnectedAt: new Date(),
    });
    await emitStatus(key, { status: 'connected', connectedPhone }, userId);
  });

  client.on('authenticated', () => {
    const cur = clients.get(key);
    if (cur) clients.set(key, { ...cur, status: 'connecting' });
  });

  client.on('auth_failure', async () => {
    clients.set(key, { client, status: 'auth_failure' });
    await setAccountStatus(accountId, { status: 'auth_failure' });
    await emitStatus(key, { status: 'auth_failure' }, userId);
  });

  client.on('disconnected', async () => {
    clients.delete(key);
    await setAccountStatus(accountId, { status: 'disconnected' });
    await emitStatus(key, { status: 'disconnected' });
    try { await client.destroy(); } catch { /* noop */ }
  });

  // Mensaje entrante → mismo pipeline de ingesta que el webhook Cloud API.
  client.on('message', async (msg) => {
    try {
      if (msg.fromMe || msg.isStatus) return;
      if (typeof msg.from === 'string' && msg.from.endsWith('@g.us')) return; // ignora grupos
      const phone = String(msg.from || '').replace(/@c\.us$/, '').replace(/[^\d]/g, '');
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

      const account2 = await WhatsappAccount.findById(accountId);
      const clinicId = await require('./callCenterClinic').resolveCallCenterClinicId();
      if (!clinicId) return;

      const { ingestExternalMessage } = require('../controllers/chatController');
      await ingestExternalMessage({
        clinicId,
        channel: 'whatsapp',
        account: account2,
        phone,
        externalUserId: phone,
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
    clients.delete(key);
    await setAccountStatus(accountId, { status: 'auth_failure' });
    await emitStatus(key, { status: 'auth_failure', error: short });
  });

  return { ok: true, status: 'connecting' };
}

/** Cierra la sesión de un número (logout) y limpia su estado. */
async function disconnect(accountId) {
  const key = String(accountId);
  const entry = clients.get(key);
  if (entry && entry.client) {
    try { await entry.client.logout(); } catch { /* noop */ }
    try { await entry.client.destroy(); } catch { /* noop */ }
  }
  clients.delete(key);
  await setAccountStatus(accountId, { status: 'disconnected' });
  await emitStatus(key, { status: 'disconnected' });
  return { ok: true };
}

/** Envía texto por la sesión QR. Devuelve un shape compatible con messaging. */
async function sendText(account, to, body) {
  const key = String(account._id);
  const entry = clients.get(key);
  if (!entry || !entry.client || entry.status !== 'connected') {
    return { ok: false, errorCode: 'qr_not_connected', error: 'El número QR no está conectado' };
  }
  const phone = String(to || '').replace(/[^\d]/g, '');
  if (!phone) return { ok: false, error: 'Teléfono inválido' };
  try {
    const sent = await entry.client.sendMessage(`${phone}@c.us`, String(body || '').slice(0, 4096));
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

/** Reconecta al arrancar el server los números QR habilitados con sesión guardada. */
async function initEnabledOnBoot() {
  try {
    const accounts = await WhatsappAccount.find({ connectionType: 'qr', enabled: true });
    for (const acc of accounts) {
      if (!acc.sessionId) continue; // nunca se vinculó → no intentamos
      // eslint-disable-next-line no-await-in-loop
      await connect(acc._id).catch(() => {});
    }
  } catch (e) {
    console.error('[whatsapp-qr boot]', e.message);
  }
}

module.exports = { connect, disconnect, sendText, downloadMedia, getLiveStatus, initEnabledOnBoot };
