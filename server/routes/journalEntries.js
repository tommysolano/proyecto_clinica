const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/journalEntryController');

router.use(auth, requireClinic);
router.get('/', requireRole('admin', 'contabilidad'), c.list);
router.get('/ledger', requireRole('admin', 'contabilidad'), c.ledger);
router.get('/trial-balance', requireRole('admin', 'contabilidad'), c.trialBalance);
router.get('/:id', requireRole('admin', 'contabilidad'), c.get);
router.post('/', requireRole('admin', 'contabilidad'), c.create);
router.post('/:id/reverse', requireRole('admin', 'contabilidad'), c.reverse);

module.exports = router;
