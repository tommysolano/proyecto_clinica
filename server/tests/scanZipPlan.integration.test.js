/**
 * DESCARGA MASIVA DEL ESCÁNER repartida en varios ZIP.
 *
 * El ZIP se arma entero en memoria, así que hay un tope por archivo. Con miles
 * de escaneos eso significa que «descargar todo» tiene que partirse en tandas, y
 * lo que vigila esta prueba es lo único que no se puede fallar en un respaldo:
 *
 *  1. las tandas cubren TODOS los documentos, sin repetir ninguno;
 *  2. ninguna tanda se pasa del tope (salvo un documento que ya lo pase él solo,
 *     que no hay forma de partir);
 *  3. el reparto es el MISMO en dos llamadas seguidas — si el orden bailara, una
 *     parte traería un documento que otra ya trajo y otro se quedaría sin bajar.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const ScannedDocument = require('../models/ScannedDocument');
const scans = require('../controllers/scanController');

const MB = 1024 * 1024;
const TOPE = 300 * MB; // MAX_ZIP_BYTES del controlador

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

/** Crea `n` documentos de `sizeMb` MB cada uno. Todos en el mismo instante, a
 *  propósito: es el caso que rompe un orden que solo mire `createdAt`. */
async function seedDocs(clinicId, userId, n, sizeMb) {
  const creado = new Date('2026-08-31T12:00:00Z');
  const docs = [];
  for (let i = 0; i < n; i++) {
    docs.push({
      clinic: clinicId,
      name: `Escaneo ${i + 1}`,
      nameKey: `escaneo ${i + 1}`,
      filename: `f${i + 1}.pdf`,
      size: sizeMb * MB,
      pages: 1,
      createdBy: userId,
      createdAt: creado,
      updatedAt: creado,
    });
  }
  return ScannedDocument.insertMany(docs);
}

const plan = (clinicId, userId, body) =>
  H.runController(scans.zipPlan, H.mockReq(clinicId, userId, body));

const ok = (r) => {
  assert.equal(r.statusCode < 400, true, `esperaba éxito: ${JSON.stringify(r.payload)}`);
  return r.payload;
};

// ─────────────────────────────────────────────────────────────────────────────
test('lo que cabe en un ZIP se queda en uno solo', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedDocs(clinicId, userId, 10, 1);

  const p = ok(await plan(clinicId, userId, { all: true }));
  assert.equal(p.total, 10);
  assert.equal(p.parts.length, 1, '10 MB no hay por qué partirlos');
  assert.equal(p.parts[0].count, 10);
});

test('lo que no cabe se reparte, sin perder ni repetir ningún documento', async () => {
  const { clinicId, userId } = await H.seedClinic();
  // 40 × 20 MB = 800 MB: no caben en 300.
  const creados = await seedDocs(clinicId, userId, 40, 20);

  const p = ok(await plan(clinicId, userId, { all: true }));
  assert.ok(p.parts.length >= 3, `esperaba varias partes, hubo ${p.parts.length}`);
  assert.equal(p.total, 40);

  const todos = p.parts.flatMap((x) => x.ids);
  assert.equal(todos.length, 40, 'ningún documento se cuenta dos veces');
  assert.equal(new Set(todos).size, 40, 'ni se repite en dos partes');

  const esperados = new Set(creados.map((d) => String(d._id)));
  for (const id of todos) assert.ok(esperados.has(id), `${id} no es de esta clínica`);
  assert.equal(esperados.size, new Set(todos).size, 'no falta ninguno');
});

test('ninguna tanda se pasa del tope de 300 MB', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedDocs(clinicId, userId, 40, 20);

  const p = ok(await plan(clinicId, userId, { all: true }));
  for (const parte of p.parts) {
    assert.ok(parte.bytes <= TOPE, `la parte ${parte.index} pesa ${parte.bytes} > ${TOPE}`);
    assert.ok(parte.count > 0, 'una parte vacía no tiene sentido');
  }
  assert.equal(
    p.parts.reduce((s, x) => s + x.bytes, 0),
    p.totalBytes,
    'la suma de las partes es el total',
  );
});

test('un documento que él solo pasa del tope va en su propia tanda', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedDocs(clinicId, userId, 1, 400); // 400 MB de una pieza

  const p = ok(await plan(clinicId, userId, { all: true }));
  assert.equal(p.parts.length, 1);
  assert.equal(p.parts[0].count, 1, 'partirlo es imposible; dejarlo fuera sería peor');
});

test('el reparto es el mismo en dos llamadas seguidas', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedDocs(clinicId, userId, 40, 20);

  const a = ok(await plan(clinicId, userId, { all: true }));
  const b = ok(await plan(clinicId, userId, { all: true }));
  assert.deepEqual(
    a.parts.map((x) => x.ids),
    b.parts.map((x) => x.ids),
    'con la misma fecha en todos, el orden lo tiene que desempatar el _id',
  );
});

test('el plan respeta el buscador y la selección', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const creados = await seedDocs(clinicId, userId, 10, 1);

  const porBusqueda = ok(await plan(clinicId, userId, { all: true, search: 'Escaneo 1' }));
  // "Escaneo 1" casa con 1 y con 10: lo que importa es que filtre, no que traiga todo.
  assert.ok(porBusqueda.total < 10, `filtró a ${porBusqueda.total}`);

  const ids = creados.slice(0, 3).map((d) => String(d._id));
  const porSeleccion = ok(await plan(clinicId, userId, { ids }));
  assert.equal(porSeleccion.total, 3);
  assert.deepEqual(new Set(porSeleccion.parts.flatMap((x) => x.ids)), new Set(ids));
});

test('sin documentos, el plan lo dice en vez de devolver cero partes', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const r = await plan(clinicId, userId, { all: true });
  assert.equal(r.statusCode, 404);
});
