/**
 * seed-accounting.js
 * ------------------
 * Rellena el módulo de contabilidad con datos demo realistas para la clínica Shiluv.
 *
 * Crea:
 *  ✓ Plan de cuentas (si no existe)
 *  ✓ 12 períodos fiscales 2026 (todos ABIERTO, enero-abril CERRADO)
 *  ✓ 2 centros de costo
 *  ✓ 2 cuentas bancarias
 *  ✓ 4 proveedores
 *  ✓ 6 facturas de compra (con ítems y retenciones)
 *  ✓ 3 activos fijos
 *  ✓ 2 bodegas + 3 categorías de inventario
 *  ✓ 3 empleados con nómina
 *  ✓ 1 lote de tarjetas de crédito
 *  ✓ 8 asientos contables manuales (VF, compras, nómina, etc.)
 *
 * Uso:
 *   cd server
 *   node seed-accounting.js
 *
 * Prerequisito: haber ejecutado `node seed.js` y `node seed-demo.js` antes.
 * Idempotente: detecta datos existentes y no duplica.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const Clinic            = require('./models/Clinic');
const ChartOfAccount    = require('./models/ChartOfAccount');
const FiscalPeriod      = require('./models/FiscalPeriod');
const CostCenter        = require('./models/CostCenter');
const BankAccount       = require('./models/BankAccount');
const Supplier          = require('./models/Supplier');
const PurchaseInvoice   = require('./models/PurchaseInvoice');
const FixedAsset        = require('./models/FixedAsset');
const Warehouse         = require('./models/Warehouse');
const InventoryCategory = require('./models/InventoryCategory');
const Employee          = require('./models/Employee');
const JournalEntry      = require('./models/JournalEntry');
const CreditCardBatch   = require('./models/CreditCardBatch');
const { seedChartOfAccounts } = require('./utils/accounting');

// ─── helpers ────────────────────────────────────────────────────────────────
function d(y, m, day) { return new Date(y, m - 1, day); }
function rnd(min, max) { return Math.round((Math.random() * (max - min) + min) * 100) / 100; }

async function getAcc(clinicId, code) {
  const a = await ChartOfAccount.findOne({ clinic: clinicId, code });
  if (!a) throw new Error(`Cuenta no encontrada: ${code}`);
  return a;
}

async function nextEntryNum(clinicId, date) {
  const year = new Date(date).getFullYear();
  const prefix = `AS-${year}-`;
  const last = await JournalEntry.findOne({ clinic: clinicId, number: new RegExp(`^${prefix}`) })
    .sort({ createdAt: -1 }).select('number');
  let n = last ? parseInt((last.number.match(/(\d+)$/) || [, '0'])[1]) + 1 : 1;
  return `${prefix}${String(n).padStart(6, '0')}`;
}

async function mkEntry(clinicId, { date, description, source, lines }) {
  const number = await nextEntryNum(clinicId, date);
  const entry = new JournalEntry({
    clinic: clinicId, number, date, description, source,
    status: 'CONTABILIZADO',
    lines: lines.map(l => ({
      account: l.acc._id,
      accountCode: l.acc.code,
      accountName: l.acc.name,
      debit: l.debit || 0,
      credit: l.credit || 0,
      description: l.desc || description,
    })),
  });
  entry.totalDebit  = entry.lines.reduce((s, l) => s + l.debit, 0);
  entry.totalCredit = entry.lines.reduce((s, l) => s + l.credit, 0);
  await entry.save();
  return entry;
}

// ─── main ───────────────────────────────────────────────────────────────────
async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ MongoDB conectado');

  // Obtener la clínica principal
  const clinic = await Clinic.findOne({ active: true }).sort({ createdAt: 1 });
  if (!clinic) throw new Error('No hay clínica. Ejecuta node seed.js primero.');
  const cid = clinic._id;
  console.log(`📋 Clínica: ${clinic.name} (${cid})`);

  // ─── 1. Plan de cuentas ──────────────────────────────────────────────────
  const existing = await ChartOfAccount.countDocuments({ clinic: cid });
  if (existing === 0) {
    const r = await seedChartOfAccounts(cid);
    console.log(`📚 Plan de cuentas creado: ${r.created} cuentas`);
  } else {
    console.log(`📚 Plan de cuentas: ya existe (${existing} cuentas)`);
  }

  // ─── 2. Períodos fiscales 2026 ───────────────────────────────────────────
  const MONTHS = [
    { month: 1, status: 'CERRADO' },
    { month: 2, status: 'CERRADO' },
    { month: 3, status: 'CERRADO' },
    { month: 4, status: 'CERRADO' },
    { month: 5, status: 'ABIERTO' },
    { month: 6, status: 'ABIERTO' },
    { month: 7, status: 'ABIERTO' },
    { month: 8, status: 'ABIERTO' },
    { month: 9, status: 'ABIERTO' },
    { month: 10, status: 'ABIERTO' },
    { month: 11, status: 'ABIERTO' },
    { month: 12, status: 'ABIERTO' },
  ];
  let periodCreated = 0;
  for (const { month, status } of MONTHS) {
    const exists = await FiscalPeriod.findOne({ clinic: cid, year: 2026, month });
    if (!exists) {
      await FiscalPeriod.create({
        clinic: cid, year: 2026, month, status,
        closedAt: status === 'CERRADO' ? d(2026, month + 1, 1) : null,
      });
      periodCreated++;
    }
  }
  console.log(`📅 Períodos fiscales 2026: ${periodCreated} creados`);

  // ─── 3. Centros de costo ─────────────────────────────────────────────────
  const CC_DATA = [
    { code: 'CC-ADM', name: 'Administración', description: 'Área administrativa y back-office' },
    { code: 'CC-MED', name: 'Médico-Estético', description: 'Servicios médicos y estéticos' },
  ];
  let ccMap = {};
  for (const cc of CC_DATA) {
    let rec = await CostCenter.findOne({ clinic: cid, code: cc.code });
    if (!rec) rec = await CostCenter.create({ clinic: cid, ...cc, active: true });
    ccMap[cc.code] = rec;
  }
  console.log(`🏢 Centros de costo: ${Object.keys(ccMap).length}`);

  // ─── 4. Cuentas bancarias ────────────────────────────────────────────────
  const accBancos = await getAcc(cid, '1.1.01.03');
  const BANKS_DATA = [
    {
      name: 'Cta. Corriente Pacífico',
      bank: 'Banco del Pacífico',
      accountNumber: '0123456789',
      accountType: 'CORRIENTE',
      bookBalance: 8500,
      initialBalance: 5000,
      initialBalanceDate: d(2026, 1, 1),
    },
    {
      name: 'Cta. Ahorros Pichincha',
      bank: 'Banco Pichincha',
      accountNumber: '2200987654',
      accountType: 'AHORROS',
      bookBalance: 3200,
      initialBalance: 2000,
      initialBalanceDate: d(2026, 1, 1),
    },
  ];
  let bankMap = {};
  for (const b of BANKS_DATA) {
    let rec = await BankAccount.findOne({ clinic: cid, accountNumber: b.accountNumber });
    if (!rec) rec = await BankAccount.create({ clinic: cid, chartAccount: accBancos._id, ...b, active: true });
    bankMap[b.accountNumber] = rec;
  }
  console.log(`🏦 Cuentas bancarias: ${Object.keys(bankMap).length}`);

  // ─── 5. Proveedores ──────────────────────────────────────────────────────
  const SUPP_DATA = [
    { ruc: '1791234560001', razonSocial: 'DISTRIBUIDORA MÉDICA DEL ECUADOR S.A.', nombreComercial: 'MedDist', email: 'ventas@meddist.com', phone: '022345678', isSpecialContributor: false, rimpe: '' },
    { ruc: '1790876540001', razonSocial: 'IMPORTADORA FARMACÉUTICA ANDES CIA. LTDA.', nombreComercial: 'FarmaAndes', email: 'compras@farmaandes.com', phone: '022876543', isSpecialContributor: true, rimpe: '' },
    { ruc: '1700111222001', razonSocial: 'PAPELERÍA Y SUMINISTROS QUITO S.A.', nombreComercial: 'PapeQuito', email: 'info@papequito.com', phone: '022111222', isSpecialContributor: false, rimpe: 'EMPRENDEDOR' },
    { ruc: '1792345670001', razonSocial: 'TECNOLOGÍA Y SERVICIOS TEC-MED S.A.', nombreComercial: 'TecMed', email: 'soporte@tecmed.ec', phone: '023456789', isSpecialContributor: false, rimpe: '' },
  ];
  let suppMap = {};
  for (const s of SUPP_DATA) {
    let rec = await Supplier.findOne({ clinic: cid, ruc: s.ruc });
    if (!rec) rec = await Supplier.create({ clinic: cid, active: true, ...s });
    suppMap[s.ruc] = rec;
  }
  console.log(`🏭 Proveedores: ${Object.keys(suppMap).length}`);

  // ─── 6. Facturas de compra ───────────────────────────────────────────────
  const accProveedores = await getAcc(cid, '2.1.01.01');
  const accIvaCompras  = await getAcc(cid, '1.1.03.01');
  const accGastoSumin  = await getAcc(cid, '6.1.11');
  const accGastoHonor  = await getAcc(cid, '6.1.08');
  const accGastoMant   = await getAcc(cid, '6.1.12');

  const PURCHASES = [
    {
      supplier: suppMap['1791234560001'],
      serie: '001-001-000000101',
      autorizacion: '2601151791234560001220260100000000000101123456789',
      fechaEmision: d(2026, 1, 10),
      items: [{ description: 'Insumos médicos varios', quantity: 10, unitPrice: 45, subtotal: 450, ivaRate: 15, ivaAmount: 67.5, account: accGastoSumin }],
      subtotal15: 450, iva: 67.5, total: 517.5, balance: 517.5,
      retentions: [{ type: 'RENTA', code: '341', description: 'Servicios - bienes', baseAmount: 450, percentage: 1, amount: 4.5 }],
      retentionTotal: 4.5,
    },
    {
      supplier: suppMap['1790876540001'],
      serie: '002-001-000000045',
      autorizacion: '2601151790876540001220260200000000000045234567890',
      fechaEmision: d(2026, 2, 5),
      items: [{ description: 'Medicamentos e insumos farmacéuticos', quantity: 1, unitPrice: 320, subtotal: 320, ivaRate: 0, ivaAmount: 0, account: accGastoSumin }],
      subtotal0: 320, iva: 0, total: 320, balance: 0, paid: true, status: 'PAGADA',
      retentions: [],
    },
    {
      supplier: suppMap['1700111222001'],
      serie: '001-001-000000789',
      autorizacion: '2601151700111222001120260100000000000789345678901',
      fechaEmision: d(2026, 3, 15),
      items: [{ description: 'Suministros de oficina y papelería', quantity: 1, unitPrice: 85, subtotal: 85, ivaRate: 15, ivaAmount: 12.75, account: accGastoSumin }],
      subtotal15: 85, iva: 12.75, total: 97.75, balance: 97.75,
      retentions: [],
    },
    {
      supplier: suppMap['1792345670001'],
      serie: '003-001-000000212',
      autorizacion: '2601151792345670001320260300000000000212456789012',
      fechaEmision: d(2026, 4, 20),
      items: [{ description: 'Mantenimiento equipos médicos', quantity: 1, unitPrice: 280, subtotal: 280, ivaRate: 15, ivaAmount: 42, account: accGastoMant }],
      subtotal15: 280, iva: 42, total: 322, balance: 322,
      retentions: [{ type: 'IVA', code: '723', description: 'Retención IVA 30%', baseAmount: 42, percentage: 30, amount: 12.6 }],
      retentionTotal: 12.6,
    },
    {
      supplier: suppMap['1791234560001'],
      serie: '001-001-000000198',
      autorizacion: '2601151791234560001220260100000000000198567890123',
      fechaEmision: d(2026, 5, 3),
      items: [{ description: 'Material desechable clínico', quantity: 20, unitPrice: 12, subtotal: 240, ivaRate: 15, ivaAmount: 36, account: accGastoSumin }],
      subtotal15: 240, iva: 36, total: 276, balance: 276,
      retentions: [],
    },
    {
      supplier: suppMap['1790876540001'],
      serie: '002-001-000000099',
      autorizacion: '2601151790876540001220260200000000000099678901234',
      fechaEmision: d(2026, 5, 10),
      items: [{ description: 'Honorarios asesoría médica', quantity: 1, unitPrice: 500, subtotal: 500, ivaRate: 15, ivaAmount: 75, account: accGastoHonor }],
      subtotal15: 500, iva: 75, total: 575, balance: 575,
      retentions: [
        { type: 'RENTA', code: '303', description: 'Honorarios profesionales', baseAmount: 500, percentage: 10, amount: 50 },
        { type: 'IVA', code: '721', description: 'Retención IVA 70%', baseAmount: 75, percentage: 70, amount: 52.5 },
      ],
      retentionTotal: 102.5,
    },
  ];

  let purchCreated = 0;
  for (const p of PURCHASES) {
    const exists = await PurchaseInvoice.findOne({ clinic: cid, supplier: p.supplier._id, serie: p.serie });
    if (!exists) {
      await PurchaseInvoice.create({
        clinic: cid,
        supplier: p.supplier._id,
        serie: p.serie,
        autorizacion: p.autorizacion,
        fechaEmision: p.fechaEmision,
        items: p.items.map(i => ({ ...i, account: i.account._id })),
        subtotal0: p.subtotal0 || 0,
        subtotal15: p.subtotal15 || 0,
        subtotal: (p.subtotal0 || 0) + (p.subtotal15 || 0),
        iva: p.iva || 0,
        total: p.total,
        balance: p.balance || 0,
        paid: p.paid || false,
        status: p.status || 'REGISTRADA',
        retentions: p.retentions || [],
        retentionTotal: p.retentionTotal || 0,
        deductible: true,
      });
      purchCreated++;
    }
  }
  console.log(`🧾 Facturas de compra: ${purchCreated} creadas`);

  // ─── 7. Bodegas y categorías ─────────────────────────────────────────────
  const WH_DATA = [
    { code: 'BDG-PRINCIPAL', name: 'Bodega Principal', location: 'Planta baja', description: 'Bodega central de insumos' },
    { code: 'BDG-FARMACIA',  name: 'Farmacia Interna',  location: 'Consultorio 1', description: 'Stock de medicamentos' },
  ];
  let whMap = {};
  for (const w of WH_DATA) {
    let rec = await Warehouse.findOne({ clinic: cid, code: w.code });
    if (!rec) rec = await Warehouse.create({ clinic: cid, ...w, active: true });
    whMap[w.code] = rec;
  }

  const CAT_DATA = [
    { code: 'CAT-INS', name: 'Insumos Médicos', kind: 'INVENTARIO', description: 'Material desechable y consumibles clínicos' },
    { code: 'CAT-MED', name: 'Medicamentos', kind: 'INVENTARIO', description: 'Fármacos y biológicos' },
    { code: 'CAT-EST', name: 'Estética', kind: 'INVENTARIO', description: 'Productos de estética y belleza' },
  ];
  for (const c of CAT_DATA) {
    const exists = await InventoryCategory.findOne({ clinic: cid, code: c.code });
    if (!exists) await InventoryCategory.create({ clinic: cid, ...c, active: true });
  }
  console.log(`🗄️  Bodegas: ${Object.keys(whMap).length} | Categorías: ${CAT_DATA.length}`);

  // ─── 8. Activos fijos ────────────────────────────────────────────────────
  const ASSETS = [
    {
      code: 'AF-001', name: 'Equipo de Láser CO₂', description: 'Láser fraccional para tratamientos estéticos',
      acquisitionDate: d(2024, 3, 15), acquisitionCost: 12000, residualValue: 600,
      depreciationRate: 10, usefulLifeMonths: 120, startDate: d(2024, 4, 1),
      accumulatedDepreciation: 2550, bookValue: 9450,
      monthlyDepreciation: 95, lastDepreciationPeriod: '2026-04',
    },
    {
      code: 'AF-002', name: 'Computadora de Escritorio', description: 'Dell OptiPlex para recepción',
      acquisitionDate: d(2025, 1, 10), acquisitionCost: 1200, residualValue: 0,
      depreciationRate: 33.33, usefulLifeMonths: 36, startDate: d(2025, 2, 1),
      accumulatedDepreciation: 560, bookValue: 640,
      monthlyDepreciation: 33.33, lastDepreciationPeriod: '2026-04',
    },
    {
      code: 'AF-003', name: 'Muebles de Sala de Espera', description: 'Sofás y mesa de centro',
      acquisitionDate: d(2023, 6, 1), acquisitionCost: 2500, residualValue: 125,
      depreciationRate: 10, usefulLifeMonths: 120, startDate: d(2023, 7, 1),
      accumulatedDepreciation: 1097.5, bookValue: 1402.5,
      monthlyDepreciation: 19.79, lastDepreciationPeriod: '2026-04',
    },
  ];
  let assetCreated = 0;
  for (const a of ASSETS) {
    const exists = await FixedAsset.findOne({ clinic: cid, code: a.code });
    if (!exists) {
      await FixedAsset.create({ clinic: cid, status: 'ACTIVO', ...a });
      assetCreated++;
    }
  }
  console.log(`🔧 Activos fijos: ${assetCreated} creados`);

  // ─── 9. Empleados ────────────────────────────────────────────────────────
  const EMP_DATA = [
    {
      code: 'EMP-001', identificacion: '1701234567', firstName: 'María', lastName: 'López Taco',
      email: 'maria.lopez@shiluv.com', phone: '0991111110', position: 'Recepcionista', department: 'Administrativo',
      contractType: 'INDEFINIDO', baseSalary: 600, hireDate: d(2024, 1, 15),
      decimoTerceroAcumulado: 'MENSUALIZADO', decimoCuartoAcumulado: 'MENSUALIZADO',
      fondosReservaAcumulado: 'ACUMULADO', receivesFondosReserva: true,
    },
    {
      code: 'EMP-002', identificacion: '1709876543', firstName: 'Pedro', lastName: 'Guaña Simba',
      email: 'pedro.guana@shiluv.com', phone: '0992222220', position: 'Auxiliar de Enfermería', department: 'Médico',
      contractType: 'INDEFINIDO', baseSalary: 550, hireDate: d(2023, 6, 1),
      decimoTerceroAcumulado: 'MENSUALIZADO', decimoCuartoAcumulado: 'MENSUALIZADO',
      fondosReservaAcumulado: 'MENSUALIZADO', receivesFondosReserva: true,
    },
    {
      code: 'EMP-003', identificacion: '1705556667', firstName: 'Andrea', lastName: 'Vargas Ruiz',
      email: 'andrea.vargas@shiluv.com', phone: '0993333330', position: 'Administradora', department: 'Administrativo',
      contractType: 'INDEFINIDO', baseSalary: 900, hireDate: d(2022, 3, 1),
      decimoTerceroAcumulado: 'ACUMULADO', decimoCuartoAcumulado: 'ACUMULADO',
      fondosReservaAcumulado: 'ACUMULADO', receivesFondosReserva: true,
    },
  ];
  let empCreated = 0;
  for (const e of EMP_DATA) {
    const exists = await Employee.findOne({ clinic: cid, identificacion: e.identificacion });
    if (!exists) {
      await Employee.create({ clinic: cid, active: true, ...e });
      empCreated++;
    }
  }
  console.log(`👤 Empleados: ${empCreated} creados`);

  // ─── 10. Asientos contables manuales ────────────────────────────────────
  const existingEntries = await JournalEntry.countDocuments({ clinic: cid, source: 'MANUAL' });
  if (existingEntries < 2) {
    // Cuentas necesarias
    const caja        = await getAcc(cid, '1.1.01.01');
    const bancos      = await getAcc(cid, '1.1.01.03');
    const clientes    = await getAcc(cid, '1.1.02.01');
    const capital     = await getAcc(cid, '3.1.01');
    const ingServ     = await getAcc(cid, '4.1.01');
    const ivaVentas   = await getAcc(cid, '2.1.02.01');
    const proveed     = await getAcc(cid, '2.1.01.01');
    const ivaCompras  = await getAcc(cid, '1.1.03.01');
    const sueldoGasto = await getAcc(cid, '6.1.01');
    const iessGasto   = await getAcc(cid, '6.1.03');
    const d13Gasto    = await getAcc(cid, '6.1.04');
    const sueldoPay   = await getAcc(cid, '2.1.03.01');
    const iessPay     = await getAcc(cid, '2.1.03.02');
    const d13Pay      = await getAcc(cid, '2.1.03.03');
    const gastoPub    = await getAcc(cid, '6.1.15');
    const gastoArr    = await getAcc(cid, '6.1.09');
    const gastoDepr   = await getAcc(cid, '6.1.13');
    const gastoMant   = await getAcc(cid, '6.1.12');

    const ENTRIES = [
      // Asiento de apertura (capital inicial)
      {
        date: d(2026, 1, 2), source: 'APERTURA',
        description: 'Asiento de apertura - Aporte de capital inicial',
        lines: [
          { acc: bancos,   debit: 5000, credit: 0 },
          { acc: caja,     debit: 1000, credit: 0 },
          { acc: capital,  debit: 0, credit: 6000 },
        ],
      },
      // Venta de servicios enero
      {
        date: d(2026, 1, 15), source: 'VENTA',
        description: 'Venta servicios médicos semana 2 - enero',
        lines: [
          { acc: clientes,  debit: 1725, credit: 0 },
          { acc: ingServ,   debit: 0, credit: 1500 },
          { acc: ivaVentas, debit: 0, credit: 225 },
        ],
      },
      // Compra insumos enero
      {
        date: d(2026, 1, 20), source: 'COMPRA',
        description: 'Compra insumos médicos - Enero',
        lines: [
          { acc: ivaCompras, debit: 67.5,  credit: 0 },
          { acc: await getAcc(cid, '6.1.11'), debit: 450, credit: 0 },
          { acc: proveed,    debit: 0, credit: 517.5 },
        ],
      },
      // Cobro en caja
      {
        date: d(2026, 1, 31), source: 'COBRO',
        description: 'Cobro pacientes - cierre enero',
        lines: [
          { acc: caja,     debit: 1725, credit: 0 },
          { acc: clientes, debit: 0,    credit: 1725 },
        ],
      },
      // Nómina febrero
      {
        date: d(2026, 2, 28), source: 'NOMINA',
        description: 'Rol de pagos - Febrero 2026',
        lines: [
          { acc: sueldoGasto, debit: 2050, credit: 0, desc: 'Sueldos brutos' },
          { acc: iessGasto,   debit: 249.08, credit: 0, desc: 'Aporte patronal 12.15%' },
          { acc: d13Gasto,    debit: 170.83, credit: 0, desc: 'Décimo tercero' },
          { acc: sueldoPay,   debit: 0, credit: 1951.81, desc: 'Sueldos netos a pagar' },
          { acc: iessPay,     debit: 0, credit: 518.1, desc: 'IESS total (personal + patronal)' },
        ],
      },
      // Pago arriendo
      {
        date: d(2026, 3, 5), source: 'PAGO',
        description: 'Pago arriendo local - Marzo 2026',
        lines: [
          { acc: gastoArr, debit: 1200, credit: 0 },
          { acc: bancos,   debit: 0,    credit: 1200 },
        ],
      },
      // Publicidad
      {
        date: d(2026, 4, 10), source: 'MANUAL',
        description: 'Gasto publicidad redes sociales - Abril',
        lines: [
          { acc: gastoPub, debit: 350, credit: 0 },
          { acc: caja,     debit: 0,   credit: 350 },
        ],
      },
      // Depreciación mensual mayo
      {
        date: d(2026, 5, 31), source: 'DEPRECIACION',
        description: 'Depreciación activos fijos - Mayo 2026',
        lines: [
          { acc: gastoDepr,               debit: 148.12, credit: 0 },
          { acc: await getAcc(cid, '1.2.02.04'), debit: 0, credit: 95,    desc: 'Dep. equipo médico' },
          { acc: await getAcc(cid, '1.2.02.05'), debit: 0, credit: 33.33, desc: 'Dep. equipo cómputo' },
          { acc: await getAcc(cid, '1.2.02.02'), debit: 0, credit: 19.79, desc: 'Dep. muebles' },
        ],
      },
    ];

    let entryCount = 0;
    for (const e of ENTRIES) {
      try {
        await mkEntry(cid, e);
        entryCount++;
      } catch (err) {
        console.warn(`  ⚠ Asiento omitido (${e.description}): ${err.message}`);
      }
    }
    console.log(`📒 Asientos contables: ${entryCount} creados`);
  } else {
    console.log(`📒 Asientos contables: ya existen (${existingEntries}), omitidos`);
  }

  // ─── 11. Lote tarjetas de crédito ────────────────────────────────────────
  const existingBatch = await CreditCardBatch.findOne({ clinic: cid });
  if (!existingBatch) {
    const bank = Object.values(bankMap)[0];
    await CreditCardBatch.create({
      clinic: cid,
      code: 'LOTE-2026-001',
      closeDate: d(2026, 5, 10),
      cardType: 'VISA',
      acquirer: 'Datafast',
      vouchers: [
        { voucherNumber: 'VCH-001', lote: 'L001', cardLast4: '4321', cardType: 'VISA', grossAmount: 115, date: d(2026, 5, 8) },
        { voucherNumber: 'VCH-002', lote: 'L001', cardLast4: '8765', cardType: 'VISA', grossAmount: 230, date: d(2026, 5, 9) },
        { voucherNumber: 'VCH-003', lote: 'L001', cardLast4: '1122', cardType: 'MASTERCARD', grossAmount: 92, date: d(2026, 5, 10) },
      ],
      grossAmount: 437,
      commissionRate: 3.5,
      commissionAmount: 15.30,
      ivaCommissionAmount: 2.29,
      retentionRate: 2,
      retentionAmount: 8.74,
      netAmount: 410.67,
      status: 'ABIERTO',
      bankAccount: bank._id,
    });
    console.log(`💳 Lote tarjetas de crédito: 1 creado (ABIERTO, listo para liquidar)`);
  } else {
    console.log(`💳 Lote tarjetas de crédito: ya existe`);
  }

  console.log('\n🎉 Seed contable completado exitosamente.');
  console.log('────────────────────────────────────────────────────────');
  console.log('Accede con: conta.demo@shiluv.com / Demo2026!');
  console.log('────────────────────────────────────────────────────────');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('❌ Error en seed-accounting:', err.message);
  process.exit(1);
});
