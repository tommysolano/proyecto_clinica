const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');
const clinicController = require('../controllers/clinicController');
const Company = require('../models/Company');
const ChartOfAccount = require('../models/ChartOfAccount');
const { seedChartOfAccounts } = require('../utils/accounting');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

test('una clínica nueva recibe el plan contable y una segunda siembra conserva las cuentas', async () => {
  const company = await Company.create({ name: 'Empresa de prueba', isDefault: true });
  const actor = await H.seedClinic();
  const response = await H.runController(clinicController.createClinic,
    H.mockReq(actor.clinicId, actor.userId, { name: 'Nueva sede', company: String(company._id) }));
  assert.equal(response.statusCode, 201, JSON.stringify(response.payload));
  const clinicId = response.payload._id;
  const before = await ChartOfAccount.countDocuments({ clinic: clinicId });
  assert.ok(before > 20);
  assert.ok(await ChartOfAccount.exists({ clinic: clinicId, code: '1.1.01.01' }));
  await seedChartOfAccounts(clinicId);
  assert.equal(await ChartOfAccount.countDocuments({ clinic: clinicId }), before);
});
