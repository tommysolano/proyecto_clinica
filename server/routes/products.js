const router = require('express').Router();
const {
  getProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
} = require('../controllers/productController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

// Lectura de catálogo: necesaria para múltiples roles (marketing, doctor,
// call_center, enfermero), por ej. para filtros, agenda, tratamientos y
// paneles de marketing. La escritura sigue restringida.
router.get('/', requireRole('admin', 'cajero', 'contabilidad', 'marketing', 'doctor', 'call_center', 'enfermero'), getProducts);
router.get('/:id', requireRole('admin', 'cajero', 'contabilidad', 'marketing', 'doctor', 'call_center', 'enfermero'), getProduct);
router.post('/', requireRole('admin', 'contabilidad'), createProduct);
router.put('/:id', requireRole('admin', 'contabilidad'), updateProduct);
router.delete('/:id', requireRole('admin'), deleteProduct);

module.exports = router;
