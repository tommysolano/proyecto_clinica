/**
 * Catálogos de las fichas por ESPECIALIDAD (podología, odontología, cosmetología).
 * Igual que mspCatalogs.js, estas listas son la fuente de verdad de las `key`
 * que se guardan en la base: el seguimiento solo persiste claves que estén aquí.
 *
 * IMPORTANTE: existe un espejo en client/src/constants/specialtyCatalogs.js. Si
 * cambias una `key` aquí, cámbiala también allá (y viceversa) o se romperá el mapeo.
 */

// ───────────────────────── Podología ─────────────────────────

// Hallazgos podológicos (casillas de la hoja «5. HALLAZGOS PODOLÓGICOS»).
const PODOLOGIA_HALLAZGOS = [
  { key: 'unaInvoluta', label: 'Uña involuta' },
  { key: 'onicocriptosis', label: 'Onicocriptosis' },
  { key: 'onicomicosis', label: 'Onicomicosis' },
  { key: 'onicogrifosis', label: 'Onicogrifosis' },
  { key: 'onicolisis', label: 'Onicólisis' },
  { key: 'helomaDuro', label: 'Heloma duro' },
  { key: 'helomaBlando', label: 'Heloma blando' },
  { key: 'hiperqueratosis', label: 'Hiperqueratosis' },
  { key: 'verrugaPlantar', label: 'Verruga plantar' },
  { key: 'fisuras', label: 'Fisuras' },
  { key: 'xerosis', label: 'Xerosis' },
  { key: 'bromhidrosis', label: 'Bromhidrosis' },
  { key: 'hiperhidrosis', label: 'Hiperhidrosis' },
  { key: 'otros', label: 'Otros' },
];

// Filas de la tabla «Evaluación podológica» (evaluación / observaciones).
const PODOLOGIA_EVALUACION = [
  { key: 'piel', label: 'Piel' },
  { key: 'unas', label: 'Uñas' },
  { key: 'pulsos', label: 'Pulsos' },
  { key: 'sensibilidad', label: 'Sensibilidad' },
  { key: 'calzado', label: 'Calzado' },
  { key: 'marcha', label: 'Marcha' },
];

// Campos de texto de «Hallazgos generales».
const PODOLOGIA_HALLAZGOS_GENERALES = [
  { key: 'piel', label: 'Piel' },
  { key: 'unas', label: 'Uñas' },
  { key: 'hidratacion', label: 'Hidratación' },
  { key: 'temperatura', label: 'Temperatura' },
  { key: 'coloracion', label: 'Coloración' },
  { key: 'otros', label: 'Otros' },
];

// Opciones cerradas de la evaluación vascular y neurológica.
const PODOLOGIA_PULSO_OPCIONES = ['presente', 'ausente'];
const PODOLOGIA_SENSIBILIDAD_OPCIONES = ['normal', 'disminuida', 'ausente'];
const PODOLOGIA_REFLEJOS_OPCIONES = ['presentes', 'ausentes'];

// ──────────────────────── Odontología ────────────────────────

// Odontograma en notación FDI, en el mismo orden en que se dibuja la hoja:
// permanentes superiores, temporales superiores, temporales inferiores y
// permanentes inferiores. Cada fila se parte en cuadrante derecho e izquierdo.
const ODONTOGRAMA_FILAS = [
  {
    key: 'permanentesSuperiores',
    label: 'Permanentes superiores',
    derecha: ['18', '17', '16', '15', '14', '13', '12', '11'],
    izquierda: ['21', '22', '23', '24', '25', '26', '27', '28'],
  },
  {
    key: 'temporalesSuperiores',
    label: 'Temporales superiores',
    derecha: ['55', '54', '53', '52', '51'],
    izquierda: ['61', '62', '63', '64', '65'],
  },
  {
    key: 'temporalesInferiores',
    label: 'Temporales inferiores',
    derecha: ['85', '84', '83', '82', '81'],
    izquierda: ['71', '72', '73', '74', '75'],
  },
  {
    key: 'permanentesInferiores',
    label: 'Permanentes inferiores',
    derecha: ['48', '47', '46', '45', '44', '43', '42', '41'],
    izquierda: ['31', '32', '33', '34', '35', '36', '37', '38'],
  },
];

// Todas las piezas válidas (la única lista contra la que se valida al guardar).
const ODONTOGRAMA_PIEZAS = ODONTOGRAMA_FILAS.flatMap((f) => [...f.derecha, ...f.izquierda]);

/**
 * Simbología del odontograma (sección 9 de la hoja del MSP).
 *
 * La hoja manda pintar en DOS colores y ese color es información clínica, no
 * decoración: `azul` = tratamiento ya realizado, `rojo` = patología actual. De
 * ahí sale el color; no se pide aparte.
 *
 * `ambito` dice sobre qué se aplica:
 *   'cara'  → se pinta un sector del diente (caries, obturado, sellante).
 *   'pieza' → es un símbolo sobre el diente entero (extracción, pérdida, corona…).
 *
 * `legacy: true` son las claves de la primera versión: siguen siendo válidas al
 * guardar para no romper lo ya registrado, pero no se ofrecen en el selector
 * porque la hoja del MSP distingue mejor (p. ej. 'protesis' → fija/removible/total).
 */
const ODONTOGRAMA_ESTADOS = [
  { key: 'sano', label: 'Sano', tone: 'emerald', color: 'neutro', ambito: 'pieza', simbolo: 'ninguno' },
  { key: 'caries', label: 'Caries', tone: 'red', color: 'rojo', ambito: 'cara', simbolo: 'circulo' },
  { key: 'obturado', label: 'Obturado / restaurado', tone: 'blue', color: 'azul', ambito: 'cara', simbolo: 'circulo' },
  { key: 'sellanteNecesario', label: 'Sellante necesario', tone: 'red', color: 'rojo', ambito: 'cara', simbolo: 'asterisco' },
  { key: 'sellanteRealizado', label: 'Sellante realizado', tone: 'blue', color: 'azul', ambito: 'cara', simbolo: 'asterisco' },
  { key: 'extraccionIndicada', label: 'Extracción indicada', tone: 'rose', color: 'rojo', ambito: 'pieza', simbolo: 'equis' },
  // Antes eran dos opciones, «Pérdida por caries» y «Pérdida (otra causa)». El
  // odontólogo pidió una sola: al marcar la pieza lo que importa es que NO está.
  // Se reaprovecha la clave 'ausente', que ya existía.
  { key: 'ausente', label: 'Ausencia', tone: 'slate', color: 'rojo', ambito: 'pieza', simbolo: 'equis' },
  { key: 'endodoncia', label: 'Endodoncia', tone: 'violet', color: 'rojo', ambito: 'pieza', simbolo: 'triangulo' },
  { key: 'corona', label: 'Corona', tone: 'amber', color: 'azul', ambito: 'pieza', simbolo: 'punto' },
  { key: 'protesisFija', label: 'Prótesis fija', tone: 'amber', color: 'rojo', ambito: 'pieza', simbolo: 'cajaGuiones' },
  { key: 'protesisRemovible', label: 'Prótesis removible', tone: 'amber', color: 'rojo', ambito: 'pieza', simbolo: 'guiones' },
  { key: 'protesisTotal', label: 'Prótesis total', tone: 'amber', color: 'rojo', ambito: 'pieza', simbolo: 'doblebarra' },
  // Claves de la primera versión: válidas al guardar, fuera del selector.
  { key: 'protesis', label: 'Prótesis', tone: 'amber', color: 'rojo', ambito: 'pieza', simbolo: 'guiones', legacy: true },
  { key: 'sellante', label: 'Sellante', tone: 'teal', color: 'azul', ambito: 'cara', simbolo: 'asterisco', legacy: true },
  { key: 'implante', label: 'Implante', tone: 'cyan', color: 'azul', ambito: 'pieza', simbolo: 'punto', legacy: true },
  { key: 'fracturado', label: 'Fracturado', tone: 'orange', color: 'rojo', ambito: 'pieza', simbolo: 'barra', legacy: true },
  { key: 'perdidaCaries', label: 'Pérdida por caries', tone: 'blue', color: 'azul', ambito: 'pieza', simbolo: 'equis', legacy: true },
  { key: 'perdidaOtra', label: 'Pérdida (otra causa)', tone: 'slate', color: 'rojo', ambito: 'pieza', simbolo: 'barra', legacy: true },
  { key: 'enErupcion', label: 'En erupción', tone: 'lime', color: 'neutro', ambito: 'pieza', simbolo: 'ninguno', legacy: true },
];

/** Los dos colores que el odontólogo puede elegir, y qué significa cada uno. */
const ODONTOGRAMA_COLOR_OPCIONES = [
  { key: 'azul', label: 'Azul', significado: 'tratamiento realizado', corto: 'realizado' },
  { key: 'rojo', label: 'Rojo', significado: 'patología actual', corto: 'patología' },
];

/**
 * UNA MARCA DEL ODONTOGRAMA SE GUARDA COMO «clave» o «clave:color».
 *
 * El color dejó de deducirse del símbolo (caries siempre rojo, obturado siempre
 * azul) y pasó a elegirlo el odontólogo, así que viaja pegado a la marca. Se usa
 * un sufijo dentro del mismo texto porque el esquema ya guarda `estado` y
 * `caras.*` como String libre: no hubo que migrar nada y lo anotado antes —sin
 * sufijo— se sigue leyendo con el color que tenía por convenio.
 *
 * ESPEJO de client/src/constants/specialtyCatalogs.js: si cambia allá, cambia acá.
 */
const marcaOdonto = (valor) => {
  const [key, color] = String(valor || '').split(':');
  const ficha = ODONTOGRAMA_ESTADOS.find((x) => x.key === key) || null;
  const explicito = ODONTOGRAMA_COLOR_OPCIONES.some((c) => c.key === color) ? color : '';
  return { key, ficha, explicito, color: explicito || ficha?.color || 'neutro' };
};

/**
 * Deja una marca lista para guardar: la clave tiene que estar en `clavesOk` y el
 * color, si viene, ser uno de los dos elegibles. Devuelve '' si no vale nada.
 *
 * Existe porque el saneador de la ficha compara la marca contra una lista blanca
 * de claves: sin esto, 'caries:azul' no figura en la lista y el servidor tiraba
 * la marca EN SILENCIO, con el odontólogo creyendo que la había guardado.
 */
const marcaValida = (valor, clavesOk) => {
  const { key, explicito } = marcaOdonto(valor);
  if (!key || !clavesOk.includes(key)) return '';
  return explicito ? `${key}:${explicito}` : key;
};

/** Etiqueta legible de una marca: el símbolo y, entre paréntesis, lo que dice su color. */
const labelOdonto = (valor) => {
  const { key, ficha, color } = marcaOdonto(valor);
  if (!key) return '';
  const nombre = ficha?.label || key;
  const c = ODONTOGRAMA_COLOR_OPCIONES.find((x) => x.key === color);
  return c ? `${nombre} (${c.corto})` : nombre;
};

// Caras de la pieza dental. El orden es el del dibujo: las 4 periféricas y el
// centro (`oclusal`), que es el sector central del esquema.
const ODONTOGRAMA_CARAS = [
  { key: 'vestibular', label: 'Vestibular' },
  { key: 'lingual', label: 'Lingual / palatina' },
  { key: 'mesial', label: 'Mesial' },
  { key: 'distal', label: 'Distal' },
  { key: 'oclusal', label: 'Oclusal / incisal' },
];

// Recesión y movilidad: la hoja las marca con "X" y admite grado 1, 2 ó 3.
const ODONTOGRAMA_GRADOS = ['1', '2', '3'];

/**
 * Sección 7 · Higiene oral simplificada (IHOS).
 *
 * Son seis sextantes y en cada uno se examina UNA pieza: la de referencia, su
 * alterna si falta, o la temporal en niños. Por eso la hoja imprime tres números
 * por fila y solo se llena la que se evaluó.
 */
const HIGIENE_ORAL_FILAS = [
  { key: 'sup_der', label: 'Superior derecho', piezas: ['16', '17', '55'] },
  { key: 'sup_ant', label: 'Superior anterior', piezas: ['11', '21', '51'] },
  { key: 'sup_izq', label: 'Superior izquierdo', piezas: ['26', '27', '65'] },
  { key: 'inf_izq', label: 'Inferior izquierdo', piezas: ['36', '37', '75'] },
  { key: 'inf_ant', label: 'Inferior anterior', piezas: ['31', '41', '71'] },
  { key: 'inf_der', label: 'Inferior derecho', piezas: ['46', '47', '85'] },
];

// Escalas de la hoja: placa y cálculo 0-3, gingivitis 0-1.
const HIGIENE_ORAL_INDICES = [
  { key: 'placa', label: 'Placa', valores: ['0', '1', '2', '3'] },
  { key: 'calculo', label: 'Cálculo', valores: ['0', '1', '2', '3'] },
  { key: 'gingivitis', label: 'Gingivitis', valores: ['0', '1'] },
];

const ENFERMEDAD_PERIODONTAL = [
  { key: 'leve', label: 'Leve' },
  { key: 'moderada', label: 'Moderada' },
  { key: 'severa', label: 'Severa' },
];

const MALOCLUSION = [
  { key: 'angleI', label: 'Angle I' },
  { key: 'angleII', label: 'Angle II' },
  { key: 'angleIII', label: 'Angle III' },
];

const FLUOROSIS = [
  { key: 'leve', label: 'Leve' },
  { key: 'moderada', label: 'Moderada' },
  { key: 'severa', label: 'Severa' },
];

/**
 * Sección 8 · Índices CPO / ceo. Mayúsculas = dentición permanente, minúsculas =
 * temporal. El TOTAL no se digita: es la suma de las tres columnas.
 */
const INDICE_CPO = [
  { key: 'c', label: 'C' },
  { key: 'p', label: 'P' },
  { key: 'o', label: 'O' },
];

const INDICE_CEO = [
  { key: 'c', label: 'c' },
  { key: 'e', label: 'e' },
  { key: 'o', label: 'o' },
];

// ─────────────────────── Cosmetología ────────────────────────

// Fototipo de piel (Fitzpatrick) y escala de Glogau.
const COSMETOLOGIA_FOTOTIPOS = ['I', 'II', 'III', 'IV', 'V', 'VI'];
const COSMETOLOGIA_GLOGAU = ['I', 'II', 'III', 'IV'];

const COSMETOLOGIA_BIOTIPOS = [
  { key: 'normal', label: 'Normal' },
  { key: 'seca', label: 'Seca' },
  { key: 'grasa', label: 'Grasa' },
  { key: 'mixta', label: 'Mixta' },
  { key: 'hidratada', label: 'Hidratada' },
  { key: 'deshidratada', label: 'Deshidratada' },
  { key: 'sensible', label: 'Sensible' },
  { key: 'asfictica', label: 'Asfíctica' },
];

const COSMETOLOGIA_ARRUGAS = [
  { key: 'finas', label: 'Finas' },
  { key: 'profundas', label: 'Profundas' },
  { key: 'patasGallo', label: 'Patas de gallo' },
  { key: 'marionetas', label: 'Marionetas' },
  { key: 'nasogenianos', label: 'Nasogenianos' },
  { key: 'lineasExpresion', label: 'Líneas de expresión' },
];

const COSMETOLOGIA_ACNE = [
  { key: 'preAcne', label: 'Pre-acné' },
  { key: 'tipoI', label: 'Acné tipo I' },
  { key: 'tipoII', label: 'Acné tipo II' },
  { key: 'conglobataIII', label: 'Acné conglobata III' },
  { key: 'secuelas', label: 'Secuelas de acné' },
];

const COSMETOLOGIA_ROSACEA = ['I', 'II', 'III', 'IV'];

const COSMETOLOGIA_LESIONES = [
  { key: 'cicatriz', label: 'Cicatriz' },
  { key: 'pustulas', label: 'Pústulas' },
  { key: 'papulas', label: 'Pápulas' },
  { key: 'abscesos', label: 'Abscesos' },
  { key: 'maculasPigmentarias', label: 'Máculas pigmentarias' },
  { key: 'melasma', label: 'Melasma' },
  { key: 'cloasma', label: 'Cloasma' },
  { key: 'nevos', label: 'Nevos' },
  { key: 'efelides', label: 'Efélides' },
  { key: 'acantosisNigricans', label: 'Acantosis nigricans' },
  { key: 'maculasVasculares', label: 'Máculas vasculares' },
  { key: 'eritema', label: 'Eritema' },
  { key: 'telangiectasias', label: 'Telangiectasias' },
  { key: 'nevoAcronico', label: 'Nevo acrónico' },
  { key: 'acromia', label: 'Acromía' },
  { key: 'vitiligo', label: 'Vitíligo' },
  { key: 'queratosis', label: 'Queratosis' },
  { key: 'roncha', label: 'Roncha' },
];

// Zonas de hiperpigmentación (la hoja marca lado D / I en los tercios).
const COSMETOLOGIA_HIPERPIGMENTACION = [
  { key: 'ovaloFacial', label: 'Óvalo facial', lados: false },
  { key: 'tercioSuperior', label: 'Tercio superior', lados: true },
  { key: 'tercioMedio', label: 'Tercio medio', lados: true },
  { key: 'tercioInferior', label: 'Tercio inferior', lados: true },
];

const COSMETOLOGIA_DESHIDRATACION = ['leve', 'moderada', 'avanzada'];

// Características del cabello: cada rasgo con sus opciones cerradas.
const COSMETOLOGIA_CABELLO = [
  { key: 'longitud', label: 'Longitud', options: ['largo', 'medio', 'corto'] },
  // Los nombres técnicos (lisótrico/cinótrico/ulótrico) se cambiaron por los de
  // uso diario a pedido de las cosmetólogas. Las claves viejas ya no se ofrecen,
  // pero siguen teniendo etiqueta en COSMETOLOGIA_OPTION_LABELS para que una
  // ficha anterior se lea igual que siempre.
  { key: 'forma', label: 'Forma', options: ['lacio', 'ondulado', 'rizado'] },
  { key: 'calibre', label: 'Calibre', options: ['grueso', 'mediano', 'fino'] },
  { key: 'densidad', label: 'Densidad', options: ['abundante', 'media', 'escasa'] },
  { key: 'elasticidad', label: 'Elasticidad', options: ['normal', 'media', 'reducida'] },
  { key: 'color', label: 'Color', options: ['natural', 'coloracion', 'decoloracion', 'cano'] },
];

// Tratamientos estéticos aplicados al cabello (casillas).
const COSMETOLOGIA_CABELLO_TRATAMIENTOS = [
  { key: 'alisados', label: 'Alisados' },
  { key: 'planchas', label: 'Planchas' },
  { key: 'secadores', label: 'Secadores' },
];

// Características del cuero cabelludo.
const COSMETOLOGIA_CUERO_CABELLUDO = [
  { key: 'tipo', label: 'Tipo', options: ['graso', 'normal', 'deshidratado'] },
  { key: 'glandulaSebacea', label: 'Glándula sebácea', options: ['normal', 'hipofuncionante', 'hiperfuncionante'] },
  { key: 'sensibilidad', label: 'Sensibilidad', options: ['normal', 'sensible', 'irritado'] },
  { key: 'movilidad', label: 'Movilidad', options: ['normal', 'media', 'reducida'] },
];

// Alteración de la fibra capilar. Cada casilla admite detalle (la hoja deja una
// línea para escribir al lado de cada alteración).
const COSMETOLOGIA_FIBRA_CAPILAR = [
  { key: 'tricoptilosis', label: 'Tricoptilosis' },
  { key: 'moniletrix', label: 'Moniletrix' },
  { key: 'tricodistrofia', label: 'Tricodistrofia' },
  { key: 'tricorrexis', label: 'Tricorrexis' },
  { key: 'tricorrexisNudosa', label: 'Tricorrexis nudosa' },
  { key: 'tricoclasia', label: 'Tricoclasia' },
  { key: 'tricomalacia', label: 'Tricomalacia' },
  { key: 'triconodosis', label: 'Triconodosis' },
  { key: 'peloLanoso', label: 'Pelo lanoso' },
  { key: 'peloEnfundado', label: 'Pelo enfundado' },
  { key: 'otras', label: 'Otras' },
];

// Afecciones del cuero cabelludo. 'alopecia' usa el detalle para el TIPO.
const COSMETOLOGIA_AFECCIONES_CUERO = [
  { key: 'deshidratacion', label: 'Deshidratación' },
  { key: 'pitiriasisSimple', label: 'Pitiriasis simple' },
  { key: 'pitiriasisEsteatoide', label: 'Pitiriasis esteatoide' },
  { key: 'dermatitisSeborreica', label: 'Dermatitis seborreica' },
  { key: 'dermatitisContacto', label: 'Dermatitis por contacto' },
  { key: 'psoriasis', label: 'Psoriasis' },
  { key: 'eczema', label: 'Eczema' },
  { key: 'seborrea', label: 'Seborrea' },
  { key: 'alopecia', label: 'Alopecia (indique tipo)' },
  { key: 'otras', label: 'Otras' },
];


// ───────────────────────── Cardiología ───────────────────────
//
// Hoja «Historia clínica cardiológica». En el seguimiento SOLO vive lo que el
// formulario general no captura ya: el motivo de consulta, la enfermedad
// actual, los signos vitales (PA/FC/SatO2/peso/talla/IMC), la impresión
// diagnóstica con CIE-10 y el plan narrado son campos del seguimiento común y
// aquí NO se repiten.

// Antecedentes relevantes: cada uno es Sí / No / sin consignar. Dejar constancia
// de que el paciente NO es hipertenso es un dato clínico, no un hueco.
const CARDIOLOGIA_ANTECEDENTES = [
  { key: 'hta', label: 'HTA' },
  { key: 'dm', label: 'DM' },
  { key: 'dislipidemia', label: 'Dislipidemia' },
  { key: 'cardiopatiaIsquemica', label: 'Cardiopatía isquémica' },
  { key: 'arritmias', label: 'Arritmias' },
  { key: 'insuficienciaCardiaca', label: 'Insuficiencia cardíaca' },
  { key: 'acvAit', label: 'ACV / AIT' },
  { key: 'erc', label: 'ERC' },
  { key: 'tabaquismo', label: 'Tabaquismo' },
];

// Estudios relevantes: una línea de resultado por estudio.
const CARDIOLOGIA_ESTUDIOS = [
  { key: 'ecocardiograma', label: 'Ecocardiograma' },
  { key: 'holter', label: 'Holter' },
  { key: 'mapa', label: 'MAPA' },
  { key: 'ergometria', label: 'Ergometría' },
  { key: 'laboratorio', label: 'Laboratorio' },
];

// Ritmo del electrocardiograma. Lista abierta: se puede elegir uno o escribirlo.
const CARDIOLOGIA_RITMOS = [
  'Sinusal',
  'Sinusal con extrasístoles',
  'Fibrilación auricular',
  'Flutter auricular',
  'Taquicardia supraventricular',
  'Ritmo de marcapasos',
  'Bloqueo AV',
];

// Etiquetas legibles de las opciones cerradas (para la UI y los resúmenes).
const COSMETOLOGIA_OPTION_LABELS = {
  largo: 'Largo', medio: 'Medio', corto: 'Corto',
  lacio: 'Lacio', ondulado: 'Ondulado', rizado: 'Rizado',
  // Formas del cabello de fichas antiguas (ya no se ofrecen al elegir).
  lisotrico: 'Lisótrico', cinotrico: 'Cinótrico', ulotrico: 'Ulótrico',
  grueso: 'Grueso', mediano: 'Mediano', fino: 'Fino',
  abundante: 'Abundante', media: 'Media', escasa: 'Escasa',
  normal: 'Normal', reducida: 'Reducida',
  natural: 'Natural', coloracion: 'Coloración', decoloracion: 'Decoloración', cano: 'Cano',
  graso: 'Graso', deshidratado: 'Deshidratado',
  hipofuncionante: 'Hipofuncionante', hiperfuncionante: 'Hiperfuncionante',
  sensible: 'Sensible', irritado: 'Irritado',
  leve: 'Leve', moderada: 'Moderada', avanzada: 'Avanzada',
  presente: 'Presente', ausente: 'Ausente',
  disminuida: 'Disminuida', presentes: 'Presentes', ausentes: 'Ausentes',
};

const PODOLOGIA_HALLAZGOS_KEYS = PODOLOGIA_HALLAZGOS.map((c) => c.key);
const CARDIOLOGIA_ANTECEDENTES_KEYS = CARDIOLOGIA_ANTECEDENTES.map((c) => c.key);
const CARDIOLOGIA_ESTUDIOS_KEYS = CARDIOLOGIA_ESTUDIOS.map((c) => c.key);
const COSMETOLOGIA_BIOTIPOS_KEYS = COSMETOLOGIA_BIOTIPOS.map((c) => c.key);
const COSMETOLOGIA_ARRUGAS_KEYS = COSMETOLOGIA_ARRUGAS.map((c) => c.key);
const COSMETOLOGIA_ACNE_KEYS = COSMETOLOGIA_ACNE.map((c) => c.key);
const COSMETOLOGIA_LESIONES_KEYS = COSMETOLOGIA_LESIONES.map((c) => c.key);
const COSMETOLOGIA_FIBRA_CAPILAR_KEYS = COSMETOLOGIA_FIBRA_CAPILAR.map((c) => c.key);
const COSMETOLOGIA_AFECCIONES_CUERO_KEYS = COSMETOLOGIA_AFECCIONES_CUERO.map((c) => c.key);
const ODONTOGRAMA_ESTADOS_KEYS = ODONTOGRAMA_ESTADOS.map((c) => c.key);
const ODONTOGRAMA_CARAS_KEYS = ODONTOGRAMA_CARAS.map((c) => c.key);
// Solo los estados que se pintan sobre una CARA; el resto son símbolos de pieza
// entera y guardarlos en una cara no significaría nada.
const ODONTOGRAMA_ESTADOS_CARA_KEYS = ODONTOGRAMA_ESTADOS.filter((e) => e.ambito === 'cara').map((e) => e.key);
const HIGIENE_ORAL_FILAS_KEYS = HIGIENE_ORAL_FILAS.map((f) => f.key);
const ENFERMEDAD_PERIODONTAL_KEYS = ENFERMEDAD_PERIODONTAL.map((c) => c.key);
const MALOCLUSION_KEYS = MALOCLUSION.map((c) => c.key);
const FLUOROSIS_KEYS = FLUOROSIS.map((c) => c.key);


// ───────────────────────── Terapia (rol 'terapeuta') ─────────────────────────
//
// La consulta del terapeuta no es la hoja MSP: no explora por sistemas, no
// diagnostica con CIE-10 y no describe una evolución. Lo suyo son tres cosas —
// cómo está el paciente en los CINCO ELEMENTOS, cómo se reparte su cuadro en
// cuatro cuadrantes, y el plan que sale de ahí—, así que su formulario se poda
// hasta dejar eso (ver `isTerapeuta` en PatientDetail).

/**
 * Los CINCO ELEMENTOS (Wu Xing), con su sitio en la rueda y su color.
 *
 * `letra` es lo que se pinta DENTRO del círculo. Madera y Metal comparten la M a
 * propósito: quien llena esta hoja las distingue por el COLOR —verde y blanco—,
 * que es como está impreso el esquema de toda la vida. Por eso el color no es
 * decoración: es la única forma de leer el gráfico.
 *
 * `x`/`y` son porcentajes del lienzo, en la posición del pentágono clásico:
 * Fuego arriba, Madera y Tierra a media altura, Agua y Metal abajo.
 */
const TERAPIA_ELEMENTOS = [
  { key: 'fuego',  label: 'Fuego',  letra: 'F', color: '#dc2626', texto: '#ffffff', x: 50, y: 12 },
  { key: 'tierra', label: 'Tierra', letra: 'T', color: '#eab308', texto: '#1f2937', x: 86, y: 42 },
  { key: 'metal',  label: 'Metal',  letra: 'M', color: '#ffffff', texto: '#1f2937', x: 72, y: 85 },
  { key: 'agua',   label: 'Agua',   letra: 'A', color: '#111827', texto: '#ffffff', x: 28, y: 85 },
  { key: 'madera', label: 'Madera', letra: 'M', color: '#16a34a', texto: '#ffffff', x: 14, y: 42 },
];

const TERAPIA_ELEMENTOS_KEYS = TERAPIA_ELEMENTOS.map((e) => e.key);

/**
 * Los dos ciclos del esquema, en pares [origen, destino].
 *
 *  · APOYO (generación): la rueda de fuera, en gris. La Madera alimenta al
 *    Fuego, el Fuego a la Tierra, y así hasta cerrar.
 *  · CONTROL (dominación): la estrella de dentro, en negro. Es la que cruza.
 *
 * Van aquí y no dibujadas a mano en el componente porque son el esquema, no un
 * adorno: si alguien corrige una flecha, la corrige en un solo sitio.
 */
const TERAPIA_CICLO_APOYO = [
  ['madera', 'fuego'], ['fuego', 'tierra'], ['tierra', 'metal'],
  ['metal', 'agua'], ['agua', 'madera'],
];
const TERAPIA_CICLO_CONTROL = [
  ['madera', 'tierra'], ['tierra', 'agua'], ['agua', 'fuego'],
  ['fuego', 'metal'], ['metal', 'madera'],
];

/**
 * Los cuatro cuadrantes del plan terapéutico. Se lee como un FODA: el cuadro del
 * paciente repartido en cuatro, y debajo el plan escrito que sale de ese reparto.
 */
const TERAPIA_FODA = [
  { key: 'desague', label: 'Desagüe' },
  { key: 'apreciacion', label: 'Apreciación' },
  { key: 'toxinas', label: 'Toxinas' },
  { key: 'bioRegeneracion', label: 'Bio-Regeneración' },
];

const TERAPIA_FODA_KEYS = TERAPIA_FODA.map((c) => c.key);

/**
 * HÁBITOS de la ficha del terapeuta. Sustituye a la rejilla de casillas de la
 * hoja MSP: aquí cada hábito se puntúa en un NIVEL (1, 2 o 3 — uno solo) y
 * además lleva una nota de lo que el paciente hace a diario.
 */
const TERAPIA_HABITOS_FILAS = [
  { key: 'digestion', label: 'Digestión' },
  { key: 'sueno', label: 'Sueño' },
  { key: 'toxinas', label: 'Toxinas' },
  { key: 'alimentacion', label: 'Alimentación' },
  { key: 'estres', label: 'Estrés' },
];

const TERAPIA_HABITOS_FILAS_KEYS = TERAPIA_HABITOS_FILAS.map((f) => f.key);

// Los niveles son EXCLUYENTES: marcar el 2 desmarca el 1. Es una escala, no tres
// casillas sueltas.
const TERAPIA_HABITOS_NIVELES = ['1', '2', '3'];

module.exports = {
  CARDIOLOGIA_ANTECEDENTES,
  CARDIOLOGIA_ANTECEDENTES_KEYS,
  CARDIOLOGIA_ESTUDIOS,
  CARDIOLOGIA_ESTUDIOS_KEYS,
  CARDIOLOGIA_RITMOS,
  PODOLOGIA_HALLAZGOS,
  PODOLOGIA_HALLAZGOS_KEYS,
  PODOLOGIA_EVALUACION,
  PODOLOGIA_HALLAZGOS_GENERALES,
  PODOLOGIA_PULSO_OPCIONES,
  PODOLOGIA_SENSIBILIDAD_OPCIONES,
  PODOLOGIA_REFLEJOS_OPCIONES,
  ODONTOGRAMA_FILAS,
  ODONTOGRAMA_PIEZAS,
  ODONTOGRAMA_ESTADOS,
  ODONTOGRAMA_ESTADOS_KEYS,
  ODONTOGRAMA_CARAS,
  ODONTOGRAMA_CARAS_KEYS,
  ODONTOGRAMA_ESTADOS_CARA_KEYS,
  ODONTOGRAMA_GRADOS,
  HIGIENE_ORAL_FILAS,
  HIGIENE_ORAL_FILAS_KEYS,
  HIGIENE_ORAL_INDICES,
  ENFERMEDAD_PERIODONTAL,
  ENFERMEDAD_PERIODONTAL_KEYS,
  MALOCLUSION,
  MALOCLUSION_KEYS,
  FLUOROSIS,
  FLUOROSIS_KEYS,
  INDICE_CPO,
  INDICE_CEO,
  ODONTOGRAMA_COLOR_OPCIONES,
  marcaOdonto,
  marcaValida,
  labelOdonto,
  COSMETOLOGIA_FOTOTIPOS,
  COSMETOLOGIA_GLOGAU,
  COSMETOLOGIA_BIOTIPOS,
  COSMETOLOGIA_BIOTIPOS_KEYS,
  COSMETOLOGIA_ARRUGAS,
  COSMETOLOGIA_ARRUGAS_KEYS,
  COSMETOLOGIA_ACNE,
  COSMETOLOGIA_ACNE_KEYS,
  COSMETOLOGIA_ROSACEA,
  COSMETOLOGIA_LESIONES,
  COSMETOLOGIA_LESIONES_KEYS,
  COSMETOLOGIA_HIPERPIGMENTACION,
  COSMETOLOGIA_DESHIDRATACION,
  COSMETOLOGIA_CABELLO,
  COSMETOLOGIA_CABELLO_TRATAMIENTOS,
  COSMETOLOGIA_CUERO_CABELLUDO,
  COSMETOLOGIA_FIBRA_CAPILAR,
  COSMETOLOGIA_FIBRA_CAPILAR_KEYS,
  COSMETOLOGIA_AFECCIONES_CUERO,
  COSMETOLOGIA_AFECCIONES_CUERO_KEYS,
  COSMETOLOGIA_OPTION_LABELS,
  TERAPIA_ELEMENTOS,
  TERAPIA_ELEMENTOS_KEYS,
  TERAPIA_CICLO_APOYO,
  TERAPIA_CICLO_CONTROL,
  TERAPIA_FODA,
  TERAPIA_FODA_KEYS,
  TERAPIA_HABITOS_FILAS,
  TERAPIA_HABITOS_FILAS_KEYS,
  TERAPIA_HABITOS_NIVELES,
};
