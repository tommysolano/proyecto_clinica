/**
 * Mensajes guardados (fragmentos estilo Daplox): CRUD con carpeta + adjunto,
 * derivación automática del atajo desde el nombre, subida de adjuntos
 * (imagen/video) y envío de prueba.
 *
 * Prueba contra los controllers reales y un Mongo en memoria.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const chat = require('../controllers/chatController');
const SavedReply = require('../models/SavedReply');
const ChatGalleryImage = require('../models/ChatGalleryImage');

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`;

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

// ─────────────────────────────────────────────────────────────────────────────
test('crear: deriva el atajo del nombre (sin acentos) y guarda carpeta + adjunto', async () => {
  const { clinicId, userId } = await H.seedClinic();

  const created = await H.runController(chat.createSavedReply, H.mockReq(clinicId, userId, {
    title: 'Recordatorio de Citas Médicas',
    body: 'Hola {{nombre}}, te esperamos 🙌',
    folder: 'Citas',
    attachment: { url: 'https://cdn.example.com/promo.mp4', type: 'video', name: 'promo.mp4' },
  }));
  assert.equal(created.statusCode, 201, JSON.stringify(created.payload));
  assert.equal(created.payload.shortcut, 'recordatorio_de_citas_medicas');
  assert.equal(created.payload.folder, 'Citas');
  assert.equal(created.payload.attachment.type, 'video');

  // Sin nombre ni atajo → 400.
  const bad = await H.runController(chat.createSavedReply, H.mockReq(clinicId, userId, { body: 'hola' }));
  assert.equal(bad.statusCode, 400);
});

// ─────────────────────────────────────────────────────────────────────────────
test('actualizar: cambia carpeta, quita el adjunto y respeta el atajo manual', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const r = await SavedReply.create({
    clinic: clinicId, shortcut: 'saludo', title: 'Saludo', body: 'Hola',
    folder: 'General', attachment: { url: 'https://x/y.png', type: 'image', name: 'y.png' },
  });

  const upd = await H.runController(chat.updateSavedReply, H.mockReq(clinicId, userId, {
    title: 'Saludo cordial',
    shortcut: 'Saludo VIP', // se normaliza
    folder: '',
    body: 'Hola 👋',
    attachment: { url: '', type: '', name: '' },
  }, { params: { id: String(r._id) } }));
  assert.equal(upd.statusCode, 200, JSON.stringify(upd.payload));
  assert.equal(upd.payload.shortcut, 'saludo_vip');
  assert.equal(upd.payload.folder, '');
  assert.equal(upd.payload.attachment.url, '', 'el adjunto se quitó');

  // Otra clínica no puede tocarlo.
  const { clinicId: otherClinic } = await H.seedClinic();
  const foreign = await H.runController(chat.updateSavedReply, H.mockReq(otherClinic, userId, { body: 'hack' }, { params: { id: String(r._id) } }));
  assert.equal(foreign.statusCode, 404);
});

// ─────────────────────────────────────────────────────────────────────────────
test('upload: acepta imagen, video y DOCUMENTOS; rechaza tamaños excesivos', async () => {
  const { clinicId, userId } = await H.seedClinic();

  const img = await H.runController(chat.uploadSavedReplyMedia, H.mockReq(clinicId, userId, { name: 'foto.png', dataUrl: PNG_DATA_URL }));
  assert.equal(img.statusCode, 201, JSON.stringify(img.payload));
  assert.equal(img.payload.type, 'image');
  assert.match(img.payload.url, /\/api\/public\/media\/[a-f0-9]{24}$/);
  assert.ok(await ChatGalleryImage.findById(img.payload.id), 'persiste en Mongo');

  const vid = await H.runController(chat.uploadSavedReplyMedia, H.mockReq(clinicId, userId, { name: 'clip.mp4', dataUrl: 'data:video/mp4;base64,AAAA' }));
  assert.equal(vid.statusCode, 201, JSON.stringify(vid.payload));
  assert.equal(vid.payload.type, 'video');

  // PDF / Word / Excel → se aceptan como DOCUMENTO (antes se rechazaban).
  const pdf = await H.runController(chat.uploadSavedReplyMedia, H.mockReq(clinicId, userId, { name: 'contrato.pdf', dataUrl: 'data:application/pdf;base64,JVBERi0=' }));
  assert.equal(pdf.statusCode, 201, JSON.stringify(pdf.payload));
  assert.equal(pdf.payload.type, 'document');
  assert.equal(pdf.payload.name, 'contrato.pdf', 'conserva el nombre del archivo para el envío');

  const xlsx = await H.runController(chat.uploadSavedReplyMedia, H.mockReq(clinicId, userId, { name: 'precios.xlsx', dataUrl: 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,UEsDBAo=' }));
  assert.equal(xlsx.statusCode, 201, JSON.stringify(xlsx.payload));
  assert.equal(xlsx.payload.type, 'document');

  // Imagen por encima del tope (~6MB → 8M chars base64) → rechazada.
  const hugeImg = await H.runController(chat.uploadSavedReplyMedia, H.mockReq(clinicId, userId, { dataUrl: 'data:image/png;base64,' + 'A'.repeat(8_100_000) }));
  assert.equal(hugeImg.statusCode, 400);
  // Documento demasiado grande (tope ~10MB por el límite de BSON de Mongo).
  const hugeDoc = await H.runController(chat.uploadSavedReplyMedia, H.mockReq(clinicId, userId, { name: 'x.pdf', dataUrl: 'data:application/pdf;base64,' + 'A'.repeat(15_000_000) }));
  assert.equal(hugeDoc.statusCode, 400);
});

// ─────────────────────────────────────────────────────────────────────────────
test('envío de prueba: valida teléfono/contenido y reporta cuando no hay número configurado', async () => {
  const { clinicId, userId } = await H.seedClinic();

  const badPhone = await H.runController(chat.testSavedReply, H.mockReq(clinicId, userId, { phone: '12', body: 'hola' }));
  assert.equal(badPhone.statusCode, 400);

  const empty = await H.runController(chat.testSavedReply, H.mockReq(clinicId, userId, { phone: '593999999999', body: '' }));
  assert.equal(empty.statusCode, 400);

  // Sin WhatsappAccount configurada: messaging.send devuelve skipped → 409 claro.
  const noAccount = await H.runController(chat.testSavedReply, H.mockReq(clinicId, userId, { phone: '593999999999', body: 'prueba de fragmento' }));
  assert.equal(noAccount.statusCode, 409, JSON.stringify(noAccount.payload));
  assert.equal(noAccount.payload.code, 'provider_unavailable');
});
