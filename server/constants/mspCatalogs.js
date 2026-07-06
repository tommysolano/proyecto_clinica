/**
 * Catálogos del formulario MSP HCU-form.002 / 2021 (Consulta Externa).
 * Estas listas definen las casillas fijas de la hoja física y son la fuente
 * de verdad tanto para el esquema (claves) como para el PDF oficial (etiquetas).
 *
 * IMPORTANTE: existe un espejo en client/src/constants/mspCatalogs.js. Si cambias
 * una `key` aquí, cámbiala también allá (y viceversa) o se romperá el mapeo.
 */

// C y D comparten las mismas 10 categorías de antecedentes patológicos.
const ANTECEDENTES_CATEGORIAS = [
  { key: 'cardiopatia', label: 'Cardiopatía' },
  { key: 'hipertension', label: 'Hipertensión' },
  { key: 'cerebroVascular', label: 'Enf. Cerebro Vascular' },
  { key: 'endocrinoMetabolico', label: 'Endócrino Metabólico' },
  { key: 'cancer', label: 'Cáncer' },
  { key: 'tuberculosis', label: 'Tuberculosis' },
  { key: 'enfMental', label: 'Enf. Mental' },
  { key: 'enfInfecciosa', label: 'Enf. Infecciosa' },
  { key: 'malformacion', label: 'Mal Formación' },
  { key: 'otro', label: 'Otro' },
];

// G. Revisión actual de órganos y sistemas (10).
const REVISION_SISTEMAS = [
  { key: 'pielAnexos', label: 'Piel - anexos' },
  { key: 'organosSentidos', label: 'Órganos de los sentidos' },
  { key: 'respiratorio', label: 'Respiratorio' },
  { key: 'cardioVascular', label: 'Cardio - vascular' },
  { key: 'digestivo', label: 'Digestivo' },
  { key: 'genitoUrinario', label: 'Genito - urinario' },
  { key: 'musculoEsqueletico', label: 'Músculo - esquelético' },
  { key: 'endocrino', label: 'Endocrino' },
  { key: 'hemoLinfatico', label: 'Hemo - linfático' },
  { key: 'nervioso', label: 'Nervioso' },
];

// H. Examen físico — Regional (15).
const EXAMEN_REGIONAL = [
  { key: 'pielFaneras', label: 'Piel - faneras' },
  { key: 'cabeza', label: 'Cabeza' },
  { key: 'ojos', label: 'Ojos' },
  { key: 'oidos', label: 'Oídos' },
  { key: 'nariz', label: 'Nariz' },
  { key: 'boca', label: 'Boca' },
  { key: 'orofaringe', label: 'Orofaringe' },
  { key: 'cuello', label: 'Cuello' },
  { key: 'axilasMamas', label: 'Axilas - mamas' },
  { key: 'torax', label: 'Tórax' },
  { key: 'abdomen', label: 'Abdomen' },
  { key: 'columnaVertebral', label: 'Columna vertebral' },
  { key: 'inglePerine', label: 'Ingle - periné' },
  { key: 'miembrosSuperiores', label: 'Miembros superiores' },
  { key: 'miembrosInferiores', label: 'Miembros inferiores' },
];

// H. Examen físico — Sistémico (10).
const EXAMEN_SISTEMICO = [
  { key: 'organosSentidos', label: 'Órganos de los sentidos' },
  { key: 'respiratorio', label: 'Respiratorio' },
  { key: 'cardioVascular', label: 'Cardio - vascular' },
  { key: 'digestivo', label: 'Digestivo' },
  { key: 'genital', label: 'Genital' },
  { key: 'urinario', label: 'Urinario' },
  { key: 'musculoEsqueletico', label: 'Músculo - esquelético' },
  { key: 'endocrino', label: 'Endócrino' },
  { key: 'hemoLinfatico', label: 'Hemo - linfático' },
  { key: 'neurologico', label: 'Neurológico' },
];

const ANTECEDENTES_KEYS = ANTECEDENTES_CATEGORIAS.map((c) => c.key);
const REVISION_SISTEMAS_KEYS = REVISION_SISTEMAS.map((c) => c.key);
const EXAMEN_REGIONAL_KEYS = EXAMEN_REGIONAL.map((c) => c.key);
const EXAMEN_SISTEMICO_KEYS = EXAMEN_SISTEMICO.map((c) => c.key);

module.exports = {
  ANTECEDENTES_CATEGORIAS,
  REVISION_SISTEMAS,
  EXAMEN_REGIONAL,
  EXAMEN_SISTEMICO,
  ANTECEDENTES_KEYS,
  REVISION_SISTEMAS_KEYS,
  EXAMEN_REGIONAL_KEYS,
  EXAMEN_SISTEMICO_KEYS,
};
