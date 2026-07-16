/**
 * Media del chat en el navegador: portapapeles, imágenes y notas de voz.
 *
 * El backend guarda los adjuntos como data URL en Mongo (ChatGalleryImage) y los
 * publica en /api/public/media/:id, así que hay un tope de tamaño real: el
 * uploader rechaza data URLs de más de ~2.5M caracteres. Una captura de pantalla
 * pegada es un PNG de varios MB y lo reventaría, por eso se recomprime aquí
 * antes de subirla en vez de dejar que el envío falle.
 */

// Holgura bajo el cap del backend (2.5M caracteres de data URL).
const MAX_IMAGE_DATAURL = 2_000_000;

export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('No se pudo leer el archivo'));
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('No se pudo leer la imagen'));
    img.src = src;
  });
}

// Redibuja la imagen a JPEG con el lado mayor limitado a maxDim.
function drawToJpeg(img, maxDim, quality) {
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  const ctx = canvas.getContext('2d');
  // Las capturas PNG suelen traer transparencia; sin fondo, JPEG la pinta negra.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

/**
 * Data URL de una imagen lista para subir. Si ya entra en el límite se manda tal
 * cual (sin perder calidad ni transparencia); solo si no entra se recomprime,
 * bajando resolución/calidad hasta que quepa.
 */
export async function imageFileToDataUrl(file) {
  const original = await readFileAsDataUrl(file);
  if (original.length <= MAX_IMAGE_DATAURL) return original;
  const img = await loadImage(original);
  const attempts = [
    [1600, 0.85],
    [1280, 0.8],
    [1024, 0.7],
    [800, 0.6],
  ];
  for (const [maxDim, quality] of attempts) {
    const out = drawToJpeg(img, maxDim, quality);
    if (out.length <= MAX_IMAGE_DATAURL) return out;
  }
  throw new Error('La imagen es demasiado grande para enviarla');
}

/**
 * Primera imagen del portapapeles en un evento de pegado, o null si lo pegado
 * no es una imagen (texto normal → el textarea lo maneja como siempre).
 */
export function imageFromClipboard(event) {
  const items = Array.from(event.clipboardData?.items || []);
  const item = items.find((i) => i.kind === 'file' && i.type.startsWith('image/'));
  return item ? item.getAsFile() : null;
}

/**
 * Nombre legible para una imagen pegada (el portapapeles entrega ficheros
 * llamados "image.png" o directamente sin nombre).
 */
export function pastedImageName(file) {
  const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `captura-${stamp}.${ext}`;
}
