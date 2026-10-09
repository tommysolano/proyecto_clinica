/**
 * SEGUNDA TANDA DE CAMBIOS DE CONTABILIDAD (personas, bancos, depósitos y cheques).
 *
 * Cubre con los CONTROLLERS reales:
 *   1. Ventas: se encuentra a la persona registrada como CLIENTE y no se factura sin identificación.
 *   2. Movimientos bancarios: búsqueda por persona / comprobante / cheque / centro de costo + Excel.
 *   3. Pagos y cobros: filtro por fecha y persona, estado conciliado y Excel.
 *   4. Conciliación: el cobro por transferencia del mostrador ENTRA al libro del banco (antes solo
 *      se veían los pagos) y una conciliación pendiente se puede eliminar.
 *   5. Depósitos: documento con papeleta y detalle; el efectivo no se deposita dos veces y la
 *      venta conserva su forma de pago (antes se le cambiaba a 'transferencia').
 *   6. Cheques: no se paga con un número que no existe en la chequera ni con uno ya usado, y el
 *      cheque girado deja de estar disponible mostrando beneficiario, monto y fecha.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('stream');
const ExcelJS = require('exceljs');
const H = require('./_integrationHelpers');

const banks = require('../controllers/bankController');
const payments = require('../controllers/paymentController');
const sales = require('../controllers/saleController');
const suppliers = require('../controllers/supplierController');
const deposits = require('../controllers/cashDepositController');
const invoices = require('../controllers/invoiceController');
const cashClosing = require('../controllers/cashClosingController');
const accountingHealth = require('../controllers/accountingHealthController');
const BankAccount = require('../models/BankAccount');
const BankTransaction = require('../models/BankTransaction');
const BankCheck = require('../models/BankCheck');
const Reconciliation = require('../models/Reconciliation');
const CostCenter = require('../models/CostCenter');
const Sale = require('../models/Sale');
const Invoice = require('../models/Invoice');
const InvoicingConfig = require('../models/InvoicingConfig');
const Supplier = require('../models/Supplier');
const { getAccount } = require('../utils/accountMap');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const run = (h, req) => H.runController(h, req);
const ok = (r) => { if (r.statusCode >= 400) throw new Error(`${r.statusCode}: ${JSON.stringify(r.payload)}`); return r.payload; };
const hoy = () => new Date().toISOString().slice(0, 10);

async function makeBank(clinicId, name = 'Banco Pichincha') {
  const acc = await getAccount(clinicId, 'bancos');
  return BankAccount.create({
    clinic: clinicId, name, bank: name,
    accountNumber: String(Math.random()).slice(2, 10), chartAccount: acc._id,
  });
}
const linea = (p, qty = 1) => ({ product: String(p._id), quantity: qty, unitPrice: p.salePrice });
async function servicio(clinicId) {
  return H.makeProduct(clinicId, { name: 'Consulta', category: 'servicio', salePrice: 100, taxCategory: 'IVA_0', taxRate: 0 });
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
/** Lee una hoja con cabecera de contexto: la fila de encabezados es la primera con `col`. */
function lector(ws, col) {
  let cabRow = 1;
  ws.eachRow((row, i) => { if (cabRow === 1 && row.values.includes(col)) cabRow = i; });
  const cab = ws.getRow(cabRow).values;
  const filas = [];
  ws.eachRow((row, i) => { if (i > cabRow) filas.push(row); });
  return { valor: (fila, header) => filas[fila].getCell(cab.indexOf(header)).value, filas, cab };
}

// ── 1. Personas registradas como CLIENTE e identificación obligatoria ─────────
test('el buscador de clientes encuentra a la persona registrada como CLIENTE (por nombre y por RUC)', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await Supplier.create({
    clinic: clinicId, ruc: '0912345678001', razonSocial: 'Comercial Andrade S.A.', roles: ['CLIENTE'],
  });
  await Supplier.create({
    clinic: clinicId, ruc: '0999999999001', razonSocial: 'Insumos Médicos', roles: ['PROVEEDOR'],
  });

  const porNombre = ok(await run(suppliers.searchClients, H.mockReq(clinicId, userId, {}, { query: { q: 'Andrade' } })));
  assert.equal(porNombre.length, 1);
  assert.equal(porNombre[0].razonSocial, 'Comercial Andrade S.A.');

  const porRuc = ok(await run(suppliers.searchClients, H.mockReq(clinicId, userId, {}, { query: { q: '0912345678' } })));
  assert.equal(porRuc.length, 1, 'también se encuentra escribiendo la cédula/RUC');

  const soloClientes = ok(await run(suppliers.searchClients, H.mockReq(clinicId, userId, {}, { query: {} })));
  assert.equal(soloClientes.length, 1, 'un proveedor no es un cliente al que facturar');
});

test('el buscador no se rompe con un nombre que trae paréntesis o signos', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await Supplier.create({ clinic: clinicId, ruc: '0911111111001', razonSocial: 'Clínica (Norte) S.A.', roles: ['CLIENTE'] });
  const r = ok(await run(suppliers.searchClients, H.mockReq(clinicId, userId, {}, { query: { q: '(Norte)' } })));
  assert.equal(r.length, 1, 'busca el texto tal cual, no como expresión regular');
});

test('no se puede facturar con la identificación en blanco', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const prod = await servicio(clinicId);

  const vacia = await run(sales.createSale, H.mockReq(clinicId, userId, {
    clientName: 'Sin cedula', clientCedula: '   ', items: [linea(prod)], paymentMethod: 'efectivo',
  }));
  assert.equal(vacia.statusCode, 400);
  assert.match(vacia.payload.message, /cédula, RUC o pasaporte/i);

  const corta = await run(sales.createSale, H.mockReq(clinicId, userId, {
    clientName: 'Basura', clientCedula: '12', items: [linea(prod)], paymentMethod: 'efectivo',
  }));
  assert.equal(corta.statusCode, 400);

  // Consumidor Final SÍ es una identificación válida.
  const cf = ok(await run(sales.createSale, H.mockReq(clinicId, userId, {
    clientName: 'Consumidor Final', clientCedula: '9999999999999', items: [linea(prod)], paymentMethod: 'efectivo',
  })));
  assert.equal(cf.clientCedula, '9999999999999');
});

// ── 2. Movimientos: búsqueda ampliada y Excel ────────────────────────────────
test('los movimientos se buscan por persona, comprobante, cheque y centro de costo', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const bank = await makeBank(clinicId);
  const centro = await CostCenter.create({ clinic: clinicId, code: 'CC1', name: 'Sucursal Norte' });

  ok(await run(banks.createMovement, H.mockReq(clinicId, userId, {
    bankAccount: String(bank._id), type: 'DEPOSITO', amount: 100,
    description: 'Deposito del dia', voucherNumber: 'PAP-778', partyName: 'Juan Pérez',
    costCenter: String(centro._id),
  })));
  ok(await run(banks.createMovement, H.mockReq(clinicId, userId, {
    bankAccount: String(bank._id), type: 'COMISION', amount: 5, description: 'Comision bancaria',
  })));

  const porPersona = ok(await run(banks.listMovements, H.mockReq(clinicId, userId, {}, { query: { q: 'Juan' } })));
  assert.equal(porPersona.items.length, 1);
  assert.equal(porPersona.items[0].partyName, 'Juan Pérez');

  const porComprobante = ok(await run(banks.listMovements, H.mockReq(clinicId, userId, {}, { query: { q: 'PAP-778' } })));
  assert.equal(porComprobante.items.length, 1);

  const porCentro = ok(await run(banks.listMovements, H.mockReq(clinicId, userId, {}, { query: { costCenter: String(centro._id) } })));
  assert.equal(porCentro.items.length, 1, 'el centro de costo filtra');

  const porBanco = ok(await run(banks.listMovements, H.mockReq(clinicId, userId, {}, { query: { bankAccount: String(bank._id) } })));
  assert.equal(porBanco.items.length, 2);
});

test('un movimiento de un pago se encuentra buscando por el nombre del proveedor', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const bank = await makeBank(clinicId);
  ok(await run(payments.create, H.mockReq(clinicId, userId, {
    type: 'PAGO', date: new Date(), partyModel: 'Supplier', partyName: 'Distribuidora Sur',
    method: 'TRANSFERENCIA', bankAccount: String(bank._id), voucherNumber: 'TR-55',
    advanceAmount: 200,
  })));
  const r = ok(await run(banks.listMovements, H.mockReq(clinicId, userId, {}, { query: { q: 'Distribuidora' } })));
  assert.equal(r.items.length, 1, 'la persona del pago viaja al libro de bancos');
  assert.equal(r.items[0].partyName, 'Distribuidora Sur');
});

test('el Excel de movimientos trae persona, comprobante, cheque y centro de costo', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const bank = await makeBank(clinicId);
  ok(await run(banks.createMovement, H.mockReq(clinicId, userId, {
    bankAccount: String(bank._id), type: 'DEPOSITO', amount: 320.5,
    description: 'Deposito', voucherNumber: 'PAP-1', partyName: 'María López',
  })));

  const wb = await excelDe(banks.movementsExcel, H.mockReq(clinicId, userId, {}, { query: {} }));
  const ws = wb.getWorksheet('Movimientos bancarios');
  const { valor, cab } = lector(ws, 'Fecha');
  for (const h of ['Persona', 'N° comprobante', 'N° cheque', 'Centro de costo', 'Entrada', 'Salida', 'Estado']) {
    assert.ok(cab.indexOf(h) > 0, `falta la columna ${h}`);
  }
  assert.equal(valor(0, 'Persona'), 'María López');
  assert.equal(valor(0, 'Entrada'), 320.5);
  assert.equal(valor(0, 'Estado'), 'REGISTRADO');
});

// ── 3. Pagos y cobros: filtros, estado y Excel ───────────────────────────────
test('los pagos se filtran por rango de fechas y por persona', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const bank = await makeBank(clinicId);
  const pago = (nombre, dias) => payments.create && run(payments.create, H.mockReq(clinicId, userId, {
    type: 'PAGO', date: H.docDate(dias), partyModel: 'Supplier', partyName: nombre,
    method: 'TRANSFERENCIA', bankAccount: String(bank._id), voucherNumber: `TR-${nombre}`,
    advanceAmount: 50,
  }));
  ok(await pago('Juan Pérez', 0));
  ok(await pago('Otro Proveedor', 0));
  ok(await pago('Juan Pérez', -40));

  const porPersona = ok(await run(payments.list, H.mockReq(clinicId, userId, {}, { query: { type: 'PAGO', q: 'Juan' } })));
  assert.equal(porPersona.items.length, 2);

  const desde = new Date(); desde.setDate(desde.getDate() - 5);
  const enRango = ok(await run(payments.list, H.mockReq(clinicId, userId, {}, {
    query: { type: 'PAGO', q: 'Juan', startDate: desde.toISOString().slice(0, 10), endDate: hoy() },
  })));
  assert.equal(enRango.items.length, 1, 'fecha + persona a la vez, como pidió el contador');
});

test('el estado del cobro distingue registrado, conciliado y anulado', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const bank = await makeBank(clinicId);
  const cobro = ok(await run(payments.create, H.mockReq(clinicId, userId, {
    type: 'COBRO', date: new Date(), partyModel: 'Patient', partyName: 'Paciente X',
    method: 'TRANSFERENCIA', bankAccount: String(bank._id), reference: 'TR-9', advanceAmount: 120,
  })));

  let lista = ok(await run(payments.list, H.mockReq(clinicId, userId, {}, { query: { type: 'COBRO' } })));
  assert.equal(lista.items[0].bankTransaction?.reconciled, false, 'nace sin conciliar');

  await BankTransaction.updateOne({ _id: cobro.bankTransaction }, { reconciled: true });
  lista = ok(await run(payments.list, H.mockReq(clinicId, userId, {}, { query: { type: 'COBRO' } })));
  assert.equal(lista.items[0].bankTransaction?.reconciled, true, 'la pantalla puede decir «conciliado»');
});

test('el Excel de cobros trae la persona y una columna de valor', async () => {
  const { clinicId, userId } = await H.seedClinic();
  ok(await run(payments.create, H.mockReq(clinicId, userId, {
    type: 'COBRO', date: new Date(), partyModel: 'Patient', partyName: 'Ana Torres', partyId: '0912345678',
    method: 'EFECTIVO', advanceAmount: 75.25,
  })));
  const wb = await excelDe(payments.paymentsExcel, H.mockReq(clinicId, userId, {}, { query: { type: 'COBRO' } }));
  const { valor, cab } = lector(wb.getWorksheet('Cobros'), 'Número');
  assert.ok(cab.indexOf('Cliente') > 0);
  assert.ok(cab.indexOf('Valor') > 0);
  assert.equal(valor(0, 'Cliente'), 'Ana Torres');
  assert.equal(valor(0, 'Valor'), 75.25);
});

// ── 4. Conciliación: los INGRESOS también entran al libro ────────────────────
test('una venta cobrada por transferencia deja movimiento en el banco y se puede conciliar', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const bank = await makeBank(clinicId);
  const prod = await servicio(clinicId);

  const venta = ok(await run(sales.createSale, H.mockReq(clinicId, userId, {
    clientName: 'Cliente', clientCedula: '0912345678', items: [linea(prod)],
    paymentMethod: 'transferencia', bankAccount: String(bank._id),
  })));

  const movs = await BankTransaction.find({ clinic: clinicId, sourceModel: 'Sale', sourceRef: venta._id });
  assert.equal(movs.length, 1, 'el ingreso de la venta entra al libro del banco');
  assert.equal(movs[0].direction, 1, 'es una ENTRADA (antes la conciliación solo veía pagos)');
  assert.equal(movs[0].amount, 100);

  // El saldo del banco sube con la venta.
  assert.equal((await BankAccount.findById(bank._id)).bookBalance, 100);

  // Y aparece en la conciliación al corte de hoy.
  const rec = ok(await run(banks.startReconciliation, H.mockReq(clinicId, userId, {
    bankAccount: String(bank._id), cutDate: H.docDate(1), statementBalance: 100,
  })));
  assert.equal(rec.items.length, 1);
  assert.equal(rec.bookBalance, 100);
  assert.equal(rec.difference, 0, 'los saldos brutos son iguales');
  assert.equal(rec.adjustedDifference, 100, 'el cobro sigue en tránsito hasta marcarlo en el extracto');
});

test('la conciliación arrastra cheques en tránsito y permite marcarlos cuando el banco los cobra', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const bank = await makeBank(clinicId);
  await BankAccount.updateOne({ _id: bank._id }, { initialBalance: 1000, bookBalance: 1000 });
  const check = await BankTransaction.create({ clinic: clinicId, bankAccount: bank._id,
    date: new Date('2026-01-10T12:00:00Z'), type: 'CHEQUE_EMITIDO', amount: 300, direction: -1 });
  const start = (cutDate, statementBalance) => run(banks.startReconciliation,
    H.mockReq(clinicId, userId, { bankAccount: bank._id, cutDate, statementBalance }));
  const close = (id) => run(banks.closeReconciliation,
    H.mockReq(clinicId, userId, {}, { params: { id: String(id) } }));
  const update = (id, items) => run(banks.updateReconciliation,
    H.mockReq(clinicId, userId, { items }, { params: { id: String(id) } }));

  const jan = ok(await start('2026-01-31T23:59:59Z', 1000));
  assert.equal(jan.bookBalance, 700);
  assert.equal(jan.outstandingBalance, -300);
  assert.equal(jan.adjustedBalance, 1000);
  assert.equal(jan.adjustedDifference, 0);
  ok(await close(jan._id));
  assert.equal((await BankTransaction.findById(check._id)).reconciled, false);

  const deposit = await BankTransaction.create({ clinic: clinicId, bankAccount: bank._id,
    date: new Date('2026-02-10T12:00:00Z'), type: 'DEPOSITO', amount: 200, direction: 1 });
  const feb = ok(await start('2026-02-28T23:59:59Z', 1200));
  assert.equal(feb.items.length, 2);
  const febSaved = ok(await update(feb._id, feb.items.map((item) => ({
    transaction: item.transaction._id, matched: String(item.transaction._id) === String(deposit._id),
  }))));
  assert.equal(febSaved.bookBalance, 900);
  assert.equal(febSaved.outstandingBalance, -300);
  assert.equal(febSaved.adjustedBalance, 1200);
  assert.equal(febSaved.adjustedDifference, 0);
  ok(await close(feb._id));

  const mar = ok(await start('2026-03-31T23:59:59Z', 900));
  assert.equal(mar.items.length, 1);
  const marSaved = ok(await update(mar._id, [{ transaction: check._id, matched: true }]));
  assert.equal(marSaved.outstandingBalance, 0);
  assert.equal(marSaved.adjustedDifference, 0);
  ok(await close(mar._id));
  assert.equal((await BankTransaction.findById(check._id)).reconciled, true);
});

test('no se cierra una conciliación que difiere del extracto o tiene líneas sin aplicar', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const bank = await makeBank(clinicId);
  const tx = await BankTransaction.create({ clinic: clinicId, bankAccount: bank._id,
    date: new Date('2026-04-10T12:00:00Z'), type: 'DEPOSITO', amount: 100, direction: 1 });
  const rec = ok(await run(banks.startReconciliation, H.mockReq(clinicId, userId,
    { bankAccount: bank._id, cutDate: '2026-04-30T23:59:59Z', statementBalance: 80 })));
  const saved = ok(await run(banks.updateReconciliation, H.mockReq(clinicId, userId,
    { items: [{ transaction: tx._id, matched: true }] }, { params: { id: String(rec._id) } })));
  assert.equal(saved.adjustedDifference, -20);
  const attempt = await run(banks.closeReconciliation, H.mockReq(clinicId, userId, {},
    { params: { id: String(rec._id) } }));
  assert.equal(attempt.statusCode, 409);
  assert.equal((await Reconciliation.findById(rec._id)).status, 'BORRADOR');
  assert.equal((await BankTransaction.findById(tx._id)).reconciled, false);

  await Reconciliation.updateOne({ _id: rec._id }, { statementBalance: 100,
    statementLines: [{ amount: 10, matched: false }] });
  const pendingLine = await run(banks.closeReconciliation, H.mockReq(clinicId, userId, {},
    { params: { id: String(rec._id) } }));
  assert.equal(pendingLine.statusCode, 409);
  assert.equal((await Reconciliation.findById(rec._id)).status, 'BORRADOR');
});

test('salud contable distingue conciliaciones antiguas sin verificar y cierres descuadrados', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const bank = await makeBank(clinicId);
  await Reconciliation.create([
    { clinic: clinicId, bankAccount: bank._id, cutDate: new Date('2026-01-31T23:59:59Z'),
      status: 'CONCILIADO', source: 'LOCAL', statementBalance: 100, bookBalance: 90 },
    { clinic: clinicId, bankAccount: bank._id, cutDate: new Date('2026-02-28T23:59:59Z'),
      status: 'CONCILIADO', source: 'LOCAL', statementBalance: 100, bookBalance: 90,
      outstandingBalance: 0, adjustedBalance: 90, adjustedDifference: 10 },
  ]);
  const report = ok(await run(accountingHealth.check, H.mockReq(clinicId, userId)));
  assert.equal(report.summary.legacyReconciliations, 1);
  assert.equal(report.summary.unbalancedReconciliations, 1);
  assert.ok(report.findings.some((finding) => finding.code === 'RECONCILIATION_LEGACY_UNVERIFIED'));
  assert.ok(report.findings.some((finding) => finding.code === 'RECONCILIATION_UNBALANCED'));
});

test('anular la venta descuenta del banco lo que había entrado', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const bank = await makeBank(clinicId);
  const prod = await servicio(clinicId);
  const venta = ok(await run(sales.createSale, H.mockReq(clinicId, userId, {
    clientName: 'Cliente', clientCedula: '0912345678', items: [linea(prod)],
    paymentMethod: 'transferencia', bankAccount: String(bank._id),
  })));
  assert.equal((await BankAccount.findById(bank._id)).bookBalance, 100);

  ok(await run(sales.cancelSale, H.mockReq(clinicId, userId, {}, { params: { id: String(venta._id) } })));

  assert.equal((await BankAccount.findById(bank._id)).bookBalance, 0, 'el saldo vuelve a su sitio');
  const mov = await BankTransaction.findOne({ clinic: clinicId, sourceModel: 'Sale', sourceRef: venta._id });
  assert.equal(mov.voided, true);
  const led = await H.assertLedgerBalanced(clinicId);
  assert.ok(led.balanced, `mayor descuadrado ${led.debit} vs ${led.credit}`);
});

test('una conciliación pendiente se elimina; una cerrada no', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const bank = await makeBank(clinicId);
  const rec = ok(await run(banks.startReconciliation, H.mockReq(clinicId, userId, {
    bankAccount: String(bank._id), cutDate: hoy(), statementBalance: 0,
  })));

  ok(await run(banks.deleteReconciliation, H.mockReq(clinicId, userId, {}, { params: { id: String(rec._id) } })));
  assert.equal(await Reconciliation.countDocuments({ clinic: clinicId }), 0);

  const otra = ok(await run(banks.startReconciliation, H.mockReq(clinicId, userId, {
    bankAccount: String(bank._id), cutDate: hoy(), statementBalance: 0,
  })));
  await Reconciliation.updateOne({ _id: otra._id }, { status: 'CONCILIADO' });
  const r = await run(banks.deleteReconciliation, H.mockReq(clinicId, userId, {}, { params: { id: String(otra._id) } }));
  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /cerrada/i);
});

// ── 5. Depósitos ─────────────────────────────────────────────────────────────
test('el depósito lista el efectivo pendiente, lo lleva al banco y no lo ofrece dos veces', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const bank = await makeBank(clinicId);
  const prod = await servicio(clinicId);

  const venta = ok(await run(sales.createSale, H.mockReq(clinicId, userId, {
    clientName: 'Contado', clientCedula: '9999999999999', items: [linea(prod)], paymentMethod: 'efectivo',
  })));

  const pendiente = ok(await run(deposits.pending, H.mockReq(clinicId, userId, {}, { query: {} })));
  assert.equal(pendiente.items.length, 1);
  assert.equal(pendiente.total, 100);

  const dep = ok(await run(deposits.create, H.mockReq(clinicId, userId, {
    date: hoy(), bankAccount: String(bank._id), voucherNumber: 'PAP-4455',
    items: [{ docModel: 'Sale', docRef: String(venta._id) }],
  })));
  assert.match(dep.number, /^DEP-/);
  assert.equal(dep.total, 100);
  assert.equal(dep.items.length, 1);

  // El dinero llegó al banco y quedó en el libro con su papeleta.
  assert.equal((await BankAccount.findById(bank._id)).bookBalance, 100);
  const mov = await BankTransaction.findOne({ clinic: clinicId, sourceModel: 'CashDeposit' });
  assert.equal(mov.voucherNumber, 'PAP-4455');
  assert.equal(mov.type, 'DEPOSITO');

  // La venta CONSERVA su forma de pago (antes se le cambiaba a 'transferencia').
  const guardada = await Sale.findById(venta._id);
  assert.equal(guardada.paymentMethod, 'efectivo', 'depositar no falsea cómo se cobró la venta');
  assert.equal(String(guardada.cashDeposit), String(dep._id));

  const despues = ok(await run(deposits.pending, H.mockReq(clinicId, userId, {}, { query: {} })));
  assert.equal(despues.items.length, 0, 'ya no se puede depositar dos veces');

  const led = await H.assertLedgerBalanced(clinicId);
  assert.ok(led.balanced, `mayor descuadrado ${led.debit} vs ${led.credit}`);
});

test('anular una factura con efectivo depositado no deja factura y venta en estados distintos', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const bank = await makeBank(clinicId);
  const prod = await servicio(clinicId);
  const venta = ok(await run(sales.createSale, H.mockReq(clinicId, userId, {
    clientName: 'Contado', clientCedula: '9999999999999', items: [linea(prod)], paymentMethod: 'efectivo',
  })));
  await InvoicingConfig.create({ clinic: clinicId, ruc: '1790012345001', razonSocial: 'Clínica de prueba' });
  const factura = await Invoice.create({ clinic: clinicId, sale: venta._id,
    claveAcceso: '0'.repeat(49) + '1', secuencial: '000000001', estab: '001', ptoEmi: '001',
    ambiente: '1', fechaEmision: '09/10/2026', estado: 'AUTORIZADO', total: 100 });
  await Sale.updateOne({ _id: venta._id }, { invoice: factura._id });
  ok(await run(deposits.create, H.mockReq(clinicId, userId, {
    date: hoy(), bankAccount: String(bank._id), voucherNumber: 'PAP-FACTURA',
    items: [{ docModel: 'Sale', docRef: String(venta._id) }],
  })));

  const rejected = await run(invoices.anular, H.mockReq(clinicId, userId,
    { motivo: 'Error comprobado' }, { params: { id: String(factura._id) } }));
  assert.equal(rejected.statusCode, 409, JSON.stringify(rejected.payload));
  assert.equal((await Invoice.findById(factura._id)).estado, 'AUTORIZADO');
  assert.notEqual((await Sale.findById(venta._id)).status, 'anulada');
  assert.equal((await BankAccount.findById(bank._id)).bookBalance, 100);
});

test('un cobro directo de venta a crédito aparece en pendientes y se deposita una sola vez', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const bank = await makeBank(clinicId);
  const prod = await servicio(clinicId);
  const venta = ok(await run(sales.createSale, H.mockReq(clinicId, userId, {
    clientName: 'Crédito', clientCedula: '0912345678', items: [linea(prod)], paymentMethod: 'credito',
  })));
  ok(await run(sales.collectSale, H.mockReq(clinicId, userId,
    { amount: 40, paymentMethod: 'efectivo' }, { params: { id: String(venta._id) } })));
  const pending = ok(await run(deposits.pending, H.mockReq(clinicId, userId, {}, { query: {} })));
  const cobro = pending.items.find((i) => i.docModel === 'JournalEntry');
  assert.ok(cobro, 'el cobro directo debe figurar con su asiento origen');
  assert.equal(cobro.amount, 40);
  const duplicate = await run(deposits.create, H.mockReq(clinicId, userId, {
    date: hoy(), bankAccount: String(bank._id), voucherNumber: 'PAP-DUP',
    items: [{ docModel: 'JournalEntry', docRef: String(cobro.docRef) },
      { docModel: 'JournalEntry', docRef: String(cobro.docRef) }],
  }));
  assert.equal(duplicate.statusCode, 400);
  const dep = ok(await run(deposits.create, H.mockReq(clinicId, userId, {
    date: hoy(), bankAccount: String(bank._id), voucherNumber: 'PAP-COBRO',
    items: [{ docModel: 'JournalEntry', docRef: String(cobro.docRef) }],
  })));
  assert.equal(dep.total, 40);
  const after = ok(await run(deposits.pending, H.mockReq(clinicId, userId, {}, { query: {} })));
  assert.equal(after.items.length, 0);
  assert.equal((await BankAccount.findById(bank._id)).bookBalance, 40);
  const blockedSale = await run(sales.cancelSale, H.mockReq(clinicId, userId, {}, { params: { id: String(venta._id) } }));
  assert.equal(blockedSale.statusCode, 409, 'la venta no se anula mientras su cobro está depositado');
  ok(await run(deposits.void, H.mockReq(clinicId, userId, { reason: 'Corrección' }, { params: { id: String(dep._id) } })));
  const restored = ok(await run(deposits.pending, H.mockReq(clinicId, userId, {}, { query: {} })));
  assert.equal(restored.items.filter((i) => i.docModel === 'JournalEntry').length, 1);
  assert.equal((await BankAccount.findById(bank._id)).bookBalance, 0);
});

test('saldo libre de caja se deposita con motivo y no permite repetir el mismo efectivo', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const bank = await makeBank(clinicId);
  ok(await run(cashClosing.open, H.mockReq(clinicId, userId, { openingBalance: 0 })));
  ok(await run(cashClosing.addMovement, H.mockReq(clinicId, userId,
    { type: 'INGRESO', amount: 75, description: 'Cambio de fondo' })));
  const before = ok(await run(deposits.pending, H.mockReq(clinicId, userId, {}, { query: {} })));
  assert.equal(before.manualAvailable, 75);
  const dep = ok(await run(deposits.create, H.mockReq(clinicId, userId, {
    date: hoy(), bankAccount: String(bank._id), voucherNumber: 'PAP-LIBRE',
    items: [], manualAmount: 75, manualReason: 'Cambio de fondo',
  })));
  assert.equal(dep.total, 75);
  const again = await run(deposits.create, H.mockReq(clinicId, userId, {
    date: hoy(), bankAccount: String(bank._id), voucherNumber: 'PAP-DOBLE',
    items: [], manualAmount: 75, manualReason: 'Cambio de fondo',
  }));
  assert.equal(again.statusCode, 409);
  assert.equal((await BankAccount.findById(bank._id)).bookBalance, 75);
});

test('de una venta mixta solo se deposita la parte en efectivo', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const bank = await makeBank(clinicId);
  const prod = await servicio(clinicId);
  ok(await run(sales.createSale, H.mockReq(clinicId, userId, {
    clientName: 'Mixto', clientCedula: '0912345678', items: [linea(prod)],
    payments: [
      { method: 'efectivo', amount: 60 },
      { method: 'transferencia', amount: 40, bankAccount: String(bank._id) },
    ],
  })));
  const pendiente = ok(await run(deposits.pending, H.mockReq(clinicId, userId, {}, { query: {} })));
  assert.equal(pendiente.items.length, 1);
  assert.equal(pendiente.items[0].amount, 60, 'solo el efectivo');
  assert.equal(pendiente.items[0].total, 100);
});

test('anular un depósito devuelve el efectivo a pendiente y el saldo del banco', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const bank = await makeBank(clinicId);
  const prod = await servicio(clinicId);
  const venta = ok(await run(sales.createSale, H.mockReq(clinicId, userId, {
    clientName: 'Contado', clientCedula: '9999999999999', items: [linea(prod)], paymentMethod: 'efectivo',
  })));
  const dep = ok(await run(deposits.create, H.mockReq(clinicId, userId, {
    date: hoy(), bankAccount: String(bank._id), voucherNumber: 'PAP-1',
    items: [{ docModel: 'Sale', docRef: String(venta._id) }],
  })));

  ok(await run(deposits.void, H.mockReq(clinicId, userId, { reason: 'papeleta equivocada' }, { params: { id: String(dep._id) } })));

  assert.equal((await BankAccount.findById(bank._id)).bookBalance, 0);
  assert.equal((await Sale.findById(venta._id)).cashDeposit, null);
  const otra = ok(await run(deposits.pending, H.mockReq(clinicId, userId, {}, { query: {} })));
  assert.equal(otra.items.length, 1, 'vuelve a estar pendiente de depositar');
  const led = await H.assertLedgerBalanced(clinicId);
  assert.ok(led.balanced, `mayor descuadrado ${led.debit} vs ${led.credit}`);
});

test('el depósito exige el número de papeleta', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const bank = await makeBank(clinicId);
  const prod = await servicio(clinicId);
  const venta = ok(await run(sales.createSale, H.mockReq(clinicId, userId, {
    clientName: 'Contado', clientCedula: '9999999999999', items: [linea(prod)], paymentMethod: 'efectivo',
  })));
  const r = await run(deposits.create, H.mockReq(clinicId, userId, {
    date: hoy(), bankAccount: String(bank._id), voucherNumber: '  ',
    items: [{ docModel: 'Sale', docRef: String(venta._id) }],
  }));
  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /papeleta/i);
});

// ── 6. Cheques ───────────────────────────────────────────────────────────────
test('no se puede pagar con un cheque que no está en la chequera', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const bank = await makeBank(clinicId);
  ok(await run(banks.generateChecks, H.mockReq(clinicId, userId, { bankAccount: String(bank._id), from: 1, to: 50 })));

  const r = await run(payments.create, H.mockReq(clinicId, userId, {
    type: 'PAGO', date: new Date(), partyModel: 'Supplier', partyName: 'Proveedor',
    method: 'CHEQUE', bankAccount: String(bank._id), checkNumber: '60', voucherNumber: 'CH-60',
    advanceAmount: 100,
  }));
  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /no existe en la chequera/i);
  assert.match(r.payload.message, /del 1 al 50/, 'dice el rango registrado');
});

test('el cheque usado deja de estar disponible y muestra beneficiario, monto y fecha', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const bank = await makeBank(clinicId);
  ok(await run(banks.generateChecks, H.mockReq(clinicId, userId, { bankAccount: String(bank._id), from: 1, to: 10 })));

  const pago = ok(await run(payments.create, H.mockReq(clinicId, userId, {
    type: 'PAGO', date: new Date(), partyModel: 'Supplier', partyName: 'Distribuidora Sur',
    method: 'CHEQUE', bankAccount: String(bank._id), checkNumber: '5', voucherNumber: 'CH-5',
    advanceAmount: 250,
  })));

  const chk = await BankCheck.findOne({ clinic: clinicId, bankAccount: bank._id, number: 5 });
  assert.equal(chk.status, 'GIRADO', 'ya no figura disponible');
  assert.equal(chk.beneficiary, 'Distribuidora Sur');
  assert.equal(chk.amount, 250);
  assert.ok(chk.date, 'queda la fecha en que se usó');
  assert.equal(String(chk.payment), String(pago._id), 'y en qué pago se usó');

  // El listado lo trae poblado para poder ver el documento desde Cheques.
  const lista = ok(await run(banks.listChecks, H.mockReq(clinicId, userId, {}, {
    query: { bankAccount: String(bank._id), status: 'GIRADO' },
  })));
  assert.equal(lista.length, 1);
  assert.equal(lista[0].payment.number, pago.number);
});

test('un cheque ya usado no se puede volver a usar', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const bank = await makeBank(clinicId);
  ok(await run(banks.generateChecks, H.mockReq(clinicId, userId, { bankAccount: String(bank._id), from: 1, to: 10 })));
  const pagar = () => run(payments.create, H.mockReq(clinicId, userId, {
    type: 'PAGO', date: new Date(), partyModel: 'Supplier', partyName: 'Proveedor',
    method: 'CHEQUE', bankAccount: String(bank._id), checkNumber: '3', voucherNumber: 'CH-3',
    advanceAmount: 90,
  }));
  ok(await pagar());
  const segundo = await pagar();
  assert.equal(segundo.statusCode, 400);
  assert.match(segundo.payload.message, /ya fue usado/i);
});

test('anular el pago devuelve el cheque a la chequera', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const bank = await makeBank(clinicId);
  ok(await run(banks.generateChecks, H.mockReq(clinicId, userId, { bankAccount: String(bank._id), from: 1, to: 10 })));
  const pago = ok(await run(payments.create, H.mockReq(clinicId, userId, {
    type: 'PAGO', date: new Date(), partyModel: 'Supplier', partyName: 'Proveedor',
    method: 'CHEQUE', bankAccount: String(bank._id), checkNumber: '7', voucherNumber: 'CH-7',
    advanceAmount: 40,
  })));
  ok(await run(payments.void, H.mockReq(clinicId, userId, {}, { params: { id: String(pago._id) } })));

  const chk = await BankCheck.findOne({ clinic: clinicId, bankAccount: bank._id, number: 7 });
  assert.equal(chk.status, 'DISPONIBLE', 'el papel no se usó: vuelve a estar libre');
  assert.equal(chk.amount, 0);
});

test('sin número de cheque se toma el primero disponible de la chequera', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const bank = await makeBank(clinicId);
  ok(await run(banks.generateChecks, H.mockReq(clinicId, userId, { bankAccount: String(bank._id), from: 100, to: 105 })));
  const pago = ok(await run(payments.create, H.mockReq(clinicId, userId, {
    type: 'PAGO', date: new Date(), partyModel: 'Supplier', partyName: 'Proveedor',
    method: 'CHEQUE', bankAccount: String(bank._id), voucherNumber: 'CH-AUTO', advanceAmount: 30,
  })));
  assert.equal(pago.checkNumber, '100');
  assert.equal((await BankCheck.findOne({ clinic: clinicId, bankAccount: bank._id, number: 100 })).status, 'GIRADO');
});

test('sin chequera registrada el pago con cheque se rechaza con instrucciones', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const bank = await makeBank(clinicId);
  const r = await run(payments.create, H.mockReq(clinicId, userId, {
    type: 'PAGO', date: new Date(), partyModel: 'Supplier', partyName: 'Proveedor',
    method: 'CHEQUE', bankAccount: String(bank._id), checkNumber: '1', voucherNumber: 'CH-1',
    advanceAmount: 10,
  }));
  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /chequera/i);
});
