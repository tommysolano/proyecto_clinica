/**
 * Normaliza `PurchaseInvoice.fechaEmision` al MEDIODÍA LOCAL de la fecha calendario elegida.
 *
 * BUG que corrige (casillero 332 en cero): el formulario de compras enviaba la fecha del
 * date-picker como `new Date("YYYY-MM-DD")` = MEDIANOCHE UTC. En Ecuador (UTC−5) eso es el día
 * ANTERIOR a las 19:00, así que una compra del día 1 caía en el mes anterior y desaparecía del
 * rango local del 103/104 (el 332 no la sumaba). Anclando al mediodía local, la fecha cae siempre
 * dentro de su mismo día calendario y el comprobante se declara en su mes real.
 *
 * Usa la MISMA función que ya normaliza las compras nuevas (utils/dates → invoiceDate): toma las
 * partes UTC (la fecha que el usuario escogió) y las reancla al mediodía local. Es IDEMPOTENTE:
 * volver a correrlo no cambia nada. Solo reescribe las compras cuya fecha efectivamente cambia
 * (las que ya estaban a mediodía local se dejan intactas).
 *
 * Uso:
 *   node scripts/migratePurchaseFechaEmision.js           (dry-run: solo muestra)
 *   node scripts/migratePurchaseFechaEmision.js --commit  (aplica los cambios)
 *
 * OJO: el .env local apunta a la base de PRODUCCIÓN. Preferir ejecutarlo en el VPS.
 * El proceso fuerza TZ=America/Guayaquil para que "mediodía local" sea el de Ecuador.
 */
process.env.TZ = process.env.TZ || 'America/Guayaquil';
require('dotenv').config();
const mongoose = require('mongoose');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const { invoiceDate } = require('../utils/dates');

const iso = (d) => (d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : String(d));

async function main() {
  const commit = process.argv.includes('--commit');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Modo: ${commit ? 'COMMIT (escribe)' : 'DRY-RUN (solo muestra)'} · TZ=${process.env.TZ}`);

  const cursor = PurchaseInvoice.find({ fechaEmision: { $ne: null } })
    .select('serie fechaEmision docType status').cursor();

  let total = 0;
  let cambian = 0;
  let cruzanMes = 0; // los realmente afectados por el bug (cambian de mes)
  const ejemplos = [];

  for (let p = await cursor.next(); p != null; p = await cursor.next()) {
    total += 1;
    const original = p.fechaEmision;
    const normal = invoiceDate(original);
    if (!(normal instanceof Date) || Number.isNaN(normal.getTime())) continue;
    if (normal.getTime() === original.getTime()) continue;
    cambian += 1;
    const cambiaMes = original.getMonth() !== normal.getMonth() || original.getFullYear() !== normal.getFullYear();
    if (cambiaMes) cruzanMes += 1;
    if (ejemplos.length < 20) {
      ejemplos.push({ serie: p.serie || String(p._id), status: p.status, antes: iso(original), despues: iso(normal), cambiaMes });
    }
    if (commit) {
      await PurchaseInvoice.updateOne({ _id: p._id }, { $set: { fechaEmision: normal } });
    }
  }

  console.log(`\nCompras revisadas: ${total}`);
  console.log(`Fechas que cambian (se reanclan a mediodía local): ${cambian}`);
  console.log(`  de ellas, cambian de MES local (las que el bug sacaba de su declaración): ${cruzanMes}`);
  if (ejemplos.length) {
    console.log('\nEjemplos:');
    for (const e of ejemplos) {
      console.log(`  ${e.cambiaMes ? '⚠ MES' : '  '} ${e.serie} [${e.status}]  ${e.antes}  →  ${e.despues}`);
    }
  }
  if (!commit && cambian) console.log('\n(Revisa la lista y vuelve a correr con --commit para aplicar.)');
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
