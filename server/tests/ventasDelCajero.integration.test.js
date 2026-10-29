/**
 * VENTAS DEL CAJERO (29-10-2026). En la página de Ventas el cajero ve solo lo que él
 * generó: lo que registró o cobró y lo que facturó. Admin y contabilidad ven todo.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const User = require('../models/User');
const Invoice = require('../models/Invoice');
const sales = require('../controllers/saleController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const comoCajero = (clinicId, cajero, body = {}, extra = {}) => {
  const req = H.mockReq(clinicId, cajero._id, body, { role: 'cajero', ...extra });
  req.user = { ...cajero.toObject(), _id: cajero._id };
  return req;
};

test('el cajero ve solo sus ventas y las que facturó; el admin ve todas', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const nuevoCajero = (name) => User.create({
    name, email: `${name}${Date.now()}@t.com`, password: 'secreto123', clinics: [{ clinic: clinicId, role: 'cajero' }],
  });
  const carla = await nuevoCajero('carla');
  const pedro = await nuevoCajero('pedro');
  const serv = await H.makeProduct(clinicId, { category: 'servicio', unlimited: true, salePrice: 10, taxCategory: 'IVA_0' });
  const vender = async (req) => {
    req.body = { items: [{ product: String(serv._id), quantity: 1 }], paymentMethod: 'efectivo', ...req.body };
    const r = await H.runController(sales.createSale, req);
    assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
    return r.payload;
  };
  const deCarla = await vender(comoCajero(clinicId, carla));
  const dePedro = await vender(comoCajero(clinicId, pedro));
  const delAdmin = await vender(H.mockReq(clinicId, userId));
  // La venta del admin la factura Carla: también es suya.
  await Invoice.collection.insertOne({ clinic: clinicId, sale: delAdmin._id, createdBy: carla._id,
    estab: '001', ptoEmi: '001', secuencial: '000000001', ambiente: '1', fechaEmision: '29/10/2026', estado: 'AUTORIZADO' });

  const lista = async (req) => {
    const r = await H.runController(sales.getSales, req);
    assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
    return r.payload.sales.map((s) => String(s._id)).sort();
  };
  assert.deepEqual(await lista(comoCajero(clinicId, carla)), [String(deCarla._id), String(delAdmin._id)].sort());
  assert.deepEqual(await lista(comoCajero(clinicId, pedro)), [String(dePedro._id)]);
  assert.equal((await lista(H.mockReq(clinicId, userId))).length, 3);
});
