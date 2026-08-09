const test = require('node:test');
const assert = require('node:assert/strict');
const { aliasesFromAd } = require('../utils/metaAds');

test('un ID estable de Ads Manager reconoce el alias de la publicación que llega por WhatsApp', () => {
  const aliases = aliasesFromAd({
    id: '120211234567890123',
    creative: { effective_object_story_id: '9988776655_4433221100' },
  });
  assert.deepEqual(
    new Set(aliases),
    new Set(['120211234567890123', '9988776655_4433221100', '4433221100'])
  );
});
