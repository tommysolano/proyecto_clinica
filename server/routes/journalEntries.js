const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/journalEntryController');

router.use(auth, requireClinic);
router.get('/', requireRole('admin', 'contabilidad'), c.list);
router.get('/ledger', requireRole('admin', 'contabilidad'), c.ledger);
router.get('/trial-balance', requireRole('admin', 'contabilidad'), c.trialBalance);
router.get('/by-source', requireRole('admin', 'contabilidad'), c.bySource);
router.get('/:id/pdf', requireRole('admin', 'contabilidad'), c.pdf);
router.get('/:id', requireRole('admin', 'contabilidad'), c.get);
router.post('/', requireRole('admin', 'contabilidad'), c.create);
router.put('/:id', requireRole('admin', 'contabilidad'), c.updateDraft);
router.post('/:id/approve', requireRole('admin', 'contabilidad'), c.approve);
router.delete('/:id', requireRole('admin', 'contabilidad'), c.removeDraft);
router.post('/:id/reverse', requireRole('admin', 'contabilidad'), c.reverse);

module.exports = router;
