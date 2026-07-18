/**
 * CÁLCULO DEL FORMULARIO 104 (IVA) para un período — numeración OFICIAL (3 columnas
 * Bruto / Neto = Bruto − N/C / Impuesto), ver server/utils/sriForms/definitions.js.
 *
 * Fuentes:
 *   - Ventas:  Invoice AUTORIZADAS cuya fecha FISCAL cae en el período (desglose por tarifa).
 *   - Compras: PurchaseInvoice no ANULADAS con fechaEmisión en el período. La partición
 *              activo fijo / tarifa 5% se deriva de las LÍNEAS (lineType, ivaRate); el resto,
 *              de la cabecera (subtotal15/subtotal0/…).
 *   - Notas de crédito: CreditDebitNote (kind NC). Emitidas sobre ventas restan de las ventas
 *              de su tarifa; recibidas sobre compras restan del NETO de las compras de su
 *              tarifa. El excedente (NC > adquisiciones de esa tarifa) va a "por compensar el
 *              próximo mes": 543 (0%) / 544-554 (gravadas).
 *   - Retenciones de IVA recibidas: CardSettlement contabilizadas del período.
 *   - Retenciones de IVA efectuadas como agente: cabecera `retentions` de las compras.
 *
 * Clasificación de compras (una fila por combinación tipo × tarifa × derecho × activo fijo):
 *   - NOTA DE VENTA (RISE / negocios populares) → 508 (toda su base).
 *   - Gravada ≠0% deducible, línea NO activo fijo → 500/520.  Línea ACTIVO_FIJO → 501/521.
 *   - Gravada 5% deducible → 540/560.
 *   - Gravada ≠0% NO deducible (sin derecho) → 502/522 (su IVA ya fue al gasto).
 *   - Tarifa 0% (deducible o no) → 507.  No objeto → 531.  Exenta → 532.
 *   El "derecho a crédito" se toma de `deductible`; el activo fijo, de `lineType`.
 */
const Invoice = require('../../models/Invoice');
const PurchaseInvoice = require('../../models/PurchaseInvoice');
const CardSettlement = require('../../models/CardSettlement');
const CreditDebitNote = require('../../models/CreditDebitNote');
const { invoiceTaxBreakdown } = require('../invoiceTaxBreakdown');
const { invoiceFiscalDate, purchaseFiscalDate, inRange } = require('../reportDateRange');

const r2 = (n) => +(Number(n) || 0).toFixed(2);
const pos = (n) => Math.max(0, r2(n));

/** Tarifa de IVA de una línea de compra normalizada a porcentaje (15, 5, 0…). */
function lineRate(it) {
  const n = Number(it.ivaRate);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n <= 1 ? n * 100 : n;
}

/** IVA de una compra que se contabilizó como crédito tributario (activo). */
function creditVat(p) {
  if (p.deductible === false) return 0;
  return Number(p.vatCreditAmount != null ? p.vatCreditAmount : (p.iva || 0)) || 0;
}

/**
 * Desglose por tarifa de una nota de crédito. Prefiere su snapshot `taxBreakdown`; si no lo
 * tiene (notas antiguas) infiere: iva>0 ⇒ base gravada (≠0%), iva=0 ⇒ tarifa 0%. `ivaRate`
 * (si viene) refuerza la inferencia. Así la resta cae en la base de su misma tarifa.
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
    clinic: clinicId, kind: 'NC', direction, refModel,
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

  // ── Notas de crédito del período
  const ncVentas = await loadCreditNotes({ clinicId, start, end, direction: 'EMITIDA', refModel: 'Invoice' });
  const ncCompras = await loadCreditNotes({ clinicId, start, end, direction: 'RECIBIDA', refModel: 'PurchaseInvoice' });

  // Ventas: valor neto = bruto − notas de crédito.
  const ventaGravadaNeta = pos(v.baseGravada - ncVentas.baseGravada);
  const ventaIvaNeto = pos(v.iva - ncVentas.iva);
  const base0Bruto = v.base0;
  const noObjetoNetoV = pos(v.baseNoObjeto - ncVentas.baseNoObjeto);
  const exentoNetoV = pos(v.baseExento - ncVentas.baseExento);

  // Reparto editable de la base 0% de ventas (bruto): 403 sin derecho / 405 con derecho.
  const has403 = editable['403'] != null;
  const has405 = editable['405'] != null;
  const b403 = r2(has403 ? editable['403'] : (has405 ? Math.max(0, base0Bruto - Number(editable['405'] || 0)) : base0Bruto));
  const b405 = r2(has405 ? editable['405'] : Math.max(0, base0Bruto - b403));
  if (r2(b403 + b405) !== base0Bruto) {
    warnings.push({
      code: 'BASE_0_DESCUADRADA',
      message: `El reparto de la base tarifa 0% (403 + 405 = ${r2(b403 + b405).toFixed(2)}) no coincide con la base 0% real de las ventas (${base0Bruto.toFixed(2)}). `
        + 'Suele pasar cuando aparecen ventas 0% nuevas después de guardar el borrador: decida cuánto va a cada casillero (con o sin derecho a crédito) y guarde. No se finaliza hasta que cuadre.',
    });
  }
  // Neto 0% = bruto − notas de crédito 0% (se restan primero de "sin derecho").
  let remNc0 = ncVentas.base0;
  const n413 = pos(b403 - remNc0); remNc0 = Math.max(0, r2(remNc0 - b403));
  const n415 = pos(b405 - remNc0); remNc0 = Math.max(0, r2(remNc0 - b405));

  // ── Compras
  const compras = await PurchaseInvoice.find({
    clinic: clinicId,
    status: { $ne: 'ANULADA' },
    fechaEmision: { $gte: start, $lte: end },
  }).lean();

  const c = {
    g500: 0, g501: 0, g540: 0, g502: 0, b507: 0, b508: 0, b531: 0, b532: 0,
    i520: 0, i521: 0, i560: 0, i522: 0,
    retIvaEfectuada: 0,
  };
  const retIvaDocs = [];
  for (const p of compras) {
    const headerGravada = r2((Number(p.subtotal12) || 0) + (Number(p.subtotal15) || 0));
    const base0 = Number(p.subtotal0) || 0;
    const noObjeto = Number(p.subtotalNoObjeto) || 0;
    const exento = Number(p.subtotalExento) || 0;
    const iva = Number(p.iva) || 0;
    const conDerecho = p.deductible !== false;
    const isRise = p.docType === 'NOTA_VENTA';

    if (isRise) {
      // RISE / negocios populares: toda la base va al 508; su IVA (raro) no es crédito.
      c.b508 += r2(headerGravada + base0 + noObjeto + exento);
      c.i522 += iva;
    } else {
      // Partición activo fijo / tarifa 5% desde las líneas (solo aplica a la base gravada).
      let afBase = 0, afIva = 0, base5 = 0, iva5 = 0;
      for (const it of p.items || []) {
        const rate = lineRate(it);
        if (rate <= 0) continue; // las líneas 0% se toman de subtotal0 (cabecera)
        const base = Number(it.subtotal) || 0;
        const itIva = Number(it.ivaAmount != null ? it.ivaAmount : (base * rate) / 100) || 0;
        if (it.lineType === 'ACTIVO_FIJO') { afBase += base; afIva += itIva; }
        else if (rate === 5) { base5 += base; iva5 += itIva; }
      }
      afBase = Math.min(r2(afBase), headerGravada);
      base5 = Math.min(r2(base5), r2(headerGravada - afBase));
      const nonAf5Gravada = pos(headerGravada - afBase - base5);

      if (conDerecho) {
        const credit = creditVat(p);
        c.g500 += nonAf5Gravada;
        c.g501 += afBase;
        c.g540 += base5;
        const ivaAf = Math.min(r2(afIva), credit);
        const iva5c = Math.min(r2(iva5), r2(credit - ivaAf));
        c.i521 += ivaAf;
        c.i560 += iva5c;
        c.i520 += pos(credit - ivaAf - iva5c);
        // La parte del IVA no recuperable de una compra deducible ya fue al gasto.
        c.i522 += pos(iva - credit);
      } else {
        c.g502 += headerGravada; // sin derecho: no se subdivide por activo fijo ni 5%
        c.i522 += iva;
      }
      c.b507 += base0;
      c.b531 += noObjeto;
      c.b532 += exento;
    }

    // Retenciones de IVA efectuadas como agente (cabecera = fuente única).
    for (const rt of p.retentions || []) {
      if (rt.type !== 'IVA') continue;
      const amount = Number(rt.amount) || 0;
      if (amount <= 0) continue;
      c.retIvaEfectuada += amount;
      retIvaDocs.push({
        purchase: String(p._id), serie: p.serie || '', fecha: purchaseFiscalDate(p),
        code: rt.code || '', base: r2(rt.baseAmount), amount: r2(amount),
        account: rt.account ? String(rt.account) : null,
      });
    }
  }
  for (const k of Object.keys(c)) c[k] = r2(c[k]);

  // Neto de compras = bruto − notas de crédito recibidas. La NC gravada resta de las filas
  // con derecho (500→501→540); el excedente va a "por compensar" (544/554). La NC 0% resta
  // del 507; su excedente va al 543.
  let remB = ncCompras.baseGravada;
  const n510 = pos(c.g500 - remB); remB = Math.max(0, r2(remB - c.g500));
  const n511 = pos(c.g501 - remB); remB = Math.max(0, r2(remB - c.g501));
  const n550 = pos(c.g540 - remB); remB = Math.max(0, r2(remB - c.g540));
  const comp544 = r2(remB);

  let remI = ncCompras.iva;
  const n520 = pos(c.i520 - remI); remI = Math.max(0, r2(remI - c.i520));
  const n521 = pos(c.i521 - remI); remI = Math.max(0, r2(remI - c.i521));
  const n560 = pos(c.i560 - remI); remI = Math.max(0, r2(remI - c.i560));
  const comp554 = r2(remI);

  const n517 = pos(c.b507 - ncCompras.base0);
  const comp543 = pos(ncCompras.base0 - c.b507);
  const n518 = c.b508;
  const n512 = c.g502;
  const n541 = pos(c.b531 - ncCompras.baseNoObjeto);
  const n542 = pos(c.b532 - ncCompras.baseExento);

  const ivaConDerechoNeto = r2(n520 + n521 + n560); // 530 (disponible)
  const ivaTotalNeto = r2(ivaConDerechoNeto + c.i522); // 529
  const ivaDisponible = ivaConDerechoNeto;

  const totalBrutoCompras = r2(c.g500 + c.g501 + c.g540 + c.g502 + c.b507 + c.b508);
  const totalNetoCompras = r2(n510 + n511 + n550 + n512 + n517 + n518);

  // ── Retenciones de IVA que NOS efectuaron (activo «Retención IVA por cobrar»)
  const settlements = await CardSettlement.find({
    clinic: clinicId, status: 'CONTABILIZADO', issueDate: { $gte: start, $lte: end },
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

  // ── Factor de proporcionalidad y crédito tributario
  const ventasConDerecho = r2(ventaGravadaNeta + n415);
  const ventasParaFactor = r2(ventaGravadaNeta + n413 + n415);
  const factor = ventasParaFactor > 0 ? +(ventasConDerecho / ventasParaFactor).toFixed(4) : 1;

  const ivaAlGastoSugerido = pos(ivaDisponible * (1 - factor));
  const ivaAlGasto = r2(editable['565'] != null ? editable['565'] : ivaAlGastoSugerido);
  const ivaUtilizable = r2(ivaDisponible - ivaAlGasto);
  const creditoAnterior = r2(editable['605'] || 0);

  // ── Resumen impositivo (sobre el IVA de ventas neto de notas de crédito)
  const impuestoCausado = pos(ventaIvaNeto - ivaUtilizable);
  const creditoGenerado = pos(ivaUtilizable - ventaIvaNeto);
  const neto = r2(impuestoCausado - creditoAnterior - retIvaRecibida);
  const impuestoPorPagar = pos(neto);
  const creditoProximoMes = r2(creditoGenerado + Math.max(0, -neto));
  const totalAPagar = r2(impuestoPorPagar + c.retIvaEfectuada);

  const totalVentasBruto = r2(v.baseGravada + b403 + b405 + v.baseNoObjeto + v.baseExento);
  const totalVentasNeto = r2(ventaGravadaNeta + n413 + n415 + noObjetoNetoV + exentoNetoV);

  const computed = {
    // Ventas
    401: v.baseGravada, 411: ventaGravadaNeta, 421: ventaIvaNeto,
    413: n413, 415: n415,
    431: v.baseNoObjeto, 441: noObjetoNetoV,
    434: v.baseExento, 444: exentoNetoV,
    409: totalVentasBruto, 419: totalVentasNeto, 429: ventaIvaNeto,
    // Compras
    500: c.g500, 510: n510, 520: n520,
    501: c.g501, 511: n511, 521: n521,
    540: c.g540, 550: n550, 560: n560,
    502: c.g502, 512: n512, 522: c.i522,
    503: 0, 513: 0, 523: 0,
    504: 0, 514: 0, 524: 0,
    505: 0, 515: 0, 525: 0,
    526: 0, 527: 0,
    506: 0, 516: 0,
    507: c.b507, 517: n517,
    508: c.b508, 518: n518,
    509: totalBrutoCompras, 519: totalNetoCompras, 529: ivaTotalNeto,
    531: c.b531, 541: n541,
    532: c.b532, 542: n542,
    543: comp543, 544: comp544, 554: comp554,
    // Crédito
    530: ivaDisponible, 563: factor, 564: ivaUtilizable,
    // Resumen
    601: impuestoCausado, 602: creditoGenerado, 607: retIvaRecibida,
    609: impuestoPorPagar, 615: creditoProximoMes,
    // Agente / pago
    721: c.retIvaEfectuada, 902: totalAPagar,
  };
  const editableResolved = { 403: b403, 405: b405, 565: ivaAlGasto, 605: creditoAnterior };
  const limits = { _base0Bruto: base0Bruto, 530: ivaDisponible };

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
      key: 'COMPRAS_TOTAL',
      label: 'Total adquisiciones (509) = suma de las filas',
      detalle: `Bruto ${totalBrutoCompras.toFixed(2)} · Neto ${totalNetoCompras.toFixed(2)} · IVA ${ivaTotalNeto.toFixed(2)}`,
      ok: true,
    },
    {
      key: 'IVA_COMPRAS',
      label: 'IVA de compras: con derecho (530) + sin derecho (522) = IVA total (529)',
      detalle: `${ivaDisponible.toFixed(2)} + ${c.i522.toFixed(2)} = ${ivaTotalNeto.toFixed(2)}`,
      ok: r2(ivaDisponible + c.i522) === ivaTotalNeto,
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
        ? `(${ventaGravadaNeta.toFixed(2)} gravadas + ${n415.toFixed(2)} tarifa 0% con derecho) / ${ventasParaFactor.toFixed(2)} = ${factor}`
        : 'Sin ventas en el período: se asume factor 1 (todo el IVA de compras es utilizable).',
      ok: true,
    },
    {
      // LIMITACIÓN CONOCIDA (ver definitions.js): la compra solo distingue "deducible" de
      // "no deducible". No se inventa la atribución directa vs. común: todo el IVA acreditable
      // se trata como COMÚN y se somete al factor. El contador ajusta el casillero 565.
      key: 'IVA_ATRIBUCION',
      label: 'Atribución del IVA de compras (limitación)',
      detalle: `Los ${ivaDisponible.toFixed(2)} de IVA con derecho a crédito se tratan como IVA COMÚN y se someten al factor. El IVA sin derecho (${c.i522.toFixed(2)}) ya fue al gasto al registrar la compra.`,
      ok: true,
    },
  ];
  if (ivaDisponible > 0) {
    warnings.push({
      code: 'IVA_ATRIBUCION_DIRECTA',
      severity: 'info',
      message: factor < 1
        ? `El factor de proporcionalidad se aplica a TODO el IVA acreditable (${ivaDisponible.toFixed(2)}) porque las compras no registran atribución directa. Si parte es directamente atribuible a ventas con derecho a crédito, ajuste el casillero 565 (IVA al gasto) con su contador.`
        : 'Las compras no registran si el IVA es de atribución directa o común. En este período el factor es 1, así que no cambia el resultado, pero la clasificación está pendiente de definir con el contador.',
    });
  }
  if (comp543 > 0 || comp544 > 0 || comp554 > 0) {
    warnings.push({
      code: 'NC_COMPRAS_POR_COMPENSAR',
      severity: 'info',
      message: `Las notas de crédito de compras superan las adquisiciones de su tarifa en el período. El excedente queda "por compensar el próximo mes": ${comp543 > 0 ? `0% $${comp543.toFixed(2)} (casillero 543)` : ''}${comp544 > 0 ? ` gravadas $${comp544.toFixed(2)} base (544) / $${comp554.toFixed(2)} IVA (554)` : ''}.`.replace(/\s+/g, ' ').trim(),
    });
  }
  if (ivaAlGasto > ivaDisponible + 0.005) {
    warnings.push({ code: 'IVA_GASTO_EXCEDE', message: `El IVA al gasto (${ivaAlGasto.toFixed(2)}) supera el IVA disponible (${ivaDisponible.toFixed(2)}).` });
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
      base0: base0Bruto,
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
      gravadaConDerechoBruta: c.g500,
      gravadaConDerechoNeta: n510,
      activoFijoConDerecho: c.g501,
      gravada5: c.g540,
      gravadaSinDerecho: c.g502,
      tarifa0: c.b507,
      rise: c.b508,
      noObjeto: c.b531,
      exento: c.b532,
      ivaConDerecho: ivaConDerechoNeto,
      ivaSinDerecho: c.i522,
      ivaTotal: ivaTotalNeto,
      ivaDisponible,
      ivaYaAlGasto: c.i522,
      docs: compras.slice(0, 500).map((p) => ({
        id: String(p._id), serie: p.serie || '', fecha: purchaseFiscalDate(p),
        docType: p.docType || 'FACTURA', subtotal: r2(p.subtotal), iva: r2(p.iva),
        ivaCredito: r2(creditVat(p)), deducible: p.deductible !== false,
      })),
    },
    notasCredito: {
      ventas: ncVentas, compras: ncCompras,
      porCompensar: { base0: comp543, baseGravada: comp544, iva: comp554 },
    },
    retencionesIvaEfectuadas: { total: c.retIvaEfectuada, docs: retIvaDocs },
    retencionesIvaRecibidas: { total: retIvaRecibida, docs: retRecibidaDocs },
    factorProporcionalidad: factor,
    ivaDisponible, ivaUtilizable, ivaAlGasto, creditoAnterior,
  };

  const totals = {
    ventasBase: totalVentasNeto,
    ventasIva: ventaIvaNeto,
    comprasBase: totalNetoCompras,
    comprasIva: ivaTotalNeto,
    ivaUtilizable, ivaAlGasto,
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
    suggestions: { 565: ivaAlGastoSugerido, 403: base0Bruto, 405: 0 },
  };
}

module.exports = { compute104 };
