const router = require('express').Router();
const { taxIdLookup, emailLookup } = require('../controllers/lookupController');
const { auth, requireClinic } = require('../middleware/auth');

// Consulta de cédula/RUC en el SRI para autocompletar formularios. Disponible
// para cualquier usuario autenticado con una clínica activa (todos los roles).
router.get('/tax-id/:id', auth, requireClinic, taxIdLookup);

// Validación de correo (formato + MX del dominio + sugerencia de typos).
router.get('/email', auth, requireClinic, emailLookup);

module.exports = router;
