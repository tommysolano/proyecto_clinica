const CallCenterConfig = require('../models/CallCenterConfig');
const WhatsappAccount = require('../models/WhatsappAccount');
const CallCenterWhatsappConfig = require('../models/CallCenterWhatsappConfig');
const qrManager = require('../utils/whatsappQrManager');
const { encryptSecret, decryptSecret } = require('../utils/secretCrypto');

/**
 * Devuelve la configuración de la clínica enmascarando tokens/secrets.
 * El cliente solo ve los últimos 4 caracteres como indicador de "configurado".
 */
const SENSITIVE_KEYS = ['accessToken', 'verifyToken', 'appSecret', 'pageAccessToken', 'apiKey'];
// Secrets reales que se cifran en reposo (verifyToken es solo handshake → no se cifra).
const ENCRYPT_KEYS = ['accessToken', 'appSecret', 'pageAccessToken', 'apiKey'];

// Enmascara: descifra primero para mostrar los últimos 4 reales.
const maskSecret = (val) => {
  if (!val || typeof val !== 'string') return '';
  const plain = decryptSecret(val);
  if (plain.length <= 4) return '****';
  return `••••${plain.slice(-4)}`;
};

const maskChannel = (channel) => {
  if (!channel) return {};
  const out = channel.toObject ? channel.toObject() : { ...channel };
  for (const k of SENSITIVE_KEYS) {
    if (out[k]) out[k] = maskSecret(out[k]);
  }
  return out;
};

const maskConfig = (cfg) => {
  const out = cfg.toObject ? cfg.toObject() : { ...cfg };
  out.whatsapp = maskChannel(out.whatsapp);
  out.messenger = maskChannel(out.messenger);
  out.instagram = maskChannel(out.instagram);
  out.tiktok = maskChannel(out.tiktok);
  out.email = maskChannel(out.email);
  out.ai = maskChannel(out.ai);
  return out;
};

/**
 * GET /api/call-center-config
 * Devuelve (o crea vacío) la config de la clínica activa.
 */
exports.get = async (req, res) => {
  try {
    let cfg = await CallCenterConfig.findOne({ clinic: req.clinicId });
    if (!cfg) {
      cfg = await CallCenterConfig.create({ clinic: req.clinicId, updatedBy: req.user._id });
    }
    res.json(maskConfig(cfg));
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener configuración', error: err.message });
  }
};

/**
 * GET /api/call-center-config/webhook-urls
 * Devuelve las URLs públicas que el usuario debe configurar en Meta/TikTok.
 * Útil para que el admin copie la URL al panel de Meta for Developers.
 */
exports.getWebhookUrls = async (req, res) => {
  // PUBLIC_API_URL puede venir con o sin "/api"; normalizamos para emitir el
  // prefijo una sola vez y que las URLs sean siempre .../api/chats/...
  let base = process.env.PUBLIC_API_URL || `${req.protocol}://${req.get('host')}`;
  base = base.replace(/\/+$/, '').replace(/\/api$/, '');
  res.json({
    // WhatsApp es global (call center compartido): una sola URL para todos los números Cloud API.
    whatsapp: `${base}/api/chats/webhook/whatsapp`,
    messenger: `${base}/api/chats/webhook/messenger/${req.clinicId}`,
    instagram: `${base}/api/chats/webhook/instagram/${req.clinicId}`,
    tiktok: `${base}/api/chats/webhook/tiktok/${req.clinicId}`,
    note:
      'Configura estas URLs como callback en el panel de Meta for Developers (WhatsApp/Messenger/Instagram) y en TikTok Developer. ' +
      'El valor "Verify Token" que pongas en cada plataforma debe coincidir con el verifyToken configurado aquí.',
  });
};

/**
 * PUT /api/call-center-config
 * Actualiza un canal. Body esperado: { channel: 'whatsapp'|'messenger'|'instagram'|'tiktok', data: {...} }
 *
 * Si un campo sensible llega con el valor enmascarado (•••• prefix) lo ignoramos
 * para no sobrescribir el secret real con la versión enmascarada.
 */
exports.update = async (req, res) => {
  try {
    const { channel, data } = req.body;
    if (!['whatsapp', 'messenger', 'instagram', 'tiktok', 'email', 'ai'].includes(channel)) {
      return res.status(400).json({ message: 'Canal inválido' });
    }
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ message: 'Datos inválidos' });
    }

    let cfg = await CallCenterConfig.findOne({ clinic: req.clinicId });
    if (!cfg) {
      cfg = new CallCenterConfig({ clinic: req.clinicId });
    }
    const current = cfg[channel] || {};
    const cleaned = {};
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'string' && v.startsWith('••••')) {
        // No tocar — el usuario no cambió el campo sensible.
        continue;
      }
      // Cifra los secrets reales antes de persistir.
      cleaned[k] = ENCRYPT_KEYS.includes(k) && typeof v === 'string' && v ? encryptSecret(v) : v;
    }
    cfg[channel] = { ...current.toObject?.() || current, ...cleaned };
    cfg.updatedBy = req.user._id;
    await cfg.save();
    res.json(maskConfig(cfg));
  } catch (err) {
    res.status(500).json({ message: 'Error al guardar configuración', error: err.message });
  }
};

/**
 * PUT /api/call-center-config/reputation
 * Guarda la URL de reseñas de Google y el rating mínimo para considerar promotor.
 */
exports.updateReputation = async (req, res) => {
  try {
    let cfg = await CallCenterConfig.findOne({ clinic: req.clinicId });
    if (!cfg) cfg = new CallCenterConfig({ clinic: req.clinicId });
    cfg.reputation = {
      googleReviewUrl: String(req.body.googleReviewUrl || '').trim(),
      minRating: Math.max(1, Math.min(5, Number(req.body.minRating) || 4)),
    };
    cfg.updatedBy = req.user._id;
    await cfg.save();
    res.json(maskConfig(cfg));
  } catch (err) {
    res.status(500).json({ message: 'Error al guardar reputación', error: err.message });
  }
};

/**
 * POST /api/call-center-config/:channel/test
 * Prueba conexión simple con la API del canal usando las credenciales guardadas.
 */
exports.testConnection = async (req, res) => {
  try {
    const { channel } = req.params;
    const cfg = await CallCenterConfig.findOne({ clinic: req.clinicId });
    if (!cfg || !cfg[channel]) {
      return res.status(404).json({ message: 'Canal no configurado' });
    }
    const c = cfg[channel];
    if (channel === 'whatsapp') {
      if (!c.accessToken || !c.phoneNumberId) {
        return res.status(400).json({ message: 'Falta accessToken o phoneNumberId' });
      }
      // Llamada a Graph API para verificar token (descifrado en uso).
      const r = await fetch(`https://graph.facebook.com/v20.0/${c.phoneNumberId}?fields=display_phone_number,verified_name`, {
        headers: { Authorization: `Bearer ${decryptSecret(c.accessToken)}` },
      });
      const data = await r.json();
      if (!r.ok) return res.status(400).json({ message: 'Token inválido', detail: data });
      return res.json({ ok: true, info: data });
    }
    if (channel === 'messenger' || channel === 'instagram') {
      if (!c.pageAccessToken || !c.pageId) {
        return res.status(400).json({ message: 'Falta pageAccessToken o pageId' });
      }
      const r = await fetch(`https://graph.facebook.com/v20.0/${c.pageId}?fields=name`, {
        headers: { Authorization: `Bearer ${decryptSecret(c.pageAccessToken)}` },
      });
      const data = await r.json();
      if (!r.ok) return res.status(400).json({ message: 'Token inválido', detail: data });
      return res.json({ ok: true, info: data });
    }
    if (channel === 'tiktok') {
      if (!c.accessToken) {
        return res.status(400).json({ message: 'Falta accessToken' });
      }
      // TikTok no tiene un endpoint "ping" universal; aceptamos si el token está presente.
      return res.json({
        ok: true,
        info: { message: 'Token presente. La verificación real depende del producto TikTok que uses.' },
      });
    }
    if (channel === 'email') {
      if (!c.apiKey || !c.fromEmail) {
        return res.status(400).json({ message: 'Falta apiKey o fromEmail' });
      }
      return res.json({
        ok: true,
        info: { message: 'Credenciales presentes. Envía una campaña de prueba para verificar la entrega.' },
      });
    }
    res.status(400).json({ message: 'Canal no soportado' });
  } catch (err) {
    res.status(500).json({ message: 'Error de prueba', error: err.message });
  }
};

/**
 * POST /api/call-center-config/ai/test
 * Prueba la conexión con la IA usando la config guardada (o el entorno).
 */
exports.testAi = async (req, res) => {
  try {
    const { testAiConnection } = require('../utils/aiAssistant');
    const r = await testAiConnection(req.clinicId);
    if (!r.ok) return res.status(400).json({ message: r.reason || 'No se pudo conectar con la IA' });
    res.json({ ok: true, model: r.model });
  } catch (err) {
    res.status(500).json({ message: 'Error de prueba', error: err.message });
  }
};

// ═══════════ WhatsApp: números globales del call center (multi-número) ═══════════
//
// Los números son GLOBALES (no por clínica): el call center atiende a todas las
// sedes. Cada número se conecta por Cloud API (Meta) o por QR (whatsapp-web.js).

const maskWaAccount = (acc) => {
  const o = acc.toObject ? acc.toObject() : { ...acc };
  if (o.accessToken) o.accessToken = maskSecret(o.accessToken);
  o.liveStatus = qrManager.getLiveStatus(o._id); // estado en memoria (QR)
  return o;
};

const appConfigPayload = (req, cfg) => {
  // PUBLIC_API_URL puede venir con o sin "/api" al final; normalizamos para
  // emitir el prefijo una sola vez y que el webhook sea siempre .../api/chats/...
  let base = process.env.PUBLIC_API_URL || `${req.protocol}://${req.get('host')}`;
  base = base.replace(/\/+$/, '').replace(/\/api$/, '');
  return {
    appSecret: maskSecret(cfg.cloudApi?.appSecret || ''),
    verifyToken: maskSecret(cfg.cloudApi?.verifyToken || ''),
    callCenterClinic: cfg.callCenterClinic || null,
    webhookUrl: `${base}/api/chats/webhook/whatsapp`,
    conversionsApi: {
      enabled: Boolean(cfg.conversionsApi?.enabled),
      datasetId: cfg.conversionsApi?.datasetId || '',
      accessToken: maskSecret(cfg.conversionsApi?.accessToken || ''),
      testEventCode: cfg.conversionsApi?.testEventCode || '',
    },
  };
};

exports.listWhatsappAccounts = async (req, res) => {
  try {
    const accounts = await WhatsappAccount.find().sort({ isDefault: -1, createdAt: 1 });
    res.json(accounts.map(maskWaAccount));
  } catch (err) {
    res.status(500).json({ message: 'Error al listar números', error: err.message });
  }
};

exports.createWhatsappAccount = async (req, res) => {
  try {
    const { label, connectionType, displayPhone, phoneNumberId, businessAccountId, accessToken } = req.body;
    if (!['cloud_api', 'qr'].includes(connectionType)) {
      return res.status(400).json({ message: 'Método de conexión inválido' });
    }
    if (!label || !String(label).trim()) {
      return res.status(400).json({ message: 'El nombre del número es obligatorio' });
    }
    if (connectionType === 'cloud_api' && !phoneNumberId) {
      return res.status(400).json({ message: 'Cloud API requiere Phone Number ID' });
    }
    const count = await WhatsappAccount.countDocuments();
    const doc = await WhatsappAccount.create({
      label: String(label).trim(),
      connectionType,
      displayPhone: displayPhone || '',
      phoneNumberId: connectionType === 'cloud_api' ? phoneNumberId || '' : '',
      businessAccountId: connectionType === 'cloud_api' ? businessAccountId || '' : '',
      accessToken: connectionType === 'cloud_api' && accessToken ? encryptSecret(accessToken) : '',
      isDefault: count === 0, // el primer número es el por defecto
      enabled: true,
      createdBy: req.user._id,
    });
    res.status(201).json(maskWaAccount(doc));
  } catch (err) {
    res.status(500).json({ message: 'Error al crear número', error: err.message });
  }
};

exports.updateWhatsappAccount = async (req, res) => {
  try {
    const doc = await WhatsappAccount.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Número no encontrado' });
    for (const k of ['label', 'displayPhone', 'phoneNumberId', 'businessAccountId', 'enabled']) {
      if (k in req.body) doc[k] = req.body[k];
    }
    // accessToken: ignora el valor enmascarado; cifra si llega uno nuevo.
    if (typeof req.body.accessToken === 'string' && !req.body.accessToken.startsWith('••••')) {
      doc.accessToken = req.body.accessToken ? encryptSecret(req.body.accessToken) : '';
    }
    await doc.save();
    res.json(maskWaAccount(doc));
  } catch (err) {
    res.status(500).json({ message: 'Error al actualizar número', error: err.message });
  }
};

exports.deleteWhatsappAccount = async (req, res) => {
  try {
    const doc = await WhatsappAccount.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Número no encontrado' });
    if (doc.connectionType === 'qr') await qrManager.disconnect(doc._id).catch(() => {});
    const wasDefault = doc.isDefault;
    await doc.deleteOne();
    if (wasDefault) {
      const next = await WhatsappAccount.findOne().sort({ createdAt: 1 });
      if (next) { next.isDefault = true; await next.save(); }
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: 'Error al eliminar número', error: err.message });
  }
};

exports.setDefaultWhatsappAccount = async (req, res) => {
  try {
    const doc = await WhatsappAccount.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Número no encontrado' });
    await WhatsappAccount.updateMany({ _id: { $ne: doc._id } }, { isDefault: false });
    doc.isDefault = true;
    await doc.save();
    res.json(maskWaAccount(doc));
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

exports.connectWhatsappAccount = async (req, res) => {
  try {
    const doc = await WhatsappAccount.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Número no encontrado' });
    if (doc.connectionType !== 'qr') {
      return res.status(400).json({ message: 'Solo los números QR se conectan por escaneo' });
    }
    const r = await qrManager.connect(doc._id, { userId: req.user._id });
    if (!r.ok) return res.status(400).json({ message: r.error || 'No se pudo iniciar la conexión' });
    res.json({ ok: true, status: r.status });
  } catch (err) {
    res.status(500).json({ message: 'Error al conectar', error: err.message });
  }
};

exports.disconnectWhatsappAccount = async (req, res) => {
  try {
    const doc = await WhatsappAccount.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Número no encontrado' });
    await qrManager.disconnect(doc._id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: 'Error al desconectar', error: err.message });
  }
};

exports.testWhatsappAccount = async (req, res) => {
  try {
    const doc = await WhatsappAccount.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Número no encontrado' });
    if (doc.connectionType !== 'cloud_api') {
      return res.status(400).json({ message: 'La prueba aplica a Cloud API. Para QR usa "Conectar".' });
    }
    if (!doc.accessToken || !doc.phoneNumberId) {
      return res.status(400).json({ message: 'Falta accessToken o phoneNumberId' });
    }
    const r = await fetch(
      `https://graph.facebook.com/v20.0/${doc.phoneNumberId}?fields=display_phone_number,verified_name`,
      { headers: { Authorization: `Bearer ${decryptSecret(doc.accessToken)}` } }
    );
    const data = await r.json();
    if (!r.ok) return res.status(400).json({ message: 'Token inválido', detail: data });
    res.json({ ok: true, info: data });
  } catch (err) {
    res.status(500).json({ message: 'Error de prueba', error: err.message });
  }
};

/**
 * POST /whatsapp/accounts/:id/quality — consulta a Meta la calidad actual del
 * número (Verde/Amarillo/Rojo) y su límite de mensajería, y los persiste.
 */
exports.refreshWhatsappAccountQuality = async (req, res) => {
  try {
    const doc = await WhatsappAccount.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Número no encontrado' });
    const r = await require('../utils/whatsappQuality').refreshAccountQuality(doc);
    if (!r.ok) return res.status(400).json({ message: r.error || 'No se pudo consultar la calidad' });
    res.json({ ok: true, qualityRating: r.qualityRating, messagingLimit: r.messagingLimit, account: maskWaAccount(doc) });
  } catch (err) {
    res.status(500).json({ message: 'Error al consultar calidad', error: err.message });
  }
};

/**
 * POST /whatsapp/capi/test — envía un evento de prueba 'Lead' a la Conversions
 * API para verificar credenciales. Con testEventCode configurado, el evento
 * aparece en "Probar eventos" del Administrador de Eventos de Meta.
 */
exports.testConversionsApi = async (req, res) => {
  try {
    const capi = require('../utils/metaConversions');
    const r = await capi.sendConversionEvent({
      eventName: 'Lead',
      eventId: `test_${Date.now()}`,
      user: { phone: req.body.phone || '593999999999' },
      customData: { chat_funnel_stage: 'prueba_conexion' },
    });
    if (r.skipped) {
      return res.status(400).json({
        message:
          r.reason === 'capi_not_configured'
            ? 'CAPI no está habilitada o falta Dataset ID / Access Token'
            : 'No hay identificadores de usuario para el evento',
      });
    }
    if (!r.ok) return res.status(400).json({ message: r.error || 'Meta rechazó el evento', detail: r.data });
    res.json({ ok: true, result: r.data });
  } catch (err) {
    res.status(500).json({ message: 'Error de prueba CAPI', error: err.message });
  }
};

// Config a nivel de app (compartida): appSecret/verifyToken del webhook + sede.
exports.getWhatsappAppConfig = async (req, res) => {
  try {
    // La clínica ancla del CRM se resuelve automáticamente (no se elige en la UI).
    const cfg = await CallCenterWhatsappConfig.getSingleton();
    res.json(appConfigPayload(req, cfg));
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

exports.updateWhatsappAppConfig = async (req, res) => {
  try {
    const cfg = await CallCenterWhatsappConfig.getSingleton();
    const cloud = cfg.cloudApi || {};
    if (typeof req.body.appSecret === 'string' && !req.body.appSecret.startsWith('••••')) {
      cloud.appSecret = req.body.appSecret ? encryptSecret(req.body.appSecret) : '';
    }
    if (typeof req.body.verifyToken === 'string' && !req.body.verifyToken.startsWith('••••')) {
      cloud.verifyToken = req.body.verifyToken || '';
    }
    cfg.cloudApi = cloud;
    // Conversions API (CAPI): dataset + token (cifrado) + modo de prueba.
    const capi = cfg.conversionsApi || {};
    if ('capiEnabled' in req.body) capi.enabled = Boolean(req.body.capiEnabled);
    if (typeof req.body.capiDatasetId === 'string') capi.datasetId = req.body.capiDatasetId.trim();
    if (typeof req.body.capiAccessToken === 'string' && !req.body.capiAccessToken.startsWith('••••')) {
      capi.accessToken = req.body.capiAccessToken ? encryptSecret(req.body.capiAccessToken) : '';
    }
    if (typeof req.body.capiTestEventCode === 'string') capi.testEventCode = req.body.capiTestEventCode.trim();
    cfg.conversionsApi = capi;
    if ('callCenterClinic' in req.body) cfg.callCenterClinic = req.body.callCenterClinic || null;
    cfg.updatedBy = req.user._id;
    await cfg.save();
    require('../utils/callCenterClinic').clearCache();
    res.json(appConfigPayload(req, cfg));
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};
