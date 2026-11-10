const router = require('express').Router();
const ctrl = require('../controllers/invoicingConfigController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

router.get('/', requireRole('admin', 'contabilidad'), ctrl.getConfig);
router.put('/', requireRole('admin', 'contabilidad'), ctrl.upsertConfig);
router.put('/email', requireRole('admin', 'contabilidad'), ctrl.saveEmailConfig);
router.post('/email/verify', requireRole('admin', 'contabilidad'), ctrl.verifyEmailConfig);
router.post('/email/gmail/start', requireRole('admin', 'contabilidad'), ctrl.startGmailAuth);
router.post('/email/gmail/complete', requireRole('admin', 'contabilidad'), ctrl.completeGmailAuth);
router.post('/certificate', requireRole('admin', 'contabilidad'), ctrl.uploadMiddleware, ctrl.uploadCertificate);
router.delete('/certificate', requireRole('admin', 'contabilidad'), ctrl.deleteCertificate);

module.exports = router;
