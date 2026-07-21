/**
 * TRADUCCIÓN DE ERRORES A RESPUESTAS LEGIBLES.
 *
 * Ningún usuario debe ver jamás un error crudo de MongoDB. El caso que motivó esto: editar una
 * compra con un activo fijo, o agregarle una retención, reventaba con
 *   «E11000 duplicate key error collection: clinica_db.fixedassets index: clinic_1_code_1 dup key…»
 * en la cara de la contadora. Aquí se traduce cualquier error conocido de Mongoose/Mongo a un
 * mensaje claro con el status correcto; el detalle técnico se queda en los logs del servidor.
 *
 * Se usa en dos lugares que comparten esta MISMA lógica:
 *   · los `catch` de los controladores (que responden dentro de su transacción) vía `sendError`;
 *   · el middleware de errores GLOBAL de Express, para cualquier error no atrapado.
 */

// Nombre legible de la entidad a partir del nombre de la colección Mongo (…fixedassets → Activos
// fijos). Sin match, se devuelve el propio nombre de la colección (mejor que nada).
const COLLECTION_LABELS = {
  fixedassets: 'Activos fijos',
  chartofaccounts: 'Plan de cuentas',
  purchaseinvoices: 'Compras',
  retentionvouchers: 'Comprobantes de retención',
  suppliers: 'Proveedores',
  products: 'Productos',
  users: 'Usuarios',
  patients: 'Pacientes',
  journalentries: 'Asientos contables',
};

/** Extrae la colección del texto del E11000 (`… collection: db.<coleccion> index: …`). */
function collectionFromMessage(message) {
  const m = /collection:\s+\S+?\.(\w+)/.exec(String(message || ''));
  return m ? m[1] : null;
}

/**
 * Convierte un error en `{ status, body }` listo para responder. `body.message` es SIEMPRE legible.
 * No registra nada (eso lo decide quien llama): `sendError` y el middleware sí logean el crudo.
 */
function formatError(err) {
  // Clave duplicada (índice único). `keyValue`/`keyPattern` traen el campo y el valor en conflicto.
  if (err && err.code === 11000) {
    const coleccion = collectionFromMessage(err.message);
    const entidad = (coleccion && COLLECTION_LABELS[coleccion]) || coleccion || 'el sistema';
    // Se ignora `clinic` (siempre presente en los índices multi-tenant): interesa el campo real.
    const claves = err.keyValue && typeof err.keyValue === 'object' ? { ...err.keyValue } : {};
    delete claves.clinic;
    const campos = Object.entries(claves);
    const detalle = campos.length
      ? campos.map(([k, v]) => `${k} «${v}»`).join(', ')
      : 'los mismos datos';
    return {
      status: 409,
      body: { message: `Ya existe un registro con ${detalle} en ${entidad}.`, code: 'DUPLICATE_KEY' },
    };
  }
  // Validación de Mongoose (campos requeridos, enums…): datos inválidos → 400.
  if (err && err.name === 'ValidationError' && err.errors) {
    const detalles = Object.values(err.errors).map((e) => e.message);
    return { status: 400, body: { message: detalles.join('; ') || 'Datos inválidos', code: 'VALIDATION' } };
  }
  // Id mal formado (Cast to ObjectId failed…): no exponer el detalle interno.
  if (err && err.name === 'CastError') {
    return { status: 400, body: { message: 'Uno de los identificadores enviados no es válido.', code: 'CAST' } };
  }
  // Errores de negocio ya tipados por los controladores (llevan `status` y mensaje pensado para el
  // usuario) se respetan tal cual, junto con su `payload` (p.ej. SRI_MISMATCH, COST_CENTER_MISMATCH).
  const status = err && (err.status || err.statusCode);
  if (status && status < 500) {
    return { status, body: { message: err.message, ...(err.payload || {}) } };
  }
  // Cualquier otra cosa es un fallo del servidor: mensaje genérico al usuario, detalle solo en logs.
  return { status: status || 500, body: { message: 'Ocurrió un error al procesar la solicitud.', code: 'INTERNAL' } };
}

/** Responde `res` con la traducción de `err`, logeando el detalle técnico (crudo) del servidor. */
function sendError(res, err) {
  const { status, body } = formatError(err);
  if (status >= 500 || (err && err.code === 11000)) {
    // El crudo (con el índice y la clave real) queda SOLO en el log del servidor.
    console.error('[apiError]', err && err.stack ? err.stack : err);
  }
  return res.status(status).json(body);
}

/** Middleware de errores GLOBAL de Express (4 args). Red de seguridad para cualquier error no atrapado. */
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  if (res.headersSent) return next(err);
  return sendError(res, err);
}

module.exports = { formatError, sendError, errorHandler, collectionFromMessage };
