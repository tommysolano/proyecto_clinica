const router = require('express').Router();
const { body } = require('express-validator');
const { login, selectClinic, getMe } = require('../controllers/authController');
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

module.exports = router;
