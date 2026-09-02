/**
 * Espejo de server/constants/specialtyCatalogs.js (fichas por especialidad:
 * podología, odontología, cosmetología y cardiología). Las `key` DEBEN coincidir
 * con las del servidor: son las que se guardan en la base y las que valida el backend.
 */

// ───────────────────────── Cardiología ───────────────────────
//
// Hoja «Historia clínica cardiológica». En el seguimiento SOLO vive lo que el
// formulario general no captura ya: el motivo de consulta, la enfermedad
// actual, los signos vitales (PA/FC/SatO2/peso/talla/IMC), la impresión
// diagnóstica con CIE-10 y el plan narrado son campos del seguimiento común y
// aquí NO se repiten.

// Antecedentes relevantes: cada uno es Sí / No / sin consignar. Dejar constancia
// de que el paciente NO es hipertenso es un dato clínico, no un hueco.
export const CARDIOLOGIA_ANTECEDENTES = [
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
export const CARDIOLOGIA_ESTUDIOS = [
  { key: 'ecocardiograma', label: 'Ecocardiograma' },
  { key: 'holter', label: 'Holter' },
  { key: 'mapa', label: 'MAPA' },
  { key: 'ergometria', label: 'Ergometría' },
  { key: 'laboratorio', label: 'Laboratorio' },
];

// Ritmo del electrocardiograma. Lista abierta: se puede elegir uno o escribirlo.
export const CARDIOLOGIA_RITMOS = [
  'Sinusal',
  'Sinusal con extrasístoles',
  'Fibrilación auricular',
  'Flutter auricular',
  'Taquicardia supraventricular',
  'Ritmo de marcapasos',
  'Bloqueo AV',
];

export const CARDIOLOGIA_ANTECEDENTES_KEYS = CARDIOLOGIA_ANTECEDENTES.map((c) => c.key);
export const CARDIOLOGIA_ESTUDIOS_KEYS = CARDIOLOGIA_ESTUDIOS.map((c) => c.key);

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
  { key: 'sellanteNecesario', label: 'Sellante necesario', tone: 'red', color: 'rojo', ambito: 'cara', simbolo: 'asterisco' },
  { key: 'sellanteRealizado', label: 'Sellante realizado', tone: 'blue', color: 'azul', ambito: 'cara', simbolo: 'asterisco' },
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
  { key: 'sellante', label: 'Sellante', tone: 'teal', color: 'azul', ambito: 'cara', simbolo: 'asterisco', legacy: true },
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
 *
 * EL LIENZO YA NO ES CUADRADO (sep-2026): es 141×100 (ver CincoElementos), y el
 * pentágono se estrechó en X para dejar un margen a los lados. No es que la
 * figura haya cambiado de forma —las distancias en píxeles son las mismas—: es
 * que ahora los campos de Madera y Tierra van POR FUERA de sus círculos y ahí
 * es donde caen.
 */
export const TERAPIA_ELEMENTOS = [
  { key: 'fuego',  label: 'Fuego',  letra: 'F', color: '#dc2626', texto: '#ffffff', x: 50,   y: 12 },
  { key: 'tierra', label: 'Tierra', letra: 'T', color: '#eab308', texto: '#1f2937', x: 75.5, y: 42 },
  // Agua y Metal suben un poco (85 → 81): sus campos van DEBAJO del círculo y
  // con el círculo al doble de tamaño se salían por el pie del lienzo.
  { key: 'metal',  label: 'Metal',  letra: 'M', color: '#ffffff', texto: '#1f2937', x: 65.5, y: 81 },
  { key: 'agua',   label: 'Agua',   letra: 'A', color: '#111827', texto: '#ffffff', x: 34.5, y: 81 },
  { key: 'madera', label: 'Madera', letra: 'M', color: '#16a34a', texto: '#ffffff', x: 24.5, y: 42 },
];

export const TERAPIA_ELEMENTOS_KEYS = TERAPIA_ELEMENTOS.map((e) => e.key);

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
export const TERAPIA_CICLO_APOYO = [
  ['madera', 'fuego'], ['fuego', 'tierra'], ['tierra', 'metal'],
  ['metal', 'agua'], ['agua', 'madera'],
];
export const TERAPIA_CICLO_CONTROL = [
  ['madera', 'tierra'], ['tierra', 'agua'], ['agua', 'fuego'],
  ['fuego', 'metal'], ['metal', 'madera'],
];

/**
 * Los cuatro cuadrantes del plan terapéutico. Se lee como un FODA: el cuadro del
 * paciente repartido en cuatro, y debajo el plan escrito que sale de ese reparto.
 */
// Los rótulos se renombraron (sep-2026): «Desagüe» pasó a «Desequilibrio» y
// «Apreciación» a «Deficiencias». Las CLAVES se quedan como estaban a propósito:
// son las que hay guardadas en las consultas de todos estos meses y renombrarlas
// dejaría en blanco lo ya escrito.
export const TERAPIA_FODA = [
  { key: 'desague', label: 'Desequilibrio' },
  { key: 'apreciacion', label: 'Deficiencias' },
  { key: 'toxinas', label: 'Toxinas' },
  { key: 'bioRegeneracion', label: 'Bio-Regeneración' },
];

export const TERAPIA_FODA_KEYS = TERAPIA_FODA.map((c) => c.key);

/**
 * HÁBITOS de la ficha del terapeuta. Sustituye a la rejilla de casillas de la
 * hoja MSP: aquí cada hábito se puntúa en un NIVEL (1, 2 o 3 — uno solo) y
 * además lleva una nota de lo que el paciente hace a diario.
 */
export const TERAPIA_HABITOS_FILAS = [
  { key: 'digestion', label: 'Digestión' },
  { key: 'sueno', label: 'Sueño' },
  { key: 'toxinas', label: 'Toxinas' },
  { key: 'alimentacion', label: 'Alimentación' },
  { key: 'estres', label: 'Estrés' },
];

export const TERAPIA_HABITOS_FILAS_KEYS = TERAPIA_HABITOS_FILAS.map((f) => f.key);

// Los niveles son EXCLUYENTES: marcar el 2 desmarca el 1. Es una escala, no tres
// casillas sueltas.
export const TERAPIA_HABITOS_NIVELES = ['1', '2', '3'];


/**
 * RÓTULOS DE LA RECETA, que no son los mismos para todos.
 *
 * El terapeuta no receta fármacos: manda suplementos, productos naturales y
 * homeopáticos, y en vez de «recomendaciones no farmacológicas» lo que entrega
 * es un acompañamiento para cambiar hábitos. La tabla y los campos son los
 * mismos —el dato guardado no cambia—; lo que cambia es cómo se llama en su
 * pantalla y en sus impresos.
 *
 * Espejo de `server/constants/specialtyCatalogs.js`: el PDF de la receta se
 * arma en el servidor y tiene que decir exactamente lo mismo.
 */
export const RECETA_ETIQUETAS = {
  general: {
    item: 'Medicamento / Insumo',
    ayuda: 'medicamentos e insumos indicados',
    consejos: 'Recomendaciones no farmacológicas',
  },
  terapeuta: {
    item: 'Suplemento / Natural / Homeopático',
    ayuda: 'suplementos, naturales u homeopáticos indicados',
    consejos: 'Coaching de cambio de hábitos',
  },
};

export const recetaEtiquetas = (esTerapeuta) =>
  esTerapeuta ? RECETA_ETIQUETAS.terapeuta : RECETA_ETIQUETAS.general;
