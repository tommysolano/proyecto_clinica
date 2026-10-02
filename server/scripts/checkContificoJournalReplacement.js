#!/usr/bin/env node
'use strict';
require('dotenv').config();
const { ContificoApi } = require('../services/contificoApi');

async function main() {
  const api = new ContificoApi({ apiKey: process.env.CONTIFICO_API_KEY, retries: 0, timeoutMs: 20000 });
  for (const id of ['BXdLAxklviR5RKeJ', 'xgep9xLKNTnPnma1']) {
    try {
      const row = await api.get(`/api/v2/contabilidad/asiento/${id}/`);
      console.log(JSON.stringify({ id, status: 'LIVE', fecha: row.fecha, glosa: row.glosa,
        detalles: row.detalles }));
    } catch (error) {
      console.log(JSON.stringify({ id, status: error.status || 'ERROR', message: error.message }));
    }
  }
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
