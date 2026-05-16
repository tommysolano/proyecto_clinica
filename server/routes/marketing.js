const router = require('express').Router();
const ctrl = require('../controllers/marketingController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

router.get('/dashboard', requireRole('admin', 'marketing'), ctrl.dashboard);
router.get('/reminders', requireRole('admin', 'marketing'), ctrl.reminders);
router.get('/predictions', requireRole('admin', 'marketing'), ctrl.predictions);
router.get('/incomplete-services', requireRole('admin', 'marketing'), ctrl.incompleteServices);
router.get('/service-evolution', requireRole('admin', 'marketing'), ctrl.serviceEvolution);
router.get('/heatmap', requireRole('admin', 'marketing'), ctrl.heatmap);
router.get('/guayaquil-zones', requireRole('admin', 'marketing', 'cajero', 'doctor'), ctrl.guayaquilZones);
router.get('/programs', requireRole('admin', 'marketing'), ctrl.programs);
router.get('/next-week', requireRole('admin', 'marketing'), ctrl.nextWeek);
router.get('/appointments-breakdown', requireRole('admin', 'marketing'), ctrl.appointmentsBreakdown);
router.get('/referrers', requireRole('admin', 'marketing'), ctrl.referrers);

module.exports = router;
