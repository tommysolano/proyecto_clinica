const router = require('express').Router();
const ctrl = require('../controllers/appointmentServiceItemController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

// Ver el catálogo: cualquiera que entre al sistema (el selector de servicio sale
// en los formularios de cita, en la agenda y en el chat del call center).
router.get('/', ctrl.list);

// Crear AL VUELO. Aquí es donde este CRUD se aparta del de consultorios: el
// requisito es que quien agenda pueda añadir el servicio que le falta sin pedirle
// nada a un administrador, y que a partir de ahí lo vean los demás.
router.post('/', requireRole('admin', 'cajero', 'call_center', 'marketing', 'doctor'), ctrl.create);

// Renombrar, cambiar color, marcar como de enfermería o dar de baja: solo admin.
// Es lo que evita que el catálogo se llene de duplicados sin nadie que limpie.
router.put('/:id', requireRole('admin'), ctrl.update);
router.delete('/:id', requireRole('admin'), ctrl.remove);

module.exports = router;
