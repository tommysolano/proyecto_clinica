const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/accountingReportsController');
const ex = require('../controllers/sriSuperciasReportsController');

router.use(auth, requireClinic, requireRole('admin', 'contabilidad'));

// General consolidado
router.get('/general', c.generalReport);

// Financieros
router.get('/income-statement', c.incomeStatement);
router.get('/balance-sheet', c.balanceSheet);
router.get('/cash-flow', c.cashFlow);

// Ventas
router.get('/sales/summary', c.salesSummary);
router.get('/sales/by-product', c.salesByProduct);
router.get('/sales/by-cashier', c.salesByCashier);
router.get('/sales/by-seller', c.salesBySeller);
router.get('/sales/by-period', c.salesByPeriod);
router.get('/sales/weekly', c.salesWeekly);
router.get('/sales/cost', c.costOfSales);
router.get('/sales/cost-by-category', c.costOfSalesByCategory);

// Gestión
router.get('/non-deductible', c.nonDeductibleExpenses);
router.get('/ar-aging', c.accountsReceivableAging);
router.get('/ap-aging', c.accountsPayableAging);
router.get('/ar-aging.xlsx', c.arAgingExcel);
router.get('/ap-aging.xlsx', c.apAgingExcel);
router.get('/cash-flow.xlsx', c.cashFlowExcel);
router.get('/advances', c.advancesControl);
router.get('/inventory', c.inventoryReport);

// SRI
router.get('/sri/purchases-sales', c.purchaseSalesList);
router.get('/sri/purchases-sales.xlsx', c.purchaseSalesExcel);
router.get('/sri/form-104', c.form104);
router.get('/sri/form-103', c.form103);
router.get('/sri/ats', c.ats);

// SRI XML (DIMM Formularios)
router.get('/sri/form-104.xml', ex.form104Xml);
router.get('/sri/form-103.xml', ex.form103Xml);

// SuperCías (archivos planos F.20)
router.get('/supercias/balance-sheet.txt', ex.balanceSheetTxt);
router.get('/supercias/income-statement.txt', ex.incomeStatementTxt);

module.exports = router;
