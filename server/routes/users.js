const router = require('express').Router();
const { getUsers, getUser, updateUser, deleteUser, getDoctors } = require('../controllers/userController');
const { auth, authorize } = require('../middleware/auth');

router.use(auth);

router.get('/', authorize('admin'), getUsers);
router.get('/doctors', getDoctors);
router.get('/:id', authorize('admin'), getUser);
router.put('/:id', authorize('admin'), updateUser);
router.delete('/:id', authorize('admin'), deleteUser);

module.exports = router;
