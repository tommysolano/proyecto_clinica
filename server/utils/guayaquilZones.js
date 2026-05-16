// Sectores oficiales de Guayaquil (clasificación municipal aproximada).
// Estos son los sectores/parroquias urbanas reconocidos por la Alcaldía
// y se usan para autocompletar el campo "dirección" al facturar y para
// generar el mapa de calor de procedencia de pacientes.
//
// Cada zona incluye coordenadas (lat, lng) aproximadas del centroide para
// poder pintar el heatmap sin necesidad de un servicio externo.

const GUAYAQUIL_ZONES = [
  { name: 'Tarqui', parroquia: 'Tarqui', lat: -2.135, lng: -79.910 },
  { name: 'Ximena', parroquia: 'Ximena', lat: -2.245, lng: -79.890 },
  { name: 'Febres Cordero', parroquia: 'Febres Cordero', lat: -2.205, lng: -79.920 },
  { name: 'García Moreno', parroquia: 'García Moreno', lat: -2.180, lng: -79.895 },
  { name: 'Pedro Carbo', parroquia: 'Pedro Carbo', lat: -2.190, lng: -79.880 },
  { name: 'Rocafuerte', parroquia: 'Rocafuerte', lat: -2.200, lng: -79.880 },
  { name: 'Bolívar (Sagrario)', parroquia: 'Bolívar', lat: -2.195, lng: -79.882 },
  { name: 'Sucre', parroquia: 'Sucre', lat: -2.200, lng: -79.900 },
  { name: 'Olmedo (San Alejo)', parroquia: 'Olmedo', lat: -2.210, lng: -79.886 },
  { name: '9 de Octubre', parroquia: '9 de Octubre', lat: -2.190, lng: -79.890 },
  { name: 'Roca', parroquia: 'Roca', lat: -2.180, lng: -79.890 },
  { name: 'Letamendi', parroquia: 'Letamendi', lat: -2.210, lng: -79.910 },
  { name: 'Ayacucho', parroquia: 'Ayacucho', lat: -2.215, lng: -79.895 },
  { name: 'Urdaneta', parroquia: 'Urdaneta', lat: -2.185, lng: -79.885 },
  // Zonas residenciales / urbanizaciones populares
  { name: 'Urdesa', parroquia: 'Tarqui', lat: -2.170, lng: -79.910 },
  { name: 'Kennedy', parroquia: 'Tarqui', lat: -2.150, lng: -79.900 },
  { name: 'Alborada', parroquia: 'Tarqui', lat: -2.130, lng: -79.900 },
  { name: 'Sauces', parroquia: 'Tarqui', lat: -2.120, lng: -79.895 },
  { name: 'Garzota', parroquia: 'Tarqui', lat: -2.130, lng: -79.905 },
  { name: 'Samanes', parroquia: 'Tarqui', lat: -2.115, lng: -79.900 },
  { name: 'Guayacanes', parroquia: 'Tarqui', lat: -2.125, lng: -79.890 },
  { name: 'Los Ceibos', parroquia: 'Tarqui', lat: -2.160, lng: -79.940 },
  { name: 'Mapasingue', parroquia: 'Tarqui', lat: -2.155, lng: -79.920 },
  { name: 'Miraflores', parroquia: 'Tarqui', lat: -2.165, lng: -79.920 },
  { name: 'Urdesa Central', parroquia: 'Tarqui', lat: -2.170, lng: -79.915 },
  { name: 'Vía a la Costa', parroquia: 'Tarqui', lat: -2.180, lng: -80.000 },
  { name: 'Vía a Samborondón', parroquia: 'Tarqui', lat: -2.140, lng: -79.870 },
  { name: 'Vía a Daule', parroquia: 'Pascuales', lat: -2.085, lng: -79.910 },
  { name: 'Pascuales', parroquia: 'Pascuales', lat: -2.080, lng: -79.905 },
  // Parroquias rurales
  { name: 'Tenguel', parroquia: 'Tenguel', lat: -3.020, lng: -79.810 },
  { name: 'Posorja', parroquia: 'Posorja', lat: -2.706, lng: -80.245 },
  { name: 'Puná', parroquia: 'Puná', lat: -2.812, lng: -80.116 },
  { name: 'El Morro', parroquia: 'El Morro', lat: -2.683, lng: -80.301 },
  { name: 'Juan Gómez Rendón (Progreso)', parroquia: 'Progreso', lat: -2.395, lng: -80.385 },
];

const NAME_SET = new Set(GUAYAQUIL_ZONES.map((z) => z.name.toLowerCase()));

function isValidGuayaquilZone(name) {
  if (!name) return false;
  return NAME_SET.has(String(name).trim().toLowerCase());
}

function findZone(name) {
  if (!name) return null;
  const k = String(name).trim().toLowerCase();
  return GUAYAQUIL_ZONES.find((z) => z.name.toLowerCase() === k) || null;
}

module.exports = { GUAYAQUIL_ZONES, isValidGuayaquilZone, findZone };
