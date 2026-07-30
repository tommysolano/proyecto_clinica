/**
 * Bandeja de notificaciones del header (la campana) y chequeo diario de plantillas:
 *  - Meta recategoriza una plantilla (UTILITY → MARKETING) y la alerta aparece en
 *    la bandeja, sin entrar a la página de Plantillas.
 *  - La notificación se guarda bajo la clínica ANCLA del CRM: se ve igual desde
 *    cualquier sucursal activa.
 *  - Cada rol ve solo los tipos que le corresponden (un doctor: bandeja vacía).
 *  - El chequeo diario deja constancia de la verificación y avisa UNA vez si Meta
 *    no responde.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const notifications = require('../controllers/notificationController');
const templates = require('../controllers/messageTemplateController');
const dailyCheck = require('../utils/templateDailyCheck');
const CallCenterWhatsappConfig = require('../models/CallCenterWhatsappConfig');
const WhatsappAccount = require('../models/WhatsappAccount');
const MessageTemplate = require('../models/MessageTemplate');
const Notification = require('../models/Notification');
const { clearCache } = require('../utils/callCenterClinic');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); clearCache(); });

/** Clínica ancla del CRM (donde caen las alertas de plantillas). */
async function seedAnchor() {
  const clinicId = new H.mongoose.Types.ObjectId();
  const cfg = await CallCenterWhatsappConfig.getSingleton();
  cfg.callCenterClinic = clinicId;
  await cfg.save();
  clearCache();
  return clinicId;
}

const listFor = async (clinicId, role, { isSuperAdmin = false } = {}) => {
  const req = H.mockReq(clinicId, new H.mongoose.Types.ObjectId(), {}, { role });
  if (isSuperAdmin) req.user.isSuperAdmin = true;
  const res = await H.runController(notifications.list, req);
  assert.equal(res.statusCode, 200);
  return res.payload;
};

test('el cambio de categoría de Meta llega a la bandeja del header', async () => {
  const clinicId = await seedAnchor();
  await MessageTemplate.create({
    clinic: clinicId, channel: 'whatsapp', name: 'recordatorio_cita',
    body: 'Hola {{nombre}}', category: 'UTILITY', status: 'approved',
  });

  // Meta devuelve la misma plantilla, ahora como MARKETING.
  const r = await templates.applyMetaTemplate(clinicId, {
    name: 'recordatorio_cita',
    status: 'APPROVED',
    category: 'MARKETING',
    language: 'es',
    components: [{ type: 'BODY', text: 'Hola {{1}}' }],
  });
  assert.equal(r.changed, true);

  const { items, unread } = await listFor(clinicId, 'admin');
  assert.equal(unread, 1);
  assert.equal(items.length, 1);
  const n = items[0];
  assert.equal(n.type, 'template_category_changed');
  // Pasar a MARKETING encarece cada mensaje: se avisa como error, no como info.
  assert.equal(n.severity, 'error');
  assert.match(n.title, /recordatorio_cita/);
  assert.match(n.body, /INCREMENTA el costo/);
  assert.equal(n.meta.from, 'UTILITY');
  assert.equal(n.meta.to, 'MARKETING');
  assert.equal(n.read, false);

  // Y la plantilla local quedó con la categoría nueva.
  const tpl = await MessageTemplate.findOne({ clinic: clinicId, name: 'recordatorio_cita' });
  assert.equal(tpl.category, 'MARKETING');
});

test('se ve desde otra sucursal activa (la alerta vive en la clínica del CRM)', async () => {
  const anchor = await seedAnchor();
  await Notification.create({
    clinic: anchor, type: 'template_category_changed', severity: 'error',
    title: 'Plantilla "x" cambió de categoría a MARKETING',
  });

  // Un admin con OTRA sucursal activa: la campana es la misma en toda la app.
  const otraSucursal = new H.mongoose.Types.ObjectId();
  const { items, unread } = await listFor(otraSucursal, 'admin');
  assert.equal(unread, 1);
  assert.equal(items.length, 1);
});

test('las notificaciones de marketing SOLO las ven admin y marketing', async () => {
  const clinicId = await seedAnchor();
  await Notification.create({ clinic: clinicId, type: 'template_category_changed', severity: 'error', title: 'plantilla' });
  await Notification.create({ clinic: clinicId, type: 'whatsapp_quality_changed', severity: 'warning', title: 'calidad' });

  for (const role of ['admin', 'marketing']) {
    // eslint-disable-next-line no-await-in-loop
    const r = await listFor(clinicId, role);
    assert.equal(r.items.length, 2, `${role} debe ver las dos`);
    assert.equal(r.unread, 2);
  }

  // El resto de roles NO las ve: bandeja vacía y contador en 0, nunca un error.
  for (const role of ['call_center', 'cajero', 'doctor', 'contabilidad', 'enfermero']) {
    // eslint-disable-next-line no-await-in-loop
    const r = await listFor(clinicId, role);
    assert.deepEqual(r.items, [], `${role} no debe ver notificaciones de marketing`);
    assert.equal(r.unread, 0);
  }

  // El super-admin lo ve todo, tenga el rol que tenga.
  const su = await listFor(clinicId, 'doctor', { isSuperAdmin: true });
  assert.equal(su.items.length, 2);
});

test('marcar como leída (una y todas) baja el contador', async () => {
  const clinicId = await seedAnchor();
  const a = await Notification.create({ clinic: clinicId, type: 'template_category_changed', severity: 'error', title: 'a' });
  await Notification.create({ clinic: clinicId, type: 'template_status_changed', severity: 'warning', title: 'b' });
  const userId = new H.mongoose.Types.ObjectId();

  const one = await H.runController(
    notifications.markRead,
    H.mockReq(clinicId, userId, {}, { role: 'admin', params: { id: String(a._id) } })
  );
  assert.equal(one.statusCode, 200);
  assert.equal(one.payload.read, true);
  assert.equal((await listFor(clinicId, 'admin')).unread, 1);

  const all = await H.runController(
    notifications.markAllRead,
    H.mockReq(clinicId, userId, {}, { role: 'admin' })
  );
  assert.equal(all.payload.updated, 1);
  assert.equal((await listFor(clinicId, 'admin')).unread, 0);
  // Las leídas siguen en la lista (historial), solo dejan de contar.
  assert.equal((await listFor(clinicId, 'admin')).items.length, 2);
});

test('un doctor no puede marcar como leída una notificación que no ve', async () => {
  const clinicId = await seedAnchor();
  const n = await Notification.create({ clinic: clinicId, type: 'template_category_changed', severity: 'error', title: 'a' });
  const res = await H.runController(
    notifications.markRead,
    H.mockReq(clinicId, new H.mongoose.Types.ObjectId(), {}, { role: 'doctor', params: { id: String(n._id) } })
  );
  assert.equal(res.statusCode, 404);
  assert.equal((await Notification.findById(n._id)).read, false);
});

test('el chequeo diario deja constancia y avisa UNA vez si Meta no responde', async () => {
  const clinicId = await seedAnchor();
  await WhatsappAccount.create({
    label: 'Principal', connectionType: 'cloud_api', phoneNumberId: '111',
    businessAccountId: 'waba1', accessToken: 'token-x', isDefault: true,
  });

  const origFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 500,
    json: async () => ({ error: { message: 'Error validating access token' } }),
  });
  try {
    const first = await dailyCheck.runDailyTemplateCheck();
    assert.equal(first.ok, false);

    // Queda la marca de "se intentó verificar" con el motivo del fallo.
    const cfg = await CallCenterWhatsappConfig.getSingleton();
    assert.ok(cfg.templateCheck.at, 'debe guardar cuándo se verificó');
    assert.equal(cfg.templateCheck.ok, false);
    assert.match(cfg.templateCheck.error, /access token/);

    // Y una (1) notificación en la campana.
    const after1 = await listFor(clinicId, 'admin');
    assert.equal(after1.items.length, 1);
    assert.equal(after1.items[0].type, 'template_check_failed');

    // Al día siguiente el token sigue mal: no se repite el aviso (la campana no
    // se llena de la misma alerta).
    await dailyCheck.runDailyTemplateCheck();
    assert.equal((await listFor(clinicId, 'admin')).items.length, 1);
  } finally {
    global.fetch = origFetch;
  }
});

test('sin número Cloud API configurado no molesta con avisos', async () => {
  const clinicId = await seedAnchor();
  const r = await dailyCheck.runDailyTemplateCheck();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_configured');
  assert.deepEqual((await listFor(clinicId, 'admin')).items, []);
});

test('el chequeo se programa a las 8:00 de Ecuador', () => {
  const ms = dailyCheck.msUntilNextCheck();
  assert.ok(ms > 0 && ms <= 24 * 60 * 60 * 1000, `esperado dentro de 24h, fue ${ms}`);
  // La hora a la que caerá, en Ecuador, es la configurada.
  const target = new Date(Date.now() + ms);
  const hourEc = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Guayaquil', hour: '2-digit', hour12: false })
      .format(target)
      .slice(0, 2)
  );
  assert.equal(hourEc, dailyCheck.CHECK_HOUR_EC);
});
