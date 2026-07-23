/**
 * Recuperación del envío por QR cuando el estado cacheado se quedó atrás.
 *
 * Caso real: tras reiniciar el VPS, whatsapp-web.js re-sincroniza y el estado del
 * cliente queda pegado en 'syncing' aunque la sesión SÍ funciona (recibe mensajes,
 * el teléfono envía). Antes, todo envío del sistema fallaba con "QR no conectado"
 * y el chat mostraba burbujas rojas con la sesión perfectamente viva.
 *
 * Aquí se inyecta un cliente FALSO en el mapa de sesiones y se comprueba que el
 * envío consulta el estado REAL (getState) y, si está CONNECTED, cura el estado y
 * procede — y que si de verdad está muerto, sigue fallando.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');
const qr = require('../utils/whatsappQrManager');
const WhatsappAccount = require('../models/WhatsappAccount');

const { clients, acquireSendableEntry } = qr.__test;

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => {
  await H.resetDb();
  clients.clear();
});

function fakeEntry(status, getStateResult) {
  return {
    status,
    percent: 50,
    watchdog: null,
    syncWatchdog: null,
    client: {
      info: { wid: { user: '593999999999' } },
      getState: async () => {
        if (getStateResult instanceof Error) throw getStateResult;
        return getStateResult;
      },
    },
  };
}

test('sesión pegada en "syncing" pero viva (getState=CONNECTED) → se cura y envía', async () => {
  const acc = await WhatsappAccount.create({ label: 'QR', connectionType: 'qr', enabled: true, status: 'syncing', sessionId: 's1', connectedPhone: '593999999999' });
  const key = String(acc._id);
  clients.set(key, fakeEntry('syncing', 'CONNECTED'));

  const entry = await acquireSendableEntry(key);
  assert.ok(entry, 'debe devolver la entrada: la sesión está viva');
  assert.equal(entry.status, 'connected', 'el estado cacheado se curó a connected');

  // El estado curado también se persiste en la cuenta (fire-and-forget: no bloquea
  // el envío, así que damos un pequeño margen a la escritura antes de leer).
  let fresh = null;
  for (let i = 0; i < 20 && (fresh?.status !== 'connected'); i++) {
    await new Promise((r) => setTimeout(r, 50));
    fresh = await WhatsappAccount.findById(acc._id).lean();
  }
  assert.equal(fresh.status, 'connected');
});

test('sesión realmente caída (getState≠CONNECTED y estado no recuperable) → no envía', async () => {
  const acc = await WhatsappAccount.create({ label: 'QR', connectionType: 'qr', enabled: true, status: 'disconnected', sessionId: 's2' });
  const key = String(acc._id);
  // Estado 'disconnected' + getState devuelve algo que no es CONNECTED.
  clients.set(key, fakeEntry('disconnected', 'UNPAIRED'));

  const entry = await acquireSendableEntry(key);
  assert.equal(entry, null, 'sesión muerta: no hay entrada para enviar');
});

test('sin cliente en el mapa → no envía', async () => {
  const acc = await WhatsappAccount.create({ label: 'QR', connectionType: 'qr', enabled: true, status: 'disconnected' });
  const entry = await acquireSendableEntry(String(acc._id));
  assert.equal(entry, null);
});

test('estado ya "connected" → devuelve sin consultar getState', async () => {
  const acc = await WhatsappAccount.create({ label: 'QR', connectionType: 'qr', enabled: true, status: 'connected', sessionId: 's3', connectedPhone: '593999999999' });
  const key = String(acc._id);
  let getStateCalled = false;
  clients.set(key, {
    status: 'connected',
    client: { info: { wid: { user: '593999999999' } }, getState: async () => { getStateCalled = true; return 'CONNECTED'; } },
  });
  const entry = await acquireSendableEntry(key);
  assert.ok(entry);
  assert.equal(getStateCalled, false, 'si ya está connected no hace falta preguntar');
});
