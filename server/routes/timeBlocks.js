const router = require('express').Router();
const ctrl = require('../controllers/timeBlockController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

// Listar: todos los roles que agendan citas (para que la UI pinte los bloqueos en el calendario)
router.get('/', ctrl.list);
// Crear/editar/borrar: solo el administrador
router.post('/', requireRole('admin'), ctrl.create);
router.put('/:id', requireRole('admin'), ctrl.update);
router.delete('/:id', requireRole('admin'), ctrl.remove);

module.exports = router;
