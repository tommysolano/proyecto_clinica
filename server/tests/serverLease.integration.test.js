/**
 * Exclusión mutua del arriendo de 'jobs' (elección de líder).
 *
 * Reproduce la causa raíz de los mensajes DUPLICADOS y de los "fallidos" fantasma:
 * DOS backends vivos contra la misma base. El arriendo garantiza que solo UNO
 * ejecuta los jobs y las sesiones QR. Aquí se comprueba la primitiva atómica:
 *   - dos poseedores compitiendo → solo uno consigue el arriendo,
 *   - mientras el arriendo esté vigente, el otro NO lo puede tomar,
 *   - cuando vence, el otro sí lo toma (relevo automático).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');
const ServerLease = require('../models/ServerLease');

const JOBS_ROLE = 'jobs';
const LEASE_MS = 2 * 60 * 1000;

// Copia de la primitiva de instanceRegistry.acquireJobsLease, parametrizada por
// poseedor, "ahora" y si es PRIMARIO, para simular procesos y el paso del tiempo.
async function tryAcquire(holder, now, amPrimary = false) {
  const expiresAt = new Date(now.getTime() + LEASE_MS);
  const or = [{ holder }, { expiresAt: { $lte: now } }];
  if (amPrimary) or.push({ primary: { $ne: true } });
  try {
    await ServerLease.findOneAndUpdate(
      { _id: JOBS_ROLE, $or: or },
      { $set: { holder, host: 'h', pid: 1, primary: amPrimary, expiresAt, renewedAt: now } },
      { upsert: true, new: true }
    );
    return true;
  } catch (err) {
    if (err?.code !== 11000) throw err;
    return false;
  }
}

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

test('solo UN proceso consigue el arriendo de jobs', async () => {
  const now = new Date('2026-07-23T12:00:00Z');
  const a = await tryAcquire('A:1', now);
  const b = await tryAcquire('B:2', now);
  assert.equal(a, true, 'el primero toma el arriendo');
  assert.equal(b, false, 'el segundo NO puede: ya hay líder');

  const lease = await ServerLease.findById(JOBS_ROLE).lean();
  assert.equal(lease.holder, 'A:1');

  // El líder renueva sin problema (es su propio arriendo).
  const renew = await tryAcquire('A:1', new Date(now.getTime() + 30000));
  assert.equal(renew, true);
});

test('un proceso PRIMARIO arrebata el liderazgo a uno NO primario (aunque no haya vencido)', async () => {
  const t0 = new Date('2026-07-23T12:00:00Z');
  // Un backend de sobra (p.ej. Render), NO primario, toma el arriendo primero.
  assert.equal(await tryAcquire('render:1', t0, false), true);
  // El servidor de PRODUCCIÓN (primario) arranca y lo arrebata en el acto.
  assert.equal(await tryAcquire('vps:1', new Date(t0.getTime() + 5000), true), true);
  let lease = await ServerLease.findById(JOBS_ROLE).lean();
  assert.equal(lease.holder, 'vps:1');
  assert.equal(lease.primary, true);

  // Y el backend de sobra ya NO puede arrebatárselo al primario (arriendo vigente).
  assert.equal(await tryAcquire('render:1', new Date(t0.getTime() + 10000), false), false);
  lease = await ServerLease.findById(JOBS_ROLE).lean();
  assert.equal(lease.holder, 'vps:1', 'el primario conserva el liderazgo');
});

test('cuando el arriendo vence, otro proceso lo toma (relevo)', async () => {
  const t0 = new Date('2026-07-23T12:00:00Z');
  assert.equal(await tryAcquire('A:1', t0), true);

  // A los 90 s el arriendo de A sigue vivo (dura 120 s) → B no puede.
  assert.equal(await tryAcquire('B:2', new Date(t0.getTime() + 90 * 1000)), false);

  // Pasados los 120 s sin que A renueve, el arriendo venció → B lo toma.
  assert.equal(await tryAcquire('B:2', new Date(t0.getTime() + 121 * 1000)), true);
  const lease = await ServerLease.findById(JOBS_ROLE).lean();
  assert.equal(lease.holder, 'B:2');
});
