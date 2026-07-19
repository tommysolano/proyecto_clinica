/**
 * RETENCIÓN EN RELACIÓN DE DEPENDENCIA — servicio auditable para el Formulario 103.
 *
 * NO calcula "sueldo menos 9,45 %". Lee las NÓMINAS CERRADAS (o pagadas) del período y
 * clasifica CADA rubro con un mapeo explícito, devolviendo qué se incluyó, qué se
 * excluyó y POR QUÉ. Así el contador puede auditar la base declarada sin abrir la
 * base de datos.
 *
 * Reglas de inclusión (mapeo auditable):
 *   INCLUIDO en la base gravada:
 *     - sueldo ganado del período (prorrateado por días trabajados);
 *     - horas extra, comisiones y bonos (rubros fijos que gravan);
 *     - rubros flexibles cuyo concepto está marcado `isTaxableIncome` o `affectsIncomeTax`.
 *   EXCLUIDO de la base gravada (con motivo):
 *     - décimo tercero, décimo cuarto, fondos de reserva y vacaciones (ingresos no
 *       gravados de IR);
 *     - rubros cuyo concepto está marcado `isNonTaxableIncome` / `isReimbursement`;
 *     - rubros SIN clasificación tributaria → se excluyen y se emite advertencia
 *       (no se asume que graven).
 *
 * Valor retenido = impuesto a la renta efectivamente descontado en el rol (`impuestoRenta`).
 *
 * PENDIENTE DE CONFIRMAR CON EL CONTADOR: qué base exige el casillero laboral vigente.
 * Se devuelven las DOS:
 *   - `baseGravada`      = ingresos gravados (la que se declara por defecto);
 *   - `baseImponibleNeta`= ingresos gravados − aporte personal IESS.
 */
const Payroll = require('../models/Payroll');
const PayrollConcept = require('../models/PayrollConcept');

const r2 = (n) => +(Number(n) || 0).toFixed(2);
const INCLUDED_STATUSES = ['CERRADO', 'PAGADO'];

const REASON = {
  NO_GRAVADO_LEY: 'Ingreso no gravado de impuesto a la renta (décimos, fondos de reserva, vacaciones).',
  CONCEPTO_NO_GRAVADO: 'El concepto está marcado como ingreso no gravado / reembolso.',
  SIN_CLASIFICAR: 'El concepto no tiene clasificación tributaria: se excluye por precaución. Márquelo en el catálogo de conceptos.',
};

/** Clasifica un rubro flexible de ingreso. → { incluido, motivo } */
function classifyEarning(line, concept) {
  if (concept?.isDecimoTercero || concept?.isDecimoCuarto || concept?.isFondosReserva || concept?.isVacation) {
    return { incluido: false, motivo: REASON.NO_GRAVADO_LEY };
  }
  if (concept?.isNonTaxableIncome || concept?.isOtherNonTaxable || concept?.isReimbursement) {
    return { incluido: false, motivo: REASON.CONCEPTO_NO_GRAVADO };
  }
  if (concept?.isTaxableIncome || concept?.affectsIncomeTax) return { incluido: true, motivo: '' };
  return { incluido: false, motivo: REASON.SIN_CLASIFICAR, sinClasificar: true };
}

/**
 * @param {object} args { clinicId, year, month }
 * @returns {Promise<{ total, baseGravada, baseImponibleNeta, iessPersonal, empleados, excluidos, warnings, payrolls }>}
 */
async function payrollWithholdingForPeriod({ clinicId, year, month }) {
  // La QUINCENA_1 es un anticipo (sin IESS ni IR): NO entra en la base de retención del 103.
  // La retención sale del cierre de mes / rol mensual, que tiene el sueldo completo y el IR.
  const rolls = await Payroll.find({ clinic: clinicId, year, month, periodType: { $ne: 'QUINCENA_1' } }).lean();
  const incluidos = rolls.filter((p) => INCLUDED_STATUSES.includes(p.status));
  const borradores = rolls.filter((p) => p.status === 'BORRADOR');
  const warnings = [];

  if (borradores.length) {
    warnings.push({
      code: 'NOMINA_BORRADOR_EXCLUIDA',
      message: `Hay ${borradores.length} rol(es) en BORRADOR en el período: no se declaran hasta cerrarlos.`,
    });
  }
  if (!incluidos.length) {
    warnings.push({
      code: 'SIN_NOMINA_CERRADA',
      message: 'No hay nóminas cerradas en el período: no se declara relación de dependencia.',
      severity: 'info',
    });
  }

  const conceptIds = [...new Set(
    incluidos.flatMap((p) => (p.items || []).flatMap((it) => (it.earnings || []).map((e) => (e.concept ? String(e.concept) : ''))))
  )].filter(Boolean);
  const concepts = conceptIds.length
    ? await PayrollConcept.find({ clinic: clinicId, _id: { $in: conceptIds } }).lean()
    : [];
  const conceptById = new Map(concepts.map((c) => [String(c._id), c]));

  const empleados = [];
  const excluidos = [];
  const sinClasificar = new Set();
  let baseGravada = 0;
  let iessPersonal = 0;
  let impuestoRenta = 0;

  for (const p of incluidos) {
    for (const it of p.items || []) {
      const detalle = [];
      // Rubros fijos que SÍ gravan.
      const fijos = [
        ['Sueldo ganado', it.baseSalary],
        ['Horas extra', it.overtime],
        ['Bonos', it.bonuses],
        ['Comisiones', it.commissions],
      ];
      let gravado = 0;
      for (const [name, amount] of fijos) {
        const amt = Number(amount) || 0;
        if (amt <= 0) continue;
        gravado += amt;
        detalle.push({ rubro: name, monto: r2(amt), incluido: true });
      }
      // Rubros fijos NO gravados (décimos, fondos, vacaciones): se listan como excluidos.
      const noGravados = [
        ['Décimo tercero', it.decimoTercero],
        ['Décimo cuarto', it.decimoCuarto],
        ['Fondos de reserva', it.fondosReserva],
        ['Vacaciones', it.vacaciones],
      ];
      for (const [name, amount] of noGravados) {
        const amt = Number(amount) || 0;
        if (amt <= 0) continue;
        detalle.push({ rubro: name, monto: r2(amt), incluido: false, motivo: REASON.NO_GRAVADO_LEY });
        excluidos.push({ empleado: it.employeeName || '', rubro: name, monto: r2(amt), motivo: REASON.NO_GRAVADO_LEY });
      }
      // Rubros flexibles.
      for (const e of it.earnings || []) {
        const amt = Number(e.amount) || 0;
        if (amt <= 0) continue;
        const concept = e.concept ? conceptById.get(String(e.concept)) : null;
        const cls = classifyEarning(e, concept);
        const rubro = e.name || concept?.name || e.code || 'Rubro';
        detalle.push({ rubro, monto: r2(amt), incluido: cls.incluido, motivo: cls.motivo || undefined });
        if (cls.incluido) gravado += amt;
        else {
          excluidos.push({ empleado: it.employeeName || '', rubro, monto: r2(amt), motivo: cls.motivo });
          if (cls.sinClasificar) sinClasificar.add(rubro);
        }
      }

      const ir = Number(it.impuestoRenta) || 0;
      const iess = Number(it.iessPersonal) || 0;
      gravado = r2(gravado);
      baseGravada += gravado;
      iessPersonal += iess;
      impuestoRenta += ir;

      empleados.push({
        payroll: String(p._id),
        periodo: p.period || `${p.year}-${String(p.month).padStart(2, '0')}`,
        employee: it.employee ? String(it.employee) : '',
        nombre: it.employeeName || '',
        identificacion: it.identificacion || '',
        baseGravada: gravado,
        iessPersonal: r2(iess),
        baseImponibleNeta: r2(gravado - iess),
        impuestoRenta: r2(ir),
        detalle,
      });
    }
  }

  if (sinClasificar.size) {
    warnings.push({
      code: 'CONCEPTOS_SIN_CLASIFICAR',
      message: `Rubros sin clasificación tributaria excluidos de la base: ${[...sinClasificar].join(', ')}. Clasifíquelos en el catálogo de conceptos para declararlos correctamente.`,
    });
  }

  baseGravada = r2(baseGravada);
  iessPersonal = r2(iessPersonal);
  impuestoRenta = r2(impuestoRenta);

  return {
    total: impuestoRenta, // valor retenido en relación de dependencia
    baseGravada,
    iessPersonal,
    baseImponibleNeta: r2(baseGravada - iessPersonal),
    empleados,
    excluidos,
    warnings,
    payrolls: {
      incluidos: incluidos.map((p) => ({ id: String(p._id), periodo: p.period, status: p.status })),
      borradoresExcluidos: borradores.length,
    },
  };
}

module.exports = { payrollWithholdingForPeriod, classifyEarning, REASON, INCLUDED_STATUSES };
