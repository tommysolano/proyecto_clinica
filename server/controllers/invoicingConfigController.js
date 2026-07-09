const fs = require('fs');
const path = require('path');
const multer = require('multer');
const InvoicingConfig = require('../models/InvoicingConfig');
const { encrypt, decrypt } = require('../modules/invoicing/ec/crypto');
const { loadP12 } = require('../modules/invoicing/ec/xadesSigner');

const CERTS_DIR = path.join(__dirname, '..', 'storage', 'certs');
if (!fs.existsSync(CERTS_DIR)) fs.mkdirSync(CERTS_DIR, { recursive: true });

const storage = multer.memoryStorage();
const uploadSingle = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (
      file.mimetype === 'application/x-pkcs12' ||
      /\.p12$|\.pfx$/i.test(file.originalname)
    ) {
      return cb(null, true);
    }
    cb(new Error('Archivo debe ser .p12 o .pfx'));
  },
}).single('certificate');

// Los errores de multer (tipo de archivo, tamaño) son del cliente: responder
// 400 con el motivo en vez de dejar que Express devuelva un 500 genérico.
exports.uploadMiddleware = (req, res, next) => {
  uploadSingle(req, res, (err) => {
    if (err) return res.status(400).json({ message: err.message });
    next();
  });
};

function sanitizeOutput(config) {
  if (!config) return null;
  const obj = config.toObject ? config.toObject({ virtuals: true }) : { ...config };
  delete obj.certificatePassword;
  return obj;
}

exports.getConfig = async (req, res) => {
  try {
    const config = await InvoicingConfig.findOne({ clinic: req.clinicId });
    res.json(sanitizeOutput(config));
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener configuración' });
  }
};

exports.upsertConfig = async (req, res) => {
  try {
    const allowed = [
      'ruc',
      'razonSocial',
      'nombreComercial',
      'direccionMatriz',
      'direccionEstablecimiento',
      'establecimiento',
      'puntoEmision',
      'secuencial',
      'retentionSequential',
      'ambiente',
      'obligadoContabilidad',
      'agenteRetencion',
      'contribuyenteEspecial',
      'smtp',
    ];
    const update = {};
    for (const k of allowed) if (req.body[k] !== undefined) update[k] = req.body[k];

    // El modelo guarda ambiente como '1' (pruebas) / '2' (producción); aceptar
    // también los alias legibles por si llega un cliente con bundle antiguo.
    if (update.ambiente === 'pruebas') update.ambiente = '1';
    if (update.ambiente === 'produccion') update.ambiente = '2';

    const config = await InvoicingConfig.findOneAndUpdate(
      { clinic: req.clinicId },
      { $set: update, $setOnInsert: { clinic: req.clinicId } },
      { new: true, upsert: true, runValidators: true }
    );
    res.json(sanitizeOutput(config));
  } catch (error) {
    res
      .status(500)
      .json({ message: 'Error al guardar configuración', error: error.message });
  }
};

exports.uploadCertificate = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Archivo requerido' });
    const { password } = req.body;
    if (!password) return res.status(400).json({ message: 'Contraseña requerida' });

    // Validar el certificado antes de guardarlo
    let info;
    try {
      info = loadP12(req.file.buffer, password);
    } catch (e) {
      return res
        .status(400)
        .json({ message: `Certificado inválido: ${e.message}` });
    }

    if (info.validTo < new Date()) {
      return res.status(400).json({ message: 'El certificado está vencido' });
    }

    const filename = `${req.clinicId}.p12`;
    const filepath = path.join(CERTS_DIR, filename);
    // El directorio puede no existir aunque se cree al arrancar (borrado en
    // caliente, deploy nuevo): asegurarlo aquí para no fallar con ENOENT.
    fs.mkdirSync(CERTS_DIR, { recursive: true });
    fs.writeFileSync(filepath, req.file.buffer);

    const config = await InvoicingConfig.findOneAndUpdate(
      { clinic: req.clinicId },
      {
        $set: {
          certificateFilename: filename,
          certificatePassword: encrypt(password),
          certificateInfo: {
            validFrom: info.validFrom,
            validTo: info.validTo,
            issuer: info.issuerName,
            subject: info.subject,
            serialNumber: info.serialNumberDecimal,
          },
        },
        $setOnInsert: { clinic: req.clinicId },
      },
      { new: true, upsert: true }
    );

    // Construir sugerencias de auto-relleno a partir del certificado
    const attribs = info.subjectAttribs || {};
    const autoFill = {};

    // RUC: los certs del SRI Ecuador lo ponen en el atributo serialNumber del subject
    const rawSerial = attribs.serialNumber || attribs.SERIALNUMBER || '';
    const rucCandidate = rawSerial.replace(/\D/g, '');
    if (rucCandidate.length === 13 || rucCandidate.length === 10) {
      autoFill.ruc = rucCandidate;
    }

    // Razón social: primero O (organización), si no CN (common name)
    const orgName = attribs.O || attribs.organizationName || '';
    const cnName = attribs.CN || attribs.commonName || '';
    if (orgName) {
      autoFill.razonSocial = orgName;
      if (cnName && cnName !== orgName) autoFill.nombreComercial = cnName;
    } else if (cnName) {
      autoFill.razonSocial = cnName;
    }

    res.json({ config: sanitizeOutput(config), autoFill });
  } catch (error) {
    res
      .status(500)
      .json({ message: 'Error al subir certificado', error: error.message });
  }
};

/**
 * Elimina el certificado cargado (archivo en disco + campos en la config).
 * No toca el resto de la configuración SRI. Hasta subir uno nuevo no se
 * podrán firmar comprobantes (isComplete() pasa a false).
 */
exports.deleteCertificate = async (req, res) => {
  try {
    const config = await InvoicingConfig.findOne({ clinic: req.clinicId });
    if (!config || !config.certificateFilename) {
      return res.status(404).json({ message: 'No hay certificado cargado' });
    }

    // Borrar el archivo del disco (si falla, la BD sigue siendo la fuente de
    // verdad: se limpia igual y el archivo huérfano se sobreescribe al resubir,
    // porque el nombre es fijo por clínica).
    try {
      const filepath = path.join(CERTS_DIR, config.certificateFilename);
      if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    } catch (e) {
      console.error('No se pudo borrar el archivo del certificado:', e.message);
    }

    const updated = await InvoicingConfig.findOneAndUpdate(
      { clinic: req.clinicId },
      {
        $set: { certificateFilename: null, certificatePassword: null },
        $unset: { certificateInfo: '' },
      },
      { new: true }
    );
    res.json(sanitizeOutput(updated));
  } catch (error) {
    res
      .status(500)
      .json({ message: 'Error al eliminar certificado', error: error.message });
  }
};

/**
 * Helper interno: obtiene configuración con certificado decifrado y buffer P12.
 */
exports.loadForSigning = async (clinicId) => {
  const config = await InvoicingConfig.findOne({ clinic: clinicId });
  if (!config) throw new Error('Configuración de facturación no encontrada');
  if (!config.isComplete()) throw new Error('Configuración de facturación incompleta');

  const filepath = path.join(CERTS_DIR, config.certificateFilename);
  if (!fs.existsSync(filepath)) throw new Error('Archivo de certificado no encontrado');

  const p12Buffer = fs.readFileSync(filepath);
  const password = decrypt(config.certificatePassword);
  return { config, p12Buffer, password };
};
