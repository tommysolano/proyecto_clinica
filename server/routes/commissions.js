const router = require('express').Router();
const ctrl = require('../controllers/commissionController');
const { auth, requireClinic, requireRole, requireSuperAdmin } = require('../middleware/auth');

router.use(auth, requireClinic);

// Resumen de atenciones por doctor: solo el super administrador (módulo de comisiones).
router.get('/doctor-summary', requireSuperAdmin, ctrl.doctorSummary);
router.get('/doctor-appointments', requireSuperAdmin, ctrl.doctorAppointments);
router.put('/doctor-service-rule', requireSuperAdmin, ctrl.saveDoctorServiceRule);
router.put('/doctor-patient-rule', requireSuperAdmin, ctrl.saveDoctorPatientRule);
// Tarifa por derivación realizada (base o por servicio derivado).
router.put('/doctor-referral-rule', requireSuperAdmin, ctrl.saveDoctorReferralRule);
// Doctores (general o especialidad) para los filtros, de una sucursal o de todas.
router.get('/doctors', requireSuperAdmin, ctrl.doctorOptions);
// Pagos por período: marcar como pagado lo ganado entre dos fechas, y deshacerlo.
router.post('/payouts', requireSuperAdmin, ctrl.createPayouts);
router.delete('/payouts/:id', requireSuperAdmin, ctrl.deletePayout);
// Ajustes manuales: sumar (o restar) un valor a las comisiones del doctor con
// observación, para corregir comisiones que el sistema no contabilizó bien.
router.post('/doctor-adjustment', requireSuperAdmin, ctrl.saveDoctorAdjustment);
router.delete('/doctor-adjustment/:id', requireSuperAdmin, ctrl.deleteDoctorAdjustment);
// Reporte PDF por doctor: fecha, paciente, servicio y valor de la comisión.
router.get('/doctor-report.pdf', requireSuperAdmin, ctrl.doctorReportPdf);
// Apartado MARKETING: el super-admin y el rol marketing (sep-2026). Marketing
// entra a Comisiones solo por este apartado; el de doctores sigue siendo del
// super-admin (requireRole deja pasar al super-admin siempre).
// Agendamientos por agente de call center (pacientes nuevos vs recurrentes).
router.get('/callcenter-summary', requireRole('marketing'), ctrl.callCenterSummary);
// Los pacientes nuevos que agendó el call center, uno por uno.
router.get('/callcenter-new-patients', requireRole('marketing'), ctrl.callCenterNewPatients);

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
