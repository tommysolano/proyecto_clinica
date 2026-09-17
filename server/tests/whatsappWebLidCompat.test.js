/**
 * Compatibilidad con los WID de WhatsApp Web posteriores a julio de 2026.
 *
 * WhatsApp cambió `id._serialized` por `id.$1`. whatsapp-web.js 1.34.7 todavía
 * busca únicamente la propiedad anterior: los textos podían salir, pero al
 * preparar cualquier adjunto en un chat @lid lanzaba el error minificado `t: t`.
 * El arreglo vive en patch-package, por eso estas pruebas usan directamente la
 * dependencia instalada: si el parche deja de aplicarse en un deploy, fallan.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const Base = require('whatsapp-web.js/src/structures/Base');
const { LoadUtils } = require('whatsapp-web.js/src/util/Injected/Utils');

test('normaliza un WID nuevo ($1) al contrato público _serialized', () => {
  const original = { user: '149460634050699', server: 'lid', $1: '149460634050699@lid' };
  const normalized = Base._normalizeId(original);

  assert.equal(normalized._serialized, '149460634050699@lid');
  assert.equal(original._serialized, undefined, 'no muta el objeto interno del Store');
});

test('getChat recupera un chat @lid por $1 si la búsqueda antigua falla', async () => {
  const previousWindow = global.window;
  const chat = { id: { user: '149460634050699', server: 'lid', $1: '149460634050699@lid' } };
  global.window = {};

  try {
    LoadUtils();
    global.window.require = (name) => {
      if (name === 'WAWebWidFactory') return { createWid: (id) => id };
      if (name === 'WAWebCollections') {
        return {
          Chat: {
            // Reproduce el error minificado de la ruta antigua de WhatsApp Web.
            get: () => { throw new Error('t: t'); },
            getModelsArray: () => [chat],
          },
        };
      }
      throw new Error(`módulo inesperado: ${name}`);
    };

    const found = await global.window.WWebJS.getChat('149460634050699@lid', { getAsModel: false });
    assert.equal(found, chat);
  } finally {
    global.window = previousWindow;
  }
});

test('processMediaData no pasa un adjunto normal por el getter que ahora exige id', async () => {
  const previousWindow = global.window;
  let memoizedGetterCalls = 0;
  let uploadedMediaType = '';

  class FakeOpaqueData {
    static async createFromData() { return new FakeOpaqueData(); }
    url() { return 'blob:video'; }
    autorelease() {}
    formData() { return {}; }
  }

  const mediaObject = {
    type: 'video', filehash: 'HASH', size: 123,
    contentInfo: {},
    consolidate() {},
  };
  const mediaData = {
    filehash: 'HASH', type: 'video', isGif: false, mimetype: 'video/mp4',
    mediaBlob: new FakeOpaqueData(),
    toJSON: () => ({}),
    set(values) { Object.assign(this, values); },
  };

  global.window = {};
  try {
    LoadUtils();
    global.window.WWebJS.mediaInfoToFile = () => ({ type: 'video/mp4', size: 123 });
    global.window.require = (name) => {
      if (name === 'WAWebMediaOpaqueData') return FakeOpaqueData;
      if (name === 'WAWebPrepRawMedia') {
        return { prepRawMedia: () => ({ waitForPrep: async () => mediaData }) };
      }
      if (name === 'WAWebMediaStorage') {
        return { getOrCreateMediaObject: () => mediaObject };
      }
      if (name === 'WAWebMmsMediaTypes') {
        return {
          msgToMediaType: () => {
            memoizedGetterCalls += 1;
            throw new Error("Data passed to getter must include an id property (it's how we memoize)");
          },
          castToV4: (type) => `v4:${type}`,
        };
      }
      if (name === 'WAWebMediaDataUtils') return { shouldUseMediaCache: () => false };
      if (name === 'WAWebMediaMmsV4Upload') {
        return {
          uploadMedia: async ({ mediaType }) => {
            uploadedMediaType = mediaType;
            return {
              mediaEntry: {
                mmsUrl: 'https://media.example/video', deprecatedMms3Url: '', directPath: '/video',
                mediaKey: 'KEY', mediaKeyTimestamp: 1, encFilehash: 'ENC', uploadHash: 'UP',
                sidecar: null, firstFrameSidecar: null,
              },
            };
          },
          uploadUnencryptedMedia: async () => { throw new Error('no es un canal'); },
        };
      }
      throw new Error(`módulo inesperado: ${name}`);
    };

    const result = await global.window.WWebJS.processMediaData(
      { mimetype: 'video/mp4', data: 'AAAA' },
      {
        forceSticker: false, forceGif: false, forceVoice: false,
        forceDocument: false, forceMediaHd: false, sendToChannel: false, sendToStatus: false,
      }
    );

    assert.equal(memoizedGetterCalls, 0, 'un chat normal no usa msgToMediaType');
    assert.equal(uploadedMediaType, 'v4:video');
    assert.equal(result.directPath, '/video');
  } finally {
    global.window = previousWindow;
  }
});
