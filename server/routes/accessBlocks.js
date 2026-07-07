const router = require('express').Router();
const {
  getAccessBlocks,
  createAccessBlock,
  updateAccessBlock,
  deleteAccessBlock,
} = require('../controllers/accessBlockController');
const { auth, requireSuperAdmin } = require('../middleware/auth');

// Solo el super-admin gestiona el bloqueo de acceso al sistema.
router.use(auth, requireSuperAdmin);

router.get('/', getAccessBlocks);
router.post('/', createAccessBlock);
router.put('/:id', updateAccessBlock);
router.delete('/:id', deleteAccessBlock);

module.exports = router;
