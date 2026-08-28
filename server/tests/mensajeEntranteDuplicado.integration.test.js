/**
 * UN MENSAJE ENTRANTE, UNA SOLA VEZ — pase lo que pase.
 *
 * En producción aparecieron mensajes guardados hasta CINCO veces. La causa: una
 * sesión QR que se reparaba volvía a enganchar los listeners DENTRO de la página
 * de WhatsApp Web sin quitar los de antes, así que el mismo mensaje entraba N
 * veces, con N creciendo en cada reparación. Se midieron copias separadas por
 * 11-15 milisegundos.
 *
 * La comprobación de duplicado que había era leer-y-luego-escribir, y con ~118 ms
 * de ida y vuelta a Atlas eso NO protege de nada: las dos ingestas leen «no
 * existe» antes de que ninguna haya insertado.
 *
 * Y lo grave no era verlo repetido en el chat: debajo del insert están el
 * contador de no leídos, el aviso por socket y el MOTOR DE AUTOMATIZACIONES. Cada
 * copia volvía a responderle al paciente.
 *
 * Estos tests fijan la red de seguridad de la BASE (el índice único), que es la
 * única que aguanta aunque algo vuelva a ingerir dos veces.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const chat = require('../controllers/chatController');
const CallCenterWhatsappConfig = require('../models/CallCenterWhatsappConfig');
const WhatsappAccount = require('../models/WhatsappAccount');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const { clearCache } = require('../utils/callCenterClinic');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => {
  await H.resetDb();
  clearCache();
  // `resetDb` vacía las colecciones; los índices se recrean aquí para que el
  // único de (clinic, externalId) esté puesto, que es justo lo que se prueba.
  await Message.syncIndexes();
});

async function seed() {
  const clinicId = new H.mongoose.Types.ObjectId();
  const cfg = await CallCenterWhatsappConfig.getSingleton();
  cfg.callCenterClinic = clinicId;
  await cfg.save();
  const account = await WhatsappAccount.create({
    label: 'QR',
    connectionType: 'qr',
    displayPhone: '+593 99 351 9937',
  });
  return { clinicId, account };
}

const entrante = (clinicId, account, externalId, body = 'Buenas') => ({
  clinicId,
  channel: 'whatsapp',
  account,
  phone: '593998278549',
  externalUserId: '44157179539458@lid',
  body,
  externalId,
  contactName: 'Jessy',
});

// ───────────────────── el índice está puesto ─────────────────────

test('existe el índice único que impide guardar dos veces el mismo entrante', async () => {
  const idx = await Message.collection.indexes();
  const unico = idx.find(
    (i) => i.unique && i.key && i.key.clinic === 1 && i.key.externalId === 1
  );
  assert.ok(unico, `falta el índice único; hay: ${idx.map((i) => i.name).join(', ')}`);
  // Parcial y solo para entrantes: un choque de ids NO puede tumbar un envío.
  assert.equal(unico.partialFilterExpression?.direction, 'in');
});

// ───────────────────── la carrera ─────────────────────

test('DOS ingestas a la vez del mismo mensaje guardan UNA sola copia', async () => {
  const { clinicId, account } = await seed();
  const id = 'false_44157179539458@lid_AC6949ECA6BC22DE377EF58';

  // A la vez, como los dos listeners que quedaban enganchados en la página.
  await Promise.all([
    chat.ingestExternalMessage(entrante(clinicId, account, id)),
    chat.ingestExternalMessage(entrante(clinicId, account, id)),
  ]);

  const msgs = await Message.find({ clinic: clinicId, direction: 'in' }).lean();
  assert.equal(msgs.length, 1, `se guardaron ${msgs.length} copias`);
});

test('CINCO ingestas a la vez tampoco pasan de una copia', async () => {
  const { clinicId, account } = await seed();
  const id = 'false_44157179539458@lid_ACFC167DC77483F5CF2A779';

  // Cinco: es la multiplicidad máxima que se midió en producción.
  await Promise.all(
    Array.from({ length: 5 }, () => chat.ingestExternalMessage(entrante(clinicId, account, id)))
  );

  const msgs = await Message.find({ clinic: clinicId, direction: 'in' }).lean();
  assert.equal(msgs.length, 1, `se guardaron ${msgs.length} copias`);
});

test('el duplicado NO infla el contador de no leídos', async () => {
  const { clinicId, account } = await seed();
  const id = 'false_44157179539458@lid_ACCFDCDD590C0246E710F78';

  await Promise.all([
    chat.ingestExternalMessage(entrante(clinicId, account, id)),
    chat.ingestExternalMessage(entrante(clinicId, account, id)),
  ]);

  const conv = await Conversation.findOne({ clinic: clinicId }).lean();
  // Este es el motivo de fondo de que la copia se descarte ANTES de seguir: bajo
  // el insert están el contador, el socket y las automatizaciones.
  assert.equal(conv.unreadCount, 1, `el contador quedó en ${conv.unreadCount}`);
});

// ───────────────────── el reintento de siempre ─────────────────────

test('reprocesar el mismo mensaje más tarde (reintento de Meta) no lo duplica', async () => {
  const { clinicId, account } = await seed();
  const id = 'wamid.HBgMNTkzOTk4Mjc4NTQ5';

  await chat.ingestExternalMessage(entrante(clinicId, account, id));
  await chat.ingestExternalMessage(entrante(clinicId, account, id));

  const msgs = await Message.find({ clinic: clinicId, direction: 'in' }).lean();
  assert.equal(msgs.length, 1);
});

test('mensajes DISTINTOS del mismo contacto se guardan todos', async () => {
  const { clinicId, account } = await seed();

  await chat.ingestExternalMessage(entrante(clinicId, account, 'id-1', 'Buenas'));
  await chat.ingestExternalMessage(entrante(clinicId, account, 'id-2', 'Disculpe'));
  await chat.ingestExternalMessage(entrante(clinicId, account, 'id-3', 'Estoy aquí'));

  const msgs = await Message.find({ clinic: clinicId, direction: 'in' }).sort({ createdAt: 1 }).lean();
  assert.equal(msgs.length, 3, 'el índice no puede tragarse mensajes legítimos');
  assert.deepEqual(msgs.map((m) => m.body), ['Buenas', 'Disculpe', 'Estoy aquí']);
});

test('el mismo id en OTRA clínica no choca', async () => {
  const { clinicId, account } = await seed();
  const otra = new H.mongoose.Types.ObjectId();
  const id = 'compartido-1';

  await chat.ingestExternalMessage(entrante(clinicId, account, id));
  await chat.ingestExternalMessage({ ...entrante(otra, account, id), phone: '593999000111' });

  assert.equal(await Message.countDocuments({ direction: 'in' }), 2);
});
