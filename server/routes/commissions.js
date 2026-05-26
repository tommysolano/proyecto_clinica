const router = require('express').Router();
const ctrl = require('../controllers/commissionController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

// Solo admin y super-admin gestionan reglas de comisión y ven el reporte global.
router.get('/rules', requireRole('admin'), ctrl.listRules);
router.post('/rules', requireRole('admin'), ctrl.createRule);
router.put('/rules/:id', requireRole('admin'), ctrl.updateRule);
router.delete('/rules/:id', requireRole('admin'), ctrl.deleteRule);
router.get('/report', requireRole('admin'), ctrl.report);

module.exports = router;
