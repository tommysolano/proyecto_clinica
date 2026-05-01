const router = require('express').Router();
const {
  getClinics,
  getClinic,
  createClinic,
  updateClinic,
  deleteClinic,
} = require('../controllers/clinicController');
const { auth, requireSuperAdmin } = require('../middleware/auth');

router.use(auth);

router.get('/', getClinics);
router.get('/:id', getClinic);
router.post('/', requireSuperAdmin, createClinic);
router.put('/:id', updateClinic);
router.delete('/:id', requireSuperAdmin, deleteClinic);

module.exports = router;
