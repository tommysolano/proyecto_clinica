/**
 * Escáner de documentos (/scanner) — estilo iLovePDF / CamScanner.
 *
 * El navegador hace la parte visual: detecta la hoja con la cámara, la recorta
 * en perspectiva y manda las páginas ya limpias como JPEG. Aquí se arman en un
 * PDF (una página A4 por imagen), se guarda en disco y se registra la ficha.
 *
 *   POST   /api/scans                 crear (multipart: pages[] + name)
 *   GET    /api/scans                 listar los de la clínica
 *   GET    /api/scans/:id/download    descargar / ver uno
 *   POST   /api/scans/download-zip    descargar varios en un ZIP
 *   PATCH  /api/scans/:id             renombrar
 *   DELETE /api/scans/:id             eliminar (autor o admin)
 *
 * Disponible para TODOS los roles: cualquiera de la clínica escanea y ve lo
 * escaneado por el resto (cada documento muestra quién lo hizo).
 */
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const ScannedDocument = require('../models/ScannedDocument');
// Se requiere para que `populate('createdBy')` encuentre el modelo registrado.
require('../models/User');
const { createZip } = require('../utils/zip');
const { nameKeyOf, sanitizeName, defaultName } = require('../utils/scanNames');

const SCANS_DIR = path.join(__dirname, '..', 'storage', 'scans');
try { fs.mkdirSync(SCANS_DIR, { recursive: true }); } catch (_) {}

const clinicDir = (clinicId) => path.join(SCANS_DIR, String(clinicId || 'default'));

const MAX_PAGES = 40;
const OK_IMAGE_TYPES = ['image/jpeg', 'image/png'];

exports.uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: MAX_PAGES },
  fileFilter: (req, file, cb) => {
    if (OK_IMAGE_TYPES.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Las páginas deben ser imágenes JPG o PNG'));
  },
}).array('pages', MAX_PAGES);

// ─── Nombres ─────────────────────────────────────────────────────────────────
// Viven en utils/scanNames.js porque el importador de fichas escaneadas también
// los necesita para emparejar los PDF del ZIP con su ficha en la base.

/**
 * Devuelve un nombre libre en la clínica. Si "Receta" ya existe prueba
 * "Receta (2)", "Receta (3)"… hasta encontrar uno. `ignoreId` sirve al renombrar
 * (para no chocar consigo mismo).
 */
async function uniqueName(clinicId, base, ignoreId = null) {
  const clean = sanitizeName(base) || defaultName();
  const filter = { clinic: clinicId };
  if (ignoreId) filter._id = { $ne: ignoreId };
  const taken = new Set(
    (await ScannedDocument.find(filter).select('nameKey').lean()).map((d) => d.nameKey)
  );
  if (!taken.has(nameKeyOf(clean))) return clean;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${clean} (${i})`;
    if (!taken.has(nameKeyOf(candidate))) return candidate;
  }
  // Salida de emergencia: sufijo aleatorio (no debería llegar aquí nunca).
  return `${clean} (${crypto.randomBytes(3).toString('hex')})`;
}

// ─── PDF ─────────────────────────────────────────────────────────────────────

/**
 * Arma el PDF: una página A4 por imagen, centrada y escalada sin deformar.
 * A4 en vez del tamaño exacto de la foto para que salga bien al imprimir.
 */
function buildPdf(images, title) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false, info: { Title: title } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const A4 = { w: 595.28, h: 841.89 };
    const MARGIN = 18;
    try {
      for (const img of images) {
        doc.addPage({ size: 'A4', margin: 0 });
        doc.image(img.buffer, MARGIN, MARGIN, {
          fit: [A4.w - MARGIN * 2, A4.h - MARGIN * 2],
          align: 'center',
          valign: 'center',
        });
      }
      doc.end();
    } catch (e) {
      reject(new Error(`No se pudo procesar una de las páginas: ${e.message}`));
    }
  });
}

// ─── Endpoints ───────────────────────────────────────────────────────────────

exports.createScan = async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ message: 'Envía al menos una página escaneada' });
    }
    const name = await uniqueName(req.clinicId, req.body.name || defaultName());
    const pdf = await buildPdf(files, name);

    const dir = clinicDir(req.clinicId);
    await fsp.mkdir(dir, { recursive: true });
    const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.pdf`;
    await fsp.writeFile(path.join(dir, filename), pdf);

    const doc = await ScannedDocument.create({
      clinic: req.clinicId,
      name,
      nameKey: nameKeyOf(name),
      filename,
      size: pdf.length,
      pages: files.length,
      createdBy: req.user._id,
    });
    const populated = await doc.populate('createdBy', 'name');
    res.status(201).json(populated);
  } catch (error) {
    res.status(400).json({ message: `No se pudo generar el PDF: ${error.message}` });
  }
};

exports.listScans = async (req, res) => {
  try {
    const { search = '', page = 1, limit = 20, mine } = req.query;
    const query = { clinic: req.clinicId };
    if (String(search).trim()) query.nameKey = { $regex: nameKeyOf(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') };
    if (mine === 'true' || mine === '1') query.createdBy = req.user._id;

    const perPage = Math.min(Math.max(parseInt(limit) || 20, 1), 100);
    const skip = (Math.max(parseInt(page) || 1, 1) - 1) * perPage;
    const [docs, total] = await Promise.all([
      ScannedDocument.find(query)
        .populate('createdBy', 'name')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(perPage)
        .lean(),
      ScannedDocument.countDocuments(query),
    ]);
    res.json({ documents: docs, total, pages: Math.ceil(total / perPage) || 1, currentPage: Math.max(parseInt(page) || 1, 1) });
  } catch (error) {
    res.status(500).json({ message: 'Error al listar los documentos escaneados', error: error.message });
  }
};

/** Lee el PDF de disco; 404 si la ficha existe pero el archivo se perdió. */
async function readPdf(doc) {
  const file = path.join(clinicDir(doc.clinic), doc.filename);
  try {
    return await fsp.readFile(file);
  } catch {
    const err = new Error(`El archivo de "${doc.name}" ya no está en el servidor`);
    err.status = 404;
    throw err;
  }
}

exports.downloadScan = async (req, res) => {
  try {
    const doc = await ScannedDocument.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!doc) return res.status(404).json({ message: 'Documento no encontrado' });
    const buffer = await readPdf(doc);
    // `inline` para verlo en el visor del navegador; si no, se descarga.
    const disposition = req.query.inline === '1' ? 'inline' : 'attachment';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${disposition}; filename="${sanitizeName(doc.name)}.pdf"`);
    res.send(buffer);
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
};

exports.downloadZip = async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    if (!ids.length) return res.status(400).json({ message: 'Selecciona al menos un documento' });
    const docs = await ScannedDocument.find({ _id: { $in: ids }, clinic: req.clinicId }).sort({ createdAt: -1 });
    if (!docs.length) return res.status(404).json({ message: 'No se encontraron los documentos seleccionados' });

    const files = [];
    const used = new Set();
    for (const doc of docs) {
      let entry = `${sanitizeName(doc.name)}.pdf`;
      // Dentro del ZIP tampoco puede haber dos entradas con el mismo nombre.
      let i = 2;
      while (used.has(entry.toLowerCase())) entry = `${sanitizeName(doc.name)} (${i++}).pdf`;
      used.add(entry.toLowerCase());
      try {
        files.push({ name: entry, data: await readPdf(doc) });
      } catch {
        // Un archivo perdido no debe tumbar la descarga del resto.
      }
    }
    if (!files.length) return res.status(404).json({ message: 'Ninguno de los archivos seleccionados está disponible' });

    const zip = createZip(files);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="escaneos_${Date.now()}.zip"`);
    res.send(zip);
  } catch (error) {
    res.status(500).json({ message: 'Error al preparar el ZIP', error: error.message });
  }
};

exports.renameScan = async (req, res) => {
  try {
    const doc = await ScannedDocument.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!doc) return res.status(404).json({ message: 'Documento no encontrado' });
    const clean = sanitizeName(req.body.name);
    if (!clean) return res.status(400).json({ message: 'El nombre no puede quedar vacío' });
    const name = await uniqueName(req.clinicId, clean, doc._id);
    doc.name = name;
    doc.nameKey = nameKeyOf(name);
    await doc.save();
    res.json(await doc.populate('createdBy', 'name'));
  } catch (error) {
    res.status(400).json({ message: `No se pudo renombrar: ${error.message}` });
  }
};

exports.deleteScan = async (req, res) => {
  try {
    const doc = await ScannedDocument.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!doc) return res.status(404).json({ message: 'Documento no encontrado' });
    // Cada quien borra lo suyo; el admin puede borrar cualquiera.
    const isOwner = String(doc.createdBy) === String(req.user._id);
    if (!isOwner && req.role !== 'admin' && !req.user.isSuperAdmin) {
      return res.status(403).json({ message: 'Solo quien lo escaneó (o un administrador) puede eliminarlo' });
    }
    await fsp.unlink(path.join(clinicDir(doc.clinic), doc.filename)).catch(() => {});
    await doc.deleteOne();
    res.json({ message: 'Documento eliminado' });
  } catch (error) {
    res.status(500).json({ message: 'Error al eliminar el documento', error: error.message });
  }
};

// Exportados para los tests.
exports._internals = { uniqueName, nameKeyOf, sanitizeName, defaultName, SCANS_DIR };
