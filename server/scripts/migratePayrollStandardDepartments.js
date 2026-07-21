/**
 * Unifica los departamentos de nómina a los 4 ESTÁNDAR por clínica (Administrativo, Ventas,
 * Costos, Otros). Pedido de la contadora: "los departamentos deben cargar por default; yo solo
 * creo los CARGOS".
 *
 * Distinto de migratePayrollDepartments.js (aquel crea catálogos desde el texto libre de los
 * empleados). Este REDUCE los departamentos a los 4 estándar:
 *   1. Siembra los 4 departamentos estándar (uno por TIPO) si faltan.
 *   2. Elige el CANÓNICO por tipo (el estándar) y REASIGNA empleados y cargos que apuntan a un
 *      departamento personalizado del mismo tipo → el canónico.
 *   3. Desactiva (no borra, para conservar historial) los departamentos personalizados vaciados.
 *
 * Reporta en dry-run qué se reasigna. Idempotente.
 *
 *   node scripts/migratePayrollStandardDepartments.js
 *   node scripts/migratePayrollStandardDepartments.js --commit
 *   node scripts/migratePayrollStandardDepartments.js --clinic=<id> --commit
 */
const { parseArgs, connect, disconnect, banner } = require('./_common');
const PayrollDepartment = require('../models/PayrollDepartment');
const PayrollPosition = require('../models/PayrollPosition');
const Employee = require('../models/Employee');

const STANDARD = [
  { name: 'Administrativo', type: 'ADMINISTRATIVO' },
  { name: 'Ventas', type: 'VENTAS' },
  { name: 'Costos', type: 'COSTOS' },
  { name: 'Otros', type: 'OTROS' },
];
const norm = (t) => { const u = String(t || '').toUpperCase(); return u === 'OTRO' ? 'OTROS' : u; };

async function run() {
  const opts = parseArgs();
  banner('Unificación de departamentos estándar de nómina', opts);
  await connect();
  try {
    const deptFilter = opts.clinic ? { clinic: opts.clinic } : {};
    const clinicIds = [...new Set((await PayrollDepartment.find(deptFilter).select('clinic').lean()).map((d) => String(d.clinic)))];

    let created = 0; let empReassigned = 0; let posReassigned = 0; let deactivated = 0;

    for (const clinicId of clinicIds) {
      const depts = await PayrollDepartment.find({ clinic: clinicId });
      const byName = new Map(depts.map((d) => [d.name, d]));

      // 1) Canónico por tipo (reusa un depto del mismo tipo si existe, si no lo crea).
      const canonical = {};
      for (const s of STANDARD) {
        let std = byName.get(s.name);
        if (!std) {
          std = depts.find((d) => norm(d.type) === s.type && d.active !== false);
          if (std && std.name !== s.name) {
            console.log(`  [${clinicId}] canónico ${s.type}: reusa «${std.name}» → «${s.name}»`);
            if (opts.commit) { std.name = s.name; std.type = s.type; await std.save().catch(() => {}); }
          } else if (!std) {
            console.log(`  [${clinicId}] crea departamento estándar «${s.name}» (${s.type})`);
            created += 1;
            std = opts.commit
              ? await PayrollDepartment.create({ clinic: clinicId, name: s.name, type: s.type })
              : { _id: `virtual-${s.type}`, name: s.name, type: s.type };
          }
        } else if (std.type !== s.type) {
          if (opts.commit) { std.type = s.type; await std.save().catch(() => {}); }
        }
        canonical[s.type] = std;
      }

      // 2) Reasigna empleados y cargos de departamentos personalizados → canónico del mismo tipo.
      const custom = depts.filter((d) => !STANDARD.some((s) => s.name === d.name));
      for (const c of custom) {
        const canon = canonical[norm(c.type)];
        if (!canon || String(canon._id) === String(c._id)) continue;

        for (const e of await Employee.find({ clinic: clinicId, departmentRef: c._id }).select('firstName lastName code')) {
          console.log(`  [${clinicId}] empleado ${e.code} «${e.firstName} ${e.lastName}»: «${c.name}» → «${canon.name}»`);
          empReassigned += 1;
          if (opts.commit) await Employee.updateOne({ _id: e._id }, { $set: { departmentRef: canon._id } });
        }
        for (const p of await PayrollPosition.find({ clinic: clinicId, department: c._id }).select('name')) {
          console.log(`  [${clinicId}] cargo «${p.name}»: «${c.name}» → «${canon.name}»`);
          posReassigned += 1;
          if (opts.commit) await PayrollPosition.updateOne({ _id: p._id }, { $set: { department: canon._id } });
        }
        if (c.active !== false) {
          deactivated += 1;
          if (opts.commit) await PayrollDepartment.updateOne({ _id: c._id }, { $set: { active: false } });
        }
      }
    }

    console.log(`\nClínicas revisadas: ${clinicIds.length}`);
    console.log(`Departamentos estándar ${opts.commit ? 'creados' : 'a crear'}: ${created}`);
    console.log(`Empleados ${opts.commit ? 'reasignados' : 'a reasignar'}: ${empReassigned}`);
    console.log(`Cargos ${opts.commit ? 'reasignados' : 'a reasignar'}: ${posReassigned}`);
    console.log(`Departamentos personalizados ${opts.commit ? 'desactivados' : 'a desactivar'}: ${deactivated}`);
  } finally {
    await disconnect();
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
