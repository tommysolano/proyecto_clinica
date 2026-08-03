/**
 * PAGO DUPLICADO — el abono que aparecía dos veces.
 *
 * Síntoma reportado: se abona $50 a una factura de compra y en Pagos salen DOS pagos de $50;
 * en la conciliación bancaria, dos movimientos. La causa no estaba en las pantallas (leen
 * bien) sino en el registro: el modal de "Pagar" enviaba el POST sin clave de idempotencia y
 * sin bloquear el botón, así que un doble clic creaba DOS `Payment` completos —cada uno con
 * su asiento y su movimiento bancario—. Todo lo que los muestra doble los está mostrando bien.
 *
 * Aquí se prueba la defensa del SERVIDOR, que es la que protege a cualquier cliente:
 *   · con clave de idempotencia ⇒ replay (un solo pago);
 *   · sin clave, duplicado inmediato ⇒ 409 (no se registra el segundo);
 *   · dos abonos legítimos distintos ⇒ los dos entran.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const payments = require('../controllers/paymentController');
const purchase = require('../controllers/purchaseInvoiceController');
const ChartOfAccount = require('../models/ChartOfAccount');
const Payment = require('../models/Payment');
const BankTransaction = require('../models/BankTransaction');
const JournalEntry = require('../models/JournalEntry');
const BankAccount = require('../models/BankAccount');
const PurchaseInvoice = require('../models/PurchaseInvoice');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

/** Compra de $300 lista para pagar + banco con cuenta contable. */
async function setup() {
  const { clinicId, userId } = await H.seedClinic();
  const gasto = await ChartOfAccount.findOne({ clinic: clinicId, code: '6.1.99' });
  const bancoAcc = await ChartOfAccount.findOne({ clinic: clinicId, code: '1.1.02.01' });
  const banco = await BankAccount.create({
    clinic: clinicId, name: 'Banco Test', bank: 'PICHINCHA', accountNumber: '123456',
    chartAccount: bancoAcc._id, initialBalance: 10000,
  });
  const sup = await H.makeSupplier(clinicId, { razonSocial: 'PROVEEDOR X' });
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: H.docDate(0), serie: '001-001-000000900',
    items: [{ description: 'Servicio', lineType: 'GASTO', quantity: 1, unitPrice: 300, ivaRate: 0, subtotal: 300, account: gasto._id }],
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  return { clinicId, userId, banco, compra: r.payload };
}

const abono = (compra, banco, amount) => ({
  type: 'PAGO', date: H.docDate(0),
  partyModel: 'Supplier', partyRef: compra.supplier, partyName: 'PROVEEDOR X',
  method: 'TRANSFERENCIA', bankAccount: banco._id, voucherNumber: 'TRF-001',
  applications: [{ docModel: 'PurchaseInvoice', docRef: compra._id, amount }],
});

// ─────────────────────────────────────────────────────────────────────────────
test('doble clic SIN clave de idempotencia: el segundo abono idéntico se rechaza (409)', async () => {
  const { clinicId, userId, banco, compra } = await setup();

  const primero = await H.runController(payments.create, H.mockReq(clinicId, userId, abono(compra, banco, 50)));
  assert.equal(primero.statusCode, 201, JSON.stringify(primero.payload));

  const segundo = await H.runController(payments.create, H.mockReq(clinicId, userId, abono(compra, banco, 50)));
  assert.equal(segundo.statusCode, 409, 'el duplicado inmediato no se registra');
  assert.match(segundo.payload.message, /idéntico/i);

  // Y NO quedó nada duplicado en ninguna de las tres colecciones que lo mostraban doble.
  assert.equal(await Payment.countDocuments({ clinic: clinicId, type: 'PAGO' }), 1, 'un solo pago');
  assert.equal(await BankTransaction.countDocuments({ clinic: clinicId, sourceModel: 'Payment' }), 1, 'un solo movimiento bancario');
  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId, sourceModel: 'Payment' }), 1, 'un solo asiento');

  // El saldo bajó UNA vez: de 300 a 250 (no a 200).
  const pi = await PurchaseInvoice.findById(compra._id);
  assert.equal(pi.balance, 250, 'el saldo refleja un solo abono de 50');
  assert.equal(pi.status, 'REGISTRADA', 'sigue con saldo pendiente');
});

test('con clave de idempotencia: el reintento devuelve el MISMO pago (replay), no uno nuevo', async () => {
  const { clinicId, userId, banco, compra } = await setup();
  const headers = { 'idempotency-key': 'intento-abono-1' };

  const primero = await H.runController(payments.create, H.mockReq(clinicId, userId, abono(compra, banco, 50), { headers }));
  assert.equal(primero.statusCode, 201);

  const reintento = await H.runController(payments.create, H.mockReq(clinicId, userId, abono(compra, banco, 50), { headers }));
  assert.equal(reintento.statusCode, 200, 'replay, no un pago nuevo');
  assert.equal(reintento.payload.idempotentReplay, true);
  assert.equal(String(reintento.payload._id), String(primero.payload._id), 'es el mismo pago');

  assert.equal(await Payment.countDocuments({ clinic: clinicId, type: 'PAGO' }), 1);
  assert.equal(await BankTransaction.countDocuments({ clinic: clinicId, sourceModel: 'Payment' }), 1);
  const pi = await PurchaseInvoice.findById(compra._id);
  assert.equal(pi.balance, 250);
});

test('dos abonos LEGÍTIMOS distintos sí entran los dos (la guardia no bloquea el trabajo real)', async () => {
  const { clinicId, userId, banco, compra } = await setup();

  const a = await H.runController(payments.create, H.mockReq(clinicId, userId, abono(compra, banco, 50)));
  assert.equal(a.statusCode, 201, JSON.stringify(a.payload));
  // Otro abono por un importe DISTINTO: es otra operación, no un duplicado.
  const b = await H.runController(payments.create, H.mockReq(clinicId, userId, abono(compra, banco, 70)));
  assert.equal(b.statusCode, 201, JSON.stringify(b.payload));

  assert.equal(await Payment.countDocuments({ clinic: clinicId, type: 'PAGO' }), 2);
  const pi = await PurchaseInvoice.findById(compra._id);
  assert.equal(pi.balance, 180, '300 − 50 − 70');
});

// ─────────────────────────────────────────────────────────────────────────────
test('los ABONOS de una compra se consultan con su saldo (lo que faltaba en la pantalla)', async () => {
  const { clinicId, userId, banco, compra } = await setup();
  await H.runController(payments.create, H.mockReq(clinicId, userId, abono(compra, banco, 50)));
  await H.runController(payments.create, H.mockReq(clinicId, userId, abono(compra, banco, 70)));

  const r = await H.runController(purchase.payments, H.mockReq(clinicId, userId, {}, { params: { id: String(compra._id) } }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));

  assert.equal(r.payload.netoAPagar, 300, 'total − retenciones');
  assert.equal(r.payload.abonado, 120, 'la suma de los abonos vigentes');
  assert.equal(r.payload.saldo, 180, 'lo que queda por pagar');
  assert.equal(r.payload.count, 2);
  assert.equal(r.payload.rows.length, 2);

  // Cada abono trae lo que el contador necesita para identificarlo.
  const [uno] = r.payload.rows;
  assert.ok(uno.number, 'número de pago');
  assert.equal(uno.method, 'TRANSFERENCIA');
  assert.equal(uno.bankAccount.name, 'Banco Test');
  assert.equal(uno.status, 'REGISTRADO');

  // Invariante del reporte: neto = abonado + saldo.
  assert.equal(r.payload.abonado + r.payload.saldo, r.payload.netoAPagar);
});

test('un abono ANULADO deja de contar como abonado y devuelve el saldo', async () => {
  const { clinicId, userId, banco, compra } = await setup();
  const p = await H.runController(payments.create, H.mockReq(clinicId, userId, abono(compra, banco, 50)));
  await H.runController(payments.void, H.mockReq(clinicId, userId, {}, { params: { id: String(p.payload._id) } }));

  const r = await H.runController(purchase.payments, H.mockReq(clinicId, userId, {}, { params: { id: String(compra._id) } }));
  assert.equal(r.payload.abonado, 0, 'el anulado no suma');
  assert.equal(r.payload.saldo, 300, 'el saldo volvió a su valor original');
  // Pero SIGUE apareciendo en la lista: explica por qué el saldo subió.
  assert.equal(r.payload.rows.length, 1);
  assert.equal(r.payload.rows[0].status, 'ANULADO');
});
