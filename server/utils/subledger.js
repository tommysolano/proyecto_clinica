const Receivable = require('../models/Receivable');
const Payable = require('../models/Payable');

/**
 * Servicio de cartera (subledger único de CxC/CxP).
 *
 * Toda venta a crédito, factura, compra, nota de crédito o anticipo abre un
 * documento de cartera. Todo cobro/pago/aplicación reduce su saldo. El balance
 * agregado de estos documentos debe conciliar contra la cuenta de control en el
 * mayor (Clientes / Proveedores).
 *
 * Idempotente por (clinic, sourceModel, sourceRef): reabrir el mismo documento
 * fuente devuelve el existente en vez de duplicar.
 */

function round2(n) {
  return +Number(n || 0).toFixed(2);
}

function withSession(query, session) {
  return session ? query.session(session) : query;
}

async function openDocument(Model, data, session) {
  const filter = { clinic: data.clinic, sourceModel: data.sourceModel, sourceRef: data.sourceRef };
  const existing = await withSession(Model.findOne(filter), session);
  if (existing) {
    // Refresca campos mutables (p.ej. tras editar el documento fuente) sin tocar
    // lo ya aplicado. Si fue anulado, se reactiva al refrescar el total.
    if (data.total != null) existing.total = round2(data.total);
    if (data.dueDate !== undefined) existing.dueDate = data.dueDate;
    if (data.number) existing.number = data.number;
    if (data.account) existing.account = data.account;
    if (data.party?.name) existing.party.name = data.party.name;
    if (existing.status === 'ANULADO') existing.status = 'ABIERTO';
    await existing.save({ session });
    return existing;
  }
  try {
    const [doc] = await Model.create([{
      clinic: data.clinic,
      party: data.party || {},
      sourceModel: data.sourceModel,
      sourceRef: data.sourceRef,
      docType: data.docType || 'FACTURA',
      number: data.number || '',
      issueDate: data.issueDate || new Date(),
      dueDate: data.dueDate || null,
      total: round2(data.total),
      applied: round2(data.applied || 0),
      account: data.account || null,
      costCenter: data.costCenter || null,
      notes: data.notes || '',
    }], session ? { session } : {});
    return doc;
  } catch (e) {
    if (e.code === 11000) return withSession(Model.findOne(filter), session);
    throw e;
  }
}

async function applyToDocument(Model, { clinicId, sourceModel, sourceRef, amount }, session) {
  const doc = await withSession(
    Model.findOne({ clinic: clinicId, sourceModel, sourceRef }),
    session
  );
  if (!doc) {
    throw Object.assign(new Error('Documento de cartera no encontrado'), { status: 404 });
  }
  if (doc.status === 'ANULADO') {
    throw Object.assign(new Error('No se puede aplicar a un documento anulado'), { status: 400 });
  }
  const amt = round2(amount);
  if (amt <= 0) throw Object.assign(new Error('Monto a aplicar inválido'), { status: 400 });
  if (amt > round2(doc.balance) + 0.01) {
    throw Object.assign(new Error(`El monto excede el saldo del documento (${doc.balance.toFixed(2)})`), { status: 400 });
  }
  doc.applied = round2(doc.applied + amt);
  await doc.save({ session });
  return doc;
}

async function unapplyFromDocument(Model, { clinicId, sourceModel, sourceRef, amount }, session) {
  const doc = await withSession(
    Model.findOne({ clinic: clinicId, sourceModel, sourceRef }),
    session
  );
  if (!doc) return null;
  doc.applied = Math.max(0, round2(doc.applied - round2(amount)));
  await doc.save({ session });
  return doc;
}

async function voidDocumentBySource(Model, { clinicId, sourceModel, sourceRef }, session) {
  const doc = await withSession(
    Model.findOne({ clinic: clinicId, sourceModel, sourceRef }),
    session
  );
  if (!doc) return null;
  doc.status = 'ANULADO';
  await doc.save({ session });
  return doc;
}

module.exports = {
  // Cuentas por cobrar
  openReceivable: (data, { session } = {}) => openDocument(Receivable, data, session),
  applyToReceivable: (args, { session } = {}) => applyToDocument(Receivable, args, session),
  unapplyFromReceivable: (args, { session } = {}) => unapplyFromDocument(Receivable, args, session),
  voidReceivable: (args, { session } = {}) => voidDocumentBySource(Receivable, args, session),
  // Cuentas por pagar
  openPayable: (data, { session } = {}) => openDocument(Payable, data, session),
  applyToPayable: (args, { session } = {}) => applyToDocument(Payable, args, session),
  unapplyFromPayable: (args, { session } = {}) => unapplyFromDocument(Payable, args, session),
  voidPayable: (args, { session } = {}) => voidDocumentBySource(Payable, args, session),
  round2,
};
