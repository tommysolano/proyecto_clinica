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
