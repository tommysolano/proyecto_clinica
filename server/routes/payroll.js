const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/payrollController');

router.use(auth, requireClinic);

router.get('/employees', requireRole('admin', 'contabilidad'), c.listEmployees);
router.get('/employees/:id', requireRole('admin', 'contabilidad'), c.getEmployee);
router.post('/employees', requireRole('admin', 'contabilidad'), c.createEmployee);
router.put('/employees/:id', requireRole('admin', 'contabilidad'), c.updateEmployee);
router.delete('/employees/:id', requireRole('admin'), c.deleteEmployee);

router.get('/loans', requireRole('admin', 'contabilidad'), c.listLoans);
router.post('/loans', requireRole('admin', 'contabilidad'), c.createLoan);
router.put('/loans/:id', requireRole('admin', 'contabilidad'), c.updateLoan);

router.get('/', requireRole('admin', 'contabilidad'), c.listPayrolls);
router.get('/:id', requireRole('admin', 'contabilidad'), c.getPayroll);
router.post('/generate', requireRole('admin', 'contabilidad'), c.generatePayroll);
router.put('/:id/item', requireRole('admin', 'contabilidad'), c.updatePayrollItem);
router.post('/:id/close', requireRole('admin', 'contabilidad'), c.closePayroll);
router.post('/:id/pay', requireRole('admin', 'contabilidad'), c.markPaid);

module.exports = router;
