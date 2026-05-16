const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/accountingReportsController');

router.use(auth, requireClinic, requireRole('admin', 'contabilidad'));

// Financieros
router.get('/income-statement', c.incomeStatement);
router.get('/balance-sheet', c.balanceSheet);
router.get('/cash-flow', c.cashFlow);

// Ventas
router.get('/sales/summary', c.salesSummary);
router.get('/sales/by-product', c.salesByProduct);
router.get('/sales/by-cashier', c.salesByCashier);
router.get('/sales/weekly', c.salesWeekly);
router.get('/sales/cost', c.costOfSales);

// Gestión
router.get('/non-deductible', c.nonDeductibleExpenses);
router.get('/ar-aging', c.accountsReceivableAging);
router.get('/ap-aging', c.accountsPayableAging);
router.get('/advances', c.advancesControl);
router.get('/inventory', c.inventoryReport);

// SRI
router.get('/sri/purchases-sales', c.purchaseSalesList);
router.get('/sri/form-104', c.form104);
router.get('/sri/form-103', c.form103);
router.get('/sri/ats', c.ats);

module.exports = router;
