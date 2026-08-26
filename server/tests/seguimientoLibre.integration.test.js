/**
 * EL SEGUIMIENTO SE SEPARA DEL INVENTARIO (ago-2026).
 *
 * Hasta ahora, para guardar un seguimiento había que registrar al menos un ítem
 * en Receta o Derivaciones, y cada ítem se elegía de un buscador del catálogo de
 * productos. Eso ataba la consulta clínica a la parte contable: una consulta de
 * control —en la que no se receta ni se deriva nada— no se podía guardar, y no se
 * podía recetar un medicamento que la clínica no vende sin dar un rodeo.
 *
 * Ahora Receta y Derivaciones son TEXTO LIBRE y lo único obligatorio es el motivo
 * de consulta. Lo que estos tests vigilan:
 *
 *  1. que un seguimiento sin receta ni derivaciones se guarde,
 *  2. que una derivación escrita a mano siga distinguiéndose de la receta. Las
 *     dos listas se guardan JUNTAS en `recetaItems` y lo único que las separa es
 *     el booleano `isService`, que antes salía de la categoría del producto. Sin
 *     producto, si nadie lo marca, TODAS las derivaciones aparecerían como
 *     "Receta" en el historial, en el PDF de receta y en la hoja MSP,
 *  3. que un seguimiento solo lo pueda borrar un administrador.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const ClinicalRecord = require('../models/ClinicalRecord');
const Patient = require('../models/Patient');
const clinicalRecords = require('../controllers/clinicalRecordController');
const { requireRole } = require('../middleware/auth');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function seedPaciente(clinicId, userId) {
  const patient = await Patient.create({
    clinic: clinicId, firstName: 'Ana', lastName: 'Pérez', cedula: '0102030405',
  });
  await ClinicalRecord.create({ clinic: clinicId, patient: patient._id, createdBy: userId });
  return patient;
}

const post = (clinicId, userId, patientId, body, role = 'doctor') =>
  H.runController(
    clinicalRecords.addFollowUp,
    H.mockReq(clinicId, userId, body, { role, params: { patientId: String(patientId) } }),
  );

// ───────────────── lo único obligatorio es el motivo ─────────────────

test('se guarda un seguimiento SIN receta ni derivaciones', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const p = await seedPaciente(clinicId, userId);

  const r = await post(clinicId, userId, p._id, { descripcion: 'Control de rutina' });

  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));
  const fu = (r.payload.followUps || []).slice(-1)[0];
  assert.equal(fu.descripcion, 'Control de rutina');
  assert.deepEqual(fu.recetaItems, [], 'sin ítems inventados');
});

test('sin motivo de consulta NO se guarda', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const p = await seedPaciente(clinicId, userId);

  const r = await post(clinicId, userId, p._id, { descripcion: '', evolucion: 'Mejora' });

  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /motivo de consulta/i);
});

test('las líneas en blanco no llegan a la historia clínica', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const p = await seedPaciente(clinicId, userId);

  const r = await post(clinicId, userId, p._id, {
    descripcion: 'Consulta',
    recetaItems: [{ name: '  ', quantity: 1 }, { name: 'Ibuprofeno 400 mg', quantity: 2 }],
    derivacionItems: [{ name: '', quantity: 1 }],
  });

  const fu = (r.payload.followUps || []).slice(-1)[0];
  assert.equal(fu.recetaItems.length, 1);
  assert.equal(fu.recetaItems[0].name, 'Ibuprofeno 400 mg');
});

// ───────────────── receta vs derivación, sin producto ─────────────────

test('una derivación escrita a mano se guarda como servicio, no como receta', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const p = await seedPaciente(clinicId, userId);

  const r = await post(clinicId, userId, p._id, {
    descripcion: 'Lumbalgia',
    recetaItems: [{ name: 'Paracetamol 500 mg', quantity: 10, dose: '1 tableta', frequency: 'c/8 h', duration: '5 días' }],
    derivacionItems: [{ name: 'Fisioterapia', quantity: 6, instructions: 'Zona lumbar' }],
  });

  const fu = (r.payload.followUps || []).slice(-1)[0];
  const receta = fu.recetaItems.filter((it) => !it.isService);
  const derivaciones = fu.recetaItems.filter((it) => it.isService);

  assert.equal(receta.length, 1, 'la receta no se lleva la derivación');
  assert.equal(receta[0].name, 'Paracetamol 500 mg');
  assert.equal(derivaciones.length, 1, 'la derivación NO puede acabar en la receta');
  assert.equal(derivaciones[0].name, 'Fisioterapia');
  assert.equal(derivaciones[0].quantity, 6);
  assert.equal(derivaciones[0].instructions, 'Zona lumbar');
});

test('con producto del inventario sigue mandando su categoría', async () => {
  // Comportamiento de siempre: una derivación que SÍ apunta a un servicio del
  // catálogo se marca por su categoría, no por la lista de la que venga.
  const { clinicId, userId } = await H.seedClinic();
  const p = await seedPaciente(clinicId, userId);
  const servicio = await H.makeProduct(clinicId, { name: 'Terapia física', category: 'servicio' });

  const r = await post(clinicId, userId, p._id, {
    descripcion: 'Lumbalgia',
    derivacionItems: [{ product: String(servicio._id), name: 'Terapia física', quantity: 3 }],
  });

  const fu = (r.payload.followUps || []).slice(-1)[0];
  assert.equal(fu.recetaItems[0].isService, true);
});

// ───────────────── borrar: solo administradores ─────────────────

test('solo un administrador puede borrar un seguimiento', () => {
  // La comprobación vive en la ruta, no en el controlador: se ejercita el
  // middleware tal cual lo monta routes/clinicalRecords.js.
  const guard = requireRole('admin');
  const intento = (role, isSuperAdmin = false) => {
    let permitido = false;
    let status = null;
    guard(
      { role, user: { isSuperAdmin } },
      { status(c) { status = c; return { json() {} }; } },
      () => { permitido = true; },
    );
    return { permitido, status };
  };

  assert.equal(intento('admin').permitido, true);
  assert.equal(intento(null, true).permitido, true, 'el super-admin siempre pasa');
  // 'doctor' pasaba antes, y `requireRole` lo expande a TODAS las especialidades:
  // por eso el borrado estaba abierto a cualquier profesional.
  for (const rol of ['doctor', 'optica', 'ginecologia', 'podologia', 'odontologia', 'cosmetologia', 'cajero', 'enfermero']) {
    const r = intento(rol);
    assert.equal(r.permitido, false, `${rol} no debería poder borrar seguimientos`);
    assert.equal(r.status, 403);
  }
});
