const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/taxDeclarationController');

router.use(auth, requireClinic, requireRole('admin', 'contabilidad'));

// Estructura declarativa del formulario (la UI se dibuja con esto).
router.get('/definition', c.definition);

router.get('/', c.list);
router.post('/draft', c.draft);
router.get('/:id', c.get);
router.put('/:id', c.update);
router.post('/:id/recompute', c.recompute);
router.post('/:id/finalize', c.finalize);
router.post('/:id/substitute', c.substitute);
router.post('/:id/void', c.void);
router.post('/:id/pay', c.pay);
router.delete('/:id', c.remove);
router.get('/:id/draft.xml', c.draftXml);

module.exports = router;
