/**
 * CÁLCULO DEL FORMULARIO 104 (IVA) para un período.
 *
 * Fuentes (las mismas que ya usan los reportes, para que declaración y reporte no
 * se contradigan):
 *   - Ventas:  Invoice AUTORIZADAS cuya fecha FISCAL cae en el período, con su
 *              desglose por tarifa (snapshot `taxBreakdown`).
 *   - Compras: PurchaseInvoice no ANULADAS con fechaEmisión en el período.
 *   - Retenciones de IVA RECIBIDAS: CardSettlement contabilizadas del período
 *              (es la única fuente de retenciones que nos efectúan terceros).
 *   - Retenciones de IVA EFECTUADAS como agente: cabecera `retentions` de las compras
 *              (fuente única: NO se recorren las retenciones por línea, que ya están
 *              agregadas en la cabecera → sin doble conteo).
 *
 * Reglas de IVA que respeta:
 *   - El IVA de una compra NO deducible ya se cargó al gasto al registrarla: no está
 *     en la cuenta «IVA en compras» y por lo tanto NO se vuelve a reclasificar aquí.
 *   - El IVA "disponible" de esta declaración (casillero 530) es solo el que quedó
 *     como activo (`vatCreditAmount`).
 *   - El IVA al gasto sugerido = disponible × (1 − factor de proporcionalidad).
 */
const Invoice = require('../../models/Invoice');
const PurchaseInvoice = require('../../models/PurchaseInvoice');
const CardSettlement = require('../../models/CardSettlement');
const { invoiceTaxBreakdown } = require('../invoiceTaxBreakdown');
const { invoiceFiscalDate, purchaseFiscalDate, inRange } = require('../reportDateRange');

const r2 = (n) => +(Number(n) || 0).toFixed(2);

/** IVA de una compra que se contabilizó como crédito tributario (activo). */
function creditVat(p) {
  if (p.deductible === false) return 0;
  return Number(p.vatCreditAmount != null ? p.vatCreditAmount : (p.iva || 0)) || 0;
}

/**
 * @param {object} args { clinicId, range, editable }  editable: { '403': n, '405': n, '565': n, '605': n }
 * @returns {Promise<{computed, limits, totals, conciliaciones, warnings, snapshot, suggestions}>}
 */
async function compute104({ clinicId, range, editable = {} }) {
  const { start, end } = range;
  const warnings = [];

  // ── Ventas (solo facturas electrónicas autorizadas: lo demás no se declara)
  const allInvoices = await Invoice.find({ clinic: clinicId, estado: 'AUTORIZADO' }).lean();
  const ventas = allInvoices.filter((inv) => inRange(invoiceFiscalDate(inv), start, end));
  const pendientes = await Invoice.countDocuments({
    clinic: clinicId,
    estado: { $in: ['EN_COLA', 'RECIBIDA', 'EN_PROCESO', 'NO_AUTORIZADO', 'DEVUELTA', 'ERROR'] },
  });

  const v = { baseGravada: 0, base0: 0, baseExento: 0, baseNoObjeto: 0, iva: 0 };
  let derivadas = 0;
  for (const inv of ventas) {
    const tb = invoiceTaxBreakdown(inv);
    v.baseGravada += tb.baseGravada;
    v.base0 += tb.base0;
    v.baseExento += tb.baseExento;
    v.baseNoObjeto += tb.baseNoObjeto;
    v.iva += tb.iva;
    if (tb.derived) derivadas += 1;
  }
  for (const k of Object.keys(v)) v[k] = r2(v[k]);
  if (derivadas > 0) {
    warnings.push({
      code: 'VENTAS_SIN_DESGLOSE',
      message: `${derivadas} factura(s) sin desglose por tarifa: su base se estimó desde los totales. Corra el backfill de desglose tributario para declarar con datos exactos.`,
    });
  }
  if (pendientes > 0) {
    warnings.push({
      code: 'VENTAS_SIN_AUTORIZAR',
      message: `Hay ${pendientes} factura(s) de venta registradas sin autorizar; no se declaran hasta que el SRI las autorice.`,
    });
  }

  // ── Compras
  const compras = await PurchaseInvoice.find({
    clinic: clinicId,
    status: { $ne: 'ANULADA' },
    fechaEmision: { $gte: start, $lte: end },
  }).lean();

  const c = {
    baseGravadaConCredito: 0,
    baseGravadaSinCredito: 0,
    base0: 0,
    baseNoObjetoExento: 0,
    ivaTotal: 0,
    ivaDisponible: 0, // el que quedó como activo (crédito tributario)
    ivaYaAlGasto: 0, // el que ya se cargó al gasto al registrar la compra
    retIvaEfectuada: 0,
  };
  const retIvaDocs = [];
  for (const p of compras) {
    const gravada = r2((Number(p.subtotal12) || 0) + (Number(p.subtotal15) || 0));
    const credit = creditVat(p);
    if (p.deductible === false) c.baseGravadaSinCredito += gravada;
    else c.baseGravadaConCredito += gravada;
    c.base0 += Number(p.subtotal0) || 0;
    c.baseNoObjetoExento += (Number(p.subtotalNoObjeto) || 0) + (Number(p.subtotalExento) || 0);
    c.ivaTotal += Number(p.iva) || 0;
    c.ivaDisponible += credit;
    c.ivaYaAlGasto += (Number(p.iva) || 0) - credit;
    // Retenciones de IVA efectuadas como agente (cabecera = fuente única).
    for (const r of p.retentions || []) {
      if (r.type !== 'IVA') continue;
      const amount = Number(r.amount) || 0;
      if (amount <= 0) continue;
      c.retIvaEfectuada += amount;
      retIvaDocs.push({
        purchase: String(p._id),
        serie: p.serie || '',
        fecha: purchaseFiscalDate(p),
        code: r.code || '',
        base: r2(r.baseAmount),
        amount: r2(amount),
        account: r.account ? String(r.account) : null,
      });
    }
  }
  for (const k of Object.keys(c)) c[k] = r2(c[k]);

  // ── Retenciones de IVA que NOS efectuaron (activo «Retención IVA por cobrar»)
  const settlements = await CardSettlement.find({
    clinic: clinicId,
    status: 'CONTABILIZADO',
    issueDate: { $gte: start, $lte: end },
  }).lean();
  let retIvaRecibida = 0;
  const retRecibidaDocs = [];
  for (const s of settlements) {
    for (const r of s.retentions || []) {
      if (r.type !== 'IVA') continue;
      const value = Number(r.value) || 0;
      if (value <= 0) continue;
      retIvaRecibida += value;
      retRecibidaDocs.push({ settlement: String(s._id), sriCode: r.sriCode || '', base: r2(r.base), amount: r2(value) });
    }
  }
  retIvaRecibida = r2(retIvaRecibida);

  // ── Casilleros editables (reparto de la base 0% y IVA al gasto)
  const base0Total = v.base0;
  const has403 = editable['403'] != null;
  const has405 = editable['405'] != null;
  // Por defecto toda la base 0% va a "sin derecho a crédito" (criterio conservador:
  // no infla el factor de proporcionalidad).
  const b403 = r2(has403 ? editable['403'] : (has405 ? Math.max(0, base0Total - Number(editable['405'] || 0)) : base0Total));
  const b405 = r2(has405 ? editable['405'] : Math.max(0, base0Total - b403));
  if (r2(b403 + b405) !== base0Total) {
    warnings.push({
      code: 'BASE_0_DESCUADRADA',
      message: `El reparto de la base tarifa 0% (403 + 405 = ${r2(b403 + b405).toFixed(2)}) no coincide con la base 0% real de las ventas (${base0Total.toFixed(2)}). `
        + 'Suele pasar cuando aparecen ventas 0% nuevas después de guardar el borrador: decida cuánto va a cada casillero (con o sin derecho a crédito) y guarde. No se finaliza hasta que cuadre.',
    });
  }

  // Factor de proporcionalidad: qué parte de las ventas da derecho a crédito.
  const ventasConDerecho = r2(v.baseGravada + b405);
  const ventasParaFactor = r2(v.baseGravada + b403 + b405);
  const factor = ventasParaFactor > 0 ? +(ventasConDerecho / ventasParaFactor).toFixed(4) : 1;

  const ivaDisponible = c.ivaDisponible;
  const ivaAlGastoSugerido = r2(ivaDisponible * (1 - factor));
  const ivaAlGasto = r2(editable['565'] != null ? editable['565'] : ivaAlGastoSugerido);
  const ivaUtilizable = r2(ivaDisponible - ivaAlGasto);

  const creditoAnterior = r2(editable['605'] || 0);

  // ── Resumen impositivo
  const impuestoCausado = r2(Math.max(0, v.iva - ivaUtilizable));
  const creditoGenerado = r2(Math.max(0, ivaUtilizable - v.iva));
  const neto = r2(impuestoCausado - creditoAnterior - retIvaRecibida);
  const impuestoPorPagar = r2(Math.max(0, neto));
  // Saldo a favor que se arrastra: el crédito generado + lo no consumido del arrastre
  // y de las retenciones recibidas.
  const creditoProximoMes = r2(creditoGenerado + Math.max(0, -neto));
  const totalAPagar = r2(impuestoPorPagar + c.retIvaEfectuada);

  const computed = {
    401: v.baseGravada,
    431: v.baseNoObjeto,
    434: v.baseExento,
    419: r2(v.baseGravada + b403 + b405 + v.baseNoObjeto + v.baseExento),
    499: v.iva,
    500: c.baseGravadaConCredito,
    507: c.baseGravadaSinCredito,
    517: c.base0,
    519: c.baseNoObjetoExento,
    521: r2(c.baseGravadaConCredito + c.baseGravadaSinCredito + c.base0 + c.baseNoObjetoExento),
    529: c.ivaTotal,
    530: ivaDisponible,
    563: factor,
    564: ivaUtilizable,
    601: impuestoCausado,
    602: creditoGenerado,
    607: retIvaRecibida,
    609: impuestoPorPagar,
    615: creditoProximoMes,
    721: c.retIvaEfectuada,
    902: totalAPagar,
  };
  // Los editables se devuelven resueltos (con su valor por defecto si no se capturaron).
  const editableResolved = { 403: b403, 405: b405, 565: ivaAlGasto, 605: creditoAnterior };

  // Topes para validar los casilleros editables.
  const limits = { _base0Total: base0Total, 530: ivaDisponible };

  // ── Conciliaciones y advertencias
  const conciliaciones = [
    {
      key: 'VENTAS_VS_IVA',
      label: 'IVA de ventas vs. base gravada',
      detalle: `Base gravada ${v.baseGravada.toFixed(2)} · IVA declarado ${v.iva.toFixed(2)}`,
      ok: true,
    },
    {
      key: 'IVA_COMPRAS',
      label: 'IVA de compras: disponible + ya cargado al gasto = IVA total',
      detalle: `${ivaDisponible.toFixed(2)} + ${c.ivaYaAlGasto.toFixed(2)} = ${c.ivaTotal.toFixed(2)}`,
      ok: r2(ivaDisponible + c.ivaYaAlGasto) === c.ivaTotal,
    },
    {
      key: 'IVA_UTILIZABLE',
      label: 'IVA disponible = utilizable + al gasto',
      detalle: `${ivaDisponible.toFixed(2)} = ${ivaUtilizable.toFixed(2)} + ${ivaAlGasto.toFixed(2)}`,
      ok: r2(ivaUtilizable + ivaAlGasto) === ivaDisponible,
    },
    {
      key: 'FACTOR',
      label: 'Factor de proporcionalidad',
      detalle: ventasParaFactor > 0
        ? `(${v.baseGravada.toFixed(2)} gravadas + ${b405.toFixed(2)} tarifa 0% con derecho) / ${ventasParaFactor.toFixed(2)} = ${factor}`
        : 'Sin ventas en el período: se asume factor 1 (todo el IVA de compras es utilizable).',
      ok: true,
    },
    {
      // LIMITACIÓN CONOCIDA (ver definitions.js): la compra solo distingue "deducible" de
      // "no deducible". NO hay un campo que marque si el IVA es de ATRIBUCIÓN DIRECTA a
      // ventas con derecho a crédito, directa a ventas sin derecho, o COMÚN (el único que
      // debería someterse al factor). No se inventa esa clasificación: todo el IVA
      // acreditable se trata como COMÚN. El contador ajusta el casillero 565 si hace falta.
      key: 'IVA_ATRIBUCION',
      label: 'Atribución del IVA de compras (limitación)',
      detalle: `El sistema no registra si cada compra es de atribución directa o común: los ${ivaDisponible.toFixed(2)} de IVA acreditable se tratan como IVA COMÚN y se someten al factor. El IVA de compras no deducibles (${c.ivaYaAlGasto.toFixed(2)}) ya fue al gasto al registrarlas y no entra aquí.`,
      ok: true,
    },
  ];
  if (ivaDisponible > 0) {
    warnings.push({
      code: 'IVA_ATRIBUCION_DIRECTA',
      severity: 'info',
      message: factor < 1
        ? `El factor de proporcionalidad se aplica a TODO el IVA acreditable (${ivaDisponible.toFixed(2)}) porque las compras no registran atribución directa. Si parte de ese IVA es directamente atribuible a ventas con derecho a crédito, ajuste el casillero 565 (IVA al gasto) con su contador.`
        : 'Las compras no registran si el IVA es de atribución directa o común. En este período el factor es 1, así que no cambia el resultado, pero la clasificación está pendiente de definir con el contador.',
    });
  }
  if (ivaAlGasto > ivaDisponible + 0.005) {
    warnings.push({
      code: 'IVA_GASTO_EXCEDE',
      message: `El IVA al gasto (${ivaAlGasto.toFixed(2)}) supera el IVA disponible (${ivaDisponible.toFixed(2)}).`,
    });
  }
  if (ivaAlGasto < 0) warnings.push({ code: 'IVA_GASTO_NEGATIVO', message: 'El IVA al gasto no puede ser negativo.' });
  if (impuestoPorPagar > 0 && creditoProximoMes > 0) {
    warnings.push({ code: 'IMPUESTO_Y_CREDITO', message: 'La declaración no puede tener a la vez impuesto por pagar y crédito tributario.' });
  }
  if (c.retIvaEfectuada > 0) {
    warnings.push({
      code: 'RET_IVA_AGENTE',
      message: `Se incluyen ${c.retIvaEfectuada.toFixed(2)} de retenciones de IVA efectuadas a proveedores como parte de la obligación. Confirme con su contador que corresponde pagarlas con el 104.`,
      severity: 'info',
    });
  }

  const snapshot = {
    ventas: {
      count: ventas.length,
      base0: v.base0,
      baseGravada: v.baseGravada,
      baseExento: v.baseExento,
      baseNoObjeto: v.baseNoObjeto,
      iva: v.iva,
      sinAutorizar: pendientes,
      sinDesglose: derivadas,
    },
    compras: {
      count: compras.length,
      ...c,
      docs: compras.slice(0, 500).map((p) => ({
        id: String(p._id),
        serie: p.serie || '',
        fecha: purchaseFiscalDate(p),
        subtotal: r2(p.subtotal),
        iva: r2(p.iva),
        ivaCredito: r2(creditVat(p)),
        deducible: p.deductible !== false,
      })),
    },
    retencionesIvaEfectuadas: { total: c.retIvaEfectuada, docs: retIvaDocs },
    retencionesIvaRecibidas: { total: retIvaRecibida, docs: retRecibidaDocs },
    factorProporcionalidad: factor,
    ivaDisponible,
    ivaUtilizable,
    ivaAlGasto,
    creditoAnterior,
  };

  const totals = {
    ventasBase: r2(v.baseGravada + v.base0 + v.baseExento + v.baseNoObjeto),
    ventasIva: v.iva,
    comprasBase: computed[521],
    comprasIva: c.ivaTotal,
    ivaUtilizable,
    ivaAlGasto,
    retencionesEfectuadas: c.retIvaEfectuada,
    impuestoPorPagar,
    creditoTributario: creditoProximoMes,
    totalAPagar,
  };

  return {
    computed,
    editable: editableResolved,
    limits,
    totals,
    conciliaciones,
    warnings,
    snapshot,
    suggestions: { 565: ivaAlGastoSugerido, 403: base0Total, 405: 0 },
  };
}

module.exports = { compute104 };
