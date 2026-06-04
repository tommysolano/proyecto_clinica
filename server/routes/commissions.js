const router = require('express').Router();
const ctrl = require('../controllers/commissionController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

// Admin y contabilidad gestionan reglas de comisión y ven el reporte global.
router.get('/rules', requireRole('admin', 'contabilidad'), ctrl.listRules);
router.post('/rules', requireRole('admin', 'contabilidad'), ctrl.createRule);
router.put('/rules/:id', requireRole('admin', 'contabilidad'), ctrl.updateRule);
router.delete('/rules/:id', requireRole('admin', 'contabilidad'), ctrl.deleteRule);
router.get('/report', requireRole('admin', 'contabilidad'), ctrl.report);

module.exports = router;
