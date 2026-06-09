const ChartOfAccount = require('../models/ChartOfAccount');
const FiscalPeriod = require('../models/FiscalPeriod');
const JournalEntry = require('../models/JournalEntry');
const Counter = require('../models/Counter');
const AccountBalance = require('../models/AccountBalance');
const defaultPlan = require('./defaultChartOfAccounts');

/**
 * Aplica los movimientos de un asiento a los saldos materializados por período.
 * sign = +1 al contabilizar, -1 si se necesitara revertir el efecto.
 */
async function applyToBalances(clinicId, date, lines, sign = 1) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const ops = (lines || [])
    .filter((l) => l.account)
    .map((l) => ({
      updateOne: {
        filter: { clinic: clinicId, account: l.account, year, month },
        update: { $inc: { debit: sign * (Number(l.debit) || 0), credit: sign * (Number(l.credit) || 0) } },
        upsert: true,
      },
    }));
  if (ops.length) {
    try { await AccountBalance.bulkWrite(ops); } catch (e) { /* no bloquear el asiento por el cache de saldos */ }
  }
}

/**
 * Obtiene/crea el período fiscal correspondiente a la fecha indicada.
 * No reabre períodos cerrados; en ese caso retorna el existente.
 */
async function getOrCreatePeriod(clinicId, date = new Date()) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  let p = await FiscalPeriod.findOne({ clinic: clinicId, year, month });
  if (!p) {
    p = await FiscalPeriod.create({ clinic: clinicId, year, month, status: 'ABIERTO' });
  }
  return p;
}

/** Garantiza que el período asociado a la fecha esté ABIERTO. */
async function assertPeriodOpen(clinicId, date) {
  const p = await getOrCreatePeriod(clinicId, date);
  if (p.status !== 'ABIERTO') {
    const err = new Error(`Período ${p.year}-${String(p.month).padStart(2, '0')} no está abierto`);
    err.status = 400;
    throw err;
  }
  return p;
}

/**
 * Crea/actualiza el plan de cuentas por defecto para una clínica.
 * Es idempotente y *aditivo*: si la clínica ya tiene cuentas, solo agrega las
 * que falten del plan estándar (por código) sin tocar las existentes. Esto
 * permite incorporar cuentas nuevas del catálogo a clínicas ya creadas.
 */
async function seedChartOfAccounts(clinicId) {
  const existingDocs = await ChartOfAccount.find({ clinic: clinicId }).select('code');
  const existingCodes = new Set(existingDocs.map((d) => d.code));
  const missing = defaultPlan.filter((a) => !existingCodes.has(a.code));
  if (!missing.length) return { created: 0, skipped: existingCodes.size };

  // Crear las cuentas faltantes (sin parent), luego asignar parent por código.
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
  const created = await ChartOfAccount.insertMany(docs);
  // Mapa código→id de TODAS las cuentas (existentes + nuevas) para enlazar padres.
  const all = await ChartOfAccount.find({ clinic: clinicId }).select('code');
  const byCode = new Map(all.map((c) => [c.code, c._id]));
  const updates = [];
  for (const c of created) {
    const parts = c.code.split('.');
    if (parts.length > 1) {
      const parentCode = parts.slice(0, -1).join('.');
      const parentId = byCode.get(parentCode);
      if (parentId) updates.push({ updateOne: { filter: { _id: c._id }, update: { parent: parentId } } });
    }
  }
  if (updates.length) await ChartOfAccount.bulkWrite(updates);
  return { created: created.length, skipped: existingCodes.size };
}

/**
 * Busca una cuenta por código y, si no existe pero está definida en el plan
 * estándar, la crea sobre la marcha (enlazando su cuenta padre). Garantiza que
 * las cuentas usadas por la contabilidad automática siempre estén disponibles,
 * incluso en clínicas creadas antes de incorporarse la cuenta al catálogo.
 * Devuelve null si el código no pertenece al plan estándar.
 */
async function ensureAccountByCode(clinicId, code) {
  let acc = await ChartOfAccount.findOne({ clinic: clinicId, code });
  if (acc) return acc;
  const def = defaultPlan.find((a) => a.code === code);
  if (!def) return null;
  const parts = code.split('.');
  let parentId = null;
  if (parts.length > 1) {
    const parentCode = parts.slice(0, -1).join('.');
    const parent = (await ChartOfAccount.findOne({ clinic: clinicId, code: parentCode }))
      || (await ensureAccountByCode(clinicId, parentCode));
    parentId = parent?._id || null;
  }
  try {
    acc = await ChartOfAccount.create({
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
    });
    return acc;
  } catch (e) {
    // Creada en paralelo por otra petición (índice único clinic+code): la reusamos.
    if (e.code === 11000) return ChartOfAccount.findOne({ clinic: clinicId, code });
    throw e;
  }
}

/** Resuelve una cuenta por taxCode o por code. Lanza si no existe. */
async function findAccount(clinicId, { code, taxCode }) {
  const q = { clinic: clinicId };
  if (taxCode) q.taxCode = taxCode;
  else if (code) q.code = code;
  const acc = await ChartOfAccount.findOne(q);
  if (!acc) {
    const err = new Error(`Cuenta contable no encontrada: ${code || taxCode}`);
    err.status = 400;
    throw err;
  }
  return acc;
}

/**
 * Genera número correlativo de asiento por clínica y año de forma ATÓMICA
 * usando un contador (evita duplicados/huecos bajo concurrencia).
 * La primera vez para un año se inicializa con el máximo existente.
 */
async function nextEntryNumber(clinicId, date = new Date()) {
  const year = new Date(date).getFullYear();
  const key = `journal-${year}`;
  const prefix = `AS-${year}-`;
  let counter = await Counter.findOne({ clinic: clinicId, key });
  if (!counter) {
    // Inicializar con el máximo número existente (migración suave de datos previos)
    const last = await JournalEntry.findOne({ clinic: clinicId, number: new RegExp(`^${prefix}`) })
      .sort({ number: -1 })
      .select('number');
    let start = 0;
    if (last) {
      const m = last.number.match(/(\d+)$/);
      if (m) start = parseInt(m[1]);
    }
    try {
      await Counter.create({ clinic: clinicId, key, seq: start });
    } catch (e) {
      // creado en paralelo por otra petición; se ignora
    }
  }
  const updated = await Counter.findOneAndUpdate(
    { clinic: clinicId, key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return `${prefix}${String(updated.seq).padStart(6, '0')}`;
}

/**
 * Crea un asiento contable validando partida doble.
 * lines: [{ accountCode?|account?, costCenter?, description?, debit, credit }]
 */
async function createEntry({ clinicId, date, description, source, sourceRef, sourceModel, lines, userId }) {
  if (!Array.isArray(lines) || lines.length < 2) {
    const err = new Error('El asiento debe tener al menos 2 líneas');
    err.status = 400;
    throw err;
  }
  const period = await assertPeriodOpen(clinicId, date);

  // Hidratar cuentas si vienen por code
  const resolved = [];
  for (const l of lines) {
    let acc = null;
    if (l.account) {
      acc = await ChartOfAccount.findOne({ _id: l.account, clinic: clinicId });
    } else if (l.accountCode) {
      acc = await ChartOfAccount.findOne({ code: l.accountCode, clinic: clinicId });
    }
    if (!acc) {
      const err = new Error(`Cuenta no encontrada: ${l.accountCode || l.account}`);
      err.status = 400;
      throw err;
    }
    if (!acc.allowsMovement) {
      const err = new Error(`Cuenta ${acc.code} no admite movimientos (es agrupadora)`);
      err.status = 400;
      throw err;
    }
    const debit = Number(l.debit) || 0;
    const credit = Number(l.credit) || 0;
    if (debit < 0 || credit < 0) throw Object.assign(new Error('Importes negativos no permitidos'), { status: 400 });
    if (debit > 0 && credit > 0) throw Object.assign(new Error('Una línea no puede tener débito y crédito'), { status: 400 });
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
  const totalDebit = resolved.reduce((s, l) => s + l.debit, 0);
  const totalCredit = resolved.reduce((s, l) => s + l.credit, 0);
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    const err = new Error(`Asiento descuadrado: débito ${totalDebit.toFixed(2)} ≠ crédito ${totalCredit.toFixed(2)}`);
    err.status = 400;
    throw err;
  }
  const number = await nextEntryNumber(clinicId, date);
  const entry = await JournalEntry.create({
    clinic: clinicId,
    number,
    date,
    period: period._id,
    description: description || '',
    source: source || 'MANUAL',
    sourceRef: sourceRef || null,
    sourceModel: sourceModel || null,
    lines: resolved,
    totalDebit,
    totalCredit,
    status: 'CONTABILIZADO',
    createdBy: userId || null,
  });
  await applyToBalances(clinicId, date, entry.lines, 1);
  return entry;
}

/** Reversa (storno) de un asiento: crea otro con débitos/créditos invertidos. */
async function reverseEntry({ clinicId, entryId, userId, reason }) {
  const orig = await JournalEntry.findOne({ _id: entryId, clinic: clinicId });
  if (!orig) throw Object.assign(new Error('Asiento no encontrado'), { status: 404 });
  if (orig.status === 'ANULADO') throw Object.assign(new Error('Ya fue anulado'), { status: 400 });
  const inverted = orig.lines.map((l) => ({
    account: l.account,
    accountCode: l.accountCode,
    accountName: l.accountName,
    costCenter: l.costCenter,
    description: `Reversión: ${l.description || ''}`,
    debit: l.credit,
    credit: l.debit,
  }));
  const period = await assertPeriodOpen(clinicId, new Date());
  const number = await nextEntryNumber(clinicId, new Date());
  const rev = await JournalEntry.create({
    clinic: clinicId,
    number,
    date: new Date(),
    period: period._id,
    description: `REVERSIÓN ${orig.number} — ${reason || ''}`,
    source: 'AJUSTE',
    sourceRef: orig._id,
    sourceModel: 'JournalEntry',
    lines: inverted,
    totalDebit: orig.totalCredit,
    totalCredit: orig.totalDebit,
    status: 'CONTABILIZADO',
    reverses: orig._id,
    createdBy: userId,
  });
  orig.status = 'ANULADO';
  orig.reversedBy = rev._id;
  await orig.save();
  await applyToBalances(clinicId, rev.date, rev.lines, 1);
  return rev;
}

/** Reconstruye AccountBalance desde cero a partir de los asientos contabilizados. */
async function recomputeBalances(clinicId) {
  await AccountBalance.deleteMany({ clinic: clinicId });
  const agg = await JournalEntry.aggregate([
    { $match: { clinic: new (require('mongoose').Types.ObjectId)(clinicId), status: 'CONTABILIZADO' } },
    { $unwind: '$lines' },
    { $group: {
      _id: { account: '$lines.account', year: { $year: '$date' }, month: { $month: '$date' } },
      debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' },
    } },
  ]);
  const docs = agg.map((r) => ({ clinic: clinicId, account: r._id.account, year: r._id.year, month: r._id.month, debit: r.debit, credit: r.credit }));
  if (docs.length) await AccountBalance.insertMany(docs);
  return docs.length;
}

module.exports = {
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
};
