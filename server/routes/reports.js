const router = require('express').Router();
const ctrl = require('../controllers/reportController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

router.get('/sales.xlsx', requireRole('admin', 'contabilidad'), ctrl.exportSales);
router.get(
  '/appointments.xlsx',
  // Solo el administrador puede descargar el Excel de citas.
  requireRole('admin'),
  ctrl.exportAppointments
);
router.get('/invoices.xlsx', requireRole('admin', 'cajero', 'contabilidad'), ctrl.exportInvoices);
router.get(
  '/patients.xlsx',
  requireRole('admin', 'cajero', 'marketing'),
  ctrl.exportPatients
);
router.get('/inventory.xlsx', requireRole('admin', 'contabilidad'), ctrl.exportInventory);
router.get('/sales-by-item.xlsx', requireRole('admin', 'contabilidad'), ctrl.exportSalesByItem);

// Reportes de atención (admin, marketing, super-admin). Pacientes atendidos por
// doctor/enfermero por fecha y adherencia a tratamientos recetados.
router.get('/attention', requireRole('admin', 'marketing'), ctrl.attentionReport);
router.get('/patient-adherence/:patientId', requireRole('admin', 'marketing'), ctrl.patientAdherence);

module.exports = router;
