const router = require('express').Router();
const c = require('../controllers/companyController');
const { auth, requireSuperAdmin } = require('../middleware/auth');

// Empresas (oct-2026). Listarlas lo necesita quien agenda (empresa → sucursal);
// crearlas, editarlas y copiar catálogos es del super-admin.
router.use(auth);
router.get('/', c.list);
router.post('/', requireSuperAdmin, c.create);
router.put('/:id', requireSuperAdmin, c.update);
router.post('/:id/copy-catalog', requireSuperAdmin, c.copyCatalog);

module.exports = router;
