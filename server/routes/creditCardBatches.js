const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/creditCardBatchController');

router.use(auth, requireClinic, requireRole('admin', 'contabilidad', 'cajero'));

router.get('/', c.list);
router.get('/:id', c.get);
router.post('/', c.create);
router.put('/:id', c.update);
router.post('/:id/liquidate', c.liquidate);
router.post('/:id/cancel', c.cancel);

module.exports = router;
