/**
 * Motor de importación de contactos, de punta a punta contra Mongo: archivo real
 * → contactos en la base, con sus modos (crear/actualizar/ambos), la
 * deduplicación por teléfono y el deshacer.
 *
 * Es lo que de verdad se juega con 47k filas: que no se dupliquen contactos, que
 * reimportar no borre datos y que una importación mal hecha se pueda revertir.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const H = require('./_integrationHelpers');

const Contact = require('../models/Contact');
const ContactImport = require('../models/ContactImport');
const ContactGroup = require('../models/ContactGroup');
const Patient = require('../models/Patient');
const { runImport, revertImport } = require('../utils/contactImportRunner');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const MAPPING = [
  { column: 'Nombre', field: 'displayName', skipEmpty: true },
  { column: 'Celular', field: 'phone', skipEmpty: true },
  { column: 'Correo', field: 'email', skipEmpty: true },
  { column: 'Ciudad', field: 'custom:ciudad', skipEmpty: true },
];

function writeCsv(rows, name = 'c.csv') {
  const file = path.join(os.tmpdir(), `imp_${Date.now()}_${Math.random().toString(36).slice(2)}_${name}`);
  fs.writeFileSync(file, rows.map((r) => r.join(',')).join('\n'), 'utf8');
  return file;
}

async function makeBatch(clinicId, userId, file, extra = {}) {
  return ContactImport.create({
    clinic: clinicId,
    fileName: 'c.csv',
    filePath: file,
    status: 'pending',
    mapping: MAPPING,
    createdBy: userId,
    ...extra,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
test('importa un CSV: crea contactos con el teléfono normalizado y las etiquetas del lote', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const file = writeCsv([
    ['Nombre', 'Celular', 'Correo', 'Ciudad'],
    ['Ligia Farfán', '0999111222', 'ligia@x.com', 'Guayaquil'],
    ['Dome', '+593 98 877 6655', '', 'Quito'],
  ]);
  const batch = await makeBatch(clinicId, userId, file, { tags: ['feria-julio'] });

  await runImport(batch._id);
  const done = await ContactImport.findById(batch._id);
  assert.equal(done.status, 'done', done.errorMessage);
  assert.equal(done.created, 2);
  assert.equal(done.failed, 0);

  const ligia = await Contact.findOne({ clinic: clinicId, phone: '593999111222' });
  assert.equal(ligia.displayName, 'Ligia Farfán');
  assert.equal(ligia.firstName, 'Ligia');
  assert.equal(ligia.email, 'ligia@x.com');
  assert.equal(ligia.customFields.get('ciudad'), 'Guayaquil');
  assert.deepEqual(ligia.tags, ['feria-julio']);
  assert.equal(ligia.source, 'import');
  assert.equal(ligia.marketing.whatsappOptIn, true);
  // Las dos formas del número acabaron en E.164.
  assert.ok(await Contact.findOne({ clinic: clinicId, phone: '593988776655' }));

  // El archivo temporal se limpia al terminar.
  assert.equal(fs.existsSync(file), false);
});

// ─────────────────────────────────────────────────────────────────────────────
test('columna Sucursal: cada contacto cae en SU sede; nombre no reconocido → sede por defecto', async () => {
  const { clinicId, userId } = await H.seedClinic(); // sede por defecto del asistente
  const Clinic = require('../models/Clinic');
  const quito = await Clinic.create({ name: 'Quito' });
  const gye = await Clinic.create({ name: 'Guayaquil' });

  const file = writeCsv([
    ['Nombre', 'Celular', 'Sucursal'],
    ['Ana', '0999111222', 'Quito'],
    ['Beto', '0988776655', 'GUAYAQUIL'], // mayúsculas: se resuelve igual
    ['Caro', '0977665544', 'Cuenca'], // no existe → cae en la sede por defecto
  ]);
  const batch = await ContactImport.create({
    clinic: clinicId, fileName: 'c.csv', filePath: file, status: 'pending', createdBy: userId,
    mapping: [
      { column: 'Nombre', field: 'displayName' },
      { column: 'Celular', field: 'phone' },
      { column: 'Sucursal', field: 'clinic' },
    ],
  });
  await runImport(batch._id);

  const done = await ContactImport.findById(batch._id);
  assert.equal(done.status, 'done', done.errorMessage);
  assert.equal(done.created, 3);

  assert.equal(String((await Contact.findOne({ phone: '593999111222' })).clinic), String(quito._id));
  assert.equal(String((await Contact.findOne({ phone: '593988776655' })).clinic), String(gye._id));
  // Sucursal desconocida → sede por defecto del asistente (batch.clinic).
  assert.equal(String((await Contact.findOne({ phone: '593977665544' })).clinic), String(clinicId));
});

// ─────────────────────────────────────────────────────────────────────────────
test('columna Sucursal + workflow: la inscripción lleva la sede en context.eventClinicId', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const Clinic = require('../models/Clinic');
  const gye = await Clinic.create({ name: 'Guayaquil' });
  const wf = await makeImportWorkflow(clinicId);

  const file = writeCsv([
    ['Nombre', 'Celular', 'Sucursal'],
    ['Ana', '0999111222', 'Guayaquil'],
  ]);
  const batch = await ContactImport.create({
    clinic: clinicId, fileName: 'c.csv', filePath: file, status: 'pending', createdBy: userId,
    workflows: [wf._id],
    mapping: [
      { column: 'Nombre', field: 'displayName' },
      { column: 'Celular', field: 'phone' },
      { column: 'Sucursal', field: 'clinic' },
    ],
  });
  await runImport(batch._id);

  const e = await WorkflowEnrollment.findOne({ workflow: wf._id });
  assert.ok(e, 'se inscribió el contacto importado');
  assert.equal(String(e.context.eventClinicId), String(gye._id), 'la sede del Excel viaja en el contexto para bifurcar');
  // La inscripción corre en la clínica del asistente (contexto de mensajería), sin cambios.
  assert.equal(String(e.clinic), String(clinicId));
});

// ─────────────────────────────────────────────────────────────────────────────
test('reimportar el mismo archivo NO duplica: actualiza por teléfono', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const f1 = writeCsv([['Nombre', 'Celular', 'Correo', 'Ciudad'], ['Ligia', '0999111222', 'v1@x.com', 'Guayaquil']]);
  await runImport((await makeBatch(clinicId, userId, f1))._id);

  // Mismo número escrito de otra forma y con el correo cambiado.
  const f2 = writeCsv([['Nombre', 'Celular', 'Correo', 'Ciudad'], ['Ligia', '+593999111222', 'v2@x.com', 'Guayaquil']]);
  const b2 = await makeBatch(clinicId, userId, f2);
  await runImport(b2._id);

  assert.equal(await Contact.countDocuments({ clinic: clinicId }), 1);
  const done = await ContactImport.findById(b2._id);
  assert.equal(done.created, 0);
  assert.equal(done.updated, 1);
  assert.equal((await Contact.findOne({ phone: '593999111222' })).email, 'v2@x.com');
});

// ─────────────────────────────────────────────────────────────────────────────
test('reimportar sin una columna NO borra el dato que ya tenía', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const f1 = writeCsv([['Nombre', 'Celular', 'Correo', 'Ciudad'], ['Ligia', '0999111222', 'ligia@x.com', 'Guayaquil']]);
  await runImport((await makeBatch(clinicId, userId, f1))._id);

  // Archivo nuevo sin correo: la celda vacía no debe pisar el correo bueno.
  const f2 = writeCsv([['Nombre', 'Celular', 'Correo', 'Ciudad'], ['Ligia Farfán', '0999111222', '', 'Guayaquil']]);
  await runImport((await makeBatch(clinicId, userId, f2))._id);

  const c = await Contact.findOne({ phone: '593999111222' });
  assert.equal(c.email, 'ligia@x.com', 'el correo no se debe perder');
  assert.equal(c.displayName, 'Ligia Farfán', 'el nombre sí se actualiza');
});

// ─────────────────────────────────────────────────────────────────────────────
test('las filas malas no tumban la importación: se cuentan y se explican', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const file = writeCsv([
    ['Nombre', 'Celular', 'Correo', 'Ciudad'],
    ['Buena', '0999111222', '', ''],
    ['Sin teléfono', '', '', ''],
    ['Ilegible', '12345', '', ''],
    ['Otra buena', '0988776655', '', ''],
  ]);
  const batch = await makeBatch(clinicId, userId, file);
  await runImport(batch._id);

  const done = await ContactImport.findById(batch._id);
  assert.equal(done.status, 'done');
  assert.equal(done.created, 2);
  assert.equal(done.failed, 2);
  assert.equal(await Contact.countDocuments({ clinic: clinicId }), 2);

  const motivos = done.rowErrors.map((e) => e.reason).join(' | ');
  assert.match(motivos, /sin teléfono/);
  assert.equal(done.rowErrors.find((e) => e.value === '12345').row, 4); // fila real del Excel
});

// ─────────────────────────────────────────────────────────────────────────────
test('un número repetido DENTRO del archivo se importa una sola vez', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const file = writeCsv([
    ['Nombre', 'Celular', 'Correo', 'Ciudad'],
    ['Ligia', '0999111222', '', ''],
    ['Ligia otra vez', '+593999111222', '', ''], // el mismo número, otra forma
  ]);
  const batch = await makeBatch(clinicId, userId, file);
  await runImport(batch._id);

  assert.equal(await Contact.countDocuments({ clinic: clinicId }), 1);
  const done = await ContactImport.findById(batch._id);
  assert.equal(done.created, 1);
  assert.equal(done.skipped, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
test('modo "solo crear": no toca los contactos que ya existen', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await Contact.create({ clinic: clinicId, phone: '593999111222', email: 'original@x.com' });

  const file = writeCsv([
    ['Nombre', 'Celular', 'Correo', 'Ciudad'],
    ['Ligia', '0999111222', 'nuevo@x.com', ''],
    ['Dome', '0988776655', 'dome@x.com', ''],
  ]);
  const batch = await makeBatch(clinicId, userId, file, { mode: 'create' });
  await runImport(batch._id);

  const done = await ContactImport.findById(batch._id);
  assert.equal(done.created, 1);
  assert.equal(done.skipped, 1);
  assert.equal((await Contact.findOne({ phone: '593999111222' })).email, 'original@x.com');
});

// ─────────────────────────────────────────────────────────────────────────────
test('modo "solo actualizar": no crea contactos nuevos', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await Contact.create({ clinic: clinicId, phone: '593999111222', email: 'viejo@x.com' });

  const file = writeCsv([
    ['Nombre', 'Celular', 'Correo', 'Ciudad'],
    ['Ligia', '0999111222', 'nuevo@x.com', ''],
    ['Desconocido', '0977665544', 'x@x.com', ''],
  ]);
  const batch = await makeBatch(clinicId, userId, file, { mode: 'update' });
  await runImport(batch._id);

  assert.equal(await Contact.countDocuments({ clinic: clinicId }), 1);
  assert.equal((await Contact.findOne({ phone: '593999111222' })).email, 'nuevo@x.com');
  const done = await ContactImport.findById(batch._id);
  assert.equal(done.updated, 1);
  assert.equal(done.skipped, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
test('el opt-in del lote solo aplica al CREAR: no le resucita el consentimiento a quien se dio de baja', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await Contact.create({
    clinic: clinicId,
    phone: '593999111222',
    marketing: { whatsappOptIn: false, optOutAt: new Date(), optOutReason: 'pidió no recibir' },
  });

  const file = writeCsv([['Nombre', 'Celular', 'Correo', 'Ciudad'], ['Ligia', '0999111222', '', '']]);
  const batch = await makeBatch(clinicId, userId, file, { whatsappOptIn: true, consentSource: 'feria' });
  await runImport(batch._id);

  const c = await Contact.findOne({ phone: '593999111222' });
  assert.equal(c.marketing.whatsappOptIn, false, 'una reimportación no puede reactivar el opt-in');
  assert.ok(c.marketing.optOutAt, 'la baja se mantiene');
});

// ─────────────────────────────────────────────────────────────────────────────
test('asigna el grupo (lista fija) del lote a todo lo importado', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const grupo = await ContactGroup.create({ clinic: clinicId, name: 'Feria Julio', kind: 'static' });
  const file = writeCsv([['Nombre', 'Celular', 'Correo', 'Ciudad'], ['Ligia', '0999111222', '', '']]);
  await runImport((await makeBatch(clinicId, userId, file, { groups: [grupo._id] }))._id);

  const c = await Contact.findOne({ phone: '593999111222' });
  assert.equal(String(c.groups[0]), String(grupo._id));
});

// ─────────────────────────────────────────────────────────────────────────────
test('deshacer: borra lo que creó el lote, pero respeta a los que ya son pacientes', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const file = writeCsv([
    ['Nombre', 'Celular', 'Correo', 'Ciudad'],
    ['Ligia', '0999111222', '', ''],
    ['Dome', '0988776655', '', ''],
  ]);
  const batch = await makeBatch(clinicId, userId, file, { tags: ['feria-julio'] });
  await runImport(batch._id);

  // Entre medias, Ligia agendó y se convirtió en paciente.
  const paciente = await Patient.create({ clinic: clinicId, firstName: 'Ligia', lastName: 'Farfán', cedula: '0912345678' });
  await Contact.updateOne({ phone: '593999111222' }, { $set: { patient: paciente._id, convertedAt: new Date() } });

  const r = await revertImport(batch._id);
  assert.equal(r.ok, true);
  assert.equal(r.deleted, 1, 'solo se borra el que no llegó a paciente');

  // Dome se fue; Ligia se queda (es paciente) pero pierde la etiqueta del lote.
  assert.equal(await Contact.findOne({ phone: '593988776655' }), null);
  const ligia = await Contact.findOne({ phone: '593999111222' });
  assert.ok(ligia, 'un contacto que ya es paciente NO se borra al deshacer');
  assert.deepEqual(ligia.tags, []);
  assert.equal((await ContactImport.findById(batch._id)).status, 'reverted');
});

// ─────────────────────────────────────────────────────────────────────────────
test('un lote solo se procesa una vez (dos ticks del job no duplican)', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const file = writeCsv([['Nombre', 'Celular', 'Correo', 'Ciudad'], ['Ligia', '0999111222', '', '']]);
  const batch = await makeBatch(clinicId, userId, file);

  const [a, b] = await Promise.all([runImport(batch._id), runImport(batch._id)]);
  // La garantía es que UNO gana la carrera (findOneAndUpdate atómico) — no CUÁL:
  // bajo carga a veces procesa el segundo. Mismo intermitente que tuvo el goteo.
  assert.ok(!!a !== !!b, 'exactamente un tick procesa el lote; el otro se retira');
  assert.equal(await Contact.countDocuments({ clinic: clinicId }), 1);
});

// ─────────────────────────────────────────────────────────────────────────────
test('importa 1.200 filas por tandas y cuenta bien', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const rows = [['Nombre', 'Celular', 'Correo', 'Ciudad']];
  for (let i = 0; i < 1200; i++) rows.push([`C${i}`, `09${String(90000000 + i)}`, '', '']);
  const batch = await makeBatch(clinicId, userId, writeCsv(rows));

  await runImport(batch._id);
  const done = await ContactImport.findById(batch._id);
  assert.equal(done.status, 'done', done.errorMessage);
  assert.equal(done.created, 1200);
  assert.equal(await Contact.countDocuments({ clinic: clinicId }), 1200);
});

// ─────────── inscripción en workflows al importar ───────────

const Workflow = require('../models/Workflow');
const WorkflowEnrollment = require('../models/WorkflowEnrollment');
const { enrollInWorkflows, nextEnrollSlot } = require('../utils/contactImportRunner');

test('nextEnrollSlot: escalona dentro de la franja 09:00-20:00', () => {
  // A media mañana: avanza 20s y ya.
  const dia = new Date(2026, 6, 17, 10, 0, 0);
  const s1 = nextEnrollSlot(dia);
  assert.equal(s1.getTime() - dia.getTime(), 20 * 1000);

  // De madrugada: salta a las 09:00 del mismo día.
  const noche = new Date(2026, 6, 17, 3, 30, 0);
  const s2 = nextEnrollSlot(noche);
  assert.equal(s2.getHours(), 9);
  assert.equal(s2.getDate(), 17);

  // Pasadas las 20:00: salta a las 09:00 del día siguiente. Nadie quiere el
  // primer mensaje de un workflow a las 3 de la mañana.
  const tarde = new Date(2026, 6, 17, 19, 59, 50);
  const s3 = nextEnrollSlot(tarde);
  assert.equal(s3.getHours(), 9);
  assert.equal(s3.getDate(), 18);
});

async function makeImportWorkflow(clinicId) {
  return Workflow.create({
    clinic: clinicId,
    name: 'Bienvenida importados',
    active: true,
    trigger: { type: 'contact_import' },
    steps: [{ type: 'add_tag', tag: 'importado-saludado' }],
  });
}

test('importar con workflow: inscribe escalonado, en waiting, y respeta el consentimiento', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const wf = await makeImportWorkflow(clinicId);

  // Un contacto que YA existe y está dado de baja: el archivo lo trae, pero no
  // debe entrar al workflow (el motor de workflows no conoce el opt-out de
  // contactos, así que el filtro es responsabilidad de la importación).
  await Contact.create({
    clinic: clinicId,
    phone: '593999000009',
    displayName: 'Baja',
    marketing: { whatsappOptIn: false, optOutAt: new Date() },
  });

  const file = writeCsv([
    ['Nombre', 'Celular', 'Correo', 'Ciudad'],
    ['Ligia', '0999111222', '', ''],
    ['Dome', '0988776655', '', ''],
    ['Baja', '0999000009', '', ''],
  ]);
  const batch = await makeBatch(clinicId, userId, file, { workflows: [wf._id] });
  await runImport(batch._id);

  const done = await ContactImport.findById(batch._id);
  assert.equal(done.status, 'done', done.errorMessage);
  assert.equal(done.enrolled, 2, 'el dado de baja NO se inscribe');

  const enrollments = await WorkflowEnrollment.find({ workflow: wf._id }).sort({ nextRunAt: 1 });
  assert.equal(enrollments.length, 2);
  for (const e of enrollments) {
    // 'waiting', NUNCA 'active': el job de recuperación reintenta cualquier
    // 'active' con >5 min sin avanzar aunque su nextRunAt sea futuro — con
    // 'active' los arranques escalonados saldrían todos de golpe a los 5 min.
    assert.equal(e.status, 'waiting');
    assert.ok(e.nextRunAt > new Date(), 'el arranque queda en el futuro');
    assert.ok(e.context.contactId, 'guarda el contacto');
    assert.equal(e.context.importBatchId, String(batch._id));
  }
  assert.ok(
    enrollments[1].nextRunAt > enrollments[0].nextRunAt,
    'los arranques van escalonados, no en ráfaga'
  );

  const fresh = await Workflow.findById(wf._id);
  assert.equal(fresh.stats.enrolled, 2);
});

test('reinscribir el mismo lote no duplica inscripciones', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const wf = await makeImportWorkflow(clinicId);
  await Contact.create([
    { clinic: clinicId, phone: '593999111222', displayName: 'Ligia', source: 'import' },
    { clinic: clinicId, phone: '593988776655', displayName: 'Dome', source: 'import' },
  ]);
  const batch = await ContactImport.create({
    clinic: clinicId, fileName: 'x.csv', status: 'done',
    mapping: MAPPING, workflows: [wf._id], createdBy: userId,
  });

  const first = await enrollInWorkflows(batch, ['593999111222', '593988776655']);
  assert.equal(first, 2);
  const again = await enrollInWorkflows(batch, ['593999111222', '593988776655']);
  assert.equal(again, 0, 'los ya inscritos (vivos) no se repiten');
  assert.equal(await WorkflowEnrollment.countDocuments({ workflow: wf._id }), 2);
});

test('deshacer la importación cancela las inscripciones pendientes', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const wf = await makeImportWorkflow(clinicId);
  const file = writeCsv([
    ['Nombre', 'Celular', 'Correo', 'Ciudad'],
    ['Ligia', '0999111222', '', ''],
  ]);
  const batch = await makeBatch(clinicId, userId, file, { workflows: [wf._id] });
  await runImport(batch._id);
  assert.equal((await ContactImport.findById(batch._id)).enrolled, 1);

  const r = await revertImport(batch._id);
  assert.equal(r.ok, true);
  assert.equal(r.cancelledEnrollments, 1);
  const e = await WorkflowEnrollment.findOne({ workflow: wf._id });
  assert.equal(e.status, 'cancelled', 'no puede quedar un envío programado de contactos borrados');
});

test('la inscripción de un contacto EJECUTA de verdad: el mensaje sale con el nombre del contacto', async () => {
  // Cierra el círculo completo: importar → inscribir (waiting) → vencer el
  // arranque → el motor envía por el teléfono del contexto, sin paciente, y
  // {{nombre}} se rellena con el CONTACTO (antes salía "Hola " en blanco).
  const { clinicId, userId } = await H.seedClinic();
  const WhatsappAccount = require('../models/WhatsappAccount');
  await WhatsappAccount.create({ label: 'QR', connectionType: 'qr', enabled: true, isDefault: true, status: 'connected' });

  const gw = require('../utils/whatsappGateway');
  const sent = [];
  const orig = gw.sendText;
  gw.sendText = async (account, to, body) => {
    sent.push({ to, body });
    return { ok: true, data: { messages: [{ id: 'wamid.1' }] } };
  };
  try {
    const wf = await Workflow.create({
      clinic: clinicId,
      name: 'Bienvenida importados',
      active: true,
      trigger: { type: 'contact_import' },
      steps: [{ type: 'send_message', body: 'Hola {{nombre}}, gracias por tu interés' }],
    });
    const file = writeCsv([
      ['Nombre', 'Celular', 'Correo', 'Ciudad'],
      ['Ligia Farfán', '0999111222', '', ''],
    ]);
    const batch = await makeBatch(clinicId, userId, file, { workflows: [wf._id] });
    await runImport(batch._id);

    // Vencer el arranque escalonado y dejar que el job lo ejecute (el mismo
    // camino que en producción: processDueEnrollments cada minuto).
    await WorkflowEnrollment.updateMany({ workflow: wf._id }, { $set: { nextRunAt: new Date(Date.now() - 1000) } });
    const engine = require('../utils/workflowEngine');
    await engine.processDueEnrollments();

    assert.equal(sent.length, 1, 'el mensaje salió');
    assert.equal(sent[0].to, '593999111222');
    assert.equal(sent[0].body, 'Hola Ligia, gracias por tu interés', 'el nombre viene del CONTACTO, no queda en blanco');

    const e = await WorkflowEnrollment.findOne({ workflow: wf._id });
    assert.equal(e.status, 'done');
  } finally {
    gw.sendText = orig;
  }
});

test('un lote atascado en running (deploy a mitad) se rescata y termina', async () => {
  // Un pm2 restart en plena importación dejaba el lote en 'running' PARA SIEMPRE:
  // el job solo miraba los 'pending'. Ahora, 5 min sin guardar = muerto → vuelve
  // a 'pending' y se reprocesa desde cero (upserts: no duplica).
  const { clinicId, userId } = await H.seedClinic();
  const file = writeCsv([
    ['Nombre', 'Celular', 'Correo', 'Ciudad'],
    ['Ligia', '0999111222', '', ''],
  ]);
  const batch = await makeBatch(clinicId, userId, file, { status: 'running', startedAt: new Date() });

  // Antedatar updatedAt exige el driver nativo: mongoose lo protege y lo
  // descarta en silencio de un $set (el resto del $set sí se aplica).
  await H.mongoose.connection.db
    .collection('contactimports')
    .updateOne({ _id: batch._id }, { $set: { updatedAt: new Date(Date.now() - 10 * 60 * 1000) } });

  const { processPendingImports } = require('../utils/contactImportRunner');
  await processPendingImports();

  const done = await ContactImport.findById(batch._id);
  assert.equal(done.status, 'done', done.errorMessage);
  assert.equal(done.created, 1);
  assert.ok(await Contact.findOne({ clinic: clinicId, phone: '593999111222' }));
});

test('un lote de OTRA máquina no se toca: su archivo no está en este disco', async () => {
  // Caso real: un server de desarrollo local conectado a la base de producción
  // corría los mismos jobs, agarraba los lotes del VPS y los mataba con "el
  // archivo ya no está en el servidor" (buscaba rutas de Linux en Windows).
  const { clinicId, userId } = await H.seedClinic();
  const file = writeCsv([
    ['Nombre', 'Celular', 'Correo', 'Ciudad'],
    ['Ligia', '0999111222', '', ''],
  ]);
  const batch = await makeBatch(clinicId, userId, file, { host: 'vps-produccion' });

  const { runImport, processPendingImports } = require('../utils/contactImportRunner');
  assert.equal(await runImport(batch._id), null, 'runImport directo tampoco lo procesa');
  await processPendingImports();

  const fresh = await ContactImport.findById(batch._id);
  assert.equal(fresh.status, 'pending', 'queda esperando a SU máquina, no falla');

  // El mismo lote con el host de esta máquina sí se procesa.
  fresh.host = require('os').hostname();
  await fresh.save();
  await processPendingImports();
  assert.equal((await ContactImport.findById(batch._id)).status, 'done');
});

test('QR caído: el workflow NO quema el turno — reintenta y envía cuando el número vuelve', async () => {
  // Caso real: una importación inscribió sus contactos mientras la sesión QR se
  // re-asentaba tras un deploy; los envíos quedaron "fallido" PARA SIEMPRE con
  // el número ya verde. Un fallo de canal es transitorio: se reintenta.
  const { clinicId, userId } = await H.seedClinic();
  const WhatsappAccount = require('../models/WhatsappAccount');
  await WhatsappAccount.create({ label: 'QR', connectionType: 'qr', enabled: true, isDefault: true, status: 'connected' });

  const gw = require('../utils/whatsappGateway');
  const orig = gw.sendText;
  const sent = [];
  gw.sendText = async () => ({ ok: false, errorCode: 'qr_not_connected', error: 'El número QR no está conectado' });
  try {
    const wf = await Workflow.create({
      clinic: clinicId,
      name: 'Bienvenida',
      active: true,
      trigger: { type: 'contact_import' },
      steps: [{ type: 'send_message', body: 'Hola {{nombre}}' }],
    });
    const file = writeCsv([
      ['Nombre', 'Celular', 'Correo', 'Ciudad'],
      ['Ligia', '0999111222', '', ''],
    ]);
    const batch = await makeBatch(clinicId, userId, file, { workflows: [wf._id] });
    await runImport(batch._id);

    const engine = require('../utils/workflowEngine');

    // 1ª ejecución con el QR caído: debe quedar EN ESPERA, no quemada.
    await WorkflowEnrollment.updateMany({ workflow: wf._id }, { $set: { nextRunAt: new Date(Date.now() - 1000) } });
    await engine.processDueEnrollments();
    let e = await WorkflowEnrollment.findOne({ workflow: wf._id });
    assert.equal(e.status, 'waiting', 'el turno no se pierde: queda esperando el reintento');
    assert.ok(e.nextRunAt > new Date(), 'reintento programado en el futuro');
    assert.ok(
      e.log.some((l) => (l.info || '').includes('Se reintenta')),
      'el registro explica que se reintentará'
    );
    assert.equal(e.context.sendRetries, 1);

    // El número "vuelve": el reintento envía de verdad y el flujo termina.
    gw.sendText = async (account, to, body) => {
      sent.push({ to, body });
      return { ok: true, data: { messages: [{ id: 'wamid.retry' }] } };
    };
    await WorkflowEnrollment.updateMany({ workflow: wf._id }, { $set: { nextRunAt: new Date(Date.now() - 1000) } });
    await engine.processDueEnrollments();

    e = await WorkflowEnrollment.findOne({ workflow: wf._id });
    assert.equal(e.status, 'done');
    assert.equal(sent.length, 1, 'el mensaje salió una sola vez');
    assert.equal(sent[0].body, 'Hola Ligia');
    assert.equal(e.context.sendRetries, undefined, 'el contador se limpia al resolverse');
  } finally {
    gw.sendText = orig;
  }
});

test('QR caído con los reintentos agotados: fallo definitivo y el flujo sigue', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const WhatsappAccount = require('../models/WhatsappAccount');
  await WhatsappAccount.create({ label: 'QR', connectionType: 'qr', enabled: true, isDefault: true, status: 'connected' });
  const gw = require('../utils/whatsappGateway');
  const orig = gw.sendText;
  gw.sendText = async () => ({ ok: false, errorCode: 'qr_not_connected', error: 'El número QR no está conectado' });
  try {
    const wf = await Workflow.create({
      clinic: clinicId,
      name: 'Bienvenida',
      active: true,
      trigger: { type: 'contact_import' },
      steps: [{ type: 'send_message', body: 'Hola' }],
    });
    await Contact.create({ clinic: clinicId, phone: '593999111222', firstName: 'Ligia' });
    const batch = await ContactImport.create({
      clinic: clinicId, fileName: 'x.csv', status: 'done', mapping: MAPPING,
      workflows: [wf._id], createdBy: userId,
    });
    await enrollInWorkflows(batch, ['593999111222']);

    // Simular que ya se reintentó el máximo de veces.
    await WorkflowEnrollment.updateMany(
      { workflow: wf._id },
      { $set: { nextRunAt: new Date(Date.now() - 1000), 'context.sendRetries': 36 } }
    );
    const engine = require('../utils/workflowEngine');
    await engine.processDueEnrollments();

    const e = await WorkflowEnrollment.findOne({ workflow: wf._id });
    assert.equal(e.status, 'done', 'agotados los reintentos, el flujo termina en vez de colgarse');
    assert.ok(e.log.some((l) => l.ok === false && (l.info || '').includes('desconectado')), 'el fallo definitivo queda registrado');
  } finally {
    gw.sendText = orig;
  }
});
