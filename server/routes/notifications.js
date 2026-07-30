const router = require('express').Router();
const ctrl = require('../controllers/notificationController');
const { auth, requireClinic } = require('../middleware/auth');

// La campana del header la abre CUALQUIER usuario con sesión: no se filtra por rol
// aquí, sino por tipo de notificación dentro del controlador (ver TYPE_ROLES). Así
// un doctor ve la bandeja vacía en vez de un 403 en cada carga del header.
router.use(auth, requireClinic);

// Rutas fijas antes de las paramétricas.
router.get('/', ctrl.list);
router.get('/unread-count', ctrl.unreadCount);
router.post('/read-all', ctrl.markAllRead);
router.post('/:id/read', ctrl.markRead);

module.exports = router;
