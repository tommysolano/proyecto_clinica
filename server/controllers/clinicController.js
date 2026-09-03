const multer = require('multer');
const Clinic = require('../models/Clinic');
const User = require('../models/User');
const Sale = require('../models/Sale');
const Appointment = require('../models/Appointment');
const Product = require('../models/Product');

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
      if (!req.user.isSuperAdmin && !['admin', 'cajero'].includes(req.role)) {
        return res.status(403).json({ message: 'No tienes permisos para esta acción' });
      }
      const todas = await Clinic.find(
        {},
        '_id name nombreComercial active appointmentSlotMinutes'
      ).sort({ name: 1 });
      return res.json(todas);
    }
    let clinics;
    if (req.user.isSuperAdmin) {
      clinics = await Clinic.find().sort({ createdAt: -1 });
    } else {
      const clinicIds = req.user.clinics.map((c) => c.clinic);
      clinics = await Clinic.find({ _id: { $in: clinicIds } }).sort({ createdAt: -1 });
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
    const clinic = await Clinic.create({ ...req.body, owner: req.user._id });

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
    const clinic = await Clinic.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!clinic) return res.status(404).json({ message: 'Clínica no encontrada' });
    res.json(clinic);
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar clínica', error: error.message });
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
