#!/usr/bin/env node
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const reports = require('../controllers/accountingReportsController');
async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  let status = 200, body;
  await reports.cashFlow({ clinicId: clinic._id, query: { startDate: '2026-01-01', endDate: '2026-12-31' } },
    { status(code) { status = code; return this; }, json(value) { body = value; return this; } });
  if (status !== 200) throw new Error(`${status} ${JSON.stringify(body)}`);
  console.log(JSON.stringify({ opening: body.opening, totalIn: body.totalIn, totalOut: body.totalOut,
    closing: body.saldoFinal, net: +(body.totalIn - body.totalOut).toFixed(2),
    rows: body.flows?.length, accounts: body.accounts?.map((r) => r.code) }, null, 2));
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
