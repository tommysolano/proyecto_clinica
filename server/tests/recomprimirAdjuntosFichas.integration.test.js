/**
 * RECOMPRIMIR LOS ADJUNTOS GORDOS (scripts/recomprimirAdjuntosFichas.js).
 *
 * Cuando al VPS le mata el Chromium, la importación copia las fotos a tamaño
 * completo para no frenarse: en septiembre eso se llevó 3 GB de disco. Este script
 * los arregla después, y lo que hay que garantizar es que arreglarlos no ROMPA el
 * adjunto del paciente ni toque el original del escáner.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fsp = require('fs/promises');
const H = require('./_integrationHelpers');

const { recomprimir } = require('../scripts/recomprimirAdjuntosFichas');
const { paginasJpeg, pdfDePaginas } = require('../utils/scanMedia');

const JPEG_1x1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64'
);

let raiz;
test.beforeEach(async () => { raiz = await fsp.mkdtemp(path.join(require('os').tmpdir(), 'shiluv-recomp-')); });
test.afterEach(async () => { await fsp.rm(raiz, { recursive: true, force: true }).catch(() => {}); });

/** Reductor de mentira que "adelgaza" quitando el relleno que le añadimos. */
const reductorFalso = { reducir: async () => JPEG_1x1 };

test('C1) reescribe el PDF con las páginas reducidas y conserva cuántas eran', async () => {
  const gordo = Buffer.concat([JPEG_1x1, Buffer.alloc(4000)]);
  const ruta = path.join(raiz, 'adjunto.pdf');
  await fsp.writeFile(ruta, await pdfDePaginas([gordo, gordo], 'Ficha'));
  const antes = (await fsp.stat(ruta)).size;

  const nuevo = await recomprimir(ruta, 'Ficha', reductorFalso);

  assert.ok(nuevo > 0 && nuevo < antes, `debe adelgazar (${antes} → ${nuevo})`);
  assert.equal((await fsp.stat(ruta)).size, nuevo, 'el tamaño que informa es el del archivo');
  assert.equal(paginasJpeg(await fsp.readFile(ruta)).length, 2, 'sigue teniendo sus dos páginas');
});

test('C2) si no adelgaza, el archivo se queda EXACTAMENTE como estaba', async () => {
  // Un PDF ya reducido: recomprimirlo no gana nada, y reescribirlo solo arriesga.
  const ruta = path.join(raiz, 'yaChico.pdf');
  const original = await pdfDePaginas([JPEG_1x1], 'Ficha');
  await fsp.writeFile(ruta, original);

  const nuevo = await recomprimir(ruta, 'Ficha', reductorFalso);

  assert.equal(nuevo, 0, 'avisa de que no hizo nada');
  assert.deepEqual(await fsp.readFile(ruta), original, 'el archivo no se tocó');
});

test('C3) un PDF que no se puede despiezar se deja en paz', async () => {
  // Los adjuntos que no hizo el escáner (o con páginas en PNG) no se tocan: mejor
  // un adjunto grande que uno roto.
  const ruta = path.join(raiz, 'raro.pdf');
  const original = Buffer.from('%PDF-1.4 esto no lo hizo el escaner');
  await fsp.writeFile(ruta, original);

  assert.equal(await recomprimir(ruta, 'Raro', reductorFalso), 0);
  assert.deepEqual(await fsp.readFile(ruta), original);
});

test('C4) no deja restos si algo falla a medias', async () => {
  const ruta = path.join(raiz, 'adjunto.pdf');
  await fsp.writeFile(ruta, await pdfDePaginas([Buffer.concat([JPEG_1x1, Buffer.alloc(4000)])], 'Ficha'));
  const explota = { reducir: async () => { throw new Error('el navegador se cayó'); } };

  await assert.rejects(() => recomprimir(ruta, 'Ficha', explota));

  const restos = (await fsp.readdir(raiz)).filter((f) => f.endsWith('.nuevo'));
  assert.deepEqual(restos, [], 'sin archivos .nuevo tirados por ahí');
  assert.ok(paginasJpeg(await fsp.readFile(ruta)).length, 'y el adjunto sigue siendo válido');
});
