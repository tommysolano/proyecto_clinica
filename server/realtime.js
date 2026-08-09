/**
 * Capa de tiempo real con Socket.IO.
 *
 * - El cliente se conecta enviando `{ auth: { token } }` (JWT firmado por la app).
 * - Cada socket se une a la "room" de la clínica activa (`clinic:<id>`).
 * - Los doctores también se unen a su sala personal (`user:<id>`).
 * - Los controllers usan `getIO()` para emitir eventos que el cliente refleja en vivo.
 *
 * Eventos estándar:
 *   appointment:created | updated | deleted
 *   treatment:created | updated | deleted
 *   patient:created | updated
 *   chat:conversation | message
 *   clinicalRecord:updated
 *   notify  (mensajes broadcast tipo toast)
 */
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const User = require('./models/User');

let io = null;

function init(httpServer) {
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
    : ['http://localhost:5173', 'http://localhost:4173'];

  io = new Server(httpServer, {
    cors: {
      origin: (origin, cb) => {
        if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
        cb(new Error(`CORS: origin no permitido: ${origin}`));
      },
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  io.use(async (socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.replace('Bearer ', '');
      if (!token) return next(new Error('No token'));
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id).select('name email isSuperAdmin clinics active');
      if (!user || !user.active) return next(new Error('Usuario inactivo'));
      socket.data.user = user;
      socket.data.clinicId = decoded.clinicId || null;
      socket.data.role = decoded.clinicId
        ? user.isSuperAdmin && !user.getRoleForClinic(decoded.clinicId)
          ? 'admin'
          : user.getRoleForClinic(decoded.clinicId)
        : user.isSuperAdmin
        ? 'admin'
        : null;
      next();
    } catch (err) {
      next(new Error('Token inválido'));
    }
  });

  io.on('connection', (socket) => {
    const { user, clinicId, role } = socket.data;
    if (clinicId) socket.join(`clinic:${clinicId}`);
    socket.join(`user:${user._id}`);
    if (role) socket.join(`clinic:${clinicId}:role:${role}`);
    // Call center ÚNICO: los agentes (de cualquier sucursal) comparten una sola
    // bandeja. Se unen a una sala común para recibir los eventos de chat en vivo.
    if (user.isSuperAdmin || ['admin', 'marketing', 'call_center'].includes(role)) {
      socket.join('callcenter');
    }
    if (user.isSuperAdmin || ['admin', 'marketing'].includes(role)) {
      socket.join('callcenter-supervisors');
    } else if (role === 'call_center') {
      socket.join('callcenter-agents');
    }

    /**
     * Presencia efímera de escritura en el chat compartido. No se guarda en BD:
     * el servidor toma la identidad del JWT (nunca del payload) y retransmite a
     * los demás asesores. `typingId` distingue dos pestañas del mismo usuario;
     * cerrar una no apaga por error el indicador de la otra.
    */
    const canUseSharedChat = user.isSuperAdmin || ['admin', 'marketing', 'call_center'].includes(role);
    const validConversationId = (value) => /^[a-f\d]{24}$/i.test(String(value || ''));
    const loadTypingConversation = async (conversationId) => {
      if (!validConversationId(conversationId)) return null;
      const Conversation = require('./models/Conversation');
      const conv = await Conversation.findById(conversationId).select('_id assignedTo').lean();
      if (!conv) return null;
      const assignedTo = String(conv.assignedTo || '');
      if (role === 'call_center' && assignedTo && assignedTo !== String(user._id)) return null;
      socket.data.typingConversation = conv;
      return conv;
    };
    const broadcastTyping = async (conversationId, isTyping, knownConversation = null) => {
      if (!canUseSharedChat || !validConversationId(conversationId)) return;
      const conv = knownConversation || await loadTypingConversation(conversationId);
      if (!conv) return;
      let target = socket.to('callcenter-supervisors');
      target = conv.assignedTo
        ? target.to(`user:${conv.assignedTo}`)
        : target.to('callcenter-agents');
      target.emit('chat:typing', {
        conversationId: String(conversationId),
        isTyping: !!isTyping,
        typingId: `${user._id}:${socket.id}`,
        userId: String(user._id),
        name: String(user.name || user.email || 'Asesor').slice(0, 80),
        at: new Date().toISOString(),
      });
    };

    socket.on('chat:typing', async (payload = {}) => {
      if (!canUseSharedChat) return;
      const conversationId = String(payload.conversationId || '');
      if (!validConversationId(conversationId)) return;

      // Una pestaña solo puede estar escribiendo en un chat a la vez. Si cambia
      // de conversación, apaga primero la señal anterior.
      const previous = socket.data.typingConversationId;
      if (previous && previous !== conversationId) await broadcastTyping(previous, false);
      if (payload.isTyping === false) {
        if (!previous || previous === conversationId) {
          await broadcastTyping(conversationId, false);
          socket.data.typingConversationId = null;
          socket.data.typingConversation = null;
        }
        return;
      }
      const conv = await loadTypingConversation(conversationId);
      if (!conv) return;
      socket.data.typingConversationId = conversationId;
      await broadcastTyping(conversationId, true, conv);
    });

    socket.on('switch-clinic', (newClinicId) => {
      // El cliente cambió de clínica activa
      if (clinicId) socket.leave(`clinic:${clinicId}`);
      if (newClinicId) socket.join(`clinic:${newClinicId}`);
      socket.data.clinicId = newClinicId;
    });

    socket.on('disconnect', () => {
      // Evita dejar los tres puntos prendidos hasta que venza el timeout del
      // cliente cuando el asesor cierra la pestaña o pierde la conexión.
      if (socket.data.typingConversationId) {
        broadcastTyping(socket.data.typingConversationId, false).catch(() => {});
      }
    });
  });

  return io;
}

function getIO() {
  return io;
}

/**
 * Foto del estado del tiempo real, para el panel de diagnóstico: cuántos sockets
 * hay conectados en total y cuántos en la bandeja del call center (los que reciben
 * `chat:message` en vivo). Si `callcenter` es 0 mientras hay agentes con el chat
 * abierto, el tiempo real NO está llegando y toca revisar la conexión del socket.
 */
function getRealtimeStats() {
  if (!io) return { up: false, totalSockets: 0, callcenterSockets: 0 };
  let callcenterSockets = 0;
  try {
    callcenterSockets = io.sockets.adapter.rooms.get('callcenter')?.size || 0;
  } catch {
    callcenterSockets = 0;
  }
  return {
    up: true,
    totalSockets: io.of('/').sockets.size,
    callcenterSockets,
  };
}

/**
 * Emite a la sala de una clínica.
 */
function emitToClinic(clinicId, event, payload) {
  if (!io || !clinicId) return;
  io.to(`clinic:${clinicId}`).emit(event, payload);
}

/**
 * Emite a un usuario específico (todas sus sesiones abiertas).
 */
function emitToUser(userId, event, payload) {
  if (!io || !userId) return;
  io.to(`user:${userId}`).emit(event, payload);
}

/**
 * Emite a todos los usuarios con un rol específico en una clínica.
 */
function emitToRole(clinicId, role, event, payload) {
  if (!io || !clinicId || !role) return;
  io.to(`clinic:${clinicId}:role:${role}`).emit(event, payload);
}

/**
 * Emite a TODA la bandeja del call center (todos los agentes, sin importar su
 * sucursal). Se usa para los eventos de chat, que son globales del call center.
 */
function emitToCallCenter(event, payload) {
  if (!io) return;
  const isPrivateChatEvent = /^(chat|call):/.test(String(event || ''));
  const conversationId = payload?.conversationId || payload?.id || null;
  if (!isPrivateChatEvent || !conversationId) {
    io.to('callcenter').emit(event, payload);
    return;
  }

  // Los eventos con contenido del chat siguen el mismo candado que la API. La
  // consulta se hace aquí para cubrir todos los emisores existentes (Cloud, QR,
  // workflows, llamadas y cambios de oportunidad) sin dejar una vía lateral.
  const Conversation = require('./models/Conversation');
  Conversation.findById(conversationId).select('assignedTo').lean()
    .then((conv) => {
      if (!io || !conv) return;
      let target = io.to('callcenter-supervisors');
      target = conv.assignedTo
        ? target.to(`user:${conv.assignedTo}`)
        : target.to('callcenter-agents');
      target.emit(event, payload);
    })
    .catch((err) => console.error('[realtime] no se pudo resolver acceso al chat:', err.message));
}

/**
 * Aviso mínimo de reasignación. Se envía a todos los asesores para que quienes
 * tenían el chat libre/abierto lo retiren inmediatamente de pantalla; no incluye
 * nombre, teléfono ni mensajes del contacto.
 */
function emitChatAssignment({ conversationId, assignedTo, assignedToName = '' }) {
  if (!io || !conversationId) return;
  io.to('callcenter').emit('chat:assignment', {
    conversationId: String(conversationId),
    assignedTo: assignedTo ? String(assignedTo) : null,
    assignedToName: String(assignedToName || '').slice(0, 80),
  });
}

module.exports = {
  init, getIO, getRealtimeStats, emitToClinic, emitToUser, emitToRole,
  emitToCallCenter, emitChatAssignment,
};
