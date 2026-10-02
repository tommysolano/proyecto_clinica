#!/usr/bin/env node
'use strict';

// Auditoría de registros RRHH ya archivados: cédula, período, importes y pago bancario.
require('dotenv').config();
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const Employee = require('../models/Employee');
const Payroll = require('../models/Payroll');
const ContificoRecord = require('../models/ContificoRecord');
const BankTransaction = require('../models/BankTransaction');
const { decodeCompressedJson } = require('../utils/compressedJson');
const { parseDate, fmt } = require('./migrateContifico');
const { payrollPaymentKey } = require('./projectContificoSupplemental');

const cents = (value) => Math.round(Number(value || 0) * 100);
const periodType = { P: 'QUINCENA_1', S: 'CIERRE_MES', M: 'MENSUAL' };

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  if (!clinic) throw new Error('Clínica Central no encontrada');
  const [sourcePeople, sourceRoles, sourceBanks, employees, payrolls] = await Promise.all([
    ContificoRecord.find({ clinic: clinic._id, entity: 'person' }).select('externalId payloadCompressed').lean(),
    ContificoRecord.find({ clinic: clinic._id, entity: 'payroll_role' }).select('externalId payloadCompressed projection').lean(),
    ContificoRecord.find({ clinic: clinic._id, entity: 'bank_movement' }).select('externalId payloadCompressed projection').lean(),
    Employee.find({ clinic: clinic._id }).select('_id identificacion contificoSource').lean(),
    Payroll.find({ clinic: clinic._id }).select('year month periodType status items payments journalEntry totalIngresos totalEgresos totalNeto').lean(),
  ]);
  const people = sourcePeople.map((record) => ({ id: record.externalId, row: decodeCompressedJson(record.payloadCompressed) }));
  const personIdByIdentification = new Map(people.map(({ id, row }) => [String(row.cedula || row.ruc || ''), id]));
  const flagged = new Set(people.filter(({ row }) => row.es_empleado).map(({ row }) => String(row.cedula || row.ruc || '')));
  const employeeByIdentification = new Map(employees.map((employee) => [String(employee.identificacion), employee]));
  const bankEvidence = new Map();
  for (const record of sourceBanks) {
    const row = decodeCompressedJson(record.payloadCompressed);
    if (String(row.tipo_registro || '').toUpperCase() !== 'E') continue;
    const amount = (row.detalles || []).reduce((sum, detail) => sum + cents(detail.monto), 0) / 100;
    const key = payrollPaymentKey({ personId: row.persona, date: row.fecha_emision, amount, reference: row.numero_comprobante });
    if (!bankEvidence.has(key)) bankEvidence.set(key, []);
    bankEvidence.get(key).push(record);
  }
  const bankIds = new Set(sourceBanks.flatMap((record) => (record.projection?.links || [])
    .filter((link) => link.model === 'BankTransaction' && link.ref).map((link) => String(link.ref))));
  const nativeBankIds = new Set((await BankTransaction.find({ _id: { $in: [...bankIds] } }).select('_id').lean()).map((row) => String(row._id)));
  const localPeriods = new Map(payrolls.map((payroll) => [`${payroll.year}-${payroll.month}-${payroll.periodType}`, payroll]));
  const sourcePeriods = new Map();
  const differences = [];
  let matchedRoleItems = 0, verifiedPayments = 0, linkedBankPayments = 0, missingJournalLinks = 0;
  for (const record of sourceRoles) {
    const row = decodeCompressedJson(record.payloadCompressed);
    const period = `${Number(row.anio)}-${Number(row.mes)}-${periodType[String(row.periodo_consultado).toUpperCase()] || '?'}`;
    const identification = String(row.cedula || '');
    sourcePeriods.set(period, (sourcePeriods.get(period) || 0) + 1);
    const payroll = localPeriods.get(period);
    const employee = employeeByIdentification.get(identification);
    const item = payroll?.items?.find((candidate) => String(candidate.identificacion) === identification);
    if (!employee) differences.push({ role: record.externalId, kind: 'EMPLOYEE_MISSING' });
    if (!payroll || !item) { differences.push({ role: record.externalId, kind: 'ROLE_ITEM_MISSING' }); continue; }
    if (cents(row.total_ingresos) !== cents(item.totalIngresos) || cents(row.total_egresos) !== cents(item.totalEgresos)
      || cents(row.total_pago) !== cents(item.netoPagar) || Number(row.dias_trabajados) !== Number(item.daysWorked)) {
      differences.push({ role: record.externalId, kind: 'ROLE_ITEM_VALUES' });
    } else matchedRoleItems += 1;
    if (!payroll.journalEntry) missingJournalLinks += 1;
    const key = payrollPaymentKey({ personId: personIdByIdentification.get(identification), date: row.fecha,
      amount: row.total_pago, reference: row.comprobante });
    const evidence = bankEvidence.get(key) || [];
    const payment = payroll.payments?.find((candidate) => candidate.idempotencyKey === `contifico:payroll:${record.externalId}`);
    if (cents(row.total_pago) > 0) {
      if (evidence.length !== 1) differences.push({ role: record.externalId, kind: 'BANK_EVIDENCE_COUNT', count: evidence.length });
      if (!payment || cents(payment.amount) !== cents(row.total_pago) || fmt(payment.date) !== fmt(parseDate(row.fecha))
        || String(payment.reference || '') !== String(row.comprobante || '')) {
        differences.push({ role: record.externalId, kind: 'PAYMENT_MISMATCH' });
      } else verifiedPayments += 1;
      if (payment?.bankTransaction && nativeBankIds.has(String(payment.bankTransaction))) linkedBankPayments += 1;
      else differences.push({ role: record.externalId, kind: 'BANK_TRANSACTION_NOT_LINKED' });
    }
  }
  for (const [period, payroll] of localPeriods) {
    const expected = sourcePeriods.get(period) || 0;
    if (payroll.items.length !== expected) differences.push({ period, kind: 'PERIOD_ITEM_COUNT', source: expected, local: payroll.items.length });
    const sums = [
      payroll.items.reduce((sum, item) => sum + cents(item.totalIngresos), 0),
      payroll.items.reduce((sum, item) => sum + cents(item.totalEgresos), 0),
      payroll.items.reduce((sum, item) => sum + cents(item.netoPagar), 0),
    ];
    if (sums[0] !== cents(payroll.totalIngresos) || sums[1] !== cents(payroll.totalEgresos) || sums[2] !== cents(payroll.totalNeto)) {
      differences.push({ period, kind: 'PERIOD_TOTALS' });
    }
  }
  const sourceIdentifications = new Set(sourceRoles.map((record) => String(decodeCompressedJson(record.payloadCompressed).cedula || '')));
  const flaggedMissingLocal = [...flagged].filter((id) => !employeeByIdentification.has(id));
  const rolePeopleMissingLocal = [...sourceIdentifications].filter((id) => !employeeByIdentification.has(id));
  const report = {
    sourcePeople: people.length, sourceEmployeeFlag: flagged.size, sourceRolePeople: sourceIdentifications.size,
    localEmployees: employees.length, sourceRoles: sourceRoles.length, localPeriods: payrolls.length,
    matchedRoleItems, verifiedPayments, linkedBankPayments,
    periods: [...sourcePeriods].sort().map(([period, items]) => ({ period, items })),
    flaggedMissingLocal: flaggedMissingLocal.length, rolePeopleMissingLocal: rolePeopleMissingLocal.length,
    rolesWithoutDirectJournalLink: missingJournalLinks, differences,
    completeForKnownRoles: differences.length === 0 && matchedRoleItems === sourceRoles.length,
    historicalEmployeeUniverseVerified: false,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.completeForKnownRoles) process.exitCode = 2;
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
