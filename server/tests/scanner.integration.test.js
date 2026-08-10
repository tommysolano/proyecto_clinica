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

const uploadReq = (clinicId, userId, { pages = 1, name } = {}) => {
  const req = H.mockReq(clinicId, userId, name === undefined ? {} : { name });
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
