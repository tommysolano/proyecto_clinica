const router = require('express').Router();
const { getMovements, createMovement } = require('../controllers/productController');
const { auth, authorize } = require('../middleware/auth');

router.use(auth);

router.get('/', getMovements);
router.post('/', authorize('admin', 'recepcionista'), createMovement);

module.exports = router;
