const multer = require('multer');
const Clinic = require('../models/Clinic');
const User = require('../models/User');
const Sale = require('../models/Sale');
const Appointment = require('../models/Appointment');
const Product = require('../models/Product');
const Company = require('../models/Company');
const {
  ensureCompanyCache, invalidateCompanyCache, companyOfClinicSync, userCompanyIds, defaultCompanyIdSync,
} = require('../utils/companies');
const { veTodasLasEmpresas } = require('../utils/clinicScope');

// Subida de logo en memoria. Lo guardamos como data URL base64 en clinic.logoUrl
// para evitar dependencias de disco/CDN externos (entornos cloud con FS efímero).
const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (req, file, cb) => {
    if (/^image\/(png|jpe?g|webp|svg\+xml)$/.test(file.mimetype)) return cb(null, true);
    cb(new Error('Formato no permitido. Usa PNG, JPG, WEBP o SVG.'));
  },
}).single('logo');

exports.logoUploadMiddleware = logoUpload;

exports.uploadLogo = async (req, res) => {
  try {
    if (!req.user.isSuperAdmin) {
      const role = req.user.getRoleForClinic(req.params.id);
      if (role !== 'admin') return res.status(403).json({ message: 'Sin permisos para subir logo' });
    }
    if (!req.file) return res.status(400).json({ message: 'Archivo requerido' });
    const dataUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    const clinic = await Clinic.findByIdAndUpdate(
      req.params.id,
      { logoUrl: dataUrl },
      { new: true }
    );
    if (!clinic) return res.status(404).json({ message: 'Clínica no encontrada' });
    res.json(clinic);
  } catch (error) {
    res.status(500).json({ message: 'Error al subir logo', error: error.message });
  }
};

exports.removeLogo = async (req, res) => {
  try {
    if (!req.user.isSuperAdmin) {
      const role = req.user.getRoleForClinic(req.params.id);
      if (role !== 'admin') return res.status(403).json({ message: 'Sin permisos' });
    }
    const clinic = await Clinic.findByIdAndUpdate(
      req.params.id,
      { logoUrl: '' },
      { new: true }
    );
    if (!clinic) return res.status(404).json({ message: 'Clínica no encontrada' });
    res.json(clinic);
  } catch (error) {
    res.status(500).json({ message: 'Error al quitar logo', error: error.message });
  }
};

/**
 * Lista clínicas. Super-admin ve todas; resto solo las suyas.
 *
 * `?scope=names` devuelve TODAS las sucursales de la organización, pero SOLO el
 * nombre y el id. Es para el filtro por sucursal de la agenda: mostrador está
 * asignado a una sola sede y aun así tiene que poder mirar la agenda de las
 * demás (la cita de un paciente puede estar en otra sucursal). Va con proyección
 * y no devolviendo el documento entero a propósito: en el documento de una
 * clínica viven su configuración tributaria y su certificado digital, y para
 * pintar un desplegable no hace falta nada de eso.
 */
exports.getClinics = async (req, res) => {
  try {
    if (req.query.scope === 'names') {
      /**
       * SIN FILTRO DE ROL, y a propósito.
       *
       * Es el contenido de un desplegable: id, nombre y el tamaño de los
       * espacios de agenda. Nada de esto es reservado —el nombre de una sede
       * está en su puerta— y lo necesita cualquiera que agende, que ya no son
       * dos roles: mostrador, administración, el call center y marketing desde
       * el chat. La lista de roles que había aquí era una COPIA de la de
       * agendar, se quedó atrás en cuanto esa cambió, y el síntoma fue un 403
       * mudo que dejaba al call center sin selector de sucursal.
       *
       * Quién puede AGENDAR lo sigue decidiendo la ruta de citas; esto solo
       * pinta el desplegable.
       */
      /**
       * EMPRESAS (oct-2026): cada sucursal viaja con su empresa, para agendar
       * eligiendo primero la empresa. El CRM (call center, marketing) y el
       * super-admin agendan en todas; el resto, en las de sus empresas.
       */
      await ensureCompanyCache();
      const filtro = {};
      if (!req.user.isSuperAdmin && !veTodasLasEmpresas(req)) {
        const empresas = new Set(userCompanyIds(req.user));
        const activa = companyOfClinicSync(req.clinicId);
        if (activa) empresas.add(activa);
        if (empresas.size) filtro.company = { $in: [...empresas] };
      }
      const todas = await Clinic.find(
        filtro,
        '_id name nombreComercial active appointmentSlotMinutes company'
      ).populate('company', 'name').sort({ name: 1 });
      return res.json(todas);
    }
    let clinics;
    if (req.user.isSuperAdmin) {
      clinics = await Clinic.find().populate('company', 'name').sort({ createdAt: -1 });
    } else {
      const clinicIds = req.user.clinics.map((c) => c.clinic);
      clinics = await Clinic.find({ _id: { $in: clinicIds } }).populate('company', 'name').sort({ createdAt: -1 });
    }
    res.json(clinics);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener clínicas', error: error.message });
  }
};

/**
 * Consolidado por sucursal: métricas comparativas (ventas, citas, inventario)
 * de todas las sucursales accesibles. Pensado para admin / super-admin que
 * necesita comparar el desempeño de cada sucursal.
 * Query opcional: ?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD (default: mes actual).
 */
exports.getClinicsOverview = async (req, res) => {
  try {
    let clinicMatch = { active: true };
    if (!req.user.isSuperAdmin) {
      const ids = req.user.clinics.map((c) => c.clinic);
      clinicMatch._id = { $in: ids };
    }
    // El consolidado es de la EMPRESA activa: cada empresa compara sus sucursales.
    if (req.companyId) clinicMatch.company = req.companyId;
    const clinics = await Clinic.find(clinicMatch)
      .select('name nombreComercial')
      .sort({ name: 1 })
      .lean();
    const clinicIds = clinics.map((c) => c._id);

    const now = new Date();
    const start = req.query.startDate
      ? new Date(req.query.startDate)
      : new Date(now.getFullYear(), now.getMonth(), 1);
    const end = req.query.endDate
      ? new Date(new Date(req.query.endDate).setHours(23, 59, 59, 999))
      : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    const [salesAgg, apptAgg, invAgg] = await Promise.all([
      Sale.aggregate([
        { $match: { clinic: { $in: clinicIds }, status: 'completada', createdAt: { $gte: start, $lte: end } } },
        { $group: { _id: '$clinic', count: { $sum: 1 }, total: { $sum: '$total' } } },
      ]),
      Appointment.aggregate([
        { $match: { clinic: { $in: clinicIds }, date: { $gte: start, $lte: end } } },
        { $group: { _id: { clinic: '$clinic', status: '$status' }, count: { $sum: 1 } } },
      ]),
      Product.aggregate([
        { $unwind: '$stockByClinic' },
        { $match: { 'stockByClinic.clinic': { $in: clinicIds } } },
        {
          $group: {
            _id: '$stockByClinic.clinic',
            units: { $sum: '$stockByClinic.stock' },
            value: { $sum: { $multiply: ['$stockByClinic.stock', { $ifNull: ['$averageCost', 0] }] } },
            products: { $sum: { $cond: [{ $gt: ['$stockByClinic.stock', 0] }, 1, 0] } },
          },
        },
      ]),
    ]);

    const salesByClinic = new Map(salesAgg.map((s) => [String(s._id), s]));
    const invByClinic = new Map(invAgg.map((i) => [String(i._id), i]));
    const apptByClinic = new Map();
    for (const a of apptAgg) {
      const key = String(a._id.clinic);
      if (!apptByClinic.has(key)) apptByClinic.set(key, {});
      apptByClinic.get(key)[a._id.status] = a.count;
    }

    const rows = clinics.map((c) => {
      const key = String(c._id);
      const s = salesByClinic.get(key) || { count: 0, total: 0 };
      const inv = invByClinic.get(key) || { units: 0, value: 0, products: 0 };
      const ap = apptByClinic.get(key) || {};
      const apptTotal = Object.values(ap).reduce((sum, n) => sum + n, 0);
      return {
        _id: c._id,
        name: c.nombreComercial || c.name,
        sales: { count: s.count, total: s.total },
        appointments: {
          total: apptTotal,
          pendiente: (ap.pendiente || 0) + (ap.confirmada || 0),
          asistida: (ap.asistida || 0) + (ap.completada || 0),
          no_asistio: ap.no_asistio || 0,
          cancelada: ap.cancelada || 0,
        },
        inventory: { units: inv.units, value: inv.value, products: inv.products },
      };
    });

    // Totales globales (consolidado de la empresa)
    const totals = rows.reduce(
      (t, r) => {
        t.sales.count += r.sales.count;
        t.sales.total += r.sales.total;
        t.appointments.total += r.appointments.total;
        t.appointments.pendiente += r.appointments.pendiente;
        t.appointments.asistida += r.appointments.asistida;
        t.appointments.no_asistio += r.appointments.no_asistio;
        t.inventory.units += r.inventory.units;
        t.inventory.value += r.inventory.value;
        return t;
      },
      {
        sales: { count: 0, total: 0 },
        appointments: { total: 0, pendiente: 0, asistida: 0, no_asistio: 0 },
        inventory: { units: 0, value: 0 },
      }
    );

    res.json({ range: { start, end }, clinics: rows, totals });
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener consolidado de sucursales', error: error.message });
  }
};

exports.getClinic = async (req, res) => {
  try {
    const clinic = await Clinic.findById(req.params.id);
    if (!clinic) return res.status(404).json({ message: 'Clínica no encontrada' });

    if (!req.user.isSuperAdmin) {
      const role = req.user.getRoleForClinic(clinic._id);
      if (!role) return res.status(403).json({ message: 'Sin acceso a esta clínica' });
    }
    res.json(clinic);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener clínica' });
  }
};

/**
 * Crear clínica. Solo super-admin.
 */
exports.createClinic = async (req, res) => {
  try {
    // Toda sucursal nace dentro de una empresa: la elegida, o la de la sucursal activa.
    await ensureCompanyCache();
    const company = req.body.company || req.companyId || defaultCompanyIdSync();
    if (!company || !(await Company.exists({ _id: company }))) {
      return res.status(400).json({ message: 'Elige la empresa de la nueva sucursal' });
    }
    const clinic = await Clinic.create({ ...req.body, company, owner: req.user._id });
    invalidateCompanyCache();

    // Auto-asignar al creador como admin
    await User.findByIdAndUpdate(req.user._id, {
      $push: { clinics: { clinic: clinic._id, role: 'admin' } },
    });
    // `clinics` sí se lee desde `req.user` (getRoleForClinic): si no se invalida,
    // el creador no podría entrar a su clínica recién creada hasta el TTL.
    require('../utils/userCache').invalidate(req.user._id);

    res.status(201).json(clinic);
  } catch (error) {
    res.status(500).json({ message: 'Error al crear clínica', error: error.message });
  }
};

exports.updateClinic = async (req, res) => {
  try {
    if (!req.user.isSuperAdmin) {
      const role = req.user.getRoleForClinic(req.params.id);
      if (role !== 'admin') return res.status(403).json({ message: 'Sin permisos' });
    }
    // La empresa no se cambia aquí: mover una sucursal es POST /clinics/:id/move.
    const { company, ...cambios } = req.body;
    const clinic = await Clinic.findByIdAndUpdate(req.params.id, cambios, {
      new: true,
      runValidators: true,
    });
    if (!clinic) return res.status(404).json({ message: 'Clínica no encontrada' });
    res.json(clinic);
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar clínica', error: error.message });
  }
};

/**
 * MOVER UNA SUCURSAL A OTRA EMPRESA (oct-2026). Solo super-admin.
 *
 * Se mueve la OPERACIÓN y el historial se queda donde se emitió: las facturas
 * pasadas llevan el RUC de la empresa de origen y sus asientos están en su
 * contabilidad. Por eso no se cambia la empresa del documento de la sucursal
 * (eso arrastraría todo su pasado), sino que:
 *   1. Nace una sucursal NUEVA en la empresa destino, con los datos de la de origen.
 *   2. Pasan a ella el personal, las citas por venir, los bloqueos por venir y los
 *      consultorios. El servicio de cada cita se busca por nombre en el catálogo
 *      de la empresa destino.
 *   3. La de origen queda inactiva en su empresa, con todo su historial (ventas,
 *      facturas, caja, contabilidad, citas pasadas) y apuntando a la nueva.
 * Facturación (certificado, puntos de emisión) se configura en la empresa destino.
 */
exports.moveClinic = async (req, res) => {
  try {
    const Room = require('../models/Room');
    const TimeBlock = require('../models/TimeBlock');
    const AppointmentServiceItem = require('../models/AppointmentServiceItem');

    const origen = await Clinic.findById(req.params.id).lean();
    if (!origen) return res.status(404).json({ message: 'Sucursal no encontrada' });
    if (origen.active === false) return res.status(400).json({ message: 'La sucursal está inactiva' });
    const destino = await Company.findOne({ _id: req.body.company, active: { $ne: false } }).lean();
    if (!destino) return res.status(400).json({ message: 'Elige una empresa destino activa' });
    await ensureCompanyCache();
    if (String(companyOfClinicSync(origen._id)) === String(destino._id)) {
      return res.status(400).json({ message: 'La sucursal ya es de esa empresa' });
    }

    const {
      _id, __v, createdAt, updatedAt, accountingCostCenter, company, movedTo, movedFrom,
      ruc, razonSocial, ...datos
    } = origen;
    const nueva = await Clinic.create({
      ...datos,
      company: destino._id,
      // Datos fiscales: los de la empresa destino (los de origen son de otro RUC).
      ruc: destino.ruc || undefined,
      razonSocial: destino.razonSocial || '',
      active: true,
      owner: req.user._id,
      movedFrom: origen._id,
    });
    invalidateCompanyCache();
    await ensureCompanyCache();

    // Personal: cambia esta sucursal por la nueva, con el mismo rol, y pasa a trabajar
    // también en la empresa destino.
    const personal = await User.find({ 'clinics.clinic': origen._id }).select('_id activeClinicId');
    await User.updateMany(
      { 'clinics.clinic': origen._id },
      { $set: { 'clinics.$[c].clinic': nueva._id }, $addToSet: { companies: destino._id } },
      { arrayFilters: [{ 'c.clinic': origen._id }] }
    );
    await User.updateMany({ activeClinicId: origen._id }, { $set: { activeClinicId: nueva._id } });
    const userCache = require('../utils/userCache');
    personal.forEach((u) => userCache.invalidate(String(u._id)));

    // Citas por venir: a la nueva, con el servicio del catálogo de la empresa destino.
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    const futuras = await Appointment.find({ clinic: origen._id, date: { $gte: hoy },
      status: { $in: ['pendiente', 'confirmada'] } }).select('_id serviceItem').lean();
    const servicios = await AppointmentServiceItem.find({ _id: { $in: futuras.map((a) => a.serviceItem).filter(Boolean) } })
      .select('slug').lean();
    const destinoPorSlug = new Map((await AppointmentServiceItem.find({ company: destino._id,
      slug: { $in: servicios.map((s) => s.slug) } }).select('slug').lean()).map((s) => [s.slug, s._id]));
    const slugDe = new Map(servicios.map((s) => [String(s._id), s.slug]));
    if (futuras.length) {
      await Appointment.bulkWrite(futuras.map((a) => ({ updateOne: { filter: { _id: a._id }, update: { $set: {
        clinic: nueva._id,
        serviceItem: a.serviceItem ? destinoPorSlug.get(slugDe.get(String(a.serviceItem))) || a.serviceItem : null,
      } } } })), { ordered: false });
    }
    const bloqueos = await TimeBlock.updateMany({ clinic: origen._id, endDate: { $gte: hoy } }, { $set: { clinic: nueva._id } });
    const consultorios = await Room.updateMany({ clinic: origen._id }, { $set: { clinic: nueva._id } });

    await Clinic.updateOne({ _id: origen._id }, { $set: { active: false, movedTo: nueva._id } });
    invalidateCompanyCache();

    res.json({
      clinic: nueva,
      moved: {
        staff: personal.length,
        appointments: futuras.length,
        timeBlocks: bloqueos.modifiedCount || 0,
        rooms: consultorios.modifiedCount || 0,
      },
    });
  } catch (error) {
    res.status(500).json({ message: 'Error al mover la sucursal', error: error.message });
  }
};

exports.deleteClinic = async (req, res) => {
  try {
    const clinic = await Clinic.findByIdAndUpdate(
      req.params.id,
      { active: false },
      { new: true }
    );
    if (!clinic) return res.status(404).json({ message: 'Clínica no encontrada' });
    res.json({ message: 'Clínica desactivada' });
  } catch (error) {
    res.status(500).json({ message: 'Error al desactivar clínica' });
  }
};
