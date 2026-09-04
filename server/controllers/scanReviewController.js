/**
 * REVISIÓN DE LAS FICHAS FÍSICAS IMPORTADAS (/patients → "Fichas por revisar").
 *
 * Los pacientes que entraron desde un escaneo (scripts/importPatientsFromScans.js)
 * traen letra manuscrita transcrita: lo que no pasó la validación quedó guardado
 * igual pero MARCADO en `scanImport.dudas`. Aquí se corrige a mano, con el PDF
 * original al lado.
 *
 *   GET   /api/patients/scan-review          los importados (pendientes por defecto)
 *   PATCH /api/patients/:id/scan-review      corrige y da por revisada la ficha
 *
 * POR QUÉ NO BASTA CON EDITAR EL PACIENTE: al importar, los mismos datos se
 * copiaron a la ficha clínica (nombre, cédula, edad, celular, dirección y la fecha
 * del seguimiento). Corregir solo el paciente dejaría la historia clínica con el
 * dato viejo — y la historia es la que ve el doctor. Por eso la corrección se
 * aplica a los dos sitios en la misma operación.
 */
const Patient = require('../models/Patient');
const ClinicalRecord = require('../models/ClinicalRecord');
const ScannedDocument = require('../models/ScannedDocument');
const { emitToClinic } = require('../realtime');
const { NOTA_SEGUIMIENTO } = require('../utils/scanPatientExtract');
const { invoiceDate } = require('../utils/dates');

/** Campos que la pantalla de revisión puede corregir. */
const EDITABLES = ['firstName', 'lastName', 'cedula', 'age', 'phone', 'email', 'address', 'fecha'];

const txt = (v) => String(v ?? '').trim();

/**
 * Qué es "estar pendiente de revisar".
 *
 * NO basta con venir de una ficha escaneada. La tanda de septiembre marcó 5.555
 * pacientes y solo 4.243 tenían algo que mirar: los otros 1.300 se leyeron
 * enteros y coinciden con lo que ya había. Listarlos también convertía la
 * pantalla en un trámite de pasar fichas correctas, que es la mejor forma de que
 * nadie llegue a las que sí importan.
 *
 * Pendiente = sin revisar Y con algo que decidir: un campo dudoso, o un valor de
 * la ficha física que no coincide con el del sistema.
 */
const PENDIENTE = {
  'scanImport.revisadoAt': null,
  $or: [
    { 'scanImport.dudas.0': { $exists: true } },
    { 'scanImport.alternos.0': { $exists: true } },
  ],
};

/**
 * Lista los pacientes importados desde un escaneo.
 * ?estado=pendientes (por defecto) | revisados | todos
 */
exports.listScanImports = async (req, res) => {
  try {
    const estado = req.query.estado || 'pendientes';
    const filtro = { clinic: req.clinicId, 'scanImport.scan': { $ne: null }, active: true };
    if (estado === 'pendientes') Object.assign(filtro, PENDIENTE);
    if (estado === 'revisados') filtro['scanImport.revisadoAt'] = { $ne: null };

    const pacientes = await Patient.find(filtro)
      .select('firstName lastName cedula age phone email address scanImport createdAt')
      .sort({ 'scanImport.importadoAt': -1 })
      .lean();

    // El nombre del documento y la fecha de la ficha viven fuera del paciente; se
    // traen de una vez para no dejar que la pantalla haga N peticiones.
    const scanIds = pacientes.map((p) => p.scanImport?.scan).filter(Boolean);
    const escaneos = await ScannedDocument.find({ _id: { $in: scanIds } }).select('name pages').lean();
    const porScan = new Map(escaneos.map((d) => [String(d._id), d]));

    const historias = await ClinicalRecord.find({ patient: { $in: pacientes.map((p) => p._id) } })
      .select('patient fecha')
      .lean();
    const porPaciente = new Map(historias.map((h) => [String(h.patient), h]));

    res.json(pacientes.map((p) => ({
      ...p,
      scanName: porScan.get(String(p.scanImport?.scan))?.name || '',
      scanPages: porScan.get(String(p.scanImport?.scan))?.pages || 0,
      fecha: porPaciente.get(String(p._id))?.fecha || null,
    })));
  } catch (error) {
    res.status(500).json({ message: 'Error al listar las fichas importadas', error: error.message });
  }
};

/** Cuántas quedan por revisar (para el aviso en /patients). */
exports.countPendingScanImports = async (req, res) => {
  try {
    const pendientes = await Patient.countDocuments({
      clinic: req.clinicId,
      'scanImport.scan': { $ne: null },
      active: true,
      ...PENDIENTE,
    });
    res.json({ pendientes });
  } catch (error) {
    res.status(500).json({ message: 'Error al contar', error: error.message });
  }
};

/**
 * Guarda las correcciones y marca la ficha como revisada.
 *
 * Solo se tocan los campos que vengan en el cuerpo: enviar el formulario sin
 * cambios equivale a "lo revisé y estaba bien".
 */
exports.saveScanReview = async (req, res) => {
  try {
    const paciente = await Patient.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!paciente) return res.status(404).json({ message: 'Paciente no encontrado' });
    if (!paciente.scanImport?.scan) {
      return res.status(400).json({ message: 'Este paciente no vino de una ficha escaneada' });
    }

    const cambios = {};
    for (const campo of EDITABLES) {
      if (Object.prototype.hasOwnProperty.call(req.body, campo)) cambios[campo] = req.body[campo];
    }

    // La cédula es única en toda la base. Se comprueba ANTES de escribir: el índice
    // solo avisaría con un E11000 después de haber intentado guardar, y en la
    // pantalla de revisión —donde se corrigen justo cédulas mal leídas— chocar con
    // otro paciente es un caso normal, no un fallo técnico.
    if ('cedula' in cambios && txt(cambios.cedula)) {
      const choque = await Patient.findOne({ cedula: txt(cambios.cedula), _id: { $ne: paciente._id } })
        .select('firstName lastName').lean();
      if (choque) {
        return res.status(400).json({
          message: `Ya existe otro paciente con esa cédula: ${choque.firstName} ${choque.lastName}`,
        });
      }
    }

    if ('firstName' in cambios) paciente.firstName = txt(cambios.firstName);
    if ('lastName' in cambios) paciente.lastName = txt(cambios.lastName);
    if ('cedula' in cambios) paciente.cedula = txt(cambios.cedula);
    if ('phone' in cambios) paciente.phone = txt(cambios.phone);
    if ('email' in cambios) paciente.email = txt(cambios.email);
    if ('address' in cambios) paciente.address = txt(cambios.address);
    if ('age' in cambios) {
      const n = Number.parseInt(cambios.age, 10);
      paciente.age = Number.isFinite(n) && n > 0 ? n : undefined;
    }

    if (!paciente.firstName || !paciente.lastName) {
      return res.status(400).json({ message: 'El nombre y el apellido no pueden quedar vacíos' });
    }

    // Revisada: sale de la lista de pendientes y ya no arrastra dudas.
    paciente.scanImport.dudas = [];
    // Los valores alternos de la ficha física ya cumplieron su función: alguien
    // los comparó con el PDF delante y se quedó con uno. Dejarlos los volvería a
    // enseñar en la ficha del paciente para siempre, como si nadie hubiera
    // decidido nada. Si llega otra ficha con una lectura distinta, la importación
    // los vuelve a poner.
    paciente.scanImport.alternos = [];
    paciente.scanImport.revisadoAt = new Date();
    paciente.scanImport.revisadoBy = req.user._id;
    await paciente.save();

    // La ficha clínica lleva copia de los mismos datos: si no se actualiza aquí,
    // el doctor sigue viendo el dato equivocado por mucho que se corrija el paciente.
    const historia = await ClinicalRecord.findOne({ patient: paciente._id });
    if (historia) {
      historia.nombre = `${paciente.firstName} ${paciente.lastName}`;
      historia.cedula = paciente.cedula;
      historia.celular = paciente.phone;
      historia.direccion = paciente.address;
      historia.edad = paciente.age;
      if ('fecha' in cambios && cambios.fecha) {
        // `invoiceDate` ancla al MEDIODÍA local. Un `new Date('2026-03-15')` se lee
        // como medianoche UTC, que en Ecuador es el día 14 a las 19:00: la ficha se
        // guardaría con un día menos del que el usuario acaba de escribir.
        const f = invoiceDate(cambios.fecha);
        if (f instanceof Date && !Number.isNaN(f.getTime())) {
          historia.fecha = f;
          // El seguimiento que trajo el PDF lleva la misma fecha que la ficha.
          const fu = historia.followUps.find((s) => s.observaciones === NOTA_SEGUIMIENTO) || historia.followUps[0];
          if (fu) fu.fecha = f;
        }
      }
      await historia.save();
    }

    emitToClinic(req.clinicId, 'patient:updated', { id: paciente._id });
    res.json({ message: 'Ficha revisada', patient: paciente });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(400).json({ message: 'Ya existe otro paciente con esa cédula' });
    }
    res.status(400).json({ message: `No se pudo guardar la revisión: ${error.message}`, error: error.message });
  }
};
