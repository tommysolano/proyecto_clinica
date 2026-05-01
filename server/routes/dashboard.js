const router = require('express').Router();
const { getDashboard } = require('../controllers/dashboardController');
const { auth, requireClinic } = require('../middleware/auth');

router.get('/', auth, requireClinic, getDashboard);

module.exports = router;
