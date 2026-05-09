/**
 * Seed de datos demo para el proyecto Shiluv.
 *
 * Llena la app con: usuarios de cada rol, productos, programas, descuentos,
 * pacientes con distintos orígenes, citas en todos sus estados,
 * tratamientos en distintos avances, derivaciones, ventas, bloqueos y
 * consultorios físicos.
 *
 * Uso:  node seed-demo.js
 *
 * Idempotente: si los emails ya existen no los duplica (solo agrega los
 * datos faltantes). Ejecutar primero `node seed.js` para crear el
 * super-admin y la clínica Shiluv.
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
const TimeBlock = require('./models/TimeBlock');
const Discount = require('./models/Discount');

const PASSWORD = 'Demo2026!';

const USERS = [
  { email: 'admin.demo@shiluv.com',     name: 'Admin Demo',     role: 'admin' },
  { email: 'cajero.demo@shiluv.com',    name: 'Carla Cajera',   role: 'cajero', cedula: '0102030405' },
  { email: 'conta.demo@shiluv.com',     name: 'Carlos Contable', role: 'contabilidad' },
  { email: 'doctor1.demo@shiluv.com',   name: 'Dra. Patricia Andrade', role: 'doctor', specialty: 'Medicina General' },
  { email: 'doctor2.demo@shiluv.com',   name: 'Dr. Javier Mendoza',    role: 'doctor', specialty: 'Dermatología' },
  { email: 'doctor3.demo@shiluv.com',   name: 'Dra. Lucía Vega',       role: 'doctor', specialty: 'Estética' },
  { email: 'callcenter.demo@shiluv.com', name: 'Karina Salas',         role: 'call_center' },
  { email: 'marketing.demo@shiluv.com',  name: 'Mario Marketing',      role: 'marketing' },
  { email: 'enfermera.demo@shiluv.com',  name: 'Elena Enfermera',      role: 'enfermero' },
];

const PATIENTS = [
  { firstName: 'Andrés',    lastName: 'Pacheco',  cedula: '1700000001', phone: '0991111111', email: 'andres@example.com',  source: 'anuncio',   sourceDetail: 'Facebook Ads' },
  { firstName: 'María',     lastName: 'Rodríguez',cedula: '1700000002', phone: '0992222222', email: 'maria@example.com',   source: 'referido',  sourceDetail: 'Recomendación de paciente' },
  { firstName: 'Juan',      lastName: 'Pérez',    cedula: '1700000003', phone: '0993333333', email: 'juan@example.com',    source: 'recepcion' },
  { firstName: 'Sofía',     lastName: 'Castro',   cedula: '1700000004', phone: '0994444444', email: 'sofia@example.com',   source: 'anuncio',   sourceDetail: 'Instagram Ads' },
  { firstName: 'Luis',      lastName: 'Vinueza',  cedula: '1700000005', phone: '0995555555', email: 'luis@example.com',    source: 'organico' },
  { firstName: 'Camila',    lastName: 'Naranjo',  cedula: '',           phone: '0996666666', email: 'camila@example.com',  source: 'referido' },
  { firstName: 'Pedro',     lastName: 'Ortiz',    cedula: '1700000007', phone: '0997777777', email: 'pedro@example.com',   source: 'recepcion' },
  { firstName: 'Valentina', lastName: 'Mora',     cedula: '1700000008', phone: '0998888888', email: 'val@example.com',     source: 'anuncio',   sourceDetail: 'Google Ads' },
  { firstName: 'Diego',     lastName: 'Flores',   cedula: '1700000009', phone: '0999999999', email: 'diego@example.com',   source: 'organico' },
  { firstName: 'Paola',     lastName: 'Sánchez',  cedula: '1700000010', phone: '0991010101', email: 'paola@example.com',   source: 'referido' },
];

const PRODUCTS = [
  // Servicios
  { name: 'Consulta general',           code: 'SRV-CON',  category: 'servicio',  salePrice: 25, taxRate: 0,  unlimited: true },
  { name: 'Limpieza facial profunda',   code: 'SRV-LIM',  category: 'servicio',  salePrice: 45, taxRate: 15, unlimited: true },
  { name: 'Botox por unidad',           code: 'SRV-BOT',  category: 'servicio',  salePrice: 12, taxRate: 15, unlimited: true },
  { name: 'Sesión de láser',            code: 'SRV-LAS',  category: 'servicio',  salePrice: 80, taxRate: 15, unlimited: true },
  { name: 'Microdermoabrasión',         code: 'SRV-MIC',  category: 'servicio',  salePrice: 60, taxRate: 15, unlimited: true },
  { name: 'Plasma rico en plaquetas',   code: 'SRV-PRP',  category: 'servicio',  salePrice: 150, taxRate: 15, unlimited: true },
  // Productos físicos
  { name: 'Crema hidratante',           code: 'PROD-CRH', category: 'insumo',    salePrice: 22, taxRate: 15, stock: 30, minStock: 5 },
  { name: 'Protector solar SPF 50',     code: 'PROD-PSL', category: 'insumo',    salePrice: 28, taxRate: 15, stock: 25, minStock: 5 },
  { name: 'Sérum vitamina C',           code: 'PROD-SVC', category: 'insumo',    salePrice: 35, taxRate: 15, stock: 18, minStock: 3 },
  // Medicamentos
  { name: 'Paracetamol 500mg',          code: 'MED-PAR',  category: 'medicamento', salePrice: 5, taxRate: 0, stock: 100, minStock: 20 },
];

const PROGRAM_BLUEPRINT = {
  name: 'Programa Rejuvenecimiento (5 sesiones)',
  code: 'PROG-REJ',
  category: 'programa',
  salePrice: 350,
  taxRate: 15,
  unlimited: true,
  // se configura programServices más abajo después de tener los IDs
};

const ymdAdd = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
};

const setHM = (date, h, m = 0) => {
  const d = new Date(date);
  d.setHours(h, m, 0, 0);
  return d;
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

  // 1) Usuarios
  const userByEmail = {};
  for (const u of USERS) {
    let existing = await User.findOne({ email: u.email });
    if (!existing) {
      const salt = await bcrypt.genSalt(10);
      const password = await bcrypt.hash(PASSWORD, salt);
      existing = await User.create({
        name: u.name,
        email: u.email,
        password,
        cedula: u.cedula,
        specialty: u.specialty,
        clinics: [{ clinic: clinicId, role: u.role }],
      });
      console.log(`Usuario creado: ${u.email} (${u.role})`);
    } else {
      const has = (existing.clinics || []).some((c) => String(c.clinic) === String(clinicId));
      if (!has) {
        existing.clinics.push({ clinic: clinicId, role: u.role });
        await existing.save();
      }
    }
    userByEmail[u.email] = existing;
  }

  const adminUser = userByEmail['admin.demo@shiluv.com'];
  const cajero = userByEmail['cajero.demo@shiluv.com'];
  const callCenter = userByEmail['callcenter.demo@shiluv.com'];
  const enfermera = userByEmail['enfermera.demo@shiluv.com'];
  const doctor1 = userByEmail['doctor1.demo@shiluv.com'];
  const doctor2 = userByEmail['doctor2.demo@shiluv.com'];
  const doctor3 = userByEmail['doctor3.demo@shiluv.com'];

  // 2) Productos
  const prodByCode = {};
  for (const p of PRODUCTS) {
    let prod = await Product.findOne({ clinic: clinicId, code: p.code });
    if (!prod) {
      prod = await Product.create({ ...p, clinic: clinicId, active: true });
      console.log(`Producto creado: ${p.name}`);
    }
    prodByCode[p.code] = prod;
  }
  // Programa que agrupa servicios
  let programa = await Product.findOne({ clinic: clinicId, code: PROGRAM_BLUEPRINT.code });
  if (!programa) {
    programa = await Product.create({
      ...PROGRAM_BLUEPRINT,
      clinic: clinicId,
      active: true,
      programServices: [
        { product: prodByCode['SRV-LIM']._id, quantity: 2 },
        { product: prodByCode['SRV-LAS']._id, quantity: 2 },
        { product: prodByCode['SRV-PRP']._id, quantity: 1 },
      ],
    });
    console.log(`Programa creado: ${PROGRAM_BLUEPRINT.name}`);
  }
  prodByCode['PROG-REJ'] = programa;

  // 3) Consultorios físicos (rooms)
  const roomDefs = [
    { name: 'Consultorio 1', code: 'C1', manager: doctor1._id },
    { name: 'Consultorio 2', code: 'C2', manager: doctor2._id },
    { name: 'Sala de procedimientos', code: 'SP', manager: enfermera._id },
  ];
  const rooms = [];
  for (const r of roomDefs) {
    let room = await Room.findOne({ clinic: clinicId, name: r.name });
    if (!room) {
      room = await Room.create({ ...r, clinic: clinicId, active: true });
      console.log(`Consultorio: ${r.name}`);
    }
    rooms.push(room);
  }

  // 4) Bloqueos demo
  const block1 = await TimeBlock.findOne({ clinic: clinicId, reason: 'Feriado nacional' });
  if (!block1) {
    await TimeBlock.create({
      clinic: clinicId,
      startDate: ymdAdd(7),
      endDate: ymdAdd(7),
      allDay: true,
      reason: 'Feriado nacional',
      createdBy: adminUser._id,
    });
  }
  const block2 = await TimeBlock.findOne({ clinic: clinicId, reason: 'Vacaciones Dr. Mendoza' });
  if (!block2) {
    await TimeBlock.create({
      clinic: clinicId,
      doctor: doctor2._id,
      startDate: ymdAdd(14),
      endDate: ymdAdd(21),
      allDay: true,
      reason: 'Vacaciones Dr. Mendoza',
      createdBy: adminUser._id,
    });
  }

  // 5) Descuento demo
  let descuento = await Discount.findOne({ clinic: clinicId, name: 'Promo lanzamiento' });
  if (!descuento) {
    descuento = await Discount.create({
      clinic: clinicId,
      name: 'Promo lanzamiento',
      type: 'percentage',
      value: 10,
      scope: 'all',
      active: true,
      createdBy: adminUser._id,
    });
    console.log('Descuento creado');
  }

  // 6) Pacientes
  const patientList = [];
  for (const p of PATIENTS) {
    let pat = await Patient.findOne({
      clinic: clinicId,
      firstName: p.firstName,
      lastName: p.lastName,
    });
    if (!pat) {
      pat = await Patient.create({
        ...p,
        clinic: clinicId,
        active: true,
        antecedentesFamiliares: 'Sin antecedentes relevantes reportados.',
        antecedentesPatologicos: 'Ninguno conocido.',
      });
      console.log(`Paciente: ${p.firstName} ${p.lastName} (${p.source})`);
    }
    patientList.push(pat);
  }

  // 7) Citas: una variedad de estados a lo largo de las próximas 2 semanas + pasadas
  const states = ['pendiente', 'confirmada', 'asistida', 'no_asistio', 'cancelada', 'completada'];
  const baseDoctors = [doctor1, doctor2, doctor3];
  const apptCount = await Appointment.countDocuments({ clinic: clinicId });
  if (apptCount < 20) {
    for (let i = 0; i < 24; i++) {
      const offset = i - 8; // de hace 8 días a +15 días
      const day = ymdAdd(offset);
      const startH = 8 + (i % 8);
      const startTime = `${String(startH).padStart(2, '0')}:00`;
      const endTime = `${String(startH).padStart(2, '0')}:30`;
      const patient = patientList[i % patientList.length];
      const doctor = baseDoctors[i % baseDoctors.length];
      const status = offset < 0
        ? states[i % states.length]
        : (i % 3 === 0 ? 'pendiente' : i % 3 === 1 ? 'confirmada' : 'asistida');
      const services = [
        { product: prodByCode['SRV-CON']._id, name: 'Consulta general', price: 25, quantity: 1 },
      ];
      if (i % 4 === 0) services.push({ product: prodByCode['SRV-LIM']._id, name: 'Limpieza facial', price: 45, quantity: 1 });
      await Appointment.create({
        clinic: clinicId,
        patient: patient._id,
        doctor: doctor._id,
        room: rooms[i % rooms.length]._id,
        date: setHM(day, 0, 0),
        startTime,
        endTime,
        services,
        status,
        paidInAdvance: i % 5 === 0,
        advanceAmount: i % 5 === 0 ? 25 : 0,
        notes: '',
        createdBy: callCenter._id,
      });
    }
    console.log('Citas demo creadas');
  }

  // 8) Tratamientos demo
  const trCount = await Treatment.countDocuments({ clinic: clinicId });
  if (trCount < 4) {
    const t1 = await Treatment.create({
      clinic: clinicId,
      patient: patientList[0]._id,
      name: 'Plan dermatológico facial',
      description: 'Tratamiento de 3 meses para acné y manchas',
      prescribedBy: doctor2._id,
      startDate: ymdAdd(-30),
      targetEndDate: ymdAdd(60),
      status: 'activo',
      items: [
        { product: prodByCode['SRV-LIM']._id, name: 'Limpieza facial profunda', quantity: 4, completed: 2 },
        { product: prodByCode['SRV-MIC']._id, name: 'Microdermoabrasión',        quantity: 3, completed: 1 },
        { product: prodByCode['SRV-PRP']._id, name: 'Plasma rico en plaquetas',  quantity: 2, completed: 0 },
      ],
      createdBy: doctor2._id,
    });
    await Treatment.create({
      clinic: clinicId,
      patient: patientList[1]._id,
      name: 'Programa rejuvenecimiento',
      description: 'Programa de 5 sesiones',
      prescribedBy: doctor3._id,
      startDate: ymdAdd(-15),
      status: 'activo',
      items: [
        { product: prodByCode['SRV-LAS']._id, name: 'Sesión de láser',           quantity: 2, completed: 2 },
        { product: prodByCode['SRV-LIM']._id, name: 'Limpieza facial profunda', quantity: 2, completed: 1 },
        { product: prodByCode['SRV-PRP']._id, name: 'Plasma rico en plaquetas', quantity: 1, completed: 0 },
      ],
      createdBy: doctor3._id,
    });
    await Treatment.create({
      clinic: clinicId,
      patient: patientList[3]._id,
      name: 'Tratamiento botox',
      prescribedBy: doctor3._id,
      startDate: ymdAdd(-60),
      status: 'completado',
      items: [
        { product: prodByCode['SRV-BOT']._id, name: 'Botox por unidad', quantity: 30, completed: 30 },
      ],
      createdBy: doctor3._id,
    });
    console.log('Tratamientos demo creados');
  }

  // 9) Derivaciones demo
  const refCount = await Referral.countDocuments({ clinic: clinicId });
  if (refCount < 4) {
    const refs = [
      { fromDoctor: doctor1._id, toDoctor: doctor2._id, patient: patientList[0]._id, specialty: 'Dermatología', reason: 'Lesión en mejilla',  status: 'agendada',  date: ymdAdd(-2) },
      { fromDoctor: doctor1._id, toDoctor: doctor3._id, patient: patientList[2]._id, specialty: 'Estética',     reason: 'Consulta estética', status: 'pendiente', date: ymdAdd(-1) },
      { fromDoctor: doctor2._id, toDoctor: doctor3._id, patient: patientList[5]._id, specialty: 'Estética',     reason: 'Tratamiento facial', status: 'atendida', date: ymdAdd(-5) },
      { fromDoctor: doctor1._id, toDoctor: doctor2._id, patient: patientList[7]._id, specialty: 'Dermatología', reason: 'Acné severo',       status: 'agendada',  date: ymdAdd(-3) },
    ];
    for (const r of refs) {
      await Referral.create({ ...r, clinic: clinicId });
    }
    console.log('Derivaciones demo creadas');
  }

  // 10) Ventas demo (con descuento, vinculadas a tratamientos cuando aplica)
  const saleCount = await Sale.countDocuments({ clinic: clinicId });
  if (saleCount < 6) {
    const sampleSales = [
      {
        patient: patientList[0],
        items: [
          { code: 'SRV-CON', qty: 1, discount: 0 },
          { code: 'PROD-PSL', qty: 1, discount: 2 },
        ],
      },
      {
        patient: patientList[1],
        items: [{ code: 'SRV-LIM', qty: 1, discount: 5 }],
      },
      {
        patient: patientList[3],
        items: [
          { code: 'SRV-BOT', qty: 10, discount: 10 },
          { code: 'PROD-CRH', qty: 1, discount: 0 },
        ],
      },
      {
        patient: patientList[4],
        items: [{ code: 'PROD-SVC', qty: 2, discount: 7 }],
      },
      {
        patient: patientList[5],
        items: [{ code: 'SRV-LAS', qty: 1, discount: 0 }],
      },
      {
        patient: patientList[6],
        items: [{ code: 'MED-PAR', qty: 5, discount: 0 }],
      },
    ];
    for (const s of sampleSales) {
      let subtotal = 0;
      let discTotal = 0;
      let tax = 0;
      const items = s.items.map((it) => {
        const p = prodByCode[it.code];
        const base = p.salePrice * it.qty;
        const sub = base - it.discount;
        const t = sub * (p.taxRate / 100);
        subtotal += base;
        discTotal += it.discount;
        tax += t;
        return {
          product: p._id,
          productCode: p.code,
          productName: p.name,
          category: p.category,
          quantity: it.qty,
          unitPrice: p.salePrice,
          taxRate: p.taxRate,
          discount: it.discount,
          subtotal: +sub.toFixed(2),
        };
      });
      await Sale.create({
        clinic: clinicId,
        patient: s.patient._id,
        clientName: `${s.patient.firstName} ${s.patient.lastName}`,
        clientCedula: s.patient.cedula || '9999999999999',
        items,
        subtotal: +subtotal.toFixed(2),
        discountTotal: +discTotal.toFixed(2),
        taxAmount: +tax.toFixed(2),
        total: +(subtotal - discTotal + tax).toFixed(2),
        paymentMethod: 'efectivo',
        status: 'completada',
        cashier: cajero._id,
        callCenter: callCenter._id,
        createdBy: cajero._id,
      });
    }
    console.log('Ventas demo creadas');
  }

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(' DATA DEMO CARGADA');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(' Usuarios demo (contraseña común: %s):', PASSWORD);
  USERS.forEach((u) => console.log(`   ${u.role.padEnd(13)} → ${u.email}`));
  console.log('══════════════════════════════════════════════════════════════\n');

  await mongoose.disconnect();
  process.exit(0);
};

seed().catch((err) => {
  console.error('Error al sembrar datos demo:', err);
  process.exit(1);
});
