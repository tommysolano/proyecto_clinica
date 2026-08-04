const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/bankController');

router.use(auth, requireClinic);

// Opciones de medios de pago para el cobro (cajero/recepción/admin/contabilidad)
router.get('/payment-options', requireRole('admin', 'contabilidad', 'cajero', 'enfermero'), c.paymentOptions);

// Cuentas
router.get('/accounts', requireRole('admin', 'contabilidad'), c.listAccounts);
router.post('/accounts', requireRole('admin', 'contabilidad'), c.createAccount);
router.put('/accounts/:id', requireRole('admin', 'contabilidad'), c.updateAccount);
router.delete('/accounts/:id', requireRole('admin'), c.deleteAccount);
router.get('/balances', requireRole('admin', 'contabilidad'), c.balances);
// Libro del banco: movimientos con saldo corrido hasta el corte (ventas/cobros y pagos)
router.get('/accounts/:id/ledger', requireRole('admin', 'contabilidad'), c.bankLedger);

// Movimientos
router.get('/transactions', requireRole('admin', 'contabilidad'), c.listMovements);
// Excel del listado con los MISMOS filtros de la pantalla (va antes de las rutas con :id).
router.get('/transactions/export.xlsx', requireRole('admin', 'contabilidad'), c.movementsExcel);
router.post('/transactions', requireRole('admin', 'contabilidad'), c.createMovement);
// Corregir un movimiento MANUAL: anula el anterior y registra el corregido (los asientos no se editan).
router.put('/transactions/:id', requireRole('admin', 'contabilidad'), c.updateMovement);
router.post('/transactions/:id/void', requireRole('admin', 'contabilidad'), c.voidMovement);
router.post('/cash-to-transfer', requireRole('admin', 'contabilidad'), c.cashToTransfer);
router.get('/cash-pending', requireRole('admin', 'contabilidad'), c.getCashPending);

// Conciliación
router.get('/reconciliations', requireRole('admin', 'contabilidad'), c.listReconciliations);
router.get('/reconciliations/:id', requireRole('admin', 'contabilidad'), c.getReconciliation);
router.post('/reconciliations', requireRole('admin', 'contabilidad'), c.startReconciliation);
router.put('/reconciliations/:id', requireRole('admin', 'contabilidad'), c.updateReconciliation);
router.post('/reconciliations/:id/close', requireRole('admin', 'contabilidad'), c.closeReconciliation);
// Solo se elimina una conciliación PENDIENTE (borrador): la cerrada es evidencia.
router.delete('/reconciliations/:id', requireRole('admin', 'contabilidad'), c.deleteReconciliation);
// Importar el extracto bancario (CSV/Excel) dentro de una conciliación
router.post('/reconciliations/:id/import', requireRole('admin', 'contabilidad'), c.reconcileImport);
router.post('/reconciliations/:id/create-movements', requireRole('admin', 'contabilidad'), c.reconcileCreateMovements);

// Importación de estado de cuenta bancario + matching automático
router.post('/statement/parse', requireRole('admin', 'contabilidad'), c.uploadStatementMiddleware, c.parseStatement);
router.post('/statement/match', requireRole('admin', 'contabilidad'), c.statementMatch);
router.post('/statement/apply', requireRole('admin', 'contabilidad'), c.statementApply);
router.post('/recompute-balances', requireRole('admin', 'contabilidad'), c.recomputeBankBalances);

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
