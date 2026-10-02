/**
 * Sincronización de documentos Contífico contra una base real en memoria:
 * alta de venta/compra con cliente, proveedor y producto nuevos; cobro posterior
 * que cierra la CxC; documento retirado del origen que se anula sin borrarse.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('./_integrationHelpers');

const Clinic = require('../models/Clinic');
const Sale = require('../models/Sale');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const Receivable = require('../models/Receivable');
const Payable = require('../models/Payable');
const Patient = require('../models/Patient');
const Supplier = require('../models/Supplier');
const { syncDocumentMonth } = require('../services/contificoDocumentSync');

let batchDir;
test.before(async () => {
  await H.startDb();
  batchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-batches-'));
  process.env.CONTIFICO_BATCH_DIR = batchDir;
});
test.after(async () => {
  await H.stopDb();
  delete process.env.CONTIFICO_BATCH_DIR;
  fs.rmSync(batchDir, { recursive: true, force: true });
});
test.beforeEach(async () => { await H.resetDb(); });

const persons = {
  P1: { id: 'P1', cedula: '0912345678', razon_social: 'PACIENTE PRUEBA', es_cliente: true, es_proveedor: false },
  P2: { id: 'P2', ruc: '0991234567001', razon_social: 'PROVEEDOR PRUEBA', es_cliente: false, es_proveedor: true },
};
const products = {
  PR1: { id: 'PR1', codigo: 'SRV001', nombre: 'Consulta', tipo: 'SERV', pvp1: '100', porcentaje_iva: 15, estado: 'A' },
};
const line = { producto_id: 'PR1', cantidad: '1', precio: '100', base_gravable: '100', base_cero: '0', base_no_gravable: '0', porcentaje_iva: 15 };
const sale = (fields = {}) => ({ id: 'S1', tipo_registro: 'CLI', tipo_documento: 'FAC', documento: '001-001-000000001',
  fecha_emision: '10/09/2026', persona_id: 'P1', total: '115.00', subtotal_12: '100', subtotal_0: '0', iva: '15',
  saldo: '115.00', anulado: false, detalles: [line], cobros: [], cliente: { razon_social: 'PACIENTE PRUEBA', cedula: '0912345678' }, ...fields });
const purchase = (fields = {}) => ({ id: 'C1', tipo_registro: 'PRO', tipo_documento: 'FAC', documento: '001-001-000000777',
  fecha_emision: '12/09/2026', persona_id: 'P2', total: '50.00', iva: '0', saldo: '50.00', anulado: false,
  detalles: [{ ...line, precio: '50', base_gravable: '0', base_cero: '50', porcentaje_iva: 0 }], ...fields });

/** API falsa: listado por mes y consultas por ID, como Contífico. */
function fakeApi(documents) {
  const notFound = (what) => Object.assign(new Error(`Contifico GET ${what}: HTTP 400 - Documento no encontrado.`), { status: 400 });
  return {
    async *pages(_path, _params, _size, stats) {
      Object.assign(stats, { expected: documents.length, unique: documents.length, complete: true });
      yield { rows: documents };
    },
    async get(url) {
      const [, kind, id] = url.match(/\/api\/v2\/(\w+)\/([^/]+)\//) || [];
      const source = { persona: persons, producto: products, documento: Object.fromEntries(documents.map((row) => [row.id, row])) }[kind];
      if (!source?.[id]) throw notFound(url);
      return source[id];
    },
  };
}

test('alta, cobro posterior y baja de documentos quedan reflejados y verificados', async () => {
  const clinic = (await Clinic.create({ name: 'Central' })).toObject();

  const first = await syncDocumentMonth({ clinic, api: fakeApi([sale(), purchase()]), year: 2026, month: 9 });
  assert.equal(first.state, 'SYNCED');
  const created = await Sale.findOne({ idempotencyKey: 'contifico:S1' }).lean();
  assert.equal(created.total, 115);
  assert.equal(created.balance, 115);
  assert.ok(created.patient, 'la venta enlaza al paciente creado desde Contífico');
  assert.equal(await Patient.countDocuments({ cedula: '0912345678' }), 1);
  assert.equal(await Supplier.countDocuments({ ruc: '0991234567001' }), 1);
  assert.equal((await Receivable.findOne({}).lean()).balance, 115);
  assert.equal((await Payable.findOne({}).lean()).balance, 50);

  // Contífico registra el cobro de la venta y elimina la compra.
  const paid = sale({ saldo: '0.00', cobros: [{ forma_cobro: 'EF', monto: '115.00', fecha: '20/09/2026' }] });
  const second = await syncDocumentMonth({ clinic, api: fakeApi([paid]), year: 2026, month: 9 });
  assert.equal(second.state, 'SYNCED');
  assert.equal(second.retired, 1);
  const collected = await Sale.findOne({ idempotencyKey: 'contifico:S1' }).lean();
  assert.equal(collected.balance, 0);
  assert.equal(collected.paid, true);
  const receivable = await Receivable.findOne({}).lean();
  assert.equal(receivable.balance, 0);
  assert.equal(receivable.status, 'PAGADO');
  const retired = await PurchaseInvoice.findOne({}).lean();
  assert.equal(retired.status, 'ANULADA', 'la compra retirada se anula, no se borra');
  assert.equal((await Payable.findOne({}).lean()).status, 'ANULADO');

  const third = await syncDocumentMonth({ clinic, api: fakeApi([paid]), year: 2026, month: 9 });
  assert.equal(third.state, 'CURRENT');
  assert.equal(fs.readdirSync(batchDir).length, 2, 'cada corrida con cambios deja respaldo; la vigente, no');
});
