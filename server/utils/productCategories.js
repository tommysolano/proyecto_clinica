/**
 * Taxonomía de productos del inventario.
 *
 * OJO con los nombres de los campos en el modelo Product:
 *   - `category`  = el TIPO del producto (en la UI se muestra como "Tipo").
 *                   Solo 3 valores. Antes existían 'medicamento' y 'otro';
 *                   'medicamento' se unificó con 'insumo'.
 *   - `categoria` = la CATEGORÍA comercial del producto (campo nuevo, "Categoría"
 *                   en la UI). Una de las opciones de PRODUCT_CATEGORIES.
 */

// Tipo de producto (campo `category`).
const PRODUCT_TYPES = ['insumo', 'servicio', 'programa'];

// Categoría comercial del producto (campo `categoria`).
const PRODUCT_CATEGORIES = [
  'SERVICIOS MEDICOS',
  'MOLECULAS',
  'AMPOLLAS',
  'TABLETAS',
  'GOTAS - HOMEOPATICAS',
  'SERVICIOS - GOTAS',
  'SERVICIOS SALUD VISUAL',
  'ARMAZON/MARCO',
  'SOBRES',
  'SUERO TERAPIAS',
  'SUEROS',
  'CREMAS',
  'JARABES',
  'SERVICIO ODONTOLOGICO',
  'SPRAY',
  'PANEL EMBARAZO',
  'PANEL ITS FEMENINO',
  'EQUIPO ZETTA',
  'EXAMENES ADICIONALES',
  'PRUEBAS RAPIDAS',
  'INMUNOHEMATOLOGÍA',
  'ELECTROLITOS Y MINERALES',
  'BIOQUÍMICA',
  'SERVICIOS CARDIOLOGÍA',
  'EXAMENES DE LABORATORIO',
  'OZONO',
];

/**
 * Normaliza un texto a una categoría canónica (ignora mayúsculas/acentos/espacios).
 * Devuelve la categoría exacta de PRODUCT_CATEGORIES o '' si no coincide.
 */
function normalizeCategoria(input) {
  if (!input) return '';
  const stripAccents = (s) =>
    s.replace(/[ÁÀÄÂáàäâ]/g, 'A')
      .replace(/[ÉÈËÊéèëê]/g, 'E')
      .replace(/[ÍÌÏÎíìïî]/g, 'I')
      .replace(/[ÓÒÖÔóòöô]/g, 'O')
      .replace(/[ÚÙÜÛúùüû]/g, 'U');
  const norm = (s) =>
    stripAccents(String(s).toUpperCase())
      .replace(/\s+/g, ' ')
      .trim();
  const target = norm(input);
  return PRODUCT_CATEGORIES.find((c) => norm(c) === target) || '';
}

module.exports = { PRODUCT_TYPES, PRODUCT_CATEGORIES, normalizeCategoria };
