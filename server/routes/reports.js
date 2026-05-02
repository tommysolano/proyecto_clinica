const router = require('express').Router();
const ctrl = require('../controllers/reportController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

router.get('/sales.xlsx', requireRole('admin', 'cajero', 'contabilidad'), ctrl.exportSales);
router.get(
  '/appointments.xlsx',
  requireRole('admin', 'cajero', 'doctor', 'contabilidad'),
  ctrl.exportAppointments
);
router.get('/invoices.xlsx', requireRole('admin', 'cajero', 'contabilidad'), ctrl.exportInvoices);
router.get(
  '/patients.xlsx',
  requireRole('admin', 'cajero', 'doctor'),
  ctrl.exportPatients
);
router.get('/inventory.xlsx', requireRole('admin', 'contabilidad'), ctrl.exportInventory);

module.exports = router;
