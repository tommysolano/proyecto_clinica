const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/cardSettlementController');

router.use(auth, requireClinic, requireRole('admin', 'contabilidad', 'cajero'));

router.get('/', c.list);
router.get('/card-sales', c.searchCardSales);
router.get('/:id', c.get);
router.post('/', c.create);
router.put('/:id', c.update);
router.post('/:id/accredit', c.accredit);
router.post('/:id/cancel', c.cancel);
router.delete('/:id', c.remove);

module.exports = router;
