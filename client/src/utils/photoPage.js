/**
 * De una foto a una página del PDF.
 *
 * Aquí NO hay procesamiento de escaneo: no se busca el borde de la hoja, no se
 * corrige la perspectiva y no se aplica ningún filtro. La foto entra al PDF tal
 * cual se tomó; lo único que se hace es ajustar el tamaño para que un documento
 * de muchas páginas no pese de más, y sacar una miniatura para la rejilla.
 *
 * (Esto sustituye a `docScan.js`, que traía la detección de bordes por Hough, el
 * recorte en perspectiva y los filtros de realce. Se eliminó a propósito: el
 * escáner ahora es una cámara y un armador de PDF, nada más.)
 */

/**
 * Lado mayor de una página. Una foto de 12 MP dentro del PDF son varios MB por
 * hoja sin que se lea mejor; a 3000 px de lado la letra chica sigue siendo
 * legible y una tanda de 100 fotos no se va a cientos de MB.
 */
export const PAGE_MAX_SIDE = 3000;

/**
 * Calidad JPEG de la página. Es lo que queda para siempre (el PDF no recomprime),
 * así que se va alto a propósito: a 0,85 la letra chica se empasta.
 */
export const PAGE_QUALITY = 0.92;

/** Canvas → Blob JPEG (lo que se sube al servidor como página). */
export function canvasToJpeg(canvas, quality = PAGE_QUALITY) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('No se pudo convertir la imagen'))),
      'image/jpeg',
      quality
    );
  });
}

/**
 * Reduce una imagen (canvas o <img> ya cargada) hasta `maxSide`, sin deformarla.
 * Si ya cabe, devuelve la de entrada sin copiarla: redibujar 100 fotos que no lo
 * necesitan es tiempo y memoria tirados.
 */
export function fitToPage(source, maxSide = PAGE_MAX_SIDE) {
  const w = source.naturalWidth || source.width;
  const h = source.naturalHeight || source.height;
  const k = Math.min(1, maxSide / Math.max(w, h));
  if (k >= 1 && source.getContext) return source;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, c.width, c.height);
  return c;
}

/**
 * Miniatura para la rejilla de páginas, como data URL.
 *
 * Va reducida a propósito: pintar la foto entera en cada tarjeta obligaría al
 * navegador a sostener decenas de mapas de bits de 12 MP a la vez, y con una
 * tanda grande la pestaña se queda sin memoria.
 */
export function thumbnailUrl(canvas, maxSide = 320) {
  const k = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
  const t = document.createElement('canvas');
  t.width = Math.max(1, Math.round(canvas.width * k));
  t.height = Math.max(1, Math.round(canvas.height * k));
  t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
  return t.toDataURL('image/jpeg', 0.7);
}

/** Carga un File/Blob/URL de imagen en un HTMLImageElement ya decodificado. */
export function loadImage(fileOrUrl) {
  return new Promise((resolve, reject) => {
    const url = typeof fileOrUrl === 'string' ? fileOrUrl : URL.createObjectURL(fileOrUrl);
    const img = new Image();
    img.onload = () => {
      if (typeof fileOrUrl !== 'string') URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      if (typeof fileOrUrl !== 'string') URL.revokeObjectURL(url);
      reject(new Error('No se pudo leer la imagen'));
    };
    img.src = url;
  });
}
