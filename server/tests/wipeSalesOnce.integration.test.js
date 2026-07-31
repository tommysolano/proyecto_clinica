/**
 * BORRADO DE VENTAS DE UNA SOLA VEZ (scripts/wipeSalesOnce.js).
 *
 * El script borra datos de PRODUCCIÓN, así que lo que se comprueba aquí es que después de
 * pasar por él el sistema queda COHERENTE, no solo vacío:
 *   · desaparecen la venta y todo lo que nace de ella (factura, CxC, cobro, asientos,
 *     movimientos de inventario y bancarios) y se recalculan los saldos por cuenta;
 *   · el stock vuelve a sus capas FIFO… y una venta ya ANULADA no lo devuelve dos veces;
 *   · lo que no es una venta (las compras) queda intacto;
 *   · la tarea corre UNA vez: el segundo despliegue no toca las ventas nuevas.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const sale = require('../controllers/saleController');
const purchase = require('../controllers/purchaseInvoiceController');
const payment = require('../controllers/paymentController');
const { wipeSales, runOnce } = require('../scripts/wipeSalesOnce');

const Sale = require('../models/Sale');
const Product = require('../models/Product');
const Receivable = require('../models/Receivable');
const Payment = require('../models/Payment');
const JournalEntry = require('../models/JournalEntry');
const AccountBalance = require('../models/AccountBalance');
const InventoryMovement = require('../models/InventoryMovement');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const OneTimeTask = require('../models/OneTimeTask');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const silencio = () => {};

/** Compra 10 unidades a $40 (deja capa FIFO y stock 10). */
async function comprar(clinicId, userId, prod, qty = 10, unitPrice = 40) {
  const sup = await H.makeSupplier(clinicId);
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: H.docDate(),
    items: [{
      description: 'Insumo', product: prod._id, quantity: qty, unitPrice,
      ivaRate: 15, subtotal: qty * unitPrice,
    }],
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  return r.payload;
}

// ─────────────────────────────────────────────────────────────────────────────
test('borra la venta con todo lo que cuelga, devuelve el stock y deja la compra intacta', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const prod = await H.makeProduct(clinicId, { category: 'insumo', salePrice: 115, purchasePrice: 40 });
  const compra = await comprar(clinicId, userId, prod);

  const r = await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: prod._id, quantity: 2, unitPrice: 115 }], paymentMethod: 'efectivo',
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal((await Product.findById(prod._id)).stock, 8);
  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId, sourceModel: 'Sale' }), 2, 'venta + costo');
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.01.01'), 230); // caja

  const res = await wipeSales({ clinic: clinicId, commit: true, log: silencio });
  assert.equal(res.ventas, 1);
  assert.equal(res.asientos, 2);

  assert.equal(await Sale.countDocuments({ clinic: clinicId }), 0);
  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId, sourceModel: 'Sale' }), 0);
  assert.equal(await InventoryMovement.countDocuments({ clinic: clinicId, sourceModel: 'Sale' }), 0);
  assert.equal((await Product.findById(prod._id)).stock, 10, 'el stock vuelve al que había antes de vender');

  // La COMPRA no se toca: su factura, su asiento y su capa siguen ahí.
  assert.equal(await PurchaseInvoice.countDocuments({ clinic: clinicId }), 1);
  assert.equal(String((await PurchaseInvoice.findById(compra._id))._id), String(compra._id));
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.04.01'), 400, 'inventario = solo la compra');
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.01.01'), 0, 'la caja de la venta desapareció');
  assert.equal(await H.accountBalanceByCode(clinicId, '5.1.01'), 0, 'el costo de venta desapareció');

  // Los saldos por cuenta/período se recalcularon (no quedaron los de la venta borrada).
  const ChartOfAccount = require('../models/ChartOfAccount');
  const caja = await ChartOfAccount.findOne({ clinic: clinicId, code: '1.1.01.01' });
  const saldoCaja = await AccountBalance.find({ clinic: clinicId, account: caja._id });
  assert.equal(saldoCaja.reduce((s, b) => s + b.debit - b.credit, 0), 0);

  const led = await H.assertLedgerBalanced(clinicId);
  assert.ok(led.balanced, `mayor descuadrado ${led.debit} vs ${led.credit}`);
});

// ─────────────────────────────────────────────────────────────────────────────
test('venta a crédito: se van la CxC, el cobro y sus asientos', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const serv = await H.makeProduct(clinicId, { category: 'servicio', salePrice: 100, unlimited: true, taxCategory: 'IVA_0' });

  const r = await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: serv._id, quantity: 1, unitPrice: 100 }], paymentMethod: 'credito',
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const saleId = r.payload._id;
  assert.equal((await Receivable.findOne({ clinic: clinicId, sourceRef: saleId })).balance, 100);

  const rp = await H.runController(payment.create, H.mockReq(clinicId, userId, {
    type: 'COBRO', method: 'EFECTIVO', partyModel: 'Patient', partyName: 'Paciente X',
    applications: [{ docModel: 'Sale', docRef: saleId, amount: 100 }],
  }));
  assert.equal(rp.statusCode, 201, JSON.stringify(rp.payload));
  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId, sourceModel: 'Payment' }), 1);

  const res = await wipeSales({ clinic: clinicId, commit: true, log: silencio });
  assert.equal(res.cxc, 1);
  assert.equal(res.cobros, 1);

  assert.equal(await Receivable.countDocuments({ clinic: clinicId }), 0);
  assert.equal(await Payment.countDocuments({ clinic: clinicId }), 0);
  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId, sourceModel: 'Payment' }), 0);
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.02.01'), 0, 'clientes en cero');
  const led = await H.assertLedgerBalanced(clinicId);
  assert.ok(led.balanced, `mayor descuadrado ${led.debit} vs ${led.credit}`);
});

// ─────────────────────────────────────────────────────────────────────────────
test('una venta ANULADA no devuelve el stock dos veces (ya lo devolvió al anularse)', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const prod = await H.makeProduct(clinicId, { category: 'insumo', salePrice: 115, purchasePrice: 40 });
  await comprar(clinicId, userId, prod);

  const r = await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: prod._id, quantity: 2, unitPrice: 115 }], paymentMethod: 'efectivo',
  }));
  const c = await H.runController(sale.cancelSale, H.mockReq(clinicId, userId, {}, { params: { id: r.payload._id } }));
  assert.equal(c.statusCode, 200, JSON.stringify(c.payload));
  assert.equal((await Product.findById(prod._id)).stock, 10, 'la anulación ya restauró el stock');

  await wipeSales({ clinic: clinicId, commit: true, log: silencio });

  assert.equal((await Product.findById(prod._id)).stock, 10, 'sigue en 10: no se sumó otra vez');
  assert.equal(await InventoryMovement.countDocuments({ clinic: clinicId, sourceModel: 'Sale' }), 0);
  assert.equal(await Sale.countDocuments({ clinic: clinicId }), 0);
  // El reverso del asiento de la venta también se fue (no quedan asientos "REVERSO" sueltos).
  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId, source: 'AJUSTE' }), 0);
  const led = await H.assertLedgerBalanced(clinicId);
  assert.ok(led.balanced, `mayor descuadrado ${led.debit} vs ${led.credit}`);
});

// ─────────────────────────────────────────────────────────────────────────────
test('dry-run: informa lo que borraría y no borra nada', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const serv = await H.makeProduct(clinicId, { category: 'servicio', salePrice: 50, unlimited: true, taxCategory: 'IVA_0' });
  await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: serv._id, quantity: 1, unitPrice: 50 }], paymentMethod: 'efectivo',
  }));

  const res = await wipeSales({ clinic: clinicId, commit: false, log: silencio });
  assert.equal(res.dryRun, true);
  assert.equal(res.ventas, 1);
  assert.equal(await Sale.countDocuments({ clinic: clinicId }), 1, 'la venta sigue ahí');
});

// ─────────────────────────────────────────────────────────────────────────────
test('la tarea se ejecuta UNA sola vez: el segundo despliegue no toca las ventas nuevas', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const serv = await H.makeProduct(clinicId, { category: 'servicio', salePrice: 50, unlimited: true, taxCategory: 'IVA_0' });
  const crearVenta = () => H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: serv._id, quantity: 1, unitPrice: 50 }], paymentMethod: 'efectivo',
  }));

  await crearVenta();
  const primera = await runOnce({ key: 'test-borrar-ventas', clinic: clinicId, log: silencio });
  assert.equal(primera.skipped, false);
  assert.equal(await Sale.countDocuments({ clinic: clinicId }), 0);

  // Ventas hechas DESPUÉS (las pruebas reales): un nuevo push no puede llevárselas.
  await crearVenta();
  const segunda = await runOnce({ key: 'test-borrar-ventas', clinic: clinicId, log: silencio });
  assert.equal(segunda.skipped, true);
  assert.equal(segunda.status, 'DONE');
  assert.equal(await Sale.countDocuments({ clinic: clinicId }), 1, 'la venta nueva sobrevive');

  const marca = await OneTimeTask.findById('test-borrar-ventas').lean();
  assert.equal(marca.status, 'DONE');
  assert.equal(marca.attempts, 1);
  assert.equal(marca.result.ventas, 1, 'la marca guarda lo que borró');

  // Con --force sí se repite (es la vía explícita para volver a limpiar).
  const forzada = await runOnce({ key: 'test-borrar-ventas', clinic: clinicId, force: true, log: silencio });
  assert.equal(forzada.skipped, false);
  assert.equal(await Sale.countDocuments({ clinic: clinicId }), 0);
  assert.equal((await OneTimeTask.findById('test-borrar-ventas').lean()).attempts, 2);
});
