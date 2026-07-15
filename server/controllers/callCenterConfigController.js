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
    // Reconciliar los números QR con la sesión real: si se desvinculó desde el
    // teléfono sin que llegara el evento, aquí se detecta y se corrige antes de
    // responder (la página nunca muestra "Conectado" con una sesión muerta).
    await Promise.all(
      accounts.map((a) => (a.connectionType === 'qr' ? qrManager.reconcileAccount(a).catch(() => {}) : null))
    );
    res.json(accounts.map(maskWaAccount));
  } catch (err) {
    res.status(500).json({ message: 'Error al listar números', error: err.message });
  }
};

/**
 * GET /whatsapp/accounts/:id/qr — estado vivo + último QR del número.
 * Es el RESPALDO del socket para el modal de conexión: si el socket se cae o
 * se pierde un evento, la página sondea este endpoint y no se queda ciega.
 */
exports.getWhatsappAccountQr = async (req, res) => {
  try {
    const doc = await WhatsappAccount.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Número no encontrado' });
    if (doc.connectionType !== 'qr') {
      return res.status(400).json({ message: 'Solo aplica a números QR' });
    }
    const snap = qrManager.getLiveSnapshot(doc._id);
    if (!snap) {
      // Sin cliente vivo: el estado de BD manda (reconciliado si estaba viejo).
      await qrManager.reconcileAccount(doc).catch(() => {});
      return res.json({ status: doc.status, qr: '', percent: null, connectedPhone: doc.connectedPhone || '' });
    }
    res.json({ ...snap, connectedPhone: doc.connectedPhone || '' });
  } catch (err) {
    res.status(500).json({ message: 'Error al consultar el estado', error: err.message });
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

/**
 * POST /whatsapp/accounts/:id/test — Diagnóstico completo de un número Cloud API.
 * No solo comprueba que el token "lea" el número: inspecciona el token con
 * debug_token (vigencia, permisos y QUÉ WABAs tiene asignadas) para detectar la
 * causa exacta del error (#200) "You do not have the necessary permissions to
 * send messages on behalf of this WhatsApp Business Account", que ocurre cuando
 * el token no tiene whatsapp_business_messaging o no tiene ESTA WABA asignada.
 * Devuelve { ok, checks: [{ ok, label, detail, fix }] }.
 */
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
    const token = decryptSecret(doc.accessToken);
    const V = process.env.WHATSAPP_API_VERSION || 'v20.0';
    const checks = [];

    // 1) Inspección del token (un token puede inspeccionarse a sí mismo).
    let dbg = null;
    try {
      const r = await fetch(
        `https://graph.facebook.com/${V}/debug_token?input_token=${encodeURIComponent(token)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const j = await r.json().catch(() => ({}));
      if (r.ok && j?.data) dbg = j.data;
    } catch { /* sin red o token ilegible: se reporta abajo */ }

    if (!dbg) {
      checks.push({
        ok: false,
        label: 'Token legible por Meta',
        detail: 'Meta no pudo inspeccionar el token (inválido o revocado).',
        fix: 'Genera un token nuevo en Business Manager → Usuarios del sistema y guárdalo en este número.',
      });
    } else {
      // Vigencia
      const expiresAt = Number(dbg.expires_at || 0); // 0 = no caduca (usuario del sistema)
      const expired = dbg.is_valid === false || (expiresAt > 0 && expiresAt * 1000 < Date.now());
      checks.push({
        ok: !expired,
        label: 'Token vigente',
        detail: expired
          ? 'El token está caducado o fue invalidado.'
          : expiresAt === 0
            ? 'Token sin caducidad (usuario del sistema). ✔ Ideal para producción.'
            : `Caduca el ${new Date(expiresAt * 1000).toLocaleString('es-EC', { timeZone: 'America/Guayaquil' })}. Los tokens temporales del panel de desarrollador duran ~24h.`,
        fix: expired
          ? 'Genera un token PERMANENTE: Business Manager → Configuración del negocio → Usuarios del sistema → Generar token (con la app y los permisos de WhatsApp).'
          : expiresAt > 0
            ? 'Para que no se caiga cada 24h, usa un token de Usuario del sistema (no caduca).'
            : '',
      });

      // App a la que pertenece el token + fecha de emisión (delata si realmente
      // se regeneró y si es de la app correcta).
      checks.push({
        ok: true,
        label: 'App y emisión del token',
        detail: `App: ${dbg.application || 'desconocida'}${dbg.app_id ? ` (ID ${dbg.app_id})` : ''}${
          dbg.issued_at
            ? ` · emitido el ${new Date(dbg.issued_at * 1000).toLocaleString('es-EC', { timeZone: 'America/Guayaquil' })}`
            : ''
        }`,
        fix: '',
      });

      // Permisos (scopes)
      const scopes = dbg.scopes || [];
      const canMessage = scopes.includes('whatsapp_business_messaging');
      checks.push({
        ok: canMessage,
        label: 'Permiso para ENVIAR mensajes (whatsapp_business_messaging)',
        detail: canMessage
          ? 'El token tiene el permiso de mensajería.'
          : `El token NO tiene whatsapp_business_messaging (tiene: ${scopes.join(', ') || 'ninguno'}). Esta es la causa típica del error #200 al enviar.`,
        fix: canMessage ? '' : 'Al generar el token del Usuario del sistema, marca los permisos "whatsapp_business_messaging" y "whatsapp_business_management".',
      });

      // WABA asignada al token (granular_scopes → target_ids)
      const gran = (dbg.granular_scopes || []).find((g) => g.scope === 'whatsapp_business_messaging');
      const targetIds = gran?.target_ids || null; // null = sin restricción granular
      if (doc.businessAccountId && Array.isArray(targetIds)) {
        const hasWaba = targetIds.includes(String(doc.businessAccountId));
        checks.push({
          ok: hasWaba,
          label: 'Esta cuenta de WhatsApp (WABA) asignada al token',
          detail: hasWaba
            ? `El token puede enviar por la WABA ${doc.businessAccountId}.`
            : `El token solo puede enviar por: ${targetIds.join(', ') || '(ninguna)'} y este número pertenece a la WABA ${doc.businessAccountId}. Esta es la causa del error #200.`,
          fix: hasWaba
            ? ''
            : 'Business Manager → Usuarios del sistema → tu usuario → "Asignar activos" → Cuentas de WhatsApp: añade ESTA cuenta con control total, y vuelve a generar el token.',
        });
      } else if (!doc.businessAccountId) {
        checks.push({
          ok: true,
          label: 'WABA ID no guardado en este número',
          detail: 'Guarda el "Identificador de la cuenta de WhatsApp Business" (WABA ID) al editar el número para poder verificar la asignación exacta.',
          fix: '',
        });
      } else {
        // Hay WABA ID guardado pero Meta no reportó restricción granular para el
        // scope de mensajería: el permiso aplica a todo lo que el usuario del
        // sistema tenga asignado.
        checks.push({
          ok: true,
          label: 'Cuentas de WhatsApp asignadas al token',
          detail: 'Meta no reporta restricción por WABA para este token (aplica a todos los activos del usuario del sistema).',
          fix: '',
        });
      }
    }

    // 2) Acceso al número concreto con ese token + su ESTADO real: si el número
    // no está registrado en Cloud API o sigue operando en la app del teléfono
    // (platform_type SMB), el envío por API falla aunque los permisos estén bien.
    const r = await fetch(
      `https://graph.facebook.com/${V}/${doc.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,status,platform_type,code_verification_status`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await r.json().catch(() => ({}));
    checks.push({
      ok: r.ok,
      label: 'Acceso al número (phone number ID)',
      detail: r.ok
        ? `Número ${data.display_phone_number || doc.phoneNumberId} ("${data.verified_name || 'sin nombre verificado'}").`
        : data?.error?.message || 'Meta rechazó la consulta del número.',
      fix: r.ok
        ? ''
        : 'Verifica que el phone number ID sea el correcto (WhatsApp Manager → Números de teléfono) y que el token tenga acceso a su WABA.',
    });
    if (r.ok && (data.status || data.platform_type || data.code_verification_status)) {
      const status = String(data.status || '').toUpperCase();
      const platform = String(data.platform_type || '').toUpperCase();
      const codeVer = String(data.code_verification_status || '').toUpperCase();
      const isCloud = !platform || platform === 'CLOUD_API' || platform === 'NOT_APPLICABLE';
      const isConnected = !status || status === 'CONNECTED';
      checks.push({
        ok: isCloud && isConnected,
        label: 'Estado del número en Cloud API',
        detail: `Estado: ${status || 'n/d'} · Plataforma: ${platform || 'n/d'} · Verificación del número: ${codeVer || 'n/d'}.`,
        fix: !isCloud
          ? 'El número está operando en la app de WhatsApp Business del teléfono (SMB), no en Cloud API. Debes migrarlo/registrarlo: WhatsApp Manager → Números de teléfono → Registrar para la API en la nube (el número se desconecta de la app del teléfono).'
          : !isConnected
            ? 'El número no está CONECTADO en Cloud API: en WhatsApp Manager → Números de teléfono, completa el registro (verificación por SMS/llamada y PIN de verificación en dos pasos).'
            : '',
      });
    }

    // 2b) La WABA guardada: ¿realmente contiene este número? Con varias cuentas
    // del MISMO nombre en el Business Manager es fácil guardar el ID equivocado.
    if (doc.businessAccountId) {
      try {
        // ¿Qué empresa es DUEÑA de la WABA? Si pertenece a otro Business Manager
        // (típico del registro integrado), Business Settings revierte en silencio
        // los permisos que intentes dar y el envío da #200 aunque todo se lea bien.
        const ro = await fetch(
          `https://graph.facebook.com/${V}/${doc.businessAccountId}?fields=name,owner_business_info,on_behalf_of_business_info,account_review_status,business_verification_status`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const oj = await ro.json().catch(() => ({}));
        // Estado de revisión de la WABA + verificación del negocio: una WABA en
        // revisión (PENDING) o rechazada, o un negocio sin verificar, bloquea el
        // envío real con #200 aunque token/permisos/número estén perfectos.
        if (ro.ok && (oj.account_review_status || oj.business_verification_status)) {
          const review = String(oj.account_review_status || '').toUpperCase();
          const bver = String(oj.business_verification_status || '').toLowerCase();
          const reviewOk = !review || review === 'APPROVED';
          const bverOk = !bver || bver === 'verified';
          checks.push({
            ok: reviewOk && bverOk,
            label: 'Revisión de la WABA y verificación del negocio',
            detail: `Revisión de la cuenta: ${review || 'n/d'} · Verificación del negocio: ${bver || 'n/d'}.`,
            fix: !reviewOk
              ? (review === 'PENDING'
                  ? 'La cuenta de WhatsApp está EN REVISIÓN por Meta: hasta que la aprueben, el envío real está bloqueado. Suele resolverse en horas/días; la verificación del negocio lo acelera.'
                  : 'La revisión de la cuenta de WhatsApp fue RECHAZADA: revisa las políticas de WhatsApp Business y apela desde WhatsApp Manager.')
              : !bverOk
                ? 'El negocio NO está verificado: Business Manager → Centro de seguridad → "Verificación del negocio" (pide RUC/documentos; 1-2 días). Sin esto Meta restringe el envío en producción.'
                : '',
          });
        }
        if (ro.ok && (oj.owner_business_info || oj.on_behalf_of_business_info)) {
          const owner = oj.owner_business_info || {};
          const obo = oj.on_behalf_of_business_info || null;
          checks.push({
            ok: true,
            label: 'Empresa propietaria de la WABA',
            detail: `"${oj.name || ''}" pertenece a la empresa «${owner.name || 'desconocida'}» (ID ${owner.id || 'n/d'})${obo ? ` · operada en nombre de «${obo.name}» (ID ${obo.id})` : ''}. Si esa empresa NO es tu Business Manager, ahí está la causa: no puedes dar permisos sobre una WABA ajena.`,
            fix: '',
          });
        }
        const rp = await fetch(
          `https://graph.facebook.com/${V}/${doc.businessAccountId}/phone_numbers?fields=id,display_phone_number`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const pj = await rp.json().catch(() => ({}));
        if (rp.ok) {
          const nums = pj.data || [];
          const contains = nums.some((n) => String(n.id) === String(doc.phoneNumberId));
          checks.push({
            ok: contains,
            label: 'El número pertenece a la WABA guardada',
            detail: contains
              ? `La WABA ${doc.businessAccountId} sí contiene este número.`
              : `La WABA guardada (${doc.businessAccountId}) NO contiene este número — sus números son: ${nums.map((n) => n.display_phone_number).join(', ') || '(ninguno)'}. Probablemente copiaste el ID de otra cuenta con el mismo nombre.`,
            fix: contains
              ? ''
              : 'En WhatsApp Manager abre la cuenta que SÍ contiene este número, copia su ID, guárdalo aquí (editar número), asigna ESA cuenta al usuario del sistema y regenera el token.',
          });
        } else {
          checks.push({
            ok: false,
            label: 'Acceso a la WABA guardada',
            detail: pj?.error?.message || `El token no puede leer la WABA ${doc.businessAccountId}.`,
            fix: 'Asigna esa cuenta de WhatsApp al usuario del sistema (control total) y REGENERA el token, o corrige el WABA ID guardado en este número.',
          });
        }

        // ¿La app del token está conectada (suscrita) a esa WABA? Enviar con el
        // token de una app distinta a la conectada produce el #200.
        if (dbg?.app_id) {
          const rs = await fetch(
            `https://graph.facebook.com/${V}/${doc.businessAccountId}/subscribed_apps`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          const sj = await rs.json().catch(() => ({}));
          if (rs.ok) {
            const apps = (sj.data || []).map((a) => a.whatsapp_business_api_data || a || {});
            const subscribed = apps.some((a) => String(a.id) === String(dbg.app_id));
            checks.push({
              ok: subscribed,
              label: 'La app del token está conectada a la WABA',
              detail: subscribed
                ? `La app del token (${dbg.application || dbg.app_id}) está suscrita a esta WABA.`
                : `Esta WABA tiene conectadas: ${apps.map((a) => a.name || a.id).join(', ') || '(ninguna app)'} — pero tu token es de la app "${dbg.application || ''}" (${dbg.app_id}). Un token de otra app no puede enviar por esta cuenta (#200).`,
              fix: subscribed
                ? ''
                : 'Genera el token desde la app que está conectada a esta WABA, o conecta tu app a la WABA y regenera el token.',
            });
          }
        }
      } catch { /* sin red: se omiten estos chequeos */ }
    }

    // 3) Envío REAL de prueba (opcional, si mandan un número destino): reproduce
    // el error exacto de Meta al enviar (p.ej. #200), que el simple "leer" no detecta.
    const testTo = String(req.body?.to || '').replace(/[^\d]/g, '');
    if (testTo) {
      const gateway = require('../utils/whatsappGateway');
      const send = await gateway.sendText(doc, testTo, 'Prueba de conexión del sistema ✅');
      const metaErr = send?.data?.error || null;
      const code = metaErr?.code || null;
      let fix = 'Revisa el detalle del error de Meta.';
      if (code === 200 || String(metaErr?.message || '').includes('#200')) {
        fix = 'El token no puede enviar por la WABA de este número: en Business Manager → Usuarios del sistema → Asignar activos, añade ESTA cuenta de WhatsApp con control total y regenera el token.';
      } else if (code === 131047) {
        fix = 'Ventana de 24h cerrada para ese destinatario: escribe primero un WhatsApp desde ese teléfono a este número y vuelve a probar (o usa una plantilla).';
      } else if (code === 131030) {
        fix = 'El número es de PRUEBA de Meta: el destinatario debe estar en la lista de destinatarios permitidos (máx. 5).';
      } else if (code === 131026) {
        fix = 'El destinatario no tiene WhatsApp o el número está mal escrito (usa código de país, ej. 5939XXXXXXXX).';
      }
      checks.push({
        ok: !!send.ok,
        label: `Envío real de prueba a ${testTo}`,
        detail: send.ok
          ? 'Mensaje aceptado por Meta. Revisa que haya llegado al teléfono.'
          : `${metaErr?.message || send.error || 'Meta rechazó el envío'}${metaErr?.error_data?.details ? ` — ${metaErr.error_data.details}` : ''}${code ? ` (código ${code}${metaErr?.error_subcode ? `/${metaErr.error_subcode}` : ''})` : ''}${metaErr?.fbtrace_id ? ` · fbtrace: ${metaErr.fbtrace_id}` : ''}`,
        fix: send.ok ? '' : fix,
      });
    }

    const ok = checks.every((c) => c.ok);
    res.json({ ok, checks, info: r.ok ? data : null });
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
