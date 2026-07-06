/**
 * Carga el catálogo CIE-10 en la colección `cie10s` (global, no por clínica).
 *
 *   node scripts/seedCie10.js                    -> siembra el subconjunto común
 *   node scripts/seedCie10.js --file=cie10.json  -> carga catálogo oficial completo
 *
 * El archivo puede ser:
 *   - JSON: array de { code, description, chapter? }
 *   - CSV : columnas code,description[,chapter] (con o sin cabecera)
 *
 * Es idempotente: hace upsert por `code`, así que se puede correr varias veces.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Cie10 = require('../models/Cie10');

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    // Separador ; o , (los catálogos del MSP suelen venir con ;)
    const parts = lines[i].split(/[;,]/);
    const code = (parts[0] || '').trim().replace(/^"|"$/g, '');
    const description = (parts[1] || '').trim().replace(/^"|"$/g, '');
    const chapter = (parts[2] || '').trim().replace(/^"|"$/g, '');
    // Salta la fila de cabecera si la primera celda no parece un código CIE.
    if (i === 0 && !/^[A-Z]\d/i.test(code)) continue;
    if (code && description) rows.push({ code, description, chapter });
  }
  return rows;
}

async function main() {
  const fileArg = process.argv.find((a) => a.startsWith('--file='));
  let data;
  if (fileArg) {
    const filePath = path.resolve(fileArg.split('=')[1]);
    const raw = fs.readFileSync(filePath, 'utf8');
    data = filePath.toLowerCase().endsWith('.json') ? JSON.parse(raw) : parseCsv(raw);
    console.log(`Archivo: ${filePath} (${data.length} códigos)`);
  } else {
    data = require('../data/cie10Common.js');
    console.log(`Subconjunto común (${data.length} códigos). Usa --file=<archivo> para el catálogo oficial.`);
  }

  if (!process.env.MONGODB_URI) throw new Error('Falta MONGODB_URI en el entorno (.env)');
  await mongoose.connect(process.env.MONGODB_URI);

  let ok = 0;
  const ops = data
    .filter((d) => d && d.code && d.description)
    .map((d) => ({
      updateOne: {
        filter: { code: String(d.code).toUpperCase().trim() },
        update: {
          $set: {
            code: String(d.code).toUpperCase().trim(),
            description: String(d.description).trim(),
            chapter: d.chapter ? String(d.chapter).trim() : '',
          },
        },
        upsert: true,
      },
    }));

  // En lotes para no saturar la conexión con catálogos grandes.
  const BATCH = 1000;
  for (let i = 0; i < ops.length; i += BATCH) {
    const res = await Cie10.bulkWrite(ops.slice(i, i + BATCH), { ordered: false });
    ok += (res.upsertedCount || 0) + (res.modifiedCount || 0) + (res.matchedCount || 0);
  }

  const total = await Cie10.countDocuments();
  console.log(`Procesados: ${ok}. Total en catálogo: ${total}.`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error('Error en seedCie10:', e.message);
  process.exit(1);
});
