/**
 * Descarga y DESCIFRADO de la media de WhatsApp por nuestra cuenta.
 *
 * Es la vía definitiva para los archivos que entran por el número QR: el
 * navegador dejó de soltar los bytes (la función interna que usa whatsapp-web.js
 * falla con un error minificado, y tras resolver la media `mediaData.mediaBlob`
 * viene vacío — "sin bytes en memoria — mediaStage=RESOLVED"). El archivo, en
 * cambio, sigue en el CDN de WhatsApp cifrado con la clave que trae el mensaje, y
 * ese esquema es parte del protocolo: no cambia cuando WhatsApp actualiza su web.
 *
 * Estas pruebas CIFRAN un archivo igual que lo hace WhatsApp y comprueban que se
 * recupera intacto, que una firma manipulada se rechaza y que un archivo que no
 * coincide con su huella no se da por bueno.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { downloadAndDecryptWaMedia, phoneFromMsgData } = require('../utils/whatsappQrManager').__test;

const INFO = {
  image: 'WhatsApp Image Keys',
  audio: 'WhatsApp Audio Keys',
  video: 'WhatsApp Video Keys',
  document: 'WhatsApp Document Keys',
};

// Cifra un archivo tal y como lo publica WhatsApp en su CDN.
function encryptLikeWhatsapp(plain, type = 'image') {
  const mediaKey = crypto.randomBytes(32);
  const expanded = Buffer.from(
    crypto.hkdfSync('sha256', mediaKey, Buffer.alloc(32), Buffer.from(INFO[type], 'utf8'), 112)
  );
  const iv = expanded.subarray(0, 16);
  const cipherKey = expanded.subarray(16, 48);
  const macKey = expanded.subarray(48, 80);
  const cipher = crypto.createCipheriv('aes-256-cbc', cipherKey, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  const mac = crypto.createHmac('sha256', macKey).update(Buffer.concat([iv, body])).digest().subarray(0, 10);
  return {
    encrypted: Buffer.concat([body, mac]),
    mediaKey: mediaKey.toString('base64'),
    filehash: crypto.createHash('sha256').update(plain).digest('base64'),
  };
}

function withFetch(bytes, fn, { ok = true, status = 200 } = {}) {
  const orig = global.fetch;
  global.fetch = async () => ({ ok, status, arrayBuffer: async () => bytes });
  return fn().finally(() => { global.fetch = orig; });
}

test('la nota de voz se baja del CDN y se descifra intacta', async () => {
  const plain = Buffer.from('OggS-esto-es-una-nota-de-voz-de-verdad'.repeat(20));
  const { encrypted, mediaKey, filehash } = encryptLikeWhatsapp(plain, 'audio');
  await withFetch(encrypted, async () => {
    const r = await downloadAndDecryptWaMedia({
      directPath: '/v/t62.7117-24/12345_678_910?ccb=11-4', mediaKey, filehash, type: 'ptt',
    });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.buffer, plain, 'los bytes deben salir idénticos');
  });
});

test('la imagen también (cada tipo usa su propia derivación de claves)', async () => {
  const plain = crypto.randomBytes(5000);
  const { encrypted, mediaKey, filehash } = encryptLikeWhatsapp(plain, 'image');
  await withFetch(encrypted, async () => {
    const r = await downloadAndDecryptWaMedia({ directPath: '/v/foto', mediaKey, filehash, type: 'image' });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.buffer, plain);
  });
});

test('un archivo manipulado se RECHAZA (no se guarda media corrupta)', async () => {
  const plain = Buffer.from('contenido original');
  const { encrypted, mediaKey, filehash } = encryptLikeWhatsapp(plain, 'image');
  const tampered = Buffer.from(encrypted);
  tampered[5] ^= 0xff;
  await withFetch(tampered, async () => {
    const r = await downloadAndDecryptWaMedia({ directPath: '/v/foto', mediaKey, filehash, type: 'image' });
    assert.equal(r.ok, false);
    assert.match(r.error, /firma/i);
  });
});

test('si el tipo de archivo no corresponde, no se da por bueno', async () => {
  const plain = Buffer.from('un audio');
  const { encrypted, mediaKey, filehash } = encryptLikeWhatsapp(plain, 'audio');
  await withFetch(encrypted, async () => {
    // Mismo archivo pero pidiéndolo como imagen: las claves derivadas son otras.
    const r = await downloadAndDecryptWaMedia({ directPath: '/v/x', mediaKey, filehash, type: 'image' });
    assert.equal(r.ok, false);
  });
});

test('sin ruta o sin clave no se intenta nada', async () => {
  assert.equal((await downloadAndDecryptWaMedia({ mediaKey: 'x', type: 'image' })).ok, false);
  assert.equal((await downloadAndDecryptWaMedia({ directPath: '/v/x', type: 'image' })).ok, false);
});

test('si el CDN responde con error, se informa el motivo', async () => {
  await withFetch(Buffer.alloc(0), async () => {
    const r = await downloadAndDecryptWaMedia({ directPath: '/v/x', mediaKey: 'AAAA', type: 'image' });
    assert.equal(r.ok, false);
    assert.match(r.error, /404/);
  }, { ok: false, status: 404 });
});

// ─────────────── teléfono real de un contacto de número oculto ───────────────

test('el teléfono del contacto se saca del propio mensaje (@lid no es un número)', () => {
  const msg = {
    _data: {
      from: { user: '204496395366461', server: 'lid' },
      to: { user: '593999888777', server: 'c.us' }, // NUESTRO número: no es el del contacto
      senderPn: '593968025421@c.us',
      notifyName: 'Anita',
    },
  };
  const r = phoneFromMsgData(msg, '593999888777');
  assert.equal(r.phone, '593968025421');
  assert.equal(r.where, 'senderPn');
});

test('nunca se toma NUESTRO propio número como el del contacto', () => {
  const msg = { _data: { from: { user: '204496395366461', server: 'lid' }, to: '593999888777@c.us' } };
  assert.equal(phoneFromMsgData(msg, '593999888777').phone, '');
});

test('también lo busca un nivel más adentro del modelo', () => {
  const msg = { _data: { contextInfo: { participantPn: '593912345678@c.us' } } };
  const r = phoneFromMsgData(msg, '593999888777');
  assert.equal(r.phone, '593912345678');
  assert.equal(r.where, 'contextInfo.participantPn');
});

test('si el mensaje no trae ningún número, no se inventa', () => {
  assert.equal(phoneFromMsgData({ _data: { from: '204496395366461@lid' } }, '593999').phone, '');
  assert.equal(phoneFromMsgData({}, '593999').phone, '');
});
