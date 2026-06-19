const CallCenterConfig = require('../models/CallCenterConfig');
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
  const base = process.env.PUBLIC_API_URL || `${req.protocol}://${req.get('host')}/api`;
  res.json({
    whatsapp: `${base}/chats/webhook/whatsapp/${req.clinicId}`,
    messenger: `${base}/chats/webhook/messenger/${req.clinicId}`,
    instagram: `${base}/chats/webhook/instagram/${req.clinicId}`,
    tiktok: `${base}/chats/webhook/tiktok/${req.clinicId}`,
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
