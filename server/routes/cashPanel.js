const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/cashPanelController');

// «Caja e ingresos»: de la SUCURSAL, como Cierre de caja y Depósitos (sin accountingScope).
router.use(auth, requireClinic, requireRole('admin', 'contabilidad', 'cajero'));

// Super administrador y contabilidad: cajas abiertas de la empresa para escoger una
// (nov-2026). Va ANTES de la caja seleccionada: lista todas, no opera sobre una.
router.get('/cajas-abiertas', c.cajasAbiertas);
// Con la cabecera X-Caja, todo lo de abajo opera sobre esa caja y su sucursal.
router.use(require('../middleware/cajaSeleccionada'));

router.get('/', c.panel);
router.get('/salidas', c.salidas);
router.get('/depositos', c.depositos);
router.get('/cuentas', c.cuentas);
router.post('/vales', c.crearVale);
router.post('/salidas/:entryId/void', c.anularSalida);

module.exports = router;
