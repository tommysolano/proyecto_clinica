/**
 * Migra la configuración de cuentas de nómina a la NUEVA estructura de PayrollConfig.accounts
 * (global + byDepartment), pedida por la contadora (estructura Contífico, ver
 * docs/CONFIGURACION_NOMINA.md).
 *
 * Lleva sin perder nada lo que ya estaba mapeado:
 *   - PayrollConfig.accounts (CÓDIGOS del plan, legacy)     → cuentas globales + gasto base por depto
 *   - PayrollDepartment.accounts (sueldos/beneficios/iessPatronal por depto) → byDepartment[TIPO]
 *   - PayrollConcept.deptAccounts (cuenta por concepto×depto) → byDepartment[TIPO][rubro de ingreso]
 *
 * SOLO rellena campos AÚN vacíos (undefined): no pisa lo que ya migraste o configuraste. Idempotente.
 *
 * Uso:
 *   node scripts/migratePayrollAccounts.js           (dry-run: solo muestra)
 *   node scripts/migratePayrollAccounts.js --commit  (aplica los cambios)
 *
 * OJO: el .env local apunta a PRODUCCIÓN. Preferir ejecutarlo en el VPS.
 */
process.env.TZ = process.env.TZ || 'America/Guayaquil';
require('dotenv').config();
const mongoose = require('mongoose');
const PayrollConfig = require('../models/PayrollConfig');
const PayrollDepartment = require('../models/PayrollDepartment');
const PayrollConcept = require('../models/PayrollConcept');
const ChartOfAccount = require('../models/ChartOfAccount');

const { DEPT_TYPES } = PayrollConfig;
const norm = (t) => { const u = String(t || '').toUpperCase(); return u === 'OTRO' ? 'OTROS' : (DEPT_TYPES.includes(u) ? u : 'ADMINISTRATIVO'); };

// Concepto (código) → campo de INGRESO por departamento (mismo mapa que el posteo).
const INCOME_FIELD_BY_CODE = {
  'ING-SUELDO': 'sueldo', 'ING-ALIMENTACION': 'alimentacion', 'ING-TRANSPORTE': 'transporte',
  'ING-VIVIENDA': 'vivienda', 'ING-COMISIONES': 'comisiones', 'ING-HE25': 'horasExtra',
  'ING-HE50': 'horasExtra', 'ING-HE100': 'horasExtra', 'ING-BONIFICACION': 'bonificaciones',
  'ING-DEVOLUCION-DIAS': 'devDiasMultas', 'ING-OTROS': 'otrosIngresos',
  'ING-VACACIONES': 'vacacionesGasto', 'ING-FONDOS-RESERVA': 'fondosReservaGasto',
  'ING-DECIMO-TERCERO': 'dec3Gasto', 'ING-DECIMO-CUARTO': 'dec4Gasto',
};

async function main() {
  const commit = process.argv.includes('--commit');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Modo: ${commit ? 'COMMIT (escribe)' : 'DRY-RUN (solo muestra)'}`);

  const db = mongoose.connection.db;
  // Clínicas con algo de nómina configurado.
  const clinicIds = new Set();
  for (const c of await db.collection('payrollconfigs').find({}, { projection: { clinic: 1 } }).toArray()) clinicIds.add(String(c.clinic));
  for (const d of await PayrollDepartment.find({}).select('clinic').lean()) clinicIds.add(String(d.clinic));

  let clinicsChanged = 0;
  let fieldsSet = 0;

  for (const clinicId of clinicIds) {
    const cid = new mongoose.Types.ObjectId(clinicId);
    // Resuelve cuentas por código dentro de la clínica.
    const accs = await ChartOfAccount.find({ clinic: cid }).select('code').lean();
    const idByCode = new Map(accs.map((a) => [a.code, a._id]));
    const byCode = (code) => idByCode.get(code) || null;

    const raw = await db.collection('payrollconfigs').findOne({ clinic: cid });
    const oldAcc = (raw && raw.accounts) || {};
    // Detecta config LEGACY (cuentas por código en strings) vs NUEVA (global/byDepartment).
    const isLegacy = oldAcc && (typeof oldAcc.sueldos === 'string' || typeof oldAcc.sueldosPorPagar === 'string');

    const cfg = await PayrollConfig.findOne({ clinic: cid }) || new PayrollConfig({ clinic: cid });
    cfg.accounts = cfg.accounts || {};
    cfg.accounts.global = cfg.accounts.global || {};
    cfg.accounts.byDepartment = cfg.accounts.byDepartment || {};
    for (const t of DEPT_TYPES) cfg.accounts.byDepartment[t] = cfg.accounts.byDepartment[t] || {};

    const setG = (field, id) => { if (id && cfg.accounts.global[field] === undefined) { cfg.accounts.global[field] = id; fieldsSet += 1; } };
    const setD = (type, field, id) => { if (id && cfg.accounts.byDepartment[type][field] === undefined) { cfg.accounts.byDepartment[type][field] = id; fieldsSet += 1; } };

    // Globales desde los códigos legacy (no dependen del departamento).
    if (isLegacy) {
      setG('sueldosPorPagar', byCode(oldAcc.sueldosPorPagar));
      setG('iessPersonal', byCode(oldAcc.iessPorPagar));
      setG('aportePatronalPasivo', byCode(oldAcc.iessPorPagar));
      setG('secapPasivo', byCode(oldAcc.iessPorPagar));
      setG('aporteConyugal', byCode(oldAcc.iessPorPagar));
      setG('impRenta', byCode(oldAcc.irPorPagar));
      setG('dec3Pasivo', byCode(oldAcc.decimoTerceroPorPagar));
      setG('dec4Pasivo', byCode(oldAcc.decimoCuartoPorPagar));
      setG('fondosReservaPasivo', byCode(oldAcc.fondosReservaPorPagar));
      setG('vacacionesPasivo', byCode(oldAcc.vacacionesPorPagar));
      const cxc = byCode(oldAcc.cxcEmpleados);
      for (const f of ['descuento', 'multa', 'ausencias', 'seguros', 'celular', 'descuentoDiasNoLaborados', 'otrosEgresos']) setG(f, cxc);
      setG('prestamoPersonal', byCode(oldAcc.prestamosPorCobrar));
      setG('anticipos', byCode(oldAcc.anticipoQuincena) || byCode(oldAcc.cxcEmpleados));
    }

    // byDepartment por PRIORIDAD (setD solo rellena lo aún vacío): lo MÁS específico primero.
    const depts = await PayrollDepartment.find({ clinic: cid }).lean();
    const deptTypeById = new Map(depts.map((d) => [String(d._id), norm(d.type)]));

    // 1) Override por concepto×departamento (PayrollConcept.deptAccounts) — lo más específico.
    const concepts = await PayrollConcept.find({ clinic: cid, type: { $in: ['INGRESO', 'PROVISION'] } }).lean();
    for (const c of concepts) {
      const field = INCOME_FIELD_BY_CODE[c.code];
      if (!field) continue;
      for (const ov of c.deptAccounts || []) {
        const t = deptTypeById.get(String(ov.department));
        if (t && ov.account) setD(t, field, ov.account);
      }
    }
    // 2) Override por departamento (PayrollDepartment.accounts).
    for (const d of depts) {
      const t = norm(d.type);
      const da = d.accounts || {};
      setD(t, 'sueldo', da.sueldos);
      if (da.beneficios) { setD(t, 'dec3Gasto', da.beneficios); setD(t, 'dec4Gasto', da.beneficios); setD(t, 'fondosReservaGasto', da.beneficios); }
      if (da.iessPatronal) { setD(t, 'aportePatronalGasto', da.iessPatronal); setD(t, 'secapGasto', da.iessPatronal); }
    }
    // 3) Baseline genérico desde los códigos generales legacy (rellena el resto de los 4 tipos).
    if (isLegacy) {
      const gSueldo = byCode(oldAcc.sueldos), gBenef = byCode(oldAcc.beneficios), gPatr = byCode(oldAcc.iessPatronal), gVac = byCode(oldAcc.gastoVacaciones);
      for (const t of DEPT_TYPES) {
        setD(t, 'sueldo', gSueldo); setD(t, 'otrosIngresos', gSueldo);
        setD(t, 'dec3Gasto', gBenef); setD(t, 'dec4Gasto', gBenef); setD(t, 'fondosReservaGasto', gBenef);
        setD(t, 'vacacionesGasto', gVac); setD(t, 'aportePatronalGasto', gPatr); setD(t, 'secapGasto', gPatr);
      }
    }

    cfg.markModified('accounts');
    const dirty = cfg.isModified('accounts') || cfg.isNew;
    if (dirty) {
      clinicsChanged += 1;
      if (commit) await cfg.save();
    }
  }

  console.log(`\nClínicas revisadas: ${clinicIds.size}`);
  console.log(`Clínicas con cuentas migradas: ${clinicsChanged}`);
  console.log(`Campos de cuenta rellenados: ${fieldsSet}`);
  if (!commit && fieldsSet) console.log('\n(Revisa y vuelve a correr con --commit para aplicar.)');
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
