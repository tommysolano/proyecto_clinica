const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/salesReportsController');

router.use(auth, requireClinic, requireRole('admin', 'contabilidad', 'cajero', 'marketing'));

// Categorías de servicios (agrupación REAL del negocio, no una búsqueda guardada).
router.get('/categories', c.listCategories);
router.post('/categories', requireRole('admin', 'contabilidad'), c.createCategory);
router.put('/categories/:id', requireRole('admin', 'contabilidad'), c.updateCategory);
router.delete('/categories/:id', requireRole('admin', 'contabilidad'), c.removeCategory);

/**
 * Presets = consultas guardadas. Consultarlos lo puede hacer cualquiera que vea el reporte;
 * crearlos y borrarlos, no: son configuración compartida de la clínica.
 */
router.get('/presets', c.listPresets);
router.post('/presets', requireRole('admin', 'contabilidad'), c.createPreset);
router.put('/presets/:id', requireRole('admin', 'contabilidad'), c.updatePreset);
router.post('/presets/:id/duplicate', requireRole('admin', 'contabilidad'), c.duplicatePreset);
router.delete('/presets/:id', requireRole('admin', 'contabilidad'), c.removePreset);

// Reportes (motor único: pantalla y Excel salen del mismo servicio).
router.get('/summary', c.summary);
router.get('/report', c.report);
// La exportación es una acción sensible (se lleva la información fuera): admin/contabilidad.
router.get('/report.xlsx', requireRole('admin', 'contabilidad'), c.exportReportExcel);
// El MISMO Excel de la pantalla de Ventas (el formato con el que trabaja el contador),
// pero acotado a los filtros del reporte.
router.get('/ventas.xlsx', requireRole('admin', 'contabilidad'), c.exportSalesSheetExcel);
router.get('/excel', requireRole('admin', 'contabilidad'), c.exportExcel);

module.exports = router;
