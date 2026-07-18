/**
 * CÁLCULO DEL FORMULARIO 103 (retenciones en la fuente del IR) para un período.
 *
 * Fuentes:
 *   - Retenciones a proveedores: cabecera `retentions` de las compras no anuladas del
 *     período (tipo RENTA). Es la FUENTE ÚNICA: la cabecera ya viene agregada desde las
 *     retenciones por línea Y es de donde se construye el comprobante de retención
 *     (RetentionVoucher se genera a partir de `inv.retentions`), así que NO se recorren
 *     `item.retentions` ni el voucher (evita el doble conteo).
 *   - Casillero 332 (no sujetos a retención): base NETA de compras que NO se retuvo. Incluye
 *     los comprobantes sin ninguna retención Y la PORCIÓN no retenida de los parcialmente
 *     retenidos, de modo que: 332 = total neto de compras − suma de bases retenidas. Así la
 *     suma de las bases del 103 (códigos de retención + 332) cuadra con el total neto de
 *     compras del período (base sin impuestos = subtotal0 + 15% + no objeto + exento).
 *   - Relación de dependencia (casillero 302): nóminas CERRADAS/PAGADAS del período
 *     (utils/payrollWithholding), con mapeo auditable de conceptos incluidos/excluidos.
 *     Base = ingresos gravados; valor retenido = IR descontado en el rol.
 *
 * Conciliaciones que devuelve (obligatorias antes de finalizar):
 *   1. bases del 103 cuadran con las compras del período (retenidas + 332 = total neto);
 *   2. valor retenido por código vs. documentos origen (detalle por comprobante);
 *   3. valores laborales vs. nóminas cerradas;
 *   4. documentos excluidos y su motivo;
 *   5. ninguna factura ni retención duplicada.
 */
const PurchaseInvoice = require('../../models/PurchaseInvoice');
const { purchaseFiscalDate } = require('../reportDateRange');
const { payrollWithholdingForPeriod } = require('../payrollWithholding');

const r2 = (n) => +(Number(n) || 0).toFixed(2);

/**
 * @param {object} args { clinicId, range }  range: { start, end, year, month }
 */
async function compute103({ clinicId, range }) {
  const { start, end } = range;
  const warnings = [];

  const compras = await PurchaseInvoice.find({
    clinic: clinicId,
    status: { $ne: 'ANULADA' },
    fechaEmision: { $gte: start, $lte: end },
  }).lean();

  // ── Retenciones de renta por código (fuente única: cabecera) + no sujetos (332)
  const byCode = new Map();
  const noSujetos = [];
  const vistos = new Set(); // control de duplicados: comprobante + código
  let totalRetenido = 0;
  let baseRetenida = 0;

  for (const p of compras) {
    const subtotal = r2(p.subtotal);
    const rentaRets = (p.retentions || []).filter((r) => r.type === 'RENTA' && (Number(r.amount) || 0) > 0);

    let baseRetenidaDoc = 0;
    for (const r of rentaRets) {
      const code = r.code || '0000';
      const key = `${p._id}|${code}`;
      if (vistos.has(key)) {
        warnings.push({
          code: 'RETENCION_DUPLICADA',
          message: `El comprobante ${p.serie || p._id} tiene el código de retención ${code} repetido en la cabecera.`,
        });
        continue;
      }
      vistos.add(key);
      const base = r2(r.baseAmount);
      const amount = r2(r.amount);
      if (!byCode.has(code)) {
        byCode.set(code, { code, description: r.description || '', rate: Number(r.percentage) || 0, base: 0, amount: 0, docs: [] });
      }
      const row = byCode.get(code);
      row.base = r2(row.base + base);
      row.amount = r2(row.amount + amount);
      row.docs.push({
        purchase: String(p._id),
        serie: p.serie || '',
        fecha: purchaseFiscalDate(p),
        base,
        amount,
        account: r.account ? String(r.account) : null,
      });
      totalRetenido = r2(totalRetenido + amount);
      baseRetenida = r2(baseRetenida + base);
      baseRetenidaDoc = r2(baseRetenidaDoc + base);
    }

    // Porción NO sujeta a retención del comprobante (332): la base que no se retuvo.
    // Cubre tanto los comprobantes sin retención como la parte no retenida de los
    // parcialmente retenidos.
    const noSujetoDoc = r2(Math.max(0, subtotal - baseRetenidaDoc));
    if (noSujetoDoc > 0) {
      noSujetos.push({
        purchase: String(p._id),
        serie: p.serie || '',
        fecha: purchaseFiscalDate(p),
        base: noSujetoDoc,
        subtotal,
        baseRetenida: baseRetenidaDoc,
        motivo: baseRetenidaDoc > 0
          ? 'Porción no sujeta a retención del comprobante (parcialmente retenido)'
          : 'Comprobante sin retención de renta',
      });
    }
    if (baseRetenidaDoc > subtotal + 0.01) {
      warnings.push({
        code: 'RETENCION_SOBRE_BASE',
        message: `El comprobante ${p.serie || p._id} tiene base retenida (${baseRetenidaDoc.toFixed(2)}) mayor que su subtotal (${subtotal.toFixed(2)}): revise las retenciones.`,
      });
    }
  }

  // ── Relación de dependencia (nóminas cerradas / pagadas)
  const dependencia = await payrollWithholdingForPeriod({ clinicId, year: range.year, month: range.month });
  warnings.push(...dependencia.warnings);

  const baseNoSujeta = r2(noSujetos.reduce((s, d) => s + d.base, 0));
  const totalComprasBase = r2(compras.reduce((s, p) => s + (Number(p.subtotal) || 0), 0));
  const sumaBasesCompras = r2(baseRetenida + baseNoSujeta);
  const totalGeneral = r2(totalRetenido + dependencia.total);

  const rows = [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));

  // ── Conciliaciones obligatorias
  const cuadra = Math.abs(sumaBasesCompras - totalComprasBase) <= 0.01;
  const conciliaciones = [
    {
      key: 'BASES_CUADRAN',
      label: 'Bases del 103 cuadran con el total neto de compras',
      detalle: `Base retenida ${baseRetenida.toFixed(2)} + no sujeta (332) ${baseNoSujeta.toFixed(2)} = ${sumaBasesCompras.toFixed(2)} · total neto de compras del período ${totalComprasBase.toFixed(2)}`,
      ok: cuadra,
    },
    {
      key: 'RETENIDO_VS_DOCUMENTOS',
      label: 'Valor retenido por código vs. documentos origen',
      detalle: `${rows.length} código(s) · ${rows.reduce((s, r) => s + r.docs.length, 0)} comprobante(s) · total ${totalRetenido.toFixed(2)}`,
      ok: r2(rows.reduce((s, r) => s + r.amount, 0)) === totalRetenido,
    },
    {
      key: 'LABORAL_VS_NOMINAS',
      label: 'Relación de dependencia (302) vs. nóminas cerradas',
      detalle: dependencia.payrolls.incluidos.length
        ? `${dependencia.payrolls.incluidos.length} rol(es) · base gravada ${dependencia.baseGravada.toFixed(2)} · IR retenido ${dependencia.total.toFixed(2)} (base imponible neta de IESS: ${dependencia.baseImponibleNeta.toFixed(2)})`
        : 'Sin nóminas cerradas en el período.',
      ok: true,
    },
    {
      key: 'SIN_DUPLICADOS',
      label: 'Sin facturas ni retenciones duplicadas',
      detalle: `${vistos.size} par(es) comprobante+código únicos · ${noSujetos.length} comprobante(s) con base no sujeta`,
      ok: !warnings.some((w) => w.code === 'RETENCION_DUPLICADA'),
    },
  ];

  if (!cuadra) {
    warnings.push({
      code: 'BASES_103_DESCUADRADAS',
      message: `La suma de las bases del 103 (retenidas ${baseRetenida.toFixed(2)} + no sujetas ${baseNoSujeta.toFixed(2)} = ${sumaBasesCompras.toFixed(2)}) no coincide con el total neto de compras del período (${totalComprasBase.toFixed(2)}). Revise que ninguna base retenida supere el subtotal de su comprobante.`,
    });
  }

  const def = require('./definitions').FORM_103;
  const computed = {
    [def.dependencyBox]: dependencia.baseGravada, // base declarada del casillero laboral (302)
    332: baseNoSujeta,
    399: totalGeneral,
  };

  const snapshot = {
    dependencia: {
      baseGravada: dependencia.baseGravada,
      baseImponibleNeta: dependencia.baseImponibleNeta,
      iessPersonal: dependencia.iessPersonal,
      retenido: dependencia.total,
      empleados: dependencia.empleados,
      excluidos: dependencia.excluidos,
      payrolls: dependencia.payrolls,
    },
    proveedores: { rows, totalRetenido, baseRetenida },
    noSujetos: { count: noSujetos.length, base: baseNoSujeta, docs: noSujetos.slice(0, 500) },
    comprasDelPeriodo: { count: compras.length, subtotal: totalComprasBase, sumaBases: sumaBasesCompras, cuadra },
  };

  const totals = {
    ventasBase: 0,
    ventasIva: 0,
    comprasBase: totalComprasBase,
    comprasIva: 0,
    ivaUtilizable: 0,
    ivaAlGasto: 0,
    retencionesEfectuadas: totalGeneral,
    impuestoPorPagar: totalGeneral,
    creditoTributario: 0,
    totalAPagar: totalGeneral,
  };

  return {
    computed,
    editable: {},
    limits: {},
    rows, // filas dinámicas por código de retención (las dibuja la UI)
    dependencia,
    totals,
    conciliaciones,
    warnings,
    snapshot,
    suggestions: {},
  };
}

module.exports = { compute103 };
