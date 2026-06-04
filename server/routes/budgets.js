const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/budgetController');

router.use(auth, requireClinic, requireRole('admin', 'contabilidad'));

router.get('/', c.list);
router.get('/execution', c.execution);
router.get('/:id', c.get);
router.post('/', c.upsert);
router.delete('/:id', c.remove);

module.exports = router;
