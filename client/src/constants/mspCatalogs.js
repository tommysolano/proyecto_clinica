/**
 * Espejo de server/constants/mspCatalogs.js (catálogos del formulario MSP
 * HCU-form.002 / 2021). Las `key` DEBEN coincidir con las del servidor: son las
 * que se guardan en la base y las que arma el PDF oficial.
 */

// C y D comparten las mismas 10 categorías de antecedentes patológicos.
export const ANTECEDENTES_CATEGORIAS = [
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
export const REVISION_SISTEMAS = [
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
export const EXAMEN_REGIONAL = [
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
export const EXAMEN_SISTEMICO = [
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

// IMC (Kg/m²) a partir de peso (kg) y talla (cm). Devuelve string con 2 decimales o ''.
export function calcIMC(weight, height) {
  const w = Number(weight);
  const h = Number(height) / 100;
  if (!w || !h) return '';
  return (w / (h * h)).toFixed(2);
}
