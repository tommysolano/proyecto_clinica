import api from '../api/axios';

/**
 * Descarga robusta de archivos (Excel/PDF/XML/CSV) desde el backend.
 *
 * Problema que resuelve: con `responseType: 'blob'`, cuando el servidor responde
 * con un error (JSON), el navegador descargaba un archivo corrupto o solo se
 * mostraba un mensaje genérico. Este helper detecta y decodifica el error real
 * del servidor y lo lanza como Error con su mensaje, además de evitar descargar
 * archivos vacíos/erróneos.
 *
 * Uso:
 *   await downloadFile('/reports/citas.xlsx', { filename: 'citas.xlsx', params });
 */
export async function downloadFile(url, { filename, params, method = 'get', data } = {}) {
  let res;
  try {
    res = await api.request({ url, method, params, data, responseType: 'blob' });
  } catch (err) {
    // El cuerpo del error viene como Blob: intentar leer el mensaje JSON real.
    const body = err.response?.data;
    if (body instanceof Blob) {
      const msg = await blobErrorMessage(body);
      throw new Error(msg || 'No se pudo descargar el archivo');
    }
    throw new Error(err.response?.data?.message || err.message || 'No se pudo descargar el archivo');
  }

  const blob = res.data;
  // Algunos backends devuelven 200 pero con un JSON de error.
  if (blob && blob.type && blob.type.includes('application/json')) {
    const msg = await blobErrorMessage(blob);
    throw new Error(msg || 'El servidor no devolvió un archivo válido');
  }
  if (!blob || blob.size === 0) {
    throw new Error('El archivo generado está vacío');
  }

  const fname = filename || filenameFromHeaders(res) || 'descarga';
  triggerBlobDownload(blob, fname);
  return true;
}

async function blobErrorMessage(blob) {
  try {
    const text = await blob.text();
    const json = JSON.parse(text);
    return json.message || json.error || null;
  } catch {
    return null;
  }
}

function filenameFromHeaders(res) {
  const cd = res.headers?.['content-disposition'];
  if (!cd) return null;
  const m = /filename="?([^"]+)"?/.exec(cd);
  return m ? m[1] : null;
}

export function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  triggerAnchorDownload(url, filename);
  // OJO: el object URL NO se revoca en el mismo tick. Chrome aguanta, pero
  // Firefox y Safari cancelan la descarga en silencio si la URL desaparece antes
  // de que el gestor de descargas haya leído el blob: el usuario hace clic y no
  // pasa absolutamente nada. Un minuto es de sobra para archivos grandes y la
  // memoria se libera igual al recargar la página.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Dispara la descarga de una URL cualquiera creando un `<a download>` y haciendo
 * clic en él. SÍNCRONO a propósito: debe ejecutarse dentro del mismo clic del
 * usuario, porque Chrome bloquea (sin avisar) las descargas programáticas que
 * llegan cuando la activación de usuario ya caducó — por ejemplo después de un
 * `await fetch` lento.
 */
export function triggerAnchorDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  if (filename) a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Descarga un archivo desde una URL cualquiera: un `data:` URL base64 (así se
 * guarda la media entrante del chat) o una URL http(s) del propio servidor
 * (p. ej. /api/public/media/:id de la media saliente).
 *
 * Por qué NO basta un `<a download href="data:…">`: los navegadores BLOQUEAN
 * descargar/navegar directamente a un data: URL (Chrome: "Not allowed to navigate
 * top frame to data URL"; Firefox falla con data URLs grandes). Las imágenes se
 * ven igual porque van dentro de un `<img src>` (no es navegación), pero un
 * PDF/Word/Excel entrante NO se podía descargar al hacer clic. Aquí bajamos el
 * contenido a un Blob y disparamos la descarga con un object URL, que sí funciona
 * en todos los navegadores y sin límite de tamaño del atributo download.
 */
export async function downloadFromUrl(url, filename) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('No se pudo obtener el archivo');
  const blob = await res.blob();
  triggerBlobDownload(blob, filename || 'descarga');
}
