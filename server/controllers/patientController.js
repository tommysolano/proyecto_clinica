const Patient = require('../models/Patient');
const Appointment = require('../models/Appointment');
const { emitToClinic } = require('../realtime');
const { canReq } = require('../utils/permissions');
const { phoneSearchRegex } = require('../utils/phoneNormalize');

// NOTA: los DATOS de los pacientes se comparten entre todas las clínicas
// (cédula única global). El campo `clinic` queda como referencia de la clínica
// donde se registró inicialmente, pero las consultas no filtran por clínica.

/**
 * DATOS DE CONTACTO del paciente: cédula, dirección, teléfono, WhatsApp y correo.
 *
 * Los ve SOLO el administrador (capacidad `patients.contactData`). El resto del
 * personal trabaja con el nombre: quien agenda, quien atiende y quien hace marketing
 * no necesita saber por dónde contactar al paciente por su cuenta.
 *
 * Con UNA excepción por campo: la CÉDULA la ve además mostrador (capacidad
 * `patients.cedula`, ver `canSeeCedula`), porque es con lo que identifica y
 * factura a la persona que tiene delante. Los otros cuatro campos no se mueven.
 *
 * Se censura en el SERVIDOR, no en React: ocultar una columna no es un permiso —
 * cualquiera abre la pestaña de red y lee el JSON. Lo que no se envía, no se filtra.
 *
 * Única excepción, y por obligación legal: quien FACTURA o COBRA (cajero,
 * contabilidad) necesita identificar al cliente en el comprobante del SRI y en la
 * cartera. Esos roles reciben los datos solo si la petición los pide expresamente
 * —`GET /patients?withContact=1`, capacidad `patients.billingData`—, que es lo que
 * hacen los selectores de cliente de Nueva venta, Cotizaciones y Pagos. La ficha del
 * paciente (`GET /patients/:id`) y el listado de Clientes NO lo piden: ahí van
 * censurados para todos menos el admin.
 */
const CONTACT_FIELDS = ['cedula', 'address', 'phone', 'whatsapp', 'email'];

/** ¿Este usuario puede ver los datos de contacto del paciente? (solo admin). */
const canSeeContactData = (req) => canReq(req, 'patients.contactData');

/**
 * LA CÉDULA VA APARTE (pedido de mostrador, 3-sep-2026).
 *
 * Caja necesita el número de identificación del paciente que tiene delante: es
 * con lo que factura, con lo que distingue a dos homónimos y con lo que confirma
 * que quien llegó es el de la agenda. Pedírsela a un administrador cada vez no
 * era viable.
 *
 * Es una excepción de UN campo, no una puerta a los datos de contacto: dirección,
 * teléfono, WhatsApp y correo siguen saliendo censurados para todo el que no sea
 * admin. Por eso el filtro es POR CAMPO y no un booleano para los cinco.
 */
const canSeeCedula = (req) => canSeeContactData(req) || canReq(req, 'patients.cedula');

/** ¿Puede ver ESTE campo de contacto? */
const canSeeContactField = (req, field) =>
  field === 'cedula' ? canSeeCedula(req) : canSeeContactData(req);

/** ¿La petición es un selector de facturación/cobro que sí puede traerlos? */
const wantsBillingContact = (req) =>
  ['1', 'true', 'yes'].includes(String(req.query?.withContact || '').toLowerCase()) &&
  canReq(req, 'patients.billingData');

const stripContactData = (patient, req) => {
  const obj = patient.toObject ? patient.toObject() : { ...patient };
  CONTACT_FIELDS.forEach((f) => {
    if (canSeeContactField(req, f)) return;
    obj[f] = undefined;
  });
  return obj;
};

/** Devuelve el paciente tal cual si el rol puede ver el contacto; si no, censurado. */
const sanitizeForRole = (patient, req) => {
  if (!patient || canSeeContactData(req)) return patient;
  return stripContactData(patient, req);
};

/**
 * Busca posibles "referidores": pacientes y personal (usuarios) registrados.
 * Usado por el selector "¿Quién lo refirió?" al crear un paciente.
 */
exports.searchReferralCandidates = async (req, res) => {
  try {
    const User = require('./../models/User');
    const q = (req.query.q || '').trim();
    const regex = q ? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;

    // El selector "¿Quién lo refirió?" es un buscador por nombre. El teléfono
    // sigue siendo del admin; por cédula busca (y la ve) quien puede verla — ver
    // CONTACT_FIELDS y canSeeCedula.
    const showContact = canSeeContactData(req);
    const showCedula = canSeeCedula(req);
    const patientFilter = { active: true };
    if (regex) {
      patientFilter.$or = [
        { firstName: regex },
        { lastName: regex },
        ...(showCedula ? [{ cedula: regex }] : []),
        ...(showContact ? [{ phone: regex }] : []),
      ];
    }
    const patients = await Patient.find(patientFilter)
      .select('firstName lastName cedula')
      .limit(15);

    const userFilter = { active: true, 'clinics.clinic': req.clinicId };
    if (regex) {
      userFilter.$or = [
        { name: regex },
        ...(showContact ? [{ cedula: regex }, { email: regex }] : []),
      ];
    }
    const users = await User.find(userFilter).select('name cedula').limit(15);

    const results = [
      ...patients.map((p) => ({
        id: p._id,
        type: 'patient',
        name: `${p.firstName} ${p.lastName}`.trim(),
        detail: showCedula ? p.cedula || '' : '',
      })),
      ...users.map((u) => ({
        id: u._id,
        type: 'user',
        name: u.name,
        detail: 'Personal',
      })),
    ];
    res.json(results);
  } catch (error) {
    res.status(500).json({ message: 'Error al buscar referidores', error: error.message });
  }
};


exports.getPatients = async (req, res) => {
  try {
    const { search, page = 1, limit = 20, isNew } = req.query;
    const query = { active: true };
    // Facturación/cobro: ver CONTACT_FIELDS arriba. Aunque no sea ninguno de los
    // dos casos se sigue pasando por el censor: es él quien deja pasar la cédula
    // a mostrador (canSeeCedula) sin soltar el resto.
    const showContact = canSeeContactData(req) || wantsBillingContact(req);

    if (search) {
      /**
       * El texto del buscador va ESCAPADO. Tal cual, un '(' o un '+' —normales
       * en un teléfono copiado y pegado— rompen la expresión regular y la
       * consulta revienta con un 500. Mismo criterio que en
       * `searchReferralCandidates`, que ya lo escapaba.
       */
      const texto = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [{ firstName: texto }, { lastName: texto }];
      /**
       * BUSCAR por cédula o teléfono lo puede hacer cualquiera que ya entre al
       * listado; VERLOS en la tabla sigue siendo solo del admin (más abajo, en
       * `stripContactData`).
       *
       * No es lo mismo: para buscar hay que traer el número ya sabido —de la
       * cédula en la mano del paciente, del chat, de la llamada—, y sin esto
       * recepción y óptica solo podían buscar por nombre, que es justo lo que
       * peor se escribe y peor se repite.
       *
       * El teléfono usa `phoneSearchRegex` para casar en cualquier formato:
       * guardado como '+593 98 853 5561' y tecleado como '0988535561'.
       */
      query.$or.push({ cedula: texto });
      const telefono = phoneSearchRegex(search);
      if (telefono) query.$or.push({ phone: telefono }, { whatsapp: telefono });
      else query.$or.push({ phone: texto });
    }

    if (isNew === 'true' || isNew === '1') {
      // "Nuevo" = paciente que aún NO ha sido atendido (sin cita asistida/completada).
      // Coincide con el concepto de "primera visita" usado en el resto del sistema.
      const attendedIds = await Appointment.distinct('patient', {
        status: { $in: ['asistida', 'completada'] },
      });
      query._id = { $nin: attendedIds.filter(Boolean) };
    }

    const patients = await Patient.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await Patient.countDocuments(query);

    res.json({
      patients: showContact ? patients : patients.map((p) => stripContactData(p, req)),
      total,
      pages: Math.ceil(total / limit),
      currentPage: parseInt(page),
    });
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener pacientes' });
  }
};

exports.getPatient = async (req, res) => {
  try {
    const patient = await Patient.findById(req.params.id);
    if (!patient) return res.status(404).json({ message: 'Paciente no encontrado' });
    res.json(sanitizeForRole(patient, req));
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener paciente' });
  }
};

/**
 * Historial de compras y aplicaciones del paciente, para el seguimiento.
 * Devuelve las ventas (qué compró, cuándo, quién lo recomendó) y el avance de
 * tratamientos (comprado vs aplicado vs restante — p.ej. cuántos sueros lleva).
 */
exports.getPatientPurchases = async (req, res) => {
  try {
    const Sale = require('../models/Sale');
    const Treatment = require('../models/Treatment');
    const patientId = req.params.id;

    const [sales, treatments] = await Promise.all([
      Sale.find({ clinic: req.clinicId, patient: patientId, status: { $ne: 'anulada' } })
        .populate('recommendedBy', 'name')
        .sort({ createdAt: -1 })
        .limit(200),
      Treatment.find({ clinic: req.clinicId, patient: patientId })
        .sort({ createdAt: -1 }),
    ]);

    const purchases = sales.map((s) => ({
      _id: s._id,
      saleNumber: s.saleNumber,
      date: s.createdAt,
      total: s.total,
      paymentMethod: s.paymentMethod,
      recommendedBy: s.recommendedBy ? s.recommendedBy.name : null,
      items: (s.items || []).map((i) => ({
        name: i.productName,
        quantity: i.quantity,
        category: i.category,
        subtotal: i.subtotal,
      })),
    }));

    const treatmentProgress = treatments.map((t) => ({
      _id: t._id,
      name: t.name,
      status: t.status,
      items: (t.items || []).map((it) => ({
        name: it.name || '',
        prescribed: it.quantity,
        applied: it.completed || 0,
        remaining: Math.max(0, (it.quantity || 0) - (it.completed || 0)),
      })),
    }));

    res.json({ purchases, treatments: treatmentProgress });
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener compras del paciente', error: error.message });
  }
};

/**
 * Limpia el cuerpo antes de guardar: los formularios mandan '' en los campos
 * vacíos y Mongoose no puede convertir '' a ObjectId ni a número (reventaba con
 * un CastError que llegaba al usuario como "Error al crear paciente" a secas).
 */
const cleanPatientBody = (body) => {
  const out = { ...body };
  for (const k of ['referredById']) {
    if (out[k] === '' || out[k] === null) out[k] = undefined;
  }
  for (const k of ['age']) {
    if (out[k] === '' || out[k] === null) out[k] = undefined;
  }
  // El enum de género no acepta '': si viene vacío, mejor no enviar el campo.
  if (out.gender === '') delete out.gender;
  return out;
};

/** Traduce los errores de Mongoose a un mensaje que el usuario pueda accionar. */
const describeSaveError = (error) => {
  if (error?.name === 'ValidationError') {
    const detail = Object.values(error.errors || {})
      .map((e) => e.message)
      .join(' · ');
    return detail || error.message;
  }
  if (error?.name === 'CastError') {
    return `El campo "${error.path}" tiene un valor no válido: "${error.value}"`;
  }
  if (error?.code === 11000) {
    const field = Object.keys(error.keyPattern || {})[0] || 'dato';
    return `Ya existe un paciente con ese ${field === 'cedula' ? 'número de identificación' : field}`;
  }
  return error?.message || 'Error desconocido';
};

exports.createPatient = async (req, res) => {
  try {
    const cedula = (req.body.cedula || '').trim();
    if (cedula) {
      const existing = await Patient.findOne({ cedula });
      if (existing) {
        return res.status(400).json({ message: 'Ya existe un paciente con esa cédula' });
      }
    }

    const patient = await Patient.create({
      ...cleanPatientBody(req.body),
      cedula,
      clinic: req.clinicId,
    });
    // Registrar a alguien SÍ es de recepción (le está dando sus datos en el
    // mostrador); volver a leerlos después ya no. La respuesta va censurada.
    emitToClinic(req.clinicId, 'patient:created', { id: patient._id });
    // Evento de dominio: dispara workflows con trigger 'patient_created'.
    {
      const { emitDomainEvent, DOMAIN_EVENTS } = require('../utils/events');
      emitDomainEvent(DOMAIN_EVENTS.PATIENT_CREATED, {
        clinicId: String(req.clinicId),
        patientId: String(patient._id),
        isFirstVisit: true,
      });
    }
    res.status(201).json(sanitizeForRole(patient, req));
  } catch (error) {
    const detail = describeSaveError(error);
    const isUserError = ['ValidationError', 'CastError'].includes(error?.name) || error?.code === 11000;
    res.status(isUserError ? 400 : 500).json({
      message: `No se pudo crear el paciente: ${detail}`,
      error: error.message,
    });
  }
};

exports.updatePatient = async (req, res) => {
  try {
    const update = cleanPatientBody(req.body);
    // Quien no VE un dato de contacto tampoco lo edita. No es solo permiso: su
    // formulario lo recibe vacío, así que sin este filtro un guardado cualquiera
    // borraría la cédula y el teléfono del paciente sin que nadie lo notara.
    //
    // Campo a campo, y no todo o nada: mostrador ve la cédula, así que también la
    // corrige (es quien descubre que está mal, al facturar); el teléfono y la
    // dirección los recibe vacíos y se descartan igual que antes.
    CONTACT_FIELDS.forEach((f) => {
      if (!canSeeContactField(req, f)) delete update[f];
    });
    // Etiquetas previas: para disparar 'tag_added' solo por las realmente nuevas.
    const prev = Array.isArray(update.tags)
      ? await Patient.findById(req.params.id).select('tags')
      : null;
    const patient = await Patient.findByIdAndUpdate(req.params.id, update, {
      new: true,
      runValidators: true,
    });
    if (!patient) return res.status(404).json({ message: 'Paciente no encontrado' });
    if (prev) {
      const before = new Set((prev.tags || []).map(String));
      const added = (patient.tags || []).filter((t) => !before.has(String(t)));
      if (added.length) {
        const { emitDomainEvent, DOMAIN_EVENTS } = require('../utils/events');
        for (const tag of added) {
          emitDomainEvent(DOMAIN_EVENTS.TAG_ADDED, {
            clinicId: String(req.clinicId),
            patientId: String(patient._id),
            tag,
          });
        }
      }
    }
    emitToClinic(req.clinicId, 'patient:updated', { id: patient._id });
    res.json(sanitizeForRole(patient, req));
  } catch (error) {
    const detail = describeSaveError(error);
    const isUserError = ['ValidationError', 'CastError'].includes(error?.name) || error?.code === 11000;
    res.status(isUserError ? 400 : 500).json({
      message: `No se pudo actualizar el paciente: ${detail}`,
      error: error.message,
    });
  }
};

exports.deletePatient = async (req, res) => {
  try {
    const patient = await Patient.findByIdAndUpdate(
      req.params.id,
      { active: false },
      { new: true }
    );
    if (!patient) return res.status(404).json({ message: 'Paciente no encontrado' });
    res.json({ message: 'Paciente eliminado' });
  } catch (error) {
    res.status(500).json({ message: 'Error al eliminar paciente' });
  }
};

/**
 * Etiquetado masivo de pacientes (para segmentación).
 * POST /api/patients/bulk-tag  body: { patientIds:[], add:[], remove:[] }
 */
exports.bulkTag = async (req, res) => {
  try {
    const { patientIds, add = [], remove = [] } = req.body;
    if (!Array.isArray(patientIds) || patientIds.length === 0) {
      return res.status(400).json({ message: 'Selecciona al menos un paciente' });
    }
    const toAdd = (add || []).map((t) => String(t).trim()).filter(Boolean);
    const toRemove = (remove || []).map((t) => String(t).trim()).filter(Boolean);
    if (!toAdd.length && !toRemove.length) {
      return res.status(400).json({ message: 'Indica etiquetas a agregar o quitar' });
    }
    const baseFilter = { _id: { $in: patientIds }, clinic: req.clinicId };
    let modified = 0;
    if (toAdd.length) {
      const r = await Patient.updateMany(baseFilter, { $addToSet: { tags: { $each: toAdd } } });
      modified = Math.max(modified, r.modifiedCount || 0);
      // Evento de dominio para el motor de workflows (trigger tag_added).
      const { emitDomainEvent, DOMAIN_EVENTS } = require('../utils/events');
      for (const pid of patientIds) {
        for (const tag of toAdd) {
          emitDomainEvent(DOMAIN_EVENTS.TAG_ADDED, {
            clinicId: String(req.clinicId),
            patientId: String(pid),
            tag,
          });
        }
      }
    }
    if (toRemove.length) {
      const r = await Patient.updateMany(baseFilter, { $pull: { tags: { $in: toRemove } } });
      modified = Math.max(modified, r.modifiedCount || 0);
    }
    res.json({ matched: patientIds.length, modified, add: toAdd, remove: toRemove });
  } catch (error) {
    res.status(500).json({ message: 'Error al etiquetar pacientes', error: error.message });
  }
};
