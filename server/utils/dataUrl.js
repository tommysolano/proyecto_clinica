/**
 * Parseo de data URLs (`data:<mime>[;param=valor...];base64,<datos>`).
 *
 * Ojo con el regex ingenuo `^data:([^;]+);base64,`: el navegador incluye el
 * codec en el tipo cuando graba audio (MediaRecorder produce blobs de tipo
 * `audio/webm;codecs=opus`), así que el data URL real es
 * `data:audio/webm;codecs=opus;base64,...` y un patrón que exija `;base64,`
 * justo detrás del mime lo rechaza. Aquí se separa por el marcador `;base64,`,
 * que es lo único garantizado.
 */

const MARKER = ';base64,';

/**
 * @returns {{ mimeType: string, kind: string, b64: string } | null}
 *   mimeType sin parámetros ('audio/webm'), kind es el tipo base ('audio').
 */
function parseDataUrl(dataUrl) {
  const s = String(dataUrl || '');
  if (!s.startsWith('data:')) return null;
  const idx = s.indexOf(MARKER);
  if (idx === -1) return null;
  const header = s.slice('data:'.length, idx); // 'audio/webm;codecs=opus'
  const mimeType = header.split(';')[0].trim().toLowerCase();
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mimeType)) return null;
  return {
    mimeType,
    kind: mimeType.split('/')[0],
    b64: s.slice(idx + MARKER.length),
  };
}

module.exports = { parseDataUrl };
