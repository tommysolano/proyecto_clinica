const mongoose = require('mongoose');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Patient = require('../models/Patient');
const User = require('../models/User');
const Appointment = require('../models/Appointment');
const Product = require('../models/Product');
const Quotation = require('../models/Quotation');
const { emitToClinic } = require('../realtime');

/**
 * Normaliza un número de teléfono a sólo dígitos (sin +, ni espacios).
 */
function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d]/g, '');
  if (!digits) return null;
  return digits;
}

/**
 * Filtro de visibilidad para conversaciones según rol.
 * - admin / marketing: ven todas las conversaciones de la clínica (marketing supervisa al call center).
 * - call_center: ve todas, pero podrá actuar (responder, marcar destacado, etc.)
 *   sólo en aquellas que tenga asignadas o aún sin asignar (se enforcing en endpoints de mutación).
 */
function buildVisibilityFilter(req) {
  // Por requerimiento, el call center "puede ver todas las citas (chats)" pero solo
  // editar lo que él creó/atiende. Para listado devolvemos todo en su clínica.
  return { clinic: req.clinicId };
}

function canMutateConversation(req, conv) {
  if (req.user?.isSuperAdmin) return true;
  if (req.role === 'admin' || req.role === 'marketing') return true;
  if (req.role === 'call_center') {
    // Puede mutar si está asignado a él o si todavía no tiene asignación.
    return !conv.assignedTo || String(conv.assignedTo) === String(req.user._id);
  }
  return false;
}

// =================== Conversaciones ===================

exports.listConversations = async (req, res) => {
  try {
    const { status, featured, opportunity, assigned, q, stage, agent, unread } = req.query;
    const filter = buildVisibilityFilter(req);

    if (status) filter.status = status;
    if (featured === 'true') filter.isFeatured = true;
    if (opportunity === 'true') filter['opportunity.isOpportunity'] = true;
    if (stage) filter['opportunity.stage'] = stage;
    if (assigned === 'me') filter.assignedTo = req.user._id;
    if (assigned === 'unassigned') filter.assignedTo = null;
    if (agent && mongoose.isValidObjectId(agent)) filter.assignedTo = agent;
    if (unread === 'true') filter.unreadCount = { $gt: 0 };

    if (q) {
      const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ contactName: regex }, { phone: regex }, { lastMessagePreview: regex }];
    }

    const conversations = await Conversation.find(filter)
      .populate('patient', 'firstName lastName cedula phone')
      .populate('assignedTo', 'name email')
      .sort({ isFeatured: -1, lastMessageAt: -1 })
      .limit(300);

    res.json(conversations);
  } catch (err) {
    res.status(500).json({ message: 'Error al listar conversaciones', error: err.message });
  }
};

exports.getConversation = async (req, res) => {
  try {
    const conv = await Conversation.findOne({ _id: req.params.id, clinic: req.clinicId })
      .populate('patient', 'firstName lastName cedula phone email')
      .populate('assignedTo', 'name email')
      .populate('featuredBy', 'name')
      .populate('opportunity.appointment', 'date startTime status')
      .populate('opportunity.interestedIn.product', 'name salePrice');
    if (!conv) return res.status(404).json({ message: 'Conversación no encontrada' });
    res.json(conv);
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener conversación', error: err.message });
  }
};

exports.createConversation = async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    if (!phone) return res.status(400).json({ message: 'Teléfono inválido' });

    // Detectar duplicado
    let conv = await Conversation.findOne({ clinic: req.clinicId, phone });
    if (conv) {
      return res.status(200).json(conv);
    }

    // Vincular paciente si existe con ese teléfono
    let patient = null;
    if (req.body.patient) {
      patient = await Patient.findOne({ _id: req.body.patient, clinic: req.clinicId });
    } else {
      patient = await Patient.findOne({
        clinic: req.clinicId,
        phone: { $regex: phone.slice(-9) + '$' },
      });
    }

    conv = await Conversation.create({
      clinic: req.clinicId,
      phone,
      contactName: req.body.contactName || patient ? `${patient.firstName} ${patient.lastName}` : '',
      patient: patient?._id || null,
      channel: req.body.channel || 'whatsapp',
      assignedTo: req.user._id,
      assignedToName: req.user.name,
      assignedAt: new Date(),
      createdBy: req.user._id,
      lastMessagePreview: '',
      lastMessageAt: new Date(),
    });

    res.status(201).json(conv);
  } catch (err) {
    res.status(500).json({ message: 'Error al crear conversación', error: err.message });
  }
};

exports.updateConversation = async (req, res) => {
  try {
    const conv = await Conversation.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!conv) return res.status(404).json({ message: 'Conversación no encontrada' });
    if (!canMutateConversation(req, conv)) {
      return res.status(403).json({ message: 'No puedes modificar esta conversación' });
    }

    const allowed = ['contactName', 'patient', 'status', 'tags'];
    allowed.forEach((k) => {
      if (req.body[k] !== undefined) conv[k] = req.body[k];
    });
    await conv.save();
    res.json(conv);
  } catch (err) {
    res.status(500).json({ message: 'Error al actualizar conversación', error: err.message });
  }
};

exports.assignConversation = async (req, res) => {
  try {
    const conv = await Conversation.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!conv) return res.status(404).json({ message: 'Conversación no encontrada' });
    // Solo admin/supervisor pueden re-asignar a otros. Call center solo puede tomarla
    // (asignársela a sí mismo) si está libre.
    const target = req.body.userId || req.user._id;
    const isSelfTake = String(target) === String(req.user._id);
    if (!isSelfTake && req.role !== 'admin' && req.role !== 'marketing' && !req.user.isSuperAdmin) {
      return res.status(403).json({ message: 'Solo supervisor/admin pueden reasignar' });
    }
    if (!isSelfTake) {
      const user = await User.findById(target).select('name');
      if (!user) return res.status(404).json({ message: 'Agente no encontrado' });
      conv.assignedToName = user.name;
    } else {
      conv.assignedToName = req.user.name;
    }
    conv.assignedTo = target;
    conv.assignedAt = new Date();
    await conv.save();
    res.json(conv);
  } catch (err) {
    res.status(500).json({ message: 'Error al asignar conversación', error: err.message });
  }
};

exports.toggleFeatured = async (req, res) => {
  try {
    const conv = await Conversation.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!conv) return res.status(404).json({ message: 'Conversación no encontrada' });
    if (!canMutateConversation(req, conv)) {
      return res.status(403).json({ message: 'No puedes destacar esta conversación' });
    }
    const next = req.body.isFeatured !== undefined ? !!req.body.isFeatured : !conv.isFeatured;
    conv.isFeatured = next;
    if (next) {
      conv.featuredBy = req.user._id;
      conv.featuredAt = new Date();
      conv.featuredNote = req.body.note || '';
    } else {
      conv.featuredBy = null;
      conv.featuredAt = null;
      conv.featuredNote = '';
    }
    await conv.save();
    res.json(conv);
  } catch (err) {
    res.status(500).json({ message: 'Error al destacar', error: err.message });
  }
};

exports.setOpportunity = async (req, res) => {
  try {
    const conv = await Conversation.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!conv) return res.status(404).json({ message: 'Conversación no encontrada' });
    if (!canMutateConversation(req, conv)) {
      return res.status(403).json({ message: 'No puedes crear oportunidad en esta conversación' });
    }
    const op = conv.opportunity || {};
    op.isOpportunity = true;
    if (req.body.stage) op.stage = req.body.stage;
    if (Array.isArray(req.body.interestedIn)) {
      op.interestedIn = req.body.interestedIn.map((s) => ({
        product: s.product || s._id,
        name: s.name,
      }));
    }
    if (req.body.expectedValue !== undefined) op.expectedValue = Number(req.body.expectedValue) || 0;
    if (req.body.notes !== undefined) op.notes = req.body.notes;
    if (req.body.appointment) op.appointment = req.body.appointment;
    if (req.body.lostReason !== undefined) op.lostReason = req.body.lostReason;
    if (req.body.stage === 'ganado' && !op.convertedAt) op.convertedAt = new Date();
    if (!op.createdAt) op.createdAt = new Date();
    conv.opportunity = op;
    await conv.save();
    res.json(conv);
  } catch (err) {
    res.status(500).json({ message: 'Error al actualizar oportunidad', error: err.message });
  }
};

exports.removeOpportunity = async (req, res) => {
  try {
    const conv = await Conversation.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!conv) return res.status(404).json({ message: 'Conversación no encontrada' });
    if (!canMutateConversation(req, conv)) {
      return res.status(403).json({ message: 'No puedes modificar esta conversación' });
    }
    conv.opportunity = { isOpportunity: false, stage: 'nuevo' };
    await conv.save();
    res.json(conv);
  } catch (err) {
    res.status(500).json({ message: 'Error al eliminar oportunidad', error: err.message });
  }
};

// =================== Múltiples oportunidades por chat ===================

// Para cada item interestedIn intentamos resolver el precio actual desde el inventario.
const enrichInterested = async (clinicId, items) => {
  if (!Array.isArray(items)) return [];
  const ids = items.map((i) => i.product).filter(Boolean);
  if (ids.length === 0) return items.map((i) => ({ product: i.product, name: i.name }));
  const products = await Product.find({ _id: { $in: ids }, clinic: clinicId }).select('name salePrice');
  const byId = new Map(products.map((p) => [String(p._id), p]));
  return items
    .filter((i) => i.product)
    .map((i) => {
      const p = byId.get(String(i.product));
      return { product: i.product, name: p?.name || i.name };
    });
};

const sumInterestedValue = async (clinicId, items) => {
  if (!Array.isArray(items)) return 0;
  const ids = items.map((i) => i.product).filter(Boolean);
  if (ids.length === 0) return 0;
  const products = await Product.find({ _id: { $in: ids }, clinic: clinicId }).select('salePrice');
  return products.reduce((s, p) => s + Number(p.salePrice || 0), 0);
};

exports.addOpportunity = async (req, res) => {
  try {
    const conv = await Conversation.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!conv) return res.status(404).json({ message: 'Conversación no encontrada' });
    if (!canMutateConversation(req, conv)) {
      return res.status(403).json({ message: 'No autorizado' });
    }
    const interestedIn = await enrichInterested(req.clinicId, req.body.interestedIn || []);
    // El valor esperado se calcula desde el inventario; ignoramos cualquier precio que envíe el cliente.
    const expectedValue = await sumInterestedValue(req.clinicId, interestedIn);
    const opp = {
      isOpportunity: true,
      stage: req.body.stage || 'nuevo',
      interestedIn,
      expectedValue,
      notes: req.body.notes || '',
      createdAt: new Date(),
    };
    conv.opportunities = [...(conv.opportunities || []), opp];
    // Mantener compat: opportunity principal = primera/última creada.
    conv.opportunity = opp;
    await conv.save();
    res.status(201).json(conv);
  } catch (err) {
    res.status(500).json({ message: 'Error al crear oportunidad', error: err.message });
  }
};

exports.updateOpportunityAt = async (req, res) => {
  try {
    const conv = await Conversation.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!conv) return res.status(404).json({ message: 'Conversación no encontrada' });
    if (!canMutateConversation(req, conv)) return res.status(403).json({ message: 'No autorizado' });
    const idx = Number(req.params.idx);
    if (!Array.isArray(conv.opportunities) || !conv.opportunities[idx]) {
      return res.status(404).json({ message: 'Oportunidad no encontrada' });
    }
    const current = conv.opportunities[idx];
    if (Array.isArray(req.body.interestedIn)) {
      current.interestedIn = await enrichInterested(req.clinicId, req.body.interestedIn);
      current.expectedValue = await sumInterestedValue(req.clinicId, current.interestedIn);
    }
    if (req.body.stage) current.stage = req.body.stage;
    if (req.body.notes !== undefined) current.notes = req.body.notes;
    if (req.body.lostReason !== undefined) current.lostReason = req.body.lostReason;
    if (req.body.stage === 'ganado' && !current.convertedAt) current.convertedAt = new Date();
    conv.opportunities[idx] = current;
    conv.markModified('opportunities');
    await conv.save();
    res.json(conv);
  } catch (err) {
    res.status(500).json({ message: 'Error al actualizar oportunidad', error: err.message });
  }
};

exports.removeOpportunityAt = async (req, res) => {
  try {
    const conv = await Conversation.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!conv) return res.status(404).json({ message: 'Conversación no encontrada' });
    if (!canMutateConversation(req, conv)) return res.status(403).json({ message: 'No autorizado' });
    const idx = Number(req.params.idx);
    conv.opportunities = (conv.opportunities || []).filter((_, i) => i !== idx);
    await conv.save();
    res.json(conv);
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

// =================== Bloquear contacto ===================

exports.toggleBlocked = async (req, res) => {
  try {
    const conv = await Conversation.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!conv) return res.status(404).json({ message: 'Conversación no encontrada' });
    if (!canMutateConversation(req, conv)) return res.status(403).json({ message: 'No autorizado' });
    const next = req.body.blocked !== undefined ? !!req.body.blocked : !conv.blocked;
    conv.blocked = next;
    conv.blockedAt = next ? new Date() : null;
    conv.blockedBy = next ? req.user._id : null;
    await conv.save();
    res.json(conv);
  } catch (err) {
    res.status(500).json({ message: 'Error al bloquear', error: err.message });
  }
};

// =================== Saved Replies ===================

const SavedReply = require('../models/SavedReply');

exports.listSavedReplies = async (req, res) => {
  try {
    const list = await SavedReply.find({ clinic: req.clinicId }).sort({ shortcut: 1 });
    res.json(list);
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

exports.createSavedReply = async (req, res) => {
  try {
    const { shortcut, title, body, shared } = req.body;
    if (!shortcut || !body) return res.status(400).json({ message: 'shortcut y body requeridos' });
    const reply = await SavedReply.create({
      clinic: req.clinicId,
      shortcut: String(shortcut).trim().toLowerCase().replace(/[^a-z0-9_-]/g, ''),
      title: title || '',
      body,
      shared: shared !== false,
      createdBy: req.user._id,
    });
    res.status(201).json(reply);
  } catch (err) {
    res.status(500).json({ message: 'Error al crear mensaje guardado', error: err.message });
  }
};

exports.updateSavedReply = async (req, res) => {
  try {
    const r = await SavedReply.findOneAndUpdate(
      { _id: req.params.id, clinic: req.clinicId },
      req.body,
      { new: true }
    );
    if (!r) return res.status(404).json({ message: 'No encontrado' });
    res.json(r);
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

exports.deleteSavedReply = async (req, res) => {
  try {
    const r = await SavedReply.findOneAndDelete({ _id: req.params.id, clinic: req.clinicId });
    if (!r) return res.status(404).json({ message: 'No encontrado' });
    res.json({ message: 'Eliminado' });
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

// =================== Auto Messages ===================

const AutoMessage = require('../models/AutoMessage');
const MessageFlow = require('../models/MessageFlow');
const FlowRun = require('../models/FlowRun');

/**
 * Evalúa las reglas de mensajes automáticos activas para una conversación recién
 * tocada por un mensaje entrante. Envía como mensaje saliente automatizado los
 * que coincidan, respetando trigger / audiencia / días / horario.
 *
 * - isNewConversation: true cuando la conversación se acaba de crear.
 * - now: Date opcional para tests; por defecto Date.now().
 */
// ¿El texto entrante coincide con las palabras clave de la regla?
function keywordMatches(rule, text) {
  const kws = (rule.keywords || []).map((k) => String(k || '').trim().toLowerCase()).filter(Boolean);
  if (kws.length === 0) return false;
  const t = String(text || '').trim().toLowerCase();
  if (!t) return false;
  return kws.some((kw) => {
    if (rule.matchType === 'exact') return t === kw;
    if (rule.matchType === 'starts') return t.startsWith(kw);
    return t.includes(kw); // contains (default)
  });
}

async function fireAutoMessages({ conv, clinicId, isNewConversation, incomingText = '', now = new Date() }) {
  try {
    const rules = await AutoMessage.find({ clinic: clinicId, active: true }).sort({ order: 1, createdAt: 1 });
    if (rules.length === 0) return;

    const dayOfWeek = now.getDay(); // 0=dom..6=sáb
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const hhmm = `${hh}:${mm}`;

    const audienceMatches = (rule) => {
      if (rule.audience === 'new') return !conv.patient;
      if (rule.audience === 'existing') return !!conv.patient;
      return true;
    };

    let createdOpportunity = false;
    let keywordFired = false;

    for (const rule of rules) {
      if (!audienceMatches(rule)) continue;
      if (Array.isArray(rule.days) && rule.days.length && !rule.days.includes(dayOfWeek)) continue;

      let shouldFire = false;
      const inHours = (!rule.hourFrom || hhmm >= rule.hourFrom) && (!rule.hourTo || hhmm <= rule.hourTo);

      if (rule.trigger === 'welcome' && isNewConversation && inHours) {
        shouldFire = true;
      } else if (rule.trigger === 'keyword') {
        // Solo la primera regla de palabra clave que coincida (comportamiento de flujo).
        if (!keywordFired && keywordMatches(rule, incomingText)) {
          shouldFire = true;
          keywordFired = true;
        }
      } else if (rule.trigger === 'incoming' && inHours) {
        shouldFire = true;
      } else if (rule.trigger === 'out_of_hours' && !inHours) {
        // Fuera del horario laboral — útil para "estamos cerrados, te respondemos mañana"
        shouldFire = true;
      }
      // 'scheduled' lo dispara un cron, no este flujo de entrada.

      if (!shouldFire) continue;
      // eslint-disable-next-line no-await-in-loop
      const msg = await Message.create({
        clinic: clinicId,
        conversation: conv._id,
        direction: 'out',
        body: rule.body,
        deliveryStatus: 'sent',
        isAutoReply: true,
      });
      conv.lastMessageAt = msg.createdAt;
      conv.lastMessagePreview = String(rule.body || '').slice(0, 140);
      conv.lastMessageDirection = 'out';

      // Acción: crear oportunidad automáticamente (una sola vez por mensaje entrante).
      if (rule.createOpportunity && !createdOpportunity && !conv.opportunity?.isOpportunity) {
        conv.opportunity = {
          ...(conv.opportunity?.toObject ? conv.opportunity.toObject() : conv.opportunity || {}),
          isOpportunity: true,
          stage: rule.opportunityStage || 'nuevo',
          notes: `Creada automáticamente por flujo "${rule.name}"`,
          createdAt: new Date(),
        };
        if (Array.isArray(conv.opportunities)) {
          conv.opportunities.push({
            isOpportunity: true,
            stage: rule.opportunityStage || 'nuevo',
            notes: `Flujo: ${rule.name}`,
            createdAt: new Date(),
          });
        }
        createdOpportunity = true;
      }
    }
    await conv.save();
  } catch (err) {
    console.error('[fireAutoMessages]', err);
  }
}

// ============================================================================
// MOTOR DE FLUJOS (estilo Daplox): disparador + secuencia de pasos
// (mensaje / espera / crear oportunidad). Las esperas se reanudan con un job.
// ============================================================================
function flowKeywordMatches(trigger, text) {
  const kws = (trigger.keywords || []).map((k) => String(k || '').trim().toLowerCase()).filter(Boolean);
  if (!kws.length) return false;
  const t = String(text || '').trim().toLowerCase();
  if (!t) return false;
  return kws.some((kw) => {
    if (trigger.matchType === 'exact') return t === kw;
    if (trigger.matchType === 'starts') return t.startsWith(kw);
    return t.includes(kw);
  });
}

function flowAudienceOk(trigger, conv) {
  if (trigger.audience === 'new') return !conv.patient;
  if (trigger.audience === 'existing') return !!conv.patient;
  return true;
}

async function sendFlowMessage(conv, clinicId, body) {
  const msg = await Message.create({
    clinic: clinicId,
    conversation: conv._id,
    direction: 'out',
    body,
    deliveryStatus: 'sent',
    isAutoReply: true,
  });
  conv.lastMessageAt = msg.createdAt;
  conv.lastMessagePreview = String(body || '').slice(0, 140);
  conv.lastMessageDirection = 'out';
  await conv.save();
  try {
    await sendToExternalChannel({ conv, msg, clinicId });
  } catch (e) {
    msg.deliveryStatus = 'failed';
    await msg.save();
  }
  emitToClinic(clinicId, 'chat:message', { conversationId: conv._id, message: msg });
}

async function applyFlowOpportunity(conv, stage) {
  if (!conv.opportunity?.isOpportunity) {
    conv.opportunity = {
      ...(conv.opportunity?.toObject ? conv.opportunity.toObject() : conv.opportunity || {}),
      isOpportunity: true,
      stage: stage || 'nuevo',
      notes: 'Creada automáticamente por flujo',
      createdAt: new Date(),
    };
  } else if (stage) {
    conv.opportunity.stage = stage;
  }
  if (Array.isArray(conv.opportunities)) {
    conv.opportunities.push({ isOpportunity: true, stage: stage || 'nuevo', createdAt: new Date() });
  }
  await conv.save();
  emitToClinic(conv.clinic, 'chat:opportunity', { conversationId: conv._id });
}

/**
 * Ejecuta los pasos de un FlowRun desde su stepIndex hasta encontrar una espera
 * pendiente (la agenda) o terminar el flujo.
 */
async function executeFlowRun(run) {
  const flow = await MessageFlow.findById(run.flow);
  if (!flow || !flow.active) { run.status = 'cancelled'; await run.save(); return; }
  const conv = await Conversation.findById(run.conversation);
  if (!conv || conv.blocked) { run.status = 'cancelled'; await run.save(); return; }

  for (let i = run.stepIndex; i < flow.steps.length; i++) {
    const step = flow.steps[i];
    if (step.type === 'wait') {
      const mins = Number(step.waitMinutes || 0);
      if (mins > 0) {
        run.stepIndex = i + 1;
        run.nextRunAt = new Date(Date.now() + mins * 60000);
        run.status = 'pending';
        await run.save();
        return;
      }
      continue; // espera 0 → seguir
    }
    if (step.type === 'message') {
      // eslint-disable-next-line no-await-in-loop
      await sendFlowMessage(conv, run.clinic, step.body || '');
    } else if (step.type === 'opportunity') {
      // eslint-disable-next-line no-await-in-loop
      await applyFlowOpportunity(conv, step.opportunityStage);
    }
  }
  run.stepIndex = flow.steps.length;
  run.status = 'done';
  await run.save();
}

/**
 * Dispara los flujos activos que coinciden con un mensaje entrante / nueva conversación.
 */
function flowInSchedule(flow, now = new Date()) {
  const day = now.getDay();
  if (Array.isArray(flow.days) && flow.days.length && !flow.days.includes(day)) return false;
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  if (flow.hourFrom && hhmm < flow.hourFrom) return false;
  if (flow.hourTo && hhmm > flow.hourTo) return false;
  return true;
}

// Un disparador coincide con el evento entrante.
function triggerMatches(tr, { conv, incomingText, isNewConversation }) {
  if (!flowAudienceOk(tr, conv)) return false;
  if (tr.type === 'welcome') return !!isNewConversation;
  if (tr.type === 'incoming') return true;
  if (tr.type === 'keyword') return flowKeywordMatches(tr, incomingText);
  return false;
}

async function triggerFlows({ conv, clinicId, incomingText = '', isNewConversation }) {
  try {
    const flows = await MessageFlow.find({ clinic: clinicId, active: true }).sort({ updatedAt: -1 });
    if (!flows.length) return;
    const now = new Date();
    for (const flow of flows) {
      if (!flowInSchedule(flow, now)) continue;
      const triggers = (flow.triggers && flow.triggers.length) ? flow.triggers : [flow.trigger || {}];
      const matched = triggers.some((tr) => triggerMatches(tr, { conv, incomingText, isNewConversation }));
      if (!matched) continue;
      // No relanzar un flujo que ya está en curso para esta conversación.
      // eslint-disable-next-line no-await-in-loop
      const existing = await FlowRun.findOne({ flow: flow._id, conversation: conv._id, status: 'pending' });
      if (existing) continue;
      // eslint-disable-next-line no-await-in-loop
      const run = await FlowRun.create({
        clinic: clinicId,
        flow: flow._id,
        conversation: conv._id,
        stepIndex: 0,
        status: 'pending',
        nextRunAt: new Date(),
      });
      // eslint-disable-next-line no-await-in-loop
      await executeFlowRun(run);
    }
  } catch (e) {
    console.error('[triggerFlows]', e);
  }
}

/**
 * Job: reanuda los flujos cuyas esperas ya vencieron.
 */
async function processDueFlowRuns() {
  try {
    const due = await FlowRun.find({ status: 'pending', nextRunAt: { $lte: new Date() } })
      .sort({ nextRunAt: 1 })
      .limit(100);
    for (const run of due) {
      // eslint-disable-next-line no-await-in-loop
      await executeFlowRun(run);
    }
  } catch (e) {
    console.error('[processDueFlowRuns]', e);
  }
}

exports.triggerFlows = triggerFlows;
exports.processDueFlowRuns = processDueFlowRuns;

exports.listAutoMessages = async (req, res) => {
  try {
    const list = await AutoMessage.find({ clinic: req.clinicId }).sort({ name: 1 });
    res.json(list);
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

exports.createAutoMessage = async (req, res) => {
  try {
    const am = await AutoMessage.create({
      ...req.body,
      clinic: req.clinicId,
      createdBy: req.user._id,
    });
    res.status(201).json(am);
  } catch (err) {
    res.status(500).json({ message: 'Error al crear', error: err.message });
  }
};

exports.updateAutoMessage = async (req, res) => {
  try {
    const am = await AutoMessage.findOneAndUpdate(
      { _id: req.params.id, clinic: req.clinicId },
      req.body,
      { new: true }
    );
    if (!am) return res.status(404).json({ message: 'No encontrado' });
    res.json(am);
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

exports.deleteAutoMessage = async (req, res) => {
  try {
    const am = await AutoMessage.findOneAndDelete({ _id: req.params.id, clinic: req.clinicId });
    if (!am) return res.status(404).json({ message: 'No encontrado' });
    res.json({ message: 'Eliminado' });
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

// =================== Galería de imágenes ===================

const ChatGalleryImage = require('../models/ChatGalleryImage');

exports.listGallery = async (req, res) => {
  try {
    const list = await ChatGalleryImage.find({ clinic: req.clinicId })
      .select('name mimeType size createdAt')
      .sort({ createdAt: -1 });
    res.json(list);
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

exports.uploadGallery = async (req, res) => {
  try {
    const { name, dataUrl } = req.body;
    if (!dataUrl || !/^data:image\/(png|jpe?g|webp|gif);base64,/.test(dataUrl)) {
      return res.status(400).json({ message: 'Imagen inválida' });
    }
    if (dataUrl.length > 2_500_000) {
      return res.status(400).json({ message: 'Imagen demasiado grande (máx ~1.8MB)' });
    }
    const mimeMatch = dataUrl.match(/^data:(image\/[a-zA-Z0-9+]+);/);
    const img = await ChatGalleryImage.create({
      clinic: req.clinicId,
      name: name || `imagen_${Date.now()}`,
      dataUrl,
      mimeType: mimeMatch ? mimeMatch[1] : 'image/png',
      size: dataUrl.length,
      createdBy: req.user._id,
    });
    res.status(201).json({ _id: img._id, name: img.name, mimeType: img.mimeType, size: img.size });
  } catch (err) {
    res.status(500).json({ message: 'Error al subir', error: err.message });
  }
};

exports.deleteGalleryItem = async (req, res) => {
  try {
    const r = await ChatGalleryImage.findOneAndDelete({ _id: req.params.id, clinic: req.clinicId });
    if (!r) return res.status(404).json({ message: 'No encontrado' });
    res.json({ message: 'Eliminado' });
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

exports.sendGalleryImage = async (req, res) => {
  try {
    const conv = await Conversation.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!conv) return res.status(404).json({ message: 'Conversación no encontrada' });
    if (conv.blocked) return res.status(403).json({ message: 'Contacto bloqueado' });
    const img = await ChatGalleryImage.findOne({ _id: req.body.imageId, clinic: req.clinicId });
    if (!img) return res.status(404).json({ message: 'Imagen no encontrada' });
    const msg = await Message.create({
      clinic: req.clinicId,
      conversation: conv._id,
      direction: 'out',
      body: req.body.caption || `[imagen: ${img.name}]`,
      mediaUrl: img.dataUrl,
      mediaType: 'image',
      sentBy: req.user._id,
      sentByName: req.user.name,
    });
    conv.lastMessagePreview = `[imagen]`;
    conv.lastMessageAt = new Date();
    conv.lastMessageDirection = 'out';
    await conv.save();
    res.status(201).json(msg);
  } catch (err) {
    res.status(500).json({ message: 'Error al enviar imagen', error: err.message });
  }
};

// =================== Vista global de oportunidades ===================

exports.listAllOpportunities = async (req, res) => {
  try {
    const { from, to, patient, service } = req.query;
    const query = { clinic: req.clinicId };
    const orFilters = [
      { 'opportunity.isOpportunity': true },
      { 'opportunities.0': { $exists: true } },
    ];
    query.$or = orFilters;
    const list = await Conversation.find(query)
      .populate('patient', 'firstName lastName cedula phone')
      .sort({ lastMessageAt: -1 })
      .limit(500);

    // Aplanar para devolver una oportunidad por fila.
    const rows = [];
    for (const c of list) {
      const opps = [];
      if (c.opportunity?.isOpportunity) opps.push(c.opportunity);
      if (Array.isArray(c.opportunities)) opps.push(...c.opportunities);
      for (const op of opps) {
        const created = op.createdAt ? new Date(op.createdAt) : null;
        if (from && created && created < new Date(from)) continue;
        if (to && created && created > new Date(`${to}T23:59:59`)) continue;
        if (
          service &&
          !(op.interestedIn || []).some((i) => String(i.product) === String(service))
        ) continue;
        const fullName = `${c.patient?.firstName || ''} ${c.patient?.lastName || ''} ${c.contactName || ''}`.toLowerCase();
        if (patient && !fullName.includes(String(patient).toLowerCase())) continue;
        rows.push({
          conversationId: c._id,
          phone: c.phone,
          contactName: c.contactName,
          patient: c.patient,
          stage: op.stage,
          notes: op.notes,
          expectedValue: op.expectedValue,
          interestedIn: op.interestedIn,
          createdAt: op.createdAt,
        });
      }
    }
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

exports.bulkWhatsappOpportunities = async (req, res) => {
  try {
    const { conversationIds, body } = req.body;
    if (!Array.isArray(conversationIds) || conversationIds.length === 0) {
      return res.status(400).json({ message: 'Selecciona al menos una conversación' });
    }
    if (!body || !String(body).trim()) {
      return res.status(400).json({ message: 'Mensaje vacío' });
    }
    const convs = await Conversation.find({
      _id: { $in: conversationIds },
      clinic: req.clinicId,
      blocked: { $ne: true },
    });
    let sent = 0;
    for (const c of convs) {
      // eslint-disable-next-line no-await-in-loop
      await Message.create({
        clinic: req.clinicId,
        conversation: c._id,
        direction: 'out',
        body: String(body).trim(),
        sentBy: req.user._id,
        sentByName: req.user.name,
      });
      c.lastMessagePreview = String(body).slice(0, 140);
      c.lastMessageAt = new Date();
      c.lastMessageDirection = 'out';
      // eslint-disable-next-line no-await-in-loop
      await c.save();
      sent++;
    }
    res.json({ sent, total: conversationIds.length });
  } catch (err) {
    res.status(500).json({ message: 'Error al enviar masivo', error: err.message });
  }
};

// =================== Mensajes ===================

exports.listMessages = async (req, res) => {
  try {
    const conv = await Conversation.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!conv) return res.status(404).json({ message: 'Conversación no encontrada' });
    const messages = await Message.find({ conversation: conv._id, clinic: req.clinicId })
      .populate('sentBy', 'name')
      .sort({ createdAt: 1 })
      .limit(500);
    // Marcar mensajes entrantes como leídos cuando el agente abre el chat
    await Message.updateMany(
      { conversation: conv._id, direction: 'in', isRead: false },
      { isRead: true }
    );
    if (conv.unreadCount > 0) {
      conv.unreadCount = 0;
      await conv.save();
    }
    res.json(messages);
  } catch (err) {
    res.status(500).json({ message: 'Error al listar mensajes', error: err.message });
  }
};

exports.sendMessage = async (req, res) => {
  try {
    const conv = await Conversation.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!conv) return res.status(404).json({ message: 'Conversación no encontrada' });
    if (!canMutateConversation(req, conv)) {
      return res.status(403).json({ message: 'No puedes enviar mensajes en esta conversación' });
    }
    if (conv.blocked) {
      return res.status(403).json({ message: 'Este contacto está bloqueado.' });
    }
    const body = (req.body.body || '').toString().trim();
    if (!body && !req.body.mediaUrl) {
      return res.status(400).json({ message: 'Mensaje vacío' });
    }
    const msg = await Message.create({
      clinic: req.clinicId,
      conversation: conv._id,
      direction: 'out',
      body,
      mediaUrl: req.body.mediaUrl || null,
      mediaType: req.body.mediaType || null,
      deliveryStatus: 'sent',
      sentBy: req.user._id,
      sentByName: req.user.name,
    });
    conv.lastMessageAt = msg.createdAt;
    conv.lastMessagePreview = body.slice(0, 140);
    conv.lastMessageDirection = 'out';
    if (!conv.assignedTo) {
      conv.assignedTo = req.user._id;
      conv.assignedToName = req.user.name;
      conv.assignedAt = new Date();
    }
    await conv.save();

    // Envío real al proveedor externo según el canal de la conversación.
    // Si falla, dejamos el mensaje guardado pero marcamos deliveryStatus='failed'.
    try {
      await sendToExternalChannel({ conv, msg, clinicId: req.clinicId });
    } catch (sendErr) {
      console.warn('[external send]', sendErr.message);
      msg.deliveryStatus = 'failed';
      await msg.save();
    }

    emitToClinic(req.clinicId, 'chat:message', { conversationId: conv._id, message: msg });
    res.status(201).json(msg);
  } catch (err) {
    res.status(500).json({ message: 'Error al enviar mensaje', error: err.message });
  }
};

/**
 * Envía un mensaje saliente usando la API del proveedor del canal.
 * Si el canal es 'web' o 'sms' (legacy) no hace nada.
 */
async function sendToExternalChannel({ conv, msg, clinicId }) {
  const CallCenterConfigModel = require('../models/CallCenterConfig');
  const cfg = await CallCenterConfigModel.findOne({ clinic: clinicId });
  if (!cfg) return;
  const channel = conv.channel;
  if (channel === 'whatsapp' && cfg.whatsapp?.enabled) {
    const { phoneNumberId, accessToken } = cfg.whatsapp;
    if (!phoneNumberId || !accessToken) return;
    const r = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: conv.phone,
        type: 'text',
        text: { body: msg.body || '' },
      }),
    });
    if (!r.ok) throw new Error(`whatsapp api ${r.status}`);
    return;
  }
  if (channel === 'messenger' && cfg.messenger?.enabled) {
    const { pageAccessToken } = cfg.messenger;
    if (!pageAccessToken) return;
    const r = await fetch(
      `https://graph.facebook.com/v20.0/me/messages?access_token=${pageAccessToken}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: { id: conv.externalUserId || conv.phone },
          message: { text: msg.body || '' },
          messaging_type: 'RESPONSE',
        }),
      }
    );
    if (!r.ok) throw new Error(`messenger api ${r.status}`);
    return;
  }
  if (channel === 'instagram' && cfg.instagram?.enabled) {
    const { pageAccessToken } = cfg.instagram;
    if (!pageAccessToken) return;
    const r = await fetch(
      `https://graph.facebook.com/v20.0/me/messages?access_token=${pageAccessToken}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: { id: conv.externalUserId || conv.phone },
          message: { text: msg.body || '' },
        }),
      }
    );
    if (!r.ok) throw new Error(`instagram api ${r.status}`);
    return;
  }
  // TikTok: la API de mensajería es específica del producto. Dejamos un stub.
  if (channel === 'tiktok' && cfg.tiktok?.enabled) {
    // Sin SDK público estable: el llamado real va aquí cuando se defina el endpoint del producto.
    return;
  }
}

// =================== Webhook / Simulación entrada ===================

/**
 * Endpoint público (sin auth) compatible con WhatsApp Business Cloud API.
 * Acepta el formato { entry: [{ changes: [{ value: { messages, contacts } }] }] }
 * y también un formato simplificado { clinicId, phone, body }.
 *
 * Para Meta es habitual implementar también el GET con hub.challenge para verificación.
 */
exports.webhookVerify = (req, res) => {
  const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'clinica-verify';
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.status(403).send('Verification failed');
};

exports.webhookReceive = async (req, res) => {
  try {
    // Soportar dos formatos
    const events = [];
    if (Array.isArray(req.body.entry)) {
      req.body.entry.forEach((entry) => {
        (entry.changes || []).forEach((change) => {
          const value = change.value || {};
          (value.messages || []).forEach((m) => {
            const contact = (value.contacts || [])[0] || {};
            events.push({
              phone: m.from,
              body: m.text?.body || m.button?.text || '',
              externalId: m.id,
              contactName: contact.profile?.name,
            });
          });
        });
      });
    } else if (req.body.phone) {
      events.push({
        phone: req.body.phone,
        body: req.body.body,
        externalId: req.body.externalId,
        contactName: req.body.contactName,
      });
    }

    // Para webhook real necesitamos identificar la clínica destino.
    // Como múltiples clínicas pueden compartir el mismo endpoint, usamos
    // un header X-Clinic-Id o un campo clinicId en el body (configurable por clínica).
    const clinicId = req.headers['x-clinic-id'] || req.body.clinicId;
    if (!clinicId) {
      return res.status(400).json({ message: 'clinicId requerido en webhook' });
    }

    for (const ev of events) {
      const phone = normalizePhone(ev.phone);
      if (!phone) continue;
      let conv = await Conversation.findOne({ clinic: clinicId, phone });
      let isNewConversation = false;
      if (!conv) {
        const patient = await Patient.findOne({
          clinic: clinicId,
          phone: { $regex: phone.slice(-9) + '$' },
        });
        conv = await Conversation.create({
          clinic: clinicId,
          phone,
          contactName: ev.contactName || patient ? `${patient.firstName} ${patient.lastName}` : '',
          patient: patient?._id || null,
          channel: 'whatsapp',
        });
        isNewConversation = true;
      }
      // Si el contacto está bloqueado, descartamos el mensaje silenciosamente.
      if (conv.blocked) continue;
      await Message.create({
        clinic: clinicId,
        conversation: conv._id,
        direction: 'in',
        body: ev.body || '',
        externalId: ev.externalId,
        deliveryStatus: 'delivered',
      });
      conv.lastMessageAt = new Date();
      conv.lastMessagePreview = (ev.body || '').slice(0, 140);
      conv.lastMessageDirection = 'in';
      conv.unreadCount = (conv.unreadCount || 0) + 1;
      if (conv.status === 'closed') conv.status = 'open';
      await conv.save();

      // Disparar flujos de mensajes automáticos
      await triggerFlows({
        conv,
        clinicId,
        isNewConversation,
        incomingText: ev.body || '',
      });
    }
    res.status(200).json({ received: events.length });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ message: 'Error en webhook', error: err.message });
  }
};

/**
 * Endpoint autenticado para simular un mensaje entrante (útil mientras no haya
 * conexión real con WhatsApp Business API). Recibe { phone, body, contactName }
 * y lo procesa como si viniera del webhook.
 */
exports.simulateIncoming = async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    if (!phone) return res.status(400).json({ message: 'Teléfono inválido' });
    const body = (req.body.body || '').toString().trim();
    if (!body) return res.status(400).json({ message: 'Mensaje vacío' });

    let conv = await Conversation.findOne({ clinic: req.clinicId, phone });
    let isNewConversation = false;
    if (!conv) {
      const patient = await Patient.findOne({
        clinic: req.clinicId,
        phone: { $regex: phone.slice(-9) + '$' },
      });
      conv = await Conversation.create({
        clinic: req.clinicId,
        phone,
        contactName:
          req.body.contactName ||
          (patient ? `${patient.firstName} ${patient.lastName}` : ''),
        patient: patient?._id || null,
        channel: 'whatsapp',
      });
      isNewConversation = true;
    }
    if (conv.blocked) {
      return res.status(403).json({ message: 'Este contacto está bloqueado.' });
    }
    const msg = await Message.create({
      clinic: req.clinicId,
      conversation: conv._id,
      direction: 'in',
      body,
      deliveryStatus: 'delivered',
    });
    conv.lastMessageAt = msg.createdAt;
    conv.lastMessagePreview = body.slice(0, 140);
    conv.lastMessageDirection = 'in';
    conv.unreadCount = (conv.unreadCount || 0) + 1;
    if (conv.status === 'closed') conv.status = 'open';
    await conv.save();

    // Disparar flujos de mensajes automáticos
    await triggerFlows({
      conv,
      clinicId: req.clinicId,
      isNewConversation,
      incomingText: body,
    });

    res.status(201).json({ conversation: conv, message: msg });
  } catch (err) {
    res.status(500).json({ message: 'Error al simular mensaje', error: err.message });
  }
};

// =================== Webhooks por canal (Meta/TikTok) ===================
//
// Cada webhook se identifica por clinicId en la URL (/chats/webhook/<canal>/<clinicId>).
// El verifyToken se valida contra CallCenterConfig por clínica + canal.
// El endpoint NO requiere auth (lo invoca el proveedor externo).

const CallCenterConfig = require('../models/CallCenterConfig');

const getChannelConfig = async (clinicId, channel) => {
  const cfg = await CallCenterConfig.findOne({ clinic: clinicId });
  if (!cfg) return null;
  return cfg[channel] || null;
};

// Procesa un evento "normalizado" (externalUserId, body, contactName) creando/
// actualizando la conversación correspondiente.
async function ingestExternalMessage({ clinicId, channel, externalUserId, body, contactName, externalId, phone }) {
  if (!externalUserId && !phone) return;
  const findKey = phone
    ? { clinic: clinicId, channel, phone }
    : { clinic: clinicId, channel, externalUserId };
  let conv = await Conversation.findOne(findKey);
  let isNew = false;
  if (!conv) {
    conv = await Conversation.create({
      clinic: clinicId,
      phone: phone || externalUserId, // unique constraint en (clinic, phone)
      externalUserId: externalUserId || '',
      contactName: contactName || '',
      channel,
    });
    isNew = true;
  }
  if (conv.blocked) return;
  await Message.create({
    clinic: clinicId,
    conversation: conv._id,
    direction: 'in',
    body: body || '',
    externalId,
    deliveryStatus: 'delivered',
  });
  conv.lastMessageAt = new Date();
  conv.lastMessagePreview = String(body || '').slice(0, 140);
  conv.lastMessageDirection = 'in';
  conv.unreadCount = (conv.unreadCount || 0) + 1;
  if (conv.status === 'closed') conv.status = 'open';
  await conv.save();
  await triggerFlows({ conv, clinicId, isNewConversation: isNew, incomingText: body || '' });
  emitToClinic(clinicId, 'chat:message', { conversationId: conv._id });
}

// Verificación GET para canales Meta (whatsapp/messenger/instagram).
// El proveedor envía hub.mode/hub.verify_token/hub.challenge.
const metaVerify = (channel) => async (req, res) => {
  const { clinicId } = req.params;
  try {
    const c = await getChannelConfig(clinicId, channel);
    const expected = c?.verifyToken;
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token && token === expected) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Verification failed');
  } catch {
    return res.status(500).send('Error');
  }
};

exports.webhookWhatsappVerify = metaVerify('whatsapp');
exports.webhookMessengerVerify = metaVerify('messenger');
exports.webhookInstagramVerify = metaVerify('instagram');

exports.webhookWhatsappReceive = async (req, res) => {
  try {
    const { clinicId } = req.params;
    const entries = Array.isArray(req.body.entry) ? req.body.entry : [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const contact = (value.contacts || [])[0] || {};
        for (const m of value.messages || []) {
          // eslint-disable-next-line no-await-in-loop
          await ingestExternalMessage({
            clinicId,
            channel: 'whatsapp',
            phone: m.from,
            externalUserId: m.from,
            body: m.text?.body || m.button?.text || m.interactive?.button_reply?.title || '',
            contactName: contact.profile?.name || '',
            externalId: m.id,
          });
        }
      }
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[whatsapp webhook]', err);
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

exports.webhookMessengerReceive = async (req, res) => {
  try {
    const { clinicId } = req.params;
    const entries = Array.isArray(req.body.entry) ? req.body.entry : [];
    for (const entry of entries) {
      for (const event of entry.messaging || []) {
        const senderId = event.sender?.id;
        if (!senderId) continue;
        if (event.message?.text) {
          // eslint-disable-next-line no-await-in-loop
          await ingestExternalMessage({
            clinicId,
            channel: 'messenger',
            externalUserId: senderId,
            body: event.message.text,
            externalId: event.message.mid,
          });
        }
      }
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[messenger webhook]', err);
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

exports.webhookInstagramReceive = async (req, res) => {
  try {
    const { clinicId } = req.params;
    const entries = Array.isArray(req.body.entry) ? req.body.entry : [];
    for (const entry of entries) {
      for (const event of entry.messaging || []) {
        const senderId = event.sender?.id;
        if (!senderId) continue;
        if (event.message?.text) {
          // eslint-disable-next-line no-await-in-loop
          await ingestExternalMessage({
            clinicId,
            channel: 'instagram',
            externalUserId: senderId,
            body: event.message.text,
            externalId: event.message.mid,
          });
        }
      }
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[instagram webhook]', err);
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

// TikTok: verificación + recepción.
exports.webhookTiktokVerify = async (req, res) => {
  const { clinicId } = req.params;
  try {
    const c = await getChannelConfig(clinicId, 'tiktok');
    const expected = c?.verifyToken;
    const challenge = req.query.challenge || req.body?.challenge;
    const token = req.query.verify_token || req.body?.verify_token;
    if (token && token === expected) return res.status(200).send(challenge || 'ok');
    return res.status(403).send('Verification failed');
  } catch {
    return res.status(500).send('Error');
  }
};

exports.webhookTiktokReceive = async (req, res) => {
  try {
    const { clinicId } = req.params;
    // El formato exacto depende del producto TikTok; soportamos un payload genérico:
    // { user_id, message, name }
    const userId = req.body.user_id || req.body.openId;
    const body = req.body.message || req.body.content || '';
    const name = req.body.name || req.body.nickname || '';
    if (userId) {
      await ingestExternalMessage({
        clinicId,
        channel: 'tiktok',
        externalUserId: String(userId),
        body,
        contactName: name,
        externalId: req.body.message_id || req.body.id,
      });
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[tiktok webhook]', err);
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

// =================== Métricas / supervisor ===================

exports.getStats = async (req, res) => {
  try {
    const match = { clinic: new mongoose.Types.ObjectId(req.clinicId) };
    const [byStatus, opportunities, featuredCount, byAgent] = await Promise.all([
      Conversation.aggregate([
        { $match: match },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      Conversation.aggregate([
        { $match: { ...match, 'opportunity.isOpportunity': true } },
        { $group: { _id: '$opportunity.stage', count: { $sum: 1 }, value: { $sum: '$opportunity.expectedValue' } } },
      ]),
      Conversation.countDocuments({ ...match, isFeatured: true }),
      Conversation.aggregate([
        { $match: { ...match, assignedTo: { $ne: null } } },
        {
          $group: {
            _id: '$assignedTo',
            total: { $sum: 1 },
            open: { $sum: { $cond: [{ $eq: ['$status', 'open'] }, 1, 0] } },
            featured: { $sum: { $cond: ['$isFeatured', 1, 0] } },
            opportunities: { $sum: { $cond: ['$opportunity.isOpportunity', 1, 0] } },
            won: { $sum: { $cond: [{ $eq: ['$opportunity.stage', 'ganado'] }, 1, 0] } },
          },
        },
        { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
        { $unwind: '$user' },
        {
          $project: {
            _id: 1,
            name: '$user.name',
            email: '$user.email',
            total: 1,
            open: 1,
            featured: 1,
            opportunities: 1,
            won: 1,
          },
        },
        { $sort: { total: -1 } },
      ]),
    ]);
    res.json({ byStatus, opportunities, featuredCount, byAgent });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener estadísticas', error: err.message });
  }
};

/**
 * POST /api/chats/:id/appointment
 * Crea una cita a partir de una conversación. Requiere que conv.patient esté vinculado.
 * Body: { date, startTime, reason?, services?: [{product, quantity?}], clinic? }
 */
/**
 * Registra un paciente en el sistema a partir del contacto de la conversación
 * y lo vincula a la conversación. Si ya existe un paciente con la misma cédula
 * o teléfono, lo reutiliza.
 */
exports.registerPatientFromChat = async (req, res) => {
  try {
    const conv = await Conversation.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!conv) return res.status(404).json({ message: 'Conversación no encontrada' });
    if (conv.patient) {
      const existing = await Patient.findById(conv.patient);
      if (existing) return res.json({ patient: existing, conversation: conv });
    }

    const { firstName, lastName, cedula, gender } = req.body;
    if (!firstName || !lastName) {
      return res.status(400).json({ message: 'Nombres y apellidos son requeridos' });
    }
    if (!gender) {
      return res.status(400).json({ message: 'El género es obligatorio' });
    }

    const phone = conv.phone || req.body.phone || '';
    let patient = null;
    if (cedula) patient = await Patient.findOne({ cedula });
    if (!patient && phone) {
      patient = await Patient.findOne({ phone: { $regex: phone.slice(-9) + '$' } });
    }
    if (!patient) {
      patient = await Patient.create({
        clinic: req.clinicId,
        firstName,
        lastName,
        cedula: cedula || '',
        gender,
        phone,
        whatsapp: phone,
        source: 'anuncio',
      });
    }
    conv.patient = patient._id;
    if (!conv.contactName) conv.contactName = `${patient.firstName} ${patient.lastName}`;
    await conv.save();
    emitToClinic(req.clinicId, 'patient:created', { id: patient._id });
    emitToClinic(req.clinicId, 'chat:updated', { id: conv._id });
    res.status(201).json({ patient, conversation: conv });
  } catch (err) {
    res.status(500).json({ message: 'Error al registrar paciente', error: err.message });
  }
};

exports.createAppointmentFromChat = async (req, res) => {
  try {
    const conv = await Conversation.findOne({
      _id: req.params.id,
      clinic: req.clinicId,
    }).populate('patient');
    if (!conv) return res.status(404).json({ message: 'Conversación no encontrada' });
    if (!conv.patient) {
      return res.status(400).json({
        message: 'La conversación no está vinculada a un paciente. Vincula primero al paciente.',
      });
    }

    // Acepta dos formatos:
    //  - { appointments: [{ date, startTime, reason?, services?, clinic? }, ...] }  → múltiples citas
    //  - { date, startTime, reason?, services?, clinic? }                            → una sola cita (legacy)
    const requested = Array.isArray(req.body.appointments) && req.body.appointments.length
      ? req.body.appointments
      : [{
          date: req.body.date,
          startTime: req.body.startTime,
          reason: req.body.reason,
          services: req.body.services || [],
          clinic: req.body.clinic,
        }];

    for (let i = 0; i < requested.length; i++) {
      const a = requested[i];
      if (!a.date || !a.startTime) {
        return res.status(400).json({ message: `La cita #${i + 1} requiere fecha y hora de inicio.` });
      }
      // El servicio es obligatorio para toda cita nueva.
      const svcIds = (a.services || [])
        .map((s) => (typeof s === 'string' ? s : s?.product))
        .filter(Boolean);
      if (svcIds.length === 0) {
        return res
          .status(400)
          .json({ message: `La cita #${i + 1} requiere al menos un servicio.` });
      }
    }

    // Normaliza 'YYYY-MM-DD' a fecha local-noon para que el filtro por día coincida.
    const parseLocalDate = (value) => {
      if (!value) return null;
      if (value instanceof Date) return value;
      const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0);
      return new Date(value);
    };

    // Recoge todos los IDs de servicios para snapshot en una sola consulta
    const allIds = new Set();
    requested.forEach((a) => (a.services || []).forEach((s) => s.product && allIds.add(String(s.product))));
    const productsMap = new Map();
    if (allIds.size) {
      const products = await Product.find({ _id: { $in: [...allIds] } });
      products.forEach((p) => productsMap.set(String(p._id), p));
    }

    const previousCount = await Appointment.countDocuments({
      clinic: req.clinicId,
      patient: conv.patient._id,
    });

    const created = [];
    let first = previousCount === 0;
    for (const a of requested) {
      const localDate = parseLocalDate(a.date);
      const serviceItems = (a.services || [])
        .filter((s) => s.product)
        .map((s) => {
          const p = productsMap.get(String(s.product));
          return {
            product: s.product,
            name: p?.name || '',
            quantity: Number(s.quantity) || 1,
          };
        });

      const targetClinic = a.clinic || req.clinicId;
      const appointment = await Appointment.create({
        clinic: targetClinic,
        patient: conv.patient._id,
        date: localDate,
        startTime: a.startTime,
        reason: a.reason || conv.opportunity?.notes || `Cita desde chat ${conv.phone}`,
        services: serviceItems,
        status: 'pendiente',
        isFirstVisit: first,
        createdBy: req.user._id,
        createdByRole: req.role || null,
      });
      first = false; // solo la primera puede ser "primera visita"
      created.push(appointment);
      emitToClinic(req.clinicId, 'appointment:created', { id: appointment._id });
    }

    // Link primera cita a la oportunidad
    conv.opportunity = conv.opportunity || {};
    conv.opportunity.isOpportunity = true;
    conv.opportunity.stage = 'agendado';
    conv.opportunity.appointment = created[0]?._id;
    conv.opportunity.convertedAt = new Date();
    await conv.save();
    emitToClinic(req.clinicId, 'chat:updated', { id: conv._id });

    res.status(201).json({
      appointment: created[0],
      appointments: created,
      conversation: conv,
    });
  } catch (err) {
    res.status(500).json({ message: 'Error al crear cita desde chat', error: err.message });
  }
};

/**
 * POST /api/chats/:id/quotation
 * Crea una cotización a partir de una conversación y envía el enlace por el chat.
 * Body: { items: [{ product, quantity?, unitPrice?, discount? }], validUntil?, notes?, send? }
 */
exports.createQuotationFromChat = async (req, res) => {
  try {
    const conv = await Conversation.findOne({
      _id: req.params.id,
      clinic: req.clinicId,
    }).populate('patient', 'firstName lastName cedula email phone');
    if (!conv) return res.status(404).json({ message: 'Conversación no encontrada' });

    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (items.length === 0) {
      return res.status(400).json({ message: 'Agrega al menos un ítem' });
    }

    const ids = items.map((i) => i.product).filter(Boolean);
    const products = ids.length
      ? await Product.find({ _id: { $in: ids }, clinic: req.clinicId })
      : [];
    const byId = new Map(products.map((p) => [String(p._id), p]));

    let subtotal = 0;
    let discountTotal = 0;
    const enriched = items.map((it) => {
      const p = byId.get(String(it.product));
      const qty = Number(it.quantity || 1);
      const unit = Number(it.unitPrice ?? p?.salePrice ?? 0);
      const discPct = Math.min(Math.max(Number(it.discount || 0), 0), 100);
      const baseSub = unit * qty;
      const discAmount = +(baseSub * (discPct / 100)).toFixed(2);
      const sub = +(baseSub - discAmount).toFixed(2);
      subtotal += baseSub;
      discountTotal += discAmount;
      return {
        product: it.product,
        productCode: p?.code,
        productName: p?.name || it.productName || '',
        category: p?.category,
        quantity: qty,
        unitPrice: unit,
        taxRate: 0,
        discount: discPct,
        subtotal: sub,
      };
    });
    const total = +(subtotal - discountTotal).toFixed(2);

    const patient = conv.patient;
    const quotation = await Quotation.create({
      clinic: req.clinicId,
      patient: patient?._id,
      clientName:
        req.body.clientName ||
        (patient ? `${patient.firstName} ${patient.lastName}` : conv.contactName) ||
        '',
      clientCedula: req.body.clientCedula || patient?.cedula || '',
      clientEmail: req.body.clientEmail || patient?.email || '',
      clientPhone: req.body.clientPhone || patient?.phone || conv.phone || '',
      notes: req.body.notes || '',
      validUntil: req.body.validUntil || undefined,
      items: enriched,
      subtotal: +subtotal.toFixed(2),
      discountTotal: +discountTotal.toFixed(2),
      taxAmount: 0,
      total,
      createdBy: req.user._id,
    });

    // Enviar mensaje al chat con enlace
    const crypto = require('crypto');
    if (!quotation.shareToken) {
      quotation.shareToken = crypto.randomBytes(16).toString('hex');
      quotation.status = 'enviada';
      await quotation.save();
    }
    const base = process.env.PUBLIC_API_URL || `${req.protocol}://${req.get('host')}`;
    const pdfUrl = `${base}/api/quotations/public/${quotation.shareToken}/pdf`;
    const body =
      `Hola ${quotation.clientName || ''}, te enviamos la cotización ${quotation.quotationNumber} ` +
      `por un total de $${Number(quotation.total || 0).toFixed(2)}.\n${pdfUrl}`;

    const msg = await Message.create({
      clinic: req.clinicId,
      conversation: conv._id,
      direction: 'out',
      body,
      deliveryStatus: 'sent',
      sentBy: req.user._id,
      sentByName: req.user.name,
    });
    conv.lastMessageAt = msg.createdAt;
    conv.lastMessagePreview = body.slice(0, 140);
    conv.lastMessageDirection = 'out';
    await conv.save();
    emitToClinic(req.clinicId, 'chat:message', { conversationId: conv._id, message: msg });
    emitToClinic(req.clinicId, 'chat:updated', { id: conv._id });

    res.status(201).json({ quotation, pdfUrl, message: msg, conversation: conv });
  } catch (err) {
    res.status(500).json({ message: 'Error al crear cotización desde chat', error: err.message });
  }
};
