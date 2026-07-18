/**
 * CÁLCULO DEL FORMULARIO 104 (IVA) para un período.
 *
 * Fuentes (las mismas que ya usan los reportes, para que declaración y reporte no
 * se contradigan):
 *   - Ventas:  Invoice AUTORIZADAS cuya fecha FISCAL cae en el período, con su
 *              desglose por tarifa (snapshot `taxBreakdown`).
 *   - Compras: PurchaseInvoice no ANULADAS con fechaEmisión en el período.
 *   - Notas de crédito: CreditDebitNote (kind NC) del período. Las EMITIDAS sobre
 *              facturas restan de las ventas de su misma tarifa; las RECIBIDAS sobre
 *              compras restan de las compras de su misma tarifa (valor NETO = bruto − NC).
 *   - Retenciones de IVA RECIBIDAS: CardSettlement contabilizadas del período.
 *   - Retenciones de IVA EFECTUADAS como agente: cabecera `retentions` de las compras.
 *
 * Clasificación de compras (una fila por combinación tipo de comprobante × tarifa ×
 * derecho a crédito), replicando el formulario oficial:
 *   - NOTA DE VENTA (RISE)          → casillero 516 (toda su base).
 *   - Factura/liquidación gravada ≠0% deducible   → 500 (base) + 520 (IVA, con derecho).
 *   - Factura/liquidación gravada ≠0% NO deducible → 507 (base) + 522 (IVA, al gasto).
 *   - Tarifa 0% deducible           → 517.  Tarifa 0% NO deducible → 518.
 *   - No objeto / exento            → 519.
 *   El "derecho a crédito" se toma de la marca `deductible` de la compra (único dato
 *   disponible); la contadora puede reclasificar el IVA al gasto (casillero 565).
 *
 * Reglas de IVA que respeta:
 *   - El IVA de una compra NO deducible ya se cargó al gasto al registrarla: no está
 *     en la cuenta «IVA en compras» y por lo tanto NO se vuelve a reclasificar aquí.
 *   - El IVA "disponible" de esta declaración (casillero 530) es solo el que quedó
 *     como activo (`vatCreditAmount`), NETO del IVA de las notas de crédito de compras.
 *   - El IVA al gasto sugerido = disponible × (1 − factor de proporcionalidad).
 */
const Invoice = require('../../models/Invoice');
const PurchaseInvoice = require('../../models/PurchaseInvoice');
const CardSettlement = require('../../models/CardSettlement');
const CreditDebitNote = require('../../models/CreditDebitNote');
const { invoiceTaxBreakdown } = require('../invoiceTaxBreakdown');
const { invoiceFiscalDate, purchaseFiscalDate, inRange } = require('../reportDateRange');

const r2 = (n) => +(Number(n) || 0).toFixed(2);

/** IVA de una compra que se contabilizó como crédito tributario (activo). */
function creditVat(p) {
  if (p.deductible === false) return 0;
  return Number(p.vatCreditAmount != null ? p.vatCreditAmount : (p.iva || 0)) || 0;
}

/**
 * Desglose por tarifa de una nota de crédito. Prefiere el snapshot `taxBreakdown` de la
 * nota; si no lo tiene (notas antiguas), infiere la tarifa por el IVA: iva>0 ⇒ toda la
 * base es gravada (≠0%), iva=0 ⇒ toda la base es tarifa 0%. `ivaRate` (si viene) refuerza
 * la inferencia. Así la resta de notas de crédito cae SIEMPRE en la base de su misma tarifa.
 */
function noteBreakdown(n) {
  const subtotal = Number(n.subtotal) || 0;
  const iva = Number(n.iva) || 0;
  const tb = n.taxBreakdown;
  if (tb && (tb.baseGravada || tb.base0 || tb.baseExento || tb.baseNoObjeto || tb.iva)) {
    return {
      baseGravada: Number(tb.baseGravada) || 0,
      base0: Number(tb.base0) || 0,
      baseExento: Number(tb.baseExento) || 0,
      baseNoObjeto: Number(tb.baseNoObjeto) || 0,
      iva: Number(tb.iva) || 0,
    };
  }
  const rate = Number(n.ivaRate);
  const esGravada = (Number.isFinite(rate) && rate > 0) || iva > 0;
  return esGravada
    ? { baseGravada: subtotal, base0: 0, baseExento: 0, baseNoObjeto: 0, iva }
    : { baseGravada: 0, base0: subtotal, baseExento: 0, baseNoObjeto: 0, iva: 0 };
}

/** Notas de crédito NC de un lado (ventas/compras) agregadas por tarifa. */
async function loadCreditNotes({ clinicId, start, end, direction, refModel }) {
  const notes = await CreditDebitNote.find({
    clinic: clinicId,
    kind: 'NC',
    direction,
    refModel,
    estado: { $ne: 'ANULADA' },
    fechaEmision: { $gte: start, $lte: end },
  }).lean();
  const agg = { baseGravada: 0, base0: 0, baseExento: 0, baseNoObjeto: 0, iva: 0, count: notes.length };
  for (const n of notes) {
    const b = noteBreakdown(n);
    agg.baseGravada += b.baseGravada;
    agg.base0 += b.base0;
    agg.baseExento += b.baseExento;
    agg.baseNoObjeto += b.baseNoObjeto;
    agg.iva += b.iva;
  }
  for (const k of ['baseGravada', 'base0', 'baseExento', 'baseNoObjeto', 'iva']) agg[k] = r2(agg[k]);
  return agg;
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

  // ── Notas de crédito del período (restan de la base de su misma tarifa)
  const ncVentas = await loadCreditNotes({ clinicId, start, end, direction: 'EMITIDA', refModel: 'Invoice' });
  const ncCompras = await loadCreditNotes({ clinicId, start, end, direction: 'RECIBIDA', refModel: 'PurchaseInvoice' });

  // Ventas NETAS de notas de crédito (la base neta es la que genera IVA).
  const ventaGravadaNeta = r2(v.baseGravada - ncVentas.baseGravada);
  const ventaIvaNeto = r2(v.iva - ncVentas.iva);
  const base0Neto = r2(v.base0 - ncVentas.base0);

  // ── Compras
  const compras = await PurchaseInvoice.find({
    clinic: clinicId,
    status: { $ne: 'ANULADA' },
    fechaEmision: { $gte: start, $lte: end },
  }).lean();

  const c = {
    conDerechoGravadaBruta: 0, // 500
    sinDerechoGravada: 0,      // 507
    cero0ConDerecho: 0,        // 517 (bruto, antes de NC 0%)
    cero0SinDerecho: 0,        // 518
    rise: 0,                   // 516
    importaciones: 0,          // 515 (placeholder)
    noObjetoExento: 0,         // 519
    ivaConDerechoBruto: 0,     // 520 (antes de NC)
    ivaSinDerecho: 0,          // 522 (al gasto)
    ivaTotalBruto: 0,          // 529 (antes de NC)
    retIvaEfectuada: 0,        // 721
  };
  const retIvaDocs = [];
  for (const p of compras) {
    const gravada = r2((Number(p.subtotal12) || 0) + (Number(p.subtotal15) || 0));
    const base0 = Number(p.subtotal0) || 0;
    const noObjetoExento = (Number(p.subtotalNoObjeto) || 0) + (Number(p.subtotalExento) || 0);
    const iva = Number(p.iva) || 0;
    const conDerecho = p.deductible !== false;
    const isRise = p.docType === 'NOTA_VENTA';

    if (isRise) {
      // Contribuyente RISE / nota de venta: toda la base va al casillero RISE; su IVA
      // (si lo hubiera) no es crédito.
      c.rise += r2(gravada + base0 + noObjetoExento);
      c.ivaSinDerecho += iva;
    } else {
      if (conDerecho) {
        c.conDerechoGravadaBruta += gravada;
        c.cero0ConDerecho += base0;
      } else {
        c.sinDerechoGravada += gravada;
        c.cero0SinDerecho += base0;
      }
      c.noObjetoExento += noObjetoExento;
      const credit = creditVat(p);
      c.ivaConDerechoBruto += credit;
      c.ivaSinDerecho += r2(iva - credit);
    }
    c.ivaTotalBruto += iva;

    // Retenciones de IVA efectuadas como agente (cabecera = fuente única).
    for (const rt of p.retentions || []) {
      if (rt.type !== 'IVA') continue;
      const amount = Number(rt.amount) || 0;
      if (amount <= 0) continue;
      c.retIvaEfectuada += amount;
      retIvaDocs.push({
        purchase: String(p._id),
        serie: p.serie || '',
        fecha: purchaseFiscalDate(p),
        code: rt.code || '',
        base: r2(rt.baseAmount),
        amount: r2(amount),
        account: rt.account ? String(rt.account) : null,
      });
    }
  }
  for (const k of Object.keys(c)) c[k] = r2(c[k]);

  // Compras NETAS de notas de crédito recibidas (la NC de compras resta de la base y del
  // IVA con derecho a crédito, que es donde se contabilizó).
  const conDerechoGravadaNeta = r2(c.conDerechoGravadaBruta - ncCompras.baseGravada);
  const cero0ConDerechoNeto = r2(c.cero0ConDerecho - ncCompras.base0);
  const ivaConDerechoNeto = r2(c.ivaConDerechoBruto - ncCompras.iva);
  const ivaTotalNeto = r2(c.ivaTotalBruto - ncCompras.iva);
  const ivaDisponible = ivaConDerechoNeto; // el que quedó como activo (crédito tributario)

  // ── Retenciones de IVA que NOS efectuaron (activo «Retención IVA por cobrar»)
  const settlements = await CardSettlement.find({
    clinic: clinicId,
    status: 'CONTABILIZADO',
    issueDate: { $gte: start, $lte: end },
  }).lean();
  let retIvaRecibida = 0;
  const retRecibidaDocs = [];
  for (const s of settlements) {
    for (const rt of s.retentions || []) {
      if (rt.type !== 'IVA') continue;
      const value = Number(rt.value) || 0;
      if (value <= 0) continue;
      retIvaRecibida += value;
      retRecibidaDocs.push({ settlement: String(s._id), sriCode: rt.sriCode || '', base: r2(rt.base), amount: r2(value) });
    }
  }
  retIvaRecibida = r2(retIvaRecibida);

  // ── Casilleros editables (reparto de la base 0% y IVA al gasto)
  const base0Total = base0Neto;
  const has403 = editable['403'] != null;
  const has405 = editable['405'] != null;
  // Por defecto toda la base 0% va a "sin derecho a crédito" (criterio conservador:
  // no infla el factor de proporcionalidad).
  const b403 = r2(has403 ? editable['403'] : (has405 ? Math.max(0, base0Total - Number(editable['405'] || 0)) : base0Total));
  const b405 = r2(has405 ? editable['405'] : Math.max(0, base0Total - b403));
  if (r2(b403 + b405) !== base0Total) {
    warnings.push({
      code: 'BASE_0_DESCUADRADA',
      message: `El reparto de la base tarifa 0% (403 + 405 = ${r2(b403 + b405).toFixed(2)}) no coincide con la base 0% real de las ventas neta de notas de crédito (${base0Total.toFixed(2)}). `
        + 'Suele pasar cuando aparecen ventas 0% nuevas después de guardar el borrador: decida cuánto va a cada casillero (con o sin derecho a crédito) y guarde. No se finaliza hasta que cuadre.',
    });
  }

  // Factor de proporcionalidad: qué parte de las ventas (netas de NC) da derecho a crédito.
  const ventasConDerecho = r2(ventaGravadaNeta + b405);
  const ventasParaFactor = r2(ventaGravadaNeta + b403 + b405);
  const factor = ventasParaFactor > 0 ? +(ventasConDerecho / ventasParaFactor).toFixed(4) : 1;

  const ivaAlGastoSugerido = r2(ivaDisponible * (1 - factor));
  const ivaAlGasto = r2(editable['565'] != null ? editable['565'] : ivaAlGastoSugerido);
  const ivaUtilizable = r2(ivaDisponible - ivaAlGasto);

  const creditoAnterior = r2(editable['605'] || 0);

  // ── Resumen impositivo (sobre el IVA de ventas NETO de notas de crédito)
  const impuestoCausado = r2(Math.max(0, ventaIvaNeto - ivaUtilizable));
  const creditoGenerado = r2(Math.max(0, ivaUtilizable - ventaIvaNeto));
  const neto = r2(impuestoCausado - creditoAnterior - retIvaRecibida);
  const impuestoPorPagar = r2(Math.max(0, neto));
  // Saldo a favor que se arrastra: el crédito generado + lo no consumido del arrastre
  // y de las retenciones recibidas.
  const creditoProximoMes = r2(creditoGenerado + Math.max(0, -neto));
  const totalAPagar = r2(impuestoPorPagar + c.retIvaEfectuada);

  const totalComprasNeto = r2(
    conDerechoGravadaNeta + c.sinDerechoGravada + cero0ConDerechoNeto + c.cero0SinDerecho
    + c.rise + c.importaciones + c.noObjetoExento
  );

  const computed = {
    401: v.baseGravada,
    411: ventaGravadaNeta,
    421: ventaIvaNeto,
    431: v.baseNoObjeto,
    434: v.baseExento,
    419: r2(ventaGravadaNeta + b403 + b405 + v.baseNoObjeto + v.baseExento),
    499: ventaIvaNeto,
    500: c.conDerechoGravadaBruta,
    510: conDerechoGravadaNeta,
    520: ivaConDerechoNeto,
    507: c.sinDerechoGravada,
    522: c.ivaSinDerecho,
    517: cero0ConDerechoNeto,
    518: c.cero0SinDerecho,
    516: c.rise,
    515: c.importaciones,
    519: c.noObjetoExento,
    521: totalComprasNeto,
    529: ivaTotalNeto,
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
      label: 'IVA de ventas vs. base gravada (neto de notas de crédito)',
      detalle: `Base gravada neta ${ventaGravadaNeta.toFixed(2)} · IVA declarado ${ventaIvaNeto.toFixed(2)}`,
      ok: true,
    },
    {
      key: 'NC_VENTAS',
      label: 'Notas de crédito de ventas restadas',
      detalle: ncVentas.count
        ? `${ncVentas.count} nota(s) · base gravada −${ncVentas.baseGravada.toFixed(2)} · base 0% −${ncVentas.base0.toFixed(2)} · IVA −${ncVentas.iva.toFixed(2)}`
        : 'Sin notas de crédito de ventas en el período.',
      ok: true,
    },
    {
      key: 'NC_COMPRAS',
      label: 'Notas de crédito de compras restadas',
      detalle: ncCompras.count
        ? `${ncCompras.count} nota(s) · base gravada −${ncCompras.baseGravada.toFixed(2)} · base 0% −${ncCompras.base0.toFixed(2)} · IVA −${ncCompras.iva.toFixed(2)}`
        : 'Sin notas de crédito de compras en el período.',
      ok: true,
    },
    {
      key: 'IVA_COMPRAS',
      label: 'IVA de compras: con derecho + sin derecho = IVA total (neto de NC)',
      detalle: `${ivaDisponible.toFixed(2)} + ${c.ivaSinDerecho.toFixed(2)} = ${ivaTotalNeto.toFixed(2)}`,
      ok: r2(ivaDisponible + c.ivaSinDerecho) === ivaTotalNeto,
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
        ? `(${ventaGravadaNeta.toFixed(2)} gravadas + ${b405.toFixed(2)} tarifa 0% con derecho) / ${ventasParaFactor.toFixed(2)} = ${factor}`
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
      detalle: `El sistema no registra si cada compra es de atribución directa o común: los ${ivaDisponible.toFixed(2)} de IVA acreditable se tratan como IVA COMÚN y se someten al factor. El IVA sin derecho a crédito (${c.ivaSinDerecho.toFixed(2)}) ya fue al gasto al registrar la compra y no entra aquí.`,
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
  if (ventaGravadaNeta < 0 || base0Total < 0 || ventaIvaNeto < 0) {
    warnings.push({
      code: 'NC_VENTAS_EXCEDEN',
      message: 'Las notas de crédito de ventas del período superan las ventas del mismo período. Verifique el arrastre: el excedente suele declararse contra el mes siguiente.',
    });
  }
  if (conDerechoGravadaNeta < 0 || ivaDisponible < 0) {
    warnings.push({
      code: 'NC_COMPRAS_EXCEDEN',
      message: 'Las notas de crédito de compras del período superan las compras del mismo período. Verifique el período de las notas de crédito recibidas.',
    });
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
      base0: base0Total,
      base0Bruta: v.base0,
      baseGravada: ventaGravadaNeta,
      baseGravadaBruta: v.baseGravada,
      baseExento: v.baseExento,
      baseNoObjeto: v.baseNoObjeto,
      iva: ventaIvaNeto,
      ivaBruto: v.iva,
      sinAutorizar: pendientes,
      sinDesglose: derivadas,
    },
    compras: {
      count: compras.length,
      conDerechoGravadaBruta: c.conDerechoGravadaBruta,
      conDerechoGravadaNeta,
      sinDerechoGravada: c.sinDerechoGravada,
      cero0ConDerecho: cero0ConDerechoNeto,
      cero0SinDerecho: c.cero0SinDerecho,
      rise: c.rise,
      importaciones: c.importaciones,
      noObjetoExento: c.noObjetoExento,
      ivaConDerecho: ivaDisponible,
      ivaSinDerecho: c.ivaSinDerecho,
      ivaTotal: ivaTotalNeto,
      ivaDisponible,
      ivaYaAlGasto: c.ivaSinDerecho,
      docs: compras.slice(0, 500).map((p) => ({
        id: String(p._id),
        serie: p.serie || '',
        fecha: purchaseFiscalDate(p),
        docType: p.docType || 'FACTURA',
        subtotal: r2(p.subtotal),
        iva: r2(p.iva),
        ivaCredito: r2(creditVat(p)),
        deducible: p.deductible !== false,
      })),
    },
    notasCredito: {
      ventas: ncVentas,
      compras: ncCompras,
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
    ventasBase: r2(ventaGravadaNeta + base0Total + v.baseExento + v.baseNoObjeto),
    ventasIva: ventaIvaNeto,
    comprasBase: computed[521],
    comprasIva: ivaTotalNeto,
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
