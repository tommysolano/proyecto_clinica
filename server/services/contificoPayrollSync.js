'use strict';

// Sincroniza los roles de pago de Contífico con Nómina. La API de roles exige la
// cédula de cada empleado (no lista un período completo), así que la población se
// arma con las cédulas conocidas MÁS las personas que aparecen en los asientos de
// nómina del mayor, y se comprueba al final contra el mayor: los sueldos de los
// roles de un mes deben ser exactamente el gasto de sueldos contabilizado.
const os = require('os');
const { randomUUID } = require('crypto');
const Clinic = require('../models/Clinic');
const Record = require('../models/ContificoRecord');
const JournalEntry = require('../models/JournalEntry');
const ServerLease = require('../models/ServerLease');
const Notification = require('../models/Notification');
const SyncState = require('../models/ContificoSyncState');
const { ContificoApi } = require('./contificoApi');
const { Extractor } = require('../scripts/migrateContifico');
const { SupplementalProjector, nameScore } = require('../scripts/projectContificoSupplemental');
const { monthRange, ecToday } = require('./contificoFinancialSync');
const { decodeCompressedJson } = require('../utils/compressedJson');

let running = false;
const LEASE_NAME = 'contifico-payroll-sync';
const STATE_ID = 'payroll-Central';
const LEASE_MS = 10 * 60 * 1000;
const cents = (value) => Math.round(Number(value || 0) * 100);
const PAYROLL_GLOSA = /cancelaci[oó]n de haberes|registro de sueldos/i;
const SALARY_ACCOUNT = /^5\.2\.1\.\d+\.1$/; // Sueldos Unificados (Vtas. y Adm.)

async function recordSyncState(patch) {
  try {
    await SyncState.updateOne({ _id: STATE_ID }, { $set: patch }, { upsert: true });
  } catch (error) {
    console.error('[contifico-payroll-sync] No pudo guardar estado:', error.message);
  }
}

/** Personas de Contífico cuyo nombre aparece en asientos de nómina (mejor coincidencia única). */
function personsInJournals(journals, persons) {
  const found = new Map();
  for (const journal of journals) {
    const scored = persons.map((person) => ({ person, score: nameScore(person.razon_social, journal.description) }))
      .filter((row) => row.score >= 2).sort((a, b) => b.score - a.score);
    if (!scored.length || (scored[1] && scored[1].score === scored[0].score)) continue;
    const id = String(scored[0].person.cedula || scored[0].person.ruc || '').trim();
    if (id) found.set(id, scored[0].person.razon_social);
  }
  return found;
}

/**
 * Sueldo de los roles del mes (detalles «SUELDO») frente al gasto de sueldos del mayor.
 * Sin gasto contabilizado el mes aún no está cerrado en Contífico: no hay contra qué medir.
 */
function salaryCheck(roles, ledgerSalary) {
  const roleSalary = roles.reduce((sum, role) => sum + (role.detalles || [])
    .filter((detail) => /\bSUELDO\b/i.test(String(detail.nombre || '')) && String(detail.tipo || '').toUpperCase().startsWith('I'))
    .reduce((total, detail) => total + cents(detail.total), 0), 0);
  if (!cents(ledgerSalary)) return { state: 'SIN_CIERRE', roleSalary: roleSalary / 100, ledgerSalary: 0 };
  return { state: roleSalary === cents(ledgerSalary) ? 'CUADRA' : 'DIFERENTE',
    roleSalary: roleSalary / 100, ledgerSalary: cents(ledgerSalary) / 100 };
}

async function syncPayrollMonth({ clinic, api, year, month, persons, assertLease = () => {} }) {
  const { from, through } = monthRange(year, month);
  const key = `${year}-${String(month).padStart(2, '0')}`;
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  // Los pagos de la 2.ª quincena se hacen los primeros días del mes siguiente.
  const journals = await JournalEntry.find({ clinic: clinic._id, status: 'CONTABILIZADO', description: PAYROLL_GLOSA,
    date: { $gte: start, $lt: new Date(end.getTime() + 10 * 86400000) } }).select('date description lines').lean();
  const discovered = personsInJournals(journals, persons);

  assertLease();
  const extractor = new Extractor({ api, clinic, commit: true, from, through, cutoff: new Date(), pageSize: 100,
    only: new Set(['payroll_roles']), payrollCedulas: [...discovered.keys()] });
  extractor.cache.person = persons;
  await extractor.execute();
  if (!['COMPLETED', 'COMPLETED_WITH_WARNINGS'].includes(extractor.run?.status)) throw new Error(`Extracción de roles ${key} no completada`);

  assertLease();
  const projected = await new SupplementalProjector({ clinic, commit: true, cutoff: new Date(), only: new Set(['payroll']) }).execute();
  const unmapped = projected.stages.flatMap((stage) => stage.samples || []).filter((sample) => /no mapeado/i.test(sample.message));
  if (unmapped.length) throw new Error(`Roles ${key} sin empleado: ${unmapped.map((sample) => sample.externalId).join(', ')}`);

  const roles = (await Record.find({ clinic: clinic._id, entity: 'payroll_role' }).select('payloadCompressed').lean())
    .map((record) => decodeCompressedJson(record.payloadCompressed))
    .filter((role) => Number(role.anio) === year && Number(role.mes) === month);
  const ledgerSalary = journals.filter((journal) => journal.date >= start && journal.date < end)
    .flatMap((journal) => journal.lines).filter((line) => SALARY_ACCOUNT.test(line.accountCode || ''))
    .reduce((sum, line) => sum + Number(line.debit || 0) - Number(line.credit || 0), 0);
  // Sueldos contabilizados fuera de asientos de nómina también cuentan en el control.
  const otherSalary = await JournalEntry.aggregate([
    { $match: { clinic: clinic._id, status: 'CONTABILIZADO', date: { $gte: start, $lt: end }, description: { $not: PAYROLL_GLOSA } } },
    { $unwind: '$lines' }, { $match: { 'lines.accountCode': SALARY_ACCOUNT } },
    { $group: { _id: null, total: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
  ]);
  const check = salaryCheck(roles, ledgerSalary + (otherSalary[0]?.total || 0));
  if (check.state === 'DIFERENTE') {
    throw new Error(`Sueldos ${key}: roles USD ${check.roleSalary.toFixed(2)} y mayor USD ${check.ledgerSalary.toFixed(2)}; `
      + 'puede faltar el rol de un empleado que Contífico no tiene marcado como empleado');
  }
  return { month: key, state: check.state === 'CUADRA' ? 'CURRENT' : 'SIN_CIERRE', roles: roles.length,
    roleSalary: check.roleSalary, ledgerSalary: check.ledgerSalary, discovered: discovered.size,
    snapshot: String(extractor.run._id) };
}

async function syncPayroll({ includeHistory = false, months: requestedMonths = null, trigger = 'MANUAL' } = {}) {
  if (running) return { state: 'ALREADY_RUNNING' };
  if (!process.env.CONTIFICO_API_KEY) return { state: 'NO_API_KEY' };
  running = true;
  const holder = `${process.pid}:${randomUUID()}`;
  let renewal, leaseLost = false, acquired = false;
  try {
    const now = new Date();
    try {
      const claim = await ServerLease.findOneAndUpdate(
        { _id: LEASE_NAME, expiresAt: { $lte: now } },
        { $set: { holder, expiresAt: new Date(now.getTime() + LEASE_MS), renewedAt: now } },
        { upsert: true, new: true }
      );
      acquired = claim?.holder === holder;
    } catch (error) { if (error.code !== 11000) throw error; }
    if (!acquired) return { state: 'ALREADY_RUNNING' };
    renewal = setInterval(async () => {
      try {
        const result = await ServerLease.updateOne({ _id: LEASE_NAME, holder },
          { $set: { expiresAt: new Date(Date.now() + LEASE_MS), renewedAt: new Date() } });
        if (result.matchedCount !== 1) leaseLost = true;
      } catch (error) { leaseLost = true; console.error('[contifico-payroll-sync] Perdió arriendo:', error.message); }
    }, 60 * 1000);
    const assertLease = () => { if (leaseLost) throw new Error('Arriendo de sincronización perdido'); };
    const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
    if (!clinic) throw new Error('Clínica Central no encontrada');
    await recordSyncState({ state: 'RUNNING', trigger, host: os.hostname(),
      startedAt: new Date(), completedAt: null, months: [], failures: [], lastError: '' });
    const api = new ContificoApi({ apiKey: process.env.CONTIFICO_API_KEY });
    const persons = (await Record.find({ clinic: clinic._id, entity: 'person' }).select('payloadCompressed').lean())
      .map((record) => decodeCompressedJson(record.payloadCompressed));
    const today = ecToday();
    const windows = [];
    if (requestedMonths) {
      for (const value of requestedMonths) {
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new Error(`Mes inválido ${value}`);
        windows.push(value.split('-').map(Number));
      }
    } else {
      windows.push([today.year, today.month], today.month === 1 ? [today.year - 1, 12] : [today.year, today.month - 1]);
      if (includeHistory) for (let year = 2026; year <= today.year; year += 1) {
        for (let month = year === today.year ? today.month : 12; month >= 1; month -= 1) windows.push([year, month]);
      }
    }
    const seen = new Set();
    const result = [], failures = [];
    for (const [year, month] of windows) {
      const key = `${year}-${String(month).padStart(2, '0')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const alertKey = `rol-${key}`;
      try {
        assertLease();
        const outcome = await syncPayrollMonth({ clinic, api, year, month, persons, assertLease });
        result.push(outcome);
        console.log(`[contifico-payroll-sync] ${key}: ${outcome.state}, ${outcome.roles} roles`);
        await Notification.updateMany({ clinic: clinic._id, type: 'contifico_sync_blocked', 'meta.month': alertKey, read: false },
          { $set: { read: true, readAt: new Date() } })
          .catch((error) => console.error('[contifico-payroll-sync] Aviso resuelto:', error.message));
      } catch (error) {
        failures.push({ month: key, error: error.message });
        console.error(`[contifico-payroll-sync] BLOQUEADO ${key}:`, error.stack || error.message);
        await Notification.updateOne({ clinic: clinic._id, user: null, type: 'contifico_sync_blocked',
          'meta.month': alertKey, read: false }, { $setOnInsert: {
          clinic: clinic._id, user: null, type: 'contifico_sync_blocked', severity: 'error', meta: { month: alertKey },
          title: `Contífico: nómina por revisar (${key})`, body: String(error.message).slice(0, 500),
        } }, { upsert: true }).catch((notificationError) =>
          console.error('[contifico-payroll-sync] No pudo crear aviso:', notificationError.message));
      }
    }
    const outcome = { state: failures.length ? 'PARTIAL' : 'COMPLETED', months: result, failures };
    await recordSyncState({ ...outcome, completedAt: new Date(), ...(failures.length ? {} : { lastSuccessfulAt: new Date() }) });
    return outcome;
  } catch (error) {
    if (acquired) await recordSyncState({ state: 'FAILED', completedAt: new Date(), lastError: String(error.message).slice(0, 500) });
    throw error;
  } finally {
    if (renewal) clearInterval(renewal);
    if (acquired) await ServerLease.deleteOne({ _id: LEASE_NAME, holder }).catch((error) =>
      console.error('[contifico-payroll-sync] No pudo soltar arriendo:', error.message));
    running = false;
  }
}

module.exports = { syncPayroll, syncPayrollMonth, personsInJournals, salaryCheck };
