const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { validationResult } = require('express-validator');
const User = require('../models/User');
const Clinic = require('../models/Clinic');
const { isAccessBlocked, blockMessage } = require('../utils/accessControl');
const { ensureCompanyCache, userCompanyIds, clinicsOfCompanySync } = require('../utils/companies');

const ACCESS_EXPIRES = process.env.JWT_EXPIRES_IN || '8h';

const signToken = (payload) =>
  jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: ACCESS_EXPIRES });

const buildPublicUser = (user, activeClinic = null, role = null) => ({
  id: user._id,
  // También como _id: el frontend usa user._id en varios sitios (SocketContext,
  // Chats, Comisiones); sin este campo el socket nunca se conectaba.
  _id: user._id,
  name: user.name,
  email: user.email,
  isSuperAdmin: !!user.isSuperAdmin,
  // Doctor que también puede atender como terapeuta (ver User.alsoTherapist):
  // la agenda pregunta con cuál gorra atender y las pantallas abren lo suyo.
  alsoTherapist: !!user.alsoTherapist,
  specialty: user.specialty,
  cedula: user.cedula,
  phone: user.phone,
  clinics: user.clinics || [],
  worksInAllClinics: !!user.worksInAllClinics,
  companies: user.companies || [],
  activeClinic,
  role,
});

/** Los campos de sucursal que necesita el selector del frontend. */
const CAMPOS_SUCURSAL = 'name razonSocial nombreComercial appointmentSlotMinutes company';

const aplanar = (clinic, role) => ({
  _id: clinic._id,
  name: clinic.name,
  razonSocial: clinic.razonSocial,
  nombreComercial: clinic.nombreComercial,
  // La rejilla de la agenda viaja con cada sucursal: el call center agenda en
  // sedes distintas desde el mismo formulario.
  appointmentSlotMinutes: clinic.appointmentSlotMinutes || 0,
  // Empresa de la sucursal: el selector las agrupa por empresa.
  company: clinic.company ? { _id: clinic.company._id, name: clinic.company.name } : null,
  role,
});

/**
 * A QUÉ SUCURSALES PUEDE ENTRAR ESTA PERSONA, y con qué rol en cada una.
 *
 * Estaba escrito dos veces —en el login y en `/auth/me`— con la misma forma y el
 * mismo caso especial (el super-admin las ve todas). Al aparecer el SEGUNDO caso
 * de "las ve todas" (`worksInAllClinics`: el doctor que rota por las sedes según
 * el horario) tocaba escribirlo dos veces más, y la copia que se olvidara
 * dejaría a esa persona sin poder cambiarse a la sede donde le pusieron la cita.
 *
 * `getRoleForClinic` es quien decide el rol, siempre: aquí no se vuelve a
 * razonar sobre `clinics[]`.
 */
async function sucursalesAccesibles(user) {
  // "En todas" son todas las sucursales de SUS empresas (utils/companies); el
  // super-admin, las de todas las empresas.
  await ensureCompanyCache();
  const propias = (user.clinics || []).map((c) => String(c.clinic));
  const enTodas = user.worksInAllClinics
    ? userCompanyIds(user).flatMap((company) => clinicsOfCompanySync(company))
    : [];
  const filtro = user.isSuperAdmin
    ? { active: true }
    : { _id: { $in: [...new Set([...propias, ...enTodas])] }, active: true };

  const clinics = await Clinic.find(filtro).select(CAMPOS_SUCURSAL).populate('company', 'name').sort({ name: 1 });
  return clinics
    .map((clinic) => {
      // El super-admin entra como admin allí donde no tenga rol propio; es la
      // regla que ya aplicaba `middleware/auth`.
      const role = user.getRoleForClinic(clinic._id) || (user.isSuperAdmin ? 'admin' : null);
      return role ? aplanar(clinic, role) : null;
    })
    .filter(Boolean);
}

/**
 * Cambia la contraseña del usuario autenticado.
 */
exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ message: 'La nueva contraseña debe tener al menos 6 caracteres' });
    }
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });

    const ok = await bcrypt.compare(currentPassword || '', user.password);
    if (!ok) return res.status(400).json({ message: 'La contraseña actual es incorrecta' });

    user.password = await bcrypt.hash(newPassword, 12);
    await user.save();
    res.json({ message: 'Contraseña actualizada correctamente' });
  } catch (error) {
    res.status(500).json({ message: 'Error al cambiar contraseña', error: error.message });
  }
};

/**
 * Cambio del PROPIO correo de acceso.
 *
 * Pide la contraseña actual: el correo es con lo que se entra al sistema, así
 * que cambiarlo desde una sesión abierta y sin comprobar nada convierte
 * cualquier ordenador desatendido en una forma de quedarse con la cuenta.
 */
exports.changeEmail = async (req, res) => {
  try {
    const { currentPassword, email } = req.body;
    const limpio = String(email || '').trim().toLowerCase();
    // Validación deliberadamente simple: lo que importa es que tenga forma de
    // correo y sea único. Quien se equivoque lo verá al volver a entrar.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(limpio)) {
      return res.status(400).json({ message: 'Escribe un correo válido' });
    }

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });

    if (limpio === String(user.email || '').toLowerCase()) {
      return res.status(400).json({ message: 'Ese ya es tu correo actual' });
    }

    const ok = await bcrypt.compare(currentPassword || '', user.password);
    if (!ok) return res.status(400).json({ message: 'La contraseña actual es incorrecta' });

    // Dos personas no pueden entrar con el mismo correo.
    const ocupado = await User.findOne({ email: limpio, _id: { $ne: user._id } }).select('_id').lean();
    if (ocupado) return res.status(409).json({ message: 'Ese correo ya lo usa otro usuario' });

    user.email = limpio;
    await user.save();
    res.json({ message: 'Correo actualizado correctamente', email: user.email });
  } catch (error) {
    // El índice único puede saltar igual si dos cambian al mismo correo a la vez.
    if (error.code === 11000) {
      return res.status(409).json({ message: 'Ese correo ya lo usa otro usuario' });
    }
    res.status(500).json({ message: 'Error al cambiar el correo', error: error.message });
  }
};

/**
 * MIS DATOS (sep-2026): nombre, cédula y teléfono, editados por la propia
 * persona desde «Configuración de cuenta». Antes solo los podía tocar un
 * administrador desde Usuarios, y el nombre es lo que sale en recetas,
 * seguimientos y la agenda.
 *
 * Solo esos tres campos: el correo va por `changeEmail` (pide contraseña) y el
 * rol, las sucursales o el estado no son cosa de uno mismo.
 */
exports.updateProfile = async (req, res) => {
  try {
    const { validateCedula, validateRuc } = require('../utils/cedulaLookup');
    const name = String(req.body?.name ?? '').replace(/\s+/g, ' ').trim();
    const cedula = String(req.body?.cedula ?? '').trim();
    const phone = String(req.body?.phone ?? '').trim();

    if (!name) return res.status(400).json({ message: 'El nombre no puede quedar vacío' });
    if (name.length > 120) return res.status(400).json({ message: 'El nombre es demasiado largo' });
    /**
     * La cédula se comprueba si TIENE FORMA de cédula o RUC (10 o 13 dígitos):
     * un dígito cambiado es el error típico y así no llega a la ficha. Otra
     * cosa (un pasaporte) se acepta tal cual: hay personal extranjero.
     */
    if (cedula) {
      if (/^\d{10}$/.test(cedula) && !validateCedula(cedula)) {
        return res.status(400).json({ message: 'La cédula no es válida: revisa los dígitos' });
      }
      if (/^\d{13}$/.test(cedula) && !validateRuc(cedula)) {
        return res.status(400).json({ message: 'El RUC no es válido: revisa los dígitos' });
      }
      if (!/^[A-Za-z0-9-]{5,20}$/.test(cedula)) {
        return res.status(400).json({ message: 'Escribe una cédula, RUC o pasaporte válido' });
      }
    }
    if (phone && !/^[+\d][\d\s()-]{5,19}$/.test(phone)) {
      return res.status(400).json({ message: 'Escribe un teléfono válido (solo números)' });
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $set: { name, cedula, phone } },
      { new: true, runValidators: true }
    );
    if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });
    res.json({ message: 'Datos actualizados', name: user.name, cedula: user.cedula, phone: user.phone });
  } catch (error) {
    res.status(500).json({ message: 'Error al guardar tus datos', error: error.message });
  }
};

/**
 * Login: devuelve token sin clínica + lista de clínicas disponibles.
 * El cliente debe llamar a /auth/select-clinic para obtener un token con clinicId.
 */
exports.login = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ message: 'Credenciales inválidas' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Credenciales inválidas' });
    }

    /**
     * CUENTA DESACTIVADA: SE DICE, NO SE DISFRAZA.
     *
     * Antes esto viajaba junto al `!user` en un único «Credenciales inválidas»,
     * y ese ahorro costaba caro: el admin le cambiaba la contraseña a alguien
     * desactivado, la pantalla decía «Usuario actualizado», la persona seguía sin
     * poder entrar y todo apuntaba a que el cambio de contraseña no se guardaba.
     * Se guardaba; lo que fallaba era otra cosa y el mensaje la tapaba.
     *
     * Se comprueba DESPUÉS de acertar la contraseña, a propósito: así el mensaje
     * solo lo ve el dueño de la cuenta y no sirve para sondear qué correos
     * existen en el sistema.
     */
    if (!user.active) {
      return res.status(403).json({
        message: 'Tu usuario está desactivado. Pide a un administrador que lo reactive.',
        code: 'USER_INACTIVE',
      });
    }

    // Bloqueo de acceso al sistema (super-admin y exceptuados quedan libres).
    const block = await isAccessBlocked(user);
    if (block.blocked) {
      return res.status(403).json({ message: blockMessage(block.rule), code: 'ACCESS_BLOCKED' });
    }

    const flatClinics = await sucursalesAccesibles(user);

    // Token "preliminar" sin clinicId (solo permite seleccionar)
    const token = signToken({ id: user._id });

    res.json({
      token,
      user: buildPublicUser(user),
      clinics: flatClinics,
    });
  } catch (error) {
    res.status(500).json({ message: 'Error en el servidor', error: error.message });
  }
};

/**
 * Selecciona la clínica activa y devuelve un nuevo JWT con clinicId.
 */
exports.selectClinic = async (req, res) => {
  try {
    const { clinicId } = req.body;
    if (!clinicId) return res.status(400).json({ message: 'clinicId requerido' });

    const user = req.user;
    let role = user.getRoleForClinic(clinicId);
    if (!role && user.isSuperAdmin) role = 'admin';
    if (!role) return res.status(403).json({ message: 'No tienes acceso a esta clínica' });

    const clinic = await Clinic.findById(clinicId);
    if (!clinic || !clinic.active) {
      return res.status(404).json({ message: 'Clínica no encontrada o inactiva' });
    }

    const token = signToken({ id: user._id, clinicId, role });

    /**
     * LA ÚLTIMA SEDE ELEGIDA QUEDA ESCRITA en el usuario: es lo que permite a
     * las notificaciones saber en qué sucursal está trabajando cada quien SIN
     * preguntarle a nadie (ver User.activeClinicId). Se guarda solo si cambió,
     * que es el caso normal y evita escrituras en cada refresco de página.
     */
    if (String(user.activeClinicId || '') !== String(clinicId)) {
      user.activeClinicId = clinicId;
      await user.save().catch((err) => {
        console.warn('[auth] no se pudo guardar la sucursal activa:', err.message);
      });
    }

    res.json({
      token,
      user: buildPublicUser(user, clinic, role),
    });
  } catch (error) {
    res.status(500).json({ message: 'Error en el servidor', error: error.message });
  }
};

exports.getMe = async (req, res) => {
  try {
    let activeClinic = null;
    if (req.clinicId) {
      activeClinic = await Clinic.findById(req.clinicId).select(
        'name razonSocial nombreComercial logoUrl appointmentSlotMinutes company'
      ).populate('company', 'name nombreComercial logoUrl');
    }

    const flatClinics = await sucursalesAccesibles(req.user);

    res.json({
      user: buildPublicUser(req.user, activeClinic, req.role),
      activeClinic,
      role: req.role || null,
      clinics: flatClinics,
    });
  } catch (error) {
    res.status(500).json({ message: 'Error en el servidor', error: error.message });
  }
};
