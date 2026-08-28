/**
 * CATÁLOGO DE SUEROTERAPIA: cloruro (la base), ampollas y moléculas.
 *
 * Un suero no es una línea de receta: es una preparación. El médico escoge el
 * volumen de cloruro y qué ampollas y moléculas van dentro, y enfermería tiene
 * que leer eso EXACTAMENTE como se escribió — es lo que entra por la vena.
 *
 * POR QUÉ UNA CONSTANTE Y NO EL INVENTARIO. La lista la fija el laboratorio, no
 * la clínica: es la misma en todas las sucursales y no cambia porque alguien dé
 * de alta un producto. Atarla al inventario significaría que el médico no puede
 * recetar una ampolla mientras no esté creada con su precio y su cuenta
 * contable, que es justamente el rodeo que ya se quitó del catálogo de agenda.
 *
 * AUN ASÍ SE DESCUENTA DEL INVENTARIO. `code` es el mismo código con el que la
 * ampolla está dada de alta como Product (índice único clinic+code), así que al
 * administrar el suero se busca por ahí y se descuenta lo que se puso. Si la
 * ampolla no existe en el inventario de esa sucursal, se receta y se aplica
 * igual: simplemente no hay stock que mover.
 *
 * Se guardan SOLO `code`, `name` y el grupo. El precio y las existencias viven
 * en el inventario y se quedarían obsoletos aquí en cuanto entre una compra.
 *
 * `activo: false` es el estado "I" del laboratorio. NO se filtra la lista: son
 * productos que aún pueden estar en la percha y el médico los sigue recetando.
 * Sirve para marcarlos en el buscador.
 */

// El cloruro es la base: va en TODOS los sueros. Lo único que se elige es el
// volumen de la bolsa.
const SUERO_CLORURO_NOMBRE = 'Cloruro';
const SUERO_CLORURO_VOLUMENES = [100, 250, 500, 1000];

const SUERO_AMPOLLAS = [
  { code: 'AAPL01', name: 'APIMEL 2ML AMP', activo: true },
  { code: 'AAROL01', name: 'ARTHRIDOL 2ML AMP', activo: true },
  { code: 'PTBERI01', name: 'BERBERIS 2ML AMP', activo: true },
  { code: 'PTBERB01', name: 'BERBULL 2ML AMP', activo: true },
  { code: 'AMCEBR01', name: 'CEREBRAIN 2ML AMP', activo: true },
  { code: 'ACENE01', name: 'CERENEX 2ML AMP', activo: true },
  { code: 'PTCHTI01', name: 'CHELATION 2ML AMP', activo: true },
  { code: 'ACHAL01', name: 'CHIMAL 2ML AMP', activo: true },
  { code: 'PTCIVA01', name: 'CITONOVA 2ML AMP', activo: true },
  { code: 'PTCOE01', name: 'COENZIMA 2ML AMP', activo: true },
  { code: 'PTCTRINF01', name: 'CONTROL DE DOLOR INFLAMACION 2ML AMP', activo: true },
  { code: 'PTCTRPSI01', name: 'CONTROL PSICOSOMATICO 2ML AMP', activo: true },
  { code: 'AMDEX01', name: 'DETOXY 2ML AMP', activo: true },
  { code: 'AMDIS01', name: 'DISCOLVER 2ML AMP', activo: true },
  { code: 'PTDTOX01', name: 'D-TOX ADVANCE 2ML AMP', activo: false },
  { code: 'AEPHEL01', name: 'EPACHEL 2ML AMP', activo: true },
  { code: 'PTESTINM01', name: 'ESTIMULADOR INMUNOLOGICO 2ML AMP', activo: false },
  { code: 'AMGARY01', name: 'GASTRYUM 2ML AMP', activo: true },
  { code: 'GLAAM01', name: 'GLANTHY AMP 2 ML', activo: true },
  { code: 'AHADR01', name: 'HAMADRON 2ML AMP', activo: true },
  { code: 'PTHEP01', name: 'HEPACEL 2ML AMP', activo: false },
  { code: 'AMHESC01', name: 'HEPATISCH 2ML AMP', activo: true },
  { code: 'PTHIERR01', name: 'HIERRO 2ML AMP', activo: true },
  { code: 'PTHIPE01', name: 'HIPERTENSION 2ML AMP', activo: false },
  { code: 'PTINMAD01', name: 'INMUNO ADVANCE 2ML AMP', activo: true },
  { code: 'AMMONS01', name: 'MOCOUS 2ML AMP', activo: true },
  { code: 'AMUSA01', name: 'MUCSAN 2ML AMP', activo: true },
  { code: 'AMNEV01', name: 'NERVO SNC 2ML AMP', activo: true },
  { code: 'ANOAR01', name: 'NOVA ARNICA 10ML', activo: false },
  { code: 'PTOVA01', name: 'OVARIFEM 2ML AMP', activo: true },
  { code: 'AMPARE01', name: 'PANKREAS 2ML AMP', activo: true },
  { code: 'APLZR01', name: 'PLAZAR 2ML AMP', activo: true },
  { code: 'PTPRO01', name: 'PROINA 2ML AMP', activo: true },
  { code: 'PTPROGEN01', name: 'PROSTATA Y GENITOURINARIO', activo: false },
  { code: 'AMPRST01', name: 'PROSTATIC 2ML AMP', activo: true },
  { code: 'PTANCI01', name: 'R1 2ML AMP', activo: true },
  { code: 'PTHEGA01', name: 'R7 2ML AMP', activo: true },
  { code: 'PTKLTE01', name: 'R10 2ML AMP', activo: true },
  { code: 'ALUBA01', name: 'R11 2ML AMP', activo: true },
  { code: 'AMQUTA01', name: 'R14 2ML AMP', activo: true },
  { code: 'PTCISA01', name: 'R16 2ML AMP', activo: true },
  { code: 'PTCOLA01', name: 'R17 2ML AMP', activo: true },
  { code: 'PTEUDI01', name: 'R20 2ML AMP', activo: true },
  { code: 'PTMEHA01', name: 'R21 2ML AMP', activo: true },
  { code: 'PTPRTA01', name: 'R25 2ML AMP', activo: true },
  { code: 'PTRECA01', name: 'R27 2ML AMP', activo: true },
  { code: 'PTCOTE01', name: 'R37 2ML AMP', activo: true },
  { code: 'RAMP01', name: 'R40 AMP 2ML', activo: true },
  { code: 'PTFOVI01', name: 'R41 2ML AMP', activo: true },
  { code: 'PTHAVE01', name: 'R42 2ML AMP', activo: true },
  { code: 'PTRUVI01', name: 'R55 2ML AMP', activo: true },
  { code: 'PTISCH01', name: 'R71 2ML AMP', activo: true },
  { code: 'PTSPTH01', name: 'R73 2ML AMP', activo: true },
  { code: 'PTREGMU01', name: 'REGENERADOR DE MUCOSA', activo: false },
  { code: 'PTGASAD01', name: 'REGENERADOR GASTROINTESTINAL 2ML AMP', activo: true },
  { code: 'PTREGHEP01', name: 'REGENERADOR HEPATOBILIAR 2ML AMP', activo: false },
  { code: 'PTREOS01', name: 'REGENERADOR OSTEOARTICULAR 2ML AMP', activo: true },
  { code: 'PTREGGL01', name: 'REGULADOR DE GLUCOSA X 1 UNID', activo: false },
  { code: 'PTREGME01', name: 'REGULADOR METABOLICO Y OBESIDAD', activo: false },
  { code: 'ASBTR01', name: 'SBELTRA 2ML AMP', activo: true },
  { code: 'NOVDE01', name: 'SUEROTERAPIA DETOX PLUS', activo: true },
  { code: 'PTTHYR01', name: 'THYRO 2ML AMP', activo: true },
  { code: 'AMTRA01', name: 'TRARNIC 2ML AMP', activo: true },
  { code: 'ATRAX01', name: 'TRAUMAX 2ML AMP', activo: true },
];

const SUERO_MOLECULAS = [
  { code: 'PTCAOV02', name: '3f CALEND OVULOS', activo: false },
  { code: 'PTCAOV', name: '6f CALEND OVULOS', activo: false },
  { code: 'PTACIALP01', name: 'ACIDO ALPHALIPOICO 10ML MOL', activo: true },
  { code: 'PTACIALP02', name: 'ACIDO ALPHALIPOICO 20ML MOL', activo: true },
  { code: 'SANNA01', name: 'ANTIOX - NAD 25 ML', activo: true },
  { code: 'SANNA02', name: 'ANTIOX - NAD PLUS 25 ML', activo: true },
  { code: 'ANT001', name: 'ANTOXMOL X 100 COMP', activo: true },
  { code: 'AM3ML', name: 'AZUL DE METILENO 3ML MOL', activo: false },
  { code: 'AM4ML', name: 'AZUL DE METILENO 4ML MOL', activo: false },
  { code: 'AM5ML', name: 'AZUL DE METILENO 5ML MOL', activo: false },
  { code: 'PTAZUME01', name: 'AZUL METILENO 10ML MOL', activo: true },
  { code: 'GLU001', name: 'BIO GLUTATHIONE AMP 2ML', activo: true },
  { code: 'PTBIOT01', name: 'BIOTINA B7 10ML MOL', activo: true },
  { code: 'PTCARN01', name: 'CARNITINA 10ML MOL', activo: false },
  { code: 'CLODECA01', name: 'CLORURO DE CALCIO 10ML MOLECULA', activo: true },
  { code: 'PTCOMB01', name: 'COMPLEJO B 10ML MOL', activo: true },
  { code: 'COM001', name: 'COMVIPLEX FCO X 200G', activo: true },
  { code: 'PTCROM01', name: 'CROMO 10ML MOL COMPL', activo: true },
  { code: 'PTDMS002', name: 'DMSO PLUS 10ML', activo: true },
  { code: 'PTDMS001', name: 'DMSO PLUS 25ML MOL', activo: true },
  { code: 'FOE001', name: 'FOENIL JARABE FCO X 120ML', activo: true },
  { code: 'PTGLU01', name: 'GLUTACELL 600', activo: true },
  { code: 'HEVI01', name: 'HEPASYN VIAL 10ML MOL', activo: true },
  { code: 'INMAX01', name: 'INFILMAX NOVA 10ML', activo: true },
  { code: 'PTLIS01', name: 'LISINA 10ML MOL', activo: true },
  { code: 'PTMEGC01', name: 'MEGADOSIS VITAMINA C 50ML MOL', activo: true },
  { code: 'PTBIOPR02', name: 'MOLECULA - BIOREGEN PRIME 25ML', activo: false },
  // Mismo nombre, dos códigos: el laboratorio dio de baja el primero y lo repuso
  // con otro código. Se dejan los dos y el buscador enseña el código al lado,
  // que es lo único que los distingue.
  { code: 'PTNEUREG01', name: 'NEURO REGENERADOR 10 ML MOL ROCAB', activo: false },
  { code: 'PTNEUREG03', name: 'NEURO REGENERADOR 10 ML MOL ROCAB', activo: true },
  { code: 'PTNEUREGNOV01', name: 'NEURO REGENERADOR 20ML MOL NOVA', activo: true },
  { code: 'PTPANT01', name: 'PANTENOL B5 10ML MOL', activo: true },
  { code: 'PTPLMA01', name: 'PLASMA MARINO 100ML MOL', activo: true },
  { code: 'PTSIL01', name: 'SILICIO 10ML MOL COMPL', activo: true },
  { code: 'PTMPL01', name: 'SUEROTERAPIA M19 PLUS 10ML MOL', activo: true },
  { code: 'PTMAGN01', name: 'SUEROTERAPIA MAGNESIO 10ML MOL', activo: true },
  { code: 'REMET01', name: 'SUEROTERAPIA REDUCTOR METABOLICO NOVA 10ML MOL', activo: true },
  { code: 'ECNOV01', name: 'SUEROTERAPIA SISTEMA INMUNE ECHINOVA 10ML MOL', activo: true },
  { code: 'TRAR001', name: 'TRARNICREM TUBO X60GR', activo: true },
  { code: 'PTTRGA01', name: 'TRIPTOFANO + GABA TAB', activo: true },
  { code: 'PTTRMG01', name: 'TRIPTOFANO CON MAGNESIO + VITAMINA B6 TAB', activo: true },
];

// Grupos que puede llevar un componente. 'otro' existe porque la lista de arriba
// es la del laboratorio, no una jaula: si el médico necesita añadir algo que no
// está, lo escribe y se guarda igual.
const SUERO_GRUPOS = ['ampolla', 'molecula', 'otro'];

// Lista única, ya etiquetada, para el buscador del cliente y para resolver
// nombres sueltos en el servidor.
const SUERO_COMPONENTES = [
  ...SUERO_AMPOLLAS.map((a) => ({ ...a, grupo: 'ampolla' })),
  ...SUERO_MOLECULAS.map((m) => ({ ...m, grupo: 'molecula' })),
];

/** Nombre → clave de comparación: sin tildes, sin dobles espacios, minúsculas. */
const claveSuero = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();

const PORCODIGO = new Map(SUERO_COMPONENTES.map((c) => [claveSuero(c.code), c]));
/**
 * Índice por nombre. Con nombres repetidos (el laboratorio dio de baja un código
 * y repuso el mismo producto con otro) gana el VIGENTE.
 *
 * No es un detalle: quien busca por nombre es el médico desde el buscador, que
 * ya solo le enseña el vigente. Quedarse con el primero del array le guardaba el
 * código dado de baja, y entonces la ampolla no se encontraba en el inventario y
 * el suero se aplicaba sin descontar nada, en silencio.
 */
const PORNOMBRE = new Map();
SUERO_COMPONENTES.forEach((c) => {
  const k = claveSuero(c.name);
  const previo = PORNOMBRE.get(k);
  if (!previo || (!previo.activo && c.activo)) PORNOMBRE.set(k, c);
});

/**
 * Encuentra un componente del catálogo por código o por nombre. Devuelve null si
 * es algo que el médico escribió a mano: eso NO es un error, se receta igual.
 */
const buscarComponenteSuero = ({ code, name } = {}) =>
  (code && PORCODIGO.get(claveSuero(code))) || (name && PORNOMBRE.get(claveSuero(name))) || null;

module.exports = {
  SUERO_CLORURO_NOMBRE,
  SUERO_CLORURO_VOLUMENES,
  SUERO_AMPOLLAS,
  SUERO_MOLECULAS,
  SUERO_COMPONENTES,
  SUERO_GRUPOS,
  claveSuero,
  buscarComponenteSuero,
};
