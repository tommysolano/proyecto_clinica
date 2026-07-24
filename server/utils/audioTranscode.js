/**
 * Convierte audio del navegador al formato que WhatsApp acepta como NOTA DE VOZ.
 *
 * El problema: MediaRecorder de Chrome (el navegador de la mayoría de agentes)
 * solo sabe grabar en `audio/webm;codecs=opus`, y WebM no sirve para WhatsApp:
 *   - Cloud API: Meta acepta ogg(opus), mpeg, mp4, aac y amr — webm NO, lo
 *     rechaza con "unsupported media type".
 *   - QR (whatsapp-web.js): se envía con sendAudioAsVoice, y WhatsApp espera
 *     ogg/opus; con webm la nota llega pero no se reproduce en el teléfono.
 *
 * Por eso todo audio entrante del composer se normaliza aquí a ogg/opus mono
 * 32 kbps, que es justo lo que graba la app oficial de WhatsApp.
 *
 * ffmpeg se resuelve desde ffmpeg-static (binario que se instala con npm, sin
 * depender de que el VPS tenga ffmpeg en el sistema). Si no estuviera
 * disponible, se devuelve el motivo para que el caller avise en vez de mandar
 * un audio que el destinatario no podrá abrir.
 */
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { parseDataUrl } = require('./dataUrl');

function resolveFfmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    return require('ffmpeg-static');
  } catch {
    return null;
  }
}

/** ¿Ya es un ogg/opus? Entonces no hay nada que convertir. */
function isOggOpus(mimeType) {
  return /^audio\/ogg\b/i.test(String(mimeType || ''));
}

function runFfmpeg(ffmpeg, args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const proc = spawn(ffmpeg, args);
    let stderr = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* noop */ }
      resolve({ ok: false, error: 'La conversión del audio tardó demasiado' });
    }, timeoutMs);
    timer.unref?.();
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ ok: true });
      resolve({ ok: false, error: stderr.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 200) });
    });
  });
}

/**
 * Recibe un data URL de audio y devuelve `{ ok, dataUrl, mimeType }` con el audio
 * en ogg/opus MONO a 32 kbps, que es exactamente lo que graba la app oficial.
 *
 * Se normaliza SIEMPRE, incluso si ya venía en ogg. Antes el ogg pasaba de largo
 * y eso hacía que la nota de voz dependiera del navegador del agente:
 *   - Chrome graba webm → se convertía → sonaba bien.
 *   - Firefox graba `audio/ogg;codecs=opus` (estéreo, ~100 kbps) → pasaba tal cual
 *     y se guardaba con la cabecera `data:audio/ogg;codecs=opus;base64,…`, que
 *     nuestro servidor de media no sabía leer (415): la nota no se podía escuchar
 *     y Meta la rechazaba al bajarla (error 131053 "Media upload error").
 * De ahí el "los audios funcionan pero a veces fallan": fallaban por navegador.
 *
 * Si no hay ffmpeg, un ogg se acepta tal cual (con la cabecera ya saneada) para no
 * bloquear el envío; cualquier otro formato sí necesita conversión.
 *
 * Se usan ficheros temporales en vez de pipes porque ffmpeg necesita una entrada
 * "buscable" para leer la cabecera de WebM de forma fiable.
 */
async function toWhatsappVoice(dataUrl) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed || parsed.kind !== 'audio') return { ok: false, error: 'El audio no es válido' };
  const { mimeType, b64 } = parsed;
  // Cabecera saneada (sin `;codecs=…`): es lo que se guarda si no hay conversión.
  const asIs = { ok: true, dataUrl: `data:${mimeType};base64,${b64}`, mimeType };

  const ffmpeg = resolveFfmpegPath();
  if (!ffmpeg) {
    if (isOggOpus(mimeType)) return asIs;
    return { ok: false, error: 'No se puede convertir el audio en este servidor (falta ffmpeg).' };
  }

  const id = crypto.randomBytes(8).toString('hex');
  const ext = (mimeType.split('/')[1] || 'webm').split(';')[0];
  const inPath = path.join(os.tmpdir(), `voz_${id}_in.${ext}`);
  // El sufijo _out es imprescindible: con un ogg de entrada, entrada y salida
  // caerían en el MISMO fichero y ffmpeg aborta con "Invalid argument".
  const outPath = path.join(os.tmpdir(), `voz_${id}_out.ogg`);
  try {
    await fs.promises.writeFile(inPath, Buffer.from(b64, 'base64'));
    // -vn: descarta cualquier pista de video (WebM puede traer una vacía).
    // Mono a 32k es lo que usa la app oficial para notas de voz: suficiente para
    // voz y mantiene el data URL pequeño (se guarda en Mongo).
    const r = await runFfmpeg(ffmpeg, [
      '-y', '-i', inPath,
      '-vn', '-ac', '1', '-ar', '48000',
      '-c:a', 'libopus', '-b:a', '32k',
      '-f', 'ogg', outPath,
    ]);
    if (!r.ok) {
      // Un ogg que no se pudo reconvertir se envía como vino: ya es el formato que
      // WhatsApp entiende y es mejor que dejar al agente sin poder mandar la nota.
      if (isOggOpus(mimeType)) {
        console.warn('[audio] no se pudo normalizar un ogg, se envía tal cual: %s', r.error);
        return asIs;
      }
      return { ok: false, error: `No se pudo convertir el audio: ${r.error}` };
    }
    const out = await fs.promises.readFile(outPath);
    if (!out.length) {
      if (isOggOpus(mimeType)) return asIs;
      return { ok: false, error: 'No se pudo convertir el audio (la conversión quedó vacía).' };
    }
    return {
      ok: true,
      dataUrl: `data:audio/ogg;base64,${out.toString('base64')}`,
      mimeType: 'audio/ogg',
    };
  } catch (e) {
    if (isOggOpus(mimeType)) return asIs;
    return { ok: false, error: `No se pudo convertir el audio: ${e.message}` };
  } finally {
    fs.promises.unlink(inPath).catch(() => {});
    fs.promises.unlink(outPath).catch(() => {});
  }
}

module.exports = { toWhatsappVoice, isOggOpus, resolveFfmpegPath };
