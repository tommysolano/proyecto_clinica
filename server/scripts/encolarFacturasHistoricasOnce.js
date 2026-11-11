#!/usr/bin/env node
// Una sola vez: encola facturas de Shiluv, sin sobrescribir envíos existentes.
const { connect, disconnect } = require('./_common');
const Invoice = require('../models/Invoice');
const Sale = require('../models/Sale');
const InvoicingConfig = require('../models/InvoicingConfig');
const OneTimeTask = require('../models/OneTimeTask');
const { configDeEmpresa } = require('../services/puntoEmision');
const { validEmail } = require('../services/invoiceEmail');
const gmail = require('../services/gmailApi');

const KEY = 'encolar-facturas-shiluv-20261029-20261111-1226';
const FROM = new Date('2026-10-29T00:00:00-05:00');
// Incluye todo el minuto 12:26, hora de Guayaquil.
const UNTIL = new Date('2026-11-11T12:27:00-05:00');
const SENDER = 'contabilidadshiluv@gmail.com';
const ELIGIBLE = ['NO_CONFIGURADO', 'SIN_CORREO', null];

function invoiceDateInRange(value) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(value || ''));
  if (!match) return false;
  const day = `${match[3]}-${match[2]}-${match[1]}`;
  const date = new Date(`${day}T05:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === day && day >= '2026-10-29' && day <= '2026-11-11';
}

async function recipientFor(invoice) {
  const saved = String(invoice.emailComprador || '').trim();
  if (validEmail(saved)) return saved;
  // Solo usar datos de la venta o ficha si la identificación coincide con el comprador.
  const id = String(invoice.identificacionComprador || '').trim();
  if (!id || /^9+$/.test(id) || !invoice.sale) return '';
  const sale = await Sale.findById(invoice.sale).select('clinic clientCedula clientEmail patient').populate('patient', 'cedula identificationAliases email').lean();
  if (!sale || String(sale.clinic) !== String(invoice.clinic)) return '';
  if (String(sale.clientCedula || '').trim() === id && validEmail(sale.clientEmail)) return sale.clientEmail.trim();
  const patientIds = [sale.patient?.cedula, ...(sale.patient?.identificationAliases || [])].map((v) => String(v || '').trim());
  if (patientIds.includes(id) && validEmail(sale.patient?.email)) return sale.patient.email.trim();
  return '';
}

async function run({ commit = false } = {}) {
  const previous = await OneTimeTask.findById(KEY).lean();
  if (commit && previous?.status === 'DONE') { console.log('Tarea ya completada; no se vuelve a encolar.'); return previous.result; }
  const target = await InvoicingConfig.find({ emailProvider: 'gmail', emailRemitente: SENDER, smtpEnabled: true });
  if (target.length !== 1 || !target[0].gmailRefreshToken || target[0].gmailAccount?.toLowerCase() !== SENDER) throw new Error('Se necesita una única configuración activa y conectada de Gmail para Shiluv.');
  await gmail.verify(target[0]);
  const configs = new Map();
  const alreadyScheduled = await Invoice.countDocuments({ 'emailDelivery.historicalBatch': KEY });
  const stats = { revisadas: 0, fueraDeEmpresa: 0, yaGestionadas: 0, sinXml: 0, sinDestinatarioSeguro: 0, encoladas: 0, cambiadasEnParalelo: 0 };
  const pendientesRevision = { sinXml: [], sinDestinatarioSeguro: [], errorPrevio: [] };
  const cursor = Invoice.find({ ambiente: '2', estado: 'AUTORIZADO', createdAt: { $gte: FROM, $lt: UNTIL } }).sort({ createdAt: 1 }).lean().cursor();
  for await (const invoice of cursor) {
    if (!invoiceDateInRange(invoice.fechaEmision)) continue;
    stats.revisadas++;
    const clinic = String(invoice.clinic);
    if (!configs.has(clinic)) configs.set(clinic, await configDeEmpresa(invoice.clinic));
    const config = configs.get(clinic);
    if (!config || String(config._id) !== String(target[0]._id)) { stats.fueraDeEmpresa++; continue; }
    if (!ELIGIBLE.includes(invoice.emailDelivery?.status || null) || invoice.emailDelivery?.sentAt || invoice.emailDelivery?.attempts > 0) {
      stats.yaGestionadas++;
      if (invoice.emailDelivery?.status === 'ERROR') pendientesRevision.errorPrevio.push(String(invoice._id));
      continue;
    }
    if (!invoice.xmlAutorizado) { stats.sinXml++; pendientesRevision.sinXml.push(String(invoice._id)); continue; }
    const recipient = await recipientFor(invoice);
    if (!recipient) { stats.sinDestinatarioSeguro++; pendientesRevision.sinDestinatarioSeguro.push(String(invoice._id)); continue; }
    if (commit) {
      // Reparte el histórico en lotes de 100 por día; los envíos normales comparten la cuota de Gmail.
      const nextAttempt = new Date(Date.now() + Math.floor((alreadyScheduled + stats.encoladas) / 100) * 24 * 60 * 60 * 1000);
      const result = await Invoice.updateOne({ _id: invoice._id, estado: 'AUTORIZADO', ambiente: '2', createdAt: { $gte: FROM, $lt: UNTIL }, 'emailDelivery.status': { $in: ELIGIBLE }, 'emailDelivery.sentAt': null, $or: [{ 'emailDelivery.attempts': { $exists: false } }, { 'emailDelivery.attempts': 0 }, { 'emailDelivery.attempts': null }] },
        { $set: { 'emailDelivery.status': 'PENDIENTE', 'emailDelivery.recipient': recipient, 'emailDelivery.attempts': 0, 'emailDelivery.nextAttempt': nextAttempt, 'emailDelivery.lockedUntil': null, 'emailDelivery.error': '', 'emailDelivery.historicalBatch': KEY } });
      if (!result.modifiedCount) { stats.cambiadasEnParalelo++; continue; }
    }
    stats.encoladas++;
  }
  if (commit) await OneTimeTask.updateOne({ _id: KEY }, { $set: { status: 'DONE', finishedAt: new Date(), result: { ...stats, pendientesRevision } } }, { upsert: true });
  console.log(JSON.stringify({ modo: commit ? 'aplicado' : 'simulación', ...stats }));
  return stats;
}

if (require.main === module) (async () => {
  try { await connect(); await run({ commit: process.argv.includes('--commit') }); }
  catch (error) { console.error('No se pudo encolar el histórico:', error.message); process.exitCode = 1; }
  finally { await disconnect(); }
})();

module.exports = { run, recipientFor, invoiceDateInRange, FROM, UNTIL, KEY };
