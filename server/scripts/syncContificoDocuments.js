#!/usr/bin/env node
'use strict';
// Uso: node scripts/syncContificoDocuments.js [--dry-run] [--history] [--months=2026-09,2026-10]
// --dry-run solo compara Contífico con ventas, compras y cartera locales.
require('dotenv').config();
const mongoose = require('mongoose');
const { syncDocuments } = require('../services/contificoDocumentSync');

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('Falta MONGODB_URI');
  await mongoose.connect(process.env.MONGODB_URI);
  const monthArg = process.argv.find((arg) => arg.startsWith('--months='));
  const months = monthArg ? monthArg.slice('--months='.length).split(',').map((value) => value.trim()) : null;
  const result = await syncDocuments({ includeHistory: process.argv.includes('--history'), months,
    commit: !process.argv.includes('--dry-run') });
  console.log(JSON.stringify(result, null, 2));
  if (result.state !== 'COMPLETED' || result.months?.some((month) => month.state === 'DIFFERENT')) process.exitCode = 1;
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
