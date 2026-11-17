/**
 * LAS BODEGAS SON DE LA EMPRESA (nov-2026): se ven y se administran desde cualquier sucursal
 * de la empresa, no solo desde la que las creó. Antes Extensión solo veía la bodega de su
 * centro de costo y Odontología ninguna, porque las 6 bodegas se habían creado en Central.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const H = require('./_integrationHelpers');

const ctrl = require('../controllers/inventoryAdvancedController');
const Clinic = require('../models/Clinic');
const Warehouse = require('../models/Warehouse');
const { invalidateCompanyCache, ensureCompanyCache } = require('../utils/companies');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); invalidateCompanyCache(); });
test.beforeEach(async () => { await H.resetDb(); invalidateCompanyCache(); });

async function seed() {
  const { clinicId: central, userId } = await H.seedClinic();
  const empresa = new mongoose.Types.ObjectId();
  const otraEmpresa = new mongoose.Types.ObjectId();
  const odontologia = new mongoose.Types.ObjectId();
  const ajena = new mongoose.Types.ObjectId();
  await Clinic.collection.insertMany([
    { _id: central, name: 'Central', company: empresa },
    { _id: odontologia, name: 'Odontología', company: empresa },
    { _id: ajena, name: 'Otra empresa', company: otraEmpresa },
  ]);
  await Warehouse.collection.insertMany([
    { clinic: central, code: 'BOD001', name: 'Matriz', active: true, isMain: true },
    { clinic: central, code: 'BOD005', name: 'Laboratorio', active: true },
    { clinic: ajena, code: 'BOD900', name: 'De otra empresa', active: true },
  ]);
  invalidateCompanyCache();
  await ensureCompanyCache();
  return { central, odontologia, ajena, userId };
}

const listar = async (clinicId, userId, query = {}) => {
  const r = await H.runController(ctrl.listWarehouses, H.mockReq(clinicId, userId, {}, { query }));
  return r.payload.map((w) => w.code).sort();
};

test('todas las bodegas de la empresa se ven desde cualquier sucursal, y solo las de la empresa', async () => {
  const { central, odontologia, ajena, userId } = await seed();
  assert.deepEqual(await listar(central, userId), ['BOD001', 'BOD005']);
  assert.deepEqual(await listar(odontologia, userId), ['BOD001', 'BOD005'], 'Odontología ve las bodegas creadas en Central');
  assert.deepEqual(await listar(ajena, userId), ['BOD900'], 'otra empresa no ve las de Shiluv');
});

test('una bodega de Central se puede editar e inactivar desde otra sucursal de la empresa', async () => {
  const { odontologia, ajena, userId } = await seed();
  const lab = await Warehouse.findOne({ code: 'BOD005' });
  const editar = await H.runController(ctrl.updateWarehouse, H.mockReq(odontologia, userId, { name: 'Laboratorio - Principal' }, { params: { id: String(lab._id) } }));
  assert.ok(editar.statusCode < 400, JSON.stringify(editar.payload));
  const guardada = await Warehouse.findById(lab._id).lean();
  assert.equal(guardada.name, 'Laboratorio - Principal');
  assert.equal(String(guardada.clinic), String(lab.clinic), 'no cambia de sucursal dueña');

  const inactivar = await H.runController(ctrl.setWarehouseActive, H.mockReq(odontologia, userId, { active: false }, { params: { id: String(lab._id) } }));
  assert.ok(inactivar.statusCode < 400, JSON.stringify(inactivar.payload));
  assert.equal((await Warehouse.findById(lab._id).lean()).active, false);

  const deOtra = await H.runController(ctrl.setWarehouseActive, H.mockReq(ajena, userId, { active: true }, { params: { id: String(lab._id) } }));
  assert.equal(deOtra.statusCode, 404, 'otra empresa no toca bodegas ajenas');
});
