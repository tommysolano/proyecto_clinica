#!/usr/bin/env node
'use strict';
require('dotenv').config();
const { ContificoApi } = require('../services/contificoApi');

async function main() {
  const api = new ContificoApi({ apiKey: process.env.CONTIFICO_API_KEY, retries: 1, timeoutMs: 20000 });
  const codes = new Map((await api.listV1('/api/v1/contabilidad/cuenta-contable/'))
    .map((row) => [row.id, row.codigo]));
  const rows = [];
  for await (const page of api.pages('/api/v2/contabilidad/asiento/',
    { fecha_inicial: '30/09/2026', fecha_final: '30/09/2026' }, 100, {})) rows.push(...page.rows);
  const selected = rows.filter((row) => /COMISION|ANTICIPO/i.test(row.glosa || '') &&
    row.detalles?.some((line) => line.cuenta_id === 'RMdR77ROsv8vEel6' && line.tipo === 'D'));
  console.log(JSON.stringify({ total: rows.length, matches: selected.map((row) => ({ id: row.id, date: row.fecha,
    glosa: row.glosa, lines: row.detalles.map((line) => ({ code: codes.get(line.cuenta_id), type: line.tipo,
      value: Number(line.valor), center: line.centro_costo_id })) })) }, null, 2));
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
