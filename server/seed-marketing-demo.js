/**
 * Seed enriquecido para demos de marketing.
 *
 * Genera datos abundantes para que los paneles de Marketing, Calendario y
 * Tratamientos muestren información variada:
 *   - 60+ pacientes con distintos orígenes y sourceDetail (nombres de
 *     personas que los refirieron).
 *   - Ventas distribuidas por zonas de Guayaquil (heatmap).
 *   - Citas a lo largo de los últimos 30 días + próximos 14 días, con
 *     algunos reagendamientos y mezcla de createdByRole.
 *   - Tratamientos en distintos avances (algunos cerca de abandono).
 *   - Programas con servicios incluidos y derivaciones variadas.
 *
 * Uso:  node seed-marketing-demo.js
 *
 * Idempotente: si los registros ya existen, sólo agrega lo faltante. Se
 * apoya en seed.js (clínica Shiluv) y opcionalmente seed-demo.js (usuarios
 * y productos base). Si éstos no existen, los crea con un set mínimo.
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

const SOURCES = [
  { source: 'anuncio',   details: ['Facebook Ads', 'Instagram Ads', 'Google Ads', 'TikTok Ads'] },
  { source: 'referido',  details: ['Dra. Patricia Andrade', 'Dr. Javier Mendoza', 'María Rodríguez', 'Andrés Pacheco', 'Camila Naranjo', 'Sofía Castro'] },
  { source: 'recepcion', details: ['Walk-in', 'Volante en sala', 'Recomendación recepción'] },
  { source: 'organico',  details: ['Búsqueda Google', 'Mapa', 'Redes orgánico'] },
];

const FIRST_NAMES = ['Andrés','María','Juan','Sofía','Luis','Camila','Pedro','Valentina','Diego','Paola','Mateo','Isabella','Sebastián','Emilia','Daniel','Antonella','Nicolás','Renata','Tomás','Mía','Joaquín','Catalina','Benjamín','Martina','Lucas','Victoria','Samuel','Julieta','Alejandro','Florencia','Gabriel','Salomé','Ignacio','Aitana','Felipe','Gabriela','Esteban','Romina','Cristóbal','Lorena','Vicente','Daniela','Bruno','Helena','Maximiliano','Carolina','Rafael','Renée','Adrián','Constanza'];
const LAST_NAMES = ['Pacheco','Rodríguez','Pérez','Castro','Vinueza','Naranjo','Ortiz','Mora','Flores','Sánchez','Vélez','Aguilar','Coello','Bermúdez','Reinoso','Quezada','Iturralde','Maldonado','Tinoco','Suárez','Cabezas','Yánez','Alarcón','Espinoza','Salgado','Carrión','Bonilla','Crespo','Encalada','Lara'];

const ZONE_NAMES = GUAYAQUIL_ZONES.map((z) => z.name);

const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

const ymdAdd = (days, base = new Date()) => {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
};

const setHM = (date, h, m = 0) => {
  const d = new Date(date);
  d.setHours(h, m, 0, 0);
  return d;
};

const ensureUser = async (clinicId, email, name, role, extras = {}) => {
  let u = await User.findOne({ email });
  if (!u) {
    const salt = await bcrypt.genSalt(10);
    const password = await bcrypt.hash(PASSWORD, salt);
    u = await User.create({
      name, email, password, ...extras,
      clinics: [{ clinic: clinicId, role }],
    });
    console.log(`Usuario base creado: ${email}`);
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

  // 1) Usuarios base (sólo si no existen)
  const admin = await ensureUser(clinicId, 'admin.demo@shiluv.com', 'Admin Demo', 'admin');
  const cajero = await ensureUser(clinicId, 'cajero.demo@shiluv.com', 'Carla Cajera', 'cajero', { cedula: '0102030405' });
  const callCenter = await ensureUser(clinicId, 'callcenter.demo@shiluv.com', 'Karina Salas', 'call_center');
  const doctor1 = await ensureUser(clinicId, 'doctor1.demo@shiluv.com', 'Dra. Patricia Andrade', 'doctor', { specialty: 'Medicina General' });
  const doctor2 = await ensureUser(clinicId, 'doctor2.demo@shiluv.com', 'Dr. Javier Mendoza', 'doctor', { specialty: 'Dermatología' });
  const doctor3 = await ensureUser(clinicId, 'doctor3.demo@shiluv.com', 'Dra. Lucía Vega', 'doctor', { specialty: 'Estética' });
  const doctors = [doctor1, doctor2, doctor3];

  // 2) Productos base
  const ensureProduct = async (def) => {
    let p = await Product.findOne({ clinic: clinicId, code: def.code });
    if (!p) {
      p = await Product.create({ ...def, clinic: clinicId, active: true });
      console.log(`Producto: ${def.name}`);
    }
    return p;
  };
  const services = {
    CON: await ensureProduct({ name: 'Consulta general',          code: 'SRV-CON', category: 'servicio', salePrice: 25, taxRate: 0, unlimited: true }),
    LIM: await ensureProduct({ name: 'Limpieza facial profunda',  code: 'SRV-LIM', category: 'servicio', salePrice: 45, taxRate: 15, unlimited: true }),
    BOT: await ensureProduct({ name: 'Botox por unidad',          code: 'SRV-BOT', category: 'servicio', salePrice: 12, taxRate: 15, unlimited: true }),
    LAS: await ensureProduct({ name: 'Sesión de láser',           code: 'SRV-LAS', category: 'servicio', salePrice: 80, taxRate: 15, unlimited: true }),
    MIC: await ensureProduct({ name: 'Microdermoabrasión',        code: 'SRV-MIC', category: 'servicio', salePrice: 60, taxRate: 15, unlimited: true }),
    PRP: await ensureProduct({ name: 'Plasma rico en plaquetas',  code: 'SRV-PRP', category: 'servicio', salePrice: 150, taxRate: 15, unlimited: true }),
  };

  // Programa
  let progRej = await Product.findOne({ clinic: clinicId, code: 'PROG-REJ' });
  if (!progRej) {
    progRej = await Product.create({
      clinic: clinicId,
      name: 'Programa Rejuvenecimiento (5 sesiones)',
      code: 'PROG-REJ',
      category: 'programa',
      salePrice: 350, taxRate: 15, unlimited: true, active: true,
      programServices: [
        { product: services.LIM._id, quantity: 2 },
        { product: services.LAS._id, quantity: 2 },
        { product: services.PRP._id, quantity: 1 },
      ],
    });
    console.log('Programa creado: Rejuvenecimiento');
  }
  let progAcne = await Product.findOne({ clinic: clinicId, code: 'PROG-ACN' });
  if (!progAcne) {
    progAcne = await Product.create({
      clinic: clinicId,
      name: 'Programa Anti-Acné (4 sesiones)',
      code: 'PROG-ACN',
      category: 'programa',
      salePrice: 280, taxRate: 15, unlimited: true, active: true,
      programServices: [
        { product: services.LIM._id, quantity: 2 },
        { product: services.MIC._id, quantity: 2 },
      ],
    });
    console.log('Programa creado: Anti-Acné');
  }
  let progBotox = await Product.findOne({ clinic: clinicId, code: 'PROG-BOT' });
  if (!progBotox) {
    progBotox = await Product.create({
      clinic: clinicId,
      name: 'Programa Botox Express',
      code: 'PROG-BOT',
      category: 'programa',
      salePrice: 240, taxRate: 15, unlimited: true, active: true,
      programServices: [
        { product: services.BOT._id, quantity: 20 },
        { product: services.CON._id, quantity: 1 },
      ],
    });
    console.log('Programa creado: Botox Express');
  }

  // 3) Rooms (asegura al menos 2)
  let rooms = await Room.find({ clinic: clinicId });
  if (rooms.length < 2) {
    rooms = [];
    for (const r of [
      { name: 'Consultorio Demo 1', code: 'CD1', manager: doctor1._id },
      { name: 'Consultorio Demo 2', code: 'CD2', manager: doctor2._id },
    ]) {
      const room = await Room.create({ ...r, clinic: clinicId, active: true });
      rooms.push(room);
    }
  }

  // 4) Generar 60 pacientes
  const existingPatients = await Patient.countDocuments({ clinic: clinicId });
  const target = 60;
  const created = [];
  if (existingPatients < target) {
    const toCreate = target - existingPatients;
    for (let i = 0; i < toCreate; i++) {
      const firstName = rand(FIRST_NAMES);
      const lastName = rand(LAST_NAMES);
      const cedula = `09${randInt(10000000, 99999999)}`;
      const exists = await Patient.findOne({ clinic: clinicId, cedula });
      if (exists) continue;
      const srcConfig = rand(SOURCES);
      const pat = await Patient.create({
        clinic: clinicId,
        firstName,
        lastName,
        cedula,
        phone: `09${randInt(60000000, 99999999)}`,
        email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}${i}@example.com`,
        source: srcConfig.source,
        sourceDetail: rand(srcConfig.details),
        address: `${rand(['Av.','Calle','Ciudadela'])} ${rand(['Las Aguas','Los Mangos','Bellavista','La Riviera','El Sol','Las Lomas'])} ${randInt(100, 999)}`,
        active: true,
      });
      created.push(pat);
    }
    console.log(`Pacientes creados: ${created.length}`);
  }
  const allPatients = await Patient.find({ clinic: clinicId }).limit(80);

  // 5) Ventas distribuidas por zonas Guayaquil
  const existingSales = await Sale.countDocuments({ clinic: clinicId });
  if (existingSales < 80) {
    const toCreateSales = 80 - existingSales;
    const serviceList = Object.values(services);
    for (let i = 0; i < toCreateSales; i++) {
      const pat = rand(allPatients);
      const zone = rand(ZONE_NAMES);
      const itemsCount = randInt(1, 3);
      const items = [];
      let subtotal = 0, tax = 0;
      for (let j = 0; j < itemsCount; j++) {
        const p = rand(serviceList);
        const qty = randInt(1, 2);
        const base = p.salePrice * qty;
        const t = base * (p.taxRate / 100);
        subtotal += base;
        tax += t;
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
      const dayOffset = -randInt(0, 60);
      const saleDate = ymdAdd(dayOffset);
      await Sale.create({
        clinic: clinicId,
        patient: pat._id,
        clientName: `${pat.firstName} ${pat.lastName}`,
        clientCedula: pat.cedula || '9999999999999',
        clientPhone: pat.phone,
        clientAddress: pat.address,
        clientCity: 'Guayaquil',
        clientZone: zone,
        items,
        subtotal: +subtotal.toFixed(2),
        discountTotal: 0,
        taxAmount: +tax.toFixed(2),
        total: +total.toFixed(2),
        paymentMethod: rand(['efectivo','tarjeta','transferencia']),
        status: 'completada',
        cashier: cajero._id,
        createdBy: rand([cajero._id, admin._id]),
        createdAt: saleDate,
        updatedAt: saleDate,
      });
    }
    console.log(`Ventas demo creadas: ${toCreateSales}`);
  }

  // 6) Citas (con reagendamientos)
  const existingAppts = await Appointment.countDocuments({ clinic: clinicId });
  if (existingAppts < 80) {
    const toCreate = 80 - existingAppts;
    const STATES = ['pendiente','confirmada','asistida','no_asistio','cancelada','completada'];
    const ROLES = ['call_center','cajero','admin','doctor'];
    for (let i = 0; i < toCreate; i++) {
      const offset = randInt(-30, 14);
      const day = ymdAdd(offset);
      const startH = randInt(8, 17);
      const startTime = `${String(startH).padStart(2,'0')}:00`;
      const endTime = `${String(startH).padStart(2,'0')}:30`;
      const pat = rand(allPatients);
      const doc = rand(doctors);
      const status = offset < 0
        ? rand(['asistida','no_asistio','completada','cancelada','asistida','asistida'])
        : rand(['pendiente','confirmada','pendiente','confirmada']);
      const createdByRole = rand(ROLES);
      const serviceList = Object.values(services);
      const sv = rand(serviceList);
      const appt = await Appointment.create({
        clinic: clinicId,
        patient: pat._id,
        doctor: doc._id,
        room: rand(rooms)._id,
        date: setHM(day, 0, 0),
        startTime,
        endTime,
        services: [{ product: sv._id, name: sv.name, price: sv.salePrice, quantity: 1 }],
        status,
        createdBy: createdByRole === 'call_center' ? callCenter._id
                  : createdByRole === 'cajero' ? cajero._id
                  : createdByRole === 'doctor' ? doc._id
                  : admin._id,
        createdByRole,
      });
      // 25% de los pasados fueron reagendados
      if (offset < 0 && Math.random() < 0.25) {
        const oldDate = ymdAdd(offset - randInt(1, 5));
        appt.rescheduleHistory.push({
          previousDate: setHM(oldDate, 0, 0),
          previousStartTime: '10:00',
          previousEndTime: '10:30',
          newDate: appt.date,
          newStartTime: appt.startTime,
          newEndTime: appt.endTime,
          rescheduledBy: callCenter._id,
          rescheduledByName: 'Karina Salas',
          rescheduledByRole: 'call_center',
          reason: rand(['Paciente solicitó cambio', 'Conflicto de horarios del doctor', 'Reorganización de agenda']),
        });
        await appt.save();
      }
    }
    console.log('Citas demo creadas');
  }

  // 7) Tratamientos en distintos avances
  const existingTreats = await Treatment.countDocuments({ clinic: clinicId });
  if (existingTreats < 15) {
    const toCreate = 15 - existingTreats;
    for (let i = 0; i < toCreate; i++) {
      const pat = rand(allPatients);
      const doc = rand(doctors);
      const startOffset = -randInt(5, 90);
      const lastActivityOffset = -randInt(0, 20); // algunos cerca de abandono (12-15 días)
      const isNearAbandon = i % 4 === 0;
      const items = [
        { product: services.LIM._id, name: services.LIM.name, quantity: 4, completed: randInt(0, 3) },
        { product: services.MIC._id, name: services.MIC.name, quantity: 3, completed: randInt(0, 2) },
      ];
      if (i % 2 === 0) items.push({ product: services.PRP._id, name: services.PRP.name, quantity: 2, completed: randInt(0, 1) });
      await Treatment.create({
        clinic: clinicId,
        patient: pat._id,
        name: rand(['Plan dermatológico facial', 'Programa anti-acné', 'Tratamiento de manchas', 'Rejuvenecimiento integral']),
        prescribedBy: doc._id,
        startDate: ymdAdd(startOffset),
        targetEndDate: ymdAdd(startOffset + 90),
        status: 'activo',
        source: rand(['referral','appointment','manual']),
        items,
        lastActivityAt: ymdAdd(isNearAbandon ? -randInt(12, 14) : lastActivityOffset),
        createdBy: doc._id,
      });
    }
    console.log('Tratamientos demo creados');
  }

  // 8) Derivaciones extra (variedad de estados)
  const refCount = await Referral.countDocuments({ clinic: clinicId });
  if (refCount < 12) {
    const toCreate = 12 - refCount;
    const STATUSES = ['pendiente','agendada','atendida','cancelada'];
    for (let i = 0; i < toCreate; i++) {
      const fromDoc = rand(doctors);
      let toDoc = rand(doctors);
      while (String(toDoc._id) === String(fromDoc._id)) toDoc = rand(doctors);
      await Referral.create({
        clinic: clinicId,
        fromDoctor: fromDoc._id,
        toDoctor: toDoc._id,
        patient: rand(allPatients)._id,
        specialty: toDoc.specialty || 'Estética',
        reason: rand(['Evaluación dermatológica','Consulta estética','Revisión post-tratamiento','Acné severo']),
        status: rand(STATUSES),
        date: ymdAdd(-randInt(0, 20)),
      });
    }
    console.log('Derivaciones demo creadas');
  }

  console.log('\n✅ Seed marketing demo completado.');
  console.log(`Usuarios demo: contraseña común = ${PASSWORD}`);
  await mongoose.disconnect();
};

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
