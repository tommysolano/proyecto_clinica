/**
 * EL CALL CENTER REGISTRA CON CORREO Y DIRECCIÓN, NO CON GÉNERO.
 *
 * El modal «Agregar paciente al sistema» del chat preguntaba el género, que no
 * se lo dicta nadie por WhatsApp y acababa a ojo o en «Seleccionar». Se cambió
 * por los dos datos que el contacto SÍ da por el chat: correo y dirección.
 *
 * Lo que se vigila aquí es que esos dos lleguen de verdad a la ficha — incluido
 * el caso que se perdía en silencio: cuando el paciente YA existía.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Conversation = require('../models/Conversation');
const Patient = require('../models/Patient');
const chatCtrl = require('../controllers/chatController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const registrar = (clinicId, userId, convId, body) =>
  H.runController(
    chatCtrl.registerPatientFromChat,
    H.mockReq(clinicId, userId, body, { params: { id: String(convId) } })
  );

test('el correo y la dirección se guardan en el paciente nuevo', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const conv = await Conversation.create({ clinic: clinicId, phone: '593991234567', channel: 'whatsapp' });

  const r = await registrar(clinicId, userId, conv._id, {
    firstName: 'Dora', lastName: 'Pinzón',
    email: 'Dora@Correo.com', address: 'Av. Principal 123 y Segunda',
  });
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));

  const p = await Patient.findById(r.payload.patient._id);
  assert.equal(p.email, 'dora@correo.com', 'el esquema lo normaliza a minúsculas');
  assert.equal(p.address, 'Av. Principal 123 y Segunda');
});

test('si el paciente YA existía, se rellenan sus huecos en vez de tirar el dato', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const existente = await Patient.create({
    clinic: clinicId, firstName: 'Dora', lastName: 'Pinzón', phone: '0991234567',
  });
  const conv = await Conversation.create({ clinic: clinicId, phone: '593991234567', channel: 'whatsapp' });

  const r = await registrar(clinicId, userId, conv._id, {
    email: 'dora@correo.com', address: 'Av. Principal 123',
  });
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(String(r.payload.patient._id), String(existente._id), 'no debe crear un duplicado');

  const p = await Patient.findById(existente._id);
  assert.equal(p.email, 'dora@correo.com');
  assert.equal(p.address, 'Av. Principal 123');
});

test('lo que el paciente YA tenía no se pisa', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const existente = await Patient.create({
    clinic: clinicId, firstName: 'Dora', lastName: 'Pinzón', phone: '0991234567',
    email: 'el.bueno@correo.com', address: 'La de siempre 45',
  });
  const conv = await Conversation.create({ clinic: clinicId, phone: '593991234567', channel: 'whatsapp' });

  await registrar(clinicId, userId, conv._id, {
    email: 'otro@correo.com', address: 'Otra dirección',
  });

  const p = await Patient.findById(existente._id);
  assert.equal(p.email, 'el.bueno@correo.com');
  assert.equal(p.address, 'La de siempre 45');
});

test('sin correo ni dirección se registra igual: ninguno es obligatorio', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const conv = await Conversation.create({ clinic: clinicId, phone: '593991234567', channel: 'whatsapp' });

  const r = await registrar(clinicId, userId, conv._id, { firstName: 'Dora' });
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const p = await Patient.findById(r.payload.patient._id);
  assert.equal(p.email, '');
  assert.equal(p.address, '');
});
