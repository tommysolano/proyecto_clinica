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

    socket.on('switch-clinic', (newClinicId) => {
      // El cliente cambió de clínica activa
      if (clinicId) socket.leave(`clinic:${clinicId}`);
      if (newClinicId) socket.join(`clinic:${newClinicId}`);
      socket.data.clinicId = newClinicId;
    });

    socket.on('disconnect', () => {
      /* noop */
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
  io.to('callcenter').emit(event, payload);
}

module.exports = { init, getIO, getRealtimeStats, emitToClinic, emitToUser, emitToRole, emitToCallCenter };
