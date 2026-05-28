const router = require('express').Router();
const {
  getClinics,
  getClinic,
  createClinic,
  updateClinic,
  deleteClinic,
  logoUploadMiddleware,
  uploadLogo,
  removeLogo,
} = require('../controllers/clinicController');
const { auth, requireSuperAdmin } = require('../middleware/auth');

router.use(auth);

router.get('/', getClinics);
router.get('/:id', getClinic);
router.post('/', requireSuperAdmin, createClinic);
router.put('/:id', updateClinic);
router.delete('/:id', requireSuperAdmin, deleteClinic);

router.post('/:id/logo', logoUploadMiddleware, uploadLogo);
router.delete('/:id/logo', removeLogo);

module.exports = router;
