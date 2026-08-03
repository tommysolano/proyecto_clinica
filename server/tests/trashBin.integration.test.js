/**
 * Papelera de reciclaje del CRM/Marketing: borrar un Workflow/MessageTemplate/
 * SavedReply/Segment/Contact lo archiva en Trash (con snapshot completo) en vez
 * de borrarlo en firme; se puede restaurar (mismo _id, para que las referencias
 * de otros documentos sigan vivas) o se purga sola pasados 30 días.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const workflowCtrl = require('../controllers/workflowController');
const templateCtrl = require('../controllers/messageTemplateController');
const segmentCtrl = require('../controllers/segmentController');
const contactCtrl = require('../controllers/contactController');
const chatCtrl = require('../controllers/chatController');
const trashCtrl = require('../controllers/trashController');

const Workflow = require('../models/Workflow');
const WorkflowEnrollment = require('../models/WorkflowEnrollment');
const MessageTemplate = require('../models/MessageTemplate');
const SavedReply = require('../models/SavedReply');
const Segment = require('../models/Segment');
const Contact = require('../models/Contact');
const Trash = require('../models/Trash');
const { purgeExpiredTrash } = require('../utils/trashBin');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

test('borrar un workflow lo archiva en la papelera y restaurarlo lo recrea con el mismo _id', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const wf = await Workflow.create({
    clinic: clinicId, name: 'Recordatorio', active: true,
    trigger: { type: 'contact_import' }, steps: [{ type: 'add_tag', tag: 'x' }],
  });
  const originalId = String(wf._id);
  // Una inscripción viva: al borrar debe seguir cancelándose (efecto existente).
  await WorkflowEnrollment.create({
    clinic: clinicId, workflow: wf._id, status: 'waiting',
    nextRunAt: new Date(Date.now() + 3600 * 1000),
    context: { phone: '593999111222' },
  });

  const delReq = H.mockReq(clinicId, userId, {}, { params: { id: originalId } });
  const del = await H.runController(workflowCtrl.remove, delReq);
  assert.equal(del.statusCode, 200, JSON.stringify(del.payload));
  assert.equal(await Workflow.findById(originalId), null);

  const enroll = await WorkflowEnrollment.findOne({ workflow: originalId });
  assert.equal(enroll.status, 'cancelled');

  const trashed = await Trash.findOne({ clinic: clinicId, entityType: 'Workflow' }).lean();
  assert.ok(trashed, 'debe existir una entrada en la papelera');
  assert.equal(trashed.label, 'Recordatorio');
  assert.equal(String(trashed.originalId), originalId);

  const listReq = H.mockReq(clinicId, userId, {}, {});
  const list = await H.runController(trashCtrl.list, listReq);
  assert.equal(list.payload.items.length, 1);
  assert.equal(list.payload.items[0].entityType, 'Workflow');

  const restoreReq = H.mockReq(clinicId, userId, {}, { params: { id: String(trashed._id) } });
  const restore = await H.runController(trashCtrl.restore, restoreReq);
  assert.equal(restore.statusCode, 200, JSON.stringify(restore.payload));

  const restored = await Workflow.findById(originalId).lean();
  assert.ok(restored, 'el workflow debe volver a existir con el MISMO _id');
  assert.equal(restored.name, 'Recordatorio');
  assert.equal(await Trash.countDocuments({ clinic: clinicId }), 0);
});

test('MessageTemplate, SavedReply, Segment y Contact también pasan por la papelera al borrarse', async () => {
  const { clinicId, userId } = await H.seedClinic();

  const tpl = await MessageTemplate.create({ clinic: clinicId, name: 'saludo_inicial', body: 'Hola {{nombre}}', status: 'approved' });
  const sr = await SavedReply.create({ clinic: clinicId, shortcut: 'saludo', title: 'Saludo', body: 'Hola!' });
  const seg = await Segment.create({ clinic: clinicId, name: 'VIP' });
  const contact = await Contact.create({ clinic: clinicId, phone: '593987654321', firstName: 'Ana' });

  await H.runController(templateCtrl.remove, H.mockReq(clinicId, userId, {}, { params: { id: String(tpl._id) } }));
  await H.runController(chatCtrl.deleteSavedReply, H.mockReq(clinicId, userId, {}, { params: { id: String(sr._id) } }));
  await H.runController(segmentCtrl.remove, H.mockReq(clinicId, userId, {}, { params: { id: String(seg._id) } }));
  await H.runController(contactCtrl.remove, H.mockReq(clinicId, userId, {}, { params: { id: String(contact._id) } }));

  assert.equal(await MessageTemplate.findById(tpl._id), null);
  assert.equal(await SavedReply.findById(sr._id), null);
  assert.equal(await Segment.findById(seg._id), null);
  assert.equal(await Contact.findById(contact._id), null);

  const entries = await Trash.find({ clinic: clinicId }).lean();
  const byType = Object.fromEntries(entries.map((e) => [e.entityType, e]));
  assert.equal(entries.length, 4);
  assert.equal(byType.MessageTemplate.label, 'saludo_inicial');
  assert.equal(byType.SavedReply.label, 'Saludo');
  assert.equal(byType.Segment.label, 'VIP');
  assert.equal(byType.Contact.label, 'Ana');

  // Restaura el contacto y confirma que vuelve tal cual (mismo teléfono).
  const restore = await H.runController(
    trashCtrl.restore,
    H.mockReq(clinicId, userId, {}, { params: { id: String(byType.Contact._id) } })
  );
  assert.equal(restore.statusCode, 200, JSON.stringify(restore.payload));
  const restoredContact = await Contact.findById(contact._id).lean();
  assert.equal(restoredContact.phone, '593987654321');
});

test('restaurar con un nombre que ya está en uso devuelve 409 en vez de reventar', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const seg = await Segment.create({ clinic: clinicId, name: 'VIP' });
  await H.runController(segmentCtrl.remove, H.mockReq(clinicId, userId, {}, { params: { id: String(seg._id) } }));
  const trashed = await Trash.findOne({ clinic: clinicId, entityType: 'Segment' }).lean();

  // Se crea OTRO segmento con el mismo nombre mientras el original estaba en la papelera.
  await Segment.create({ clinic: clinicId, name: 'VIP' });

  const restore = await H.runController(
    trashCtrl.restore,
    H.mockReq(clinicId, userId, {}, { params: { id: String(trashed._id) } })
  );
  assert.equal(restore.statusCode, 409, JSON.stringify(restore.payload));
  // La entrada de la papelera se conserva: el usuario puede reintentar tras liberar el nombre.
  assert.ok(await Trash.findById(trashed._id));
});

test('eliminar definitivamente antes de tiempo borra la entrada sin restaurar nada', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const seg = await Segment.create({ clinic: clinicId, name: 'VIP' });
  await H.runController(segmentCtrl.remove, H.mockReq(clinicId, userId, {}, { params: { id: String(seg._id) } }));
  const trashed = await Trash.findOne({ clinic: clinicId }).lean();

  const purge = await H.runController(trashCtrl.purgeNow, H.mockReq(clinicId, userId, {}, { params: { id: String(trashed._id) } }));
  assert.equal(purge.statusCode, 200, JSON.stringify(purge.payload));
  assert.equal(await Trash.countDocuments({ clinic: clinicId }), 0);
  assert.equal(await Segment.findById(seg._id), null);
});

test('el job de purga borra en firme solo lo vencido (30+ días), no lo reciente', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const seg1 = await Segment.create({ clinic: clinicId, name: 'Vencido' });
  const seg2 = await Segment.create({ clinic: clinicId, name: 'Reciente' });
  await H.runController(segmentCtrl.remove, H.mockReq(clinicId, userId, {}, { params: { id: String(seg1._id) } }));
  await H.runController(segmentCtrl.remove, H.mockReq(clinicId, userId, {}, { params: { id: String(seg2._id) } }));

  // Fuerza al primero a estar vencido (purgeAt en el pasado); el segundo queda intacto (30 días).
  await Trash.updateOne({ clinic: clinicId, label: 'Vencido' }, { $set: { purgeAt: new Date(Date.now() - 1000) } });

  const deletedCount = await purgeExpiredTrash();
  assert.ok(deletedCount >= 1);
  const remaining = await Trash.find({ clinic: clinicId }).lean();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].label, 'Reciente');
});
