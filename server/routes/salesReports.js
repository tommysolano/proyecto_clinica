const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/salesReportsController');

router.use(auth, requireClinic, requireRole('admin', 'contabilidad', 'cajero', 'marketing'));

// Categorías de servicios (guardadas)
router.get('/categories', c.listCategories);
router.post('/categories', c.createCategory);
router.put('/categories/:id', c.updateCategory);
router.delete('/categories/:id', c.removeCategory);

// Reportes
router.get('/summary', c.summary);
router.get('/excel', c.exportExcel);

module.exports = router;
