const router = require('express').Router();
const ctrl = require('../controllers/messageTemplateController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

const ROLES = ['admin', 'marketing'];

router.get('/', requireRole(...ROLES), ctrl.list);
router.post('/', requireRole(...ROLES), ctrl.create);
router.post('/sync-whatsapp', requireRole(...ROLES), ctrl.syncWhatsapp);
router.get('/:id', requireRole(...ROLES), ctrl.get);
router.put('/:id', requireRole(...ROLES), ctrl.update);
router.delete('/:id', requireRole(...ROLES), ctrl.remove);

module.exports = router;
