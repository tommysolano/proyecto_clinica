const Receivable = require('../models/Receivable');
const Payable = require('../models/Payable');

function modelForSide(side) {
  return side === 'AP' ? Payable : Receivable;
}

function round2(n) {
  return +Number(n || 0).toFixed(2);
}

/**
 * Lista documentos de cartera (CxC por defecto, o CxP con ?side=AP).
 * Filtros: status, partyRef, desde/hasta (issueDate).
 */
exports.list = async (req, res) => {
  try {
    const Model = modelForSide(req.query.side);
    const filter = { clinic: req.clinicId };
    if (req.query.status) filter.status = req.query.status;
    else filter.status = { $ne: 'ANULADO' };
    if (req.query.partyRef) filter['party.ref'] = req.query.partyRef;
    if (req.query.from || req.query.to) {
      filter.issueDate = {};
      if (req.query.from) filter.issueDate.$gte = new Date(req.query.from);
      if (req.query.to) filter.issueDate.$lte = new Date(req.query.to);
    }
    const docs = await Model.find(filter).sort({ issueDate: -1 }).limit(2000);
    res.json(docs);
  } catch (e) {
    res.status(500).json({ message: 'Error al listar cartera', error: e.message });
  }
};

/**
 * Aging (antigüedad de saldos) por contraparte, en tramos 0-30, 31-60, 61-90, 90+.
 * Considera la fecha de vencimiento (o de emisión si no hay vencimiento).
 */
exports.aging = async (req, res) => {
  try {
    const Model = modelForSide(req.query.side);
    const asOf = req.query.asOf ? new Date(req.query.asOf) : new Date();
    const docs = await Model.find({
      clinic: req.clinicId,
      status: { $in: ['ABIERTO', 'PARCIAL'] },
    });
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
      const base = d.dueDate || d.issueDate;
      const days = Math.floor((asOf - new Date(base)) / 86400000);
      const bal = round2(d.balance);
      let bucket;
      if (days <= 0) bucket = 'current';
      else if (days <= 30) bucket = 'd30';
      else if (days <= 60) bucket = 'd60';
      else if (days <= 90) bucket = 'd90';
      else bucket = 'd90plus';
      row[bucket] = round2(row[bucket] + bal);
      row.total = round2(row.total + bal);
      totals[bucket] = round2(totals[bucket] + bal);
      totals.total = round2(totals.total + bal);
    }
    res.json({ asOf, side: req.query.side === 'AP' ? 'AP' : 'AR', rows: [...byParty.values()], totals });
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
