'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseReconciliations, matchLines } = require('../scripts/importContificoReconciliations');

const bank = 'Banco Pichincha Cta Cte 2100343419';
const sheets = (lines, statementBalance) => ({
  movements: [
    ['SHILUV'], [], [], ['Fecha Corte', 'Banco', 'Saldo Inicial', 'Fecha', 'Detalle', 'Referencia', 'Tipo', 'Signo', 'Monto', 'Persona'], [],
    ['31/01/26', bank, '100', ...lines[0]], ...lines.slice(1).map((line) => ['', '', '', ...line]),
  ],
  balances: [['Resumen'], [], [], ['31/01/26', bank, 'Saldo bancario al 31/01/26', 'Saldo contable al 31/01/26', 'Diferencia'],
    ['', '', statementBalance, '$1,000.00', '-$500.00']],
});
const ledgerLine = (key, date, amount, description) => ({ key, journalEntry: `J${key}`, lineIndex: 0,
  accountNumber: '2100343419', date, amount, description });

test('lee cada conciliación y exige que inicial + movimientos sea el saldo bancario', () => {
  const lines = [['05/01/26', 'COBRO', '1', 'DEP', '+', '50', ''], ['06/01/26', 'PAGO', '2', 'TRANSF', '-', '20', 'PROV']];
  const [block] = parseReconciliations(sheets(lines, '$130.00'));
  assert.equal(block.accountNumber, '2100343419');
  assert.equal(block.cutDate, '2026-01-31');
  assert.deepEqual(block.lines.map((line) => line.amount), [50, -20]);
  assert.equal(block.bookBalance, 1000);
  assert.throws(() => parseReconciliations(sheets(lines, '$999.00')), /inicial \+ movimientos/);
});

test('empata por glosa cuando hay varias líneas del mismo día e importe', () => {
  const blocks = [{ accountNumber: '2100343419', cutDate: '2026-01-31', bankName: bank, lines: [
    { date: '2026-01-10', amount: -120, description: 'Doc. 002,   P/R HONORARIOS_x000d_\nENERO' },
    { date: '2026-01-10', amount: -120, description: 'Doc. 001, P/R SERVICIOS' },
  ] }];
  const ledger = [ledgerLine('a', '2026-01-10', -120, 'Doc. 001, P/R SERVICIOS'),
    ledgerLine('b', '2026-01-10', -120, 'Doc. 002, P/R HONORARIOS\r\nENERO')];
  const { unmatched } = matchLines(blocks, ledger);
  assert.equal(unmatched.length, 0);
  assert.deepEqual(blocks[0].items.map((item) => item.lines[0].journalEntry), ['Jb', 'Ja']);
});

test('un PAGO MASIVO agrupa los asientos del día y dos transferencias se reparten por importe', () => {
  const blocks = [{ accountNumber: '2100343419', cutDate: '2026-02-28', bankName: bank, lines: [
    { date: '2026-02-28', amount: -30, description: 'PAGO MASIVO' },
    { date: '2026-02-28', amount: -45, description: 'PAGO MASIVO' },
    { date: '2026-02-28', amount: -400, description: 'Cancelación de haberes del mes de Febrero CARLA' },
  ] }];
  const ledger = [
    ledgerLine('m1', '2026-02-28', -10, 'PAGO MASIVO'), ledgerLine('m2', '2026-02-28', -20, 'PAGO MASIVO'),
    ledgerLine('m3', '2026-02-28', -40, 'PAGO MASIVO'), ledgerLine('m4', '2026-02-28', -5, 'PAGO MASIVO'),
    ledgerLine('h1', '2026-02-28', -200, 'Cancelación de haberes correspondientes, CARLA'),
    ledgerLine('h2', '2026-02-28', -200, 'Cancelación de haberes correspondientes, JAIME'),
    // Otro pago del mismo día que Contífico no concilió: no debe entrar en el grupo.
    ledgerLine('p1', '2026-02-28', -99, 'PAGO PROVEEDORES'),
  ];
  const { unmatched } = matchLines(blocks, ledger);
  assert.equal(unmatched.length, 0);
  const [first, second, payroll] = blocks[0].items;
  const sum = (item) => item.lines.reduce((total, line) => total + ledger.find((row) => row.journalEntry === line.journalEntry).amount, 0);
  assert.equal(sum(first), -30);
  assert.equal(sum(second), -45);
  assert.equal(first.lines.length + second.lines.length, 4);
  assert.equal(payroll.lines.length, 2);
  assert.match(first.note, /reparto se calculó por importe/);
});

test('sin una suma exacta el movimiento queda sin asiento', () => {
  const blocks = [{ accountNumber: '2100343419', cutDate: '2026-02-28', bankName: bank, lines: [
    { date: '2026-02-28', amount: -31, description: 'PAGO MASIVO' }] }];
  const { unmatched } = matchLines(blocks, [ledgerLine('m1', '2026-02-28', -30, 'PAGO MASIVO')]);
  assert.equal(unmatched.length, 1);
  assert.equal(blocks[0].items[0].matched, false);
});

test('los pendientes al corte deben explicar saldo contable − bancario; los posfechados no cuentan', () => {
  const lines = [['05/01/26', 'COBRO', '1', 'DEP', '+', '50', '']];
  const pendingRow = (date, sign, amount) => ['', '', date, 'PARTIDA', 'R', sign, amount, ''];
  const base = sheets(lines, '$150.00');
  base.balances[4] = ['', '', '$150.00', '$1,000.00', '-$850.00'];
  const pending = {
    DEPOSITO_TRANSITO: [['Depósitos'], [], [], [], ['31/01/26', bank, '30/01/26', 'DEP VT', 'R', '+', '900', '']],
    CHEQUE_PENDIENTE: [['Cheques'], [], [], [], ['31/01/26', bank, '20/01/26', 'CHEQUE', '7', '-', '50', 'PROV']],
    CHEQUE_POSTFECHADO: [['Postfechados'], [], [], [], ['31/01/26', bank, ...pendingRow('15/02/26', '-', '999').slice(2)]],
  };
  const [block] = parseReconciliations({ ...base, pending });
  assert.equal(block.pending.length, 3);
  assert.deepEqual(block.pending.map((item) => item.amount), [900, -50, -999]);
  pending.CHEQUE_PENDIENTE[4][6] = '60';
  assert.throws(() => parseReconciliations({ ...base, pending }), /bancario \+ pendientes ≠ contable/);
});
