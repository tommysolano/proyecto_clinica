const router = require('express').Router();
const {
  getClinics,
  getClinicsOverview,
  getClinic,
  createClinic,
  updateClinic,
  deleteClinic,
  logoUploadMiddleware,
  uploadLogo,
  removeLogo,
  moveClinic,
} = require('../controllers/clinicController');
const { auth, requireSuperAdmin } = require('../middleware/auth');

router.use(auth);

router.get('/', getClinics);
router.get('/overview', getClinicsOverview);
router.get('/:id', getClinic);
router.post('/', requireSuperAdmin, createClinic);
router.put('/:id', updateClinic);
router.delete('/:id', requireSuperAdmin, deleteClinic);
// Mover a otra empresa: nace una sucursal nueva allá y esta queda con su historial.
router.post('/:id/move', requireSuperAdmin, moveClinic);

router.post('/:id/logo', logoUploadMiddleware, uploadLogo);
router.delete('/:id/logo', removeLogo);

module.exports = router;
