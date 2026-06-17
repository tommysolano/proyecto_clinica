const MessageTemplate = require('../models/MessageTemplate');
const CallCenterConfig = require('../models/CallCenterConfig');

const API_VERSION = process.env.WHATSAPP_API_VERSION || 'v20.0';

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
    const tpl = await MessageTemplate.create({
      clinic: req.clinicId,
      channel: req.body.channel || 'whatsapp',
      name: String(name).trim().toLowerCase().replace(/[^a-z0-9_]/g, '_'),
      language: req.body.language || 'es',
      category: req.body.category || 'MARKETING',
      subject: req.body.subject || '',
      headerType: req.body.headerType || 'none',
      headerText: req.body.headerText || '',
      body,
      footer: req.body.footer || '',
      buttons: req.body.buttons || [],
      variables,
      status: 'draft',
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

/**
 * Sincroniza el estado de las plantillas de WhatsApp con Meta.
 * Lee las plantillas del WABA y actualiza `status`/`metaTemplateId` por nombre.
 * Requiere businessAccountId + accessToken en CallCenterConfig.whatsapp.
 */
exports.syncWhatsapp = async (req, res) => {
  try {
    const cfg = await CallCenterConfig.findOne({ clinic: req.clinicId }).lean();
    const wa = cfg?.whatsapp;
    if (!wa?.accessToken || !wa?.businessAccountId) {
      return res.status(400).json({
        message: 'Falta businessAccountId / accessToken de WhatsApp para sincronizar con Meta',
      });
    }
    const url = `https://graph.facebook.com/${API_VERSION}/${wa.businessAccountId}/message_templates?limit=200&access_token=${wa.accessToken}`;
    const r = await fetch(url);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(502).json({
        message: 'Error al consultar plantillas en Meta',
        error: data?.error?.message || `HTTP ${r.status}`,
      });
    }

    const metaTemplates = Array.isArray(data.data) ? data.data : [];
    let updated = 0;
    let imported = 0;
    for (const mt of metaTemplates) {
      const status = META_STATUS_MAP[mt.status] || 'pending';
      const existing = await MessageTemplate.findOne({
        clinic: req.clinicId,
        channel: 'whatsapp',
        name: mt.name,
      });
      const bodyComponent = (mt.components || []).find((c) => c.type === 'BODY');
      const patch = {
        status,
        metaTemplateId: mt.id || '',
        language: mt.language || 'es',
        category: mt.category || 'MARKETING',
        syncedAt: new Date(),
        rejectionReason: status === 'rejected' ? mt.rejected_reason || '' : '',
      };
      if (existing) {
        Object.assign(existing, patch);
        if (bodyComponent?.text && !existing.body) existing.body = bodyComponent.text;
        await existing.save();
        updated++;
      } else {
        await MessageTemplate.create({
          clinic: req.clinicId,
          channel: 'whatsapp',
          name: mt.name,
          body: bodyComponent?.text || mt.name,
          createdBy: req.user._id,
          ...patch,
        });
        imported++;
      }
    }
    res.json({ synced: metaTemplates.length, updated, imported });
  } catch (err) {
    res.status(500).json({ message: 'Error al sincronizar con Meta', error: err.message });
  }
};
