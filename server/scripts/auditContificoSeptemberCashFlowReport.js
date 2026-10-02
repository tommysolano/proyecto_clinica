#!/usr/bin/env node
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const reports = require('../controllers/accountingReportsController');

const round = (value) => +Number(value || 0).toFixed(2);

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  let status = 200, body;
  const response = { status(code) { status = code; return this; }, json(value) { body = value; return this; } };
  await reports.cashFlow({ clinicId: clinic._id,
    query: { startDate: '2026-09-01', endDate: '2026-09-30' } }, response);
  if (status !== 200 || !body || !Array.isArray(body.flows))
    throw new Error(`Flujo de caja falló: ${status} ${JSON.stringify(body)}`);
  const byCode = new Map();
  for (const flow of body.flows) {
    const code = flow.accountCode;
    const value = byCode.get(code) || { debit: 0, credit: 0, lines: 0 };
    value.debit += Number(flow.in || 0); value.credit += Number(flow.out || 0); value.lines += 1;
    byCode.set(code, value);
  }
  const report = { accounts: body.accounts?.length, flowLines: body.flows.length,
    opening: round(body.opening), totalIn: round(body.totalIn), totalOut: round(body.totalOut),
    closing: round(body.saldoFinal), reconciles: round(body.opening + body.totalIn - body.totalOut) === round(body.saldoFinal),
    codes: [...byCode].map(([code, value]) => ({ code,
      debit: round(value.debit), credit: round(value.credit), lines: value.lines })) };
  console.log(JSON.stringify(report, null, 2));
  if (!report.reconciles || report.flowLines !== 1804 ||
    report.totalIn !== 79202.25 || report.totalOut !== 31748.71)
    process.exitCode = 2;
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
