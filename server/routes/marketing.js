const router = require('express').Router();
const ctrl = require('../controllers/marketingController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

router.get('/dashboard', requireRole('admin', 'marketing'), ctrl.dashboard);
router.get('/reminders', requireRole('admin', 'marketing'), ctrl.reminders);
router.get('/predictions', requireRole('admin', 'marketing'), ctrl.predictions);

module.exports = router;
