const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/cashDepositController');

router.use(auth, requireClinic);

// El efectivo pendiente lo consulta también el cajero desde Caja.
router.get('/pending', requireRole('admin', 'contabilidad', 'cajero'), c.pending);
router.get('/', requireRole('admin', 'contabilidad'), c.list);
router.get('/:id', requireRole('admin', 'contabilidad'), c.get);
router.post('/', requireRole('admin', 'contabilidad', 'cajero'), c.create);
// Un depósito NO se edita: se anula (reversa su asiento y libera los documentos) y se rehace.
router.post('/:id/void', requireRole('admin', 'contabilidad'), c.void);

module.exports = router;
