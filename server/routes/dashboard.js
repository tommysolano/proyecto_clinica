const router = require('express').Router();
const { getDashboard, getTopProducts } = require('../controllers/dashboardController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.get('/', auth, requireClinic, getDashboard);
router.get(
  '/top-products',
  auth,
  requireClinic,
  requireRole('admin', 'cajero', 'contabilidad'),
  getTopProducts
);

module.exports = router;
