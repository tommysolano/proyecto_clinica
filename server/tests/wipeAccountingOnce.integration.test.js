/**
 * CONTABILIDAD EN CERO DE UNA SOLA VEZ (scripts/wipeAccountingOnce.js).
 *
 * El script borra datos de PRODUCCIÓN, así que lo importante es demostrar DÓNDE se
 * detiene: se lleva por delante todo el movimiento contable, pero el CRM/marketing y
 * los catálogos tienen que seguir exactamente igual. Y debe correr una sola vez.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const sale = require('../controllers/saleController');
const purchase = require('../controllers/purchaseInvoiceController');
const { wipeAccounting, runOnce } = require('../scripts/wipeAccountingOnce');

const Sale = require('../models/Sale');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const Payable = require('../models/Payable');
const JournalEntry = require('../models/JournalEntry');
const AccountBalance = require('../models/AccountBalance');
const InventoryMovement = require('../models/InventoryMovement');
const InventoryLayer = require('../models/InventoryLayer');
const Product = require('../models/Product');
const ChartOfAccount = require('../models/ChartOfAccount');
const Supplier = require('../models/Supplier');
const BankAccount = require('../models/BankAccount');
const OneTimeTask = require('../models/OneTimeTask');

// CRM / marketing: lo que NO se puede tocar.
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Contact = require('../models/Contact');
const MessageTemplate = require('../models/MessageTemplate');
const Workflow = require('../models/Workflow');
const Patient = require('../models/Patient');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const silencio = () => {};

/** Deja movimiento contable de verdad: una compra que ingresa stock y una venta que lo saca. */
async function moverContabilidad(clinicId, userId) {
  const prod = await H.makeProduct(clinicId, { category: 'insumo', salePrice: 115, purchasePrice: 40 });
  const sup = await H.makeSupplier(clinicId);
  const compra = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id,
    fechaEmision: H.docDate(),
    items: [{ description: 'Insumo', product: prod._id, quantity: 10, unitPrice: 40, ivaRate: 15, subtotal: 400 }],
  }));
  assert.equal(compra.statusCode, 201, JSON.stringify(compra.payload));

  const venta = await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: prod._id, quantity: 2, unitPrice: 115 }], paymentMethod: 'efectivo',
  }));
  assert.equal(venta.statusCode, 201, JSON.stringify(venta.payload));
  return { prod, sup };
}

/** Datos de CRM/marketing que tienen que sobrevivir intactos. */
async function sembrarCrm(clinicId) {
  const conv = await Conversation.create({ clinic: clinicId, phone: '593999111222', contactName: 'Paciente CRM' });
  await Message.create({ clinic: clinicId, conversation: conv._id, direction: 'in', body: 'Hola' });
  await Contact.create({ clinic: clinicId, name: 'Contacto CRM', phone: '593999111222' });
  await MessageTemplate.create({ clinic: clinicId, name: 'recordatorio_cita', body: 'Hola {{1}}', status: 'approved' });
  await Workflow.create({ clinic: clinicId, name: 'Bienvenida', folder: 'General', nodes: [], edges: [] });
  await Patient.create({ clinic: clinicId, firstName: 'Ana', lastName: 'Perez', cedula: '0102030405' });
  return conv;
}

// ─────────────────────────────────────────────────────────────────────────────
test('deja el movimiento contable en cero pero conserva catálogos y saldo inicial del banco', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const { prod, sup } = await moverContabilidad(clinicId, userId);
  const cuentasAntes = await ChartOfAccount.countDocuments({ clinic: clinicId });
  const banco = await BankAccount.create({
    clinic: clinicId,
    name: 'Cuenta corriente', bank: 'Pichincha', accountNumber: '2100123456',
    chartAccount: (await ChartOfAccount.findOne({ clinic: clinicId }))._id,
    initialBalance: 500, bookBalance: 1234.56,
  });

  assert.ok(await Sale.countDocuments({ clinic: clinicId }) > 0);
  assert.ok(await JournalEntry.countDocuments({ clinic: clinicId }) > 0);

  const res = await wipeAccounting({ clinic: clinicId, commit: true, log: silencio });
  assert.ok(res.totalDocs > 0);

  // Movimiento: en cero.
  assert.equal(await Sale.countDocuments({ clinic: clinicId }), 0);
  assert.equal(await PurchaseInvoice.countDocuments({ clinic: clinicId }), 0);
  assert.equal(await Payable.countDocuments({ clinic: clinicId }), 0);
  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId }), 0);
  assert.equal(await AccountBalance.countDocuments({ clinic: clinicId }), 0);
  assert.equal(await InventoryMovement.countDocuments({ clinic: clinicId }), 0);
  assert.equal(await InventoryLayer.countDocuments({ clinic: clinicId }), 0);

  // Catálogos: intactos.
  assert.equal(await ChartOfAccount.countDocuments({ clinic: clinicId }), cuentasAntes, 'el plan de cuentas no se toca');
  assert.ok(await Supplier.findById(sup._id), 'el proveedor sigue existiendo');
  const producto = await Product.findById(prod._id);
  assert.ok(producto, 'el producto sigue existiendo');
  assert.equal(producto.stock, 0, 'sin kardex, el stock queda en 0');
  assert.equal(producto.averageCost, 0);

  // El banco conserva su configuración y vuelve a su saldo inicial (no a cero).
  const bancoDespues = await BankAccount.findById(banco._id);
  assert.ok(bancoDespues, 'la cuenta bancaria no se borra');
  assert.equal(bancoDespues.bookBalance, 500);
});

test('el CRM y los pacientes no se tocan', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await moverContabilidad(clinicId, userId);
  await sembrarCrm(clinicId);

  await wipeAccounting({ clinic: clinicId, commit: true, log: silencio });

  assert.equal(await Conversation.countDocuments({ clinic: clinicId }), 1, 'los chats siguen ahí');
  assert.equal(await Message.countDocuments({ clinic: clinicId }), 1);
  assert.equal(await Contact.countDocuments({ clinic: clinicId }), 1);
  assert.equal(await MessageTemplate.countDocuments({ clinic: clinicId }), 1);
  assert.equal(await Workflow.countDocuments({ clinic: clinicId }), 1);
  assert.equal(await Patient.countDocuments({ clinic: clinicId }), 1);
});

test('el dry-run no borra nada', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await moverContabilidad(clinicId, userId);
  const ventasAntes = await Sale.countDocuments({ clinic: clinicId });
  const asientosAntes = await JournalEntry.countDocuments({ clinic: clinicId });

  const res = await wipeAccounting({ clinic: clinicId, commit: false, log: silencio });

  assert.equal(res.dryRun, true);
  assert.equal(await Sale.countDocuments({ clinic: clinicId }), ventasAntes);
  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId }), asientosAntes);
});

test('corre una sola vez: el segundo despliegue no borra lo nuevo', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await moverContabilidad(clinicId, userId);

  const primera = await runOnce({ key: 'test-contabilidad-cero', clinic: clinicId, log: silencio });
  assert.equal(primera.status, 'DONE');
  assert.equal(await Sale.countDocuments({ clinic: clinicId }), 0);

  // Datos nuevos después del borrado (la operación siguió normal).
  await moverContabilidad(clinicId, userId);
  const nuevas = await Sale.countDocuments({ clinic: clinicId });
  assert.equal(nuevas, 1);

  const segunda = await runOnce({ key: 'test-contabilidad-cero', clinic: clinicId, log: silencio });
  assert.equal(segunda.skipped, true, 'la marca DONE impide repetirla');
  assert.equal(await Sale.countDocuments({ clinic: clinicId }), nuevas, 'las ventas nuevas siguen ahí');
  assert.equal((await OneTimeTask.findById('test-contabilidad-cero')).status, 'DONE');
});

test('sin --secuenciales, la configuración de facturación del SRI no se toca', async () => {
  const InvoicingConfig = require('../models/InvoicingConfig');
  const { clinicId, userId } = await H.seedClinic();
  await moverContabilidad(clinicId, userId);
  await InvoicingConfig.create({
    clinic: clinicId, secuencial: 87, ambiente: '2',
    certificateFilename: 'firma.p12', certificatePassword: 'cifrada',
  });

  await wipeAccounting({ clinic: clinicId, commit: true, log: silencio });

  const cfg = await InvoicingConfig.findOne({ clinic: clinicId });
  assert.ok(cfg, 'la configuración de facturación no se borra');
  assert.equal(cfg.secuencial, 87, 'el secuencial del SRI se conserva');
  assert.equal(cfg.certificateFilename, 'firma.p12', 'el certificado digital se conserva');
});
