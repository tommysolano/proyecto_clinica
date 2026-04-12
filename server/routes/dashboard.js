const router = require('express').Router();
const { getDashboard } = require('../controllers/dashboardController');
const { auth } = require('../middleware/auth');

router.get('/', auth, getDashboard);

module.exports = router;
