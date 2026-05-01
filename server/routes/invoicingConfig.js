const router = require('express').Router();
const ctrl = require('../controllers/invoicingConfigController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

router.get('/', requireRole('admin', 'contabilidad'), ctrl.getConfig);
router.put('/', requireRole('admin'), ctrl.upsertConfig);
router.post('/certificate', requireRole('admin'), ctrl.uploadMiddleware, ctrl.uploadCertificate);

module.exports = router;
