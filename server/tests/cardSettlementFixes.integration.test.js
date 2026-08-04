/**
 * LIQUIDACIONES Y LOTES DE TARJETA · fallas reportadas por contabilidad.
 *
 * Cubre, con los CONTROLLERS reales, los seis defectos corregidos:
 *   1. buscar por N° de lote no devolvía nada (rango de fechas impuesto, ceros a la izquierda,
 *      y lote que solo vive en el renglón de pago dividido);
 *   2. el doble clic creaba DOS liquidaciones (idempotencia por `Idempotency-Key`);
 *   3. las bases con/sin IVA se guardan, se totalizan y no pueden superar el depósito;
 *   4. la acreditación aparece en la conciliación bancaria aunque se contabilice DESPUÉS
 *      de haberla abierto;
 *   5. liquidar un lote deposita en el banco elegido, no en el primero de la clínica.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const H = require('./_integrationHelpers');

const ctrl = require('../controllers/cardSettlementController');
const batchCtrl = require('../controllers/creditCardBatchController');
const bankCtrl = require('../controllers/bankController');
const CardSettlement = require('../models/CardSettlement');
const CreditCardBatch = require('../models/CreditCardBatch');
const RetentionRule = require('../models/RetentionRule');
const BankAccount = require('../models/BankAccount');
const BankTransaction = require('../models/BankTransaction');
const Sale = require('../models/Sale');
const { getAccount } = require('../utils/accountMap');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const run = (h, req) => H.runController(h, req);

async function seedRules(clinicId) {
  await RetentionRule.create([
    { clinic: clinicId, type: 'RENTA', code: '332', description: 'Ret. renta tarjetas', rate: 2, active: true },
    { clinic: clinicId, type: 'IVA', code: '725', description: 'Ret. IVA 30%', rate: 30, active: true },
  ]);
}

async function makeBank(clinicId, name = 'Banco Pichincha') {
  const acc = await getAccount(clinicId, 'bancos');
  return BankAccount.create({ clinic: clinicId, name, bank: name, accountNumber: String(Math.random()).slice(2, 10), chartAccount: acc._id });
}

/** Venta pagada con tarjeta. `payments` permite simular el pago dividido. */
function makeSale(clinicId, { lote = '', total = 100, dias = 0, payments = null } = {}) {
  const fecha = H.docDate(dias);
  return Sale.create({
    clinic: clinicId,
    saleNumber: `V-${Math.random().toString(36).slice(2, 8)}`,
    clientName: 'Paciente',
    subtotal: total, taxableSubtotal: total, taxAmount: 0, total,
    paymentMethod: payments ? 'mixto' : 'tarjeta',
    payments: payments || [{ method: 'tarjeta', amount: total, cardLote: lote }],
    cardLote: lote,
    status: 'completada',
    createdAt: fecha,
  });
}

// ── 1. Búsqueda por lote ─────────────────────────────────────────────────────
test('buscar SOLO por lote encuentra la venta aunque sea de días anteriores', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await makeSale(clinicId, { lote: '0457', total: 250, dias: -6 });

  const r = await run(ctrl.searchCardSales, H.mockReq(clinicId, userId, {}, { query: { lote: '0457' } }));
  assert.equal(r.statusCode, 200);
  assert.equal(r.payload.length, 1, 'el lote de un día anterior tiene que salir (antes el rango de HOY lo tapaba)');
  assert.equal(r.payload[0].total, 250);
});

test('los ceros a la izquierda no esconden el lote: 457 encuentra 0457 y al revés', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await makeSale(clinicId, { lote: '0457', total: 100 });

  const sinCeros = await run(ctrl.searchCardSales, H.mockReq(clinicId, userId, {}, { query: { lote: '457' } }));
  assert.equal(sinCeros.payload.length, 1, '457 debe encontrar el lote 0457');

  await Sale.updateMany({ clinic: clinicId }, { cardLote: '457' });
  const conCeros = await run(ctrl.searchCardSales, H.mockReq(clinicId, userId, {}, { query: { lote: '0457' } }));
  assert.equal(conCeros.payload.length, 1, '0457 debe encontrar el lote 457');
});

test('con pago dividido encuentra el lote del SEGUNDO renglón de tarjeta', async () => {
  const { clinicId, userId } = await H.seedClinic();
  // La cabecera se queda con el lote del primer renglón: el del segundo solo vive en payments[].
  await makeSale(clinicId, {
    lote: '111', total: 300,
    payments: [
      { method: 'tarjeta', amount: 100, cardLote: '111' },
      { method: 'tarjeta', amount: 200, cardLote: '222' },
    ],
  });

  const r = await run(ctrl.searchCardSales, H.mockReq(clinicId, userId, {}, { query: { lote: '222' } }));
  assert.equal(r.payload.length, 1, 'el lote del renglón dividido también se busca');
});

test('el rango de fechas sigue acotando cuando se usa a propósito', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await makeSale(clinicId, { lote: '900', total: 50, dias: -10 });
  const hoy = new Date().toISOString().slice(0, 10);

  const r = await run(ctrl.searchCardSales, H.mockReq(clinicId, userId, {}, { query: { lote: '900', from: hoy, to: hoy } }));
  assert.equal(r.payload.length, 0, 'si el contador pone fechas, mandan las fechas');
});

// ── 2. Doble clic ────────────────────────────────────────────────────────────
const BODY_LIQ = () => ({
  issueDate: new Date(),
  transactions: [{ recap: 'A', deposit: 1000, commission: 20, iva: 3, baseRetIr: 200, baseRetIva: 0 }],
  retentions: [{ type: 'RENTA', sriCode: '332' }],
});

test('doble clic con la misma clave crea UNA sola liquidación', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedRules(clinicId);
  const headers = { 'idempotency-key': 'liq-doble-clic' };
  const body = BODY_LIQ();

  const primera = await run(ctrl.create, H.mockReq(clinicId, userId, body, { headers }));
  const segunda = await run(ctrl.create, H.mockReq(clinicId, userId, body, { headers }));

  assert.equal(primera.statusCode, 201);
  assert.equal(segunda.statusCode, 200, 'la repetición es un replay, no una creación');
  assert.equal(String(segunda.payload._id), String(primera.payload._id));
  assert.equal(segunda.payload.idempotentReplay, true);
  assert.equal(await CardSettlement.countDocuments({ clinic: clinicId }), 1, 'una sola liquidación en la base');
});

test('la misma clave con OTRO contenido responde 409 y no crea nada', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedRules(clinicId);
  const headers = { 'idempotency-key': 'liq-misma-clave' };

  await run(ctrl.create, H.mockReq(clinicId, userId, BODY_LIQ(), { headers }));
  const otra = { ...BODY_LIQ(), transactions: [{ recap: 'B', deposit: 5000, commission: 20, iva: 3, baseRetIr: 200, baseRetIva: 0 }] };
  const r = await run(ctrl.create, H.mockReq(clinicId, userId, otra, { headers }));

  assert.equal(r.statusCode, 409);
  assert.equal(await CardSettlement.countDocuments({ clinic: clinicId }), 1);
});

test('sin clave de idempotencia, dos envíos distintos siguen siendo dos liquidaciones con códigos distintos', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedRules(clinicId);
  const a = await run(ctrl.create, H.mockReq(clinicId, userId, BODY_LIQ()));
  const b = await run(ctrl.create, H.mockReq(clinicId, userId, BODY_LIQ()));
  assert.equal(a.statusCode, 201);
  assert.equal(b.statusCode, 201);
  assert.notEqual(a.payload.code, b.payload.code, 'la numeración es atómica, no se repite');
});

test('el código no se reutiliza tras eliminar un borrador', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedRules(clinicId);
  const a = await run(ctrl.create, H.mockReq(clinicId, userId, BODY_LIQ()));
  await run(ctrl.remove, H.mockReq(clinicId, userId, {}, { params: { id: String(a.payload._id) } }));
  const b = await run(ctrl.create, H.mockReq(clinicId, userId, BODY_LIQ()));
  assert.equal(b.statusCode, 201, JSON.stringify(b.payload));
  assert.notEqual(b.payload.code, a.payload.code, 'el contador no retrocede al borrar (antes chocaba con el índice único)');
});

// ── 3. Bases con / sin IVA ───────────────────────────────────────────────────
test('las bases con y sin IVA se guardan y se totalizan', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedRules(clinicId);
  const r = await run(ctrl.create, H.mockReq(clinicId, userId, {
    issueDate: new Date(),
    transactions: [
      { recap: 'A', deposit: 1000, baseConIva: 700, baseSinIva: 195, commission: 20, iva: 3, baseRetIr: 200, baseRetIva: 0 },
      { recap: 'B', deposit: 500, baseConIva: 300, baseSinIva: 155, commission: 10, iva: 1.5, baseRetIr: 0, baseRetIva: 0 },
    ],
    retentions: [{ type: 'RENTA', sriCode: '332' }],
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(r.payload.totalBaseConIva, 1000);
  assert.equal(r.payload.totalBaseSinIva, 350);
  assert.equal(r.payload.transactions[0].baseConIva, 700);
});

test('la suma de bases no puede superar el depósito de la transacción', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedRules(clinicId);
  const r = await run(ctrl.create, H.mockReq(clinicId, userId, {
    issueDate: new Date(),
    transactions: [{ recap: 'A', deposit: 1000, baseConIva: 900, baseSinIva: 300, commission: 20, iva: 3, baseRetIr: 200, baseRetIva: 0 }],
    retentions: [{ type: 'RENTA', sriCode: '332' }],
  }));
  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /supera el depósito/i);
  assert.equal(await CardSettlement.countDocuments({ clinic: clinicId }), 0);
});

// ── 4. Conciliación bancaria ─────────────────────────────────────────────────
test('la acreditación aparece en una conciliación abierta ANTES de contabilizarla', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedRules(clinicId);
  const bank = await makeBank(clinicId);
  const corte = new Date();
  corte.setHours(23, 59, 59, 999);

  // La contadora abre la conciliación primero: todavía no hay movimientos.
  const rec = await run(bankCtrl.startReconciliation, H.mockReq(clinicId, userId, {
    bankAccount: String(bank._id), cutDate: corte, statementBalance: 0,
  }));
  assert.equal(rec.statusCode, 201, JSON.stringify(rec.payload));
  assert.equal(rec.payload.items.length, 0);

  // Después acredita la liquidación.
  const liq = (await run(ctrl.create, H.mockReq(clinicId, userId, {
    issueDate: new Date(), bankAccount: String(bank._id), ...BODY_LIQ(),
  }))).payload;
  const acc = await run(ctrl.accredit, H.mockReq(clinicId, userId, {}, { params: { id: String(liq._id) } }));
  assert.equal(acc.statusCode, 200, JSON.stringify(acc.payload));

  // Al volver a abrir la conciliación, el depósito TIENE que estar.
  const detalle = await run(bankCtrl.getReconciliation, H.mockReq(clinicId, userId, {}, { params: { id: String(rec.payload._id) } }));
  assert.equal(detalle.statusCode, 200, JSON.stringify(detalle.payload));
  assert.equal(detalle.payload.items.length, 1, 'el movimiento de la liquidación entra a la conciliación');
  assert.equal(String(detalle.payload.items[0].transaction._id), String(acc.payload.bankTransaction));
  assert.ok(detalle.payload.bookBalance > 0, 'el saldo contable incluye el depósito');
});

test('los movimientos ya marcados no se pierden al recargar la conciliación', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedRules(clinicId);
  const bank = await makeBank(clinicId);
  const liq = (await run(ctrl.create, H.mockReq(clinicId, userId, {
    issueDate: new Date(), bankAccount: String(bank._id), ...BODY_LIQ(),
  }))).payload;
  await run(ctrl.accredit, H.mockReq(clinicId, userId, {}, { params: { id: String(liq._id) } }));

  const corte = new Date(); corte.setHours(23, 59, 59, 999);
  const rec = (await run(bankCtrl.startReconciliation, H.mockReq(clinicId, userId, {
    bankAccount: String(bank._id), cutDate: corte, statementBalance: 0,
  }))).payload;

  const marcados = rec.items.map((it) => ({ transaction: it.transaction._id || it.transaction, matched: true }));
  const guardada = await run(bankCtrl.updateReconciliation, H.mockReq(clinicId, userId, { items: marcados }, { params: { id: String(rec._id) } }));
  assert.equal(guardada.payload.items[0].matched, true);

  const releida = await run(bankCtrl.getReconciliation, H.mockReq(clinicId, userId, {}, { params: { id: String(rec._id) } }));
  assert.equal(releida.payload.items[0].matched, true, 'la recarga conserva lo ya marcado');
});

test('los movimientos creados desde el extracto siguen en la conciliación al recargarla', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const bank = await makeBank(clinicId);
  const corte = new Date(); corte.setHours(23, 59, 59, 999);
  const rec = (await run(bankCtrl.startReconciliation, H.mockReq(clinicId, userId, {
    bankAccount: String(bank._id), cutDate: corte, statementBalance: 0,
  }))).payload;

  // Una comisión bancaria del extracto: nace YA conciliada contra esta conciliación.
  const creada = await run(bankCtrl.reconcileCreateMovements, H.mockReq(clinicId, userId, {
    creates: [{ date: new Date(), amount: -12.5, description: 'Comision bancaria' }],
  }, { params: { id: String(rec._id) } }));
  assert.equal(creada.statusCode, 200, JSON.stringify(creada.payload));
  assert.equal(creada.payload.items.length, 1);

  const releida = await run(bankCtrl.getReconciliation, H.mockReq(clinicId, userId, {}, { params: { id: String(rec._id) } }));
  assert.equal(releida.payload.items.length, 1, 'la recarga no puede expulsar lo que la propia conciliación creó');
  assert.equal(releida.payload.items[0].matched, true);
});

// ── 5. Lotes de tarjeta ──────────────────────────────────────────────────────
test('liquidar un lote deposita en el banco elegido, no en el primero de la clínica', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const primero = await makeBank(clinicId, 'Banco Uno');
  const elegido = await makeBank(clinicId, 'Banco Dos');

  const lote = (await run(batchCtrl.create, H.mockReq(clinicId, userId, {
    closeDate: new Date(), acquirer: 'Datafast', commissionRate: 5, retentionRate: 2,
    bankAccount: String(elegido._id),
    vouchers: [{ voucherNumber: '1', lote: '0457', grossAmount: 1000 }],
  }))).payload;
  assert.equal(lote.grossAmount, 1000);

  // El cliente ya manda el banco, pero aunque no lo mandara debe usar el del lote.
  const r = await run(batchCtrl.liquidate, H.mockReq(clinicId, userId, {}, { params: { id: String(lote._id) } }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));

  const bt = await BankTransaction.findById(r.payload.bankTransaction);
  assert.equal(String(bt.bankAccount), String(elegido._id), 'el depósito va al banco del lote');
  assert.notEqual(String(bt.bankAccount), String(primero._id));
});

test('doble clic al crear un lote crea UNO solo', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const bank = await makeBank(clinicId);
  const headers = { 'idempotency-key': 'lote-doble-clic' };
  const body = {
    closeDate: new Date(), acquirer: 'Medianet', commissionRate: 4, bankAccount: String(bank._id),
    vouchers: [{ voucherNumber: '9', lote: '0100', grossAmount: 500 }],
  };

  const a = await run(batchCtrl.create, H.mockReq(clinicId, userId, body, { headers }));
  const b = await run(batchCtrl.create, H.mockReq(clinicId, userId, body, { headers }));
  assert.equal(a.statusCode, 201);
  assert.equal(b.statusCode, 200);
  assert.equal(String(a.payload._id), String(b.payload._id));
  assert.equal(await CreditCardBatch.countDocuments({ clinic: clinicId }), 1);
});

test('el % de IVA de la comisión del formulario sí se aplica (antes estaba fijo en 15)', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const bank = await makeBank(clinicId);
  const r = await run(batchCtrl.create, H.mockReq(clinicId, userId, {
    closeDate: new Date(), acquirer: 'Datafast', commissionRate: 10, ivaCommissionRate: 5,
    bankAccount: String(bank._id),
    vouchers: [{ voucherNumber: '1', lote: '1', grossAmount: 1000 }],
  }));
  assert.equal(r.payload.commissionAmount, 100);
  assert.equal(r.payload.ivaCommissionAmount, 5, '5% de 100, no 15%');
  assert.equal(r.payload.netAmount, 895);
});

test('un cobro ya incluido en un lote no se vuelve a ofrecer (forBatch)', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const bank = await makeBank(clinicId);
  const venta = await makeSale(clinicId, { lote: '0457', total: 400 });

  const antes = await run(ctrl.searchCardSales, H.mockReq(clinicId, userId, {}, { query: { lote: '0457', forBatch: 'true' } }));
  assert.equal(antes.payload.length, 1);

  await run(batchCtrl.create, H.mockReq(clinicId, userId, {
    closeDate: new Date(), acquirer: 'Datafast', bankAccount: String(bank._id),
    vouchers: [{ sale: String(venta._id), voucherNumber: '1', lote: '0457', grossAmount: 400 }],
  }));

  const despues = await run(ctrl.searchCardSales, H.mockReq(clinicId, userId, {}, { query: { lote: '0457', forBatch: 'true' } }));
  assert.equal(despues.payload.length, 0, 'ese cobro ya está en un lote: no se puede contar dos veces');
});
