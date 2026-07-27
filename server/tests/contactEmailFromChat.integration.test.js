/**
 * El correo del contacto sale de lo que ÉL escribe en el chat.
 *
 * No hay ningún formulario donde pedirlo: el agente ve en el panel lateral el
 * correo que el contacto haya mandado en la conversación, listo para copiar.
 * Por eso lo que importa es la extracción: la gente lo escribe suelto, dentro de
 * una frase, con mayúsculas o con un punto final pegado.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const chat = require('../controllers/chatController');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Patient = require('../models/Patient');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function conversacionCon(clinicId, mensajes) {
  const conv = await Conversation.create({ clinic: clinicId, channel: 'whatsapp', phone: '593999111222' });
  for (const m of mensajes) {
    // eslint-disable-next-line no-await-in-loop
    await Message.create({
      clinic: clinicId,
      conversation: conv._id,
      direction: m.dir || 'in',
      body: m.body,
    });
  }
  return conv;
}

async function detectado(clinicId, conv) {
  const r = await H.runController(
    chat.getConversation,
    H.mockReq(clinicId, null, {}, { params: { id: String(conv._id) } })
  );
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  return r.payload.detectedEmail;
}

test('correo escrito dentro de una frase: se extrae solo el correo', async () => {
  const { clinicId } = await H.seedClinic();
  const conv = await conversacionCon(clinicId, [
    { body: 'Buenas, quiero información' },
    { body: 'mi correo es maira.ruiz@gmail.com gracias' },
  ]);
  assert.equal(await detectado(clinicId, conv), 'maira.ruiz@gmail.com');
});

test('se queda con el ÚLTIMO que escribió (si se corrigió, vale el segundo)', async () => {
  const { clinicId } = await H.seedClinic();
  const conv = await conversacionCon(clinicId, [
    { body: 'ana@gmial.com' },
    { body: 'perdón, es ana@gmail.com' },
  ]);
  assert.equal(await detectado(clinicId, conv), 'ana@gmail.com');
});

test('normaliza mayúsculas y quita el punto final pegado', async () => {
  const { clinicId } = await H.seedClinic();
  const conv = await conversacionCon(clinicId, [{ body: 'Escríbeme a Cris.Salsa@Hotmail.COM.' }]);
  assert.equal(await detectado(clinicId, conv), 'cris.salsa@hotmail.com');
});

test('lo que escribe la CLÍNICA no cuenta como correo del contacto', async () => {
  const { clinicId } = await H.seedClinic();
  const conv = await conversacionCon(clinicId, [
    { dir: 'out', body: 'Puedes escribirnos a info@shiluvecuador.com' },
  ]);
  assert.equal(await detectado(clinicId, conv), '');
});

test('sin correo en la conversación devuelve vacío (el panel muestra el aviso)', async () => {
  const { clinicId } = await H.seedClinic();
  const conv = await conversacionCon(clinicId, [{ body: 'Hola, cuánto cuesta?' }, { body: 'gracias' }]);
  assert.equal(await detectado(clinicId, conv), '');
});

test('un texto con arroba que NO es correo no se confunde', async () => {
  const { clinicId } = await H.seedClinic();
  const conv = await conversacionCon(clinicId, [{ body: 'sígueme en @shiluv y te aviso' }]);
  assert.equal(await detectado(clinicId, conv), '');
});

test('si el contacto ya es paciente, el correo del chat sigue mandando en la detección', async () => {
  const { clinicId } = await H.seedClinic();
  const patient = await Patient.create({
    clinic: clinicId, firstName: 'Maira', lastName: 'Ruiz', cedula: '0912345678', email: 'viejo@correo.com',
  });
  const conv = await Conversation.create({
    clinic: clinicId, channel: 'whatsapp', phone: '593999111222', patient: patient._id,
  });
  await Message.create({ clinic: clinicId, conversation: conv._id, direction: 'in', body: 'ahora uso maira@nuevo.com' });

  const r = await H.runController(
    chat.getConversation,
    H.mockReq(clinicId, null, {}, { params: { id: String(conv._id) } })
  );
  assert.equal(r.payload.detectedEmail, 'maira@nuevo.com');
  // El de la ficha viaja aparte: el panel lo usa solo como respaldo.
  assert.equal(r.payload.patient.email, 'viejo@correo.com');
});
