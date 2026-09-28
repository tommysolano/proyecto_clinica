#!/usr/bin/env node
'use strict';

/**
 * Comisiones > Doctores: el índice único de las tarifas por doctor pasa a
 * incluir el ALCANCE (`doctorCommissionScope`) (sep-2026).
 *
 * El índice viejo `uniq_doctor_appointment_service_commission` era
 * { clinic, doctorServiceDoctor, appointmentService }: con él no pueden convivir
 * la base por paciente y la base por DERIVACIÓN (las dos con
 * `appointmentService: null`), ni la tarifa por atender un servicio con la de
 * derivarlo. Este script crea el índice nuevo (más estricto en nada: su clave es
 * un superconjunto de la vieja, así que no puede chocar con datos existentes) y
 * luego retira el viejo.
 *
 * Idempotente: puede correr en cada despliegue. Sin --commit solo informa.
 *
 *   node scripts/relaxDoctorCommissionRuleIndex.js
 *   node scripts/relaxDoctorCommissionRuleIndex.js --commit
 */

require('dotenv').config();
const mongoose = require('mongoose');
const CommissionRule = require('../models/CommissionRule');

const VIEJO = 'uniq_doctor_appointment_service_commission';
const NUEVO = 'uniq_doctor_commission_scope_service';

async function main() {
  const commit = process.argv.includes('--commit');
  if (!process.env.MONGODB_URI) throw new Error('Falta MONGODB_URI');
  await mongoose.connect(process.env.MONGODB_URI);

  const coll = CommissionRule.collection;
  const indexes = await coll.indexes().catch(() => []);
  const viejo = indexes.find((i) => i.name === VIEJO);
  const nuevo = indexes.find((i) => i.name === NUEVO);
  console.log(JSON.stringify({
    mode: commit ? 'COMMIT' : 'DRY_RUN',
    indiceViejo: viejo ? 'presente' : 'ausente',
    indiceNuevo: nuevo ? 'presente' : 'ausente',
  }));
  if (!commit) return;

  if (!nuevo) {
    await coll.createIndex(
      { clinic: 1, doctorServiceDoctor: 1, appointmentService: 1, doctorCommissionScope: 1 },
      { unique: true, partialFilterExpression: { managedFromDoctorCommissions: true }, name: NUEVO }
    );
    console.log('Índice nuevo creado (doctor + servicio + alcance).');
  }
  if (viejo) {
    await coll.dropIndex(VIEJO);
    console.log('Índice viejo retirado: ya pueden convivir la tarifa por paciente y la de derivación.');
  }
}

if (require.main === module) main()
  .catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
