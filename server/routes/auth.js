const router = require('express').Router();
const { body } = require('express-validator');
const { login, selectClinic, getMe, changePassword, changeEmail } = require('../controllers/authController');
const { auth } = require('../middleware/auth');

router.post(
  '/login',
  [
    body('email').isEmail().withMessage('Email inválido'),
    body('password').notEmpty().withMessage('La contraseña es requerida'),
  ],
  login
);

router.post('/select-clinic', auth, selectClinic);
router.get('/me', auth, getMe);
router.post('/change-password', auth, changePassword);
router.post('/change-email', auth, changeEmail);

module.exports = router;
