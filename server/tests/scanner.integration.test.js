/**
 * Escáner de documentos: armado del PDF, nombres únicos, listado, descarga
 * individual y en ZIP, renombrado y borrado.
 *
 * Las páginas llegan como JPEG desde el navegador (ya recortadas); aquí se
 * generan JPEG mínimos de verdad con pdfkit para que el PDF sea real.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const H = require('./_integrationHelpers');

const scans = require('../controllers/scanController');
const ScannedDocument = require('../models/ScannedDocument');

const { SCANS_DIR } = scans._internals;

test.before(async () => { await H.startDb(); });
test.after(async () => {
  await H.stopDb();
  // El controller escribe en server/storage/scans: se limpia lo del test.
  await fsp.rm(SCANS_DIR, { recursive: true, force: true }).catch(() => {});
});
test.beforeEach(async () => { await H.resetDb(); });

/**
 * PNG 1×1 válido (el más pequeño posible). pdfkit lo acepta igual que un JPEG
 * de cámara y evita depender de un binario de ejemplo en el repo.
 */
function tinyPng(gray = 200) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(require('../utils/zip').crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);       // ancho
  ihdr.writeUInt32BE(1, 4);       // alto
  ihdr[8] = 8;                    // profundidad
  ihdr[9] = 2;                    // color RGB
  const raw = Buffer.from([0, gray, gray, gray]); // filtro 0 + pixel
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const pageFiles = (n) =>
  Array.from({ length: n }, (_, i) => ({
    buffer: tinyPng(200 - i * 10),
    mimetype: 'image/png',
    originalname: `pagina-${i + 1}.png`,
  }));

const uploadReq = (clinicId, userId, { pages = 1, name, ...body } = {}) => {
  const req = H.mockReq(clinicId, userId, { ...(name === undefined ? {} : { name }), ...body });
  req.files = pageFiles(pages);
  return req;
};

/** mockRes ampliado: `send` con Buffer (descargas de PDF/ZIP). */
function binaryRes() {
  const { res, state } = H.mockRes();
  return { res, state };
}

// ─────────────────────────────────────────────────────────────────────────────
test('Escáner — varias fotos se convierten en un solo PDF guardado en disco', async () => {
  const { clinicId, userId } = await H.seedClinic();

  const r = await H.runController(scans.createScan, uploadReq(clinicId, userId, { pages: 3, name: 'Receta Ana' }));

  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(r.payload.name, 'Receta Ana');
  assert.equal(r.payload.pages, 3);
  assert.ok(r.payload.size > 0);

  const doc = await ScannedDocument.findById(r.payload._id);
  const file = path.join(SCANS_DIR, String(clinicId), doc.filename);
  assert.ok(fs.existsSync(file), 'el PDF debería estar en disco');
  const bytes = await fsp.readFile(file);
  assert.equal(bytes.slice(0, 5).toString('ascii'), '%PDF-', 'el archivo no es un PDF');
  // Una página del PDF por cada foto.
  assert.equal((bytes.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length, 3);
});

// ─────────────────────────────────────────────────────────────────────────────
//  Un PDF por imagen (mode=split)
// ─────────────────────────────────────────────────────────────────────────────
test('Escáner separado — cada imagen sale como un PDF distinto, numerado', async () => {
  const { clinicId, userId } = await H.seedClinic();

  const r = await H.runController(
    scans.createScan,
    uploadReq(clinicId, userId, { pages: 3, name: 'Receta Ana', mode: 'split' })
  );

  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(r.payload.count, 3);
  assert.deepEqual(r.payload.documents.map((d) => d.name), ['Receta Ana 1', 'Receta Ana 2', 'Receta Ana 3']);
  // Tres fichas, cada una de UNA página y con su propio archivo en disco.
  assert.equal(await ScannedDocument.countDocuments({ clinic: clinicId }), 3);
  const archivos = new Set();
  for (const d of r.payload.documents) {
    assert.equal(d.pages, 1);
    assert.ok(d.size > 0);
    const doc = await ScannedDocument.findById(d._id);
    archivos.add(doc.filename);
    const bytes = await fsp.readFile(path.join(SCANS_DIR, String(clinicId), doc.filename));
    assert.equal(bytes.slice(0, 5).toString('ascii'), '%PDF-');
    assert.equal((bytes.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length, 1);
  }
  assert.equal(archivos.size, 3, 'cada PDF debe ser un archivo aparte');
});

test('Escáner separado — sin nombre, cada PDF se llama como su imagen (sin extensión)', async () => {
  const { clinicId, userId } = await H.seedClinic();

  const r = await H.runController(
    scans.createScan,
    uploadReq(clinicId, userId, {
      pages: 3,
      mode: 'split',
      pageNames: JSON.stringify(['cedula-ana.jpg', 'receta.PNG', '']),
    })
  );

  const nombres = r.payload.documents.map((d) => d.name);
  assert.equal(nombres[0], 'cedula-ana');
  assert.equal(nombres[1], 'receta');
  // La tercera no traía nombre propio (foto de cámara): la fecha + su número.
  assert.match(nombres[2], /^Escaneo \d{2}-\d{2}-\d{4} 3$/);
});

test('Escáner separado — los nombres repetidos dentro de la MISMA tanda no chocan', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await H.runController(scans.createScan, uploadReq(clinicId, userId, { name: 'Cédula' }));

  const r = await H.runController(
    scans.createScan,
    uploadReq(clinicId, userId, {
      pages: 3,
      mode: 'split',
      pageNames: JSON.stringify(['cedula.jpg', 'cedula.jpg', 'CEDULA.jpg']),
    })
  );

  assert.deepEqual(r.payload.documents.map((d) => d.name), ['cedula (2)', 'cedula (3)', 'CEDULA (4)']);
  assert.equal(await ScannedDocument.countDocuments({ clinic: clinicId }), 4);
});

test('Escáner separado — una tanda partida en varios envíos sigue la numeración', async () => {
  const { clinicId, userId } = await H.seedClinic();

  // El cliente parte las tandas grandes en varias peticiones: la segunda avisa
  // cuántas imágenes van ya para que los nombres no vuelvan a empezar en 1.
  const a = await H.runController(
    scans.createScan,
    uploadReq(clinicId, userId, { pages: 2, name: 'Ficha', mode: 'split' })
  );
  const b = await H.runController(
    scans.createScan,
    uploadReq(clinicId, userId, { pages: 2, name: 'Ficha', mode: 'split', startIndex: 2 })
  );

  assert.deepEqual(a.payload.documents.map((d) => d.name), ['Ficha 1', 'Ficha 2']);
  assert.deepEqual(b.payload.documents.map((d) => d.name), ['Ficha 3', 'Ficha 4']);
  assert.equal(await ScannedDocument.countDocuments({ clinic: clinicId }), 4);
});

test('Escáner separado — sin el modo se sigue armando un solo PDF (lo de siempre)', async () => {
  const { clinicId, userId } = await H.seedClinic();

  const r = await H.runController(scans.createScan, uploadReq(clinicId, userId, { pages: 3, name: 'Todo junto' }));

  assert.equal(r.payload.name, 'Todo junto');
  assert.equal(r.payload.pages, 3);
  assert.equal(r.payload.documents, undefined);
  assert.equal(await ScannedDocument.countDocuments({ clinic: clinicId }), 1);
});

test('Escáner separado — una imagen rota no tumba al resto de la tanda', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const req = uploadReq(clinicId, userId, { pages: 3, name: 'Tanda', mode: 'split' });
  req.files[1] = { buffer: Buffer.from('esto no es una imagen'), mimetype: 'image/png', originalname: 'rota.png' };

  const r = await H.runController(scans.createScan, req);

  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(r.payload.count, 2);
  assert.deepEqual(r.payload.documents.map((d) => d.name), ['Tanda 1', 'Tanda 3']);
  assert.equal(r.payload.errors.length, 1);
  assert.match(r.payload.errors[0], /Imagen 2/);

  // Con desplazamiento, el aviso nombra la imagen por su número real en la tanda.
  const req2 = uploadReq(clinicId, userId, { pages: 2, name: 'Otra', mode: 'split', startIndex: 10 });
  req2.files[0] = { buffer: Buffer.from('rota'), mimetype: 'image/png', originalname: 'rota.png' };
  const r2 = await H.runController(scans.createScan, req2);
  assert.match(r2.payload.errors[0], /Imagen 11/);
  assert.deepEqual(r2.payload.documents.map((d) => d.name), ['Otra 12']);
});

// ─────────────────────────────────────────────────────────────────────────────
//  Un PDF único que llega en varias tandas (sin tope de imágenes)
// ─────────────────────────────────────────────────────────────────────────────
test('Escáner — un PDF único puede pasar del tope de una petición: llega por tandas', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const sessionId = 'tanda-de-prueba-1';

  // Dos envíos intermedios: apartan las páginas y NO crean ninguna ficha.
  const a = await H.runController(
    scans.createScan,
    uploadReq(clinicId, userId, { pages: 3, name: 'Historia larga', sessionId, startIndex: 0, finish: 'false' })
  );
  assert.equal(a.statusCode, 202, JSON.stringify(a.payload));
  assert.equal(a.payload.staged, true);
  assert.equal(a.payload.pages, 3);
  assert.equal(await ScannedDocument.countDocuments({ clinic: clinicId }), 0, 'todavía no hay documento');

  const b = await H.runController(
    scans.createScan,
    uploadReq(clinicId, userId, { pages: 3, name: 'Historia larga', sessionId, startIndex: 3, finish: 'false' })
  );
  assert.equal(b.payload.pages, 6);

  // El último envío junta TODO en un solo PDF.
  const c = await H.runController(
    scans.createScan,
    uploadReq(clinicId, userId, { pages: 2, name: 'Historia larga', sessionId, startIndex: 6, finish: 'true' })
  );
  assert.equal(c.statusCode, 201, JSON.stringify(c.payload));
  assert.equal(c.payload.name, 'Historia larga');
  assert.equal(c.payload.pages, 8, 'las 8 páginas de las tres tandas van en el mismo PDF');

  assert.equal(await ScannedDocument.countDocuments({ clinic: clinicId }), 1, 'un solo documento, no uno por tanda');
  const doc = await ScannedDocument.findById(c.payload._id);
  const bytes = await fsp.readFile(path.join(SCANS_DIR, String(clinicId), doc.filename));
  assert.equal(bytes.slice(0, 5).toString('ascii'), '%PDF-');
  assert.equal((bytes.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length, 8);

  // El apartado temporal se limpia: no se queda ocupando disco.
  assert.equal(fs.existsSync(scans._internals.stagingDir(clinicId, sessionId)), false);
});

test('Escáner — las tandas de un PDF único respetan el orden aunque lleguen al revés', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const sessionId = 'tanda-desordenada';

  // La segunda tanda llega ANTES que la primera (dos peticiones en paralelo).
  await H.runController(
    scans.createScan,
    uploadReq(clinicId, userId, { pages: 2, name: 'Orden', sessionId, startIndex: 2, finish: 'false' })
  );
  const r = await H.runController(
    scans.createScan,
    uploadReq(clinicId, userId, { pages: 2, name: 'Orden', sessionId, startIndex: 0, finish: 'true' })
  );

  assert.equal(r.payload.pages, 4);
  // El orden lo fija `startIndex`, no el orden de llegada.
  const rutas = await scans._internals.stagedPaths(clinicId, sessionId);
  assert.deepEqual(rutas, [], 'el apartado quedó vacío tras armar el PDF');
});

test('Escáner — un sessionId con truco no saca los archivos de su carpeta', async () => {
  const { validSessionId } = scans._internals;
  assert.equal(validSessionId('../../etc'), '');
  assert.equal(validSessionId('con/barra'), '');
  assert.equal(validSessionId('corto'), '');
  assert.equal(validSessionId('sesion-valida-123'), 'sesion-valida-123');
});

test('Escáner — sin sessionId un PDF único sigue armándose de una sola vez', async () => {
  const { clinicId, userId } = await H.seedClinic();

  const r = await H.runController(scans.createScan, uploadReq(clinicId, userId, { pages: 2, name: 'De una' }));

  assert.equal(r.statusCode, 201);
  assert.equal(r.payload.pages, 2);
});

test('Escáner — el nombre no se repite: el sistema agrega (2), (3)…', async () => {
  const { clinicId, userId } = await H.seedClinic();

  const a = await H.runController(scans.createScan, uploadReq(clinicId, userId, { name: 'Cédula' }));
  const b = await H.runController(scans.createScan, uploadReq(clinicId, userId, { name: 'Cédula' }));
  // Mismo nombre con otra caja y sin tilde: sigue siendo el mismo para el sistema.
  const c = await H.runController(scans.createScan, uploadReq(clinicId, userId, { name: 'cedula' }));

  assert.equal(a.payload.name, 'Cédula');
  assert.equal(b.payload.name, 'Cédula (2)');
  assert.equal(c.payload.name, 'cedula (3)');
  assert.equal(await ScannedDocument.countDocuments({ clinic: clinicId }), 3);
});

test('Escáner — sin nombre usa uno por defecto con la fecha', async () => {
  const { clinicId, userId } = await H.seedClinic();

  const r = await H.runController(scans.createScan, uploadReq(clinicId, userId, {}));

  assert.match(r.payload.name, /^Escaneo \d{2}-\d{2}-\d{4}$/);
});

test('Escáner — sin páginas no se crea nada', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const req = H.mockReq(clinicId, userId, { name: 'Vacío' });
  req.files = [];

  const r = await H.runController(scans.createScan, req);

  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /al menos una página/i);
  assert.equal(await ScannedDocument.countDocuments({}), 0);
});

test('Escáner — cada sucursal ve solo sus documentos', async () => {
  const a = await H.seedClinic();
  const b = await H.seedClinic();
  await H.runController(scans.createScan, uploadReq(a.clinicId, a.userId, { name: 'De la sede A' }));
  await H.runController(scans.createScan, uploadReq(b.clinicId, b.userId, { name: 'De la sede B' }));

  const list = await H.runController(scans.listScans, H.mockReq(a.clinicId, a.userId));

  assert.equal(list.payload.total, 1);
  assert.equal(list.payload.documents[0].name, 'De la sede A');
});

test('Escáner — se descarga uno solo y varios en un ZIP', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const uno = await H.runController(scans.createScan, uploadReq(clinicId, userId, { name: 'Uno' }));
  const dos = await H.runController(scans.createScan, uploadReq(clinicId, userId, { pages: 2, name: 'Dos' }));

  // Individual.
  const { res, state } = binaryRes();
  await scans.downloadScan(
    { ...H.mockReq(clinicId, userId), params: { id: uno.payload._id }, query: {} },
    res
  );
  assert.equal(state.headers['Content-Type'], 'application/pdf');
  assert.match(state.headers['Content-Disposition'], /attachment; filename="Uno\.pdf"/);
  assert.equal(state.payload.slice(0, 5).toString('ascii'), '%PDF-');

  // En grupo (ZIP).
  const zipRes = binaryRes();
  await scans.downloadZip(
    H.mockReq(clinicId, userId, { ids: [uno.payload._id, dos.payload._id] }),
    zipRes.res
  );
  assert.equal(zipRes.state.headers['Content-Type'], 'application/zip');
  const zip = zipRes.state.payload;
  assert.equal(zip.slice(0, 2).toString('ascii'), 'PK');
  const asText = zip.toString('latin1');
  assert.ok(asText.includes('Uno.pdf'), 'el ZIP debería traer Uno.pdf');
  assert.ok(asText.includes('Dos.pdf'), 'el ZIP debería traer Dos.pdf');
});

test('Escáner — renombrar respeta la unicidad', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await H.runController(scans.createScan, uploadReq(clinicId, userId, { name: 'Informe' }));
  const otro = await H.runController(scans.createScan, uploadReq(clinicId, userId, { name: 'Borrador' }));

  const r = await H.runController(scans.renameScan, {
    ...H.mockReq(clinicId, userId, { name: 'Informe' }),
    params: { id: otro.payload._id },
  });

  assert.equal(r.payload.name, 'Informe (2)');
});

test('Escáner — solo el autor (o un admin) puede eliminar; el archivo se borra del disco', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const otroUsuario = new H.mongoose.Types.ObjectId();
  const doc = await H.runController(scans.createScan, uploadReq(clinicId, userId, { name: 'Privado' }));
  const file = path.join(SCANS_DIR, String(clinicId), (await ScannedDocument.findById(doc.payload._id)).filename);

  // Otro usuario con rol no administrativo: no puede.
  const denied = await H.runController(scans.deleteScan, {
    ...H.mockReq(clinicId, otroUsuario, {}, { role: 'cajero' }),
    params: { id: doc.payload._id },
  });
  assert.equal(denied.statusCode, 403);
  assert.ok(fs.existsSync(file));

  // El autor sí.
  const ok = await H.runController(scans.deleteScan, {
    ...H.mockReq(clinicId, userId, {}, { role: 'cajero' }),
    params: { id: doc.payload._id },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(await ScannedDocument.countDocuments({}), 0);
  assert.ok(!fs.existsSync(file), 'el PDF debería haberse borrado del disco');
});

test('Escáner — el super-admin puede eliminar lo de otro aunque su rol no sea admin', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const jefe = new H.mongoose.Types.ObjectId();
  const doc = await H.runController(scans.createScan, uploadReq(clinicId, userId, { name: 'De otro' }));

  const req = { ...H.mockReq(clinicId, jefe, {}, { role: 'cajero' }), params: { id: doc.payload._id } };
  req.user.isSuperAdmin = true;
  const r = await H.runController(scans.deleteScan, req);

  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(await ScannedDocument.countDocuments({}), 0);
});

// ─────────────────────────────────────────────────────────────────────────────
//  Eliminar varios de una vez
// ─────────────────────────────────────────────────────────────────────────────
test('Escáner — el admin elimina varios de una vez y sus archivos salen del disco', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const creados = [];
  for (const name of ['Uno', 'Dos', 'Tres']) {
    creados.push((await H.runController(scans.createScan, uploadReq(clinicId, userId, { name }))).payload);
  }
  const archivos = [];
  for (const d of creados) {
    archivos.push(path.join(SCANS_DIR, String(clinicId), (await ScannedDocument.findById(d._id)).filename));
  }

  const r = await H.runController(
    scans.deleteManyScans,
    H.mockReq(clinicId, userId, { ids: [creados[0]._id, creados[2]._id] })
  );

  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(r.payload.deleted, 2);
  assert.deepEqual(r.payload.skipped, []);
  assert.equal(await ScannedDocument.countDocuments({ clinic: clinicId }), 1);
  assert.ok(!fs.existsSync(archivos[0]));
  assert.ok(fs.existsSync(archivos[1]), 'el que no se seleccionó sigue ahí');
  assert.ok(!fs.existsSync(archivos[2]));
});

test('Escáner — al eliminar varios, los ajenos se saltan y se dice cuáles', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const otro = new H.mongoose.Types.ObjectId();
  const mio = (await H.runController(scans.createScan, uploadReq(clinicId, otro, { name: 'Mío' }))).payload;
  const ajeno = (await H.runController(scans.createScan, uploadReq(clinicId, userId, { name: 'Ajeno' }))).payload;

  const r = await H.runController(
    scans.deleteManyScans,
    H.mockReq(clinicId, otro, { ids: [mio._id, ajeno._id] }, { role: 'cajero' })
  );

  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(r.payload.deleted, 1);
  assert.deepEqual(r.payload.skipped, ['Ajeno']);
  assert.equal(await ScannedDocument.countDocuments({ clinic: clinicId }), 1);
});

test('Escáner — eliminar varios sin permiso sobre ninguno no borra nada', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const otro = new H.mongoose.Types.ObjectId();
  const doc = (await H.runController(scans.createScan, uploadReq(clinicId, userId, { name: 'Ajeno' }))).payload;

  const r = await H.runController(
    scans.deleteManyScans,
    H.mockReq(clinicId, otro, { ids: [doc._id] }, { role: 'cajero' })
  );

  assert.equal(r.statusCode, 403);
  assert.equal(await ScannedDocument.countDocuments({ clinic: clinicId }), 1);
});

test('Escáner — eliminar varios no cruza sucursales ni acepta una selección vacía', async () => {
  const a = await H.seedClinic();
  const b = await H.seedClinic();
  const suyo = (await H.runController(scans.createScan, uploadReq(b.clinicId, b.userId, { name: 'De la sede B' }))).payload;

  const vacio = await H.runController(scans.deleteManyScans, H.mockReq(a.clinicId, a.userId, { ids: [] }));
  assert.equal(vacio.statusCode, 400);

  // Desde la sede A no se puede tocar un documento de la sede B.
  const cruzado = await H.runController(scans.deleteManyScans, H.mockReq(a.clinicId, a.userId, { ids: [suyo._id] }));
  assert.equal(cruzado.statusCode, 404);
  assert.equal(await ScannedDocument.countDocuments({ clinic: b.clinicId }), 1);
});

test('Escáner — el buscador ignora tildes y mayúsculas', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await H.runController(scans.createScan, uploadReq(clinicId, userId, { name: 'Exámenes de laboratorio' }));
  await H.runController(scans.createScan, uploadReq(clinicId, userId, { name: 'Factura proveedor' }));

  const r = await H.runController(scans.listScans, {
    ...H.mockReq(clinicId, userId),
    query: { search: 'EXAMENES' },
  });

  assert.equal(r.payload.total, 1);
  assert.equal(r.payload.documents[0].name, 'Exámenes de laboratorio');
});

test('Escáner — "descargar todos" baja TODO, no solo lo que cabe en una página', async () => {
  const { clinicId, userId } = await H.seedClinic();
  // Más documentos de los que muestra una página del listado.
  for (let i = 1; i <= 55; i++) {
    await H.runController(scans.createScan, uploadReq(clinicId, userId, { name: `Ficha ${i}` }));
  }

  // El listado, en efecto, solo entrega la primera página.
  const listado = await H.runController(
    scans.listScans,
    { ...H.mockReq(clinicId, userId), query: { page: 1, limit: 50 } }
  );
  assert.equal(listado.payload.documents.length, 50);
  assert.equal(listado.payload.total, 55);

  const zipRes = binaryRes();
  await scans.downloadZip(H.mockReq(clinicId, userId, { all: true }), zipRes.res);

  assert.equal(zipRes.state.headers['Content-Type'], 'application/zip');
  const asText = zipRes.state.payload.toString('latin1');
  // La 55 solo está si el servidor resolvió la lista entera, no la página vista.
  assert.ok(asText.includes('Ficha 55.pdf'), 'debe incluir la última, fuera de la primera página');
  assert.ok(asText.includes('Ficha 1.pdf'));
  const entradas = asText.split('Ficha ').length - 1;
  assert.ok(entradas >= 55, `esperaba las 55 fichas, encontré ${entradas} referencias`);
});

test('Escáner — "descargar todos" respeta el buscador y no cruza sucursales', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const otra = await H.seedClinic();
  await H.runController(scans.createScan, uploadReq(clinicId, userId, { name: 'Ficha Ana' }));
  await H.runController(scans.createScan, uploadReq(clinicId, userId, { name: 'Receta Luis' }));
  await H.runController(scans.createScan, uploadReq(otra.clinicId, otra.userId, { name: 'Ficha Ajena' }));

  const zipRes = binaryRes();
  // Sin tilde ni mayúsculas: el filtro es el mismo que el del listado.
  await scans.downloadZip(H.mockReq(clinicId, userId, { all: true, search: 'ficha' }), zipRes.res);

  const asText = zipRes.state.payload.toString('latin1');
  assert.ok(asText.includes('Ficha Ana.pdf'));
  assert.ok(!asText.includes('Receta Luis.pdf'), 'lo que no casa con la búsqueda no se descarga');
  assert.ok(!asText.includes('Ficha Ajena.pdf'), 'jamás documentos de otra sucursal');
});

test('Escáner — "descargar todos" sin documentos avisa en vez de mandar un ZIP vacío', async () => {
  const { clinicId, userId } = await H.seedClinic();

  const r = await H.runController(scans.downloadZip, H.mockReq(clinicId, userId, { all: true }));

  assert.equal(r.statusCode, 404);
  assert.match(r.payload.message, /No hay documentos/);
});

// ─────────────────────────────────────────────────────────────────────────────
//  «Un PDF por imagen» sin tope: una tanda GRANDE repartida en varios envíos
// ─────────────────────────────────────────────────────────────────────────────
/**
 * El cliente parte las tandas en envíos de MAX_POR_ENVIO (40) imágenes. Aquí se
 * reproduce eso con 100 fotos: 40 + 40 + 20. Lo que se comprueba es que NO se
 * pierde ni una por el camino, que la numeración sigue entre envíos y que cada
 * PDF acaba en su propio archivo. Este es el caso que el usuario ve como
 * «subo 100 fotos y quiero 100 PDF».
 */
test('Escáner separado — 100 imágenes en tandas de 40 crean 100 PDF, sin tope', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const TOTAL = 100;
  const POR_ENVIO = scans._internals.MAX_POR_ENVIO;
  assert.equal(POR_ENVIO, 40, 'si cambia el tamaño de la tanda, este test debe seguirlo');

  let subidas = 0;
  let creados = 0;
  const nombres = [];
  while (subidas < TOTAL) {
    const cuantas = Math.min(POR_ENVIO, TOTAL - subidas);
    const req = uploadReq(clinicId, userId, {
      pages: cuantas,
      name: 'Cédula',
      mode: 'split',
      startIndex: subidas,
    });
    // eslint-disable-next-line no-await-in-loop
    const r = await H.runController(scans.createScan, req);
    assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
    assert.equal(r.payload.errors.length, 0, `envío desde ${subidas}: ${r.payload.errors[0] || ''}`);
    creados += r.payload.count;
    nombres.push(...r.payload.documents.map((d) => d.name));
    subidas += cuantas;
  }

  assert.equal(creados, TOTAL, 'ninguna imagen se queda por el camino');
  assert.equal(await ScannedDocument.countDocuments({ clinic: clinicId }), TOTAL);
  // La numeración es continua entre envíos: 1..100, sin repetir ni saltar.
  assert.deepEqual(nombres, Array.from({ length: TOTAL }, (_, i) => `Cédula ${i + 1}`));
  // Cada uno es un archivo distinto y de una sola página.
  const docs = await ScannedDocument.find({ clinic: clinicId }).lean();
  assert.equal(new Set(docs.map((d) => d.filename)).size, TOTAL, 'cada PDF es un archivo aparte');
  assert.ok(docs.every((d) => d.pages === 1 && d.size > 0));
  assert.ok(fs.existsSync(path.join(SCANS_DIR, String(clinicId), docs[0].filename)));
});

test('Escáner separado — sin nombre escrito, 100 fotos de cámara no chocan entre tandas', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const TOTAL = 100;

  // Sin `name` y sin `pageNames`: todos los PDF salen del nombre por defecto
  // ("Escaneo dd-mm-aaaa N"). Es el caso que más presiona al repartidor de
  // nombres, porque la base parte de un único nombre repetido.
  let subidas = 0;
  const nombres = [];
  while (subidas < TOTAL) {
    const cuantas = Math.min(40, TOTAL - subidas);
    // eslint-disable-next-line no-await-in-loop
    const r = await H.runController(
      scans.createScan,
      uploadReq(clinicId, userId, { pages: cuantas, mode: 'split', startIndex: subidas })
    );
    nombres.push(...r.payload.documents.map((d) => d.name));
    subidas += cuantas;
  }

  assert.equal(nombres.length, TOTAL);
  // Ni un nombre repetido: el índice único {clinic, nameKey} habría reventado.
  assert.equal(new Set(nombres.map((n) => n.toLowerCase())).size, TOTAL);
  assert.equal(await ScannedDocument.countDocuments({ clinic: clinicId }), TOTAL);
});

test('Escáner separado — 100 imágenes con el MISMO nombre de archivo se numeran (2)…(101)', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const TOTAL = 100;

  // El peor caso del repartidor de nombres: 100 fotos que se llaman igual. Antes
  // de dar por bueno "no hay tope" hay que comprobar que el bucle de sufijos
  // (2), (3)… aguanta una tanda entera y no acaba en el sufijo de emergencia.
  let subidas = 0;
  const nombres = [];
  while (subidas < TOTAL) {
    const cuantas = Math.min(40, TOTAL - subidas);
    // eslint-disable-next-line no-await-in-loop
    const r = await H.runController(
      scans.createScan,
      uploadReq(clinicId, userId, {
        pages: cuantas,
        mode: 'split',
        startIndex: subidas,
        pageNames: JSON.stringify(Array.from({ length: cuantas }, () => 'cedula.jpg')),
      })
    );
    nombres.push(...r.payload.documents.map((d) => d.name));
    subidas += cuantas;
  }

  assert.equal(new Set(nombres.map((n) => n.toLowerCase())).size, TOTAL, 'ningún nombre repetido');
  assert.equal(nombres[0], 'cedula');
  assert.equal(nombres[1], 'cedula (2)');
  assert.equal(nombres[TOTAL - 1], `cedula (${TOTAL})`);
  assert.equal(await ScannedDocument.countDocuments({ clinic: clinicId }), TOTAL);
});

test('Escáner separado — pasados los mil escaneos del mismo nombre, se sigue numerando', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const { allocateName, nameKeyOf } = scans._internals;

  // Una clínica que lleva 1.200 "cedula" guardados. El repartidor de nombres
  // probaba sufijos solo hasta (999) y a partir de ahí bautizaba con un sufijo
  // aleatorio —"cedula (51b51e)"—, que además podía chocar contra el índice
  // único y hacer perder esa imagen de la tanda.
  const taken = new Set([nameKeyOf('cedula')]);
  for (let i = 2; i <= 1200; i++) taken.add(nameKeyOf(`cedula (${i})`));

  const siguientes = [allocateName(taken, 'cedula'), allocateName(taken, 'cedula')];
  assert.deepEqual(siguientes, ['cedula (1201)', 'cedula (1202)']);
  assert.ok(
    !siguientes.some((n) => /\([0-9a-f]{6}\)$/.test(n)),
    'ninguno debe caer en el sufijo aleatorio de emergencia'
  );

  // Y el nombre repartido es de verdad único contra la base (el índice
  // {clinic, nameKey} no puede reventar).
  const r = await H.runController(scans.createScan, uploadReq(clinicId, userId, { name: 'cedula (1201)' }));
  assert.equal(r.statusCode, 201);
  assert.equal(r.payload.name, 'cedula (1201)');
});

test('Escáner separado — la respuesta dice QUÉ imagen falló, para poder reintentarla', async () => {
  const { clinicId, userId } = await H.seedClinic();

  // Tanda de 4 con la 2ª rota, empezando en la imagen 41 (segunda tanda real).
  const req = uploadReq(clinicId, userId, {
    pages: 4,
    mode: 'split',
    startIndex: 40,
    pageNames: JSON.stringify(['uno.jpg', 'rota.jpg', 'tres.jpg', 'cuatro.jpg']),
  });
  req.files[1] = { buffer: Buffer.from('esto no es una imagen'), mimetype: 'image/png', originalname: 'rota.jpg' };

  const r = await H.runController(scans.createScan, req);

  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(r.payload.count, 3);
  // `failed` es lo que permite al cliente dejar esa imagen en la rejilla: sin el
  // índice, se borraban todas y el usuario perdía el archivo sin saber cuál era.
  assert.equal(r.payload.failed.length, 1);
  assert.equal(r.payload.failed[0].index, 1, 'la posición DENTRO de este envío');
  assert.equal(r.payload.failed[0].number, 42, 'su número dentro de la tanda entera');
  assert.equal(r.payload.failed[0].file, 'rota');
  assert.ok(r.payload.failed[0].message);
  // El texto de siempre se mantiene por compatibilidad.
  assert.match(r.payload.errors[0], /Imagen 42/);
});

test('Escáner separado — sin fallos, `failed` viene vacío', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const r = await H.runController(
    scans.createScan,
    uploadReq(clinicId, userId, { pages: 3, name: 'Todo bien', mode: 'split' })
  );
  assert.deepEqual(r.payload.failed, []);
  assert.deepEqual(r.payload.errors, []);
});

test('Escáner separado — dos envíos SIMULTÁNEOS no pierden PDFs por chocar de nombre', async () => {
  const { clinicId, userId } = await H.seedClinic();

  // Sin nombre escrito, los dos envíos reparten los mismos "Escaneo dd-mm-aaaa N"
  // (allocateName solo aparta en memoria del proceso). Antes, el segundo chocaba
  // contra el índice único {clinic, nameKey} y esa imagen se perdía con un
  // E11000 crudo; ahora se vuelve a pedir nombre y se reintenta solo el registro.
  const [a, b] = await Promise.all([
    H.runController(scans.createScan, uploadReq(clinicId, userId, { pages: 5, mode: 'split' })),
    H.runController(scans.createScan, uploadReq(clinicId, userId, { pages: 5, mode: 'split' })),
  ]);

  assert.equal(a.statusCode, 201, JSON.stringify(a.payload));
  assert.equal(b.statusCode, 201, JSON.stringify(b.payload));
  assert.deepEqual(a.payload.failed, [], JSON.stringify(a.payload.errors));
  assert.deepEqual(b.payload.failed, [], JSON.stringify(b.payload.errors));
  assert.equal(a.payload.count + b.payload.count, 10, 'las 10 imágenes tienen su PDF');
  assert.equal(await ScannedDocument.countDocuments({ clinic: clinicId }), 10);
  const nombres = (await ScannedDocument.find({ clinic: clinicId }).lean()).map((d) => d.nameKey);
  assert.equal(new Set(nombres).size, 10, 'ningún nombre repetido');
});
