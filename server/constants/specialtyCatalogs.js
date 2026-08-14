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

// Estado de la pieza. `tone` lo usa el cliente para colorear el diente.
const ODONTOGRAMA_ESTADOS = [
  { key: 'sano', label: 'Sano', tone: 'emerald' },
  { key: 'caries', label: 'Caries', tone: 'red' },
  { key: 'obturado', label: 'Obturado / restaurado', tone: 'blue' },
  { key: 'endodoncia', label: 'Endodoncia', tone: 'violet' },
  { key: 'corona', label: 'Corona', tone: 'amber' },
  { key: 'protesis', label: 'Prótesis', tone: 'amber' },
  { key: 'implante', label: 'Implante', tone: 'cyan' },
  { key: 'sellante', label: 'Sellante', tone: 'teal' },
  { key: 'fracturado', label: 'Fracturado', tone: 'orange' },
  { key: 'extraccionIndicada', label: 'Extracción indicada', tone: 'rose' },
  { key: 'ausente', label: 'Ausente', tone: 'slate' },
  { key: 'enErupcion', label: 'En erupción', tone: 'lime' },
];

// Caras de la pieza dental.
const ODONTOGRAMA_CARAS = [
  { key: 'vestibular', label: 'Vestibular' },
  { key: 'lingual', label: 'Lingual / palatina' },
  { key: 'mesial', label: 'Mesial' },
  { key: 'distal', label: 'Distal' },
  { key: 'oclusal', label: 'Oclusal / incisal' },
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
  { key: 'forma', label: 'Forma', options: ['lisotrico', 'cinotrico', 'ulotrico'] },
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

// Etiquetas legibles de las opciones cerradas (para la UI y los resúmenes).
const COSMETOLOGIA_OPTION_LABELS = {
  largo: 'Largo', medio: 'Medio', corto: 'Corto',
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
const COSMETOLOGIA_BIOTIPOS_KEYS = COSMETOLOGIA_BIOTIPOS.map((c) => c.key);
const COSMETOLOGIA_ARRUGAS_KEYS = COSMETOLOGIA_ARRUGAS.map((c) => c.key);
const COSMETOLOGIA_ACNE_KEYS = COSMETOLOGIA_ACNE.map((c) => c.key);
const COSMETOLOGIA_LESIONES_KEYS = COSMETOLOGIA_LESIONES.map((c) => c.key);
const COSMETOLOGIA_FIBRA_CAPILAR_KEYS = COSMETOLOGIA_FIBRA_CAPILAR.map((c) => c.key);
const COSMETOLOGIA_AFECCIONES_CUERO_KEYS = COSMETOLOGIA_AFECCIONES_CUERO.map((c) => c.key);
const ODONTOGRAMA_ESTADOS_KEYS = ODONTOGRAMA_ESTADOS.map((c) => c.key);
const ODONTOGRAMA_CARAS_KEYS = ODONTOGRAMA_CARAS.map((c) => c.key);

module.exports = {
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
};
