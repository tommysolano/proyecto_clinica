/**
 * Generador de archivos ZIP en JS puro (método "store", sin compresión).
 * Evita dependencias externas para empaquetar varios PDFs/archivos y entregarlos
 * en una sola descarga. Suficiente para descargas masivas de facturas (RIDE).
 */

// Tabla CRC32 precomputada.
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

/** Convierte una fecha a (date, time) en formato MS-DOS para el ZIP. */
function dosDateTime(d = new Date()) {
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2))) & 0xffff;
  const date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  return { time, date };
}

/**
 * Crea un Buffer ZIP a partir de una lista de archivos.
 * @param {Array<{name: string, data: Buffer}>} files
 * @returns {Buffer}
 */
function createZip(files) {
  const { time, date } = dosDateTime();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const crc = crc32(data);

    // Local file header (30 bytes + nombre).
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // firma
    local.writeUInt16LE(20, 4);         // versión necesaria
    local.writeUInt16LE(0x0800, 6);     // flags (UTF-8)
    local.writeUInt16LE(0, 8);          // método: 0 = store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // tamaño comprimido
    local.writeUInt32LE(data.length, 22); // tamaño sin comprimir
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);           // extra field length

    localParts.push(local, nameBuf, data);

    // Central directory header (46 bytes + nombre).
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);   // versión creador
    central.writeUInt16LE(20, 6);   // versión necesaria
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comentario
    central.writeUInt16LE(0, 34); // disco
    central.writeUInt16LE(0, 36); // atributos internos
    central.writeUInt32LE(0, 38); // atributos externos
    central.writeUInt32LE(offset, 42); // offset del local header
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const localBuf = Buffer.concat(localParts);

  // End of central directory record (22 bytes).
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16); // offset del central directory
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localBuf, centralBuf, eocd]);
}

module.exports = { createZip, crc32 };
