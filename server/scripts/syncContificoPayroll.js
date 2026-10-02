#!/usr/bin/env node
'use strict';
// Uso: node scripts/syncContificoPayroll.js [--history] [--months=2026-08,2026-09]
require('dotenv').config();
const mongoose = require('mongoose');
const { syncPayroll } = require('../services/contificoPayrollSync');

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('Falta MONGODB_URI');
  await mongoose.connect(process.env.MONGODB_URI);
  const monthArg = process.argv.find((arg) => arg.startsWith('--months='));
  const months = monthArg ? monthArg.slice('--months='.length).split(',').map((value) => value.trim()) : null;
  const result = await syncPayroll({ includeHistory: process.argv.includes('--history'), months });
  console.log(JSON.stringify(result, null, 2));
  if (result.state !== 'COMPLETED') process.exitCode = 1;
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
