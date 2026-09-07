const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/appointmentBlastController');

/**
 * Envío masivo a las citas de la agenda ("Recordatorios de citas").
 *
 * OJO: a diferencia del resto del CRM, estas rutas NO usan `callCenterScope`.
 * Las citas viven en su sucursal REAL y el usuario elige de qué sedes envía; si
 * el middleware reescribiera `req.clinicId` a la clínica ancla, el alcance de
 * sucursales se calcularía sobre la ancla y el filtro devolvería la agenda
 * equivocada. La clínica ancla se resuelve dentro del controlador, donde hace
 * falta de verdad (los workflows y los chats sí viven ahí).
 */
router.use(auth, requireClinic);

// Los mismos roles que hacen los otros envíos masivos (ver routes/contacts.js):
// preparar y lanzar una campaña es trabajo de call center y marketing.
const ROLES = ['admin', 'marketing', 'call_center'];

router.get('/workflows', requireRole(...ROLES), c.listWorkflows);
router.get('/pending-enrollments', requireRole(...ROLES), c.pendingEnrollments);
router.post('/preview', requireRole(...ROLES), c.preview);
router.get('/', requireRole(...ROLES), c.list);
router.post('/', requireRole(...ROLES), c.create);
router.get('/:id', requireRole(...ROLES), c.get);

module.exports = router;
