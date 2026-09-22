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
 * Por eso todo audio entrante del composer se normaliza aquí a ogg/opus mono,
 * con los MISMOS parámetros que graba la app oficial (16 kHz, VOIP): el
 * contenedor queda con la duración real escrita y el teléfono del destinatario
 * la muestra bien. Un ogg "de navegador" sin reconvertir (o un webm) llega con
 * metadatos de duración rotos/ausentes y el cliente de WhatsApp la ESTIMA —
 * ahí nacen los "5 segundos que se ven como 4 minutos".
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

/** ¿Ya es un ogg/opus? (informativo; la conversión corre SIEMPRE). */
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
 * DURACIÓN REAL del audio, en segundos (o null si no se pudo leer).
 *
 * La lee ffmpeg del fichero convertido: es el dato exacto que el teléfono
 * muestra para la nota de voz. La necesita el CRM para pintar el tiempo de la
 * burbuja SIN depender del estimo del navegador (que para contenedores de
 * MediaRecorder es absurdo — el "4 minutos" que se reportaba).
 */
async function probeAudioDurationSec(ffmpeg, audioPath, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const proc = spawn(ffmpeg, ['-i', audioPath, '-f', 'null', '-']);
    let stderr = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* noop */ }
      resolve(null);
    }, timeoutMs);
    timer.unref?.();
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', () => { clearTimeout(timer); resolve(null); });
    proc.on('close', () => {
      clearTimeout(timer);
      // "Duration: 00:00:05.01" — minutos y segundos van en dos partes.
      const m = stderr.match(/Duration:\s*(\d+):(\d{2}):(\d{2})\.(\d+)/);
      if (!m) return resolve(null);
      const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(`0.${m[4]}`);
      resolve(Number.isFinite(sec) && sec > 0 ? Math.round(sec * 10) / 10 : null);
    });
  });
}

/**
 * Recibe un data URL de audio y devuelve `{ ok, dataUrl, mimeType }` con el audio
 * en ogg/opus MONO a 16 kHz, que es exactamente lo que graba la app oficial.
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
async function toWhatsappVoiceBuffer(buffer, mimeType) {
  const cleanMimeType = String(mimeType || '').split(';')[0].toLowerCase();
  if (!Buffer.isBuffer(buffer) || !buffer.length || !cleanMimeType.startsWith('audio/')) {
    return { ok: false, error: 'El audio no es válido' };
  }
  mimeType = cleanMimeType;
  // Cabecera saneada (sin `;codecs=…`): es lo que se guarda si no hay conversión.
  const asIs = { ok: true, buffer, mimeType };

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
    await fs.promises.writeFile(inPath, buffer);
    // -vn: descarta cualquier pista de video (WebM puede traer una vacía).
    // MISMA RECETA que una nota de voz de la app oficial (16 kHz mono, VOIP,
    // tramas de 60 ms): con ella el teléfono del destinatario muestra la
    // DURACIÓN correcta — con 48 kHz y sin el resto, los clientes de WhatsApp
    // la estiman mal y un audio de 5 segundos se veía de "4 minutos".
    const r = await runFfmpeg(ffmpeg, [
      '-y', '-i', inPath,
      '-vn', '-ac', '1', '-ar', '16000',
      '-c:a', 'libopus', '-b:a', '32k',
      '-compression_level', '10', '-frame_duration', '60', '-application', 'voip',
      '-map_metadata', '-1',
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
    // La DURACIÓN REAL del fichero que se guarda: la lee ffmpeg del contenedor
    // convertido. Con ella, la burbuja del CRM no depende del estimo del
    // navegador — que es la mitad del reporte de "4 minutos".
    const duration = await probeAudioDurationSec(ffmpeg, outPath);
    return {
      ok: true,
      buffer: out,
      mimeType: 'audio/ogg',
      duration,
    };
  } catch (e) {
    if (isOggOpus(mimeType)) return asIs;
    return { ok: false, error: `No se pudo convertir el audio: ${e.message}` };
  } finally {
    fs.promises.unlink(inPath).catch(() => {});
    fs.promises.unlink(outPath).catch(() => {});
  }
}

/** Compatibilidad con los callers antiguos que todavía envían data URLs. */
async function toWhatsappVoice(dataUrl) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed || parsed.kind !== 'audio') return { ok: false, error: 'El audio no es válido' };
  const result = await toWhatsappVoiceBuffer(Buffer.from(parsed.b64, 'base64'), parsed.mimeType);
  if (!result.ok) return result;
  const { buffer, ...rest } = result;
  return { ...rest, dataUrl: `data:${result.mimeType};base64,${buffer.toString('base64')}` };
}

module.exports = { toWhatsappVoice, toWhatsappVoiceBuffer, probeAudioDurationSec, isOggOpus, resolveFfmpegPath };
