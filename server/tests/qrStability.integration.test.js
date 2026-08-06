/**
 * ESTABILIDAD de las sesiones QR: cuándo se puede dar por muerta una sesión y
 * qué pasa después.
 *
 * CASO REAL (jul-2026): el número conectado por QR se caía varias veces al día y
 * había que entrar a pulsar "Conectar" a mano. La causa no era WhatsApp: era el
 * propio chequeo de salud. Bastaba UN `getState()` que no dijera 'CONNECTED'
 * para destruir la sesión — y `getState()` devuelve `null` durante toda la
 * recarga que WhatsApp Web se hace a sí misma (por eso existe el parche de
 * re-inyección), además de pasar por OPENING/TIMEOUT en cada bache de red. Como
 * además NADA volvía a levantar la sesión, cada falso positivo dejaba el canal
 * de la clínica muerto hasta que una persona se daba cuenta.
 *
 * Lo que se fija aquí:
 *   1. Los estados que la propia librería considera vivos (OPENING/PAIRING/
 *      TIMEOUT) NUNCA cierran la sesión.
 *   2. Un vistazo sin respuesta (null o excepción) se TOLERA; solo se cierra
 *      tras MAX_MISSES seguidos.
 *   3. Al cerrarse por algo pasajero se PROGRAMA la reconexión automática.
 *   4. Solo la desvinculación desde el teléfono exige QR nuevo (y entonces no se
 *      reintenta, porque sin QR es imposible).
 *   5. El supervisor levanta cualquier cuenta vinculada que se quedó sin sesión.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');
const qr = require('../utils/whatsappQrManager');
const WhatsappAccount = require('../models/WhatsappAccount');
const registry = require('../utils/instanceRegistry');

const {
  clients, reconnectTimers, cancelReconnect, verifyConnected, superviseSessions, MAX_MISSES,
} = qr.__test;

// El supervisor y los reintentos solo corren en el proceso LÍDER: en las pruebas
// no hay elección de líder, así que se finge que lo somos.
const realIsLeader = registry.isLeader;

test.before(async () => {
  await H.startDb();
  registry.isLeader = () => true;
});
test.after(async () => {
  registry.isLeader = realIsLeader;
  await H.stopDb();
});
test.beforeEach(async () => {
  await H.resetDb();
  for (const key of Array.from(reconnectTimers.keys())) cancelReconnect(key);
  clients.clear();
});

/** Sesión falsa cuyo `getState` va devolviendo los valores de la lista. */
function fakeEntry(states) {
  const queue = Array.isArray(states) ? [...states] : [states];
  const entry = {
    status: 'connected',
    misses: 0,
    watchdog: null,
    syncWatchdog: null,
    destroyed: false,
    client: {
      info: { wid: { user: '593999999999' } },
      getState: async () => {
        const v = queue.length > 1 ? queue.shift() : queue[0];
        if (v instanceof Error) throw v;
        return v;
      },
      destroy: async () => { entry.destroyed = true; },
    },
  };
  return entry;
}

async function newAccount(patch = {}) {
  return WhatsappAccount.create({
    label: 'Recepción',
    connectionType: 'qr',
    enabled: true,
    status: 'connected',
    sessionId: 's1',
    connectedPhone: '593999999999',
    ...patch,
  });
}

test('OPENING/TIMEOUT (la sesión está volviendo sola) NO cierra nada', async () => {
  const acc = await newAccount();
  const key = String(acc._id);
  const entry = fakeEntry(['OPENING', 'TIMEOUT', 'PAIRING']);
  clients.set(key, entry);

  for (let i = 0; i < 3; i++) {
    // eslint-disable-next-line no-await-in-loop
    const status = await verifyConnected(key, entry, 500);
    assert.equal(status, 'connected', 'un estado transitorio no cambia el estado');
  }
  assert.ok(clients.has(key), 'la sesión sigue viva');
  assert.equal(entry.destroyed, false, 'no se destruyó el navegador');
});

test('getState que NUNCA contesta (Chrome atascado) no deja la sesión "conectada" para siempre', async () => {
  // Antes, un getState que agotaba el tiempo se contaba como prueba de vida y
  // BORRABA el contador de vistazos fallidos: una sesión con el navegador
  // atascado no acumulaba nunca los MAX_MISSES y se quedaba 'connected' de por
  // vida, sin recibir nada y sin que nada la levantara.
  const acc = await newAccount();
  const key = String(acc._id);
  const entry = fakeEntry('CONNECTED');
  entry.client.getState = () => new Promise(() => {}); // no contesta jamás
  clients.set(key, entry);

  for (let i = 1; i < MAX_MISSES; i++) {
    // eslint-disable-next-line no-await-in-loop
    await verifyConnected(key, entry, 30);
    assert.ok(clients.has(key), `vistazo ${i}: el silencio todavía se tolera`);
  }
  const status = await verifyConnected(key, entry, 30);
  assert.equal(status, 'disconnected', 'el silencio persistente sí cierra la sesión');
  assert.ok(reconnectTimers.has(key), 'y se reconecta sola');
});

test('getState=null (WhatsApp Web recargándose) se tolera hasta MAX_MISSES', async () => {
  const acc = await newAccount();
  const key = String(acc._id);
  const entry = fakeEntry(null);
  clients.set(key, entry);

  for (let i = 1; i < MAX_MISSES; i++) {
    // eslint-disable-next-line no-await-in-loop
    await verifyConnected(key, entry, 500);
    assert.ok(clients.has(key), `vistazo ${i}: todavía no se toca la sesión`);
  }
  // El que colma el vaso sí la cierra… pero deja programada la reconexión.
  const status = await verifyConnected(key, entry, 500);
  assert.equal(status, 'disconnected');
  assert.equal(clients.has(key), false, 'la sesión se cerró');
  assert.ok(reconnectTimers.has(key), 'se programó la reconexión automática');

  const fresh = await WhatsappAccount.findById(acc._id).lean();
  assert.equal(fresh.status, 'disconnected');
  assert.equal(fresh.lastDisconnectNeedsQr, false, 'esto NO exige escanear un QR');
  assert.ok(fresh.lastDisconnectAt, 'queda registrado cuándo se cayó');
  assert.match(fresh.lastDisconnectReason, /getState/, 'y por qué');
});

test('un error de puppeteer cuenta como "sin veredicto", no como muerte', async () => {
  const acc = await newAccount();
  const key = String(acc._id);
  const entry = fakeEntry(new Error('Execution context was destroyed, most likely because of a navigation.'));
  clients.set(key, entry);

  await verifyConnected(key, entry, 500);
  assert.ok(clients.has(key), 'una navegación de la página no mata la sesión');
  assert.equal(entry.misses, 1);
});

test('la sesión se recupera: un CONNECTED borra los vistazos fallidos', async () => {
  const acc = await newAccount();
  const key = String(acc._id);
  const entry = fakeEntry([null, null, 'CONNECTED']);
  clients.set(key, entry);

  await verifyConnected(key, entry, 500);
  await verifyConnected(key, entry, 500);
  assert.equal(entry.misses, 2);
  const status = await verifyConnected(key, entry, 500);
  assert.equal(status, 'connected');
  assert.equal(entry.misses, 0, 'la cuenta vuelve a cero: no se acumulan caídas viejas');
});

test('UNPAIRED (desvinculado desde el teléfono) → exige QR y NO se reintenta', async () => {
  const acc = await newAccount();
  const key = String(acc._id);
  const entry = fakeEntry('UNPAIRED');
  clients.set(key, entry);

  const status = await verifyConnected(key, entry, 500);
  assert.equal(status, 'disconnected');
  assert.equal(reconnectTimers.has(key), false, 'reconectar sin QR no sirve de nada');

  const fresh = await WhatsappAccount.findById(acc._id).lean();
  assert.equal(fresh.lastDisconnectNeedsQr, true);
});

test('CONFLICT (sesión expulsada) → se cierra pero SÍ se reintenta solo', async () => {
  const acc = await newAccount();
  const key = String(acc._id);
  const entry = fakeEntry('CONFLICT');
  clients.set(key, entry);

  await verifyConnected(key, entry, 500);
  assert.ok(reconnectTimers.has(key), 'la sesión guardada sigue sirviendo: se reintenta');
  const fresh = await WhatsappAccount.findById(acc._id).lean();
  assert.equal(fresh.lastDisconnectNeedsQr, false);
});

test('navegador muerto (sin memoria en el VPS) → se detecta y se reintenta', async () => {
  const acc = await newAccount();
  const key = String(acc._id);
  const entry = fakeEntry('CONNECTED');
  entry.client.pupBrowser = { connected: false, on() {} };
  clients.set(key, entry);

  const status = await verifyConnected(key, entry, 500);
  assert.equal(status, 'disconnected');
  assert.ok(reconnectTimers.has(key), 'se vuelve a levantar solo');
  const fresh = await WhatsappAccount.findById(acc._id).lean();
  assert.match(fresh.lastDisconnectReason, /navegador/);
});

test('supervisor: una cuenta vinculada sin sesión viva se vuelve a levantar', async () => {
  const acc = await newAccount({ status: 'disconnected' });
  const key = String(acc._id);
  assert.equal(clients.has(key), false);

  await superviseSessions();
  assert.ok(reconnectTimers.has(key), 'nadie tiene que pulsar "Conectar" a mano');
});

test('supervisor: no toca la que fue desvinculada desde el teléfono', async () => {
  const acc = await newAccount({ status: 'disconnected', lastDisconnectNeedsQr: true });
  await superviseSessions();
  assert.equal(reconnectTimers.has(String(acc._id)), false);
});

test('supervisor: no toca números apagados ni los que nunca se vincularon', async () => {
  const apagada = await newAccount({ enabled: false, status: 'disconnected' });
  const nueva = await newAccount({ status: 'disconnected', connectedPhone: '', sessionId: '' });
  await superviseSessions();
  assert.equal(reconnectTimers.has(String(apagada._id)), false);
  assert.equal(reconnectTimers.has(String(nueva._id)), false);
});
