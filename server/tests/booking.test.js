const test = require('node:test');
const assert = require('node:assert/strict');
const { generateSlots, isBlocked, filterAvailable, addMinutesHHMM, toMinutes } = require('../utils/booking');

test('generateSlots produces start times that fit before hourTo', () => {
  assert.deepEqual(generateSlots({ hourFrom: '09:00', hourTo: '11:00', slotMinutes: 30 }), ['09:00', '09:30', '10:00', '10:30']);
  // El último slot no debe exceder hourTo (10:30+30=11:00 cabe; 11:00 no inicia).
  assert.deepEqual(generateSlots({ hourFrom: '09:00', hourTo: '10:00', slotMinutes: 45 }), ['09:00']);
});

test('generateSlots returns empty on invalid ranges', () => {
  assert.deepEqual(generateSlots({ hourFrom: '18:00', hourTo: '09:00', slotMinutes: 30 }), []);
  assert.deepEqual(generateSlots({ hourFrom: 'bad', hourTo: '10:00', slotMinutes: 30 }), []);
});

test('isBlocked detects overlap between a slot+duration and a blocked range', () => {
  assert.equal(isBlocked('10:00', 30, [{ from: '10:15', to: '11:00' }]), true); // 10:00-10:30 solapa 10:15
  assert.equal(isBlocked('09:00', 30, [{ from: '10:00', to: '11:00' }]), false);
  assert.equal(isBlocked('10:30', 30, [{ from: '10:00', to: '10:30' }]), false); // contiguo, no solapa
});

test('filterAvailable removes full, blocked and past slots', () => {
  const slots = ['09:00', '09:30', '10:00', '10:30'];
  const out = filterAvailable(slots, {
    takenCounts: { '09:30': 2 },
    maxPerSlot: 2,
    durationMin: 30,
    blockedRanges: [{ from: '10:00', to: '10:30' }],
    isToday: true,
    nowHHMM: '09:05',
  });
  // 09:00 pasado, 09:30 lleno, 10:00 bloqueado → solo 10:30
  assert.deepEqual(out, ['10:30']);
});

test('filterAvailable keeps everything when unconstrained', () => {
  const slots = ['09:00', '09:30'];
  assert.deepEqual(filterAvailable(slots, { maxPerSlot: 1 }), slots);
});

test('addMinutesHHMM computes the end time', () => {
  assert.equal(addMinutesHHMM('09:45', 30), '10:15');
  assert.equal(toMinutes('10:15'), 615);
});
