const CallCenterConfig = require('../models/CallCenterConfig');
const WhatsappAccount = require('../models/WhatsappAccount');
const CallCenterWhatsappConfig = require('../models/CallCenterWhatsappConfig');
const User = require('../models/User');
const qrManager = require('../utils/whatsappQrManager');
const whatsappIdentity = require('../utils/whatsappIdentity');
const { encryptSecret, decryptSecret } = require('../utils/secretCrypto');
const { TIME_RE, normalizeSchedule, isWorkingAt } = require('../utils/agentSchedule');

/**
 * Devuelve la configuración de la clínica enmascarando tokens/secrets.
 * El cliente solo ve los últimos 4 caracteres como indicador de "configurado".
 */
const SENSITIVE_KEYS = ['accessToken', 'verifyToken', 'appSecret', 'pageAccessToken', 'apiKey'];
// Secrets reales que se cifran en reposo (verifyToken es solo handshake → no se cifra).
const ENCRYPT_KEYS = ['accessToken', 'appSecret', 'pageAccessToken', 'apiKey'];

/**
 * Asesores del call center compartido y sus turnos. Es global igual que la
 * bandeja: no se filtra por la sucursal activa.
 */
exports.listAgentSchedules = async (req, res) => {
  try {
    const users = await User.find({ active: true, 'clinics.role': 'call_center' })
      .select('name email callCenterSchedule')
      .sort({ name: 1 })
      .lean();
    res.json(users.map((user) => {
      const callCenterSchedule = normalizeSchedule(user.callCenterSchedule);
      return { ...user, callCenterSchedule, inShift: isWorkingAt(callCenterSchedule) };
    }));
  } catch (err) {
    res.status(500).json({ message: 'Error al listar horarios de asesores', error: err.message });
  }
};

exports.updateAgentSchedule = async (req, res) => {
  try {
    const raw = req.body?.callCenterSchedule || req.body?.schedule;
    if (!raw || !Array.isArray(raw.days)) {
      return res.status(400).json({ message: 'Horario inválido' });
    }
    const invalidTime = raw.days.some((day) => !TIME_RE.test(String(day?.start || '')) || !TIME_RE.test(String(day?.end || '')));
    if (invalidTime) return res.status(400).json({ message: 'Las horas deben tener formato HH:MM' });
    const callCenterSchedule = normalizeSchedule(raw);
    if (callCenterSchedule.enabled && !callCenterSchedule.days.some((day) => day.enabled)) {
      return res.status(400).json({ message: 'Activa al menos un día de trabajo' });
    }
    const user = await User.findOneAndUpdate(
      { _id: req.params.id, active: true, 'clinics.role': 'call_center' },
      { $set: { callCenterSchedule } },
      { new: true, runValidators: true }
    ).select('name email callCenterSchedule');
    if (!user) return res.status(404).json({ message: 'Asesor call center no encontrado' });
    res.json({
      ...user.toObject(),
      callCenterSchedule: normalizeSchedule(user.callCenterSchedule),
      inShift: isWorkingAt(user.callCenterSchedule),
    });
  } catch (err) {
    res.status(500).json({ message: 'Error al guardar el horario', error: err.message });
  }
};

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
      whatsappBusinessAccountId: cfg.conversionsApi?.whatsappBusinessAccountId || '',
    },
    marketingApi: {
      enabled: Boolean(cfg.marketingApi?.enabled),
      accessToken: maskSecret(cfg.marketingApi?.accessToken || ''),
      adAccountId: cfg.marketingApi?.adAccountId || '',
    },
  };
};

exports.listWhatsappAccounts = async (req, res) => {
  try {
    // Los números ARCHIVADOS (borrados desde la app) no se listan: siguen en la
    // base solo como lápida, para que sus chats no apunten a la nada mientras el
    // número se reconecta. Ver utils/whatsappIdentity.js.
    const accounts = await WhatsappAccount.find({ archivedAt: null }).sort({ isDefault: -1, createdAt: 1 });
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
    const count = await WhatsappAccount.countDocuments({ archivedAt: null });
    const doc = await WhatsappAccount.create({
      label: String(label).trim(),
      connectionType,
      displayPhone: displayPhone || '',
      phoneNumberId: connectionType === 'cloud_api' ? phoneNumberId || '' : '',
      businessAccountId: connectionType === 'cloud_api' ? businessAccountId || '' : '',
      accessToken: connectionType === 'cloud_api' && accessToken ? encryptSecret(accessToken) : '',
      isDefault: count === 0, // el primer número es el por defecto
      enabled: true,
      phoneKey: whatsappIdentity.phoneKeyOf(displayPhone),
      createdBy: req.user._id,
    });
    // ¿Este número ya existió (se borró y se está volviendo a dar de alta)? Se
    // recupera su historial YA en Cloud API, donde la identidad la da el teléfono
    // o el phoneNumberId. En QR se hace al vincular, que es cuando WhatsApp dice
    // de qué teléfono se trata (ver whatsappQrManager, evento 'ready').
    if (connectionType === 'cloud_api') {
      await whatsappIdentity.adoptIdentity(doc).catch(() => {});
    }
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
    // La identidad del número la fija su TELÉFONO. En QR manda el que reporta
    // WhatsApp al vincular ('ready'): editar la etiqueta no debe pisarlo.
    if (!doc.phoneKey || doc.connectionType === 'cloud_api') {
      const key = whatsappIdentity.phoneKeyOf(doc.connectedPhone || doc.displayPhone);
      if (key) doc.phoneKey = key;
    }
    await doc.save();
    if (doc.connectionType === 'cloud_api') {
      await whatsappIdentity.adoptIdentity(doc).catch(() => {});
    }
    res.json(maskWaAccount(doc));
  } catch (err) {
    res.status(500).json({ message: 'Error al actualizar número', error: err.message });
  }
};

/** Traspasa los chats, su ventana de 24h y su historial de un número a otro. */
const reassignConversations = whatsappIdentity.reassignAccountLinks;

/**
 * DELETE /whatsapp/accounts/:id — quita un número de la lista y, con él, decide
 * qué pasa con sus conversaciones.
 *
 * NO SE BORRA DE VERDAD: se ARCHIVA (`archivedAt`). El borrado real era un
 * `deleteOne()` y los chats se quedaban apuntando a un id inexistente. Al
 * responder, la resolución del número caía hasta el final (el número POR
 * DEFECTO) y el mensaje salía por otro número — uno al que ese paciente nunca
 * había escrito, así que Meta lo rechazaba con 131047 y el paciente no recibía
 * nada. El 07-ago-2026 se borró así el número QR: 4.585 chats huérfanos y 156
 * mensajes perdidos al día siguiente.
 *
 * Con la lápida, ese historial NUNCA queda huérfano: cuando el mismo teléfono
 * vuelve a conectarse —aunque sea creando un número nuevo— lo reclama entero
 * (utils/whatsappIdentity.adoptIdentity) y la lápida desaparece sola.
 *
 * `replacementId` (body o query) traspasa los chats YA, a mano, a otro número
 * que siga conectado; se usa cuando el teléfono no va a volver.
 *
 * Sin destino los enlaces se dejan TAL CUAL, apuntando al número archivado.
 * Suena a dejar basura, pero es lo seguro: mientras el chat recuerde que su
 * último entrante llegó por un número que ya no está en línea, la ventana de 24h
 * se da por CERRADA y el agente ve que necesita una plantilla, en vez de escribir
 * texto libre que se pierde.
 */
exports.deleteWhatsappAccount = async (req, res) => {
  try {
    const doc = await WhatsappAccount.findById(req.params.id);
    if (!doc || doc.archivedAt) return res.status(404).json({ message: 'Número no encontrado' });

    const replacementId = req.body?.replacementId || req.query?.replacementId || null;
    let replacement = null;
    if (replacementId) {
      if (String(replacementId) === String(doc._id)) {
        return res.status(400).json({ message: 'El número de destino no puede ser el que se borra' });
      }
      replacement = await WhatsappAccount.findOne({ _id: replacementId, archivedAt: null });
      if (!replacement) return res.status(400).json({ message: 'El número de destino no existe' });
    }

    if (doc.connectionType === 'qr') await qrManager.disconnect(doc._id).catch(() => {});
    const Conversation = require('../models/Conversation');
    const moved = replacement
      ? await reassignConversations(doc._id, replacement._id)
      : { conversations: 0, windows: 0, messages: 0 };
    const orphaned = replacement ? 0 : await Conversation.countDocuments({ whatsappAccount: doc._id });
    const wasDefault = doc.isDefault;
    // Traspasado a otro número no queda nada que custodiar: ese destino ya es su
    // sucesor y hereda también su identidad (para los chats que no se movieran).
    if (replacement) {
      replacement.previousIds = [
        ...new Set([...(replacement.previousIds || []).map(String), String(doc._id)]),
      ];
      await replacement.save().catch(() => {});
    }
    doc.archivedAt = new Date();
    doc.enabled = false;
    doc.isDefault = false;
    doc.status = 'disconnected';
    await doc.save();
    if (wasDefault) {
      const next = await WhatsappAccount.findOne({ archivedAt: null }).sort({ createdAt: 1 });
      if (next) { next.isDefault = true; await next.save(); }
    }
    res.json({ ok: true, movedTo: replacement ? replacement.label : null, orphaned, ...moved });
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
    const V = process.env.WHATSAPP_API_VERSION || 'v23.0';
    const checks = [];
    let tokenUser = null; // usuario del sistema dueño del token (GET /me)

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
        detail: `App: ${dbg.application || 'desconocida'}${dbg.app_id ? ` (ID ${dbg.app_id})` : ''}${dbg.type ? ` · tipo de token: ${dbg.type}` : ''}${
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
        // scope de mensajería. OJO: esto puede ser un admin sin restricción, pero
        // también un token sin NINGUNA WABA para mensajería — se muestra el dato
        // crudo para no interpretar de más.
        checks.push({
          ok: true,
          label: 'Cuentas de WhatsApp asignadas al token',
          detail: `Meta no reporta target_ids para el permiso de mensajería. granular_scopes crudo: ${JSON.stringify(dbg.granular_scopes || [])}`,
          fix: '',
        });
      }
    }

    // 1b) Identidad del token: QUÉ usuario del sistema lo generó. Con varios
    // usuarios/empresas de nombres parecidos, esto delata tokens del usuario
    // equivocado (los activos se asignan por usuario, no por empresa).
    try {
      const rm = await fetch(`https://graph.facebook.com/${V}/me?fields=id,name`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const mj = await rm.json().catch(() => ({}));
      if (rm.ok && mj?.id) {
        tokenUser = mj;
        checks.push({
          ok: true,
          label: 'Identidad del token',
          detail: `El token pertenece al usuario del sistema «${mj.name || '(sin nombre)'}» (ID ${mj.id}).`,
          fix: '',
        });
      }
    } catch { /* sin red: se omite */ }

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

    // 2a) Re-suscribir la app a la WABA con ESTE token (idempotente y sin efectos
    // secundarios: si ya estaba suscrita, Meta responde success). Corre ANTES del
    // chequeo de apps conectadas para que ese chequeo vea el estado ya reparado.
    // Caso real: WABA creada fuera de la app o suscrita con un token viejo.
    if (doc.businessAccountId) {
      try {
        const rsub = await fetch(
          `https://graph.facebook.com/${V}/${doc.businessAccountId}/subscribed_apps`,
          { method: 'POST', headers: { Authorization: `Bearer ${token}` } }
        );
        const sj2 = await rsub.json().catch(() => ({}));
        checks.push({
          ok: !!(rsub.ok && sj2.success !== false),
          label: 'Re-suscripción de la app a la WABA (con el token actual)',
          detail: rsub.ok
            ? `Meta aceptó la (re)suscripción: ${JSON.stringify(sj2)}.`
            : sj2?.error?.message || 'Meta rechazó la re-suscripción.',
          fix: rsub.ok
            ? ''
            : 'El token no pudo suscribir su app a esta WABA: revisa que tenga whatsapp_business_management con control total sobre ELLA.',
        });
      } catch { /* sin red: se omite */ }
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

          // Permisos EXACTOS (tasks) de cada usuario sobre ESTA WABA según Meta.
          // Es la prueba reina del #200: si el dueño del token no aparece aquí o
          // aparece sin control total, el envío se rechaza aunque pueda leer.
          if (owner.id) {
            try {
              const ru = await fetch(
                `https://graph.facebook.com/${V}/${doc.businessAccountId}/assigned_users?business=${owner.id}&fields=id,name,tasks&limit=50`,
                { headers: { Authorization: `Bearer ${token}` } }
              );
              const uj = await ru.json().catch(() => ({}));
              if (ru.ok) {
                const users = uj.data || [];
                const rows = users.map((u) => `«${u.name || u.id}» → [${(u.tasks || []).join(', ')}]`);
                const mine = tokenUser ? users.find((u) => String(u.id) === String(tokenUser.id)) : null;
                const mineTasks = mine?.tasks || [];
                const fullish = ['MANAGE', 'DEVELOP', 'FULL_CONTROL', 'MESSAGING'];
                const hasFull = mineTasks.some((t) => fullish.includes(String(t).toUpperCase()));
                checks.push({
                  ok: tokenUser ? !!mine && hasFull : true,
                  label: 'Permisos del dueño del token sobre ESTA WABA (tasks)',
                  detail: `Usuarios asignados a la WABA: ${rows.join(' · ') || '(ninguno)'}${
                    tokenUser
                      ? mine
                        ? ` — el dueño del token («${tokenUser.name}») tiene: [${mineTasks.join(', ')}].`
                        : ` — el dueño del token («${tokenUser.name}», ID ${tokenUser.id}) NO está en la lista: esta WABA no está asignada a ESE usuario del sistema.`
                      : ''
                  }`,
                  fix: tokenUser && (!mine || !hasFull)
                    ? 'Business Manager → Usuarios del sistema → selecciona EXACTAMENTE ese usuario → Asignar activos → Cuentas de WhatsApp → elige la WABA por ID (hay varias con el mismo nombre) → activa CONTROL TOTAL → regenera el token y guárdalo aquí.'
                    : '',
                });
              }
            } catch { /* sin red: se omite */ }
          }
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
 * POST /whatsapp/accounts/:id/register — registra el número en Cloud API.
 * Necesario cuando el número queda verificado pero PENDING (típico tras migrarlo
 * de WABA): Meta exige POST /{phone_id}/register con un PIN de 6 dígitos. Si el
 * número tiene verificación en dos pasos activa el PIN debe coincidir; si está
 * desactivada, este PIN queda como el nuevo (guárdalo).
 */
exports.registerWhatsappNumber = async (req, res) => {
  try {
    const doc = await WhatsappAccount.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Número no encontrado' });
    if (doc.connectionType !== 'cloud_api') {
      return res.status(400).json({ message: 'El registro aplica solo a números Cloud API.' });
    }
    if (!doc.accessToken || !doc.phoneNumberId) {
      return res.status(400).json({ message: 'Falta accessToken o phoneNumberId' });
    }
    const pin = String(req.body?.pin || '').replace(/[^\d]/g, '');
    if (pin.length !== 6) {
      return res.status(400).json({ message: 'El PIN debe tener exactamente 6 dígitos.' });
    }
    const token = decryptSecret(doc.accessToken);
    const V = process.env.WHATSAPP_API_VERSION || 'v23.0';
    const r = await fetch(`https://graph.facebook.com/${V}/${doc.phoneNumberId}/register`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false) {
      // Meta esconde la causa real en error_data.details / error_user_msg; el
      // "message" a secas suele ser un genérico tipo "Invalid parameter".
      const e = j?.error || {};
      const detail = e.error_data?.details || e.error_user_msg || '';
      const parts = [e.message || 'Meta rechazó el registro del número.'];
      if (detail) parts.push(detail);
      if (e.code) parts.push(`(código ${e.code}${e.error_subcode ? `/${e.error_subcode}` : ''})`);
      return res.status(400).json({ message: parts.join(' — '), error: e });
    }
    res.json({ success: true, message: 'Número registrado en Cloud API. Vuelve a Probar: el estado debe salir CONNECTED.' });
  } catch (err) {
    res.status(500).json({ message: 'Error al registrar el número', error: err.message });
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
    if (typeof req.body.capiWabaId === 'string') capi.whatsappBusinessAccountId = req.body.capiWabaId.trim();
    cfg.conversionsApi = capi;
    // Marketing API: token (cifrado) de Usuario del Sistema con ads_management.
    const mkt = cfg.marketingApi || {};
    if ('marketingEnabled' in req.body) mkt.enabled = Boolean(req.body.marketingEnabled);
    if (typeof req.body.marketingAccessToken === 'string' && !req.body.marketingAccessToken.startsWith('••••')) {
      mkt.accessToken = req.body.marketingAccessToken ? encryptSecret(req.body.marketingAccessToken) : '';
    }
    if (typeof req.body.marketingAdAccountId === 'string') mkt.adAccountId = req.body.marketingAdAccountId.trim();
    cfg.marketingApi = mkt;
    if ('callCenterClinic' in req.body) cfg.callCenterClinic = req.body.callCenterClinic || null;
    cfg.updatedBy = req.user._id;
    await cfg.save();
    require('../utils/callCenterClinic').clearCache();
    res.json(appConfigPayload(req, cfg));
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

/**
 * GET /whatsapp/diagnostics — chequeo de salud de TODO el canal de WhatsApp de un
 * vistazo. Reúne en una sola pantalla las causas reales de "no se envían los
 * mensajes" que hasta ahora había que reconstruir a mano desde la base:
 *
 *  1. BACKENDS VIVOS: si hay más de uno contra la misma base, se DUPLICAN los
 *     envíos y aparecen "fallidos" fantasma (el gemelo entregó el mensaje). Marca
 *     además cuál no puede descifrar los tokens (SECRETS_KEY) o corre otro commit.
 *  2. NÚMEROS: por cada número, si el token es descifrable (Cloud) o la sesión
 *     está viva (QR), y su rol (por defecto / habilitado).
 *  3. ENVÍOS FALLIDOS de las últimas 24 h agrupados por causa, con su explicación.
 *  4. ENLACES HUÉRFANOS: conversaciones apuntando a un número borrado (se pueden
 *     auto-curar con el botón del panel → POST .../diagnostics/heal).
 */
exports.whatsappDiagnostics = async (req, res) => {
  try {
    const registry = require('../utils/instanceRegistry');
    const gateway = require('../utils/whatsappGateway');
    const Message = require('../models/Message');
    const Conversation = require('../models/Conversation');

    // 1) Backends vivos + líder de jobs.
    const cluster = await registry.snapshot();

    // 2) Salud por número (los archivados son lápidas: no son números de trabajo).
    const accounts = await WhatsappAccount.find({ archivedAt: null }).sort({ isDefault: -1, createdAt: 1 });
    await Promise.all(
      accounts.map((a) => (a.connectionType === 'qr' ? qrManager.reconcileAccount(a).catch(() => {}) : null))
    );
    // Verificación EN VIVO del token de un número Cloud contra Meta (debug_token).
    // Detecta el caso más doloroso: un token CADUCADO/REVOCADO — Meta responde 190
    // y todos los envíos por ese número fallan, aunque el token se descifre bien.
    // Best-effort con timeout corto: si Meta o la red no responden, no rompe el panel.
    const V = process.env.WHATSAPP_API_VERSION || 'v23.0';
    const probeCloudToken = async (a) => {
      const token = decryptSecret(a.accessToken);
      if (!token || require('../utils/secretCrypto').isEncrypted(token)) return { state: 'undecryptable' };
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 5000);
        const r = await fetch(
          `https://graph.facebook.com/${V}/debug_token?input_token=${encodeURIComponent(token)}`,
          { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal }
        );
        clearTimeout(t);
        const j = await r.json().catch(() => ({}));
        const d = j?.data;
        if (!r.ok || !d) return { state: 'rejected' };
        const expMs = Number(d.expires_at || 0) * 1000;
        if (d.is_valid === false || (expMs > 0 && expMs < Date.now())) return { state: 'expired', expMs };
        return { state: 'valid', expMs };
      } catch {
        return { state: 'unknown' }; // sin red / timeout: no concluye
      }
    };

    const accountsHealth = await Promise.all(
      accounts.map(async (a) => {
        let health = 'ok';
        let detail = '';
        if (a.connectionType === 'cloud_api') {
          const tokenErr = gateway.cloudTokenError(a);
          if (!a.accessToken) {
            health = 'error';
            detail = 'Sin token: este número no puede enviar por Cloud API.';
          } else if (tokenErr) {
            health = 'error';
            detail = 'El token no se puede descifrar en el servidor (falta o cambió SECRETS_KEY). Vuelve a guardarlo.';
          } else if (!a.phoneNumberId) {
            health = 'error';
            detail = 'Falta el Phone Number ID.';
          } else {
            // Token descifrable: ahora comprobamos si Meta lo acepta.
            const probe = await probeCloudToken(a);
            if (probe.state === 'expired' || probe.state === 'rejected') {
              health = 'error';
              detail =
                'El token está CADUCADO o revocado (Meta lo rechaza con error 190). Genera un token de ' +
                'Usuario del Sistema (no caduca) y guárdalo en este número.';
            } else if (probe.state === 'valid') {
              detail =
                probe.expMs > 0
                  ? `Token válido, pero CADUCA el ${new Date(probe.expMs).toLocaleString('es-EC', { timeZone: 'America/Guayaquil' })}. Usa uno de Usuario del Sistema para que no expire.`
                  : 'Token válido y sin caducidad (Usuario del Sistema). ✔';
            } else {
              detail = 'Token descifrable. No se pudo verificar contra Meta ahora (sin red o timeout); usa "Probar".';
            }
          }
        } else {
          // QR: la verdad es la sesión VIVA en memoria, no solo el estado guardado.
          const snap = qrManager.getLiveSnapshot(a._id);
          const liveStatus = snap?.status || a.status;
          // Rastro de la última caída: sin esto, "se volvió a desconectar" no
          // dejaba ninguna pista de POR QUÉ (ni de cuándo).
          const caida = a.lastDisconnectAt
            ? ` Última caída: ${new Date(a.lastDisconnectAt).toLocaleString('es-EC', { timeZone: 'America/Guayaquil' })}` +
              `${a.lastDisconnectReason ? ` — ${a.lastDisconnectReason}.` : '.'}`
            : '';
          // Última RECEPCIÓN: "conectado" no significa "recibiendo". Una sesión
          // zombi (envía pero no recibe) se delata aquí — es el único dato que
          // permite verlo de un vistazo sin abrir los chats.
          const recibido = a.lastInboundAt
            ? ` Último mensaje recibido: ${new Date(a.lastInboundAt).toLocaleString('es-EC', { timeZone: 'America/Guayaquil' })}` +
              ` (hace ${Math.round((Date.now() - new Date(a.lastInboundAt)) / 60000)} min).`
            : ' Aún no ha recibido ningún mensaje.';
          if (liveStatus === 'connected') detail = `Sesión de WhatsApp Web conectada.${recibido}${caida}`;
          else if (['connecting', 'syncing', 'qr_pending'].includes(liveStatus)) {
            health = 'warn';
            detail =
              'La sesión se está sincronizando o espera el escaneo del QR. Mientras tanto, los envíos por este número pueden fallar con "QR no conectado".' +
              caida;
          } else {
            health = 'error';
            detail = a.lastDisconnectNeedsQr
              ? `Sesión cerrada desde el teléfono: hay que pulsar "Conectar" y escanear el QR.${caida}`
              : `Sesión de WhatsApp Web caída; el servidor la está reconectando solo.${caida}`;
          }
        }
        if (!a.enabled) {
          health = 'warn';
          detail = 'Número deshabilitado: no se usa para enviar.';
        }
        return {
          _id: a._id,
          label: a.label,
          connectionType: a.connectionType,
          enabled: a.enabled,
          isDefault: a.isDefault,
          status: a.status,
          displayPhone: a.displayPhone || a.connectedPhone || '',
          qualityRating: a.qualityRating,
          health,
          detail,
        };
      })
    );

    // 3) Fallidos de las últimas 24 h por causa.
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const failsRaw = await Message.aggregate([
      { $match: { direction: 'out', deliveryStatus: 'failed', createdAt: { $gte: since } } },
      { $group: { _id: '$errorCode', n: { $sum: 1 }, sample: { $first: '$errorMessage' }, last: { $max: '$createdAt' } } },
      { $sort: { n: -1 } },
    ]);
    const FAIL_HINTS = {
      token_undecryptable: 'Un backend no tiene la SECRETS_KEY. Si ves 2 backends arriba, mata el de sobra; si no, vuelve a guardar el token.',
      qr_not_connected: 'La sesión de WhatsApp Web estaba caída al enviar. Reconecta el número QR (o era un segundo backend sin la sesión).',
      190: 'Token de Meta caducado o revocado. Genera uno de Usuario del Sistema (no caduca) y guárdalo.',
      200: 'El token no tiene permiso sobre esta WABA. Usa "Probar" para el diagnóstico exacto.',
      131053: 'Meta rechazó la subida de la media. Revisa formato/tamaño del archivo.',
      131026: 'Mensaje no entregable (el número no está en WhatsApp o bloqueó al negocio).',
      out_of_window: 'Se intentó texto libre fuera de la ventana de 24 h. Usa una plantilla aprobada.',
    };
    const failures = failsRaw.map((f) => ({
      code: f._id || '(sin código)',
      count: f.n,
      last: f.last,
      sample: String(f.sample || '').slice(0, 160),
      hint: FAIL_HINTS[f._id] || '',
    }));

    // 4b) MEDIA ENTRANTE de los últimos 7 días por número. Es la forma de ver si
    // las fotos/audios que mandan los pacientes están llegando de verdad: un
    // número con mucho tráfico y CERO media significa que se están perdiendo
    // (le pasó al número QR: 1600 mensajes recibidos y ni una sola foto).
    const since7 = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const mediaRaw = await Message.aggregate([
      { $match: { direction: 'in', createdAt: { $gte: since7 } } },
      {
        $group: {
          _id: '$whatsappAccount',
          mensajes: { $sum: 1 },
          conMedia: { $sum: { $cond: [{ $ifNull: ['$mediaType', false] }, 1, 0] } },
          mediaOk: {
            $sum: {
              $cond: [
                { $and: [{ $ifNull: ['$mediaType', false] }, { $gt: [{ $strLenCP: { $ifNull: ['$mediaUrl', ''] } }, 0] }] },
                1,
                0,
              ],
            },
          },
          ultimaMedia: {
            $max: { $cond: [{ $ifNull: ['$mediaType', false] }, '$createdAt', null] },
          },
        },
      },
    ]);
    const incomingMedia = accounts.map((a) => {
      const r = mediaRaw.find((x) => String(x._id) === String(a._id)) || {};
      const received = r.mensajes || 0;
      const withMedia = r.conMedia || 0;
      const ok = r.mediaOk || 0;
      let hint = '';
      if (withMedia && ok < withMedia) {
        hint = `${withMedia - ok} archivo(s) llegaron pero no se pudieron descargar: se ven en el chat como "no disponible".`;
      } else if (!withMedia && received >= 50) {
        hint =
          'Este número no ha recibido NI UN archivo en 7 días con mucho tráfico de texto: revisa el log del servidor ' +
          '([whatsapp-qr media]) porque puede que la sesión no esté logrando descargarlos.';
      }
      return {
        _id: a._id,
        label: a.label,
        connectionType: a.connectionType,
        received,
        withMedia,
        ok,
        last: r.ultimaMedia || null,
        hint,
      };
    });

    // 4) Conversaciones enlazadas a un número que ya no existe. Cuenta también las
    // que solo tienen ahí la ventana de 24h (`lastInboundAccount`): son las que se
    // quedan sin poder mandar texto libre hasta que se diga quién hereda el chat.
    // Un chat que recuerde el id de un documento ANTERIOR del mismo número (se
    // borró y se volvió a conectar) NO está huérfano: `previousIds` dice que ese
    // id sigue siendo este número, y la resolución del envío lo sabe.
    const ids = new Set(accounts.flatMap((a) => [String(a._id), ...(a.previousIds || []).map(String)]));
    const linked = await Conversation.find({
      $or: [{ whatsappAccount: { $ne: null } }, { lastInboundAccount: { $ne: null } }],
    })
      .select('whatsappAccount lastInboundAccount')
      .lean();
    const orphanLinks = linked.filter(
      (c) =>
        (c.whatsappAccount && !ids.has(String(c.whatsappAccount))) ||
        (c.lastInboundAccount && !ids.has(String(c.lastInboundAccount)))
    ).length;

    res.json({
      cluster,
      accounts: accountsHealth,
      failures,
      incomingMedia,
      orphanLinks,
      secretsKey: registry.hasSecretsKey(),
      // Estado del tiempo real: cuántos sockets están conectados a la bandeja. Si es
      // 0 con agentes usando el chat, el tiempo real no llega (revisar el socket).
      realtime: require('../realtime').getRealtimeStats(),
      generatedAt: new Date(),
    });
  } catch (err) {
    res.status(500).json({ message: 'Error en el diagnóstico', error: err.message });
  }
};

/**
 * POST /whatsapp/diagnostics/heal — traspasa a `accountId` las conversaciones
 * que apuntan a un número BORRADO (lo normal: el mismo teléfono que se volvió a
 * conectar y quedó guardado como un número nuevo).
 *
 * EL DESTINO ES OBLIGATORIO. Antes esto solo sabía poner `whatsappAccount = null`
 * y se vendía como "limpiar", pero no arreglaba nada: un chat sin número enlazado
 * cae al número POR DEFECTO, que puede ser otro teléfono al que el contacto nunca
 * escribió — exactamente lo que dejó 4.585 chats respondiéndose por el número de
 * la API y a Meta rechazándolos con 131047. Un chat tiene que quedarse con el
 * número por el que de verdad se le va a responder.
 */
exports.healWhatsappLinks = async (req, res) => {
  try {
    const Conversation = require('../models/Conversation');
    const Message = require('../models/Message');
    // Ids VIVOS: los de los números en uso y los de los documentos anteriores que
    // ya absorbieron (`previousIds`) — un chat que recuerde uno de esos NO está
    // huérfano, se resuelve solo. Los archivados sí cuentan como rotos: su
    // teléfono no ha vuelto, y hasta que vuelva esos chats no tienen salida.
    const accounts = await WhatsappAccount.find({ archivedAt: null }).select('_id previousIds').lean();
    const ids = accounts.flatMap((a) => [a._id, ...(a.previousIds || [])]);

    const targetId = req.body?.accountId || null;
    if (!targetId) {
      return res.status(400).json({ message: 'Elige a qué número pasan esas conversaciones' });
    }
    const target = await WhatsappAccount.findOne({ _id: targetId, enabled: true, archivedAt: null });
    if (!target) return res.status(400).json({ message: 'Número de destino no válido o deshabilitado' });

    const muerto = { $ne: null, $nin: ids };
    const [convs, inbound, msgs] = await Promise.all([
      Conversation.updateMany({ whatsappAccount: muerto }, { $set: { whatsappAccount: target._id } }),
      Conversation.updateMany({ lastInboundAccount: muerto }, { $set: { lastInboundAccount: target._id } }),
      Message.updateMany({ whatsappAccount: muerto }, { $set: { whatsappAccount: target._id } }),
    ]);

    res.json({
      ok: true,
      healed: convs.modifiedCount ?? convs.nModified ?? 0,
      windows: inbound.modifiedCount ?? inbound.nModified ?? 0,
      messages: msgs.modifiedCount ?? msgs.nModified ?? 0,
      movedTo: target.label,
    });
  } catch (err) {
    res.status(500).json({ message: 'Error al reparar enlaces', error: err.message });
  }
};
