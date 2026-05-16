const JournalEntry = require('../models/JournalEntry');
const ChartOfAccount = require('../models/ChartOfAccount');
const Sale = require('../models/Sale');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const Invoice = require('../models/Invoice');
const Payment = require('../models/Payment');
const Product = require('../models/Product');
const InventoryMovement = require('../models/InventoryMovement');

// ---------- Helpers ----------
async function getAccountBalances(clinicId, { startDate, endDate } = {}) {
  const match = { clinic: clinicId, status: 'CONTABILIZADO' };
  if (startDate || endDate) {
    match.date = {};
    if (startDate) match.date.$gte = new Date(startDate);
    if (endDate) match.date.$lte = new Date(endDate);
  }
  const agg = await JournalEntry.aggregate([
    { $match: match },
    { $unwind: '$lines' },
    { $group: { _id: '$lines.account', debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
  ]);
  const accounts = await ChartOfAccount.find({ clinic: clinicId });
  const map = new Map(accounts.map((a) => [String(a._id), { ...a.toObject(), debit: 0, credit: 0, balance: 0 }]));
  for (const r of agg) {
    const a = map.get(String(r._id));
    if (!a) continue;
    a.debit = r.debit; a.credit = r.credit;
    a.balance = a.nature === 'DEBITO' ? r.debit - r.credit : r.credit - r.debit;
  }
  return Array.from(map.values());
}

// ---------- Estado de Resultados ----------
exports.incomeStatement = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const balances = await getAccountBalances(req.clinicId, { startDate, endDate });
    const ingresos = balances.filter((a) => a.type === 'INGRESO' && a.allowsMovement);
    const costos = balances.filter((a) => a.type === 'COSTO' && a.allowsMovement);
    const gastos = balances.filter((a) => a.type === 'GASTO' && a.allowsMovement);
    const totalIngresos = ingresos.reduce((s, a) => s + a.balance, 0);
    const totalCostos = costos.reduce((s, a) => s + a.balance, 0);
    const totalGastos = gastos.reduce((s, a) => s + a.balance, 0);
    const utilidadBruta = totalIngresos - totalCostos;
    const utilidadOperacional = utilidadBruta - totalGastos;
    res.json({
      ingresos, costos, gastos,
      totales: { totalIngresos, totalCostos, totalGastos, utilidadBruta, utilidadOperacional },
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ---------- Balance General ----------
exports.balanceSheet = async (req, res) => {
  try {
    const { date } = req.query;
    const balances = await getAccountBalances(req.clinicId, { endDate: date });
    const activos = balances.filter((a) => a.type === 'ACTIVO' && a.allowsMovement);
    const pasivos = balances.filter((a) => a.type === 'PASIVO' && a.allowsMovement);
    const patrimonio = balances.filter((a) => a.type === 'PATRIMONIO' && a.allowsMovement);
    const ingresos = balances.filter((a) => a.type === 'INGRESO');
    const gastos = balances.filter((a) => a.type === 'GASTO' || a.type === 'COSTO');
    const totalActivos = activos.reduce((s, a) => s + a.balance, 0);
    const totalPasivos = pasivos.reduce((s, a) => s + a.balance, 0);
    const utilidad = ingresos.reduce((s, a) => s + a.balance, 0) - gastos.reduce((s, a) => s + a.balance, 0);
    const totalPatrimonio = patrimonio.reduce((s, a) => s + a.balance, 0) + utilidad;
    res.json({
      activos, pasivos, patrimonio,
      utilidadEjercicio: utilidad,
      totales: { totalActivos, totalPasivos, totalPatrimonio, totalPasivoPatrimonio: totalPasivos + totalPatrimonio },
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ---------- Flujo de Caja (cuentas de efectivo y banco) ----------
exports.cashFlow = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const cashAccs = await ChartOfAccount.find({ clinic: req.clinicId, code: /^1\.1\.01\./ });
    const ids = cashAccs.map((a) => a._id);
    const match = { clinic: req.clinicId, status: 'CONTABILIZADO', 'lines.account': { $in: ids } };
    if (startDate || endDate) {
      match.date = {};
      if (startDate) match.date.$gte = new Date(startDate);
      if (endDate) match.date.$lte = new Date(endDate);
    }
    const entries = await JournalEntry.find(match).sort({ date: 1 });
    const flows = [];
    let saldo = 0;
    for (const e of entries) {
      for (const l of e.lines) {
        if (!ids.some((id) => String(id) === String(l.account))) continue;
        const movement = l.debit - l.credit;
        saldo += movement;
        flows.push({ date: e.date, number: e.number, description: e.description, in: l.debit, out: l.credit, saldo });
      }
    }
    res.json({ flows, totalIn: flows.reduce((s, f) => s + f.in, 0), totalOut: flows.reduce((s, f) => s + f.out, 0), saldoFinal: saldo });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ---------- Ventas: resumen, por producto, por cajero, semanal ----------
exports.salesSummary = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const match = { clinic: req.clinicId, status: 'completada' };
    if (startDate || endDate) {
      match.createdAt = {};
      if (startDate) match.createdAt.$gte = new Date(startDate);
      if (endDate) match.createdAt.$lte = new Date(endDate);
    }
    const total = await Sale.aggregate([
      { $match: match },
      { $group: { _id: null, count: { $sum: 1 }, subtotal: { $sum: '$subtotal' }, taxAmount: { $sum: '$taxAmount' }, total: { $sum: '$total' } } },
    ]);
    res.json(total[0] || { count: 0, subtotal: 0, taxAmount: 0, total: 0 });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.salesByProduct = async (req, res) => {
  const { startDate, endDate } = req.query;
  const match = { clinic: req.clinicId, status: 'completada' };
  if (startDate || endDate) {
    match.createdAt = {};
    if (startDate) match.createdAt.$gte = new Date(startDate);
    if (endDate) match.createdAt.$lte = new Date(endDate);
  }
  const rows = await Sale.aggregate([
    { $match: match }, { $unwind: '$items' },
    { $group: { _id: { product: '$items.product', name: '$items.productName' },
                qty: { $sum: '$items.quantity' }, subtotal: { $sum: '$items.subtotal' } } },
    { $sort: { subtotal: -1 } },
  ]);
  res.json(rows);
};

exports.salesByCashier = async (req, res) => {
  const { startDate, endDate } = req.query;
  const match = { clinic: req.clinicId, status: 'completada' };
  if (startDate || endDate) {
    match.createdAt = {};
    if (startDate) match.createdAt.$gte = new Date(startDate);
    if (endDate) match.createdAt.$lte = new Date(endDate);
  }
  const rows = await Sale.aggregate([
    { $match: match },
    { $group: { _id: '$cashier', count: { $sum: 1 }, total: { $sum: '$total' } } },
    { $sort: { total: -1 } },
  ]);
  await Sale.populate(rows, { path: '_id', model: 'User', select: 'name email' });
  res.json(rows);
};

exports.salesWeekly = async (req, res) => {
  const { year } = req.query;
  const y = parseInt(year) || new Date().getFullYear();
  const start = new Date(y, 0, 1);
  const end = new Date(y, 11, 31, 23, 59, 59);
  const rows = await Sale.aggregate([
    { $match: { clinic: req.clinicId, status: 'completada', createdAt: { $gte: start, $lte: end } } },
    { $group: { _id: { week: { $isoWeek: '$createdAt' }, year: { $isoWeekYear: '$createdAt' } }, count: { $sum: 1 }, total: { $sum: '$total' } } },
    { $sort: { '_id.year': 1, '_id.week': 1 } },
  ]);
  res.json(rows);
};

exports.costOfSales = async (req, res) => {
  const { startDate, endDate } = req.query;
  const match = { clinic: req.clinicId, status: 'completada' };
  if (startDate || endDate) {
    match.createdAt = {};
    if (startDate) match.createdAt.$gte = new Date(startDate);
    if (endDate) match.createdAt.$lte = new Date(endDate);
  }
  const sales = await Sale.find(match).populate('items.product', 'purchasePrice');
  let cost = 0;
  for (const s of sales) {
    for (const it of s.items) {
      const pcost = it.product?.purchasePrice || 0;
      cost += pcost * it.quantity;
    }
  }
  const totalSales = sales.reduce((s, v) => s + v.total, 0);
  res.json({ totalSales, totalCost: cost, grossProfit: totalSales - cost });
};

// ---------- Gestión ----------
exports.nonDeductibleExpenses = async (req, res) => {
  const { startDate, endDate } = req.query;
  const accs = await ChartOfAccount.find({ clinic: req.clinicId, code: /^6\.3\./ });
  const ids = accs.map((a) => a._id);
  const match = { clinic: req.clinicId, status: 'CONTABILIZADO', 'lines.account': { $in: ids } };
  if (startDate || endDate) {
    match.date = {};
    if (startDate) match.date.$gte = new Date(startDate);
    if (endDate) match.date.$lte = new Date(endDate);
  }
  const agg = await JournalEntry.aggregate([
    { $match: match }, { $unwind: '$lines' },
    { $match: { 'lines.account': { $in: ids } } },
    { $group: { _id: '$lines.account', debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
  ]);
  const map = new Map(accs.map((a) => [String(a._id), a]));
  const rows = agg.map((r) => ({ account: map.get(String(r._id)), amount: r.debit - r.credit }));
  const total = rows.reduce((s, r) => s + r.amount, 0);
  res.json({ rows, total });
};

// Cartera por edad: separa documentos vencidos por rangos
function bucket(days) {
  if (days <= 0) return 'POR_VENCER';
  if (days <= 30) return 'VENCIDO_30';
  if (days <= 60) return 'VENCIDO_60';
  if (days <= 90) return 'VENCIDO_90';
  if (days <= 120) return 'VENCIDO_120';
  return 'VENCIDO_MAS_120';
}

exports.accountsReceivableAging = async (req, res) => {
  try {
    const today = new Date();
    // Aplica a facturas de venta autorizadas con saldo pendiente (saldo = total - cobros aplicados)
    const invoices = await Invoice.find({ clinic: req.clinicId, estado: 'AUTORIZADO' });
    const paymentApps = await Payment.aggregate([
      { $match: { clinic: req.clinicId, type: 'COBRO', status: 'REGISTRADO' } },
      { $unwind: '$applications' },
      { $match: { 'applications.docModel': 'Invoice' } },
      { $group: { _id: '$applications.docRef', paid: { $sum: '$applications.amount' } } },
    ]);
    const paidMap = new Map(paymentApps.map((p) => [String(p._id), p.paid]));
    const rows = [];
    for (const inv of invoices) {
      const paid = paidMap.get(String(inv._id)) || 0;
      const balance = (inv.importeTotal || inv.total || 0) - paid;
      if (balance <= 0.01) continue;
      const emitido = new Date(inv.fechaEmision.split('/').reverse().join('-'));
      const days = Math.floor((today - emitido) / (1000 * 60 * 60 * 24)) - 30; // crédito 30 días por defecto
      rows.push({
        docId: inv._id, type: 'Factura', number: `${inv.estab}-${inv.ptoEmi}-${inv.secuencial}`,
        client: inv.razonSocialComprador, date: inv.fechaEmision,
        total: inv.importeTotal || inv.total, paid, balance, days,
        bucket: bucket(days),
      });
    }
    const totals = rows.reduce((acc, r) => { acc[r.bucket] = (acc[r.bucket] || 0) + r.balance; acc.total += r.balance; return acc; }, { total: 0 });
    res.json({ rows, totals });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.accountsPayableAging = async (req, res) => {
  try {
    const today = new Date();
    const invoices = await PurchaseInvoice.find({ clinic: req.clinicId, status: 'REGISTRADA' });
    const paymentApps = await Payment.aggregate([
      { $match: { clinic: req.clinicId, type: 'PAGO', status: 'REGISTRADO' } },
      { $unwind: '$applications' },
      { $match: { 'applications.docModel': 'PurchaseInvoice' } },
      { $group: { _id: '$applications.docRef', paid: { $sum: '$applications.amount' } } },
    ]);
    const paidMap = new Map(paymentApps.map((p) => [String(p._id), p.paid]));
    const rows = [];
    for (const inv of invoices) {
      const paid = paidMap.get(String(inv._id)) || 0;
      const balance = inv.balance - paid;
      if (balance <= 0.01) continue;
      const dueDate = inv.fechaVencimiento || new Date(inv.fechaEmision.getTime() + 30 * 86400000);
      const days = Math.floor((today - dueDate) / (1000 * 60 * 60 * 24));
      rows.push({
        docId: inv._id, type: 'Compra', number: inv.serie,
        supplier: inv.supplier, date: inv.fechaEmision, total: inv.total, paid, balance, days,
        bucket: bucket(days),
      });
    }
    const totals = rows.reduce((acc, r) => { acc[r.bucket] = (acc[r.bucket] || 0) + r.balance; acc.total += r.balance; return acc; }, { total: 0 });
    res.json({ rows, totals });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.advancesControl = async (req, res) => {
  // Saldo de cuentas Anticipos a proveedores y Anticipos de clientes
  const codes = ['1.1.02.03', '2.1.01.03'];
  const accs = await ChartOfAccount.find({ clinic: req.clinicId, code: { $in: codes } });
  const ids = accs.map((a) => a._id);
  const agg = await JournalEntry.aggregate([
    { $match: { clinic: req.clinicId, status: 'CONTABILIZADO', 'lines.account': { $in: ids } } },
    { $unwind: '$lines' },
    { $match: { 'lines.account': { $in: ids } } },
    { $group: { _id: '$lines.account', debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
  ]);
  const rows = agg.map((r) => {
    const acc = accs.find((a) => String(a._id) === String(r._id));
    return { code: acc.code, name: acc.name, debit: r.debit, credit: r.credit, saldo: acc.nature === 'DEBITO' ? r.debit - r.credit : r.credit - r.debit };
  });
  res.json(rows);
};

exports.inventoryReport = async (req, res) => {
  const products = await Product.find({ clinic: req.clinicId, active: true });
  const rows = products.map((p) => ({
    code: p.code, name: p.name, category: p.category,
    stock: p.stock || 0, purchasePrice: p.purchasePrice || 0,
    salePrice: p.salePrice || 0,
    valueAtCost: (p.stock || 0) * (p.purchasePrice || 0),
    valueAtSale: (p.stock || 0) * (p.salePrice || 0),
  }));
  const totals = rows.reduce((acc, r) => ({
    valueAtCost: acc.valueAtCost + r.valueAtCost,
    valueAtSale: acc.valueAtSale + r.valueAtSale,
    units: acc.units + r.stock,
  }), { valueAtCost: 0, valueAtSale: 0, units: 0 });
  res.json({ rows, totals });
};

// ---------- Reportes SRI ----------
exports.purchaseSalesList = async (req, res) => {
  const { year, month } = req.query;
  const y = parseInt(year) || new Date().getFullYear();
  const m = parseInt(month) || (new Date().getMonth() + 1);
  const start = new Date(y, m - 1, 1);
  const end = new Date(y, m, 0, 23, 59, 59);
  const ventas = await Invoice.find({ clinic: req.clinicId, estado: 'AUTORIZADO',
    createdAt: { $gte: start, $lte: end } });
  const compras = await PurchaseInvoice.find({ clinic: req.clinicId, status: { $ne: 'ANULADA' },
    fechaEmision: { $gte: start, $lte: end } }).populate('supplier', 'ruc razonSocial');
  res.json({ ventas, compras });
};

/** Formulario 104 - IVA mensual (resumen para llenado). */
exports.form104 = async (req, res) => {
  try {
    const { year, month } = req.query;
    const y = parseInt(year), m = parseInt(month);
    const start = new Date(y, m - 1, 1);
    const end = new Date(y, m, 0, 23, 59, 59);

    const ventas = await Invoice.find({ clinic: req.clinicId, estado: 'AUTORIZADO',
      createdAt: { $gte: start, $lte: end } });
    const v = ventas.reduce((acc, i) => {
      acc.base += i.totalSinImpuestos || 0;
      acc.iva += i.totalImpuesto || 0;
      return acc;
    }, { base: 0, iva: 0 });

    const compras = await PurchaseInvoice.find({ clinic: req.clinicId, status: { $ne: 'ANULADA' },
      fechaEmision: { $gte: start, $lte: end } });
    const c = compras.reduce((acc, p) => {
      acc.base += p.subtotal || 0;
      acc.iva += p.iva || 0;
      acc.retIVA += (p.retentions || []).filter((r) => r.type === 'IVA').reduce((s, r) => s + (r.amount || 0), 0);
      return acc;
    }, { base: 0, iva: 0, retIVA: 0 });

    res.json({
      periodo: `${y}-${String(m).padStart(2, '0')}`,
      ventas: v, compras: c,
      ivaPorPagar: +(v.iva - c.iva - c.retIVA).toFixed(2),
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

/** Formulario 103 - Retenciones en la fuente. */
exports.form103 = async (req, res) => {
  try {
    const { year, month } = req.query;
    const y = parseInt(year), m = parseInt(month);
    const start = new Date(y, m - 1, 1);
    const end = new Date(y, m, 0, 23, 59, 59);
    const compras = await PurchaseInvoice.find({ clinic: req.clinicId, status: { $ne: 'ANULADA' },
      fechaEmision: { $gte: start, $lte: end } });
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
    res.json({ periodo: `${y}-${String(m).padStart(2, '0')}`, rows: Object.values(byCode), total: Object.values(byCode).reduce((s, r) => s + r.amount, 0) });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

/**
 * ATS - Anexo Transaccional Simplificado.
 * Genera XML simplificado (estructura básica del SRI v2.0.0).
 */
exports.ats = async (req, res) => {
  try {
    const { year, month } = req.query;
    const y = parseInt(year), m = parseInt(month);
    const start = new Date(y, m - 1, 1);
    const end = new Date(y, m, 0, 23, 59, 59);
    const Clinic = require('../models/Clinic');
    const clinic = await Clinic.findById(req.clinicId);
    const ventas = await Invoice.find({ clinic: req.clinicId, estado: 'AUTORIZADO', createdAt: { $gte: start, $lte: end } });
    const compras = await PurchaseInvoice.find({ clinic: req.clinicId, status: { $ne: 'ANULADA' }, fechaEmision: { $gte: start, $lte: end } }).populate('supplier');

    const esc = (s) => String(s || '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<iva>\n';
    xml += `  <TipoIDInformante>R</TipoIDInformante>\n`;
    xml += `  <IdInformante>${esc(clinic?.ruc)}</IdInformante>\n`;
    xml += `  <razonSocial>${esc(clinic?.razonSocial || clinic?.name)}</razonSocial>\n`;
    xml += `  <Anio>${y}</Anio>\n  <Mes>${String(m).padStart(2, '0')}</Mes>\n`;

    // Compras
    xml += '  <compras>\n';
    for (const c of compras) {
      xml += '    <detalleCompras>\n';
      xml += `      <codSustento>01</codSustento>\n`;
      xml += `      <tpIdProv>${c.supplier?.tipoIdentificacion === 'CEDULA' ? '02' : '01'}</tpIdProv>\n`;
      xml += `      <idProv>${esc(c.supplier?.ruc)}</idProv>\n`;
      xml += `      <tipoComprobante>${c.docType === 'NOTA_CREDITO_REC' ? '04' : '01'}</tipoComprobante>\n`;
      xml += `      <fechaRegistro>${c.fechaEmision.toISOString().slice(0, 10).split('-').reverse().join('/')}</fechaRegistro>\n`;
      xml += `      <establecimiento>${esc(c.estab || '001')}</establecimiento>\n`;
      xml += `      <puntoEmision>${esc(c.ptoEmi || '001')}</puntoEmision>\n`;
      xml += `      <secuencial>${esc(c.secuencial || '')}</secuencial>\n`;
      xml += `      <autorizacion>${esc(c.autorizacion || '')}</autorizacion>\n`;
      xml += `      <baseNoGraIva>${(c.subtotalNoObjeto || 0).toFixed(2)}</baseNoGraIva>\n`;
      xml += `      <baseImponible>${(c.subtotal0 || 0).toFixed(2)}</baseImponible>\n`;
      xml += `      <baseImpGrav>${((c.subtotal12 || 0) + (c.subtotal15 || 0)).toFixed(2)}</baseImpGrav>\n`;
      xml += `      <montoIva>${(c.iva || 0).toFixed(2)}</montoIva>\n`;
      xml += `      <total>${(c.total || 0).toFixed(2)}</total>\n`;
      xml += '    </detalleCompras>\n';
    }
    xml += '  </compras>\n';

    // Ventas (agrupadas por cliente)
    const byClient = {};
    for (const v of ventas) {
      const k = v.identificacionComprador || '9999999999999';
      if (!byClient[k]) byClient[k] = { ...v.toObject(), base: 0, iva: 0, total: 0, count: 0 };
      byClient[k].base += v.totalSinImpuestos || 0;
      byClient[k].iva += v.totalImpuesto || 0;
      byClient[k].total += v.importeTotal || 0;
      byClient[k].count += 1;
    }
    xml += '  <ventas>\n';
    for (const v of Object.values(byClient)) {
      xml += '    <detalleVentas>\n';
      xml += `      <tpIdCliente>${v.tipoIdentificacionComprador === '04' ? '01' : '02'}</tpIdCliente>\n`;
      xml += `      <idCliente>${esc(v.identificacionComprador)}</idCliente>\n`;
      xml += `      <tipoComprobante>18</tipoComprobante>\n`;
      xml += `      <numeroComprobantes>${v.count}</numeroComprobantes>\n`;
      xml += `      <baseImponible>0.00</baseImponible>\n`;
      xml += `      <baseImpGrav>${v.base.toFixed(2)}</baseImpGrav>\n`;
      xml += `      <montoIva>${v.iva.toFixed(2)}</montoIva>\n`;
      xml += `      <valorRetIva>0.00</valorRetIva>\n`;
      xml += `      <valorRetRenta>0.00</valorRetRenta>\n`;
      xml += '    </detalleVentas>\n';
    }
    xml += '  </ventas>\n';
    xml += '</iva>\n';
    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', `attachment; filename="ATS-${y}-${String(m).padStart(2, '0')}.xml"`);
    res.send(xml);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};
