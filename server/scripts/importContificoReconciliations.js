#!/usr/bin/env node
'use strict';
// Importa las conciliaciones bancarias exportadas de Contífico
// (Bancos → Conciliaciones → Conciliación Bancaria → Excel, hojas «Movimientos» y «Saldo»).
//
// Uso: node scripts/importContificoReconciliations.js --file=Conciliaciones.xlsx [--commit]
// Sin --commit solo informa. El .xls antiguo de Contífico debe guardarse como .xlsx.
//
// En las cuentas importadas el libro del banco es el MAYOR: cada movimiento conciliado se
// identifica con su línea de asiento (cuenta, fecha, signo, monto y glosa). No se crean
// movimientos bancarios ni se modifican asientos. Antes de escribir se exige que el saldo
// contable de cada conciliación sea el del mayor a esa fecha y que cada movimiento tenga
// una única línea; si algo falla no se importa nada.
require('dotenv').config();
const mongoose = require('mongoose');

const r2 = (value) => +Number(value || 0).toFixed(2);
const cents = (value) => Math.round(Number(value || 0) * 100);
const text = (value) => (value && typeof value === 'object' && 'richText' in value
  ? value.richText.map((part) => part.text).join('') : String(value ?? '')).trim();
// Excel guarda el retorno de carro de las glosas como «_x000d_».
const norm = (value) => text(value).replace(/_x000d_/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

function money(value) {
  if (typeof value === 'number') return value;
  const raw = text(value).replace(/[$,\s]/g, '');
  if (!raw) return null;
  const number = Number(raw);
  if (!Number.isFinite(number)) throw new Error(`Monto inválido: ${value}`);
  return number;
}

/** dd/mm/aa o dd/mm/aaaa (o Date) → 'AAAA-MM-DD'. */
function isoDay(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const match = text(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!match) return null;
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return `${year}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
}

/** Número de cuenta dentro de «Banco Internacional Cta Cte 1400632113». */
const accountNumberOf = (bank) => (text(bank).match(/(\d{6,})\s*$/) || [])[1] || null;

/**
 * Convierte las filas de ambas hojas en conciliaciones. Comprueba que el saldo
 * inicial más los movimientos dé el saldo bancario del resumen.
 */
function parseReconciliations({ movements, balances, pending = {} }) {
  const summaries = new Map();
  for (let index = 0; index < balances.length; index += 1) {
    const row = balances[index];
    const cut = isoDay(row[0]);
    if (!cut || !text(row[1]) || !/saldo bancario/i.test(text(row[2]))) continue;
    const values = balances[index + 1] || [];
    summaries.set(`${cut}|${accountNumberOf(row[1])}`, {
      statementBalance: money(values[2]), bookBalance: money(values[3]), difference: money(values[4]) });
  }
  const blocks = [];
  let current = null;
  for (const row of movements) {
    const cut = isoDay(row[0]);
    if (cut && text(row[1])) {
      current = { cutDate: cut, bankName: text(row[1]), accountNumber: accountNumberOf(row[1]),
        openingBalance: money(row[2]) ?? 0, lines: [] };
      if (!current.accountNumber) throw new Error(`Cuenta sin número: ${text(row[1])}`);
      blocks.push(current);
    }
    const date = isoDay(row[3]);
    if (!date || !current) continue;
    const sign = text(row[7]);
    if (!['+', '-'].includes(sign)) throw new Error(`Signo inválido «${sign}» en ${current.cutDate} ${current.bankName}`);
    const amount = money(row[8]);
    if (amount === null) throw new Error(`Monto vacío en ${current.cutDate} ${current.bankName}`);
    current.lines.push({ date, description: text(row[4]), reference: text(row[5]), type: text(row[6]),
      amount: r2(sign === '-' ? -amount : amount), party: text(row[9]) });
  }
  for (const block of blocks) {
    const summary = summaries.get(`${block.cutDate}|${block.accountNumber}`);
    if (!summary) throw new Error(`Sin resumen de saldo para ${block.cutDate} ${block.bankName}`);
    Object.assign(block, summary);
    const computed = r2(block.openingBalance + block.lines.reduce((sum, line) => sum + line.amount, 0));
    if (cents(computed) !== cents(block.statementBalance)) {
      throw new Error(`${block.cutDate} ${block.bankName}: inicial + movimientos = ${computed}, resumen ${block.statementBalance}`);
    }
  }
  if (summaries.size !== blocks.length) throw new Error(`Resúmenes ${summaries.size} ≠ conciliaciones ${blocks.length}`);

  // Partidas pendientes al corte (columnas: corte, banco, fecha, detalle, referencia, signo, monto, persona).
  for (const block of blocks) block.pending = [];
  const byKey = new Map(blocks.map((block) => [`${block.cutDate}|${block.accountNumber}`, block]));
  for (const [category, rows] of Object.entries(pending)) {
    let target = null;
    for (const row of rows) {
      const cut = isoDay(row[0]);
      if (cut && text(row[1])) {
        target = byKey.get(`${cut}|${accountNumberOf(row[1])}`);
        if (!target) throw new Error(`${category}: conciliación inexistente ${cut} ${text(row[1])}`);
      }
      const date = isoDay(row[2]);
      if (!date || !target) continue;
      const sign = text(row[5]);
      if (!['+', '-'].includes(sign)) throw new Error(`${category}: signo inválido «${sign}»`);
      const amount = money(row[6]);
      target.pending.push({ category, date, description: text(row[3]), reference: text(row[4]),
        amount: r2(sign === '-' ? -amount : amount), party: text(row[7]) });
    }
  }
  if (Object.keys(pending).length) for (const block of blocks) {
    const inTransit = block.pending.filter((item) => item.category !== 'CHEQUE_POSTFECHADO')
      .reduce((sum, item) => sum + cents(item.amount), 0);
    if (cents(block.statementBalance) + inTransit !== cents(block.bookBalance)) {
      throw new Error(`${block.cutDate} ${block.bankName}: bancario + pendientes ≠ contable`);
    }
  }
  return blocks;
}

const PENDING_SHEETS = {
  DEPOSITO_TRANSITO: 'Depósitos en tránsito',
  CHEQUE_PENDIENTE: 'Cheques pendientes de cobro',
  NC_TRANSITO: 'Notas de crédito en tránsito',
  ND_TRANSITO: 'Notas de dédito en tránsito', // así, con la errata, la nombra Contífico
  CHEQUE_POSTFECHADO: 'Cheques Postfechados',
};

/**
 * Asigna a cada movimiento conciliado una línea del mayor: misma cuenta, fecha, signo
 * y monto; si hay varias, la de glosa igual. Una línea no se usa dos veces. Las
 * candidatas idénticas (misma glosa) son intercambiables y se toman en orden.
 * `ledger`: [{ key: journalId-index, journalEntry, lineIndex, accountNumber, date, amount, description }]
 */
function matchLines(blocks, ledger) {
  const pool = new Map();
  for (const line of ledger) {
    const key = `${line.accountNumber}|${line.date}|${cents(line.amount)}`;
    if (!pool.has(key)) pool.set(key, []);
    pool.get(key).push(line);
  }
  const used = new Set();
  const ref = (line) => ({ journalEntry: line.journalEntry, lineIndex: line.lineIndex });
  const pending = [];
  for (const block of blocks) {
    block.items = block.lines.map((line) => {
      const candidates = (pool.get(`${block.accountNumber}|${line.date}|${cents(line.amount)}`) || [])
        .filter((candidate) => !used.has(candidate.key));
      const sameText = candidates.filter((candidate) => norm(candidate.description) === norm(line.description));
      const chosen = sameText[0] || (candidates.length === 1 ? candidates[0] : null);
      const item = { ...line, lines: chosen ? [ref(chosen)] : [], matched: Boolean(chosen), note: '' };
      if (chosen) used.add(chosen.key);
      else pending.push({ block, item, candidates: candidates.length });
      return item;
    });
  }

  // Segunda pasada: un movimiento del banco que agrupa varios asientos del mismo día
  // y la misma glosa («PAGO MASIVO», «PAGOS VARIOS», «Cancelación de haberes»). Solo
  // se acepta si la suma del grupo es EXACTAMENTE la de los movimientos pendientes.
  const sets = new Map();
  for (const entry of pending) {
    const { block, item } = entry;
    const key = `${block.accountNumber}|${item.date}|${Math.sign(item.amount)}|${glosaHead(item.description)}`;
    if (!sets.has(key)) sets.set(key, []);
    sets.get(key).push(entry);
  }
  for (const [key, entries] of sets) {
    const [accountNumber, date, sign, head] = key.split('|');
    const free = ledger.filter((line) => line.accountNumber === accountNumber && line.date === date && !used.has(line.key)
      && String(Math.sign(line.amount)) === sign && glosaHead(line.description) === head);
    const target = entries.reduce((sum, entry) => sum + cents(entry.item.amount), 0);
    if (!free.length || free.reduce((sum, line) => sum + cents(line.amount), 0) !== target) continue;
    let remaining = free;
    const parts = [];
    for (const entry of entries.slice(0, -1)) {
      const subset = subsetWithSum(remaining, cents(entry.item.amount));
      if (!subset) break;
      parts.push(subset);
      const taken = new Set(subset.map((line) => line.key));
      remaining = remaining.filter((line) => !taken.has(line.key));
    }
    if (parts.length !== entries.length - 1) continue;
    parts.push(remaining);
    entries.forEach((entry, index) => {
      Object.assign(entry.item, { lines: parts[index].map(ref), matched: true,
        note: entries.length > 1
          ? `Agrupa ${parts[index].length} asientos «${head}» del día; Contífico no indica qué pagos van en cada transferencia, el reparto se calculó por importe`
          : `Agrupa ${parts[index].length} asientos «${head}» del día` });
      entry.resolved = true;
      parts[index].forEach((line) => used.add(line.key));
    });
  }
  const unmatched = pending.filter((entry) => !entry.resolved)
    .map(({ block, item, candidates }) => ({ cutDate: block.cutDate, bank: block.bankName, ...item, candidates }));
  return { blocks, unmatched };
}

/** Primeras palabras de la glosa, antes de la coma: identifica el tipo de pago. */
function glosaHead(value) {
  return norm(value).replace(/,.*$/, '').split(' ').slice(0, 3).join(' ');
}

/** Subconjunto de líneas cuyo importe suma `target` centavos (programación dinámica). */
function subsetWithSum(lines, target) {
  const values = lines.map((line) => Math.abs(cents(line.amount)));
  const goal = Math.abs(target);
  const from = new Int32Array(goal + 1).fill(-1);
  from[0] = -2;
  for (let index = 0; index < values.length; index += 1) {
    for (let total = goal; total >= values[index]; total -= 1) {
      if (from[total] === -1 && from[total - values[index]] !== -1 && from[total - values[index]] !== index) {
        from[total] = index;
      }
    }
  }
  if (from[goal] === -1) return null;
  const subset = [];
  for (let total = goal; total > 0; total -= values[from[total]]) subset.push(lines[from[total]]);
  return subset;
}

async function readWorkbook(file) {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const rows = (name) => {
    const sheet = workbook.getWorksheet(name);
    if (!sheet) throw new Error(`Falta la hoja «${name}»`);
    const result = [];
    sheet.eachRow({ includeEmpty: true }, (row) => {
      result.push(Array.from({ length: 10 }, (_, column) => row.getCell(column + 1).value));
    });
    return result;
  };
  const pending = Object.fromEntries(Object.entries(PENDING_SHEETS).map(([category, name]) => [category, rows(name)]));
  return { movements: rows('Movimientos'), balances: rows('Saldo'), pending };
}

async function main() {
  const fileArg = process.argv.find((arg) => arg.startsWith('--file='));
  if (!fileArg) throw new Error('Indique --file=Conciliaciones.xlsx');
  const commit = process.argv.includes('--commit');
  // El exporte no trae el estado; los cortes «Pendiente» en Contífico se indican así:
  // --pending=2026-07-31:1400632113,2026-07-31:1071312145
  const pendingArg = process.argv.find((arg) => arg.startsWith('--pending='));
  const pendingCuts = new Set(pendingArg ? pendingArg.slice('--pending='.length).split(',').map((value) => value.trim()).filter(Boolean) : []);
  const file = fileArg.slice('--file='.length);
  if (!/\.xlsx$/i.test(file)) throw new Error('Guarde el exporte de Contífico como .xlsx');
  const blocks = parseReconciliations(await readWorkbook(file));

  await mongoose.connect(process.env.MONGODB_URI);
  const Clinic = require('../models/Clinic');
  const BankAccount = require('../models/BankAccount');
  const JournalEntry = require('../models/JournalEntry');
  const Reconciliation = require('../models/Reconciliation');
  require('../models/ChartOfAccount');
  const { journalBalances } = require('../services/bankJournalLedger');
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  if (!clinic) throw new Error('Clínica Central no encontrada');
  const banks = await BankAccount.find({ clinic: clinic._id }).populate('chartAccount', 'code').lean();
  const bankByNumber = new Map(banks.map((bank) => [String(bank.accountNumber), bank]));
  for (const block of blocks) {
    block.bank = bankByNumber.get(block.accountNumber);
    if (!block.bank?.chartAccount) throw new Error(`Cuenta bancaria ${block.accountNumber} sin cuenta contable local`);
  }

  // Saldo contable de cada corte = saldo del mayor a esa fecha.
  for (const block of blocks) {
    const balance = (await journalBalances(clinic._id, [block.bank.chartAccount._id], block.cutDate))
      .get(String(block.bank.chartAccount._id)) || 0;
    if (cents(balance) !== cents(block.bookBalance)) {
      throw new Error(`${block.cutDate} ${block.bankName}: saldo contable Contífico ${block.bookBalance}, mayor ${balance}`);
    }
  }

  const accountIds = banks.map((bank) => bank.chartAccount?._id).filter(Boolean);
  const numberByAccount = new Map(banks.map((bank) => [String(bank.chartAccount?._id), String(bank.accountNumber)]));
  const journals = await JournalEntry.find({ clinic: clinic._id, status: 'CONTABILIZADO', 'lines.account': { $in: accountIds } })
    .select('date description lines.account lines.debit lines.credit').lean();
  const ledger = [];
  for (const journal of journals) for (const [index, line] of journal.lines.entries()) {
    const accountNumber = numberByAccount.get(String(line.account));
    if (!accountNumber) continue;
    ledger.push({ key: `${journal._id}-${index}`, journalEntry: journal._id, lineIndex: index, accountNumber,
      date: journal.date.toISOString().slice(0, 10), amount: r2((line.debit || 0) - (line.credit || 0)),
      description: journal.description || '' });
  }
  const { unmatched } = matchLines(blocks, ledger);
  // Un pendiente puede repetirse en varios cortes (un cheque sin cobrar dos meses) y
  // conciliarse en uno posterior: se empata dentro de cada conciliación por separado.
  const pendingUnmatched = [];
  for (const block of blocks) {
    const scoped = { ...block, lines: block.pending };
    pendingUnmatched.push(...matchLines([scoped], ledger).unmatched);
    block.pendingItems = scoped.items;
  }
  const describe = (line) => `${line.cutDate} ${line.bank.slice(0, 20)} ${line.date} ${line.amount} ${line.category || line.type} ${line.reference} ${line.description.slice(0, 60)} (candidatas ${line.candidates})`;
  const total = blocks.reduce((sum, block) => sum + block.lines.length, 0);
  const pendingTotal = blocks.reduce((sum, block) => sum + block.pending.length, 0);
  console.log(JSON.stringify({ mode: commit ? 'COMMIT' : 'DRY_RUN', reconciliations: blocks.length, movements: total,
    matched: total - unmatched.length, unmatched: unmatched.length, unmatchedSample: unmatched.slice(0, 30).map(describe),
    pending: pendingTotal, pendingMatched: pendingTotal - pendingUnmatched.length,
    pendingUnmatched: pendingUnmatched.length, pendingUnmatchedSample: pendingUnmatched.slice(0, 30).map(describe),
    pendingStatus: [...pendingCuts] }, null, 2));
  for (const key of pendingCuts) {
    if (!blocks.some((block) => `${block.cutDate}:${block.accountNumber}` === key)) throw new Error(`--pending=${key} no existe en el archivo`);
  }
  if (!commit) return;
  if (unmatched.length || pendingUnmatched.length) throw new Error('Hay movimientos sin línea del mayor; no se importa nada');

  for (const block of blocks) {
    const cutDate = new Date(`${block.cutDate}T12:00:00.000Z`);
    const sourceKey = `contifico:${block.accountNumber}:${block.cutDate}`;
    const closed = !pendingCuts.has(`${block.cutDate}:${block.accountNumber}`);
    const item = (row) => ({ lines: row.lines, note: row.note, date: new Date(`${row.date}T12:00:00.000Z`),
      type: row.type || '', description: row.description, reference: row.reference, party: row.party,
      amount: row.amount, matched: row.matched, ...(row.category ? { category: row.category } : {}) });
    await Reconciliation.updateOne({ clinic: clinic._id, sourceKey }, { $set: {
      clinic: clinic._id, bankAccount: block.bank._id, cutDate, periodEnd: cutDate, source: 'CONTIFICO', sourceKey,
      description: `Conciliación importada de Contífico (${block.bankName})`,
      openingBalance: block.openingBalance, statementBalance: block.statementBalance, bookBalance: block.bookBalance,
      difference: block.difference, status: closed ? 'CONCILIADO' : 'BORRADOR', closedAt: closed ? cutDate : null,
      items: [], statementLines: [], journalItems: block.items.map(item), pendingItems: block.pendingItems.map(item),
    } }, { upsert: true });
  }
  console.log(`Importadas ${blocks.length} conciliaciones (${total} movimientos, ${pendingTotal} pendientes al corte)`);
}

if (require.main === module) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));

module.exports = { parseReconciliations, matchLines, isoDay, money };
