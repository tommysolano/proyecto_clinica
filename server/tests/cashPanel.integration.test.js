/**
 * «CAJA E INGRESOS» (oct-2026): el cuadre de caja del período, el vale de caja y el
 * historial de salidas, con los CONTROLLERS reales.
 *
 * Lo que fijan:
 *   1. El cuadre separa lo que pasó por el cajón (GAVETA) de lo cobrado por otros medios
 *      (NETEO, en los dos bloques) y su saldo coincide con el movimiento del mayor.
 *   2. El vale saca efectivo de caja contra la cuenta elegida, aparece en las salidas y se
 *      anula desde ahí: vale y reverso se cancelan y el cuadre vuelve a su sitio.
 *   3. Un vale no puede ir a la cuenta de un banco (eso es un depósito) ni a fecha futura.
 *   4. Una venta anulada dentro del período no cuenta y el cuadre sigue cuadrando.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const sales = require('../controllers/saleController');
const deposits = require('../controllers/cashDepositController');
const panel = require('../controllers/cashPanelController');
const BankAccount = require('../models/BankAccount');
const CashMovement = require('../models/CashMovement');
const { getAccount } = require('../utils/accountMap');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const run = (h, req) => H.runController(h, req);
const ok = (r) => { if (r.statusCode >= 400) throw new Error(`${r.statusCode}: ${JSON.stringify(r.payload)}`); return r.payload; };
const hoy = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const periodo = () => ({ from: hoy(), to: hoy() });
const linea = (bloque, clave) => bloque.find((f) => f.clave === clave);

async function preparar() {
  const { clinicId, userId } = await H.seedClinic();
  const bancos = await getAccount(clinicId, 'bancos');
  const bank = await BankAccount.create({
    clinic: clinicId, name: 'Banco Pichincha', bank: 'Banco Pichincha', accountNumber: '2200112233', chartAccount: bancos._id,
  });
  const prod = await H.makeProduct(clinicId, { name: 'Consulta', category: 'servicio', salePrice: 100, taxCategory: 'IVA_0', taxRate: 0 });
  const venta = (extra) => run(sales.createSale, H.mockReq(clinicId, userId, {
    clientName: 'Cliente', clientCedula: '0912345678',
    items: [{ product: String(prod._id), quantity: 1, unitPrice: 100 }],
    ...extra,
  }));
  const gasto = await getAccount(clinicId, 'otrosGastos');
  return { clinicId, userId, bank, venta, gasto };
}

test('el cuadre separa el efectivo de lo cobrado por otros medios y cuadra contra el mayor', async () => {
  const { clinicId, userId, bank, venta, gasto } = await preparar();
  const efectivo = ok(await venta({ paymentMethod: 'efectivo' }));
  ok(await venta({ paymentMethod: 'transferencia', bankAccount: String(bank._id) }));

  // Se deposita la venta en efectivo y se registra un vale de 20.
  ok(await run(deposits.create, H.mockReq(clinicId, userId, {
    bankAccount: String(bank._id), voucherNumber: 'PAP-1', date: hoy(),
    items: [{ docModel: 'Sale', docRef: String(efectivo._id) }],
  })));
  const vale = ok(await run(panel.crearVale, H.mockReq(clinicId, userId, {
    date: hoy(), amount: 20, account: String(gasto._id), description: 'Taxi a laboratorio',
  })));
  assert.equal(vale.movement.type, 'VALE');

  const p = ok(await run(panel.panel, H.mockReq(clinicId, userId, {}, { query: periodo() })));
  assert.equal(linea(p.ingresos, 'ventas_efectivo').monto, 100);
  assert.equal(linea(p.ingresos, 'ventas_efectivo').grupo, 'GAVETA');
  assert.equal(linea(p.ingresos, 'ventas_transferencia').monto, 100);
  assert.equal(linea(p.ingresos, 'ventas_transferencia').grupo, 'NETEO');
  assert.equal(linea(p.egresos, 'ventas_transferencia').monto, 100, 'la transferencia sale por el otro bloque');
  assert.equal(linea(p.egresos, 'depositos').monto, 100);
  assert.equal(linea(p.egresos, 'vales').monto, 20);
  assert.equal(linea(p.egresos, 'vales').detalle.items[0].detalle, 'Vale de caja: Taxi a laboratorio');
  assert.equal(p.totalIngresos, 200);
  assert.equal(p.totalEgresos, 220);
  assert.equal(p.saldoCaja, -20);
  assert.equal(p.movimientoMayor, -20, 'el mayor dice lo mismo: entró 100, salieron 100 al banco y 20 en el vale');
  assert.equal(p.diferencia, 0);
  assert.equal(p.saldoMayor, -20);
});

test('el vale aparece en las salidas y se anula desde ahí', async () => {
  const { clinicId, userId, gasto, venta } = await preparar();
  ok(await venta({ paymentMethod: 'efectivo' }));
  ok(await run(panel.crearVale, H.mockReq(clinicId, userId, {
    date: hoy(), amount: 35, account: String(gasto._id), description: 'Insumos de limpieza',
  })));

  const s = ok(await run(panel.salidas, H.mockReq(clinicId, userId, {}, { query: periodo() })));
  assert.equal(s.items.length, 1);
  const fila = s.items[0];
  assert.equal(fila.amount, 35);
  assert.equal(fila.tipo, 'VALE');
  assert.equal(fila.canVoid, true);
  assert.equal(fila.accountCode, gasto.code);

  ok(await run(panel.anularSalida, H.mockReq(clinicId, userId, { reason: 'Se registró dos veces' }, {
    params: { entryId: fila.entryId },
  })));
  const mov = await CashMovement.findOne({ clinic: clinicId, type: 'VALE' });
  assert.equal(mov.voided, true);

  const despues = ok(await run(panel.salidas, H.mockReq(clinicId, userId, {}, { query: periodo() })));
  assert.equal(despues.items[0].reversed, true, 'queda en el historial, marcada como anulada');
  assert.equal(despues.items[0].canVoid, false);

  const p = ok(await run(panel.panel, H.mockReq(clinicId, userId, {}, { query: periodo() })));
  assert.equal(linea(p.egresos, 'vales').monto, 0, 'vale y reverso del mismo día se cancelan');
  assert.equal(p.saldoCaja, 100);
  assert.equal(p.diferencia, 0);

  // Anular dos veces no hace nada.
  const otra = await run(panel.anularSalida, H.mockReq(clinicId, userId, {}, { params: { entryId: fila.entryId } }));
  assert.equal(otra.statusCode, 400);
});

test('un vale no va a la cuenta de un banco, ni a fecha futura, ni sin valor', async () => {
  const { clinicId, userId, bank, gasto } = await preparar();
  const aBanco = await run(panel.crearVale, H.mockReq(clinicId, userId, {
    date: hoy(), amount: 10, account: String(bank.chartAccount),
  }));
  assert.equal(aBanco.statusCode, 400);
  assert.equal(aBanco.payload.code, 'VALE_A_BANCO');

  const futuro = await run(panel.crearVale, H.mockReq(clinicId, userId, {
    date: '2999-01-01', amount: 10, account: String(gasto._id),
  }));
  assert.equal(futuro.statusCode, 400);

  const cero = await run(panel.crearVale, H.mockReq(clinicId, userId, { date: hoy(), amount: 0, account: String(gasto._id) }));
  assert.equal(cero.statusCode, 400);

  // La lista de cuentas del vale tampoco ofrece la del banco.
  const cuentas = ok(await run(panel.cuentas, H.mockReq(clinicId, userId)));
  assert.ok(cuentas.some((c) => String(c._id) === String(gasto._id)));
  assert.ok(!cuentas.some((c) => String(c._id) === String(bank.chartAccount)));
});

test('una venta anulada en el mismo período no cuenta y el cuadre sigue cuadrando', async () => {
  const { clinicId, userId, venta } = await preparar();
  ok(await venta({ paymentMethod: 'efectivo' }));
  const anulada = ok(await venta({ paymentMethod: 'efectivo' }));
  ok(await run(sales.cancelSale, H.mockReq(clinicId, userId, {}, { params: { id: String(anulada._id) } })));

  const p = ok(await run(panel.panel, H.mockReq(clinicId, userId, {}, { query: periodo() })));
  assert.equal(linea(p.ingresos, 'ventas_efectivo').monto, 100);
  assert.equal(p.saldoCaja, 100);
  assert.equal(p.movimientoMayor, 100);
  assert.equal(p.diferencia, 0);
});
