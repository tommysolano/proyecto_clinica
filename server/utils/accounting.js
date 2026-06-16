const mongoose = require('mongoose');
const ChartOfAccount = require('../models/ChartOfAccount');
const FiscalPeriod = require('../models/FiscalPeriod');
const JournalEntry = require('../models/JournalEntry');
const Counter = require('../models/Counter');
const AccountBalance = require('../models/AccountBalance');
const defaultPlan = require('./defaultChartOfAccounts');

function withSession(query, session) {
  return session ? query.session(session) : query;
}

function createWithSession(Model, doc, session) {
  return Model.create([doc], session ? { session } : {}).then((docs) => docs[0]);
}

async function runInTransaction(work, { session } = {}) {
  if (session) return work(session);
  const ownSession = await mongoose.startSession();
  try {
    let result;
    await ownSession.withTransaction(async () => {
      result = await work(ownSession);
    });
    return result;
  } finally {
    await ownSession.endSession();
  }
}

async function applyToBalances(clinicId, date, lines, sign = 1, options = {}) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const ops = (lines || [])
    .filter((l) => l.account)
    .map((l) => ({
      updateOne: {
        filter: { clinic: clinicId, account: l.account, year, month },
        update: {
          $inc: {
            debit: sign * (Number(l.debit) || 0),
            credit: sign * (Number(l.credit) || 0),
          },
        },
        upsert: true,
      },
    }));
  if (ops.length) await AccountBalance.bulkWrite(ops, options.session ? { session: options.session } : {});
}

async function getOrCreatePeriod(clinicId, date = new Date(), options = {}) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  let period = await withSession(FiscalPeriod.findOne({ clinic: clinicId, year, month }), options.session);
  if (period) return period;

  try {
    period = await createWithSession(FiscalPeriod, { clinic: clinicId, year, month, status: 'ABIERTO' }, options.session);
  } catch (e) {
    if (e.code !== 11000) throw e;
    period = await withSession(FiscalPeriod.findOne({ clinic: clinicId, year, month }), options.session);
  }
  return period;
}

async function assertPeriodOpen(clinicId, date, options = {}) {
  const period = await getOrCreatePeriod(clinicId, date, options);
  if (period.status !== 'ABIERTO') {
    const err = new Error(`Periodo ${period.year}-${String(period.month).padStart(2, '0')} no esta abierto`);
    err.status = 400;
    throw err;
  }
  return period;
}

async function seedChartOfAccounts(clinicId, options = {}) {
  const existingDocs = await withSession(ChartOfAccount.find({ clinic: clinicId }).select('code'), options.session);
  const existingCodes = new Set(existingDocs.map((d) => d.code));
  const missing = defaultPlan.filter((a) => !existingCodes.has(a.code));
  if (!missing.length) return { created: 0, skipped: existingCodes.size };

  const docs = missing.map((a) => ({
    clinic: clinicId,
    code: a.code,
    name: a.name,
    type: a.type,
    nature: a.nature,
    allowsMovement: a.allowsMovement !== false,
    taxCode: a.taxCode || null,
    level: a.code.split('.').length,
    isSystem: true,
  }));
  const created = await ChartOfAccount.insertMany(docs, options.session ? { session: options.session } : {});
  const all = await withSession(ChartOfAccount.find({ clinic: clinicId }).select('code'), options.session);
  const byCode = new Map(all.map((c) => [c.code, c._id]));
  const updates = [];
  for (const c of created) {
    const parts = c.code.split('.');
    if (parts.length > 1) {
      const parentId = byCode.get(parts.slice(0, -1).join('.'));
      if (parentId) updates.push({ updateOne: { filter: { _id: c._id }, update: { parent: parentId } } });
    }
  }
  if (updates.length) await ChartOfAccount.bulkWrite(updates, options.session ? { session: options.session } : {});
  return { created: created.length, skipped: existingCodes.size };
}

async function ensureAccountByCode(clinicId, code, options = {}) {
  let acc = await withSession(ChartOfAccount.findOne({ clinic: clinicId, code }), options.session);
  if (acc) return acc;

  const def = defaultPlan.find((a) => a.code === code);
  if (!def) return null;

  const parts = code.split('.');
  let parentId = null;
  if (parts.length > 1) {
    const parentCode = parts.slice(0, -1).join('.');
    const parent = (await withSession(ChartOfAccount.findOne({ clinic: clinicId, code: parentCode }), options.session))
      || (await ensureAccountByCode(clinicId, parentCode, options));
    parentId = parent?._id || null;
  }

  try {
    acc = await createWithSession(ChartOfAccount, {
      clinic: clinicId,
      code: def.code,
      name: def.name,
      type: def.type,
      nature: def.nature,
      allowsMovement: def.allowsMovement !== false,
      taxCode: def.taxCode || null,
      level: parts.length,
      parent: parentId,
      isSystem: true,
    }, options.session);
    return acc;
  } catch (e) {
    if (e.code === 11000) return withSession(ChartOfAccount.findOne({ clinic: clinicId, code }), options.session);
    throw e;
  }
}

async function findAccount(clinicId, { code, taxCode }, options = {}) {
  const q = { clinic: clinicId };
  if (taxCode) q.taxCode = taxCode;
  else if (code) q.code = code;
  const acc = await withSession(ChartOfAccount.findOne(q), options.session);
  if (!acc) {
    const err = new Error(`Cuenta contable no encontrada: ${code || taxCode}`);
    err.status = 400;
    throw err;
  }
  return acc;
}

async function nextEntryNumber(clinicId, date = new Date(), options = {}) {
  const year = new Date(date).getFullYear();
  const key = `journal-${year}`;
  const prefix = `AS-${year}-`;
  let counter = await withSession(Counter.findOne({ clinic: clinicId, key }), options.session);
  if (!counter) {
    const last = await withSession(
      JournalEntry.findOne({ clinic: clinicId, number: new RegExp(`^${prefix}`) })
        .sort({ number: -1 })
        .select('number'),
      options.session
    );
    let start = 0;
    if (last) {
      const m = last.number.match(/(\d+)$/);
      if (m) start = parseInt(m[1], 10);
    }
    try {
      await createWithSession(Counter, { clinic: clinicId, key, seq: start }, options.session);
    } catch (e) {
      if (e.code !== 11000) throw e;
    }
  }
  const updated = await withSession(
    Counter.findOneAndUpdate(
      { clinic: clinicId, key },
      { $inc: { seq: 1 } },
      { new: true, upsert: true }
    ),
    options.session
  );
  return `${prefix}${String(updated.seq).padStart(6, '0')}`;
}

async function resolveEntryLines(clinicId, lines, options = {}) {
  if (!Array.isArray(lines) || lines.length < 2) {
    const err = new Error('El asiento debe tener al menos 2 lineas');
    err.status = 400;
    throw err;
  }

  const resolved = [];
  for (const l of lines) {
    let acc = null;
    if (l.account) {
      acc = await withSession(ChartOfAccount.findOne({ _id: l.account, clinic: clinicId }), options.session);
    } else if (l.accountCode) {
      acc = await withSession(ChartOfAccount.findOne({ code: l.accountCode, clinic: clinicId }), options.session);
    }
    if (!acc) {
      const err = new Error(`Cuenta no encontrada: ${l.accountCode || l.account}`);
      err.status = 400;
      throw err;
    }
    if (!acc.active) {
      const err = new Error(`Cuenta ${acc.code} esta inactiva`);
      err.status = 400;
      throw err;
    }
    if (!acc.allowsMovement) {
      const err = new Error(`Cuenta ${acc.code} no admite movimientos`);
      err.status = 400;
      throw err;
    }

    const debit = +((Number(l.debit) || 0).toFixed(2));
    const credit = +((Number(l.credit) || 0).toFixed(2));
    if (debit < 0 || credit < 0) throw Object.assign(new Error('Importes negativos no permitidos'), { status: 400 });
    if (debit > 0 && credit > 0) throw Object.assign(new Error('Una linea no puede tener debito y credito'), { status: 400 });
    if (debit === 0 && credit === 0) throw Object.assign(new Error('Una linea debe tener debito o credito'), { status: 400 });

    resolved.push({
      account: acc._id,
      accountCode: acc.code,
      accountName: acc.name,
      costCenter: l.costCenter || null,
      description: l.description || '',
      debit,
      credit,
    });
  }

  const totalDebit = +resolved.reduce((s, l) => s + l.debit, 0).toFixed(2);
  const totalCredit = +resolved.reduce((s, l) => s + l.credit, 0).toFixed(2);
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    const err = new Error(`Asiento descuadrado: debito ${totalDebit.toFixed(2)} != credito ${totalCredit.toFixed(2)}`);
    err.status = 400;
    throw err;
  }
  return { resolved, totalDebit, totalCredit };
}

async function findExistingSourceEntry({ clinicId, sourceModel, sourceRef, sourceAction }, options = {}) {
  if (!sourceModel || !sourceRef || !sourceAction) return null;
  return withSession(
    JournalEntry.findOne({
      clinic: clinicId,
      sourceModel,
      sourceRef,
      sourceAction,
      status: 'CONTABILIZADO',
    }),
    options.session
  );
}

async function createEntry({
  clinicId,
  date,
  description,
  source,
  sourceRef,
  sourceModel,
  sourceAction,
  lines,
  userId,
  allowExisting = true,
  session,
}) {
  const entryDate = date ? new Date(date) : new Date();
  const action = sourceModel && sourceRef ? (sourceAction || 'POST') : (sourceAction || null);

  const existing = allowExisting
    ? await findExistingSourceEntry({ clinicId, sourceModel, sourceRef, sourceAction: action }, { session })
    : null;
  if (existing) return existing;

  const period = await assertPeriodOpen(clinicId, entryDate, { session });
  const { resolved, totalDebit, totalCredit } = await resolveEntryLines(clinicId, lines, { session });
  const number = await nextEntryNumber(clinicId, entryDate, { session });

  try {
    const entry = await createWithSession(JournalEntry, {
      clinic: clinicId,
      number,
      date: entryDate,
      period: period._id,
      description: description || '',
      source: source || 'MANUAL',
      sourceRef: sourceRef || null,
      sourceModel: sourceModel || null,
      sourceAction: action,
      lines: resolved,
      totalDebit,
      totalCredit,
      status: 'CONTABILIZADO',
      createdBy: userId || null,
    }, session);
    await applyToBalances(clinicId, entryDate, entry.lines, 1, { session });
    return entry;
  } catch (e) {
    if (e.code === 11000) {
      const duplicated = await findExistingSourceEntry({ clinicId, sourceModel, sourceRef, sourceAction: action }, { session });
      if (duplicated) return duplicated;
    }
    throw e;
  }
}

async function reverseEntry({ clinicId, entryId, userId, reason, date, session }) {
  const reversalDate = date ? new Date(date) : new Date();
  const orig = await withSession(JournalEntry.findOne({ _id: entryId, clinic: clinicId }), session);
  if (!orig) throw Object.assign(new Error('Asiento no encontrado'), { status: 404 });
  if (orig.status !== 'CONTABILIZADO') throw Object.assign(new Error('Solo se reversan asientos contabilizados'), { status: 400 });
  if (orig.isReversed || orig.reversedBy) throw Object.assign(new Error('El asiento ya fue reversado'), { status: 400 });
  if (orig.reverses) throw Object.assign(new Error('No se puede reversar un asiento de reverso'), { status: 400 });

  const inverted = orig.lines.map((l) => ({
    account: l.account,
    costCenter: l.costCenter,
    description: `Reversion: ${l.description || orig.description || orig.number}`,
    debit: l.credit,
    credit: l.debit,
  }));

  const rev = await createEntry({
    clinicId,
    date: reversalDate,
    description: `REVERSO ${orig.number}${reason ? ` - ${reason}` : ''}`,
    source: 'AJUSTE',
    sourceRef: orig._id,
    sourceModel: 'JournalEntry',
    sourceAction: 'REVERSAL',
    lines: inverted,
    userId,
    allowExisting: false,
    session,
  });

  rev.reverses = orig._id;
  rev.reversalReason = reason || '';
  await rev.save({ session });

  orig.isReversed = true;
  orig.reversedBy = rev._id;
  orig.reversedAt = reversalDate;
  orig.reversalReason = reason || '';
  await orig.save({ session });
  return rev;
}

async function recomputeBalances(clinicId, options = {}) {
  await AccountBalance.deleteMany({ clinic: clinicId }).session(options.session || null);
  const clinicObjectId = mongoose.Types.ObjectId.createFromHexString(String(clinicId));
  const agg = await JournalEntry.aggregate([
    { $match: { clinic: clinicObjectId, status: 'CONTABILIZADO' } },
    { $unwind: '$lines' },
    {
      $group: {
        _id: { account: '$lines.account', year: { $year: '$date' }, month: { $month: '$date' } },
        debit: { $sum: '$lines.debit' },
        credit: { $sum: '$lines.credit' },
      },
    },
  ]).session(options.session || null);
  const docs = agg.map((r) => ({
    clinic: clinicId,
    account: r._id.account,
    year: r._id.year,
    month: r._id.month,
    debit: +Number(r.debit || 0).toFixed(2),
    credit: +Number(r.credit || 0).toFixed(2),
  }));
  if (docs.length) await AccountBalance.insertMany(docs, options.session ? { session: options.session } : {});
  return docs.length;
}

module.exports = {
  runInTransaction,
  getOrCreatePeriod,
  assertPeriodOpen,
  seedChartOfAccounts,
  ensureAccountByCode,
  findAccount,
  createEntry,
  reverseEntry,
  nextEntryNumber,
  applyToBalances,
  recomputeBalances,
  resolveEntryLines,
};
