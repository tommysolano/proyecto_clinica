/**
 * CRUD de carpetas ANIDADAS (utils/folderCrud), probado con los modelos reales de
 * mensajes guardados. Cubre lo importante: crear "A/B/C" deja registrados también
 * sus ancestros, y no se puede borrar una carpeta que tiene contenido (para no
 * dejar mensajes huérfanos en una carpeta inexistente).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const { makeFolderCrud, normFolderPath } = require('../utils/folderCrud');
const SavedReply = require('../models/SavedReply');
const SavedReplyFolder = require('../models/SavedReplyFolder');

const crud = makeFolderCrud({ FolderModel: SavedReplyFolder, ItemModel: SavedReply, folderField: 'folder' });

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

test('normFolderPath: limpia barras, espacios y segmentos vacíos', () => {
  assert.equal(normFolderPath('  A / B / '), 'A/B');
  assert.equal(normFolderPath('A//B///C'), 'A/B/C');
  assert.equal(normFolderPath(''), '');
});

test('crear "A/B/C" registra la hoja Y sus ancestros (A, A/B)', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const r = await H.runController(crud.create, H.mockReq(clinicId, userId, { name: 'A/B/C' }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(r.payload.name, 'A/B/C', 'devuelve la carpeta hoja');

  const names = (await SavedReplyFolder.find({ clinic: clinicId }).lean()).map((f) => f.name).sort();
  assert.deepEqual(names, ['A', 'A/B', 'A/B/C'], 'existen la hoja y todos sus ancestros como carpetas navegables');

  // Idempotente: crear otra subcarpeta no duplica los ancestros.
  await H.runController(crud.create, H.mockReq(clinicId, userId, { name: 'A/B/D' }));
  const count = await SavedReplyFolder.countDocuments({ clinic: clinicId });
  assert.equal(count, 4, 'A, A/B, A/B/C, A/B/D (los ancestros no se duplican)');
});

test('crear sin nombre → 400', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const r = await H.runController(crud.create, H.mockReq(clinicId, userId, { name: '   ' }));
  assert.equal(r.statusCode, 400);
});

test('borrar una carpeta VACÍA la quita a ella y sus subcarpetas del registro', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await H.runController(crud.create, H.mockReq(clinicId, userId, { name: 'A/B/C' }));

  // Borrar "A" (vacía de mensajes) borra A, A/B y A/B/C del registro.
  const r = await H.runController(crud.remove, H.mockReq(clinicId, userId, {}, { query: { path: 'A' } }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(await SavedReplyFolder.countDocuments({ clinic: clinicId }), 0);
});

test('NO se puede borrar una carpeta con contenido (ni por una subcarpeta)', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await H.runController(crud.create, H.mockReq(clinicId, userId, { name: 'A/B' }));
  await SavedReply.create({ clinic: clinicId, shortcut: 'hola', title: 'Hola', body: 'hola', folder: 'A/B' });

  // Borrar "A" debe fallar: tiene un mensaje en la subcarpeta A/B.
  const r = await H.runController(crud.remove, H.mockReq(clinicId, userId, {}, { query: { path: 'A' } }));
  assert.equal(r.statusCode, 400, JSON.stringify(r.payload));
  assert.match(r.payload.message, /no está vacía/i);
  assert.ok(await SavedReplyFolder.findOne({ clinic: clinicId, name: 'A/B' }), 'la carpeta sigue ahí');

  // Al mover el mensaje fuera, ya se puede borrar.
  await SavedReply.updateOne({ clinic: clinicId, shortcut: 'hola' }, { folder: '' });
  const r2 = await H.runController(crud.remove, H.mockReq(clinicId, userId, {}, { query: { path: 'A' } }));
  assert.equal(r2.statusCode, 200);
});

test('las carpetas son por clínica: una clínica no ve ni borra las de otra', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const { clinicId: other } = await H.seedClinic();
  await H.runController(crud.create, H.mockReq(clinicId, userId, { name: 'Mia' }));

  const list = await H.runController(crud.list, H.mockReq(other, userId));
  assert.equal(list.payload.length, 0, 'la otra clínica no ve la carpeta');
});
