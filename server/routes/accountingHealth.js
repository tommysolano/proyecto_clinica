const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/accountingHealthController');

router.use(auth, requireClinic);
router.get('/', requireRole('admin', 'contabilidad'), c.check);

module.exports = router;
