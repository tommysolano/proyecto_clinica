/**
 * AUDITORÍA PRE-COMMIT DEL FLUJO DE CAJA (Fase 2).
 *
 * Cierra los ocho frentes de la auditoría:
 *   1. días de crédito del proveedor → vencimiento legal de la CxP (fuente única)
 *   2. obligaciones vencidas ANTES del rango: no desaparecen, se acumulan una sola vez
 *   3. transferencias internas entre cuentas de liquidez: efecto consolidado CERO
 *   4. liquidación de partidas manuales: contabiliza o vincula, nunca "cambia de estado"
 *   5. ciclo completo de la CxC de una factura (cobro, anulación, recobro)
 *   6. CxC duplicadas entre una venta y su factura
 *   7. `plannedCollectionDate`: un solo campo persistido
 *   8. concurrencia de configuración y reglas
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const H = require('./_integrationHelpers');

const svc = require('../services/cashFlowService');
const ctrl = require('../controllers/cashFlowController');
const purchases = require('../controllers/purchaseInvoiceController');
const payments = require('../controllers/paymentController');

const CashFlowConfig = require('../models/CashFlowConfig');
const CashFlowMapping = require('../models/CashFlowMapping');
const CashFlowManualItem = require('../models/CashFlowManualItem');
const ChartOfAccount = require('../models/ChartOfAccount');
const BankAccount = require('../models/BankAccount');
const BankTransaction = require('../models/BankTransaction');
const JournalEntry = require('../models/JournalEntry');
const Payable = require('../models/Payable');
const Receivable = require('../models/Receivable');
const Invoice = require('../models/Invoice');
const Sale = require('../models/Sale');
const Payment = require('../models/Payment');
const { createEntry } = require('../utils/accounting');
const { getAccount } = require('../utils/accountMap');
const { openReceivable, openPayable } = require('../utils/subledger');
const { resolvePurchaseDueDate } = require('../utils/purchaseDueDate');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const run = (h, req) => H.runController(h, req);
const ok = (r) => { assert.ok(r.statusCode < 400, JSON.stringify(r.payload)); return r.payload; };
const settled = (rs) => rs.map((r) => (r.status === 'fulfilled' ? r.value : { statusCode: 500, payload: { message: String(r.reason?.message) } }));

const HOY = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();
const dia = (n) => { const d = new Date(HOY); d.setDate(d.getDate() + n); return d; };
const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const habil = (d) => { const x = new Date(d); while (x.getDay() === 0) x.setDate(x.getDate() + 1); return x; };
const proj = (clinicId, from, to, filters) => svc.buildProjection(clinicId, { from: from || HOY, to: to || dia(30), filters });
const dayOf = (data, d) => data.days.find((x) => x.date === key(habil(d)));
const celda = (data, d, dir, cat) => dayOf(data, d)?.categorias?.[dir]?.[cat]?.total || 0;

async function cuenta(clinicId, code) { return ChartOfAccount.findOne({ clinic: clinicId, code }); }
async function banco(clinicId, code = '1.1.01.03') {
  const acc = await cuenta(clinicId, code);
  return BankAccount.create({ clinic: clinicId, name: `Cta ${code}`, bank: 'Pichincha', accountNumber: String(Math.random()).slice(2, 8), chartAccount: acc._id });
}
/** Asiento de fondeo: D cuenta de liquidez / H otros ingresos. */
async function fondear(clinicId, userId, monto, fecha = dia(-10), code = '1.1.01.03') {
  const c = await cuenta(clinicId, code);
  const ing = await getAccount(clinicId, 'otrosIngresos');
  return createEntry({
    clinicId, date: fecha, description: 'Fondeo', userId,
    sourceModel: 'CashDeposit', sourceRef: c._id, sourceAction: `FUND:${code}:${+fecha}:${Math.random()}`,
    lines: [{ account: c._id, debit: monto, credit: 0 }, { account: ing._id, debit: 0, credit: monto }],
  });
}

// ══════════════ BLOQUE 1 · DÍAS DE CRÉDITO ══════════════

test('B1) la utilidad de vencimiento respeta la prioridad y NO lleva la fecha a día hábil', () => {
  const viernes = new Date(2026, 6, 17);   // vie 17/07/2026
  // 1. fecha explícita manda sobre cualquier plazo
  assert.equal(
    key(resolvePurchaseDueDate({ fechaEmision: viernes, fechaVencimiento: dia(3), creditDays: 30 }, { creditDays: 60 }).dueDate),
    key(dia(3))
  );
  // 2. plazo de la compra manda sobre el del proveedor
  const r2 = resolvePurchaseDueDate({ fechaEmision: viernes, creditDays: 1 }, { creditDays: 60 });
  assert.equal(r2.source, 'COMPRA');
  assert.equal(key(r2.dueDate), key(new Date(2026, 6, 18)), 'sábado: el vencimiento LEGAL sigue siendo sábado');
  assert.equal(new Date(r2.dueDate).getDay(), 6);
  // 3. proveedor
  const r3 = resolvePurchaseDueDate({ fechaEmision: viernes }, { creditDays: 2 });
  assert.equal(r3.source, 'PROVEEDOR');
  assert.equal(new Date(r3.dueDate).getDay(), 0, 'domingo: el vencimiento LEGAL conserva el domingo');
  // 4. proveedor con cero días ⇒ sin plazo, no se inventa fecha
  const r4 = resolvePurchaseDueDate({ fechaEmision: viernes }, { creditDays: 0 });
  assert.equal(r4.source, 'SIN_PLAZO');
  assert.equal(r4.dueDate, null);
});

test('B1) todos los caminos de contabilización producen la MISMA fecha (compra → CxP)', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-5) });
  const gasto = await cuenta(clinicId, '6.1.99');
  const sup15 = await H.makeSupplier(clinicId, { creditDays: 15 });
  const emision = dia(-1);
  const item = (n) => ([{ description: 'G', lineType: 'GASTO', account: gasto._id, quantity: 1, unitPrice: n, ivaRate: 0, subtotal: n }]);
  const venceDe = async (piId) => (await Payable.findOne({ clinic: clinicId, sourceRef: piId })).dueDate;

  // (a) creación manual, proveedor con 15 días
  const a = ok(await run(purchases.create, H.mockReq(clinicId, userId, {
    supplier: sup15._id, fechaEmision: emision, serie: '001-001-000000901', items: item(100),
  })));
  const esperado15 = new Date(emision); esperado15.setDate(esperado15.getDate() + 15);
  assert.equal(key(await venceDe(a._id)), key(esperado15), 'sin fecha propia: emisión + 15 del proveedor');

  // (b) plazo propio de la compra gana al del proveedor
  const b = ok(await run(purchases.create, H.mockReq(clinicId, userId, {
    supplier: sup15._id, fechaEmision: emision, creditDays: 7, serie: '001-001-000000902', items: item(100),
  })));
  const esperado7 = new Date(emision); esperado7.setDate(esperado7.getDate() + 7);
  assert.equal(key(await venceDe(b._id)), key(esperado7));

  // (c) fecha explícita gana a todo
  const c = ok(await run(purchases.create, H.mockReq(clinicId, userId, {
    supplier: sup15._id, fechaEmision: emision, creditDays: 7, fechaVencimiento: dia(45),
    serie: '001-001-000000903', items: item(100),
  })));
  assert.equal(key(await venceDe(c._id)), key(dia(45)));

  // (d) proveedor sin plazo y compra sin fecha ⇒ CxP sin vencimiento (no se inventa)
  const sup0 = await H.makeSupplier(clinicId, { creditDays: 0 });
  const d = ok(await run(purchases.create, H.mockReq(clinicId, userId, {
    supplier: sup0._id, fechaEmision: emision, serie: '001-001-000000904', items: item(100),
  })));
  assert.equal(await venceDe(d._id), null);
  // …y se proyecta por la emisión, marcado como fallback documentado.
  const data = await proj(clinicId, dia(-5), dia(30));
  const fila = data.detalle.find((x) => String(x.docRef) === String(d._id));
  assert.equal(fila.basedOn, 'EMISION');

  // (e) el camino de AUTORIZACIÓN da la misma fecha que la creación
  const e = ok(await run(purchases.create, H.mockReq(clinicId, userId, {
    supplier: sup15._id, fechaEmision: emision, serie: '001-001-000000905', items: item(100), status: 'POR_AUTORIZAR',
  })));
  const venceCreacion = await venceDe(e._id);
  assert.equal(key(venceCreacion), key(esperado15), 'un camino distinto no puede dar otra fecha');
});

test('B1) una CxP con fecha corregida a mano no se recalcula al reabrir la cartera', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-5) });
  const gasto = await cuenta(clinicId, '6.1.99');
  const sup = await H.makeSupplier(clinicId, { creditDays: 15 });
  const pi = ok(await run(purchases.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: dia(-1), serie: '001-001-000000910',
    items: [{ description: 'G', lineType: 'GASTO', account: gasto._id, quantity: 1, unitPrice: 100, ivaRate: 0, subtotal: 100 }],
  })));

  // El contador corrige la fecha en la cartera.
  await Payable.updateOne({ clinic: clinicId, sourceRef: pi._id }, { $set: { dueDate: dia(60) } });

  // Se vuelve a tocar la compra (actualización): la fecha DERIVADA no puede pisar la manual.
  ok(await run(purchases.update, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: dia(-1), serie: '001-001-000000910',
    items: [{ description: 'G', lineType: 'GASTO', account: gasto._id, quantity: 1, unitPrice: 120, ivaRate: 0, subtotal: 120 }],
  }, { params: { id: String(pi._id) } })));

  const cxp = await Payable.findOne({ clinic: clinicId, sourceRef: pi._id });
  assert.equal(key(cxp.dueDate), key(dia(60)), 'la fecha corregida a mano sobrevive');
});

test('B1) backfill: completa desde la compra y desde el proveedor, sin tocar lo cerrado ni lo que ya tiene fecha', async () => {
  const { clinicId } = await H.seedClinic({ date: dia(-40) });
  const prov = await getAccount(clinicId, 'proveedores');
  const sup = await H.makeSupplier(clinicId, { creditDays: 15 });
  const PurchaseInvoice = require('../models/PurchaseInvoice');
  // Se ejercita la lógica REAL del script (no una copia), sobre la conexión del harness.
  const { backfillDueDates } = require('../scripts/backfillPayableDueDates');

  const mkCompra = async (extra) => PurchaseInvoice.create({
    clinic: clinicId, supplier: sup._id, fechaEmision: dia(-20), serie: `001-001-${Math.random().toString().slice(2, 11)}`,
    subtotal: 100, total: 100, ...extra,
  });
  const mkCxp = async (pi, extra = {}) => openPayable({
    clinic: clinicId, party: { model: 'Supplier', ref: sup._id, name: 'x' },
    sourceModel: 'PurchaseInvoice', sourceRef: pi._id, docType: 'COMPRA',
    number: pi.serie, issueDate: pi.fechaEmision, total: 100, account: prov._id, ...extra,
  });

  const c1 = await mkCompra({ creditDays: 10 });            // plazo propio
  const c2 = await mkCompra({});                            // plazo del proveedor (15)
  const c3 = await mkCompra({ fechaVencimiento: dia(-5) }); // fecha explícita
  const c4 = await mkCompra({});                            // ya tiene fecha en la CxP
  await mkCxp(c1); await mkCxp(c2); await mkCxp(c3);
  await mkCxp(c4, { dueDate: dia(99) });
  // CxP pagada sin fecha: NO se toca, solo se reporta.
  const c5 = await mkCompra({ creditDays: 10 });
  await mkCxp(c5, { applied: 100 });
  // Huérfana: la compra no existe.
  await openPayable({
    clinic: clinicId, party: { model: 'Supplier', ref: null, name: 'x' },
    sourceModel: 'PurchaseInvoice', sourceRef: new H.mongoose.Types.ObjectId(),
    docType: 'COMPRA', number: 'HUERFANA', issueDate: dia(-20), total: 50, account: prov._id,
  });

  const seco = await backfillDueDates({ clinic: clinicId });   // dry-run por defecto
  assert.equal(seco.encontradas, 6);
  assert.equal(seco.elegibles, 3, 'c1, c2 y c3');
  assert.equal(seco.desdeCompra, 2, 'plazo propio + fecha explícita');
  assert.equal(seco.desdeProveedor, 1);
  assert.equal(seco.omitidas, 1, 'c4 ya tenía fecha');
  assert.equal(seco.cerradas, 1, 'la pagada solo se reporta');
  assert.equal(seco.huerfanas, 1);
  // DRY-RUN: no escribió nada.
  assert.equal((await Payable.findOne({ clinic: clinicId, sourceRef: c1._id })).dueDate, null);

  await backfillDueDates({ commit: true, clinic: clinicId });
  const v1 = new Date(dia(-20)); v1.setDate(v1.getDate() + 10);
  const v2 = new Date(dia(-20)); v2.setDate(v2.getDate() + 15);
  assert.equal(key((await Payable.findOne({ clinic: clinicId, sourceRef: c1._id })).dueDate), key(v1));
  assert.equal(key((await Payable.findOne({ clinic: clinicId, sourceRef: c2._id })).dueDate), key(v2));
  assert.equal(key((await Payable.findOne({ clinic: clinicId, sourceRef: c3._id })).dueDate), key(dia(-5)));
  assert.equal(key((await Payable.findOne({ clinic: clinicId, sourceRef: c4._id })).dueDate), key(dia(99)), 'intacta');
  assert.equal((await Payable.findOne({ clinic: clinicId, sourceRef: c5._id })).dueDate, null, 'la pagada no se tocó');

  // Idempotente: una segunda corrida no cambia nada.
  const segunda = await backfillDueDates({ commit: true, clinic: clinicId });
  assert.equal(segunda.elegibles, 0);
});

// ══════════════ BLOQUE 2 · VENCIDOS ANTES DEL RANGO ══════════════

test('B2) CxP y CxC vencidas el mes anterior se acumulan en el primer día y conservan su mora', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-60) });
  await fondear(clinicId, userId, 1000, dia(-50));
  const prov = await getAccount(clinicId, 'proveedores');
  const cli = await getAccount(clinicId, 'clientes');

  const p = await openPayable({
    clinic: clinicId, party: { model: 'Supplier', ref: null, name: 'Moroso' },
    sourceModel: 'PurchaseInvoice', sourceRef: new H.mongoose.Types.ObjectId(), docType: 'COMPRA',
    number: 'P-1', issueDate: dia(-45), dueDate: dia(-30), total: 400, account: prov._id,
  });
  await openReceivable({
    clinic: clinicId, party: { model: 'Patient', ref: null, name: 'Deudor' },
    sourceModel: 'Sale', sourceRef: new H.mongoose.Types.ObjectId(), docType: 'VENTA',
    number: 'V-1', issueDate: dia(-45), dueDate: dia(-25), total: 300, account: cli._id,
  });
  // Histórico SIN dueDate cuya emisión es anterior al rango (fallback por emisión).
  await openPayable({
    clinic: clinicId, party: { model: 'Supplier', ref: null, name: 'SinFecha' },
    sourceModel: 'PurchaseInvoice', sourceRef: new H.mongoose.Types.ObjectId(), docType: 'COMPRA',
    number: 'P-2', issueDate: dia(-40), total: 100, account: prov._id,
  });

  const data = await proj(clinicId, HOY, dia(15));
  const primer = data.days[0].date;

  const cxpRow = data.detalle.find((x) => x.tercero === 'Moroso');
  assert.equal(cxpRow.day, primer, 'no desaparece: se acumula en el primer día del rango');
  assert.equal(cxpRow.overdue, true);
  assert.equal(cxpRow.acumuladoVencido, true);
  assert.equal(key(new Date(cxpRow.dueDate)), key(dia(-30)), 'conserva su vencimiento legal');
  assert.ok(cxpRow.diasVencidos >= 30, 'conserva sus días de mora reales');
  assert.equal(key(new Date(cxpRow.proyeccionOriginal)), key(habil(dia(-30))), 'y su fecha de proyección original');

  const cxcRow = data.detalle.find((x) => x.tercero === 'Deudor');
  assert.equal(cxcRow.day, primer);
  assert.equal(cxcRow.overdue, true);

  const sinFecha = data.detalle.find((x) => x.tercero === 'SinFecha');
  assert.equal(sinFecha.day, primer, 'el histórico sin vencimiento también se arrastra');
  assert.equal(sinFecha.acumuladoVencido, true);
  assert.equal(sinFecha.basedOn, 'EMISION');

  // Se suman UNA sola vez.
  assert.equal(data.days[0].egresos, 500, '400 + 100');
  assert.equal(data.days[0].ingresos, 300);
  assert.equal(data.totales.egresos, 500, 'no se repiten en su fecha histórica');
  assert.equal(data.totales.acumuladoVencido, 800);
  assert.equal(data.saldoFinal, svc.r2(1000 + 300 - 500));
  assert.ok(data.alertas.some((a) => a.tipo === 'VENCIDOS_ACUMULADOS'));
  assert.ok(!!p);
});

test('B2) vencida y reprogramada dentro / fuera del rango; pagos previos al rango', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-60) });
  const prov = await getAccount(clinicId, 'proveedores');
  const mk = async (name, extra) => openPayable({
    clinic: clinicId, party: { model: 'Supplier', ref: null, name },
    sourceModel: 'PurchaseInvoice', sourceRef: new H.mongoose.Types.ObjectId(), docType: 'COMPRA',
    number: name, issueDate: dia(-45), dueDate: dia(-30), total: 500, account: prov._id, ...extra,
  });

  await mk('Dentro', { plannedPaymentDate: dia(5) });
  await mk('Fuera', { plannedPaymentDate: dia(60) });
  await mk('Parcial', { applied: 200 });          // pago parcial anterior al rango
  await mk('Saldada', { applied: 500 });          // pago total anterior al rango

  const data = await proj(clinicId, HOY, dia(15));
  const primer = data.days[0].date;
  const fila = (n) => data.detalle.find((x) => x.tercero === n);

  assert.equal(fila('Dentro').day, key(habil(dia(5))), 'reprogramada dentro del rango: va a su nueva fecha');
  assert.equal(fila('Dentro').overdue, true, 'pero sigue vencida legalmente');
  assert.equal(fila('Dentro').acumuladoVencido, false);

  assert.equal(fila('Fuera').day, null, 'reprogramada MÁS ALLÁ del rango: fuera del horizonte, no se fuerza');
  assert.equal(fila('Fuera').overdue, true);

  assert.equal(fila('Parcial').day, primer);
  assert.equal(fila('Parcial').saldo, 300, 'solo el saldo pendiente');

  assert.equal(fila('Saldada'), undefined, 'una CxP saldada no está ni en el detalle');
  assert.equal(data.days[0].egresos, 300, 'solo la parcial se acumula en el primer día');
  assert.ok(!!userId);
});

// ══════════════ BLOQUE 3 · TRANSFERENCIAS INTERNAS ══════════════

/** Asiento de traspaso: D destino / H origen (más líneas extra opcionales). */
async function traspaso(clinicId, userId, { destino, origen, monto, extra = [], fecha = HOY, desc = 'Traspaso' }) {
  const d = await cuenta(clinicId, destino);
  const o = await cuenta(clinicId, origen);
  const lines = [
    { account: d._id, debit: monto - extra.reduce((s, x) => s + x.debit, 0), credit: 0 },
    ...(await Promise.all(extra.map(async (x) => ({ account: (await cuenta(clinicId, x.code))._id, debit: x.debit, credit: 0 })))),
    { account: o._id, debit: 0, credit: monto },
  ];
  return createEntry({
    clinicId, date: fecha, description: desc, userId,
    sourceModel: 'BankTransaction', sourceRef: new H.mongoose.Types.ObjectId(), sourceAction: 'TRANSFER',
    lines,
  });
}

test('B3) Caja→Banco y BancoA→BancoB (ambas incluidas): efecto consolidado CERO', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-10) });
  await fondear(clinicId, userId, 8000, dia(-5), '1.1.01.01');   // caja
  const antes = await proj(clinicId, HOY, dia(5));
  assert.equal(antes.saldoInicial, 8000);

  // Caja general → Bancos, 5.000. Ambas están en el conjunto configurado.
  await traspaso(clinicId, userId, { destino: '1.1.01.03', origen: '1.1.01.01', monto: 5000 });

  const data = await proj(clinicId, HOY, dia(5));
  assert.equal(data.totales.ingresos, 0, 'un traspaso NO es un ingreso');
  assert.equal(data.totales.egresos, 0, 'ni un egreso');
  assert.equal(data.totales.transferenciasInternas, 5000, 'se informa aparte');
  assert.equal(data.saldoFinal, 8000, 'el saldo consolidado no cambia');
  assert.equal(dayOf(data, HOY).transferenciasInternas, 5000);
  assert.equal(dayOf(data, HOY).ingresos, 0);
  assert.equal(dayOf(data, HOY).egresos, 0);

  const fila = data.detalle.find((x) => x.transferenciaInterna);
  assert.ok(fila, 'se ve en el detalle');
  assert.equal(fila.direction, 'INTERNO');
  assert.equal(fila.origen[0].code, '1.1.01.01', 'muestra el origen');
  assert.equal(fila.destino[0].code, '1.1.01.03', 'y el destino');
});

test('B3) hacia/desde una cuenta NO incluida sí son salida y entrada reales', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-10) });
  await fondear(clinicId, userId, 5000, dia(-5), '1.1.01.03');

  // Solo el banco está configurado: la caja general queda FUERA del conjunto.
  const bancoAcc = await cuenta(clinicId, '1.1.01.03');
  const cfg = await svc.getConfig(clinicId);
  cfg.bankAccounts = [bancoAcc._id];
  cfg.cashAccounts = [];
  cfg.includeChildAccounts = false;
  await cfg.save();

  // Banco (incluida) → Caja (NO incluida): salida real del conjunto.
  await traspaso(clinicId, userId, { destino: '1.1.01.01', origen: '1.1.01.03', monto: 1000, desc: 'Salida' });
  // Caja (NO incluida) → Banco (incluida): entrada real.
  await traspaso(clinicId, userId, { destino: '1.1.01.03', origen: '1.1.01.01', monto: 400, desc: 'Entrada' });

  const data = await proj(clinicId, HOY, dia(5));
  assert.equal(data.totales.transferenciasInternas, 0, 'no hay nada interno: la otra cuenta está fuera');
  assert.equal(data.totales.egresos, 1000, 'salir del conjunto configurado SÍ es egreso');
  assert.equal(data.totales.ingresos, 400, 'entrar SÍ es ingreso');
  assert.equal(data.saldoFinal, svc.r2(5000 - 1000 + 400));
});

test('B3) traspaso con comisión bancaria: solo la comisión es egreso real', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-10) });
  await fondear(clinicId, userId, 10000, dia(-5), '1.1.01.03');
  await fondear(clinicId, userId, 0, dia(-5), '1.1.01.01').catch(() => null);

  // D Caja 4.990 / D Comisión bancaria 10 / H Banco 5.000
  await traspaso(clinicId, userId, {
    destino: '1.1.01.01', origen: '1.1.01.03', monto: 5000,
    extra: [{ code: '6.1.16', debit: 10 }],
  });

  const data = await proj(clinicId, HOY, dia(5));
  assert.equal(data.totales.transferenciasInternas, 4990, 'la parte que solo cambia de cuenta');
  assert.equal(data.totales.ingresos, 0);
  assert.equal(data.totales.egresos, 10, 'la comisión SÍ sale del conjunto');
  assert.equal(data.saldoFinal, 9990, '10.000 − 10 de comisión');
});

test('B3) más de dos líneas de liquidez en el mismo asiento se netean bien', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-10) });
  await fondear(clinicId, userId, 9000, dia(-5), '1.1.01.03');

  const b = await cuenta(clinicId, '1.1.01.03');
  const caja = await cuenta(clinicId, '1.1.01.01');
  const chica = await cuenta(clinicId, '1.1.01.02');
  await createEntry({
    clinicId, date: HOY, description: 'Reparto de fondos', userId,
    sourceModel: 'BankTransaction', sourceRef: new H.mongoose.Types.ObjectId(), sourceAction: 'SPLIT',
    lines: [
      { account: caja._id, debit: 1000, credit: 0 },
      { account: chica._id, debit: 2000, credit: 0 },
      { account: b._id, debit: 0, credit: 3000 },
    ],
  });

  const data = await proj(clinicId, HOY, dia(5));
  assert.equal(data.totales.transferenciasInternas, 3000);
  assert.equal(data.totales.ingresos, 0);
  assert.equal(data.totales.egresos, 0);
  assert.equal(data.saldoFinal, 9000);

  const fila = data.detalle.find((x) => x.transferenciaInterna);
  assert.equal(fila.destino.length, 2, 'dos destinos');
  assert.equal(fila.origen.length, 1);
});

test('B3) movimientos reales y Excel tampoco inflan ingresos/egresos', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-10) });
  await fondear(clinicId, userId, 8000, dia(-5), '1.1.01.01');
  await traspaso(clinicId, userId, { destino: '1.1.01.03', origen: '1.1.01.01', monto: 5000 });

  const movs = await svc.realMovements(clinicId, { from: HOY, to: dia(5) });
  const interna = movs.rows.find((r) => r.transferenciaInterna);
  assert.ok(interna, 'aparece en Movimientos reales');
  assert.equal(interna.metodo, 'TRANSFERENCIA_INTERNA');
  assert.equal(interna.ingreso, 0);
  assert.equal(interna.egreso, 0);
  assert.equal(interna.origenCuentas[0].code, '1.1.01.01');
  assert.equal(interna.destinoCuentas[0].code, '1.1.01.03');
  assert.equal(movs.totalIn, 0, 'no infla los ingresos');
  assert.equal(movs.totalOut, 0, 'ni los egresos');
  assert.equal(movs.totalTransferenciasInternas, 5000);
  // Y no se duplica por existir a la vez el asiento y un BankTransaction.
  assert.equal(movs.rows.filter((r) => r.transferenciaInterna).length, 1);

  const api = await proj(clinicId, HOY, dia(5));
  const res = H.mockRes();
  await ctrl.projectionExcel(H.mockReq(clinicId, userId, {}, { query: { from: key(HOY), to: key(dia(5)) } }), res.res);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.state.payload);
  const ws = wb.getWorksheet('Flujo');
  let totalIngresos = null;
  let saldoFinal = null;
  ws.eachRow((row) => {
    if (row.getCell(1).value === 'TOTAL INGRESOS') totalIngresos = Number(row.getCell(2).value) || 0;
    if (row.getCell(1).value === 'SALDO PROYECTADO') saldoFinal = Number(row.getCell(2).value) || 0;
  });
  assert.equal(totalIngresos, 0, 'el Excel tampoco infla los ingresos');
  assert.equal(saldoFinal, api.days[0].saldoFinal);
});

// ══════════════ BLOQUE 4 · PARTIDAS MANUALES Y SETTLE ══════════════

const partida = (clinicId, userId, extra = {}) => run(ctrl.createManualItem, H.mockReq(clinicId, userId, {
  direction: 'EGRESO', category: 'OTROS_PAGOS', subcategory: 'VIATICOS',
  description: 'Viáticos', amount: 250, plannedDate: dia(4), ...extra,
}));

test('B4) una partida planificada no toca el mayor y NO se liquida cambiando de estado', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: HOY });
  const item = ok(await partida(clinicId, userId));
  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId }), 0);

  // Sin modo, no se liquida: hay que contabilizar o vincular.
  const r = await run(ctrl.settleManualItem, H.mockReq(clinicId, userId, {}, { params: { id: String(item._id) } }));
  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /no se convierte en movimiento real cambiando su estado/i);
  assert.equal((await CashFlowManualItem.findById(item._id)).status, 'PLANIFICADO');
  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId }), 0);
});

test('B4) liquidar CREANDO el movimiento: un solo asiento, un solo BankTransaction, sin duplicar', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: HOY });
  await fondear(clinicId, userId, 1000, dia(-1));
  const bank = await banco(clinicId);
  const gasto = await cuenta(clinicId, '6.1.99');
  const item = ok(await partida(clinicId, userId));

  const body = {
    mode: 'CREAR', bankAccountId: String(bank._id), counterAccountId: String(gasto._id),
    date: key(HOY), method: 'TRANSFERENCIA', reference: 'TR-9',
  };
  const req = () => H.mockReq(clinicId, userId, body, {
    params: { id: String(item._id) }, headers: { 'idempotency-key': 'SET-1' },
  });

  const primero = ok(await run(ctrl.settleManualItem, req()));
  assert.equal(primero.status, 'REALIZADO');
  assert.equal(primero.settledByModel, 'BankTransaction');

  // Doble submit: no contabiliza dos veces.
  const replay = ok(await run(ctrl.settleManualItem, req()));
  assert.equal(replay.idempotentReplay, true);

  const asientos = await JournalEntry.find({ clinic: clinicId, sourceModel: 'CashFlowManualItem' });
  assert.equal(asientos.length, 1, 'un solo asiento');
  assert.equal(asientos[0].totalDebit, 250);
  assert.equal(asientos[0].totalCredit, 250, 'balanceado');
  assert.equal(await BankTransaction.countDocuments({ clinic: clinicId, sourceModel: 'CashFlowManualItem' }), 1);
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);

  // Sale de la proyección y aparece como movimiento real, sin duplicarse.
  const data = await proj(clinicId, HOY, dia(20));
  assert.equal(celda(data, dia(4), 'EGRESO', 'OTROS_PAGOS'), 0, 'ya no se proyecta');
  assert.equal(dayOf(data, HOY).egresosReales, 250, 'aparece una sola vez como real');
  const movs = await svc.realMovements(clinicId, { from: HOY, to: dia(1) });
  assert.equal(movs.rows.filter((m) => m.egreso === 250).length, 1);
});

test('B4) fallo intermedio revierte todo y la partida sigue planificada', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: HOY });
  const bank = await banco(clinicId);
  const gasto = await cuenta(clinicId, '6.1.99');
  const item = ok(await partida(clinicId, userId));

  const original = BankTransaction.create;
  BankTransaction.create = () => { throw new Error('fallo simulado del libro de bancos'); };
  let r;
  try {
    r = await run(ctrl.settleManualItem, H.mockReq(clinicId, userId, {
      mode: 'CREAR', bankAccountId: String(bank._id), counterAccountId: String(gasto._id), date: key(HOY),
    }, { params: { id: String(item._id) } }));
  } finally { BankTransaction.create = original; }

  assert.ok(r.statusCode >= 400);
  assert.equal((await CashFlowManualItem.findById(item._id)).status, 'PLANIFICADO', 'no quedó liquidada a medias');
  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId, sourceModel: 'CashFlowManualItem' }), 0);
});

test('B4) vincular un movimiento REAL existente: valida clínica, dirección, importe y exclusividad', async () => {
  const a = await H.seedClinic({ date: HOY });
  const b = await H.seedClinic({ date: HOY });
  const bankA = await banco(a.clinicId);
  const item = ok(await partida(a.clinicId, a.userId, { amount: 300 }));

  const mkTx = async (clinicId, bankId, { amount, direction }) => BankTransaction.create({
    clinic: clinicId, bankAccount: bankId, date: HOY, type: direction === 1 ? 'DEPOSITO' : 'PAGO',
    amount, direction, description: 'mov',
  });
  const txOk = await mkTx(a.clinicId, bankA._id, { amount: 300, direction: -1 });
  const txImporte = await mkTx(a.clinicId, bankA._id, { amount: 999, direction: -1 });
  const txDireccion = await mkTx(a.clinicId, bankA._id, { amount: 300, direction: 1 });
  const bankB = await banco(b.clinicId);
  const txOtraClinica = await mkTx(b.clinicId, bankB._id, { amount: 300, direction: -1 });

  const vincular = (ref) => run(ctrl.settleManualItem, H.mockReq(a.clinicId, a.userId, {
    mode: 'VINCULAR', settledByModel: 'BankTransaction', settledByRef: String(ref),
  }, { params: { id: String(item._id) } }));

  assert.equal((await vincular(txOtraClinica._id)).statusCode, 404, 'otra clínica: no existe aquí');
  assert.equal((await vincular(txImporte._id)).statusCode, 400, 'importe incompatible');
  assert.equal((await vincular(txDireccion._id)).statusCode, 400, 'dirección incompatible');
  assert.equal((await CashFlowManualItem.findById(item._id)).status, 'PLANIFICADO');

  const okRes = ok(await vincular(txOk._id));
  assert.equal(okRes.status, 'REALIZADO');
  assert.equal(okRes.settledByModel, 'BankTransaction');

  // Ese mismo movimiento no puede respaldar OTRA partida.
  const otra = ok(await partida(a.clinicId, a.userId, { amount: 300, description: 'Otra' }));
  const conflicto = await run(ctrl.settleManualItem, H.mockReq(a.clinicId, a.userId, {
    mode: 'VINCULAR', settledByModel: 'BankTransaction', settledByRef: String(txOk._id),
  }, { params: { id: String(otra._id) } }));
  assert.equal(conflicto.statusCode, 409);
  assert.match(conflicto.payload.message, /no puede liquidar dos previsiones/i);
});

test('B4) cancelar antes de liquidar sí; después de liquidar NO (no se revierte contabilidad real)', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: HOY });
  const bank = await banco(clinicId);
  const gasto = await cuenta(clinicId, '6.1.99');

  const cancelable = ok(await partida(clinicId, userId));
  const c = ok(await run(ctrl.cancelManualItem, H.mockReq(clinicId, userId, { reason: 'No se hará el viaje' },
    { params: { id: String(cancelable._id) } })));
  assert.equal(c.status, 'CANCELADO');

  const liquidada = ok(await partida(clinicId, userId, { description: 'Otra' }));
  ok(await run(ctrl.settleManualItem, H.mockReq(clinicId, userId, {
    mode: 'CREAR', bankAccountId: String(bank._id), counterAccountId: String(gasto._id), date: key(HOY),
  }, { params: { id: String(liquidada._id) } })));

  const r = await run(ctrl.cancelManualItem, H.mockReq(clinicId, userId, { reason: 'me arrepentí' },
    { params: { id: String(liquidada._id) } }));
  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /no puede borrar ni reversar/i);
  assert.equal((await CashFlowManualItem.findById(liquidada._id)).status, 'REALIZADO');
  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId, sourceModel: 'CashFlowManualItem' }), 1,
    'el asiento real sigue vivo');
});

test('B4) cuenta inválida y aislamiento entre clínicas', async () => {
  const a = await H.seedClinic({ date: HOY });
  const b = await H.seedClinic({ date: HOY });
  const bankB = await banco(b.clinicId);
  const gastoA = await cuenta(a.clinicId, '6.1.99');
  const item = ok(await partida(a.clinicId, a.userId));

  const cuentaAjena = await run(ctrl.settleManualItem, H.mockReq(a.clinicId, a.userId, {
    mode: 'CREAR', bankAccountId: String(bankB._id), counterAccountId: String(gastoA._id), date: key(HOY),
  }, { params: { id: String(item._id) } }));
  assert.equal(cuentaAjena.statusCode, 400, 'no se puede usar un banco de otra clínica');

  const inexistente = await run(ctrl.settleManualItem, H.mockReq(a.clinicId, a.userId, {
    mode: 'CREAR', cashAccountId: String(new H.mongoose.Types.ObjectId()), counterAccountId: String(gastoA._id), date: key(HOY),
  }, { params: { id: String(item._id) } }));
  assert.equal(inexistente.statusCode, 400);

  assert.equal((await CashFlowManualItem.findById(item._id)).status, 'PLANIFICADO');
  assert.equal(await JournalEntry.countDocuments({ clinic: a.clinicId }), 0);
});

// ══════════════ BLOQUE 5 · CICLO COMPLETO DE LA CxC DE UNA FACTURA ══════════════

async function facturaConCxC(clinicId, total = 500) {
  const inv = await Invoice.create({
    clinic: clinicId, claveAcceso: `CLV${Date.now()}${Math.random()}`, secuencial: '000000500',
    estab: '001', ptoEmi: '001', ambiente: '1', estado: 'AUTORIZADO', fechaEmision: '01/01/2026',
    tipoIdentificacionComprador: '05', identificacionComprador: '0912345678',
    razonSocialComprador: 'Cliente A', totalSinImpuestos: total, totalImpuesto: 0, importeTotal: total,
    balance: total,
  });
  const cli = await getAccount(clinicId, 'clientes');
  await openReceivable({
    clinic: clinicId, party: { model: 'Patient', ref: null, name: 'Cliente A' },
    sourceModel: 'Invoice', sourceRef: inv._id, docType: 'FACTURA', number: inv.secuencial,
    issueDate: dia(-3), dueDate: dia(6), total, account: cli._id,
  });
  return inv;
}
const cobrar = (clinicId, userId, inv, amount, key2) => run(payments.create, H.mockReq(clinicId, userId, {
  type: 'COBRO', method: 'EFECTIVO', partyModel: 'Patient', partyName: 'Cliente A', date: HOY,
  applications: [{ docModel: 'Invoice', docRef: String(inv._id), amount }],
}, key2 ? { headers: { 'idempotency-key': key2 } } : {}));

test('B5) cobro parcial, anulación y recobro mantienen Invoice y CxC en el mismo saldo', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-5) });
  const inv = await facturaConCxC(clinicId, 500);
  const saldos = async () => ({
    inv: (await Invoice.findById(inv._id)).balance,
    cxc: (await Receivable.findOne({ clinic: clinicId, sourceRef: inv._id })).balance,
    flujo: celda(await proj(clinicId, HOY, dia(20)), dia(6), 'INGRESO', 'CLIENTES'),
  });

  assert.deepEqual(await saldos(), { inv: 500, cxc: 500, flujo: 500 });

  // Cobro parcial de 200
  const p1 = ok(await cobrar(clinicId, userId, inv, 200));
  assert.deepEqual(await saldos(), { inv: 300, cxc: 300, flujo: 300 }, 'los tres bajan a la vez');

  // Anulación: los DOS saldos vuelven a 500 (antes la CxC se quedaba en 300 para siempre)
  ok(await run(payments.void, H.mockReq(clinicId, userId, { date: key(HOY) }, { params: { id: String(p1._id) } })));
  assert.deepEqual(await saldos(), { inv: 500, cxc: 500, flujo: 500 }, 'anular devuelve el saldo a la CxC');
  const anulado = await Payment.findById(p1._id);
  assert.equal(anulado.status, 'ANULADO');
  const reversa = await JournalEntry.findOne({ clinic: clinicId, _id: anulado.journalEntry });
  assert.equal(reversa.isReversed, true, 'el movimiento real quedó reversado');

  // Doble anulación: bloqueada.
  const doble = await run(payments.void, H.mockReq(clinicId, userId, {}, { params: { id: String(p1._id) } }));
  assert.equal(doble.statusCode, 400);
  assert.match(doble.payload.message, /ya anulado/i);
  assert.deepEqual(await saldos(), { inv: 500, cxc: 500, flujo: 500 }, 'y no resta dos veces');

  // Segundo cobro, ahora total.
  const p2 = ok(await cobrar(clinicId, userId, inv, 500));
  assert.deepEqual(await saldos(), { inv: 0, cxc: 0, flujo: 0 });
  assert.equal((await Receivable.findOne({ clinic: clinicId, sourceRef: inv._id })).status, 'PAGADO');

  // Anulación del cobro total: reabre el saldo completo.
  ok(await run(payments.void, H.mockReq(clinicId, userId, { date: key(HOY) }, { params: { id: String(p2._id) } })));
  assert.deepEqual(await saldos(), { inv: 500, cxc: 500, flujo: 500 });
  assert.equal((await Receivable.findOne({ clinic: clinicId, sourceRef: inv._id })).status, 'ABIERTO');
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

test('B5) idempotencia y concurrencia del cobro de una factura: la CxC se aplica una sola vez', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-5) });
  const inv = await facturaConCxC(clinicId, 500);

  // Mismo cobro con la misma clave, en paralelo.
  const rs = settled(await Promise.allSettled([
    cobrar(clinicId, userId, inv, 200, 'INV-1'),
    cobrar(clinicId, userId, inv, 200, 'INV-1'),
  ]));
  assert.ok(rs.every((r) => r.statusCode < 400), JSON.stringify(rs.map((r) => r.payload?.message)));
  assert.ok(rs.every((r) => !/E11000/i.test(r.payload?.message || '')));
  assert.equal(await Payment.countDocuments({ clinic: clinicId }), 1, 'un solo cobro');
  assert.equal((await Receivable.findOne({ clinic: clinicId, sourceRef: inv._id })).applied, 200, 'aplicado una vez');
  assert.equal((await Invoice.findById(inv._id)).balance, 300);
});

// ══════════════ BLOQUE 6 · CxC DUPLICADAS ENTRE VENTA Y FACTURA ══════════════

/** Reproduce el escenario histórico: una venta a crédito FACTURADA con dos CxC. */
async function ventaFacturadaConDosCxC(clinicId, { totalVenta = 400, appliedVenta = 0, appliedFactura = 0 } = {}) {
  const inv = await Invoice.create({
    clinic: clinicId, claveAcceso: `CLV${Date.now()}${Math.random()}`, secuencial: '000000777',
    estab: '001', ptoEmi: '001', ambiente: '1', estado: 'AUTORIZADO', fechaEmision: '01/01/2026',
    tipoIdentificacionComprador: '05', identificacionComprador: '0912345678',
    razonSocialComprador: 'Cliente F', totalSinImpuestos: totalVenta, totalImpuesto: 0, importeTotal: totalVenta,
    balance: totalVenta,
  });
  const sale = await Sale.create({
    clinic: clinicId, saleNumber: `V-${Math.floor(Math.random() * 1e6)}`, clientName: 'Cliente F',
    paymentMethod: 'credito', status: 'completada',
    subtotal: totalVenta, taxAmount: 0, total: totalVenta, balance: totalVenta,
    invoice: inv._id, items: [],
  });
  const cli = await getAccount(clinicId, 'clientes');
  await openReceivable({
    clinic: clinicId, party: { model: 'Patient', ref: null, name: 'Cliente F' },
    sourceModel: 'Sale', sourceRef: sale._id, docType: 'VENTA', number: sale.saleNumber,
    issueDate: dia(-3), dueDate: dia(6), total: totalVenta, applied: appliedVenta, account: cli._id,
  });
  await openReceivable({
    clinic: clinicId, party: { model: 'Patient', ref: null, name: 'Cliente F' },
    sourceModel: 'Invoice', sourceRef: inv._id, docType: 'FACTURA', number: inv.secuencial,
    issueDate: dia(-3), dueDate: dia(6), total: totalVenta, applied: appliedFactura, account: cli._id,
  });
  return { sale, inv };
}

test('B6) venta con factura enlazada y DOS CxC históricas: el flujo la cuenta UNA vez y avisa', async () => {
  const { clinicId } = await H.seedClinic({ date: dia(-5) });
  const { sale, inv } = await ventaFacturadaConDosCxC(clinicId, { totalVenta: 400 });
  assert.equal(await Receivable.countDocuments({ clinic: clinicId }), 2, 'el histórico tiene las dos');

  const data = await proj(clinicId, HOY, dia(20));
  assert.equal(celda(data, dia(6), 'INGRESO', 'CLIENTES'), 400, 'una obligación económica = un solo importe');
  assert.equal(data.totales.ingresos, 400);

  const dupRow = data.detalle.find((x) => x.duplicada);
  assert.ok(dupRow, 'la duplicada se sigue viendo');
  assert.equal(dupRow.sourceModel, 'Invoice', 'la canónica es la VENTA; se descarta la de la factura');
  assert.equal(dupRow.day, null, 'y no se suma');
  assert.equal(String(dupRow.duplicadaDe.sourceRef), String(sale._id));

  const alerta = data.alertas.find((a) => a.tipo === 'CXC_DUPLICADA');
  assert.ok(alerta, 'el flujo ADVIERTE la duplicidad');
  assert.equal(dupRow.resolution, 'SAFE_DUPLICATE', 'sin cobros en ninguna: consolidable');
  assert.ok(!data.alertas.some((a) => a.tipo === 'CXC_DUPLICADA_AMBIGUA'));
  assert.ok(!!inv);
});

test('B6) casos que NO se deduplican: venta sin factura, factura suelta e importes iguales sin vínculo', async () => {
  const { clinicId } = await H.seedClinic({ date: dia(-5) });
  const cli = await getAccount(clinicId, 'clientes');

  // 1. venta a crédito sin factura
  const sale = await Sale.create({
    clinic: clinicId, saleNumber: 'V-SOLA', clientName: 'A', paymentMethod: 'credito',
    status: 'completada', subtotal: 100, taxAmount: 0, total: 100, balance: 100, items: [],
  });
  await openReceivable({
    clinic: clinicId, party: { model: 'Patient', ref: null, name: 'A' },
    sourceModel: 'Sale', sourceRef: sale._id, docType: 'VENTA', number: 'V-SOLA',
    issueDate: dia(-3), dueDate: dia(6), total: 100, account: cli._id,
  });
  // 2. factura independiente, del MISMO importe, sin vínculo con la venta
  const inv = await facturaConCxC(clinicId, 100);

  const data = await proj(clinicId, HOY, dia(20));
  assert.equal(data.detalle.filter((x) => x.duplicada).length, 0,
    'dos documentos distintos con el mismo importe pero sin vínculo NO se deduplican');
  assert.equal(celda(data, dia(6), 'INGRESO', 'CLIENTES'), 200, 'suman los dos: son obligaciones distintas');
  assert.ok(!data.alertas.some((a) => a.tipo === 'CXC_DUPLICADA'));
  assert.ok(!!inv);
});

test('B6) el diagnóstico reporta los pares, los clasifica y NO modifica nada', async () => {
  const { clinicId } = await H.seedClinic({ date: dia(-5) });
  const { diagnose } = require('../scripts/diagnoseDuplicateReceivables');

  // Aplicaciones distintas en cada cartera y sin cobros que las expliquen: nadie puede afirmar
  // cuál dice la verdad. Es AMBIGUO y no se consolida solo.
  await ventaFacturadaConDosCxC(clinicId, { totalVenta: 400, appliedVenta: 100, appliedFactura: 50 });

  const rep = await diagnose({ clinic: clinicId });
  assert.equal(rep.duplicadas, 1, 'encuentra el par');
  assert.equal(rep.ambiguas, 1);
  assert.equal(rep.corregiblesAuto, 0, 'no se puede corregir solo: hay que decidirlo a mano');
  const o = rep.detalle[0].obligacion;
  assert.equal(o.receivables.venta.applied, 100);
  assert.equal(o.receivables.factura.applied, 50);
  assert.equal(o.balance, 300, 'saldo conservador: 400 − el mayor cobro demostrable (100)');
  assert.equal(await Receivable.countDocuments({ clinic: clinicId }), 2, 'el diagnóstico NO borra ni fusiona');

  // Y el flujo cuenta la obligación una sola vez, con ese mismo saldo, avisando de la ambigüedad.
  const data = await proj(clinicId, HOY, dia(20));
  assert.equal(celda(data, dia(6), 'INGRESO', 'CLIENTES'), 300);
  assert.ok(data.alertas.some((a) => a.tipo === 'CXC_DUPLICADA_AMBIGUA'));
});

// ══════════════ BLOQUE 7 · plannedCollectionDate ══════════════

test('B7) un solo campo persistido: `plannedCollectionDate` es solo nombre de API', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: HOY });
  const cli = await getAccount(clinicId, 'clientes');
  const cxc = await openReceivable({
    clinic: clinicId, party: { model: 'Patient', ref: null, name: 'Cliente' },
    sourceModel: 'Sale', sourceRef: new H.mongoose.Types.ObjectId(), docType: 'VENTA',
    number: 'V-9', issueDate: dia(-2), dueDate: dia(5), total: 900, account: cli._id,
  });

  ok(await run(ctrl.reschedule, H.mockReq(clinicId, userId, {
    docModel: 'Receivable', docRef: String(cxc._id), newDate: dia(11), reason: 'El cliente pidió plazo',
  })));

  // 1. En la base hay UN solo campo con la fecha.
  const crudo = await Receivable.collection.findOne({ _id: cxc._id });
  assert.equal(key(crudo.plannedPaymentDate), key(dia(11)), 'el campo persistido canónico');
  assert.equal(crudo.plannedCollectionDate, undefined, 'no existe un segundo campo que pueda divergir');
  assert.equal(key(crudo.dueDate), key(dia(5)), 'el vencimiento legal no se tocó');

  // 2. .lean() y las agregaciones ven el campo canónico.
  const leanDoc = await Receivable.findById(cxc._id).lean();
  assert.equal(key(leanDoc.plannedPaymentDate), key(dia(11)));
  const [agg] = await Receivable.aggregate([
    { $match: { _id: cxc._id } },
    { $project: { plannedPaymentDate: 1 } },
  ]);
  assert.equal(key(agg.plannedPaymentDate), key(dia(11)), 'la agregación también');

  // 3. Filtro por rango y ordenamiento funcionan sobre el campo real.
  const enRango = await Receivable.find({
    clinic: clinicId, plannedPaymentDate: { $gte: dia(10), $lte: dia(12) },
  }).sort({ plannedPaymentDate: 1 });
  assert.equal(enRango.length, 1);

  // 4. La proyección, el detalle y el Excel usan LA MISMA fecha.
  const data = await proj(clinicId, HOY, dia(20));
  const fila = data.detalle.find((x) => String(x.id) === String(cxc._id));
  assert.equal(fila.day, key(habil(dia(11))));
  assert.equal(key(new Date(fila.plannedDate)), key(dia(11)));
  assert.equal(key(new Date(fila.plannedCollectionDate)), key(dia(11)), 'expuesto con su nombre de API en una CxC');
  assert.equal(celda(data, dia(11), 'INGRESO', 'CLIENTES'), 900);

  const res = H.mockRes();
  await ctrl.projectionExcel(H.mockReq(clinicId, userId, {}, { query: { from: key(HOY), to: key(dia(20)) } }), res.res);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.state.payload);
  const wsd = wb.getWorksheet('Detalle');
  let filaExcel = null;
  wsd.eachRow((row, i) => { if (i > 1 && row.getCell(7).value === 'Cliente') filaExcel = row; });
  assert.ok(filaExcel);
  assert.equal(filaExcel.getCell(1).value, key(habil(dia(11))), 'el Excel proyecta en la misma fecha');
});

// ══════════════ BLOQUE 8 · CONCURRENCIA DE CONFIG Y REGLAS ══════════════

test('B8) configuración y reglas concurrentes: una sola, sin E11000 y sin mezclar clínicas', async () => {
  const a = await H.seedClinic({ date: HOY });
  const b = await H.seedClinic({ date: HOY });

  // Autocreación simultánea de la configuración.
  const cfgs = await Promise.allSettled([
    svc.getConfig(a.clinicId), svc.getConfig(a.clinicId), svc.getConfig(a.clinicId),
  ]);
  assert.ok(cfgs.every((r) => r.status === 'fulfilled'), JSON.stringify(cfgs.map((r) => r.reason?.message)));
  assert.equal(await CashFlowConfig.countDocuments({ clinic: a.clinicId }), 1, 'una sola configuración');
  assert.equal(await CashFlowConfig.countDocuments({ clinic: b.clinicId }), 0, 'no se creó en la otra clínica');

  // La misma regla, a la vez, en las dos clínicas.
  const sup = await H.makeSupplier(a.clinicId);
  const body = {
    direction: 'EGRESO', matchType: 'SUPPLIER', matchValue: String(sup._id),
    category: 'GASTOS_FIJOS', subcategory: 'SERVICIOS_BASICOS',
  };
  const rs = settled(await Promise.allSettled([
    run(ctrl.createMapping, H.mockReq(a.clinicId, a.userId, body)),
    run(ctrl.createMapping, H.mockReq(a.clinicId, a.userId, body)),
    run(ctrl.createMapping, H.mockReq(b.clinicId, b.userId, body)),
  ]));
  assert.ok(rs.every((r) => r.statusCode < 400), JSON.stringify(rs.map((r) => r.payload?.message)));
  assert.ok(rs.every((r) => !/E11000|duplicate key/i.test(r.payload?.message || '')), 'ningún E11000 crudo');
  assert.equal(await CashFlowMapping.countDocuments({ clinic: a.clinicId }), 1);
  assert.equal(await CashFlowMapping.countDocuments({ clinic: b.clinicId }), 1, 'cada clínica tiene la suya');

  // La misma llave con OTRA categoría ⇒ 409 controlado, sin segunda regla.
  const conflicto = await run(ctrl.createMapping, H.mockReq(a.clinicId, a.userId, { ...body, category: 'OTROS_PAGOS' }));
  assert.equal(conflicto.statusCode, 409);
  assert.equal(await CashFlowMapping.countDocuments({ clinic: a.clinicId }), 1);
});
