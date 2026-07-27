/**
 * Almacén de archivos EN DISCO para la media del chat.
 *
 * POR QUÉ EXISTE
 * --------------
 * Hasta jul-2026 todo archivo que pasaba por el chat (fotos, notas de voz,
 * videos, PDFs) se guardaba como texto base64 DENTRO de MongoDB. Medido en
 * producción:
 *
 *     base de datos completa .......... 169 MB
 *     de eso, archivos en base64 ...... 149 MB  (88%)
 *     toda la operación de la clínica ..  20 MB
 *       (pacientes, citas, contabilidad, nómina, facturación al SRI…)
 *
 * Seis videos ocupaban 60 MB de una cuota de 512 MB. Y como base64 infla un 33%,
 * ~112 MB de archivos reales consumían ~149 MB. Peor aún: el cluster está a
 * 118 ms del servidor y con el ancho de banda limitado del plan gratuito, así que
 * cada vez que un agente abría un chat con un video, esos megas cruzaban el
 * cuello de botella.
 *
 * Mientras tanto el servidor tiene 65 GB de disco libres al lado.
 *
 * Ahora los bytes viven en disco y Mongo solo guarda la ruta. La base baja a ~20 MB
 * y la media se sirve desde la misma máquina, en milisegundos.
 *
 * DÓNDE SE GUARDAN
 * ----------------
 * `MEDIA_DIR` (env) o, por defecto, `server/storage/media` — el mismo sitio que ya
 * usan los archivos de importación de contactos, que sobrevive a los despliegues
 * (`git reset --hard` no borra ficheros no versionados).
 *
 * Estructura: `<MEDIA_DIR>/<año>/<mes>/<id>.<ext>`, troceado por fecha para no
 * acabar con un único directorio de decenas de miles de archivos.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const DEFAULT_DIR = path.join(__dirname, '..', 'storage', 'media');

/** Raíz del almacén. Se lee en cada llamada para que los tests puedan cambiarla. */
function rootDir() {
  return process.env.MEDIA_DIR || DEFAULT_DIR;
}

// Extensión a partir del tipo MIME. Solo es cosmética (el tipo real se guarda en
// Mongo), pero hace que el directorio se pueda inspeccionar a mano en el servidor.
const EXT = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/gif': 'gif', 'video/mp4': 'mp4', 'video/3gpp': '3gp', 'video/quicktime': 'mov',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/amr': 'amr',
  'application/pdf': 'pdf', 'text/plain': 'txt',
};

function extensionFor(mimeType) {
  const clean = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (EXT[clean]) return EXT[clean];
  const tail = clean.split('/')[1] || 'bin';
  return tail.replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin';
}

/**
 * Clave de almacenamiento (ruta RELATIVA a la raíz). Se guarda tal cual en Mongo:
 * relativa a propósito, para poder mover el almacén de sitio sin reescribir la base.
 */
function buildKey(id, mimeType, when = new Date()) {
  const y = when.getFullYear();
  const mm = String(when.getMonth() + 1).padStart(2, '0');
  return `${y}/${mm}/${id}.${extensionFor(mimeType)}`;
}

/**
 * Ruta absoluta de una clave. Rechaza claves que intenten salirse del almacén
 * (`../`): la clave sale de la base de datos y no debe poder apuntar a
 * `/etc/passwd` ni al `.env` del servidor.
 */
function absolutePath(storageKey) {
  const root = path.resolve(rootDir());
  const abs = path.resolve(root, String(storageKey || ''));
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`Clave de media fuera del almacén: ${storageKey}`);
  }
  return abs;
}

/**
 * Escribe los bytes en disco y devuelve su clave. La escritura es a un temporal
 * seguido de `rename` (atómico en el mismo sistema de ficheros): si el proceso
 * muere a mitad, nunca queda un archivo a medias que parezca bueno.
 */
async function write({ id, buffer, mimeType, when }) {
  const key = buildKey(id, mimeType, when);
  const abs = absolutePath(key);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, buffer);
  await fsp.rename(tmp, abs);
  return { storageKey: key, size: buffer.length };
}

/** Bytes de una clave. `null` si el archivo no está (no lanza). */
async function read(storageKey) {
  try {
    return await fsp.readFile(absolutePath(storageKey));
  } catch {
    return null;
  }
}

/** Tamaño en bytes, o `null` si no existe. */
async function size(storageKey) {
  try {
    const st = await fsp.stat(absolutePath(storageKey));
    return st.size;
  } catch {
    return null;
  }
}

/**
 * Stream de lectura (con rango opcional). Es lo que usa el endpoint público: un
 * video de 15 MB se envía por trozos sin cargarlo entero en memoria, que con
 * varios agentes a la vez tumbaría el proceso.
 */
function createReadStream(storageKey, opts = {}) {
  return fs.createReadStream(absolutePath(storageKey), opts);
}

/** Borra el archivo. No lanza si ya no está. */
async function remove(storageKey) {
  try {
    await fsp.unlink(absolutePath(storageKey));
    return true;
  } catch {
    return false;
  }
}

/**
 * Bytes de un adjunto del chat por su id, venga de donde venga.
 *
 * Es la ÚNICA puerta que deben usar el endpoint público y los dos gateways de
 * WhatsApp (QR y Cloud API). Resuelve los dos formatos:
 *   - `storageKey` → archivo en disco (lo nuevo)
 *   - `dataUrl`    → base64 en Mongo (lo anterior a la migración)
 *
 * Así el envío por WhatsApp sigue funcionando durante la migración y después,
 * sin que ninguno de los dos gateways tenga que saber dónde vive el archivo.
 */
async function loadAttachment(id) {
  const ChatGalleryImage = require('../models/ChatGalleryImage');
  const doc = await ChatGalleryImage.findById(id).select('dataUrl storageKey mimeType name').lean().catch(() => null);
  if (!doc) return null;
  if (doc.storageKey) {
    const buffer = await read(doc.storageKey);
    if (buffer) return { buffer, mimeType: doc.mimeType || 'application/octet-stream', name: doc.name || '', storageKey: doc.storageKey };
    // El archivo debería estar y no está: se avisa fuerte. Si además quedaba el
    // base64 se usa como red de seguridad en vez de perder el adjunto.
    console.error('[mediaStore] FALTA el archivo en disco: %s (id=%s)', doc.storageKey, id);
  }
  if (doc.dataUrl) {
    const parsed = require('./dataUrl').parseDataUrl(doc.dataUrl);
    if (parsed) {
      return {
        buffer: Buffer.from(parsed.b64, 'base64'),
        mimeType: parsed.mimeType || doc.mimeType || 'application/octet-stream',
        name: doc.name || '',
        storageKey: '',
      };
    }
  }
  return null;
}

module.exports = {
  absolutePath,
  buildKey,
  createReadStream,
  extensionFor,
  loadAttachment,
  read,
  remove,
  rootDir,
  size,
  write,
};
