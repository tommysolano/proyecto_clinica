const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/creditDebitNoteController');

router.use(auth, requireClinic);
router.get('/', requireRole('admin', 'contabilidad'), c.list);
router.get('/:id', requireRole('admin', 'contabilidad'), c.get);
router.post('/', requireRole('admin', 'contabilidad'), c.create);
router.post('/:id/emit', requireRole('admin', 'contabilidad'), c.emit);
router.post('/:id/void', requireRole('admin', 'contabilidad'), c.void);

module.exports = router;
