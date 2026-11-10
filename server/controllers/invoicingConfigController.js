const fs = require('fs');
const path = require('path');
const multer = require('multer');
const InvoicingConfig = require('../models/InvoicingConfig');
const { encrypt, decrypt } = require('../modules/invoicing/ec/crypto');
const { loadP12, rucsDelCertificado } = require('../modules/invoicing/ec/xadesSigner');
// La configuración SRI es de la EMPRESA: desde cualquier sucursal se lee y edita la misma.
const { sucursalSri } = require('../services/puntoEmision');

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
  obj.smtpPasswordConfigured = !!obj.smtpPassword;
  delete obj.smtpPassword;
  obj.gmailClientSecretConfigured = !!obj.gmailClientSecret;
  obj.gmailConnected = !!obj.gmailRefreshToken;
  for (const key of ['gmailClientSecret', 'gmailRefreshToken', 'gmailOauthStateHash', 'gmailOauthUser', 'gmailOauthExpires']) delete obj[key];
  obj.gmailRedirectUri = process.env.GMAIL_OAUTH_REDIRECT_URI || '';
  return obj;
}

exports.getConfig = async (req, res) => {
  try {
    const config = await InvoicingConfig.findOne({ clinic: await sucursalSri(req.clinicId) });
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
      'establishments',
      'secuencial',
      'retentionSequential',
      'ambiente',
      'obligadoContabilidad',
      'agenteRetencion',
      'contribuyenteEspecial',
    ];
    const update = {};
    for (const k of allowed) if (req.body[k] !== undefined) update[k] = req.body[k];

    // El modelo guarda ambiente como '1' (pruebas) / '2' (producción); aceptar
    // también los alias legibles por si llega un cliente con bundle antiguo.
    if (update.ambiente === 'pruebas') update.ambiente = '1';
    if (update.ambiente === 'produccion') update.ambiente = '2';

    const sri = await sucursalSri(req.clinicId);
    const config = await InvoicingConfig.findOneAndUpdate(
      { clinic: sri },
      { $set: update, $setOnInsert: { clinic: sri } },
      { new: true, upsert: true, runValidators: true }
    );
    res.json(sanitizeOutput(config));
  } catch (error) {
    res
      .status(500)
      .json({ message: 'Error al guardar configuración', error: error.message });
  }
};

exports.saveEmailConfig = async (req, res) => {
  try {
    const { enabled, from, host, port, secure, user, password, provider = 'smtp', gmailClientId, gmailClientSecret } = req.body || {};
    if (!['smtp', 'gmail'].includes(provider)) return res.status(400).json({ message: 'Proveedor de correo inválido.' });
    if (typeof enabled !== 'boolean' || typeof secure !== 'boolean') return res.status(400).json({ message: 'Configuración de correo inválida' });
    const sri = await sucursalSri(req.clinicId);
    const existing = await InvoicingConfig.findOne({ clinic: sri });
    if (provider === 'gmail') {
      const address = String(from || '').trim().toLowerCase();
      const clientId = String(gmailClientId || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || !clientId || !(gmailClientSecret || existing?.gmailClientSecret)) return res.status(400).json({ message: 'Complete el remitente y las credenciales de Google.' });
      const changed = clientId !== existing?.gmailClientId || !!gmailClientSecret || address !== existing?.emailRemitente?.toLowerCase();
      if (enabled && (changed || !existing?.gmailRefreshToken || existing.gmailAccount !== address)) return res.status(400).json({ message: 'Guarde la configuración desactivada y conecte la cuenta de Google antes de activar el envío.' });
      const fields = { smtpEnabled: enabled, emailProvider: provider, emailRemitente: address, gmailClientId: clientId };
      if (gmailClientSecret) fields.gmailClientSecret = encrypt(gmailClientSecret);
      const update = { $set: fields, $setOnInsert: { clinic: sri } };
      if (changed) update.$unset = { gmailRefreshToken: '', gmailAccount: '', gmailOauthStateHash: '', gmailOauthUser: '', gmailOauthExpires: '' };
      const config = await InvoicingConfig.findOneAndUpdate({ clinic: sri }, update, { new: true, upsert: true, runValidators: true });
      return res.json(sanitizeOutput(config));
    }
    const p = Number(port);
    const fields = { smtpEnabled: enabled, emailProvider: 'smtp', emailRemitente: String(from || '').trim(), smtpHost: String(host || '').trim(),
      smtpPort: p || undefined, smtpSecure: secure, smtpUser: String(user || '').trim() };
    if (enabled && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.emailRemitente) || !fields.smtpHost || !Number.isInteger(p) || p < 1 || p > 65535 || !fields.smtpUser || !(password || existing?.smtpPassword))) {
      return res.status(400).json({ message: 'Complete el remitente, servidor, puerto, usuario y contraseña SMTP.' });
    }
    if (password) fields.smtpPassword = encrypt(password);
    const config = await InvoicingConfig.findOneAndUpdate({ clinic: sri }, { $set: fields, $setOnInsert: { clinic: sri } }, { new: true, upsert: true, runValidators: true });
    res.json(sanitizeOutput(config));
  } catch (error) {
    res.status(400).json({ message: 'No se pudo guardar la configuración de correo', error: error.message });
  }
};

exports.verifyEmailConfig = async (req, res) => {
  let config;
  try {
    config = await InvoicingConfig.findOne({ clinic: await sucursalSri(req.clinicId) });
    if (config?.emailProvider === 'gmail') await require('../services/gmailApi').verify(config);
    else await require('../services/invoiceEmail').verifyTransport(config);
    res.json({ message: config?.emailProvider === 'gmail' ? 'Cuenta de Gmail verificada correctamente.' : 'Conexión SMTP verificada correctamente.' });
  } catch (error) {
    if (config?.emailProvider === 'gmail') return res.status(400).json({ code: error.code || 'GMAIL_ERROR', message: error.code === 'GMAIL_CONNECTION' ? 'No se pudo conectar con Google. Revise la conexión del servidor.' : 'No se pudo verificar Gmail. Compruebe la cuenta y vuelva a conectarla.' });
    res.status(400).json(require('../services/invoiceEmail').describeSmtpError(error));
  }
};

exports.startGmailAuth = async (req, res) => {
  try {
    const crypto = require('crypto');
    const redirect = process.env.GMAIL_OAUTH_REDIRECT_URI;
    if (!redirect || !/^https:\/\//.test(redirect)) return res.status(400).json({ message: 'Configure GMAIL_OAUTH_REDIRECT_URI con la URL HTTPS de Configuración SRI.' });
    const sri = await sucursalSri(req.clinicId);
    const config = await InvoicingConfig.findOne({ clinic: sri });
    if (config?.emailProvider !== 'gmail' || !config.gmailClientId || !config.gmailClientSecret) return res.status(400).json({ message: 'Guarde primero los datos de Gmail.' });
    const state = crypto.randomBytes(32).toString('base64url');
    await InvoicingConfig.updateOne({ _id: config._id }, { $set: { gmailOauthStateHash: crypto.createHash('sha256').update(state).digest('hex'), gmailOauthUser: String(req.user._id), gmailOauthExpires: new Date(Date.now() + 10 * 60 * 1000) } });
    const params = new URLSearchParams({ client_id: config.gmailClientId, redirect_uri: redirect, response_type: 'code', scope: require('../services/gmailApi').SCOPES.join(' '), access_type: 'offline', prompt: 'consent', state, login_hint: config.emailRemitente });
    res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
  } catch { res.status(500).json({ message: 'No se pudo iniciar la conexión con Google.' }); }
};

exports.completeGmailAuth = async (req, res) => {
  try {
    const crypto = require('crypto');
    const { state, code } = req.body || {};
    if (typeof state !== 'string' || typeof code !== 'string' || !state || !code || state.length > 256 || code.length > 4096) return res.status(400).json({ message: 'Respuesta de autorización inválida.' });
    const sri = await sucursalSri(req.clinicId);
    const config = await InvoicingConfig.findOneAndUpdate({ clinic: sri, emailProvider: 'gmail', gmailOauthStateHash: crypto.createHash('sha256').update(state).digest('hex'), gmailOauthUser: String(req.user._id), gmailOauthExpires: { $gt: new Date() } }, { $unset: { gmailOauthStateHash: '', gmailOauthUser: '', gmailOauthExpires: '' } }, { new: true });
    if (!config) return res.status(400).json({ message: 'La autorización caducó o no corresponde a esta sesión. Intente conectar de nuevo.' });
    const gmail = require('../services/gmailApi');
    const tokens = await gmail.token({ code, client_id: config.gmailClientId, client_secret: decrypt(config.gmailClientSecret), redirect_uri: process.env.GMAIL_OAUTH_REDIRECT_URI, grant_type: 'authorization_code' });
    if (!tokens.refresh_token || !String(tokens.scope || '').split(' ').includes('https://www.googleapis.com/auth/gmail.send')) return res.status(400).json({ message: 'Google no concedió el permiso de envío permanente. Vuelva a conectar y acepte el permiso.' });
    const account = await gmail.account(tokens.access_token);
    if (account !== config.emailRemitente.toLowerCase()) return res.status(400).json({ message: 'La cuenta de Google elegida no coincide con el remitente guardado.' });
    const updated = await InvoicingConfig.findOneAndUpdate({ _id: config._id, emailProvider: 'gmail', gmailClientId: config.gmailClientId, gmailClientSecret: config.gmailClientSecret, emailRemitente: config.emailRemitente }, { $set: { gmailRefreshToken: encrypt(tokens.refresh_token), gmailAccount: account } }, { new: true });
    if (!updated) return res.status(400).json({ message: 'La configuración cambió durante la autorización. Inténtelo de nuevo.' });
    res.json(sanitizeOutput(updated));
  } catch { res.status(400).json({ message: 'No se pudo completar la conexión con Google. Intente nuevamente.' }); }
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

    const sri = await sucursalSri(req.clinicId);
    const filename = `${sri}.p12`;
    const filepath = path.join(CERTS_DIR, filename);
    // El directorio puede no existir aunque se cree al arrancar (borrado en
    // caliente, deploy nuevo): asegurarlo aquí para no fallar con ENOENT.
    fs.mkdirSync(CERTS_DIR, { recursive: true });
    fs.writeFileSync(filepath, req.file.buffer);

    const config = await InvoicingConfig.findOneAndUpdate(
      { clinic: sri },
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
            ruc: rucsDelCertificado(info.certificate)[0] || '',
          },
        },
        $setOnInsert: { clinic: sri },
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

    // ¿Es del RUC que factura? Se avisa al subirlo, no cuando el SRI ya rechazó la factura.
    const rucsCert = rucsDelCertificado(info.certificate);
    const advertencia = rucsCert.length && config.ruc && !rucsCert.includes(String(config.ruc).trim())
      ? `Atención: este certificado es del RUC ${rucsCert.join(', ')} y la empresa factura con el RUC ${config.ruc}. El SRI rechazará las facturas («FIRMA INVALIDA»). Suba el certificado de la empresa.`
      : null;

    res.json({ config: sanitizeOutput(config), autoFill, advertencia });
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
    const config = await InvoicingConfig.findOne({ clinic: await sucursalSri(req.clinicId) });
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
      { _id: config._id },
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
  const config = await InvoicingConfig.findOne({ clinic: await sucursalSri(clinicId) });
  if (!config) throw new Error('Configuración de facturación no encontrada');
  if (!config.isComplete()) throw new Error('Configuración de facturación incompleta');

  const filepath = path.join(CERTS_DIR, config.certificateFilename);
  if (!fs.existsSync(filepath)) throw new Error('Archivo de certificado no encontrado');

  const p12Buffer = fs.readFileSync(filepath);
  const password = decrypt(config.certificatePassword);

  /**
   * EL CERTIFICADO TIENE QUE SER DEL RUC QUE EMITE (oct-2026). Si no lo es, el SRI responde
   * «FIRMA INVALIDA … RucComprobante / RucCertificado» y el número de factura ya se gastó.
   * Se corta aquí, antes de reservar ningún número, con el motivo claro.
   */
  const rucs = rucsDelCertificado(loadP12(p12Buffer, password, { ruc: config.ruc }).certificate);
  if (rucs.length && config.ruc && !rucs.includes(String(config.ruc).trim())) {
    throw Object.assign(new Error(
      `El certificado de firma electrónica cargado es del RUC ${rucs.join(', ')}, pero se factura con el RUC ${config.ruc}. `
      + 'El SRI lo rechaza («FIRMA INVALIDA»). Suba en Configuración SRI el certificado de la empresa (el de su representante legal).'
    ), { status: 400, code: 'CERTIFICADO_DE_OTRO_RUC' });
  }
  return { config, p12Buffer, password };
};
