#!/usr/bin/env node
'use strict';
require('dotenv').config();
const { ContificoApi } = require('../services/contificoApi');

async function main() {
  const api = new ContificoApi({ apiKey: process.env.CONTIFICO_API_KEY, retries: 1, timeoutMs: 20000 });
  for (const params of [
    { fecha_inicial: '30/09/2026', fecha_final: '30/09/2026', result_size: 1000, result_page: 1 },
    { fecha_inicio: '30/09/2026', fecha_fin: '30/09/2026', result_size: 1000, result_page: 1 },
  ]) {
    const rows = await api.listV1('/api/v1/registro/transaccion/', params);
    const sep = rows.filter((row) => String(row.fecha_emision).endsWith('/09/2026'));
    const sepPay = sep.filter((row) => row.tipo === 'P');
    console.log(JSON.stringify({ params, returned: rows.length,
      firstDate: rows[0]?.fecha_emision, lastDate: rows.at(-1)?.fecha_emision,
      september: sep.length, septemberPayments: sepPay.length,
      sepPay: sepPay.map((row) => ({ id: row.id, date: row.fecha_emision,
        total: row.total, reference: row.numero_comprobante, form: row.forma })) }));
  }
  for (const id of ['Ejb2Rn13JUpAp1bV', 'mBdJZV752hqPqZd0', 'BXdLgX5oAuR5RKbJ', '9jaKOWAVMT202Oak']) {
    const row = await api.get(`/api/v1/registro/transaccion/${id}/`);
    console.log(JSON.stringify({ id, row }));
  }
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
