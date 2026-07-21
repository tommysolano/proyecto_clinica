const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/payrollController');
const d = require('../controllers/employeeDeductionController');

router.use(auth, requireClinic);

// Deducciones al personal y consumo interno (se ubican antes de las rutas con :id).
router.get('/deductions', requireRole('admin', 'contabilidad'), d.listDeductions);
router.post('/deductions', requireRole('admin', 'contabilidad'), d.createDeduction);
router.post('/deductions/:id/void', requireRole('admin', 'contabilidad'), d.voidDeduction);
router.post('/internal-consumption', requireRole('admin', 'contabilidad'), d.internalConsumption);

router.get('/employees', requireRole('admin', 'contabilidad'), c.listEmployees);
router.get('/linkable-users', requireRole('admin', 'contabilidad'), c.listLinkableUsers);
router.get('/employees/:id', requireRole('admin', 'contabilidad'), c.getEmployee);
router.post('/employees', requireRole('admin', 'contabilidad'), c.createEmployee);
router.put('/employees/:id', requireRole('admin', 'contabilidad'), c.updateEmployee);
router.post('/employees/:id/fondos-mode', requireRole('admin', 'contabilidad'), c.setFondosReservaMode);
router.delete('/employees/:id', requireRole('admin'), c.deleteEmployee);

router.get('/loans', requireRole('admin', 'contabilidad'), c.listLoans);
router.post('/loans', requireRole('admin', 'contabilidad'), c.createLoan);
router.put('/loans/:id', requireRole('admin', 'contabilidad'), c.updateLoan);

router.get('/config', requireRole('admin', 'contabilidad'), c.getConfig);
router.put('/config', requireRole('admin', 'contabilidad'), c.updateConfig);
router.post('/config/copy-department', requireRole('admin', 'contabilidad'), c.copyDepartmentAccounts);
router.get('/decimos', requireRole('admin', 'contabilidad'), c.generateDecimos);

// Catálogos parametrizados (departamentos, cargos, conceptos/rubros)
router.get('/departments', requireRole('admin', 'contabilidad'), c.listDepartments);
router.post('/departments', requireRole('admin', 'contabilidad'), c.createDepartment);
router.put('/departments/:id', requireRole('admin', 'contabilidad'), c.updateDepartment);
router.get('/positions', requireRole('admin', 'contabilidad'), c.listPositions);
router.post('/positions', requireRole('admin', 'contabilidad'), c.createPosition);
router.put('/positions/:id', requireRole('admin', 'contabilidad'), c.updatePosition);
router.get('/concepts', requireRole('admin', 'contabilidad'), c.listConcepts);
router.post('/concepts', requireRole('admin', 'contabilidad'), c.createConcept);
router.post('/concepts/seed', requireRole('admin', 'contabilidad'), c.seedConcepts);
router.put('/concepts/:id', requireRole('admin', 'contabilidad'), c.updateConcept);

// Tabla de impuesto a la renta parametrizable
router.get('/income-tax', requireRole('admin', 'contabilidad'), c.listIncomeTaxTables);
router.post('/income-tax', requireRole('admin', 'contabilidad'), c.createIncomeTaxTable);
router.post('/income-tax/seed', requireRole('admin', 'contabilidad'), c.seedIncomeTaxTable);
router.put('/income-tax/:id', requireRole('admin', 'contabilidad'), c.updateIncomeTaxTable);

// Retención en relación de dependencia del período (la consume el Formulario 103).
router.get('/withholding', requireRole('admin', 'contabilidad'), c.withholdingSummary);

router.get('/', requireRole('admin', 'contabilidad'), c.listPayrolls);
router.get('/:id', requireRole('admin', 'contabilidad'), c.getPayroll);
router.post('/generate', requireRole('admin', 'contabilidad'), c.generatePayroll);
router.put('/:id/item', requireRole('admin', 'contabilidad'), c.updatePayrollItem);
router.post('/:id/close', requireRole('admin', 'contabilidad'), c.closePayroll);
router.post('/:id/reopen', requireRole('admin', 'contabilidad'), c.reopenPayroll);
router.post('/:id/void', requireRole('admin', 'contabilidad'), c.voidPayroll);
router.post('/:id/pay', requireRole('admin', 'contabilidad'), c.markPaid);

module.exports = router;
