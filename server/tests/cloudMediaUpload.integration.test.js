/**
 * Envío de media por Cloud API (Meta): se SUBEN los bytes a /media y se manda por
 * `media id`, no por link. Así Meta no depende de poder descargar nuestra URL
 * pública — la causa típica de "media que se marca enviada pero nunca llega" (el
 * texto va inline y llega; la media por link no, si Meta no alcanza el enlace).
 * Y si la subida a Meta falla (media muy grande), el envío es ok:false (fallido),
 * no un "enviado" en falso.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');
const wa = require('../utils/whatsappCloud');
const ChatGalleryImage = require('../models/ChatGalleryImage');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const creds = { accessToken: 'TOKEN', phoneNumberId: '123', apiVersion: 'v23.0' };

test('Cloud sendMedia: sube los bytes a Meta y envía por media id (no por link)', async () => {
  const { clinicId } = await H.seedClinic();
  const img = await ChatGalleryImage.create({
    clinic: clinicId, name: 'foto.png',
    dataUrl: 'data:image/png;base64,iVBORw0KGgo=', mimeType: 'image/png',
  });

  const calls = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (String(url).endsWith('/media')) return { ok: true, json: async () => ({ id: 'MEDIA_ID_1' }) };
    return { ok: true, json: async () => ({ messages: [{ id: 'wamid.OUT1' }] }) };
  };
  try {
    const r = await wa.sendMedia(creds, '593999999999', `https://x/api/public/media/${img._id}`, 'hola', 'image');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(calls[0].url.endsWith('/123/media'), `1ª llamada = upload /media, fue ${calls[0].url}`);
    assert.ok(calls[1].url.endsWith('/123/messages'), `2ª llamada = /messages, fue ${calls[1].url}`);
    const body = JSON.parse(calls[1].opts.body);
    assert.equal(body.type, 'image');
    assert.equal(body.image.id, 'MEDIA_ID_1', 'se envía por media id');
    assert.equal(body.image.link, undefined, 'NO por link');
    assert.equal(body.image.caption, 'hola');
  } finally {
    global.fetch = origFetch;
  }
});

test('Cloud sendMedia: si la subida a Meta falla (media muy grande) → ok:false, no "enviado"', async () => {
  const { clinicId } = await H.seedClinic();
  const img = await ChatGalleryImage.create({
    clinic: clinicId, name: 'big.mp4',
    dataUrl: 'data:video/mp4;base64,AAAABBBB', mimeType: 'video/mp4',
  });

  const origFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).endsWith('/media')) {
      return { ok: false, status: 400, json: async () => ({ error: { message: 'Media file size too big.' } }) };
    }
    return { ok: true, json: async () => ({ messages: [{ id: 'x' }] }) };
  };
  try {
    const r = await wa.sendMedia(creds, '593999999999', `https://x/api/public/media/${img._id}`, '', 'video');
    assert.equal(r.ok, false, 'subida fallida ⇒ ok:false (el envío se marca fallido)');
    assert.match(String(r.error || ''), /too big/i);
  } finally {
    global.fetch = origFetch;
  }
});
