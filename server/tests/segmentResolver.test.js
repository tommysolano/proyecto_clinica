const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPatientMatch, intersectIdLists, YEAR_MS } = require('../utils/segmentResolver');

test('builds a base match limited to active patients', () => {
  const match = buildPatientMatch({});
  assert.equal(match.active, true);
  assert.equal(Object.keys(match).length, 1);
});

test('filters by sources, tags and gender', () => {
  const match = buildPatientMatch({
    sources: ['anuncio', 'referido'],
    tags: ['ortodoncia', 'vip'],
    gender: 'femenino',
  });
  assert.deepEqual(match.source, { $in: ['anuncio', 'referido'] });
  assert.deepEqual(match.tags, { $all: ['ortodoncia', 'vip'] });
  assert.equal(match.gender, 'femenino');
});

test('translates an age range into a birthDate range', () => {
  const now = new Date('2026-06-17T00:00:00Z');
  const match = buildPatientMatch({ ageRange: { min: 18, max: 30 } }, now);
  // min edad 18 → nació como muy tarde hace 18 años
  assert.ok(match.birthDate.$lte.getTime() <= now.getTime() - 18 * YEAR_MS + 1);
  // max edad 30 → nació como muy temprano hace 31 años
  assert.ok(match.birthDate.$gte.getTime() <= now.getTime() - 30 * YEAR_MS);
});

test('whatsapp opt-in excludes opt-out and non-consenting patients', () => {
  const match = buildPatientMatch({ hasOptIn: 'whatsapp' });
  assert.equal(match['marketing.optOutAt'], null);
  assert.deepEqual(match['marketing.whatsappOptIn'], { $ne: false });
});

test('email opt-in requires a non-empty email', () => {
  const match = buildPatientMatch({ hasOptIn: 'email' });
  assert.deepEqual(match.email, { $nin: [null, ''] });
});

test('intersectIdLists returns null without cross-collection lists', () => {
  assert.equal(intersectIdLists([]), null);
});

test('intersectIdLists keeps only patients present in every list', () => {
  const result = intersectIdLists([
    ['a', 'b', 'c'],
    ['b', 'c', 'd'],
    ['c', 'b'],
  ]);
  assert.deepEqual(result.sort(), ['b', 'c']);
});

test('intersectIdLists with an empty list yields no patients', () => {
  assert.deepEqual(intersectIdLists([['a', 'b'], []]), []);
});
