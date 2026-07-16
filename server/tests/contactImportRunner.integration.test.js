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
  assert.ok(a && !b, 'el segundo intento no debe volver a procesar el lote');
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
