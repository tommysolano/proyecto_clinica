/**
 * Migra departamentos/cargos de EMPLEADOS que hoy están como texto libre a los
 * catálogos parametrizados (PayrollDepartment / PayrollPosition) y enlaza las
 * referencias en cada empleado (departmentRef / positionRef). No borra los textos
 * legacy. Idempotente. Dry-run por defecto; --commit para aplicar.
 *
 *   node scripts/migratePayrollDepartments.js
 *   node scripts/migratePayrollDepartments.js --commit
 *   node scripts/migratePayrollDepartments.js --clinic=<id> --commit
 *
 * Los departamentos nuevos se crean con type ADMINISTRATIVO y SIN cuentas: el
 * contador debe asignarles la cuenta de gasto antes de cerrar roles nuevos.
 */
const { parseArgs, connect, disconnect, banner } = require('./_common');
const Employee = require('../models/Employee');
const PayrollDepartment = require('../models/PayrollDepartment');
const PayrollPosition = require('../models/PayrollPosition');

async function findOrCreate(Model, filter, data, commit) {
  let doc = await Model.findOne(filter);
  if (!doc && commit) doc = await Model.create(data);
  return doc;
}

async function run() {
  const opts = parseArgs();
  banner('Migración departamentos/cargos de nómina', opts);
  await connect();
  try {
    const q = opts.clinic ? { clinic: opts.clinic } : {};
    const employees = await Employee.find(q);
    let deptCreated = 0; let posCreated = 0; let linked = 0;
    for (const e of employees) {
      const deptName = (e.department || '').trim();
      const posName = (e.position || '').trim();
      let deptRef = e.departmentRef;
      let posRef = e.positionRef;

      if (deptName && !deptRef) {
        let dept = await PayrollDepartment.findOne({ clinic: e.clinic, name: deptName });
        if (!dept) {
          console.log(`  + Departamento «${deptName}» (clínica ${e.clinic})`);
          deptCreated += 1;
          dept = await findOrCreate(PayrollDepartment, { clinic: e.clinic, name: deptName },
            { clinic: e.clinic, name: deptName, type: 'ADMINISTRATIVO' }, opts.commit);
        }
        deptRef = dept?._id || null;
      }
      if (posName && !posRef) {
        let pos = await PayrollPosition.findOne({ clinic: e.clinic, name: posName });
        if (!pos) {
          console.log(`  + Cargo «${posName}» (clínica ${e.clinic})`);
          posCreated += 1;
          pos = await findOrCreate(PayrollPosition, { clinic: e.clinic, name: posName },
            { clinic: e.clinic, name: posName, department: deptRef || null }, opts.commit);
        }
        posRef = pos?._id || null;
      }
      const needsLink = (deptRef && String(deptRef) !== String(e.departmentRef || '')) ||
                        (posRef && String(posRef) !== String(e.positionRef || ''));
      if (needsLink) {
        linked += 1;
        console.log(`  ↪ Empleado ${e.code} → depto=${deptName || '-'} cargo=${posName || '-'}`);
        if (opts.commit) {
          e.departmentRef = deptRef || e.departmentRef;
          e.positionRef = posRef || e.positionRef;
          await e.save();
        }
      }
    }
    console.log(`\nDepartamentos ${opts.commit ? 'creados' : 'a crear'}: ${deptCreated}`);
    console.log(`Cargos ${opts.commit ? 'creados' : 'a crear'}: ${posCreated}`);
    console.log(`Empleados ${opts.commit ? 'enlazados' : 'a enlazar'}: ${linked}`);
    console.log('\nRecuerda asignar la cuenta de gasto a cada departamento nuevo antes de cerrar roles.');
  } finally {
    await disconnect();
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
