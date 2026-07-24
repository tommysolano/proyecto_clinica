/**
 * Adjuntos de los MENSAJES GUARDADOS (el video que se manda con el texto).
 *
 * Bug reportado: "subí videos a los mensajes guardados, se ven en la lista, pero
 * al enviarlos solo sale el texto". Causa: el chat carga los mensajes guardados
 * UNA vez al abrir la página; si el mensaje se editaba después (en la página de
 * Mensajes Guardados, en otra pestaña) para adjuntarle el video, el chat seguía
 * insertando su copia vieja SIN adjunto y el mensaje salía como texto pelado.
 *
 * Por eso "marcar como usado" —la llamada que el chat ya hacía al insertar—
 * devuelve ahora el documento ACTUALIZADO: el adjunto que se envía es siempre el
 * vigente, sin depender de cuándo se cargó la página.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const chat = require('../controllers/chatController');
const SavedReply = require('../models/SavedReply');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

test('marcar como usado devuelve la versión VIGENTE, con su adjunto', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const reply = await SavedReply.create({
    clinic: clinicId,
    title: 'Ubicación Laboratorio',
    shortcut: 'ubicacion_laboratorio',
    body: 'Estamos en Urdesa Central',
  });

  // El agente le adjunta el video DESPUÉS (la copia del chat ya está cargada).
  await SavedReply.updateOne(
    { _id: reply._id },
    { attachment: { url: 'https://app.shiluvecuador.com/api/public/media/6a63823bceccc6eaf8011e3a', type: 'video', name: 'DIRECCION LABORATORIO.mp4' } }
  );

  const r = await H.runController(
    chat.markSavedReplyUsed,
    H.mockReq(clinicId, userId, {}, { params: { id: String(reply._id) } })
  );
  assert.equal(r.statusCode, 200);
  assert.equal(r.payload.attachment.type, 'video', 'debe traer el adjunto actual');
  assert.equal(r.payload.attachment.name, 'DIRECCION LABORATORIO.mp4');
  assert.ok(r.payload.attachment.url, 'sin url el chat enviaría solo el texto');
  assert.equal(r.payload.usageCount, 1, 'y sigue contando el uso');
  assert.equal(r.payload.body, 'Estamos en Urdesa Central');
});

test('marcar como usado de un mensaje de otra clínica no devuelve nada', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const otra = new H.mongoose.Types.ObjectId();
  const reply = await SavedReply.create({ clinic: otra, title: 'Ajena', shortcut: 'ajena', body: 'x' });

  const r = await H.runController(
    chat.markSavedReplyUsed,
    H.mockReq(clinicId, userId, {}, { params: { id: String(reply._id) } })
  );
  assert.equal(r.statusCode, 404);
});
