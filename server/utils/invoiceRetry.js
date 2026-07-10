/**
 * Manejo de caídas del SRI y reintentos automáticos de facturas electrónicas.
 *
 * El SRI falla con frecuencia. Este módulo implementa la máquina de estados que
 * lleva una factura desde EN_COLA hasta AUTORIZADO sin perderla y sin que el
 * usuario tenga que corregir una por una:
 *
 *   EN_COLA / ERROR ──(enviarComprobante)──▶ RECIBIDA ──(autorizar)──▶ AUTORIZADO
 *        ▲   caído                              │  procesando            │
 *        └──────── reintento con backoff ◀──────┴── EN_PROCESO ──────────┘
 *
 * - Los errores de CONECTIVIDAD (SRI caído/timeout) NO cambian el comprobante a
 *   ERROR: se deja EN_COLA / se mantiene el estado y se programa un reintento.
 * - Los rechazos de NEGOCIO (DEVUELTA / NO_AUTORIZADO) sí son definitivos y
 *   requieren corrección manual (no se reintentan solos).
 * - La fecha de emisión y la clave de acceso se generan UNA vez y NO se
 *   regeneran al reintentar: mantener la fecha de emisión original es lo correcto
 *   en Ecuador (la clave la codifica). Si el SRI autoriza otro día, la fecha de
 *   emisión se conserva y el frontend muestra una advertencia administrativa.
 */
const Invoice = require('../models/Invoice');
const sriClient = require('../modules/invoicing/ec/sriClient');
const { isConnectivityError } = sriClient;

// Backoff por número de reintento (minutos). Se satura en 4 horas.
const BACKOFF_MIN = [1, 3, 10, 30, 60, 120, 240];
// Tras estos reintentos automáticos, el comprobante deja de reintentarse solo y
// requiere el botón manual "Reintentar" (evita golpear al SRI indefinidamente
// por un error que no es transitorio).
const MAX_AUTO_RETRIES = 24;

function nextBackoff(reintentos) {
  const i = Math.min(Math.max(Number(reintentos) || 0, 0), BACKOFF_MIN.length - 1);
  return new Date(Date.now() + BACKOFF_MIN[i] * 60 * 1000);
}

function pushIntento(invoice, tipo, estado, mensaje) {
  if (!Array.isArray(invoice.intentos)) invoice.intentos = [];
  invoice.intentos.push({
    at: new Date(),
    tipo,
    estado,
    mensaje: mensaje ? String(mensaje).slice(0, 500) : undefined,
  });
  if (invoice.intentos.length > 30) {
    invoice.intentos = invoice.intentos.slice(-30);
  }
}

function parseMensajes(node) {
  if (!node) return [];
  const arr = Array.isArray(node) ? node : [node];
  return arr
    .filter(Boolean)
    .map((m) => ({
      identificador: m.identificador,
      mensaje: m.mensaje,
      informacionAdicional: m.informacionAdicional,
      tipo: m.tipo,
    }));
}

// ¿La recepción devolvió el comprobante porque la clave YA estaba registrada?
// (identificador 43 del SRI). En ese caso no es un rechazo: la factura ya fue
// recibida en un intento anterior y hay que pasar directo a autorización.
function claveYaRegistrada(mensajes) {
  return (mensajes || []).some(
    (m) =>
      String(m.identificador) === '43' ||
      /clave\s*(de\s*)?acceso\s*(registrad|repetid)/i.test(
        `${m.identificador || ''} ${m.mensaje || ''}`
      )
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Avanza UNA factura al siguiente estado según su situación actual.
 * Muta y guarda el documento. No lanza por errores del SRI (los captura y los
 * refleja en el estado); solo puede lanzar por errores de BD.
 *
 * @param {import('mongoose').Document} invoice
 * @param {object} [opts]
 * @param {object} [opts.client] cliente SRI inyectable (para tests)
 * @param {boolean} [opts.force] procesar aunque sea estado final no-autorizado
 * @param {number} [opts.authAttempts] nº de consultas de autorización en esta pasada
 * @param {number} [opts.authDelayMs] espera entre consultas de autorización
 */
async function processInvoice(invoice, opts = {}) {
  const client = opts.client || sriClient;
  const ambiente = invoice.ambiente || '1';
  const authAttempts = Math.max(1, opts.authAttempts || 1);
  const authDelayMs = opts.authDelayMs || 0;

  // Estados finales: no hacer nada (salvo force para NO_AUTORIZADO).
  if (['AUTORIZADO', 'ANULADA'].includes(invoice.estado)) return invoice;
  if (invoice.estado === 'NO_AUTORIZADO' && !opts.force) return invoice;

  // ── Paso 1: RECEPCIÓN (enviar el XML firmado) ──────────────────────────────
  const needsSend = ['EN_COLA', 'ERROR', 'DEVUELTA'].includes(invoice.estado);
  if (needsSend) {
    if (!invoice.xmlFirmado) {
      invoice.estado = 'ERROR';
      invoice.errorUltimo = 'La factura no tiene XML firmado; debe reemitirse.';
      pushIntento(invoice, 'RECEPCION', 'ERROR', invoice.errorUltimo);
      await invoice.save();
      return invoice;
    }
    try {
      const rec = await client.enviarComprobante(invoice.xmlFirmado, ambiente);
      const mensajes = parseMensajes(rec?.comprobantes?.comprobante?.mensajes?.mensaje);
      if (rec?.estado === 'RECIBIDA') {
        invoice.estado = 'RECIBIDA';
        if (mensajes.length) invoice.mensajesSri = mensajes;
        pushIntento(invoice, 'RECEPCION', 'RECIBIDA');
      } else if (claveYaRegistrada(mensajes)) {
        // Ya la tenían recibida: continuar a autorización.
        invoice.estado = 'RECIBIDA';
        pushIntento(invoice, 'RECEPCION', 'YA_REGISTRADA');
      } else {
        // Rechazo de negocio en recepción: requiere corrección manual.
        invoice.estado = 'DEVUELTA';
        if (mensajes.length) invoice.mensajesSri = mensajes;
        invoice.errorUltimo = mensajes[0]?.mensaje || 'Comprobante devuelto por el SRI';
        invoice.reintentos = (invoice.reintentos || 0) + 1;
        invoice.proximoReintento = null;
        pushIntento(invoice, 'RECEPCION', 'DEVUELTA', invoice.errorUltimo);
        await invoice.save();
        return invoice;
      }
    } catch (e) {
      invoice.reintentos = (invoice.reintentos || 0) + 1;
      invoice.proximoReintento = nextBackoff(invoice.reintentos);
      if (isConnectivityError(e)) {
        // SRI caído: NO marcar ERROR; dejar en cola para reintentar.
        invoice.estado = 'EN_COLA';
        invoice.errorUltimo = `SRI no disponible: ${e.message}`;
        pushIntento(invoice, 'RECEPCION', 'SRI_NO_DISPONIBLE', e.message);
      } else {
        invoice.estado = 'ERROR';
        invoice.errorUltimo = e.message;
        pushIntento(invoice, 'RECEPCION', 'ERROR', e.message);
      }
      await invoice.save();
      return invoice;
    }
  }

  // ── Paso 2: AUTORIZACIÓN (consultar por clave de acceso) ────────────────────
  if (['RECIBIDA', 'EN_PROCESO'].includes(invoice.estado)) {
    for (let i = 0; i < authAttempts; i++) {
      if (authDelayMs) await sleep(authDelayMs);
      try {
        const aut = await client.autorizarComprobante(invoice.claveAcceso, ambiente);
        const list = aut?.autorizaciones?.autorizacion;
        const item = Array.isArray(list) ? list[0] : list;
        const estado = String(item?.estado || '').toUpperCase();
        if (estado === 'AUTORIZADO') {
          invoice.estado = 'AUTORIZADO';
          invoice.numeroAutorizacion = item.numeroAutorizacion;
          invoice.fechaAutorizacion = item.fechaAutorizacion;
          invoice.xmlAutorizado = item.comprobante;
          invoice.proximoReintento = null;
          invoice.errorUltimo = null;
          pushIntento(invoice, 'AUTORIZACION', 'AUTORIZADO');
          break;
        } else if (estado === 'NO AUTORIZADO' || estado === 'NO_AUTORIZADO') {
          invoice.estado = 'NO_AUTORIZADO';
          const mensajes = parseMensajes(item?.mensajes?.mensaje);
          if (mensajes.length) invoice.mensajesSri = mensajes;
          invoice.errorUltimo = mensajes[0]?.mensaje || 'No autorizado por el SRI';
          invoice.proximoReintento = null;
          pushIntento(invoice, 'AUTORIZACION', 'NO_AUTORIZADO', invoice.errorUltimo);
          break;
        } else {
          // Aún en proceso: programar reintento posterior.
          invoice.estado = 'EN_PROCESO';
          invoice.reintentos = (invoice.reintentos || 0) + 1;
          invoice.proximoReintento = nextBackoff(invoice.reintentos);
          pushIntento(invoice, 'AUTORIZACION', 'EN_PROCESO');
        }
      } catch (e) {
        invoice.reintentos = (invoice.reintentos || 0) + 1;
        invoice.proximoReintento = nextBackoff(invoice.reintentos);
        if (isConnectivityError(e)) {
          invoice.errorUltimo = `SRI no disponible: ${e.message}`;
          pushIntento(invoice, 'AUTORIZACION', 'SRI_NO_DISPONIBLE', e.message);
        } else {
          invoice.estado = 'ERROR';
          invoice.errorUltimo = e.message;
          pushIntento(invoice, 'AUTORIZACION', 'ERROR', e.message);
        }
        break;
      }
    }
  }

  await invoice.save();
  return invoice;
}

/**
 * Procesa la cola de facturas pendientes (las que se pueden avanzar solas).
 * @param {object} [opts]
 * @param {string|import('mongoose').Types.ObjectId} [opts.clinicId] limitar a una clínica
 * @param {boolean} [opts.force] ignorar backoff y tope de reintentos (botón manual)
 * @param {number} [opts.limit]
 * @param {object} [opts.client] cliente SRI inyectable (tests)
 */
async function runInvoiceRetryQueue(opts = {}) {
  const { clinicId, force = false, limit = 50, client } = opts;
  const query = {
    estado: { $in: ['EN_COLA', 'RECIBIDA', 'EN_PROCESO', 'ERROR'] },
  };
  if (clinicId) query.clinic = clinicId;
  if (!force) {
    query.reintentos = { $lt: MAX_AUTO_RETRIES };
    query.$or = [{ proximoReintento: null }, { proximoReintento: { $lte: new Date() } }];
  }

  const pendientes = await Invoice.find(query)
    .sort({ proximoReintento: 1, createdAt: 1 })
    .limit(limit);

  let processed = 0;
  let autorizadas = 0;
  for (const inv of pendientes) {
    try {
      await processInvoice(inv, { client, force });
      processed++;
      if (inv.estado === 'AUTORIZADO') autorizadas++;
    } catch (e) {
      console.error('[invoiceRetry] error procesando', String(inv._id), e.message);
    }
  }
  return { found: pendientes.length, processed, autorizadas };
}

/**
 * Arranca el job de reintentos: primera pasada a los 20s del arranque y luego
 * cada SRI_RETRY_INTERVAL_MIN minutos (por defecto 5).
 */
function startInvoiceRetryJob() {
  const RUN_MS =
    Math.max(1, Number(process.env.SRI_RETRY_INTERVAL_MIN) || 5) * 60 * 1000;
  const run = () =>
    runInvoiceRetryQueue()
      .then((r) => {
        if (r.found) {
          console.log(
            `[invoiceRetry] ${r.processed}/${r.found} facturas procesadas, ${r.autorizadas} autorizada(s).`
          );
        }
      })
      .catch((e) => console.error('[invoiceRetry] job error:', e.message));
  setTimeout(run, 20 * 1000);
  setInterval(run, RUN_MS);
}

module.exports = {
  processInvoice,
  runInvoiceRetryQueue,
  startInvoiceRetryJob,
  nextBackoff,
  isConnectivityError,
  MAX_AUTO_RETRIES,
};
