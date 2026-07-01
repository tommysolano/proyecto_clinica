const MessageTemplate = require('../models/MessageTemplate');
const ChatGalleryImage = require('../models/ChatGalleryImage');

const API_VERSION = process.env.WHATSAPP_API_VERSION || 'v20.0';

/**
 * Sube una imagen de cabecera de plantilla (data URL base64). La almacena en
 * ChatGalleryImage (reutiliza el storage de la galería) y devuelve su URL
 * pública autoalojada — necesaria porque Meta no acepta data URLs en plantillas.
 */
exports.uploadHeaderImage = async (req, res) => {
  try {
    const { dataUrl, name } = req.body;
    if (!dataUrl || !/^data:image\/(png|jpe?g|webp);base64,/.test(dataUrl)) {
      return res.status(400).json({ message: 'Imagen inválida (usa PNG/JPG/WEBP)' });
    }
    if (dataUrl.length > 2_500_000) {
      return res.status(400).json({ message: 'Imagen demasiado grande (máx ~1.8MB)' });
    }
    const mimeMatch = dataUrl.match(/^data:(image\/[a-zA-Z0-9+]+);/);
    const img = await ChatGalleryImage.create({
      clinic: req.clinicId,
      name: name || `tpl_${Date.now()}`,
      dataUrl,
      mimeType: mimeMatch ? mimeMatch[1] : 'image/png',
      size: dataUrl.length,
      createdBy: req.user._id,
    });
    // PUBLIC_API_URL ya incluye "/api" por convención; normalizamos para no
    // duplicarlo (…/api/api/… daba 404) y devolvemos siempre una URL absoluta,
    // necesaria porque Meta descarga esta imagen desde fuera.
    let base = process.env.PUBLIC_API_URL || `${req.protocol}://${req.get('host')}/api`;
    base = base.replace(/\/+$/, '').replace(/\/api$/, '');
    const url = `${base}/api/public/media/${img._id}`;
    res.status(201).json({ id: img._id, url });
  } catch (err) {
    res.status(500).json({ message: 'Error al subir imagen', error: err.message });
  }
};

exports.list = async (req, res) => {
  try {
    const filter = { clinic: req.clinicId };
    if (req.query.channel) filter.channel = req.query.channel;
    if (req.query.status) filter.status = req.query.status;
    const list = await MessageTemplate.find(filter).sort({ updatedAt: -1 });
    res.json(list);
  } catch (err) {
    res.status(500).json({ message: 'Error al listar plantillas', error: err.message });
  }
};

exports.get = async (req, res) => {
  try {
    const tpl = await MessageTemplate.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!tpl) return res.status(404).json({ message: 'Plantilla no encontrada' });
    res.json(tpl);
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

// Detecta las variables {{...}} usadas en el cuerpo para documentarlas.
function extractVariables(body = '') {
  const found = new Map();
  const re = /\{\{\s*([\w]+)\s*\}\}/g;
  let m;
  while ((m = re.exec(body))) {
    if (!found.has(m[1])) found.set(m[1], { key: m[1], example: '' });
  }
  return [...found.values()];
}

exports.create = async (req, res) => {
  try {
    const { name, body } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ message: 'El nombre es requerido' });
    }
    if (!body || !String(body).trim()) {
      return res.status(400).json({ message: 'El cuerpo es requerido' });
    }
    const variables = req.body.variables?.length ? req.body.variables : extractVariables(body);
    const channel = req.body.channel || 'whatsapp';
    const tpl = await MessageTemplate.create({
      clinic: req.clinicId,
      channel,
      name: String(name).trim().toLowerCase().replace(/[^a-z0-9_]/g, '_'),
      language: req.body.language || 'es',
      category: req.body.category || 'MARKETING',
      subject: req.body.subject || '',
      headerType: req.body.headerType || 'none',
      headerText: req.body.headerText || '',
      headerMediaUrl: req.body.headerMediaUrl || '',
      body,
      footer: req.body.footer || '',
      buttons: req.body.buttons || [],
      variables,
      // El email no pasa por aprobación de Meta: queda listo para usar.
      status: channel === 'email' ? 'approved' : 'draft',
      createdBy: req.user._id,
    });
    res.status(201).json(tpl);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: 'Ya existe una plantilla con ese nombre y canal' });
    }
    res.status(500).json({ message: 'Error al crear plantilla', error: err.message });
  }
};

exports.update = async (req, res) => {
  try {
    const update = { ...req.body };
    delete update.clinic;
    delete update._id;
    delete update.status; // el estado lo gobierna la sincronización con Meta
    delete update.metaTemplateId;
    if (update.body) update.variables = req.body.variables?.length ? req.body.variables : extractVariables(update.body);
    const tpl = await MessageTemplate.findOneAndUpdate(
      { _id: req.params.id, clinic: req.clinicId },
      update,
      { new: true, runValidators: true }
    );
    if (!tpl) return res.status(404).json({ message: 'Plantilla no encontrada' });
    res.json(tpl);
  } catch (err) {
    res.status(500).json({ message: 'Error al actualizar plantilla', error: err.message });
  }
};

exports.remove = async (req, res) => {
  try {
    const tpl = await MessageTemplate.findOneAndDelete({ _id: req.params.id, clinic: req.clinicId });
    if (!tpl) return res.status(404).json({ message: 'Plantilla no encontrada' });
    res.json({ message: 'Plantilla eliminada' });
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

const META_STATUS_MAP = {
  APPROVED: 'approved',
  PENDING: 'pending',
  IN_APPEAL: 'pending',
  REJECTED: 'rejected',
  DISABLED: 'disabled',
  PAUSED: 'disabled',
};

const Notification = require('../models/Notification');
const { emitToClinic } = require('../realtime');

/**
 * Registra una alerta (Notification) por cambio de categoría/estado de plantilla
 * y la emite por socket a la clínica.
 */
async function raiseTemplateAlert(clinicId, { type, severity, title, body, meta }) {
  const notif = await Notification.create({ clinic: clinicId, type, severity, title, body, meta });
  try {
    emitToClinic(clinicId, 'notification:new', notif);
  } catch {
    /* realtime opcional */
  }
  return notif;
}

/**
 * Dirección del cambio de costo al recategorizar. MARKETING es la categoría más
 * cara; UTILITY/AUTHENTICATION son más baratas. Pasar a MARKETING => sube el costo.
 */
function categoryCostDirection(from, to) {
  if (to === 'MARKETING' && from && from !== 'MARKETING') return 'up';
  if (from === 'MARKETING' && to && to !== 'MARKETING') return 'down';
  return 'flat';
}

/**
 * Alerta especializada de cambio de categoría con aviso de impacto en costo.
 * Si Meta recategoriza a MARKETING, sube de severidad (error) porque encarece
 * cada mensaje. `atCreation` distingue la recategorización al registrar la plantilla.
 */
async function raiseCategoryChangeAlert(clinicId, name, from, to, { atCreation = false } = {}) {
  const dir = categoryCostDirection(from, to);
  const costMsg =
    dir === 'up'
      ? ' ⚠️ Esto INCREMENTA el costo por mensaje (Marketing es más caro que Utility/Authentication).'
      : dir === 'down'
      ? ' Esto REDUCE el costo por mensaje.'
      : '';
  return raiseTemplateAlert(clinicId, {
    type: 'template_category_changed',
    severity: dir === 'up' ? 'error' : 'warning',
    title: atCreation
      ? `Meta categorizó la plantilla "${name}" como ${to}`
      : `Plantilla "${name}" cambió de categoría a ${to}`,
    body: atCreation
      ? `Al registrarla, Meta la clasificó como ${to} (tú pediste ${from || '—'}).${costMsg}`
      : `Meta cambió la categoría de ${from} a ${to}.${costMsg}`,
    meta: { template: name, from, to, atCreation, costDirection: dir },
  });
}

/**
 * Aplica el patch de Meta a una plantilla existente o la crea. Si cambia la
 * categoría o el estado, levanta una alerta. Devuelve { action, changed }.
 * PURO respecto a Meta: recibe el objeto `mt` ya descargado.
 */
async function applyMetaTemplate(clinicId, mt, createdBy) {
  const status = META_STATUS_MAP[mt.status] || 'pending';
  const existing = await MessageTemplate.findOne({ clinic: clinicId, channel: 'whatsapp', name: mt.name });
  const bodyComponent = (mt.components || []).find((c) => c.type === 'BODY');
  const newCategory = mt.category || 'MARKETING';
  const patch = {
    status,
    metaTemplateId: mt.id || '',
    language: mt.language || 'es',
    category: newCategory,
    syncedAt: new Date(),
    rejectionReason: status === 'rejected' ? mt.rejected_reason || '' : '',
  };

  if (!existing) {
    await MessageTemplate.create({
      clinic: clinicId,
      channel: 'whatsapp',
      name: mt.name,
      body: bodyComponent?.text || mt.name,
      createdBy: createdBy || null,
      ...patch,
    });
    return { action: 'imported', changed: false };
  }

  const prevCategory = existing.category;
  const prevStatus = existing.status;
  Object.assign(existing, patch);
  if (bodyComponent?.text && !existing.body) existing.body = bodyComponent.text;
  await existing.save();

  let changed = false;
  if (prevCategory && newCategory && prevCategory !== newCategory) {
    changed = true;
    await raiseCategoryChangeAlert(clinicId, mt.name, prevCategory, newCategory);
  }
  if (prevStatus !== status && (status === 'rejected' || status === 'disabled')) {
    changed = true;
    await raiseTemplateAlert(clinicId, {
      type: 'template_status_changed',
      severity: status === 'rejected' ? 'error' : 'warning',
      title: `Plantilla "${mt.name}" ahora está ${status === 'rejected' ? 'RECHAZADA' : 'DESHABILITADA'}`,
      body: patch.rejectionReason || 'Meta cambió el estado de la plantilla.',
      meta: { template: mt.name, from: prevStatus, to: status },
    });
  }
  return { action: 'updated', changed };
}

/**
 * Sincroniza las plantillas de WhatsApp de una clínica con Meta. Detecta cambios
 * de categoría/estado y levanta alertas. Reutilizable por el endpoint manual y
 * por el job periódico. Devuelve un resumen.
 */
async function syncTemplatesFromMeta(clinicId, createdBy = null) {
  // Las plantillas viven en el WABA del número Cloud API por defecto (config global).
  const gateway = require('../utils/whatsappGateway');
  const account = await gateway.getDefaultCloudAccount();
  if (!account?.accessToken || !account?.businessAccountId) {
    return { ok: false, reason: 'not_configured' };
  }
  const accessToken = require('../utils/secretCrypto').decryptSecret(account.accessToken);
  const url = `https://graph.facebook.com/${API_VERSION}/${account.businessAccountId}/message_templates?fields=name,status,category,language,components,rejected_reason,id&limit=200&access_token=${accessToken}`;
  const r = await fetch(url);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    return { ok: false, reason: 'meta_error', error: data?.error?.message || `HTTP ${r.status}` };
  }
  const metaTemplates = Array.isArray(data.data) ? data.data : [];
  let updated = 0;
  let imported = 0;
  let alerts = 0;
  for (const mt of metaTemplates) {
    // eslint-disable-next-line no-await-in-loop
    const res = await applyMetaTemplate(clinicId, mt, createdBy);
    if (res.action === 'imported') imported++;
    else updated++;
    if (res.changed) alerts++;
  }
  return { ok: true, synced: metaTemplates.length, updated, imported, alerts };
}

/**
 * Job: sincroniza las plantillas de TODAS las clínicas con WhatsApp configurado.
 * Lo invoca un setInterval en index.js.
 */
async function syncAllClinicsTemplates() {
  // WABA global: se sincroniza una sola vez, almacenando las plantillas bajo la
  // clínica sede del call center.
  const gateway = require('../utils/whatsappGateway');
  const account = await gateway.getDefaultCloudAccount();
  if (!account) return { clinics: 0, alerts: 0 };
  const CallCenterWhatsappConfig = require('../models/CallCenterWhatsappConfig');
  const singleton = await CallCenterWhatsappConfig.getSingleton();
  const clinicId = singleton.callCenterClinic;
  if (!clinicId) return { clinics: 0, alerts: 0 };
  const r = await syncTemplatesFromMeta(clinicId).catch(() => ({ ok: false }));
  return { clinics: 1, alerts: r.ok ? r.alerts || 0 : 0 };
}

/**
 * Endpoint manual: sincroniza el estado de las plantillas de WhatsApp con Meta.
 */
exports.syncWhatsapp = async (req, res) => {
  try {
    const result = await syncTemplatesFromMeta(req.clinicId, req.user._id);
    if (!result.ok) {
      if (result.reason === 'not_configured') {
        return res.status(400).json({ message: 'Falta businessAccountId / accessToken de WhatsApp para sincronizar con Meta' });
      }
      return res.status(502).json({ message: 'Error al consultar plantillas en Meta', error: result.error });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: 'Error al sincronizar con Meta', error: err.message });
  }
};

// ─────────── Alertas (Notifications de plantillas) ───────────
exports.listAlerts = async (req, res) => {
  try {
    const filter = { clinic: req.clinicId, type: { $in: ['template_category_changed', 'template_status_changed'] } };
    if (req.query.unread === 'true') filter.read = false;
    const list = await Notification.find(filter).sort({ createdAt: -1 }).limit(100);
    res.json(list);
  } catch (err) {
    res.status(500).json({ message: 'Error al listar alertas', error: err.message });
  }
};

exports.markAlertRead = async (req, res) => {
  try {
    if (req.params.id === 'all') {
      await Notification.updateMany({ clinic: req.clinicId, read: false }, { read: true, readAt: new Date() });
      return res.json({ message: 'Todas marcadas como leídas' });
    }
    const n = await Notification.findOneAndUpdate(
      { _id: req.params.id, clinic: req.clinicId },
      { read: true, readAt: new Date() },
      { new: true }
    );
    if (!n) return res.status(404).json({ message: 'No encontrada' });
    res.json(n);
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

/**
 * Procesa un webhook de plantilla de Meta (cambio instantáneo de estado/categoría).
 * field: 'message_template_status_update' | 'template_category_update'.
 * Devuelve true si aplicó algún cambio.
 */
async function handleTemplateWebhook(clinicId, field, value = {}) {
  const name = value.message_template_name || value.name;
  if (!name) return false;
  const tpl = await MessageTemplate.findOne({ clinic: clinicId, channel: 'whatsapp', name });
  if (!tpl) return false;

  // Cambio de categoría
  const newCategory = value.new_category || value.correct_category;
  if (newCategory && newCategory !== tpl.category) {
    const from = tpl.category;
    tpl.category = newCategory;
    tpl.syncedAt = new Date();
    await tpl.save();
    await raiseCategoryChangeAlert(clinicId, name, from, newCategory);
    return true;
  }

  // Cambio de estado (event: APPROVED/REJECTED/DISABLED/PAUSED/PENDING)
  if (field === 'message_template_status_update' && value.event) {
    const status = META_STATUS_MAP[value.event] || 'pending';
    if (status !== tpl.status) {
      const from = tpl.status;
      tpl.status = status;
      tpl.rejectionReason = status === 'rejected' ? value.reason || '' : '';
      tpl.syncedAt = new Date();
      await tpl.save();
      if (status === 'rejected' || status === 'disabled') {
        await raiseTemplateAlert(clinicId, {
          type: 'template_status_changed',
          severity: status === 'rejected' ? 'error' : 'warning',
          title: `Plantilla "${name}" ahora está ${status === 'rejected' ? 'RECHAZADA' : 'DESHABILITADA'}`,
          body: tpl.rejectionReason || 'Meta cambió el estado de la plantilla.',
          meta: { template: name, from, to: status },
        });
      }
      return true;
    }
  }
  return false;
}

// ═══════════ Envío de plantillas a Meta para aprobación ═══════════
//
// Meta exige placeholders POSICIONALES ({{1}}, {{2}}…). Nuestras plantillas pueden
// usar variables nombradas ({{firstName}}) o numeradas: las convertimos a numeradas
// en orden de aparición y construimos los `example` que Meta requiere.

/**
 * Convierte un texto con variables {{x}} a placeholders numerados {{1}},{{2}}…
 * Devuelve el texto convertido, los ejemplos (en orden) y cuántas variables hay.
 */
function toNumberedText(text, variables = []) {
  const order = [];
  const seen = new Map();
  const numbered = String(text || '').replace(/\{\{\s*([\w]+)\s*\}\}/g, (_m, key) => {
    if (!seen.has(key)) {
      seen.set(key, seen.size + 1);
      order.push(key);
    }
    return `{{${seen.get(key)}}}`;
  });
  const exMap = new Map((variables || []).map((v) => [v.key, v.example]));
  const examples = order.map((key, i) => {
    const ex = exMap.get(key);
    return ex && String(ex).trim() ? String(ex) : `ejemplo${i + 1}`;
  });
  return { numbered, examples, count: order.length };
}

/**
 * Construye el array `components` que pide la Graph API a partir de una plantilla
 * local (cabecera, cuerpo, pie y botones).
 */
function buildMetaComponents(tpl) {
  const components = [];

  // HEADER
  if (tpl.headerType === 'text' && tpl.headerText) {
    const { numbered, examples, count } = toNumberedText(tpl.headerText, tpl.variables);
    const header = { type: 'HEADER', format: 'TEXT', text: numbered };
    if (count > 0) header.example = { header_text: examples };
    components.push(header);
  } else if (['image', 'document', 'video'].includes(tpl.headerType) && tpl.headerMediaUrl) {
    // Meta pide un "handle" del media; aceptamos pasar la URL pública autoalojada.
    components.push({
      type: 'HEADER',
      format: tpl.headerType.toUpperCase(),
      example: { header_handle: [tpl.headerMediaUrl] },
    });
  }

  // BODY (obligatorio)
  const { numbered, examples, count } = toNumberedText(tpl.body, tpl.variables);
  const body = { type: 'BODY', text: numbered };
  if (count > 0) body.example = { body_text: [examples] };
  components.push(body);

  // FOOTER
  if (tpl.footer) components.push({ type: 'FOOTER', text: tpl.footer });

  // BUTTONS
  if (Array.isArray(tpl.buttons) && tpl.buttons.length) {
    const buttons = tpl.buttons
      .filter((b) => b && b.text)
      .map((b) => {
        if (b.type === 'url') return { type: 'URL', text: b.text, url: b.url || '' };
        if (b.type === 'phone') return { type: 'PHONE_NUMBER', text: b.text, phone_number: b.url || '' };
        return { type: 'QUICK_REPLY', text: b.text };
      });
    if (buttons.length) components.push({ type: 'BUTTONS', buttons });
  }

  return components;
}

/**
 * Registra (POST) la plantilla en el WABA del número Cloud API por defecto.
 * Devuelve { ok, data } o { ok:false, reason, error }.
 */
async function submitTemplateToMeta(tpl) {
  const gateway = require('../utils/whatsappGateway');
  const account = await gateway.getDefaultCloudAccount();
  if (!account?.accessToken || !account?.businessAccountId) {
    return { ok: false, reason: 'not_configured' };
  }
  const accessToken = require('../utils/secretCrypto').decryptSecret(account.accessToken);
  const url = `https://graph.facebook.com/${API_VERSION}/${account.businessAccountId}/message_templates`;
  const payload = {
    name: tpl.name,
    language: tpl.language || 'es',
    category: tpl.category || 'MARKETING',
    components: buildMetaComponents(tpl),
  };
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return {
        ok: false,
        reason: 'meta_error',
        error: data?.error?.error_user_msg || data?.error?.message || `HTTP ${r.status}`,
        data,
      };
    }
    return { ok: true, data };
  } catch (err) {
    return { ok: false, reason: 'network', error: err.message };
  }
}

/**
 * POST /api/message-templates/:id/submit
 * Envía la plantilla local a Meta para revisión. Tras enviarla queda en 'pending'
 * y el resto del ciclo (aprobación/rechazo/recategorización) lo gobiernan el
 * webhook y la sincronización periódica.
 */
exports.submit = async (req, res) => {
  try {
    const tpl = await MessageTemplate.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!tpl) return res.status(404).json({ message: 'Plantilla no encontrada' });
    if (tpl.channel !== 'whatsapp') {
      return res.status(400).json({ message: 'Solo las plantillas de WhatsApp se envían a Meta' });
    }
    if (tpl.status === 'pending' || tpl.status === 'approved') {
      return res
        .status(400)
        .json({ message: `La plantilla ya está ${tpl.status === 'approved' ? 'aprobada' : 'en revisión'} en Meta` });
    }

    const result = await submitTemplateToMeta(tpl);
    if (!result.ok) {
      if (result.reason === 'not_configured') {
        return res.status(400).json({
          message: 'Falta el número Cloud API por defecto (WABA ID + Access Token) para enviar a Meta',
        });
      }
      return res.status(502).json({ message: result.error || 'Meta rechazó la solicitud', detail: result.data?.error });
    }

    const created = result.data || {};
    tpl.metaTemplateId = created.id || tpl.metaTemplateId;
    tpl.status = META_STATUS_MAP[created.status] || 'pending';
    tpl.rejectionReason = '';
    tpl.syncedAt = new Date();
    // Meta puede recategorizar al registrar (impacta en el costo): avisar si difiere.
    if (created.category && created.category !== tpl.category) {
      const from = tpl.category;
      tpl.category = created.category;
      await raiseCategoryChangeAlert(req.clinicId, tpl.name, from, created.category, { atCreation: true });
    }
    await tpl.save();
    res.json(tpl);
  } catch (err) {
    res.status(500).json({ message: 'Error al enviar a Meta', error: err.message });
  }
};

exports.applyMetaTemplate = applyMetaTemplate;
exports.syncTemplatesFromMeta = syncTemplatesFromMeta;
exports.syncAllClinicsTemplates = syncAllClinicsTemplates;
exports.handleTemplateWebhook = handleTemplateWebhook;
exports.submitTemplateToMeta = submitTemplateToMeta;
exports.buildMetaComponents = buildMetaComponents;
