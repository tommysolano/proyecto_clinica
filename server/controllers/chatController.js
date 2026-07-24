const mongoose = require('mongoose');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Patient = require('../models/Patient');
const User = require('../models/User');
const Appointment = require('../models/Appointment');
const Product = require('../models/Product');
const Quotation = require('../models/Quotation');
const { emitToClinic, emitToUser, emitToCallCenter } = require('../realtime');
const messaging = require('../utils/messaging');
const { verifyMetaSignature } = require('../utils/metaWebhook');

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
    // Puede ADMINISTRAR (reasignar, editar, destacar, oportunidades, bloquear,
    // borrar) si está asignado a él o si todavía no tiene asignación.
    return !conv.assignedTo || String(conv.assignedTo) === String(req.user._id);
  }
  return false;
}

/**
 * ¿Puede este usuario RESPONDER (enviar mensajes) en esta conversación? El call
 * center comparte UNA sola bandeja: cualquier agente puede contestar cualquier
 * chat, esté asignado a quien esté (la asignación es un indicador de "quién lo
 * atiende", no un candado). Las acciones administrativas siguen restringidas por
 * canMutateConversation.
 *
 * Antes, enviar TEXTO exigía tener el chat asignado, pero enviar imágenes (send-
 * image) no: un agente veía el chat de un compañero y podía mandar la imagen pero
 * NO el texto ("No puedes enviar mensajes en esta conversación"). Este permiso
 * unifica el criterio: responder es de toda la bandeja.
 */
function canReplyConversation(req, conv) {
  if (req.user?.isSuperAdmin) return true;
  return ['admin', 'marketing', 'call_center'].includes(req.role);
}

// Expuestos para pruebas unitarias del modelo de permisos del chat.
exports.canMutateConversation = canMutateConversation;
exports.canReplyConversation = canReplyConversation;

// Clasifica un tipo MIME en la categoría de media de WhatsApp. Todo lo que no sea
// imagen/video/audio (PDF, Word, Excel, ZIP…) se envía como DOCUMENTO adjunto.
function mediaKindOf(mimeType) {
  const m = String(mimeType || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'document';
}

// Motivos por los que un envío se OMITE (no llegó a intentarse con el proveedor).
// Compartido por todas las rutas de envío para dar el mismo mensaje al agente.
const SEND_SKIP_REASONS = {
  blocked: 'Este contacto está bloqueado.',
  opt_out: 'Este paciente solicitó no recibir mensajes.',
  no_whatsapp_consent: 'Este paciente no tiene consentimiento de WhatsApp.',
  out_of_window: 'La ventana de 24h está cerrada. Usa una plantilla aprobada.',
  invalid_recipient: 'Destinatario inválido.',
  provider_unavailable: 'No hay un número de WhatsApp conectado para enviar. Revisa la conexión en Configuración del Call Center.',
};

// =================== Conversaciones ===================

exports.listConversations = async (req, res) => {
  try {
    const { status, featured, opportunity, assigned, q, stage, agent, unread, excludeFeatured } = req.query;
    const filter = buildVisibilityFilter(req);

    if (status) filter.status = status;
    if (featured === 'true') filter.isFeatured = true;
    // Los destacados viven en su propia pestaña: se excluyen del listado "Todos"
    // para que no anclen chats viejos sobre los de actividad reciente.
    if (excludeFeatured === 'true') filter.isFeatured = { $ne: true };
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
      .populate('patient', 'firstName lastName cedula phone whatsapp marketing')
      .populate('assignedTo', 'name email')
      .populate('whatsappAccount', 'label connectionType displayPhone connectedPhone')
      .sort({ lastMessageAt: -1 })
      .limit(300);

    // Tipo de conexión EFECTIVO por chat: el de su número, o el del número por
    // defecto si no tiene uno asignado. El front lo usa para saber si aplica la
    // ventana de 24h (los números QR no la tienen). Un solo query extra.
    const defaultType = await resolveDefaultConnectionType();
    const out = conversations.map((c) => decorateConversation(c.toObject(), defaultType));

    res.json(out);
  } catch (err) {
    res.status(500).json({ message: 'Error al listar conversaciones', error: err.message });
  }
};

// Tipo de conexión del número por defecto (cloud_api | qr). Se usa para los chats
// sin número asignado: así el front sabe si aplicarles la ventana de 24h.
async function resolveDefaultConnectionType() {
  try {
    const def = await require('../utils/whatsappGateway').getDefaultAccount();
    return def?.connectionType || 'cloud_api';
  } catch {
    return 'cloud_api';
  }
}

/**
 * Añade a una conversación ya serializada los datos DERIVADOS que necesita la UI:
 *   - `effectiveConnectionType`: el del número enlazado o, si no tiene (o el
 *     enlace apunta a un número BORRADO — `populate` devuelve null), el del
 *     número por defecto, que es justo al que caería el envío real.
 *   - `window`: estado de la ventana de 24h calculado en el servidor (ver
 *     `messaging.describeWhatsappWindow`). El navegador ya no la recalcula: una
 *     sola regla, imposible que las dos vistas discrepen.
 */
function decorateConversation(o, defaultType) {
  o.effectiveConnectionType = o.whatsappAccount?.connectionType || defaultType;
  o.window = messaging.describeWhatsappWindow(o, o.effectiveConnectionType);
  return o;
}

// Repuebla un documento de conversación con los campos que la UI necesita
// (paciente, agente, productos de la oportunidad). Se usa al devolver el conv
// tras una mutación para no perder los datos poblados en el cliente.
async function populateConversation(conv) {
  return conv.populate([
    { path: 'patient', select: 'firstName lastName cedula phone whatsapp email marketing tags' },
    { path: 'assignedTo', select: 'name email' },
    { path: 'featuredBy', select: 'name' },
    { path: 'whatsappAccount', select: 'label connectionType displayPhone connectedPhone' },
    { path: 'opportunity.appointment', select: 'date startTime status' },
    { path: 'opportunity.interestedIn.product', select: 'name salePrice' },
    { path: 'opportunities.interestedIn.product', select: 'name salePrice' },
  ]);
}

exports.getConversation = async (req, res) => {
  try {
    const conv = await Conversation.findOne({ _id: req.params.id, clinic: req.clinicId })
      .populate('patient', 'firstName lastName cedula phone whatsapp email marketing tags')
      .populate('assignedTo', 'name email')
      .populate('featuredBy', 'name')
      .populate('whatsappAccount', 'label connectionType displayPhone connectedPhone')
      .populate('opportunity.appointment', 'date startTime status')
      .populate('opportunity.interestedIn.product', 'name salePrice')
      .populate('opportunities.interestedIn.product', 'name salePrice');
    if (!conv) return res.status(404).json({ message: 'Conversación no encontrada' });
    res.json(decorateConversation(conv.toObject(), await resolveDefaultConnectionType()));
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener conversación', error: err.message });
  }
};

/**
 * Marca una conversación como leída: pone el contador de no leídos en 0 y marca
 * los entrantes como leídos, SIN necesidad de responder. Es un estado interno del
 * CRM (nunca se manda "visto" a WhatsApp), para poder quitar la notificación de un
 * chat que ya se atendió por otra vía.
 */
/**
 * Contadores de chats NO LEÍDOS para los badges del riel:
 *   - `mine`: chats sin leer asignados a mí.
 *   - `all`:  chats sin leer de toda la bandeja del call center.
 * Cuenta CONVERSACIONES (no mensajes), igual que el badge de Daplox.
 */
exports.unreadCounts = async (req, res) => {
  try {
    const base = { clinic: req.clinicId, unreadCount: { $gt: 0 } };
    const [all, mine] = await Promise.all([
      Conversation.countDocuments(base),
      Conversation.countDocuments({ ...base, assignedTo: req.user._id }),
    ]);
    res.json({ all, mine });
  } catch (err) {
    res.status(500).json({ message: 'Error al contar no leídos', error: err.message });
  }
};

exports.markConversationRead = async (req, res) => {
  try {
    const conv = await Conversation.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!conv) return res.status(404).json({ message: 'Conversación no encontrada' });
    // Marcar como visto es una acción de BANDEJA (baja el pendiente), no una acción
    // administrativa: cualquier agente con acceso al chat puede hacerlo, esté el
    // chat asignado a quien esté — igual que responder. Antes exigía ser el agente
    // asignado (canMutateConversation) y a los demás les rebotaba con 403.
    if (!canReplyConversation(req, conv)) {
      return res.status(403).json({ message: 'No tienes acceso a la bandeja de chats' });
    }
    conv.unreadCount = 0;
    await conv.save();
    await Message.updateMany(
      { conversation: conv._id, direction: 'in', isRead: false },
      { isRead: true }
    );
    emitToCallCenter('chat:updated', { id: conv._id });
    res.json({ ok: true, unreadCount: 0 });
  } catch (err) {
    res.status(500).json({ message: 'Error al marcar como leído', error: err.message });
  }
};

exports.createConversation = async (req, res) => {
  try {
    // Normalización fuerte a E.164 (0999… → 593999…): un chat nuevo debe quedar
    // con un número al que de verdad se pueda escribir por WhatsApp.
    const norm = require('../utils/phoneNormalize').normalizePhone(req.body.phone);
    if (!norm.ok) {
      return res.status(400).json({ message: `Teléfono inválido${norm.reason ? `: ${norm.reason}` : ''}` });
    }
    const phone = norm.phone;

    // Detectar duplicado
    let conv = await Conversation.findOne({ clinic: req.clinicId, phone });
    if (conv) {
      return res.status(200).json(conv);
    }

    // Vincular paciente si existe con ese teléfono (CRM global: en toda la organización).
    let patient = null;
    if (req.body.patient) {
      patient = await Patient.findById(req.body.patient);
    } else {
      patient = await Patient.findOne({
        phone: { $regex: phone.slice(-9) + '$' },
      });
    }

    conv = await Conversation.create({
      clinic: req.clinicId,
      phone,
      contactName:
        req.body.contactName ||
        (patient ? `${patient.firstName} ${patient.lastName}` : ''),
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

    const prevTags = new Set((conv.tags || []).map(String));
    const patientIdBefore = conv.patient?._id || conv.patient || null;
    const allowed = ['contactName', 'patient', 'status', 'tags'];
    allowed.forEach((k) => {
      if (req.body[k] !== undefined) conv[k] = req.body[k];
    });
    await conv.save();
    // Etiquetar desde el chat también dispara los workflows de 'tag_added'
    // (antes solo el etiquetado masivo de pacientes emitía el evento).
    if (Array.isArray(req.body.tags) && patientIdBefore) {
      const added = (conv.tags || []).filter((t) => !prevTags.has(String(t)));
      if (added.length) {
        const { emitDomainEvent, DOMAIN_EVENTS } = require('../utils/events');
        for (const tag of added) {
          emitDomainEvent(DOMAIN_EVENTS.TAG_ADDED, {
            clinicId: String(req.clinicId),
            patientId: String(patientIdBefore),
            tag,
          });
        }
      }
    }
    await populateConversation(conv);
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

// =================== Asistente IA: sugerir respuesta ===================

exports.suggestReply = async (req, res) => {
  try {
    const { suggestReply } = require('../utils/aiAssistant');
    const result = await suggestReply({ clinicId: req.clinicId, conversationId: req.params.id });
    if (!result.ok) return res.status(400).json({ message: result.reason });
    res.json({ suggestion: result.suggestion });
  } catch (err) {
    res.status(500).json({ message: 'Error al sugerir respuesta', error: err.message });
  }
};

exports.summarizeConversation = async (req, res) => {
  try {
    const { summarizeConversation } = require('../utils/aiAssistant');
    const result = await summarizeConversation({ clinicId: req.clinicId, conversationId: req.params.id });
    if (!result.ok) return res.status(400).json({ message: result.reason });
    res.json({ summary: result.summary });
  } catch (err) {
    res.status(500).json({ message: 'Error al resumir', error: err.message });
  }
};

// =================== Notas internas + @menciones ===================

exports.addInternalNote = async (req, res) => {
  try {
    const conv = await Conversation.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!conv) return res.status(404).json({ message: 'Conversación no encontrada' });
    const body = String(req.body.body || '').trim();
    if (!body) return res.status(400).json({ message: 'La nota está vacía' });
    const mentions = Array.isArray(req.body.mentions)
      ? req.body.mentions.filter((id) => mongoose.isValidObjectId(id))
      : [];
    const note = { author: req.user._id, authorName: req.user.name, body, mentions, at: new Date() };
    conv.internalNotes = [...(conv.internalNotes || []), note];
    await conv.save();
    // Notifica a los mencionados.
    for (const uid of mentions) {
      if (String(uid) !== String(req.user._id)) {
        emitToUser(uid, 'chat:mention', {
          conversationId: conv._id,
          by: req.user.name,
          preview: body.slice(0, 120),
        });
      }
    }
    res.status(201).json(conv.internalNotes[conv.internalNotes.length - 1]);
  } catch (err) {
    res.status(500).json({ message: 'Error al agregar nota', error: err.message });
  }
};

exports.listInternalNotes = async (req, res) => {
  try {
    const conv = await Conversation.findOne({ _id: req.params.id, clinic: req.clinicId })
      .select('internalNotes')
      .populate('internalNotes.author', 'name');
    if (!conv) return res.status(404).json({ message: 'Conversación no encontrada' });
    res.json(conv.internalNotes || []);
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

// =================== Auto-asignación round-robin ===================

/**
 * Devuelve el agente call_center con MENOS conversaciones abiertas asignadas.
 * Empata por el que tiene la asignación más antigua (reparto equitativo).
 */
async function pickRoundRobinAgent(clinicId) {
  // Call center único: cualquier agente call_center (de cualquier sucursal) entra
  // al reparto; se balancea por conversaciones abiertas en la bandeja (sede).
  const agents = await User.find({
    active: true,
    'clinics.role': 'call_center',
  }).select('_id name');
  if (!agents.length) return null;

  const counts = await Conversation.aggregate([
    { $match: { clinic: new mongoose.Types.ObjectId(clinicId), status: 'open', assignedTo: { $ne: null } } },
    { $group: { _id: '$assignedTo', count: { $sum: 1 } } },
  ]);
  const byAgent = new Map(counts.map((c) => [String(c._id), c.count]));
  agents.sort((a, b) => (byAgent.get(String(a._id)) || 0) - (byAgent.get(String(b._id)) || 0));
  return agents[0];
}

exports.autoAssign = async (req, res) => {
  try {
    const conv = await Conversation.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!conv) return res.status(404).json({ message: 'Conversación no encontrada' });
    const agent = await pickRoundRobinAgent(req.clinicId);
    if (!agent) return res.status(400).json({ message: 'No hay agentes de call center disponibles' });
    conv.assignedTo = agent._id;
    conv.assignedToName = agent.name;
    conv.assignedAt = new Date();
    await conv.save();
    emitToUser(agent._id, 'chat:assigned', { conversationId: conv._id });
    res.json(conv);
  } catch (err) {
    res.status(500).json({ message: 'Error al auto-asignar', error: err.message });
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
    const prevStage = op.isOpportunity ? op.stage : null;
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
    if (req.body.stage && req.body.stage !== prevStage) notifyOpportunityStage(conv, req.body.stage);
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

/**
 * Mantiene el espejo legacy `conv.opportunity` en sync con el array
 * `conv.opportunities`. El panel lateral, los listados y el embudo leen
 * `conv.opportunity`; sin esta sincronización las ediciones del array no se
 * reflejan en la UI ("se edita y no se guarda"). La oportunidad principal es la
 * más reciente (última del array).
 */
const syncPrimaryOpportunity = (conv) => {
  const list = Array.isArray(conv.opportunities) ? conv.opportunities : [];
  if (list.length === 0) {
    conv.opportunity = { isOpportunity: false, stage: 'nuevo' };
  } else {
    const primary = list[list.length - 1];
    conv.opportunity = primary?.toObject ? primary.toObject() : { ...primary };
  }
  conv.markModified('opportunity');
};

/**
 * Emite el evento de dominio "la oportunidad entró a la etapa X" para disparar
 * los workflows con trigger 'opportunity_stage'. Se llama SOLO cuando la etapa
 * cambió de verdad (o al crear una oportunidad nueva), no en cada guardado, para
 * no reinscribir de más. No pasa por el paso move_stage (evita cascadas).
 */
const notifyOpportunityStage = (conv, stage) => {
  if (!conv || !stage) return;
  try {
    const { emitDomainEvent, DOMAIN_EVENTS } = require('../utils/events');
    emitDomainEvent(DOMAIN_EVENTS.OPPORTUNITY_STAGE_CHANGED, {
      clinicId: String(conv.clinic),
      conversationId: String(conv._id),
      patientId: conv.patient ? String(conv.patient) : null,
      phone: conv.phone || '',
      stage,
    });
  } catch {
    /* la emisión nunca debe romper el guardado de la oportunidad */
  }
};

/**
 * Crea una marca INTERNA dentro del hilo (kind='event'): se muestra a los agentes
 * como un chip centrado y NUNCA se envía al contacto por WhatsApp. Se emite en vivo
 * para que aparezca en el chat de todo el equipo. No toca lastMessage* (no debe
 * mover la conversación en la lista ni cambiar la vista previa).
 */
async function createInternalEvent({ clinicId, conv, eventType, body, sentBy, sentByName }) {
  const msg = await Message.create({
    clinic: clinicId,
    conversation: conv._id,
    kind: 'event',
    eventType,
    body,
    sentBy: sentBy || null,
    sentByName: sentByName || '',
  });
  emitToCallCenter('chat:message', { conversationId: conv._id, message: msg });
  return msg;
}

// Texto legible del chip de "oportunidad creada" para el hilo.
function opportunityEventBody(opp) {
  const productos = (opp.interestedIn || []).map((i) => i.name).filter(Boolean).join(', ');
  const partes = [`Oportunidad creada${productos ? `: ${productos}` : ''}`];
  if (opp.expectedValue) partes.push(`$${Number(opp.expectedValue).toFixed(2)}`);
  partes.push(`etapa ${opp.stage}`);
  return partes.join(' · ');
}

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
      tags: Array.isArray(req.body.tags) ? req.body.tags.filter(Boolean) : [],
      createdAt: new Date(),
    };
    conv.opportunities = [...(conv.opportunities || []), opp];
    // Mantener compat: opportunity principal = última creada.
    syncPrimaryOpportunity(conv);
    await conv.save();
    // Marca interna en el hilo (visible solo para el equipo, no se envía al contacto).
    await createInternalEvent({
      clinicId: req.clinicId,
      conv,
      eventType: 'opportunity_created',
      body: opportunityEventBody(opp),
      sentBy: req.user._id,
      sentByName: req.user.name,
    }).catch(() => {});
    // Una oportunidad nueva entró a su etapa → dispara workflows 'opportunity_stage'.
    notifyOpportunityStage(conv, opp.stage);
    await populateConversation(conv);
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
    const prevStage = current.stage;
    if (Array.isArray(req.body.interestedIn)) {
      current.interestedIn = await enrichInterested(req.clinicId, req.body.interestedIn);
      current.expectedValue = await sumInterestedValue(req.clinicId, current.interestedIn);
    }
    if (req.body.stage) current.stage = req.body.stage;
    if (req.body.notes !== undefined) current.notes = req.body.notes;
    if (req.body.lostReason !== undefined) current.lostReason = req.body.lostReason;
    if (Array.isArray(req.body.tags)) current.tags = req.body.tags.filter(Boolean);
    if (req.body.stage === 'ganado' && !current.convertedAt) current.convertedAt = new Date();
    conv.opportunities[idx] = current;
    conv.markModified('opportunities');
    syncPrimaryOpportunity(conv);
    await conv.save();
    // Solo si la etapa cambió de verdad → dispara workflows 'opportunity_stage'.
    if (req.body.stage && req.body.stage !== prevStage) notifyOpportunityStage(conv, req.body.stage);
    await populateConversation(conv);
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
    syncPrimaryOpportunity(conv);
    await conv.save();
    await populateConversation(conv);
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

// ─────────── Carpetas de mensajes guardados (anidadas, tipo Windows) ───────────
// Rutas con '/' ("CITA/Recordatorios"). El registro persiste una carpeta aunque
// esté vacía, para poder crear subcarpetas antes de meterles mensajes.
const savedReplyFolders = require('../utils/folderCrud').makeFolderCrud({
  FolderModel: require('../models/SavedReplyFolder'),
  ItemModel: SavedReply,
  folderField: 'folder',
});
exports.listSavedReplyFolders = savedReplyFolders.list;
exports.createSavedReplyFolder = savedReplyFolders.create;
exports.deleteSavedReplyFolder = savedReplyFolders.remove; // DELETE ...?path=...

exports.listSavedReplies = async (req, res) => {
  try {
    // Más usados primero (el menú del chat muestra el top 4 por defecto).
    const list = await SavedReply.find({ clinic: req.clinicId }).sort({ usageCount: -1, shortcut: 1 });
    res.json(list);
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

/**
 * Marca un mensaje guardado como usado (ordena el menú por "más usados") y
 * devuelve el documento ACTUALIZADO.
 *
 * Devolverlo es lo que garantiza que el chat inserte la versión vigente: la
 * lista del chat se carga al abrir la página y se quedaba vieja, así que si un
 * agente le adjuntaba un video al mensaje guardado desde la otra pestaña, el
 * chat seguía insertando la copia SIN adjunto y el video no se enviaba (el
 * mensaje salía como texto pelado, sin ningún aviso).
 */
exports.markSavedReplyUsed = async (req, res) => {
  try {
    const updated = await SavedReply.findOneAndUpdate(
      { _id: req.params.id, clinic: req.clinicId },
      { $inc: { usageCount: 1 } },
      { new: true }
    );
    if (!updated) return res.status(404).json({ message: 'Mensaje guardado no encontrado' });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

// Normaliza el atajo: minúsculas, sin espacios ni caracteres raros. Si no se
// envía, se deriva del título/nombre (sin acentos) para que "/" siga funcionando.
function normalizeShortcut(shortcut, title) {
  const base = String(shortcut || title || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_-]/g, '');
  return base.slice(0, 40);
}

function normalizeAttachment(att) {
  if (!att || !att.url) return { url: '', type: '', name: '' };
  const type = ['image', 'video', 'document'].includes(att.type) ? att.type : 'document';
  return {
    url: String(att.url).trim(),
    type,
    name: String(att.name || '').trim().slice(0, 120),
  };
}

exports.createSavedReply = async (req, res) => {
  try {
    const { shortcut, title, body, shared, folder, attachment } = req.body;
    const cut = normalizeShortcut(shortcut, title);
    if (!cut || !body) return res.status(400).json({ message: 'Nombre/atajo y mensaje requeridos' });
    const reply = await SavedReply.create({
      clinic: req.clinicId,
      shortcut: cut,
      title: title || '',
      body,
      folder: String(folder || '').trim().slice(0, 60),
      attachment: normalizeAttachment(attachment),
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
    const patch = {};
    if (req.body.title !== undefined) patch.title = req.body.title;
    if (req.body.body !== undefined) patch.body = req.body.body;
    if (req.body.folder !== undefined) patch.folder = String(req.body.folder || '').trim().slice(0, 60);
    if (req.body.shared !== undefined) patch.shared = req.body.shared !== false;
    if (req.body.attachment !== undefined) patch.attachment = normalizeAttachment(req.body.attachment);
    if (req.body.shortcut !== undefined || req.body.title !== undefined) {
      const cut = normalizeShortcut(req.body.shortcut, req.body.title);
      if (cut) patch.shortcut = cut;
    }
    const r = await SavedReply.findOneAndUpdate(
      { _id: req.params.id, clinic: req.clinicId },
      patch,
      { new: true }
    );
    if (!r) return res.status(404).json({ message: 'No encontrado' });
    res.json(r);
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

/**
 * Sube un adjunto del chat (imagen, video o audio como data URL). Lo usan los
 * mensajes guardados, el editor de workflows y el compositor del chat (imágenes
 * pegadas del portapapeles y notas de voz). Se almacena en ChatGalleryImage
 * (mismo storage autoalojado que las cabeceras de plantilla) y devuelve la URL
 * pública /api/public/media/:id que entienden los gateways de WhatsApp (QR la
 * lee directo de Mongo; Cloud API la descarga).
 *
 * El audio se normaliza a ogg/opus: es el único formato que WhatsApp reproduce
 * como nota de voz y que Meta acepta (el navegador graba WebM, que no sirve).
 */
exports.uploadSavedReplyMedia = async (req, res) => {
  try {
    const { name } = req.body;
    let { dataUrl } = req.body;
    const parsed = require('../utils/dataUrl').parseDataUrl(dataUrl);
    if (!parsed) {
      return res.status(400).json({ message: 'Archivo inválido' });
    }
    // Clasifica por el tipo MIME: imagen/video/audio se envían como tales; TODO lo
    // demás (PDF, Word, Excel, ZIP…) se manda como DOCUMENTO adjunto.
    const kind = mediaKindOf(parsed.mimeType);
    // Topes en CARACTERES de data URL base64 (~1.33× el tamaño real del archivo).
    // El documento se guarda como base64 en Mongo (tope real de BSON 16MB), por eso
    // ~10MB de archivo — cubre PDFs/Office normales sin reventar el documento.
    const MAX_LEN = { video: 43_000_000, audio: 21_000_000, image: 8_000_000, document: 14_000_000 };
    const TOO_BIG = {
      video: 'Video demasiado grande (máx ~32MB)',
      audio: 'Audio demasiado grande (máx ~15MB)',
      image: 'Imagen demasiado grande (máx ~6MB)',
      document: 'Archivo demasiado grande (máx ~10MB)',
    };
    if (dataUrl.length > MAX_LEN[kind]) {
      return res.status(400).json({ message: TOO_BIG[kind] });
    }
    let mimeType = parsed.mimeType;
    if (kind === 'audio') {
      const conv = await require('../utils/audioTranscode').toWhatsappVoice(dataUrl);
      if (!conv.ok) return res.status(400).json({ message: conv.error });
      dataUrl = conv.dataUrl;
      mimeType = conv.mimeType;
    } else {
      // Cabecera SIEMPRE limpia (`data:<mime>;base64,…`). El navegador puede meter
      // parámetros en el tipo (codecs, charset) y eso rompe a quien luego lee el
      // adjunto por su URL pública. El contenido no se toca.
      dataUrl = `data:${mimeType};base64,${parsed.b64}`;
    }
    const img = await ChatGalleryImageModel().create({
      clinic: req.clinicId,
      name: name || `adjunto_${Date.now()}`,
      dataUrl,
      mimeType,
      size: dataUrl.length,
      createdBy: req.user._id,
    });
    res.status(201).json({ id: img._id, url: publicMediaUrl(req, img._id), type: kind, name: img.name });
  } catch (err) {
    res.status(500).json({ message: 'Error al subir adjunto', error: err.message });
  }
};

// Carga diferida para no mover el require existente de más abajo.
function ChatGalleryImageModel() {
  return require('../models/ChatGalleryImage');
}

// ============ Automatizaciones desde el chat (disparo manual) ============

/**
 * Lista las automatizaciones ACTIVAS con sus flujos (nodos disparadores) para
 * el menú del chat: si el disparo automático no salió (p.ej. la cita se agendó
 * antes de crear el workflow), el agente puede ejecutar el flujo a mano.
 */
exports.listWorkflowsForChat = async (req, res) => {
  try {
    const Workflow = require('../models/Workflow');
    // Más usadas primero (stats.enrolled): el menú muestra el top 4 por defecto.
    const list = await Workflow.find({ clinic: req.clinicId, active: true })
      .select('name folder nodes edges triggers trigger stats')
      .sort({ 'stats.enrolled': -1, name: 1 })
      .lean();
    const out = list
      .map((wf) => {
        const triggerNodes = (wf.nodes || []).filter((n) => n.type === 'trigger');
        const flows = triggerNodes.length
          ? triggerNodes
              .filter((tn) => (wf.edges || []).some((e) => e.source === tn.id)) // sin pasos = nada que ejecutar
              .map((tn) => ({
                startNodeId: tn.id,
                triggerTypes: ((tn.data?.triggers?.length ? tn.data.triggers : wf.triggers) || [])
                  .map((t) => t.type)
                  .filter(Boolean),
              }))
          : [{ startNodeId: null, triggerTypes: (wf.triggers || []).map((t) => t.type).filter(Boolean) }];
        return { _id: wf._id, name: wf.name, folder: wf.folder || 'General', used: wf.stats?.enrolled || 0, flows };
      })
      .filter((w) => w.flows.length > 0);
    res.json(out);
  } catch (err) {
    res.status(500).json({ message: 'Error al listar automatizaciones', error: err.message });
  }
};

/**
 * Ejecuta manualmente un flujo de una automatización para ESTE chat.
 * body: { workflowId, startNodeId? } (startNodeId identifica el flujo cuando el
 * diagrama tiene varios). Si el paciente tiene una PRÓXIMA cita, se pone en el
 * contexto para que las variables de cita y los "esperar hasta la cita"
 * funcionen igual que en el disparo automático.
 */
exports.runWorkflowManually = async (req, res) => {
  try {
    const conv = await Conversation.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!conv) return res.status(404).json({ message: 'Conversación no encontrada' });
    const Workflow = require('../models/Workflow');
    const WorkflowEnrollment = require('../models/WorkflowEnrollment');
    const workflowEngine = require('../utils/workflowEngine');
    const wf = await Workflow.findOne({ _id: req.body.workflowId, clinic: req.clinicId });
    if (!wf) return res.status(404).json({ message: 'Automatización no encontrada' });
    if (!wf.active) return res.status(400).json({ message: 'La automatización está pausada: actívala primero.' });

    // Flujo a ejecutar (nodo disparador). Workflows lineales no tienen nodos.
    let flow = { startNodeId: null, currentNodeId: null };
    if ((wf.nodes || []).length) {
      const tn = (wf.nodes || []).find(
        (n) => n.type === 'trigger' && (!req.body.startNodeId || n.id === req.body.startNodeId)
      );
      const startChild = tn ? workflowEngine.nextNodeId(wf, tn.id) : null;
      if (!startChild) return res.status(400).json({ message: 'El flujo indicado no tiene pasos.' });
      flow = { startNodeId: tn.id, currentNodeId: startChild };
    }

    // Evitar doble ejecución simultánea del mismo flujo en este chat.
    const live = await WorkflowEnrollment.findOne({
      workflow: wf._id,
      conversation: conv._id,
      startNodeId: flow.startNodeId,
      status: { $in: ['active', 'waiting'] },
    });
    if (live) {
      return res.status(409).json({ message: 'Este chat ya tiene esa automatización en ejecución o en espera.' });
    }

    const patient = conv.patient ? await Patient.findById(conv.patient) : null;
    let appt = null;
    if (patient) {
      const { startOfToday } = require('../utils/appointmentDate');
      appt = await Appointment.findOne({
        patient: patient._id,
        status: { $in: ['pendiente', 'confirmada'] },
        date: { $gte: startOfToday() },
      }).sort({ date: 1, startTime: 1 });
    }
    const { appointmentDateTime } = require('../utils/appointmentDate');
    const enrollment = await WorkflowEnrollment.create({
      clinic: req.clinicId,
      workflow: wf._id,
      patient: patient?._id || null,
      conversation: conv._id,
      stepIndex: 0,
      currentNodeId: flow.currentNodeId,
      startNodeId: flow.startNodeId,
      status: 'active',
      nextRunAt: new Date(),
      context: {
        phone: conv.phone,
        conversationId: String(conv._id),
        eventType: 'manual', // no bloquea el dedup por (cita, evento) de los disparos automáticos
        ...(appt
          ? {
              appointmentId: String(appt._id),
              appointmentDate: appointmentDateTime(appt.date, appt.startTime),
              eventClinicId: String(appt.clinic),
            }
          : {}),
      },
    });
    await Workflow.updateOne({ _id: wf._id }, { $inc: { 'stats.enrolled': 1 } });
    try {
      const patientName = patient
        ? `${patient.firstName || ''} ${patient.lastName || ''}`.trim()
        : conv.contactName || conv.phone;
      require('../models/WorkflowTriggerEvent')
        .create({
          clinic: req.clinicId,
          workflow: wf._id,
          patient: patient?._id || null,
          patientName,
          eventType: 'manual',
          decision: 'enrolled',
          detail: `Disparada manualmente por ${req.user?.name || 'un agente'} desde el chat.`,
        })
        .catch(() => {});
    } catch {
      /* noop */
    }
    await workflowEngine.executeEnrollment(enrollment).catch(() => {});
    // Devolver el primer fallo del log (si lo hubo) para que el agente vea al
    // instante por qué no salió (ventana 24h, QR desconectado, sin teléfono…).
    const fresh = await WorkflowEnrollment.findById(enrollment._id).lean();
    const failed = (fresh?.log || []).find((l) => l.ok === false);
    res.json({ ok: true, status: fresh?.status || 'active', warning: failed?.info || '' });
  } catch (err) {
    res.status(500).json({ message: 'Error al ejecutar la automatización', error: err.message });
  }
};

/**
 * Envío de prueba de un fragmento (como el "fragmento de prueba" de Daplox):
 * manda el texto + adjunto al número indicado por el WhatsApp por defecto.
 * No requiere que el fragmento esté guardado: recibe el contenido directo.
 */
exports.testSavedReply = async (req, res) => {
  try {
    const { phone, body, attachment } = req.body;
    const digits = String(phone || '').replace(/[^\d]/g, '');
    if (!digits || digits.length < 8) return res.status(400).json({ message: 'Número de teléfono inválido' });
    const att = normalizeAttachment(attachment);
    if (!String(body || '').trim() && !att.url) {
      return res.status(400).json({ message: 'El fragmento está vacío' });
    }
    const result = await messaging.send({
      clinicId: req.clinicId,
      channel: 'whatsapp',
      to: digits,
      body: String(body || ''),
      mediaUrl: att.url || null,
      mediaType: att.type || null,
      ignoreOptOut: true, // es una prueba a un número propio
      sentBy: req.user._id,
      sentByName: req.user.name,
    });
    if (result.skipped) {
      const reasons = {
        out_of_window: 'La ventana de 24h con ese número está cerrada (Cloud API). Escríbete primero desde ese número o usa un número QR.',
        provider_unavailable: 'No hay ningún número de WhatsApp configurado.',
        invalid_recipient: 'Número inválido.',
        blocked: 'Ese contacto está bloqueado.',
      };
      return res.status(409).json({ message: reasons[result.reason] || 'No se pudo enviar la prueba.', code: result.reason });
    }
    if (result.deliveryStatus === 'failed') {
      return res.status(502).json({ message: result.errorMessage || 'El proveedor rechazó el envío' });
    }
    res.json({ ok: true, deliveryStatus: result.deliveryStatus });
  } catch (err) {
    res.status(500).json({ message: 'Error al enviar prueba', error: err.message });
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
      await messaging.send({
        clinicId,
        channel: conv.channel || 'whatsapp',
        conversation: conv,
        to: conv.phone,
        patient: conv.patient,
        body: rule.body,
        isAutoReply: true,
      });

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
  return messaging.send({
    clinicId,
    channel: conv.channel || 'whatsapp',
    conversation: conv,
    to: conv.phone,
    patient: conv.patient,
    body,
    isAutoReply: true,
  });
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
  emitToCallCenter('chat:opportunity', { conversationId: conv._id });
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

/**
 * URL pública (sin auth) que sirve los BYTES de una imagen de la galería por id
 * (mediaController.serve decodifica el data URL). La usa el <img> de la galería
 * para mostrar la MINIATURA REAL en vez de un icono genérico (el listado no trae
 * el dataUrl, que es pesado), y también Meta para las cabeceras de plantilla.
 */
function publicMediaUrl(req, id) {
  let base = process.env.PUBLIC_API_URL || `${req.protocol}://${req.get('host')}/api`;
  base = base.replace(/\/+$/, '').replace(/\/api$/, '');
  return `${base}/api/public/media/${id}`;
}

exports.listGallery = async (req, res) => {
  try {
    // No se trae el dataUrl (pesa MBs): el <img> carga la miniatura por `url`.
    const list = await ChatGalleryImage.find({ clinic: req.clinicId })
      .select('name mimeType size createdAt')
      .sort({ createdAt: -1 })
      .lean();
    res.json(list.map((g) => ({ ...g, url: publicMediaUrl(req, g._id) })));
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

exports.uploadGallery = async (req, res) => {
  try {
    const { name, dataUrl } = req.body;
    // Parseo tolerante (el tipo puede traer parámetros) y cabecera normalizada al
    // guardar, para que el adjunto siempre se pueda servir por su URL pública.
    const parsed = require('../utils/dataUrl').parseDataUrl(dataUrl);
    if (!parsed || !/^image\/(png|jpe?g|webp|gif)$/.test(parsed.mimeType)) {
      return res.status(400).json({ message: 'Imagen inválida' });
    }
    if (dataUrl.length > 8_000_000) {
      return res.status(400).json({ message: 'Imagen demasiado grande (máx ~6MB)' });
    }
    const img = await ChatGalleryImage.create({
      clinic: req.clinicId,
      name: name || `imagen_${Date.now()}`,
      dataUrl: `data:${parsed.mimeType};base64,${parsed.b64}`,
      mimeType: parsed.mimeType,
      size: dataUrl.length,
      createdBy: req.user._id,
    });
    res.status(201).json({ _id: img._id, name: img.name, mimeType: img.mimeType, size: img.size, url: publicMediaUrl(req, img._id) });
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
    if (!canReplyConversation(req, conv)) {
      return res.status(403).json({ message: 'No puedes enviar mensajes en esta conversación' });
    }
    if (conv.blocked) return res.status(403).json({ message: 'Este contacto está bloqueado.' });
    const img = await ChatGalleryImage.findOne({ _id: req.body.imageId, clinic: req.clinicId }).select('_id name mimeType');
    if (!img) return res.status(404).json({ message: 'Imagen no encontrada' });

    // La media se envía DE VERDAD por el proveedor (Cloud la sube a Meta por id,
    // QR por bytes) usando su URL pública. BUG anterior: esta ruta SOLO creaba el
    // mensaje en la BD (deliveryStatus por defecto 'sent') y NUNCA contactaba a
    // WhatsApp — la imagen se veía "enviada" pero jamás le llegaba al contacto.
    const mime = String(img.mimeType || '');
    const kind = mime.startsWith('video') ? 'video' : mime.startsWith('audio') ? 'audio' : 'image';
    const result = await messaging.send({
      clinicId: req.clinicId,
      channel: conv.channel || 'whatsapp',
      conversation: conv,
      to: conv.phone,
      patient: conv.patient,
      body: (req.body.caption || '').toString().trim(),
      mediaUrl: publicMediaUrl(req, img._id),
      mediaType: kind,
      sentBy: req.user._id,
      sentByName: req.user.name,
    });

    if (result.skipped) {
      return res.status(409).json({
        message: SEND_SKIP_REASONS[result.reason] || 'El mensaje fue omitido.',
        code: result.reason,
      });
    }
    // El proveedor rechazó la media (QR desconectado, Meta la rechazó, muy grande):
    // NUNCA 201 "enviado". El mensaje queda FALLIDO con su motivo y el front lo
    // muestra en rojo con "Reintentar".
    if (!result.ok) {
      return res.status(502).json({
        message: result.errorMessage || 'No se pudo enviar la imagen: el proveedor de WhatsApp la rechazó.',
        code: result.errorCode || 'send_failed',
        deliveryStatus: result.deliveryStatus || 'failed',
        chatMessage: result.message,
      });
    }
    if (!conv.assignedTo) {
      conv.assignedTo = req.user._id;
      conv.assignedToName = req.user.name;
      conv.assignedAt = new Date();
      await conv.save();
    }
    res.status(201).json(result.message);
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
      .populate('patient', 'firstName lastName cedula phone whatsapp marketing')
      .sort({ lastMessageAt: -1 })
      .limit(500);

    // Aplanar para devolver una oportunidad por fila. OJO: `opportunity` es el
    // ESPEJO de la última del array — si hay array, usar SOLO el array (antes se
    // sumaban ambos y la oportunidad principal salía duplicada en el embudo).
    const rows = [];
    for (const c of list) {
      const opps = [];
      if (Array.isArray(c.opportunities) && c.opportunities.length) opps.push(...c.opportunities);
      else if (c.opportunity?.isOpportunity) opps.push(c.opportunity);
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
          // Anuncio del que nació la oportunidad (una por anuncio).
          adId: op.attribution?.adId || '',
          adCampaign: op.attribution?.campaign || '',
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
    }).populate('patient', 'firstName lastName phone whatsapp marketing');
    let sent = 0;
    let failed = 0;
    let skipped = 0;
    const results = [];
    for (const c of convs) {
      // eslint-disable-next-line no-await-in-loop
      const result = await messaging.send({
        clinicId: req.clinicId,
        channel: c.channel || 'whatsapp',
        conversation: c,
        to: c.phone,
        patient: c.patient,
        body: String(body).trim(),
        sentBy: req.user._id,
        sentByName: req.user.name,
      });
      if (result.skipped) skipped++;
      else if (result.ok) sent++;
      else failed++;
      results.push({
        conversationId: c._id,
        ok: !!result.ok,
        skipped: !!result.skipped,
        reason: result.reason || '',
        deliveryStatus: result.deliveryStatus || '',
        errorCode: result.errorCode || '',
        errorMessage: result.errorMessage || '',
      });
    }
    res.json({
      total: convs.length,
      requested: conversationIds.length,
      sent,
      failed,
      skipped,
      results,
    });
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
    // A propósito NO se marca como leído al abrir el chat: la notificación de
    // "no leído" debe permanecer hasta que el agente RESPONDA (ver messaging.send
    // y sendGalleryImage). Así, si el agente lee un mensaje y salta a otro chat,
    // el pendiente sigue visible y no se pierde entre tantas conversaciones.
    res.json(messages);
  } catch (err) {
    res.status(500).json({ message: 'Error al listar mensajes', error: err.message });
  }
};

// Resumen del mensaje citado. `who` (contacto) se pasa aparte porque el mensaje
// entrante no guarda el nombre del remitente. Devuelve null si no aplica.
function replySnapshotFrom(quoted, contactName) {
  if (!quoted) return null;
  const senderName =
    quoted.direction === 'out'
      ? quoted.sentByName || (quoted.isAutoReply ? 'Automático' : 'Equipo')
      : contactName || 'Contacto';
  let body = quoted.body || '';
  if (!body && quoted.mediaType) body = `[${quoted.mediaType}]`;
  return {
    message: quoted._id,
    externalId: quoted.externalId || '',
    direction: quoted.direction,
    senderName,
    body: String(body).slice(0, 300),
    mediaType: quoted.mediaType || '',
  };
}

// Carga el mensaje citado (por id) validando que sea de ESTA conversación.
async function buildReplySnapshot(replyToId, conv) {
  if (!replyToId) return null;
  const quoted = await Message.findOne({
    _id: replyToId,
    conversation: conv._id,
    clinic: conv.clinic,
  }).select('body direction externalId mediaType sentByName isAutoReply');
  if (!quoted) return null;
  return replySnapshotFrom(quoted, conv.contactName);
}

exports.sendMessage = async (req, res) => {
  try {
    const conv = await Conversation.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!conv) return res.status(404).json({ message: 'Conversación no encontrada' });
    // Responder es de toda la bandeja compartida (no exige tener el chat asignado);
    // así funciona igual que enviar una imagen. Ver canReplyConversation.
    if (!canReplyConversation(req, conv)) {
      return res.status(403).json({ message: 'No puedes enviar mensajes en esta conversación' });
    }
    if (conv.blocked) {
      return res.status(403).json({ message: 'Este contacto está bloqueado.' });
    }

    const outboundBody = (req.body.body || '').toString().trim();
    const templateName = String(
      req.body.templateName || req.body.template?.name || req.body.template || ''
    ).trim();
    if (!outboundBody && !req.body.mediaUrl && !templateName) {
      return res.status(400).json({ message: 'Mensaje vacío' });
    }

    // Responder a un mensaje específico (cita estilo WhatsApp): se resuelve el
    // mensaje original de ESTA conversación y se arma el snapshot que se persiste
    // y se muestra en la burbuja; su wamid viaja a WhatsApp como `context`.
    const replyTo = await buildReplySnapshot(req.body.replyTo, conv);

    // Todo envío saliente pasa por la puerta única (ventana 24h, opt-out, registro de estado).
    const result = await messaging.send({
      clinicId: req.clinicId,
      channel: conv.channel || 'whatsapp',
      conversation: conv,
      to: conv.phone,
      patient: conv.patient,
      body: outboundBody,
      mediaUrl: req.body.mediaUrl || null,
      mediaType: req.body.mediaType || null,
      mediaName: req.body.mediaName || '',
      mediaSize: req.body.mediaSize || 0,
      replyTo,
      template: templateName
        ? {
            name: templateName,
            language: req.body.templateLanguage || req.body.language || 'es',
            vars: req.body.templateVars || req.body.vars || [],
          }
        : null,
      sentBy: req.user._id,
      sentByName: req.user.name,
    });

    if (result.skipped) {
      return res.status(409).json({
        message: SEND_SKIP_REASONS[result.reason] || 'El mensaje fue omitido.',
        code: result.reason,
      });
    }

    // El proveedor RECHAZÓ el envío (QR desconectado, error de Meta, etc.): el
    // mensaje quedó como FALLIDO. NUNCA devolver 201 "enviado" en este caso: el
    // agente DEBE saber que el mensaje NO llegó (antes se devolvía 201 y el chat
    // lo mostraba como enviado — peligroso: "dice enviado y nunca llega"). El
    // mensaje fallido igual queda en el chat (por socket) con su motivo.
    if (!result.ok) {
      console.warn(
        '[sendMessage] envío FALLIDO conv=%s user=%s code=%s msg=%s',
        String(conv._id), String(req.user?._id), result.errorCode || '', result.errorMessage || ''
      );
      return res.status(502).json({
        message: result.errorMessage || 'No se pudo enviar el mensaje: el proveedor de WhatsApp lo rechazó.',
        code: result.errorCode || 'send_failed',
        deliveryStatus: result.deliveryStatus || 'failed',
        chatMessage: result.message,
      });
    }

    if (!conv.assignedTo) {
      conv.assignedTo = req.user._id;
      conv.assignedToName = req.user.name;
      conv.assignedAt = new Date();
      await conv.save();
    }

    return res.status(201).json(result.message);
  } catch (err) {
    res.status(500).json({ message: 'Error al enviar mensaje', error: err.message });
  }
};

/**
 * GET /chats/accounts — números (globales) conectados, para el selector
 * "responder desde" del chat. Sólo campos no sensibles (sin tokens ni secretos).
 */
exports.listChatAccounts = async (req, res) => {
  try {
    const WhatsappAccount = require('../models/WhatsappAccount');
    const accounts = await WhatsappAccount.find({ enabled: true })
      .select('label connectionType displayPhone connectedPhone status isDefault')
      .sort({ isDefault: -1, createdAt: 1 })
      .lean();
    res.json(accounts);
  } catch (e) {
    res.status(500).json({ message: 'Error al listar números', error: e.message });
  }
};

/**
 * PATCH /chats/:id/account — fija por qué número (global) se responde ESTA
 * conversación. Normalmente el número se enlaza SOLO al recibir (por eso se puede
 * responder desde el mismo número al que el contacto escribió); esto permite
 * corregirlo o elegirlo a mano.
 */
exports.setConversationAccount = async (req, res) => {
  try {
    const conv = await Conversation.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!conv) return res.status(404).json({ message: 'Conversación no encontrada' });
    if (!canReplyConversation(req, conv)) {
      return res.status(403).json({ message: 'No puedes cambiar el número de esta conversación' });
    }
    const WhatsappAccount = require('../models/WhatsappAccount');
    if (!mongoose.isValidObjectId(req.body.whatsappAccountId)) {
      return res.status(400).json({ message: 'Número no válido' });
    }
    const acc = await WhatsappAccount.findOne({ _id: req.body.whatsappAccountId, enabled: true });
    if (!acc) return res.status(400).json({ message: 'Número no válido o deshabilitado' });
    conv.whatsappAccount = acc._id;
    await conv.save();
    const populated = await Conversation.findById(conv._id)
      .populate('whatsappAccount', 'label connectionType displayPhone connectedPhone')
      .lean();
    populated.effectiveConnectionType = populated.whatsappAccount?.connectionType || 'cloud_api';
    emitToCallCenter('chat:conversation:updated', { conversationId: conv._id, whatsappAccount: populated.whatsappAccount });
    res.json(populated);
  } catch (e) {
    res.status(500).json({ message: 'Error al cambiar el número', error: e.message });
  }
};

/**
 * Envío externo legacy — DESHABILITADO. Toda la mensajería saliente pasa ahora
 * por la puerta única en utils/messaging.js. Se conserva la firma sólo para
 * referencia histórica; no se invoca desde ningún flujo.
 */
async function legacyExternalSendDisabled({ conv, msg, clinicId }) {
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
    const statuses = [];
    if (Array.isArray(req.body.entry)) {
      req.body.entry.forEach((entry) => {
        (entry.changes || []).forEach((change) => {
          const value = change.value || {};
          (value.statuses || []).forEach((s) => statuses.push(s));
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

    const signature = await validateMetaWebhookRequest(req, clinicId, 'whatsapp');
    if (!signature.ok) {
      return res.status(403).json({ message: 'Firma invalida', code: signature.reason });
    }

    const statusUpdates = await processMetaStatuses(clinicId, statuses);
    for (const ev of events) {
      // eslint-disable-next-line no-await-in-loop
      await ingestExternalMessage({
        clinicId,
        channel: 'whatsapp',
        phone: ev.phone,
        externalUserId: ev.phone,
        body: ev.body || '',
        contactName: ev.contactName,
        externalId: ev.externalId,
      });
    }
    return res.status(200).json({ received: events.length, statusUpdates });
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
    conv.lastInboundAt = msg.createdAt;
    conv.window24hExpiresAt = messaging.computeWhatsappWindowExpiresAt(msg.createdAt);
    conv.unreadCount = (conv.unreadCount || 0) + 1;
    if (conv.status === 'closed') conv.status = 'open';
    await conv.save();

    emitToCallCenter('chat:message', { conversationId: conv._id, message: msg });
    const optedOut = await applyIncomingOptOut({
      clinicId: req.clinicId,
      conv,
      incomingText: body,
    });
    if (!optedOut) {
      await require('../utils/workflowEngine')
        .resumeOnReply({ clinicId: req.clinicId, patientId: conv.patient, phone: conv.phone, text: body })
        .catch(() => {});
      await triggerFlows({
        conv,
        clinicId: req.clinicId,
        isNewConversation,
        incomingText: body,
      });
    }

    return res.status(201).json({ conversation: conv, message: msg });
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

async function validateMetaWebhookRequest(req, clinicId, channel) {
  const cfg = await getChannelConfig(clinicId, channel);
  const { decryptSecret } = require('../utils/secretCrypto');
  return verifyMetaSignature({
    rawBody: req.rawBody || req.body,
    signature: req.headers['x-hub-signature-256'],
    appSecret: cfg?.appSecret ? decryptSecret(cfg.appSecret) : '',
  });
}

function normalizeMetaStatus(status) {
  const err = (status.errors || [])[0] || {};
  return {
    externalId: status.id,
    status: status.status,
    timestamp: status.timestamp,
    errorCode: err.code || err.error_subcode,
    errorMessage: err.title || err.message || err.error_data?.details || '',
  };
}

async function processMetaStatuses(clinicId, statuses = []) {
  let updated = 0;
  for (const status of statuses) {
    const normalized = normalizeMetaStatus(status);
    // eslint-disable-next-line no-await-in-loop
    const result = await messaging.updateMessageStatus({ clinicId, ...normalized });
    if (result.ok) updated++;
  }
  return updated;
}

async function findPatientForIncoming(clinicId, phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  const tail = normalized.slice(-9);
  // CRM global: vincula al paciente esté en la sucursal que esté.
  return Patient.findOne({
    $or: [
      { phone: { $regex: `${tail}$` } },
      { whatsapp: { $regex: `${tail}$` } },
    ],
  });
}

async function applyIncomingOptOut({ clinicId, conv, incomingText }) {
  if (!messaging.isOptOutText(incomingText)) return false;
  const patientId = conv.patient?._id || conv.patient;
  const patient = conv.patient
    ? await Patient.findById(patientId)
    : await findPatientForIncoming(clinicId, conv.phone);
  if (patient) {
    patient.marketing = {
      ...(patient.marketing?.toObject ? patient.marketing.toObject() : patient.marketing || {}),
      whatsappOptIn: false,
      optOutAt: new Date(),
      optOutReason: 'keyword',
    };
    await patient.save();
    if (!conv.patient) {
      conv.patient = patient._id;
      await conv.save();
    }
    emitToClinic(clinicId, 'patient:updated', { id: patient._id });
  }
  await messaging.send({
    clinicId,
    channel: conv.channel || 'whatsapp',
    conversation: conv,
    to: conv.phone,
    patient,
    body: 'Hemos registrado tu baja. No volveremos a enviarte mensajes promocionales.',
    isAutoReply: true,
    ignoreOptOut: true,
  });
  return true;
}

/**
 * Texto legible para los mensajes de WhatsApp que NO son texto ni media
 * (ubicación, tarjeta de contacto, reacción, pedido, o un tipo que Meta aún no
 * documenta). Sin esto se creaba una burbuja COMPLETAMENTE VACÍA en el chat: el
 * agente veía un hueco y no sabía que el paciente le había mandado algo.
 */
function describeNonMediaMessage(m) {
  if (m.location) {
    const name = m.location.name || m.location.address || '';
    return `📍 Ubicación${name ? `: ${name}` : ''}`;
  }
  if (Array.isArray(m.contacts) && m.contacts.length) {
    const who = m.contacts
      .map((c) => c.name?.formatted_name || c.name?.first_name || '')
      .filter(Boolean)
      .join(', ');
    return `👤 Contacto compartido${who ? `: ${who}` : ''}`;
  }
  if (m.reaction) return `${m.reaction.emoji || '👍'} (reacción a un mensaje)`;
  if (m.order) return '🛒 Pedido del catálogo';
  if (m.system?.body) return m.system.body;
  if (m.type === 'unsupported' || m.errors?.length) {
    return '(mensaje que WhatsApp no permite mostrar aquí — míralo en el teléfono)';
  }
  return '';
}

// Texto corto para la bandeja cuando el mensaje es solo media (sin pie).
function mediaPreviewText(type, name) {
  const labels = {
    image: '📷 Foto',
    video: '🎬 Video',
    audio: '🎤 Nota de voz',
    document: '📄 Documento',
    sticker: '🌟 Sticker',
  };
  const base = labels[type] || (type ? '📎 Adjunto' : '');
  return name && type === 'document' ? `${base} · ${name}` : base;
}

/**
 * Ingresa un mensaje SALIENTE que se envió desde el teléfono (número QR),
 * FUERA de nuestro sistema. whatsapp-web.js lo entrega por `message_create` con
 * `fromMe=true`; así el historial del CRM refleja también lo que el agente
 * contestó directo desde WhatsApp en el celular.
 *
 * Dedup: los mensajes que ESTE sistema envió también disparan `message_create`.
 * Se descartan (a) por `externalId` (wamid ya guardado) y (b) por un saliente
 * reciente con el mismo texto (nuestro envío puede no haber guardado aún el
 * wamid cuando llega el evento).
 */
async function ingestExternalOutbound({ clinicId, account, externalUserId, phone, body, media, externalId, contactName }) {
  const normalizedPhone = normalizePhone(phone || externalUserId);
  if (!normalizedPhone) return;
  // (a) ¿Ya lo tenemos por su wamid?
  if (externalId) {
    const dup = await Message.findOne({ clinic: clinicId, externalId, direction: 'out' }).select('_id');
    if (dup) return;
  }
  // Número oculto (@lid): casar por el JID estable (su `phone` es el número real ya
  // resuelto, que puede diferir del identificador del LID). Si no, por teléfono.
  const isLidJid = typeof externalUserId === 'string' && externalUserId.endsWith('@lid');
  let conv = isLidJid
    ? await Conversation.findOne({ clinic: clinicId, channel: 'whatsapp', externalUserId })
    : null;
  if (!conv) conv = await Conversation.findOne({ clinic: clinicId, channel: 'whatsapp', phone: normalizedPhone });
  // Sin conversación previa no creamos una desde un saliente del teléfono: sería
  // un chat que el agente inició fuera del CRM y del que no tenemos contexto.
  if (!conv) return;

  let mediaUrl = null;
  let mediaType = null;
  let mediaName = '';
  let mediaSize = 0;
  let mediaError = '';
  let finalBody = body || '';
  if (media) {
    mediaName = String(media.filename || '').slice(0, 200);
    // El tipo se conserva aunque la descarga falle (ver ingestExternalMessage).
    mediaType = media.type || null;
    mediaSize = Number(media.size) || 0;
    if (media.dataUrl) mediaUrl = media.dataUrl;
    else if (media.unavailable) {
      mediaError = String(media.error || 'No se pudo descargar el archivo de WhatsApp.').slice(0, 300);
    }
    if (!finalBody) finalBody = media.caption || '';
  }

  // (b) Dedup por texto reciente: un saliente idéntico creado por nuestro envío
  // en los últimos 40s (aún sin wamid) es el mismo mensaje, no uno del teléfono.
  const since = new Date(Date.now() - 40 * 1000);
  const recentSame = await Message.findOne({
    clinic: clinicId,
    conversation: conv._id,
    direction: 'out',
    createdAt: { $gte: since },
    ...(finalBody ? { body: finalBody } : { mediaType: mediaType || null }),
  }).select('_id');
  if (recentSame) {
    // Es nuestro envío: aprovechamos para respaldar el wamid si no lo tenía.
    if (externalId) {
      await Message.updateOne(
        { _id: recentSame._id, externalId: { $in: [null, ''] } },
        { externalId }
      ).catch(() => {});
    }
    return;
  }

  const msg = await Message.create({
    clinic: clinicId,
    conversation: conv._id,
    direction: 'out',
    body: finalBody,
    mediaUrl,
    mediaType,
    mediaName,
    mediaSize,
    ...(mediaError ? { errorCode: 'media_unavailable', errorMessage: mediaError } : {}),
    externalId: externalId || undefined,
    origin: 'phone',
    sentByName: 'WhatsApp (teléfono)',
    deliveryStatus: 'sent',
  });
  conv.lastMessageAt = msg.createdAt;
  conv.lastMessagePreview = (finalBody || mediaPreviewText(mediaType, mediaName)).slice(0, 140);
  conv.lastMessageDirection = 'out';
  // Responder desde el teléfono también cuenta como responder: se limpia el
  // pendiente de "no leído" (coherente con la regla del sistema).
  conv.unreadCount = 0;
  if (account && !conv.whatsappAccount) conv.whatsappAccount = account._id;
  await Message.updateMany(
    { conversation: conv._id, direction: 'in', isRead: false },
    { isRead: true }
  );
  await conv.save();
  emitToCallCenter('chat:message', { conversationId: conv._id, message: msg });
}

// Procesa un evento "normalizado" (externalUserId, body, contactName) creando/
// actualizando la conversación correspondiente.
async function ingestExternalMessage({ clinicId, channel, externalUserId, body, contactName, externalId, phone, referral, media, account, interactiveReply, contextId }) {
  if (!externalUserId && !phone) return;
  // Meta reintenta el webhook si no respondemos a tiempo: si este message id ya
  // se procesó, no lo dupliques (ni re-dispares flujos/workflows).
  if (externalId) {
    const dup = await Message.findOne({ clinic: clinicId, externalId, direction: 'in' }).select('_id');
    if (dup) return;
  }
  const normalizedPhone = normalizePhone(phone || externalUserId);
  // Contactos de número OCULTO (@lid): su identidad estable es el JID @lid, NO el
  // teléfono (que se resuelve aparte y puede llegar después). Buscar por externalUserId
  // evita duplicar el chat y permite CURAR el número mostrado al valor real.
  const isLidJid = typeof externalUserId === 'string' && externalUserId.endsWith('@lid');
  const findKey = isLidJid
    ? { clinic: clinicId, channel, externalUserId }
    : phone
      ? { clinic: clinicId, channel, phone: normalizedPhone }
      : { clinic: clinicId, channel, externalUserId };
  let conv = await Conversation.findOne(findKey);
  // LID sin chat aún por su JID: ¿ya hay uno con ESE número real (el contacto escribió
  // antes por Cloud u otro canal)? úsalo para no duplicar (se le fija el JID @lid).
  if (!conv && isLidJid && phone && normalizedPhone) {
    conv = await Conversation.findOne({ clinic: clinicId, channel, phone: normalizedPhone });
  }
  let isNew = false;
  let patient = phone ? await findPatientForIncoming(clinicId, normalizedPhone) : null;
  if (!conv) {
    conv = await Conversation.create({
      clinic: clinicId,
      phone: normalizedPhone || phone || externalUserId, // unique constraint en (clinic, phone)
      externalUserId: externalUserId || '',
      contactName:
        contactName ||
        (patient ? `${patient.firstName || ''} ${patient.lastName || ''}`.trim() : ''),
      patient: patient?._id || null,
      channel,
      ...(referral ? { attribution: referral } : {}),
    });
    isNew = true;
    // CAPI: primera conversación de WhatsApp = Lead para Meta (fire-and-forget).
    if (channel === 'whatsapp') {
      require('../utils/metaConversions')
        .reportLead({
          conversationId: conv._id,
          phone: conv.phone,
          contactName: conv.contactName,
          ctwaClid: referral?.ctwaClid || '',
          adId: referral?.adId || '',
        })
        .catch(() => {});
    }
  } else if (!conv.patient && patient) {
    conv.patient = patient._id;
  }
  // Mantener el identificador externo al día: para números QR ahora llega el JID
  // completo de WhatsApp (…@c.us / …@lid), necesario para poder responder a
  // contactos con número oculto. Cura conversaciones creadas solo con dígitos.
  if (externalUserId && conv.externalUserId !== externalUserId) {
    conv.externalUserId = externalUserId;
  }
  // Número oculto ya resuelto a su teléfono REAL: mostrarlo en vez del LID. Solo se
  // actualiza cuando de verdad se resolvió algo distinto al identificador del LID (si
  // la resolución falló, `phone` = dígitos del LID → no se pisa un número ya bueno).
  if (isLidJid && phone && normalizedPhone) {
    const lidDigits = externalUserId.replace(/@lid$/, '').replace(/\D/g, '');
    if (normalizePhone(lidDigits) !== normalizedPhone && conv.phone !== normalizedPhone) {
      conv.phone = normalizedPhone;
    }
  }
  // Si llega atribución (click-to-WhatsApp) y la conversación aún no la tiene, guárdala.
  if (referral && referral.adId && !conv.attribution?.adId) {
    conv.attribution = referral;
  }
  // Cada ANUNCIO es una oportunidad distinta: si el mensaje viene de un anuncio
  // y este chat aún no tiene una oportunidad de ESE anuncio, se crea sola
  // (etapa 'nuevo') con su atribución — el agente la ve lista en el panel.
  if (referral && referral.adId) {
    const hasForAd =
      (conv.opportunities || []).some((o) => o.attribution?.adId === referral.adId) ||
      (!(conv.opportunities || []).length &&
        conv.opportunity?.isOpportunity &&
        conv.attribution?.adId === referral.adId);
    if (!hasForAd) {
      conv.opportunities = [
        ...(conv.opportunities || []),
        {
          isOpportunity: true,
          stage: 'nuevo',
          notes: referral.campaign ? `Desde anuncio: ${referral.campaign}` : 'Desde anuncio (click-to-WhatsApp)',
          attribution: {
            adId: referral.adId,
            campaign: referral.campaign || '',
            ctwaClid: referral.ctwaClid || '',
          },
          createdAt: new Date(),
        },
      ];
      syncPrimaryOpportunity(conv);
    }
  }
  // Recuerda por qué número (global) entró el mensaje, para responder por el mismo.
  if (account && String(conv.whatsappAccount || '') !== String(account._id)) {
    conv.whatsappAccount = account._id;
  }
  if (conv.blocked) return;

  // Media entrante (imagen/audio/documento/video/sticker de WhatsApp): se descarga
  // y persiste como dataUrl base64 para no perderla. Cap de tamaño en downloadMedia.
  let mediaUrl = null;
  let mediaType = null;
  let mediaName = '';
  let mediaSize = 0;
  let mediaError = '';
  let finalBody = body || '';
  if (media && channel === 'whatsapp') {
    mediaName = String(media.filename || '').slice(0, 200);
    mediaSize = Number(media.size) || 0;
    // El TIPO se guarda SIEMPRE, aunque la descarga falle: así el agente ve
    // "📷 Foto (no disponible)" en el chat en vez de una burbuja vacía sin
    // explicación (o —peor— nada, como pasaba antes).
    mediaType = media.type || null;
    if (media.dataUrl) {
      // Número QR: la media llega ya descargada inline (whatsapp-web.js).
      mediaUrl = media.dataUrl;
    } else if (media.unavailable) {
      // QR: la sesión de WhatsApp Web no logró entregar los bytes.
      mediaError = String(media.error || 'No se pudo descargar el archivo de WhatsApp.').slice(0, 300);
    } else if (media.id && account) {
      // Cloud API: se descarga por id usando las credenciales del número.
      const gateway = require('../utils/whatsappGateway');
      const dl = await gateway.downloadMedia(account, media.id);
      if (dl.ok) {
        mediaUrl = dl.dataUrl;
        mediaSize = Number(dl.size) || mediaSize;
        if (!mediaName && dl.filename) mediaName = String(dl.filename).slice(0, 200);
      } else {
        mediaError = String(
          dl.tooLarge ? 'El archivo es demasiado grande para guardarlo.' : dl.error || 'Meta no entregó el archivo.'
        ).slice(0, 300);
        console.warn('[chat media] Cloud API NO entregó la media type=%s id=%s: %s', media.type, media.id, mediaError);
      }
    } else if (media.id && !account) {
      // Sin cuenta resuelta (phone_number_id desconocido) no hay credenciales con
      // las que bajar la media: antes se perdía en silencio.
      mediaError = 'No se pudo identificar el número de WhatsApp por el que llegó el archivo.';
      console.warn('[chat media] webhook sin cuenta resuelta: media type=%s id=%s no descargada', media.type, media.id);
    }
    // El texto de la burbuja es SOLO el pie real; el nombre del documento va
    // aparte en `mediaName` (se pinta como tarjeta) y los stickers no llevan texto.
    if (!finalBody) finalBody = media.caption || '';
  }

  // Cita entrante: el contacto respondió a un mensaje específico. Meta manda el
  // wamid citado en `context.id`; lo resolvemos a nuestro mensaje para mostrar la
  // burbuja citada (el remitente es el equipo si era saliente, o el contacto).
  let replyTo = null;
  if (contextId) {
    const fields = 'body direction externalId mediaType sentByName isAutoReply';
    let quoted = await Message.findOne({ clinic: clinicId, conversation: conv._id, externalId: contextId })
      .select(fields);
    if (!quoted) {
      // El mismo mensaje puede estar guardado con OTRA forma del JID (chats LID:
      // @lid vs @c.us), o el contexto puede llegar como hash pelado
      // (quotedStanzaID). La parte única del wamid identifica el mensaje igual.
      const parts = String(contextId).split('_');
      const hash = parts.length >= 3 ? parts[2] : String(contextId);
      if (hash && hash.length >= 8) {
        const esc = hash.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        quoted = await Message.findOne({
          clinic: clinicId,
          conversation: conv._id,
          externalId: new RegExp(`(^|_)${esc}$`),
        }).select(fields);
      }
    }
    if (quoted) replyTo = replySnapshotFrom(quoted, conv.contactName);
  }

  const msg = await Message.create({
    clinic: clinicId,
    conversation: conv._id,
    direction: 'in',
    body: finalBody,
    mediaUrl,
    mediaType,
    mediaName,
    mediaSize,
    // Motivo por el que el archivo no está disponible (se muestra en la burbuja).
    ...(mediaError ? { errorCode: 'media_unavailable', errorMessage: mediaError } : {}),
    externalId,
    ...(interactiveReply ? { interactiveReply } : {}),
    ...(replyTo ? { replyTo } : {}),
    // Anuncio del que vino este mensaje (solo lo trae el 1er mensaje tras el clic).
    ...(referral && referral.adId
      ? {
          referral: {
            sourceId: referral.adId,
            sourceType: referral.sourceType || '',
            sourceUrl: referral.sourceUrl || '',
            headline: referral.headline || '',
            body: referral.body || '',
            ctwaClid: referral.ctwaClid || '',
          },
        }
      : {}),
    // Número por el que entró (para responder por el mismo, aun sin enlazar la conv).
    whatsappAccount: account?._id || null,
    deliveryStatus: 'delivered',
  });
  conv.lastMessageAt = msg.createdAt;
  conv.lastMessagePreview = (finalBody || mediaPreviewText(mediaType, mediaName)).slice(0, 140);
  conv.lastMessageDirection = 'in';
  conv.lastInboundAt = msg.createdAt;
  conv.window24hExpiresAt = messaging.computeWhatsappWindowExpiresAt(msg.createdAt);
  conv.unreadCount = (conv.unreadCount || 0) + 1;
  if (conv.status === 'closed') conv.status = 'open';
  await conv.save();
  emitToCallCenter('chat:message', { conversationId: conv._id, message: msg });

  const optedOut = await applyIncomingOptOut({ clinicId, conv, incomingText: finalBody });
  if (optedOut) return;
  const workflowEngine = require('../utils/workflowEngine');
  // Reanuda workflows que esperaban respuesta del paciente (p.ej. confirmar cita).
  await workflowEngine
    .resumeOnReply({ clinicId, patientId: conv.patient, phone: conv.phone, text: finalBody })
    .catch(() => {});
  // Motor nuevo: disparadores de chat (inbound_message / keyword / new_conversation).
  await workflowEngine
    .enrollForChatMessage({
      clinicId,
      conversation: conv,
      patient: patient || (conv.patient ? { _id: conv.patient } : null),
      phone: conv.phone,
      text: finalBody,
      isNew,
      referral, // anuncio CTWA del que vino este mensaje (trigger 'ctwa_ad')
    })
    .catch(() => {});
  // Legacy MessageFlow (en deprecación): sigue atendiendo flujos ya existentes.
  await triggerFlows({ conv, clinicId, isNewConversation: isNew, incomingText: finalBody });
}

// Expuesto para que whatsappQrManager reutilice el mismo pipeline de ingesta.
exports.ingestExternalMessage = ingestExternalMessage;
// Texto de los mensajes que no son ni texto ni media (ubicación, contacto…).
exports.describeNonMediaMessage = describeNonMediaMessage;
// Salientes enviados desde el teléfono (número QR), fuera del sistema.
exports.ingestExternalOutbound = ingestExternalOutbound;
// Lo reutiliza el controller de llamadas: una llamada entrante debe vincularse
// al mismo paciente que un mensaje entrante del mismo número.
exports.findPatientForIncoming = findPatientForIncoming;
exports.normalizePhone = normalizePhone;

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

exports.webhookMessengerVerify = metaVerify('messenger');
exports.webhookInstagramVerify = metaVerify('instagram');

// Config global de WhatsApp (appSecret/verifyToken compartidos + clínica sede).
async function getWhatsappAppConfig() {
  const CallCenterWhatsappConfig = require('../models/CallCenterWhatsappConfig');
  return CallCenterWhatsappConfig.getSingleton();
}

// Verificación GET del webhook único de WhatsApp (todos los números Cloud API).
// El verifyToken es a nivel de app (config global), no por clínica.
exports.webhookWhatsappVerify = async (req, res) => {
  try {
    const cfg = await getWhatsappAppConfig();
    const expected = cfg?.cloudApi?.verifyToken;
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token && token === expected) return res.status(200).send(challenge);
    return res.status(403).send('Verification failed');
  } catch {
    return res.status(500).send('Error');
  }
};

exports.webhookWhatsappReceive = async (req, res) => {
  try {
    const appCfg = await getWhatsappAppConfig();
    const { decryptSecret } = require('../utils/secretCrypto');
    const signature = verifyMetaSignature({
      rawBody: req.rawBody || req.body,
      signature: req.headers['x-hub-signature-256'],
      appSecret: appCfg?.cloudApi?.appSecret ? decryptSecret(appCfg.cloudApi.appSecret) : '',
    });
    if (!signature.ok) {
      return res.status(403).json({ message: 'Firma invalida', code: signature.reason });
    }
    // El call center es global: las conversaciones viven en la clínica ancla (auto).
    const clinicId = await require('../utils/callCenterClinic').resolveCallCenterClinicId();
    if (!clinicId) {
      return res.status(400).json({ message: 'No hay ninguna clínica registrada para el call center' });
    }
    const gateway = require('../utils/whatsappGateway');
    const entries = Array.isArray(req.body.entry) ? req.body.entry : [];
    let statusUpdates = 0;
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        // Cambios de plantilla (categoría/estado) notificados por Meta en tiempo real.
        if (change.field === 'message_template_status_update' || change.field === 'template_category_update') {
          // eslint-disable-next-line no-await-in-loop
          await require('./messageTemplateController')
            .handleTemplateWebhook(clinicId, change.field, value)
            .catch((e) => console.error('[whatsapp webhook template]', e.message));
          continue;
        }
        // Salud del canal: Meta avisa si la calidad del número cae (spam/bloqueos)
        // o si cambia el límite diario de mensajería.
        if (change.field === 'phone_number_quality_update') {
          // eslint-disable-next-line no-await-in-loop
          await require('../utils/whatsappQuality')
            .handleQualityWebhook(clinicId, value)
            .catch((e) => console.error('[whatsapp webhook quality]', e.message));
          continue;
        }
        // Identifica POR CUÁL número (global) llegó el evento, vía phone_number_id.
        // eslint-disable-next-line no-await-in-loop
        const account = await gateway.getCloudAccountByPhoneNumberId(value.metadata?.phone_number_id);
        // Llamadas de voz (Calling API): señalización WebRTC + fin de llamada.
        if (change.field === 'calls') {
          // eslint-disable-next-line no-await-in-loop
          await require('./callController')
            .handleCallWebhook(clinicId, value, account)
            .catch((e) => console.error('[whatsapp webhook calls]', e.message));
          continue;
        }
        if (Array.isArray(value.statuses) && value.statuses.length) {
          // eslint-disable-next-line no-await-in-loop
          statusUpdates += await processMetaStatuses(clinicId, value.statuses);
        }
        const contact = (value.contacts || [])[0] || {};
        for (const m of value.messages || []) {
          // Media entrante: imagen/audio/video/documento/sticker.
          const media = m.image
            ? { type: 'image', id: m.image.id, caption: m.image.caption || '' }
            : m.audio
            ? { type: 'audio', id: m.audio.id }
            : m.video
            ? { type: 'video', id: m.video.id, caption: m.video.caption || '' }
            : m.document
            ? {
                type: 'document',
                id: m.document.id,
                // El nombre del archivo va aparte (se pinta como tarjeta); el
                // caption solo si el usuario escribió un pie de verdad.
                caption: m.document.caption || '',
                filename: m.document.filename || '',
              }
            : m.sticker
            ? { type: 'sticker', id: m.sticker.id }
            : null;
          // Respuesta interactiva: botón interactivo, lista, o botón de respuesta
          // rápida de plantilla (llega como m.button con payload). El id/payload
          // permite etiquetar interés (CRO) sin depender del texto visible.
          const reply = m.interactive?.button_reply || m.interactive?.list_reply || null;
          const interactiveReply = reply
            ? {
                id: reply.id || '',
                title: reply.title || '',
                type: m.interactive?.list_reply ? 'list_reply' : 'button_reply',
              }
            : m.button
            ? { id: m.button.payload || '', title: m.button.text || '', type: 'button_reply' }
            : null;
          // Atribución click-to-WhatsApp (anuncios Meta): solo viene en el 1er
          // mensaje tras tocar el anuncio y SOLO en números Cloud API. Se registra
          // en el log para poder auditar que llega y comparar el ID del anuncio
          // (source_id) con el configurado en el disparador ctwa_ad.
          const referral = m.referral
            ? {
                adId: m.referral.source_id || '',
                campaign: m.referral.headline || m.referral.body || '',
                ctwaClid: m.referral.ctwa_clid || '',
                // Detalle completo para mostrar en el chat de qué anuncio vino.
                headline: m.referral.headline || '',
                body: m.referral.body || '',
                sourceUrl: m.referral.source_url || '',
                sourceType: m.referral.source_type || '',
              }
            : null;
          if (m.referral) {
            console.log(
              '[ctwa_ad] mensaje desde anuncio — source_id=%s source_type=%s ctwa_clid=%s de %s',
              m.referral.source_id || '(vacío)',
              m.referral.source_type || '(sin tipo)',
              m.referral.ctwa_clid || '(sin clid)',
              m.from
            );
          }
          // eslint-disable-next-line no-await-in-loop
          await ingestExternalMessage({
            clinicId,
            channel: 'whatsapp',
            account,
            phone: m.from,
            externalUserId: m.from,
            body: m.text?.body || m.button?.text || reply?.title || describeNonMediaMessage(m),
            interactiveReply,
            media,
            contactName: contact.profile?.name || '',
            externalId: m.id,
            // Cita: wamid del mensaje al que el contacto respondió (si respondió a uno).
            contextId: m.context?.id || '',
            referral,
          });
        }
      }
    }
    res.status(200).json({ ok: true, statusUpdates });
  } catch (err) {
    console.error('[whatsapp webhook]', err);
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

exports.webhookMessengerReceive = async (req, res) => {
  try {
    const { clinicId } = req.params;
    const signature = await validateMetaWebhookRequest(req, clinicId, 'messenger');
    if (!signature.ok) {
      return res.status(403).json({ message: 'Firma invalida', code: signature.reason });
    }
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
    const signature = await validateMetaWebhookRequest(req, clinicId, 'instagram');
    if (!signature.ok) {
      return res.status(403).json({ message: 'Firma invalida', code: signature.reason });
    }
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

// Una cita cuenta como asistida tanto si se marcó 'asistida' como si ya se
// 'completada' (el doctor la atendió): en ambos casos el paciente vino.
const ATTENDED_STATUSES = ['asistida', 'completada'];

/**
 * Rango de fechas del panel de Supervisión. `from`/`to` llegan como 'YYYY-MM-DD'
 * y se interpretan en hora de Ecuador (todo el sistema va en America/Guayaquil,
 * y el server fuerza TZ), de modo que "hoy" es el hoy del usuario y no el UTC.
 * Sin parámetros no filtra: devuelve el histórico completo.
 */
function statsDateRange(query) {
  const parse = (v, endOfDay) => {
    const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const [, y, mo, d] = m;
    return new Date(
      Number(y), Number(mo) - 1, Number(d),
      ...(endOfDay ? [23, 59, 59, 999] : [0, 0, 0, 0])
    );
  };
  const from = parse(query.from, false);
  const to = parse(query.to, true);
  if (!from && !to) return null;
  return { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
}

exports.getStats = async (req, res) => {
  try {
    const clinicOid = new mongoose.Types.ObjectId(req.clinicId);
    const range = statsDateRange(req.query);
    // El rango filtra por creación de la conversación: el panel mide el trabajo
    // sobre los chats que ENTRARON en el periodo.
    const match = { clinic: clinicOid, ...(range ? { createdAt: range } : {}) };

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
      // Ojo: NO se filtra por assignedTo. Los chats SIN ASIGNAR salen agrupados en
      // su propia fila: son justo los que nadie responde, y ocultarlos hacía que
      // la tabla no cuadrara con el indicador de "sin responder".
      Conversation.aggregate([
        { $match: match },
        {
          $group: {
            _id: '$assignedTo',
            total: { $sum: 1 },
            open: { $sum: { $cond: [{ $eq: ['$status', 'open'] }, 1, 0] } },
            // Esperando respuesta: chat abierto cuyo ÚLTIMO mensaje es del paciente.
            unanswered: {
              $sum: {
                $cond: [
                  { $and: [{ $eq: ['$status', 'open'] }, { $eq: ['$lastMessageDirection', 'in'] }] },
                  1,
                  0,
                ],
              },
            },
          },
        },
        { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
        { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            _id: 1,
            name: { $ifNull: ['$user.name', 'Sin asignar'] },
            email: '$user.email',
            total: 1,
            open: 1,
            unanswered: 1,
          },
        },
        { $sort: { total: -1 } },
      ]),
    ]);

    // Tiempo de primera respuesta (promedio) por agente + SLA (conversaciones sin
    // responder cuyo último mensaje es entrante y lleva más del umbral abierto).
    const SLA_MINUTES = Number(req.query.slaMinutes || 60);
    const slaCutoff = new Date(Date.now() - SLA_MINUTES * 60000);
    const [responseTimes, unanswered, appointmentsByAgent] = await Promise.all([
      Conversation.aggregate([
        { $match: { ...match, firstResponseAt: { $ne: null } } },
        { $project: { assignedTo: 1, respMs: { $subtract: ['$firstResponseAt', '$createdAt'] } } },
        { $group: { _id: '$assignedTo', avgMs: { $avg: '$respMs' }, count: { $sum: 1 } } },
        { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
        { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
        { $project: { name: '$user.name', avgMinutes: { $round: [{ $divide: ['$avgMs', 60000] }, 1] }, count: 1 } },
        { $sort: { avgMinutes: 1 } },
      ]),
      Conversation.countDocuments({
        ...match,
        status: 'open',
        lastMessageDirection: 'in',
        lastMessageAt: { $lt: slaCutoff },
      }),
      // Citas nacidas de un chat, por agente que las creó. Se filtran por el chat
      // (`conversation`), no por Appointment.clinic: una cita del call center puede
      // agendarse en OTRA sucursal y se perdería al filtrar por clínica.
      Appointment.aggregate([
        {
          $match: {
            conversation: { $ne: null },
            ...(range ? { createdAt: range } : {}),
          },
        },
        {
          $lookup: {
            from: 'conversations',
            localField: 'conversation',
            foreignField: '_id',
            as: 'conv',
          },
        },
        { $unwind: '$conv' },
        { $match: { 'conv.clinic': clinicOid } },
        {
          $group: {
            _id: '$createdBy',
            created: { $sum: 1 },
            attended: { $sum: { $cond: [{ $in: ['$status', ATTENDED_STATUSES] }, 1, 0] } },
          },
        },
      ]),
    ]);

    // Las citas se cuelgan del agente en la tabla "Por agente". Un agente puede
    // haber creado citas sin tener chats asignados (tomó un chat de otro), así
    // que las filas que no existan en byAgent se añaden al final.
    const apptByAgent = new Map(appointmentsByAgent.map((a) => [String(a._id), a]));
    const rows = byAgent.map((a) => {
      // La fila "Sin asignar" tiene _id null y nunca casa con un createdBy.
      const appt = a._id ? apptByAgent.get(String(a._id)) : null;
      if (a._id) apptByAgent.delete(String(a._id));
      return { ...a, appointmentsCreated: appt?.created || 0, appointmentsAttended: appt?.attended || 0 };
    });
    if (apptByAgent.size) {
      const extra = await User.find({ _id: { $in: [...apptByAgent.keys()] } }).select('name email');
      for (const u of extra) {
        const appt = apptByAgent.get(String(u._id));
        rows.push({
          _id: u._id,
          name: u.name,
          email: u.email,
          total: 0,
          open: 0,
          appointmentsCreated: appt?.created || 0,
          appointmentsAttended: appt?.attended || 0,
          unanswered: 0,
        });
      }
    }

    const appointments = appointmentsByAgent.reduce(
      (acc, a) => ({ created: acc.created + a.created, attended: acc.attended + a.attended }),
      { created: 0, attended: 0 }
    );

    res.json({
      byStatus,
      opportunities,
      featuredCount,
      byAgent: rows,
      responseTimes,
      appointments,
      range: { from: req.query.from || '', to: req.query.to || '' },
      sla: { thresholdMinutes: SLA_MINUTES, unanswered },
    });
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
    // Atribución: traspasa el origen del anuncio (click-to-WhatsApp) al paciente.
    if (conv.attribution?.adId && !patient.attribution?.adId) {
      patient.attribution = {
        ...(patient.attribution?.toObject ? patient.attribution.toObject() : patient.attribution || {}),
        utmCampaign: conv.attribution.campaign || '',
        adId: conv.attribution.adId,
        // ctwa_clid: matching fuerte para la Conversions API (Schedule/Purchase).
        ctwaClid: conv.attribution.ctwaClid || '',
        firstTouchAt: patient.attribution?.firstTouchAt || conv.createdAt || new Date(),
      };
      await patient.save();
    }
    await conv.save();
    emitToClinic(req.clinicId, 'patient:created', { id: patient._id });
    emitToCallCenter('chat:updated', { id: conv._id });
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

    const { isPastLocalDate, isPastLocalDateTime, PAST_DATE_MESSAGE, PAST_TIME_MESSAGE } = require('../utils/appointmentDate');
    for (let i = 0; i < requested.length; i++) {
      const a = requested[i];
      if (!a.date || !a.startTime) {
        return res.status(400).json({ message: `La cita #${i + 1} requiere fecha y hora de inicio.` });
      }
      // No se puede agendar en una fecha anterior a hoy.
      if (isPastLocalDate(a.date)) {
        return res.status(400).json({ message: `La cita #${i + 1}: ${PAST_DATE_MESSAGE}` });
      }
      // Ni HOY en una hora que ya pasó (hora Ecuador).
      if (isPastLocalDateTime(a.date, a.startTime)) {
        return res.status(400).json({ message: `La cita #${i + 1}: ${PAST_TIME_MESSAGE}` });
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
        // Deja rastro del chat de origen: el panel de Supervisión cuenta por aquí
        // las citas que produjo el call center.
        conversation: conv._id,
      });
      first = false; // solo la primera puede ser "primera visita"
      created.push(appointment);
      emitToClinic(targetClinic, 'appointment:created', { id: appointment._id });
      // Evento de DOMINIO: sin esto, las citas creadas desde el chat jamás
      // disparaban los workflows de "cita agendada" (solo las de la página de
      // Citas y la reserva online lo emitían).
      const { emitDomainEvent, DOMAIN_EVENTS } = require('../utils/events');
      emitDomainEvent(DOMAIN_EVENTS.APPOINTMENT_CREATED, {
        clinicId: String(targetClinic),
        patientId: String(conv.patient._id),
        appointmentId: String(appointment._id),
        appointmentDate: require('../utils/appointmentDate').appointmentDateTime(appointment.date, appointment.startTime),
        isFirstVisit: !!appointment.isFirstVisit,
        services: serviceItems.map((s) => String(s.product)).filter(Boolean),
      });
    }

    // Link primera cita a la oportunidad
    const prevStage = conv.opportunity?.isOpportunity ? conv.opportunity.stage : null;
    conv.opportunity = conv.opportunity || {};
    conv.opportunity.isOpportunity = true;
    conv.opportunity.stage = 'agendado';
    conv.opportunity.appointment = created[0]?._id;
    conv.opportunity.convertedAt = new Date();
    await conv.save();
    emitToCallCenter('chat:updated', { id: conv._id });
    // Agendar desde el chat mueve la oportunidad a "agendado" → dispara workflows.
    if (prevStage !== 'agendado') notifyOpportunityStage(conv, 'agendado');

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

    // El enlace se envía DE VERDAD por el proveedor (antes solo se creaba el
    // mensaje con deliveryStatus 'sent' y NUNCA salía a WhatsApp). Si el proveedor
    // lo rechaza, el mensaje queda FALLIDO con su motivo, no un "enviado" falso.
    const result = await messaging.send({
      clinicId: req.clinicId,
      channel: conv.channel || 'whatsapp',
      conversation: conv,
      to: conv.phone,
      patient: conv.patient,
      body,
      sentBy: req.user._id,
      sentByName: req.user.name,
    });
    emitToCallCenter('chat:updated', { id: conv._id });

    res.status(201).json({
      quotation,
      pdfUrl,
      message: result.message || null,
      deliveryStatus: result.deliveryStatus || (result.skipped ? 'skipped' : 'failed'),
      sendError: result.ok ? null : (result.errorMessage || SEND_SKIP_REASONS[result.reason] || 'No se pudo enviar el enlace por WhatsApp.'),
      conversation: conv,
    });
  } catch (err) {
    res.status(500).json({ message: 'Error al crear cotización desde chat', error: err.message });
  }
};
