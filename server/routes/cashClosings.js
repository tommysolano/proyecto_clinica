const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/cashClosingController');

router.use(auth, requireClinic);

const operan = requireRole('admin', 'contabilidad', 'cajero');
// Marketing revisa las cajas en SOLO LECTURA (nov-2026): el historial y su detalle, nada más.
const consultan = requireRole('admin', 'contabilidad', 'cajero', 'marketing');

router.get('/summary', operan, c.summary);
router.get('/current', operan, c.current);
router.get('/movements', operan, c.listMovements);
router.post('/movements', operan, c.addMovement);
router.post('/movements/:id/void', operan, c.voidMovement);
router.get('/branches', consultan, c.branches);
router.get('/', consultan, c.list);
router.get('/:id/detail', consultan, c.detail);
router.post('/open', operan, c.open);
router.post('/:id/close', operan, c.close);
router.post('/', operan, c.create);
router.post('/:id/cancel', operan, c.cancel);

module.exports = router;
