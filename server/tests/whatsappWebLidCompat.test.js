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

test('processMediaData usa una clave real de mensaje y no el hash del archivo', async () => {
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
  const outgoingMessageId = {
    $1: 'true_149460634050699@lid_NEW_VIDEO_ID',
    remote: { $1: '149460634050699@lid' },
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
          msgToMediaType: (descriptor) => {
            memoizedGetterCalls += 1;
            if (descriptor.id == null) {
              throw new Error("Data passed to getter must include an id property (it's how we memoize)");
            }
            if (typeof descriptor.id === 'string' || !descriptor.id.remote) {
              throw new TypeError("Cannot read properties of undefined (reading '_serialized')");
            }
            assert.equal(descriptor.id, outgoingMessageId);
            assert.notEqual(descriptor.id, mediaData.filehash);
            assert.equal(descriptor.type, 'video');
            assert.equal(descriptor.isNewsletter, false);
            return 'v4:video';
          },
          castToV4: () => {
            throw new Error('castToV4 no debe intervenir en este flujo');
          },
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
        messageId: outgoingMessageId,
      }
    );

    assert.equal(memoizedGetterCalls, 1, 'la conversión recibe un descriptor con identidad');
    assert.equal(uploadedMediaType, 'v4:video');
    assert.equal(result.directPath, '/video');
  } finally {
    global.window = previousWindow;
  }
});

test('la vista previa de enlaces recibe el chat requerido por WhatsApp Web', () => {
  const fs = require('node:fs');
  const utilsPath = require.resolve('whatsapp-web.js/src/util/Injected/Utils');
  const source = fs.readFileSync(utilsPath, 'utf8');
  assert.match(source, /\.getLinkPreview\(link, chat\)/);
});

test('sendMessage recupera el mensaje saliente usando el nuevo id $1', async () => {
  const previousWindow = global.window;
  let lookupId = '';
  let mediaMessageId;

  const lid = {
    $1: '149460634050699@lid',
    isLid: () => true,
    isGroup: () => false,
    isStatus: () => false,
  };
  const me = { $1: '593967632250@lid' };
  class FakeMsgKey {
    constructor({ to, id }) {
      this.$1 = `true_${to.$1}_${id}`;
    }
    static async newId() { return 'NEW_VIDEO_ID'; }
  }

  global.window = {};
  try {
    LoadUtils();
    global.window.WWebJS.processMediaData = async (_media, options) => {
      mediaMessageId = options.messageId;
      return {
        preview: 'video-preview',
        toJSON: () => ({ type: 'video', directPath: '/uploaded-video' }),
      };
    };
    global.window.require = (name) => {
      if (name === 'WAWebChatGetters') {
        return { getIsNewsletter: () => false, getIsBroadcast: () => false };
      }
      if (name === 'WALinkify') return { findLink: () => null };
      if (name === 'WAWebUserPrefsMeUser') {
        return { getMaybeMeLidUser: () => me, getMaybeMePnUser: () => me };
      }
      if (name === 'WAWebMsgKey') return FakeMsgKey;
      if (name === 'WAWebGetEphemeralFieldsMsgActionsUtils') {
        return { getEphemeralFields: () => ({}) };
      }
      if (name === 'WAWebSendMsgChatAction') {
        return { addAndSendMsgToChat: () => [Promise.resolve(), Promise.resolve()] };
      }
      if (name === 'WAWebCollections') {
        return {
          Msg: {
            get: (id) => {
              lookupId = id;
              return { id };
            },
          },
        };
      }
      throw new Error(`módulo inesperado: ${name}`);
    };

    const result = await global.window.WWebJS.sendMessage(
      { id: lid },
      'video-preview',
      { media: { mimetype: 'video/mp4' }, caption: 'Ubicación' }
    );

    assert.equal(lookupId, 'true_149460634050699@lid_NEW_VIDEO_ID');
    assert.equal(mediaMessageId.$1, lookupId, 'la preparación usa el mismo MsgKey completo del envío');
    assert.equal(result.id, lookupId);
  } finally {
    global.window = previousWindow;
  }
});

test('los adjuntos QR no intentan crear otra vista previa desde el caption', () => {
  const fs = require('node:fs');
  const managerPath = require.resolve('../utils/whatsappQrManager');
  const source = fs.readFileSync(managerPath, 'utf8');
  const optionsBlock = source.slice(
    source.indexOf('const opts = isVoice'),
    source.indexOf('const bytes =', source.indexOf('const opts = isVoice'))
  );

  assert.notEqual(optionsBlock, '', 'debe localizar las opciones del envío de adjuntos');
  assert.equal(
    (optionsBlock.match(/linkPreview:\s*false/g) || []).length,
    3,
    'audio, documento e imagen/video deben desactivar el preview de enlaces'
  );
});
