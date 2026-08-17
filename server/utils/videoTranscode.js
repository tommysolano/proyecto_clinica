/**
 * Normaliza VIDEO al único formato que WhatsApp sabe entregar.
 *
 * EL PROBLEMA QUE RESUELVE
 * ------------------------
 * WhatsApp Cloud API acepta `video/mp4` y `video/3gpp`, pero además exige que
 * dentro vaya **H.264 + AAC** con una sola pista de audio. Un iPhone moderno
 * graba en H.265/HEVC dentro de un .mp4 perfectamente legítimo, y ahí estaba la
 * trampa: Meta ACEPTA la subida (el contenedor es válido), devuelve un media id,
 * acepta el POST del mensaje con 200 y un wamid — y solo DESPUÉS, al
 * transcodificar para entregarlo, falla y manda por webhook el estado `failed`
 * con el código 131053. Para el agente el mensaje aparecía enviado y de repente
 * se volvía rojo, siempre con el mismo archivo y sin ningún patrón visible.
 *
 * Caso real medido en producción: el video de un mensaje guardado era
 * `hevc/hvc1`, 8,39 MB, 1080x1920 — seis envíos, seis fallos. Los otros cuatro
 * videos del sistema eran `h264/avc1`, dos de ellos MÁS pesados (11,1 y 11,8 MB),
 * y nunca fallaron: no era el tamaño, era el códec.
 *
 * QUÉ SE HACE
 * -----------
 * Al SUBIR el archivo (una vez), no al enviarlo (cada vez): se mira lo que hay
 * dentro y, si no es lo que WhatsApp acepta, se recodifica. Si ya es H.264+AAC y
 * cabe en el límite, no se toca ni un byte.
 *
 * ffprobe NO viene con ffmpeg-static, así que la inspección se hace con
 * `ffmpeg -i` leyendo su stderr (que es donde ffmpeg describe las pistas).
 */
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { parseDataUrl } = require('./dataUrl');
const { resolveFfmpegPath } = require('./audioTranscode');

// Tope REAL de WhatsApp para video (16 MB). El nuestro se queda un poco por
// debajo: Meta rechaza justo en el borde y es mejor no apurar.
const MAX_VIDEO_BYTES = 15 * 1024 * 1024;

// Lo único que WhatsApp entrega sin recodificar por su cuenta.
const OK_VIDEO_CODECS = new Set(['h264']);
const OK_AUDIO_CODECS = new Set(['aac']);
const OK_VIDEO_MIME = new Set(['video/mp4', 'video/3gpp']);

/**
 * Ejecuta ffmpeg y devuelve su salida. `expectFailure` es para `ffmpeg -i` sin
 * fichero de salida: termina con código 1 ("At least one output file must be
 * specified") y eso NO es un error, es cómo se inspecciona un archivo.
 */
function runFfmpeg(ffmpeg, args, { timeoutMs = 300000, expectFailure = false } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(ffmpeg, args);
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { proc.kill('SIGKILL'); } catch { /* noop */ }
      resolve({ ok: false, stderr, error: 'La conversión del video tardó demasiado' });
    }, timeoutMs);
    timer.unref?.();
    // ffmpeg puede escribir mucho en stderr; se guarda solo la cola útil.
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, stderr, error: e.message });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return;
      if (code === 0 || expectFailure) return resolve({ ok: true, stderr });
      resolve({
        ok: false,
        stderr,
        error: stderr.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 200),
      });
    });
  });
}

/**
 * Qué hay dentro del archivo, leído del stderr de `ffmpeg -i`. Las líneas que
 * interesan tienen esta pinta:
 *
 *   Stream #0:0[0x1](und): Video: hevc (Main) (hvc1 / 0x31637668), yuv420p, 1080x1920, …
 *   Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, …
 *   Duration: 00:00:38.10, start: 0.000000, bitrate: 1846 kb/s
 *
 * Devuelve { ok, videoCodec, audioCodec, audioStreams, durationSec }.
 */
async function probeMedia(filePath) {
  const ffmpeg = resolveFfmpegPath();
  if (!ffmpeg) return { ok: false, error: 'falta ffmpeg' };
  const r = await runFfmpeg(ffmpeg, ['-hide_banner', '-i', filePath], {
    timeoutMs: 30000,
    expectFailure: true,
  });
  const out = r.stderr || '';
  if (!/Stream #\d+:\d+/.test(out)) {
    return { ok: false, error: 'no se pudo leer el archivo de video' };
  }
  const videoCodec = (out.match(/Stream #\d+:\d+[^\n]*: Video: (\w+)/) || [])[1] || '';
  const audioMatches = [...out.matchAll(/Stream #\d+:\d+[^\n]*: Audio: (\w+)/g)];
  const dur = out.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  return {
    ok: true,
    videoCodec: videoCodec.toLowerCase(),
    audioCodec: (audioMatches[0]?.[1] || '').toLowerCase(),
    audioStreams: audioMatches.length,
    durationSec: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0,
  };
}

/**
 * ¿Hay que recodificar? Devuelve el motivo (texto) o '' si el archivo ya sirve.
 * Se separa de la conversión para poder probarlo y para poder explicárselo al
 * usuario cuando no se pueda convertir.
 */
function transcodeReason({ mimeType, bytes, probe }) {
  if (!OK_VIDEO_MIME.has(String(mimeType || '').toLowerCase())) {
    return `el formato ${mimeType || 'desconocido'} no es MP4`;
  }
  if (bytes > MAX_VIDEO_BYTES) return 'pesa más de 15 MB';
  if (!probe?.ok) return ''; // sin inspección no se toca: mejor no romper lo que iba bien
  if (probe.videoCodec && !OK_VIDEO_CODECS.has(probe.videoCodec)) {
    return `el video está en ${probe.videoCodec.toUpperCase()} y WhatsApp solo entrega H.264`;
  }
  if (probe.audioCodec && !OK_AUDIO_CODECS.has(probe.audioCodec)) {
    return `el audio está en ${probe.audioCodec.toUpperCase()} y WhatsApp solo entrega AAC`;
  }
  if (probe.audioStreams > 1) return 'trae más de una pista de audio';
  return '';
}

// Parámetros medidos sobre el archivo real que fallaba (1080x1920, 38 s, HEVC):
// 9,2 s de conversión y 6,86 MB de salida. Un `-crf 28` a secas daba 27,4 MB y
// 33,6 s — por eso van el techo de tasa y el escalado a 720 px de ancho, que
// para un video que se ve en un móvil es de sobra.
const ENCODE_ARGS = [
  '-map', '0:v:0', '-map', '0:a:0?', // el '?' = "si hay audio"; un video mudo no debe fallar
  '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'main', '-pix_fmt', 'yuv420p',
  '-crf', '28', '-maxrate', '2500k', '-bufsize', '5000k',
  '-vf', "scale='min(720,iw)':-2", // -2 = alto par (libx264 lo exige)
  '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
  '-movflags', '+faststart', // índice al principio: Meta lo procesa sin bajarlo entero
];

/**
 * Recibe un data URL de video y devuelve
 * `{ ok, dataUrl, mimeType, transcoded, reason }` con un MP4 H.264 + AAC que
 * WhatsApp sí puede entregar, o `{ ok: false, error }` con un motivo que se le
 * pueda enseñar al agente.
 *
 * Si el archivo ya está bien NO se toca (ni se recomprime): la mayoría de los
 * videos ya vienen en H.264 y recodificarlos solo perdería calidad y tiempo.
 */
async function toWhatsappVideo(dataUrl) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed || parsed.kind !== 'video') return { ok: false, error: 'El video no es válido' };
  const { mimeType, b64 } = parsed;
  const buffer = Buffer.from(b64, 'base64');
  const asIs = { ok: true, dataUrl: `data:${mimeType};base64,${b64}`, mimeType, transcoded: false, reason: '' };

  const ffmpeg = resolveFfmpegPath();
  if (!ffmpeg) {
    // Sin ffmpeg no se puede ni mirar dentro. Se deja pasar lo que ya cumple por
    // fuera (mp4 dentro del tamaño) y se rechaza lo que seguro que va a fallar.
    if (OK_VIDEO_MIME.has(mimeType.toLowerCase()) && buffer.length <= MAX_VIDEO_BYTES) return asIs;
    return { ok: false, error: 'Este servidor no puede convertir videos (falta ffmpeg). Sube un MP4 (H.264) de menos de 15 MB.' };
  }

  const id = crypto.randomBytes(8).toString('hex');
  const ext = (mimeType.split('/')[1] || 'mp4').split(';')[0].replace('quicktime', 'mov').replace('3gpp', '3gp');
  const inPath = path.join(os.tmpdir(), `wavid_${id}_in.${ext}`);
  const outPath = path.join(os.tmpdir(), `wavid_${id}_out.mp4`);
  try {
    await fs.promises.writeFile(inPath, buffer);
    const probe = await probeMedia(inPath);
    // Con ffmpeg delante, un archivo que no se puede ni leer NO es un video: se
    // rechaza aquí, mientras el usuario está subiéndolo y puede hacer algo, en
    // vez de dejar que Meta lo acepte y lo tire después con un 131053.
    if (!probe.ok) {
      return { ok: false, error: 'No se pudo leer el video (puede estar dañado o incompleto). Vuelve a exportarlo e inténtalo de nuevo.' };
    }
    const reason = transcodeReason({ mimeType, bytes: buffer.length, probe });
    if (!reason) return asIs;

    console.log('[video] recodificando: %s (%s, %d bytes, %s/%s)',
      reason, mimeType, buffer.length, probe.videoCodec || '?', probe.audioCodec || '-');

    // Si lo ÚNICO que falla es el envoltorio (.mov de iPhone, .3gp) pero dentro
    // ya va H.264 + AAC y cabe de tamaño, basta con cambiarlo de caja: se copian
    // las pistas tal cual. Es casi instantáneo y no pierde ni un poco de
    // calidad, frente a los segundos y la pérdida de recodificar por gusto.
    const soloEnvoltorio = OK_VIDEO_CODECS.has(probe.videoCodec)
      && (!probe.audioCodec || OK_AUDIO_CODECS.has(probe.audioCodec))
      && probe.audioStreams <= 1
      && buffer.length <= MAX_VIDEO_BYTES;
    if (soloEnvoltorio) {
      const remux = await runFfmpeg(ffmpeg, [
        '-y', '-i', inPath, '-map', '0:v:0', '-map', '0:a:0?',
        '-c', 'copy', '-movflags', '+faststart', outPath,
      ], { timeoutMs: 60000 });
      const salida = remux.ok ? await fs.promises.readFile(outPath).catch(() => Buffer.alloc(0)) : Buffer.alloc(0);
      if (salida.length && salida.length <= MAX_VIDEO_BYTES) {
        console.log('[video] recontenido a MP4 sin recodificar (%d bytes)', salida.length);
        return {
          ok: true,
          dataUrl: `data:video/mp4;base64,${salida.toString('base64')}`,
          mimeType: 'video/mp4',
          transcoded: true,
          reason,
        };
      }
      // Si el cambio de caja no salió, se sigue por la recodificación normal.
    }

    const r = await runFfmpeg(ffmpeg, ['-y', '-i', inPath, ...ENCODE_ARGS, outPath]);
    if (!r.ok) return { ok: false, error: `No se pudo convertir el video: ${r.error}` };

    let out = await fs.promises.readFile(outPath).catch(() => Buffer.alloc(0));
    if (!out.length) return { ok: false, error: 'No se pudo convertir el video (la conversión quedó vacía).' };

    // Todavía se pasa de tamaño: segunda pasada con la tasa calculada desde la
    // duración, para que quepa sí o sí. Sin duración no hay nada que calcular.
    // Todavía se pasa de tamaño: se vuelve a codificar con la tasa calculada
    // para que quepa. El presupuesto es SOLO para el video, así que hay que
    // descontar el audio y dejar margen para el contenedor: repartir el total y
    // luego sumarle encima el audio se pasaba siempre, y el resultado era
    // rechazar por grande un video que sí se podía comprimir.
    //
    // Se permite un segundo ajuste porque la tasa que pide ffmpeg y la que sale
    // no coinciden exactamente; con lo que pesó de verdad se corrige en
    // proporción y ya cabe.
    const AUDIO_KBPS = 128;
    const SOBRAN = new Set(['-crf', '-maxrate', '-bufsize']);
    const base = ENCODE_ARGS.filter((a, i, arr) => !SOBRAN.has(a) && !SOBRAN.has(arr[i - 1]));
    let kbps = 0;
    for (let intento = 1; intento <= 2 && out.length > MAX_VIDEO_BYTES && probe.durationSec > 1; intento++) {
      kbps = intento === 1
        // 94% del presupuesto para dejar sitio al índice y las cabeceras del MP4.
        ? Math.floor((MAX_VIDEO_BYTES * 8 * 0.94) / probe.durationSec / 1000) - AUDIO_KBPS
        // Corrección con la medida real de la pasada anterior.
        : Math.floor(kbps * (MAX_VIDEO_BYTES / out.length) * 0.95);
      kbps = Math.max(120, kbps);
      console.log('[video] pasada extra %d: %d bytes es demasiado, bajando el video a %dk', intento, out.length, kbps);
      // eslint-disable-next-line no-await-in-loop
      const extra = await runFfmpeg(ffmpeg, [
        '-y', '-i', inPath, ...base,
        '-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`,
        outPath,
      ]);
      if (!extra.ok) break;
      // eslint-disable-next-line no-await-in-loop
      const nuevo = await fs.promises.readFile(outPath).catch(() => Buffer.alloc(0));
      if (!nuevo.length) break;
      out = nuevo;
    }
    if (out.length > MAX_VIDEO_BYTES) {
      return { ok: false, error: 'El video es demasiado largo para WhatsApp (no baja de 15 MB ni comprimiéndolo). Recórtalo y vuelve a subirlo.' };
    }
    return {
      ok: true,
      dataUrl: `data:video/mp4;base64,${out.toString('base64')}`,
      mimeType: 'video/mp4',
      transcoded: true,
      reason,
    };
  } catch (e) {
    return { ok: false, error: `No se pudo convertir el video: ${e.message}` };
  } finally {
    fs.promises.unlink(inPath).catch(() => {});
    fs.promises.unlink(outPath).catch(() => {});
  }
}

/**
 * Detección BARATA de HEVC mirando los bytes, sin lanzar ffmpeg. Es una red de
 * seguridad para los videos que YA estaban guardados antes de que las subidas se
 * normalizaran: mejor un error claro al enviar que un mensaje que Meta acepta y
 * luego marca fallido.
 *
 * Se busca en POSITIVO (las marcas de HEVC). Lo contrario —exigir 'avc1'— daría
 * falsos positivos: un .MOV de iPhone en H.264 perfectamente válido no lleva
 * 'avc1' en el ftyp.
 */
function looksLikeHevc(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return false;
  const MARCAS = /hvc1|hev1|hvcC|dvh1|dvhe/;
  const VENTANA = 256 * 1024;
  // Las marcas viven en la caja `moov`, y hay que mirar en los DOS extremos:
  // con `+faststart` el moov va al principio, pero SIN faststart —que es como
  // graba la cámara de un iPhone y como se guardaban los videos antes de que
  // las subidas se normalizaran— va al FINAL del archivo. Mirar solo la cabecera
  // dejaba pasar justo los archivos para los que existe este guardia.
  const cabeza = buffer.subarray(0, Math.min(buffer.length, VENTANA)).toString('latin1');
  if (MARCAS.test(cabeza)) return true;
  const cola = buffer.subarray(Math.max(0, buffer.length - VENTANA)).toString('latin1');
  return MARCAS.test(cola);
}

module.exports = {
  toWhatsappVideo,
  probeMedia,
  transcodeReason,
  looksLikeHevc,
  MAX_VIDEO_BYTES,
  OK_VIDEO_MIME,
};
