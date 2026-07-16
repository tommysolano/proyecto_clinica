const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseDataUrl } = require('../utils/dataUrl');
const { toWhatsappVoice, isOggOpus, resolveFfmpegPath } = require('../utils/audioTranscode');
const { parseCallEvent } = require('../utils/whatsappCalls');

// ─────────────────────── data URLs ───────────────────────

test('parseDataUrl: acepta el tipo CON codec que produce MediaRecorder', () => {
  // Este es el caso real: Chrome graba blobs de tipo 'audio/webm;codecs=opus',
  // así que el data URL lleva el codec entre el mime y el ';base64,'. Un patrón
  // que exija ';base64,' pegado al mime rechaza toda grabación de Chrome.
  const out = parseDataUrl('data:audio/webm;codecs=opus;base64,QUJD');
  assert.equal(out.mimeType, 'audio/webm');
  assert.equal(out.kind, 'audio');
  assert.equal(out.b64, 'QUJD');
});

test('parseDataUrl: tipo simple sin parámetros', () => {
  const out = parseDataUrl('data:image/png;base64,AAAA');
  assert.equal(out.mimeType, 'image/png');
  assert.equal(out.kind, 'image');
  assert.equal(out.b64, 'AAAA');
});

test('parseDataUrl: rechaza lo que no es un data URL base64', () => {
  assert.equal(parseDataUrl('https://ejemplo.com/foto.png'), null);
  assert.equal(parseDataUrl('data:text/plain,hola'), null);
  assert.equal(parseDataUrl(''), null);
  assert.equal(parseDataUrl(null), null);
});

test('isOggOpus: solo el ogg se considera ya listo para WhatsApp', () => {
  assert.equal(isOggOpus('audio/ogg'), true);
  assert.equal(isOggOpus('audio/ogg; codecs=opus'), true);
  assert.equal(isOggOpus('audio/webm'), false);
  assert.equal(isOggOpus('audio/mp4'), false);
});

// ─────────────────────── notas de voz ───────────────────────

// Genera un WebM/Opus igual al que graba Chrome, para no depender de un fixture.
function makeChromeStyleWebm() {
  const ffmpeg = resolveFfmpegPath();
  const out = path.join(os.tmpdir(), `test_voz_${Date.now()}.webm`);
  const r = spawnSync(ffmpeg, [
    '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-c:a', 'libopus', '-f', 'webm', out,
  ]);
  assert.equal(r.status, 0, 'no se pudo generar el webm de prueba');
  const b64 = fs.readFileSync(out).toString('base64');
  fs.unlinkSync(out);
  return `data:audio/webm;codecs=opus;base64,${b64}`;
}

test('toWhatsappVoice: convierte el WebM del navegador a ogg/opus', async () => {
  const r = await toWhatsappVoice(makeChromeStyleWebm());
  assert.equal(r.ok, true, r.error);
  assert.equal(r.mimeType, 'audio/ogg');
  const bytes = Buffer.from(r.dataUrl.split(',')[1], 'base64');
  // 'OggS' es la firma del contenedor Ogg: si no está, WhatsApp no lo reproduce.
  assert.equal(bytes.subarray(0, 4).toString(), 'OggS');
});

test('toWhatsappVoice: un ogg ya válido se deja intacto (no se re-transcodifica)', async () => {
  const first = await toWhatsappVoice(makeChromeStyleWebm());
  const second = await toWhatsappVoice(first.dataUrl);
  assert.equal(second.ok, true);
  assert.equal(second.dataUrl, first.dataUrl);
});

test('toWhatsappVoice: rechaza lo que no es audio', async () => {
  const r = await toWhatsappVoice('data:image/png;base64,AAAA');
  assert.equal(r.ok, false);
  assert.match(r.error, /no es válido/i);
});

// ─────────────────────── llamadas ───────────────────────

test('parseCallEvent: una llamada del contacto se lee como entrante con su offer', () => {
  const ev = parseCallEvent({
    id: 'wacid.ABC',
    event: 'connect',
    direction: 'USER_INITIATED',
    from: '593999111222',
    to: '593777000111',
    session: { sdp_type: 'offer', sdp: 'v=0...' },
  });
  assert.equal(ev.direction, 'in');
  assert.equal(ev.event, 'connect');
  assert.equal(ev.sdpType, 'offer');
  assert.equal(ev.sdp, 'v=0...');
  assert.equal(ev.callId, 'wacid.ABC');
});

test('parseCallEvent: la respuesta a nuestra llamada se lee como saliente con answer', () => {
  const ev = parseCallEvent({
    id: 'wacid.XYZ',
    event: 'connect',
    direction: 'BUSINESS_INITIATED',
    session: { sdp_type: 'answer', sdp: 'v=0 answer' },
  });
  assert.equal(ev.direction, 'out');
  assert.equal(ev.sdpType, 'answer');
});

test('parseCallEvent: el fin de llamada trae estado y duración', () => {
  const ev = parseCallEvent({
    id: 'wacid.ABC',
    event: 'terminate',
    status: 'COMPLETED',
    duration: 42,
  });
  assert.equal(ev.event, 'terminate');
  assert.equal(ev.status, 'COMPLETED');
  assert.equal(ev.duration, 42);
});

test('parseCallEvent: tolera payloads vacíos o inesperados', () => {
  assert.equal(parseCallEvent(null), null);
  assert.equal(parseCallEvent('texto'), null);
  const ev = parseCallEvent({ id: 'x' });
  assert.equal(ev.event, '');
  assert.equal(ev.direction, '');
  assert.equal(ev.sdp, '');
});
