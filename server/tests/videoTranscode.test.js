/**
 * El video que WhatsApp no podía entregar (error 131053).
 *
 * WhatsApp Cloud API solo entrega video H.264 + AAC. Un MP4 con pista
 * H.265/HEVC (lo que graba un iPhone) es un archivo válido: Meta lo acepta al
 * subirlo y solo lo rechaza DESPUÉS, al entregarlo, por webhook. De ahí el
 * "unas veces se envía y otras no" que en realidad era "este archivo no se
 * envía nunca".
 *
 * Aquí se generan videos REALES con ffmpeg (HEVC y H.264) y se comprueba que la
 * normalización hace lo que debe. Si el ffmpeg del entorno no sabe codificar
 * HEVC, los casos que lo necesitan se saltan en vez de fallar.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const vt = require('../utils/videoTranscode');
const { resolveFfmpegPath } = require('../utils/audioTranscode');

const ffmpeg = resolveFfmpegPath();
const tmp = (name) => path.join(os.tmpdir(), `vtest_${crypto.randomBytes(6).toString('hex')}_${name}`);
const creados = [];
const limpiar = (p) => { creados.push(p); return p; };
test.after(() => creados.forEach((p) => fs.promises.unlink(p).catch(() => {})));

/** Genera un video de prueba. Devuelve la ruta, o null si ffmpeg no puede. */
function generar({ vcodec, acodec = 'aac', duration = 2, size = '320x240' }) {
  if (!ffmpeg) return null;
  const out = limpiar(tmp(`${vcodec}.mp4`));
  const args = ['-y', '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=10:duration=${duration}`];
  if (acodec) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${duration}`);
  args.push('-c:v', vcodec, '-tag:v', vcodec === 'libx265' ? 'hvc1' : 'avc1', '-pix_fmt', 'yuv420p');
  args.push(...(acodec ? ['-c:a', acodec] : ['-an']));
  args.push(out);
  const r = spawnSync(ffmpeg, args, { encoding: 'utf8' });
  return r.status === 0 && fs.existsSync(out) ? out : null;
}

const asDataUrl = (file, mime = 'video/mp4') => `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;

test('probeMedia lee el códec de video y de audio con ffmpeg -i (no hay ffprobe)', async (t) => {
  const file = generar({ vcodec: 'libx264' });
  if (!file) return t.skip('ffmpeg no disponible');
  const probe = await vt.probeMedia(file);
  assert.equal(probe.ok, true);
  assert.equal(probe.videoCodec, 'h264');
  assert.equal(probe.audioCodec, 'aac');
  assert.equal(probe.audioStreams, 1);
  assert.ok(probe.durationSec > 1);
});

test('un video HEVC se convierte a H.264 (la causa raíz del 131053)', async (t) => {
  const file = generar({ vcodec: 'libx265' });
  if (!file) return t.skip('este ffmpeg no codifica HEVC');
  assert.equal((await vt.probeMedia(file)).videoCodec, 'hevc', 'la muestra debe ser HEVC');

  const r = await vt.toWhatsappVideo(asDataUrl(file));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.transcoded, true);
  assert.match(r.reason, /HEVC/);
  assert.equal(r.mimeType, 'video/mp4');

  // Y el resultado es de verdad H.264, no solo un MIME distinto.
  const out = limpiar(tmp('convertido.mp4'));
  fs.writeFileSync(out, Buffer.from(r.dataUrl.split(',')[1], 'base64'));
  assert.equal((await vt.probeMedia(out)).videoCodec, 'h264');
  assert.equal(vt.looksLikeHevc(fs.readFileSync(out)), false);
});

test('un video que YA es H.264+AAC no se toca (no se recomprime por gusto)', async (t) => {
  const file = generar({ vcodec: 'libx264' });
  if (!file) return t.skip('ffmpeg no disponible');
  const original = fs.readFileSync(file);
  const r = await vt.toWhatsappVideo(asDataUrl(file));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.transcoded, false, 'no debe recodificar lo que ya sirve');
  assert.deepEqual(Buffer.from(r.dataUrl.split(',')[1], 'base64'), original, 'los bytes deben ser los mismos');
});

test('un video HEVC SIN audio también se convierte (el -map de audio es opcional)', async (t) => {
  const file = generar({ vcodec: 'libx265', acodec: null });
  if (!file) return t.skip('este ffmpeg no codifica HEVC');
  const probe = await vt.probeMedia(file);
  assert.equal(probe.audioStreams, 0, 'la muestra debe ser muda');
  const r = await vt.toWhatsappVideo(asDataUrl(file));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.transcoded, true);
});

test('un .mov con H.264 dentro solo cambia de envoltorio: no se recodifica ni se pierde calidad', async (t) => {
  if (!ffmpeg) return t.skip('ffmpeg no disponible');
  const out = limpiar(tmp('iphone.mov'));
  const gen = spawnSync(ffmpeg, [
    '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', out,
  ], { encoding: 'utf8' });
  if (gen.status !== 0) return t.skip('ffmpeg no pudo generar el .mov');

  const r = await vt.toWhatsappVideo(asDataUrl(out, 'video/quicktime'));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.transcoded, true);
  assert.equal(r.mimeType, 'video/mp4');
  assert.match(r.reason, /no es MP4/);

  const conv = limpiar(tmp('remux.mp4'));
  const bytes = Buffer.from(r.dataUrl.split(',')[1], 'base64');
  fs.writeFileSync(conv, bytes);
  const probe = await vt.probeMedia(conv);
  assert.equal(probe.videoCodec, 'h264');
  assert.equal(probe.audioCodec, 'aac');
  // Copiar las pistas mantiene prácticamente el mismo peso; recodificar a 720p
  // con CRF 28 lo cambiaría mucho. Es la señal de que NO se recodificó.
  const original = fs.statSync(out).size;
  assert.ok(
    Math.abs(bytes.length - original) < original * 0.2,
    `debe copiar las pistas, no recodificar (original ${original}, salida ${bytes.length})`
  );
});

test('un archivo que dice ser video pero no se puede leer se rechaza al subirlo', async (t) => {
  if (!ffmpeg) return t.skip('ffmpeg no disponible');
  // Antes esto pasaba de largo y el fallo aparecía mucho después, en el chat,
  // como un 131053 de Meta. Mejor decirlo mientras el usuario lo está subiendo.
  const basura = Buffer.from('esto no es un video, solo texto').toString('base64');
  const r = await vt.toWhatsappVideo(`data:video/mp4;base64,${basura}`);
  assert.equal(r.ok, false);
  assert.match(r.error, /no se pudo leer/i);
});

test('un video con DOS pistas de audio se normaliza a una sola', async (t) => {
  if (!ffmpeg) return t.skip('ffmpeg no disponible');
  const out = limpiar(tmp('dosaudios.mp4'));
  const gen = spawnSync(ffmpeg, [
    '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2',
    '-map', '0:v', '-map', '1:a', '-map', '2:a',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', out,
  ], { encoding: 'utf8' });
  if (gen.status !== 0) return t.skip('ffmpeg no pudo generar la muestra');
  assert.equal((await vt.probeMedia(out)).audioStreams, 2, 'la muestra debe traer dos pistas');

  const r = await vt.toWhatsappVideo(asDataUrl(out));
  assert.equal(r.ok, true, r.error);
  const conv = limpiar(tmp('unaudio.mp4'));
  fs.writeFileSync(conv, Buffer.from(r.dataUrl.split(',')[1], 'base64'));
  assert.equal((await vt.probeMedia(conv)).audioStreams, 1, 'WhatsApp solo admite una pista de audio');
});

test('transcodeReason: qué obliga a recodificar y qué no', () => {
  const h264 = { ok: true, videoCodec: 'h264', audioCodec: 'aac', audioStreams: 1, durationSec: 10 };
  const chico = 1024;
  // Nada que hacer.
  assert.equal(vt.transcodeReason({ mimeType: 'video/mp4', bytes: chico, probe: h264 }), '');
  assert.equal(vt.transcodeReason({ mimeType: 'video/3gpp', bytes: chico, probe: h264 }), '');
  // Códec de video que WhatsApp no entrega.
  assert.match(
    vt.transcodeReason({ mimeType: 'video/mp4', bytes: chico, probe: { ...h264, videoCodec: 'hevc' } }),
    /HEVC/
  );
  // Códec de audio que no entrega.
  assert.match(
    vt.transcodeReason({ mimeType: 'video/mp4', bytes: chico, probe: { ...h264, audioCodec: 'opus' } }),
    /OPUS/
  );
  // Varias pistas de audio.
  assert.match(
    vt.transcodeReason({ mimeType: 'video/mp4', bytes: chico, probe: { ...h264, audioStreams: 2 } }),
    /pista de audio/
  );
  // Contenedor que WhatsApp no admite (.mov, .webm) aunque dentro fuera H.264.
  assert.match(vt.transcodeReason({ mimeType: 'video/quicktime', bytes: chico, probe: h264 }), /no es MP4/);
  assert.match(vt.transcodeReason({ mimeType: 'video/webm', bytes: chico, probe: h264 }), /no es MP4/);
  // Pasado de tamaño para WhatsApp.
  assert.match(
    vt.transcodeReason({ mimeType: 'video/mp4', bytes: vt.MAX_VIDEO_BYTES + 1, probe: h264 }),
    /15 MB/
  );
  // Sin inspección posible NO se toca: mejor dejar pasar lo que ya iba bien que
  // recodificar a ciegas todos los videos de la clínica.
  assert.equal(vt.transcodeReason({ mimeType: 'video/mp4', bytes: chico, probe: { ok: false } }), '');
});

test('looksLikeHevc detecta H.265 sin lanzar ffmpeg, y no da falsos positivos', async (t) => {
  const hevc = generar({ vcodec: 'libx265' });
  const h264 = generar({ vcodec: 'libx264' });
  if (!hevc || !h264) return t.skip('ffmpeg no disponible o sin HEVC');
  assert.equal(vt.looksLikeHevc(fs.readFileSync(hevc)), true);
  // Un H.264 legítimo NO debe bloquearse: por eso la detección busca las marcas
  // de HEVC en positivo y no la ausencia de 'avc1' (un .MOV de iPhone en H.264
  // tampoco lleva 'avc1' en el ftyp y quedaría bloqueado en falso).
  assert.equal(vt.looksLikeHevc(fs.readFileSync(h264)), false);
  assert.equal(vt.looksLikeHevc(Buffer.alloc(4)), false);
  assert.equal(vt.looksLikeHevc(null), false);
});

/**
 * El caso que de verdad importa y que estuvo a punto de colarse: en un MP4 sin
 * `+faststart` —como graba la cámara de un iPhone y como estaban guardados TODOS
 * los videos anteriores a esta mejora— la caja `moov`, que es donde vive la
 * marca `hvc1`, está al FINAL del archivo. Una detección que solo mirase la
 * cabecera daría `false` justo para los archivos por los que existe.
 *
 * La muestra se hace deliberadamente GRANDE y se comprueba que la marca cae
 * fuera de la ventana de cabecera: si no, el test estaría pasando por el motivo
 * equivocado.
 */
test('looksLikeHevc encuentra la marca aunque el moov esté al FINAL del archivo', async (t) => {
  if (!ffmpeg) return t.skip('ffmpeg no disponible');
  const out = limpiar(tmp('moov_al_final.mp4'));
  const gen = spawnSync(ffmpeg, [
    '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=8',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8',
    '-c:v', 'libx265', '-tag:v', 'hvc1', '-crf', '24', '-pix_fmt', 'yuv420p', '-c:a', 'aac', out,
  ], { encoding: 'utf8' });
  if (gen.status !== 0) return t.skip('este ffmpeg no codifica HEVC');

  const bytes = fs.readFileSync(out);
  const marca = bytes.indexOf(Buffer.from('hvc1', 'latin1'));
  assert.ok(marca > 512 * 1024, `la muestra debe tener la marca lejos del principio (está en ${marca})`);
  assert.equal(vt.looksLikeHevc(bytes), true, 'debe mirar también la cola del archivo');

  // Y el mismo contenido con el índice delante también se detecta.
  const fast = limpiar(tmp('moov_delante.mp4'));
  const remux = spawnSync(ffmpeg, ['-y', '-i', out, '-c', 'copy', '-movflags', '+faststart', fast]);
  if (remux.status === 0) assert.equal(vt.looksLikeHevc(fs.readFileSync(fast)), true);

  // Un H.264 del mismo tamaño y forma NO debe dar falso positivo.
  const limpio = limpiar(tmp('h264_grande.mp4'));
  const gen2 = spawnSync(ffmpeg, [
    '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=8',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8',
    '-c:v', 'libx264', '-crf', '24', '-pix_fmt', 'yuv420p', '-c:a', 'aac', limpio,
  ]);
  if (gen2.status === 0) assert.equal(vt.looksLikeHevc(fs.readFileSync(limpio)), false);
});
