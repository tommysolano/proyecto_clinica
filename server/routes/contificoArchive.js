const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const controller = require('../controllers/contificoArchiveController');

router.use(auth, requireClinic, requireRole('admin', 'contabilidad'));
router.get('/summary', controller.summary);
router.get('/runs', controller.runs);
router.get('/records', controller.list);
router.get('/records/:entity/:externalId', controller.detail);

module.exports = router;
