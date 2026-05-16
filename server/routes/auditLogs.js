const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/auditLogController');

router.use(auth, requireClinic, requireRole('admin', 'contabilidad'));
router.get('/', c.list);

module.exports = router;
