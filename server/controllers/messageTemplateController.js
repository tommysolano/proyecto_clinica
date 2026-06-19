const MessageTemplate = require('../models/MessageTemplate');
const CallCenterConfig = require('../models/CallCenterConfig');
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
    const base = process.env.PUBLIC_API_URL || '';
    const url = base ? `${base}/api/public/media/${img._id}` : `/api/public/media/${img._id}`;
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
    await raiseTemplateAlert(clinicId, {
      type: 'template_category_changed',
      severity: 'warning',
      title: `Plantilla "${mt.name}" cambió de categoría`,
      body: `Meta cambió la categoría de ${prevCategory} a ${newCategory}. Revisa el costo/uso de la plantilla.`,
      meta: { template: mt.name, from: prevCategory, to: newCategory },
    });
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
  const cfg = await CallCenterConfig.findOne({ clinic: clinicId }).lean();
  const wa = cfg?.whatsapp;
  if (!wa?.accessToken || !wa?.businessAccountId) {
    return { ok: false, reason: 'not_configured' };
  }
  const accessToken = require('../utils/secretCrypto').decryptSecret(wa.accessToken);
  const url = `https://graph.facebook.com/${API_VERSION}/${wa.businessAccountId}/message_templates?fields=name,status,category,language,components,rejected_reason,id&limit=200&access_token=${accessToken}`;
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
  const configs = await CallCenterConfig.find({
    'whatsapp.businessAccountId': { $ne: '' },
    'whatsapp.accessToken': { $ne: '' },
  }).select('clinic').lean();
  let total = 0;
  for (const cfg of configs) {
    // eslint-disable-next-line no-await-in-loop
    const r = await syncTemplatesFromMeta(cfg.clinic).catch(() => ({ ok: false }));
    if (r.ok) total += r.alerts || 0;
  }
  return { clinics: configs.length, alerts: total };
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
    await raiseTemplateAlert(clinicId, {
      type: 'template_category_changed',
      severity: 'warning',
      title: `Plantilla "${name}" cambió de categoría`,
      body: `Meta cambió la categoría de ${from} a ${newCategory}. Revisa el costo/uso de la plantilla.`,
      meta: { template: name, from, to: newCategory },
    });
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

exports.applyMetaTemplate = applyMetaTemplate;
exports.syncTemplatesFromMeta = syncTemplatesFromMeta;
exports.syncAllClinicsTemplates = syncAllClinicsTemplates;
exports.handleTemplateWebhook = handleTemplateWebhook;
