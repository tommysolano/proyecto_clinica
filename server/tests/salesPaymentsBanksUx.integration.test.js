/**
 * CAMBIOS PEDIDOS POR CONTABILIDAD (bancos, productos, ventas y cobros).
 *
 * Cubre con los CONTROLLERS reales:
 *   1. Movimientos bancarios: solo se corrigen/anulan los MANUALES; los que espejan otro
 *      documento (cobro, venta, liquidación…) se bloquean para no reversar su asiento.
 *   2. Productos: el stock ya no se puede pisar desde la ficha (lo manda el kardex).
 *   3. Excel de ventas: una columna por forma de pago, con el importe de cada una y los días
 *      de crédito.
 *   4. Venta: diferido de tarjeta de crédito y plazo de crédito en días.
 *   5. Cobro de una venta: se registra como documento COBRO y aparece en la lista de cobros.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('stream');
const ExcelJS = require('exceljs');
const H = require('./_integrationHelpers');

const banks = require('../controllers/bankController');
const products = require('../controllers/productController');
const sales = require('../controllers/saleController');
const payments = require('../controllers/paymentController');
const reports = require('../controllers/reportController');
const BankAccount = require('../models/BankAccount');
const BankTransaction = require('../models/BankTransaction');
const CreditCard = require('../models/CreditCard');
const Product = require('../models/Product');
const Sale = require('../models/Sale');
const { getAccount } = require('../utils/accountMap');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const run = (h, req) => H.runController(h, req);
const ok = (r) => { if (r.statusCode >= 400) throw new Error(`${r.statusCode}: ${JSON.stringify(r.payload)}`); return r.payload; };

async function makeBank(clinicId, name = 'Banco Pichincha') {
  const acc = await getAccount(clinicId, 'bancos');
  return BankAccount.create({ clinic: clinicId, name, bank: name, accountNumber: String(Math.random()).slice(2, 10), chartAccount: acc._id });
}

/** El Excel se ESCRIBE en el response (stream). */
async function excelDe(handler, req) {
  const salida = new PassThrough();
  const chunks = [];
  salida.on('data', (c) => chunks.push(c));
  salida.setHeader = () => {};
  salida.status = () => ({ json: (p) => { throw new Error(`El export falló: ${p.message}`); } });
  const fin = new Promise((r) => salida.on('end', r));
  await handler(req, salida);
  await fin;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.concat(chunks));
  return wb;
}
const lector = (ws) => {
  const cab = ws.getRow(1).values;
  const filas = [];
  ws.eachRow((row, i) => { if (i > 1) filas.push(row); });
  return { valor: (fila, header) => filas[fila].getCell(cab.indexOf(header)).value, filas, cab };
};

// ── 1. Movimientos bancarios ─────────────────────────────────────────────────
test('un movimiento manual se corrige: se anula el anterior y nace el corregido', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const bank = await makeBank(clinicId);

  const creado = ok(await run(banks.createMovement, H.mockReq(clinicId, userId, {
    bankAccount: String(bank._id), type: 'DEPOSITO', amount: 100, description: 'Deposito con monto equivocado', reference: 'PAP-1',
  })));
  assert.equal(creado.transaction.amount, 100);

  const corregido = ok(await run(banks.updateMovement, H.mockReq(clinicId, userId,
    { amount: 250, description: 'Deposito corregido' },
    { params: { id: String(creado.transaction._id) } })));

  assert.equal(corregido.transaction.amount, 250);
  assert.equal(corregido.transaction.description, 'Deposito corregido');
  assert.equal(corregido.transaction.reference, 'PAP-1', 'lo que no se envía se conserva');

  const anterior = await BankTransaction.findById(creado.transaction._id);
  assert.equal(anterior.voided, true, 'el equivocado queda anulado, no se borra');
  const led = await H.assertLedgerBalanced(clinicId);
  assert.ok(led.balanced, `mayor descuadrado ${led.debit} vs ${led.credit}`);
});

test('un movimiento que viene de otro documento NO se corrige ni se anula desde bancos', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const bank = await makeBank(clinicId);
  // Un movimiento nacido de un cobro: comparte el asiento del cobro.
  const tx = await BankTransaction.create({
    clinic: clinicId, bankAccount: bank._id, date: new Date(), type: 'COBRO',
    amount: 80, direction: 1, description: 'Cobro CB-1', sourceModel: 'Payment', sourceRef: bank._id, createdBy: userId,
  });

  const edit = await run(banks.updateMovement, H.mockReq(clinicId, userId, { amount: 5 }, { params: { id: String(tx._id) } }));
  assert.equal(edit.statusCode, 400);
  assert.match(edit.payload.message, /documento de origen/i);

  const anular = await run(banks.voidMovement, H.mockReq(clinicId, userId, {}, { params: { id: String(tx._id) } }));
  assert.equal(anular.statusCode, 400);
  assert.match(anular.payload.message, /documento de origen/i);
  assert.equal((await BankTransaction.findById(tx._id)).voided, false, 'sigue vivo');
});

test('un movimiento conciliado no se puede corregir', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const bank = await makeBank(clinicId);
  const creado = ok(await run(banks.createMovement, H.mockReq(clinicId, userId, {
    bankAccount: String(bank._id), type: 'DEPOSITO', amount: 100, reference: 'PAP-9',
  })));
  await BankTransaction.updateOne({ _id: creado.transaction._id }, { reconciled: true });

  const r = await run(banks.updateMovement, H.mockReq(clinicId, userId, { amount: 120 }, { params: { id: String(creado.transaction._id) } }));
  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /conciliado/i);
});

test('el listado de movimientos incluye el día del filtro «hasta»', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const bank = await makeBank(clinicId);
  ok(await run(banks.createMovement, H.mockReq(clinicId, userId, {
    bankAccount: String(bank._id), type: 'DEPOSITO', amount: 10, reference: 'HOY',
  })));
  const hoy = new Date().toISOString().slice(0, 10);
  const r = ok(await run(banks.listMovements, H.mockReq(clinicId, userId, {}, { query: { startDate: hoy, endDate: hoy } })));
  assert.equal(r.items.length, 1, 'el movimiento de hoy entra en el rango hoy–hoy');
});

// ── 2. Stock de productos ────────────────────────────────────────────────────
test('editar un producto NO puede cambiar el stock', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const base = await H.makeProduct(clinicId, { name: 'Base', category: 'insumo' });
  const creado = ok(await run(products.createProduct, H.mockReq(clinicId, userId, {
    name: 'Insumo', category: 'insumo', inventoryCategory: String(base.inventoryCategory),
    salePrice: 10, cost: 5, stock: 40,
  })));
  assert.equal(creado.stock, 40, 'en el alta sí entra como saldo inicial');

  const editado = ok(await run(products.updateProduct, H.mockReq(clinicId, userId,
    { name: 'Insumo renombrado', stock: 9999, salePrice: 12 },
    { params: { id: String(creado._id) } })));
  assert.equal(editado.name, 'Insumo renombrado', 'lo demás sí se edita');
  assert.equal(editado.salePrice, 12);
  assert.equal(editado.stock, 40, 'el stock lo manda el kardex, no la ficha');
  assert.equal((await Product.findById(creado._id)).stock, 40);
});

// ── 3 y 4. Venta: plazo, diferido y Excel desglosado ─────────────────────────
async function setupVenta() {
  const { clinicId, userId } = await H.seedClinic();
  const prod = await H.makeProduct(clinicId, { name: 'Servicio', category: 'servicio', salePrice: 100, taxCategory: 'IVA_0', taxRate: 0 });
  const credito = await CreditCard.create({ clinic: clinicId, name: 'Datafast Crédito', brand: 'VISA', accountType: 'CREDITO' });
  const debito = await CreditCard.create({ clinic: clinicId, name: 'Datafast Débito', brand: 'VISA', accountType: 'DEBITO' });
  return { clinicId, userId, prod, credito, debito };
}
const linea = (p, qty = 1) => ({ product: String(p._id), quantity: qty, unitPrice: p.salePrice });

test('el plazo en días fija el vencimiento (y no se corre un día por la zona horaria)', async () => {
  const { clinicId, userId, prod } = await setupVenta();
  const venta = ok(await run(sales.createSale, H.mockReq(clinicId, userId, {
    clientName: 'Cliente', items: [linea(prod)], paymentMethod: 'credito', creditDays: 30,
  })));
  assert.equal(venta.creditDays, 30);
  const dias = Math.round((new Date(venta.dueDate) - new Date(venta.createdAt)) / 86400000);
  assert.equal(dias, 30, 'vence exactamente a 30 días');
  // Anclado al mediodía local: el día calendario del vencimiento no se corre.
  assert.equal(new Date(venta.dueDate).getHours(), 12);
});

test('el diferido se guarda solo en tarjeta de CRÉDITO; en débito queda corriente', async () => {
  const { clinicId, userId, prod, credito, debito } = await setupVenta();

  const conCredito = ok(await run(sales.createSale, H.mockReq(clinicId, userId, {
    clientName: 'Cliente', items: [linea(prod)], paymentMethod: 'tarjeta',
    creditCard: String(credito._id), cardType: 'CREDITO',
    cardDeferredType: 'SIN_INTERES', cardDeferredMonths: 6, cardLote: '0457',
  })));
  assert.equal(conCredito.payments[0].cardDeferredType, 'SIN_INTERES');
  assert.equal(conCredito.payments[0].cardDeferredMonths, 6);
  assert.equal(conCredito.cardDeferredType, 'SIN_INTERES', 'la cabecera lo espeja para la liquidación');

  const conDebito = ok(await run(sales.createSale, H.mockReq(clinicId, userId, {
    clientName: 'Cliente', items: [linea(prod)], paymentMethod: 'tarjeta',
    creditCard: String(debito._id), cardType: 'DEBITO',
    cardDeferredType: 'CON_INTERES', cardDeferredMonths: 12,
  })));
  assert.equal(conDebito.payments[0].cardDeferredType, 'CORRIENTE', 'una tarjeta de débito no difiere');
  assert.equal(conDebito.payments[0].cardDeferredMonths, 0);
});

test('el Excel de ventas trae una columna por forma de pago con su importe', async () => {
  const { clinicId, userId, prod, credito } = await setupVenta();
  // Venta MIXTA: 40 efectivo + 30 tarjeta de crédito + 30 a crédito a 15 días.
  ok(await run(sales.createSale, H.mockReq(clinicId, userId, {
    clientName: 'Cliente mixto', items: [linea(prod)],
    payments: [
      { method: 'efectivo', amount: 40 },
      { method: 'tarjeta', amount: 30, creditCard: String(credito._id), cardType: 'CREDITO' },
      { method: 'credito', amount: 30 },
    ],
    creditDays: 15,
  })));

  const wb = await excelDe(reports.exportSales, H.mockReq(clinicId, userId, {}, { query: {} }));
  const ws = wb.getWorksheet('Ventas');
  const { valor, cab } = lector(ws);

  for (const h of ['Efectivo', 'Transferencia', 'Tarjeta crédito', 'Tarjeta débito', 'Crédito (CxC)', 'Días crédito']) {
    assert.ok(cab.indexOf(h) > 0, `falta la columna ${h}`);
  }
  assert.equal(valor(0, 'Efectivo'), 40);
  assert.equal(valor(0, 'Tarjeta crédito'), 30);
  assert.equal(valor(0, 'Tarjeta débito'), 0);
  assert.equal(valor(0, 'Crédito (CxC)'), 30);
  assert.equal(valor(0, 'Días crédito'), 15);
  // Las columnas de forma de pago suman el total de la venta.
  const suma = ['Efectivo', 'Transferencia', 'Tarjeta crédito', 'Tarjeta débito', 'Tarjeta (sin tipo)', 'Crédito (CxC)', 'Otros']
    .reduce((s, h) => s + Number(valor(0, h) || 0), 0);
  assert.equal(+suma.toFixed(2), Number(valor(0, 'Total')));
});

test('una venta antigua sin desglose no inventa el tipo de tarjeta', async () => {
  const { clinicId, userId } = await H.seedClinic();
  // Venta legacy: método resumen 'tarjeta' y sin payments[].
  await Sale.create({
    clinic: clinicId, saleNumber: 'V-LEGACY', clientName: 'Antiguo',
    subtotal: 50, taxAmount: 0, total: 50, paymentMethod: 'tarjeta', payments: [], status: 'completada',
  });
  const wb = await excelDe(reports.exportSales, H.mockReq(clinicId, userId, {}, { query: {} }));
  const { valor } = lector(wb.getWorksheet('Ventas'));
  assert.equal(valor(0, 'Tarjeta (sin tipo)'), 50, 'sin evidencia va a su propia columna');
  assert.equal(valor(0, 'Tarjeta crédito'), 0);
  assert.equal(valor(0, 'Tarjeta débito'), 0);
});

// ── 5. El cobro de una venta aparece en Cobros ───────────────────────────────
test('cobrar una venta a crédito genera un documento COBRO que sale en la lista', async () => {
  const { clinicId, userId, prod } = await setupVenta();
  const bank = await makeBank(clinicId);
  const venta = ok(await run(sales.createSale, H.mockReq(clinicId, userId, {
    clientName: 'Deudor', items: [linea(prod)], paymentMethod: 'credito', creditDays: 30,
  })));
  assert.equal(venta.balance, 100);

  const cobro = ok(await run(payments.create, H.mockReq(clinicId, userId, {
    type: 'COBRO', date: new Date(), partyModel: 'Patient', partyRef: null, partyName: 'Deudor',
    method: 'TRANSFERENCIA', bankAccount: String(bank._id), reference: 'TR-1',
    applications: [{ docModel: 'Sale', docRef: String(venta._id), amount: 100 }],
  })));
  assert.equal(cobro.type, 'COBRO');
  assert.equal(cobro.appliedAmount, 100);
  assert.equal(cobro.partyName, 'Deudor', 'el nombre del cliente se guarda (antes se perdía)');

  const lista = ok(await run(payments.list, H.mockReq(clinicId, userId, {}, { query: { type: 'COBRO' } })));
  assert.equal(lista.items.length, 1, 'el cobro aparece en la pantalla de Cobros');
  assert.equal(lista.items[0].number, cobro.number);

  const saldada = await Sale.findById(venta._id);
  assert.equal(saldada.balance, 0);
  assert.equal(saldada.paid, true);
  const led = await H.assertLedgerBalanced(clinicId);
  assert.ok(led.balanced, `mayor descuadrado ${led.debit} vs ${led.credit}`);
});
