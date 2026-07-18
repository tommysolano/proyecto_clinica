/**
 * TRAZABILIDAD DESDE EL KARDEX (consulta de la contadora).
 *
 * Verifica los DATOS que consumen los tres accesos de solo lectura del detalle de un movimiento
 * del kardex (Kardex.jsx → InventoryMovementDetailModal):
 *   1. Movimiento de inventario  → la fila del kardex trae todo lo necesario.
 *   2. Movimiento contable        → `journal-entries/by-source` del documento trae el/los asiento(s);
 *      en la VENTA, el asiento incluye el COSTO DE VENTA y la salida de inventario (lo que pedía
 *      la contadora: "quiero ver el asiento del costo").
 *   3. Factura                    → `GET /sales/:id` y `GET /purchase-invoices/:id` devuelven la
 *      factura completa (cabecera, líneas, totales) para el visor de consulta.
 *
 * Se ejerce con los CONTROLLERS reales (los mismos que llama la UI), no con mocks.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const sale = require('../controllers/saleController');
const purchase = require('../controllers/purchaseInvoiceController');
const journal = require('../controllers/journalEntryController');
const kardex = require('../services/kardexService');
const Sale = require('../models/Sale');
const PurchaseInvoice = require('../models/PurchaseInvoice');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const ok = (r, code = 200) => { assert.equal(r.statusCode, code, JSON.stringify(r.payload)); return r.payload; };

test('compra + venta: el kardex enlaza factura y asiento (con el costo de venta) en ambos movimientos', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const prod = await H.makeProduct(clinicId, { category: 'insumo', salePrice: 115, purchasePrice: 40, stock: 0 });
  const sup = await H.makeSupplier(clinicId);

  // ── Compra 10 @ 40 → entrada al inventario + asiento de compra ────────────────────────
  const pr = ok(await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date('2026-06-01'), serie: '001-001-000000501',
    items: [{ description: 'Insumo X', product: prod._id, quantity: 10, unitPrice: 40, ivaRate: 15, subtotal: 400 }],
  })), 201);
  const purchaseId = pr._id;

  // ── Venta 3 @ 115 (contado) → salida + asiento combinado con COGS 3x40=120 ─────────────
  const sr = ok(await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: prod._id, quantity: 3, unitPrice: 115 }], paymentMethod: 'efectivo', date: new Date('2026-06-10'),
  })), 201);
  const saleId = sr._id;

  // ── 1) Kardex: dos filas, cada una con documento y asiento enlazados ──────────────────
  const k = await kardex.buildKardex(clinicId, { product: String(prod._id) });
  const entrada = k.rows.find((r) => r.type === 'entrada');
  const salida = k.rows.find((r) => r.type === 'salida');
  assert.ok(entrada, 'hay una fila de ingreso (compra)');
  assert.ok(salida, 'hay una fila de egreso (venta)');

  assert.deepEqual(
    { model: entrada.documento?.model, ref: String(entrada.documento?.ref) },
    { model: 'PurchaseInvoice', ref: String(purchaseId) },
    'la entrada apunta a la factura de compra',
  );
  assert.ok(entrada.journalEntry, 'la entrada tiene asiento enlazado');
  assert.deepEqual(
    { model: salida.documento?.model, ref: String(salida.documento?.ref) },
    { model: 'Sale', ref: String(saleId) },
    'la salida apunta a la venta',
  );
  assert.ok(salida.journalEntry, 'la salida tiene asiento enlazado (para el botón "Ver asiento")');

  // ── 2) Movimiento contable por documento (by-source, lo que abre el modal) ────────────
  // VENTA: el asiento del documento contiene el COSTO DE VENTA y la salida de inventario.
  const asientosVenta = ok(await H.runController(journal.bySource,
    H.mockReq(clinicId, userId, {}, { query: { model: 'Sale', ref: String(saleId) } })));
  assert.ok(Array.isArray(asientosVenta) && asientosVenta.length >= 1, 'la venta tiene al menos un asiento');
  const lineasVenta = asientosVenta.flatMap((e) => e.lines || []);
  const costo = lineasVenta.find((l) => /Costo venta/i.test(l.description || ''));
  const salidaInv = lineasVenta.find((l) => /Salida inventario/i.test(l.description || ''));
  assert.ok(costo && costo.debit === 120, 'el asiento de la venta muestra el COSTO DE VENTA (débito 120)');
  assert.ok(salidaInv && salidaInv.credit === 120, 'y la salida de inventario (crédito 120)');

  // COMPRA: el asiento del documento contiene el ingreso a inventario.
  const asientosCompra = ok(await H.runController(journal.bySource,
    H.mockReq(clinicId, userId, {}, { query: { model: 'PurchaseInvoice', ref: String(purchaseId) } })));
  const lineasCompra = asientosCompra.flatMap((e) => e.lines || []);
  assert.ok(lineasCompra.some((l) => l.debit === 400), 'el asiento de compra ingresa 400 al inventario');

  // ── 3) Factura de origen para el visor de consulta (endpoints que usa el modal) ───────
  const venta = ok(await H.runController(sale.getSale, H.mockReq(clinicId, userId, {}, { params: { id: String(saleId) } })));
  assert.ok(venta.saleNumber, 'la venta trae su número');
  assert.ok(Array.isArray(venta.items) && venta.items.length === 1, 'la venta trae sus líneas');
  assert.ok(venta.items[0].product?.name || venta.items[0].productName, 'la línea de venta tiene nombre de producto');
  assert.equal(venta.total, 345, 'total de la venta 3x115');

  const compra = ok(await H.runController(purchase.get, H.mockReq(clinicId, userId, {}, { params: { id: String(purchaseId) } })));
  assert.ok(compra.supplier?.razonSocial, 'la compra trae el proveedor (razón social)');
  assert.ok(Array.isArray(compra.items) && compra.items.length === 1, 'la compra trae sus líneas');
  assert.equal(compra.subtotal, 400, 'subtotal de la compra');

  // Consistencia: los ids que el kardex enlaza son los mismos documentos que se previsualizan.
  assert.equal(String(venta._id), String(saleId));
  assert.equal(String(compra._id), String(purchaseId));

  // Sanidad de esquema (que el populate/guardado sigue como espera el visor).
  assert.ok(await Sale.findById(saleId));
  assert.ok(await PurchaseInvoice.findById(purchaseId));
});
