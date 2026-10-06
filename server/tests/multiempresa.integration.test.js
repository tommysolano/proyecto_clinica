/**
 * VARIAS EMPRESAS (oct-2026).
 *
 * Una empresa = una razón social con sus sucursales. Agenda, personal, ventas,
 * catálogo y contabilidad son de cada una; los pacientes y el CRM, de todas. Se
 * vigila que nada de una empresa se cuele en la otra por los sitios que antes
 * decían «toda la organización», y las dos operaciones nuevas: copiar el catálogo
 * y mover una sucursal (la operación se va, el historial se queda).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Company = require('../models/Company');
const Clinic = require('../models/Clinic');
const User = require('../models/User');
const Product = require('../models/Product');
const Appointment = require('../models/Appointment');
const AppointmentServiceItem = require('../models/AppointmentServiceItem');
const companies = require('../utils/companies');
const { sucursalesVisibles, validarSucursalDestino } = require('../utils/clinicScope');
const { sincronizarServiciosInventario } = require('../utils/serviciosInventario');
const serviceItems = require('../controllers/appointmentServiceItemController');
const companyCtrl = require('../controllers/companyController');
const clinicCtrl = require('../controllers/clinicController');

const { ObjectId } = H.mongoose.Types;

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); companies.invalidateCompanyCache(); });

const ok = (r) => { assert.ok(r.statusCode < 400, JSON.stringify(r.payload)); return r.payload; };
const ids = (list) => (list || []).map(String).sort();

async function seed() {
  const shiluv = await Company.create({ name: 'Shiluv', isDefault: true });
  const otra = await Company.create({ name: 'Otra' });
  const [a1, a2, b1] = await Clinic.create([
    { name: 'Central', company: shiluv._id },
    { name: 'Extension', company: shiluv._id },
    { name: 'Norte', company: otra._id },
  ]);
  const crear = (name, clinics, extras = {}) => User.create({
    name, email: `${name.toLowerCase()}@t.com`, password: 'secreto123', clinics, ...extras });
  const admin = await crear('Admin', [{ clinic: a1._id, role: 'admin' }]);
  const asesor = await crear('Asesor', [{ clinic: a1._id, role: 'call_center' }]);
  const rotativo = await crear('Rotativo', [{ clinic: a1._id, role: 'doctor' }], { worksInAllClinics: true });
  await companies.refreshCompanyCache();
  return { shiluv, otra, a1, a2, b1, admin, asesor, rotativo };
}

const req = (clinicId, user, role, extra = {}) => ({ clinicId: String(clinicId), user, role, query: {}, ...extra });

test('la agenda de administración es la de SU empresa; el CRM ve todas', async () => {
  const { a1, a2, admin, asesor } = await seed();
  assert.deepEqual(ids(sucursalesVisibles(req(a1._id, admin, 'admin'))), ids([a1._id, a2._id]));
  assert.equal(sucursalesVisibles(req(a1._id, asesor, 'call_center')), null, 'call center: todas las empresas');
  // El super-admin también trabaja en la empresa de su sucursal activa (cambia de empresa al cambiar de sucursal).
  assert.deepEqual(ids(sucursalesVisibles(req(a1._id, { isSuperAdmin: true }, 'admin'))), ids([a1._id, a2._id]));
});

test('«trabaja en todas las sucursales» = todas las de SUS empresas', async () => {
  const { otra, a2, b1, rotativo } = await seed();
  const doc = await User.findById(rotativo._id);
  assert.deepEqual(ids(doc.companies), ids([(await Company.findOne({ isDefault: true }))._id]), 'se completa al guardar');
  assert.equal(doc.getRoleForClinic(a2._id), 'doctor', 'otra sucursal de su empresa');
  assert.equal(doc.getRoleForClinic(b1._id), null, 'la otra empresa no');
  assert.equal(await User.countDocuments(User.enSucursal(b1._id, 'doctor')), 0);

  // Se le añade la otra empresa: ahora también atiende allí.
  doc.companies.push(otra._id);
  await doc.save();
  assert.equal(doc.getRoleForClinic(b1._id), 'doctor');
  assert.equal(await User.countDocuments(User.enSucursal(b1._id, 'doctor')), 1);
});

test('agendar en otra empresa: el CRM sí, administración de otra empresa no', async () => {
  const { a1, b1, admin, asesor } = await seed();
  const deAdmin = await validarSucursalDestino(req(a1._id, admin, 'admin'), String(b1._id));
  assert.equal(deAdmin.ok, false);
  assert.equal(deAdmin.status, 403);
  const delAsesor = await validarSucursalDestino(req(a1._id, asesor, 'call_center'), String(b1._id));
  assert.equal(delAsesor.ok, true);
});

test('cada empresa ofrece SUS servicios al agendar, aunque se llamen igual', async () => {
  const { a1, b1, asesor } = await seed();
  await Product.collection.insertMany([
    { clinic: a1._id, code: 'S1', name: 'Consulta', category: 'servicio', active: true, unlimited: true },
    { clinic: b1._id, code: 'S1', name: 'Consulta', category: 'servicio', active: true, unlimited: true },
    { clinic: b1._id, code: 'S2', name: 'Masaje', category: 'servicio', active: true, unlimited: true },
  ]);
  await sincronizarServiciosInventario({ force: true });
  assert.equal(await AppointmentServiceItem.countDocuments({ slug: 'consulta' }), 2, 'una Consulta por empresa');
  // El asesor está en Central y agenda en Norte (otra empresa): ve el catálogo de Norte.
  const r = ok(await H.runController(serviceItems.list, H.mockReq(String(a1._id), asesor._id, {},
    { role: 'call_center', query: { clinic: String(b1._id) } })));
  assert.deepEqual(r.map((i) => i.name).sort(), ['Consulta', 'Masaje']);
  const propio = ok(await H.runController(serviceItems.list, H.mockReq(String(a1._id), asesor._id, {}, { role: 'call_center' })));
  assert.deepEqual(propio.map((i) => i.name), ['Consulta']);
});

test('copiar el catálogo: independiente, sin stock y sin duplicar lo que ya hay', async () => {
  const { shiluv, otra, a1, b1 } = await seed();
  const ampolla = new ObjectId();
  await Product.collection.insertMany([
    { _id: ampolla, clinic: a1._id, code: 'A1', name: 'Ampolla', category: 'insumo', active: true, stock: 40, salePrice: 5,
      stockByClinic: [{ clinic: a1._id, stock: 40 }] },
    { clinic: a1._id, code: 'S1', name: 'Suero', category: 'servicio', active: true, unlimited: true, salePrice: 30,
      components: [{ product: ampolla, quantity: 2 }] },
    { clinic: b1._id, code: 'S1', name: 'Suero de Norte', category: 'servicio', active: true, unlimited: true, salePrice: 25 },
  ]);
  const superAdmin = { _id: new ObjectId(), isSuperAdmin: true };
  const r = ok(await H.runController(companyCtrl.copyCatalog, { ...H.mockReq(String(a1._id), superAdmin._id,
    { fromCompany: String(shiluv._id) }, { params: { id: String(otra._id) } }), user: superAdmin }));
  assert.deepEqual([r.copied, r.skipped], [1, 1], 'la Ampolla se copia; S1 ya existía en Norte');
  const copia = await Product.findOne({ clinic: b1._id, code: 'A1' }).lean();
  assert.equal(copia.stock, 0);
  assert.deepEqual(copia.stockByClinic, []);
  assert.equal(copia.salePrice, 5);
  assert.equal((await Product.findOne({ clinic: b1._id, code: 'S1' }).lean()).name, 'Suero de Norte', 'no se pisa');
  // Independientes: cambiar el precio en una no toca la otra.
  await Product.updateOne({ _id: copia._id }, { $set: { salePrice: 9 } });
  assert.equal((await Product.findById(ampolla).lean()).salePrice, 5);
});

test('mover una sucursal: la operación pasa a la otra empresa y el historial se queda', async () => {
  const { otra, a2, admin } = await seed();
  const enfermera = await User.create({ name: 'Enf', email: 'enf@t.com', password: 'secreto123',
    clinics: [{ clinic: a2._id, role: 'enfermero' }] });
  const patient = new ObjectId();
  const manana = new Date(Date.now() + 2 * 86400000);
  const ayer = new Date(Date.now() - 2 * 86400000);
  const [futura, pasada] = await Appointment.collection.insertMany([
    { clinic: a2._id, patient, date: manana, status: 'pendiente' },
    { clinic: a2._id, patient, date: ayer, status: 'completada' },
  ]).then((r) => Object.values(r.insertedIds));

  const superAdmin = await User.findById(admin._id);
  superAdmin.isSuperAdmin = true;
  const r = ok(await H.runController(clinicCtrl.moveClinic, { ...H.mockReq(String(a2._id), admin._id,
    { company: String(otra._id) }, { params: { id: String(a2._id) } }), user: superAdmin }));
  const nueva = r.clinic;
  assert.equal(String(nueva.company), String(otra._id));
  assert.equal(nueva.name, 'Extension');
  assert.deepEqual([r.moved.staff, r.moved.appointments], [1, 1]);

  const origen = await Clinic.findById(a2._id).lean();
  assert.equal(origen.active, false);
  assert.equal(String(origen.company), String((await Company.findOne({ isDefault: true }))._id), 'sigue en su empresa');
  assert.equal(String(origen.movedTo), String(nueva._id));
  assert.equal(String((await Appointment.findById(futura).lean()).clinic), String(nueva._id), 'la cita futura se va');
  assert.equal(String((await Appointment.findById(pasada).lean()).clinic), String(a2._id), 'la pasada se queda');
  const movida = await User.findById(enfermera._id).lean();
  assert.deepEqual(movida.clinics.map((c) => [String(c.clinic), c.role]), [[String(nueva._id), 'enfermero']]);
  assert.ok(ids(movida.companies).includes(String(otra._id)));
});

test('al arrancar: sin empresas se crea la principal y se le asigna todo', async () => {
  const [central] = await Clinic.create([{ name: 'Central', nombreComercial: 'Shiluv' }, { name: 'Lab' }]);
  await User.create({ name: 'Doc', email: 'doc@t.com', password: 'secreto123', clinics: [{ clinic: central._id, role: 'doctor' }] });
  await AppointmentServiceItem.collection.insertOne({ name: 'Consulta', slug: 'consulta', clinic: central._id, active: true });
  const r = await companies.ensureCompanies();
  const principal = await Company.findOne({ isDefault: true }).lean();
  assert.equal(principal.name, 'Shiluv');
  assert.equal(await Clinic.countDocuments({ company: principal._id }), 2);
  assert.deepEqual(ids((await User.findOne({ name: 'Doc' }).lean()).companies), [String(principal._id)]);
  assert.equal(String((await AppointmentServiceItem.findOne({}).lean()).company), String(principal._id));
  // Idempotente.
  await companies.ensureCompanies();
  assert.equal(await Company.countDocuments(), 1);
  assert.equal(r.company, String(principal._id));
});
