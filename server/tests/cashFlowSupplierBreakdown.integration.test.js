/**
 * FLUJO DE CAJA · SUBLÍNEAS POR PROVEEDOR (pedido de la contadora: "a quién le debo").
 *
 * Bajo cada categoría de EGRESO, el servicio agrega el detalle por (día, categoría, proveedor).
 * Se verifica sobre los controllers/servicio reales:
 *   a) la suma de las sublíneas de proveedor = la celda de la categoría, en cada columna;
 *   b) un proveedor sin categoría aparece como sublínea bajo «Sin clasificar»;
 *   c) el Excel lleva una fila por proveedor bajo cada categoría, y cuadra con la matriz/JSON;
 *   d) el permiso separa lectura (cashflow.view) de escritura (cashflow.manage);
 *   e) el detalle de celda sigue funcionando y se puede filtrar por proveedor.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const H = require('./_integrationHelpers');

const svc = require('../services/cashFlowService');
const ctrl = require('../controllers/cashFlowController');
const { openPayable } = require('../utils/subledger');
const { getAccount } = require('../utils/accountMap');
const { requireCap, can } = require('../utils/permissions');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const run = (h, req) => H.runController(h, req);
const ok = (r) => { assert.ok(r.statusCode < 400, JSON.stringify(r.payload)); return r.payload; };
const r2 = (n) => +(Number(n) || 0).toFixed(2);

const HOY = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();
const dia = (n) => { const d = new Date(HOY); d.setDate(d.getDate() + n); return d; };

let seq = 0;
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
const assign = (clinicId, userId, supplierId, category) =>
  run(ctrl.assignSupplier, H.mockReq(clinicId, userId, { supplierId: String(supplierId), category }));

// ─────────────────────────────────────────────────────────────────────────────
test('a) sublíneas por proveedor: la suma cuadra con la celda de la categoría en cada columna', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: HOY });
  const jose = await H.makeSupplier(clinicId, { razonSocial: 'José' });
  const pablo = await H.makeSupplier(clinicId, { razonSocial: 'Pablito' });
  const rosa = await H.makeSupplier(clinicId, { razonSocial: 'Rosa' });
  // Dos proveedores en HONORARIOS (en días distintos) y uno en PROVEEDORES.
  await cxp(clinicId, jose, { total: 300, dueDate: dia(3) });
  await cxp(clinicId, pablo, { total: 500, dueDate: dia(6) });
  await cxp(clinicId, rosa, { total: 200, dueDate: dia(3) });
  await assign(clinicId, userId, jose._id, 'HONORARIOS_DOCTORES');
  await assign(clinicId, userId, pablo._id, 'HONORARIOS_DOCTORES');
  await assign(clinicId, userId, rosa._id, 'PROVEEDORES');

  const data = await svc.buildProjection(clinicId, { from: HOY, to: dia(30) });
  const desglose = data.proveedoresPorCategoria;

  // HONORARIOS: dos sublíneas (José 300, Pablito 500), ordenadas por total desc.
  const hon = desglose.HONORARIOS_DOCTORES;
  assert.equal(hon.length, 2, 'dos proveedores en Honorarios');
  assert.deepEqual(hon.map((p) => p.name), ['Pablito', 'José'], 'ordenadas por total desc');
  assert.equal(hon.find((p) => p.name === 'José').total, 300);
  assert.equal(hon.find((p) => p.name === 'Pablito').total, 500);
  // PROVEEDORES: una sublínea (Rosa 200).
  assert.equal(desglose.PROVEEDORES.length, 1);
  assert.equal(desglose.PROVEEDORES[0].name, 'Rosa');

  // INVARIANTE: por cada día, la suma de las sublíneas = la celda de la categoría.
  for (const cat of ['HONORARIOS_DOCTORES', 'PROVEEDORES']) {
    for (const d of data.days) {
      const celda = r2(d.categorias?.EGRESO?.[cat]?.total || 0);
      const subs = r2((desglose[cat] || []).reduce((s, p) => s + (p.byDay?.[d.date] || 0), 0));
      assert.equal(subs, celda, `sublíneas=celda en ${cat} el ${d.date}`);
    }
  }
  // Invariante global: la suma de TODAS las sublíneas = total de egresos proyectados.
  const totalSubs = r2(Object.values(desglose).flat().reduce((s, p) => s + p.total, 0));
  assert.equal(totalSubs, r2(data.totales.egresos), 'suma de sublíneas = total egresos');
  assert.equal(totalSubs, 1000, '300 + 500 + 200');
});

// ─────────────────────────────────────────────────────────────────────────────
test('b) un proveedor sin categoría aparece como sublínea bajo «Sin clasificar»', async () => {
  const { clinicId } = await H.seedClinic({ date: HOY });
  const pepe = await H.makeSupplier(clinicId, { razonSocial: 'Pepito (sin clasificar)' });
  await cxp(clinicId, pepe, { total: 250 });

  const data = await svc.buildProjection(clinicId, { from: HOY, to: dia(30) });
  const sinClasif = data.proveedoresPorCategoria.SIN_CLASIFICAR;
  assert.ok(sinClasif, 'hay sublíneas en SIN_CLASIFICAR');
  assert.equal(sinClasif.length, 1);
  assert.equal(sinClasif[0].name, 'Pepito (sin clasificar)');
  assert.equal(sinClasif[0].total, 250);
  // Y aparece como pendiente de clasificar (recuadro de la derecha).
  assert.deepEqual(data.proveedoresPendientes.map((p) => p.name), ['Pepito (sin clasificar)']);
});

// ─────────────────────────────────────────────────────────────────────────────
test('c) el Excel lleva una fila por proveedor bajo cada categoría y cuadra con la matriz', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: HOY });
  const jose = await H.makeSupplier(clinicId, { razonSocial: 'José' });
  const pablo = await H.makeSupplier(clinicId, { razonSocial: 'Pablito' });
  await cxp(clinicId, jose, { total: 300, dueDate: dia(3) });
  await cxp(clinicId, pablo, { total: 500, dueDate: dia(6) });
  await assign(clinicId, userId, jose._id, 'HONORARIOS_DOCTORES');
  await assign(clinicId, userId, pablo._id, 'HONORARIOS_DOCTORES');

  // Genera el Excel (captura el buffer que manda res.send).
  let buf = null;
  const res = {
    setHeader() {},
    send(b) { buf = b; },
    status(code) { return { json: (p) => { throw new Error(`Excel ${code}: ${p.message}`); } }; },
  };
  await ctrl.projectionExcel(H.mockReq(clinicId, userId, {}, { query: { from: `${HOY.getFullYear()}-${String(HOY.getMonth() + 1).padStart(2, '0')}-${String(HOY.getDate()).padStart(2, '0')}` } }), res);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.getWorksheet('Flujo');

  // Recolecta las filas por etiqueta y sus valores numéricos por columna.
  const filas = [];
  ws.eachRow((row) => {
    const label = row.getCell(1).value;
    if (typeof label !== 'string') return;
    const vals = [];
    for (let i = 2; i <= ws.columnCount; i += 1) {
      const v = row.getCell(i).value;
      vals.push(typeof v === 'number' ? v : 0);
    }
    filas.push({ label: label.trim(), vals });
  });

  const catRow = filas.find((f) => f.label === 'Honorarios de doctores');
  assert.ok(catRow, 'existe la fila de la categoría en el Excel');
  const provJose = filas.find((f) => f.label.includes('José') && f.label.includes('↳'));
  const provPablo = filas.find((f) => f.label.includes('Pablito') && f.label.includes('↳'));
  assert.ok(provJose && provPablo, 'las filas de proveedor (con ↳) están bajo la categoría');

  // Columna a columna: la suma de las filas de proveedor = la fila de la categoría.
  for (let i = 0; i < catRow.vals.length; i += 1) {
    assert.equal(r2(provJose.vals[i] + provPablo.vals[i]), r2(catRow.vals[i]), `Excel: proveedores=categoría col ${i}`);
  }
  assert.equal(r2(provJose.vals.reduce((s, v) => s + v, 0)), 300, 'total José en el Excel');
  assert.equal(r2(provPablo.vals.reduce((s, v) => s + v, 0)), 500, 'total Pablito en el Excel');

  // Y cuadra con el JSON de la proyección.
  const data = await svc.buildProjection(clinicId, { from: HOY, to: dia(30) });
  const totalCatJson = r2((data.proveedoresPorCategoria.HONORARIOS_DOCTORES || []).reduce((s, p) => s + p.total, 0));
  assert.equal(totalCatJson, 800, 'JSON = Excel = matriz');
});

// ─────────────────────────────────────────────────────────────────────────────
test('d) permisos: cashflow.view (solo lectura) puede leer pero NO configurar', () => {
  // Capacidades por rol.
  assert.equal(can('admin', 'cashflow.view'), true);
  assert.equal(can('admin', 'cashflow.manage'), true);
  assert.equal(can('contabilidad', 'cashflow.view'), true);
  assert.equal(can('contabilidad', 'cashflow.manage'), true);
  assert.equal(can('cajero', 'cashflow.view'), true, 'la caja SOLO visualiza');
  assert.equal(can('cajero', 'cashflow.manage'), false, 'pero no configura');
  assert.equal(can('marketing', 'cashflow.view'), false, 'un rol sin acceso no ve el flujo');

  // El middleware de las rutas: lectura pasa, escritura da 403 para el rol de solo-lectura.
  const callMw = (mw, role) => {
    let status = 200; let nexted = false; let payload = null;
    const res = { status(c) { status = c; return { json(p) { payload = p; } }; } };
    mw({ role, user: {} }, res, () => { nexted = true; });
    return { status, nexted, payload };
  };
  assert.equal(callMw(requireCap('cashflow.view'), 'cajero').nexted, true, 'view: la proyección/Excel se leen');
  const manage = callMw(requireCap('cashflow.manage'), 'cajero');
  assert.equal(manage.nexted, false);
  assert.equal(manage.status, 403, 'manage: asignar proveedor/saldo/partidas/overrides → 403');
  assert.equal(callMw(requireCap('cashflow.manage'), 'contabilidad').nexted, true, 'contabilidad sí configura');
});

// ─────────────────────────────────────────────────────────────────────────────
test('e) el detalle de celda sigue funcionando y se puede filtrar por proveedor', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: HOY });
  const jose = await H.makeSupplier(clinicId, { razonSocial: 'José' });
  const pablo = await H.makeSupplier(clinicId, { razonSocial: 'Pablito' });
  await cxp(clinicId, jose, { total: 300, dueDate: dia(3) });
  await cxp(clinicId, pablo, { total: 500, dueDate: dia(3) });
  await assign(clinicId, userId, jose._id, 'HONORARIOS_DOCTORES');
  await assign(clinicId, userId, pablo._id, 'HONORARIOS_DOCTORES');

  const data = await svc.buildProjection(clinicId, { from: HOY, to: dia(30) });
  const dayKey = data.proveedoresPorCategoria.HONORARIOS_DOCTORES[0].byDay
    && Object.keys(data.proveedoresPorCategoria.HONORARIOS_DOCTORES.find((p) => p.name === 'José').byDay)[0];
  const from = `${HOY.getFullYear()}-${String(HOY.getMonth() + 1).padStart(2, '0')}-${String(HOY.getDate()).padStart(2, '0')}`;

  // Celda de la categoría (como hoy): 800.
  const full = ok(await run(ctrl.cellDetail, H.mockReq(clinicId, userId, {}, { query: {
    from, date: dayKey, direction: 'EGRESO', category: 'HONORARIOS_DOCTORES',
  } })));
  assert.equal(full.total, 800, 'la celda muestra las dos CxP');

  // Filtrado por proveedor (clic en la sublínea): solo José (300).
  const soloJose = ok(await run(ctrl.cellDetail, H.mockReq(clinicId, userId, {}, { query: {
    from, date: dayKey, direction: 'EGRESO', category: 'HONORARIOS_DOCTORES', party: 'José',
  } })));
  assert.equal(soloJose.total, 300, 'el detalle filtrado por proveedor muestra solo lo suyo');
  assert.ok(soloJose.rows.every((row) => String(row.tercero).includes('José')));
});
