const router = require('express').Router();
const {
  getProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  getMovements,
  createMovement,
} = require('../controllers/productController');
const { auth, authorize } = require('../middleware/auth');

router.use(auth);

router.get('/', getProducts);
router.get('/:id', getProduct);
router.post('/', authorize('admin', 'recepcionista'), createProduct);
router.put('/:id', authorize('admin', 'recepcionista'), updateProduct);
router.delete('/:id', authorize('admin'), deleteProduct);

module.exports = router;
