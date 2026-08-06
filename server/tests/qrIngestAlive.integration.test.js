/**
 * SESIÓN ZOMBI: el número figura conectado pero dejó de RECIBIR.
 *
 * CASO REAL (ago-2026, producción). El número QR "GENERAL" apareció "conectado"
 * durante casi 6 horas sin ingresar un solo mensaje entrante: los envíos salían,
 * `getState()` respondía CONNECTED y la campana nunca sonó, mientras los pacientes
 * escribían al vacío. La causa no fue WhatsApp ni la red: whatsapp-web.js
 * re-engancha sus listeners SOLO si detecta que `window.WWebJS` desapareció
 * (Client.js:311); cuando WhatsApp Web se recarga y esa comprobación no se cumple,
 * la librería emite 'ready' igualmente y deja la sesión con el socket vivo y el
 * puente de mensajes roto.
 *
 * El chequeo de salud era ciego a esto porque solo preguntaba por el socket. Lo
 * que se fija aquí:
 *   1. Una sesión que recibe con normalidad NO se toca.
 *   2. Una sonda sin respuesta (Chrome ocupado) NO cierra nada — igual que con
 *      getState, la falta de veredicto no es muerte.
 *   3. Perder el enganche de mensajes es CERTEZA: se rescata lo perdido y se
 *      reinicia la sesión, dejando el estado en 'disconnected' (honesto) y la
 *      reconexión automática programada.
 *   4. Un hueco (mensajes en el navegador que no llegaron a la app) se rescata
 *      primero y solo reinicia si vuelve a aparecer.
 *   5. Una cuenta sin marca de recepción fija la referencia en vez de reiniciarse
 *      (si no, el primer chequeo tras el despliegue mataría todas las sesiones).
 *   6. El freno de mano impide un bucle de reinicios.
 *   7. La marca `lastInboundAt` la escribe la propia ingesta con la hora DEL
 *      MENSAJE, y nunca retrocede (rescatar mensajes viejos no la mueve atrás).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');
const qr = require('../utils/whatsappQrManager');
const WhatsappAccount = require('../models/WhatsappAccount');
const Message = require('../models/Message');
const registry = require('../utils/instanceRegistry');
const callCenterClinic = require('../utils/callCenterClinic');
const chatController = require('../controllers/chatController');

const {
  clients, reconnectTimers, cancelReconnect, verifyIngest, probeIngest,
  ingestIncomingQrMessage, recoverMissedInbound, MAX_INGEST_GAPS,
} = qr.__test;

const realIsLeader = registry.isLeader;
const realResolveClinic = callCenterClinic.resolveCallCenterClinicId;
const realIngest = chatController.ingestExternalMessage;

test.before(async () => {
  await H.startDb();
  registry.isLeader = () => true;
});
test.after(async () => {
  registry.isLeader = realIsLeader;
  callCenterClinic.resolveCallCenterClinicId = realResolveClinic;
  chatController.ingestExternalMessage = realIngest;
  await H.stopDb();
});
test.beforeEach(async () => {
  await H.resetDb();
  for (const key of Array.from(reconnectTimers.keys())) cancelReconnect(key);
  clients.clear();
});

const AHORA_SEG = () => Math.floor(Date.now() / 1000);

/**
 * Sesión falsa cuya página contesta lo que le digamos.
 * `sonda` es lo que devuelve el evaluate de probeIngest; `rescatables` lo que
 * devuelve el de recoverMissedInbound (se distinguen por el 3er argumento, que
 * solo pasa el rescate).
 */
function fakeEntry(sonda, rescatables = { total: 0, modelos: [] }) {
  const entry = {
    status: 'connected',
    misses: 0,
    watchdog: null,
    syncWatchdog: null,
    destroyed: false,
    evaluados: 0,
    client: {
      info: { wid: { user: '593993519937' } },
      pupPage: {
        isClosed: () => false,
        evaluate: async (_fn, _tipos, _desde, tope) => {
          entry.evaluados += 1;
          if (tope !== undefined) return rescatables; // llamada del rescate
          if (sonda instanceof Error) throw sonda;
          return sonda;
        },
      },
      getState: async () => 'CONNECTED',
      destroy: async () => { entry.destroyed = true; },
    },
  };
  return entry;
}

/** Sonda "todo en orden": enganchada y sin nada pendiente. */
function sondaSana(ultimoSeg = AHORA_SEG()) {
  return { wwebjs: true, expuesta: true, enganchado: true, ultimoEntranteSeg: ultimoSeg, pendientes: 0, error: '' };
}

async function newAccount(patch = {}) {
  return WhatsappAccount.create({
    label: 'GENERAL',
    connectionType: 'qr',
    enabled: true,
    status: 'connected',
    sessionId: 's1',
    connectedPhone: '593993519937',
    lastInboundAt: new Date(),
    ...patch,
  });
}

test('una sesión que recibe con normalidad no se toca', async () => {
  const acc = await newAccount();
  const key = String(acc._id);
  const entry = fakeEntry(sondaSana());
  clients.set(key, entry);

  await verifyIngest(key, entry);

  assert.ok(clients.has(key), 'la sesión sigue viva');
  assert.equal(entry.destroyed, false);
  assert.equal(entry.ingestGaps, 0);
  const fresh = await WhatsappAccount.findById(acc._id).lean();
  assert.equal(fresh.status, 'connected');
});

test('la sonda sin respuesta (Chrome ocupado) NO cierra la sesión', async () => {
  const acc = await newAccount();
  const key = String(acc._id);
  const entry = fakeEntry(new Error('__timeout__'));
  clients.set(key, entry);

  await verifyIngest(key, entry);

  assert.ok(clients.has(key), 'sin veredicto no se toca nada');
  assert.equal(entry.destroyed, false);
  assert.equal(reconnectTimers.has(key), false);
});

test('perder el enganche de mensajes reinicia la sesión y deja el estado honesto', async () => {
  const acc = await newAccount({ lastInboundAt: new Date(Date.now() - 30 * 60000) });
  const key = String(acc._id);
  // El caso de producción: WWebJS sigue ahí (por eso la librería no re-enganchó)
  // pero el listener 'add' ya no está.
  const entry = fakeEntry({
    wwebjs: true, expuesta: true, enganchado: false,
    ultimoEntranteSeg: AHORA_SEG(), pendientes: 4, error: '',
  });
  clients.set(key, entry);

  await verifyIngest(key, entry);

  assert.equal(clients.has(key), false, 'la sesión zombi se cerró');
  assert.equal(entry.destroyed, true, 'se destruyó el navegador');
  assert.ok(reconnectTimers.has(key), 'se programó la reconexión automática');

  const fresh = await WhatsappAccount.findById(acc._id).lean();
  assert.equal(fresh.status, 'disconnected', 'la UI deja de mentir');
  assert.equal(fresh.lastDisconnectNeedsQr, false, 'no hace falta QR nuevo: se reconecta sola');
  assert.match(fresh.lastDisconnectReason, /ingesta muerta/, 'queda escrito POR QUÉ se cayó');
});

test('un hueco se rescata primero y solo reinicia si vuelve a aparecer', async () => {
  const acc = await newAccount({ lastInboundAt: new Date(Date.now() - 30 * 60000) });
  const key = String(acc._id);
  // Estructuralmente sana, pero el navegador tiene mensajes que la app no guardó.
  const entry = fakeEntry({
    wwebjs: true, expuesta: true, enganchado: true,
    ultimoEntranteSeg: AHORA_SEG(), pendientes: 3, error: '',
  });
  clients.set(key, entry);

  await verifyIngest(key, entry);
  assert.ok(clients.has(key), 'el primer hueco NO reinicia: primero se rescata');
  assert.equal(entry.ingestGaps, 1);

  await verifyIngest(key, entry);
  assert.equal(MAX_INGEST_GAPS, 2, 'este test asume el umbral de 2 vueltas');
  assert.equal(clients.has(key), false, 'el hueco persistente sí reinicia');
  assert.ok(reconnectTimers.has(key), 'y deja la reconexión programada');
});

test('una cuenta sin marca de recepción fija la referencia en vez de reiniciarse', async () => {
  // Es el estado de TODAS las cuentas justo tras desplegar el campo nuevo: sin
  // esta guarda, el primer chequeo vería un hueco de años y mataría la sesión.
  const acc = await newAccount({ lastInboundAt: null });
  const key = String(acc._id);
  const ultimo = AHORA_SEG() - 3600;
  const entry = fakeEntry({
    wwebjs: true, expuesta: true, enganchado: true,
    ultimoEntranteSeg: ultimo, pendientes: 99, error: '',
  });
  clients.set(key, entry);

  await verifyIngest(key, entry);

  assert.ok(clients.has(key), 'no se reinicia nada');
  const fresh = await WhatsappAccount.findById(acc._id).lean();
  assert.ok(fresh.lastInboundAt, 'se fijó la referencia para la próxima vuelta');
  assert.equal(Math.floor(new Date(fresh.lastInboundAt).getTime() / 1000), ultimo);
});

test('el freno de mano impide un bucle de reinicios', async () => {
  const acc = await newAccount({ lastInboundAt: new Date(Date.now() - 30 * 60000) });
  const key = String(acc._id);
  const rota = {
    wwebjs: true, expuesta: true, enganchado: false,
    ultimoEntranteSeg: AHORA_SEG(), pendientes: 1, error: '',
  };
  const entry = fakeEntry(rota);
  entry.lastIngestRepairAt = Date.now() - 60000; // se reinició hace 1 minuto
  clients.set(key, entry);

  await verifyIngest(key, entry);

  assert.ok(clients.has(key), 'no se reinicia dos veces seguidas');
  assert.equal(entry.destroyed, false);
});

test('probeIngest sin página utilizable no da veredicto', async () => {
  const entry = fakeEntry(sondaSana());
  entry.client.pupPage.isClosed = () => true;
  const r = await probeIngest(entry, Date.now());
  assert.equal(r.ok, false);
  assert.equal(r.sinRespuesta, true);
});

test('la ingesta escribe lastInboundAt con la hora del mensaje y nunca retrocede', async () => {
  const acc = await newAccount({ lastInboundAt: null });
  const key = String(acc._id);
  callCenterClinic.resolveCallCenterClinicId = async () => acc._id; // basta un id válido
  const recibidos = [];
  chatController.ingestExternalMessage = async (p) => { recibidos.push(p); };

  const client = { info: { wid: { user: '593993519937' } } };
  const nuevo = Math.floor(Date.now() / 1000) - 60;
  const viejo = nuevo - 7200;
  const msg = (t, body) => ({
    fromMe: false, isStatus: false, from: '593999888777@c.us', type: 'chat',
    body, timestamp: t, hasMedia: false, hasQuotedMsg: false,
    id: { _serialized: `false_593999888777@c.us_HASH${t}` },
    _data: { notifyName: 'Paciente' },
  });

  assert.equal(await ingestIncomingQrMessage(msg(nuevo, 'hola'), client, key), true);
  let fresh = await WhatsappAccount.findById(acc._id).lean();
  assert.equal(Math.floor(new Date(fresh.lastInboundAt).getTime() / 1000), nuevo);

  // Un mensaje RESCATADO más antiguo no puede hacer retroceder la marca: si lo
  // hiciera, el chequeo siguiente vería un hueco falso y reiniciaría la sesión.
  assert.equal(await ingestIncomingQrMessage(msg(viejo, 'mensaje viejo'), client, key), true);
  fresh = await WhatsappAccount.findById(acc._id).lean();
  assert.equal(Math.floor(new Date(fresh.lastInboundAt).getTime() / 1000), nuevo);

  assert.equal(recibidos.length, 2, 'ambos mensajes pasaron por la ingesta');
  assert.equal(recibidos[0].externalUserId, '593999888777@c.us');

  callCenterClinic.resolveCallCenterClinicId = realResolveClinic;
  chatController.ingestExternalMessage = realIngest;
});

test('el rescate reingresa lo perdido y no vuelve a meter lo que ya está guardado', async () => {
  const acc = await newAccount({ lastInboundAt: new Date(Date.now() - 60 * 60000) });
  const key = String(acc._id);
  callCenterClinic.resolveCallCenterClinicId = async () => acc._id;
  const recibidos = [];
  chatController.ingestExternalMessage = async (p) => { recibidos.push(p); };

  const t = AHORA_SEG() - 300;
  // Modelo crudo tal como lo devuelve WWebJS.getMessageModel dentro de la página.
  const modelo = (hash, body, tt) => ({
    id: {
      fromMe: false,
      remote: { _serialized: '593999888777@c.us' },
      id: hash,
      _serialized: `false_593999888777@c.us_${hash}`,
    },
    from: '593999888777@c.us', to: '593993519937@c.us',
    body, type: 'chat', t: tt, notifyName: 'Paciente', isNewMsg: true,
  });
  const entry = fakeEntry(sondaSana(), {
    total: 2,
    modelos: [modelo('H1', 'perdido 1', t), modelo('H2', 'perdido 2', t + 10)],
  });

  const n = await recoverMissedInbound(entry.client, key, Date.now() - 3600000);
  assert.equal(n, 2, 'los dos mensajes de la sesión se reingresaron');
  assert.deepEqual(recibidos.map((r) => r.body), ['perdido 1', 'perdido 2'], 'y en orden cronológico');

  // Uno de ellos ya está guardado: el siguiente rescate no lo repite (y, sobre
  // todo, no vuelve a descargar su archivo).
  await Message.create({
    clinic: acc._id,
    conversation: acc._id,
    direction: 'in',
    body: 'perdido 1',
    externalId: 'false_593999888777@c.us_H1',
  });
  recibidos.length = 0;
  const n2 = await recoverMissedInbound(entry.client, key, Date.now() - 3600000);
  assert.equal(n2, 1, 'solo se reingresa el que faltaba');
  assert.deepEqual(recibidos.map((r) => r.body), ['perdido 2']);

  callCenterClinic.resolveCallCenterClinicId = realResolveClinic;
  chatController.ingestExternalMessage = realIngest;
});

test('los grupos y los tipos sin contenido nunca entran', async () => {
  const acc = await newAccount();
  const key = String(acc._id);
  const client = { info: { wid: { user: '593993519937' } } };
  const base = { fromMe: false, isStatus: false, type: 'chat', body: 'hola', timestamp: AHORA_SEG(), hasMedia: false };

  assert.equal(await ingestIncomingQrMessage({ ...base, from: '12036@g.us' }, client, key), false, 'grupo fuera');
  assert.equal(
    await ingestIncomingQrMessage({ ...base, from: '593999888777@c.us', type: 'e2e_notification' }, client, key),
    false,
    'la renegociación de claves no crea chats fantasma'
  );
  assert.equal(await ingestIncomingQrMessage({ ...base, from: '593999888777@c.us', fromMe: true }, client, key), false);
});
