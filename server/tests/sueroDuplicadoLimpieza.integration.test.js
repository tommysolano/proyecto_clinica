/**
 * LIMPIEZA DE LOS SUEROS QUE SE ESCRIBIERON DOS VECES.
 *
 * El arreglo del duplicado (ver `sueroDesdeLaCita`, T15/T16) cierra la puerta,
 * pero no borra lo que ya está en las fichas. Este script las repasa — y como
 * borra de una historia clínica, lo que se vigila aquí es sobre todo lo que NO
 * debe tocar: lo que escribió un médico a mano, dos bolsas distintas del mismo
 * día, y cualquier bolsa que enfermería ya haya aplicado (eso movió inventario y
 * es lo que de verdad pasó).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const ClinicalRecord = require('../models/ClinicalRecord');
const Patient = require('../models/Patient');
const { diagnose, limpiar } = require('../scripts/diagnoseDuplicateSerums');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const DETOX = { code: 'NOVDE01', name: 'SUEROTERAPIA DETOX PLUS', grupo: 'ampolla', quantity: 1 };

/** Una línea de receta de suero, como la escribe `lineaDeRecetaDeSuero`. */
const lineaSuero = (name, extra = {}) => ({
  name,
  isSerum: true,
  serumBase: { name: 'Cloruro', volumeMl: 250 },
  serumComponents: [{ ...DETOX }],
  ...extra,
});

/** Un seguimiento escrito POR EL SISTEMA (el motivo es lo que lo delata). */
const auto = (name, extra = {}) => ({
  fecha: new Date(),
  motivoConsulta: `Suero indicado al agendar (${name})`,
  descripcion: `Suero indicado al agendar (${name})`,
  recetaItems: [lineaSuero(name, extra.item || {})],
  ...(extra.fu || {}),
});

async function fichaCon(followUps) {
  const { clinicId } = await H.seedClinic();
  const patient = await Patient.create({ clinic: clinicId, firstName: 'Andrés', lastName: 'Ramos' });
  const rec = await ClinicalRecord.create({ clinic: clinicId, patient: patient._id, followUps });
  return { clinicId, patient, rec };
}

test('encuentra la bolsa escrita dos veces el mismo día y conserva la primera', async () => {
  const { rec } = await fichaCon([auto('Detox Plus'), auto('Detox Plus')]);

  const { grupos, revisar } = await diagnose({});
  assert.equal(grupos.length, 1);
  assert.equal(revisar.length, 0);
  assert.equal(grupos[0].total, 2);
  assert.equal(grupos[0].borrar.length, 1, 'sobra una');

  const antes = await ClinicalRecord.findById(rec._id).lean();
  assert.equal(String(grupos[0].conservar), String(antes.followUps[0]._id), 'se queda la más antigua');

  assert.equal(await limpiar(grupos), 1);
  const despues = await ClinicalRecord.findById(rec._id).lean();
  assert.equal(despues.followUps.length, 1);
  assert.equal(String(despues.followUps[0]._id), String(antes.followUps[0]._id));
});

test('NO toca lo que escribió un médico a mano, aunque sea el mismo suero', async () => {
  const manual = {
    fecha: new Date(),
    motivoConsulta: 'Control por cansancio',
    recetaItems: [lineaSuero('Detox Plus')],
  };
  const { rec } = await fichaCon([auto('Detox Plus'), manual]);

  const { grupos } = await diagnose({});
  assert.equal(grupos.length, 0, 'una receta del médico no es una copia del sistema');
  assert.equal((await ClinicalRecord.findById(rec._id)).followUps.length, 2);
});

test('dos bolsas DISTINTAS el mismo día son dos indicaciones, no una repetida', async () => {
  const otra = auto('Hepatoprotector');
  otra.recetaItems[0].serumComponents = [{ code: 'HEP01', name: 'HEPATO', grupo: 'ampolla', quantity: 2 }];
  const { rec } = await fichaCon([auto('Detox Plus'), otra]);

  assert.equal((await diagnose({})).grupos.length, 0);
  assert.equal((await ClinicalRecord.findById(rec._id)).followUps.length, 2);
});

test('la copia que enfermería YA APLICÓ no se borra: se reporta para mirarla a mano', async () => {
  const aplicada = auto('Detox Plus', {
    item: { administrations: [{ at: new Date(), byName: 'Enf', baseVolumeMl: 250 }] },
  });
  const { rec } = await fichaCon([auto('Detox Plus'), aplicada]);

  const { grupos, revisar } = await diagnose({});
  assert.equal(grupos.length, 0, 'no hay nada seguro que borrar');
  assert.equal(revisar.length, 1);
  assert.equal(revisar[0].aplicados.length, 1);
  assert.equal((await ClinicalRecord.findById(rec._id)).followUps.length, 2, 'siguen las dos');
});

test('una bolsa sola no se toca', async () => {
  const { rec } = await fichaCon([auto('Detox Plus')]);
  assert.equal((await diagnose({})).grupos.length, 0);
  assert.equal((await ClinicalRecord.findById(rec._id)).followUps.length, 1);
});

test('tres copias dejan una', async () => {
  const { rec } = await fichaCon([auto('Detox Plus'), auto('Detox Plus'), auto('Detox Plus')]);
  const { grupos } = await diagnose({});
  assert.equal(grupos[0].borrar.length, 2);
  assert.equal(await limpiar(grupos), 2);
  assert.equal((await ClinicalRecord.findById(rec._id)).followUps.length, 1);
});
