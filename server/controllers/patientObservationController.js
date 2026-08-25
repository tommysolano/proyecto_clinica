const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');
const mongoose = require('mongoose');

const PatientObservation = require('../models/PatientObservation');
const Patient = require('../models/Patient');
const { canReq } = require('../utils/permissions');

// --- Almacenamiento en disco de los adjuntos de las observaciones ---
//
// Se guardan por PACIENTE, no por sucursal (como sí hacen los adjuntos de
// seguimientos): la ficha del paciente es global y un admin de otra sede puede
// adjuntar a una observación escrita en la primera. Con carpeta por sucursal, ese
// archivo se escribiría en un sitio y se buscaría en otro.
const OBSERVATIONS_DIR = path.join(__dirname, '..', 'storage', 'observations');
try {
  fs.mkdirSync(OBSERVATIONS_DIR, { recursive: true });
} catch (_) {}

/** Carpeta de los adjuntos de un paciente. `id` ya viene validado por el router. */
const patientDir = (patientId) => path.join(OBSERVATIONS_DIR, String(patientId));

const observationStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = patientDir(req.params.id);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const rand = crypto.randomBytes(6).toString('hex');
    const ext = path.extname(file.originalname || '');
    cb(null, `${Date.now()}-${rand}${ext}`);
  },
});

// Qué se puede adjuntar: lo que el equipo suele tener a mano — el PDF del
// laboratorio, la foto del carnet, el comprobante de la transferencia, un Excel.
const OK_ATTACHMENT_TYPES = [
  'application/pdf',
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
  'application/zip',
  'application/x-zip-compressed',
];

const MAX_FILES = 10;

exports.uploadMiddleware = multer({
  storage: observationStorage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB por archivo
  fileFilter: (req, file, cb) => {
    if (OK_ATTACHMENT_TYPES.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`No se admite este tipo de archivo (${file.mimetype || 'desconocido'})`));
  },
}).array('files', MAX_FILES);

/** Borra del disco los archivos de una subida que al final no se guardó. */
const discardUploads = (req) => {
  for (const f of req.files || []) {
    try { fs.unlinkSync(f.path); } catch (_) {}
  }
};

const toAttachment = (file, userId) => ({
  filename: file.filename,
  originalName: file.originalname,
  mimeType: file.mimetype,
  size: file.size,
  uploadedAt: new Date(),
  uploadedBy: userId,
});

const populated = (query) =>
  query.populate('createdBy', 'name').populate('updatedBy', 'name');

/**
 * ¿Puede este usuario MODIFICAR esta observación?
 *
 * Solo su autor… y el administrador, que además queda registrado en `updatedBy`
 * para que se vea quién la tocó (es el «creado por / modificado por» de la ficha).
 */
const canEdit = (obs, req) =>
  String(obs.createdBy?._id || obs.createdBy) === String(req.user._id) ||
  canReq(req, 'patients.observations.moderate');

/** Marca la observación como modificada por quien la está tocando. */
const stampEditor = (obs, req) => {
  obs.updatedBy = req.user._id;
  obs.editedAt = new Date();
};

/** GET /patients/:id/observations — de la más nueva a la más vieja. */
exports.list = async (req, res) => {
  try {
    const rows = await populated(
      // `_id` como desempate: dos observaciones del mismo milisegundo (importación,
      // dos pestañas) saldrían en orden arbitrario y la lista bailaría al recargar.
      PatientObservation.find({ patient: req.params.id }).sort({ createdAt: -1, _id: -1 })
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener las observaciones', error: error.message });
  }
};

/**
 * POST /patients/:id/observations
 * multipart/form-data: `text` + hasta MAX_FILES archivos en `files`.
 */
exports.create = async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim();
    const files = req.files || [];
    if (!text && files.length === 0) {
      discardUploads(req);
      return res.status(400).json({ message: 'Escribe una observación o adjunta un archivo' });
    }

    const patient = await Patient.findById(req.params.id).select('_id');
    if (!patient) {
      discardUploads(req);
      return res.status(404).json({ message: 'Paciente no encontrado' });
    }

    const obs = await PatientObservation.create({
      clinic: req.clinicId,
      patient: patient._id,
      text,
      attachments: files.map((f) => toAttachment(f, req.user._id)),
      createdBy: req.user._id,
    });

    res.status(201).json(await populated(PatientObservation.findById(obs._id)));
  } catch (error) {
    discardUploads(req);
    res.status(500).json({ message: 'Error al guardar la observación', error: error.message });
  }
};

/** PUT /patients/:id/observations/:obsId — cambia el texto. */
exports.update = async (req, res) => {
  try {
    const obs = await PatientObservation.findOne({
      _id: req.params.obsId,
      patient: req.params.id,
    });
    if (!obs) return res.status(404).json({ message: 'Observación no encontrada' });
    if (!canEdit(obs, req)) {
      return res.status(403).json({ message: 'Solo puedes modificar las observaciones que escribiste' });
    }

    const text = String(req.body?.text ?? '').trim();
    if (!text && obs.attachments.length === 0) {
      return res.status(400).json({ message: 'La observación no puede quedar vacía' });
    }
    obs.text = text;
    stampEditor(obs, req);
    await obs.save();

    res.json(await populated(PatientObservation.findById(obs._id)));
  } catch (error) {
    res.status(500).json({ message: 'Error al modificar la observación', error: error.message });
  }
};

/** DELETE /patients/:id/observations/:obsId — se lleva sus archivos del disco. */
exports.remove = async (req, res) => {
  try {
    const obs = await PatientObservation.findOne({
      _id: req.params.obsId,
      patient: req.params.id,
    });
    if (!obs) return res.status(404).json({ message: 'Observación no encontrada' });
    if (!canEdit(obs, req)) {
      return res.status(403).json({ message: 'Solo puedes eliminar las observaciones que escribiste' });
    }

    for (const att of obs.attachments) {
      try { fs.unlinkSync(path.join(patientDir(obs.patient), att.filename)); } catch (_) {}
    }
    await obs.deleteOne();
    res.json({ message: 'Observación eliminada' });
  } catch (error) {
    res.status(500).json({ message: 'Error al eliminar la observación', error: error.message });
  }
};

/** POST /patients/:id/observations/:obsId/attachments — adjunta más archivos. */
exports.addAttachments = async (req, res) => {
  try {
    const obs = await PatientObservation.findOne({
      _id: req.params.obsId,
      patient: req.params.id,
    });
    if (!obs) {
      discardUploads(req);
      return res.status(404).json({ message: 'Observación no encontrada' });
    }
    if (!canEdit(obs, req)) {
      discardUploads(req);
      return res.status(403).json({ message: 'Solo puedes modificar las observaciones que escribiste' });
    }
    if (!req.files?.length) {
      return res.status(400).json({ message: 'No se recibió ningún archivo' });
    }

    obs.attachments.push(...req.files.map((f) => toAttachment(f, req.user._id)));
    stampEditor(obs, req);
    await obs.save();

    res.status(201).json(await populated(PatientObservation.findById(obs._id)));
  } catch (error) {
    discardUploads(req);
    res.status(500).json({ message: 'Error al adjuntar el archivo', error: error.message });
  }
};

/** GET /patients/:id/observations/:obsId/attachments/:attId — descarga. */
exports.downloadAttachment = async (req, res) => {
  try {
    const obs = await PatientObservation.findOne({
      _id: req.params.obsId,
      patient: req.params.id,
    });
    if (!obs) return res.status(404).json({ message: 'Observación no encontrada' });
    const att = obs.attachments.id(req.params.attId);
    if (!att) return res.status(404).json({ message: 'Archivo no encontrado' });

    const filePath = path.join(patientDir(obs.patient), att.filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: 'El archivo ya no está en el servidor' });
    }
    res.setHeader('Content-Type', att.mimeType || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(att.originalName)}"`
    );
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    res.status(500).json({ message: 'Error al descargar el archivo', error: error.message });
  }
};

/** DELETE /patients/:id/observations/:obsId/attachments/:attId */
exports.deleteAttachment = async (req, res) => {
  try {
    const obs = await PatientObservation.findOne({
      _id: req.params.obsId,
      patient: req.params.id,
    });
    if (!obs) return res.status(404).json({ message: 'Observación no encontrada' });
    if (!canEdit(obs, req)) {
      return res.status(403).json({ message: 'Solo puedes modificar las observaciones que escribiste' });
    }
    const att = obs.attachments.id(req.params.attId);
    if (!att) return res.status(404).json({ message: 'Archivo no encontrado' });
    if (!obs.text.trim() && obs.attachments.length === 1) {
      return res.status(400).json({
        message: 'Es el único contenido de la observación: escribe un texto o elimina la observación entera',
      });
    }

    try { fs.unlinkSync(path.join(patientDir(obs.patient), att.filename)); } catch (_) {}
    att.deleteOne();
    stampEditor(obs, req);
    await obs.save();

    res.json(await populated(PatientObservation.findById(obs._id)));
  } catch (error) {
    res.status(500).json({ message: 'Error al eliminar el archivo', error: error.message });
  }
};

/**
 * Rechaza un id de paciente/observación mal formado antes de que llegue a Mongoose
 * (si no, `findOne` revienta con un CastError y el usuario ve un 500 sin sentido).
 */
exports.validateIds = (req, res, next) => {
  const ids = [req.params.id, req.params.obsId, req.params.attId].filter(Boolean);
  if (ids.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
    return res.status(400).json({ message: 'Identificador no válido' });
  }
  next();
};

/**
 * Traduce los errores de multer (tamaño, tipo, exceso de archivos) a un mensaje
 * accionable. Sin esto, un archivo de 30 MB devuelve un 500 mudo.
 */
exports.handleUploadErrors = (handler) => (req, res, next) => {
  handler(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ message: 'Cada archivo puede pesar como máximo 20 MB' });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ message: `Puedes adjuntar hasta ${MAX_FILES} archivos a la vez` });
    }
    return res.status(400).json({ message: err.message || 'No se pudo subir el archivo' });
  });
};
