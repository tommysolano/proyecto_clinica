const router = require('express').Router();
const { auth, requireClinic } = require('../middleware/auth');
const { requireCap } = require('../utils/permissions');
const c = require('../controllers/cashFlowController');

router.use(auth, requireClinic);

// Separación LECTURA / ESCRITURA (pedido de la contadora: que otros solo VISUALICEN).
//   · cashflow.view   → ver la proyección, el detalle de celdas, el Excel y los movimientos.
//   · cashflow.manage → configurar, clasificar, excluir, reprogramar, partidas y reglas.
// admin y contabilidad tienen ambas; cajero solo `view` (solo lectura). Ver utils/permissions.js.
const canView = requireCap('cashflow.view');
const canManage = requireCap('cashflow.manage');

// ── LECTURA (solo-visualización) ───────────────────────────────────────────────────────
router.get('/config', canView, c.getConfig);
router.get('/projection', canView, c.projection);
router.get('/projection/cell', canView, c.cellDetail);
router.get('/projection.xlsx', canView, c.projectionExcel);
router.get('/movements', canView, c.movements);
router.get('/history', canView, c.docHistory);
router.get('/manual-items', canView, c.listManualItems);
router.get('/settlement-candidates', canView, c.settlementCandidates);
router.get('/mappings', canView, c.listMappings);
router.get('/suppliers', canView, c.suppliers);

// ── ESCRITURA (configuración y decisiones) ─────────────────────────────────────────────
router.put('/config', canManage, c.updateConfig);

// Decisiones sobre un documento (no generan asientos ni tocan el vencimiento legal)
router.post('/reschedule', canManage, c.reschedule);
router.post('/classify', canManage, c.classifyDoc);
router.post('/unclassify', canManage, c.unclassifyDoc);
router.post('/exclude', canManage, c.setExcluded);
router.post('/note', canManage, c.addNote);

// Partidas manuales (previsiones sin efecto contable)
router.post('/manual-items', canManage, c.createManualItem);
router.put('/manual-items/:id', canManage, c.updateManualItem);
router.post('/manual-items/:id/settle', canManage, c.settleManualItem);
router.post('/manual-items/:id/cancel', canManage, c.cancelManualItem);

// Reglas de clasificación automática
router.post('/mappings', canManage, c.createMapping);
router.put('/mappings/:id', canManage, c.updateMapping);
router.delete('/mappings/:id', canManage, c.deleteMapping);

// Asignación de proveedores a categorías de egreso (reglas SUPPLIER con exclusión progresiva)
router.post('/suppliers/assign', canManage, c.assignSupplier);
router.post('/suppliers/unassign', canManage, c.unassignSupplier);

module.exports = router;
