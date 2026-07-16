/**
 * Importación masiva de contactos desde Excel/CSV (asistente de 4 pasos).
 *
 * El flujo es el de Daplox, y el orden importa:
 *   1. POST /contacts/imports/analyze  → sube el archivo y devuelve sus CABECERAS
 *      con valores de muestra + un mapeo sugerido. No crea nada todavía.
 *   2. POST /contacts/imports          → el usuario confirma el mapeo, etiquetas y
 *      grupos; se crea el lote en 'pending'. Responde al instante.
 *   3. Un job procesa el lote en segundo plano y emite el progreso por socket.
 *
 * Se sube a DISCO (no a memoria ni a Mongo): un CSV de 30 MB en RAM tumbaría el
 * VPS, que además corre Chromium para los QR y los PDFs.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');
const mongoose = require('mongoose');
const ContactImport = require('../models/ContactImport');
const ContactGroup = require('../models/ContactGroup');
const Contact = require('../models/Contact');
const { readHeaders, isSupported } = require('../utils/contactFileReader');
const { suggestMapping, FIELD_OPTIONS } = require('../utils/contactRowMapper');
const { revertImport } = require('../utils/contactImportRunner');

const UPLOAD_DIR = path.join(os.tmpdir(), 'shiluv_contact_imports');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// 30 MB, igual que Daplox.
exports.uploadMiddleware = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) =>
      cb(null, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!isSupported(file.originalname)) {
      return cb(new Error('Formato no admitido: sube un archivo .csv, .xlsx o .xls'));
    }
    cb(null, true);
  },
}).single('file');

/** Paso 2 del asistente: analiza el archivo y propone el mapeo. */
exports.analyze = async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No se recibió ningún archivo' });
  try {
    const { headers, samples } = await readHeaders(req.file.path, req.file.originalname);
    if (!headers.length) {
      await fs.promises.unlink(req.file.path).catch(() => {});
      return res.status(400).json({ message: 'El archivo no tiene cabeceras: la primera fila debe ser el nombre de cada columna.' });
    }
    res.json({
      // El front devuelve esto al confirmar: así el archivo no se sube dos veces.
      uploadId: path.basename(req.file.path),
      fileName: req.file.originalname,
      fileSize: req.file.size,
      headers,
      samples,
      mapping: suggestMapping(headers),
      fieldOptions: FIELD_OPTIONS,
    });
  } catch (err) {
    await fs.promises.unlink(req.file.path).catch(() => {});
    res.status(400).json({ message: `No se pudo leer el archivo: ${err.message}` });
  }
};

/** Paso 4: confirma y encola la importación. */
exports.create = async (req, res) => {
  try {
    const { uploadId, fileName, mapping, mode, tags, groups, whatsappOptIn, consentSource } = req.body;
    // basename() evita que un uploadId manipulado ("../../etc/passwd") salga del
    // directorio de subidas.
    const filePath = path.join(UPLOAD_DIR, path.basename(String(uploadId || '')));
    if (!uploadId || !fs.existsSync(filePath)) {
      return res.status(400).json({ message: 'El archivo subido ya no está disponible. Vuelve a subirlo.' });
    }
    const map = Array.isArray(mapping) ? mapping : [];
    if (!map.some((m) => m.field === 'phone')) {
      return res.status(400).json({
        message: 'Debes asignar una columna al campo Teléfono: es lo que identifica a cada contacto.',
      });
    }

    const groupIds = (Array.isArray(groups) ? groups : []).filter((g) => mongoose.isValidObjectId(g));
    if (groupIds.length) {
      const found = await ContactGroup.countDocuments({ _id: { $in: groupIds }, clinic: req.clinicId, kind: 'static' });
      if (found !== groupIds.length) {
        return res.status(400).json({ message: 'Algún grupo no existe o es un grupo por filtro (esos se calculan solos).' });
      }
    }

    const batch = await ContactImport.create({
      clinic: req.clinicId,
      fileName: fileName || 'contactos.csv',
      filePath,
      fileSize: fs.statSync(filePath).size,
      status: 'pending',
      mapping: map.map((m) => ({
        column: String(m.column || ''),
        field: String(m.field || ''),
        skipEmpty: m.skipEmpty !== false,
      })),
      mode: ['upsert', 'create', 'update'].includes(mode) ? mode : 'upsert',
      tags: (Array.isArray(tags) ? tags : []).map((t) => String(t).trim()).filter(Boolean),
      groups: groupIds,
      whatsappOptIn: whatsappOptIn !== false,
      consentSource: String(consentSource || '').trim(),
      createdBy: req.user._id,
      createdByName: req.user.name,
    });
    // El job lo coge en el siguiente tick (máx. 1 min); no se espera aquí.
    res.status(201).json(batch);
  } catch (err) {
    res.status(500).json({ message: 'Error al crear la importación', error: err.message });
  }
};

/** Historial de importaciones (con su progreso). */
exports.list = async (req, res) => {
  try {
    const list = await ContactImport.find({ clinic: req.clinicId })
      .select('-filePath -mapping')
      .sort({ createdAt: -1 })
      .limit(50);
    res.json(list);
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

exports.get = async (req, res) => {
  try {
    const batch = await ContactImport.findOne({ _id: req.params.id, clinic: req.clinicId }).select('-filePath');
    if (!batch) return res.status(404).json({ message: 'Importación no encontrada' });
    res.json(batch);
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

/** Deshacer: borra los contactos que creó ese lote. */
exports.revert = async (req, res) => {
  try {
    const batch = await ContactImport.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!batch) return res.status(404).json({ message: 'Importación no encontrada' });
    const r = await revertImport(batch._id);
    if (!r.ok) return res.status(409).json({ message: r.error });
    res.json(r);
  } catch (err) {
    res.status(500).json({ message: 'Error al deshacer', error: err.message });
  }
};

/** Informe de errores en CSV, para corregir el archivo y reintentar. */
exports.errorsCsv = async (req, res) => {
  try {
    const batch = await ContactImport.findOne({ _id: req.params.id, clinic: req.clinicId }).select('rowErrors fileName');
    if (!batch) return res.status(404).json({ message: 'Importación no encontrada' });
    const rows = [['fila', 'valor', 'motivo']];
    for (const e of batch.rowErrors || []) rows.push([e.row, e.value, e.reason]);
    const csv = rows
      .map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="errores_importacion.csv"`);
    res.send(`﻿${csv}`); // BOM: para que Excel respete los acentos
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

/** Estimación previa: cuántos contactos hay ya con esos teléfonos. */
exports.stats = async (req, res) => {
  try {
    const total = await Contact.countDocuments({ clinic: req.clinicId });
    res.json({ total });
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};
