/**
 * ESTADO DE RESULTADOS EN COLUMNAS: por MES, por CENTRO DE COSTO y por SEDE.
 *
 * El contador lee el reporte como una hoja con una columna por mes (o por centro de
 * costo) y el total a la derecha. Lo que se comprueba aquí es que esas columnas SUMAN
 * exactamente el total —si no, el reporte miente— y que el movimiento sin centro de
 * costo aparece en su propia columna en vez de desaparecer.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const reports = require('../controllers/accountingReportsController');
const { createEntry } = require('../utils/accounting');
const ChartOfAccount = require('../models/ChartOfAccount');
const CostCenter = require('../models/CostCenter');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const d = (s) => new Date(`${s}T12:00:00`);

const pedir = (clinicId, userId, query) => H.runController(
  reports.incomeStatement,
  H.mockReq(clinicId, userId, {}, { query, user: { _id: userId, clinics: [{ clinic: clinicId }] } })
);

/** Asiento simple ingreso/caja por `monto` en la fecha dada, con centro opcional. */
async function venta(clinicId, userId, { fecha, monto, costCenter = null }) {
  const caja = await ChartOfAccount.findOne({ clinic: clinicId, code: '1.1.01.01' });
  const ingreso = await ChartOfAccount.findOne({ clinic: clinicId, code: '4.1.01' });
  return createEntry({
    clinicId,
    date: d(fecha),
    description: `Venta ${fecha}`,
    source: 'VENTA',
    lines: [
      { account: caja._id, debit: monto, credit: 0, costCenter },
      { account: ingreso._id, debit: 0, credit: monto, costCenter },
    ],
    userId,
  });
}

/** Asiento de gasto por `monto`, con centro opcional. */
async function gasto(clinicId, userId, { fecha, monto, costCenter = null }) {
  const caja = await ChartOfAccount.findOne({ clinic: clinicId, code: '1.1.01.01' });
  const g = await ChartOfAccount.findOne({ clinic: clinicId, code: '6.1.99' });
  return createEntry({
    clinicId,
    date: d(fecha),
    description: `Gasto ${fecha}`,
    source: 'AJUSTE',
    lines: [
      { account: g._id, debit: monto, credit: 0, costCenter },
      { account: caja._id, debit: 0, credit: monto, costCenter },
    ],
    userId,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
test('por MES: una columna por mes del rango y las columnas suman el total', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: d('2026-01-15') });
  await venta(clinicId, userId, { fecha: '2026-01-20', monto: 100 });
  await venta(clinicId, userId, { fecha: '2026-02-10', monto: 250 });
  await gasto(clinicId, userId, { fecha: '2026-02-11', monto: 40 });

  const r = await pedir(clinicId, userId, { startDate: '2026-01-01', endDate: '2026-03-31', breakdown: 'month' });
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  const p = r.payload;

  assert.deepEqual(p.columns.map((c) => c.label), ['ENERO', 'FEBRERO', 'MARZO']);
  assert.equal(p.porColumna['2026-01'].totalIngresos, 100);
  assert.equal(p.porColumna['2026-02'].totalIngresos, 250);
  assert.equal(p.porColumna['2026-02'].totalGastos, 40);
  assert.equal(p.porColumna['2026-03'].totalIngresos, 0, 'un mes sin movimiento sale en cero, no desaparece');

  // Lo que hace creíble el reporte: la suma horizontal cuadra con el total.
  const suma = p.columns.reduce((s, c) => s + p.porColumna[c.key].totalIngresos, 0);
  assert.equal(+suma.toFixed(2), p.totalIngresos);
  assert.equal(p.totalIngresos, 350);
  assert.equal(p.utilidadOperacional, 310);

  // El árbol lleva el importe de cada columna en cada nodo (y también en los grupos).
  const raizIngresos = p.tree.find((n) => n.type === 'INGRESO');
  assert.equal(raizIngresos.values['2026-01'], 100);
  assert.equal(raizIngresos.values['2026-02'], 250);
  assert.equal(raizIngresos.total, 350);
});

test('por CENTRO DE COSTO: cada centro en su columna y lo que no tiene, en "Sin centro de costos"', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: d('2026-05-01') });
  const norte = await CostCenter.create({ clinic: clinicId, code: 'CC1', name: 'Sede Norte' });
  const sur = await CostCenter.create({ clinic: clinicId, code: 'CC2', name: 'Sede Sur' });

  await venta(clinicId, userId, { fecha: '2026-05-05', monto: 300, costCenter: norte._id });
  await venta(clinicId, userId, { fecha: '2026-05-06', monto: 200, costCenter: sur._id });
  await venta(clinicId, userId, { fecha: '2026-05-07', monto: 50 }); // sin centro

  const r = await pedir(clinicId, userId, { startDate: '2026-05-01', endDate: '2026-05-31', breakdown: 'costCenter' });
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  const p = r.payload;

  const etiquetas = p.columns.map((c) => c.label);
  assert.deepEqual(etiquetas, ['CC1 Sede Norte', 'CC2 Sede Sur', 'Sin centro de costos']);
  assert.equal(p.porColumna[String(norte._id)].totalIngresos, 300);
  assert.equal(p.porColumna[String(sur._id)].totalIngresos, 200);
  const sinCentro = p.columns.find((c) => c.label === 'Sin centro de costos').key;
  assert.equal(p.porColumna[sinCentro].totalIngresos, 50, 'el movimiento sin centro se ve, no se pierde');
  assert.equal(p.totalIngresos, 550);
});

test('un centro de costo SIN movimiento no ocupa columna', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: d('2026-05-01') });
  const usado = await CostCenter.create({ clinic: clinicId, code: 'CC1', name: 'Con movimiento' });
  await CostCenter.create({ clinic: clinicId, code: 'CC9', name: 'Nunca usado' });
  await venta(clinicId, userId, { fecha: '2026-05-05', monto: 120, costCenter: usado._id });

  const r = await pedir(clinicId, userId, { startDate: '2026-05-01', endDate: '2026-05-31', breakdown: 'costCenter' });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.payload.columns.map((c) => c.label), ['CC1 Con movimiento']);
});

test('el margen por columna es la utilidad sobre las ventas de ESA columna', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: d('2026-01-15') });
  await venta(clinicId, userId, { fecha: '2026-01-20', monto: 1000 });
  await gasto(clinicId, userId, { fecha: '2026-01-21', monto: 250 });
  await venta(clinicId, userId, { fecha: '2026-02-20', monto: 400 });
  await gasto(clinicId, userId, { fecha: '2026-02-21', monto: 400 });

  const r = await pedir(clinicId, userId, { startDate: '2026-01-01', endDate: '2026-02-28', breakdown: 'month' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.payload.porColumna['2026-01'].margen, 75, '750 de 1000');
  assert.equal(r.payload.porColumna['2026-02'].margen, 0, 'gastó todo lo que vendió');
});

test('sin desglose el reporte sigue siendo el de siempre (una sola cifra por cuenta)', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: d('2026-01-15') });
  await venta(clinicId, userId, { fecha: '2026-01-20', monto: 100 });

  const r = await pedir(clinicId, userId, { startDate: '2026-01-01', endDate: '2026-01-31' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.payload.breakdown, 'none');
  assert.deepEqual(r.payload.columns, []);
  assert.equal(r.payload.totalIngresos, 100);
});

// ─────────────────────────────────────────────────────────────────────────────
test('costos y gastos colgados de la MISMA raíz salen cada uno en su sección', async () => {
  // El plan que llegó de Contífico cuelga los costos (5.1) y los gastos (5.2) de
  // la raíz 5, que está tipada como COSTO. Repartir las secciones por el tipo de
  // la raíz metía el grupo 5 entero en "Costo de ventas" y dejaba "Gastos
  // operativos" vacío pero con total: el reporte se contradecía solo.
  const { clinicId, userId } = await H.seedClinic({ date: d('2026-03-15') });
  await ChartOfAccount.create([
    { clinic: clinicId, code: '5.2', name: 'Gastos', type: 'GASTO', nature: 'DEBITO', level: 2, allowsMovement: false, active: true },
    { clinic: clinicId, code: '5.2.1', name: 'Gastos de Actividades Ordinarias', type: 'GASTO', nature: 'DEBITO', level: 3, allowsMovement: true, active: true },
  ]);
  const caja = await ChartOfAccount.findOne({ clinic: clinicId, code: '1.1.01.01' });
  const costo = await ChartOfAccount.findOne({ clinic: clinicId, code: '5.1.01' });
  const gastoOrdinario = await ChartOfAccount.findOne({ clinic: clinicId, code: '5.2.1' });
  await venta(clinicId, userId, { fecha: '2026-03-20', monto: 1000 });
  await createEntry({ clinicId, date: d('2026-03-21'), description: 'Costo', source: 'AJUSTE', userId,
    lines: [{ account: costo._id, debit: 300, credit: 0 }, { account: caja._id, debit: 0, credit: 300 }] });
  await createEntry({ clinicId, date: d('2026-03-22'), description: 'Gasto ordinario', source: 'AJUSTE', userId,
    lines: [{ account: gastoOrdinario._id, debit: 120, credit: 0 }, { account: caja._id, debit: 0, credit: 120 }] });

  const r = await pedir(clinicId, userId, { startDate: '2026-03-01', endDate: '2026-03-31' });
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  const p = r.payload;
  assert.equal(p.totalCostos, 300);
  assert.equal(p.totalGastos, 120);

  const seccion = (tipo) => p.tree.filter((n) => n.type === tipo);
  const suma = (nodes) => +nodes.reduce((acc, n) => acc + n.total, 0).toFixed(2);
  // Cada sección trae cuentas y cuadra con SU propio total: ni una vacía con
  // saldo, ni una que se lleve el importe de la otra.
  assert.ok(seccion('COSTO').length, 'la sección de costos quedó vacía');
  assert.ok(seccion('GASTO').length, 'la sección de gastos quedó vacía');
  assert.equal(suma(seccion('COSTO')), p.totalCostos);
  assert.equal(suma(seccion('GASTO')), p.totalGastos);
  assert.equal(suma(seccion('INGRESO')), p.totalIngresos);

  // Y ninguna cuenta de gasto se cuela en el árbol de costos.
  const codigos = (nodes, out = []) => { for (const n of nodes) { out.push(n.code); codigos(n.children || [], out); } return out; };
  assert.ok(!codigos(seccion('COSTO')).includes('5.2.1'));
  assert.ok(codigos(seccion('GASTO')).includes('5.2.1'));
});
