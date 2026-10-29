/**
 * BUSCADOR DE CLIENTE EN VENTAS (29-10-2026). Igual que la agenda: por palabras sueltas,
 * sin tildes y en cualquier orden. Antes había que escribir el nombre exacto.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Patient = require('../models/Patient');
const sales = require('../controllers/saleController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

test('encuentra la venta por palabras sueltas, sin tildes, por cédula, teléfono o paciente', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const serv = await H.makeProduct(clinicId, { category: 'servicio', unlimited: true, salePrice: 10, taxCategory: 'IVA_0' });
  const cesar = await Patient.create({ clinic: clinicId, firstName: 'CESAR DANIEL', lastName: 'GUATUMILLO VALLEJO', cedula: '1717369365', phone: '593987654321' });
  const vender = async (body) => {
    const r = await H.runController(sales.createSale, H.mockReq(clinicId, userId, {
      items: [{ product: String(serv._id), quantity: 1 }], paymentMethod: 'efectivo', ...body,
    }));
    assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
    return String(r.payload._id);
  };
  const deCesar = await vender({ patient: String(cesar._id), clientName: 'GUATUMILLO VALLEJO CESAR DANIEL', clientCedula: '1717369365' });
  // Facturada a otra persona, pero el paciente es César.
  const aOtro = await vender({ patient: String(cesar._id), clientName: 'EMPRESA XYZ S.A.', clientCedula: '0990000000001' });
  const tommy = await vender({ clientName: 'TOMMY NELSON SOLANO PEÑAFIEL', clientCedula: '0911111111' });

  const buscar = async (client) => {
    const r = await H.runController(sales.getSales, H.mockReq(clinicId, userId, {}, { query: { client } }));
    assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
    return r.payload.sales.map((s) => String(s._id)).sort();
  };
  assert.deepEqual(await buscar('cesar guatumillo'), [deCesar, aOtro].sort(), 'palabras en otro orden + paciente');
  assert.deepEqual(await buscar('tommy penafiel'), [tommy], 'sin tildes');
  assert.deepEqual(await buscar('  Solano   TOMMY '), [tommy], 'espacios y mayúsculas');
  assert.deepEqual(await buscar('0911111111'), [tommy], 'cédula del comprador');
  assert.deepEqual(await buscar('0987654321'), [deCesar, aOtro].sort(), 'teléfono del paciente en formato local');
  assert.deepEqual(await buscar('xyz'), [aOtro], 'razón social facturada');
  assert.deepEqual(await buscar('(+)'), [], 'solo signos: nada, sin error');
});
