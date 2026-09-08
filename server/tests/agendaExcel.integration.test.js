/**
 * EL EXCEL DE LA AGENDA.
 *
 * Lo que se vigila aquí:
 *   1. baja EXACTAMENTE lo que la pantalla está enseñando (los ids que manda),
 *      no «todas las citas del día»: la agenda filtra en el navegador y ese era
 *      el motivo de mandar ids en vez de filtros;
 *   2. no se fía de esa lista — una cita de una sede fuera del alcance de quien
 *      pide no entra, aunque mande su id;
 *   3. NO lleva datos de contacto (cédula, teléfono, correo, dirección). Es una
 *      agenda de trabajo, no el padrón: ver services/agendaWorkbook.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('stream');
const ExcelJS = require('exceljs');
const H = require('./_integrationHelpers');

const Appointment = require('../models/Appointment');
const Clinic = require('../models/Clinic');
const Patient = require('../models/Patient');
const User = require('../models/User');
const appt = require('../controllers/appointmentController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

/**
 * Un `res` que de verdad es un stream: el Excel se escribe con
 * `wb.xlsx.write(res)`, y el `mockRes` de siempre no tiene `write`/`end`.
 * Devuelve el archivo ya leído, o el JSON de error si el controlador cortó.
 */
function resDeExcel() {
  const chunks = [];
  const res = new PassThrough();
  res.on('data', (c) => chunks.push(c));
  res.headers = {};
  res.setHeader = (k, v) => { res.headers[String(k).toLowerCase()] = v; };
  res.statusCode = 200;
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.payload = p; res.corto = true; return res; };
  const terminado = new Promise((r) => res.on('end', r));
  return {
    res,
    async archivo() {
      if (res.corto) return null;
      await terminado;
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(Buffer.concat(chunks));
      return wb;
    },
  };
}

const manana = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0);
};

async function seed() {
  const { clinicId, userId } = await H.seedClinic();
  await Clinic.create({ _id: clinicId, name: 'Central' });
  const otraSede = await Clinic.create({ name: 'Sucursal Norte' });
  const paciente = await Patient.create({
    clinic: clinicId, firstName: 'ANA', lastName: 'PEREZ',
    cedula: '0102030405', phone: '0991112233', email: 'ana@example.com',
    address: 'Av. Siempre Viva 123',
  });
  const doctora = await User.create({
    name: 'Solano', email: 'doc@t.com', password: 'secreto123',
    clinics: [{ clinic: clinicId, role: 'doctor' }],
  });
  const citas = await Appointment.create([
    {
      clinic: clinicId, patient: paciente._id, date: manana(), startTime: '09:00',
      status: 'asistida', agreedValue: 45, advanceAmount: 20, advancePayment: 'abono',
      advanceMethod: 'efectivo', isFirstVisit: true, arrivalDelayMinutes: 23,
      arrivedAt: new Date(), serviceName: 'Detox Plus', reason: 'control',
      turns: [{ kind: 'doctor', user: doctora._id }],
    },
    {
      clinic: clinicId, patient: paciente._id, date: manana(), startTime: '10:00',
      status: 'pendiente', agreedValue: 30,
    },
    {
      clinic: otraSede._id, patient: paciente._id, date: manana(), startTime: '11:00',
      status: 'pendiente', agreedValue: 60,
    },
  ]);
  return { clinicId, userId, paciente, doctora, otraSede, citas };
}

const pedirExcel = async (clinicId, userId, body, role = 'cajero', sedesDelUsuario = null) => {
  const { res, archivo } = resDeExcel();
  const req = H.mockReq(clinicId, userId, body, { role });
  // `sucursalesVisibles` mira las sucursales ASIGNADAS a la persona, y `mockReq`
  // no las pone: sin esto un rol de alcance limitado no vería ninguna cita y el
  // test pasaría por el motivo equivocado.
  if (sedesDelUsuario) req.user.clinics = sedesDelUsuario.map((c) => ({ clinic: c }));
  await appt.exportAppointments(req, res);
  return { res, wb: await archivo() };
};

/** Todos los textos de una hoja, para buscar en ella. */
const textoDe = (ws) => {
  const partes = [];
  ws.eachRow((fila) => fila.eachCell({ includeEmpty: false }, (c) => {
    if (c.value !== null && c.value !== undefined) partes.push(String(c.value));
  }));
  return partes.join(' | ');
};

test('E1) exporta SOLO las citas que manda la pantalla, no todo el día', async () => {
  const { clinicId, userId, citas } = await seed();

  const { wb } = await pedirExcel(clinicId, userId, {
    ids: [String(citas[0]._id)],
    periodo: 'Día 9 de septiembre de 2026',
    filtros: 'Estado: Asistida',
  });

  const ws = wb.getWorksheet('Citas');
  const texto = textoDe(ws);
  assert.match(texto, /09:00/, 'la cita pedida está');
  assert.doesNotMatch(texto, /10:00/, 'la que no se pidió, no');
  // Y la cabecera dice de qué son estas citas y por qué son solo estas.
  assert.match(texto, /Día 9 de septiembre de 2026/);
  assert.match(texto, /Estado: Asistida/);
});

test('E2) una cita de una sede fuera de tu alcance no entra, aunque mandes su id', async () => {
  const { clinicId, userId, citas } = await seed();

  // Enfermería solo alcanza SU sucursal (mostrador y administración ven todas,
  // que son los roles que hoy tienen el botón; esto protege si mañana se abre).
  const { wb } = await pedirExcel(
    clinicId, userId,
    { ids: citas.map((c) => String(c._id)) },
    'enfermero',
    [clinicId] // trabaja solo en Central
  );

  const texto = textoDe(wb.getWorksheet('Citas'));
  assert.match(texto, /09:00/);
  assert.doesNotMatch(texto, /11:00/, 'la de la otra sucursal no baja');
});

test('E3) NO lleva cédula, teléfono, correo ni dirección del paciente', async () => {
  const { clinicId, userId, citas } = await seed();

  const { wb } = await pedirExcel(clinicId, userId, { ids: citas.map((c) => String(c._id)) });

  for (const nombre of ['Citas', 'Resumen']) {
    const texto = textoDe(wb.getWorksheet(nombre));
    assert.doesNotMatch(texto, /0102030405/, `cédula en la hoja ${nombre}`);
    assert.doesNotMatch(texto, /0991112233/, `teléfono en la hoja ${nombre}`);
    assert.doesNotMatch(texto, /ana@example\.com/, `correo en la hoja ${nombre}`);
    assert.doesNotMatch(texto, /Siempre Viva/, `dirección en la hoja ${nombre}`);
  }
  // Y el nombre sí: es una agenda de trabajo.
  assert.match(textoDe(wb.getWorksheet('Citas')), /ANA PEREZ/);
});

test('E4) el archivo trae las dos hojas, con encabezados y totales', async () => {
  const { clinicId, userId, citas } = await seed();

  const { res, wb } = await pedirExcel(clinicId, userId, {
    ids: [String(citas[0]._id), String(citas[1]._id)],
  });

  assert.match(res.headers['content-type'], /spreadsheetml\.sheet/);
  assert.match(res.headers['content-disposition'], /attachment; filename="citas-/);

  const ws = wb.getWorksheet('Citas');
  // Fila 6: los encabezados (1-4 son la cabecera del informe, 5 va en blanco).
  const encabezados = ws.getRow(6).values.filter(Boolean).map(String);
  assert.ok(encabezados.includes('Paciente'), 'la fila 6 son los encabezados');
  assert.ok(encabezados.includes('Retraso'));
  assert.ok(!encabezados.includes('Cédula'), 'no hay columna de cédula');
  // Congelada por la fila 6 y con autofiltro: se leen cien citas sin perderlos.
  assert.equal(ws.views?.[0]?.ySplit, 6);
  assert.ok(ws.autoFilter, 'la tabla se puede filtrar en el propio Excel');

  // Dos citas + la fila de totales.
  assert.equal(ws.lastRow.number, 6 + 2 + 1);
  assert.match(String(ws.lastRow.getCell(5).value), /2 citas/);

  assert.ok(wb.getWorksheet('Resumen'), 'y la hoja de resumen');
  assert.match(textoDe(wb.getWorksheet('Resumen')), /Citas por estado/);
});

test('E5) sin citas no se genera un archivo vacío: se dice que no hay nada', async () => {
  const { clinicId, userId } = await seed();

  const { res } = await pedirExcel(clinicId, userId, { ids: [] });
  assert.equal(res.statusCode, 400);
  assert.match(res.payload.message, /No hay ninguna cita/);

  // Un id con forma válida pero inexistente tampoco inventa nada.
  const inventado = new H.mongoose.Types.ObjectId();
  const otra = await pedirExcel(clinicId, userId, { ids: [String(inventado)] });
  assert.equal(otra.res.statusCode, 404);
});

test('E6) el retraso va como NÚMERO, para poder ordenarlo y promediarlo', async () => {
  const { clinicId, userId, citas } = await seed();

  const { wb } = await pedirExcel(clinicId, userId, { ids: [String(citas[0]._id)] });
  const ws = wb.getWorksheet('Citas');
  const col = ws.getRow(6).values.findIndex((v) => v === 'Retraso');
  assert.equal(ws.getRow(7).getCell(col).value, 23);
  assert.equal(typeof ws.getRow(7).getCell(col).value, 'number');
});
