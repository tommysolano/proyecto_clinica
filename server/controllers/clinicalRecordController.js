const ClinicalRecord = require('../models/ClinicalRecord');
const Patient = require('../models/Patient');
const Product = require('../models/Product');
const Treatment = require('../models/Treatment');
const {
  ANTECEDENTES_CATEGORIAS,
  HABITOS_CATEGORIAS,
  HABITOS_KEYS,
  REVISION_SISTEMAS,
  EXAMEN_REGIONAL,
  EXAMEN_SISTEMICO,
} = require('../constants/mspCatalogs');
const { SUERO_CLORURO_NOMBRE, SUERO_CLORURO_VOLUMENES, buscarComponenteSuero } = require('../constants/sueroterapia');
const {
  CARDIOLOGIA_ANTECEDENTES_KEYS,
  CARDIOLOGIA_ESTUDIOS_KEYS,
  PODOLOGIA_HALLAZGOS_KEYS,
  PODOLOGIA_PULSO_OPCIONES,
  PODOLOGIA_SENSIBILIDAD_OPCIONES,
  PODOLOGIA_REFLEJOS_OPCIONES,
  ODONTOGRAMA_PIEZAS,
  ODONTOGRAMA_ESTADOS_KEYS,
  COSMETOLOGIA_FOTOTIPOS,
  COSMETOLOGIA_GLOGAU,
  COSMETOLOGIA_ROSACEA,
  COSMETOLOGIA_BIOTIPOS_KEYS,
  COSMETOLOGIA_ARRUGAS_KEYS,
  COSMETOLOGIA_ACNE_KEYS,
  COSMETOLOGIA_LESIONES_KEYS,
  COSMETOLOGIA_HIPERPIGMENTACION,
  COSMETOLOGIA_DESHIDRATACION,
  COSMETOLOGIA_CABELLO,
  COSMETOLOGIA_CUERO_CABELLUDO,
  COSMETOLOGIA_FIBRA_CAPILAR_KEYS,
  COSMETOLOGIA_AFECCIONES_CUERO_KEYS,
  ODONTOGRAMA_ESTADOS_CARA_KEYS,
  ODONTOGRAMA_GRADOS,
  marcaValida,
  HIGIENE_ORAL_FILAS,
  HIGIENE_ORAL_FILAS_KEYS,
  HIGIENE_ORAL_INDICES,
  ENFERMEDAD_PERIODONTAL_KEYS,
  MALOCLUSION_KEYS,
  FLUOROSIS_KEYS,
} = require('../constants/specialtyCatalogs');
const {
  SCORE_MAMA_NUMERICOS_KEYS,
  SCORE_MAMA_CONCIENCIA,
  SCORE_MAMA_PROTEINURIA,
  calcularScoreMama,
} = require('../constants/scoreMama');
const { specialtyFollowUpHtml } = require('../utils/specialtyFollowUpPrint');
const { firmarPdfConUsuario, bloqueFirmaHtml, FIRMA_CSS } = require('../utils/pdfSignature');
const { describeCie10 } = require('../utils/cie10Catalog');
const { emitToClinic, emitToUser, emitToRole } = require('../realtime');
const { canReq } = require('../utils/permissions');
const { isDoctorRole } = require('../constants/roles');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');

// --- Almacenamiento en disco para adjuntos de seguimientos (PDFs) ---
const FOLLOWUPS_DIR = path.join(__dirname, '..', 'storage', 'followups');
try {
  fs.mkdirSync(FOLLOWUPS_DIR, { recursive: true });
} catch (_) {}

const followupStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(FOLLOWUPS_DIR, String(req.clinicId || 'default'));
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ts = Date.now();
    const rand = crypto.randomBytes(6).toString('hex');
    const ext = path.extname(file.originalname || '') || '.pdf';
    cb(null, `${ts}-${rand}${ext}`);
  },
});

// Se aceptan PDFs e imágenes (ecografías, resultados de laboratorio, fotos, etc.).
const OK_ATTACHMENT_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
];

exports.uploadAttachmentMiddleware = multer({
  storage: followupStorage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    if (OK_ATTACHMENT_TYPES.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Solo se aceptan archivos PDF o imágenes'));
  },
}).single('file');

/**
 * La cabecera de la hoja MSP guarda su PROPIA copia de la cédula, la dirección y
 * el celular del paciente. Son los mismos datos de contacto que solo ve el
 * administrador (ver CONTACT_FIELDS en patientController): esconderlos ahí y
 * dejarlos aquí sería no esconderlos.
 */
const RECORD_CONTACT_FIELDS = ['cedula', 'direccion', 'celular'];

const hideContactData = (record, req) => {
  if (!record || canReq(req, 'patients.contactData')) return record;
  const obj = record.toObject ? record.toObject() : { ...record };
  RECORD_CONTACT_FIELDS.forEach((f) => {
    obj[f] = undefined;
  });
  return obj;
};

/**
 * ENFERMERÍA VE LA HISTORIA CLÍNICA ENTERA.
 *
 * Hasta ahora el servidor le recortaba la ficha: de cada seguimiento solo la
 * receta, y sin antecedentes, alergias ni hábitos. La idea era que su trabajo no
 * necesitaba la historia. No era cierto: quien canaliza una vía y mete tres
 * ampollas es justo quien tiene que saber a qué es alérgico el paciente, qué
 * toma ya, qué diagnóstico hay detrás y cómo salieron los signos vitales. El
 * recorte no protegía nada —es la misma clínica y el mismo paciente— y en cambio
 * escondía lo único que puede evitar una reacción.
 *
 * Lo que enfermería sigue SIN poder es REDACTAR la consulta: eso es de quien
 * atiende, y lo defienden las rutas (ver routes/clinicalRecords.js), no un
 * recorte de la respuesta.
 *
 * Los datos de CONTACTO (cédula, dirección, celular) son otra cosa y siguen
 * siendo solo del administrador: los quita `hideContactData`, que no tiene nada
 * que ver con lo clínico.
 */

/**
 * FECHA DE UN SEGUIMIENTO PARA IMPRIMIRLA (dd/mm/aaaa).
 *
 * El día se lee en UTC, no en hora local. `addFollowUp` guarda `new Date(fecha)`
 * y un 'YYYY-MM-DD' se convierte en medianoche UTC: leído en Ecuador (UTC-5) eso
 * es el DÍA ANTERIOR a las 19:00, así que una consulta del 5 de enero salía
 * impresa como 4 de enero en la hoja del MSP. Es el mismo criterio que ya usa
 * `appointmentDateTime` para las citas: las dos formas históricas de guardado
 * (medianoche UTC y 12:00 local) caen en el día correcto leídas en UTC.
 */
const fechaDocumento = (d) => {
  if (!d) return '';
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return '';
  /**
   * Hay DOS formas de fecha guardadas y se leen distinto:
   *
   *  - Medianoche UTC exacta: vino de un 'YYYY-MM-DD' del formulario (el doctor
   *    eligió el día). Se lee en UTC, porque en Ecuador (UTC-5) esa medianoche
   *    es el día ANTERIOR a las 19:00 y la consulta salía fechada un día antes.
   *  - Cualquier otro instante: es un sello de tiempo real (`new Date()` al
   *    guardar sin fecha). Se lee en hora local, porque lo que vale es la hora
   *    de Ecuador: a las 21:46 del 27 ya es día 28 en UTC.
   */
  const esFechaSola =
    x.getUTCHours() === 0 && x.getUTCMinutes() === 0 &&
    x.getUTCSeconds() === 0 && x.getUTCMilliseconds() === 0;
  const dia = esFechaSola ? x.getUTCDate() : x.getDate();
  const mes = (esFechaSola ? x.getUTCMonth() : x.getMonth()) + 1;
  const anio = esFechaSola ? x.getUTCFullYear() : x.getFullYear();
  return `${String(dia).padStart(2, '0')}/${String(mes).padStart(2, '0')}/${anio}`;
};

/**
 * Sanea la COMPOSICIÓN de un suero tal y como llega del cliente.
 *
 * El cloruro es la base y va en todos: lo único que se elige es el volumen, y
 * solo se aceptan los cuatro que existen (100/250/500/1000 ml) — un "750"
 * tecleado de más es una bolsa que no está en la nevera.
 *
 * Las ampollas y moléculas se resuelven contra el catálogo para quedarse con el
 * NOMBRE y el CÓDIGO buenos: es lo que luego permite encontrar la ampolla en el
 * inventario y descontarla. Lo que no está en el catálogo NO se descarta —el
 * médico puede recetar algo que la lista no tiene— pero se guarda sin código, y
 * entonces simplemente no habrá stock que mover.
 */
const saneaComposicionSuero = (it) => {
  const base = it?.serumBase || {};
  const volumen = Number(base.volumeMl);
  const serumBase = {
    name: String(base.name || '').trim() || SUERO_CLORURO_NOMBRE,
    volumeMl: SUERO_CLORURO_VOLUMENES.includes(volumen) ? volumen : null,
  };
  const serumComponents = (Array.isArray(it?.serumComponents) ? it.serumComponents : [])
    .map((c) => {
      const nombre = String(c?.name || '').trim();
      if (!nombre) return null;
      const delCatalogo = buscarComponenteSuero({ code: c?.code, name: nombre });
      const cantidad = Number(c?.quantity);
      return {
        code: delCatalogo?.code || String(c?.code || '').trim(),
        name: delCatalogo?.name || nombre,
        grupo:
          delCatalogo?.grupo ||
          (['ampolla', 'molecula', 'otro'].includes(c?.grupo) ? c.grupo : 'otro'),
        // Una ampolla "de 0" no es una ampolla: si no viene un número válido se
        // asume 1, que es lo que el médico quiso decir al añadirla a la lista.
        quantity: Number.isFinite(cantidad) && cantidad > 0 ? cantidad : 1,
      };
    })
    .filter(Boolean);
  return { serumBase, serumComponents };
};

/**
 * La preparación del suero en una línea: la base y lo que lleva dentro.
 *
 * Es lo que enfermería lee justo antes de pinchar, así que va en el mismo orden
 * en que lo escribió el médico y las cantidades se ponen SIEMPRE, también cuando
 * es una sola: "APIMEL ×1" no se puede confundir; "APIMEL" a secas sí.
 */
const describeSuero = (it) => {
  if (!it?.isSerum) return '';
  const partes = [];
  const vol = it.serumBase?.volumeMl;
  if (vol) partes.push(`${it.serumBase?.name || SUERO_CLORURO_NOMBRE} ${vol} ml`);
  (it.serumComponents || []).forEach((c) => {
    if (c?.name) partes.push(`${c.name} ×${c.quantity || 1}`);
  });
  return partes.join(' · ');
};

/**
 * Cruza LO RECETADO con LO QUE ENFERMERÍA DICE QUE PUSO.
 *
 * El paciente puede negarse a una ampolla en el momento: el médico recetó tres y
 * él solo quiere dos. Se recorre siempre la receta —no lo que manda el cliente—
 * para que una ampolla omitida quede registrada como omitida, con su motivo, en
 * vez de desaparecer del parte. Si no viene nada (cliente antiguo, o un suero sin
 * composición) se asume que se puso todo lo recetado, que es lo que pasaba antes.
 *
 * Nunca se acepta poner MÁS de lo recetado: para eso hace falta otra receta, que
 * es la misma línea que ya defiende el tope de dosis.
 */
const cruzaComponentesAplicados = (serumComponents, enviados) => {
  const recetados = Array.isArray(serumComponents) ? serumComponents : [];
  const lista = Array.isArray(enviados) ? enviados : null;
  // Se busca por código; sin código (algo escrito a mano) por nombre.
  const clave = (c) => String(c?.code || '').trim().toUpperCase() || String(c?.name || '').trim().toUpperCase();
  /**
   * Una COLA por clave, no un mapa: si la preparación repite la misma ampolla
   * («APIMEL ×1» y «APIMEL ×2» son dos líneas legítimas) y la lista que llega no
   * viene completa, un mapa haría que las dos filas leyeran la misma casilla y
   * se descontara de más. Cada casilla se consume una sola vez.
   */
  const porClave = new Map();
  (lista || []).forEach((c) => {
    const k = clave(c);
    if (!k) return;
    if (!porClave.has(k)) porClave.set(k, []);
    porClave.get(k).push(c);
  });
  const tomarPorClave = (k) => (porClave.get(k) || []).shift() || null;
  /**
   * Cuando llega la lista COMPLETA se empareja por POSICIÓN, no por código: el
   * cliente la construye a partir de la receta y en el mismo orden. Emparejar
   * solo por código se equivoca cuando la misma ampolla aparece dos veces en la
   * preparación (recetar "APIMEL ×1" y "APIMEL ×2" es legítimo): las dos filas
   * leerían la misma casilla y se descontaría de menos o de más.
   */
  const porPosicion = lista && lista.length === recetados.length;

  return recetados.map((r, i) => {
    const recetada = Number(r.quantity) || 0;
    const enviado = lista ? (porPosicion ? lista[i] : tomarPorClave(clave(r))) : null;
    // Sin lista → se pone todo. Con lista pero sin esta ampolla → no se pone
    // (enfermería la desmarcó), que es justo el caso que había que poder contar.
    let puesta = lista ? Number(enviado?.quantityApplied) : recetada;
    if (!Number.isFinite(puesta) || puesta < 0) puesta = 0;
    puesta = Math.min(puesta, recetada);
    return {
      code: r.code || '',
      name: r.name || '',
      grupo: r.grupo || '',
      quantityPrescribed: recetada,
      quantityApplied: puesta,
      omitReason: puesta < recetada ? String(enviado?.omitReason || '').trim() : '',
    };
  });
};

/**
 * Busca la ampolla en el inventario por su código de catálogo.
 *
 * El catálogo de productos es DE TODA LA ORGANIZACIÓN, no de la sucursal: un
 * producto no pertenece a la sede que lo creó y `availableInClinics` vacío
 * significa "en todas" (ver getProducts). Filtrar por `clinic` aquí haría que una
 * ampolla dada de alta en otra sede no se encontrara y el suero se aplicara sin
 * descontar nada, en silencio.
 */
const buscaProductoPorCodigo = async (clinicId, code) => {
  // Primero el producto DE ESTA SEDE. El código es único por (clinic, code),
  // así que dos sucursales pueden tener cada una su «AAPL01»: sin este primer
  // intento se descontaba el de la otra sede y el stock de la nevera desde la
  // que salió la ampolla seguía intacto.
  const propio = await Product.findOne({ code, clinic: clinicId });
  if (propio) return propio;
  return Product.findOne({
    code,
    $or: [
      { availableInClinics: { $exists: false } },
      { availableInClinics: { $size: 0 } },
      { availableInClinics: clinicId },
    ],
  });
};

/**
 * Descuenta del inventario lo que se puso DE VERDAD en una dosis de suero.
 *
 * Se descuenta al aplicar, no al recetar: hasta que el suero no está puesto no
 * ha salido nada de la percha, y la ampolla que el paciente rechaza sigue ahí.
 *
 * Se mueve el stock igual que los componentes de un producto compuesto (más
 * abajo, al guardar la receta): stock del producto + un movimiento de inventario.
 * NO pasa por las capas FIFO del kardex, que es como se descuenta una venta.
 *
 * Lo que no esté dado de alta en el inventario se aplica igual y no mueve stock:
 * enfermería NO se puede quedar sin poner un suero porque a alguien le falte
 * crear un producto.
 *
 * Devuelve lo movido para poder deshacerlo exactamente igual.
 */
const descontarComponentesSuero = async ({ clinicId, userId, aplicados, itemName, recordId }) => {
  const InventoryMovement = require('../models/InventoryMovement');
  const movimientos = [];
  for (const c of aplicados) {
    if (!c.code || !(c.quantityApplied > 0)) continue;
    try {
      const prod = await buscaProductoPorCodigo(clinicId, c.code);
      if (!prod || prod.unlimited) continue;
      /**
       * SE REGISTRA LO QUE DE VERDAD SALIÓ, no lo que se pidió.
       *
       * `Product.stock` tiene `min: 0`, así que descontar 2 de un stock de 1
       * deja 0: solo salió 1. Anotar 2 en el movimiento descuadra el kardex, y
       * anotar 2 en `stockMoves` hace que deshacer la dosis devuelva 2 a la
       * percha — inventario inventado. El clínico sigue diciendo que se
       * aplicaron 2 (que es la verdad), pero el inventario solo mueve lo que
       * tenía.
       */
      const antes = prod.stock || 0;
      const despues = Math.max(0, antes - c.quantityApplied);
      const salieron = antes - despues;
      if (salieron <= 0) continue;
      prod.stock = despues;
      await prod.save();
      await InventoryMovement.create({
        clinic: clinicId,
        product: prod._id,
        type: 'salida',
        quantity: salieron,
        balanceAfter: despues,
        movementDate: new Date(),
        reason: `${c.name} · suero ${itemName}`.trim(),
        sourceModel: 'ClinicalRecord',
        sourceRef: recordId || null,
        createdBy: userId,
      });
      movimientos.push({ product: prod._id, quantity: salieron });
    } catch (e) {
      console.warn(`No se pudo descontar ${c.code} del inventario:`, e.message);
    }
  }
  return movimientos;
};

/**
 * Devuelve al inventario lo que descontó una dosis que se deshace.
 *
 * Va por `stockMoves` —lo que esa dosis movió de verdad— y no por la receta: si
 * entretanto cambió algo, recalcularlo devolvería a la percha algo que nunca
 * salió de ella.
 */
const devolverComponentesSuero = async ({ clinicId, userId, movimientos, itemName, recordId }) => {
  const InventoryMovement = require('../models/InventoryMovement');
  for (const m of movimientos || []) {
    if (!m?.product || !(m.quantity > 0)) continue;
    try {
      // Por _id, sin filtrar por sucursal: el catálogo es de toda la
      // organización (ver buscaProductoPorCodigo) y es EXACTAMENTE el producto
      // del que salió el stock.
      const prod = await Product.findById(m.product);
      if (!prod || prod.unlimited) continue;
      prod.stock = (prod.stock || 0) + m.quantity;
      await prod.save();
      await InventoryMovement.create({
        clinic: clinicId,
        product: prod._id,
        type: 'entrada',
        quantity: m.quantity,
        balanceAfter: prod.stock,
        movementDate: new Date(),
        reason: `Reverso de aplicación · suero ${itemName}`.trim(),
        sourceModel: 'ClinicalRecord',
        sourceRef: recordId || null,
        createdBy: userId,
      });
    } catch (e) {
      console.warn('No se pudo devolver al inventario un componente del suero:', e.message);
    }
  }
};

/**
 * Obtiene la ficha clínica de un paciente. Si no existe la crea con datos
 * básicos copiados del paciente.
 */
exports.getOrCreateByPatient = async (req, res) => {
  try {
    const { patientId } = req.params;
    const patient = await Patient.findById(patientId);
    if (!patient) return res.status(404).json({ message: 'Paciente no encontrado' });

    let record = await ClinicalRecord.findOne({
      clinic: req.clinicId,
      patient: patientId,
    })
      .populate('followUps.createdBy', 'name')
      .populate('createdBy', 'name')
      .populate('updatedBy', 'name');

    if (!record) {
      // Edad calculada
      let edad;
      if (patient.birthDate) {
        const diff = Date.now() - new Date(patient.birthDate).getTime();
        edad = Math.floor(diff / (1000 * 60 * 60 * 24 * 365.25));
      }
      record = await ClinicalRecord.create({
        clinic: req.clinicId,
        patient: patient._id,
        fecha: new Date(),
        nombre: `${patient.firstName} ${patient.lastName}`.trim(),
        direccion: patient.address || '',
        edad: edad ?? 0,
        cedula: patient.cedula,
        celular: patient.phone || '',
        followUps: [],
        createdBy: req.user._id,
      });
    }

    res.json(hideContactData(record, req));
  } catch (error) {
    res
      .status(500)
      .json({ message: 'Error al obtener ficha clínica', error: error.message });
  }
};

exports.updateByPatient = async (req, res) => {
  try {
    const { patientId } = req.params;
    const patient = await Patient.findById(patientId);
    if (!patient) return res.status(404).json({ message: 'Paciente no encontrado' });

    const allowed = [
      'fecha',
      'nombre',
      'direccion',
      'edad',
      'cedula',
      'celular',
      // Antecedentes patológicos MSP (C personales / D familiares) + datos relevantes.
      'patologicosPersonales',
      'patologicosFamiliares',
      'datosRelevantes',
      'datosRelevantesFamiliares',
      // Antecedentes que la hoja MSP amontona en un renglón y que aquí son tres
      // preguntas distintas, más los hábitos.
      'antecedentesQuirurgicos',
      'antecedentesMedicamentos',
      'alergias',
      'habitosDetalle',
    ];
    const update = { updatedBy: req.user._id };
    for (const k of allowed) {
      if (req.body[k] !== undefined) update[k] = req.body[k];
    }
    // Los hábitos SÍ se sanean (los antecedentes MSP vienen de siempre sin
    // sanear): solo claves del catálogo y solo las que dicen algo, para que no
    // entren casillas inventadas ni nueve filas vacías por ficha.
    if (req.body.habitos !== undefined) {
      update.habitos = (Array.isArray(req.body.habitos) ? req.body.habitos : [])
        .filter((c) => c && HABITOS_KEYS.includes(c.key))
        .map((c) => ({ key: String(c.key), marked: !!c.marked, detail: String(c.detail || '').trim() }))
        .filter((c) => c.marked || c.detail);
    }
    // Quien no ve cédula/dirección/celular tampoco los guarda: su formulario los
    // recibe vacíos y un guardado cualquiera los borraría de la hoja MSP.
    if (!canReq(req, 'patients.contactData')) {
      RECORD_CONTACT_FIELDS.forEach((f) => delete update[f]);
    }

    const record = await ClinicalRecord.findOneAndUpdate(
      { clinic: req.clinicId, patient: patientId },
      { $set: update, $setOnInsert: { createdBy: req.user._id } },
      { new: true, upsert: true, runValidators: true }
    );

    res.json(hideContactData(record, req));
  } catch (error) {
    res
      .status(500)
      .json({ message: 'Error al actualizar ficha clínica', error: error.message });
  }
};

exports.addFollowUp = async (req, res) => {
  try {
    const { patientId } = req.params;
    const {
      fecha,
      descripcion,
      valor,
      metodoPago,
      recomendaciones,
      estudioSintomas,
      receta,            // texto libre legacy (opcional)
      recetaItems,       // array de insumos/medicamentos desde inventario
      derivacionItems,   // array de servicios/programas desde inventario
      observaciones,     // reemplaza el antiguo "tratamiento asociado"
      treatment,         // legacy: id de tratamiento manual (sigue soportado)
      vitalSigns,        // signos vitales (opcional)
      opticaRx,          // datos ópticos (rol optica): { od:{...}, oi:{...} }
      ginecologia,       // datos ginecológicos (rol ginecologia)
      podologia,         // datos podológicos (rol podologia)
      odontologia,       // odontograma FDI (rol odontologia)
      cosmetologia,      // fichas estética facial/capilar (rol cosmetologia)
      cardiologia,       // ficha cardiológica (rol cardiologia)
      // --- Campos del formulario MSP HCU-form.002 ---
      tipoConsulta,      // B: 'primera' | 'subsecuente'
      enfermedadActual,  // E: enfermedad o problema actual
      revisionSistemas,  // G: [{ key, marked, detail }]
      revisionSistemasHallazgos, // G: hallazgos descritos de la revisión
      examenFisico,      // H: { regional:[...], sistemico:[...], hallazgos }
      diagnosticos,      // I: [{ descripcion, cie, cieDescripcion, presuntivo, definitivo }]
      planTratamiento,   // J: texto del plan
      recomendacionesNoFarmacologicas, // dieta, ejercicio, reposo… (va bajo el plan)
      evolucion,         // evolución respecto de consultas anteriores
    } = req.body;

    // --- Saneadores de las secciones MSP (solo se guardan claves con contenido) ---
    const sanitizeChecks = (arr) =>
      (Array.isArray(arr) ? arr : [])
        .filter((c) => c && c.key)
        .map((c) => ({ key: String(c.key), marked: !!c.marked, detail: String(c.detail || '').trim() }));
    const sanitizeExamen = (ex) => {
      if (!ex || typeof ex !== 'object') return undefined;
      return {
        regional: sanitizeChecks(ex.regional),
        sistemico: sanitizeChecks(ex.sistemico),
        hallazgos: String(ex.hallazgos || '').trim(),
      };
    };
    const sanitizeDiagnosticos = (arr) =>
      (Array.isArray(arr) ? arr : [])
        .filter((d) => d && (String(d.descripcion || '').trim() || String(d.cie || '').trim()))
        .slice(0, 6)
        .map((d) => {
          const cie = String(d.cie || '').trim().toUpperCase();
          return {
            descripcion: String(d.descripcion || '').trim(),
            cie,
            // Si el cliente no mandó el nombre del código, se toma del catálogo.
            cieDescripcion: String(d.cieDescripcion || '').trim() || describeCie10(cie),
            presuntivo: !!d.presuntivo,
            definitivo: !!d.definitivo,
          };
        });

    // Saneador de los datos ginecológicos: solo persiste lo que llega con contenido.
    const sanitizeGineco = (g) => {
      if (!g || typeof g !== 'object') return undefined;
      const numOrNull = (v) => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v));
      const met = g.metodosAnticonceptivos || {};
      const pap = g.pap || {};
      const toma = pap.toma || {};
      const cp = g.controlPrenatal || {};
      const gpac = g.gpac || {};
      // El esquema exige min:0; un negativo por API tumbaría TODO el seguimiento
      // con un error de validación, así que aquí se descarta y punto.
      const pesoPre = numOrNull(g.pesoPreconcepcional);
      return {
        fum: g.fum ? new Date(g.fum) : null,
        gpac: {
          gestas: numOrNull(gpac.gestas),
          partos: numOrNull(gpac.partos),
          abortos: numOrNull(gpac.abortos),
          cesareas: numOrNull(gpac.cesareas),
        },
        embarazoActual: typeof g.embarazoActual === 'boolean' ? g.embarazoActual : null,
        pesoPreconcepcional: pesoPre != null && pesoPre >= 0 ? pesoPre : null,
        metodosAnticonceptivos: {
          hormonal: !!met.hormonal,
          barrera: !!met.barrera,
          diu: !!met.diu,
          otro: !!met.otro,
          otroDetalle: String(met.otroDetalle || '').trim(),
        },
        pap: {
          tipo: ['previo', 'primera_vez'].includes(pap.tipo) ? pap.tipo : '',
          toma: {
            exocervical: !!toma.exocervical,
            endocervical: !!toma.endocervical,
            otros: !!toma.otros,
            otrosDetalle: String(toma.otrosDetalle || '').trim(),
          },
        },
        controlPrenatal: {
          signosVitalesScore: String(cp.signosVitalesScore || '').trim(),
          scoreMama: sanitizeScoreMama(cp.scoreMama),
          bebePosicion: String(cp.bebePosicion || '').trim(),
          actividadCardiaca: String(cp.actividadCardiaca || '').trim(),
        },
      };
    };

    /**
     * SCORE MAMÁ. Los puntajes y el total se RECALCULAN aquí a partir de los
     * valores medidos: lo que mande el navegador se ignora. Es un puntaje que
     * decide si se activa la clave obstétrica — no puede depender de que el
     * cliente esté actualizado ni de que nadie toque la petición.
     */
    const sanitizeScoreMama = (sm) => {
      if (!sm || typeof sm !== 'object') return undefined;
      const numOrNull = (v) => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v));
      const medidos = {};
      for (const key of SCORE_MAMA_NUMERICOS_KEYS) medidos[key] = numOrNull(sm[key]);
      medidos.conciencia = SCORE_MAMA_CONCIENCIA.some((o) => o.key === sm.conciencia) ? sm.conciencia : '';
      medidos.proteinuria = SCORE_MAMA_PROTEINURIA.some((o) => o.key === sm.proteinuria) ? sm.proteinuria : '';
      const { puntajes, total } = calcularScoreMama(medidos);
      return { ...medidos, puntajes, total };
    };

    // --- Saneadores de las fichas por especialidad ---
    // Regla común: el catálogo manda. Solo se guardan claves que existan en
    // server/constants/specialtyCatalogs.js y opciones dentro de su lista; lo que
    // no cuadra se descarta en silencio en vez de romper la validación de mongoose.
    const txt = (v) => String(v ?? '').trim();
    const pick = (v, options) => (options.includes(v) ? v : '');
    const checksIn = (arr, allowedKeys) =>
      sanitizeChecks(arr).filter((c) => allowedKeys.includes(c.key));

    const sanitizePodologia = (p) => {
      if (!p || typeof p !== 'object') return undefined;
      const hg = p.hallazgosGenerales || {};
      const vn = p.vascularNeurologica || {};
      const ev = p.evaluacion || {};
      return {
        hallazgosGenerales: {
          piel: txt(hg.piel),
          unas: txt(hg.unas),
          hidratacion: txt(hg.hidratacion),
          temperatura: txt(hg.temperatura),
          coloracion: txt(hg.coloracion),
          edema: typeof hg.edema === 'boolean' ? hg.edema : null,
          otros: txt(hg.otros),
        },
        vascularNeurologica: {
          pulsoPedio: pick(vn.pulsoPedio, PODOLOGIA_PULSO_OPCIONES),
          pulsoTibialPosterior: pick(vn.pulsoTibialPosterior, PODOLOGIA_PULSO_OPCIONES),
          llenadoCapilar: txt(vn.llenadoCapilar),
          sensibilidadMonofilamento: pick(vn.sensibilidadMonofilamento, PODOLOGIA_SENSIBILIDAD_OPCIONES),
          reflejos: pick(vn.reflejos, PODOLOGIA_REFLEJOS_OPCIONES),
        },
        evaluacion: {
          piel: txt(ev.piel),
          unas: txt(ev.unas),
          pulsos: txt(ev.pulsos),
          sensibilidad: txt(ev.sensibilidad),
          calzado: txt(ev.calzado),
          marcha: txt(ev.marcha),
        },
        hallazgos: checksIn(p.hallazgos, PODOLOGIA_HALLAZGOS_KEYS),
        hallazgosDetalle: txt(p.hallazgosDetalle),
      };
    };

    /**
     * Ficha cardiológica. Los antecedentes son de TRES estados (sí / no / sin
     * consignar): solo se guarda el que trae un booleano de verdad, para no
     * convertir "no preguntado" en "el paciente dice que no".
     */
    const sanitizeCardiologia = (c) => {
      if (!c || typeof c !== 'object') return undefined;
      const numOrNull = (v) => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v));
      const ecg = c.electrocardiograma || {};
      const est = c.estudios || {};
      const plan = c.plan || {};
      const estudios = {};
      for (const key of CARDIOLOGIA_ESTUDIOS_KEYS) estudios[key] = txt(est[key]);
      return {
        antecedentes: (Array.isArray(c.antecedentes) ? c.antecedentes : [])
          .filter((a) => a && CARDIOLOGIA_ANTECEDENTES_KEYS.includes(a.key) && typeof a.value === 'boolean')
          .map((a) => ({ key: a.key, value: a.value })),
        antecedentesOtros: txt(c.antecedentesOtros),
        alergias: txt(c.alergias),
        medicacionActual: txt(c.medicacionActual),
        electrocardiograma: {
          ritmo: txt(ecg.ritmo),
          fc: numOrNull(ecg.fc),
          hallazgos: txt(ecg.hallazgos),
        },
        estudios,
        plan: {
          estudiosSolicitados: txt(plan.estudiosSolicitados),
          proximoControl: txt(plan.proximoControl),
        },
      };
    };

    /**
     * Estado de UNA cara. Solo valen los estados de ámbito 'cara' (pintar
     * "extracción indicada" en la cara mesial no significaría nada).
     *
     * Acepta además el formato ANTIGUO, en el que las caras eran booleanas y el
     * estado vivía solo en la pieza: un `true` heredaba el estado del diente. Así
     * un odontograma guardado antes del rediseño se sigue leyendo igual.
     */
    const caraEstado = (v, estadoPieza) => {
      if (v === true || v === 'true') {
        // Una cara marcada en el formato viejo solo puede heredar el estado de su
        // pieza si ese estado es de cara. Si no lo es (extracción indicada,
        // ausente, corona…), NO se inventa nada: esto es una historia clínica y
        // rellenarla con "caries" sería escribir un diagnóstico que nadie puso.
        // La cara queda sin estado; el símbolo de la pieza se conserva aparte.
        return ODONTOGRAMA_ESTADOS_CARA_KEYS.includes(estadoPieza) ? estadoPieza : '';
      }
      if (v === false || v === 'false') return '';
      // `marcaValida` y no un `includes` a secas: la marca puede traer pegado el
      // color que eligió el odontólogo ('caries:azul'), y ese texto no figura en
      // la lista blanca de claves. Sin esto el servidor tiraba la marca EN
      // SILENCIO y el odontólogo creía que la había guardado.
      return marcaValida(v, ODONTOGRAMA_ESTADOS_CARA_KEYS);
    };

    const sanitizeOdontologia = (o) => {
      if (!o || typeof o !== 'object') return undefined;
      const dientes = (Array.isArray(o.odontograma) ? o.odontograma : [])
        .filter((d) => d && ODONTOGRAMA_PIEZAS.includes(String(d.diente)))
        .map((d) => {
          const caras = d.caras || {};
          const estado = marcaValida(d.estado, ODONTOGRAMA_ESTADOS_KEYS);
          return {
            diente: String(d.diente),
            estado,
            caras: {
              vestibular: caraEstado(caras.vestibular, estado),
              lingual: caraEstado(caras.lingual, estado),
              mesial: caraEstado(caras.mesial, estado),
              distal: caraEstado(caras.distal, estado),
              oclusal: caraEstado(caras.oclusal, estado),
            },
            recesion: pick(d.recesion, ODONTOGRAMA_GRADOS),
            movilidad: pick(d.movilidad, ODONTOGRAMA_GRADOS),
            nota: txt(d.nota),
          };
        })
        // Una pieza sin nada marcado no aporta nada: no se guarda.
        .filter((d) => d.estado || d.nota || d.recesion || d.movilidad || Object.values(d.caras).some(Boolean));
      // Una misma pieza no puede ir dos veces: gana la última marca recibida.
      const porDiente = new Map(dientes.map((d) => [d.diente, d]));

      // Sección 7: una fila por sextante, y la pieza tiene que ser una de las tres
      // que la hoja ofrece para ese sextante.
      const higiene = (Array.isArray(o.higieneOral) ? o.higieneOral : [])
        .map((f) => {
          const def = HIGIENE_ORAL_FILAS.find((x) => x.key === String(f?.fila));
          if (!def) return null;
          return {
            fila: def.key,
            pieza: pick(f.pieza, def.piezas),
            placa: pick(f.placa, HIGIENE_ORAL_INDICES[0].valores),
            calculo: pick(f.calculo, HIGIENE_ORAL_INDICES[1].valores),
            gingivitis: pick(f.gingivitis, HIGIENE_ORAL_INDICES[2].valores),
          };
        })
        .filter((f) => f && (f.pieza || f.placa || f.calculo || f.gingivitis));
      const porFila = new Map(higiene.map((f) => [f.fila, f]));

      // Los índices CPO/ceo son conteos de piezas: enteros de 0 a 52. Se valida
      // con expresión regular y no con parseInt, que aceptaba '3.9' como 3 y
      // '5abc' como 5: un conteo mal tecleado se guardaba distinto y en silencio.
      const conteo = (v) => {
        const s = String(v ?? '').trim();
        if (!/^\d{1,2}$/.test(s)) return '';
        const n = Number(s);
        return n <= ODONTOGRAMA_PIEZAS.length ? String(n) : '';
      };
      const cpo = o.cpo || {};
      const ceo = o.ceo || {};

      return {
        odontograma: ODONTOGRAMA_PIEZAS.filter((p) => porDiente.has(p)).map((p) => porDiente.get(p)),
        higieneOral: HIGIENE_ORAL_FILAS_KEYS.filter((k) => porFila.has(k)).map((k) => porFila.get(k)),
        enfermedadPeriodontal: pick(o.enfermedadPeriodontal, ENFERMEDAD_PERIODONTAL_KEYS),
        maloclusion: pick(o.maloclusion, MALOCLUSION_KEYS),
        fluorosis: pick(o.fluorosis, FLUOROSIS_KEYS),
        cpo: { c: conteo(cpo.c), p: conteo(cpo.p), o: conteo(cpo.o) },
        ceo: { c: conteo(ceo.c), e: conteo(ceo.e), o: conteo(ceo.o) },
        observaciones: txt(o.observaciones),
      };
    };

    const sanitizeCosmetologia = (c) => {
      if (!c || typeof c !== 'object') return undefined;
      const de = c.datosEsteticos || {};
      const ev = c.evaluacion || {};
      const hi = c.higiene || {};
      const ca = c.cabello || {};
      const tr = ca.tratamientos || {};
      const cc = c.cueroCabelludo || {};
      const pr = c.procedimiento || {};
      const hiperKeys = COSMETOLOGIA_HIPERPIGMENTACION.map((z) => z.key);
      const optionsOf = (catalog, key) => catalog.find((f) => f.key === key)?.options || [];
      return {
        datosEsteticos: {
          tratamientosEsteticos: txt(de.tratamientosEsteticos),
          autotratamientos: txt(de.autotratamientos),
          cosmeticosUsoActual: txt(de.cosmeticosUsoActual),
        },
        evaluacion: {
          fototipo: pick(ev.fototipo, COSMETOLOGIA_FOTOTIPOS),
          glogau: pick(ev.glogau, COSMETOLOGIA_GLOGAU),
          rosacea: pick(ev.rosacea, COSMETOLOGIA_ROSACEA),
          biotipo: checksIn(ev.biotipo, COSMETOLOGIA_BIOTIPOS_KEYS),
          arrugas: checksIn(ev.arrugas, COSMETOLOGIA_ARRUGAS_KEYS),
          acne: checksIn(ev.acne, COSMETOLOGIA_ACNE_KEYS),
          lesionesElementales: checksIn(ev.lesionesElementales, COSMETOLOGIA_LESIONES_KEYS),
          hiperpigmentaciones: (Array.isArray(ev.hiperpigmentaciones) ? ev.hiperpigmentaciones : [])
            .filter((z) => z && hiperKeys.includes(z.key))
            .map((z) => ({
              key: String(z.key),
              marked: !!z.marked,
              derecho: !!z.derecho,
              izquierdo: !!z.izquierdo,
            }))
            .filter((z) => z.marked || z.derecho || z.izquierdo),
          deshidratacionFacial: pick(ev.deshidratacionFacial, COSMETOLOGIA_DESHIDRATACION),
          bioestimulacion: txt(ev.bioestimulacion),
          nutricionDermica: txt(ev.nutricionDermica),
          observaciones: txt(ev.observaciones),
        },
        higiene: {
          frecuenciaLavado: txt(hi.frecuenciaLavado),
          shampoo: txt(hi.shampoo),
          acondicionador: txt(hi.acondicionador),
          otros: txt(hi.otros),
        },
        cabello: {
          longitud: pick(ca.longitud, optionsOf(COSMETOLOGIA_CABELLO, 'longitud')),
          forma: pick(ca.forma, optionsOf(COSMETOLOGIA_CABELLO, 'forma')),
          calibre: pick(ca.calibre, optionsOf(COSMETOLOGIA_CABELLO, 'calibre')),
          densidad: pick(ca.densidad, optionsOf(COSMETOLOGIA_CABELLO, 'densidad')),
          elasticidad: pick(ca.elasticidad, optionsOf(COSMETOLOGIA_CABELLO, 'elasticidad')),
          color: pick(ca.color, optionsOf(COSMETOLOGIA_CABELLO, 'color')),
          tratamientos: {
            alisados: !!tr.alisados,
            planchas: !!tr.planchas,
            secadores: !!tr.secadores,
          },
        },
        cueroCabelludo: {
          tipo: pick(cc.tipo, optionsOf(COSMETOLOGIA_CUERO_CABELLUDO, 'tipo')),
          glandulaSebacea: pick(cc.glandulaSebacea, optionsOf(COSMETOLOGIA_CUERO_CABELLUDO, 'glandulaSebacea')),
          sensibilidad: pick(cc.sensibilidad, optionsOf(COSMETOLOGIA_CUERO_CABELLUDO, 'sensibilidad')),
          movilidad: pick(cc.movilidad, optionsOf(COSMETOLOGIA_CUERO_CABELLUDO, 'movilidad')),
        },
        fibraCapilar: checksIn(c.fibraCapilar, COSMETOLOGIA_FIBRA_CAPILAR_KEYS),
        afeccionesCuero: checksIn(c.afeccionesCuero, COSMETOLOGIA_AFECCIONES_CUERO_KEYS),
        procedimiento: {
          procedimiento: txt(pr.procedimiento),
          productos: txt(pr.productos),
          apoyoDomiciliario: txt(pr.apoyoDomiciliario),
        },
      };
    };

    if (!descripcion && !req.body.motivoConsulta) {
      return res.status(400).json({ message: 'El motivo de consulta es requerido' });
    }

    // El motivo de consulta es el ÚNICO campo obligatorio de un seguimiento.
    // Antes también se exigía al menos un ítem en Receta o Derivaciones, y eso
    // impedía registrar consultas en las que no se receta ni se deriva nada
    // (un control, una revisión de resultados): obligaba a inventarse una línea.
    //
    // Las dos listas se unifican porque el modelo las guarda juntas en
    // `recetaItems`; lo que las distingue después es la marca `isService`.
    // `fromDerivacion` la conserva: sin producto de inventario del que deducir la
    // categoría, es lo único que dice que esa línea era una derivación — y de ella
    // dependen el historial, el PDF de la receta y la hoja MSP, que separan
    // «Receta» de «Derivaciones» por ese booleano.
    const itemsRaw = [
      ...(Array.isArray(recetaItems) ? recetaItems : []).map((it) => ({ ...it, fromDerivacion: false })),
      ...(Array.isArray(derivacionItems) ? derivacionItems : []).map((it) => ({ ...it, fromDerivacion: true })),
    ];

    // --- Hidratar recetaItems con snapshot de nombre/categoría y marcar servicios ---
    // Se descartan filas totalmente vacías. Un ítem manual (medicamento que la
    // clínica no vende) llega sin `product` pero con `name`, y es válido.
    const items = itemsRaw.filter((it) => it.product || (it.name && it.name.trim()));
    const productIds = items.map((it) => it.product).filter(Boolean);
    let productsById = {};
    if (productIds.length) {
      const prods = await Product.find({ _id: { $in: productIds }, clinic: req.clinicId });
      productsById = prods.reduce((acc, p) => {
        acc[String(p._id)] = p;
        return acc;
      }, {});
    }
    const hydratedItems = items.map((it) => {
      const p = it.product ? productsById[String(it.product)] : null;
      // Con producto manda su categoría (comportamiento de siempre); sin él,
      // manda de qué lista vino. Ver el comentario de `fromDerivacion` arriba.
      const isService = p ? ['servicio', 'programa'].includes(p.category) : Boolean(it.fromDerivacion);
      // Suero: lo marca el doctor a mano en la receta. Solo tiene sentido en la
      // receta, no en las derivaciones — un servicio no se "administra" por
      // dosis, se agenda.
      const isSerum = !isService && Boolean(it.isSerum);
      // La composición solo se guarda si la línea ES un suero: desmarcar la
      // casilla tiene que dejar la línea limpia, no un medicamento arrastrando
      // media bolsa de cloruro invisible.
      const { serumBase, serumComponents } = isSerum
        ? saneaComposicionSuero(it)
        : { serumBase: { name: '', volumeMl: null }, serumComponents: [] };
      const isComposite = Boolean(p?.isComposite);
      // Componentes elegidos por el doctor para un item compuesto.
      let componentsUsed = [];
      if (isComposite && Array.isArray(it.componentsUsed)) {
        const allowed = new Set((p.components || []).map((c) => String(c.product)));
        componentsUsed = it.componentsUsed
          .filter((c) => c.product && allowed.has(String(c.product)) && Number(c.quantity) > 0)
          .map((c) => ({ product: c.product, name: c.name || '', quantity: Number(c.quantity) }));
      }
      return {
        product: it.product || undefined,
        name: it.name || p?.name || '',
        quantity: Number(it.quantity || 1),
        dose: it.dose || '',
        frequency: it.frequency || '',
        duration: it.duration || '',
        instructions: it.instructions || '',
        isService: Boolean(isService),
        isSerum,
        serumBase,
        serumComponents,
        administrations: [],
        isComposite,
        componentsUsed,
      };
    });

    // Descontar del inventario los componentes de los items compuestos recetados.
    try {
      const InventoryMovement = require('../models/InventoryMovement');
      for (const it of hydratedItems) {
        if (!it.isComposite || !it.componentsUsed.length) continue;
        for (const comp of it.componentsUsed) {
          const compProduct = await Product.findOne({ _id: comp.product, clinic: req.clinicId });
          if (!compProduct || compProduct.unlimited) continue;
          const qty = comp.quantity * Number(it.quantity || 1);
          compProduct.stock = Math.max(0, (compProduct.stock || 0) - qty);
          await compProduct.save();
          await InventoryMovement.create({
            clinic: req.clinicId,
            product: comp.product,
            type: 'salida',
            quantity: qty,
            balanceAfter: compProduct.stock,
            reason: `Componente de ${it.name} (receta)`,
            createdBy: req.user._id,
          });
        }
      }
    } catch (e) {
      console.warn('No se pudo descontar componentes del inventario:', e.message);
    }

    // --- Crear automáticamente un Tratamiento si la receta tiene items de tipo servicio/programa ---
    let autoTreatmentId = treatment || null;
    const serviceItems = hydratedItems.filter((it) => it.isService && it.product);
    if (!autoTreatmentId && serviceItems.length > 0) {
      try {
        const newT = await Treatment.create({
          clinic: req.clinicId,
          patient: patientId,
          name: `Tratamiento desde receta — ${new Date().toLocaleDateString('es-EC')}`,
          status: 'activo',
          items: serviceItems.map((it) => ({
            product: it.product,
            name: it.name,
            quantity: it.quantity,
            completed: 0,
            completionRefs: [],
          })),
          createdBy: req.user._id,
          lastActivityAt: new Date(),
        });
        autoTreatmentId = newT._id;
        emitToClinic(req.clinicId, 'treatment:created', newT);
      } catch (e) {
        console.warn('No se pudo crear tratamiento automático:', e.message);
      }
    }

    const record = await ClinicalRecord.findOneAndUpdate(
      { clinic: req.clinicId, patient: patientId },
      {
        $push: {
          followUps: {
            fecha: fecha ? new Date(fecha) : new Date(),
            descripcion: descripcion || req.body.motivoConsulta || '',
            motivoConsulta: req.body.motivoConsulta || descripcion || '',
            recomendaciones: recomendaciones || estudioSintomas || '',
            estudioSintomas: estudioSintomas || recomendaciones || '',
            receta: receta || '',
            recetaItems: hydratedItems,
            observaciones: observaciones || '',
            vitalSigns: vitalSigns && typeof vitalSigns === 'object' ? {
              hora: vitalSigns.hora || '',
              temperature: vitalSigns.temperature ?? null,
              bloodPressure: vitalSigns.bloodPressure || '',
              heartRate: vitalSigns.heartRate ?? null,
              respiratoryRate: vitalSigns.respiratoryRate ?? null,
              oxygenSaturation: vitalSigns.oxygenSaturation ?? null,
              weight: vitalSigns.weight ?? null,
              height: vitalSigns.height ?? null,
              abdominalPerimeter: vitalSigns.abdominalPerimeter ?? null,
              capillaryHemoglobin: vitalSigns.capillaryHemoglobin ?? null,
              glucose: vitalSigns.glucose ?? null,
            } : undefined,
            // Secciones MSP (B, E, G, H, I, J).
            tipoConsulta: ['primera', 'subsecuente'].includes(tipoConsulta) ? tipoConsulta : '',
            enfermedadActual: String(enfermedadActual || '').trim(),
            revisionSistemas: sanitizeChecks(revisionSistemas),
            revisionSistemasHallazgos: String(revisionSistemasHallazgos || '').trim(),
            examenFisico: sanitizeExamen(examenFisico),
            diagnosticos: sanitizeDiagnosticos(diagnosticos),
            planTratamiento: String(planTratamiento || '').trim(),
            recomendacionesNoFarmacologicas: String(recomendacionesNoFarmacologicas || '').trim(),
            evolucion: String(evolucion || '').trim(),
            treatment: autoTreatmentId,
            autoTreatmentCreated: autoTreatmentId && !treatment ? autoTreatmentId : undefined,
            opticaRx: opticaRx && typeof opticaRx === 'object' ? opticaRx : undefined,
            ginecologia: sanitizeGineco(ginecologia),
            podologia: sanitizePodologia(podologia),
            odontologia: sanitizeOdontologia(odontologia),
            cosmetologia: sanitizeCosmetologia(cosmetologia),
            cardiologia: sanitizeCardiologia(cardiologia),
            valor: valor || 0,
            metodoPago: metodoPago || 'efectivo',
            createdBy: req.user._id,
          },
        },
        $setOnInsert: { createdBy: req.user._id },
      },
      { new: true, upsert: false }
    );

    if (!record) {
      return res
        .status(404)
        .json({ message: 'Primero debe crear la ficha clínica del paciente' });
    }

    /**
     * AVANCE DE TURNO. Una cita puede pasar por varios profesionales: guardar el
     * seguimiento ya NO la cierra sin más, cierra EL TURNO de quien lo escribió.
     * Si detrás hay otro, la cita pasa a sus manos y sigue abierta; solo el
     * último la da por completada.
     */
    let siguienteTurno = null;
    // La cita que se registró sola, si la consulta llegó sin ninguna. La
    // pantalla la usa para decirlo: si no, quien atiende no sabe que quedó
    // registrada y acaba creándola otra vez a mano.
    let citaAutomatica = null;
    if (req.body.appointmentId) {
      try {
        const Appointment = require('../models/Appointment');
        const { completarTurno } = require('../utils/appointmentTurns');
        const apt = await Appointment.findOne({
          _id: req.body.appointmentId,
          clinic: req.clinicId,
        });
        if (apt && ['asistida', 'pendiente', 'confirmada'].includes(apt.status)) {
          const nuevoFu = (record.followUps || []).slice(-1)[0];
          const { siguiente, terminado } = completarTurno(apt, {
            userId: req.user._id,
            followUpId: nuevoFu?._id,
          });
          // Sin turnos (cita anterior al cambio, o asignada a la antigua) se
          // comporta como siempre: un seguimiento la cierra.
          if (terminado || !apt.turns?.length) {
            apt.status = 'completada';
            apt.consultationEndedAt = new Date();
          }
          await apt.save();
          emitToClinic(req.clinicId, 'appointment:updated', apt);

          if (siguiente?.user) {
            // Con el nombre resuelto: la pantalla dice "pasa al Dr. X" en vez de
            // un id, y quien acaba de atender sabe a quién le deja el paciente.
            const User = require('../models/User');
            const quien = await User.findById(siguiente.user).select('name').lean().catch(() => null);
            siguienteTurno = { kind: siguiente.kind, user: { _id: siguiente.user, name: quien?.name || '' } };
            // Al siguiente le llega la cita ahora: aviso en su pantalla y en su móvil.
            emitToUser(siguiente.user, 'appointment:assigned', apt);
            const { notificarUsuarios } = require('../utils/pushNotifications');
            await notificarUsuarios([siguiente.user], {
              clinicId: req.clinicId,
              type: 'appointment_assigned',
              title: 'Te toca atender',
              body: 'El profesional anterior terminó su parte de la consulta.',
              url: `/patients/${patientId}?tab=seguimientos&appointment=${apt._id}`,
            }).catch(() => {});
          } else if (siguiente) {
            // Turno de enfermería sin dueño: sale a la bandeja de todos, y les
            // llega al móvil igual que si recepción se la hubiera mandado
            // directa — hasta ahora solo se enteraban con la pestaña abierta.
            siguienteTurno = { kind: 'enfermeria', user: null };
            emitToRole(req.clinicId, 'enfermero', 'appointment:assigned', apt);
            const { notificarRol } = require('../utils/pushNotifications');
            await notificarRol(req.clinicId, 'enfermero', {
              type: 'appointment_nursing',
              title: 'Cita para enfermería',
              body: 'El doctor terminó su parte de la consulta.',
              url: '/appointments',
            }).catch(() => {});
          }
        }
      } catch (e) {
        console.warn('No se pudo avanzar el turno de la cita:', e.message);
      }
    } else if (isDoctorRole(req.role)) {
      /**
       * SEGUIMIENTO SIN CITA: se registra la cita SOLA, al guardar.
       *
       * En óptica el cliente entra por la puerta sin haber llamado a nadie. Lo
       * mismo pasa con cualquier especialidad cuando alguien llega de imprevisto.
       * Hasta ahora la consulta se escribía igual —el seguimiento se guardaba
       * sin más— pero la cita nunca existía, y con ella se perdía TODO lo que
       * cuelga de la cita: la atención no salía en la agenda del día, ni en los
       * reportes, ni devengaba comisión, ni contaba para «paciente nuevo», ni
       * había de dónde cobrarla. Una consulta real que el sistema no vio.
       *
       * Se crea CERRADA porque el trabajo ya está hecho: el seguimiento que
       * acaba de guardarse ES la atención. Dejarla abierta pondría una cita
       * fantasma en la agenda de quien acaba de terminar.
       *
       * Solo para roles que ATIENDEN. Un admin o un cajero también pueden
       * escribir un seguimiento, pero ahí están documentando por otro: crearles
       * una cita les metería pacientes en sus dashboards y comisiones.
       *
       * Y en su propio try: si esto falla, el seguimiento ya está guardado y no
       * se puede perder por no haber podido registrar la cita.
       */
      try {
        const Appointment = require('../models/Appointment');
        const { crearCitaAtencionInmediata } = require('../utils/walkInAppointment');
        const nuevoFu = (record.followUps || []).slice(-1)[0];
        const apt = await crearCitaAtencionInmediata({
          Appointment,
          clinicId: req.clinicId,
          patientId,
          user: req.user,
          role: req.role,
          estado: 'cerrada',
          followUpId: nuevoFu?._id,
        });
        citaAutomatica = { _id: apt._id, startTime: apt.startTime, isFirstVisit: apt.isFirstVisit };
        emitToClinic(req.clinicId, 'appointment:created', apt);
      } catch (e) {
        console.warn('No se pudo registrar la cita de la atención sin cita:', e.message);
      }
    }

    emitToClinic(req.clinicId, 'clinicalRecord:updated', { patient: patientId });
    // `nextTurn` deja que la pantalla diga "pasa al Dr. X" en vez de dar la cita
    // por terminada cuando no lo está. `autoAppointment` avisa de la cita que se
    // registró sola cuando la consulta llegó sin ninguna.
    const extra = {};
    if (siguienteTurno) extra.nextTurn = siguienteTurno;
    if (citaAutomatica) extra.autoAppointment = citaAutomatica;
    res.status(201).json(Object.keys(extra).length ? { ...record.toObject(), ...extra } : record);
  } catch (error) {
    res.status(500).json({ message: 'Error al agregar seguimiento', error: error.message });
  }
};

/**
 * ADMINISTRAR UNA DOSIS de un ítem marcado como suero.
 *
 * El doctor receta "7 sueros" y enfermería los va poniendo en días distintos.
 * Cada aplicación se anota aquí, con quién y cuándo, y de ahí sale el "3 de 7,
 * faltan 4" que se ve en la receta. Antes esa cuenta se llevaba de memoria o en
 * un papel, que es como se ponía uno de más o se dejaba de poner el último.
 *
 * NO se puede pasar de lo recetado: si el paciente necesita más, hace falta otra
 * receta del médico. Esa es justamente la línea que un contador libre borraría.
 */
exports.administerSerum = async (req, res) => {
  try {
    const { patientId, followUpId, itemId } = req.params;

    const record = await ClinicalRecord.findOne({ clinic: req.clinicId, patient: patientId });
    if (!record) return res.status(404).json({ message: 'Ficha no encontrada' });

    const fu = record.followUps.id(followUpId);
    if (!fu) return res.status(404).json({ message: 'Seguimiento no encontrado' });

    const item = (fu.recetaItems || []).id(itemId);
    if (!item) return res.status(404).json({ message: 'Ítem de receta no encontrado' });
    if (!item.isSerum) {
      return res.status(400).json({ message: 'Este ítem no está marcado como suero' });
    }

    const recetados = Math.max(0, Number(item.quantity) || 0);
    const puestos = (item.administrations || []).length;
    if (recetados && puestos >= recetados) {
      return res.status(409).json({
        message: `Ya se administraron los ${recetados} que recetó el doctor. Hace falta una receta nueva.`,
        code: 'SERUM_COMPLETE',
      });
    }

    // El nombre se busca si la sesión no lo trae: este snapshot es lo único que
    // quedará el día que esa persona salga de la clínica, y una aplicación sin
    // responsable es un registro clínico a medias.
    let nombre = req.user.name || '';
    if (!nombre) {
      const User = require('../models/User');
      nombre = (await User.findById(req.user._id).select('name').lean().catch(() => null))?.name || '';
    }

    // Qué se pone en ESTA dosis. Enfermería puede desmarcar una ampolla que el
    // paciente rechaza: se aplica el resto, queda constancia de la omitida y del
    // inventario sale solo lo aplicado.
    const componentes = cruzaComponentesAplicados(item.serumComponents, req.body?.components);
    const volumenPedido = Number(req.body?.baseVolumeMl);
    const baseVolumeMl = SUERO_CLORURO_VOLUMENES.includes(volumenPedido)
      ? volumenPedido
      : item.serumBase?.volumeMl ?? null;

    /**
     * RECLAMO ATÓMICO DE LA DOSIS.
     *
     * El tope («no más de lo recetado») no puede vivir en un `if` sobre un
     * documento leído hace un instante: con un doble clic —o dos enfermeros a la
     * vez— las dos peticiones ven `puestos = 0 < recetados = 1`, las dos
     * empujan su dosis y el paciente acaba con dos sueros de una receta de uno,
     * con doble descuento de inventario.
     *
     * `$size` en el arrayFilter es un compare-and-set: solo entra quien ve el
     * array EXACTAMENTE como lo leyó. La segunda petición no modifica nada.
     */
    const mongoose = require('mongoose');
    const dosisId = new mongoose.Types.ObjectId();
    const dosis = {
      _id: dosisId,
      at: new Date(),
      by: req.user._id,
      byName: nombre,
      note: String(req.body?.note || '').trim(),
      baseVolumeMl,
      components: componentes,
      // El inventario se mueve DESPUÉS de que la dosis esté guardada; aquí no se
      // sabe todavía qué salió.
      stockMoves: [],
    };

    const tras = await ClinicalRecord.findOneAndUpdate(
      { _id: record._id, clinic: req.clinicId },
      { $push: { 'followUps.$[fu].recetaItems.$[it].administrations': dosis } },
      {
        new: true,
        arrayFilters: [
          { 'fu._id': fu._id },
          { 'it._id': item._id, 'it.administrations': { $size: puestos } },
        ],
      },
    );
    /**
     * Se comprueba en el DOCUMENTO, no en `modifiedCount`.
     *
     * Cuando el arrayFilter no casa, Mongo no escribe nada pero igual informa
     * `modifiedCount: 1` (el documento sí casó). Fiarse de ese número daba por
     * buena la segunda dosis de una carrera. Como el `_id` de la dosis lo
     * generamos aquí y es único, encontrarlo dentro es la prueba de que entró
     * ESTA y no la del vecino.
     */
    const entro = (tras?.followUps?.id(fu._id)?.recetaItems?.id(item._id)?.administrations || [])
      .some((a) => String(a._id) === String(dosisId));
    if (!entro) {
      return res.status(409).json({
        message: 'Alguien registró esta aplicación al mismo tiempo. Vuelve a mirar la receta antes de repetirla.',
        code: 'SERUM_RACE',
      });
    }

    /**
     * El inventario se mueve AHORA, con la dosis ya guardada.
     *
     * Antes se descontaba primero: si fallaba el guardado, las ampollas salían
     * del stock sin que quedara ninguna dosis en la ficha, y el reintento las
     * volvía a descontar. Al revés, lo peor que puede pasar es una dosis con
     * `stockMoves` vacío —visible, y deshacerla no devuelve nada de más—.
     */
    const stockMoves = await descontarComponentesSuero({
      clinicId: req.clinicId,
      userId: req.user._id,
      aplicados: componentes,
      itemName: item.name,
      recordId: record._id,
    });
    if (stockMoves.length) {
      await ClinicalRecord.updateOne(
        { _id: record._id },
        { $set: { 'followUps.$[fu].recetaItems.$[it].administrations.$[ad].stockMoves': stockMoves } },
        {
          arrayFilters: [{ 'fu._id': fu._id }, { 'it._id': item._id }, { 'ad._id': dosisId }],
        },
      ).catch((e) => console.warn('No se pudo anotar el movimiento de stock en la dosis:', e.message));
    }

    const fresco = await ClinicalRecord.findById(record._id);
    emitToClinic(req.clinicId, 'clinicalRecord:updated', { patient: patientId });
    res.json(hideContactData(fresco, req));
  } catch (error) {
    res.status(500).json({ message: 'Error al registrar la administración', error: error.message });
  }
};

/**
 * Deshace la ÚLTIMA aplicación registrada de un suero.
 *
 * Existe porque un clic de más en un registro clínico no puede ser irreversible:
 * sin esto, la única salida sería dejar constancia de una dosis que nunca se
 * puso. La borra quien la registró, o un administrador.
 */
exports.undoSerumAdministration = async (req, res) => {
  try {
    const { patientId, followUpId, itemId } = req.params;

    const record = await ClinicalRecord.findOne({ clinic: req.clinicId, patient: patientId });
    if (!record) return res.status(404).json({ message: 'Ficha no encontrada' });

    const fu = record.followUps.id(followUpId);
    if (!fu) return res.status(404).json({ message: 'Seguimiento no encontrado' });
    const item = (fu.recetaItems || []).id(itemId);
    if (!item) return res.status(404).json({ message: 'Ítem de receta no encontrado' });

    const ultima = (item.administrations || [])[item.administrations.length - 1];
    if (!ultima) return res.status(400).json({ message: 'No hay ninguna administración que deshacer' });

    const esAdmin = req.user.isSuperAdmin || req.role === 'admin';
    if (!esAdmin && String(ultima.by) !== String(req.user._id)) {
      return res.status(403).json({ message: 'Solo quien la registró (o un administrador) puede deshacerla' });
    }

    /**
     * PRIMERO SE QUITA LA DOSIS, Y SOLO SI SE QUITÓ SE DEVUELVE EL STOCK.
     *
     * El `$pull` por `_id` es el candado: de dos peticiones simultáneas —o de
     * dos clics en «Deshacer la última», que no espera respuesta— solo UNA
     * encuentra la dosis y la borra; la otra no modifica nada y se corta aquí.
     * Al revés (devolver y luego borrar) las dos devolvían el mismo stockMoves y
     * la percha acababa con ampollas que nunca salieron.
     */
    const antes = await ClinicalRecord.findOneAndUpdate(
      { _id: record._id, clinic: req.clinicId },
      { $pull: { 'followUps.$[fu].recetaItems.$[it].administrations': { _id: ultima._id } } },
      // `new: false` a propósito: interesa la foto de ANTES. `findOneAndUpdate`
      // es atómico, así que de dos peticiones a la vez solo la primera ve la
      // dosis todavía puesta; la segunda recibe el documento ya sin ella. Esa
      // diferencia es el candado. (`modifiedCount` no sirve: informa 1 aunque no
      // se haya quitado nada.)
      { new: false, arrayFilters: [{ 'fu._id': fu._id }, { 'it._id': item._id }] },
    );
    const laQuitéYo = (antes?.followUps?.id(fu._id)?.recetaItems?.id(item._id)?.administrations || [])
      .some((a) => String(a._id) === String(ultima._id));
    if (!laQuitéYo) {
      return res.status(409).json({
        message: 'Esa aplicación ya se había deshecho.',
        code: 'SERUM_UNDO_RACE',
      });
    }

    await devolverComponentesSuero({
      clinicId: req.clinicId,
      userId: req.user._id,
      movimientos: ultima.stockMoves,
      itemName: item.name,
      recordId: record._id,
    });

    // Se relee: `record` es la foto de ANTES del $pull y devolverla dejaría la
    // pantalla enseñando la dosis que se acaba de borrar.
    const fresco = await ClinicalRecord.findById(record._id);

    emitToClinic(req.clinicId, 'clinicalRecord:updated', { patient: patientId });
    res.json(hideContactData(fresco, req));
  } catch (error) {
    res.status(500).json({ message: 'Error al deshacer la administración', error: error.message });
  }
};

exports.deleteFollowUp = async (req, res) => {
  try {
    const { patientId, followUpId } = req.params;

    const record = await ClinicalRecord.findOneAndUpdate(
      { clinic: req.clinicId, patient: patientId },
      { $pull: { followUps: { _id: followUpId } } },
      { new: true }
    );

    if (!record) return res.status(404).json({ message: 'Ficha no encontrada' });
    emitToClinic(req.clinicId, 'clinicalRecord:updated', { patient: patientId });
    res.json(record);
  } catch (error) {
    res.status(500).json({ message: 'Error al eliminar seguimiento' });
  }
};

/**
 * Sube un adjunto PDF a un seguimiento específico.
 * Espera multipart/form-data con campo "file" (single).
 */
exports.uploadFollowUpAttachment = async (req, res) => {
  try {
    const { patientId, followUpId } = req.params;
    if (!req.file) return res.status(400).json({ message: 'No se recibió archivo' });

    const record = await ClinicalRecord.findOne({
      clinic: req.clinicId,
      patient: patientId,
    });
    if (!record) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      return res.status(404).json({ message: 'Ficha clínica no encontrada' });
    }
    const fu = record.followUps.id(followUpId);
    if (!fu) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      return res.status(404).json({ message: 'Seguimiento no encontrado' });
    }

    const attachment = {
      filename: req.file.filename,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      uploadedAt: new Date(),
      uploadedBy: req.user._id,
    };
    fu.attachments.push(attachment);
    await record.save();

    const saved = fu.attachments[fu.attachments.length - 1];
    res.status(201).json({ message: 'Archivo subido', attachment: saved });
  } catch (error) {
    if (req.file) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
    }
    res.status(500).json({ message: 'Error al subir archivo', error: error.message });
  }
};

/**
 * Descarga un adjunto PDF de un seguimiento.
 */
exports.downloadFollowUpAttachment = async (req, res) => {
  try {
    const { patientId, followUpId, attachmentId } = req.params;
    const record = await ClinicalRecord.findOne({
      clinic: req.clinicId,
      patient: patientId,
    });
    if (!record) return res.status(404).json({ message: 'Ficha no encontrada' });
    const fu = record.followUps.id(followUpId);
    if (!fu) return res.status(404).json({ message: 'Seguimiento no encontrado' });
    const att = fu.attachments.id(attachmentId);
    if (!att) return res.status(404).json({ message: 'Archivo no encontrado' });

    const filePath = path.join(FOLLOWUPS_DIR, String(req.clinicId), att.filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: 'Archivo no existe en disco' });
    }
    res.setHeader('Content-Type', att.mimeType || 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(att.originalName)}"`
    );
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    res.status(500).json({ message: 'Error al descargar archivo', error: error.message });
  }
};

/**
 * Elimina un adjunto PDF de un seguimiento.
 */
exports.deleteFollowUpAttachment = async (req, res) => {
  try {
    const { patientId, followUpId, attachmentId } = req.params;
    const record = await ClinicalRecord.findOne({
      clinic: req.clinicId,
      patient: patientId,
    });
    if (!record) return res.status(404).json({ message: 'Ficha no encontrada' });
    const fu = record.followUps.id(followUpId);
    if (!fu) return res.status(404).json({ message: 'Seguimiento no encontrado' });
    const att = fu.attachments.id(attachmentId);
    if (!att) return res.status(404).json({ message: 'Archivo no encontrado' });

    const filePath = path.join(FOLLOWUPS_DIR, String(req.clinicId), att.filename);
    try { fs.unlinkSync(filePath); } catch (_) {}
    att.deleteOne();
    await record.save();
    res.json({ message: 'Archivo eliminado' });
  } catch (error) {
    res.status(500).json({ message: 'Error al eliminar archivo', error: error.message });
  }
};

/**
 * Genera un PDF imprimible del seguimiento (receta, estudio/síntomas, observaciones,
 * tratamiento asociado) listo para entregar al paciente.
 */
exports.printFollowUp = async (req, res) => {
  try {
    const { patientId, followUpId } = req.params;
    const record = await ClinicalRecord.findOne({
      clinic: req.clinicId,
      patient: patientId,
    }).populate('followUps.createdBy', 'name specialty email signatureCert');
    if (!record) return res.status(404).json({ message: 'Ficha no encontrada' });

    const fu = record.followUps.id(followUpId);
    if (!fu) return res.status(404).json({ message: 'Seguimiento no encontrado' });

    const patient = await Patient.findById(patientId);
    const Clinic = require('../models/Clinic');
    const clinic = await Clinic.findById(req.clinicId);
    // Quien firma es EL AUTOR de la consulta, no quien pulsa imprimir: la receta
    // es del médico que atendió, aunque el PDF lo saque recepción.
    const autor = fu.createdBy || null;

    // Fecha en dd/mm/aaaa. Ver `fechaDocumento`: el día se lee en UTC porque
    // guardado como medianoche UTC, en Ecuador sería el día anterior.
    const fmtDate = fechaDocumento(fu.fecha);
    // Los signos vitales NO se imprimen aquí: ver el comentario del cuerpo del
    // documento. Van en la hoja MSP, que es la de la consulta.
    // Receta óptica
    const rxOd = fu.opticaRx?.od || {};
    const rxOi = fu.opticaRx?.oi || {};
    const hasOptica = ['sph','cyl','ax','add','dnp','alt'].some((c) => (rxOd[c] || rxOi[c]));
    const opticaHtml = hasOptica ? `
      <div class="label" style="margin-top:8px">Receta óptica (RX)</div>
      <table>
        <thead><tr><th>RX</th><th>SPH</th><th>CYL</th><th>AX</th><th>ADD</th><th>DNP</th><th>ALT</th></tr></thead>
        <tbody>
          <tr><td style="padding:6px 8px;border:1px solid #e2e8f0"><b>OD</b></td>
            ${['sph','cyl','ax','add','dnp','alt'].map((c) => `<td style="padding:6px 8px;border:1px solid #e2e8f0">${rxOd[c] || '—'}</td>`).join('')}
          </tr>
          <tr><td style="padding:6px 8px;border:1px solid #e2e8f0"><b>OI</b></td>
            ${['sph','cyl','ax','add','dnp','alt'].map((c) => `<td style="padding:6px 8px;border:1px solid #e2e8f0">${rxOi[c] || '—'}</td>`).join('')}
          </tr>
        </tbody>
      </table>` : '';
    // Los ítems se guardan juntos en recetaItems; se separan por `isService`
    // (servicios/programas = Derivaciones, el resto = Receta de insumos).
    //
    // `celda` ESCAPA el texto. Desde que la receta se escribe a mano (antes los
    // nombres venían del catálogo de productos), el médico puede teclear
    // "Ibuprofeno <400 mg>" o "Suero A&D": sin escapar, el navegador se comería
    // ese trozo al imprimir y el medicamento saldría cambiado en la hoja que se
    // lleva el paciente.
    const escHtml = (s) =>
      String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const celda = (v, extra = '') =>
      `<td style="padding:6px 8px;border:1px solid #e2e8f0${extra}">${escHtml(v) || '—'}</td>`;
    // Un suero lleva una fila extra con la preparación (cloruro + ampollas y
    // moléculas). Va DEBAJO y a todo el ancho porque es una lista, no una celda:
    // metida en la columna de indicaciones salía en una tira ilegible, y es
    // exactamente lo que enfermería tiene que leer antes de pinchar.
    const recetaRows = (fu.recetaItems || [])
      .filter((it) => !it.isService)
      .map((it) => {
        const preparacion = describeSuero(it);
        return `
        <tr>
          ${celda(it.name)}
          ${celda(it.quantity || 1, ';text-align:center')}
          ${celda(it.dose)}
          ${celda(it.frequency)}
          ${celda(it.duration)}
          ${celda(it.instructions)}
        </tr>${
          preparacion
            ? `
        <tr>
          <td colspan="6" style="padding:6px 8px;border:1px solid #e2e8f0;background:#f0f9ff">
            <b>Preparación del suero:</b> ${escHtml(preparacion)}
          </td>
        </tr>`
            : ''
        }`;
      })
      .join('');
    const derivacionRows = (fu.recetaItems || [])
      .filter((it) => it.isService)
      .map(
        (it) => `
        <tr>
          ${celda(it.name)}
          ${celda(it.quantity || 1, ';text-align:center')}
          ${celda(it.instructions)}
        </tr>`
      )
      .join('');

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<style>
  body{font-family:Arial,sans-serif;color:#1e293b;padding:30px;}
  h1{color:#047857;margin:0 0 4px 0;}
  .header{border-bottom:2px solid #10b981;padding-bottom:12px;margin-bottom:18px;}
  .box{background:#f0fdf4;border-radius:8px;padding:10px 12px;margin-bottom:12px;}
  .label{font-size:11px;color:#047857;text-transform:uppercase;font-weight:600;margin-bottom:3px;}
  table{width:100%;border-collapse:collapse;font-size:12px;}
  th{background:#ecfdf5;text-align:left;padding:6px 8px;border:1px solid #e2e8f0;}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;}
  .footer{margin-top:30px;font-size:11px;color:#64748b;border-top:1px dashed #cbd5e1;padding-top:8px;}
  .sign{margin-top:60px;text-align:center;font-size:11px;}
  ${FIRMA_CSS}
</style></head><body>
  <div class="header">
    <h1>${clinic?.nombreComercial || clinic?.name || 'Clínica'}</h1>
    <div style="font-size:12px;color:#64748b">${clinic?.direccion || ''} · ${clinic?.telefono || ''}</div>
    <div style="margin-top:6px;font-size:13px;font-weight:600">Receta médica / Indicaciones</div>
  </div>

  <div class="grid">
    <div class="box"><div class="label">Paciente</div><div>${patient?.firstName || ''} ${patient?.lastName || ''}</div></div>
    <div class="box"><div class="label">Cédula</div><div>${patient?.cedula || '—'}</div></div>
    <div class="box"><div class="label">Edad</div><div>${record.edad || '—'}</div></div>
    <div class="box"><div class="label">Fecha</div><div>${fmtDate}</div></div>
  </div>

  <!--
    ESTA HOJA ES LA RECETA, NO LA CONSULTA.
    Es el papel que se lleva el paciente: lo que tiene que tomar, lo que tiene
    que hacer y a dónde tiene que ir. Antes salían además los signos vitales, el
    motivo de consulta, el estudio/síntomas, las observaciones y la ficha de la
    especialidad — la anamnesis entera en la mano del paciente y de quien la
    lea por el camino. Todo eso es historia clínica y ya se imprime donde le
    corresponde: la hoja MSP HCU-form.002 (una consulta) y la HCU-form.005
    (el historial).
  -->

  ${recetaRows ? `<div class="label" style="margin-top:8px">Receta</div>
    <table><thead><tr>
      <th>Medicamento / Insumo</th>
      <th style="text-align:center">Cant.</th>
      <th>Dosis</th>
      <th>Frecuencia</th>
      <th>Duración</th>
      <th>Indicaciones</th>
    </tr></thead><tbody>${recetaRows}</tbody></table>` : ''}

  ${derivacionRows ? `<div class="label" style="margin-top:8px">Derivaciones</div>
    <table><thead><tr>
      <th>Servicio / Programa</th>
      <th style="text-align:center">Cant.</th>
      <th>Indicaciones</th>
    </tr></thead><tbody>${derivacionRows}</tbody></table>` : ''}

  ${fu.receta ? `<div class="box" style="margin-top:10px"><div class="label">Receta (notas adicionales)</div><div style="white-space:pre-wrap">${fu.receta}</div></div>` : ''}

  ${fu.recomendacionesNoFarmacologicas ? `<div class="box"><div class="label">Recomendaciones no farmacológicas</div><div style="white-space:pre-wrap">${escHtml(fu.recomendacionesNoFarmacologicas)}</div></div>` : ''}

  <!-- La RX óptica sí: para el óptico, la graduación ES la receta. -->
  ${opticaHtml}

  <div class="sign">
    ${bloqueFirmaHtml(autor, { esc: escHtml })}
  </div>

  <div class="footer">Documento generado el ${new Date().toLocaleString('es-EC')}</div>
</body></html>`;

    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      format: 'A4',
      margin: { top: '15mm', bottom: '15mm', left: '12mm', right: '12mm' },
    });
    await browser.close();

    /**
     * FIRMA ELECTRÓNICA de la receta, con el certificado del médico que atendió.
     *
     * Si no tiene certificado (o está vencido) la receta sale igual, sin firmar:
     * dejar al paciente sin su receta porque a alguien le falte configurar algo
     * sería peor que entregarla sin firma. El recuadro visible ya dice cuál de
     * las dos cosas es, así que nadie se confunde.
     */
    const { pdf: pdfFinal, firmado } = await firmarPdfConUsuario(pdf, autor, {
      reason: 'Receta médica / Indicaciones',
      location: clinic?.nombreComercial || clinic?.name || '',
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('X-Firma-Electronica', firmado ? 'si' : 'no');
    res.setHeader('Content-Disposition', `inline; filename="receta_${followUpId}.pdf"`);
    res.end(pdfFinal);
  } catch (error) {
    console.error('Error generando PDF de seguimiento:', error);
    res.status(500).json({ message: 'Error al generar PDF', error: error.message });
  }
};

/**
 * Genera la hoja oficial MSP HCU-form.002 / 2021 (Consulta Externa) de una
 * consulta: ensambla la Ficha (A datos, C/D antecedentes) con el seguimiento
 * (B motivo, E enfermedad actual, F constantes, G revisión, H examen físico,
 * I diagnósticos, J plan, K profesional).
 */
exports.printMspForm = async (req, res) => {
  try {
    const { patientId, followUpId } = req.params;
    const record = await ClinicalRecord.findOne({
      clinic: req.clinicId,
      patient: patientId,
    }).populate('followUps.createdBy', 'name specialty email cedula signatureCert');
    if (!record) return res.status(404).json({ message: 'Ficha no encontrada' });
    const fu = record.followUps.id(followUpId);
    if (!fu) return res.status(404).json({ message: 'Seguimiento no encontrado' });

    const patient = await Patient.findById(patientId);
    const Clinic = require('../models/Clinic');
    const clinic = await Clinic.findById(req.clinicId);

    const esc = (s) =>
      String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const val = (s) => (s == null || s === '' ? '&nbsp;' : esc(s));
    const fmtDate = fechaDocumento;

    // Nombres/apellidos: el modelo guarda firstName/lastName combinados.
    const nombres = (patient?.firstName || '').split(/\s+/);
    const apellidos = (patient?.lastName || '').split(/\s+/);
    const edad = record.edad ?? patient?.computedAge ?? patient?.age ?? '';
    const sexo = patient?.gender ? patient.gender.charAt(0).toUpperCase() : '';

    const mapChecks = (arr) => Object.fromEntries((arr || []).map((c) => [c.key, c]));
    // Rejilla de casillas MSP (numeradas), 5 por fila; debajo, detalles de las marcadas.
    const renderChecks = (catalog, arr) => {
      const m = mapChecks(arr);
      const cells = catalog.map((cat, i) => {
        const c = m[cat.key];
        const on = c && c.marked;
        return `<td class="chk${on ? ' on' : ''}"><span class="cn">${i + 1}.</span> ${esc(cat.label)} <span class="mk">${on ? '✕' : ''}</span></td>`;
      });
      let rows = '';
      const perRow = 5;
      for (let i = 0; i < cells.length; i += perRow) {
        let row = cells.slice(i, i + perRow).join('');
        // Completa la última fila para mantener el ancho uniforme.
        const missing = perRow - (cells.length - i < perRow ? cells.length - i : perRow);
        if (missing > 0 && i + perRow >= cells.length) row += '<td class="chk empty"></td>'.repeat(missing);
        rows += `<tr>${row}</tr>`;
      }
      const details = catalog
        .map((cat) => {
          const c = m[cat.key];
          return c && (c.marked || c.detail) ? `<div><b>${esc(cat.label)}:</b> ${esc(c.detail || '—')}</div>` : '';
        })
        .join('');
      return `<table class="checks">${rows}</table>${details ? `<div class="det">${details}</div>` : ''}`;
    };

    const vs = fu.vitalSigns || {};
    const imc = vs.weight && vs.height ? (Number(vs.weight) / Math.pow(Number(vs.height) / 100, 2)).toFixed(2) : '';

    // Receta / derivaciones (parte del plan de tratamiento).
    const recetaItems = (fu.recetaItems || []).filter((it) => !it.isService);
    const derivItems = (fu.recetaItems || []).filter((it) => it.isService);
    const recetaHtml = recetaItems.length
      ? `<div class="sub">Receta</div><table class="grid"><tr><th>Medicamento / Insumo</th><th>Cant.</th><th>Dosis</th><th>Frecuencia</th><th>Duración</th><th>Indicaciones</th></tr>${recetaItems
          .map((it) => {
            const fila = `<tr><td>${val(it.name)}</td><td class="c">${it.quantity || 1}</td><td>${val(it.dose)}</td><td>${val(it.frequency)}</td><td>${val(it.duration)}</td><td>${val(it.instructions)}</td></tr>`;
            // La preparación del suero va en su propia fila a todo el ancho: es
            // una lista de ampollas, no cabe en una celda.
            const prep = describeSuero(it);
            return prep
              ? `${fila}<tr><td colspan="6"><b>Preparación del suero:</b> ${esc(prep)}</td></tr>`
              : fila;
          })
          .join('')}</table>`
      : '';
    const derivHtml = derivItems.length
      ? `<div class="sub">Derivaciones</div><table class="grid"><tr><th>Servicio / Programa</th><th>Cant.</th><th>Indicaciones</th></tr>${derivItems
          .map((it) => `<tr><td>${val(it.name)}</td><td class="c">${it.quantity || 1}</td><td>${val(it.instructions)}</td></tr>`)
          .join('')}</table>`
      : '';

    // I. Diagnósticos (rellena a 6 filas como la hoja oficial).
    const dx = fu.diagnosticos || [];
    let dxRows = '';
    for (let i = 0; i < Math.max(6, dx.length); i++) {
      const d = dx[i] || {};
      dxRows += `<tr><td class="c">${i + 1}.</td><td>${val(d.descripcion || d.cieDescripcion)}</td><td class="c">${val(d.cie)}</td><td class="c">${d.presuntivo ? '✕' : '&nbsp;'}</td><td class="c">${d.definitivo ? '✕' : '&nbsp;'}</td></tr>`;
    }

    const doc = fu.createdBy || {};

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<style>
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color:#111; font-size:10px; margin:0; }
  .bar { background:#d9d9ef; font-weight:bold; font-size:12px; padding:4px 6px; border:1px solid #444; margin-top:8px; }
  .bar .note { float:right; font-size:7.5px; font-weight:normal; color:#333; max-width:45%; text-align:right; }
  table { width:100%; border-collapse:collapse; }
  .info td { border:1px solid #888; padding:3px 5px; vertical-align:top; }
  .info .lbl { background:#d7ecd7; font-weight:bold; font-size:8px; white-space:nowrap; }
  .box { border:1px solid #888; border-top:none; padding:5px 6px; min-height:26px; white-space:pre-wrap; }
  .checks { margin-top:2px; }
  .checks td { border:1px solid #999; padding:3px 4px; font-size:8px; width:20%; vertical-align:top; height:22px; }
  .checks td.on { background:#d7ecd7; font-weight:bold; }
  .checks td.empty { background:#f4f4f4; }
  .checks .cn { color:#555; font-weight:bold; }
  .checks .mk { float:right; color:#046a04; font-weight:bold; }
  .det { border:1px solid #888; border-top:none; padding:4px 6px; font-size:8px; line-height:1.5; }
  .grid th, .grid td { border:1px solid #999; padding:3px 5px; font-size:8.5px; text-align:left; }
  .grid th { background:#ececf7; }
  .grid td.c, .grid th.c { text-align:center; }
  .vit th, .vit td { border:1px solid #999; padding:3px 2px; font-size:7.5px; text-align:center; }
  .vit th { background:#d7ecd7; }
  .sub { font-weight:bold; font-size:9px; margin:6px 0 2px; }
  .page2 { page-break-before: always; }
  .sign td { border:1px solid #888; padding:4px 6px; font-size:8px; height:40px; vertical-align:top; }
  .sign .lbl { background:#d7ecd7; font-weight:bold; text-align:center; }
  .title { text-align:right; font-weight:bold; font-size:12px; margin-top:6px; }
  .foot { font-size:7px; color:#666; margin-top:4px; }
  ${FIRMA_CSS}
</style></head><body>

  <!-- A. DATOS DEL ESTABLECIMIENTO Y USUARIO / PACIENTE -->
  <div class="bar">A. DATOS DEL ESTABLECIMIENTO Y USUARIO / PACIENTE</div>
  <table class="info">
    <tr>
      <td class="lbl">Institución del sistema</td><td>&nbsp;</td>
      <td class="lbl">Establecimiento de salud</td><td>${val(clinic?.nombreComercial || clinic?.name)}</td>
      <td class="lbl">N.º historia clínica única</td><td>${val(patient?.cedula)}</td>
    </tr>
    <tr>
      <td class="lbl">Primer apellido</td><td>${val(apellidos[0])}</td>
      <td class="lbl">Segundo apellido</td><td>${val(apellidos.slice(1).join(' '))}</td>
      <td class="lbl">Sexo</td><td>${val(sexo)}</td>
    </tr>
    <tr>
      <td class="lbl">Primer nombre</td><td>${val(nombres[0])}</td>
      <td class="lbl">Segundo nombre</td><td>${val(nombres.slice(1).join(' '))}</td>
      <td class="lbl">Edad (años)</td><td>${val(edad)}</td>
    </tr>
  </table>

  <!-- B. MOTIVO DE CONSULTA -->
  <div class="bar">B. MOTIVO DE CONSULTA <span class="note">${fu.tipoConsulta === 'primera' ? 'PRIMERA [✕]' : 'PRIMERA [ ]'} &nbsp; ${fu.tipoConsulta === 'subsecuente' ? 'SUBSECUENTE [✕]' : 'SUBSECUENTE [ ]'}</span></div>
  <div class="box">${val(fu.descripcion || fu.motivoConsulta)}</div>

  <!-- C. ANTECEDENTES PATOLÓGICOS PERSONALES -->
  <div class="bar">C. ANTECEDENTES PATOLÓGICOS PERSONALES <span class="note">Datos clínico-quirúrgicos, obstétricos, alérgicos relevantes</span></div>
  ${renderChecks(ANTECEDENTES_CATEGORIAS, record.patologicosPersonales)}
  ${record.datosRelevantes ? `<div class="det"><b>Relevantes:</b> ${esc(record.datosRelevantes)}</div>` : ''}
  ${
    // Quirúrgicos, medicación habitual y alergias. La hoja oficial los mete en el
    // renglón de "relevantes" de arriba; aquí van desglosados porque es como se
    // capturan y porque la alergia es lo primero que hay que ver antes de recetar.
    [
      ['Quirúrgicos', record.antecedentesQuirurgicos],
      ['Medicación habitual', record.antecedentesMedicamentos],
      ['Alergias', record.alergias],
    ]
      .filter(([, v]) => String(v || '').trim())
      .map(([k, v]) => `<div class="det"><b>${k}:</b> ${esc(v)}</div>`)
      .join('')
  }

  <!-- HÁBITOS -->
  ${
    (record.habitos || []).length || String(record.habitosDetalle || '').trim()
      ? `<div class="bar">HÁBITOS <span class="note">Tabaco · alcohol · drogas · alimentación · actividad física</span></div>
  ${renderChecks(HABITOS_CATEGORIAS, record.habitos)}
  ${record.habitosDetalle ? `<div class="det"><b>Detalle:</b> ${esc(record.habitosDetalle)}</div>` : ''}`
      : ''
  }

  <!-- D. ANTECEDENTES PATOLÓGICOS FAMILIARES -->
  <div class="bar">D. ANTECEDENTES PATOLÓGICOS FAMILIARES</div>
  ${renderChecks(ANTECEDENTES_CATEGORIAS, record.patologicosFamiliares)}
  ${record.datosRelevantesFamiliares ? `<div class="det"><b>Relevantes:</b> ${esc(record.datosRelevantesFamiliares)}</div>` : ''}

  <!-- E. ENFERMEDAD O PROBLEMA ACTUAL -->
  <div class="bar">E. ENFERMEDAD O PROBLEMA ACTUAL <span class="note">Cronología · localización · características · intensidad · frecuencia · factores agravantes</span></div>
  <div class="box">${val(fu.enfermedadActual)}${fu.estudioSintomas ? `\n\nEstudio o síntomas: ${esc(fu.estudioSintomas)}` : ''}</div>

  <!-- F. CONSTANTES VITALES Y ANTROPOMETRÍA -->
  <div class="bar">F. CONSTANTES VITALES Y ANTROPOMETRÍA</div>
  <table class="vit">
    <tr><th>Fecha</th><th>Hora</th><th>Temp (°C)</th><th>P. Arterial</th><th>Pulso/min</th><th>F. Resp/min</th><th>Peso (Kg)</th><th>Talla (cm)</th><th>IMC</th><th>P. Abdom.</th><th>Hb cap.</th><th>Glucosa</th><th>SatO₂ %</th></tr>
    <tr><td>${fmtDate(fu.fecha)}</td><td>${val(vs.hora)}</td><td>${val(vs.temperature)}</td><td>${val(vs.bloodPressure)}</td><td>${val(vs.heartRate)}</td><td>${val(vs.respiratoryRate)}</td><td>${val(vs.weight)}</td><td>${val(vs.height)}</td><td>${val(imc)}</td><td>${val(vs.abdominalPerimeter)}</td><td>${val(vs.capillaryHemoglobin)}</td><td>${val(vs.glucose)}</td><td>${val(vs.oxygenSaturation)}</td></tr>
  </table>

  <!-- G. REVISIÓN ACTUAL DE ÓRGANOS Y SISTEMAS -->
  <div class="bar">G. REVISIÓN ACTUAL DE ÓRGANOS Y SISTEMAS <span class="note">Marcar cuando presente patología y describa</span></div>
  ${renderChecks(REVISION_SISTEMAS, fu.revisionSistemas)}
  ${fu.revisionSistemasHallazgos ? `<div class="det"><b>Hallazgos:</b> ${esc(fu.revisionSistemasHallazgos)}</div>` : ''}

  <!-- PÁGINA 2 -->
  <div class="page2"></div>

  <!-- H. EXAMEN FÍSICO -->
  <div class="bar">H. EXAMEN FÍSICO — REGIONAL <span class="note">Marcar cuando presente patología y describa</span></div>
  ${renderChecks(EXAMEN_REGIONAL, fu.examenFisico?.regional)}
  <div class="bar">H. EXAMEN FÍSICO — SISTÉMICO</div>
  ${renderChecks(EXAMEN_SISTEMICO, fu.examenFisico?.sistemico)}
  ${fu.examenFisico?.hallazgos ? `<div class="det"><b>Hallazgos:</b> ${esc(fu.examenFisico.hallazgos)}</div>` : ''}

  <!-- I. DIAGNÓSTICO -->
  <div class="bar">I. DIAGNÓSTICO <span class="note">PRE = presuntivo · DEF = definitivo</span></div>
  <table class="grid"><tr><th class="c">#</th><th>Descripción</th><th class="c">CIE</th><th class="c">PRE</th><th class="c">DEF</th></tr>${dxRows}</table>

  <!-- J. PLAN DE TRATAMIENTO -->
  <div class="bar">J. PLAN DE TRATAMIENTO <span class="note">Diagnóstico, terapéutico y educacional</span></div>
  <div class="box">${val(fu.planTratamiento)}</div>
  ${fu.recomendacionesNoFarmacologicas ? `<div class="bar">RECOMENDACIONES NO FARMACOLÓGICAS <span class="note">Dieta · ejercicio · reposo · hábitos</span></div><div class="box">${esc(fu.recomendacionesNoFarmacologicas)}</div>` : ''}
  ${fu.evolucion ? `<div class="bar">EVOLUCIÓN <span class="note">Cómo evoluciona respecto de controles anteriores</span></div><div class="box">${esc(fu.evolucion)}</div>` : ''}
  ${recetaHtml}
  ${derivHtml}

  <!-- K. DATOS DEL PROFESIONAL RESPONSABLE -->
  <div class="bar">K. DATOS DEL PROFESIONAL RESPONSABLE</div>
  <table class="sign">
    <tr>
      <td class="lbl">Fecha</td><td class="lbl">Nombre y apellidos</td><td class="lbl">N.º documento</td><td class="lbl">Firma / Sello</td>
    </tr>
    <tr>
      <td>${fmtDate(fu.fecha)}</td>
      <td>${val(doc.name)}${doc.specialty ? `<br/><span style="font-size:7px;color:#555">${esc(doc.specialty)}</span>` : ''}</td>
      <td>${val(doc.cedula)}</td>
      <td>${bloqueFirmaHtml(doc, { esc })}</td>
    </tr>
  </table>

  <div class="title">CONSULTA EXTERNA — HCU-form.002 / 2021</div>
  <div class="foot">Generado el ${new Date().toLocaleString('es-EC')}</div>
</body></html>`;

    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      format: 'A4',
      margin: { top: '10mm', bottom: '10mm', left: '8mm', right: '8mm' },
      printBackground: true,
    });
    await browser.close();

    // La hoja 002 es UNA consulta con UN profesional responsable (bloque K), así
    // que se firma con su certificado igual que la receta. La 005 NO se firma:
    // recorre consultas de varios médicos y una sola firma diría que todas son
    // de la misma persona.
    const { pdf: pdfFinal, firmado } = await firmarPdfConUsuario(pdf, fu.createdBy, {
      reason: 'Consulta externa · HCU-form.002',
      location: clinic?.nombreComercial || clinic?.name || '',
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('X-Firma-Electronica', firmado ? 'si' : 'no');
    res.setHeader('Content-Disposition', `inline; filename="HCU002_${followUpId}.pdf"`);
    res.end(pdfFinal);
  } catch (error) {
    console.error('Error generando HCU-form.002:', error);
    res.status(500).json({ message: 'Error al generar el formulario MSP', error: error.message });
  }
};

/**
 * Genera la hoja oficial MSP HCU-form.005 / 2008 — EVOLUCIÓN Y PRESCRIPCIONES.
 *
 * Es la HISTORIA del paciente, no una consulta: «conservar un registro
 * secuencial del progreso clínico, variaciones del tratamiento y prescripciones»
 * (instructivo del MSP). Por eso va TODA la ficha en orden cronológico
 * ascendente, y no un seguimiento suelto como la HCU-form.002.
 *
 * El formulario tiene dos bloques y una columna de enfermería:
 *   1 EVOLUCIÓN      · fecha, hora y notas. Firma al pie de cada nota.
 *   2 PRESCRIPCIONES · farmacoterapia e indicaciones para enfermería y otro
 *                      personal. Firma al pie del grupo de prescripciones.
 *     ADMINISTRACIÓN · la administración verificada de cada prescripción, con la
 *                      firma de enfermería. La hoja oficial dice literalmente
 *                      «ESCRIBIR CON ROJO», y por eso esa columna va en rojo: es
 *                      lo que la distingue de un vistazo de lo que mandó el
 *                      médico. Sale de las aplicaciones de suero que registra
 *                      enfermería, con su hora y su nombre.
 */
exports.printHcu005 = async (req, res) => {
  try {
    const { patientId } = req.params;
    const record = await ClinicalRecord.findOne({ clinic: req.clinicId, patient: patientId })
      .populate('followUps.createdBy', 'name specialty cedula');
    if (!record) return res.status(404).json({ message: 'Ficha no encontrada' });

    const patient = await Patient.findById(patientId);
    const Clinic = require('../models/Clinic');
    const clinic = await Clinic.findById(req.clinicId);

    const esc = (s) =>
      String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const val = (s) => (s == null || s === '' ? '&nbsp;' : esc(s));
    const fechaDe = fechaDocumento;
    const horaDe = (d) => {
      if (!d) return '';
      const x = new Date(d);
      return `${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`;
    };
    // Solo las casillas marcadas: la 005 es un relato, no la rejilla de la 002.
    const marcadas = (catalogo, arr) => {
      const m = new Map((arr || []).map((c) => [c.key, c]));
      return catalogo.filter((cat) => m.get(cat.key)?.marked).map((cat) => cat.label);
    };

    const nombres = (patient?.firstName || '').trim();
    const apellidos = (patient?.lastName || '').trim();
    const edad = record.edad ?? patient?.computedAge ?? patient?.age ?? '';
    const sexo = patient?.gender ? patient.gender.charAt(0).toUpperCase() : '';

    // Orden CRONOLÓGICO ASCENDENTE: la hoja es un registro secuencial y se lee
    // de la primera consulta a la última, al revés que el historial en pantalla.
    const seguimientos = [...(record.followUps || [])].sort(
      (a, b) => new Date(a.fecha) - new Date(b.fecha),
    );

    const filas = seguimientos.map((fu) => {
      // ── 1. NOTAS DE EVOLUCIÓN ──
      const notas = [];
      if (fu.kind === 'enfermeria') notas.push('<b>[Enfermería]</b>');
      if (fu.descripcion || fu.motivoConsulta) {
        notas.push(`<b>Motivo:</b> ${esc(fu.descripcion || fu.motivoConsulta)}`);
      }
      if (fu.enfermedadActual) notas.push(`<b>Enfermedad actual:</b> ${esc(fu.enfermedadActual)}`);

      const vs = fu.vitalSigns || {};
      const signos = [
        vs.bloodPressure && `TA ${vs.bloodPressure}`,
        vs.heartRate && `FC ${vs.heartRate}`,
        vs.respiratoryRate && `FR ${vs.respiratoryRate}`,
        vs.temperature != null && `T ${vs.temperature}`,
        vs.oxygenSaturation && `SatO2 ${vs.oxygenSaturation}%`,
        vs.weight && `Peso ${vs.weight} kg`,
        vs.height && `Talla ${vs.height} cm`,
        vs.glucose && `Glu ${vs.glucose}`,
      ].filter(Boolean);
      if (signos.length) notas.push(`<b>Signos vitales:</b> ${esc(signos.join(' · '))}`);

      const rev = marcadas(REVISION_SISTEMAS, fu.revisionSistemas);
      if (rev.length) notas.push(`<b>Revisión por sistemas:</b> ${esc(rev.join(', '))}`);
      if (fu.revisionSistemasHallazgos) notas.push(esc(fu.revisionSistemasHallazgos));

      const reg = marcadas(EXAMEN_REGIONAL, fu.examenFisico?.regional);
      const sis = marcadas(EXAMEN_SISTEMICO, fu.examenFisico?.sistemico);
      if (reg.length || sis.length) {
        notas.push(`<b>Examen físico:</b> ${esc([...reg, ...sis].join(', '))}`);
      }
      if (fu.examenFisico?.hallazgos) notas.push(esc(fu.examenFisico.hallazgos));

      const dx = (fu.diagnosticos || []).filter((d) => d.descripcion || d.cie);
      if (dx.length) {
        notas.push(
          `<b>Diagnóstico:</b> ${dx
            .map((d) => `${esc(d.descripcion || d.cieDescripcion)}${d.cie ? ` (${esc(d.cie)})` : ''}${d.definitivo ? ' DEF' : d.presuntivo ? ' PRE' : ''}`)
            .join('; ')}`,
        );
      }
      if (fu.evolucion) notas.push(`<b>Evolución:</b> ${esc(fu.evolucion)}`);
      // La ficha de la especialidad (gineco, podología, odontología…) es parte
      // del progreso clínico y aquí sí va: esta hoja ES la historia.
      const especialidad = specialtyFollowUpHtml(fu);

      // ── 2. PRESCRIPCIONES ──
      const receta = (fu.recetaItems || []).filter((it) => !it.isService);
      const deriv = (fu.recetaItems || []).filter((it) => it.isService);
      const presc = [];
      receta.forEach((it) => {
        const linea = [
          `<b>${esc(it.name)}</b>`,
          it.quantity ? `x${it.quantity}` : '',
          it.dose ? `· ${esc(it.dose)}` : '',
          it.frequency ? `· ${esc(it.frequency)}` : '',
          it.duration ? `· ${esc(it.duration)}` : '',
        ].filter(Boolean).join(' ');
        const prep = describeSuero(it);
        presc.push(
          linea +
            (prep ? `<div class="prep">Preparación: ${esc(prep)}</div>` : '') +
            (it.instructions ? `<div class="ind">${esc(it.instructions)}</div>` : ''),
        );
      });
      if (fu.planTratamiento) presc.push(`<b>Plan:</b> ${esc(fu.planTratamiento)}`);
      if (fu.recomendacionesNoFarmacologicas) {
        presc.push(`<b>No farmacológicas:</b> ${esc(fu.recomendacionesNoFarmacologicas)}`);
      }
      if (deriv.length) {
        presc.push(
          `<b>Derivaciones:</b> ${deriv
            .map((it) => `${esc(it.name)}${it.quantity ? ` x${it.quantity}` : ''}${it.instructions ? ` (${esc(it.instructions)})` : ''}`)
            .join('; ')}`,
        );
      }
      if (fu.receta) presc.push(esc(fu.receta));

      // ── ADMINISTRACIÓN (enfermería, en rojo) ──
      const admin = [];
      receta.filter((it) => it.isSerum).forEach((it) => {
        (it.administrations || []).forEach((ad) => {
          const omitidas = (ad.components || []).filter((c) => c.quantityApplied < c.quantityPrescribed);
          const puestas = (ad.components || []).filter((c) => c.quantityApplied > 0);
          admin.push(
            '<div class="adm">' +
              `<b>${fechaDe(ad.at)} ${horaDe(ad.at)}</b> — ${esc(it.name)}` +
              (ad.baseVolumeMl ? ` · ${esc(it.serumBase?.name || SUERO_CLORURO_NOMBRE)} ${ad.baseVolumeMl} ml` : '') +
              (puestas.length
                ? `<div>${puestas.map((c) => `${esc(c.name)} x${c.quantityApplied}`).join(' · ')}</div>`
                : '') +
              (omitidas.length
                ? `<div class="omit">No se aplicó: ${omitidas.map((c) => `${esc(c.name)}${c.omitReason ? ` (${esc(c.omitReason)})` : ''}`).join(' · ')}</div>`
                : '') +
              (ad.note ? `<div>${esc(ad.note)}</div>` : '') +
              `<div class="firma">${esc(ad.byName || '')}</div>` +
            '</div>',
          );
        });
      });

      const doc = fu.createdBy || {};
      // La firma al pie de CADA nota y de CADA grupo de prescripciones es una
      // exigencia literal del instructivo, no un adorno.
      const firma = `<div class="firma">${esc(doc.name || '')}${doc.specialty ? ` · ${esc(doc.specialty)}` : ''}${doc.cedula ? ` · CI ${esc(doc.cedula)}` : ''}</div>`;

      return `<tr>
        <td class="c fec">${val(fechaDe(fu.fecha))}</td>
        <td class="c hor">${val(vs.hora)}</td>
        <td class="nota">${notas.join('<br/>') || '&nbsp;'}${especialidad}${firma}</td>
        <td class="presc">${presc.length ? presc.join('<hr class="sep"/>') + firma : '&nbsp;'}</td>
        <td class="admin">${admin.join('') || '&nbsp;'}</td>
      </tr>`;
    });

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<style>
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color:#111; font-size:9px; margin:0; }
  .bar { background:#d9d9ef; font-weight:bold; font-size:11px; padding:4px 6px; border:1px solid #444; }
  table { width:100%; border-collapse:collapse; }
  .info td { border:1px solid #888; padding:3px 5px; vertical-align:top; font-size:8.5px; }
  .info .lbl { background:#d7ecd7; font-weight:bold; font-size:8px; white-space:nowrap; }
  .hoja th { background:#ececf7; border:1px solid #999; padding:4px 5px; font-size:8px; text-align:center; }
  .hoja td { border:1px solid #999; padding:4px 5px; vertical-align:top; font-size:8.5px; line-height:1.45; }
  .hoja td.c { text-align:center; white-space:nowrap; }
  .hoja .fec { width:62px; } .hoja .hor { width:36px; }
  .hoja .nota { width:38%; } .hoja .presc { width:30%; } .hoja .admin { width:22%; }
  /* El instructivo pide que la administración de enfermería vaya EN ROJO. */
  .hoja .admin { color:#b00000; }
  .adm { border-bottom:1px dotted #e0a0a0; padding-bottom:3px; margin-bottom:3px; }
  .adm .omit { font-style:italic; }
  .firma { margin-top:5px; padding-top:3px; border-top:1px dotted #888; font-size:7.5px; color:#333; }
  .admin .firma { color:#b00000; border-top-color:#e0a0a0; }
  .prep { background:#f0f9ff; padding:2px 4px; margin-top:2px; }
  .ind { color:#333; margin-top:2px; }
  .sep { border:none; border-top:1px dashed #bbb; margin:4px 0; }
  .title { text-align:right; font-weight:bold; font-size:10px; margin-top:6px; }
  .foot { font-size:7px; color:#666; margin-top:3px; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
</style></head><body>

  <div class="bar">EVOLUCIÓN Y PRESCRIPCIONES</div>
  <table class="info">
    <tr>
      <td class="lbl">Establecimiento</td><td>${val(clinic?.nombreComercial || clinic?.name)}</td>
      <td class="lbl">N.º historia clínica</td><td>${val(patient?.cedula)}</td>
      <td class="lbl">Sexo (M-F)</td><td>${val(sexo)}</td>
      <td class="lbl">Edad</td><td>${val(edad)}</td>
    </tr>
    <tr>
      <td class="lbl">Apellidos</td><td colspan="3">${val(apellidos)}</td>
      <td class="lbl">Nombres</td><td colspan="3">${val(nombres)}</td>
    </tr>
  </table>

  <table class="hoja">
    <thead>
      <tr>
        <th colspan="3">1 · EVOLUCIÓN</th>
        <th>2 · PRESCRIPCIONES</th>
        <th>ADMINISTRACIÓN DE FÁRMACOS Y OTROS</th>
      </tr>
      <tr>
        <th class="fec">Fecha</th>
        <th class="hor">Hora</th>
        <th>Notas de evolución <span style="font-weight:normal">(firma al pie de cada nota)</span></th>
        <th>Farmacoterapia e indicaciones para enfermería y otro personal</th>
        <th>Enfermería · hora y firma</th>
      </tr>
    </thead>
    <tbody>
      ${filas.join('') || '<tr><td colspan="5" style="text-align:center;padding:20px">Sin consultas registradas.</td></tr>'}
    </tbody>
  </table>

  <div class="title">SNS-MSP / HCU-form.005 / 2008</div>
  <div class="foot">Generado el ${new Date().toLocaleString('es-EC')} · ${seguimientos.length} atencion${seguimientos.length === 1 ? '' : 'es'}</div>
</body></html>`;

    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      format: 'A4',
      landscape: true,
      margin: { top: '10mm', bottom: '14mm', left: '8mm', right: '8mm' },
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      // «N.º HOJA» del formulario oficial: puppeteer es quien sabe cuántas salen.
      footerTemplate:
        '<div style="width:100%;font-size:8px;color:#444;padding:0 10mm;text-align:right">' +
        'N.º hoja <span class="pageNumber"></span> de <span class="totalPages"></span></div>',
    });
    await browser.close();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="HCU005_${patientId}.pdf"`);
    res.end(pdf);
  } catch (error) {
    console.error('Error generando HCU-form.005:', error);
    res.status(500).json({ message: 'Error al generar la historia clínica', error: error.message });
  }
};
