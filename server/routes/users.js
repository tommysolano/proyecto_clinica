const router = require('express').Router();
const {
  getUsers,
  getUser,
  createUser,
  updateUser,
  deleteUser,
  getDoctors,
  updateMySignature,
  getMySignature,
} = require('../controllers/userController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

router.get('/doctors', getDoctors);
// Firma digital del usuario actual (cualquier rol; típicamente doctor/optica).
router.get('/me/signature', getMySignature);
router.put('/me/signature', updateMySignature);
router.get('/', requireRole('admin'), getUsers);
router.get('/:id', requireRole('admin'), getUser);
router.post('/', requireRole('admin'), createUser);
router.put('/:id', requireRole('admin'), updateUser);
router.delete('/:id', requireRole('admin'), deleteUser);

module.exports = router;
