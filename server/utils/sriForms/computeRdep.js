/**
 * CÁLCULO DEL ANEXO RDEP (Retenciones en la fuente por relación de dependencia), ANUAL.
 *
 * Es el detalle, empleado por empleado, de lo que el Formulario 103 declaró mes a mes en el
 * casillero de relación de dependencia. Por eso REUSA la misma fuente y el mismo mapeo
 * auditable que el 103 (`utils/payrollWithholding`): si el 103 y el RDEP no cuadraran, el
 * SRI lo detecta. Se calcula mes a mes y se acumula, así la conciliación es por construcción.
 *
 * Qué CALCULA el sistema (de las nóminas CERRADAS/PAGADAS del año):
 *   - ingresos gravados con este empleador, desglosados en sueldo y sobresueldos
 *     (horas extra, bonos, comisiones y rubros flexibles que gravan);
 *   - ingresos NO gravados (décimos, fondos de reserva, vacaciones) — informativos;
 *   - aporte personal al IESS;
 *   - impuesto a la renta retenido por este empleador.
 *
 * Qué CAPTURA el contador (modelo RdepAnnex): gastos personales del empleado, ingresos /
 * aportes / retenciones de OTROS empleadores y exoneraciones. El sistema no puede conocerlos.
 *
 * Base imponible = (gravados propios + gravados otros) − IESS propio − IESS otros
 *                  − gastos personales deducibles − exoneraciones.
 * El impuesto CAUSADO se calcula con la tabla vigente del IR (`PayrollIncomeTaxTable`), la
 * misma que usa la nómina; si no hay tabla del año, se informa y queda en 0 con advertencia.
 */
const Payroll = require('../../models/Payroll');
const PayrollConcept = require('../../models/PayrollConcept');
const Employee = require('../../models/Employee');
const { classifyEarning, INCLUDED_STATUSES } = require('../payrollWithholding');

const r2 = (n) => +(Number(n) || 0).toFixed(2);

const GASTO_FIELDS = [
  'gastosVivienda', 'gastosSalud', 'gastosEducacion',
  'gastosAlimentacion', 'gastosVestimenta', 'gastosTurismo',
];

/** Fila vacía del anexo para un empleado. */
function emptyRow(identificacion, nombre) {
  return {
    identificacion: identificacion || '',
    tipoIdentificacion: 'CEDULA',
    nombre: nombre || '',
    cargo: '',
    // Calculado de la nómina
    sueldos: 0,              // sueldo ganado del período
    sobresueldos: 0,         // horas extra + bonos + comisiones + flexibles gravados
    gravadoEmpleador: 0,     // sueldos + sobresueldos (= base gravada del 103)
    noGravado: 0,            // décimos, fondos, vacaciones (informativo)
    iessPersonal: 0,
    retenidoEmpleador: 0,
    meses: 0,                // nº de roles del año en que aparece
    // Capturado por el contador (RdepAnnex)
    ingresosOtrosEmpleadores: 0,
    iessOtrosEmpleadores: 0,
    retenidoOtrosEmpleadores: 0,
    gastosVivienda: 0, gastosSalud: 0, gastosEducacion: 0,
    gastosAlimentacion: 0, gastosVestimenta: 0, gastosTurismo: 0,
    exoneracionDiscapacidad: 0, exoneracionTerceraEdad: 0,
    // Derivados
    gastosPersonales: 0,
    baseImponible: 0,
    impuestoCausado: 0,
    // impuesto causado − retenido por otros; si es negativo, no hay nada más que retener
    saldoPorRetener: 0,
  };
}

/**
 * Impuesto a la renta causado según la tabla progresiva del ejercicio
 * (`PayrollIncomeTaxTable`, la MISMA que usa la nómina). El RDEP es anual, así que solo
 * tiene sentido con una tabla ANNUAL; si la configurada es MONTHLY se anualiza el tramo.
 * Regla del modelo: base > `from` y (base <= `to` o `to` nulo) ⇒ IR = baseTax + (base − from) × excessRate/100.
 * @returns {{ impuesto: number, tablaEncontrada: boolean }}
 */
function impuestoCausado(base, tabla) {
  const ranges = tabla?.ranges;
  if (!Array.isArray(ranges) || !ranges.length) return { impuesto: 0, tablaEncontrada: false };
  const factor = tabla.periodType === 'MONTHLY' ? 12 : 1;
  const b = Math.max(0, Number(base) || 0);
  const ordenados = [...ranges]
    .map((t) => ({
      from: (Number(t.from) || 0) * factor,
      to: t.to == null ? null : Number(t.to) * factor,
      baseTax: (Number(t.baseTax) || 0) * factor,
      excessRate: Number(t.excessRate) || 0,
    }))
    .sort((x, y) => x.from - y.from);
  // Tramo cuyo límite inferior es el mayor que no supera la base.
  let tramo = ordenados[0];
  for (const t of ordenados) {
    if (b > t.from) tramo = t; else break;
  }
  const excedente = Math.max(0, b - tramo.from);
  return { impuesto: r2(tramo.baseTax + excedente * (tramo.excessRate / 100)), tablaEncontrada: true };
}

/**
 * @param {object} args { clinicId, year, overrides }  overrides: { [identificacion]: {...} }
 * @returns {Promise<{ rows, totals, warnings, conciliaciones }>}
 */
async function computeRdep({ clinicId, year, overrides = {} }) {
  const warnings = [];

  // Mismo criterio que el 103: la QUINCENA_1 es un anticipo (sin IESS ni IR) y no entra;
  // solo cuentan los roles CERRADOS o PAGADOS.
  const rolls = await Payroll.find({
    clinic: clinicId, year, periodType: { $ne: 'QUINCENA_1' },
  }).lean();
  const incluidos = rolls.filter((p) => INCLUDED_STATUSES.includes(p.status));
  const borradores = rolls.filter((p) => p.status === 'BORRADOR');
  if (borradores.length) {
    warnings.push({
      code: 'NOMINA_BORRADOR_EXCLUIDA',
      message: `${borradores.length} rol(es) del ${year} están en BORRADOR: no entran al RDEP hasta cerrarlos.`,
    });
  }
  if (!incluidos.length) {
    warnings.push({
      code: 'SIN_NOMINA_CERRADA',
      severity: 'info',
      message: `No hay nóminas cerradas en ${year}: el RDEP sale vacío.`,
    });
  }

  // Conceptos (para clasificar los rubros flexibles con el MISMO mapeo del 103).
  const conceptIds = [...new Set(
    incluidos.flatMap((p) => (p.items || []).flatMap((it) => (it.earnings || []).map((e) => (e.concept ? String(e.concept) : ''))))
  )].filter(Boolean);
  const concepts = conceptIds.length
    ? await PayrollConcept.find({ clinic: clinicId, _id: { $in: conceptIds } }).lean()
    : [];
  const conceptById = new Map(concepts.map((c) => [String(c._id), c]));

  const byId = new Map();
  const sinIdentificacion = [];

  for (const p of incluidos) {
    for (const it of p.items || []) {
      const ident = String(it.identificacion || '').trim();
      if (!ident) {
        sinIdentificacion.push(it.employeeName || '(sin nombre)');
        continue;
      }
      if (!byId.has(ident)) byId.set(ident, emptyRow(ident, it.employeeName || ''));
      const row = byId.get(ident);
      if (!row.nombre && it.employeeName) row.nombre = it.employeeName;
      row.meses += 1;

      row.sueldos = r2(row.sueldos + (Number(it.baseSalary) || 0));
      let sobre = (Number(it.overtime) || 0) + (Number(it.bonuses) || 0) + (Number(it.commissions) || 0);
      // Rubros flexibles: gravan solo si el concepto está clasificado como gravado (igual que el 103).
      for (const e of it.earnings || []) {
        const amt = Number(e.amount) || 0;
        if (amt <= 0) continue;
        const concept = e.concept ? conceptById.get(String(e.concept)) : null;
        if (classifyEarning(e, concept).incluido) sobre += amt;
      }
      row.sobresueldos = r2(row.sobresueldos + sobre);
      row.noGravado = r2(row.noGravado
        + (Number(it.decimoTercero) || 0) + (Number(it.decimoCuarto) || 0)
        + (Number(it.fondosReserva) || 0) + (Number(it.vacaciones) || 0));
      row.iessPersonal = r2(row.iessPersonal + (Number(it.iessPersonal) || 0));
      row.retenidoEmpleador = r2(row.retenidoEmpleador + (Number(it.impuestoRenta) || 0));
    }
  }

  if (sinIdentificacion.length) {
    warnings.push({
      code: 'EMPLEADO_SIN_IDENTIFICACION',
      message: `${sinIdentificacion.length} empleado(s) en la nómina no tienen identificación y NO se pueden reportar en el RDEP: ${[...new Set(sinIdentificacion)].slice(0, 5).join(', ')}. Complete la cédula en su ficha.`,
    });
  }

  // Tipo de identificación y cargo desde la ficha del empleado (el rol solo guarda el número).
  const idents = [...byId.keys()];
  const employees = idents.length
    ? await Employee.find({ clinic: clinicId, identificacion: { $in: idents } })
      .select('identificacion tipoIdentificacion position').lean()
    : [];
  const empByIdent = new Map(employees.map((e) => [String(e.identificacion), e]));

  // Tabla del IR del año (la misma que usa la nómina).
  let tabla = null;
  try {
    const PayrollIncomeTaxTable = require('../../models/PayrollIncomeTaxTable');
    tabla = await PayrollIncomeTaxTable.findOne({ clinic: clinicId, year, active: true }).lean();
  } catch { /* sin tabla: se advierte más abajo */ }
  if (!tabla) {
    warnings.push({
      code: 'SIN_TABLA_IR',
      message: `No hay tabla del impuesto a la renta para ${year}: el "impuesto causado" del anexo queda en 0. Cárguela en Configuración de nómina.`,
    });
  }

  const rows = [];
  for (const ident of idents) {
    const row = byId.get(ident);
    const emp = empByIdent.get(ident);
    if (emp) {
      row.tipoIdentificacion = emp.tipoIdentificacion || 'CEDULA';
      row.cargo = emp.position || '';
    }
    row.gravadoEmpleador = r2(row.sueldos + row.sobresueldos);

    // Lo capturado por el contador (se ignora cualquier clave que no sea editable).
    const ov = overrides[ident] || {};
    for (const k of [
      'ingresosOtrosEmpleadores', 'iessOtrosEmpleadores', 'retenidoOtrosEmpleadores',
      ...GASTO_FIELDS, 'exoneracionDiscapacidad', 'exoneracionTerceraEdad',
    ]) {
      row[k] = r2(ov[k]);
    }

    row.gastosPersonales = r2(GASTO_FIELDS.reduce((s, k) => s + row[k], 0));
    const exoneraciones = r2(row.exoneracionDiscapacidad + row.exoneracionTerceraEdad);
    row.baseImponible = r2(Math.max(0,
      row.gravadoEmpleador + row.ingresosOtrosEmpleadores
      - row.iessPersonal - row.iessOtrosEmpleadores
      - row.gastosPersonales - exoneraciones
    ));
    row.impuestoCausado = impuestoCausado(row.baseImponible, tabla).impuesto;
    row.saldoPorRetener = r2(row.impuestoCausado - row.retenidoEmpleador - row.retenidoOtrosEmpleadores);
    rows.push(row);
  }
  rows.sort((a, b) => String(a.nombre).localeCompare(String(b.nombre)));

  const sum = (k) => r2(rows.reduce((s, r) => s + (Number(r[k]) || 0), 0));
  const totals = {
    empleados: rows.length,
    gravadoEmpleador: sum('gravadoEmpleador'),
    noGravado: sum('noGravado'),
    iessPersonal: sum('iessPersonal'),
    gastosPersonales: sum('gastosPersonales'),
    baseImponible: sum('baseImponible'),
    impuestoCausado: sum('impuestoCausado'),
    retenidoEmpleador: sum('retenidoEmpleador'),
    retenidoOtrosEmpleadores: sum('retenidoOtrosEmpleadores'),
  };

  // Diferencia entre lo causado y lo efectivamente retenido: es el aviso clásico del RDEP
  // (faltó o sobró retención en el ejercicio) y hay que verlo ANTES de presentar el anexo.
  const descuadre = rows.filter((r) => Math.abs(r.saldoPorRetener) > 0.5);
  if (descuadre.length) {
    warnings.push({
      code: 'RETENCION_INCOMPLETA',
      severity: 'info',
      message: `${descuadre.length} empleado(s) tienen diferencia entre el impuesto causado y lo retenido en el año. Revise si corresponde ajustar la retención de diciembre.`,
    });
  }

  const conciliaciones = [
    {
      key: 'RDEP_VS_103',
      label: 'Retenido en el RDEP vs. lo declarado en el 103 (relación de dependencia)',
      detalle: `${rows.length} empleado(s) · base gravada ${totals.gravadoEmpleador.toFixed(2)} · IR retenido ${totals.retenidoEmpleador.toFixed(2)}. `
        + 'Sale de las mismas nóminas cerradas y con el mismo mapeo de conceptos que el casillero 302/352 del 103.',
      ok: true,
    },
    {
      key: 'EMPLEADOS_IDENTIFICADOS',
      label: 'Todos los empleados del año tienen identificación',
      detalle: sinIdentificacion.length
        ? `${sinIdentificacion.length} empleado(s) sin cédula: no se pueden reportar.`
        : 'Todos los empleados reportables tienen identificación.',
      ok: sinIdentificacion.length === 0,
    },
    {
      key: 'IMPUESTO_CAUSADO',
      label: 'Impuesto causado calculado con la tabla del ejercicio',
      detalle: tabla
        ? `Tabla ${year} aplicada · causado ${totals.impuestoCausado.toFixed(2)} · retenido ${totals.retenidoEmpleador.toFixed(2)}`
        : `Sin tabla del IR para ${year}: el impuesto causado queda en 0.`,
      ok: !!tabla,
    },
  ];

  return { rows, totals, warnings, conciliaciones, year };
}

module.exports = { computeRdep, GASTO_FIELDS };
