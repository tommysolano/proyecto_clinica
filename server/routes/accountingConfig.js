const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/accountingConfigController');

router.use(auth, requireClinic, requireRole('admin', 'contabilidad'));

router.get('/', c.get);
router.put('/', c.update);

module.exports = router;
