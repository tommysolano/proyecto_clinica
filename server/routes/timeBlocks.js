const router = require('express').Router();
const ctrl = require('../controllers/timeBlockController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

// Listar: cualquier rol autenticado (la agenda y la reserva pública pintan los
// bloqueos; ver también el uso interno en appointmentController y booking).
router.get('/', ctrl.list);
// Crear/editar/borrar: administración y MARKETING (sep-2026, a petición del
// usuario). Espejo del menú «Bloqueos de horarios» de la agenda.
router.post('/', requireRole('admin', 'marketing'), ctrl.create);
router.put('/:id', requireRole('admin', 'marketing'), ctrl.update);
router.delete('/:id', requireRole('admin', 'marketing'), ctrl.remove);

module.exports = router;
