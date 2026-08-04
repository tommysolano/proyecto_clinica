const ExcelJS = require('exceljs');
const Receivable = require('../models/Receivable');
const Payable = require('../models/Payable');

function modelForSide(side) {
  return side === 'AP' ? Payable : Receivable;
}

function round2(n) {
  return +Number(n || 0).toFixed(2);
}

/** Fecha de corte del aging (por defecto ahora). Un solo parser para pantalla y Excel. */
function parseAsOf(req) {
  return req.query.asOf ? new Date(req.query.asOf) : new Date();
}

/**
 * Busca el nombre TAL CUAL se escribió: sin escapar, un cliente con paréntesis, punto o '+'
 * en el nombre cambiaba lo que se buscaba (o rompía la expresión). Lo usa también el modal de
 * cobro, que busca la cartera de Consumidor Final por nombre porque no tiene paciente.
 */
const escaparRegex = (v) => String(v).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Filtro de la vista por DOCUMENTOS (misma para /subledger y el Excel):
 * status (sin ANULADO por defecto), contraparte (ref exacta o nombre) y rango de emisión.
 */
function buildListFilter(req) {
  const filter = { clinic: req.clinicId };
  if (req.query.status) filter.status = req.query.status;
  else filter.status = { $ne: 'ANULADO' };
  if (req.query.partyRef) filter['party.ref'] = req.query.partyRef;
  if (req.query.q) filter['party.name'] = { $regex: escaparRegex(req.query.q), $options: 'i' };
  if (req.query.from || req.query.to) {
    filter.issueDate = {};
    if (req.query.from) filter.issueDate.$gte = new Date(req.query.from);
    if (req.query.to) filter.issueDate.$lte = new Date(req.query.to);
  }
  return filter;
}

/** Filtro de la vista por ANTIGÜEDAD: solo saldos abiertos, misma contraparte opcional. */
function buildAgingFilter(req) {
  const filter = { clinic: req.clinicId, status: { $in: ['ABIERTO', 'PARCIAL'] } };
  if (req.query.partyRef) filter['party.ref'] = req.query.partyRef;
  if (req.query.q) filter['party.name'] = { $regex: escaparRegex(req.query.q), $options: 'i' };
  return filter;
}

/** Días de mora de un documento a la fecha de corte (negativo si aún no vence). */
function overdueDays(doc, asOf) {
  const base = doc.dueDate || doc.issueDate;
  return Math.floor((asOf - new Date(base)) / 86400000);
}

/** Tramo de antigüedad de un número de días de mora. */
function bucketOf(days) {
  if (days <= 0) return 'current';
  if (days <= 30) return 'd30';
  if (days <= 60) return 'd60';
  if (days <= 90) return 'd90';
  return 'd90plus';
}

/**
 * Aging por contraparte a partir de los documentos abiertos. ÚNICA fórmula: la usan el
 * endpoint de pantalla y el Excel, así que los tramos y totales no pueden discrepar.
 */
function agingFromDocs(docs, asOf) {
  const byParty = new Map();
  const totals = { current: 0, d30: 0, d60: 0, d90: 0, d90plus: 0, total: 0 };
  for (const d of docs) {
    const ref = String(d.party?.ref || d._id);
    if (!byParty.has(ref)) {
      byParty.set(ref, {
        partyRef: d.party?.ref || null,
        partyName: d.party?.name || '—',
        current: 0, d30: 0, d60: 0, d90: 0, d90plus: 0, total: 0,
      });
    }
    const row = byParty.get(ref);
    const bucket = bucketOf(overdueDays(d, asOf));
    const bal = round2(d.balance);
    row[bucket] = round2(row[bucket] + bal);
    row.total = round2(row.total + bal);
    totals[bucket] = round2(totals[bucket] + bal);
    totals.total = round2(totals.total + bal);
  }
  return { rows: [...byParty.values()], totals };
}

/**
 * Lista documentos de cartera (CxC por defecto, o CxP con ?side=AP).
 * Filtros: status, partyRef/q, desde/hasta (issueDate).
 */
exports.list = async (req, res) => {
  try {
    const Model = modelForSide(req.query.side);
    const docs = await Model.find(buildListFilter(req)).sort({ issueDate: -1 }).limit(2000);
    res.json(docs);
  } catch (e) {
    res.status(500).json({ message: 'Error al listar cartera', error: e.message });
  }
};

/**
 * Aging (antigüedad de saldos) por contraparte, en tramos por vencer, 1-30, 31-60, 61-90, +90.
 * Considera la fecha de vencimiento (o de emisión si no hay vencimiento) contra la de corte.
 */
exports.aging = async (req, res) => {
  try {
    const Model = modelForSide(req.query.side);
    const asOf = parseAsOf(req);
    const docs = await Model.find(buildAgingFilter(req));
    const { rows, totals } = agingFromDocs(docs, asOf);
    res.json({ asOf, side: req.query.side === 'AP' ? 'AP' : 'AR', rows, totals });
  } catch (e) {
    res.status(500).json({ message: 'Error al calcular aging', error: e.message });
  }
};

/**
 * Estado de cuenta de una contraparte: documentos y saldo corriente.
 */
exports.statement = async (req, res) => {
  try {
    const Model = modelForSide(req.query.side);
    if (!req.query.partyRef) return res.status(400).json({ message: 'partyRef requerido' });
    const docs = await Model.find({
      clinic: req.clinicId,
      'party.ref': req.query.partyRef,
      status: { $ne: 'ANULADO' },
    }).sort({ issueDate: 1 });
    let running = 0;
    const rows = docs.map((d) => {
      running = round2(running + d.balance);
      return {
        id: d._id,
        date: d.issueDate,
        dueDate: d.dueDate,
        docType: d.docType,
        number: d.number,
        total: d.total,
        applied: d.applied,
        balance: d.balance,
        status: d.status,
        runningBalance: running,
      };
    });
    const outstanding = round2(rows.reduce((s, r) => s + r.balance, 0));
    res.json({ partyRef: req.query.partyRef, outstanding, rows });
  } catch (e) {
    res.status(500).json({ message: 'Error al generar estado de cuenta', error: e.message });
  }
};

// ═══════════════════════════ EXCEL ═══════════════════════════

const MONEY = '"$"#,##0.00';
const HDR = 'FF1F2937';
const fmtDate = (d) => {
  if (!d) return '';
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return '';
  return `${String(x.getDate()).padStart(2, '0')}/${String(x.getMonth() + 1).padStart(2, '0')}/${x.getFullYear()}`;
};

/**
 * Descarga a Excel de la cartera, en las DOS vistas que muestra la pantalla.
 * Reutiliza EXACTAMENTE la misma fuente y fórmula (buildListFilter / buildAgingFilter /
 * agingFromDocs) que los endpoints de pantalla: los tramos, el corte y los totales cuadran
 * por construcción. Respeta los filtros: side, view, asOf (corte), partyRef/q y from/to.
 *
 * GET /subledger/export.xlsx?side=AR|AP&view=aging|documents&asOf=&q=&from=&to=
 */
exports.exportExcel = async (req, res) => {
  try {
    const side = req.query.side === 'AP' ? 'AP' : 'AR';
    const Model = modelForSide(side);
    const view = req.query.view === 'documents' ? 'documents' : 'aging';
    const asOf = parseAsOf(req);
    const partyLabel = side === 'AP' ? 'Proveedor' : 'Cliente';
    const titleSide = side === 'AP' ? 'CUENTAS POR PAGAR' : 'CUENTAS POR COBRAR';

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Sistema clínico';

    const styleHeader = (row) => {
      row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      row.eachCell((c) => {
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HDR } };
        c.alignment = { horizontal: 'center', vertical: 'middle' };
      });
    };

    if (view === 'aging') {
      const docs = await Model.find(buildAgingFilter(req));
      const { rows, totals } = agingFromDocs(docs, asOf);

      const ws = wb.addWorksheet('Antigüedad', { views: [{ state: 'frozen', ySplit: 3 }] });
      ws.getColumn(1).width = 36;
      for (let i = 2; i <= 7; i += 1) ws.getColumn(i).width = 14;

      const titulo = ws.addRow([`${titleSide} — Antigüedad de saldos al ${fmtDate(asOf)}`]);
      titulo.font = { bold: true, size: 13 };
      ws.mergeCells(1, 1, 1, 7);
      ws.addRow([]);
      const head = ws.addRow([partyLabel, 'Por vencer', '1-30', '31-60', '61-90', '+90', 'Total']);
      styleHeader(head);

      for (const r of rows) {
        const row = ws.addRow([r.partyName, r.current, r.d30, r.d60, r.d90, r.d90plus, r.total]);
        for (let i = 2; i <= 7; i += 1) row.getCell(i).numFmt = MONEY;
        row.getCell(7).font = { bold: true };
      }
      if (!rows.length) ws.addRow(['Sin saldos pendientes']);

      const tot = ws.addRow(['TOTAL', totals.current, totals.d30, totals.d60, totals.d90, totals.d90plus, totals.total]);
      tot.font = { bold: true };
      tot.eachCell((c, i) => {
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
        if (i >= 2) c.numFmt = MONEY;
      });
    } else {
      const docs = await Model.find(buildListFilter(req)).sort({ issueDate: -1 }).limit(5000);

      const ws = wb.addWorksheet('Documentos', { views: [{ state: 'frozen', ySplit: 3 }] });
      const widths = [30, 18, 14, 14, 12, 16, 16, 16];
      widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

      const titulo = ws.addRow([`${titleSide} — Documentos al ${fmtDate(asOf)}`]);
      titulo.font = { bold: true, size: 13 };
      ws.mergeCells(1, 1, 1, 8);
      ws.addRow([]);
      const head = ws.addRow([
        partyLabel, 'Número', 'Emisión', 'Vencimiento', 'Días vencidos', 'Valor original', 'Abonos', 'Saldo pendiente',
      ]);
      styleHeader(head);

      let totOriginal = 0;
      let totAbonos = 0;
      let totSaldo = 0;
      for (const d of docs) {
        const dias = Math.max(0, overdueDays(d, asOf));
        totOriginal = round2(totOriginal + Number(d.total || 0));
        totAbonos = round2(totAbonos + Number(d.applied || 0));
        totSaldo = round2(totSaldo + Number(d.balance || 0));
        const row = ws.addRow([
          d.party?.name || '—',
          d.number || '',
          fmtDate(d.issueDate),
          d.dueDate ? fmtDate(d.dueDate) : '',
          dias,
          round2(d.total),
          round2(d.applied),
          round2(d.balance),
        ]);
        [6, 7, 8].forEach((i) => { row.getCell(i).numFmt = MONEY; });
        row.getCell(8).font = { bold: true };
      }
      if (!docs.length) ws.addRow(['Sin documentos']);

      const tot = ws.addRow(['TOTAL', '', '', '', '', totOriginal, totAbonos, totSaldo]);
      tot.font = { bold: true };
      tot.eachCell((c, i) => {
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
        if (i >= 6) c.numFmt = MONEY;
      });
    }

    const nombre = `${side === 'AP' ? 'cuentas_por_pagar' : 'cuentas_por_cobrar'}_${view}_${Date.now()}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
    const buffer = await wb.xlsx.writeBuffer();
    res.send(Buffer.from(buffer));
  } catch (e) {
    res.status(500).json({ message: 'Error al exportar cartera', error: e.message });
  }
};
