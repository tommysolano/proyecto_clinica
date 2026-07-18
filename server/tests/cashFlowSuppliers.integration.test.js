/**
 * FLUJO DE CAJA · asignación de proveedores a categorías, proveedores pendientes de clasificar,
 * saldo inicial manual y rango que arranca HOY con sábados. Todo sobre los controllers/servicio
 * reales (sin mocks del cálculo).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const svc = require('../services/cashFlowService');
const ctrl = require('../controllers/cashFlowController');
const CashFlowMapping = require('../models/CashFlowMapping');
const { openPayable } = require('../utils/subledger');
const { getAccount } = require('../utils/accountMap');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const run = (h, req) => H.runController(h, req);
const ok = (r) => { assert.ok(r.statusCode < 400, JSON.stringify(r.payload)); return r.payload; };

const HOY = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();
const dia = (n) => { const d = new Date(HOY); d.setDate(d.getDate() + n); return d; };
const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const catTotal = (data, dir, cat) => data.days.reduce((s, d) => s + (d.categorias?.[dir]?.[cat]?.total || 0), 0);

let seq = 0;
/** CxP de un proveedor concreto (party.ref = supplier._id) para que la regla SUPPLIER case. */
async function cxp(clinicId, supplier, { total = 100, dueDate = dia(4) } = {}) {
  seq += 1;
  const cuenta = await getAccount(clinicId, 'proveedores');
  return openPayable({
    clinic: clinicId,
    party: { model: 'Supplier', ref: supplier._id, name: supplier.razonSocial },
    sourceModel: 'PurchaseInvoice', sourceRef: new H.mongoose.Types.ObjectId(), docType: 'COMPRA',
    number: `001-001-${String(seq).padStart(9, '0')}`,
    issueDate: dia(-2), dueDate, total, applied: 0, account: cuenta._id,
  });
}

const suppliers = (clinicId, userId) => run(ctrl.suppliers, H.mockReq(clinicId, userId, {}, {}));
const assign = (clinicId, userId, supplierId, category) =>
  run(ctrl.assignSupplier, H.mockReq(clinicId, userId, { supplierId: String(supplierId), category }));
const unassign = (clinicId, userId, supplierId) =>
  run(ctrl.unassignSupplier, H.mockReq(clinicId, userId, { supplierId: String(supplierId) }));

// ─────────────────────────────────────────────────────────────────────────────
test('1) la clínica trae las 5 categorías de egreso pedidas por la contadora', async () => {
  const { clinicId } = await H.seedClinic({ date: HOY });
  const cfg = await svc.getConfig(clinicId);
  const labels = cfg.categories.EGRESO.map((c) => c.label);
  for (const l of ['Proveedores de inventario', 'Honorarios de doctores', 'Otros gastos', 'Gastos fijos', 'Préstamos']) {
    assert.ok(labels.includes(l), `falta la categoría "${l}" (están: ${labels.join(', ')})`);
  }
  // Honorarios de doctores va después de proveedores de inventario y antes de otros gastos.
  const keys = cfg.categories.EGRESO.map((c) => c.key);
  assert.ok(keys.indexOf('PROVEEDORES') < keys.indexOf('HONORARIOS_DOCTORES'));
  assert.ok(keys.indexOf('HONORARIOS_DOCTORES') < keys.indexOf('OTROS_PAGOS'));
});

// ─────────────────────────────────────────────────────────────────────────────
test('2) asignar proveedores con EXCLUSIÓN PROGRESIVA en el selector', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: HOY });
  const jose = await H.makeSupplier(clinicId, { razonSocial: 'José (ampollas)' });
  const pablo = await H.makeSupplier(clinicId, { razonSocial: 'Pablito (doctor)' });
  const pepe = await H.makeSupplier(clinicId, { razonSocial: 'Pepito (arreglos)' });
  await cxp(clinicId, jose, { total: 300 });
  await cxp(clinicId, pablo, { total: 500 });
  await cxp(clinicId, pepe, { total: 200 });

  // De entrada los tres están DISPONIBLES y ninguno asignado.
  let s = ok(await suppliers(clinicId, userId));
  assert.equal(s.disponibles.length, 3);
  assert.equal(s.asignados.length, 0);

  // José → Proveedores de inventario.
  ok(await assign(clinicId, userId, jose._id, 'PROVEEDORES'));
  s = ok(await suppliers(clinicId, userId));
  assert.deepEqual(s.disponibles.map((x) => x.name).sort(), ['Pablito (doctor)', 'Pepito (arreglos)'],
    'José ya no aparece como opción en las demás categorías');

  // Pablito → Honorarios de doctores.
  ok(await assign(clinicId, userId, pablo._id, 'HONORARIOS_DOCTORES'));
  s = ok(await suppliers(clinicId, userId));
  assert.deepEqual(s.disponibles.map((x) => x.name), ['Pepito (arreglos)'], 'solo queda Pepito disponible');
  assert.equal(s.asignados.length, 2);
  const porRef = Object.fromEntries(s.asignados.map((a) => [a.name, a.category]));
  assert.equal(porRef['José (ampollas)'], 'PROVEEDORES');
  assert.equal(porRef['Pablito (doctor)'], 'HONORARIOS_DOCTORES');
});

// ─────────────────────────────────────────────────────────────────────────────
test('3) la proyección agrupa cada CxP en la categoría del proveedor y lista los pendientes', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: HOY });
  const jose = await H.makeSupplier(clinicId, { razonSocial: 'José (ampollas)' });
  const pablo = await H.makeSupplier(clinicId, { razonSocial: 'Pablito (doctor)' });
  const pepe = await H.makeSupplier(clinicId, { razonSocial: 'Pepito (arreglos)' });
  await cxp(clinicId, jose, { total: 300 });
  await cxp(clinicId, pablo, { total: 500 });
  await cxp(clinicId, pepe, { total: 200 });

  await assign(clinicId, userId, jose._id, 'PROVEEDORES');
  await assign(clinicId, userId, pablo._id, 'HONORARIOS_DOCTORES');

  let data = await svc.buildProjection(clinicId, { from: HOY, to: dia(30) });
  // Pepito, sin categoría, aparece en pendientes; los otros dos no.
  assert.deepEqual(data.proveedoresPendientes.map((p) => p.name), ['Pepito (arreglos)']);
  // Cada CxP cae en la categoría de su proveedor. Pepito (sin regla) cae en el default de módulo.
  assert.equal(catTotal(data, 'EGRESO', 'HONORARIOS_DOCTORES'), 500, 'la CxP de Pablito va a Honorarios');
  assert.equal(catTotal(data, 'EGRESO', 'PROVEEDORES'), 500, 'José (300) + Pepito por default (200)');

  // Al clasificar a Pepito desaparece de pendientes y su CxP se mueve a Otros gastos.
  ok(await assign(clinicId, userId, pepe._id, 'OTROS_PAGOS'));
  data = await svc.buildProjection(clinicId, { from: HOY, to: dia(30) });
  assert.equal(data.proveedoresPendientes.length, 0, 'ya no hay proveedores pendientes');
  assert.equal(catTotal(data, 'EGRESO', 'OTROS_PAGOS'), 200, 'Pepito ahora en Otros gastos');
  assert.equal(catTotal(data, 'EGRESO', 'PROVEEDORES'), 300, 'solo José');

  // Quitar a Pablito lo vuelve a hacer disponible y pendiente.
  ok(await unassign(clinicId, userId, pablo._id));
  const s = ok(await suppliers(clinicId, userId));
  assert.ok(s.disponibles.some((x) => x.name === 'Pablito (doctor)'), 'Pablito vuelve a estar disponible');
  data = await svc.buildProjection(clinicId, { from: HOY, to: dia(30) });
  assert.deepEqual(data.proveedoresPendientes.map((p) => p.name), ['Pablito (doctor)']);
  assert.equal(await CashFlowMapping.countDocuments({ clinic: clinicId, matchType: 'SUPPLIER' }), 2, 'quedan José y Pepito');
});

// ─────────────────────────────────────────────────────────────────────────────
test('4) el rango arranca HOY y el calendario incluye los sábados', async () => {
  const { clinicId } = await H.seedClinic({ date: HOY });
  const cfg = await svc.getConfig(clinicId);
  assert.equal(cfg.includeSaturdays, true, 'sábados activos por defecto');

  const data = await svc.buildProjection(clinicId, { from: HOY, to: dia(14) });
  assert.equal(key(new Date(data.rango.from)), key(HOY), 'la proyección arranca hoy, no mañana');
  // Primer día = hoy si hoy es hábil (lun–sáb); si hoy es domingo, el lunes.
  const primerHabil = HOY.getDay() === 0 ? dia(1) : HOY;
  assert.equal(data.days[0].date, key(primerHabil));
  // Cualquier sábado dentro de la ventana es una columna (no se desplaza).
  for (let i = 0; i <= 14; i += 1) {
    const d = dia(i);
    if (d.getDay() === 6) assert.ok(data.days.some((x) => x.date === key(d)), `el sábado ${key(d)} debe ser columna`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
test('5) saldo inicial MANUAL se respeta (y AUTO sale del mayor)', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: HOY });

  // Por defecto AUTO: sin movimientos del mayor, arranca en 0.
  let data = await svc.buildProjection(clinicId, { from: HOY, to: dia(10) });
  assert.equal(data.config.openingBalanceMode, 'AUTO');
  assert.equal(data.saldoInicial, 0);

  // Se fija un saldo inicial manual desde la configuración.
  ok(await run(ctrl.updateConfig, H.mockReq(clinicId, userId, { openingBalanceMode: 'MANUAL', openingBalanceManual: 5000 })));
  data = await svc.buildProjection(clinicId, { from: HOY, to: dia(10) });
  assert.equal(data.config.openingBalanceMode, 'MANUAL');
  assert.equal(data.saldoInicial, 5000, 'la proyección arranca del saldo manual');
  assert.equal(data.days[0].saldoInicial, 5000, 'el primer día usa el saldo manual');
  assert.equal(data.saldoInicialAuto, 0, 'el saldo automático (del mayor) se sigue informando aparte');
});

// ─────────────────────────────────────────────────────────────────────────────
test('6) invariante: el detalle de cada celda de egreso concilia con su total', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: HOY });
  const jose = await H.makeSupplier(clinicId, { razonSocial: 'José' });
  await cxp(clinicId, jose, { total: 300 });
  await cxp(clinicId, jose, { total: 150, dueDate: dia(6) });
  await assign(clinicId, userId, jose._id, 'HONORARIOS_DOCTORES');

  const data = await svc.buildProjection(clinicId, { from: HOY, to: dia(30) });
  // La suma del detalle proyectado de la categoría = la suma de las celdas de esa categoría.
  const detalleCat = data.detalle
    .filter((r) => !r.esReal && r.day && r.direction === 'EGRESO' && r.category === 'HONORARIOS_DOCTORES')
    .reduce((s, r) => s + r.saldo, 0);
  assert.equal(svc.r2(detalleCat), catTotal(data, 'EGRESO', 'HONORARIOS_DOCTORES'));
  assert.equal(svc.r2(detalleCat), 450, 'las dos CxP de José (300 + 150)');
  // Y no queda ninguna alerta de descuadre detalle↔celdas.
  assert.ok(!data.alertas.some((a) => a.tipo === 'DESCUADRE_DETALLE'));
});
