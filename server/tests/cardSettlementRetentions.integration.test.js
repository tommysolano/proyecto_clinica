/**
 * LIQUIDACIÓN DE TARJETA · captura de retenciones sin digitación (revisión de la contadora).
 *
 * Con los CONTROLLERS reales:
 *  · las filas de retención se generan/actualizan SOLAS desde las bases de las transacciones
 *    (RENTA = Σ baseRetIr, IVA = Σ baseRetIva);
 *  · elegir el código SRI trae el % de la RetentionRule y calcula el valor (base × % / 100);
 *  · no se puede guardar ni acreditar una retención sin código;
 *  · el asiento al acreditar cuadra con los nuevos campos (depósito + comisión + IVA + retenciones
 *    = total de transacciones).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const ctrl = require('../controllers/cardSettlementController');
const CardSettlement = require('../models/CardSettlement');
const RetentionRule = require('../models/RetentionRule');
const BankAccount = require('../models/BankAccount');
const JournalEntry = require('../models/JournalEntry');
const BankTransaction = require('../models/BankTransaction');
const { getAccount } = require('../utils/accountMap');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const run = (h, req) => H.runController(h, req);

/** Reglas de retención del catálogo: renta 2% (código 332) e IVA 30% (código 725). */
async function seedRules(clinicId) {
  await RetentionRule.create([
    { clinic: clinicId, type: 'RENTA', code: '332', description: 'Ret. renta tarjetas', rate: 2, active: true },
    { clinic: clinicId, type: 'IVA', code: '725', description: 'Ret. IVA 30%', rate: 30, active: true },
  ]);
}

async function makeBank(clinicId) {
  const acc = await getAccount(clinicId, 'bancos');
  return BankAccount.create({ clinic: clinicId, name: 'Banco Pichincha', bank: 'Pichincha', accountNumber: '1', chartAccount: acc._id });
}

/** Dos transacciones: A solo con base de renta; B con base de renta e IVA. */
const TXNS = () => [
  { date: new Date(), recap: 'A', deposit: 1000, commission: 20, iva: 3, baseRetIr: 200, baseRetIva: 0 },
  { date: new Date(), recap: 'B', deposit: 500, commission: 10, iva: 1.5, baseRetIr: 250, baseRetIva: 100 },
];

// ─────────────────────────────────────────────────────────────────────────────
test('las filas RENTA e IVA se generan solas con las bases sumadas y el % viene de la regla', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedRules(clinicId);

  const body = {
    issueDate: new Date(),
    transactions: TXNS(),
    retentions: [{ type: 'RENTA', sriCode: '332' }, { type: 'IVA', sriCode: '725' }],
  };
  const r = await run(ctrl.create, H.mockReq(clinicId, userId, body));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const s = r.payload;

  // Bases sumadas de TODAS las transacciones: RENTA 200+250=450, IVA 0+100=100.
  const renta = s.retentions.find((x) => x.type === 'RENTA');
  const iva = s.retentions.find((x) => x.type === 'IVA');
  assert.ok(renta && iva, 'existen las dos filas de retención');
  assert.equal(s.retentions.length, 2, 'exactamente una por tipo (no se digitan a mano)');
  assert.deepEqual([renta.base, renta.percentage, renta.value], [450, 2, 9], 'RENTA: base 450, 2% (de la regla), valor 9');
  assert.deepEqual([iva.base, iva.percentage, iva.value], [100, 30, 30], 'IVA: base 100, 30% (de la regla), valor 30');

  // A pagar por transacción = depósito - comisión - iva (la retención NO se resta por línea).
  assert.equal(s.transactions[0].toPay, 977);
  assert.equal(s.transactions[1].toPay, 488.5);
  assert.equal(s.totalRetIr, 9);
  assert.equal(s.totalRetIva, 30);
});

// ─────────────────────────────────────────────────────────────────────────────
test('si una base queda en 0, su fila de retención desaparece', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedRules(clinicId);
  // Solo base de renta (ninguna de IVA): debe existir la fila RENTA y NO la de IVA.
  const body = {
    issueDate: new Date(),
    transactions: [{ recap: 'A', deposit: 1000, commission: 20, iva: 3, baseRetIr: 200, baseRetIva: 0 }],
    retentions: [{ type: 'RENTA', sriCode: '332' }],
  };
  const s = (await run(ctrl.create, H.mockReq(clinicId, userId, body))).payload;
  assert.equal(s.retentions.length, 1);
  assert.equal(s.retentions[0].type, 'RENTA');
  assert.equal(s.totalRetIva, 0, 'sin base de IVA no hay retención de IVA');
});

// ─────────────────────────────────────────────────────────────────────────────
test('no se puede guardar una retención sin código SRI (bloqueo claro)', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedRules(clinicId);
  // Hay base de renta pero la fila no trae código: debe bloquear.
  const body = {
    issueDate: new Date(),
    transactions: TXNS(),
    retentions: [{ type: 'IVA', sriCode: '725' }], // falta la de RENTA
  };
  const r = await run(ctrl.create, H.mockReq(clinicId, userId, body));
  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /código SRI de la retención de renta/i);
});

// ─────────────────────────────────────────────────────────────────────────────
test('no se puede acreditar sin código SRI (guard en la acreditación)', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedRules(clinicId);
  const bank = await makeBank(clinicId);
  // Se inserta directo un BORRADOR con bases pero SIN código (evita la validación del create)
  // para probar el guard de la acreditación.
  const s = await CardSettlement.create({
    clinic: clinicId, code: 'LIQ-TEST-1', issueDate: new Date(), bankAccount: bank._id,
    transactions: TXNS(), retentions: [], createdBy: userId,
  });
  const r = await run(ctrl.accredit, H.mockReq(clinicId, userId, {}, { params: { id: String(s._id) } }));
  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /código SRI/i);
  assert.equal((await CardSettlement.findById(s._id)).status, 'BORRADOR', 'no se contabilizó');
});

// ─────────────────────────────────────────────────────────────────────────────
test('el asiento al acreditar cuadra con los nuevos campos', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedRules(clinicId);
  const bank = await makeBank(clinicId);

  const created = (await run(ctrl.create, H.mockReq(clinicId, userId, {
    issueDate: new Date(), bankAccount: String(bank._id),
    transactions: TXNS(),
    retentions: [{ type: 'RENTA', sriCode: '332' }, { type: 'IVA', sriCode: '725' }],
  }))).payload;

  const r = await run(ctrl.accredit, H.mockReq(clinicId, userId, {}, { params: { id: String(created._id) } }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  const s = r.payload;
  assert.equal(s.status, 'CONTABILIZADO');

  // Neto a banco = totalToPay - retIr - retIva = 1465.5 - 9 - 30 = 1426.5.
  const netEsperado = 1426.5;
  const bt = await BankTransaction.findById(s.bankTransaction);
  assert.equal(bt.amount, netEsperado, 'el depósito en banco es el neto correcto');

  // El asiento cuadra y suma exactamente el total de transacciones (depósito 1500).
  const entry = await JournalEntry.findById(s.journalEntry);
  const totalDebe = entry.lines.reduce((a, l) => a + (l.debit || 0), 0);
  const totalHaber = entry.lines.reduce((a, l) => a + (l.credit || 0), 0);
  assert.equal(+totalDebe.toFixed(2), 1500);
  assert.equal(+totalHaber.toFixed(2), 1500, 'depósito + comisión + IVA + retenciones = total transacciones');

  const bankLine = entry.lines.find((l) => (l.debit || 0) === netEsperado);
  assert.ok(bankLine, 'hay una línea de banco por el neto');
  const led = await H.assertLedgerBalanced(clinicId);
  assert.ok(led.balanced, `mayor descuadrado ${led.debit} vs ${led.credit}`);
});

// ─────────────────────────────────────────────────────────────────────────────
test('la coherencia se recalcula al guardar: la base de la fila = suma de bases, aunque el cliente mande otra', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedRules(clinicId);
  // El cliente manda una base y un % equivocados: el backend los ignora y recalcula desde la regla.
  const s = (await run(ctrl.create, H.mockReq(clinicId, userId, {
    issueDate: new Date(),
    transactions: TXNS(),
    retentions: [
      { type: 'RENTA', sriCode: '332', base: 99999, percentage: 3, value: 12345 },
      { type: 'IVA', sriCode: '725', base: 1, percentage: 1, value: 1 },
    ],
  }))).payload;
  const renta = s.retentions.find((x) => x.type === 'RENTA');
  assert.deepEqual([renta.base, renta.percentage, renta.value], [450, 2, 9], 'ignora lo digitado y recalcula base/%/valor');
});
