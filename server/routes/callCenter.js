const router = require('express').Router();
const ctrl = require('../controllers/callCenterController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

const VIEW_ROLES = ['admin', 'call_center', 'marketing'];

router.get('/commissions', requireRole(...VIEW_ROLES), ctrl.getCommissions);
router.get('/summary', requireRole(...VIEW_ROLES), ctrl.getAgentSummary);
router.get('/agents', requireRole('admin', 'marketing'), ctrl.listAgents);

module.exports = router;
