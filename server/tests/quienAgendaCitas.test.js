/**
 * QUIÉN PUEDE AGENDAR UNA CITA.
 *
 * Se prueba sobre la RUTA de verdad (`POST /api/appointments`), no sobre una
 * copia de la lista de roles: lo que falla en producción es que la lista de la
 * ruta y la del botón dejen de decir lo mismo, y una lista repetida en el test
 * no lo detectaría nunca.
 *
 * Lo que fija:
 *  · odontología SÍ (sep-2026, a petición del usuario): el paciente sale del
 *    sillón con el control a quince días y quien lo sabe es quien lo atendió;
 *  · marketing SÍ (sep-2026): ya editaba y borraba citas, pero la CREACIÓN
 *    obligaba a pedírsela a otro;
 *  · y va enumerada, NO por 'doctor' — porque `requireRole` expande ese rol a
 *    TODAS las especialidades, y agendar no se le abrió al resto.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const router = require('../routes/appointments');

/** La cadena de middleware que la ruta pone delante de `POST /`. */
function guardiaDeAgendar() {
  const capa = router.stack.find((l) => l.route?.path === '/' && l.route.methods?.post);
  assert.ok(capa, 'la ruta POST / de citas existe');
  // El último handle es el controlador; los de antes son los guardianes.
  const handles = capa.route.stack.map((s) => s.handle);
  assert.ok(handles.length >= 2, 'la ruta tiene al menos un guardián y el controlador');
  return handles.slice(0, -1);
}

/** ¿Deja pasar a este rol? Corre los guardianes sin llegar al controlador. */
function dejaPasar(role) {
  const req = { role, user: {}, body: {}, params: {}, query: {} };
  let pasó = false;
  let estado = null;
  const res = {
    status(c) { estado = c; return res; },
    json() { return res; },
  };
  for (const guardia of guardiaDeAgendar()) {
    pasó = false;
    guardia(req, res, () => { pasó = true; });
    if (!pasó) break;
  }
  return { pasó, estado };
}

test('odontología puede agendar citas', () => {
  const { pasó } = dejaPasar('odontologia');
  assert.equal(pasó, true, 'odontología entra a POST /appointments');
});

test('mostrador, administración y call center siguen agendando', () => {
  for (const role of ['admin', 'cajero', 'call_center']) {
    assert.equal(dejaPasar(role).pasó, true, `${role} debería poder agendar`);
  }
});

test('marketing puede agendar citas (sep-2026)', () => {
  const { pasó } = dejaPasar('marketing');
  assert.equal(pasó, true, 'marketing entra a POST /appointments');
});

test('agendar NO se le abrió a las demás especialidades ni al resto', () => {
  // 'doctor' no está en la lista de la ruta, así que la expansión de
  // `requireRole` no entra en juego: cada especialidad va por su nombre.
  for (const role of ['doctor', 'optica', 'podologia', 'ginecologia', 'cosmetologia',
    'cardiologia', 'terapeuta', 'enfermero', 'contabilidad']) {
    const { pasó, estado } = dejaPasar(role);
    assert.equal(pasó, false, `${role} NO debería poder agendar`);
    assert.equal(estado, 403);
  }
});
