/**
 * Espejo de server/constants/specialtyCatalogs.js (fichas por especialidad:
 * podología, odontología y cosmetología). Las `key` DEBEN coincidir con las del
 * servidor: son las que se guardan en la base y las que valida el backend.
 */

// ───────────────────────── Podología ─────────────────────────

// Hallazgos podológicos (casillas de la hoja «5. HALLAZGOS PODOLÓGICOS»).
export const PODOLOGIA_HALLAZGOS = [
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
export const PODOLOGIA_EVALUACION = [
  { key: 'piel', label: 'Piel' },
  { key: 'unas', label: 'Uñas' },
  { key: 'pulsos', label: 'Pulsos' },
  { key: 'sensibilidad', label: 'Sensibilidad' },
  { key: 'calzado', label: 'Calzado' },
  { key: 'marcha', label: 'Marcha' },
];

// Campos de texto de «Hallazgos generales».
export const PODOLOGIA_HALLAZGOS_GENERALES = [
  { key: 'piel', label: 'Piel' },
  { key: 'unas', label: 'Uñas' },
  { key: 'hidratacion', label: 'Hidratación' },
  { key: 'temperatura', label: 'Temperatura' },
  { key: 'coloracion', label: 'Coloración' },
  { key: 'otros', label: 'Otros' },
];

export const PODOLOGIA_PULSO_OPCIONES = ['presente', 'ausente'];
export const PODOLOGIA_SENSIBILIDAD_OPCIONES = ['normal', 'disminuida', 'ausente'];
export const PODOLOGIA_REFLEJOS_OPCIONES = ['presentes', 'ausentes'];

// ──────────────────────── Odontología ────────────────────────

// Odontograma en notación FDI, en el mismo orden en que se dibuja la hoja.
export const ODONTOGRAMA_FILAS = [
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

export const ODONTOGRAMA_PIEZAS = ODONTOGRAMA_FILAS.flatMap((f) => [...f.derecha, ...f.izquierda]);

/**
 * Simbología del odontograma (sección 9 de la hoja del MSP).
 *
 * El color es información clínica, no adorno: `azul` = tratamiento ya realizado,
 * `rojo` = patología actual. `ambito` dice si se pinta un sector del diente
 * ('cara') o si es un símbolo sobre la pieza entera ('pieza').
 *
 * `legacy: true` son las claves de la primera versión: se siguen entendiendo al
 * leer lo ya guardado, pero no se ofrecen en el selector.
 */
export const ODONTOGRAMA_ESTADOS = [
  { key: 'sano', label: 'Sano', tone: 'emerald', color: 'neutro', ambito: 'pieza', simbolo: 'ninguno' },
  { key: 'caries', label: 'Caries', tone: 'red', color: 'rojo', ambito: 'cara', simbolo: 'circulo' },
  { key: 'obturado', label: 'Obturado / restaurado', tone: 'blue', color: 'azul', ambito: 'cara', simbolo: 'circulo' },
  { key: 'sellanteNecesario', label: 'Sellante necesario', tone: 'red', color: 'rojo', ambito: 'cara', simbolo: 'cuadro' },
  { key: 'sellanteRealizado', label: 'Sellante realizado', tone: 'blue', color: 'azul', ambito: 'cara', simbolo: 'cuadro' },
  { key: 'extraccionIndicada', label: 'Extracción indicada', tone: 'rose', color: 'rojo', ambito: 'pieza', simbolo: 'equis' },
  // Antes eran dos opciones, «Pérdida por caries» y «Pérdida (otra causa)». El
  // odontólogo pidió una sola: al marcar la pieza lo que importa es que NO está,
  // y la causa, si hace falta, va en la nota de la pieza. Se reaprovecha la clave
  // 'ausente' —que ya existía— en vez de inventar una tercera sinónima, así que
  // lo guardado hace tiempo con esa clave se sigue viendo con la etiqueta nueva.
  { key: 'ausente', label: 'Ausencia', tone: 'slate', color: 'rojo', ambito: 'pieza', simbolo: 'equis' },
  { key: 'endodoncia', label: 'Endodoncia', tone: 'violet', color: 'rojo', ambito: 'pieza', simbolo: 'triangulo' },
  { key: 'corona', label: 'Corona', tone: 'amber', color: 'azul', ambito: 'pieza', simbolo: 'punto' },
  { key: 'protesisFija', label: 'Prótesis fija', tone: 'amber', color: 'rojo', ambito: 'pieza', simbolo: 'cajaGuiones' },
  { key: 'protesisRemovible', label: 'Prótesis removible', tone: 'amber', color: 'rojo', ambito: 'pieza', simbolo: 'guiones' },
  { key: 'protesisTotal', label: 'Prótesis total', tone: 'amber', color: 'rojo', ambito: 'pieza', simbolo: 'doblebarra' },
  { key: 'protesis', label: 'Prótesis', tone: 'amber', color: 'rojo', ambito: 'pieza', simbolo: 'guiones', legacy: true },
  { key: 'sellante', label: 'Sellante', tone: 'teal', color: 'azul', ambito: 'cara', simbolo: 'cuadro', legacy: true },
  { key: 'implante', label: 'Implante', tone: 'cyan', color: 'azul', ambito: 'pieza', simbolo: 'punto', legacy: true },
  { key: 'fracturado', label: 'Fracturado', tone: 'orange', color: 'rojo', ambito: 'pieza', simbolo: 'barra', legacy: true },
  // Las dos pérdidas que sustituyó «Ausencia»: fuera del selector, pero se
  // siguen leyendo con su etiqueta original para no reescribir la historia de
  // una ficha ya firmada.
  { key: 'perdidaCaries', label: 'Pérdida por caries', tone: 'blue', color: 'azul', ambito: 'pieza', simbolo: 'equis', legacy: true },
  { key: 'perdidaOtra', label: 'Pérdida (otra causa)', tone: 'slate', color: 'rojo', ambito: 'pieza', simbolo: 'barra', legacy: true },
  { key: 'enErupcion', label: 'En erupción', tone: 'lime', color: 'neutro', ambito: 'pieza', simbolo: 'ninguno', legacy: true },
];

// Los estados que se ofrecen para pintar (sin las claves antiguas).
export const ODONTOGRAMA_ESTADOS_VIGENTES = ODONTOGRAMA_ESTADOS.filter((e) => !e.legacy);

/**
 * Colores REALES del dibujo. Hacen falta en hexadecimal porque dentro de un
 * <svg> los `fill`/`stroke` no entienden las clases de Tailwind.
 */
export const ODONTOGRAMA_COLORES = {
  rojo: '#dc2626',
  azul: '#2563eb',
  neutro: '#64748b',
};

/** Los dos colores que el odontólogo puede elegir, y qué significa cada uno. */
export const ODONTOGRAMA_COLOR_OPCIONES = [
  { key: 'azul', label: 'Azul', significado: 'tratamiento realizado', corto: 'realizado' },
  { key: 'rojo', label: 'Rojo', significado: 'patología actual', corto: 'patología' },
];

/**
 * UNA MARCA DEL ODONTOGRAMA SE GUARDA COMO «clave» o «clave:color».
 *
 * El color era fijo por estado (caries siempre rojo, obturado siempre azul),
 * pero el odontólogo necesita las dos tintas en CUALQUIER símbolo: la misma
 * figura significa una cosa si está por hacer y otra si ya se hizo. Así que el
 * color pasó de deducirse a elegirse, y hay que guardarlo junto a la marca.
 *
 * Se guarda como sufijo dentro del mismo String ('caries:azul') a propósito: el
 * esquema ya guarda `estado` y `caras.*` como texto libre, así que no hace falta
 * migrar nada y lo anotado antes —sin sufijo— se sigue leyendo con el color que
 * tenía por convenio. Ver server/models/ClinicalRecord.js.
 */
export const marcaOdonto = (valor) => {
  const [key, color] = String(valor || '').split(':');
  const ficha = ODONTOGRAMA_ESTADOS.find((x) => x.key === key) || null;
  const explicito = ODONTOGRAMA_COLOR_OPCIONES.some((c) => c.key === color) ? color : '';
  return { key, ficha, explicito, color: explicito || ficha?.color || 'neutro' };
};

/** Cómo se guarda una marca: el estado y, si se eligió, su color. */
export const marcaValor = (key, color) => (key && color ? `${key}:${color}` : key || '');

/** Color con el que se dibuja una marca ('' → el neutro del contorno). */
export const colorEstado = (valor) =>
  ODONTOGRAMA_COLORES[marcaOdonto(valor).color] || ODONTOGRAMA_COLORES.neutro;

/** Ficha del estado (para saber su ámbito y su símbolo al dibujar). */
export const estadoOdonto = (valor) => marcaOdonto(valor).ficha;

/**
 * Color con el que se empieza a pintar al elegir un símbolo: el del convenio de
 * la hoja (caries rojo, obturado azul). Se puede cambiar, pero por defecto el
 * odontograma sigue saliendo como siempre.
 */
export const colorPorDefecto = (key) => {
  const c = ODONTOGRAMA_ESTADOS.find((x) => x.key === key)?.color;
  return c === 'rojo' || c === 'azul' ? c : 'azul';
};

/**
 * Etiqueta de una marca para leerla en texto (resumen e impresión): el nombre
 * del símbolo y, entre paréntesis, lo que dice su color. Sin esto, una marca
 * guardada como 'caries:azul' se imprimiría con la clave cruda.
 */
export const labelOdonto = (valor) => {
  const { key, ficha, color } = marcaOdonto(valor);
  if (!key) return '';
  const nombre = ficha?.label || key;
  const c = ODONTOGRAMA_COLOR_OPCIONES.find((x) => x.key === color);
  return c ? `${nombre} (${c.corto})` : nombre;
};

// Clases Tailwind por estado. Se escriben COMPLETAS (no `bg-${tone}-100`) porque
// Tailwind solo conserva las clases que encuentra literales en el código.
export const ODONTOGRAMA_ESTADO_CLASES = {
  sano: 'bg-emerald-100 border-emerald-400 text-emerald-800',
  caries: 'bg-red-100 border-red-400 text-red-800',
  obturado: 'bg-blue-100 border-blue-400 text-blue-800',
  endodoncia: 'bg-violet-100 border-violet-400 text-violet-800',
  corona: 'bg-amber-100 border-amber-400 text-amber-800',
  protesis: 'bg-amber-200 border-amber-500 text-amber-900',
  implante: 'bg-cyan-100 border-cyan-400 text-cyan-800',
  sellante: 'bg-teal-100 border-teal-400 text-teal-800',
  fracturado: 'bg-orange-100 border-orange-400 text-orange-800',
  extraccionIndicada: 'bg-rose-200 border-rose-500 text-rose-900',
  ausente: 'bg-slate-300 border-slate-500 text-slate-700 line-through',
  enErupcion: 'bg-lime-100 border-lime-400 text-lime-800',
};

// Caras de la pieza dental. El orden es el del dibujo: las 4 periféricas y el
// centro (`oclusal`), que es el sector central del esquema.
export const ODONTOGRAMA_CARAS = [
  { key: 'vestibular', label: 'Vestibular' },
  { key: 'lingual', label: 'Lingual / palatina' },
  { key: 'mesial', label: 'Mesial' },
  { key: 'distal', label: 'Distal' },
  { key: 'oclusal', label: 'Oclusal / incisal' },
];

// Recesión y movilidad: la hoja las marca con "X" y admite grado 1, 2 ó 3.
export const ODONTOGRAMA_GRADOS = ['1', '2', '3'];

/**
 * Sección 7 · Higiene oral simplificada (IHOS).
 *
 * Seis sextantes; en cada uno se examina UNA pieza: la de referencia, su alterna
 * si falta, o la temporal en niños. Por eso la hoja imprime tres números por fila
 * y solo se llena la que se evaluó.
 */
export const HIGIENE_ORAL_FILAS = [
  { key: 'sup_der', label: 'Superior derecho', piezas: ['16', '17', '55'] },
  { key: 'sup_ant', label: 'Superior anterior', piezas: ['11', '21', '51'] },
  { key: 'sup_izq', label: 'Superior izquierdo', piezas: ['26', '27', '65'] },
  { key: 'inf_izq', label: 'Inferior izquierdo', piezas: ['36', '37', '75'] },
  { key: 'inf_ant', label: 'Inferior anterior', piezas: ['31', '41', '71'] },
  { key: 'inf_der', label: 'Inferior derecho', piezas: ['46', '47', '85'] },
];

export const HIGIENE_ORAL_INDICES = [
  { key: 'placa', label: 'Placa', valores: ['0', '1', '2', '3'] },
  { key: 'calculo', label: 'Cálculo', valores: ['0', '1', '2', '3'] },
  { key: 'gingivitis', label: 'Gingivitis', valores: ['0', '1'] },
];

export const ENFERMEDAD_PERIODONTAL = [
  { key: 'leve', label: 'Leve' },
  { key: 'moderada', label: 'Moderada' },
  { key: 'severa', label: 'Severa' },
];

export const MALOCLUSION = [
  { key: 'angleI', label: 'Angle I' },
  { key: 'angleII', label: 'Angle II' },
  { key: 'angleIII', label: 'Angle III' },
];

export const FLUOROSIS = [
  { key: 'leve', label: 'Leve' },
  { key: 'moderada', label: 'Moderada' },
  { key: 'severa', label: 'Severa' },
];

/**
 * Sección 8 · Índices CPO / ceo. Mayúsculas = dentición permanente, minúsculas =
 * temporal. El TOTAL no se digita: es la suma de las tres columnas.
 */
export const INDICE_CPO = [
  { key: 'c', label: 'C' },
  { key: 'p', label: 'P' },
  { key: 'o', label: 'O' },
];

export const INDICE_CEO = [
  { key: 'c', label: 'c' },
  { key: 'e', label: 'e' },
  { key: 'o', label: 'o' },
];

// ─────────────────────── Cosmetología ────────────────────────

export const COSMETOLOGIA_FOTOTIPOS = ['I', 'II', 'III', 'IV', 'V', 'VI'];
export const COSMETOLOGIA_GLOGAU = ['I', 'II', 'III', 'IV'];

export const COSMETOLOGIA_BIOTIPOS = [
  { key: 'normal', label: 'Normal' },
  { key: 'seca', label: 'Seca' },
  { key: 'grasa', label: 'Grasa' },
  { key: 'mixta', label: 'Mixta' },
  { key: 'hidratada', label: 'Hidratada' },
  { key: 'deshidratada', label: 'Deshidratada' },
  { key: 'sensible', label: 'Sensible' },
  { key: 'asfictica', label: 'Asfíctica' },
];

export const COSMETOLOGIA_ARRUGAS = [
  { key: 'finas', label: 'Finas' },
  { key: 'profundas', label: 'Profundas' },
  { key: 'patasGallo', label: 'Patas de gallo' },
  { key: 'marionetas', label: 'Marionetas' },
  { key: 'nasogenianos', label: 'Nasogenianos' },
  { key: 'lineasExpresion', label: 'Líneas de expresión' },
];

export const COSMETOLOGIA_ACNE = [
  { key: 'preAcne', label: 'Pre-acné' },
  { key: 'tipoI', label: 'Acné tipo I' },
  { key: 'tipoII', label: 'Acné tipo II' },
  { key: 'conglobataIII', label: 'Acné conglobata III' },
  { key: 'secuelas', label: 'Secuelas de acné' },
];

export const COSMETOLOGIA_ROSACEA = ['I', 'II', 'III', 'IV'];

export const COSMETOLOGIA_LESIONES = [
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
export const COSMETOLOGIA_HIPERPIGMENTACION = [
  { key: 'ovaloFacial', label: 'Óvalo facial', lados: false },
  { key: 'tercioSuperior', label: 'Tercio superior', lados: true },
  { key: 'tercioMedio', label: 'Tercio medio', lados: true },
  { key: 'tercioInferior', label: 'Tercio inferior', lados: true },
];

export const COSMETOLOGIA_DESHIDRATACION = ['leve', 'moderada', 'avanzada'];

export const COSMETOLOGIA_CABELLO = [
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

export const COSMETOLOGIA_CABELLO_TRATAMIENTOS = [
  { key: 'alisados', label: 'Alisados' },
  { key: 'planchas', label: 'Planchas' },
  { key: 'secadores', label: 'Secadores' },
];

export const COSMETOLOGIA_CUERO_CABELLUDO = [
  { key: 'tipo', label: 'Tipo', options: ['graso', 'normal', 'deshidratado'] },
  { key: 'glandulaSebacea', label: 'Glándula sebácea', options: ['normal', 'hipofuncionante', 'hiperfuncionante'] },
  { key: 'sensibilidad', label: 'Sensibilidad', options: ['normal', 'sensible', 'irritado'] },
  { key: 'movilidad', label: 'Movilidad', options: ['normal', 'media', 'reducida'] },
];

// Alteración de la fibra capilar. Cada casilla admite detalle (la hoja deja una
// línea para escribir al lado de cada alteración).
export const COSMETOLOGIA_FIBRA_CAPILAR = [
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
export const COSMETOLOGIA_AFECCIONES_CUERO = [
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
export const COSMETOLOGIA_OPTION_LABELS = {
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

/** Etiqueta legible de una opción cerrada; si no está en el mapa, la deja tal cual. */
export const optionLabel = (v) => COSMETOLOGIA_OPTION_LABELS[v] || v || '';
