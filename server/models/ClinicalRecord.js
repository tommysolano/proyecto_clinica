const mongoose = require('mongoose');

const recetaItemSchema = new mongoose.Schema(
  {
    // Referencia al producto/medicamento del inventario (categoría 'medicamento' o 'servicio'/'programa').
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    name: { type: String, trim: true }, // snapshot del nombre por si el producto cambia
    quantity: { type: Number, default: 1, min: 0 },
    dose: { type: String, trim: true, default: '' },         // ej: 500mg
    frequency: { type: String, trim: true, default: '' },    // ej: cada 8 horas
    duration: { type: String, trim: true, default: '' },     // ej: 7 días
    instructions: { type: String, trim: true, default: '' }, // ej: tomar después de comer
    // Marca interna para identificar si este ítem corresponde a un servicio/programa
    // y debe disparar la creación automática del tratamiento.
    isService: { type: Boolean, default: false },
    // Si el producto es compuesto (ej. suero), aquí van los componentes que el
    // doctor eligió recetar (ej. las ampollas). Se descuentan del inventario; el
    // costo cobrado es el del item compuesto, no la suma de los componentes.
    isComposite: { type: Boolean, default: false },
    componentsUsed: [
      {
        product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
        name: { type: String, trim: true },
        quantity: { type: Number, default: 1, min: 0 },
        _id: false,
      },
    ],
  },
  { _id: true }
);

// Casilla del formulario MSP: una categoría fija (por `key`, ver mspCatalogs.js)
// con marca y detalle. `marked` significa "presente" en antecedentes (C/D) y
// "patológico" en revisión de sistemas (G) y examen físico (H).
const mspCheckSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    marked: { type: Boolean, default: false },
    detail: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

// I. Diagnóstico. Hasta 6 por consulta; cada uno con código CIE-10 y si es
// presuntivo (PRE) y/o definitivo (DEF).
const diagnosticoSchema = new mongoose.Schema(
  {
    descripcion: { type: String, trim: true, default: '' },
    cie: { type: String, trim: true, default: '' },            // código CIE-10 (ej. J00)
    cieDescripcion: { type: String, trim: true, default: '' }, // snapshot del nombre del código
    presuntivo: { type: Boolean, default: false },
    definitivo: { type: Boolean, default: false },
  },
  { _id: false }
);

/**
 * Pieza del odontograma (rol 'odontologia'). `diente` es el número FDI ('11',
 * '18', '51'…, ver ODONTOGRAMA_PIEZAS). Solo se guardan las piezas marcadas, no
 * las 52 del esquema.
 *
 * `estado` es el símbolo que afecta a la PIEZA ENTERA (extracción indicada,
 * pérdida, endodoncia, corona, prótesis…). Cada cara lleva ADEMÁS su propio
 * estado, porque la hoja del MSP permite caries en una cara y obturado en otra
 * del mismo diente; antes las caras eran booleanas y eso no cabía.
 *
 * `recesion` y `movilidad` son el grado 1-3 que la hoja marca con "X" encima
 * (arco superior) o debajo (arco inferior) de cada pieza permanente.
 */
const odontogramaDienteSchema = new mongoose.Schema(
  {
    diente: { type: String, required: true },
    estado: { type: String, trim: true, default: '' },
    caras: {
      vestibular: { type: String, trim: true, default: '' },
      lingual: { type: String, trim: true, default: '' },
      mesial: { type: String, trim: true, default: '' },
      distal: { type: String, trim: true, default: '' },
      oclusal: { type: String, trim: true, default: '' },
    },
    recesion: { type: String, trim: true, default: '' },
    movilidad: { type: String, trim: true, default: '' },
    nota: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

// Sección 7 · una fila de la higiene oral simplificada: qué pieza se examinó en
// ese sextante y sus tres índices.
const higieneOralFilaSchema = new mongoose.Schema(
  {
    fila: { type: String, required: true },
    pieza: { type: String, trim: true, default: '' },
    placa: { type: String, trim: true, default: '' },
    calculo: { type: String, trim: true, default: '' },
    gingivitis: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

const followUpSchema = new mongoose.Schema(
  {
    fecha: { type: Date, required: true, default: Date.now },
    // B. Motivo de consulta: primera vez o subsecuente.
    tipoConsulta: { type: String, enum: ['primera', 'subsecuente', ''], default: '' },
    // E. Enfermedad o problema actual (cronología, localización, características…).
    enfermedadActual: { type: String, trim: true, default: '' },
    // Tipo de entrada de seguimiento: '' (consulta normal del doctor) o
    // 'enfermeria' (aplicación de servicio registrada automáticamente por enfermería).
    kind: { type: String, default: '' },
    // "motivo de consulta" reemplaza al antiguo "descripcion".
    // Mantenemos `descripcion` como alias por retrocompatibilidad de datos.
    motivoConsulta: { type: String, trim: true },
    descripcion: { type: String, trim: true },
    // Antes era "Recomendaciones"; ahora se llama "Estudio o síntomas".
    // Mantenemos el campo `recomendaciones` por retrocompatibilidad pero
    // exponemos también `estudioSintomas` (alias funcional en el cliente).
    recomendaciones: { type: String, trim: true },
    estudioSintomas: { type: String, trim: true },
    // Antes "receta" era texto libre; ahora soportamos items estructurados del inventario.
    receta: { type: String, trim: true }, // legacy / texto libre opcional
    recetaItems: { type: [recetaItemSchema], default: [] },
    // Reemplaza al campo "treatment" (ref). Ahora se captura como texto.
    observaciones: { type: String, trim: true },
    // F. Constantes vitales y antropometría del paciente.
    vitalSigns: {
      hora: { type: String, trim: true, default: '' },          // HH:mm
      temperature: { type: Number, default: null },        // °C
      bloodPressure: { type: String, trim: true, default: '' }, // "120/80"
      heartRate: { type: Number, default: null },          // pulso lpm
      respiratoryRate: { type: Number, default: null },    // rpm
      oxygenSaturation: { type: Number, default: null },   // pulsioximetría %
      weight: { type: Number, default: null },             // kg
      height: { type: Number, default: null },             // cm
      abdominalPerimeter: { type: Number, default: null }, // perímetro abdominal cm
      capillaryHemoglobin: { type: Number, default: null },// hemoglobina capilar g/dL
      glucose: { type: Number, default: null },            // glucosa capilar mg/dL
    },
    // G. Revisión actual de órganos y sistemas (10 casillas MSP) + hallazgos
    // descritos (un solo campo al pie, igual que el examen físico).
    revisionSistemas: { type: [mspCheckSchema], default: [] },
    revisionSistemasHallazgos: { type: String, trim: true, default: '' },
    // H. Examen físico: regional (15) + sistémico (10) + hallazgos descritos.
    examenFisico: {
      regional: { type: [mspCheckSchema], default: [] },
      sistemico: { type: [mspCheckSchema], default: [] },
      hallazgos: { type: String, trim: true, default: '' },
    },
    // I. Diagnóstico(s) con CIE-10 (hasta 6).
    diagnosticos: { type: [diagnosticoSchema], default: [] },
    // J. Plan de tratamiento (diagnóstico, terapéutico y educacional). La receta
    // e insumos siguen en recetaItems; esto es el plan narrado del MSP.
    planTratamiento: { type: String, trim: true, default: '' },
    // Evolución del paciente respecto de las consultas anteriores. Va debajo
    // del plan y aplica a TODAS las especialidades, no solo a la consulta MSP.
    evolucion: { type: String, trim: true, default: '' },
    // Archivos PDF subidos por el doctor (ecografías, bioresonancias, etc.)
    attachments: [
      {
        filename: { type: String, required: true },
        originalName: { type: String, required: true },
        mimeType: { type: String, default: 'application/pdf' },
        size: { type: Number, default: 0 },
        uploadedAt: { type: Date, default: Date.now },
        uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      },
    ],
    // Datos ópticos (rol 'optica'). Columnas: SPH CYL AX ADD DNP ALT. Filas OD / OI.
    opticaRx: {
      od: {
        sph: { type: String, trim: true, default: '' },
        cyl: { type: String, trim: true, default: '' },
        ax: { type: String, trim: true, default: '' },
        add: { type: String, trim: true, default: '' },
        dnp: { type: String, trim: true, default: '' },
        alt: { type: String, trim: true, default: '' },
      },
      oi: {
        sph: { type: String, trim: true, default: '' },
        cyl: { type: String, trim: true, default: '' },
        ax: { type: String, trim: true, default: '' },
        add: { type: String, trim: true, default: '' },
        dnp: { type: String, trim: true, default: '' },
        alt: { type: String, trim: true, default: '' },
      },
    },
    // Datos ginecológicos (rol 'ginecologia'). Antecedentes y controles propios
    // de la consulta gineco-obstétrica.
    ginecologia: {
      // FUM: fecha de la última menstruación.
      fum: { type: Date, default: null },
      // G P A C: gestas, partos, abortos, cesáreas.
      gpac: {
        gestas: { type: Number, default: null, min: 0 },
        partos: { type: Number, default: null, min: 0 },
        abortos: { type: Number, default: null, min: 0 },
        cesareas: { type: Number, default: null, min: 0 },
      },
      // Embarazo actual: true = sí, false = no, null = no consignado.
      embarazoActual: { type: Boolean, default: null },
      // Peso ANTES del embarazo (kg). Con la talla da el IMC pregestacional,
      // que es el que fija cuánto peso debería subir en todo el embarazo.
      pesoPreconcepcional: { type: Number, default: null, min: 0 },
      // Métodos anticonceptivos en uso.
      metodosAnticonceptivos: {
        hormonal: { type: Boolean, default: false },
        barrera: { type: Boolean, default: false },
        diu: { type: Boolean, default: false },
        otro: { type: Boolean, default: false },
        otroDetalle: { type: String, trim: true, default: '' },
      },
      // Papanicolaou (PAP).
      pap: {
        // ¿PAP previo o primera vez?
        tipo: { type: String, enum: ['previo', 'primera_vez', ''], default: '' },
        // Toma de la muestra.
        toma: {
          exocervical: { type: Boolean, default: false },
          endocervical: { type: Boolean, default: false },
          otros: { type: Boolean, default: false },
          otrosDetalle: { type: String, trim: true, default: '' },
        },
      },
      // Control prenatal.
      controlPrenatal: {
        signosVitalesScore: { type: String, trim: true, default: '' },
        bebePosicion: { type: String, trim: true, default: '' },
        actividadCardiaca: { type: String, trim: true, default: '' },
      },
    },
    // Datos podológicos (rol 'podologia'). Hoja «Historia clínica podológica».
    podologia: {
      // Hallazgos generales: descripciones libres del pie.
      hallazgosGenerales: {
        piel: { type: String, trim: true, default: '' },
        unas: { type: String, trim: true, default: '' },
        hidratacion: { type: String, trim: true, default: '' },
        temperatura: { type: String, trim: true, default: '' },
        coloracion: { type: String, trim: true, default: '' },
        // Edema: true = sí, false = no, null = no consignado.
        edema: { type: Boolean, default: null },
        otros: { type: String, trim: true, default: '' },
      },
      // Evaluación vascular y neurológica.
      vascularNeurologica: {
        pulsoPedio: { type: String, enum: ['presente', 'ausente', ''], default: '' },
        pulsoTibialPosterior: { type: String, enum: ['presente', 'ausente', ''], default: '' },
        llenadoCapilar: { type: String, trim: true, default: '' },  // segundos
        sensibilidadMonofilamento: {
          type: String,
          enum: ['normal', 'disminuida', 'ausente', ''],
          default: '',
        },
        reflejos: { type: String, enum: ['presentes', 'ausentes', ''], default: '' },
      },
      // Evaluación podológica: tabla evaluación / observaciones.
      evaluacion: {
        piel: { type: String, trim: true, default: '' },
        unas: { type: String, trim: true, default: '' },
        pulsos: { type: String, trim: true, default: '' },
        sensibilidad: { type: String, trim: true, default: '' },
        calzado: { type: String, trim: true, default: '' },
        marcha: { type: String, trim: true, default: '' },
      },
      // Hallazgos podológicos: casillas (ver PODOLOGIA_HALLAZGOS) + descripción al pie.
      hallazgos: { type: [mspCheckSchema], default: [] },
      hallazgosDetalle: { type: String, trim: true, default: '' },
    },
    // Datos odontológicos (rol 'odontologia'). Odontograma en notación FDI: solo
    // se guardan las piezas con contenido, no las 52 del esquema.
    odontologia: {
      odontograma: {
        type: [odontogramaDienteSchema],
        default: [],
      },
      // Sección 7 · Indicadores de salud bucal.
      higieneOral: { type: [higieneOralFilaSchema], default: [] },
      enfermedadPeriodontal: { type: String, trim: true, default: '' },
      maloclusion: { type: String, trim: true, default: '' },
      fluorosis: { type: String, trim: true, default: '' },
      // Sección 8 · Índices CPO (permanentes) y ceo (temporales). Los TOTAL no se
      // guardan: son la suma y se calculan al mostrar, para que no puedan quedar
      // descuadrados respecto a sus sumandos.
      cpo: {
        c: { type: String, trim: true, default: '' },
        p: { type: String, trim: true, default: '' },
        o: { type: String, trim: true, default: '' },
      },
      ceo: {
        c: { type: String, trim: true, default: '' },
        e: { type: String, trim: true, default: '' },
        o: { type: String, trim: true, default: '' },
      },
      observaciones: { type: String, trim: true, default: '' },
    },
    // Datos cosmetológicos (rol 'cosmetologia'). Fichas estética facial y capilar.
    cosmetologia: {
      // Datos estéticos.
      datosEsteticos: {
        tratamientosEsteticos: { type: String, trim: true, default: '' },
        autotratamientos: { type: String, trim: true, default: '' },
        cosmeticosUsoActual: { type: String, trim: true, default: '' },
      },
      // Evaluación (facial).
      evaluacion: {
        fototipo: { type: String, trim: true, default: '' },   // I…VI (Fitzpatrick)
        glogau: { type: String, trim: true, default: '' },     // I…IV
        rosacea: { type: String, trim: true, default: '' },    // estadio I…IV
        biotipo: { type: [mspCheckSchema], default: [] },
        arrugas: { type: [mspCheckSchema], default: [] },
        acne: { type: [mspCheckSchema], default: [] },
        lesionesElementales: { type: [mspCheckSchema], default: [] },
        // Hiperpigmentaciones por zona; los tercios además marcan lado D / I.
        hiperpigmentaciones: {
          type: [
            {
              key: { type: String, required: true },
              marked: { type: Boolean, default: false },
              derecho: { type: Boolean, default: false },
              izquierdo: { type: Boolean, default: false },
              _id: false,
            },
          ],
          default: [],
        },
        deshidratacionFacial: {
          type: String,
          enum: ['leve', 'moderada', 'avanzada', ''],
          default: '',
        },
        bioestimulacion: { type: String, trim: true, default: '' },
        nutricionDermica: { type: String, trim: true, default: '' },
        observaciones: { type: String, trim: true, default: '' },
      },
      // Datos de higiene (capilar).
      higiene: {
        frecuenciaLavado: { type: String, trim: true, default: '' },
        shampoo: { type: String, trim: true, default: '' },
        acondicionador: { type: String, trim: true, default: '' },
        otros: { type: String, trim: true, default: '' },
      },
      // Características del cabello (opciones cerradas, ver COSMETOLOGIA_CABELLO).
      cabello: {
        longitud: { type: String, trim: true, default: '' },
        forma: { type: String, trim: true, default: '' },
        calibre: { type: String, trim: true, default: '' },
        densidad: { type: String, trim: true, default: '' },
        elasticidad: { type: String, trim: true, default: '' },
        color: { type: String, trim: true, default: '' },
        tratamientos: {
          alisados: { type: Boolean, default: false },
          planchas: { type: Boolean, default: false },
          secadores: { type: Boolean, default: false },
        },
      },
      // Características del cuero cabelludo.
      cueroCabelludo: {
        tipo: { type: String, trim: true, default: '' },
        glandulaSebacea: { type: String, trim: true, default: '' },
        sensibilidad: { type: String, trim: true, default: '' },
        movilidad: { type: String, trim: true, default: '' },
      },
      // Alteración de la fibra capilar y afecciones del cuero cabelludo. Van con
      // detalle por casilla porque la hoja deja una línea al lado de cada una
      // (en 'alopecia' ese detalle es el TIPO).
      fibraCapilar: { type: [mspCheckSchema], default: [] },
      afeccionesCuero: { type: [mspCheckSchema], default: [] },
      // Procedimiento y productos utilizados.
      procedimiento: {
        procedimiento: { type: String, trim: true, default: '' },
        productos: { type: String, trim: true, default: '' },
        apoyoDomiciliario: { type: String, trim: true, default: '' },
      },
    },
    // Mantenemos compat con tratamientos referenciados (auto-creados a partir de la receta).
    treatment: { type: mongoose.Schema.Types.ObjectId, ref: 'Treatment', default: null },
    autoTreatmentCreated: { type: mongoose.Schema.Types.ObjectId, ref: 'Treatment' },
    valor: { type: Number, default: 0, min: 0 },
    metodoPago: {
      type: String,
      enum: ['efectivo', 'tarjeta', 'transferencia', 'otro', ''],
      default: '',
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

const clinicalRecordSchema = new mongoose.Schema(
  {
    clinic: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Clinic',
      required: true,
      index: true,
    },
    patient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Patient',
      required: true,
    },
    // Ficha técnica
    fecha: { type: Date, default: Date.now },
    nombre: { type: String, trim: true },
    direccion: { type: String, trim: true },
    edad: { type: Number, min: 0, max: 150 },
    cedula: { type: String, trim: true },
    celular: { type: String, trim: true },
    // C. Antecedentes patológicos personales (10 categorías MSP).
    patologicosPersonales: { type: [mspCheckSchema], default: [] },
    // D. Antecedentes patológicos familiares (10 categorías MSP).
    patologicosFamiliares: { type: [mspCheckSchema], default: [] },
    // Pie de C: datos clínico-quirúrgicos, obstétricos y alérgicos relevantes.
    datosRelevantes: { type: String, trim: true, default: '' },
    // Pie de D: lo mismo, descrito para los antecedentes familiares.
    datosRelevantesFamiliares: { type: String, trim: true, default: '' },
    // Antecedentes libres (LEGACY — origen de migración a las listas estructuradas).
    antecedentesFamiliares: { type: String, trim: true, default: '' },
    antecedentesPatologicos: { type: String, trim: true, default: '' },
    // Seguimiento
    followUps: { type: [followUpSchema], default: [] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

clinicalRecordSchema.index({ clinic: 1, patient: 1 }, { unique: true });

module.exports = mongoose.model('ClinicalRecord', clinicalRecordSchema);
