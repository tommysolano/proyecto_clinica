const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/supplierController');

router.use(auth, requireClinic);
router.get('/', requireRole('admin', 'contabilidad'), c.list);
// Buscador de clientes del mostrador (va ANTES de '/:id' o 'clients' se tomaría por un id).
// El cajero necesita facturar a una persona registrada como CLIENTE sin ver la ficha contable.
router.get('/clients', requireRole('admin', 'contabilidad', 'cajero'), c.searchClients);
router.get('/:id', requireRole('admin', 'contabilidad'), c.get);
router.post('/', requireRole('admin', 'contabilidad'), c.create);
router.put('/:id', requireRole('admin', 'contabilidad'), c.update);
router.delete('/:id', requireRole('admin'), c.remove);

module.exports = router;
