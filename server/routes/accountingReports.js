const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/accountingReportsController');
const ex = require('../controllers/sriSuperciasReportsController');

router.use(auth, requireClinic, requireRole('admin', 'contabilidad'));

// General consolidado
router.get('/general', c.generalReport);
router.get('/general.xlsx', c.generalReportExcel);

// Saldos por período (materializados)
router.get('/period-balances', c.periodBalances);
router.get('/period-balances.xlsx', c.periodBalancesExcel);
router.post('/recompute-balances', c.recomputeBalances);

// Indicadores financieros (ratios + punto de equilibrio)
router.get('/indicators', c.financialIndicators);
router.get('/indicators.xlsx', c.indicatorsExcel);

// Financieros
// El .xlsx va ANTES: `/account-flow/:accountId` también casa con "abc.xlsx" (el punto entra
// en el parámetro), así que declarado después nunca se alcanzaría.
router.get('/account-flow/:accountId.xlsx', c.accountFlowExcel);
router.get('/account-flow/:accountId', c.accountFlow);
router.get('/income-statement', c.incomeStatement);
router.get('/income-statement.xlsx', c.incomeStatementExcel);
router.get('/balance-sheet', c.balanceSheet);
router.get('/balance-sheet.xlsx', c.balanceSheetExcel);
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
// Detalle (drill-down) de UNA fila de los reportes de ventas: qué ventas la componen,
// con su factura. Va ANTES del comodín `/sales/:report.xlsx`, que si no se queda el .xlsx.
router.get('/sales/drilldown', c.salesDrilldown);
router.get('/sales/drilldown.xlsx', c.salesDrilldownExcel);
// Excel de los sub-reportes de ventas (by-period, by-product, by-seller, by-cashier,
// cost, cost-by-category). Un solo endpoint: solo cambian las columnas.
router.get('/sales/:report.xlsx', c.salesSubreportExcel);

// Gestión
router.get('/non-deductible', c.nonDeductibleExpenses);
router.get('/non-deductible.xlsx', c.nonDeductibleExcel);
router.get('/ar-aging', c.accountsReceivableAging);
router.get('/ap-aging', c.accountsPayableAging);
router.get('/ar-aging.xlsx', c.arAgingExcel);
router.get('/ap-aging.xlsx', c.apAgingExcel);
router.get('/cash-flow.xlsx', c.cashFlowExcel);
router.get('/advances', c.advancesControl);
router.get('/advances.xlsx', c.advancesExcel);
router.get('/inventory', c.inventoryReport);
router.get('/inventory.xlsx', c.inventoryExcel);

// Rentabilidad por centro de costo
router.get('/profitability/by-doctor', c.profitabilityByDoctor);
router.get('/profitability/by-doctor.xlsx', c.profitabilityExcel);

// SRI
router.get('/sri/purchases-sales', c.purchaseSalesList);
router.get('/sri/purchases-sales.xlsx', c.purchaseSalesExcel);
router.get('/sri/form-104', c.form104);
router.get('/sri/form-104.xlsx', c.form104Excel);
router.get('/sri/form-103', c.form103);
router.get('/sri/form-103.xlsx', c.form103Excel);
router.get('/sri/ats-preview', c.atsPreview);
router.get('/sri/ats-preview.xlsx', c.atsExcel);
router.get('/sri/ats', c.ats);
router.get('/sri/rdep', c.rdep);
router.get('/sri/rdep.xlsx', c.rdepExcel);
router.get('/sri/retentions-received', c.retentionsReceived);
router.get('/sri/retentions-received.xlsx', c.retentionsReceivedExcel);

// SRI 103/104 en XML: BORRADOR TÉCNICO (estructura propia, no validada contra el SRI).
// No es un archivo DIMM ni está listo para cargar. La declaración formal está en
// /tax-declarations.
router.get('/sri/form-104.xml', ex.form104Xml);
router.get('/sri/form-103.xml', ex.form103Xml);

// SuperCías (archivos planos F.20)
router.get('/supercias/balance-sheet.txt', ex.balanceSheetTxt);
router.get('/supercias/income-statement.txt', ex.incomeStatementTxt);

module.exports = router;
