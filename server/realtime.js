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
  io = new Server(httpServer, {
    cors: { origin: true, credentials: true },
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

module.exports = { init, getIO, emitToClinic, emitToUser, emitToRole };
