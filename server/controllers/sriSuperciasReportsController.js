/**
 * Reportes oficiales SRI (XML) y SuperCías (TXT).
 *
 * SuperCías F.20 (estados financieros):
 *   - Balance General: archivo plano pipe `codigoCuenta|saldo`
 *   - Estado de Resultados: mismo formato
 * SRI:
 *   - Formulario 103 (retenciones en la fuente) XML
 *   - Formulario 104 (IVA) XML
 *   - ATS ya existe en accountingReportsController
 */

const JournalEntry = require('../models/JournalEntry');
const ChartOfAccount = require('../models/ChartOfAccount');
const Invoice = require('../models/Invoice');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const Clinic = require('../models/Clinic');

function escXml(s) {
  return String(s == null ? '' : s).replace(/[<>&"']/g, (c) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    '"': '&quot;',
    "'": '&apos;',
  }[c]));
}

async function getBalances(clinicId, { startDate, endDate } = {}) {
  const match = { clinic: clinicId, status: 'CONTABILIZADO' };
  if (startDate || endDate) {
    match.date = {};
    if (startDate) match.date.$gte = new Date(startDate);
    if (endDate) match.date.$lte = new Date(endDate);
  }
  const agg = await JournalEntry.aggregate([
    { $match: match },
    { $unwind: '$lines' },
    {
      $group: {
        _id: '$lines.account',
        debit: { $sum: '$lines.debit' },
        credit: { $sum: '$lines.credit' },
      },
    },
  ]);
  const accounts = await ChartOfAccount.find({ clinic: clinicId });
  const map = new Map(
    accounts.map((a) => [String(a._id), { ...a.toObject(), debit: 0, credit: 0, balance: 0 }])
  );
  for (const r of agg) {
    const a = map.get(String(r._id));
    if (!a) continue;
    a.debit = r.debit;
    a.credit = r.credit;
    a.balance = a.nature === 'DEBITO' ? r.debit - r.credit : r.credit - r.debit;
  }
  return Array.from(map.values());
}

/**
 * GET /accounting-reports/supercias/balance-sheet.txt?date=YYYY-MM-DD
 * Pipe-separated codigoCuenta|saldo de cuentas con movimiento (formato F.20 simplificado).
 */
exports.balanceSheetTxt = async (req, res) => {
  try {
    const { date } = req.query;
    const balances = await getBalances(req.clinicId, { endDate: date });
    const rows = balances
      .filter((a) => a.allowsMovement && ['ACTIVO', 'PASIVO', 'PATRIMONIO'].includes(a.type))
      .map((a) => `${a.code}|${(a.balance || 0).toFixed(2)}`);
    const txt = rows.join('\r\n') + '\r\n';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="supercias-balance-${date || 'actual'}.txt"`
    );
    res.send(txt);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

/**
 * GET /accounting-reports/supercias/income-statement.txt?startDate&endDate
 */
exports.incomeStatementTxt = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const balances = await getBalances(req.clinicId, { startDate, endDate });
    const rows = balances
      .filter((a) => a.allowsMovement && ['INGRESO', 'COSTO', 'GASTO'].includes(a.type))
      .map((a) => `${a.code}|${(a.balance || 0).toFixed(2)}`);
    const txt = rows.join('\r\n') + '\r\n';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="supercias-resultados-${startDate || ''}_${endDate || ''}.txt"`
    );
    res.send(txt);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

/**
 * GET /accounting-reports/sri/form-104.xml?year&month
 * Genera XML del formulario 104 (IVA mensual) compatible con DIMM Formularios.
 */
exports.form104Xml = async (req, res) => {
  try {
    const { year, month } = req.query;
    const y = parseInt(year);
    const m = parseInt(month);
    if (!y || !m) return res.status(400).json({ message: 'year y month requeridos' });
    const start = new Date(y, m - 1, 1);
    const end = new Date(y, m, 0, 23, 59, 59);
    const clinic = await Clinic.findById(req.clinicId);

    const ventas = await Invoice.find({
      clinic: req.clinicId,
      estado: 'AUTORIZADO',
      createdAt: { $gte: start, $lte: end },
    });
    const v = ventas.reduce(
      (acc, i) => {
        acc.base += i.totalSinImpuestos || 0;
        acc.iva += i.totalImpuesto || 0;
        return acc;
      },
      { base: 0, iva: 0 }
    );

    const compras = await PurchaseInvoice.find({
      clinic: req.clinicId,
      status: { $ne: 'ANULADA' },
      fechaEmision: { $gte: start, $lte: end },
    });
    const c = compras.reduce(
      (acc, p) => {
        acc.base += p.subtotal || 0;
        acc.iva += p.iva || 0;
        acc.retIVA += (p.retentions || [])
          .filter((r) => r.type === 'IVA')
          .reduce((s, r) => s + (r.amount || 0), 0);
        return acc;
      },
      { base: 0, iva: 0, retIVA: 0 }
    );

    const ivaPagar = +(v.iva - c.iva - c.retIVA).toFixed(2);
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<form104>\n';
    xml += `  <ruc>${escXml(clinic?.ruc)}</ruc>\n`;
    xml += `  <razonSocial>${escXml(clinic?.razonSocial || clinic?.name)}</razonSocial>\n`;
    xml += `  <periodoFiscal>${String(m).padStart(2, '0')}/${y}</periodoFiscal>\n`;
    xml += '  <ventas>\n';
    xml += `    <baseImponible>${v.base.toFixed(2)}</baseImponible>\n`;
    xml += `    <iva>${v.iva.toFixed(2)}</iva>\n`;
    xml += '  </ventas>\n';
    xml += '  <compras>\n';
    xml += `    <baseImponible>${c.base.toFixed(2)}</baseImponible>\n`;
    xml += `    <iva>${c.iva.toFixed(2)}</iva>\n`;
    xml += `    <retencionIva>${c.retIVA.toFixed(2)}</retencionIva>\n`;
    xml += '  </compras>\n';
    xml += `  <ivaPorPagar>${ivaPagar.toFixed(2)}</ivaPorPagar>\n`;
    xml += '</form104>\n';
    res.setHeader('Content-Type', 'application/xml');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="form104-${y}-${String(m).padStart(2, '0')}.xml"`
    );
    res.send(xml);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

/**
 * GET /accounting-reports/sri/form-103.xml?year&month
 * Retenciones en la fuente del impuesto a la renta.
 */
exports.form103Xml = async (req, res) => {
  try {
    const { year, month } = req.query;
    const y = parseInt(year);
    const m = parseInt(month);
    if (!y || !m) return res.status(400).json({ message: 'year y month requeridos' });
    const start = new Date(y, m - 1, 1);
    const end = new Date(y, m, 0, 23, 59, 59);
    const clinic = await Clinic.findById(req.clinicId);
    const compras = await PurchaseInvoice.find({
      clinic: req.clinicId,
      status: { $ne: 'ANULADA' },
      fechaEmision: { $gte: start, $lte: end },
    });
    const byCode = {};
    for (const p of compras) {
      for (const r of p.retentions || []) {
        if (r.type !== 'RENTA') continue;
        const key = r.code || '0000';
        if (!byCode[key]) byCode[key] = { code: key, description: r.description || '', base: 0, amount: 0 };
        byCode[key].base += r.baseAmount || 0;
        byCode[key].amount += r.amount || 0;
      }
    }
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<form103>\n';
    xml += `  <ruc>${escXml(clinic?.ruc)}</ruc>\n`;
    xml += `  <razonSocial>${escXml(clinic?.razonSocial || clinic?.name)}</razonSocial>\n`;
    xml += `  <periodoFiscal>${String(m).padStart(2, '0')}/${y}</periodoFiscal>\n`;
    xml += '  <retenciones>\n';
    let total = 0;
    for (const r of Object.values(byCode)) {
      xml += '    <retencion>\n';
      xml += `      <codigo>${escXml(r.code)}</codigo>\n`;
      xml += `      <descripcion>${escXml(r.description)}</descripcion>\n`;
      xml += `      <baseImponible>${r.base.toFixed(2)}</baseImponible>\n`;
      xml += `      <valorRetenido>${r.amount.toFixed(2)}</valorRetenido>\n`;
      xml += '    </retencion>\n';
      total += r.amount;
    }
    xml += '  </retenciones>\n';
    xml += `  <totalRetenido>${total.toFixed(2)}</totalRetenido>\n`;
    xml += '</form103>\n';
    res.setHeader('Content-Type', 'application/xml');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="form103-${y}-${String(m).padStart(2, '0')}.xml"`
    );
    res.send(xml);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};
