const bcrypt = require('bcryptjs');
const multer = require('multer');
const User = require('../models/User');
const { VALID_ROLES, DOCTOR_LIKE_ROLES } = require('../constants/roles');
const { sucursalPedida } = require('../utils/clinicScope');
const { encrypt: encryptSecret } = require('../modules/invoicing/ec/crypto');
const {
  loadP12,
  guardarCertificado,
  borrarCertificado,
  estadoFirma,
} = require('../utils/pdfSignature');

const sanitizeClinics = (clinics, fallbackClinicId) => {
  if (!Array.isArray(clinics)) return [];
  return clinics
    .filter((c) => c && c.clinic && VALID_ROLES.includes(c.role))
    .map((c) => ({ clinic: c.clinic, role: c.role }));
};

/**
 * SUCURSALES QUE ESTE ADMINISTRADOR PUEDE GESTIONAR.
 *
 * El super-admin (el dueño) las gestiona todas. Un admin de sucursal, solo
 * aquellas donde ÉL es admin — que pueden ser varias. Es la misma regla que ya
 * aplicaba `updateUser`, generalizada: antes solo se podía tocar la sucursal
 * activa, y eso obligaba a cambiar de sede en el menú para mover a una persona.
 */
const clinicasQueGestiona = async (req) => {
  const Clinic = require('../models/Clinic');
  const filtro = req.user.isSuperAdmin
    ? { active: { $ne: false } }
    : {
        _id: {
          $in: (req.user.clinics || []).filter((c) => c.role === 'admin').map((c) => c.clinic),
        },
        active: { $ne: false },
      };
  // `appointmentSlotMinutes` viaja aquí para que la pantalla de Configuración
  // pinte sus dos pestañas (personal y agenda) con una sola petición.
  return Clinic.find(filtro)
    .select('name nombreComercial appointmentSlotMinutes')
    .sort({ name: 1 })
    .lean();
};

/**
 * EN QUÉ SUCURSAL ESTÁ CADA PERSONA.
 *
 * Devuelve la rejilla completa: las sucursales que este admin gestiona y el
 * personal que trabaja en alguna de ellas, con su rol en cada una.
 *
 * De esto dependen los avisos: cuando una cita necesita enfermería, el aviso
 * sale a los enfermeros DE ESA SUCURSAL (`notificarRol(clinicId, 'enfermero')`,
 * que filtra por `clinics: {$elemMatch: {clinic, role}}`). Si alguien está
 * asignado a tres sedes, le suenan las tres. Esta pantalla es donde se arregla.
 */
exports.getStaffAssignments = async (req, res) => {
  try {
    const clinics = await clinicasQueGestiona(req);
    const ids = clinics.map((c) => c._id);
    // Se listan también los desactivados: aparecen en gris y se pueden reactivar
    // sin tener que adivinar que existen.
    const users = await User.find({ 'clinics.clinic': { $in: ids } })
      .select('name email specialty active isSuperAdmin clinics worksInAllClinics')
      .sort({ name: 1 })
      .lean();
    res.json({ clinics, users });
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener las asignaciones', error: error.message });
  }
};

/**
 * Cambia en qué sucursales trabaja una persona y con qué rol en cada una.
 *
 * `assignments` es la lista COMPLETA para las sucursales que este admin
 * gestiona; lo que no venga se interpreta como "ya no trabaja ahí". Las
 * asignaciones en sedes que NO gestiona se conservan intactas: un admin de
 * Norte no puede sacar a nadie de Sur ni sin querer.
 */
exports.updateStaffAssignments = async (req, res) => {
  try {
    const { assignments } = req.body;
    if (!Array.isArray(assignments)) {
      return res.status(400).json({ message: 'Faltan las asignaciones' });
    }

    const clinics = await clinicasQueGestiona(req);
    const gestionables = new Set(clinics.map((c) => String(c._id)));

    const target = await User.findById(req.params.id);
    if (!target) return res.status(404).json({ message: 'Usuario no encontrado' });
    // Al dueño solo lo toca el dueño.
    if (target.isSuperAdmin && !req.user.isSuperAdmin) {
      return res.status(403).json({ message: 'No puedes cambiar las sucursales del super-admin' });
    }

    const intactas = target.clinics.filter((c) => !gestionables.has(String(c.clinic)));
    // Una sola fila por sucursal: dos roles en la misma sede no existen, y con
    // duplicados `getRoleForClinic` devolvería el primero que encuentre.
    const porClinica = new Map();
    for (const a of assignments) {
      if (!a || !a.clinic || !VALID_ROLES.includes(a.role)) continue;
      if (!gestionables.has(String(a.clinic))) continue;
      porClinica.set(String(a.clinic), { clinic: a.clinic, role: a.role });
    }

    /**
     * NADIE SE QUITA A SÍ MISMO EL ADMIN.
     *
     * Sin esto, un administrador que se cambia de sucursal en su propia fila se
     * queda sin la pantalla desde la que acaba de hacerlo —y sin nadie a quien
     * pedírselo si es el único—. El super-admin sí puede: él nunca se queda
     * fuera, su acceso no depende de esta lista.
     */
    if (!req.user.isSuperAdmin && String(target._id) === String(req.user._id)) {
      for (const c of target.clinics) {
        if (c.role !== 'admin' || !gestionables.has(String(c.clinic))) continue;
        if (porClinica.get(String(c.clinic))?.role !== 'admin') {
          return res.status(400).json({
            message: 'No puedes quitarte a ti mismo el rol de administrador. Pídeselo a otro administrador.',
            code: 'SELF_DEMOTION',
          });
        }
      }
    }

    target.clinics = [...intactas, ...porClinica.values()];

    /**
     * «TRABAJA EN TODAS LAS SUCURSALES».
     *
     * No sustituye a la asignación, la EXTIENDE: de la fila sale el rol, y el
     * check dice que ese rol vale en cualquier sede (ver User.worksInAllClinics).
     * Por eso se exige tener sucursal — sin ella no hay rol que extender y la
     * persona quedaría marcada como "en todas" y sin ser nada en ninguna.
     */
    if (req.body.worksInAllClinics !== undefined) {
      const marcar = !!req.body.worksInAllClinics;
      if (marcar && !target.clinics.length) {
        return res.status(400).json({
          message: 'Para marcar «trabaja en todas las sucursales» primero hay que asignarle una: de ahí sale su rol.',
          code: 'ALL_CLINICS_WITHOUT_ROLE',
        });
      }
      target.worksInAllClinics = marcar;
    }

    await target.save();

    // El middleware `auth` cachea el usuario: sin esto el cambio tardaría hasta
    // el TTL en notar que esa persona ya no está en esta sucursal.
    require('../utils/userCache').invalidate(String(target._id));

    const populated = await User.findById(target._id)
      .select('name email specialty active isSuperAdmin clinics worksInAllClinics')
      .lean();
    res.json(populated);
  } catch (error) {
    res.status(500).json({ message: 'Error al guardar las asignaciones', error: error.message });
  }
};

/**
 * Lista usuarios. Por defecto solo los que pertenecen a la clínica activa.
 * El super-admin con clínica activa también ve solo los de esa clínica.
 */
exports.getUsers = async (req, res) => {
  try {
    // El super-admin puede pedir TODOS los usuarios (?all=1), p.ej. para elegir
    // excepciones al bloqueo de acceso global.
    const allGlobal = req.query.all === '1' && req.user?.isSuperAdmin;
    const filter = !allGlobal && req.clinicId ? { 'clinics.clinic': req.clinicId } : {};
    const users = await User.find(filter)
      .populate('clinics.clinic', 'name')
      .select('-password')
      .sort({ createdAt: -1 });
    res.json(users);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener usuarios', error: error.message });
  }
};

exports.getUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .populate('clinics.clinic', 'name')
      .select('-password');
    if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });
    res.json(user);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener usuario' });
  }
};

/**
 * Crear usuario (solo admin de la clínica). Asigna automáticamente la clínica activa
 * con el rol indicado. El admin puede asignar más clínicas si tiene permiso allí.
 */
exports.createUser = async (req, res) => {
  try {
    const { name, email, password, role, specialty, phone, cedula, clinics } = req.body;
    if (!name || !email || !password || !role) {
      return res.status(400).json({ message: 'Faltan campos requeridos' });
    }
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ message: 'Rol inválido' });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: 'La contraseña debe tener al menos 6 caracteres' });
    }

    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ message: 'El email ya está registrado' });

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Construir asignaciones de clínicas. Por defecto: la clínica activa con el rol dado.
    let clinicAssignments = [{ clinic: req.clinicId, role }];
    if (Array.isArray(clinics) && clinics.length > 0 && req.user.isSuperAdmin) {
      clinicAssignments = sanitizeClinics(clinics);
    }

    const user = await User.create({
      name,
      email,
      password: hashedPassword,
      specialty,
      phone,
      cedula,
      clinics: clinicAssignments,
    });

    const populated = await User.findById(user._id)
      .populate('clinics.clinic', 'name')
      .select('-password');
    res.status(201).json(populated);
  } catch (error) {
    res.status(500).json({ message: 'Error al crear usuario', error: error.message });
  }
};

exports.updateUser = async (req, res) => {
  try {
    const { name, email, specialty, phone, cedula, active, clinics, password } = req.body;
    const update = { name, email, specialty, phone, cedula, active };
    Object.keys(update).forEach((k) => update[k] === undefined && delete update[k]);

    if (password) {
      if (password.length < 6) {
        return res.status(400).json({ message: 'La contraseña debe tener al menos 6 caracteres' });
      }
      const salt = await bcrypt.genSalt(10);
      update.password = await bcrypt.hash(password, salt);
    }

    if (Array.isArray(clinics)) {
      // Solo super-admin o admin pueden modificar asignaciones; el admin solo de su clínica
      if (req.user.isSuperAdmin) {
        update.clinics = sanitizeClinics(clinics);
      } else {
        // Admin de clínica: solo puede agregar/cambiar el rol del usuario para SU clínica
        const target = await User.findById(req.params.id);
        if (!target) return res.status(404).json({ message: 'Usuario no encontrado' });
        const others = target.clinics.filter((c) => String(c.clinic) !== String(req.clinicId));
        const newForThis = clinics.find((c) => String(c.clinic) === String(req.clinicId));
        const merged = [...others];
        if (newForThis && VALID_ROLES.includes(newForThis.role)) {
          merged.push({ clinic: req.clinicId, role: newForThis.role });
        }
        update.clinics = merged;
      }
    }

    const user = await User.findByIdAndUpdate(req.params.id, update, {
      new: true,
      runValidators: true,
    })
      .populate('clinics.clinic', 'name')
      .select('-password');
    if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });
    // El middleware `auth` cachea el usuario: sin esto, un cambio de rol o de
    // clínica tardaría hasta el TTL en aplicarse.
    require('../utils/userCache').invalidate(req.params.id);
    res.json(user);
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar usuario', error: error.message });
  }
};

exports.deleteUser = async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { active: false },
      { new: true }
    ).select('-password');
    if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });
    // Desactivar debe cortar el acceso YA, no cuando expire la caché de `auth`.
    require('../utils/userCache').invalidate(req.params.id);
    res.json({ message: 'Usuario desactivado' });
  } catch (error) {
    res.status(500).json({ message: 'Error al eliminar usuario' });
  }
};

/**
 * FIRMA ELECTRÓNICA DEL PROFESIONAL (.p12 / .pfx).
 *
 * Sustituye a la firma escaneada: una imagen de la firma no firma nada, solo se
 * parece a una firma. Con el certificado la receta sale firmada dentro del PDF y
 * se puede comprobar quién la emitió y que nadie la tocó después.
 *
 * Mismo tratamiento que el certificado del SRI: se valida ANTES de guardar, el
 * archivo va a disco y la contraseña se guarda cifrada — nunca en claro y nunca
 * de vuelta al cliente.
 */
const certUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/x-pkcs12' || /\.p12$|\.pfx$/i.test(file.originalname)) {
      return cb(null, true);
    }
    cb(new Error('El archivo debe ser un certificado .p12 o .pfx'));
  },
}).single('certificate');

// Los errores de multer (tipo, tamaño) son culpa del cliente: 400 con el motivo,
// no un 500 genérico de Express.
exports.signatureCertUploadMiddleware = (req, res, next) => {
  certUpload(req, res, (err) => {
    if (err) return res.status(400).json({ message: err.message });
    next();
  });
};

/** Lo que se le puede enseñar al cliente: todo menos la contraseña. */
const certPublico = (user) => {
  const cert = user?.signatureCert;
  if (!cert?.filename) return { tiene: false };
  const { ok, motivo } = estadoFirma(user);
  return {
    tiene: true,
    puedeFirmar: ok,
    motivo,
    info: cert.info || {},
    uploadedAt: cert.uploadedAt,
  };
};

exports.getMySignatureCert = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('name email signatureCert');
    res.json(certPublico(user));
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener la firma', error: error.message });
  }
};

exports.uploadMySignatureCert = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Falta el archivo del certificado' });
    const { password } = req.body;
    if (!password) return res.status(400).json({ message: 'La contraseña del certificado es requerida' });

    // Se abre ANTES de guardar nada: un .p12 que no abre, o una contraseña
    // equivocada, se rechaza aquí y no el día que haya que firmar una receta.
    let info;
    try {
      info = loadP12(req.file.buffer, password);
    } catch (e) {
      return res.status(400).json({
        message: 'No se pudo abrir el certificado. Revisa que el archivo sea correcto y que la contraseña coincida.',
        detalle: e.message,
      });
    }
    if (info.validTo && info.validTo < new Date()) {
      return res.status(400).json({ message: 'Ese certificado está vencido: no sirve para firmar.' });
    }

    const filename = guardarCertificado(req.user._id, req.file.buffer);
    const commonName =
      info.certificate?.subject?.getField?.('CN')?.value || req.user.name || '';

    const user = await User.findByIdAndUpdate(
      req.user._id,
      {
        $set: {
          signatureCert: {
            filename,
            password: encryptSecret(password),
            info: {
              commonName,
              subject: info.subject,
              issuer: info.issuerName,
              serialNumber: info.serialNumberDecimal,
              validFrom: info.validFrom,
              validTo: info.validTo,
            },
            uploadedAt: new Date(),
          },
        },
      },
      { new: true },
    ).select('name email signatureCert');

    require('../utils/userCache').invalidate(String(req.user._id));
    res.json({ message: 'Firma electrónica configurada', ...certPublico(user) });
  } catch (error) {
    res.status(500).json({ message: 'Error al guardar la firma', error: error.message });
  }
};

exports.deleteMySignatureCert = async (req, res) => {
  try {
    borrarCertificado(req.user._id);
    await User.findByIdAndUpdate(req.user._id, {
      $unset: { signatureCert: '' },
    });
    require('../utils/userCache').invalidate(String(req.user._id));
    res.json({ message: 'Firma electrónica eliminada', tiene: false });
  } catch (error) {
    res.status(500).json({ message: 'Error al eliminar la firma', error: error.message });
  }
};

/**
 * Lista doctores de la clínica activa. Incluye las especialidades ('optica',
 * 'ginecologia', 'podologia', 'odontologia', 'cosmetologia'), que son doctores
 * especializados y también asignables a citas (misma expansión que hace
 * requireRole en middleware/auth.js; la lista vive en constants/roles.js).
 *
 * Cada doctor sale con `roleInClinic`: el rol que tiene EN ESTA sucursal, que
 * es lo que define su tipo (general / óptica / ginecología / lo que se cree a
 * futuro). La misma persona puede ser doctor en una sede y óptica en otra, así
 * que el tipo se resuelve aquí, contra req.clinicId, y no adivinándolo en el
 * cliente. La etiqueta visible la pone el frontend (utils/roles.js).
 */
/**
 * Enfermeros de ESTA sucursal, para nombrar el turno al asignar la atención.
 *
 * Filtra por sucursal por lo mismo que las notificaciones: quien no trabaja hoy
 * en esta sede no debe salir en la lista de recepción, o acabará con un turno
 * asignado a alguien que está a treinta kilómetros.
 */
/**
 * Los selectores de personal aceptan `?clinic=<id>`: mostrador asigna citas de
 * otras sucursales y quien puede atenderlas es el personal DE ESA SEDE, no el de
 * la sucursal en la que está el cajero. Sin esto el selector ofrecía doctores de
 * la sede equivocada y la cita quedaba asignada a alguien que ni la ve.
 */
exports.getNurses = async (req, res) => {
  try {
    const clinicId = sucursalPedida(req);
    const nurses = await User.find({
      active: true,
      // `enSucursal` y no un $elemMatch a mano: incluye a quien está marcado
      // como "trabaja en todas las sucursales" (ver User.worksInAllClinics).
      ...User.enSucursal(clinicId, 'enfermero'),
    })
      .select('name email')
      .sort({ name: 1 })
      .lean();
    res.json(nurses);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener enfermeros', error: error.message });
  }
};

exports.getDoctors = async (req, res) => {
  try {
    // Ver `getNurses`: `?clinic=<id>` para el personal de otra sucursal.
    const clinicId = sucursalPedida(req);
    const doctors = await User.find({
      active: true,
      ...User.enSucursal(clinicId, DOCTOR_LIKE_ROLES),
    })
      .select('-password')
      .sort({ name: 1 })
      .lean();
    const withRole = doctors.map((d) => ({
      ...d,
      // Quien rota por todas no tiene fila para ESTA sede: su rol es el de su
      // asignación, igual que resuelve `getRoleForClinic`.
      roleInClinic:
        (d.clinics || []).find((c) => String(c.clinic) === String(clinicId))?.role
        || (d.worksInAllClinics ? d.clinics?.[0]?.role : null)
        || null,
    }));
    res.json(withRole);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener doctores', error: error.message });
  }
};
