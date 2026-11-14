#!/usr/bin/env node
/**
 * ENLAZA AL PACIENTE LAS VENTAS QUE SE FACTURARON A SU CÉDULA SIN ELEGIRLO (nov-2026).
 *
 * Hasta ahora, facturar desde la página de Facturación a la persona «Cliente» (migrada de
 * Contífico) o escribiendo la cédula a mano dejaba la venta sin paciente, aunque fuera la
 * misma persona. Desde nov-2026 `createSale` las enlaza solo (utils/pacientePorCedula); este
 * script corrige las que ya existen con la misma regla:
 *   · identificación = cédula del paciente, o RUC de persona natural (cédula + 001);
 *   · solo si hay UN paciente con esa cédula (con duplicados no se adivina);
 *   · nunca Consumidor Final.
 * Además escribe la compra en las Observaciones del paciente (como las ventas nuevas).
 *
 * Uso:  node scripts/enlazarVentasAPacienteOnce.js            (DRY-RUN: solo cuenta)
 *       node scripts/enlazarVentasAPacienteOnce.js --commit   (aplica)
 * Repetirlo es inofensivo: solo toca ventas que siguen sin paciente.
 */
const { connect, disconnect, parseArgs } = require('./_common');
const Sale = require('../models/Sale');
require('../models/Patient');
require('../models/User');
require('../models/Product');
const { pacientePorCedula } = require('../utils/pacientePorCedula');
const { registrarVenta } = require('../utils/observacionesAutomaticas');

async function enlazar({ commit = false, log = console.log } = {}) {
  const ventas = await Sale.find({
    $or: [{ patient: null }, { patient: { $exists: false } }],
    clientCedula: { $nin: [null, '', '9999999999999'] },
  }).select('_id clientCedula clientName createdBy').lean();
  log(`Ventas sin paciente con identificación: ${ventas.length}`);

  const cache = new Map();
  const enlaces = [];
  for (const v of ventas) {
    const ced = String(v.clientCedula || '').trim();
    if (!cache.has(ced)) cache.set(ced, await pacientePorCedula(ced));
    const pid = cache.get(ced);
    if (pid) enlaces.push({ venta: v, patient: pid });
  }
  log(`Ventas que son de un paciente: ${enlaces.length}`);
  enlaces.slice(0, 30).forEach(({ venta }) => log(`  · ${venta.clientName || '—'} (${venta.clientCedula})`));
  if (!commit) {
    log('\nDRY-RUN: usa --commit para enlazarlas.');
    return { candidatas: ventas.length, enlazables: enlaces.length, dryRun: true };
  }

  let hechas = 0;
  for (const { venta, patient } of enlaces) {
    const r = await Sale.updateOne(
      { _id: venta._id, $or: [{ patient: null }, { patient: { $exists: false } }] },
      { $set: { patient } },
      { timestamps: false },
    );
    if (r.modifiedCount) {
      hechas += 1;
      await registrarVenta(venta._id, venta.createdBy, { fechaOriginal: true });
    }
  }
  log(`\n✅ ${hechas} venta(s) enlazadas a su paciente.`);
  return { enlazadas: hechas };
}

async function main() {
  const { commit } = parseArgs();
  console.log(`\n=== Enlazar ventas a su paciente por cédula (${commit ? 'COMMIT' : 'DRY-RUN'}) ===\n`);
  await connect();
  try { await enlazar({ commit }); } finally { await disconnect(); }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { enlazar };
