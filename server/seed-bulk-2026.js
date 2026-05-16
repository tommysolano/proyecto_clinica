/**
 * Seed masivo 2026.
 *
 * Llena la clínica con MUCHOS datos distribuidos entre el 1-Ene-2026 y
 * la fecha actual, para poder probar gráficos, evolución, predicciones,
 * heatmap, abandono de tratamientos, etc.
 *
 *   - ~120 pacientes adicionales con orígenes variados.
 *   - ~500 ventas distribuidas día a día con zonas de Guayaquil.
 *   - ~350 citas con mezcla de estados, roles y reagendamientos.
 *   - ~40 tratamientos en diferentes avances (algunos cerca de abandono).
 *   - ~40 derivaciones en todos los estados.
 *
 * Uso:  node seed-bulk-2026.js
 *
 * Idempotente por umbrales: no crea más si ya hay suficientes registros.
 * Marca lo creado con notes incluye "[bulk-2026]" cuando el campo existe.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const User = require('./models/User');
const Clinic = require('./models/Clinic');
const Patient = require('./models/Patient');
const Product = require('./models/Product');
const Appointment = require('./models/Appointment');
const Sale = require('./models/Sale');
const Treatment = require('./models/Treatment');
const Referral = require('./models/Referral');
const Room = require('./models/Room');
const { GUAYAQUIL_ZONES } = require('./utils/guayaquilZones');

const PASSWORD = 'Demo2026!';
const START_DATE = new Date('2026-01-01T00:00:00');
const END_DATE = new Date(); // hoy

// Volúmenes objetivo (acumulados, no incrementales sobre lo que ya hay)
const TARGET_PATIENTS = 180;
const TARGET_SALES = 600;
const TARGET_APPOINTMENTS = 450;
const TARGET_TREATMENTS = 50;
const TARGET_REFERRALS = 50;

const FIRST_NAMES = ['Andrés','María','Juan','Sofía','Luis','Camila','Pedro','Valentina','Diego','Paola','Mateo','Isabella','Sebastián','Emilia','Daniel','Antonella','Nicolás','Renata','Tomás','Mía','Joaquín','Catalina','Benjamín','Martina','Lucas','Victoria','Samuel','Julieta','Alejandro','Florencia','Gabriel','Salomé','Ignacio','Aitana','Felipe','Gabriela','Esteban','Romina','Cristóbal','Lorena','Vicente','Daniela','Bruno','Helena','Maximiliano','Carolina','Rafael','Renée','Adrián','Constanza','Pablo','Sara','Roberto','Andrea','Fernando','Verónica','Miguel','Patricia','Jorge','Mónica'];
const LAST_NAMES = ['Pacheco','Rodríguez','Pérez','Castro','Vinueza','Naranjo','Ortiz','Mora','Flores','Sánchez','Vélez','Aguilar','Coello','Bermúdez','Reinoso','Quezada','Iturralde','Maldonado','Tinoco','Suárez','Cabezas','Yánez','Alarcón','Espinoza','Salgado','Carrión','Bonilla','Crespo','Encalada','Lara','Cevallos','Burgos','Cárdenas','Granda','Mosquera','Vera','Jaramillo','Salazar'];

const SOURCES = [
  { source: 'anuncio',   details: ['Facebook Ads','Instagram Ads','Google Ads','TikTok Ads','YouTube Ads'] },
  { source: 'referido',  details: ['Dra. Patricia Andrade','Dr. Javier Mendoza','Dra. Lucía Vega','María Rodríguez','Andrés Pacheco','Camila Naranjo','Sofía Castro','Vecino del consultorio'] },
  { source: 'recepcion', details: ['Walk-in','Volante en sala','Recomendación recepción','Pase por el local'] },
  { source: 'organico',  details: ['Búsqueda Google','Mapa','Redes orgánico','Boca a boca'] },
];

const ZONE_NAMES = GUAYAQUIL_ZONES.map((z) => z.name);
const OTHER_CITIES = ['Samborondón','Daule','Durán','Playas','Salinas'];

const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const randomDateInRange = () => {
  const ms = randInt(START_DATE.getTime(), END_DATE.getTime());
  return new Date(ms);
};
const setHM = (date, h, m = 0) => {
  const d = new Date(date);
  d.setHours(h, m, 0, 0);
  return d;
};
const daysBetween = (a, b) => Math.floor((b - a) / 86400000);

const ensureUser = async (clinicId, email, name, role, extras = {}) => {
  let u = await User.findOne({ email });
  if (!u) {
    const salt = await bcrypt.genSalt(10);
    const password = await bcrypt.hash(PASSWORD, salt);
    u = await User.create({
      name, email, password, ...extras,
      clinics: [{ clinic: clinicId, role }],
    });
    console.log(`Usuario creado: ${email}`);
  } else if (!(u.clinics || []).some((c) => String(c.clinic) === String(clinicId))) {
    u.clinics.push({ clinic: clinicId, role });
    await u.save();
  }
  return u;
};

const seed = async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Conectado a MongoDB');

  const clinic = await Clinic.findOne({ name: 'Shiluv' });
  if (!clinic) {
    console.error('Primero corre `node seed.js` para crear la clínica Shiluv.');
    process.exit(1);
  }
  const clinicId = clinic._id;
  console.log(`Rango: ${START_DATE.toISOString().slice(0,10)} → ${END_DATE.toISOString().slice(0,10)} (${daysBetween(START_DATE, END_DATE)} días)`);

  // Usuarios base
  const admin = await ensureUser(clinicId, 'admin.demo@shiluv.com', 'Admin Demo', 'admin');
  const cajero = await ensureUser(clinicId, 'cajero.demo@shiluv.com', 'Carla Cajera', 'cajero');
  const callCenter = await ensureUser(clinicId, 'callcenter.demo@shiluv.com', 'Karina Salas', 'call_center');
  const doctor1 = await ensureUser(clinicId, 'doctor1.demo@shiluv.com', 'Dra. Patricia Andrade', 'doctor', { specialty: 'Medicina General' });
  const doctor2 = await ensureUser(clinicId, 'doctor2.demo@shiluv.com', 'Dr. Javier Mendoza', 'doctor', { specialty: 'Dermatología' });
  const doctor3 = await ensureUser(clinicId, 'doctor3.demo@shiluv.com', 'Dra. Lucía Vega', 'doctor', { specialty: 'Estética' });
  const doctors = [doctor1, doctor2, doctor3];
  const ROLE_TO_USER = {
    admin: admin._id,
    cajero: cajero._id,
    call_center: callCenter._id,
    doctor: doctor1._id,
  };

  // Productos: usar los que ya existan; sino crear los básicos
  const ensureProduct = async (def) => {
    let p = await Product.findOne({ clinic: clinicId, code: def.code });
    if (!p) p = await Product.create({ ...def, clinic: clinicId, active: true });
    return p;
  };
  const services = {
    CON: await ensureProduct({ name: 'Consulta general',          code: 'SRV-CON', category: 'servicio', salePrice: 25,  taxRate: 0,  unlimited: true }),
    LIM: await ensureProduct({ name: 'Limpieza facial profunda',  code: 'SRV-LIM', category: 'servicio', salePrice: 45,  taxRate: 15, unlimited: true }),
    BOT: await ensureProduct({ name: 'Botox por unidad',          code: 'SRV-BOT', category: 'servicio', salePrice: 12,  taxRate: 15, unlimited: true }),
    LAS: await ensureProduct({ name: 'Sesión de láser',           code: 'SRV-LAS', category: 'servicio', salePrice: 80,  taxRate: 15, unlimited: true }),
    MIC: await ensureProduct({ name: 'Microdermoabrasión',        code: 'SRV-MIC', category: 'servicio', salePrice: 60,  taxRate: 15, unlimited: true }),
    PRP: await ensureProduct({ name: 'Plasma rico en plaquetas',  code: 'SRV-PRP', category: 'servicio', salePrice: 150, taxRate: 15, unlimited: true }),
  };
  const serviceList = Object.values(services);

  // Rooms
  let rooms = await Room.find({ clinic: clinicId });
  if (rooms.length < 2) {
    rooms = [];
    for (const r of [
      { name: 'Consultorio Demo 1', code: 'CD1', manager: doctor1._id },
      { name: 'Consultorio Demo 2', code: 'CD2', manager: doctor2._id },
    ]) {
      rooms.push(await Room.create({ ...r, clinic: clinicId, active: true }));
    }
  }

  // 1) Pacientes
  const currentPatients = await Patient.countDocuments({ clinic: clinicId });
  if (currentPatients < TARGET_PATIENTS) {
    const toCreate = TARGET_PATIENTS - currentPatients;
    let createdCount = 0;
    for (let i = 0; i < toCreate; i++) {
      const firstName = rand(FIRST_NAMES);
      const lastName = rand(LAST_NAMES);
      const cedula = `09${randInt(10000000, 99999999)}`;
      const exists = await Patient.findOne({ clinic: clinicId, cedula });
      if (exists) continue;
      const srcConfig = rand(SOURCES);
      const regDate = randomDateInRange();
      const pat = new Patient({
        clinic: clinicId,
        firstName, lastName, cedula,
        phone: `09${randInt(60000000, 99999999)}`,
        email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}${i}@example.com`,
        source: srcConfig.source,
        sourceDetail: rand(srcConfig.details),
        address: `${rand(['Av.','Calle','Ciudadela'])} ${rand(['Las Aguas','Los Mangos','Bellavista','La Riviera','El Sol','Las Lomas','Las Peñas'])} ${randInt(100, 999)}`,
        active: true,
        createdAt: regDate,
        updatedAt: regDate,
      });
      await pat.save();
      createdCount++;
    }
    console.log(`Pacientes creados: ${createdCount}`);
  }
  const allPatients = await Patient.find({ clinic: clinicId }).limit(300);

  // 2) Ventas distribuidas día por día
  const currentSales = await Sale.countDocuments({ clinic: clinicId });
  if (currentSales < TARGET_SALES) {
    const toCreate = TARGET_SALES - currentSales;
    for (let i = 0; i < toCreate; i++) {
      const pat = rand(allPatients);
      const useGuayaquil = Math.random() < 0.85; // 85% Guayaquil
      const city = useGuayaquil ? 'Guayaquil' : rand(OTHER_CITIES);
      const zone = useGuayaquil ? rand(ZONE_NAMES) : '';
      const itemsCount = randInt(1, 3);
      const items = [];
      let subtotal = 0, tax = 0;
      for (let j = 0; j < itemsCount; j++) {
        const p = rand(serviceList);
        const qty = randInt(1, 2);
        const base = p.salePrice * qty;
        const t = base * (p.taxRate / 100);
        subtotal += base; tax += t;
        items.push({
          product: p._id,
          productCode: p.code,
          productName: p.name,
          category: p.category,
          quantity: qty,
          unitPrice: p.salePrice,
          taxRate: p.taxRate,
          discount: 0,
          subtotal: +base.toFixed(2),
        });
      }
      const total = subtotal + tax;
      const saleDate = randomDateInRange();
      const sale = new Sale({
        clinic: clinicId,
        patient: pat._id,
        clientName: `${pat.firstName} ${pat.lastName}`,
        clientCedula: pat.cedula || '9999999999999',
        clientPhone: pat.phone,
        clientAddress: pat.address,
        clientCity: city,
        clientZone: zone,
        items,
        subtotal: +subtotal.toFixed(2),
        discountTotal: 0,
        taxAmount: +tax.toFixed(2),
        total: +total.toFixed(2),
        paymentMethod: rand(['efectivo','tarjeta','transferencia']),
        status: 'completada',
        cashier: cajero._id,
        createdBy: cajero._id,
        notes: '[bulk-2026]',
        createdAt: saleDate,
        updatedAt: saleDate,
      });
      await sale.save();
    }
    console.log(`Ventas creadas: ${toCreate}`);
  }

  // 3) Citas
  const currentAppts = await Appointment.countDocuments({ clinic: clinicId });
  if (currentAppts < TARGET_APPOINTMENTS) {
    const toCreate = TARGET_APPOINTMENTS - currentAppts;
    const ROLES = ['call_center','cajero','admin','doctor'];
    for (let i = 0; i < toCreate; i++) {
      const apptDate = randomDateInRange();
      const startH = randInt(8, 18);
      const startTime = `${String(startH).padStart(2,'0')}:00`;
      const endTime = `${String(startH).padStart(2,'0')}:30`;
      const pat = rand(allPatients);
      const doc = rand(doctors);
      const isPast = apptDate < new Date();
      const status = isPast
        ? rand(['asistida','asistida','asistida','no_asistio','completada','cancelada'])
        : rand(['pendiente','confirmada','pendiente']);
      const createdByRole = rand(ROLES);
      const sv = rand(serviceList);
      const appt = new Appointment({
        clinic: clinicId,
        patient: pat._id,
        doctor: doc._id,
        room: rand(rooms)._id,
        date: setHM(apptDate, 0, 0),
        startTime, endTime,
        services: [{ product: sv._id, name: sv.name, price: sv.salePrice, quantity: 1 }],
        status,
        createdBy: createdByRole === 'doctor' ? doc._id : ROLE_TO_USER[createdByRole],
        createdByRole,
        notes: '[bulk-2026]',
        createdAt: apptDate,
        updatedAt: apptDate,
      });
      // 20% reagendadas
      if (isPast && Math.random() < 0.2) {
        const oldOffsetDays = randInt(1, 7);
        const previousDate = new Date(apptDate.getTime() - oldOffsetDays * 86400000);
        appt.rescheduleHistory.push({
          previousDate: setHM(previousDate, 0, 0),
          previousStartTime: '10:00',
          previousEndTime: '10:30',
          newDate: appt.date,
          newStartTime: appt.startTime,
          newEndTime: appt.endTime,
          rescheduledBy: callCenter._id,
          rescheduledByName: 'Karina Salas',
          rescheduledByRole: 'call_center',
          reason: rand(['Paciente solicitó cambio','Conflicto del doctor','Reorganización de agenda','Cliente no disponible']),
          at: previousDate,
        });
      }
      await appt.save();
    }
    console.log(`Citas creadas: ${toCreate}`);
  }

  // 4) Tratamientos
  const currentTreats = await Treatment.countDocuments({ clinic: clinicId });
  if (currentTreats < TARGET_TREATMENTS) {
    const toCreate = TARGET_TREATMENTS - currentTreats;
    for (let i = 0; i < toCreate; i++) {
      const pat = rand(allPatients);
      const doc = rand(doctors);
      const startDate = randomDateInRange();
      const items = [
        { product: services.LIM._id, name: services.LIM.name, quantity: 4, completed: randInt(0, 3) },
        { product: services.MIC._id, name: services.MIC.name, quantity: 3, completed: randInt(0, 2) },
      ];
      if (i % 2 === 0) items.push({ product: services.PRP._id, name: services.PRP.name, quantity: 2, completed: randInt(0, 1) });
      // Distribución para forzar variedad de estados de abandono:
      //   - 1/5 cerca de abandono (12-14 días sin actividad)
      //   - 1/10 abandonado (>15 días)
      //   - resto activo reciente
      let lastActivityAt;
      const dice = Math.random();
      if (dice < 0.2) {
        lastActivityAt = new Date(Date.now() - randInt(12, 14) * 86400000);
      } else if (dice < 0.3) {
        lastActivityAt = new Date(Date.now() - randInt(16, 30) * 86400000);
      } else {
        lastActivityAt = new Date(Date.now() - randInt(0, 10) * 86400000);
      }
      const tr = new Treatment({
        clinic: clinicId,
        patient: pat._id,
        name: rand(['Plan dermatológico facial','Programa anti-acné','Tratamiento de manchas','Rejuvenecimiento integral','Plan capilar','Tratamiento corporal']),
        prescribedBy: doc._id,
        startDate,
        targetEndDate: new Date(startDate.getTime() + 90 * 86400000),
        status: 'activo',
        source: rand(['referral','appointment','manual']),
        items,
        lastActivityAt,
        createdBy: doc._id,
        notes: '[bulk-2026]',
        createdAt: startDate,
        updatedAt: lastActivityAt,
      });
      await tr.save();
    }
    console.log(`Tratamientos creados: ${toCreate}`);
  }

  // 5) Derivaciones
  const currentRefs = await Referral.countDocuments({ clinic: clinicId });
  if (currentRefs < TARGET_REFERRALS) {
    const toCreate = TARGET_REFERRALS - currentRefs;
    const STATUSES = ['pendiente','agendada','atendida','cancelada'];
    for (let i = 0; i < toCreate; i++) {
      const fromDoc = rand(doctors);
      let toDoc = rand(doctors);
      while (String(toDoc._id) === String(fromDoc._id)) toDoc = rand(doctors);
      const date = randomDateInRange();
      const ref = new Referral({
        clinic: clinicId,
        fromDoctor: fromDoc._id,
        toDoctor: toDoc._id,
        patient: rand(allPatients)._id,
        specialty: toDoc.specialty || 'Estética',
        reason: rand(['Evaluación dermatológica','Consulta estética','Revisión post-tratamiento','Acné severo','Manchas','Consulta especializada']),
        status: rand(STATUSES),
        date,
        createdAt: date,
        updatedAt: date,
      });
      await ref.save();
    }
    console.log(`Derivaciones creadas: ${toCreate}`);
  }

  console.log('\n✅ Seed masivo 2026 completado.');
  console.log(`Contraseña común para usuarios demo: ${PASSWORD}`);
  await mongoose.disconnect();
};

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
