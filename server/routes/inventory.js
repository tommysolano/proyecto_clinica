const router = require('express').Router();
const { getMovements, createMovement } = require('../controllers/productController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

router.get('/', requireRole('admin', 'contabilidad'), getMovements);
router.post('/', requireRole('admin', 'contabilidad'), createMovement);

module.exports = router;
