/**
 * SOLICITUDES DE TRASLADO (nov-2026): el usuario de un punto de emisión con bodega pide ítems
 * para esa bodega; un administrador escoge la bodega de origen y aprueba, lo que ejecuta el
 * traslado real (mismo núcleo que el traslado directo). Todo o nada: sin stock no se aprueba.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const H = require('./_integrationHelpers');

const ctrl = require('../controllers/transferRequestController');
const invCtrl = require('../controllers/inventoryAdvancedController');
const productCtrl = require('../controllers/productController');
const TransferRequest = require('../models/TransferRequest');
const PuntoEmision = require('../models/PuntoEmision');
const Warehouse = require('../models/Warehouse');
const Notification = require('../models/Notification');
const InventoryMovement = require('../models/InventoryMovement');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function setup() {
  const { clinicId, userId: adminId } = await H.seedClinic();
  const cajeroId = new mongoose.Types.ObjectId();
  const matriz = await Warehouse.create({ clinic: clinicId, code: 'BOD001', name: 'Matriz', isMain: true });
  const lab = await Warehouse.create({ clinic: clinicId, code: 'BOD005', name: 'Laboratorio' });
  const gasas = await H.makeProduct(clinicId, { name: 'Gasas', code: 'P1', category: 'insumo', purchasePrice: 5 });
  await H.runController(productCtrl.createMovement, H.mockReq(clinicId, adminId, {
    product: String(gasas._id), type: 'entrada', quantity: 10, unitCost: 5, warehouse: String(matriz._id),
  }));
  await PuntoEmision.create({ clinic: clinicId, establecimiento: '002', codigo: '001', nombre: 'Caja Lab', usuario: cajeroId, bodega: lab._id });
  const comoCajero = (body = {}, extra = {}) => ({ ...H.mockReq(clinicId, cajeroId, body, { role: 'cajero', ...extra }), user: { _id: cajeroId, name: 'Cajera Lab' } });
  const comoAdmin = (body = {}, extra = {}) => ({ ...H.mockReq(clinicId, adminId, body, extra), user: { _id: adminId, name: 'Admin' } });
  return { clinicId, adminId, cajeroId, matriz, lab, gasas, comoCajero, comoAdmin };
}

const stockEn = async (clinicId, userId, productId) => {
  const r = await H.runController(invCtrl.warehouseStock, H.mockReq(clinicId, userId, {}, { query: {} }));
  const fila = r.payload.find((s) => String(s.product._id) === String(productId));
  return Object.fromEntries((fila?.warehouses || []).map((w) => [w.warehouse?.name, w.qty]));
};

test('el usuario del punto pide para SU bodega y el administrador aprueba desde otra', async () => {
  const { clinicId, adminId, matriz, lab, gasas, comoCajero, comoAdmin } = await setup();

  const ctx = (await H.runController(ctrl.context, comoCajero())).payload;
  assert.equal(ctx.canRequest, true);
  assert.equal(ctx.canManage, false, 'un cajero no atiende solicitudes');
  assert.equal(String(ctx.bodega._id), String(lab._id));

  const creada = await H.runController(ctrl.create, comoCajero({ items: [{ product: String(gasas._id), quantity: 4 }], notes: 'Para muestras' }));
  assert.equal(creada.statusCode, 201, JSON.stringify(creada.payload));
  const sol = creada.payload;
  assert.equal(sol.code, 'SOL-000001');
  assert.equal(sol.status, 'PENDIENTE');
  assert.equal(sol.toWarehouse.name, 'Laboratorio', 'el destino es la bodega del punto');
  assert.equal(await Notification.countDocuments({ type: 'transfer_request_new' }), 1, 'aviso para quien atiende');

  // El cajero no puede aprobar.
  const sinPermiso = await H.runController(ctrl.approve, comoCajero({ fromWarehouse: String(matriz._id) }, { params: { id: sol._id } }));
  assert.equal(sinPermiso.statusCode, 403);

  // El administrador escoge la bodega de origen y traslada 3 de las 4 pedidas.
  const ap = await H.runController(ctrl.approve, comoAdmin({
    fromWarehouse: String(matriz._id), items: [{ product: String(gasas._id), quantity: 3 }], note: 'Solo quedan 3 de reserva',
  }, { params: { id: String(sol._id) } }));
  assert.equal(ap.statusCode, 200, JSON.stringify(ap.payload));
  assert.equal(ap.payload.status, 'APROBADA');
  assert.equal(ap.payload.fromWarehouse.name, 'Matriz');
  assert.equal(ap.payload.items[0].approvedQty, 3);
  assert.ok(ap.payload.transferGroup, 'queda enlazada al traslado');
  assert.deepEqual(await stockEn(clinicId, adminId, gasas._id), { Matriz: 7, Laboratorio: 3 });
  assert.equal(await InventoryMovement.countDocuments({ type: 'traslado', transferGroup: ap.payload.transferGroup }), 2);
  assert.equal(await Notification.countDocuments({ type: 'transfer_request_resolved' }), 1, 'aviso a quien pidió');

  // Aprobar otra vez no traslada de nuevo.
  const otraVez = await H.runController(ctrl.approve, comoAdmin({ fromWarehouse: String(matriz._id) }, { params: { id: String(sol._id) } }));
  assert.equal(otraVez.statusCode, 409);
  assert.deepEqual(await stockEn(clinicId, adminId, gasas._id), { Matriz: 7, Laboratorio: 3 });
});

test('sin stock en el origen no se mueve nada y la solicitud sigue pendiente', async () => {
  const { clinicId, adminId, matriz, gasas, comoCajero, comoAdmin } = await setup();
  const sol = (await H.runController(ctrl.create, comoCajero({ items: [{ product: String(gasas._id), quantity: 50 }] }))).payload;
  const r = await H.runController(ctrl.approve, comoAdmin({ fromWarehouse: String(matriz._id) }, { params: { id: String(sol._id) } }));
  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /Stock insuficiente de "Gasas"/);
  assert.equal((await TransferRequest.findById(sol._id)).status, 'PENDIENTE');
  assert.equal(await InventoryMovement.countDocuments({ type: 'traslado' }), 0);
  assert.deepEqual(await stockEn(clinicId, adminId, gasas._id), { Matriz: 10 });
});

test('rechazar pide motivo; retirar solo la propia pendiente; sin bodega no se pide', async () => {
  const { clinicId, gasas, lab, comoCajero, comoAdmin } = await setup();
  const item = [{ product: String(gasas._id), quantity: 1 }];

  const a = (await H.runController(ctrl.create, comoCajero({ items: item }))).payload;
  assert.equal((await H.runController(ctrl.reject, comoAdmin({}, { params: { id: String(a._id) } }))).statusCode, 400, 'sin motivo no');
  const rech = await H.runController(ctrl.reject, comoAdmin({ note: 'No hay en ninguna bodega' }, { params: { id: String(a._id) } }));
  assert.equal(rech.payload.status, 'RECHAZADA');
  assert.equal(rech.payload.resolutionNote, 'No hay en ninguna bodega');

  const b = (await H.runController(ctrl.create, comoCajero({ items: item }))).payload;
  assert.equal(b.code, 'SOL-000002');
  assert.equal((await H.runController(ctrl.cancel, comoAdmin({}, { params: { id: String(b._id) } }))).statusCode, 409, 'otro usuario no la retira');
  assert.equal((await H.runController(ctrl.cancel, comoCajero({}, { params: { id: String(b._id) } }))).payload.status, 'CANCELADA');

  // La bodega no puede ser el propio origen.
  const c = (await H.runController(ctrl.create, comoCajero({ items: item }))).payload;
  const mismo = await H.runController(ctrl.approve, comoAdmin({ fromWarehouse: String(lab._id) }, { params: { id: String(c._id) } }));
  assert.equal(mismo.statusCode, 400);

  // Punto sin bodega: no puede pedir.
  await PuntoEmision.updateMany({ clinic: clinicId }, { $set: { bodega: null } });
  const sinBodega = await H.runController(ctrl.create, comoCajero({ items: item }));
  assert.equal(sinBodega.statusCode, 400);
  assert.match(sinBodega.payload.message, /no tiene una bodega asignada/);
  assert.equal((await H.runController(ctrl.context, comoCajero())).payload.canRequest, false);
});

// Nov-2026: un ítem está en la bodega principal y otro solo en otra bodega. El administrador
// escoge la principal y saca el otro ítem de la bodega donde sí hay: un traslado por origen.
test('ítems sueltos desde otra bodega: un traslado por bodega de origen, todo o nada', async () => {
  const { clinicId, adminId, matriz, lab, gasas, comoCajero, comoAdmin } = await setup();
  const centro = await Warehouse.create({ clinic: clinicId, code: 'BOD006', name: 'Centro' });
  const jarabe = await H.makeProduct(clinicId, { name: 'Jarabe', code: 'P2', category: 'insumo', purchasePrice: 2 });
  await H.runController(productCtrl.createMovement, H.mockReq(clinicId, adminId, {
    product: String(jarabe._id), type: 'entrada', quantity: 8, unitCost: 2, warehouse: String(centro._id),
  }));
  const pedir = async () => (await H.runController(ctrl.create, comoCajero({ items: [
    { product: String(gasas._id), quantity: 4 }, { product: String(jarabe._id), quantity: 5 },
  ] }))).payload;

  // Si el ítem suelto sale de una bodega sin stock, no se mueve NADA (tampoco lo de la principal).
  const s1 = await pedir();
  const mal = await H.runController(ctrl.approve, comoAdmin({
    fromWarehouse: String(matriz._id),
    items: [{ product: String(gasas._id), quantity: 4 }, { product: String(jarabe._id), quantity: 5, fromWarehouse: String(matriz._id) }],
  }, { params: { id: String(s1._id) } }));
  assert.equal(mal.statusCode, 400);
  assert.deepEqual(await stockEn(clinicId, adminId, gasas._id), { Matriz: 10 });
  assert.equal((await TransferRequest.findById(s1._id)).status, 'PENDIENTE');

  // Gasas de la principal (Matriz) y Jarabe de Centro.
  const ap = await H.runController(ctrl.approve, comoAdmin({
    fromWarehouse: String(matriz._id),
    items: [{ product: String(gasas._id), quantity: 4 }, { product: String(jarabe._id), quantity: 5, fromWarehouse: String(centro._id) }],
  }, { params: { id: String(s1._id) } }));
  assert.equal(ap.statusCode, 200, JSON.stringify(ap.payload));
  assert.deepEqual(await stockEn(clinicId, adminId, gasas._id), { Matriz: 6, Laboratorio: 4 });
  assert.deepEqual(await stockEn(clinicId, adminId, jarabe._id), { Centro: 3, Laboratorio: 5 });
  assert.equal(ap.payload.transferGroups.length, 2, 'un traslado por bodega de origen');
  const porProducto = Object.fromEntries(ap.payload.items.map((i) => [i.productName, i.fromWarehouse?.name || null]));
  assert.deepEqual(porProducto, { Gasas: null, Jarabe: 'Centro' }, 'null = salió de la principal');

  // La bodega destino no vale como origen de un ítem.
  const s2 = await pedir();
  const aDestino = await H.runController(ctrl.approve, comoAdmin({
    fromWarehouse: String(matriz._id), items: [{ product: String(jarabe._id), quantity: 1, fromWarehouse: String(lab._id) }],
  }, { params: { id: String(s2._id) } }));
  assert.equal(aDestino.statusCode, 400);
});

// Nov-2026: «Mi bodega» — el usuario del punto ve su bodega en tiempo real: sistema vs toma física.
test('mi bodega: stock del sistema y última toma física de la bodega del punto', async () => {
  const { clinicId, adminId, matriz, lab, gasas, comoCajero, comoAdmin } = await setup();
  const PhysicalCount = require('../models/PhysicalCount');

  // Antes de recibir nada: la bodega está vacía (con ?todos=1 aparece Gasas en cero).
  let r = await H.runController(ctrl.myWarehouse, comoCajero());
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(r.payload.bodega.name, 'Laboratorio');
  assert.deepEqual(r.payload.items, []);
  r = await H.runController(ctrl.myWarehouse, comoCajero({}, { query: { todos: '1' } }));
  assert.deepEqual(r.payload.items.map((i) => [i.name, i.sistema, i.fisico]), [['Gasas', 0, null]]);

  // Le trasladan 4 y en la toma física de su bodega se contaron 3.
  const sol = (await H.runController(ctrl.create, comoCajero({ items: [{ product: String(gasas._id), quantity: 4 }] }))).payload;
  await H.runController(ctrl.approve, comoAdmin({ fromWarehouse: String(matriz._id) }, { params: { id: String(sol._id) } }));
  await PhysicalCount.create({
    clinic: clinicId, code: 'TF-00001', warehouse: lab._id, date: new Date(), status: 'CONFIRMADO', createdBy: adminId,
    items: [{ product: gasas._id, countedQty: 3, counted: true }],
  });
  r = await H.runController(ctrl.myWarehouse, comoCajero());
  const fila = r.payload.items[0];
  assert.equal(fila.name, 'Gasas');
  assert.equal(fila.sistema, 4, 'lo de su bodega, no lo de Matriz');
  assert.equal(fila.fisico.qty, 3);
  assert.equal(fila.fisico.code, 'TF-00001');
  assert.equal(fila.diferencia, -1);

  // Sin bodega en su punto no hay «Mi bodega».
  const sinBodega = await H.runController(ctrl.myWarehouse, comoAdmin());
  assert.equal(sinBodega.statusCode, 404);
});
