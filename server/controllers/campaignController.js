const mongoose = require('mongoose');
const Campaign = require('../models/Campaign');
const ScheduledMessage = require('../models/ScheduledMessage');
const MessageTemplate = require('../models/MessageTemplate');
const Segment = require('../models/Segment');
const messaging = require('../utils/messaging');
const { resolveSegment } = require('../utils/segmentResolver');

const BATCH_SIZE = 50; // mensajes por tick del job (respeta rate limit de Meta)

function firstNameOf(patient) {
  const full = patient?.name || '';
  return (patient?.firstName || full.split(' ')[0] || '').trim();
}

function personalize(text, patient) {
  const name = firstNameOf(patient) || patient?.name || '';
  return String(text || '')
    .replace(/\{\{\s*(nombre|name|firstName)\s*\}\}/gi, name);
}

// Construye las variables de la plantilla para un paciente concreto.
function buildVars(template, patient) {
  if (!template?.variables?.length) return [];
  const name = firstNameOf(patient);
  return template.variables.map((v) => {
    const key = String(v.key || '').toLowerCase();
    if (['firstname', 'nombre', 'name', '1'].includes(key)) return name;
    if (['lastname', 'apellido'].includes(key)) return (patient?.name || '').split(' ').slice(1).join(' ');
    return v.example || '';
  });
}

exports.list = async (req, res) => {
  try {
    const list = await Campaign.find({ clinic: req.clinicId })
      .populate('segment', 'name')
      .populate('template', 'name status')
      .sort({ createdAt: -1 })
      .limit(200);
    res.json(list);
  } catch (err) {
    res.status(500).json({ message: 'Error al listar campañas', error: err.message });
  }
};

exports.get = async (req, res) => {
  try {
    const c = await Campaign.findOne({ _id: req.params.id, clinic: req.clinicId })
      .populate('segment', 'name filters')
      .populate('template', 'name status body');
    if (!c) return res.status(404).json({ message: 'Campaña no encontrada' });
    res.json(c);
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

/**
 * Crea una campaña y encola sus mensajes (ScheduledMessage) para el segmento.
 * body: { name, channel, segment, template?, body?, scheduledFor? }
 */
exports.create = async (req, res) => {
  try {
    const { name, channel = 'whatsapp', segment, body } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ message: 'El nombre es requerido' });
    }
    if (!segment) {
      return res.status(400).json({ message: 'Selecciona un segmento de destino' });
    }

    const seg = await Segment.findOne({ _id: segment, clinic: req.clinicId });
    if (!seg) return res.status(404).json({ message: 'Segmento no encontrado' });

    let template = null;
    if (req.body.template) {
      template = await MessageTemplate.findOne({ _id: req.body.template, clinic: req.clinicId });
      if (!template) return res.status(404).json({ message: 'Plantilla no encontrada' });
    }
    if (!template && !String(body || '').trim()) {
      return res.status(400).json({ message: 'Indica un cuerpo de mensaje o una plantilla' });
    }

    const { patients } = await resolveSegment(req.clinicId, seg.filters || {});
    if (patients.length === 0) {
      return res.status(400).json({ message: 'El segmento no tiene destinatarios' });
    }

    const scheduledFor = req.body.scheduledFor ? new Date(req.body.scheduledFor) : new Date();
    const isFuture = scheduledFor.getTime() > Date.now() + 1000;

    const campaign = await Campaign.create({
      clinic: req.clinicId,
      name: String(name).trim(),
      channel,
      segment: seg._id,
      template: template?._id || null,
      templateName: template?.name || '',
      templateLanguage: template?.language || 'es',
      body: body || '',
      scheduledFor,
      status: isFuture ? 'scheduled' : 'sending',
      stats: { targeted: patients.length, queued: patients.length, sent: 0, failed: 0, skipped: 0 },
      startedAt: isFuture ? null : new Date(),
      createdBy: req.user._id,
    });

    // Encola un ScheduledMessage por paciente (idempotente).
    const docs = patients
      .filter((p) => (channel === 'email' ? p.email : p.whatsapp || p.phone))
      .map((p) => ({
        clinic: req.clinicId,
        campaign: campaign._id,
        channel,
        to: channel === 'email' ? p.email : p.whatsapp || p.phone,
        patient: p._id,
        contactName: p.name || '',
        body: template ? '' : personalize(body, p),
        templateName: template?.name || '',
        templateLanguage: template?.language || 'es',
        templateVars: template ? buildVars(template, p) : null,
        scheduledFor,
        status: 'queued',
        idempotencyKey: `${campaign._id}:${p._id}`,
      }));

    if (docs.length) {
      await ScheduledMessage.insertMany(docs, { ordered: false }).catch((e) => {
        // Ignora duplicados (idempotencia); re-lanza otros errores.
        if (e.code !== 11000) throw e;
      });
    }
    // Ajusta el conteo real encolado.
    campaign.stats.targeted = docs.length;
    campaign.stats.queued = docs.length;
    await campaign.save();

    // Si es inmediata, intenta procesar ya (sin esperar al tick del job).
    if (!isFuture) processDueScheduledMessages().catch(() => {});

    res.status(201).json(campaign);
  } catch (err) {
    res.status(500).json({ message: 'Error al crear campaña', error: err.message });
  }
};

exports.cancel = async (req, res) => {
  try {
    const c = await Campaign.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!c) return res.status(404).json({ message: 'Campaña no encontrada' });
    if (['done', 'cancelled'].includes(c.status)) {
      return res.status(400).json({ message: 'La campaña ya finalizó' });
    }
    await ScheduledMessage.updateMany(
      { campaign: c._id, status: 'queued' },
      { status: 'cancelled', reason: 'campaign_cancelled' }
    );
    c.status = 'cancelled';
    c.finishedAt = new Date();
    await c.save();
    res.json(c);
  } catch (err) {
    res.status(500).json({ message: 'Error al cancelar campaña', error: err.message });
  }
};

// Recalcula stats/estado de una campaña desde sus ScheduledMessage.
async function recomputeCampaign(campaignId) {
  const rows = await ScheduledMessage.aggregate([
    { $match: { campaign: new mongoose.Types.ObjectId(campaignId) } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  const by = {};
  rows.forEach((r) => { by[r._id] = r.count; });
  const queued = by.queued || 0;
  const sent = by.sent || 0;
  const failed = by.failed || 0;
  const skipped = by.skipped || 0;
  const targeted = queued + sent + failed + skipped + (by.cancelled || 0);

  const campaign = await Campaign.findById(campaignId);
  if (!campaign) return;
  campaign.stats = { targeted, queued, sent, failed, skipped };
  if (campaign.status !== 'cancelled') {
    if (queued === 0) {
      campaign.status = 'done';
      if (!campaign.finishedAt) campaign.finishedAt = new Date();
    } else if (sent + failed + skipped > 0) {
      campaign.status = 'sending';
      if (!campaign.startedAt) campaign.startedAt = new Date();
    }
  }
  await campaign.save();
}

/**
 * Job: procesa los ScheduledMessage vencidos. Lo invoca un setInterval en index.js
 * y también la creación de campañas inmediatas. Procesa en lotes para respetar
 * el rate limit del proveedor.
 */
async function processDueScheduledMessages() {
  const due = await ScheduledMessage.find({ status: 'queued', scheduledFor: { $lte: new Date() } })
    .sort({ scheduledFor: 1 })
    .limit(BATCH_SIZE);
  if (!due.length) return { processed: 0 };

  const affectedCampaigns = new Set();
  for (const sm of due) {
    sm.attempts += 1;
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await messaging.send({
        clinicId: sm.clinic,
        channel: sm.channel,
        to: sm.to,
        patient: sm.patient,
        contactName: sm.contactName,
        body: sm.body,
        template: sm.templateName
          ? { name: sm.templateName, language: sm.templateLanguage, vars: sm.templateVars || [] }
          : null,
      });
      if (result.skipped) {
        sm.status = 'skipped';
        sm.reason = result.reason || '';
      } else if (result.ok) {
        sm.status = 'sent';
        sm.message = result.messageId || null;
      } else {
        sm.status = 'failed';
        sm.errorCode = result.errorCode || '';
        sm.reason = result.errorMessage || '';
      }
    } catch (err) {
      sm.status = 'failed';
      sm.reason = err.message;
    }
    // eslint-disable-next-line no-await-in-loop
    await sm.save();
    if (sm.campaign) affectedCampaigns.add(String(sm.campaign));
  }

  for (const id of affectedCampaigns) {
    // eslint-disable-next-line no-await-in-loop
    await recomputeCampaign(id).catch(() => {});
  }
  return { processed: due.length };
}

exports.processDueScheduledMessages = processDueScheduledMessages;
// Exportados para pruebas unitarias.
exports._internal = { personalize, buildVars, firstNameOf };
