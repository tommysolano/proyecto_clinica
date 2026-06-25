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
router.get('/report.xlsx', requireRole('admin', 'contabilidad'), ctrl.reportExcel);

// Contabilización de comisiones devengadas (genera asiento contable).
router.get('/postings', requireRole('admin', 'contabilidad'), ctrl.listPostings);
router.post('/post', requireRole('admin', 'contabilidad'), ctrl.postCommissions);
router.post('/postings/:id/cancel', requireRole('admin', 'contabilidad'), ctrl.cancelPosting);

module.exports = router;
