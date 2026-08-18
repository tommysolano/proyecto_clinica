/**
 * «EL BOTÓN NO LLEGÓ AL PACIENTE».
 *
 * Por Cloud API una plantilla se manda POR NOMBRE: el cuerpo y los botones que
 * ve el paciente son los de la versión aprobada EN META, no los de nuestra copia.
 * El editor, sin embargo, dejaba agregarle un botón a una plantilla ya registrada
 * y lo guardaba solo aquí. Resultado: el editor y la burbuja del chat enseñaban
 * un botón que Meta no conocía y que el paciente nunca recibía, sin ningún aviso.
 *
 * Aquí se cubre lo que cierra ese agujero:
 *   1) cambiar el contenido de una plantilla registrada se le ENVÍA a Meta;
 *   2) si Meta lo rechaza, no se guarda nada (nada de divergencias a medias);
 *   3) la sincronización borra los botones fantasma que quedaron de antes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const MessageTemplate = require('../models/MessageTemplate');
const WhatsappAccount = require('../models/WhatsappAccount');
const ctrl = require('../controllers/messageTemplateController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

/** Número Cloud API por defecto: sin él no hay a quién pedirle la edición. */
const numeroApi = () => WhatsappAccount.create({
  label: 'API', connectionType: 'cloud_api', enabled: true, isDefault: true,
  phoneNumberId: '111', businessAccountId: 'waba1', accessToken: 'tok',
});

/** Sustituye `fetch` para no llamar a Meta y poder mirar lo que se le mandó. */
function fakeFetch(responder) {
  const orig = global.fetch;
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: String(url), method: opts.method, body });
    const r = responder({ url: String(url), body }) || {};
    return {
      ok: r.ok !== false,
      status: r.status || (r.ok === false ? 400 : 200),
      json: async () => r.data || {},
    };
  };
  return { calls, restore: () => { global.fetch = orig; } };
}

const plantillaRegistrada = (clinicId, extra = {}) => MessageTemplate.create({
  clinic: clinicId,
  channel: 'whatsapp',
  name: '24h_flujo',
  language: 'es',
  category: 'UTILITY',
  status: 'approved',
  body: '¿Asistirás mañana a tu cita?',
  metaTemplateId: '900111',
  ...extra,
});

const reqUpdate = (clinicId, userId, id, body) => ({
  ...H.mockReq(clinicId, userId, body),
  params: { id: String(id) },
});

// ─────────────────────────────────────────────────────────────────────────────
test('agregar un botón a una plantilla registrada SE LE ENVÍA a Meta y vuelve a revisión', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await numeroApi();
  const tpl = await plantillaRegistrada(clinicId);
  const f = fakeFetch(() => ({ ok: true, data: { success: true } }));

  try {
    const r = await H.runController(
      ctrl.update,
      reqUpdate(clinicId, userId, tpl._id, {
        body: '¿Asistirás mañana a tu cita?',
        buttons: [{ type: 'quick_reply', text: 'Si asistire' }],
      })
    );

    assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
    // Se editó la plantilla POR SU ID, no se creó otra en la lista de la WABA.
    const edicion = f.calls.find((c) => c.url.includes('/900111'));
    assert.ok(edicion, `no se llamó a Meta: ${JSON.stringify(f.calls.map((c) => c.url))}`);
    assert.equal(edicion.method, 'POST');
    const botones = edicion.body.components.find((c) => c.type === 'BUTTONS');
    assert.deepEqual(botones.buttons, [{ type: 'QUICK_REPLY', text: 'Si asistire' }]);

    // Hasta que Meta la apruebe, sale la versión anterior: por eso queda 'pending'.
    const guardada = await MessageTemplate.findById(tpl._id).lean();
    assert.equal(guardada.status, 'pending');
    assert.equal(guardada.buttons.length, 1);
  } finally {
    f.restore();
  }
});

test('si Meta rechaza el cambio, la plantilla queda EXACTAMENTE como estaba', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await numeroApi();
  const tpl = await plantillaRegistrada(clinicId);
  const f = fakeFetch(() => ({ ok: false, data: { error: { error_user_msg: 'Solo 1 edición al día' } } }));

  try {
    const r = await H.runController(
      ctrl.update,
      reqUpdate(clinicId, userId, tpl._id, { buttons: [{ type: 'quick_reply', text: 'Si asistire' }] })
    );

    assert.equal(r.statusCode, 502);
    assert.match(r.payload.message, /Solo 1 edición al día/);
    const guardada = await MessageTemplate.findById(tpl._id).lean();
    assert.equal(guardada.buttons.length, 0, 'no puede quedar un botón que Meta no aceptó');
    assert.equal(guardada.status, 'approved');
  } finally {
    f.restore();
  }
});

test('mientras Meta la revisa no se deja cambiar el contenido', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await numeroApi();
  const tpl = await plantillaRegistrada(clinicId, { status: 'pending' });
  const f = fakeFetch(() => ({ ok: true }));

  try {
    const r = await H.runController(
      ctrl.update,
      reqUpdate(clinicId, userId, tpl._id, { buttons: [{ type: 'quick_reply', text: 'Si asistire' }] })
    );

    assert.equal(r.statusCode, 400);
    assert.match(r.payload.message, /revisando/i);
    assert.equal(f.calls.length, 0, 'ni siquiera se molesta a Meta');
  } finally {
    f.restore();
  }
});

test('lo que NO gobierna Meta se guarda sin molestarla', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await numeroApi();
  const tpl = await plantillaRegistrada(clinicId);
  const f = fakeFetch(() => ({ ok: true }));

  try {
    // Mismo contenido (los botones vienen igual de vacíos) + un campo nuestro.
    const r = await H.runController(
      ctrl.update,
      reqUpdate(clinicId, userId, tpl._id, { body: '¿Asistirás mañana a tu cita?', buttons: [], folder: '/Recordatorios' })
    );

    assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
    assert.equal(f.calls.length, 0, 'sin cambio de contenido no hay nada que mandar');
    const guardada = await MessageTemplate.findById(tpl._id).lean();
    assert.equal(guardada.status, 'approved', 'no debe volver a revisión por nada');
  } finally {
    f.restore();
  }
});

test('un borrador (aún sin registrar) se sigue editando solo aquí', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const tpl = await MessageTemplate.create({
    clinic: clinicId, channel: 'whatsapp', name: 'borrador_1', status: 'draft', body: 'Hola',
  });
  const f = fakeFetch(() => ({ ok: true }));

  try {
    const r = await H.runController(
      ctrl.update,
      reqUpdate(clinicId, userId, tpl._id, { body: 'Hola de nuevo', buttons: [{ type: 'quick_reply', text: 'Ok' }] })
    );

    assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
    assert.equal(f.calls.length, 0);
    const guardada = await MessageTemplate.findById(tpl._id).lean();
    assert.equal(guardada.body, 'Hola de nuevo');
    assert.equal(guardada.status, 'draft');
  } finally {
    f.restore();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
test('la sincronización con Meta borra los botones fantasma', async () => {
  const { clinicId } = await H.seedClinic();
  // Así quedaron las plantillas de antes del arreglo: con un botón que solo
  // existía en nuestra base.
  await plantillaRegistrada(clinicId, { buttons: [{ type: 'quick_reply', text: 'Fantasma' }] });

  await ctrl.applyMetaTemplate(clinicId, {
    name: '24h_flujo',
    status: 'APPROVED',
    category: 'UTILITY',
    language: 'es',
    id: '900111',
    components: [{ type: 'BODY', text: '¿Asistirás mañana a tu cita?' }],
  });

  const guardada = await MessageTemplate.findOne({ clinic: clinicId, name: '24h_flujo' }).lean();
  assert.deepEqual(guardada.buttons, [], 'si Meta no tiene botones, nosotros tampoco');
});

test('la sincronización sí trae los botones que Meta sí tiene', async () => {
  const { clinicId } = await H.seedClinic();
  await plantillaRegistrada(clinicId);

  await ctrl.applyMetaTemplate(clinicId, {
    name: '24h_flujo',
    status: 'APPROVED',
    category: 'UTILITY',
    language: 'es',
    id: '900111',
    components: [
      { type: 'BODY', text: '¿Asistirás mañana a tu cita?' },
      { type: 'BUTTONS', buttons: [
        { type: 'QUICK_REPLY', text: 'Si asistire' },
        { type: 'URL', text: 'Ubicación', url: 'https://maps.example/clinica' },
      ] },
    ],
  });

  const guardada = await MessageTemplate.findOne({ clinic: clinicId, name: '24h_flujo' }).lean();
  assert.deepEqual(
    guardada.buttons.map((b) => [b.type, b.text, b.url]),
    [['quick_reply', 'Si asistire', ''], ['url', 'Ubicación', 'https://maps.example/clinica']]
  );
});
