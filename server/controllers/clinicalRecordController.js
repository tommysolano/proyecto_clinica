const ClinicalRecord = require('../models/ClinicalRecord');
const Patient = require('../models/Patient');
const Product = require('../models/Product');
const Treatment = require('../models/Treatment');
const {
  ANTECEDENTES_CATEGORIAS,
  REVISION_SISTEMAS,
  EXAMEN_REGIONAL,
  EXAMEN_SISTEMICO,
} = require('../constants/mspCatalogs');
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
const { describeCie10 } = require('../utils/cie10Catalog');
const { emitToClinic, emitToUser, emitToRole } = require('../realtime');
const { canReq } = require('../utils/permissions');
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
    ];
    const update = { updatedBy: req.user._id };
    for (const k of allowed) {
      if (req.body[k] !== undefined) update[k] = req.body[k];
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
            siguienteTurno = siguiente;
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
    }

    emitToClinic(req.clinicId, 'clinicalRecord:updated', { patient: patientId });
    // `nextTurn` deja que la pantalla diga "pasa al Dr. X" en vez de dar la cita
    // por terminada cuando no lo está.
    res.status(201).json(siguienteTurno ? { ...record.toObject(), nextTurn: siguienteTurno } : record);
  } catch (error) {
    res.status(500).json({ message: 'Error al agregar seguimiento', error: error.message });
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
    }).populate('followUps.createdBy', 'name specialty signatureImage');
    if (!record) return res.status(404).json({ message: 'Ficha no encontrada' });

    const fu = record.followUps.id(followUpId);
    if (!fu) return res.status(404).json({ message: 'Seguimiento no encontrado' });

    const patient = await Patient.findById(patientId);
    const Clinic = require('../models/Clinic');
    const clinic = await Clinic.findById(req.clinicId);
    const doctorSignature = fu.createdBy?.signatureImage || '';
    const doctorName = fu.createdBy?.name || '';
    const doctorSpecialty = fu.createdBy?.specialty || '';

    // Fecha en formato dd/mm/aaaa para Ecuador
    const fmtDate = (() => {
      const d = new Date(fu.fecha);
      const dd = String(d.getDate()).padStart(2, '0');
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const yyyy = d.getFullYear();
      return `${dd}/${mm}/${yyyy}`;
    })();
    // Signos vitales
    const vs = fu.vitalSigns || {};
    const vitalsParts = [];
    if (vs.bloodPressure) vitalsParts.push(`TA: ${vs.bloodPressure}`);
    if (vs.heartRate) vitalsParts.push(`FC: ${vs.heartRate} lpm`);
    if (vs.respiratoryRate) vitalsParts.push(`FR: ${vs.respiratoryRate} rpm`);
    if (vs.temperature != null) vitalsParts.push(`T°: ${vs.temperature}°C`);
    if (vs.oxygenSaturation) vitalsParts.push(`SatO₂: ${vs.oxygenSaturation}%`);
    if (vs.weight) vitalsParts.push(`Peso: ${vs.weight} kg`);
    if (vs.height) vitalsParts.push(`Talla: ${vs.height} cm`);
    if (vs.glucose) vitalsParts.push(`Glucosa: ${vs.glucose} mg/dL`);
    const vitalsHtml = vitalsParts.length
      ? `<div class="box"><div class="label">Signos vitales</div><div>${vitalsParts.join(' &nbsp;·&nbsp; ')}</div></div>`
      : '';
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
    const recetaRows = (fu.recetaItems || [])
      .filter((it) => !it.isService)
      .map(
        (it) => `
        <tr>
          ${celda(it.name)}
          ${celda(it.quantity || 1, ';text-align:center')}
          ${celda(it.dose)}
          ${celda(it.frequency)}
          ${celda(it.duration)}
          ${celda(it.instructions)}
        </tr>`
      )
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
  .sign{margin-top:60px;border-top:1px solid #94a3b8;width:280px;padding-top:6px;text-align:center;font-size:11px;}
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

  ${fu.descripcion ? `<div class="box"><div class="label">Motivo de consulta</div><div>${fu.descripcion}</div></div>` : ''}

  ${(fu.estudioSintomas || fu.recomendaciones) ? `<div class="box"><div class="label">Estudio o síntomas</div><div>${fu.estudioSintomas || fu.recomendaciones}</div></div>` : ''}

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

  ${fu.observaciones ? `<div class="box"><div class="label">Observaciones</div><div style="white-space:pre-wrap">${fu.observaciones}</div></div>` : ''}

  ${vitalsHtml}
  ${opticaHtml}
  ${specialtyFollowUpHtml(fu)}

  <div class="sign">
    ${doctorSignature ? `<img src="${doctorSignature}" alt="Firma" style="max-height:60px;display:block;margin:0 auto 4px;" />` : ''}
    ${doctorName ? `Dr. ${doctorName}` : ''}
    <br/><span style="color:#94a3b8">${doctorSpecialty || 'Médico tratante'}</span>
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

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="receta_${followUpId}.pdf"`);
    res.end(pdf);
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
    }).populate('followUps.createdBy', 'name specialty signatureImage cedula');
    if (!record) return res.status(404).json({ message: 'Ficha no encontrada' });
    const fu = record.followUps.id(followUpId);
    if (!fu) return res.status(404).json({ message: 'Seguimiento no encontrado' });

    const patient = await Patient.findById(patientId);
    const Clinic = require('../models/Clinic');
    const clinic = await Clinic.findById(req.clinicId);

    const esc = (s) =>
      String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const val = (s) => (s == null || s === '' ? '&nbsp;' : esc(s));
    const fmtDate = (d) => {
      if (!d) return '';
      const x = new Date(d);
      return `${String(x.getDate()).padStart(2, '0')}/${String(x.getMonth() + 1).padStart(2, '0')}/${x.getFullYear()}`;
    };

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
          .map((it) => `<tr><td>${val(it.name)}</td><td class="c">${it.quantity || 1}</td><td>${val(it.dose)}</td><td>${val(it.frequency)}</td><td>${val(it.duration)}</td><td>${val(it.instructions)}</td></tr>`)
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
      <td>${doc.signatureImage ? `<img src="${doc.signatureImage}" style="max-height:34px"/>` : '&nbsp;'}</td>
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

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="HCU002_${followUpId}.pdf"`);
    res.end(pdf);
  } catch (error) {
    console.error('Error generando HCU-form.002:', error);
    res.status(500).json({ message: 'Error al generar el formulario MSP', error: error.message });
  }
};
