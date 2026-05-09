const router = require('express').Router();
const ctrl = require('../controllers/roomController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

// Cualquier usuario logueado puede ver el listado (para selector en citas)
router.get('/', ctrl.list);
// Solo el administrador puede gestionar consultorios y asignar encargados
router.post('/', requireRole('admin'), ctrl.create);
router.put('/:id', requireRole('admin'), ctrl.update);
router.delete('/:id', requireRole('admin'), ctrl.remove);

module.exports = router;
