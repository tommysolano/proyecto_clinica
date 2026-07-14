const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/cashFlowController');

// Mismos permisos que el resto de reportes contables.
router.use(auth, requireClinic, requireRole('admin', 'contabilidad'));

// Configuración
router.get('/config', c.getConfig);
router.put('/config', c.updateConfig);

// Proyección (motor único: la UI no recalcula saldos)
router.get('/projection', c.projection);
router.get('/projection/cell', c.cellDetail);
router.get('/projection.xlsx', c.projectionExcel);

// Movimientos reales (vista separada de lo ya realizado)
router.get('/movements', c.movements);

// Decisiones sobre un documento (no generan asientos ni tocan el vencimiento legal)
router.post('/reschedule', c.reschedule);
router.post('/classify', c.classifyDoc);
router.post('/unclassify', c.unclassifyDoc);
router.post('/exclude', c.setExcluded);
router.post('/note', c.addNote);
router.get('/history', c.docHistory);

// Partidas manuales (previsiones sin efecto contable)
router.get('/manual-items', c.listManualItems);
router.post('/manual-items', c.createManualItem);
router.put('/manual-items/:id', c.updateManualItem);
router.get('/settlement-candidates', c.settlementCandidates);
router.post('/manual-items/:id/settle', c.settleManualItem);
router.post('/manual-items/:id/cancel', c.cancelManualItem);

// Reglas de clasificación automática
router.get('/mappings', c.listMappings);
router.post('/mappings', c.createMapping);
router.put('/mappings/:id', c.updateMapping);
router.delete('/mappings/:id', c.deleteMapping);

module.exports = router;
