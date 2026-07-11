/**
 * RESET CONTROLADO de información de prueba, POR MÓDULOS.
 *
 * Pensado para limpiar el ambiente antes de la carga de datos reales
 * (plan de cuentas, categorías, productos y compras/ventas de prueba).
 *
 * ─── LO QUE NUNCA TOCA (se preserva SIEMPRE) ───────────────────────────────
 *   · InvoicingConfig: CERTIFICADO DIGITAL de facturación (.p12), contraseña,
 *     RUC, secuenciales de factura/retención/NC y config SMTP.
 *   · Archivos en server/storage/ (certificados, adjuntos).
 *   · Usuarios, clínicas, roles y bloqueos de acceso.
 *   · Pacientes, citas, fichas clínicas (datos médicos).
 *   · Configuración contable (AccountingConfig), reglas de retención,
 *     catálogos de nómina (departamentos, cargos, conceptos, tablas IR).
 *   · Bodegas, cuentas bancarias (la configuración; sus movimientos sí se
 *     limpian con --bancos), tarjetas de crédito configuradas.
 *   · CRM/Marketing (conversaciones, plantillas, workflows, campañas).
 *
 * ─── MÓDULOS (flags combinables) ───────────────────────────────────────────
 *   --ventas         Ventas, facturas de venta, cotizaciones, NC/ND, CxC,
 *                    ingresos diferidos
 *   --compras        Facturas de compra, CxP, comprobantes de retención
 *   --pagos          Pagos y cobros registrados (Payment)
 *   --cajas          Movimientos y cierres de caja, lotes y liquidaciones de tarjeta
 *   --bancos         Movimientos bancarios, cheques, conciliaciones
 *   --inventario     Kardex (capas y movimientos), tomas físicas; resetea el
 *                    stock/costo promedio de los productos a 0 (no borra productos)
 *   --productos      TODOS los productos/servicios (implica --inventario)
 *   --categorias     Categorías de inventario/activo fijo
 *   --activos        Activos fijos
 *   --comisiones     Contabilizaciones de comisiones (CommissionPosting)
 *   --nomina         Roles de pago, préstamos y deducciones de empleados
 *   --empleados      Fichas de empleados (implica --nomina)
 *   --terceros       Proveedores/clientes del módulo contable (Supplier)
 *   --contabilidad   TODOS los asientos, saldos por período, períodos fiscales
 *                    y contadores de numeración de asientos
 *   --plan-cuentas   ¡CUIDADO! Borra el plan de cuentas completo. Los módulos
 *                    parametrizados con cuentas (categorías, bancos, bodegas,
 *                    nómina, config contable) quedarán con referencias rotas:
 *                    importa el nuevo plan y re-parametriza inmediatamente.
 *   --transaccional  Atajo: ventas + compras + pagos + cajas + bancos +
 *                    inventario + activos + comisiones + nomina + contabilidad
 *                    (conserva catálogos: productos, categorías, terceros,
 *                    empleados y plan de cuentas)
 *
 * ─── USO ───────────────────────────────────────────────────────────────────
 *   node scripts/resetDatosPrueba.js --transaccional                (dry-run)
 *   node scripts/resetDatosPrueba.js --transaccional --commit       (BORRA)
 *   node scripts/resetDatosPrueba.js --ventas --compras --commit
 *   node scripts/resetDatosPrueba.js --productos --categorias --commit
 *   node scripts/resetDatosPrueba.js --transaccional --clinic=<id> --commit
 *
 * Por seguridad NO borra nada salvo que se pase --commit.
 * Requiere MONGODB_URI en el entorno (.env).
 */
const { connect, disconnect, mongoose } = require('./_common');

// Modelos por módulo (se cargan aquí para que mongoose los registre).
const Sale = require('../models/Sale');
const Invoice = require('../models/Invoice');
const Quotation = require('../models/Quotation');
const CreditDebitNote = require('../models/CreditDebitNote');
const Receivable = require('../models/Receivable');
const DeferredIncome = require('../models/DeferredIncome');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const Payable = require('../models/Payable');
const RetentionVoucher = require('../models/RetentionVoucher');
const Payment = require('../models/Payment');
const CashMovement = require('../models/CashMovement');
const CashClosing = require('../models/CashClosing');
const CardSettlement = require('../models/CardSettlement');
const CreditCardBatch = require('../models/CreditCardBatch');
const BankTransaction = require('../models/BankTransaction');
const BankCheck = require('../models/BankCheck');
const Reconciliation = require('../models/Reconciliation');
const InventoryLayer = require('../models/InventoryLayer');
const InventoryMovement = require('../models/InventoryMovement');
const PhysicalCount = require('../models/PhysicalCount');
const Product = require('../models/Product');
const InventoryCategory = require('../models/InventoryCategory');
const FixedAsset = require('../models/FixedAsset');
const CommissionPosting = require('../models/CommissionPosting');
const Payroll = require('../models/Payroll');
const EmployeeLoan = require('../models/EmployeeLoan');
const EmployeeDeduction = require('../models/EmployeeDeduction');
const Employee = require('../models/Employee');
const Supplier = require('../models/Supplier');
const JournalEntry = require('../models/JournalEntry');
const AccountBalance = require('../models/AccountBalance');
const FiscalPeriod = require('../models/FiscalPeriod');
const Counter = require('../models/Counter');
const ChartOfAccount = require('../models/ChartOfAccount');

// [etiqueta, Modelo, filtroExtra?]
const MODULES = {
  ventas: [
    ['Ventas (Sale)', Sale],
    ['Facturas de venta (Invoice)', Invoice],
    ['Cotizaciones (Quotation)', Quotation],
    ['Notas de crédito/débito (CreditDebitNote)', CreditDebitNote],
    ['Cuentas por cobrar (Receivable)', Receivable],
    ['Ingresos diferidos (DeferredIncome)', DeferredIncome],
  ],
  compras: [
    ['Facturas de compra (PurchaseInvoice)', PurchaseInvoice],
    ['Cuentas por pagar (Payable)', Payable],
    ['Comprobantes de retención (RetentionVoucher)', RetentionVoucher],
  ],
  pagos: [
    ['Pagos y cobros (Payment)', Payment],
  ],
  cajas: [
    ['Movimientos de caja (CashMovement)', CashMovement],
    ['Cierres de caja (CashClosing)', CashClosing],
    ['Liquidaciones de tarjeta (CardSettlement)', CardSettlement],
    ['Lotes de tarjeta (CreditCardBatch)', CreditCardBatch],
  ],
  bancos: [
    ['Movimientos bancarios (BankTransaction)', BankTransaction],
    ['Cheques (BankCheck)', BankCheck],
    ['Conciliaciones (Reconciliation)', Reconciliation],
  ],
  inventario: [
    ['Capas de kardex (InventoryLayer)', InventoryLayer],
    ['Movimientos de inventario (InventoryMovement)', InventoryMovement],
    ['Tomas físicas (PhysicalCount)', PhysicalCount],
  ],
  productos: [
    ['Productos/servicios (Product)', Product],
    ['Contador de códigos de producto', Counter, { key: 'product-code' }],
  ],
  categorias: [
    ['Categorías de inventario/activo (InventoryCategory)', InventoryCategory],
  ],
  activos: [
    ['Activos fijos (FixedAsset)', FixedAsset],
  ],
  comisiones: [
    ['Comisiones contabilizadas (CommissionPosting)', CommissionPosting],
  ],
  nomina: [
    ['Roles de pago (Payroll)', Payroll],
    ['Préstamos de empleados (EmployeeLoan)', EmployeeLoan],
    ['Deducciones de empleados (EmployeeDeduction)', EmployeeDeduction],
  ],
  empleados: [
    ['Empleados (Employee)', Employee],
  ],
  terceros: [
    ['Proveedores/clientes contables (Supplier)', Supplier],
  ],
  contabilidad: [
    ['Asientos contables (JournalEntry)', JournalEntry],
    ['Saldos por cuenta/período (AccountBalance)', AccountBalance],
    ['Períodos fiscales (FiscalPeriod)', FiscalPeriod],
    ['Contadores de asientos (Counter journal-*)', Counter, { key: /^journal-/ }],
  ],
  'plan-cuentas': [
    ['Plan de cuentas (ChartOfAccount)', ChartOfAccount],
  ],
};

const TRANSACCIONAL = ['ventas', 'compras', 'pagos', 'cajas', 'bancos', 'inventario', 'activos', 'comisiones', 'nomina', 'contabilidad'];
// Dependencias: borrar productos sin su kardex (o empleados sin sus roles) deja huérfanos.
const IMPLIES = { productos: ['inventario'], empleados: ['nomina'] };

function parseFlags() {
  const args = process.argv.slice(2);
  const commit = args.includes('--commit');
  const clinicArg = args.find((a) => a.startsWith('--clinic='));
  const clinic = clinicArg ? clinicArg.split('=')[1] : null;
  let selected = Object.keys(MODULES).filter((m) => args.includes(`--${m}`));
  if (args.includes('--transaccional')) selected = [...new Set([...selected, ...TRANSACCIONAL])];
  for (const m of [...selected]) {
    for (const dep of IMPLIES[m] || []) if (!selected.includes(dep)) selected.push(dep);
  }
  return { commit, clinic, selected };
}

async function run() {
  const { commit, clinic, selected } = parseFlags();

  console.log('\n=== RESET CONTROLADO DE DATOS DE PRUEBA ===');
  console.log(commit ? 'MODO: COMMIT (borra de verdad).' : 'MODO: DRY-RUN (solo cuenta). Usa --commit para aplicar.');
  if (clinic) console.log(`Alcance: solo clínica ${clinic}`);

  if (!selected.length) {
    console.log('\nNo se indicó ningún módulo. Flags disponibles:');
    Object.keys(MODULES).forEach((m) => console.log(`  --${m}`));
    console.log('  --transaccional  (atajo: todo lo transaccional, conserva catálogos)');
    console.log('\nEjemplo: node scripts/resetDatosPrueba.js --transaccional --commit');
    process.exit(1);
  }

  console.log(`\nMódulos a limpiar: ${selected.join(', ')}`);
  console.log('\n🔒 SE PRESERVA SIEMPRE (no se toca):');
  console.log('   · Certificado digital de facturación (.p12) y su configuración (InvoicingConfig)');
  console.log('   · Secuenciales SRI de factura/retención/NC (no se reinician: el SRI no admite reuso)');
  console.log('   · Usuarios, clínicas, pacientes, citas y fichas clínicas');
  console.log('   · Config contable, reglas de retención, catálogos de nómina, bodegas y bancos (config)');
  console.log('   · CRM/Marketing (chats, plantillas, workflows, campañas)');
  if (selected.includes('plan-cuentas')) {
    console.log('\n⚠️  --plan-cuentas: los módulos que referencian cuentas quedarán con vínculos rotos.');
    console.log('    Importa el nuevo plan y re-parametriza (categorías, bancos, bodegas, nómina, config) enseguida.');
  }
  console.log('');

  await connect();
  try {
    const filter = clinic ? { clinic: new mongoose.Types.ObjectId(clinic) } : {};
    for (const mod of selected) {
      console.log(`— Módulo ${mod}:`);
      for (const [label, Model, extra] of MODULES[mod]) {
        const f = { ...filter, ...(extra || {}) };
        const count = await Model.countDocuments(f);
        if (commit) {
          const { deletedCount } = await Model.deleteMany(f);
          console.log(`   🗑️  ${label}: ${deletedCount} eliminados (había ${count}).`);
        } else {
          console.log(`   • ${label}: ${count} documentos se eliminarían.`);
        }
      }
      // El kardex es la fuente del stock: al borrarlo hay que poner en cero el
      // cache de stock/costo de los productos (si no se borran los productos).
      if (mod === 'inventario' && !selected.includes('productos')) {
        const prodCount = await Product.countDocuments({ ...filter, $or: [{ stock: { $gt: 0 } }, { averageCost: { $gt: 0 } }] });
        if (commit) {
          await Product.updateMany(filter, { $set: { stock: 0, averageCost: 0, stockByClinic: [] } });
          console.log(`   ♻️  Stock/costo promedio reseteado a 0 en los productos (${prodCount} tenían stock/costo).`);
        } else {
          console.log(`   • Stock/costo promedio se resetearía a 0 (${prodCount} productos con stock/costo).`);
        }
      }
    }
    console.log(commit
      ? '\n✅  Reset aplicado. El certificado digital y la configuración de facturación quedaron INTACTOS.'
      : '\nDRY-RUN: nada se borró. Ejecuta con --commit para aplicar.');
  } finally {
    await disconnect();
  }
}

run().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
