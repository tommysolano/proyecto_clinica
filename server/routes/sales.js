const router = require('express').Router();
const { getSales, getSale, createSale, cancelSale } = require('../controllers/saleController');
const { auth, authorize } = require('../middleware/auth');

router.use(auth);

router.get('/', getSales);
router.get('/:id', getSale);
router.post('/', createSale);
router.put('/:id/cancel', authorize('admin'), cancelSale);

module.exports = router;
