/**
 * MÚSICA PARA LAS PUBLICACIONES (oct-2026).
 *
 * Las APIs oficiales NO dejan elegir canciones de la biblioteca de Instagram,
 * Facebook o TikTok: eso solo se hace desde la app del teléfono. Lo que sí se
 * puede es que el video SALGA con la música puesta. Aquí se monta con ffmpeg:
 *
 *   - VIDEO + audio: se reemplaza o se mezcla el sonido. La imagen se copia
 *     tal cual (`-c:v copy`), sin recodificar: tarda segundos aunque el video
 *     sea largo, y no pierde calidad.
 *   - IMAGEN + audio: se arma un video (vertical 9:16, cuadrado o 4:5) de hasta
 *     30 s, para historias, reels o TikTok con una foto.
 *
 * El resultado es un medio NUEVO (el original se conserva para poder quitar la
 * música). Ojo con los derechos: una canción comercial puede hacer que la red
 * silencie o bloquee el video.
 */
const { spawn } = require('child_process');
const { resolveFfmpegPath } = require('../audioTranscode');
const { SocialApiError } = require('./http');

const FORMATOS = {
  vertical: { w: 1080, h: 1920 },
  cuadrado: { w: 1080, h: 1080 },
  retrato: { w: 1080, h: 1350 },
};
// nginx corta la petición a los 60 s: un video desde imagen más largo no cabe.
const MAX_SEGUNDOS_IMAGEN = 30;

function ffmpeg(args, timeoutMs = 55 * 1000) {
  const bin = resolveFfmpegPath();
  if (!bin) return Promise.resolve({ ok: false, stderr: 'ffmpeg no está instalado en el servidor' });
  return new Promise((resolve) => {
    const proc = spawn(bin, ['-hide_banner', ...args]);
    let stderr = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* noop */ }
      resolve({ ok: false, stderr: 'tardó demasiado' });
    }, timeoutMs);
    proc.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 200000) stderr = stderr.slice(-100000); });
    proc.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, stderr: e.message }); });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, stderr }); });
  });
}

/** Duración (s), ancho y alto del archivo, leídos de la cabecera que imprime ffmpeg. */
async function inspeccionar(path) {
  const { stderr } = await ffmpeg(['-i', path], 15000);
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const v = /Video:.*?,\s*(\d{2,5})x(\d{2,5})/.exec(stderr);
  return {
    duration: d ? Math.round(Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3])) : 0,
    width: v ? Number(v[1]) : 0,
    height: v ? Number(v[2]) : 0,
    hasAudio: /Stream #.*Audio:/.test(stderr),
  };
}

const ultimaLinea = (s) => String(s || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-1)[0] || '';

/**
 * Monta la música. `base` = { path, mimeType } (video o imagen), `audio` = { path }.
 * Devuelve { duration, width, height } del archivo escrito en `outPath` (mp4).
 */
async function mezclarMusica({ base, audio, outPath, modo = 'replace', volumen = 1, segundos = 15, formato = 'vertical' }) {
  const vol = Math.min(2, Math.max(0, Number(volumen) || 1)).toFixed(2);
  const salida = ['-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-y', outPath];

  if (String(base.mimeType).startsWith('image/')) {
    const { w, h } = FORMATOS[formato] || FORMATOS.vertical;
    const t = Math.min(MAX_SEGUNDOS_IMAGEN, Math.max(3, Number(segundos) || 15));
    const r = await ffmpeg([
      '-loop', '1', '-framerate', '30', '-i', base.path,
      '-stream_loop', '-1', '-i', audio.path,
      '-t', String(t),
      '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=white,format=yuv420p`,
      '-af', `volume=${vol}`,
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-r', '30',
      ...salida,
    ]);
    if (!r.ok) throw new SocialApiError(`No se pudo crear el video con música: ${ultimaLinea(r.stderr)}`);
    return inspeccionar(outPath);
  }

  const info = await inspeccionar(base.path);
  const mezclar = modo === 'mix' && info.hasAudio;
  const audioArgs = mezclar
    ? ['-filter_complex', `[1:a]volume=${vol}[m];[0:a][m]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]`, '-map', '0:v:0', '-map', '[a]']
    : ['-af', `volume=${vol}`, '-map', '0:v:0', '-map', '1:a:0'];
  const entrada = ['-i', base.path, '-stream_loop', '-1', '-i', audio.path];
  // Primero copiando la imagen (rápido y sin pérdida); si el códec no cabe en
  // un mp4, se recodifica a H.264, que aceptan todas las redes.
  let r = await ffmpeg([...entrada, ...audioArgs, '-c:v', 'copy', '-shortest', ...salida]);
  if (!r.ok) {
    r = await ffmpeg([...entrada, ...audioArgs, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-shortest', ...salida]);
  }
  if (!r.ok) throw new SocialApiError(`No se pudo poner la música al video: ${ultimaLinea(r.stderr)}`);
  return inspeccionar(outPath);
}

module.exports = { FORMATOS, MAX_SEGUNDOS_IMAGEN, inspeccionar, mezclarMusica };
