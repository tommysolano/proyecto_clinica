const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/subledgerController');

router.use(auth, requireClinic);
router.get('/', requireRole('admin', 'contabilidad', 'cajero'), c.list);
router.get('/aging', requireRole('admin', 'contabilidad'), c.aging);
router.get('/statement', requireRole('admin', 'contabilidad', 'cajero'), c.statement);

module.exports = router;
