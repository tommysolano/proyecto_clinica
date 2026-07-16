/**
 * Envío masivo por goteo: tandas, respeto del consentimiento y horario.
 *
 * Aquí un fallo se traduce en mensajes de verdad a personas de verdad (duplicados,
 * a quien se dio de baja, o de madrugada), así que se prueba contra Mongo con el
 * gateway simulado.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Contact = require('../models/Contact');
const ContactGroup = require('../models/ContactGroup');
const DripCampaign = require('../models/DripCampaign');
const WhatsappAccount = require('../models/WhatsappAccount');
const Message = require('../models/Message');
const { withinSchedule, personalize } = require('../utils/dripRunner');
const { buildContactMatch, buildSendableMatch } = require('../utils/contactAudience');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
// Limpiar ANTES de cada test, no después: si uno falla a mitad no deja la base
// sucia y hace fallar al siguiente (un fallo intermitente y engañoso).
test.beforeEach(async () => { await H.resetDb(); });

// ─────────── piezas puras (sin BD) ───────────

test('withinSchedule: respeta franja horaria y días', () => {
  const camp = { hourFrom: '09:00', hourTo: '20:00', days: [1, 2, 3, 4, 5] };
  const lunes10 = new Date(2026, 6, 13, 10, 0); // lunes 10:00
  const lunes7 = new Date(2026, 6, 13, 7, 0);   // lunes 07:00 (temprano)
  const lunes22 = new Date(2026, 6, 13, 22, 0); // lunes 22:00 (tarde)
  const domingo10 = new Date(2026, 6, 12, 10, 0);

  assert.equal(withinSchedule(camp, lunes10), true);
  assert.equal(withinSchedule(camp, lunes7), false, 'no se envía antes de la hora');
  assert.equal(withinSchedule(camp, lunes22), false, 'no se envía de noche');
  assert.equal(withinSchedule(camp, domingo10), false, 'domingo no está en los días');

  // Sin días configurados = todos los días valen.
  assert.equal(withinSchedule({ hourFrom: '09:00', hourTo: '20:00', days: [] }, domingo10), true);
});

test('personalize: rellena el nombre en el texto libre (envíos por QR)', () => {
  assert.equal(
    personalize('Hola {{nombre}}, te esperamos', { firstName: 'Ligia', lastName: 'Farfán' }),
    'Hola Ligia, te esperamos'
  );
  // Si solo hay displayName, se usa la primera palabra.
  assert.equal(personalize('Hola {{nombre}}', { displayName: 'Dome Pérez' }), 'Hola Dome');
  // Sin nombre no se rompe: queda vacío, no "{{nombre}}".
  assert.equal(personalize('Hola {{nombre}}', {}), 'Hola ');
  assert.equal(personalize('{{nombre_completo}}', { firstName: 'Ana', lastName: 'Paz' }), 'Ana Paz');
});

// ─────────── audiencia ───────────

test('buildSendableMatch: excluye a quien se dio de baja o no tiene opt-in', async () => {
  const { clinicId } = await H.seedClinic();
  await Contact.create([
    { clinic: clinicId, phone: '593999000001' }, // opt-in por defecto = true
    { clinic: clinicId, phone: '593999000002', marketing: { whatsappOptIn: false } },
    { clinic: clinicId, phone: '593999000003', marketing: { whatsappOptIn: true, optOutAt: new Date() } },
    { clinic: clinicId, phone: '593999000004', active: false },
  ]);

  const sendable = await Contact.find(buildSendableMatch(clinicId, null)).lean();
  const phones = sendable.map((c) => c.phone);
  assert.deepEqual(phones, ['593999000001']);
  await H.resetDb();
});

test('buildContactMatch: filtros de un grupo dinámico', async () => {
  const { clinicId } = await H.seedClinic();
  await Contact.create([
    { clinic: clinicId, phone: '593999000001', tags: ['feria', 'vip'], source: 'import' },
    { clinic: clinicId, phone: '593999000002', tags: ['feria'], source: 'import' },
    { clinic: clinicId, phone: '593999000003', tags: ['vip'], source: 'chat' },
  ]);

  // $all: tiene TODAS las etiquetas.
  let r = await Contact.find(buildContactMatch(clinicId, { tags: ['feria', 'vip'] })).lean();
  assert.deepEqual(r.map((c) => c.phone), ['593999000001']);

  // $in: tiene ALGUNA.
  r = await Contact.find(buildContactMatch(clinicId, { anyTags: ['feria', 'vip'] })).lean();
  assert.equal(r.length, 3);

  // Por origen.
  r = await Contact.find(buildContactMatch(clinicId, { sources: ['chat'] })).lean();
  assert.deepEqual(r.map((c) => c.phone), ['593999000003']);

  // La búsqueda libre combina con el resto sin pisarlo (el $or de optIn + el $or
  // del buscador se combinan con $and: es donde un match mal armado da resultados
  // de más).
  r = await Contact.find(buildContactMatch(clinicId, { whatsappOptIn: 'no', q: '000001' })).lean();
  assert.equal(r.length, 0, 'ese contacto sí tiene opt-in: no debe salir');
  await H.resetDb();
});

test('buildContactMatch: separa contactos que ya son pacientes de los que no', async () => {
  const { clinicId } = await H.seedClinic();
  const Patient = require('../models/Patient');
  const p = await Patient.create({ clinic: clinicId, firstName: 'Ana', lastName: 'Paz', cedula: '0911111111' });
  await Contact.create([
    { clinic: clinicId, phone: '593999000001', patient: p._id },
    { clinic: clinicId, phone: '593999000002' },
  ]);

  const yaPacientes = await Contact.find(buildContactMatch(clinicId, { isPatient: 'yes' })).lean();
  assert.deepEqual(yaPacientes.map((c) => c.phone), ['593999000001']);
  const aunNo = await Contact.find(buildContactMatch(clinicId, { isPatient: 'no' })).lean();
  assert.deepEqual(aunNo.map((c) => c.phone), ['593999000002']);
  await H.resetDb();
});

// ─────────── el goteo, de punta a punta ───────────

/** Simula el gateway: ningún test manda mensajes de verdad. */
function fakeGateway() {
  const gw = require('../utils/whatsappGateway');
  const sent = [];
  const orig = { sendText: gw.sendText, sendTemplate: gw.sendTemplate };
  gw.sendText = async (account, to, body) => {
    sent.push({ to, body });
    return { ok: true, data: { messages: [{ id: `wamid.${sent.length}` }] } };
  };
  gw.sendTemplate = async (account, to, templateName, lang, components) => {
    sent.push({ to, template: true, templateName, lang, components });
    return { ok: true, data: { messages: [{ id: `wamid.${sent.length}` }] } };
  };
  return { sent, restore: () => Object.assign(gw, orig) };
}

/** Parámetros del cuerpo que se le mandaron a Meta, como texto plano. */
function bodyParams(entry) {
  const body = (entry.components || []).find((c) => c.type === 'body');
  return (body?.parameters || []).map((p) => p.text);
}

test('goteo: manda solo la tanda, y a la siguiente sigue por donde iba', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const gw = fakeGateway();
  try {
    await WhatsappAccount.create({ label: 'QR', connectionType: 'qr', enabled: true, isDefault: true, status: 'connected' });
    for (let i = 1; i <= 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      await Contact.create({ clinic: clinicId, phone: `59399900000${i}`, displayName: `C${i}` });
    }
    const camp = await DripCampaign.create({
      clinic: clinicId, name: 'Promo', body: 'Hola {{nombre}}',
      batchSize: 2, intervalMinutes: 15,
      hourFrom: '00:00', hourTo: '23:59', // sin franja para que el test no dependa de la hora
      status: 'running', nextRunAt: new Date(), createdBy: userId,
    });

    const { runCampaign } = require('../utils/dripRunner');
    await runCampaign(camp._id);
    let fresh = await DripCampaign.findById(camp._id);
    assert.equal(fresh.stats.sent, 2, 'solo la tanda, no los 5 de golpe');
    assert.equal(fresh.status, 'running');
    assert.ok(fresh.nextRunAt > new Date(), 'se reprograma la siguiente tanda');

    // La siguiente tanda va a por los que faltan, no repite.
    fresh.nextRunAt = new Date();
    await fresh.save();
    await runCampaign(camp._id);
    fresh = await DripCampaign.findById(camp._id);
    assert.equal(fresh.stats.sent, 4);

    fresh.nextRunAt = new Date();
    await fresh.save();
    await runCampaign(camp._id);
    fresh = await DripCampaign.findById(camp._id);
    assert.equal(fresh.stats.sent, 5);
    assert.equal(fresh.status, 'done', 'al no quedar nadie, termina');

    // Nadie recibió dos veces.
    const destinos = gw.sent.map((s) => s.to);
    assert.equal(new Set(destinos).size, destinos.length, 'ningún contacto repetido');
    // Y el texto salió personalizado.
    assert.match(gw.sent[0].body, /^Hola C\d$/);
  } finally {
    gw.restore();
    await H.resetDb();
  }
});

test('goteo: nunca escribe a quien se dio de baja, aunque se diera de baja a mitad', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const gw = fakeGateway();
  try {
    await WhatsappAccount.create({ label: 'QR', connectionType: 'qr', enabled: true, isDefault: true, status: 'connected' });
    await Contact.create([
      { clinic: clinicId, phone: '593999000001', displayName: 'Sí' },
      { clinic: clinicId, phone: '593999000002', displayName: 'Baja', marketing: { whatsappOptIn: false } },
    ]);
    const camp = await DripCampaign.create({
      clinic: clinicId, name: 'Promo', body: 'Hola',
      batchSize: 10, intervalMinutes: 15, hourFrom: '00:00', hourTo: '23:59',
      status: 'running', nextRunAt: new Date(), createdBy: userId,
    });

    const { runCampaign } = require('../utils/dripRunner');
    await runCampaign(camp._id);

    assert.deepEqual(gw.sent.map((s) => s.to), ['593999000001']);
    const fresh = await DripCampaign.findById(camp._id);
    assert.equal(fresh.status, 'done');
  } finally {
    gw.restore();
    await H.resetDb();
  }
});

test('goteo: fuera de la franja horaria no gasta mensajes, solo reprograma', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const gw = fakeGateway();
  try {
    await WhatsappAccount.create({ label: 'QR', connectionType: 'qr', enabled: true, isDefault: true, status: 'connected' });
    await Contact.create({ clinic: clinicId, phone: '593999000001' });
    // Franja imposible: la hora actual nunca cae dentro.
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const camp = await DripCampaign.create({
      clinic: clinicId, name: 'Nocturna', body: 'Hola',
      batchSize: 10, intervalMinutes: 15,
      hourFrom: hh >= '12' ? '00:00' : '23:00',
      hourTo: hh >= '12' ? '00:01' : '23:59',
      status: 'running', nextRunAt: new Date(), createdBy: userId,
    });

    const { runCampaign } = require('../utils/dripRunner');
    await runCampaign(camp._id);

    assert.equal(gw.sent.length, 0, 'fuera de horario no se envía nada');
    const fresh = await DripCampaign.findById(camp._id);
    assert.equal(fresh.status, 'running', 'la campaña sigue viva, solo espera');
    assert.ok(fresh.nextRunAt > new Date());
  } finally {
    gw.restore();
    await H.resetDb();
  }
});

test('goteo: dos ticks a la vez no mandan la tanda dos veces', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const gw = fakeGateway();
  try {
    await WhatsappAccount.create({ label: 'QR', connectionType: 'qr', enabled: true, isDefault: true, status: 'connected' });
    await Contact.create({ clinic: clinicId, phone: '593999000001' });
    const camp = await DripCampaign.create({
      clinic: clinicId, name: 'Promo', body: 'Hola',
      batchSize: 10, intervalMinutes: 15, hourFrom: '00:00', hourTo: '23:59',
      status: 'running', nextRunAt: new Date(), createdBy: userId,
    });

    const { runCampaign } = require('../utils/dripRunner');
    const [a, b] = await Promise.all([runCampaign(camp._id), runCampaign(camp._id)]);
    assert.ok(a && !b, 'el segundo tick no debe procesar la misma tanda');
    assert.equal(gw.sent.length, 1, 'el contacto recibe UN mensaje, no dos');
  } finally {
    gw.restore();
    await H.resetDb();
  }
});

test('goteo: solo alcanza al grupo elegido', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const gw = fakeGateway();
  try {
    await WhatsappAccount.create({ label: 'QR', connectionType: 'qr', enabled: true, isDefault: true, status: 'connected' });
    const grupo = await ContactGroup.create({ clinic: clinicId, name: 'Feria', kind: 'static' });
    await Contact.create([
      { clinic: clinicId, phone: '593999000001', groups: [grupo._id] },
      { clinic: clinicId, phone: '593999000002' }, // fuera del grupo
    ]);
    const camp = await DripCampaign.create({
      clinic: clinicId, name: 'Promo feria', body: 'Hola', group: grupo._id,
      batchSize: 10, intervalMinutes: 15, hourFrom: '00:00', hourTo: '23:59',
      status: 'running', nextRunAt: new Date(), createdBy: userId,
    });

    const { runCampaign } = require('../utils/dripRunner');
    await runCampaign(camp._id);
    assert.deepEqual(gw.sent.map((s) => s.to), ['593999000001']);
  } finally {
    gw.restore();
    await H.resetDb();
  }
});

test('goteo: el envío queda en el chat del contacto', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const gw = fakeGateway();
  try {
    await WhatsappAccount.create({ label: 'QR', connectionType: 'qr', enabled: true, isDefault: true, status: 'connected' });
    await Contact.create({ clinic: clinicId, phone: '593999000001', displayName: 'Ligia' });
    const camp = await DripCampaign.create({
      clinic: clinicId, name: 'Promo', body: 'Hola Ligia',
      batchSize: 10, intervalMinutes: 15, hourFrom: '00:00', hourTo: '23:59',
      status: 'running', nextRunAt: new Date(), createdBy: userId,
    });

    const { runCampaign } = require('../utils/dripRunner');
    await runCampaign(camp._id);

    // El agente tiene que poder ver en el chat lo que se le mandó al contacto.
    const Conversation = require('../models/Conversation');
    const conv = await Conversation.findOne({ clinic: clinicId, phone: '593999000001' });
    assert.ok(conv, 'se crea la conversación del contacto');
    const msg = await Message.findOne({ conversation: conv._id, direction: 'out' });
    assert.ok(msg, 'el mensaje queda registrado en el chat');
    assert.equal(msg.body, 'Hola Ligia');
  } finally {
    gw.restore();
    await H.resetDb();
  }
});

// ─────────── variables de plantilla (Cloud API) ───────────

/** Número de Cloud API + plantilla aprobada con una variable {{nombre}}. */
async function seedCloudTemplate(clinicId, body = 'Hola {{nombre}}, te esperamos.') {
  await WhatsappAccount.create({
    label: 'Producción', connectionType: 'cloud_api', enabled: true, isDefault: true,
    status: 'connected', phoneNumberId: '123', accessToken: 'tok', messagingLimit: 'TIER_1K',
  });
  const MessageTemplate = require('../models/MessageTemplate');
  return MessageTemplate.create({
    clinic: clinicId, channel: 'whatsapp', name: 'promo_julio', language: 'es',
    status: 'approved', body,
    // El EJEMPLO es la trampa: sin resolver la variable contra el contacto,
    // messaging cae aquí y los 800 contactos reciben "Hola María".
    variables: [{ key: 'nombre', example: 'María' }],
  });
}

test('goteo por Cloud API: la plantilla se rellena con el nombre del CONTACTO, no con el ejemplo', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const gw = fakeGateway();
  try {
    const tpl = await seedCloudTemplate(clinicId);
    await Contact.create([
      { clinic: clinicId, phone: '593999000001', firstName: 'Emily', lastName: 'Torres' },
      { clinic: clinicId, phone: '593999000002', displayName: 'Dome' },
    ]);
    const camp = await DripCampaign.create({
      clinic: clinicId, name: 'Promo', template: tpl._id, templateName: 'promo_julio',
      templateLanguage: 'es', templateVars: [{ key: 'nombre', source: 'nombre' }],
      batchSize: 10, intervalMinutes: 15, hourFrom: '00:00', hourTo: '23:59',
      status: 'running', nextRunAt: new Date(), createdBy: userId,
    });

    const { runCampaign } = require('../utils/dripRunner');
    await runCampaign(camp._id);

    assert.equal(gw.sent.length, 2);
    const names = gw.sent.map((s) => bodyParams(s)[0]).sort();
    assert.deepEqual(names, ['Dome', 'Emily'], 'cada contacto recibe SU nombre');
    assert.ok(!names.includes('María'), 'nadie recibe el ejemplo de la plantilla');
  } finally {
    gw.restore();
    await H.resetDb();
  }
});

test('goteo por Cloud API: un contacto sin nombre recibe "-" y no rompe el envío', async () => {
  // Meta rechaza los parámetros vacíos: un contacto que en el Excel era solo un
  // número no puede tumbar la campaña entera.
  const { clinicId, userId } = await H.seedClinic();
  const gw = fakeGateway();
  try {
    const tpl = await seedCloudTemplate(clinicId);
    await Contact.create({ clinic: clinicId, phone: '593999000009' });
    const camp = await DripCampaign.create({
      clinic: clinicId, name: 'Promo', template: tpl._id, templateName: 'promo_julio',
      templateLanguage: 'es', templateVars: [{ key: 'nombre', source: 'nombre' }],
      batchSize: 10, intervalMinutes: 15, hourFrom: '00:00', hourTo: '23:59',
      status: 'running', nextRunAt: new Date(), createdBy: userId,
    });

    const { runCampaign } = require('../utils/dripRunner');
    await runCampaign(camp._id);

    const fresh = await DripCampaign.findById(camp._id);
    assert.equal(fresh.stats.sent, 1, 'se envía igual');
    assert.deepEqual(bodyParams(gw.sent[0]), ['-']);
  } finally {
    gw.restore();
    await H.resetDb();
  }
});

test('goteo por Cloud API: una plantilla SIN variables no manda parámetros', async () => {
  // Mandar parámetros a una plantilla que no los tiene es el error #132000.
  const { clinicId, userId } = await H.seedClinic();
  const gw = fakeGateway();
  try {
    const tpl = await seedCloudTemplate(clinicId, 'Promo de julio, escríbenos.');
    tpl.variables = [];
    await tpl.save();
    await Contact.create({ clinic: clinicId, phone: '593999000001', firstName: 'Emily' });
    const camp = await DripCampaign.create({
      clinic: clinicId, name: 'Promo', template: tpl._id, templateName: 'promo_julio',
      templateLanguage: 'es', templateVars: [],
      batchSize: 10, intervalMinutes: 15, hourFrom: '00:00', hourTo: '23:59',
      status: 'running', nextRunAt: new Date(), createdBy: userId,
    });

    const { runCampaign } = require('../utils/dripRunner');
    await runCampaign(camp._id);

    assert.equal(gw.sent.length, 1);
    assert.deepEqual(bodyParams(gw.sent[0]), [], 'sin parámetros de cuerpo');
  } finally {
    gw.restore();
    await H.resetDb();
  }
});

test('goteo por Cloud API: un texto fijo va igual para todos, el nombre no', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const gw = fakeGateway();
  try {
    const tpl = await seedCloudTemplate(clinicId, 'Hola {{nombre}}, usa el código {{promo}}');
    tpl.variables = [{ key: 'nombre', example: 'María' }, { key: 'promo', example: 'XXX' }];
    await tpl.save();
    await Contact.create([
      { clinic: clinicId, phone: '593999000001', firstName: 'Emily' },
      { clinic: clinicId, phone: '593999000002', firstName: 'Ana' },
    ]);
    const camp = await DripCampaign.create({
      clinic: clinicId, name: 'Promo', template: tpl._id, templateName: 'promo_julio',
      templateLanguage: 'es',
      templateVars: [{ key: 'nombre', source: 'nombre' }, { key: 'promo', source: 'fixed', fixed: 'JULIO20' }],
      batchSize: 10, intervalMinutes: 15, hourFrom: '00:00', hourTo: '23:59',
      status: 'running', nextRunAt: new Date(), createdBy: userId,
    });

    const { runCampaign } = require('../utils/dripRunner');
    await runCampaign(camp._id);

    const params = gw.sent.map((s) => bodyParams(s)).sort((a, b) => a[0].localeCompare(b[0]));
    assert.deepEqual(params, [['Ana', 'JULIO20'], ['Emily', 'JULIO20']]);
  } finally {
    gw.restore();
    await H.resetDb();
  }
});
