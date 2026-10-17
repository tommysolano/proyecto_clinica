import api from '../api/axios';

/**
 * Subida de medios del planificador de redes.
 *
 * Antes de subir se prepara el archivo en el navegador:
 *  - Las imágenes que no son JPG se convierten a JPG: Instagram SOLO acepta
 *    JPEG por la API, y así un PNG o WEBP no se descubre como error a la hora
 *    de publicar. Un JPG que ya cumple (≤ 4 MB y ≤ 2048 px) se deja tal cual;
 *    los demás se reducen para entrar en el límite de Facebook (4 MB).
 *  - Se miden ancho, alto y duración: el editor avisa de proporciones y
 *    duraciones que cada red rechazaría.
 */

async function imageSize(file) {
  const bmp = await createImageBitmap(file);
  const size = { width: bmp.width, height: bmp.height };
  bmp.close?.();
  return size;
}

// Facebook acepta fotos de hasta 4 MB e Instagram de hasta 8 MB y las reduce a
// 1440 px de ancho: una foto de móvil de 12 MP no aporta nada y fallaría.
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_LADO = 2048;

async function toJpeg(file) {
  const bmp = await createImageBitmap(file);
  const escala = Math.min(1, MAX_LADO / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * escala);
  canvas.height = Math.round(bmp.height * escala);
  const ctx = canvas.getContext('2d');
  // Fondo blanco: la transparencia de un PNG saldría negra en JPG.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  // Se baja la calidad por pasos solo si hace falta para entrar en 4 MB.
  let blob = null;
  for (const calidad of [0.92, 0.85, 0.75, 0.65]) {
    blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', calidad));
    if (blob && blob.size <= MAX_BYTES) break;
  }
  if (!blob) throw new Error('No se pudo convertir la imagen');
  const name = String(file.name || 'imagen').replace(/\.[^.]+$/, '') + '.jpg';
  return { file: new File([blob], name, { type: 'image/jpeg' }), width: canvas.width, height: canvas.height };
}

function videoMeta(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    const done = (meta) => {
      URL.revokeObjectURL(url);
      resolve(meta);
    };
    v.onloadedmetadata = () => done({ duration: Math.round(v.duration || 0), width: v.videoWidth || 0, height: v.videoHeight || 0 });
    v.onerror = () => done({ duration: 0, width: 0, height: 0 });
    v.src = url;
  });
}

export async function prepareFile(file) {
  const type = String(file.type || '');
  if (type.startsWith('image/')) {
    if (/^image\/jpe?g$/i.test(type) && file.size <= MAX_BYTES) {
      const size = await imageSize(file);
      if (Math.max(size.width, size.height) <= MAX_LADO) return { file, ...size, duration: 0 };
    }
    return { ...(await toJpeg(file)), duration: 0 };
  }
  if (type.startsWith('video/')) return { file, ...(await videoMeta(file)) };
  throw new Error('Formato no admitido: sube imágenes o videos');
}

/** Sube un archivo y devuelve el medio listo para guardar en la publicación. */
export async function uploadSocialMedia(rawFile, onProgress) {
  const prepared = await prepareFile(rawFile);
  const fd = new FormData();
  fd.append('file', prepared.file);
  const { data } = await api.post('/social/media', fd, {
    onUploadProgress: (e) => {
      if (onProgress && e.total) onProgress(Math.round((e.loaded / e.total) * 100));
    },
    // Un video grande por una conexión lenta tarda: sin tope de tiempo.
    timeout: 0,
  });
  return { ...data, width: prepared.width, height: prepared.height, duration: prepared.duration };
}
