/**
 * Manejo de caídas del SRI y reintentos automáticos (requerimiento 10).
 *
 * Verifica la máquina de estados de utils/invoiceRetry.processInvoice con un
 * cliente SRI simulado (inyectado): si el SRI está caído la factura NO se pierde
 * (queda EN_COLA y se reprograma), si responde avanza RECIBIDA→AUTORIZADO, los
 * rechazos de negocio no se reintentan solos, y la cola procesa las pendientes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Invoice = require('../models/Invoice');
const {
  processInvoice,
  runInvoiceRetryQueue,
  isConnectivityError,
} = require('../utils/invoiceRetry');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

let seq = 0;
async function makeInvoice(clinicId, overrides = {}) {
  seq += 1;
  return Invoice.create({
    clinic: clinicId,
    claveAcceso: `CLAVE${Date.now()}${seq}`.padEnd(49, '0'),
    secuencial: String(seq).padStart(9, '0'),
    estab: '001',
    ptoEmi: '001',
    ambiente: '1',
    fechaEmision: '10/07/2026',
    estado: 'EN_COLA',
    xmlFirmado: '<factura/>',
    importeTotal: 100,
    ...overrides,
  });
}

// Respuestas SRI simuladas.
const recRecibida = () => ({ estado: 'RECIBIDA' });
const recDevuelta = (mensaje = { identificador: '45', mensaje: 'RUC no existe', tipo: 'ERROR' }) => ({
  estado: 'DEVUELTA',
  comprobantes: { comprobante: { mensajes: { mensaje } } },
});
const autAutorizado = () => ({
  autorizaciones: {
    autorizacion: {
      estado: 'AUTORIZADO',
      numeroAutorizacion: '1234567890',
      fechaAutorizacion: new Date(),
      comprobante: '<autorizado/>',
    },
  },
});
const autNoAutorizado = () => ({
  autorizaciones: {
    autorizacion: {
      estado: 'NO AUTORIZADO',
      mensajes: { mensaje: { identificador: '70', mensaje: 'Firma inválida', tipo: 'ERROR' } },
    },
  },
});
const autEnProceso = () => ({ autorizaciones: null });

const downError = () => {
  const e = new Error('Timeout SRI tras 30000ms');
  return e;
};

test('SRI caído en recepción: la factura NO se pierde, queda EN_COLA y se reprograma', async () => {
  const { clinicId } = await H.seedClinic();
  const inv = await makeInvoice(clinicId);
  let authCalled = false;
  const client = {
    enviarComprobante: async () => { throw downError(); },
    autorizarComprobante: async () => { authCalled = true; return autAutorizado(); },
  };

  await processInvoice(inv, { client });

  assert.equal(inv.estado, 'EN_COLA', 'sigue en cola, no pasa a ERROR');
  assert.equal(inv.reintentos, 1);
  assert.ok(inv.proximoReintento instanceof Date, 'programa un próximo reintento');
  assert.equal(authCalled, false, 'no consulta autorización si no llegó a recibirse');
  assert.ok(inv.intentos.some((i) => i.estado === 'SRI_NO_DISPONIBLE'));
  assert.match(inv.errorUltimo, /no disponible/i);
});

test('Flujo feliz: recepción RECIBIDA y autorización AUTORIZADO', async () => {
  const { clinicId } = await H.seedClinic();
  const inv = await makeInvoice(clinicId);
  const client = {
    enviarComprobante: async () => recRecibida(),
    autorizarComprobante: async () => autAutorizado(),
  };

  await processInvoice(inv, { client });

  assert.equal(inv.estado, 'AUTORIZADO');
  assert.equal(inv.numeroAutorizacion, '1234567890');
  assert.ok(inv.xmlAutorizado);
  assert.equal(inv.proximoReintento, null, 'no reprograma tras autorizar');
  assert.equal(inv.errorUltimo, null);
});

test('Rechazo de negocio en recepción (DEVUELTA) no se reintenta automáticamente', async () => {
  const { clinicId } = await H.seedClinic();
  const inv = await makeInvoice(clinicId);
  const client = {
    enviarComprobante: async () => recDevuelta(),
    autorizarComprobante: async () => autAutorizado(),
  };

  await processInvoice(inv, { client });

  assert.equal(inv.estado, 'DEVUELTA');
  assert.equal(inv.proximoReintento, null, 'no se reprograma: requiere corrección manual');
  assert.equal(inv.mensajesSri.length, 1);
  assert.match(inv.mensajesSri[0].mensaje, /RUC/);
});

test('Clave ya registrada (id 43) salta a autorización en vez de devolver', async () => {
  const { clinicId } = await H.seedClinic();
  const inv = await makeInvoice(clinicId);
  const client = {
    enviarComprobante: async () =>
      recDevuelta({ identificador: '43', mensaje: 'CLAVE ACCESO REGISTRADA', tipo: 'ERROR' }),
    autorizarComprobante: async () => autAutorizado(),
  };

  await processInvoice(inv, { client });

  assert.equal(inv.estado, 'AUTORIZADO');
});

test('Recibida pero aún en proceso: queda EN_PROCESO con reintento programado', async () => {
  const { clinicId } = await H.seedClinic();
  const inv = await makeInvoice(clinicId, { estado: 'RECIBIDA' });
  const client = {
    enviarComprobante: async () => recRecibida(),
    autorizarComprobante: async () => autEnProceso(),
  };

  await processInvoice(inv, { client });

  assert.equal(inv.estado, 'EN_PROCESO');
  assert.ok(inv.proximoReintento instanceof Date);
});

test('No autorizado por el SRI: estado final, sin reintento automático', async () => {
  const { clinicId } = await H.seedClinic();
  const inv = await makeInvoice(clinicId, { estado: 'RECIBIDA' });
  const client = {
    enviarComprobante: async () => recRecibida(),
    autorizarComprobante: async () => autNoAutorizado(),
  };

  await processInvoice(inv, { client });

  assert.equal(inv.estado, 'NO_AUTORIZADO');
  assert.equal(inv.proximoReintento, null);
  assert.match(inv.errorUltimo, /firma/i);
});

test('runInvoiceRetryQueue procesa las EN_COLA cuando el SRI vuelve y respeta los estados finales', async () => {
  const { clinicId } = await H.seedClinic();
  await makeInvoice(clinicId); // EN_COLA
  await makeInvoice(clinicId); // EN_COLA
  await makeInvoice(clinicId, { estado: 'AUTORIZADO' }); // final, no se toca
  await makeInvoice(clinicId, { estado: 'NO_AUTORIZADO', proximoReintento: null }); // final

  const client = {
    enviarComprobante: async () => recRecibida(),
    autorizarComprobante: async () => autAutorizado(),
  };

  const result = await runInvoiceRetryQueue({ clinicId, client });

  assert.equal(result.found, 2, 'solo toma las 2 EN_COLA');
  assert.equal(result.autorizadas, 2);
  const autorizadas = await Invoice.countDocuments({ clinic: clinicId, estado: 'AUTORIZADO' });
  assert.equal(autorizadas, 3, '2 recién autorizadas + 1 que ya lo estaba');
});

test('La cola respeta el backoff salvo force: proximoReintento futuro se salta', async () => {
  const { clinicId } = await H.seedClinic();
  await makeInvoice(clinicId, { proximoReintento: new Date(Date.now() + 3600_000) }); // dentro de 1h
  const client = {
    enviarComprobante: async () => recRecibida(),
    autorizarComprobante: async () => autAutorizado(),
  };

  const normal = await runInvoiceRetryQueue({ clinicId, client });
  assert.equal(normal.found, 0, 'no procesa mientras no venza el backoff');

  const forced = await runInvoiceRetryQueue({ clinicId, client, force: true });
  assert.equal(forced.found, 1, 'force ignora el backoff');
  assert.equal(forced.autorizadas, 1);
});

test('isConnectivityError distingue caídas del SRI de rechazos de negocio', () => {
  assert.equal(isConnectivityError(new Error('Timeout SRI tras 30000ms')), true);
  assert.equal(isConnectivityError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })), true);
  assert.equal(isConnectivityError(new Error('getaddrinfo ENOTFOUND cel.sri.gob.ec')), true);
  assert.equal(isConnectivityError(new Error('RUC del comprobante no existe')), false);
});
