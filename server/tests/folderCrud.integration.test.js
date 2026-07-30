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

test('borrar una carpeta CON contenido avisa primero (para poder elegir qué hacer)', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await H.runController(crud.create, H.mockReq(clinicId, userId, { name: 'A/B' }));
  await SavedReply.create({ clinic: clinicId, shortcut: 'hola', title: 'Hola', body: 'hola', folder: 'A/B' });

  // Borrar "A" sin decir qué hacer con el contenido: no borra nada y dice cuánto hay.
  const r = await H.runController(crud.remove, H.mockReq(clinicId, userId, {}, { query: { path: 'A' } }));
  assert.equal(r.statusCode, 409, JSON.stringify(r.payload));
  assert.equal(r.payload.code, 'FOLDER_NOT_EMPTY');
  assert.equal(r.payload.count, 1);
  assert.ok(await SavedReplyFolder.findOne({ clinic: clinicId, name: 'A/B' }), 'la carpeta sigue ahí');

  // Al mover el mensaje fuera, ya se borra sin preguntar.
  await SavedReply.updateOne({ clinic: clinicId, shortcut: 'hola' }, { folder: '' });
  const r2 = await H.runController(crud.remove, H.mockReq(clinicId, userId, {}, { query: { path: 'A' } }));
  assert.equal(r2.statusCode, 200);
});

test('mode=move: borra la carpeta llena y su contenido sube un nivel', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await H.runController(crud.create, H.mockReq(clinicId, userId, { name: 'A/B/C' }));
  await SavedReply.create({ clinic: clinicId, shortcut: 'uno', title: 'Uno', body: 'x', folder: 'A/B' });
  await SavedReply.create({ clinic: clinicId, shortcut: 'dos', title: 'Dos', body: 'x', folder: 'A/B/C' });

  const r = await H.runController(
    crud.remove,
    H.mockReq(clinicId, userId, {}, { query: { path: 'A/B', mode: 'move' } })
  );
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(r.payload.movedItems, 2);
  assert.equal(r.payload.movedTo, 'A');

  // Los mensajes existen y quedaron en la carpeta de arriba.
  const folders = (await SavedReply.find({ clinic: clinicId }).lean()).map((s) => s.folder);
  assert.deepEqual(folders.sort(), ['A', 'A']);
  // La carpeta y su subcarpeta ya no están en el registro; "A" sí.
  const names = (await SavedReplyFolder.find({ clinic: clinicId }).lean()).map((f) => f.name);
  assert.deepEqual(names.sort(), ['A']);
});

test('mode=move desde una carpeta de primer nivel deja el contenido sin carpeta', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await H.runController(crud.create, H.mockReq(clinicId, userId, { name: 'A' }));
  await SavedReply.create({ clinic: clinicId, shortcut: 'uno', title: 'Uno', body: 'x', folder: 'A' });

  const r = await H.runController(crud.remove, H.mockReq(clinicId, userId, {}, { query: { path: 'A', mode: 'move' } }));
  assert.equal(r.statusCode, 200);
  assert.equal((await SavedReply.findOne({ clinic: clinicId, shortcut: 'uno' })).folder, '');
});

test('mode=purge: borra la carpeta llena Y todo su contenido', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await H.runController(crud.create, H.mockReq(clinicId, userId, { name: 'A/B' }));
  await SavedReply.create({ clinic: clinicId, shortcut: 'uno', title: 'Uno', body: 'x', folder: 'A' });
  await SavedReply.create({ clinic: clinicId, shortcut: 'dos', title: 'Dos', body: 'x', folder: 'A/B' });
  // Una de otra carpeta que NO debe tocarse.
  await SavedReply.create({ clinic: clinicId, shortcut: 'tres', title: 'Tres', body: 'x', folder: 'Z' });

  const r = await H.runController(crud.remove, H.mockReq(clinicId, userId, {}, { query: { path: 'A', mode: 'purge' } }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(r.payload.deletedItems, 2);

  const left = (await SavedReply.find({ clinic: clinicId }).lean()).map((s) => s.shortcut);
  assert.deepEqual(left, ['tres'], 'solo sobrevive la de otra carpeta');
  assert.equal(await SavedReplyFolder.countDocuments({ clinic: clinicId }), 0);
});

test('mode inválido → 400 (nunca se borra "por si acaso")', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await H.runController(crud.create, H.mockReq(clinicId, userId, { name: 'A' }));
  await SavedReply.create({ clinic: clinicId, shortcut: 'uno', title: 'Uno', body: 'x', folder: 'A' });
  const r = await H.runController(crud.remove, H.mockReq(clinicId, userId, {}, { query: { path: 'A', mode: 'todo' } }));
  assert.equal(r.statusCode, 400);
  assert.equal(await SavedReply.countDocuments({ clinic: clinicId }), 1);
});

test('renombrar arrastra subcarpetas y contenido (nadie queda huérfano)', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await H.runController(crud.create, H.mockReq(clinicId, userId, { name: 'Citas/Recordatorios' }));
  await SavedReply.create({ clinic: clinicId, shortcut: 'uno', title: 'Uno', body: 'x', folder: 'Citas' });
  await SavedReply.create({ clinic: clinicId, shortcut: 'dos', title: 'Dos', body: 'x', folder: 'Citas/Recordatorios' });

  const r = await H.runController(crud.rename, H.mockReq(clinicId, userId, { path: 'Citas', name: 'Agenda' }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(r.payload.to, 'Agenda');
  assert.equal(r.payload.items, 2);

  const names = (await SavedReplyFolder.find({ clinic: clinicId }).lean()).map((f) => f.name).sort();
  assert.deepEqual(names, ['Agenda', 'Agenda/Recordatorios']);
  const folders = (await SavedReply.find({ clinic: clinicId }).lean()).map((s) => s.folder).sort();
  assert.deepEqual(folders, ['Agenda', 'Agenda/Recordatorios']);
});

test('renombrar una subcarpeta la deja en su sitio (solo cambia el último tramo)', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await H.runController(crud.create, H.mockReq(clinicId, userId, { name: 'A/B/C' }));

  const r = await H.runController(crud.rename, H.mockReq(clinicId, userId, { path: 'A/B', name: 'Bis' }));
  assert.equal(r.statusCode, 200);
  const names = (await SavedReplyFolder.find({ clinic: clinicId }).lean()).map((f) => f.name).sort();
  assert.deepEqual(names, ['A', 'A/Bis', 'A/Bis/C']);
});

test('renombrar no fusiona con una carpeta que ya existe en el mismo nivel', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await H.runController(crud.create, H.mockReq(clinicId, userId, { name: 'A' }));
  await H.runController(crud.create, H.mockReq(clinicId, userId, { name: 'B' }));

  const r = await H.runController(crud.rename, H.mockReq(clinicId, userId, { path: 'A', name: 'B' }));
  assert.equal(r.statusCode, 409, JSON.stringify(r.payload));
  assert.match(r.payload.message, /Ya existe una carpeta/i);
  const names = (await SavedReplyFolder.find({ clinic: clinicId }).lean()).map((f) => f.name).sort();
  assert.deepEqual(names, ['A', 'B'], 'nada cambió');
});

test('renombrar rechaza el nombre vacío y el que trae "/"', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await H.runController(crud.create, H.mockReq(clinicId, userId, { name: 'A' }));

  const vacio = await H.runController(crud.rename, H.mockReq(clinicId, userId, { path: 'A', name: '  ' }));
  assert.equal(vacio.statusCode, 400);
  const conBarra = await H.runController(crud.rename, H.mockReq(clinicId, userId, { path: 'A', name: 'X/Y' }));
  assert.equal(conBarra.statusCode, 400);
  assert.match(conBarra.payload.message, /"\/"/);
});

test('renombrar una carpeta que solo existía como ruta de los elementos la registra', async () => {
  const { clinicId, userId } = await H.seedClinic();
  // Sin pasar por crud.create: la carpeta "Vieja" solo vive en el campo del mensaje.
  await SavedReply.create({ clinic: clinicId, shortcut: 'uno', title: 'Uno', body: 'x', folder: 'Vieja' });

  const r = await H.runController(crud.rename, H.mockReq(clinicId, userId, { path: 'Vieja', name: 'Nueva' }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal((await SavedReply.findOne({ clinic: clinicId, shortcut: 'uno' })).folder, 'Nueva');
  assert.ok(await SavedReplyFolder.findOne({ clinic: clinicId, name: 'Nueva' }), 'queda registrada');
});

test('borrar una carpeta con automatizaciones cancela sus inscripciones vivas', async () => {
  // El caso real de Automatizaciones: purgar la carpeta borra los workflows, y las
  // inscripciones que quedaran vivas harían trabajar al motor sobre algo inexistente.
  const Workflow = require('../models/Workflow');
  const WorkflowFolder = require('../models/WorkflowFolder');
  const WorkflowEnrollment = require('../models/WorkflowEnrollment');
  const wfCrud = require('../controllers/workflowController'); // usa el crud con la limpieza

  const { clinicId, userId } = await H.seedClinic();
  await H.runController(wfCrud.createFolder, H.mockReq(clinicId, userId, { name: 'Viejas' }));
  const wf = await Workflow.create({
    clinic: clinicId, name: 'Recordatorio viejo', folder: 'Viejas', active: true,
    triggers: [{ type: 'appointment_created' }], steps: [],
  });
  const enr = await WorkflowEnrollment.create({ clinic: clinicId, workflow: wf._id, status: 'waiting' });

  const r = await H.runController(
    wfCrud.deleteFolder,
    H.mockReq(clinicId, userId, {}, { query: { path: 'Viejas', mode: 'purge' } })
  );
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(r.payload.deletedItems, 1);
  assert.equal(await Workflow.countDocuments({ clinic: clinicId }), 0);
  assert.equal(await WorkflowFolder.countDocuments({ clinic: clinicId }), 0);
  assert.equal((await WorkflowEnrollment.findById(enr._id)).status, 'cancelled');
});

test('las carpetas son por clínica: una clínica no ve ni borra las de otra', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const { clinicId: other } = await H.seedClinic();
  await H.runController(crud.create, H.mockReq(clinicId, userId, { name: 'Mia' }));

  const list = await H.runController(crud.list, H.mockReq(other, userId));
  assert.equal(list.payload.length, 0, 'la otra clínica no ve la carpeta');
});
