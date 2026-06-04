const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/cashClosingController');

router.use(auth, requireClinic, requireRole('admin', 'contabilidad', 'cajero'));

router.get('/summary', c.summary);
router.get('/', c.list);
router.post('/', c.create);
router.post('/:id/cancel', c.cancel);

module.exports = router;
