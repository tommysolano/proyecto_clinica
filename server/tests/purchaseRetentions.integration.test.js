/**
 * Retenciones por LÍNEA basadas en catálogo (RetentionRule): el backend recalcula
 * base/monto/cuenta desde la regla (ignora lo que envíe el frontend), deriva la cabecera
 * agrupada, contabiliza reduciendo CxP y acreditando retenciones por pagar, y alimenta
 * los reportes SRI. Incluye compatibilidad legacy (retención manual de cabecera) sin
 * doble conteo.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const purchase = require('../controllers/purchaseInvoiceController');
const reports = require('../controllers/accountingReportsController');
const ChartOfAccount = require('../models/ChartOfAccount');
const InventoryCategory = require('../models/InventoryCategory');
const RetentionRule = require('../models/RetentionRule');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const Payable = require('../models/Payable');
const JournalEntry = require('../models/JournalEntry');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function setup() {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-01') });
  const gasto = await ChartOfAccount.findOne({ clinic: clinicId, code: '6.1.99' });
  const invAcc = await ChartOfAccount.findOne({ clinic: clinicId, code: '1.1.04.01' });
  const invCat = await InventoryCategory.create({ clinic: clinicId, code: 'INV', name: 'Insumos', kind: 'INVENTARIO', assetAccount: invAcc._id });
  const retRentaAcc = await ChartOfAccount.findOne({ clinic: clinicId, code: '2.1.02.04' });
  const retIvaAcc = await ChartOfAccount.findOne({ clinic: clinicId, code: '2.1.02.03' });
  // Reglas de catálogo (rates limpios para asserts): sin payableAccount → fallback por rol.
  const ruleBienes = await RetentionRule.create({ clinic: clinicId, type: 'RENTA', code: '312', description: 'Compra de bienes', rate: 2, appliesTo: 'BIENES', baseType: 'SUBTOTAL_TOTAL' });
  const ruleTransp = await RetentionRule.create({ clinic: clinicId, type: 'RENTA', code: '310', description: 'Transporte', rate: 1, appliesTo: 'TRANSPORTE', baseType: 'SUBTOTAL_TOTAL' });
  const ruleIva = await RetentionRule.create({ clinic: clinicId, type: 'IVA', code: '721', description: 'Retención IVA 30%', rate: 30, appliesTo: 'BIENES', baseType: 'IVA' });
  return { clinicId, userId, gasto, invAcc, invCat, retRentaAcc, retIvaAcc, ruleBienes, ruleTransp, ruleIva };
}

const invLine = (product, ret, qty = 10, price = 5, ivaRate = 0) => ({ description: 'Insumo', lineType: 'INVENTARIO', product, quantity: qty, unitPrice: price, ivaRate, subtotal: qty * price, retention: ret });
const gastoLine = (acc, ret, val = 100, ivaRate = 0) => ({ description: 'Transporte', lineType: 'GASTO', quantity: 1, unitPrice: val, ivaRate, subtotal: val, account: acc, retention: ret });

// ─────────────────────────────────────────────────────────────────────────────
test('1) inventario con retención 2%: calcula base y monto automáticamente', async () => {
  const { clinicId, userId, invCat, ruleBienes } = await setup();
  const sup = await H.makeSupplier(clinicId);
  const prod = await H.makeProduct(clinicId, { category: 'insumo', stock: 0, inventoryCategory: invCat._id });
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date('2026-06-05'),
    items: [invLine(prod._id, { rule: String(ruleBienes._id) }, 10, 5, 0)],
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const inv = await PurchaseInvoice.findById(r.payload._id);
  const ret = inv.items[0].retention;
  assert.equal(ret.base, 50);
  assert.equal(ret.rate, 2);
  assert.equal(ret.amount, 1);
  assert.equal(String(ret.code), '312');
  assert.equal(inv.retentionTotal, 1);
  assert.equal(inv.balance, 49);
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.04.01'), 50);
  assert.equal(await H.accountBalanceByCode(clinicId, '2.1.02.04'), -1, 'retención renta por pagar');
  assert.equal(await H.accountBalanceByCode(clinicId, '2.1.01.01'), -49, 'CxP neto');
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

// ─────────────────────────────────────────────────────────────────────────────
test('2) gasto transporte con retención 1%: código distinto en la misma factura', async () => {
  const { clinicId, userId, gasto, ruleTransp } = await setup();
  const sup = await H.makeSupplier(clinicId);
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date('2026-06-05'),
    items: [gastoLine(gasto._id, { code: '310', type: 'RENTA' }, 100, 0)],
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const inv = await PurchaseInvoice.findById(r.payload._id);
  assert.equal(inv.items[0].retention.amount, 1);
  assert.equal(inv.items[0].retention.code, '310');
  assert.equal(inv.retentionTotal, 1);
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

// ─────────────────────────────────────────────────────────────────────────────
test('3) compra mixta con dos retenciones: resumen agrupado correcto', async () => {
  const { clinicId, userId, gasto, invCat, ruleBienes, ruleTransp } = await setup();
  const sup = await H.makeSupplier(clinicId);
  const prod = await H.makeProduct(clinicId, { category: 'insumo', stock: 0, inventoryCategory: invCat._id });
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date('2026-06-05'),
    items: [
      invLine(prod._id, { rule: String(ruleBienes._id) }, 10, 5, 0),        // 312: base 50, ret 1
      gastoLine(gasto._id, { rule: String(ruleTransp._id) }, 100, 0),        // 310: base 100, ret 1
    ],
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const inv = await PurchaseInvoice.findById(r.payload._id);
  assert.equal(inv.retentions.length, 2, 'resumen agrupado por código');
  const r312 = inv.retentions.find((x) => x.code === '312');
  const r310 = inv.retentions.find((x) => x.code === '310');
  assert.equal(r312.baseAmount, 50); assert.equal(r312.amount, 1);
  assert.equal(r310.baseAmount, 100); assert.equal(r310.amount, 1);
  assert.equal(inv.retentionTotal, 2);
  // retentionSummary (virtual) expone la forma con base/rate/account.
  const summary = inv.toJSON().retentionSummary;
  assert.equal(summary.length, 2);
  assert.ok(summary.every((s) => s.account));
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

// ─────────────────────────────────────────────────────────────────────────────
test('4) backend ignora base/porcentaje/monto falsos enviados por el frontend', async () => {
  const { clinicId, userId, invCat, ruleBienes } = await setup();
  const sup = await H.makeSupplier(clinicId);
  const prod = await H.makeProduct(clinicId, { category: 'insumo', stock: 0, inventoryCategory: invCat._id });
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date('2026-06-05'),
    items: [invLine(prod._id, { rule: String(ruleBienes._id), base: 9999, baseAmount: 9999, rate: 99, percentage: 99, amount: 9999 }, 10, 5, 0)],
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const inv = await PurchaseInvoice.findById(r.payload._id);
  assert.equal(inv.items[0].retention.base, 50, 'recalcula base real');
  assert.equal(inv.items[0].retention.rate, 2, 'usa rate de la regla');
  assert.equal(inv.items[0].retention.amount, 1, 'recalcula monto real');
  assert.equal(inv.retentionTotal, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
test('5) regla inactiva falla', async () => {
  const { clinicId, userId, gasto } = await setup();
  const sup = await H.makeSupplier(clinicId);
  const inactive = await RetentionRule.create({ clinic: clinicId, type: 'RENTA', code: '399', description: 'Inactiva', rate: 5, baseType: 'SUBTOTAL_TOTAL', active: false });
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date('2026-06-05'),
    items: [gastoLine(gasto._id, { rule: String(inactive._id) }, 100, 0)],
  }));
  assert.equal(r.statusCode, 400, JSON.stringify(r.payload));
  assert.match(r.payload.message, /inactiva/i);
});

// ─────────────────────────────────────────────────────────────────────────────
test('6) regla con cuenta de retención inválida (otra clínica) falla', async () => {
  const { clinicId, userId, gasto } = await setup();
  const sup = await H.makeSupplier(clinicId);
  const otherClinic = new H.mongoose.Types.ObjectId();
  const foreignAcc = await ChartOfAccount.create({ clinic: otherClinic, code: '2.1.02.04', name: 'Ret (otra)', type: 'PASIVO', nature: 'CREDITO', allowsMovement: true });
  const badRule = await RetentionRule.create({ clinic: clinicId, type: 'RENTA', code: '398', rate: 2, baseType: 'SUBTOTAL_TOTAL', payableAccount: foreignAcc._id });
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date('2026-06-05'),
    items: [gastoLine(gasto._id, { rule: String(badRule._id) }, 100, 0)],
  }));
  assert.equal(r.statusCode, 400, JSON.stringify(r.payload));
  assert.match(r.payload.message, /cuenta de retención/i);
});

// ─────────────────────────────────────────────────────────────────────────────
test('7) asiento cuadra: inventario + IVA al debe; CxP neto + retenciones al haber', async () => {
  const { clinicId, userId, invCat, ruleBienes } = await setup();
  const sup = await H.makeSupplier(clinicId);
  const prod = await H.makeProduct(clinicId, { category: 'insumo', stock: 0, inventoryCategory: invCat._id });
  // Inventario 100 + IVA 15 = 115. Retención renta 2% de 100 = 2 (código 312).
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date('2026-06-05'),
    items: [{ description: 'Insumo', lineType: 'INVENTARIO', product: prod._id, quantity: 10, unitPrice: 10, ivaRate: 15, subtotal: 100, retention: { rule: String(ruleBienes._id) } }],
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const inv = await PurchaseInvoice.findById(r.payload._id);
  assert.equal(inv.iva, 15);
  assert.equal(inv.total, 115);
  assert.equal(inv.retentionTotal, 2, 'renta 2% de 100');
  assert.equal(inv.balance, 113);
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.04.01'), 100, 'inventario al debe');
  assert.equal(await H.accountBalanceByCode(clinicId, '2.1.02.04'), -2, 'retención renta al haber');
  assert.equal(await H.accountBalanceByCode(clinicId, '2.1.01.01'), -113, 'CxP neto (115 - 2)');
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

// ─────────────────────────────────────────────────────────────────────────────
test('8) CxP (Payable) queda por el neto después de retenciones', async () => {
  const { clinicId, userId, invCat, ruleBienes } = await setup();
  const sup = await H.makeSupplier(clinicId);
  const prod = await H.makeProduct(clinicId, { category: 'insumo', stock: 0, inventoryCategory: invCat._id });
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date('2026-06-05'),
    items: [invLine(prod._id, { rule: String(ruleBienes._id) }, 10, 5, 0)], // total 50, ret 1 → neto 49
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const pay = await Payable.findOne({ clinic: clinicId, sourceModel: 'PurchaseInvoice', sourceRef: r.payload._id });
  assert.ok(pay, 'debe existir CxP');
  assert.equal(pay.total, 49, 'CxP por el neto');
  assert.equal(pay.balance, 49);
});

// ─────────────────────────────────────────────────────────────────────────────
test('9) la retención aparece en el mayor con origen COMPRA', async () => {
  const { clinicId, userId, invCat, ruleBienes, retRentaAcc } = await setup();
  const sup = await H.makeSupplier(clinicId);
  const prod = await H.makeProduct(clinicId, { category: 'insumo', stock: 0, inventoryCategory: invCat._id });
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date('2026-06-05'),
    items: [invLine(prod._id, { rule: String(ruleBienes._id) }, 10, 5, 0)],
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const entry = await JournalEntry.findOne({ clinic: clinicId, source: 'COMPRA', sourceRef: r.payload._id });
  assert.ok(entry, 'existe asiento de compra');
  assert.equal(entry.sourceModel, 'PurchaseInvoice');
  const retLine = entry.lines.find((l) => String(l.account) === String(retRentaAcc._id) && l.credit > 0);
  assert.ok(retLine, 'el asiento incluye la retención por pagar');
  assert.equal(retLine.credit, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
test('10) el Formulario 103 toma las retenciones por línea', async () => {
  const { clinicId, userId, gasto, invCat, ruleBienes, ruleTransp } = await setup();
  const sup = await H.makeSupplier(clinicId);
  const prod = await H.makeProduct(clinicId, { category: 'insumo', stock: 0, inventoryCategory: invCat._id });
  await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date('2026-06-15'),
    items: [invLine(prod._id, { rule: String(ruleBienes._id) }, 10, 5, 0), gastoLine(gasto._id, { rule: String(ruleTransp._id) }, 100, 0)],
  }));
  const res = await H.runController(reports.form103, H.mockReq(clinicId, userId, {}, { query: { year: '2026', month: '6' } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  const rows = res.payload.rows;
  const r312 = rows.find((x) => x.code === '312');
  const r310 = rows.find((x) => x.code === '310');
  assert.ok(r312 && r310, 'ambos códigos RENTA en el 103');
  assert.equal(r312.amount, 1);
  assert.equal(r310.amount, 1);
  assert.equal(res.payload.total, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
test('11) compra legacy con retención de cabecera sigue funcionando', async () => {
  const { clinicId, userId, gasto } = await setup();
  const sup = await H.makeSupplier(clinicId);
  // Factura legacy REGISTRADA (sin strictAccounts) con retención MANUAL de cabecera y sin retención por línea.
  const legacy = await PurchaseInvoice.create({
    clinic: clinicId, supplier: sup._id, fechaEmision: new Date('2026-06-05'), serie: '001-001-000000900',
    items: [{ description: 'Servicio', lineType: 'GASTO', account: gasto._id, quantity: 1, unitPrice: 100, subtotal: 100, ivaRate: 0 }],
    retentions: [{ type: 'RENTA', code: '312', description: 'Bienes', baseAmount: 100, percentage: 2, amount: 2 }],
    subtotal: 100, total: 100, retentionTotal: 2, balance: 98, status: 'REGISTRADA',
  });
  const upd = await H.runController(purchase.update, H.mockReq(clinicId, userId, {
    fechaEmision: new Date('2026-06-05'),
    items: [{ description: 'Servicio', lineType: 'GASTO', account: gasto._id, quantity: 1, unitPrice: 100, subtotal: 100, ivaRate: 0 }],
    retentions: [{ type: 'RENTA', code: '312', description: 'Bienes', baseAmount: 100, percentage: 2, amount: 2 }],
  }, { params: { id: String(legacy._id) } }));
  assert.equal(upd.statusCode, 200, JSON.stringify(upd.payload));
  const inv = await PurchaseInvoice.findById(legacy._id);
  assert.equal(inv.retentionTotal, 2, 'conserva retención de cabecera legacy');
  assert.equal(inv.balance, 98);
  assert.equal(await H.accountBalanceByCode(clinicId, '2.1.02.04'), -2, 'contabiliza por rol (cuenta legacy nula)');
  assert.equal(await H.accountBalanceByCode(clinicId, '2.1.01.01'), -98);
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

// ─────────────────────────────────────────────────────────────────────────────
test('12) sin doble conteo si llegan retención de cabecera Y por línea (nueva)', async () => {
  const { clinicId, userId, gasto, ruleTransp } = await setup();
  const sup = await H.makeSupplier(clinicId);
  // Compra NUEVA: el cliente manda ADEMÁS una cabecera manual falsa; debe ignorarse.
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date('2026-06-05'),
    retentions: [{ type: 'RENTA', code: 'XXX', baseAmount: 100, percentage: 50, amount: 50 }], // cabecera manual falsa
    items: [gastoLine(gasto._id, { rule: String(ruleTransp._id) }, 100, 0)], // línea 310: ret 1
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const inv = await PurchaseInvoice.findById(r.payload._id);
  assert.equal(inv.retentionTotal, 1, 'solo cuenta la retención por línea (no la cabecera manual)');
  assert.equal(inv.retentions.length, 1);
  assert.equal(inv.retentions[0].code, '310');
  assert.equal(await H.accountBalanceByCode(clinicId, '2.1.02.04'), -1);
  assert.equal(await H.accountBalanceByCode(clinicId, '2.1.01.01'), -99, 'CxP = 100 - 1');
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

// ── Múltiples retenciones por línea (RENTA + IVA) ──────────────────────────────
test('13) una línea con RENTA + IVA: calcula ambas, CxP neto y asiento cuadran', async () => {
  const { clinicId, userId, invCat, ruleBienes, ruleIva } = await setup();
  const sup = await H.makeSupplier(clinicId);
  const prod = await H.makeProduct(clinicId, { category: 'insumo', stock: 0, inventoryCategory: invCat._id });
  // Inventario 100 + IVA 15. Renta 2% de 100 = 2; IVA 30% de 15 = 4.5. CxP = 108.5.
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date('2026-06-05'),
    items: [{ description: 'Insumo', lineType: 'INVENTARIO', product: prod._id, quantity: 10, unitPrice: 10, ivaRate: 15, subtotal: 100,
      retentions: [{ rule: String(ruleBienes._id) }, { rule: String(ruleIva._id) }] }],
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const inv = await PurchaseInvoice.findById(r.payload._id);
  assert.equal(inv.items[0].retentions.length, 2, 'dos retenciones en la línea');
  assert.equal(inv.retentionTotal, 6.5);
  assert.equal(inv.balance, 108.5);
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.04.01'), 100);
  assert.equal(await H.accountBalanceByCode(clinicId, '2.1.02.04'), -2, 'retención renta');
  assert.equal(await H.accountBalanceByCode(clinicId, '2.1.02.03'), -4.5, 'retención IVA');
  assert.equal(await H.accountBalanceByCode(clinicId, '2.1.01.01'), -108.5, 'CxP neto = 115 - 6.5');
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

// ─────────────────────────────────────────────────────────────────────────────
test('14) resumen agrupa retenciones de varias líneas por type/code', async () => {
  const { clinicId, userId, gasto, invCat, ruleBienes, ruleTransp, ruleIva } = await setup();
  const sup = await H.makeSupplier(clinicId);
  const prod = await H.makeProduct(clinicId, { category: 'insumo', stock: 0, inventoryCategory: invCat._id });
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date('2026-06-05'),
    items: [
      { description: 'Insumo', lineType: 'INVENTARIO', product: prod._id, quantity: 10, unitPrice: 10, ivaRate: 15, subtotal: 100, retentions: [{ rule: String(ruleBienes._id) }, { rule: String(ruleIva._id) }] }, // 312:2, 721:4.5
      { description: 'Transporte', lineType: 'GASTO', account: gasto._id, quantity: 1, unitPrice: 100, ivaRate: 0, subtotal: 100, retentions: [{ rule: String(ruleBienes._id) }, { rule: String(ruleTransp._id) }] }, // 312:2, 310:1
    ],
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const inv = await PurchaseInvoice.findById(r.payload._id);
  // Códigos: 312 (renta, dos líneas → base 200, monto 4), 310 (renta 1), 721 (iva 4.5)
  const r312 = inv.retentions.find((x) => x.code === '312');
  const r310 = inv.retentions.find((x) => x.code === '310');
  const r721 = inv.retentions.find((x) => x.code === '721');
  assert.equal(r312.baseAmount, 200); assert.equal(r312.amount, 4);
  assert.equal(r310.amount, 1);
  assert.equal(r721.amount, 4.5);
  assert.equal(inv.retentionTotal, 9.5);
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

// ─────────────────────────────────────────────────────────────────────────────
test('15) backend ignora base/monto/rate falsos en AMBAS retenciones de la línea', async () => {
  const { clinicId, userId, invCat, ruleBienes, ruleIva } = await setup();
  const sup = await H.makeSupplier(clinicId);
  const prod = await H.makeProduct(clinicId, { category: 'insumo', stock: 0, inventoryCategory: invCat._id });
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date('2026-06-05'),
    items: [{ description: 'Insumo', lineType: 'INVENTARIO', product: prod._id, quantity: 10, unitPrice: 10, ivaRate: 15, subtotal: 100,
      retentions: [
        { rule: String(ruleBienes._id), base: 9999, amount: 9999, rate: 99 },
        { rule: String(ruleIva._id), base: 8888, amount: 8888, rate: 88 },
      ] }],
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const inv = await PurchaseInvoice.findById(r.payload._id);
  const rr = inv.items[0].retentions;
  const renta = rr.find((x) => x.type === 'RENTA');
  const iva = rr.find((x) => x.type === 'IVA');
  assert.equal(renta.base, 100); assert.equal(renta.rate, 2); assert.equal(renta.amount, 2);
  assert.equal(iva.base, 15); assert.equal(iva.rate, 30); assert.equal(iva.amount, 4.5);
  assert.equal(inv.retentionTotal, 6.5);
});

// ─────────────────────────────────────────────────────────────────────────────
test('16) no permite duplicar el mismo type+code en la misma línea', async () => {
  const { clinicId, userId, gasto, ruleBienes } = await setup();
  const sup = await H.makeSupplier(clinicId);
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date('2026-06-05'),
    items: [{ description: 'Gasto', lineType: 'GASTO', account: gasto._id, quantity: 1, unitPrice: 100, ivaRate: 0, subtotal: 100,
      retentions: [{ rule: String(ruleBienes._id) }, { rule: String(ruleBienes._id) }] }], // 312 duplicado
  }));
  assert.equal(r.statusCode, 400, JSON.stringify(r.payload));
  assert.match(r.payload.message, /duplicada/i);
});

// ─────────────────────────────────────────────────────────────────────────────
test('17) permite RENTA + IVA (tipos distintos) en la misma línea', async () => {
  const { clinicId, userId, gasto, ruleTransp, ruleIva } = await setup();
  const sup = await H.makeSupplier(clinicId);
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date('2026-06-05'),
    items: [{ description: 'Servicio', lineType: 'GASTO', account: gasto._id, quantity: 1, unitPrice: 100, ivaRate: 15, subtotal: 100,
      retentions: [{ rule: String(ruleTransp._id) }, { rule: String(ruleIva._id) }] }], // 310 renta + 721 iva
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const inv = await PurchaseInvoice.findById(r.payload._id);
  assert.equal(inv.items[0].retentions.length, 2);
  assert.equal(inv.retentionTotal, +(1 + 15 * 0.30).toFixed(2)); // 1 + 4.5 = 5.5
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

// ─────────────────────────────────────────────────────────────────────────────
test('18) compra legacy con item.retention SINGULAR sigue funcionando (se normaliza a array)', async () => {
  const { clinicId, userId, gasto, ruleTransp } = await setup();
  const sup = await H.makeSupplier(clinicId);
  // Simula un cliente/datos viejos que mandan `retention` singular (no array).
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date('2026-06-05'),
    items: [{ description: 'Transporte', lineType: 'GASTO', account: gasto._id, quantity: 1, unitPrice: 100, ivaRate: 0, subtotal: 100, retention: { rule: String(ruleTransp._id) } }],
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const inv = await PurchaseInvoice.findById(r.payload._id);
  assert.equal(inv.items[0].retentions.length, 1, 'el singular se normaliza a retentions[]');
  assert.equal(inv.items[0].retention.code, '310', 'y se conserva el singular por compat');
  assert.equal(inv.retentionTotal, 1);
  assert.equal(await H.accountBalanceByCode(clinicId, '2.1.01.01'), -99);
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

// ─────────────────────────────────────────────────────────────────────────────
test('19) el Formulario 103 toma AMBAS retenciones RENTA (dos códigos) por línea', async () => {
  const { clinicId, userId, gasto, invCat, ruleBienes, ruleTransp } = await setup();
  const sup = await H.makeSupplier(clinicId);
  const prod = await H.makeProduct(clinicId, { category: 'insumo', stock: 0, inventoryCategory: invCat._id });
  await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date('2026-06-15'),
    items: [{ description: 'Insumo', lineType: 'INVENTARIO', product: prod._id, quantity: 10, unitPrice: 10, ivaRate: 0, subtotal: 100,
      retentions: [{ rule: String(ruleBienes._id) }, { rule: String(ruleTransp._id) }] }], // 312 + 310 (ambas RENTA)
  }));
  const res = await H.runController(reports.form103, H.mockReq(clinicId, userId, {}, { query: { year: '2026', month: '6' } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  const r312 = res.payload.rows.find((x) => x.code === '312');
  const r310 = res.payload.rows.find((x) => x.code === '310');
  assert.ok(r312 && r310, 'ambos códigos RENTA en el 103');
  assert.equal(r312.amount, 2);
  assert.equal(r310.amount, 1);
  assert.equal(res.payload.total, 3);
});
