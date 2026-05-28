const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/bankController');

router.use(auth, requireClinic);

// Cuentas
router.get('/accounts', requireRole('admin', 'contabilidad'), c.listAccounts);
router.post('/accounts', requireRole('admin', 'contabilidad'), c.createAccount);
router.put('/accounts/:id', requireRole('admin', 'contabilidad'), c.updateAccount);
router.delete('/accounts/:id', requireRole('admin'), c.deleteAccount);
router.get('/balances', requireRole('admin', 'contabilidad'), c.balances);

// Movimientos
router.get('/transactions', requireRole('admin', 'contabilidad'), c.listMovements);
router.post('/transactions', requireRole('admin', 'contabilidad'), c.createMovement);
router.post('/transactions/:id/void', requireRole('admin', 'contabilidad'), c.voidMovement);
router.post('/cash-to-transfer', requireRole('admin', 'contabilidad'), c.cashToTransfer);
router.get('/cash-pending', requireRole('admin', 'contabilidad'), c.getCashPending);

// Conciliación
router.get('/reconciliations', requireRole('admin', 'contabilidad'), c.listReconciliations);
router.post('/reconciliations', requireRole('admin', 'contabilidad'), c.startReconciliation);
router.put('/reconciliations/:id', requireRole('admin', 'contabilidad'), c.updateReconciliation);
router.post('/reconciliations/:id/close', requireRole('admin', 'contabilidad'), c.closeReconciliation);

// Cheques (chequera)
router.get('/checks', requireRole('admin', 'contabilidad'), c.listChecks);
router.post('/checks/generate', requireRole('admin', 'contabilidad'), c.generateChecks);
router.post('/checks/:id/void', requireRole('admin', 'contabilidad'), c.voidCheck);

// Tarjetas de crédito + POS
router.get('/cards', requireRole('admin', 'contabilidad'), c.listCards);
router.post('/cards', requireRole('admin', 'contabilidad'), c.createCard);
router.put('/cards/:id', requireRole('admin', 'contabilidad'), c.updateCard);
router.delete('/cards/:id', requireRole('admin'), c.deleteCard);

module.exports = router;
