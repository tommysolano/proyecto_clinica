/**
 * ZIP EN FLUJO (utils/zip.js → writeZipStream).
 *
 * Nace para la descarga masiva del escáner: armar el ZIP entero en memoria eran
 * cientos de MB de pico por descarga, de sobra para dejar sin RAM al servidor.
 *
 * Un ZIP mal formado no se nota hasta que alguien intenta abrir el respaldo, así
 * que aquí se PARSEA lo generado —directorio central incluido— en vez de dar por
 * bueno que los bytes están donde tocan.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');
const zlib = require('node:zlib');

const { writeZipStream, crc32 } = require('../utils/zip');

/** Recolector con `_write` ASÍNCRONO: así se ejercita el camino del 'drain'. */
class Colector extends Writable {
  constructor() {
    super({ highWaterMark: 16 * 1024 });
    this.chunks = [];
  }
  _write(chunk, _enc, cb) {
    this.chunks.push(Buffer.from(chunk));
    setImmediate(cb);
  }
  get buffer() { return Buffer.concat(this.chunks); }
}

async function generar(entries) {
  const out = new Colector();
  const escritos = await writeZipStream(entries, out);
  // El `_write` es asíncrono: sin cerrar y esperar, los últimos trozos (el
  // directorio central) aún no están en el búfer.
  await new Promise((resolve) => out.end(resolve));
  return { buffer: out.buffer, escritos };
}

/** Lee el ZIP por su DIRECTORIO CENTRAL, que es como lo hace un descompresor. */
function leerZip(buf) {
  const eocd = buf.length - 22;
  assert.equal(buf.readUInt32LE(eocd), 0x06054b50, 'falta el registro de fin de directorio central');
  const nEntradas = buf.readUInt16LE(eocd + 10);
  const tamCentral = buf.readUInt32LE(eocd + 12);
  const offCentral = buf.readUInt32LE(eocd + 16);
  assert.equal(offCentral + tamCentral, eocd, 'el directorio central no termina donde empieza el EOCD');

  const archivos = [];
  let p = offCentral;
  for (let i = 0; i < nEntradas; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, `entrada ${i}: firma del directorio central`);
    const crc = buf.readUInt32LE(p + 16);
    const comprimido = buf.readUInt32LE(p + 20);
    const original = buf.readUInt32LE(p + 24);
    const nLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const comLen = buf.readUInt16LE(p + 32);
    const offLocal = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nLen).toString('utf8');

    // Y se va a buscar el dato al header local, como haría el descompresor.
    assert.equal(buf.readUInt32LE(offLocal), 0x04034b50, `${name}: firma del header local`);
    const nLenLocal = buf.readUInt16LE(offLocal + 26);
    const extraLocal = buf.readUInt16LE(offLocal + 28);
    const inicio = offLocal + 30 + nLenLocal + extraLocal;
    const data = buf.slice(inicio, inicio + comprimido);

    archivos.push({ name, data, crc, original });
    p += 46 + nLen + extraLen + comLen;
  }
  return archivos;
}

const entrada = (name, data) => ({ name, read: async () => data });

// ─────────────────────────────────────────────────────────────────────────────
test('el ZIP generado se puede leer por su directorio central', async () => {
  const files = [
    ['vacio.pdf', Buffer.alloc(0)],
    ['pequeño.pdf', Buffer.from('%PDF-1.4 hola qué tal\n')],
    ['Escaneo con espacios (2).pdf', Buffer.from('contenido 2')],
    // 5 MB: obliga a pasar por el 'drain' varias veces.
    ['grande.pdf', Buffer.alloc(5 * 1024 * 1024, 0xab)],
  ];
  const { buffer, escritos } = await generar(files.map(([n, d]) => entrada(n, d)));
  assert.equal(escritos, files.length);

  const leidos = leerZip(buffer);
  assert.equal(leidos.length, files.length);
  for (const [i, [name, data]] of files.entries()) {
    assert.equal(leidos[i].name, name, 'el nombre viaja en UTF-8 (tildes y ñ incluidas)');
    assert.equal(leidos[i].original, data.length);
    assert.ok(leidos[i].data.equals(data), `${name}: el contenido tiene que salir intacto`);
    assert.equal(leidos[i].crc, crc32(data), `${name}: CRC`);
  }
});

test('un archivo que no se puede leer se omite sin romper el ZIP', async () => {
  const { buffer, escritos } = await generar([
    entrada('uno.pdf', Buffer.from('A')),
    { name: 'perdido.pdf', read: async () => { throw new Error('ya no está en el disco'); } },
    entrada('dos.pdf', Buffer.from('B')),
  ]);

  assert.equal(escritos, 2, 'el perdido no cuenta');
  const leidos = leerZip(buffer);
  assert.deepEqual(leidos.map((f) => f.name), ['uno.pdf', 'dos.pdf']);
  assert.ok(leidos[1].data.equals(Buffer.from('B')), 'el de después del fallo sigue bien');
});

test('sin ningún archivo sale un ZIP vacío pero válido', async () => {
  const { buffer, escritos } = await generar([]);
  assert.equal(escritos, 0);
  assert.equal(buffer.length, 22, 'solo el EOCD');
  assert.deepEqual(leerZip(buffer), []);
});

test('el método es "store": los PDF no se recomprimen', async () => {
  const data = Buffer.from('%PDF-1.4 ' + 'x'.repeat(1000));
  const { buffer } = await generar([entrada('a.pdf', data)]);
  const [f] = leerZip(buffer);
  // Método 0 = sin comprimir: el dato dentro del ZIP es el archivo tal cual.
  assert.ok(f.data.equals(data));
  // Y para descartar que sea casualidad: comprimido sería más corto.
  assert.ok(zlib.deflateRawSync(data).length < data.length, 'la prueba solo vale si el dato es comprimible');
});
