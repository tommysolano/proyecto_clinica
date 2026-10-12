const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/cashPanelController');

// «Caja e ingresos»: de la SUCURSAL, como Cierre de caja y Depósitos (sin accountingScope).
router.use(auth, requireClinic, requireRole('admin', 'contabilidad', 'cajero'));

router.get('/', c.panel);
router.get('/salidas', c.salidas);
router.get('/depositos', c.depositos);
router.get('/cuentas', c.cuentas);
router.post('/vales', c.crearVale);
router.post('/salidas/:entryId/void', c.anularSalida);

module.exports = router;
