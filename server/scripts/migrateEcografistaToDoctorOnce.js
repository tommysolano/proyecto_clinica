#!/usr/bin/env node
/**
 * EL ROL 'ecografista' PASA A 'doctor' — UNA SOLA VEZ.
 *
 * ─── POR QUÉ ───────────────────────────────────────────────────────────────────────
 * Se creó un rol propio para quien hace ecografías porque su consulta era distinta:
 * no explora, no receta, solo sube la imagen y escribe lo que ve. Resultó que eso no
 * era un rol, era una PESTAÑA («Archivos»), y ahora la tiene cualquier doctor. El rol
 * sobraba y se retiró de `constants/roles.js`.
 *
 * ─── POR QUÉ ES OBLIGATORIA ────────────────────────────────────────────────────────
 * `User.clinics[].role` tiene `enum: VALID_ROLES`. En cuanto 'ecografista' sale de la
 * lista, quien lo tenga guardado:
 *   · recibe 403 en TODA ruta de doctor —`middleware/auth.js` deja de expandirlo—, o
 *     sea que entra al sistema y no puede hacer absolutamente nada;
 *   · tiene el documento INVÁLIDO: el primer `save()` del usuario (reasignarle
 *     sucursales, cambiarle la contraseña) revienta con un error de validación;
 *   · aterriza en el panel que no le toca, porque el `switch` por rol cae al default.
 * Y una `CommissionRule` con `role:'ecografista'` deja de casar con nadie: la persona
 * sigue atendiendo y deja de cobrar su comisión, sin ningún error a la vista.
 *
 * ─── QUÉ HACE ──────────────────────────────────────────────────────────────────────
 *  1. `users.clinics[]`: cada entrada con `role:'ecografista'` pasa a `'doctor'`.
 *     Si la persona YA era 'doctor' en esa misma sucursal quedarían dos entradas para
 *     la misma clínica y `getRoleForClinic` se queda con la primera: la duplicada se
 *     ELIMINA en vez de convertirla.
 *  2. `commissionrules.role`: 'ecografista' → 'doctor'. Si eso deja dos reglas
 *     idénticas no se tocan (una regla de comisión no se borra sola: se avisa).
 *
 * No toca seguimientos ni citas: `ClinicalRecord.createdByRole` es un texto libre y
 * decir que aquella consulta la escribió un ecografista sigue siendo verdad.
 *
 * ─── "UNA SOLA VEZ" ────────────────────────────────────────────────────────────────
 * La marca vive en la base (colección `onetimetasks`, clave TASK_KEY): el despliegue
 * la ejecuta en cada push, pero solo el PRIMERO hace algo. Si falla queda FAILED y el
 * siguiente despliegue la reintenta.
 *
 * ─── USO ───────────────────────────────────────────────────────────────────────────
 *   node scripts/migrateEcografistaToDoctorOnce.js             (DRY-RUN: solo informa)
 *   node scripts/migrateEcografistaToDoctorOnce.js --commit    (aplica una vez y deja marca)
 *   node scripts/migrateEcografistaToDoctorOnce.js --commit --force   (repite aunque esté DONE)
 *   node scripts/migrateEcografistaToDoctorOnce.js --estado    (solo muestra la marca)
 */
const os = require('os');
const { connect, disconnect } = require('./_common');

const OneTimeTask = require('../models/OneTimeTask');
const User = require('../models/User');
const CommissionRule = require('../models/CommissionRule');

const TASK_KEY = 'migrar-ecografista-a-doctor-2026-09-01';
const STALE_RUNNING_MS = 30 * 60 * 1000;

const VIEJO = 'ecografista';
const NUEVO = 'doctor';

/**
 * Convierte el rol donde haga falta. Con `commit: false` no escribe nada.
 *
 * Se escribe con `updateOne` sobre el documento entero y no con un `$set` posicional
 * porque hay que poder BORRAR entradas duplicadas, no solo cambiarlas.
 */
async function migrarEcografistas({ commit = false, log = console.log } = {}) {
  // ── 1. Usuarios ──
  const usuarios = await User.find({ 'clinics.role': VIEJO })
    .select('_id name email clinics')
    .lean();
  log(`   • Usuarios con rol '${VIEJO}' en alguna sucursal: ${usuarios.length}`);

  /**
   * Quién era ecografista EN CADA SUCURSAL. Se calcula ANTES de tocar nada:
   * después de la migración esa información ya no existe en ningún sitio, y es
   * justo la que necesitan las reglas de comisión (ver más abajo).
   */
  const porClinica = new Map();
  for (const u of usuarios) {
    for (const c of u.clinics || []) {
      if (c.role !== VIEJO) continue;
      const k = String(c.clinic);
      if (!porClinica.has(k)) porClinica.set(k, []);
      porClinica.get(k).push(String(u._id));
    }
  }

  let convertidas = 0;
  let duplicadasBorradas = 0;

  for (const u of usuarios) {
    const yaEraDoctorEn = new Set(
      (u.clinics || [])
        .filter((c) => c.role === NUEVO)
        .map((c) => String(c.clinic))
    );
    const siguiente = [];
    const detalle = [];
    for (const c of u.clinics || []) {
      if (c.role !== VIEJO) {
        siguiente.push(c);
        continue;
      }
      if (yaEraDoctorEn.has(String(c.clinic))) {
        // Ya es 'doctor' en esa sede: convertirla dejaría la clínica dos veces y
        // `getRoleForClinic` se queda con la primera que encuentre.
        duplicadasBorradas += 1;
        detalle.push(`${c.clinic} → duplicada, se elimina (ya era ${NUEVO})`);
        continue;
      }
      convertidas += 1;
      yaEraDoctorEn.add(String(c.clinic));
      siguiente.push({ clinic: c.clinic, role: NUEVO });
      detalle.push(`${c.clinic} → ${NUEVO}`);
    }
    log(`   ${commit ? '✅' : '•'} ${u.name || u.email || u._id}: ${detalle.join(' · ')}`);
    if (commit) {
      // eslint-disable-next-line no-await-in-loop
      await User.updateOne({ _id: u._id }, { $set: { clinics: siguiente } });
    }
  }

  /**
   * ── 2. Reglas de comisión ──
   *
   * OJO, ESTO ES DINERO. Cambiar `role: 'ecografista'` por `role: 'doctor'` a
   * secas sería un error caro: una regla por ROL con `role:'doctor'` la cobran
   * TODOS los médicos y todas las especialidades (ver `matchTarget` y
   * `DOCTOR_RULE_HEIRS` en commissionController.js). Una regla que pagaba a una
   * persona pasaría a pagarle a la plantilla entera, sin ningún error a la vista.
   *
   * Por eso la regla por ROL se convierte en una regla POR PERSONA, con las que
   * eran ecografistas en esa sucursal: paga exactamente a quien pagaba.
   *
   * Si no queda nadie, la regla se DESACTIVA. Hoy no paga a nadie (no hay quien
   * tenga ese rol); dejarla como 'doctor' empezaría a pagar a todos.
   */
  const reglas = await CommissionRule.find({ role: VIEJO })
    .select('_id name clinic targetType users user')
    .lean();
  log(`   • Reglas de comisión con role='${VIEJO}': ${reglas.length}`);

  let reglasANombre = 0;
  let reglasDesactivadas = 0;
  for (const r of reglas) {
    if (r.targetType === 'user') {
      // Ya paga a personas concretas: `role` ahí es solo una etiqueta.
      log(`   ${commit ? '✅' : '•'} "${r.name || r._id}" (por persona) → role='${NUEVO}'`);
      // eslint-disable-next-line no-await-in-loop
      if (commit) await CommissionRule.updateOne({ _id: r._id }, { $set: { role: NUEVO } });
      continue;
    }
    const gente = porClinica.get(String(r.clinic)) || [];
    if (!gente.length) {
      reglasDesactivadas += 1;
      log(`   ${commit ? '⚠️ ' : '•'} "${r.name || r._id}" (por rol, SIN nadie con ese rol) → se DESACTIVA`);
      // eslint-disable-next-line no-await-in-loop
      if (commit) await CommissionRule.updateOne({ _id: r._id }, { $set: { active: false, role: NUEVO } });
      continue;
    }
    reglasANombre += 1;
    log(`   ${commit ? '✅' : '•'} "${r.name || r._id}" (por rol) → por persona, a ${gente.length} usuario(s)`);
    // eslint-disable-next-line no-await-in-loop
    if (commit) {
      // `role` se vacía: en una regla por persona no se usa (matchTarget corta
      // en targetType==='user'), y dejarlo en 'doctor' sería una trampa esperando
      // a que alguien devuelva la regla a «por rol» y empiece a pagar a todos.
      await CommissionRule.updateOne({ _id: r._id }, {
        $set: { targetType: 'user', users: gente, user: gente[0], role: '' },
      });
    }
  }

  const stats = {
    usuarios: usuarios.length,
    entradasConvertidas: convertidas,
    entradasDuplicadasBorradas: duplicadasBorradas,
    reglasComision: reglas.length,
    reglasPasadasANombre: reglasANombre,
    reglasDesactivadas,
  };

  if (!commit) {
    log(`\nDRY-RUN: se convertirían ${convertidas} asignación(es) de sucursal`
      + `${duplicadasBorradas ? `, se borrarían ${duplicadasBorradas} duplicada(s)` : ''}`
      + ` y ${reglas.length} regla(s) de comisión`
      + `${reglasANombre ? ` (${reglasANombre} pasarían a ser por persona)` : ''}`
      + `${reglasDesactivadas ? ` (${reglasDesactivadas} se desactivarían por no tener a nadie)` : ''}.`);
    log('Ejecuta con --commit para aplicar.');
    return { ...stats, dryRun: true };
  }
  log(`\n✅  ${convertidas} asignación(es) convertidas a '${NUEVO}'`
    + `${duplicadasBorradas ? ` · ${duplicadasBorradas} duplicada(s) eliminadas` : ''}`
    + ` · ${reglas.length} regla(s) de comisión migradas`
    + `${reglasDesactivadas ? ` (${reglasDesactivadas} DESACTIVADAS: revísalas)` : ''}.`);

  // Comprobación final: si queda alguno, el despliegue tiene que enterarse.
  const quedan = await User.countDocuments({ 'clinics.role': VIEJO });
  if (quedan) throw new Error(`Quedaron ${quedan} usuario(s) con rol '${VIEJO}'`);
  return stats;
}

/** Envoltorio "una sola vez": reclama la marca de forma atómica y deja constancia. */
async function runOnce({ key = TASK_KEY, force = false, log = console.log } = {}) {
  const previa = await OneTimeTask.findById(key).lean();
  if (previa && !force) {
    if (previa.status === 'DONE') {
      log(`⏭️  Tarea "${key}" ya ejecutada el ${previa.finishedAt?.toISOString?.() || '—'}: no se hace nada.`);
      return { skipped: true, status: 'DONE' };
    }
    if (previa.status === 'RUNNING' && Date.now() - new Date(previa.startedAt).getTime() < STALE_RUNNING_MS) {
      log(`⏭️  Tarea "${key}" en ejecución por ${previa.host} (pid ${previa.pid}): no se hace nada.`);
      return { skipped: true, status: 'RUNNING' };
    }
    log(`↻  Intento anterior de "${key}" quedó en ${previa.status}: se reintenta.`);
  }

  const marca = {
    status: 'RUNNING', host: os.hostname(), pid: process.pid, startedAt: new Date(),
    finishedAt: null, error: '', result: null,
  };
  if (previa) {
    await OneTimeTask.updateOne({ _id: key }, { $set: marca, $inc: { attempts: 1 } });
  } else {
    try {
      await OneTimeTask.create({ _id: key, ...marca, attempts: 1 });
    } catch (e) {
      if (e.code === 11000) {
        log(`⏭️  Otro proceso reclamó "${key}" primero: no se hace nada.`);
        return { skipped: true, status: 'RUNNING' };
      }
      throw e;
    }
  }

  try {
    const result = await migrarEcografistas({ commit: true, log });
    await OneTimeTask.updateOne({ _id: key }, { $set: { status: 'DONE', finishedAt: new Date(), result } });
    log(`🔒  Marca "${key}" = DONE: no volverá a ejecutarse en los próximos despliegues.`);
    return { skipped: false, status: 'DONE', result };
  } catch (e) {
    await OneTimeTask.updateOne({ _id: key }, { $set: { status: 'FAILED', finishedAt: new Date(), error: e.message } });
    throw e;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const commit = args.includes('--commit');
  const force = args.includes('--force');
  const soloEstado = args.includes('--estado');
  const key = (args.find((a) => a.startsWith('--key=')) || '').split('=')[1] || TASK_KEY;

  console.log('\n=== ROL ecografista → doctor (tarea de una sola vez) ===');
  console.log(`Clave de la tarea: ${key}`);
  console.log(commit ? 'MODO: COMMIT (cambia los roles de verdad).' : 'MODO: DRY-RUN (solo informa). Usa --commit para aplicar.');
  console.log('');

  await connect();
  try {
    const previa = await OneTimeTask.findById(key).lean();
    if (soloEstado) {
      console.log(previa
        ? `Estado: ${previa.status} · intentos: ${previa.attempts} · host: ${previa.host} · fin: ${previa.finishedAt || '—'}`
        : 'Estado: sin marca (nunca se ejecutó).');
      return;
    }
    if (!commit) {
      if (previa) console.log(`(Marca existente: ${previa.status}. Con --commit ${previa.status === 'DONE' && !force ? 'NO' : 'SÍ'} se ejecutaría.)\n`);
      await migrarEcografistas({ commit: false });
      return;
    }
    await runOnce({ key, force });
  } finally {
    await disconnect();
  }
}

module.exports = { migrarEcografistas, runOnce, TASK_KEY };

if (require.main === module) {
  main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}
