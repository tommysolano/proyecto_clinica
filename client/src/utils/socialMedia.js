import api from '../api/axios';

/**
 * Subida de medios del planificador de redes.
 *
 * Antes de subir se prepara el archivo en el navegador:
 *  - Las imágenes que no son JPG se convierten a JPG: Instagram SOLO acepta
 *    JPEG por la API, y así un PNG o WEBP no se descubre como error a la hora
 *    de publicar. Un JPG se deja tal cual (re-comprimirlo solo perdería calidad).
 *  - Se miden ancho, alto y duración: el editor avisa de proporciones y
 *    duraciones que cada red rechazaría.
 */

async function imageSize(file) {
  const bmp = await createImageBitmap(file);
  const size = { width: bmp.width, height: bmp.height };
  bmp.close?.();
  return size;
}

async function toJpeg(file) {
  const bmp = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext('2d');
  // Fondo blanco: la transparencia de un PNG saldría negra en JPG.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
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
    if (/^image\/jpe?g$/i.test(type)) return { file, ...(await imageSize(file)), duration: 0 };
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
