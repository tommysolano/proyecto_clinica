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

router.get('/', requireRole('admin', 'cajero', 'contabilidad'), getProducts);
router.get('/:id', requireRole('admin', 'cajero', 'contabilidad'), getProduct);
router.post('/', requireRole('admin', 'contabilidad'), createProduct);
router.put('/:id', requireRole('admin', 'contabilidad'), updateProduct);
router.delete('/:id', requireRole('admin'), deleteProduct);

module.exports = router;
