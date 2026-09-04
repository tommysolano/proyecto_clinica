/**
 * EL VIGILANTE DE LA IMPORTACIÓN DE FICHAS (scripts/desatascarImportacionFichas.js).
 *
 * Existe por lo que pasó de verdad: el kernel del VPS mató el Chromium del reductor,
 * cada foto pasó a tardar los tres minutos del `protocolTimeout` de puppeteer, y la
 * tanda siguió "avanzando" a una ficha cada seis minutos — dieciséis días para
 * terminar. Y como el proceso seguía vivo, su latido dejaba la marca de
 * `onetimetasks` en RUNNING y fresca, así que ningún despliegue se atrevía a
 * relanzar encima: había que entrar al servidor a matarla a mano.
 *
 * Lo que se prueba: que distingue "va lenta" de "no va", que no mata lo que
 * funciona, y que al desbloquear deja la marca de forma que el siguiente intento la
 * REANUDE (FAILED) en vez de darla por buena (DONE).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const H = require('./_integrationHelpers');

const { main, CLAVE } = require('../scripts/desatascarImportacionFichas');
const Patient = require('../models/Patient');
const { mongoose } = require('../scripts/_common');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
const tareas = () => mongoose.connection.db.collection('onetimetasks');

test.beforeEach(async () => {
  await H.resetDb();
  // `onetimetasks` no es un modelo de mongoose, así que resetDb no la vacía y la
  // marca de un test se colaría en el siguiente.
  await tareas().deleteMany({});
});

const marcaEnCurso = (extra = {}) => tareas().insertOne({
  _id: CLAVE,
  status: 'RUNNING',
  host: os.hostname(),
  pid: 999999, // no existe: matarlo es un ESRCH, que el script trata como "ya no estaba"
  startedAt: new Date(),
  attempts: 1,
  ...extra,
});

/** Espía que cuenta si se pidió matar, sin mandar señales de verdad. */
const espia = () => {
  const llamadas = [];
  return { llamadas, matar: (pid) => { llamadas.push(pid); return [`proceso ${pid}`]; } };
};

test('V1) si no hay ninguna tanda corriendo, no se mete donde no le llaman', async () => {
  await H.seedClinic();
  const r = await main({ commit: true, esperaMs: 10 });
  assert.equal(r.atascada, false);

  await tareas().insertOne({ _id: CLAVE, status: 'DONE', finishedAt: new Date() });
  const r2 = await main({ commit: true, esperaMs: 10 });
  assert.equal(r2.atascada, false, 'una tanda terminada no se toca');
  assert.equal((await tareas().findOne({ _id: CLAVE })).status, 'DONE');
});

test('V2) una tanda que avanza se deja trabajar, por lenta que vaya', async () => {
  const { clinicId } = await H.seedClinic();
  await marcaEnCurso();
  const ojo = espia();

  // Una sola ficha nueva mientras se mira: es lenta, pero está viva.
  const avanzar = setTimeout(() => {
    Patient.create({
      clinic: clinicId, firstName: 'Ana', lastName: 'Vera',
      scanImport: { scan: new mongoose.Types.ObjectId(), importadoAt: new Date() },
    }).catch(() => {});
  }, 50);
  avanzar.unref?.();

  const r = await main({ commit: true, esperaMs: 900, matarProceso: ojo.matar });

  assert.equal(r.atascada, false);
  assert.deepEqual(ojo.llamadas, [], 'no se mata a quien está trabajando');
  assert.equal((await tareas().findOne({ _id: CLAVE })).status, 'RUNNING');
});

test('V3) una tanda viva pero parada se mata y se deja lista para reanudar', async () => {
  await H.seedClinic();
  await marcaEnCurso();
  const ojo = espia();

  const r = await main({ commit: true, esperaMs: 300, matarProceso: ojo.matar });

  assert.equal(r.atascada, true);
  assert.deepEqual(ojo.llamadas, [999999], 'se mata el pid que dice la marca');

  const marca = await tareas().findOne({ _id: CLAVE });
  assert.equal(marca.status, 'FAILED', 'FAILED y no DONE: es lo que hace que se reanude sola');
  assert.match(marca.error, /atascada/);
});

test('V4) sin --commit solo diagnostica: no mata ni desbloquea', async () => {
  await H.seedClinic();
  await marcaEnCurso();
  const ojo = espia();

  const r = await main({ esperaMs: 300, matarProceso: ojo.matar });

  assert.equal(r.atascada, true, 'lo dice…');
  assert.deepEqual(ojo.llamadas, [], '…pero no toca nada');
  assert.equal((await tareas().findOne({ _id: CLAVE })).status, 'RUNNING');
});

test('V5) no mata un proceso de OTRA máquina: ese pid no es suyo', async () => {
  // Con dos backends, el pid 999999 de aquí es cualquier cosa allí. Matar a ciegas
  // por número sería peor que dejarlo atascado.
  await H.seedClinic();
  await marcaEnCurso({ host: 'otro-servidor' });
  const ojo = espia();

  const r = await main({ commit: true, esperaMs: 300, matarProceso: ojo.matar });

  assert.equal(r.atascada, true);
  assert.equal(r.matada, false);
  assert.deepEqual(ojo.llamadas, []);
  assert.equal((await tareas().findOne({ _id: CLAVE })).status, 'RUNNING', 'la desbloquea quien pueda matarla');
});
