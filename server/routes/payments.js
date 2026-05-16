const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/paymentController');

router.use(auth, requireClinic);
router.get('/', requireRole('admin', 'contabilidad', 'cajero'), c.list);
router.get('/:id', requireRole('admin', 'contabilidad', 'cajero'), c.get);
router.post('/', requireRole('admin', 'contabilidad', 'cajero'), c.create);
router.post('/:id/void', requireRole('admin', 'contabilidad'), c.void);

module.exports = router;
