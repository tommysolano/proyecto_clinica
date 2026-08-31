const router = require('express').Router();
const c = require('../controllers/scanController');
const { auth, requireClinic } = require('../middleware/auth');

// El escáner de documentos está disponible para TODOS los roles: basta estar
// autenticado y con una sucursal activa (los documentos son de la sucursal).
router.use(auth, requireClinic);

router.get('/', c.listScans);
router.post('/', c.uploadMiddleware, c.createScan);
// Cuántos ZIP hacen falta y qué va en cada uno. Va antes de la descarga porque
// es lo que el cliente pregunta primero cuando son miles de documentos.
router.post('/zip-plan', c.zipPlan);
router.post('/download-zip', c.downloadZip);
router.post('/delete-many', c.deleteManyScans);
router.get('/:id/download', c.downloadScan);
router.patch('/:id', c.renameScan);
router.delete('/:id', c.deleteScan);

module.exports = router;
