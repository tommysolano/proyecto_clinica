#!/usr/bin/env node
'use strict';
require('dotenv').config();
const { ContificoApi } = require('../services/contificoApi');

async function main() {
  const api = new ContificoApi({ apiKey: process.env.CONTIFICO_API_KEY, retries: 0, timeoutMs: 20000 });
  const ids = ['YjbqlWynyT8G8ZaL', 'loej0NmMlHnkn8bQ', 'xmbmYgp09TjGjzbo', 'JvaMJxlNGSqGqXbp'];
  for (const id of ids) {
    const row = await api.get(`/api/v2/documento/${id}/`);
    console.log(JSON.stringify({ id, fecha: row.fecha_emision, creado: row.fecha_creacion, numero: row.documento,
      tipo: row.tipo_documento, descripcion: row.descripcion, persona_id: row.persona_id,
      total: row.total, saldo: row.saldo, detalles: row.detalles }));
  }
  for (const [from, through] of [['30/09/2026', '30/09/2026'], ['01/10/2026', '01/10/2026']]) {
    const matches = [];
    for await (const page of api.pages('/api/v2/contabilidad/asiento/',
      { fecha_inicial: from, fecha_final: through }, 100, {}))
      matches.push(...page.rows.filter((row) => /ANTICIPO COMISI[OÓ]N ERNESTO ARDILA/i.test(row.glosa)));
    console.log(JSON.stringify({ from, through, matches: matches.map((row) => ({ id: row.id,
      fecha: row.fecha, glosa: row.glosa, detalles: row.detalles })) }));
  }
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
