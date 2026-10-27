const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');
const Company = require('../models/Company');
const Clinic = require('../models/Clinic');
const CostCenter = require('../models/CostCenter');
const Warehouse = require('../models/Warehouse');
const InventoryLayer = require('../models/InventoryLayer');
const Product = require('../models/Product');
const Sale = require('../models/Sale');
const Record = require('../models/ContificoRecord');
const { syncCostCenterCatalog } = require('../services/contificoFinancialSync');
const { contificoSourceClinic } = require('../services/contificoSourceClinic');
const { configure } = require('../scripts/configureCostCenterBranches');
const { accountingScope } = require('../services/accountingScope');
const accountingScopeMiddleware = require('../middleware/accountingScope');
const { createResolver } = require('../services/costCenterPolicy');
const costCentersController = require('../controllers/costCenterController');
const inventoryController = require('../controllers/inventoryAdvancedController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

test('centros y bodegas quedan en su sucursal; documentos de Contífico conservan centro y origen', async () => {
  const main = await Company.create({ name: 'Principal', isDefault: true });
  const other = await Company.create({ name: 'Otra empresa' });
  const clinics = {};
  for (const name of ['Central', 'Extensión', 'Laboratorio', 'Odontología', 'Dermazen']) {
    clinics[name] = await Clinic.create({ name, company: main._id });
  }
  const foreign = await Clinic.create({ name: 'Dermazen', company: other._id });
  const [cc1, cc2, cc5] = await CostCenter.create([
    { clinic: clinics.Central._id, code: '1', name: 'CC CENTRAL' },
    { clinic: clinics.Central._id, code: '2', name: 'CC EXTENSIÓN' },
    { clinic: clinics.Central._id, code: '5', name: 'CC LABORATORIO' },
  ]);
  const [cc3] = await CostCenter.create([{ clinic: clinics.Central._id, code: '3', name: 'CC ODONTOLOGÍA' },
    { clinic: clinics.Central._id, code: '4', name: 'CC OPTOMETRÍA' },
    { clinic: clinics.Central._id, code: '6', name: 'CC SERVICIOS MÉDICOS' }]);
  await Warehouse.create([
    { clinic: clinics.Central._id, code: 'BOD001', name: 'Matriz', costCenter: cc1._id },
    { clinic: clinics.Central._id, code: 'BOD004', name: 'Extensión', costCenter: cc2._id },
    { clinic: clinics.Central._id, code: 'BOD005', name: 'Laboratorio', costCenter: cc5._id },
  ]);
  const whLab = await Warehouse.findOne({ code: 'BOD005' });
  const product = await Product.create({ clinic: clinics.Central._id, code: 'P1', name: 'Insumo',
    category: 'insumo', salePrice: 5, stock: 5,
    stockByClinic: [{ clinic: clinics.Central._id, stock: 5 }] });
  const layer = await InventoryLayer.create({ clinic: clinics.Central._id, product: product._id,
    warehouse: whLab._id, qtyInitial: 3, qtyRemaining: 3, unitCost: 1, date: new Date() });
  const source = await Sale.collection.insertOne({ clinic: clinics.Central._id, costCenter: cc5._id,
    status: 'completada', total: 10, createdAt: new Date() });
  const noCenter = await Sale.collection.insertOne({ clinic: clinics.Central._id, costCenter: null,
    status: 'completada', total: 20, createdAt: new Date() });

  const preview = await configure();
  assert.equal(preview.mode, 'dry-run');
  assert.equal((await CostCenter.findById(cc5._id)).clinic.toString(), clinics.Central.id);
  await configure({ commit: true });
  await configure({ commit: true });

  assert.equal(String((await CostCenter.findById(cc2._id)).clinic), clinics['Extensión'].id);
  assert.equal(String((await CostCenter.findById(cc5._id)).clinic), clinics.Laboratorio.id);
  assert.equal(String((await CostCenter.findById(cc3._id)).clinic), clinics['Extensión'].id);
  assert.equal(String((await Warehouse.findOne({ code: 'BOD005' })).clinic), clinics.Laboratorio.id);
  assert.equal(String((await InventoryLayer.findById(layer._id)).clinic), clinics.Laboratorio.id);
  const migratedProduct = await Product.findById(product._id).lean();
  assert.equal(migratedProduct.stock, 5);
  assert.equal(migratedProduct.stockByClinic.find((entry) => String(entry.clinic) === clinics.Laboratorio.id).stock, 3);
  assert.equal(migratedProduct.stockByClinic.find((entry) => String(entry.clinic) === clinics.Central.id).stock, 2);
  assert.equal(String((await Clinic.findById(clinics['Odontología']._id)).accountingCostCenter), String(cc2._id));
  const dermazen = await Clinic.findById(clinics.Dermazen._id).lean();
  const cc7 = await CostCenter.find({ clinic: dermazen._id, code: 'DERMAZEN' }).lean();
  assert.equal(cc7.length, 1);
  assert.equal(String(dermazen.accountingCostCenter), String(cc7[0]._id));
  assert.equal((await Clinic.findById(foreign._id)).accountingCostCenter, null);

  const labScope = await accountingScope(clinics.Laboratorio._id);
  assert.equal(String(labScope.dataClinic), clinics.Central.id);
  assert.equal(String(labScope.costCenter._id), String(cc5._id));
  const extScope = await accountingScope(clinics['Extensión']._id);
  assert.deepEqual(extScope.costCenterIds.map(String).sort(), [String(cc2._id), String(cc3._id)].sort());
  const extRequest = H.mockReq(clinics['Extensión'].id, new H.mongoose.Types.ObjectId());
  extRequest.method = 'GET';
  extRequest.path = '/';
  await new Promise((resolve, reject) => accountingScopeMiddleware()(extRequest, {},
    (error) => error ? reject(error) : resolve()));
  assert.equal(String(extRequest.clinicId), clinics.Central.id);
  assert.deepEqual(extRequest.costCenterScope.$in.map(String).sort(),
    [String(cc2._id), String(cc3._id)].sort());
  const labCenters = await H.runController(costCentersController.list,
    H.mockReq(clinics.Laboratorio.id, new H.mongoose.Types.ObjectId()));
  assert.deepEqual(labCenters.payload.map((center) => center.code), ['5']);
  const labWarehouses = await H.runController(inventoryController.listWarehouses,
    H.mockReq(clinics.Laboratorio.id, new H.mongoose.Types.ObjectId()));
  assert.deepEqual(labWarehouses.payload.map((warehouse) => warehouse.code), ['BOD005']);
  const odontoWarehouse = await Warehouse.findOne({ code: 'BOD004' });
  const shared = await createResolver({ clinicId: clinics['Odontología']._id })
    .resolve({ warehouse: odontoWarehouse._id });
  assert.equal(String(shared.costCenter), String(cc2._id));
  const importedWarehouse = await createResolver({ clinicId: clinics.Central._id })
    .resolve({ warehouse: whLab._id });
  assert.equal(String(importedWarehouse.costCenter), String(cc5._id));
  const labPurchaseResolver = createResolver({ clinicId: clinics.Central._id,
    activeClinicId: clinics.Laboratorio._id });
  assert.equal(String((await labPurchaseResolver.resolve({ warehouse: whLab._id })).costCenter), String(cc5._id));
  await assert.rejects(() => labPurchaseResolver.getCostCenter(cc2._id), /no existe en esta clínica/);
  await assert.rejects(() => labPurchaseResolver.getCostCenter(cc1._id), /no existe en esta clínica/);
  assert.equal(String((await Sale.findById(source.insertedId)).costCenter), String(cc5._id));
  assert.equal((await Sale.findById(noCenter.insertedId)).costCenter, null);
});

test('un centro nuevo de Contífico se crea en la empresa principal y conserva su fuente', async () => {
  const main = await Company.create({ name: 'Principal', isDefault: true });
  const other = await Company.create({ name: 'Otra empresa' });
  const central = await Clinic.create({ name: 'Central', company: main._id });
  await Clinic.create({ name: 'Central', company: other._id });
  assert.equal(String((await contificoSourceClinic())._id), central.id);
  const api = { listV1: async () => [{ id: 'source-8', codigo: '8', nombre: 'CC NUEVO', estado: 'A' }] };
  assert.deepEqual(await syncCostCenterCatalog({ clinic: central, api }), { source: 1, created: 1 });
  assert.deepEqual(await syncCostCenterCatalog({ clinic: central, api }), { source: 1, created: 0 });
  const center = await CostCenter.findOne({ clinic: central._id, code: '8' });
  assert.equal(center.name, 'CC NUEVO');
  assert.equal((await Record.findOne({ clinic: central._id, entity: 'cost_center', externalId: 'source-8' })).projection.status,
    'PROJECTED');
  assert.deepEqual((await Clinic.findById(central._id)).accountingImportCostCenters.map(String), [center.id]);
  assert.equal(await CostCenter.countDocuments({ code: '8' }), 1);
});
