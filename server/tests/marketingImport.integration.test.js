/**
 * Round-trip real de la carga masiva por Excel de Marketing:
 * se DESCARGA la plantilla oficial (con sus filas de ejemplo), se vuelve a
 * SUBIR al importador y se verifica que crea las plantillas de mensaje (borrador)
 * y las automatizaciones (inactivas, multi-paso) correctas. Mongo en memoria.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('stream');
const H = require('./_integrationHelpers');

const bulk = require('../controllers/marketingImportController');
const Workflow = require('../models/Workflow');
const MessageTemplate = require('../models/MessageTemplate');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const oid = () => new H.mongoose.Types.ObjectId();

function jsonRes() {
  return {
    code: 200,
    body: null,
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

// Ejecuta un handler de descarga contra un stream y devuelve el .xlsx en Buffer.
async function downloadBuffer(handler) {
  const stream = new PassThrough();
  stream.setHeader = () => {};
  const chunks = [];
  stream.on('data', (c) => chunks.push(c));
  const finished = new Promise((resolve) => stream.on('finish', resolve));
  await handler({}, stream);
  await finished;
  return Buffer.concat(chunks);
}

test('automatizaciones: descargar plantilla y volver a subirla crea workflows inactivos multi-paso', async () => {
  const buf = await downloadBuffer(bulk.downloadAutomatizacionesTemplate);
  assert.ok(buf.length > 0, 'la plantilla descargada no está vacía');

  const clinic = oid();
  const res = jsonRes();
  await bulk.importAutomatizacionesExcel({ file: { buffer: buf }, clinicId: clinic, user: { _id: oid() } }, res);

  assert.equal(res.code, 200);
  assert.equal(res.body.errors.length, 0, `sin errores: ${JSON.stringify(res.body.errors)}`);
  assert.ok(res.body.created >= 3, `crea al menos 3, creó ${res.body.created}`);

  const wfs = await Workflow.find({ clinic }).lean();

  const bienvenida = wfs.find((w) => w.name === 'Bienvenida');
  assert.ok(bienvenida, 'existe la automatización Bienvenida');
  assert.equal(bienvenida.active, false, 'se crea INACTIVA');
  assert.equal(bienvenida.triggers[0].type, 'new_conversation');
  assert.deepEqual(bienvenida.steps.map((s) => s.type), ['send_message', 'wait', 'send_template']);
  assert.equal(bienvenida.steps[1].waitMinutes, 60);

  const precios = wfs.find((w) => w.name === 'Precios');
  assert.equal(precios.triggers[0].type, 'keyword');
  assert.deepEqual(precios.triggers[0].keywords, ['precio', 'costo', 'valor']);

  const rec = wfs.find((w) => w.name === 'Recordatorio 24h');
  assert.equal(rec.triggers[0].type, 'appointment_created');
  assert.equal(rec.steps[0].type, 'wait_until');
  assert.equal(rec.steps[0].offsetMinutes, -1440, '24h antes = -1440 min');
});

test('automatizaciones: re-subir la misma plantilla omite (no duplica)', async () => {
  const buf = await downloadBuffer(bulk.downloadAutomatizacionesTemplate);
  const clinic = oid();
  await bulk.importAutomatizacionesExcel({ file: { buffer: buf }, clinicId: clinic, user: { _id: oid() } }, jsonRes());
  const res2 = jsonRes();
  await bulk.importAutomatizacionesExcel({ file: { buffer: buf }, clinicId: clinic, user: { _id: oid() } }, res2);
  assert.equal(res2.body.created, 0, 'la segunda vez no crea nada');
  assert.ok(res2.body.skipped >= 3, 'las omite por nombre repetido');
});

test('plantillas: descargar plantilla y volver a subirla crea borradores con botones', async () => {
  const buf = await downloadBuffer(bulk.downloadPlantillasTemplate);
  assert.ok(buf.length > 0);

  const clinic = oid();
  const res = jsonRes();
  await bulk.importPlantillasExcel({ file: { buffer: buf }, clinicId: clinic, user: { _id: oid() } }, res);

  assert.equal(res.code, 200);
  assert.equal(res.body.errors.length, 0, `sin errores: ${JSON.stringify(res.body.errors)}`);
  assert.ok(res.body.created >= 2);

  const tpls = await MessageTemplate.find({ clinic }).lean();
  const t = tpls.find((x) => x.name === 'recordatorio_cita');
  assert.ok(t, 'existe recordatorio_cita');
  assert.equal(t.status, 'draft', 'se crea como BORRADOR');
  assert.equal(t.category, 'UTILITY');
  assert.ok(t.buttons.length >= 1, 'lee los botones');
  assert.ok(t.variables.some((v) => v.key === '1'), 'detecta variables {{1}}');
});
