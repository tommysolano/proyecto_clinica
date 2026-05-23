const router = require('express').Router();
const { getMovements, createMovement, getConsolidated } = require('../controllers/productController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

// Endpoint multi-clínica: no requiere clinic context (agrega todas las clínicas a las que pertenece el usuario)
router.get('/consolidated', auth, requireRole('admin', 'contabilidad'), getConsolidated);

router.use(auth, requireClinic);

router.get('/', requireRole('admin', 'contabilidad'), getMovements);
router.post('/', requireRole('admin', 'contabilidad'), createMovement);

module.exports = router;
