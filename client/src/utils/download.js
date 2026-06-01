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
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
