const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/cashClosingController');

router.use(auth, requireClinic, requireRole('admin', 'contabilidad', 'cajero'));

router.get('/summary', c.summary);
router.get('/current', c.current);
router.get('/movements', c.listMovements);
router.post('/movements', c.addMovement);
router.post('/movements/:id/void', c.voidMovement);
router.get('/', c.list);
router.post('/open', c.open);
router.post('/:id/close', c.close);
router.post('/', c.create);
router.post('/:id/cancel', c.cancel);

module.exports = router;
