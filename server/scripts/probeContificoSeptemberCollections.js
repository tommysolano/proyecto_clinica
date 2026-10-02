#!/usr/bin/env node
'use strict';
require('dotenv').config();
const { ContificoApi } = require('../services/contificoApi');
async function main() {
  const api = new ContificoApi({ apiKey: process.env.CONTIFICO_API_KEY, retries: 1, timeoutMs: 20000 });
  const reports = [];
  for (const page of [1, 2, 3]) {
    const rows = await api.listV1('/api/v1/registro/transaccion/', {
      fecha_inicial: '30/09/2026', fecha_final: '30/09/2026', result_size: 1000, result_page: page });
    const sep = rows.filter((row) => row.tipo === 'C' && row.fecha_emision === '30/09/2026');
    reports.push({ page, returned: rows.length, firstId: rows[0]?.id, firstDate: rows[0]?.fecha_emision,
      lastId: rows.at(-1)?.id, lastDate: rows.at(-1)?.fecha_emision,
      sep30Collections: sep.length, sep30Total: +sep.reduce((sum, row) => sum + Number(row.total || 0), 0).toFixed(2),
      sep30Ids: sep.map((row) => row.id) });
  }
  const overlaps = reports.slice(1).map((row, index) => ({ page: row.page,
    sameIds: row.sep30Ids.filter((id) => reports[0].sep30Ids.includes(id)).length }));
  console.log(JSON.stringify({ pages: reports.map(({ sep30Ids, ...row }) => row), overlaps }, null, 2));
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
