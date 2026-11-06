const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/chartOfAccountController');

router.use(auth, requireClinic);
router.use(require('../middleware/accountingScope')());
// UN PLAN POR EMPRESA (nov-2026): se lee, se crea y se edita SIEMPRE en el plan de la empresa,
// desde cualquier sucursal (antes Odontología y Dermazen veían un plan propio, vacío). Las
// sucursales usan esas cuentas al registrar: el asiento toma su copia (utils/planEmpresa).
router.use(async (req, res, next) => {
  try {
    req.clinicId = await require('../utils/planEmpresa').clinicaDelPlan(req.clinicId);
    next();
  } catch (e) { next(e); }
});
// Consulta del plan: el cajero lo LEE para elegir la cuenta de ingreso/gasto al
// registrar un movimiento de caja (crear/editar cuentas sigue siendo de contabilidad).
router.get('/', requireRole('admin', 'contabilidad', 'cajero'), c.list);
router.get('/next-code', requireRole('admin', 'contabilidad'), c.suggestChild);
router.get('/:id', requireRole('admin', 'contabilidad'), c.get);
router.post('/', requireRole('admin', 'contabilidad'), c.create);
router.put('/:id', requireRole('admin', 'contabilidad'), c.update);
router.delete('/:id', requireRole('admin', 'contabilidad'), c.remove);
router.post('/seed', requireRole('admin', 'contabilidad'), c.seed);

module.exports = router;
