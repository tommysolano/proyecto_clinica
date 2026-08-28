/**
 * Espejo de server/constants/sueroterapia.js (cloruro, ampollas y moléculas de
 * la sueroterapia). Los `code` DEBEN coincidir con los del servidor: son los que
 * se guardan en el seguimiento y con los que se busca la ampolla en el
 * inventario para descontarla al aplicarla.
 *
 * Se guardan solo código y nombre: el precio y las existencias viven en el
 * inventario y aquí se quedarían obsoletos en cuanto entre una compra.
 *
 * `activo: false` es el estado "I" del laboratorio. La lista NO se filtra por
 * eso —siguen recetándose— pero el buscador los marca.
 */

// El cloruro es la base: va en TODOS los sueros. Lo único que se elige es el
// volumen de la bolsa.
export const SUERO_CLORURO_NOMBRE = "Cloruro";
export const SUERO_CLORURO_VOLUMENES = [100, 250, 500, 1000];

export const SUERO_AMPOLLAS = [
  { code: "AAPL01", name: "APIMEL 2ML AMP", activo: true },
  { code: "AAROL01", name: "ARTHRIDOL 2ML AMP", activo: true },
  { code: "PTBERI01", name: "BERBERIS 2ML AMP", activo: true },
  { code: "PTBERB01", name: "BERBULL 2ML AMP", activo: true },
  { code: "AMCEBR01", name: "CEREBRAIN 2ML AMP", activo: true },
  { code: "ACENE01", name: "CERENEX 2ML AMP", activo: true },
  { code: "PTCHTI01", name: "CHELATION 2ML AMP", activo: true },
  { code: "ACHAL01", name: "CHIMAL 2ML AMP", activo: true },
  { code: "PTCIVA01", name: "CITONOVA 2ML AMP", activo: true },
  { code: "PTCOE01", name: "COENZIMA 2ML AMP", activo: true },
  { code: "PTCTRINF01", name: "CONTROL DE DOLOR INFLAMACION 2ML AMP", activo: true },
  { code: "PTCTRPSI01", name: "CONTROL PSICOSOMATICO 2ML AMP", activo: true },
  { code: "AMDEX01", name: "DETOXY 2ML AMP", activo: true },
  { code: "AMDIS01", name: "DISCOLVER 2ML AMP", activo: true },
  { code: "PTDTOX01", name: "D-TOX ADVANCE 2ML AMP", activo: false },
  { code: "AEPHEL01", name: "EPACHEL 2ML AMP", activo: true },
  { code: "PTESTINM01", name: "ESTIMULADOR INMUNOLOGICO 2ML AMP", activo: false },
  { code: "AMGARY01", name: "GASTRYUM 2ML AMP", activo: true },
  { code: "GLAAM01", name: "GLANTHY AMP 2 ML", activo: true },
  { code: "AHADR01", name: "HAMADRON 2ML AMP", activo: true },
  { code: "PTHEP01", name: "HEPACEL 2ML AMP", activo: false },
  { code: "AMHESC01", name: "HEPATISCH 2ML AMP", activo: true },
  { code: "PTHIERR01", name: "HIERRO 2ML AMP", activo: true },
  { code: "PTHIPE01", name: "HIPERTENSION 2ML AMP", activo: false },
  { code: "PTINMAD01", name: "INMUNO ADVANCE 2ML AMP", activo: true },
  { code: "AMMONS01", name: "MOCOUS 2ML AMP", activo: true },
  { code: "AMUSA01", name: "MUCSAN 2ML AMP", activo: true },
  { code: "AMNEV01", name: "NERVO SNC 2ML AMP", activo: true },
  { code: "ANOAR01", name: "NOVA ARNICA 10ML", activo: false },
  { code: "PTOVA01", name: "OVARIFEM 2ML AMP", activo: true },
  { code: "AMPARE01", name: "PANKREAS 2ML AMP", activo: true },
  { code: "APLZR01", name: "PLAZAR 2ML AMP", activo: true },
  { code: "PTPRO01", name: "PROINA 2ML AMP", activo: true },
  { code: "PTPROGEN01", name: "PROSTATA Y GENITOURINARIO", activo: false },
  { code: "AMPRST01", name: "PROSTATIC 2ML AMP", activo: true },
  { code: "PTANCI01", name: "R1 2ML AMP", activo: true },
  { code: "PTHEGA01", name: "R7 2ML AMP", activo: true },
  { code: "PTKLTE01", name: "R10 2ML AMP", activo: true },
  { code: "ALUBA01", name: "R11 2ML AMP", activo: true },
  { code: "AMQUTA01", name: "R14 2ML AMP", activo: true },
  { code: "PTCISA01", name: "R16 2ML AMP", activo: true },
  { code: "PTCOLA01", name: "R17 2ML AMP", activo: true },
  { code: "PTEUDI01", name: "R20 2ML AMP", activo: true },
  { code: "PTMEHA01", name: "R21 2ML AMP", activo: true },
  { code: "PTPRTA01", name: "R25 2ML AMP", activo: true },
  { code: "PTRECA01", name: "R27 2ML AMP", activo: true },
  { code: "PTCOTE01", name: "R37 2ML AMP", activo: true },
  { code: "RAMP01", name: "R40 AMP 2ML", activo: true },
  { code: "PTFOVI01", name: "R41 2ML AMP", activo: true },
  { code: "PTHAVE01", name: "R42 2ML AMP", activo: true },
  { code: "PTRUVI01", name: "R55 2ML AMP", activo: true },
  { code: "PTISCH01", name: "R71 2ML AMP", activo: true },
  { code: "PTSPTH01", name: "R73 2ML AMP", activo: true },
  { code: "PTREGMU01", name: "REGENERADOR DE MUCOSA", activo: false },
  { code: "PTGASAD01", name: "REGENERADOR GASTROINTESTINAL 2ML AMP", activo: true },
  { code: "PTREGHEP01", name: "REGENERADOR HEPATOBILIAR 2ML AMP", activo: false },
  { code: "PTREOS01", name: "REGENERADOR OSTEOARTICULAR 2ML AMP", activo: true },
  { code: "PTREGGL01", name: "REGULADOR DE GLUCOSA X 1 UNID", activo: false },
  { code: "PTREGME01", name: "REGULADOR METABOLICO Y OBESIDAD", activo: false },
  { code: "ASBTR01", name: "SBELTRA 2ML AMP", activo: true },
  { code: "NOVDE01", name: "SUEROTERAPIA DETOX PLUS", activo: true },
  { code: "PTTHYR01", name: "THYRO 2ML AMP", activo: true },
  { code: "AMTRA01", name: "TRARNIC 2ML AMP", activo: true },
  { code: "ATRAX01", name: "TRAUMAX 2ML AMP", activo: true },
];

export const SUERO_MOLECULAS = [
  { code: "PTCAOV02", name: "3f CALEND OVULOS", activo: false },
  { code: "PTCAOV", name: "6f CALEND OVULOS", activo: false },
  { code: "PTACIALP01", name: "ACIDO ALPHALIPOICO 10ML MOL", activo: true },
  { code: "PTACIALP02", name: "ACIDO ALPHALIPOICO 20ML MOL", activo: true },
  { code: "SANNA01", name: "ANTIOX - NAD 25 ML", activo: true },
  { code: "SANNA02", name: "ANTIOX - NAD PLUS 25 ML", activo: true },
  { code: "ANT001", name: "ANTOXMOL X 100 COMP", activo: true },
  { code: "AM3ML", name: "AZUL DE METILENO 3ML MOL", activo: false },
  { code: "AM4ML", name: "AZUL DE METILENO 4ML MOL", activo: false },
  { code: "AM5ML", name: "AZUL DE METILENO 5ML MOL", activo: false },
  { code: "PTAZUME01", name: "AZUL METILENO 10ML MOL", activo: true },
  { code: "GLU001", name: "BIO GLUTATHIONE AMP 2ML", activo: true },
  { code: "PTBIOT01", name: "BIOTINA B7 10ML MOL", activo: true },
  { code: "PTCARN01", name: "CARNITINA 10ML MOL", activo: false },
  { code: "CLODECA01", name: "CLORURO DE CALCIO 10ML MOLECULA", activo: true },
  { code: "PTCOMB01", name: "COMPLEJO B 10ML MOL", activo: true },
  { code: "COM001", name: "COMVIPLEX FCO X 200G", activo: true },
  { code: "PTCROM01", name: "CROMO 10ML MOL COMPL", activo: true },
  { code: "PTDMS002", name: "DMSO PLUS 10ML", activo: true },
  { code: "PTDMS001", name: "DMSO PLUS 25ML MOL", activo: true },
  { code: "FOE001", name: "FOENIL JARABE FCO X 120ML", activo: true },
  { code: "PTGLU01", name: "GLUTACELL 600", activo: true },
  { code: "HEVI01", name: "HEPASYN VIAL 10ML MOL", activo: true },
  { code: "INMAX01", name: "INFILMAX NOVA 10ML", activo: true },
  { code: "PTLIS01", name: "LISINA 10ML MOL", activo: true },
  { code: "PTMEGC01", name: "MEGADOSIS VITAMINA C 50ML MOL", activo: true },
  { code: "PTBIOPR02", name: "MOLECULA - BIOREGEN PRIME 25ML", activo: false },
  { code: "PTNEUREG01", name: "NEURO REGENERADOR 10 ML MOL ROCAB", activo: false },
  { code: "PTNEUREG03", name: "NEURO REGENERADOR 10 ML MOL ROCAB", activo: true },
  { code: "PTNEUREGNOV01", name: "NEURO REGENERADOR 20ML MOL NOVA", activo: true },
  { code: "PTPANT01", name: "PANTENOL B5 10ML MOL", activo: true },
  { code: "PTPLMA01", name: "PLASMA MARINO 100ML MOL", activo: true },
  { code: "PTSIL01", name: "SILICIO 10ML MOL COMPL", activo: true },
  { code: "PTMPL01", name: "SUEROTERAPIA M19 PLUS 10ML MOL", activo: true },
  { code: "PTMAGN01", name: "SUEROTERAPIA MAGNESIO 10ML MOL", activo: true },
  { code: "REMET01", name: "SUEROTERAPIA REDUCTOR METABOLICO NOVA 10ML MOL", activo: true },
  { code: "ECNOV01", name: "SUEROTERAPIA SISTEMA INMUNE ECHINOVA 10ML MOL", activo: true },
  { code: "TRAR001", name: "TRARNICREM TUBO X60GR", activo: true },
  { code: "PTTRGA01", name: "TRIPTOFANO + GABA TAB", activo: true },
  { code: "PTTRMG01", name: "TRIPTOFANO CON MAGNESIO + VITAMINA B6 TAB", activo: true },
];

// Lista única ya etiquetada, que es como la pinta el buscador del suero.
export const SUERO_COMPONENTES = [
  ...SUERO_AMPOLLAS.map((a) => ({ ...a, grupo: 'ampolla' })),
  ...SUERO_MOLECULAS.map((m) => ({ ...m, grupo: 'molecula' })),
];

export const SUERO_GRUPO_LABEL = { ampolla: 'Ampolla', molecula: 'Molécula', otro: 'Otro' };

/** Nombre → clave de comparación: sin tildes, sin dobles espacios, mayúsculas. */
export const claveSuero = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();

const PORCODIGO = new Map(SUERO_COMPONENTES.map((x) => [claveSuero(x.code), x]));
// Con nombres repetidos gana el VIGENTE: es el que enseña el buscador, y
// guardar el código dado de baja deja la ampolla sin descontar del inventario.
// Espejo exacto del servidor.
const PORNOMBRE = new Map();
SUERO_COMPONENTES.forEach((x) => {
  const k = claveSuero(x.name);
  const previo = PORNOMBRE.get(k);
  if (!previo || (!previo.activo && x.activo)) PORNOMBRE.set(k, x);
});

/**
 * Busca un componente por código o nombre. Devuelve null si es algo escrito a
 * mano, que NO es un error: el catálogo es una ayuda, no una jaula.
 */
export const buscarComponenteSuero = ({ code, name } = {}) =>
  (code && PORCODIGO.get(claveSuero(code))) || (name && PORNOMBRE.get(claveSuero(name))) || null;
