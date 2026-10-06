const router = require('express').Router();
const ctrl = require('../controllers/reportController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);
// Los Excel de ventas, facturas e inventario leen la contabilidad de la empresa
// (Contífico), filtrada por el centro de costo de la sucursal.
const contable = require('../middleware/accountingScope')();

router.get('/sales.xlsx', requireRole('admin', 'contabilidad', 'cajero'), contable, ctrl.exportSales);
router.get(
  '/appointments.xlsx',
  // Solo el administrador puede descargar el Excel de citas.
  requireRole('admin'),
  ctrl.exportAppointments
);
router.get('/invoices.xlsx', requireRole('admin', 'cajero', 'contabilidad'), contable, ctrl.exportInvoices);
router.get(
  '/patients.xlsx',
  requireRole('admin', 'cajero', 'marketing', 'call_center'),
  ctrl.exportPatients
);
router.get('/inventory.xlsx', requireRole('admin', 'contabilidad'), contable, ctrl.exportInventory);
router.get('/sales-by-item.xlsx', requireRole('admin', 'contabilidad'), contable, ctrl.exportSalesByItem);

// Reportes de atención (admin, marketing, super-admin). Pacientes atendidos por
// doctor/enfermero por fecha y adherencia a tratamientos recetados.
router.get('/attention', requireRole('admin', 'marketing'), ctrl.attentionReport);
router.get('/patient-adherence/:patientId', requireRole('admin', 'marketing'), ctrl.patientAdherence);

module.exports = router;
