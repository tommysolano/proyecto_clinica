const mongoose = require('mongoose');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Patient = require('../models/Patient');
const User = require('../models/User');
const Appointment = require('../models/Appointment');
const Product = require('../models/Product');
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
 * - admin / supervisor_call_center: ven todas las conversaciones de la clínica.
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
  if (req.role === 'admin' || req.role === 'supervisor_call_center') return true;
  if (req.role === 'call_center') {
    // Puede mutar si está asignado a él o si todavía no tiene asignación.
    return !conv.assignedTo || String(conv.assignedTo) === String(req.user._id);
  }
  return false;
}

// =================== Conversaciones ===================

exports.listConversations = async (req, res) => {
  try {
    const { status, featured, opportunity, assigned, q, stage, agent } = req.query;
    const filter = buildVisibilityFilter(req);

    if (status) filter.status = status;
    if (featured === 'true') filter.isFeatured = true;
    if (opportunity === 'true') filter['opportunity.isOpportunity'] = true;
    if (stage) filter['opportunity.stage'] = stage;
    if (assigned === 'me') filter.assignedTo = req.user._id;
    if (assigned === 'unassigned') filter.assignedTo = null;
    if (agent && mongoose.isValidObjectId(agent)) filter.assignedTo = agent;

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
    if (!isSelfTake && req.role !== 'admin' && req.role !== 'supervisor_call_center' && !req.user.isSuperAdmin) {
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
    // TODO: aquí se llamaría a la API de WhatsApp Business para enviar realmente el mensaje.
    emitToClinic(req.clinicId, 'chat:message', { conversationId: conv._id, message: msg });
    res.status(201).json(msg);
  } catch (err) {
    res.status(500).json({ message: 'Error al enviar mensaje', error: err.message });
  }
};

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
      }
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
    res.status(201).json({ conversation: conv, message: msg });
  } catch (err) {
    res.status(500).json({ message: 'Error al simular mensaje', error: err.message });
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
    const { date, startTime, reason, services = [], clinic } = req.body;
    if (!date || !startTime) {
      return res.status(400).json({ message: 'Fecha y hora de inicio requeridas' });
    }

    // Normaliza 'YYYY-MM-DD' a fecha local-noon para que el filtro por día coincida.
    const parseLocalDate = (value) => {
      if (!value) return null;
      if (value instanceof Date) return value;
      const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0);
      return new Date(value);
    };
    const localDate = parseLocalDate(date);

    // Hydrate services snapshot
    let serviceItems = [];
    if (Array.isArray(services) && services.length) {
      const ids = services.map((s) => s.product).filter(Boolean);
      const products = ids.length ? await Product.find({ _id: { $in: ids } }) : [];
      const map = new Map(products.map((p) => [String(p._id), p]));
      serviceItems = services
        .filter((s) => s.product)
        .map((s) => {
          const p = map.get(String(s.product));
          return {
            product: s.product,
            name: p?.name || '',
            quantity: Number(s.quantity) || 1,
          };
        });
    }

    const appointment = await Appointment.create({
      clinic: clinic || req.clinicId,
      patient: conv.patient._id,
      date: localDate,
      startTime,
      reason: reason || conv.opportunity?.notes || `Cita desde chat ${conv.phone}`,
      services: serviceItems,
      status: 'pendiente',
      createdBy: req.user._id,
    });

    // Link to opportunity
    conv.opportunity = conv.opportunity || {};
    conv.opportunity.isOpportunity = true;
    conv.opportunity.stage = 'agendado';
    conv.opportunity.appointment = appointment._id;
    conv.opportunity.convertedAt = new Date();
    await conv.save();

    emitToClinic(req.clinicId, 'appointment:created', { id: appointment._id });
    emitToClinic(req.clinicId, 'chat:updated', { id: conv._id });

    res.status(201).json({ appointment, conversation: conv });
  } catch (err) {
    res.status(500).json({ message: 'Error al crear cita desde chat', error: err.message });
  }
};
