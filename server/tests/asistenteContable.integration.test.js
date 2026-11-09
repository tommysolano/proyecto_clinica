const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');
const User = require('../models/User');
const Clinic = require('../models/Clinic');
const CashClosing = require('../models/CashClosing');
const userController = require('../controllers/userController');
const cashClosing = require('../controllers/cashClosingController');
const { requireRole } = require('../middleware/auth');
const { can, CAPS } = require('../utils/permissions');
const { puedeElegirCaja } = require('../middleware/cajaSeleccionada');
const { restrictedAssistantApi } = require('../middleware/asistenteContable');

test.before(async () => H.startDb());
test.after(async () => H.stopDb());
test.beforeEach(async () => H.resetDb());

test('se puede crear un asistente contable y conserva los permisos no restringidos', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await Clinic.create({ _id: clinicId, name: 'Principal' });
  const response = await H.runController(userController.createUser, H.mockReq(clinicId, userId, {
    name: 'Asistente', email: 'asistente@example.com', password: 'clave123', role: 'asistente_contable',
  }));
  assert.equal(response.statusCode, 201, JSON.stringify(response.payload));
  const user = await User.findById(response.payload._id);
  assert.equal(user.getRoleForClinic(clinicId), 'asistente_contable');
  let allowed = false;
  requireRole('admin', 'contabilidad')({ role: 'asistente_contable', user }, {}, () => { allowed = true; });
  assert.equal(allowed, true);
  const forbidden = { status(code) { this.code = code; return this; }, json() {} };
  requireRole('admin')({ role: 'asistente_contable', user }, forbidden, () => assert.fail('no debe heredar administrador'));
  assert.equal(forbidden.code, 403);
  for (const capability of CAPS.contabilidad.filter((c) => !c.startsWith('cashflow.'))) assert.equal(can('asistente_contable', capability), true, capability);
  assert.equal(can('asistente_contable', 'cashflow.view'), false);
  assert.equal(can('asistente_contable', 'cashflow.manage'), false);
  assert.equal(can('asistente_contable', 'patients.contactData'), can('contabilidad', 'patients.contactData'));
  assert.equal(puedeElegirCaja({ role: 'asistente_contable', user }), true);
  const caja = await CashClosing.create({ clinic: clinicId, date: new Date(), openedAt: new Date(), openedBy: userId, status: 'ABIERTA' });
  const req = Object.assign(H.mockReq(clinicId, user._id, {}, { role: 'asistente_contable', params: { id: String(caja._id) } }), { user });
  assert.equal((await H.runController(cashClosing.detail, req)).statusCode, 200);
});

test('bloquea las API restringidas y conserva las usadas en compras y reportes permitidos', () => {
  const blocked = [
    ['/api/accounting-config', 'GET'], ['/api/retention-rules', 'POST'],
    ['/api/fiscal-periods', 'GET'], ['/api/journal-entries/ledger.xlsx', 'GET'],
    ['/api/journal-entries/trial-balance', 'GET'], ['/api/accounting-reports/period-balances.xlsx', 'GET'],
    ['/api/deferred-income', 'GET'], ['/api/retention-vouchers', 'GET'],
    ['/api/retention-vouchers/123/retry', 'POST'], ['/api/budgets/execution', 'GET'],
    ['/api/cash-flow/projection.xlsx', 'GET'], ['/api/accounting-health', 'GET'], ['/api/audit-logs', 'GET'],
    ['/api/accounting-reports/income-statement.xlsx', 'GET'], ['/api/accounting-reports/general', 'GET'],
    ['/api/accounting-reports/sales/by-period.xlsx', 'GET'], ['/api/accounting-reports/supercias/balance-sheet.txt', 'GET'],
  ];
  for (const [url, method] of blocked) assert.equal(restrictedAssistantApi(url, method), true, `${method} ${url}`);
  const allowed = [
    ['/api/purchase-invoices', 'GET'], ['/api/retention-rules?active=true', 'GET'],
    ['/api/retention-vouchers/config', 'GET'], ['/api/retention-vouchers/from-purchase/123', 'POST'],
    ['/api/journal-entries', 'GET'], ['/api/journal-entries/123', 'GET'],
    ['/api/accounting-reports/sri/form-104', 'GET'], ['/api/accounting-reports/profitability/by-doctor', 'GET'],
    ['/api/accounting-reports/collections/by-cashier', 'GET'], ['/api/accounting-reports/sales/drilldown.xlsx', 'GET'],
  ];
  for (const [url, method] of allowed) assert.equal(restrictedAssistantApi(url, method), false, `${method} ${url}`);
});

test('la sesión autenticada aplica el bloqueo a asistente y deja entrar a contabilidad', async () => {
  const express = require('express');
  const jwt = require('jsonwebtoken');
  const { auth } = require('../middleware/auth');
  const { clinicId } = await H.seedClinic();
  await Clinic.create({ _id: clinicId, name: 'Principal' });
  const create = (role) => User.create({ name: role, email: `${role}@example.com`, password: 'clave123', clinics: [{ clinic: clinicId, role }] });
  const assistant = await create('asistente_contable');
  const accountant = await create('contabilidad');
  const previous = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'test-asistente-contable';
  const app = express();
  app.use(auth, requireRole('admin', 'contabilidad'));
  app.use((req, res) => res.json({ role: req.role }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const call = (user, path) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { headers: {
      Authorization: `Bearer ${jwt.sign({ id: user._id, clinicId: String(clinicId) }, process.env.JWT_SECRET)}`,
    } });
    assert.equal((await call(assistant, '/api/accounting-reports/income-statement')).status, 403);
    assert.equal((await call(assistant, '/api/fiscal-periods')).status, 403);
    assert.equal((await call(assistant, '/api/purchase-invoices')).status, 200);
    assert.equal((await call(accountant, '/api/accounting-reports/income-statement')).status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous;
  }
});
