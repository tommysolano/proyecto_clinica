/**
 * DIAGNÓSTICO DE SOLO LECTURA del estado de la base de PRODUCCIÓN.
 *
 * NO escribe absolutamente nada: solo find/count/aggregate. Sirve para decidir qué
 * corregir tras los reportes de la contadora (103/104 sin datos, retenciones que no
 * aparecen en el modal de la compra, nómina mal configurada).
 *
 * Uso:  node scripts/diagnoseProductionState.js [--clinic=<id>] [--year=2026] [--month=5]
 */
process.env.TZ = process.env.TZ || 'America/Guayaquil';
require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SriDeclaration = require('../models/SriDeclaration');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const RetentionVoucher = require('../models/RetentionVoucher');
const PayrollConfig = require('../models/PayrollConfig');
const PayrollDepartment = require('../models/PayrollDepartment');
const PayrollConcept = require('../models/PayrollConcept');
const Payroll = require('../models/Payroll');
const FixedAsset = require('../models/FixedAsset');
const Clinic = require('../models/Clinic');
const { DEPT_TYPES } = require('../models/PayrollConfig');
const { getDefinition } = require('../utils/sriForms/definitions');

const arg = (name, def = null) => {
  const a = process.argv.slice(2).find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : def;
};

const iso = (d) => (d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : String(d ?? '—'));
const loc = (d) =>
  d instanceof Date && !Number.isNaN(d.getTime())
    ? d.toLocaleString('es-EC', { timeZone: 'America/Guayaquil', hour12: false })
    : '—';
const money = (n) => (Number(n) || 0).toFixed(2);
const h1 = (t) => console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`);
const h2 = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 72 - t.length))}`);

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const dbName = mongoose.connection.name;
  const host = mongoose.connection.host;

  const year = Number(arg('year', 2026));
  const month = Number(arg('month', 5));

  h1('DIAGNÓSTICO DE PRODUCCIÓN (SOLO LECTURA)');
  console.log(`Fecha del diagnóstico : ${loc(new Date())} (America/Guayaquil)`);
  console.log(`Base                  : ${dbName} @ ${host}`);
  console.log(`TZ del proceso        : ${process.env.TZ}`);
  console.log(`Período bajo análisis : ${year}-${String(month).padStart(2, '0')}`);

  // ── Clínicas
  const clinics = await Clinic.find({}).select('name ruc').lean();
  console.log(`\nClínicas (${clinics.length}):`);
  clinics.forEach((c) => console.log(`  · ${c._id}  ${c.name || '(sin nombre)'}  RUC ${c.ruc || '—'}`));
  const clinicFilter = arg('clinic');
  const clinicIds = clinicFilter ? [new mongoose.Types.ObjectId(clinicFilter)] : clinics.map((c) => c._id);

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. DECLARACIONES SRI
  // ═══════════════════════════════════════════════════════════════════════════
  h1('1. DECLARACIONES SRI (formularios 103 / 104)');

  console.log(`Versión de definición EN CÓDIGO → 103: ${getDefinition('103').definitionVersion}`
    + `   104: ${getDefinition('104').definitionVersion}`);

  const totalDecl = await SriDeclaration.countDocuments({});
  console.log(`\nTotal de SriDeclaration en la base: ${totalDecl}`);

  const decls = await SriDeclaration.find({ clinic: { $in: clinicIds } })
    .sort({ year: -1, month: -1, formType: 1, version: -1 })
    .lean();

  if (!decls.length) {
    console.log('\n  ⚠ NO EXISTE NINGUNA declaración guardada para estas clínicas.');
    console.log('    (Si la pantalla se alimenta de un borrador persistido, saldría vacía.)');
  }

  for (const d of decls) {
    const computed = (d.computedCells || []).length;
    const editable = (d.editableCells || []).length;
    const nonZero = (d.computedCells || []).filter((c) => Number(c.value) !== 0).length;
    const snapKeys = d.snapshot && typeof d.snapshot === 'object' ? Object.keys(d.snapshot) : [];
    const staleDef = d.definitionVersion !== getDefinition(d.formType).definitionVersion;
    h2(`F${d.formType} · ${d.periodKey} · v${d.version} · ${d.status}`);
    console.log(`  _id             : ${d._id}`);
    console.log(`  clinic          : ${d.clinic}`);
    console.log(`  definitionVersion: ${d.definitionVersion}${staleDef ? '   ⚠ DISTINTA a la del código' : '   ✓ igual a la del código'}`);
    console.log(`  createdAt       : ${iso(d.createdAt)}  (local ${loc(d.createdAt)})`);
    console.log(`  updatedAt       : ${iso(d.updatedAt)}  (local ${loc(d.updatedAt)})`);
    console.log(`  finalizedAt     : ${iso(d.finalizedAt)}`);
    console.log(`  casilleros      : computed=${computed} (con valor ≠ 0: ${nonZero})  editable=${editable}`);
    console.log(`  snapshot        : ${snapKeys.length ? `${snapKeys.length} claves → ${snapKeys.join(', ')}` : '⚠ VACÍO'}`);
    console.log(`  totales         : ventasBase=${money(d.totals?.ventasBase)} ventasIva=${money(d.totals?.ventasIva)}`
      + ` comprasBase=${money(d.totals?.comprasBase)} comprasIva=${money(d.totals?.comprasIva)}`);
    console.log(`                    retencionesEfectuadas=${money(d.totals?.retencionesEfectuadas)}`
      + ` impuestoPorPagar=${money(d.totals?.impuestoPorPagar)} totalAPagar=${money(d.totals?.totalAPagar)}`);
    if (nonZero) {
      const top = (d.computedCells || [])
        .filter((c) => Number(c.value) !== 0)
        .slice(0, 12)
        .map((c) => `${c.box}=${money(c.value)}`)
        .join('  ');
      console.log(`  casillas ≠ 0    : ${top}`);
    } else {
      console.log('  casillas ≠ 0    : ⚠ NINGUNA — el formulario se vería TODO EN CERO');
    }
  }

  // ── Compras del mes analizado, rango LOCAL America/Guayaquil
  const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
  const end = new Date(year, month, 0, 23, 59, 59, 999);
  h2(`COMPRAS DEL PERÍODO ${year}-${String(month).padStart(2, '0')} (rango LOCAL)`);
  console.log(`  Rango local  : ${loc(start)}  →  ${loc(end)}`);
  console.log(`  Rango en UTC : ${iso(start)}  →  ${iso(end)}`);

  const comprasMes = await PurchaseInvoice.find({
    clinic: { $in: clinicIds },
    fechaEmision: { $gte: start, $lte: end },
  })
    .select('serie docType status subtotal total fechaEmision createdAt retentions retentionTotal retentionVoucher')
    .sort({ fechaEmision: 1 })
    .lean();

  console.log(`\n  Compras dentro del rango (todos los estados): ${comprasMes.length}`);
  const porEstado = {};
  const porTipo = {};
  let sumSubtotal = 0;
  for (const p of comprasMes) {
    porEstado[p.status] = (porEstado[p.status] || 0) + 1;
    porTipo[p.docType] = (porTipo[p.docType] || 0) + 1;
    if (p.status !== 'ANULADA') sumSubtotal += Number(p.subtotal) || 0;
  }
  console.log(`  Por estado : ${JSON.stringify(porEstado)}`);
  console.log(`  Por docType: ${JSON.stringify(porTipo)}`);
  console.log(`  Suma de subtotal de cabecera (no anuladas): ${money(sumSubtotal)}`);
  console.log('\n  Primeras 10 (fecha CRUDA en UTC | fecha LOCAL | docType | status | subtotal | serie):');
  comprasMes.slice(0, 10).forEach((p, i) => {
    console.log(`   ${String(i + 1).padStart(2)}. ${iso(p.fechaEmision)} | ${loc(p.fechaEmision)} | `
      + `${(p.docType || '').padEnd(17)} | ${(p.status || '').padEnd(12)} | ${money(p.subtotal).padStart(10)} | ${p.serie || p._id}`);
  });

  // ── ¿Quedan compras con fechaEmision a medianoche UTC (bug pre-migración)?
  h2('¿SE APLICÓ migratePurchaseFechaEmision? (medianoche UTC = 19:00 local del día anterior)');
  const allPurchases = await PurchaseInvoice.find({ fechaEmision: { $ne: null } })
    .select('serie docType status fechaEmision subtotal clinic')
    .lean();
  const medianocheUtc = allPurchases.filter(
    (p) => p.fechaEmision instanceof Date
      && p.fechaEmision.getUTCHours() === 0
      && p.fechaEmision.getUTCMinutes() === 0
      && p.fechaEmision.getUTCSeconds() === 0
  );
  const mediodiaLocal = allPurchases.filter(
    (p) => p.fechaEmision instanceof Date && p.fechaEmision.getUTCHours() === 17
  );
  console.log(`  Total de compras con fechaEmision : ${allPurchases.length}`);
  console.log(`  A MEDIANOCHE UTC (bug sin migrar) : ${medianocheUtc.length}`);
  console.log(`  A MEDIODÍA LOCAL (17:00 UTC, ok)  : ${mediodiaLocal.length}`);
  console.log(`  Otras horas                       : ${allPurchases.length - medianocheUtc.length - mediodiaLocal.length}`);
  if (medianocheUtc.length) {
    console.log('\n  Ejemplos SIN migrar (UTC crudo | local | serie):');
    medianocheUtc.slice(0, 10).forEach((p) => {
      console.log(`    · ${iso(p.fechaEmision)} | ${loc(p.fechaEmision)} | ${p.serie || p._id} | ${p.status}`);
    });
    const cruzanMes = medianocheUtc.filter((p) => {
      const l = new Date(p.fechaEmision);
      return l.getMonth() !== p.fechaEmision.getUTCMonth();
    });
    console.log(`  De esas, CAMBIAN DE MES al leerlas en local: ${cruzanMes.length}`);
  }

  // ── ¿Dónde está la compra de 375?
  h2('BÚSQUEDA DE LA COMPRA DE 375 (subtotal o total ≈ 375)');
  const c375 = allPurchases.filter((p) => Math.abs((Number(p.subtotal) || 0) - 375) < 1.5);
  const c375full = await PurchaseInvoice.find({
    $or: [
      { subtotal: { $gte: 373.5, $lte: 376.5 } },
      { total: { $gte: 373.5, $lte: 376.5 } },
    ],
  })
    .select('serie docType status subtotal total fechaEmision createdAt retentions retentionTotal retentionVoucher clinic')
    .lean();
  console.log(`  Coincidencias por subtotal≈375: ${c375.length} · por subtotal o total≈375: ${c375full.length}`);
  c375full.forEach((p) => {
    const dentro = p.fechaEmision >= start && p.fechaEmision <= end;
    console.log(`    · serie=${p.serie || p._id} docType=${p.docType} status=${p.status}`
      + ` subtotal=${money(p.subtotal)} total=${money(p.total)}`);
    console.log(`      fechaEmision UTC=${iso(p.fechaEmision)} | LOCAL=${loc(p.fechaEmision)}`
      + ` → ¿dentro de ${year}-${String(month).padStart(2, '0')} local? ${dentro ? 'SÍ' : 'NO'}`);
    console.log(`      createdAt=${iso(p.createdAt)} retenciones=${(p.retentions || []).length}`
      + ` retentionTotal=${money(p.retentionTotal)} retentionVoucher=${p.retentionVoucher || 'null'}`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. RETENCIONES
  // ═══════════════════════════════════════════════════════════════════════════
  h1('2. RETENCIONES (RetentionVoucher + cabecera de compras)');

  const totalRv = await RetentionVoucher.countDocuments({});
  console.log(`Total de RetentionVoucher en la base: ${totalRv}`);
  const porEstadoRv = await RetentionVoucher.aggregate([
    { $group: { _id: '$estado', n: { $sum: 1 }, monto: { $sum: '$totalRetenido' } } },
    { $sort: { n: -1 } },
  ]);
  console.log('\nPor estado:');
  porEstadoRv.forEach((g) => console.log(`  · ${String(g._id).padEnd(22)} ${String(g.n).padStart(4)}   total retenido ${money(g.monto)}`));
  if (!porEstadoRv.length) console.log('  ⚠ NINGUNO — no hay comprobantes de retención guardados.');

  const ultimosRv = await RetentionVoucher.find({})
    .sort({ createdAt: -1 })
    .limit(5)
    .select('serie estab ptoEmi secuencial periodoFiscal codSustento estado totalRetenido purchaseInvoice fechaEmision createdAt updatedAt retentions')
    .lean();
  h2('Últimos 5 comprobantes de retención');
  if (!ultimosRv.length) console.log('  (ninguno)');
  ultimosRv.forEach((v, i) => {
    console.log(`  ${i + 1}. ${v.serie}  periodoFiscal=${v.periodoFiscal}  sustento=${v.codSustento}  estado=${v.estado}`);
    console.log(`     totalRetenido=${money(v.totalRetenido)}  líneas=${(v.retentions || []).length}`
      + `  purchaseInvoice=${v.purchaseInvoice}`);
    console.log(`     fechaEmision=${iso(v.fechaEmision)}  createdAt=${iso(v.createdAt)}  updatedAt=${iso(v.updatedAt)}`);
  });

  // ── Compras con retenciones en cabecera
  h2('Compras con retenciones en CABECERA (las que el modal debe mostrar)');
  const conRet = await PurchaseInvoice.countDocuments({ 'retentions.0': { $exists: true } });
  const conRetTotal = await PurchaseInvoice.countDocuments({ retentionTotal: { $gt: 0 } });
  const conVoucher = await PurchaseInvoice.countDocuments({ retentionVoucher: { $ne: null } });
  const conRetLinea = await PurchaseInvoice.countDocuments({ 'items.retentions.0': { $exists: true } });
  console.log(`  Compras con retentions[] en cabecera : ${conRet}`);
  console.log(`  Compras con retentionTotal > 0       : ${conRetTotal}`);
  console.log(`  Compras con retentionVoucher != null : ${conVoucher}`);
  console.log(`  Compras con retenciones POR LÍNEA    : ${conRetLinea}`);

  const ultimasConRet = await PurchaseInvoice.find({ 'retentions.0': { $exists: true } })
    .sort({ createdAt: -1 })
    .limit(5)
    .select('serie docType status fechaEmision createdAt updatedAt retentions retentionTotal retentionNumber retentionVoucher retentionJournalEntry items.retentions')
    .populate('retentionVoucher', 'estab ptoEmi secuencial serie fechaEmision periodoFiscal estado numeroAutorizacion totalRetenido retentions')
    .lean();

  if (!ultimasConRet.length) {
    console.log('\n  ⚠ NINGUNA compra tiene retenciones en cabecera.');
    console.log('    → El modal no muestra nada porque NO HAY NADA GUARDADO (el guardado sigue fallando).');
  }
  ultimasConRet.forEach((p, i) => {
    console.log(`\n  ${i + 1}. serie=${p.serie || p._id}  docType=${p.docType}  status=${p.status}`);
    console.log(`     fechaEmision=${iso(p.fechaEmision)} | local ${loc(p.fechaEmision)}`);
    console.log(`     createdAt=${iso(p.createdAt)}  updatedAt=${iso(p.updatedAt)}`);
    console.log(`     retentionTotal=${money(p.retentionTotal)}  retentionNumber=${p.retentionNumber || '—'}`);
    console.log(`     retenciones cabecera (${(p.retentions || []).length}):`);
    (p.retentions || []).forEach((r) => {
      console.log(`       - ${r.type} cod=${r.code || '—'} base=${money(r.baseAmount)} ${money(r.percentage)}%`
        + ` monto=${money(r.amount)} cuenta=${r.account || 'null'} rule=${r.rule || 'null'}`);
    });
    const lineRets = (p.items || []).reduce((n, it) => n + (it.retentions || []).length, 0);
    console.log(`     retenciones por línea: ${lineRets}`);
    if (p.retentionVoucher && typeof p.retentionVoucher === 'object') {
      console.log(`     retentionVoucher POBLADO ✓ → serie=${p.retentionVoucher.serie}`
        + ` estado=${p.retentionVoucher.estado} periodoFiscal=${p.retentionVoucher.periodoFiscal}`
        + ` totalRetenido=${money(p.retentionVoucher.totalRetenido)}`);
    } else if (p.retentionVoucher) {
      console.log(`     retentionVoucher = ${p.retentionVoucher}  ⚠ REFERENCIA COLGADA (no se pudo poblar: el voucher no existe)`);
    } else {
      console.log('     retentionVoucher = null  ⚠ sin comprobante vinculado');
    }
    console.log(`     retentionJournalEntry = ${p.retentionJournalEntry || 'null'}`);
  });

  // ── Vouchers huérfanos / referencias colgadas
  h2('Integridad de vínculos compra ↔ comprobante');
  const invsWithVoucherRef = await PurchaseInvoice.find({ retentionVoucher: { $ne: null } })
    .select('serie retentionVoucher').lean();
  const voucherIds = new Set((await RetentionVoucher.find({}).select('_id').lean()).map((v) => String(v._id)));
  const colgadas = invsWithVoucherRef.filter((p) => !voucherIds.has(String(p.retentionVoucher)));
  console.log(`  Compras que apuntan a un voucher inexistente: ${colgadas.length}`);
  colgadas.slice(0, 10).forEach((p) => console.log(`    · ${p.serie || p._id} → ${p.retentionVoucher}`));
  const invIds = new Set((await PurchaseInvoice.find({}).select('_id').lean()).map((p) => String(p._id)));
  const vouchersHuerfanos = (await RetentionVoucher.find({}).select('serie purchaseInvoice').lean())
    .filter((v) => !invIds.has(String(v.purchaseInvoice)));
  console.log(`  Vouchers cuya compra ya no existe: ${vouchersHuerfanos.length}`);
  vouchersHuerfanos.slice(0, 10).forEach((v) => console.log(`    · ${v.serie} → ${v.purchaseInvoice}`));

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. NÓMINA
  // ═══════════════════════════════════════════════════════════════════════════
  h1('3. NÓMINA (PayrollConfig / departamentos / conceptos / roles)');

  const configs = await PayrollConfig.find({}).lean();
  console.log(`PayrollConfig existentes: ${configs.length}`);
  if (!configs.length) console.log('  ⚠ NINGUNA — la pantalla de configuración arrancaría vacía.');

  for (const cfg of configs) {
    const clinicName = clinics.find((c) => String(c._id) === String(cfg.clinic))?.name || '(desconocida)';
    h2(`PayrollConfig · clínica ${clinicName} (${cfg.clinic})`);
    console.log(`  updatedAt=${iso(cfg.updatedAt)} (local ${loc(cfg.updatedAt)})  createdAt=${iso(cfg.createdAt)}`);
    console.log(`  paymentFrequency=${cfg.paymentFrequency}  anticipoQuincenaPct=${cfg.anticipoQuincenaPct}`
      + `  sbu=${cfg.sbu}  iessPersonal=${cfg.iessPersonal}  iessPatronal=${cfg.iessPatronal}`);

    const acc = cfg.accounts || {};
    const global = acc.global || null;
    const byDept = acc.byDepartment || null;
    console.log(`  accounts.global        : ${global ? 'existe' : '⚠ NO EXISTE'}`);
    console.log(`  accounts.byDepartment  : ${byDept ? 'existe' : '⚠ NO EXISTE'}`);

    if (global) {
      const keys = Object.keys(PayrollConfig.schema.path('accounts.global').schema.paths);
      const set = keys.filter((k) => global[k]);
      const nulls = keys.filter((k) => !global[k]);
      console.log(`    global: ${set.length}/${keys.length} campos CON cuenta · ${nulls.length} en null`);
      console.log(`      con cuenta: ${set.length ? set.join(', ') : '(ninguno)'}`);
      console.log(`      en null   : ${nulls.length ? nulls.join(', ') : '(ninguno)'}`);
    }
    if (byDept) {
      for (const t of DEPT_TYPES) {
        const d = byDept[t];
        if (!d) { console.log(`    byDepartment.${t}: ⚠ NO EXISTE`); continue; }
        const keys = Object.keys(PayrollConfig.schema.path(`accounts.byDepartment.${t}`).schema.paths);
        const set = keys.filter((k) => d[k]);
        const nulls = keys.filter((k) => !d[k]);
        console.log(`    byDepartment.${t.padEnd(14)}: ${String(set.length).padStart(2)}/${keys.length} con cuenta`
          + ` · null: ${nulls.length ? nulls.join(', ') : '(ninguno)'}`);
      }
      const extra = Object.keys(byDept).filter((k) => !DEPT_TYPES.includes(k));
      if (extra.length) console.log(`    ⚠ claves NO estándar en byDepartment: ${extra.join(', ')}`);
    }
  }

  h2('PayrollDepartment (departamentos)');
  const depts = await PayrollDepartment.find({}).lean();
  console.log(`  Total: ${depts.length}`);
  depts.forEach((d) => {
    const legacy = d.accounts && (d.accounts.sueldos || d.accounts.beneficios || d.accounts.iessPatronal);
    console.log(`    · name="${d.name}" type=${d.type} active=${d.active} clinic=${d.clinic}`
      + `  cuentas legacy=${legacy ? 'SÍ (sueldos/beneficios/iessPatronal poblados)' : 'no'}`
      + `  createdAt=${iso(d.createdAt)}`);
  });
  const STD = ['ADMINISTRATIVO', 'VENTAS', 'COSTOS', 'OTROS'];
  const noEstandar = depts.filter((d) => !STD.includes(d.type) || !STD.includes(String(d.name).toUpperCase()));
  console.log(`  Departamentos cuyo NOMBRE no es uno de los 4 estándar: ${noEstandar.length}`);
  noEstandar.forEach((d) => console.log(`    · "${d.name}" (type=${d.type})`));

  h2('PayrollConcept legacy con deptAccounts (deptAccounts es ARRAY de {department, account})');
  const totalConcepts = await PayrollConcept.countDocuments({});
  const conDeptAcc = await PayrollConcept.find({ 'deptAccounts.0': { $exists: true } })
    .select('code name deptAccounts').lean();
  console.log(`  Total de conceptos: ${totalConcepts}`);
  console.log(`  Con deptAccounts poblado (≥1 entrada): ${conDeptAcc.length}`);
  conDeptAcc.slice(0, 10).forEach((c) => {
    console.log(`    · ${c.code} ${c.name} → ${(c.deptAccounts || []).length} mapeo(s)`
      + ` (dept→cuenta: ${(c.deptAccounts || []).map((m) => `${m.department}→${m.account}`).join(', ')})`);
  });

  h2('Últimos 3 roles de pago');
  const roles = await Payroll.find({})
    .sort({ year: -1, month: -1, createdAt: -1 })
    .limit(3)
    .select('year month periodType status clinic journalEntry payableRef createdAt updatedAt')
    .lean();
  if (!roles.length) console.log('  (ninguno)');
  roles.forEach((r) => {
    console.log(`    · ${r.year}-${String(r.month).padStart(2, '0')} periodType=${r.periodType || '⚠ SIN periodType'}`
      + ` status=${r.status} journalEntry=${r.journalEntry || 'null'} payableRef=${r.payableRef || 'null'}`);
    console.log(`      createdAt=${iso(r.createdAt)}  updatedAt=${iso(r.updatedAt)}`);
  });
  const sinPeriodType = await Payroll.countDocuments({ periodType: { $exists: false } });
  console.log(`  Roles SIN periodType (migratePayrollPeriodType pendiente): ${sinPeriodType}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. ACTIVOS FIJOS
  // ═══════════════════════════════════════════════════════════════════════════
  h1('4. ACTIVOS FIJOS');

  const totalFa = await FixedAsset.countDocuments({});
  console.log(`Total de FixedAsset: ${totalFa}`);
  const dupes = await FixedAsset.aggregate([
    { $group: { _id: { clinic: '$clinic', code: '$code' }, n: { $sum: 1 }, ids: { $push: '$_id' } } },
    { $match: { n: { $gt: 1 } } },
  ]);
  console.log(`Códigos duplicados por (clinic, code): ${dupes.length}`);
  dupes.slice(0, 10).forEach((d) => console.log(`  · code=${d._id.code} → ${d.n} documentos (${d.ids.join(', ')})`));

  const porEstadoFa = await FixedAsset.aggregate([
    { $group: { _id: '$status', n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ]);
  console.log(`Por estado: ${JSON.stringify(porEstadoFa.map((g) => ({ [g._id]: g.n })))}`);

  const desdeCompras = await FixedAsset.find({ purchaseInvoice: { $ne: null } })
    .sort({ createdAt: -1 })
    .limit(15)
    .select('code name status purchaseInvoice purchaseLineIndex purchaseUnitIndex acquisitionCost createdAt')
    .populate('purchaseInvoice', 'serie status fechaEmision')
    .lean();
  console.log(`\nActivos vinculados a una compra (últimos ${desdeCompras.length}):`);
  desdeCompras.forEach((a) => {
    const pi = a.purchaseInvoice;
    console.log(`  · code=${a.code} "${a.name}" status=${a.status} costo=${money(a.acquisitionCost)}`);
    console.log(`    compra=${pi && typeof pi === 'object' ? `${pi.serie} (${pi.status})` : `${pi} ⚠ referencia colgada`}`
      + ` línea=${a.purchaseLineIndex} unidad=${a.purchaseUnitIndex} createdAt=${iso(a.createdAt)}`);
  });
  const sinCompra = await FixedAsset.countDocuments({ purchaseInvoice: null });
  console.log(`\nActivos SIN compra de origen (alta manual): ${sinCompra}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. VERSIÓN DESPLEGADA / BUILD
  // ═══════════════════════════════════════════════════════════════════════════
  h1('5. VERSIÓN DEL CÓDIGO EN ESTE WORKING TREE');
  const repoRoot = path.resolve(__dirname, '..', '..');
  try {
    const head = execSync('git rev-parse HEAD', { cwd: repoRoot }).toString().trim();
    const short = execSync('git log -1 --pretty=format:"%h %ad %s" --date=iso', { cwd: repoRoot }).toString().trim();
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: repoRoot }).toString().trim();
    const dirty = execSync('git status --porcelain', { cwd: repoRoot }).toString().trim();
    console.log(`  HEAD   : ${head}`);
    console.log(`  branch : ${branch}`);
    console.log(`  commit : ${short}`);
    console.log(`  working tree: ${dirty ? `${dirty.split('\n').length} archivo(s) con cambios sin commitear` : 'limpio'}`);
  } catch (e) {
    console.log(`  (no se pudo leer git: ${e.message})`);
  }

  const distIndex = path.join(repoRoot, 'client', 'dist', 'index.html');
  if (fs.existsSync(distIndex)) {
    const st = fs.statSync(distIndex);
    console.log(`  client/dist/index.html: ${iso(st.mtime)} (local ${loc(st.mtime)})`);
    const assets = path.join(repoRoot, 'client', 'dist', 'assets');
    if (fs.existsSync(assets)) {
      const files = fs.readdirSync(assets)
        .map((f) => ({ f, m: fs.statSync(path.join(assets, f)).mtime }))
        .sort((a, b) => b.m - a.m)
        .slice(0, 3);
      files.forEach((x) => console.log(`    asset ${x.f} → ${iso(x.m)}`));
    }
  } else {
    console.log('  client/dist: NO existe artefacto local (el build vive solo en el VPS).');
  }

  console.log('\nFIN DEL DIAGNÓSTICO (no se escribió nada en la base).\n');
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('ERROR:', e);
  try { await mongoose.disconnect(); } catch { /* noop */ }
  process.exit(1);
});
