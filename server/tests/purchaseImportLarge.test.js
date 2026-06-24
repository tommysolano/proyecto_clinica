const test = require('node:test');
const assert = require('node:assert/strict');
const { startDb, stopDb, resetDb, seedClinic, mockReq, runController } = require('./_integrationHelpers');
const purchaseCtrl = require('../controllers/purchaseInvoiceController');
const PurchaseInvoice = require('../models/PurchaseInvoice');

const HEADER = 'RUC_EMISOR\tRAZON_SOCIAL_EMISOR\tTIPO_COMPROBANTE\tSERIE_COMPROBANTE\tCLAVE_ACCESO\tFECHA_AUTORIZACION\tFECHA_EMISION\tIDENTIFICACION_RECEPTOR\tVALOR_SIN_IMPUESTOS\tIVA\tIMPORTE_TOTAL\tNUMERO_DOCUMENTO_MODIFICADO';

test('importa TODAS las facturas del TXT (sin tope de 100) y el total las refleja', async (t) => {
  await startDb();
  t.after(stopDb);
  await resetDb();
  const { clinicId, userId } = await seedClinic({ date: new Date('2026-06-01') });

  const N = 150;
  const lines = [HEADER];
  for (let i = 1; i <= N; i++) {
    const ruc = String(1790000000000 + i); // 13 dígitos, único por proveedor
    const sec = String(i).padStart(9, '0');
    const clave = `0106202601179000000${sec}0012001001${sec}1`; // clave de acceso única
    lines.push(`${ruc}\tPROVEEDOR ${i} SA\tFactura\t001-001-${sec}\t${clave}\t01/06/2026 10:00:00\t01/06/2026\t0993404160001\t100\t15\t115\t`);
  }

  const res = await runController(purchaseCtrl.importTxt, mockReq(clinicId, userId, { content: lines.join('\n') }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  assert.equal(res.payload.created, N, `debió crear ${N} facturas, creó ${res.payload.created}`);
  assert.equal(res.payload.errors.length, 0, JSON.stringify(res.payload.errors));
  assert.equal(await PurchaseInvoice.countDocuments({ clinic: clinicId }), N, 'todas deben quedar en la base');

  // El listado pagina (la página muestra hasta el limit) pero `total` refleja TODAS.
  const list = await runController(purchaseCtrl.list, mockReq(clinicId, userId, {}, { query: { limit: 100, page: 1 } }));
  assert.equal(list.payload.total, N, 'el total debe contar todas las facturas, no solo la página');
  assert.equal(list.payload.items.length, 100, 'la página devuelve hasta el limit pedido');

  // Segunda página trae el resto.
  const page2 = await runController(purchaseCtrl.list, mockReq(clinicId, userId, {}, { query: { limit: 100, page: 2 } }));
  assert.equal(page2.payload.items.length, 50, 'la segunda página trae las restantes');
});
