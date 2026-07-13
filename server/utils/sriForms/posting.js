/**
 * CONTABILIZACIÓN DE LAS DECLARACIONES (Formularios 103 y 104) y su obligación.
 *
 * Reglas transversales que aplica:
 *   - NO acredita Banco. La declaración solo reconoce la OBLIGACIÓN; el banco se mueve
 *     únicamente cuando se paga (ver taxDeclarationController.pay).
 *   - NO duplica el pasivo: el crédito a «SRI por pagar» lo hace el asiento, y la CxP es
 *     solo el documento de submayor sobre esa misma cuenta de control.
 *   - Las cuentas se resuelven por ROL (AccountingConfig → catálogo), nunca por código fijo.
 *     Las retenciones se cierran contra la cuenta con la que se contabilizaron (snapshot
 *     de la retención), cayendo al rol solo si la retención no dejó cuenta.
 *   - Agrega por cuenta y netea: ninguna línea lleva débito y crédito a la vez.
 */
const crypto = require('crypto');
const ChartOfAccount = require('../../models/ChartOfAccount');
const { getAccount } = require('../accountMap');
const { XML_DISCLAIMER, getDefinition } = require('./definitions');

const r2 = (n) => +(Number(n) || 0).toFixed(2);

/** Agregador de líneas por cuenta (evita débito y crédito en la misma línea). */
function lineAggregator() {
  const agg = new Map();
  return {
    add(accountId, debit, credit, description) {
      if (!accountId) return;
      const key = String(accountId);
      if (!agg.has(key)) agg.set(key, { account: accountId, debit: 0, credit: 0, description });
      const row = agg.get(key);
      row.debit = r2(row.debit + (debit || 0));
      row.credit = r2(row.credit + (credit || 0));
    },
    lines() {
      return [...agg.values()]
        .map((l) => {
          const net = r2(l.debit - l.credit);
          return net >= 0
            ? { account: l.account, debit: net, credit: 0, description: l.description }
            : { account: l.account, debit: 0, credit: r2(-net), description: l.description };
        })
        .filter((l) => l.debit > 0 || l.credit > 0);
    },
  };
}

/** Cuenta con la que se contabilizó una retención; si no la dejó, la del rol. */
async function retentionAccount(clinicId, doc, role, session) {
  if (doc.account) {
    const acc = await ChartOfAccount.findOne({ _id: doc.account, clinic: clinicId }).session(session || null);
    if (acc) return acc._id;
  }
  return (await getAccount(clinicId, role, { session }))._id;
}

/**
 * Líneas del asiento de cierre del FORMULARIO 104.
 *
 *   D IVA en ventas ............ IVA generado (cierra el pasivo del período)
 *   D IVA al gasto ............. IVA no deducible reclasificado
 *   D Retención IVA por pagar .. retenciones efectuadas como agente (se pagan con el 104)
 *   H IVA en compras ........... IVA disponible (cierra el activo del período)
 *   H Retención IVA por cobrar . retenciones que nos efectuaron (se aplican al impuesto)
 *   H Crédito tributario ....... saldo a favor del mes anterior consumido
 *   H SRI por pagar ............ obligación resultante   (si hay que pagar)
 *   D Crédito tributario ....... saldo a favor del período (si queda a favor)
 */
async function build104Lines(clinicId, { snapshot, totals }, session) {
  const agg = lineAggregator();
  const [ivaVentas, ivaCompras, ivaGasto, creditoTrib, retIvaCobrar, sriPorPagar] = await Promise.all([
    getAccount(clinicId, 'ivaVentas', { session }),
    getAccount(clinicId, 'ivaCompras', { session }),
    getAccount(clinicId, 'ivaComprasNoCredito', { session }),
    getAccount(clinicId, 'creditoTributarioIva', { session }),
    getAccount(clinicId, 'retIvaPorCobrar', { session }),
    getAccount(clinicId, 'sriPorPagar', { session }),
  ]);

  const ivaGenerado = r2(snapshot.ventas.iva);
  const ivaDisponible = r2(snapshot.ivaDisponible);
  const ivaAlGasto = r2(snapshot.ivaAlGasto);
  const retRecibidas = r2(snapshot.retencionesIvaRecibidas.total);
  const creditoAnterior = r2(snapshot.creditoAnterior);
  const impuesto = r2(totals.impuestoPorPagar);
  const creditoNuevo = r2(totals.creditoTributario);

  if (ivaGenerado > 0) agg.add(ivaVentas._id, ivaGenerado, 0, 'Cierre IVA en ventas del período');
  if (ivaAlGasto > 0) agg.add(ivaGasto._id, ivaAlGasto, 0, 'IVA no deducible enviado al gasto (proporcionalidad)');
  if (ivaDisponible > 0) agg.add(ivaCompras._id, 0, ivaDisponible, 'Cierre IVA en compras del período');
  if (retRecibidas > 0) agg.add(retIvaCobrar._id, 0, retRecibidas, 'Retenciones de IVA que nos efectuaron, aplicadas');
  if (creditoAnterior > 0) agg.add(creditoTrib._id, 0, creditoAnterior, 'Crédito tributario del mes anterior aplicado');

  // Retenciones de IVA efectuadas como agente: cierran su pasivo y pasan a la obligación.
  for (const d of snapshot.retencionesIvaEfectuadas.docs || []) {
    const accId = await retentionAccount(clinicId, d, 'retIvaPorPagar', session);
    agg.add(accId, r2(d.amount), 0, `Retención IVA efectuada ${d.code} (${d.serie})`);
  }

  const obligacion = r2(impuesto + r2(snapshot.retencionesIvaEfectuadas.total));
  if (obligacion > 0) agg.add(sriPorPagar._id, 0, obligacion, 'Obligación con el SRI (Formulario 104)');
  if (creditoNuevo > 0) agg.add(creditoTrib._id, creditoNuevo, 0, 'Crédito tributario a favor del próximo período');

  return { lines: agg.lines(), obligacion, controlAccount: sriPorPagar._id };
}

/**
 * Líneas del asiento de cierre del FORMULARIO 103.
 *
 *   D Retención Renta por pagar .. retenciones a proveedores (por código, con su cuenta)
 *   D Impuesto a la Renta por pagar retención a empleados (relación de dependencia)
 *   H SRI por pagar .............. obligación total del período
 */
async function build103Lines(clinicId, { snapshot, totals }, session) {
  const agg = lineAggregator();
  const [irPorPagar, sriPorPagar] = await Promise.all([
    getAccount(clinicId, 'irPorPagar', { session }),
    getAccount(clinicId, 'sriPorPagar', { session }),
  ]);

  for (const row of snapshot.proveedores.rows || []) {
    for (const d of row.docs || []) {
      const accId = await retentionAccount(clinicId, d, 'retRentaPorPagar', session);
      agg.add(accId, r2(d.amount), 0, `Retención renta ${row.code} (${d.serie})`);
    }
  }
  const laboral = r2(snapshot.dependencia.retenido);
  if (laboral > 0) agg.add(irPorPagar._id, laboral, 0, 'Retención IR en relación de dependencia');

  const obligacion = r2(totals.totalAPagar);
  if (obligacion > 0) agg.add(sriPorPagar._id, 0, obligacion, 'Obligación con el SRI (Formulario 103)');

  return { lines: agg.lines(), obligacion, controlAccount: sriPorPagar._id };
}

async function buildDeclarationLines(clinicId, declaration, session) {
  const payload = { snapshot: declaration.snapshot, totals: declaration.totals };
  if (declaration.formType === '104') return build104Lines(clinicId, payload, session);
  return build103Lines(clinicId, payload, session);
}

/**
 * BORRADOR TÉCNICO en XML. NO es el XML oficial del SRI ni un archivo DIMM: la
 * estructura no está validada contra la definición vigente (ver definitions.js).
 * Se guarda como respaldo/auditoría de lo declarado, con su hash.
 */
function buildDraftXml(declaration, clinic) {
  const def = getDefinition(declaration.formType);
  const esc = (s) => String(s == null ? '' : s).replace(/[<>&"']/g, (ch) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
  }[ch]));
  const cells = declaration.cellMap ? declaration.cellMap() : {};
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<!-- ${XML_DISCLAIMER} -->`,
    '<borradorTecnico>',
    `  <advertencia>${esc(XML_DISCLAIMER)}</advertencia>`,
    `  <formulario>${esc(declaration.formType)}</formulario>`,
    `  <definicion>${esc(def.definitionVersion)}</definicion>`,
    `  <casillerosVerificados>${def.verified ? 'true' : 'false'}</casillerosVerificados>`,
    `  <ruc>${esc(clinic?.ruc)}</ruc>`,
    `  <razonSocial>${esc(clinic?.razonSocial || clinic?.name)}</razonSocial>`,
    `  <periodoFiscal>${String(declaration.month).padStart(2, '0')}/${declaration.year}</periodoFiscal>`,
    `  <version>${declaration.version}</version>`,
    '  <casilleros>',
  ];
  for (const box of Object.keys(cells).sort()) {
    lines.push(`    <casillero numero="${esc(box)}">${Number(cells[box] || 0).toFixed(2)}</casillero>`);
  }
  lines.push('  </casilleros>');
  // El 103 tiene filas dinámicas por código de retención.
  if (declaration.formType === '103') {
    lines.push('  <retencionesProveedores>');
    for (const row of declaration.snapshot?.proveedores?.rows || []) {
      lines.push('    <retencion>');
      lines.push(`      <codigo>${esc(row.code)}</codigo>`);
      lines.push(`      <baseImponible>${Number(row.base || 0).toFixed(2)}</baseImponible>`);
      lines.push(`      <valorRetenido>${Number(row.amount || 0).toFixed(2)}</valorRetenido>`);
      lines.push('    </retencion>');
    }
    lines.push('  </retencionesProveedores>');
  }
  lines.push(`  <totalAPagar>${Number(declaration.totals?.totalAPagar || 0).toFixed(2)}</totalAPagar>`);
  lines.push('</borradorTecnico>');
  const xml = lines.join('\n');
  return { xml, hash: crypto.createHash('sha256').update(xml).digest('hex') };
}

module.exports = { buildDeclarationLines, build103Lines, build104Lines, buildDraftXml };
