const mongoose = require('mongoose');

/**
 * Una ampolla o molécula que va DENTRO de un suero.
 *
 * `code` es el código del catálogo de sueroterapia, que es el mismo con el que
 * la ampolla está dada de alta en el inventario (índice único clinic+code): por
 * ahí se la descuenta cuando se aplica. Puede venir vacío —el médico escribió
 * algo que no está en la lista— y eso NO invalida la receta: se receta igual y
 * simplemente no hay stock que mover.
 *
 * Se guarda el NOMBRE además del código porque es un registro clínico: si mañana
 * cambian el catálogo, la receta tiene que seguir diciendo qué se recetó.
 */
const suerocomponenteSchema = new mongoose.Schema(
  {
    code: { type: String, trim: true, default: '' },
    name: { type: String, trim: true, required: true },
    grupo: { type: String, enum: ['ampolla', 'molecula', 'otro'], default: 'otro' },
    quantity: { type: Number, default: 1, min: 0 },
  },
  { _id: false }
);

/**
 * Lo que REALMENTE se puso en una dosis concreta de suero.
 *
 * El paciente puede negarse a una ampolla en el momento: el doctor recetó tres y
 * él solo quiere dos. Enfermería aplica las dos, deja constancia de la que no se
 * puso y del motivo, y del inventario sale únicamente lo aplicado. Sin esto la
 * única opción era mentir en el registro o descontar algo que sigue en la percha.
 */
const suerocomponenteAplicadoSchema = new mongoose.Schema(
  {
    code: { type: String, trim: true, default: '' },
    name: { type: String, trim: true, default: '' },
    grupo: { type: String, trim: true, default: '' },
    // Lo que decía la receta y lo que se puso. Se guardan los DOS: "se puso 1 de
    // 2" es un dato clínico distinto de "se recetó 1".
    quantityPrescribed: { type: Number, default: 0, min: 0 },
    quantityApplied: { type: Number, default: 0, min: 0 },
    // Por qué no se puso (o se puso menos). Vacío cuando se puso todo.
    omitReason: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

/**
 * UNA aplicación de enfermería, copiada al seguimiento del enfermero.
 *
 * Es el mismo contenido que una entrada de `recetaItems[].administrations`, pero
 * guardado donde se lee: en la tarjeta del turno de enfermería. Se copia en vez
 * de referenciarse porque una historia clínica tiene que decir lo que se hizo
 * ese día aunque después se corrija la receta.
 */
const aplicacionEnfermeriaSchema = new mongoose.Schema(
  {
    // Nombre del suero/servicio aplicado (snapshot).
    itemName: { type: String, trim: true, default: '' },
    // Volumen de cloruro de ESTA dosis. null cuando no es un suero.
    baseVolumeMl: { type: Number, default: null },
    baseName: { type: String, trim: true, default: '' },
    // Las ampollas y moléculas, con lo recetado y lo puesto.
    components: { type: [suerocomponenteAplicadoSchema], default: [] },
    note: { type: String, trim: true, default: '' },
    at: { type: Date, default: null },
    // Quién la puso. `byName` es snapshot: si esa persona se va, la aplicación
    // tiene que seguir diciendo quién fue.
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    byName: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

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

    /**
     * SUERO (u otra aplicación que se administra por dosis).
     *
     * El doctor receta, por ejemplo, 7 sueros; enfermería los va poniendo a lo
     * largo de varios días y cada aplicación queda anotada aquí. Es lo que
     * permite decir "3 de 7 administrados, faltan 4" sin llevar la cuenta en un
     * papel — que es como se llevaba, y por eso se perdía.
     */
    isSerum: { type: Boolean, default: false },

    /**
     * COMPOSICIÓN DEL SUERO. El cloruro es la base y va en todos (lo único que
     * se elige es el volumen de la bolsa); dentro van las ampollas y moléculas
     * que el médico decide. Enfermería tiene que leerlo EXACTAMENTE como se
     * escribió: es lo que entra por la vena.
     *
     * Solo tiene sentido con `isSerum`; en cualquier otro ítem va vacío.
     */
    serumBase: {
      name: { type: String, trim: true, default: '' },   // 'Cloruro'
      volumeMl: { type: Number, default: null },         // 100 | 250 | 500 | 1000
    },
    serumComponents: { type: [suerocomponenteSchema], default: [] },

    administrations: [
      {
        at: { type: Date, default: Date.now },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        // Snapshot: si esa persona deja la clínica, la aplicación tiene que
        // seguir diciendo quién la puso. Es un registro clínico.
        byName: { type: String, trim: true, default: '' },
        note: { type: String, trim: true, default: '' },
        // Volumen de cloruro que se puso en ESTA dosis (puede diferir del
        // recetado: la bolsa que había, lo que toleró el paciente…).
        baseVolumeMl: { type: Number, default: null },
        // Qué ampollas/moléculas se pusieron de verdad y cuáles no.
        components: { type: [suerocomponenteAplicadoSchema], default: [] },
        /**
         * Inventario movido por ESTA dosis. Se guarda para poder deshacerla
         * exactamente: sin esto, "deshacer" tendría que volver a adivinar qué se
         * descontó, y si entretanto cambió la receta devolvería al stock algo
         * que nunca salió.
         */
        stockMoves: [
          {
            product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
            quantity: { type: Number, default: 0, min: 0 },
            _id: false,
          },
        ],
      },
    ],

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

/**
 * Antecedente cardiológico: Sí / No / sin consignar.
 *
 * NO es un `mspCheckSchema` (que es booleano) a propósito: en cardiología dejar
 * escrito que el paciente NO es hipertenso es un hallazgo, no la ausencia de un
 * dato. Con un booleano, "no marcado" y "consta que no" serían indistinguibles.
 */
const cardioAntecedenteSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    value: { type: Boolean, default: null },
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
    /**
     * Tipo de entrada de seguimiento:
     *   ''            consulta normal (doctor o especialidad);
     *   'enfermeria'  aplicación registrada por enfermería;
     *   'estudio'     ecografía, laboratorio o cualquier estudio que se resuelve
     *                 subiendo el archivo y escribiendo la impresión
     *                 diagnóstica. NO lleva motivo de consulta: quien hace el
     *                 estudio no está haciendo una consulta.
     */
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
    // Recomendaciones NO farmacológicas: dieta, ejercicio, higiene del sueño,
    // reposo… Va justo debajo del plan y es deliberadamente un campo aparte: lo
    // que el paciente tiene que hacer por su cuenta se le entrega y se le
    // explica distinto de lo que tiene que tomar, y mezclado en el plan se
    // perdía entre los fármacos.
    recomendacionesNoFarmacologicas: { type: String, trim: true, default: '' },
    // Evolución del paciente respecto de las consultas anteriores. Va debajo
    // del plan y aplica a TODAS las especialidades, no solo a la consulta MSP.
    evolucion: { type: String, trim: true, default: '' },
    /**
     * INDICACIONES de quien hizo el estudio. Campo aparte de `evolucion` porque
     * no dicen lo mismo: la evolución es cómo va el paciente respecto de sus
     * controles; esto es lo que se observa y se recomienda a partir de la imagen
     * que se acaba de tomar.
     *
     * En la pestaña de Archivos se rotula «Impresión diagnóstica», que es como
     * lo llama quien hace ecografías. Es el mismo campo a propósito: quien lea
     * la ficha después tiene que ver lo que dijo el estudio sin abrir el PDF, y
     * eso vale igual venga de un seguimiento o de un archivo suelto.
     */
    indicaciones: { type: String, trim: true, default: '' },
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
        // Texto libre de las fichas anteriores al Score MAMÁ. Se conserva para
        // que los seguimientos ya guardados se sigan leyendo; los nuevos usan
        // `scoreMama`.
        signosVitalesScore: { type: String, trim: true, default: '' },
        // SCORE MAMÁ (MSP · Gerencia Institucional de Disminución Acelerada de
        // Muerte Materna). Se guarda el DETALLE, no solo el total: la puntuación
        // de cada parámetro es lo que justifica la decisión clínica, y si mañana
        // cambian los cortes de la tabla los seguimientos viejos tienen que
        // seguir mostrando lo que se puntuó ese día.
        scoreMama: {
          // Valores medidos (los mismos que los signos vitales del seguimiento;
          // se copian aquí para que el score quede íntegro por sí solo).
          fc: { type: Number, default: null },
          sistolica: { type: Number, default: null },
          diastolica: { type: Number, default: null },
          fr: { type: Number, default: null },
          temperatura: { type: Number, default: null },
          saturacion: { type: Number, default: null },
          // 'alerta' | 'confusa' | 'voz' | 'dolor' | 'no_responde'
          conciencia: { type: String, trim: true, default: '' },
          // 'negativa' | 'positiva'
          proteinuria: { type: String, trim: true, default: '' },
          // Puntaje parcial por parámetro, con la misma clave que arriba.
          puntajes: {
            fc: { type: Number, default: null },
            sistolica: { type: Number, default: null },
            diastolica: { type: Number, default: null },
            fr: { type: Number, default: null },
            temperatura: { type: Number, default: null },
            saturacion: { type: Number, default: null },
            conciencia: { type: Number, default: null },
            proteinuria: { type: Number, default: null },
          },
          total: { type: Number, default: null },
        },
        bebePosicion: { type: String, trim: true, default: '' },
        actividadCardiaca: { type: String, trim: true, default: '' },
      },
    },
    // Datos cardiológicos (rol 'cardiologia'). Hoja «Historia clínica
    // cardiológica». Solo lo que el seguimiento general NO captura ya: el
    // motivo, la enfermedad actual, los signos vitales, la impresión
    // diagnóstica (CIE-10) y el plan narrado son campos comunes y no se repiten.
    cardiologia: {
      antecedentes: { type: [cardioAntecedenteSchema], default: [] },
      antecedentesOtros: { type: String, trim: true, default: '' },
      alergias: { type: String, trim: true, default: '' },
      medicacionActual: { type: String, trim: true, default: '' },
      electrocardiograma: {
        ritmo: { type: String, trim: true, default: '' },
        fc: { type: Number, default: null },
        hallazgos: { type: String, trim: true, default: '' },
      },
      // Resultado de cada estudio (ver CARDIOLOGIA_ESTUDIOS).
      estudios: {
        ecocardiograma: { type: String, trim: true, default: '' },
        holter: { type: String, trim: true, default: '' },
        mapa: { type: String, trim: true, default: '' },
        ergometria: { type: String, trim: true, default: '' },
        laboratorio: { type: String, trim: true, default: '' },
      },
      plan: {
        estudiosSolicitados: { type: String, trim: true, default: '' },
        proximoControl: { type: String, trim: true, default: '' },
      },
    },
    /**
     * CONSULTA DEL TERAPEUTA (rol 'terapeuta'). PRIVADA.
     *
     * Su hoja no es la MSP: no explora por sistemas, no diagnostica con CIE-10 y
     * no narra una evolución. Son tres cosas y ya —cómo está el paciente en los
     * cinco elementos, cómo se reparte su cuadro en cuatro cuadrantes, y el plan
     * que sale de ahí—, y no las ve nadie más que él y la administración
     * (ver `hideTherapyNotes` en el controlador).
     */
    terapia: {
      // Un texto por elemento (ver TERAPIA_ELEMENTOS). Solo se guardan los que
      // tienen algo escrito.
      elementos: {
        type: [new mongoose.Schema(
          {
            key: { type: String, required: true },
            texto: { type: String, trim: true, default: '' },
          },
          { _id: false }
        )],
        default: [],
      },
      /**
       * Las FLECHAS que dibujó el terapeuta sobre el esquema, en unidades del
       * lienzo (141 × 100, ver `CincoElementos.jsx`).
       *
       * Antes las dos ruedas clásicas se pintaban solas e iguales en todas las
       * consultas; ahora el lienzo nace limpio y cada uno traza las relaciones
       * de SU paciente, así que hay que guardarlas. `tipo` es cuál de los dos
       * ciclos: 'apoyo' (gris) o 'control' (negra).
       */
      flechas: {
        type: [new mongoose.Schema(
          {
            x1: { type: Number, required: true },
            y1: { type: Number, required: true },
            x2: { type: Number, required: true },
            y2: { type: Number, required: true },
            tipo: { type: String, enum: ['apoyo', 'control'], default: 'control' },
          },
          { _id: false }
        )],
        default: [],
      },
      // Los cuatro cuadrantes del plan (ver TERAPIA_FODA).
      foda: {
        desague: { type: String, trim: true, default: '' },
        apreciacion: { type: String, trim: true, default: '' },
        toxinas: { type: String, trim: true, default: '' },
        bioRegeneracion: { type: String, trim: true, default: '' },
      },
      // El plan escrito que sale del reparto de arriba. Sustituye al «plan de
      // tratamiento» de la hoja MSP, que al terapeuta no se le pide.
      plan: { type: String, trim: true, default: '' },
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
    /**
     * ROL con el que se escribió el seguimiento ('odontologia', 'doctor',
     * 'enfermero'…). No se deduce del usuario al leer: la misma persona puede
     * tener un rol distinto en cada sucursal, y mañana otro. Lo que hace falta
     * saber es con qué sombrero se escribió ESTA consulta.
     *
     * Nace para que el odontólogo vea su historia sin las consultas de las demás
     * especialidades. Los seguimientos anteriores a este campo lo tienen vacío;
     * quien filtre tiene que aceptar eso y caer al contenido (ver
     * `odontologiaHasData` en el cliente), no esconderlos.
     */
    createdByRole: { type: String, trim: true, default: '' },
    /**
     * EDICIÓN POSTERIOR. Un seguimiento se puede corregir o ampliar después de
     * guardarlo —el doctor mandó algo por error, o se acordó de un dato—, pero
     * es historia clínica: `createdBy` NO se toca nunca (de él sale la firma
     * electrónica de la receta) y queda constancia de quién lo cambió y cuándo.
     * Mismo patrón que las observaciones del paciente.
     */
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    editedAt: { type: Date, default: null },
    /**
     * QUÉ APLICÓ ENFERMERÍA, en sus propias palabras y con sus cantidades.
     *
     * Lo escribe SOLO el servidor al cerrar el turno de enfermería. Sin esto la
     * tarjeta del seguimiento decía «Servicio aplicado por enfermería» y nada
     * más: la aplicación real vive en `recetaItems[].administrations` del
     * seguimiento del DOCTOR que lo recetó, que es otra tarjeta y otro día.
     *
     * Es una FOTO, no una referencia: si mañana se corrige la receta, lo que se
     * puso sigue diciendo lo que se puso.
     */
    aplicaciones: { type: [aplicacionEnfermeriaSchema], default: [] },
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

    /**
     * ANTECEDENTES QUE NO CABEN EN LAS 10 CASILLAS DEL MSP.
     *
     * La hoja oficial mete cirugías, medicación y alergias en un único renglón
     * de "datos relevantes" al pie de C. En la práctica son tres preguntas
     * distintas que se hacen en tres momentos distintos, y escritas en el mismo
     * párrafo se pierden: la alergia a un fármaco es lo primero que hay que
     * mirar antes de recetar, y estaba a la altura de una nota suelta.
     *
     * `datosRelevantes` se conserva tal cual: sigue siendo el pie de C de la hoja
     * MSP y las fichas ya escritas lo tienen relleno.
     */
    // Cirugías previas (con año si se sabe).
    antecedentesQuirurgicos: { type: String, trim: true, default: '' },
    // Medicación habitual: lo que el paciente YA toma antes de esta consulta.
    antecedentesMedicamentos: { type: String, trim: true, default: '' },
    // Alergias: medicamentosas, alimentarias, ambientales.
    alergias: { type: String, trim: true, default: '' },
    // Hábitos (tabaco, alcohol, drogas…). Casillas con detalle propio: "fuma"
    // sin el "10 al día" no sirve para nada clínico.
    habitos: { type: [mspCheckSchema], default: [] },
    habitosDetalle: { type: String, trim: true, default: '' },
    // Antecedentes libres (LEGACY — origen de migración a las listas estructuradas).
    antecedentesFamiliares: { type: String, trim: true, default: '' },
    antecedentesPatologicos: { type: String, trim: true, default: '' },

    /**
     * LA FICHA DEL TERAPEUTA. Vive APARTE de la hoja MSP a propósito.
     *
     * No es «la ficha con un par de campos más»: el terapeuta no llena la hoja
     * oficial y sus antecedentes son suyos. Y sobre todo, esto es PRIVADO —solo
     * lo ven él y la administración (ver `hideTherapyNotes`)—, así que tiene que
     * poder recortarse de un tajo. Mezclado dentro de los campos de la hoja MSP
     * habría que ir campo por campo decidiendo cuál es de quién, y el día que se
     * añadiera uno nuevo se escaparía.
     *
     * Los antecedentes repiten la forma de la hoja MSP a propósito: el terapeuta
     * pregunta lo mismo, y así el catálogo de categorías es el mismo.
     */
    fichaTerapia: {
      patologicosPersonales: { type: [mspCheckSchema], default: [] },
      patologicosFamiliares: { type: [mspCheckSchema], default: [] },
      datosRelevantes: { type: String, trim: true, default: '' },
      datosRelevantesFamiliares: { type: String, trim: true, default: '' },
      antecedentesQuirurgicos: { type: String, trim: true, default: '' },
      antecedentesMedicamentos: { type: String, trim: true, default: '' },
      alergias: { type: String, trim: true, default: '' },
      /**
       * HÁBITOS, en tabla. Sustituye a la rejilla de casillas de la hoja MSP:
       * una fila por hábito (digestión, sueño, toxinas, alimentación, estrés),
       * un NIVEL excluyente del 1 al 3, y lo que el paciente hace a diario.
       */
      habitos: {
        type: [new mongoose.Schema(
          {
            fila: { type: String, required: true },
            // '1' | '2' | '3' | '' — uno solo: es una escala, no tres casillas.
            nivel: { type: String, trim: true, default: '' },
            diario: { type: String, trim: true, default: '' },
          },
          { _id: false }
        )],
        default: [],
      },
      habitosDetalle: { type: String, trim: true, default: '' },
      // Quién y cuándo tocó esta ficha por última vez. Va aparte de `updatedBy`
      // del documento: esta ficha la escribe otra persona y en otro momento.
      updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      updatedAt: { type: Date, default: null },
    },
    // Seguimiento
    followUps: { type: [followUpSchema], default: [] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

clinicalRecordSchema.index({ clinic: 1, patient: 1 }, { unique: true });

module.exports = mongoose.model('ClinicalRecord', clinicalRecordSchema);
