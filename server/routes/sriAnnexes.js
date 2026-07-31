const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/sriAnnexController');

router.use(auth, requireClinic);

const accounting = requireRole('admin', 'contabilidad');

// ── RDEP (anexo anual del Formulario 103: relación de dependencia)
router.get('/rdep', accounting, c.getRdep);
router.put('/rdep', accounting, c.saveRdep);
router.get('/rdep/export.xlsx', accounting, c.exportRdepXlsx);
router.get('/rdep/draft.xml', accounting, c.exportRdepXml);

// ── Anexo de Accionistas (APS) — el listado va ANTES de /aps para no chocar rutas
router.get('/shareholders', accounting, c.listShareholders);
router.post('/shareholders', accounting, c.createShareholder);
router.put('/shareholders/:id', accounting, c.updateShareholder);
router.delete('/shareholders/:id', accounting, c.removeShareholder);

router.get('/aps', accounting, c.getAps);
router.get('/aps/export.xlsx', accounting, c.exportApsXlsx);
router.get('/aps/draft.xml', accounting, c.exportApsXml);

module.exports = router;
