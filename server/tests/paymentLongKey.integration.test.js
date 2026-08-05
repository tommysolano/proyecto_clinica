/**
 * EL PAGO QUE SE QUEDABA PENSANDO PARA SIEMPRE.
 *
 * Síntoma reportado: se registra un pago con cheque a DOS facturas de compra, la pantalla se
 * queda en «Registrando…» y al cabo de un rato aparece un «Error» que no dice nada. En la base
 * no queda ni el pago ni el asiento, y en el log del servidor tampoco hay rastro.
 *
 * Causa: la clave de idempotencia que arma el navegador llevaba un segmento por documento
 * aplicado (~45 caracteres por factura). Con UNA factura la clave medía ~160 caracteres y el
 * pago entraba; con DOS llegaba a 206 y superaba el límite de 200 del servidor.
 * `readIdempotencyKey` lanzaba entonces un error 400… pero se la llama ANTES del `try` del
 * controlador, y Express 4 no captura el rechazo de un handler `async`: la petición se quedaba
 * SIN RESPUESTA, el navegador giraba hasta que se cortaba la conexión y el toast mostraba el
 * texto genérico. De ahí que «no especificara el error»: nunca hubo respuesta que leer.
 *
 * Se corrige en los dos extremos: el cliente resume la huella (clave de longitud fija) y el
 * servidor deriva una clave corta y estable en vez de rechazar la larga. Aquí se prueba el
 * servidor, que es el que protege a cualquier cliente (integraciones, versiones cacheadas del
 * front, scripts).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const payments = require('../controllers/paymentController');
const purchase = require('../controllers/purchaseInvoiceController');
const { readIdempotencyKey } = require('../utils/idempotency');
const ChartOfAccount = require('../models/ChartOfAccount');
const BankAccount = require('../models/BankAccount');
const BankCheck = require('../models/BankCheck');
const Payment = require('../models/Payment');
const PurchaseInvoice = require('../models/PurchaseInvoice');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

/** Banco con chequera 1..50 y dos compras del mismo proveedor, listas para pagar. */
async function setup() {
  const { clinicId, userId } = await H.seedClinic();
  const gasto = await ChartOfAccount.findOne({ clinic: clinicId, code: '6.1.99' });
  const bancoAcc = await ChartOfAccount.findOne({ clinic: clinicId, code: '1.1.01.03' });
  const banco = await BankAccount.create({
    clinic: clinicId, name: 'Cta. Cte. Banco Internacional', bank: 'INTERNACIONAL',
    accountNumber: '1400632113', chartAccount: bancoAcc._id, initialBalance: 0,
  });
  await BankCheck.insertMany(
    Array.from({ length: 50 }, (_, i) => ({ clinic: clinicId, bankAccount: banco._id, number: i + 1 }))
  );
  const sup = await H.makeSupplier(clinicId, { razonSocial: 'ANGULO GONZALEZ LISSETTE MISHELL' });

  const compras = [];
  for (const [serie, monto] of [['001-001-3665', 230], ['001-001-021', 431.25]]) {
    const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
      supplier: sup._id, fechaEmision: H.docDate(0), serie,
      items: [{ description: 'Servicio', lineType: 'GASTO', quantity: 1, unitPrice: monto, ivaRate: 0, subtotal: monto, account: gasto._id }],
    }));
    assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
    compras.push(r.payload);
  }
  return { clinicId, userId, banco, sup, compras };
}

/** Clave con la MISMA forma que la del navegador: uuid + un segmento por documento aplicado. */
const claveNavegador = (banco, sup, compras) => [
  '11111111-2222-3333-4444-555555555555:PAGO', 'CHEQUE', String(banco._id),
  H.docDate(0), String(sup._id), '0', '2',
  ...compras.map((c, i) => `PurchaseInvoice_${c._id}_${i === 0 ? '230' : '431.25'}`),
].join('|');

const pagoConCheque = (banco, sup, compras) => ({
  type: 'PAGO', date: H.docDate(0),
  partyModel: 'Supplier', partyRef: String(sup._id), partyName: 'ANGULO GONZALEZ LISSETTE MISHELL',
  method: 'CHEQUE', bankAccount: String(banco._id), checkNumber: '2',
  voucherNumber: '32423423423432',
  applications: [
    { docModel: 'PurchaseInvoice', docRef: String(compras[0]._id), amount: 230 },
    { docModel: 'PurchaseInvoice', docRef: String(compras[1]._id), amount: 431.25 },
  ],
  advanceAmount: 0,
});

// ─────────────────────────────────────────────────────────────────────────────
test('una clave de idempotencia larga NO tumba la petición: se deriva una corta y estable', () => {
  const larga = `x${'y'.repeat(400)}`;
  const derivada = readIdempotencyKey({ headers: { 'idempotency-key': larga } });
  assert.ok(derivada, 'devuelve una clave, no lanza');
  assert.ok(derivada.length <= 200, `la clave derivada cabe en el índice (${derivada.length})`);
  // Estable: la misma clave larga produce SIEMPRE la misma corta, o el replay dejaría de funcionar.
  assert.equal(derivada, readIdempotencyKey({ headers: { 'idempotency-key': larga } }));
  // Y sigue distinguiendo intenciones distintas.
  assert.notEqual(derivada, readIdempotencyKey({ headers: { 'idempotency-key': `${larga}z` } }));
  // Una clave normal no se toca.
  assert.equal(readIdempotencyKey({ headers: { 'idempotency-key': 'intento-1' } }), 'intento-1');
});

test('pago con cheque a DOS compras (clave de 200+ caracteres): se registra y responde', async () => {
  const { clinicId, userId, banco, sup, compras } = await setup();
  const clave = claveNavegador(banco, sup, compras);
  assert.ok(clave.length > 200, `la clave del navegador supera el límite antiguo (${clave.length})`);

  const r = await H.runController(payments.create, H.mockReq(
    clinicId, userId, pagoConCheque(banco, sup, compras), { headers: { 'idempotency-key': clave } }
  ));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(r.payload.total, 661.25);

  // El cheque quedó girado con su beneficiario e importe, y las dos compras quedaron pagadas.
  const chk = await BankCheck.findOne({ clinic: clinicId, bankAccount: banco._id, number: 2 });
  assert.equal(chk.status, 'GIRADO');
  assert.equal(chk.amount, 661.25);
  assert.equal(chk.beneficiary, 'ANGULO GONZALEZ LISSETTE MISHELL');
  for (const c of compras) {
    const pi = await PurchaseInvoice.findById(c._id);
    assert.equal(pi.balance, 0, `${pi.serie} quedó saldada`);
    assert.equal(pi.status, 'PAGADA');
  }
});

test('reintentar ese mismo pago con la clave larga hace replay, no un segundo pago', async () => {
  const { clinicId, userId, banco, sup, compras } = await setup();
  const headers = { 'idempotency-key': claveNavegador(banco, sup, compras) };

  const primero = await H.runController(payments.create, H.mockReq(clinicId, userId, pagoConCheque(banco, sup, compras), { headers }));
  assert.equal(primero.statusCode, 201, JSON.stringify(primero.payload));

  const reintento = await H.runController(payments.create, H.mockReq(clinicId, userId, pagoConCheque(banco, sup, compras), { headers }));
  assert.equal(reintento.statusCode, 200, 'replay');
  assert.equal(reintento.payload.idempotentReplay, true);
  assert.equal(String(reintento.payload._id), String(primero.payload._id));

  assert.equal(await Payment.countDocuments({ clinic: clinicId, type: 'PAGO' }), 1, 'un solo pago');
  // Y el cheque se giró UNA vez (no se consumió otro número al reintentar).
  assert.equal(await BankCheck.countDocuments({ clinic: clinicId, bankAccount: banco._id, status: 'GIRADO' }), 1);
});
