const Payment = require('../models/Payment');
const Invoice = require('../models/Invoice');
const Receivable = require('../models/Receivable');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const Supplier = require('../models/Supplier');
const { resolvePurchaseDueDate } = require('../utils/purchaseDueDate');
const BankAccount = require('../models/BankAccount');
const BankTransaction = require('../models/BankTransaction');
const BankCheck = require('../models/BankCheck');
const Sale = require('../models/Sale');
const { girarCheque, liberarCheque } = require('../services/bankChecks');
const { newWorkbook, addSheet, sendWorkbook, excelHandler, periodLabel } = require('../utils/excelReport');
const { createEntry, findAccount, reverseEntry, runInTransaction, assertPeriodOpen } = require('../utils/accounting');
const { getAccount } = require('../utils/accountMap');
const { openReceivable, applyToReceivable, unapplyFromReceivable, openPayable, applyToPayable, unapplyFromPayable } = require('../utils/subledger');
const { canonicalReceivableTarget, legacyUnapplyTarget } = require('../services/receivableObligations');
const {
  readIdempotencyKey, fingerprint, assertSameFingerprint, normalize: N, conflict,
} = require('../utils/idempotency');
const { sendError } = require('../utils/apiError');

async function nextNumber(clinicId, type, session = null) {
  const prefix = type === 'COBRO' ? 'CB-' : 'PG-';
  const year = new Date().getFullYear();
  const re = new RegExp(`^${prefix}${year}-`);
  let qy = Payment.findOne({ clinic: clinicId, number: re }).sort({ number: -1 }).select('number');
  if (session) qy = qy.session(session);
  const last = await qy;
  let n = 1;
  if (last) {
    const m = last.number.match(/(\d+)$/);
    if (m) n = parseInt(m[1]) + 1;
  }
  return `${prefix}${year}-${String(n).padStart(6, '0')}`;
}

const escaparRegex = (v) => String(v).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Filtro del listado de cobros/pagos. Lo comparten la pantalla y el Excel.
 *
 * `q` busca por PERSONA (nombre o razón social), número del documento, referencia o cheque:
 * el pedido concreto era "ver los pagos del 1 al 30 de julio hechos a Juan", que necesita el
 * rango de fechas y el tercero a la vez.
 */
function buildPaymentFilter(req) {
  const { type, startDate, endDate, partyRef, status, q, method, bankAccount } = req.query;
  const filter = { clinic: req.clinicId };
  if (type) filter.type = type;
  if (partyRef) filter.partyRef = partyRef;
  if (status) filter.status = status;
  if (method) filter.method = method;
  if (bankAccount) filter.bankAccount = bankAccount;
  if (q && q.trim()) {
    const rx = new RegExp(escaparRegex(q), 'i');
    filter.$or = [{ partyName: rx }, { partyId: rx }, { number: rx }, { reference: rx }, { checkNumber: rx }];
  }
  if (startDate || endDate) {
    filter.date = {};
    if (startDate) filter.date.$gte = new Date(startDate);
    // Hasta el FIN del día: con la medianoche se perdían los cobros del propio día de corte.
    if (endDate) filter.date.$lte = new Date(`${String(endDate).slice(0, 10)}T23:59:59.999`);
  }
  return filter;
}

exports.list = async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const filter = buildPaymentFilter(req);
  const lim = Math.min(parseInt(limit, 10) || 20, 500);
  const pag = Math.max(parseInt(page, 10) || 1, 1);
  const total = await Payment.countDocuments(filter);
  const items = await Payment.find(filter)
    .populate('createdBy', 'name')
    .populate('bankAccount', 'name bank')
    // El estado de la pantalla distingue conciliado de registrado: sale del movimiento bancario.
    .populate('bankTransaction', 'reconciled voided')
    .sort({ date: -1, createdAt: -1 })
    .skip((pag - 1) * lim).limit(lim);
  res.json({ items, total, pages: Math.ceil(total / lim), currentPage: pag });
};

/** Excel de cobros/pagos con los mismos filtros de la pantalla (el rango entero, sin paginar). */
exports.paymentsExcel = excelHandler(async (req, res) => {
  const filter = buildPaymentFilter(req);
  const items = await Payment.find(filter)
    .populate('bankAccount', 'name bank')
    .populate('bankTransaction', 'reconciled')
    .populate('createdBy', 'name')
    .sort({ date: 1, createdAt: 1 })
    .limit(10000)
    .lean();

  const esCobro = req.query.type === 'COBRO';
  const rows = items.map((p) => ({
    number: p.number,
    date: p.date,
    party: p.partyName || '',
    partyId: p.partyId || '',
    method: p.method,
    bank: p.bankAccount?.name || '',
    check: p.checkNumber || '',
    reference: p.reference || '',
    docs: (p.applications || []).map((a) => a.docNumber).filter(Boolean).join(', '),
    applied: p.status === 'ANULADO' ? 0 : Number(p.appliedAmount || 0),
    advance: p.status === 'ANULADO' ? 0 : Number(p.advanceAmount || 0),
    total: p.status === 'ANULADO' ? 0 : Number(p.total || 0),
    status: p.status === 'ANULADO' ? 'ANULADO' : (p.bankTransaction?.reconciled ? 'CONCILIADO' : 'REGISTRADO'),
    user: p.createdBy?.name || '',
  }));

  const wb = newWorkbook();
  addSheet(wb, {
    title: esCobro ? 'Cobros' : 'Pagos',
    meta: [
      ['Reporte', esCobro ? 'Cobros recibidos' : 'Pagos realizados'],
      ['Período', periodLabel(req.query)],
      ['Persona', req.query.q || 'Todas'],
      ['Documentos', rows.length],
    ],
    columns: [
      { header: 'Número', key: 'number', width: 16 },
      { header: 'Fecha', key: 'date', width: 12, date: true },
      { header: esCobro ? 'Cliente' : 'Proveedor', key: 'party', width: 32 },
      { header: 'Cédula / RUC', key: 'partyId', width: 16 },
      { header: 'Forma', key: 'method', width: 15 },
      { header: 'Banco', key: 'bank', width: 22 },
      { header: 'N° cheque', key: 'check', width: 12 },
      { header: 'Referencia', key: 'reference', width: 18 },
      { header: 'Documentos aplicados', key: 'docs', width: 26 },
      { header: 'Aplicado', key: 'applied', width: 14, money: true },
      { header: 'Anticipo', key: 'advance', width: 14, money: true },
      { header: 'Valor', key: 'total', width: 14, money: true },
      { header: 'Estado', key: 'status', width: 14 },
      { header: 'Registró', key: 'user', width: 20 },
    ],
    rows,
    totals: {
      applied: +rows.reduce((s, r) => s + r.applied, 0).toFixed(2),
      advance: +rows.reduce((s, r) => s + r.advance, 0).toFixed(2),
      total: +rows.reduce((s, r) => s + r.total, 0).toFixed(2),
    },
    notes: ['Los documentos anulados van con valor 0: se conservan como traza y no suman al total.'],
  });
  await sendWorkbook(res, wb, `${esCobro ? 'cobros' : 'pagos'}_${Date.now()}.xlsx`);
});

exports.get = async (req, res) => {
  const p = await Payment.findOne({ _id: req.params.id, clinic: req.clinicId })
    .populate('createdBy', 'name')
    .populate('bankAccount', 'name bank')
    .populate('journalEntry');
  if (!p) return res.status(404).json({ message: 'No encontrado' });
  res.json(p);
};

/**
 * Crea cobro o pago, aplica a documentos, opcional anticipo.
 */
exports.create = async (req, res) => {
  // Idempotencia: clave provista por el cliente (header `Idempotency-Key`, o body por
  // compatibilidad) para no registrar dos veces el mismo cobro/pago por doble-submit o
  // reintento de red. La HUELLA del contenido distingue un reintento (mismo contenido ⇒
  // replay) de una operación distinta que reutiliza la clave por error (⇒ 409).
  //
  // La IDENTIDAD DEL DESTINO va dentro de la huella: aquí el destino no es un parámetro de
  // ruta sino los documentos aplicados (`applications[].docModel/docRef`), es decir la CxP o
  // CxC concreta. Reutilizar la clave contra OTRA CxP produce otra huella ⇒ 409.
  const idempotencyKey = readIdempotencyKey(req);
  const targetOf = (apps) => (apps || [])
    .map((a) => ({ docModel: a.docModel || null, docRef: N.id(a.docRef) }))
    .sort((a, b) => String(a.docRef).localeCompare(String(b.docRef)));
  const target = targetOf(req.body?.applications);
  const idemFingerprint = fingerprint({
    op: 'payment.create',
    type: req.body?.type || null,
    method: req.body?.method || null,
    bankAccount: N.id(req.body?.bankAccount),
    party: N.id(req.body?.partyRef),
    date: N.date(req.body?.date),
    advanceAmount: N.num(req.body?.advanceAmount),
    checkNumber: req.body?.checkNumber || null,
    applications: (req.body?.applications || [])
      .map((a) => ({ docModel: a.docModel || null, docRef: N.id(a.docRef), amount: N.num(a.amount) }))
      .sort((a, b) => String(a.docRef).localeCompare(String(b.docRef))),
  });
  try {
    // Replay directo: si la clave ya se usó en esta clínica, devolvemos el pago
    // existente SIN crear otro asiento, BankTransaction ni re-aplicar CxP/CxC.
    if (idempotencyKey) {
      const existing = await Payment.findOne({ clinic: req.clinicId, idempotencyKey });
      if (existing) {
        // Pagos legacy (con clave pero sin huella): no se pueden comparar por contenido, así
        // que al menos se comprueba que apuntan a la MISMA obligación. Nunca se devuelve el
        // pago de otra CxP/CxC como si fuera el de esta.
        if (JSON.stringify(targetOf(existing.applications)) !== JSON.stringify(target)) {
          throw conflict(
            `La clave de idempotencia ya fue utilizada para el cobro/pago ${existing.number}, `
            + 'aplicado a OTROS documentos. Cada obligación es una operación distinta: use una clave nueva.'
          );
        }
        assertSameFingerprint(existing.idempotencyFingerprint, idemFingerprint, 'cobro/pago');
        return res.status(200).json({ ...existing.toObject(), idempotentReplay: true });
      }
    }
    {
      const paymentId = await runInTransaction(async (session) => {
        const { type, date, partyModel, partyRef, partyName, partyId,
                method, bankAccount, checkNumber, reference, applications = [],
                advanceAmount = 0, description, voucherUrl, voucherNumber } = req.body;
        if (!['COBRO', 'PAGO'].includes(type)) throw Object.assign(new Error('type invalido'), { status: 400 });
        if (!method) throw Object.assign(new Error('method requerido'), { status: 400 });
        if (!['EFECTIVO'].includes(method) && !bankAccount && method !== 'TARJETA') {
          throw Object.assign(new Error('bankAccount requerido para este metodo'), { status: 400 });
        }

        const txDate = date ? new Date(date) : new Date();
        await assertPeriodOpen(req.clinicId, txDate, { session });
        const apps = applications.map((a) => ({ ...a, amount: +(Number(a.amount) || 0).toFixed(2) }));
        const seen = new Set();
        for (const a of apps) {
          if (!a.docRef || !(a.amount > 0)) throw Object.assign(new Error('Aplicacion invalida'), { status: 400 });
          const key = `${a.docModel}:${a.docRef}`;
          if (seen.has(key)) throw Object.assign(new Error('No se permite aplicar dos veces al mismo documento'), { status: 400 });
          seen.add(key);
        }
        const appliedAmount = +apps.reduce((s, a) => s + a.amount, 0).toFixed(2);
        const total = +(appliedAmount + Number(advanceAmount || 0)).toFixed(2);
        if (total <= 0) throw Object.assign(new Error('Total debe ser mayor a 0'), { status: 400 });

        for (const a of apps) {
          if (type === 'PAGO' && a.docModel === 'PurchaseInvoice') {
            const pi = await PurchaseInvoice.findOne({ _id: a.docRef, clinic: req.clinicId }).session(session);
            if (!pi) throw Object.assign(new Error('Compra no encontrada'), { status: 400 });
            if (pi.status === 'ANULADA') throw Object.assign(new Error('No se puede pagar una compra anulada'), { status: 400 });
            await assertPeriodOpen(req.clinicId, pi.fechaEmision, { session });
            const balance = Number(pi.balance ?? pi.total ?? 0);
            if (a.amount > balance + 0.01) throw Object.assign(new Error(`El pago excede el saldo de ${pi.serie || 'compra'}`), { status: 400 });
          } else if (type === 'COBRO' && a.docModel === 'Invoice') {
            const inv = await Invoice.findOne({ _id: a.docRef, clinic: req.clinicId }).session(session);
            if (!inv) throw Object.assign(new Error('Factura no encontrada'), { status: 400 });
            if (inv.estado === 'ANULADA') throw Object.assign(new Error('No se puede cobrar una factura anulada'), { status: 400 });
            if (typeof inv.balance !== 'undefined' && a.amount > Number(inv.balance || 0) + 0.01) {
              throw Object.assign(new Error('El cobro excede el saldo de la factura'), { status: 400 });
            }
          } else if (type === 'COBRO' && a.docModel === 'Sale') {
            const s = await Sale.findOne({ _id: a.docRef, clinic: req.clinicId }).session(session);
            if (!s) throw Object.assign(new Error('Venta no encontrada'), { status: 400 });
            if (s.status === 'anulada') throw Object.assign(new Error('No se puede cobrar una venta anulada'), { status: 400 });
            // Lo que habilita el cobro es que la venta TENGA saldo, no que su método resumen sea
            // 'credito': una venta MIXTA (parte efectivo, parte a crédito) tiene `paymentMethod`
            // 'mixto' y una CxC real, y antes no se la podía cobrar nunca.
            if (!(Number(s.balance || 0) > 0.005)) {
              throw Object.assign(new Error('La venta no tiene saldo pendiente de cobro'), { status: 400 });
            }
            if (a.amount > Number(s.balance || 0) + 0.01) {
              throw Object.assign(new Error('El cobro excede el saldo de la venta'), { status: 400 });
            }
          }
        }

        let bank = null;
        if (bankAccount) bank = await BankAccount.findOne({ _id: bankAccount, clinic: req.clinicId }).session(session);
        if (bankAccount && !bank) throw Object.assign(new Error('Cuenta bancaria no encontrada'), { status: 404 });
        // El asiento debita/acredita la cuenta contable del banco: sin ella el asiento
        // quedaría con una cuenta indefinida. Se bloquea con mensaje claro (F1).
        if (bank && !bank.chartAccount) throw Object.assign(new Error('La cuenta bancaria no tiene cuenta contable asociada'), { status: 400 });

        if (type === 'PAGO' && method !== 'EFECTIVO' && bank) {
          if (!voucherNumber && !voucherUrl && !reference && !checkNumber) {
            throw Object.assign(new Error('Comprobante requerido para pagos bancarios'), { status: 400 });
          }
          // Se permite pagar aunque el saldo del banco quede en negativo (sin bloqueo).
        }

        // RED DE SEGURIDAD contra el pago duplicado (independiente de la clave de idempotencia).
        //
        // El caso real: el modal de "Pagar" enviaba el POST sin clave y sin bloquear el botón, así
        // que un doble clic registraba DOS pagos idénticos —dos asientos, dos movimientos bancarios—
        // y el mismo abono aparecía dos veces en Pagos y en la conciliación. La clave de idempotencia
        // ya lo evita desde la UI; esto cubre cualquier otro cliente (integración, script, reintento).
        //
        // Solo se rechaza el duplicado INMEDIATO: dos abonos iguales al mismo documento son legítimos
        // (dos abonos de $50 el mismo día), pero no dentro de la misma ventana de segundos. Por eso la
        // ventana es corta y el mensaje explica cómo forzarlo si de verdad son dos pagos distintos.
        if (!idempotencyKey && apps.length) {
          const VENTANA_MS = 60 * 1000;
          const gemelo = await Payment.findOne({
            clinic: req.clinicId,
            type,
            method,
            total,
            status: 'REGISTRADO',
            createdAt: { $gte: new Date(Date.now() - VENTANA_MS) },
            applications: {
              $all: apps.map((a) => ({ $elemMatch: { docModel: a.docModel, docRef: a.docRef, amount: a.amount } })),
              $size: apps.length,
            },
          }).session(session);
          if (gemelo) {
            throw Object.assign(
              new Error(
                `Ya se registró hace instantes un ${type === 'COBRO' ? 'cobro' : 'pago'} idéntico (${gemelo.number}) `
                + `por $${total.toFixed(2)} sobre los mismos documentos. No se registró de nuevo para no duplicarlo. `
                + 'Si de verdad son dos operaciones distintas, espere un minuto y vuelva a registrarla.'
              ),
              { status: 409, code: 'DUPLICATE_PAYMENT' }
            );
          }
        }

        const number = await nextNumber(req.clinicId, type);
        const [payment] = await Payment.create([{
          clinic: req.clinicId,
          type,
          number,
          date: txDate,
          partyModel: partyModel || (type === 'COBRO' ? 'Patient' : 'Supplier'),
          partyRef,
          partyName,
          partyId,
          method,
          bankAccount: bank?._id || null,
          checkNumber,
          reference,
          total,
          applications: apps,
          appliedAmount,
          advanceAmount,
          description,
          idempotencyKey,
          idempotencyFingerprint: idempotencyKey ? idemFingerprint : null,
          createdBy: req.user._id,
        }], { session });

        const lines = [];
        if (type === 'COBRO') {
          if (method === 'EFECTIVO') {
            const caja = await getAccount(req.clinicId, 'caja', { session });
            lines.push({ account: caja._id, debit: total, credit: 0, description: 'Cobro en efectivo' });
          } else if (method === 'TARJETA') {
            const tarj = await getAccount(req.clinicId, 'tarjetasPorLiquidar', { session });
            lines.push({ account: tarj._id, debit: total, credit: 0, description: 'Cobro tarjeta - por liquidar' });
          } else {
            lines.push({ account: bank.chartAccount, debit: total, credit: 0, description: `Cobro ${method}` });
          }
          if (appliedAmount > 0) {
            const clientes = await getAccount(req.clinicId, 'clientes', { session });
            lines.push({ account: clientes._id, debit: 0, credit: appliedAmount, description: 'Aplicacion a factura' });
          }
          if (Number(advanceAmount || 0) > 0) {
            const anticipo = await getAccount(req.clinicId, 'anticipoClientes', { session });
            lines.push({ account: anticipo._id, debit: 0, credit: Number(advanceAmount), description: 'Anticipo cliente' });
          }
        } else {
          if (appliedAmount > 0) {
            const prov = await getAccount(req.clinicId, 'proveedores', { session });
            lines.push({ account: prov._id, debit: appliedAmount, credit: 0, description: 'Pago a proveedor' });
          }
          if (Number(advanceAmount || 0) > 0) {
            const ant = await getAccount(req.clinicId, 'anticipoProveedores', { session });
            lines.push({ account: ant._id, debit: Number(advanceAmount), credit: 0, description: 'Anticipo a proveedor' });
          }
          if (method === 'EFECTIVO') {
            const caja = await getAccount(req.clinicId, 'caja', { session });
            lines.push({ account: caja._id, debit: 0, credit: total, description: 'Pago en efectivo' });
          } else {
            lines.push({ account: bank.chartAccount, debit: 0, credit: total, description: `Pago ${method}` });
          }
        }

        const entry = await createEntry({
          clinicId: req.clinicId,
          date: txDate,
          description: description || `${type} ${number}`,
          source: type === 'COBRO' ? 'COBRO' : 'PAGO',
          sourceModel: 'Payment',
          sourceRef: payment._id,
          sourceAction: 'REGISTER',
          lines,
          userId: req.user._id,
          session,
        });

        let bankTx = null;
        let chequeGirado = null;   // número del cheque que hay que marcar como GIRADO
        if (bank) {
          let txType = type === 'COBRO' ? 'COBRO' : 'PAGO';
          if (method === 'CHEQUE' && type === 'PAGO') {
            txType = 'CHEQUE_EMITIDO';
            // El número tiene que EXISTIR en la chequera y estar disponible. Antes no se
            // validaba nada: se podía pagar con el cheque 60 teniendo registrada la chequera
            // hasta el 50, y el cheque usado seguía figurando como disponible.
            if (checkNumber) {
              chequeGirado = checkNumber;
            } else {
              const libre = await BankCheck.findOne({
                clinic: req.clinicId, bankAccount: bank._id, status: 'DISPONIBLE',
              }).sort({ number: 1 }).session(session);
              if (!libre) {
                throw Object.assign(new Error(
                  'No quedan cheques disponibles en la chequera de esta cuenta. '
                  + 'Genera el siguiente rango en Bancos → Cheques.'
                ), { status: 400 });
              }
              chequeGirado = String(libre.number);
              bank.nextCheckNumber = libre.number + 1;
              await bank.save({ session });
            }
          }
          [bankTx] = await BankTransaction.create([{
            clinic: req.clinicId,
            bankAccount: bank._id,
            date: txDate,
            type: txType,
            amount: total,
            direction: type === 'COBRO' ? 1 : -1,
            description: description || `${type} ${number}`,
            reference,
            voucherUrl: voucherUrl || '',
            voucherNumber: voucherNumber || '',
            checkNumber: chequeGirado || checkNumber,
            // La PERSONA viaja al libro de bancos: es como el contador busca un movimiento
            // ("los pagos a Juan de julio"), y sin copiarla había que abrir cada documento.
            partyName: partyName || '',
            journalEntry: entry._id,
            sourceModel: 'Payment',
            sourceRef: payment._id,
            createdBy: req.user._id,
          }], { session });

          if (chequeGirado) {
            await girarCheque({
              clinicId: req.clinicId,
              bankId: bank._id,
              number: chequeGirado,
              beneficiary: partyName || description || '',
              amount: total,
              date: txDate,
              transactionId: bankTx._id,
              paymentId: payment._id,
              session,
            });
          }
        }

        payment.journalEntry = entry._id;
        payment.bankTransaction = bankTx?._id || null;
        if (chequeGirado) payment.checkNumber = chequeGirado;
        await payment.save({ session });

        for (let i = 0; i < apps.length; i++) {
          const a = apps[i];
          // Dónde se aplicó de verdad el importe (lo lee la anulación). Por defecto, el propio
          // documento; el cobro de una factura enlazada puede redirigirlo a la venta canónica.
          const marcar = (sourceModel, sourceRef) => {
            payment.applications[i].appliedTo = { sourceModel, sourceRef };
          };
          if (type === 'PAGO' && a.docModel === 'PurchaseInvoice') {
            const pi = await PurchaseInvoice.findOne({ _id: a.docRef, clinic: req.clinicId }).session(session);
            pi.balance = Math.max(0, Number(pi.balance || pi.total || 0) - Number(a.amount));
            if (pi.balance <= 0.005) {
              pi.balance = 0;
              pi.paid = true;
              if (pi.status !== 'ANULADA') pi.status = 'PAGADA';
            }
            await pi.save({ session });
            // Subledger CxP: asegura y aplica el pago al documento de la compra.
            const provAcc = await getAccount(req.clinicId, 'proveedores', { session });
            // El vencimiento sale de la MISMA utilidad que usa la compra (fecha explícita →
            // días de crédito de la compra → del proveedor): esta cartera legacy nacía sin
            // vencimiento y se proyectaba por la emisión.
            const supDoc = await Supplier.findById(pi.supplier).session(session);
            const { dueDate: vencePi } = resolvePurchaseDueDate(pi, supDoc);
            await openPayable({
              clinic: req.clinicId,
              party: { model: 'Supplier', ref: pi.supplier, name: partyName || '' },
              sourceModel: 'PurchaseInvoice', sourceRef: pi._id, docType: 'COMPRA',
              number: pi.serie || '', issueDate: pi.fechaEmision || new Date(),
              dueDate: vencePi,
              total: +(Number(pi.total || 0) - Number(pi.retentionTotal || 0)).toFixed(2),
              // applied previo (antes de este pago): total - retención - saldo ANTERIOR.
              applied: +(Number(pi.total || 0) - Number(pi.retentionTotal || 0) - (Number(pi.balance || 0) + Number(a.amount))).toFixed(2),
              account: provAcc._id,
            }, { session });
            await applyToPayable({ clinicId: req.clinicId, sourceModel: 'PurchaseInvoice', sourceRef: pi._id, amount: a.amount }, { session });
            marcar('PurchaseInvoice', pi._id);
          } else if (type === 'COBRO' && a.docModel === 'Invoice') {
            const inv = await Invoice.findOne({ _id: a.docRef, clinic: req.clinicId }).session(session);
            if (inv && typeof inv.balance !== 'undefined') {
              inv.balance = Math.max(0, Number(inv.balance || inv.total || 0) - Number(a.amount));
              if (inv.balance <= 0.005) {
                inv.balance = 0;
                if (typeof inv.paid !== 'undefined') inv.paid = true;
              }
              await inv.save({ session });
            }
            // Submayor CxC: si la factura tiene cartera abierta (las migradas por
            // scripts/migrateCarteraToSubledger la tienen), el cobro TIENE que reducirla.
            // Sin esto el saldo del submayor no bajaba nunca: la antigüedad de cartera
            // mostraba como pendiente una factura ya cobrada y el flujo de caja la
            // proyectaría eternamente. No se abre cartera nueva aquí: una factura cobrada
            // en el mostrador no tiene CxC y no debe tenerla.
            //
            // Si la factura pertenece a una venta a crédito, la obligación económica es UNA
            // sola: el cobro se aplica sobre la cartera CANÓNICA (servicio compartido), no
            // sobre dos submayores a la vez.
            const destino = await canonicalReceivableTarget({
              clinicId: req.clinicId, sourceModel: 'Invoice', sourceRef: a.docRef, session,
            }) || { sourceModel: 'Invoice', sourceRef: String(a.docRef), redirected: false };
            const cxc = await Receivable.findOne({
              clinic: req.clinicId, sourceModel: destino.sourceModel, sourceRef: destino.sourceRef,
            }).session(session);
            if (cxc && cxc.status !== 'ANULADO' && cxc.balance > 0.005) {
              await applyToReceivable({
                clinicId: req.clinicId,
                sourceModel: destino.sourceModel,
                sourceRef: destino.sourceRef,
                amount: Math.min(Number(a.amount), cxc.balance),
              }, { session });
              // Se recuerda DÓNDE se aplicó: anular tiene que devolvérselo a la misma cartera.
              marcar(destino.sourceModel, destino.sourceRef);
            }
            // La venta y su factura son el mismo dinero: si la obligación canónica es la venta,
            // su documento también baja, o los dos documentos de la misma obligación divergirían.
            if (destino.redirected && destino.sourceModel === 'Sale') {
              const sv = await Sale.findOne({ _id: destino.sourceRef, clinic: req.clinicId }).session(session);
              if (sv) {
                sv.balance = Math.max(0, Number(sv.balance || sv.total || 0) - Number(a.amount));
                sv.paid = sv.balance <= 0.005;
                if (sv.paid) sv.balance = 0;
                await sv.save({ session });
              }
            }
          } else if (type === 'COBRO' && a.docModel === 'Sale') {
            const s = await Sale.findOne({ _id: a.docRef, clinic: req.clinicId }).session(session);
            if (s) {
              s.balance = Math.max(0, Number(s.balance || s.total || 0) - Number(a.amount));
              s.paid = s.balance <= 0.005;
              if (s.paid) s.balance = 0;
              await s.save({ session });
              // Subledger CxC: asegura y aplica el cobro al documento de la venta.
              const clientesAcc = await getAccount(req.clinicId, 'clientes', { session });
              await openReceivable({
                clinic: req.clinicId,
                party: { model: 'Patient', ref: s.patient || null, name: s.clientName || '' },
                sourceModel: 'Sale', sourceRef: s._id, docType: 'VENTA',
                number: s.saleNumber, issueDate: s.createdAt || txDate, dueDate: s.dueDate || null,
                total: s.total,
                applied: +(Number(s.total || 0) - (Number(s.balance || 0) + Number(a.amount))).toFixed(2),
                account: clientesAcc._id,
              }, { session });
              await applyToReceivable({ clinicId: req.clinicId, sourceModel: 'Sale', sourceRef: s._id, amount: a.amount }, { session });
              marcar('Sale', s._id);
            }
          }
        }
        // Persiste el destino real de cada aplicación (lo lee la anulación).
        await payment.save({ session });

        return payment._id;
      });
      const payment = await Payment.findById(paymentId);
      // Evento de dominio: cobro registrado a un paciente (dispara CAPI Purchase).
      if (payment.type === 'COBRO' && payment.partyModel === 'Patient' && payment.partyRef) {
        const { emitDomainEvent, DOMAIN_EVENTS } = require('../utils/events');
        emitDomainEvent(DOMAIN_EVENTS.PAYMENT_RECEIVED, {
          clinicId: String(req.clinicId),
          patientId: String(payment.partyRef),
          paymentId: String(payment._id),
          total: Number(payment.total || 0),
        });
      }
      return res.status(201).json(payment);
    }
  } catch (e) {
    // Carrera de idempotencia: otra petición con la misma clave ganó (índice único).
    // Recuperamos y devolvemos el pago existente en vez de fallar (409 si pedía otra cosa).
    if (e.code === 11000 && idempotencyKey) {
      const existing = await Payment.findOne({ clinic: req.clinicId, idempotencyKey });
      if (existing) {
        const mismoDestino = JSON.stringify(targetOf(existing.applications)) === JSON.stringify(target);
        try {
          if (!mismoDestino) throw conflict(`La clave de idempotencia ya fue utilizada para el cobro/pago ${existing.number}, aplicado a OTROS documentos.`);
          assertSameFingerprint(existing.idempotencyFingerprint, idemFingerprint, 'cobro/pago');
        } catch (conflictErr) {
          return res.status(409).json({ message: conflictErr.message });
        }
        return res.status(200).json({ ...existing.toObject(), idempotentReplay: true });
      }
    }
    // Un error SIN `status` no es culpa del usuario: es un fallo interno. Se devolvía como 400
    // con el texto crudo de Mongo (a veces vacío ⇒ la pantalla mostraba solo «Error») y no se
    // registraba en ninguna parte, así que el log del servidor tampoco tenía la causa.
    // `sendError` traduce lo conocido (clave duplicada, validación, cast) y deja el stack en el log.
    return sendError(res, e);
  }
};

/**
 * Pago masivo a proveedores: recibe varias facturas de compra (de uno o varios
 * proveedores) y crea un Payment por proveedor aplicando a sus facturas. Útil
 * para liquidar muchas facturas de una sola vez con un mismo banco/método.
 * Body: { date, method, bankAccount?, voucherNumber?, reference?, description?,
 *         items: [{ purchaseInvoice, amount }] }
 */
exports.createBulk = async (req, res) => {
  try {
    const { date, method, bankAccount, voucherNumber, reference, description, items = [] } = req.body;
    if (!method) return res.status(400).json({ message: 'method requerido' });
    const norm = (items || [])
      .map((i) => ({ ref: i.purchaseInvoice || i.docRef, amount: +(Number(i.amount) || 0).toFixed(2) }))
      .filter((i) => i.ref && i.amount > 0);
    if (!norm.length) return res.status(400).json({ message: 'Selecciona al menos una factura con monto' });

    const result = await runInTransaction(async (session) => {
      const txDate = date ? new Date(date) : new Date();
      await assertPeriodOpen(req.clinicId, txDate, { session });

      // Validar facturas y agrupar por proveedor.
      const bySupplier = new Map();
      let grandTotal = 0;
      const seen = new Set();
      for (const it of norm) {
        if (seen.has(String(it.ref))) throw Object.assign(new Error('Factura repetida en la selección'), { status: 400 });
        seen.add(String(it.ref));
        const pi = await PurchaseInvoice.findOne({ _id: it.ref, clinic: req.clinicId })
          .populate('supplier', 'razonSocial ruc')
          .session(session);
        if (!pi) throw Object.assign(new Error('Compra no encontrada'), { status: 400 });
        if (pi.status === 'ANULADA') throw Object.assign(new Error(`No se puede pagar una compra anulada (${pi.serie || ''})`), { status: 400 });
        await assertPeriodOpen(req.clinicId, pi.fechaEmision, { session });
        const balance = Number(pi.balance ?? pi.total ?? 0);
        if (it.amount > balance + 0.01) throw Object.assign(new Error(`El pago excede el saldo de ${pi.serie || 'la compra'}`), { status: 400 });
        const supId = String(pi.supplier?._id || pi.supplier);
        if (!bySupplier.has(supId)) bySupplier.set(supId, { name: pi.supplier?.razonSocial || '', ref: pi.supplier?._id || pi.supplier, list: [] });
        bySupplier.get(supId).list.push({ pi, amount: it.amount });
        grandTotal += it.amount;
      }
      grandTotal = +grandTotal.toFixed(2);

      // Banco / validación de saldo total.
      let bank = null;
      if (bankAccount) {
        bank = await BankAccount.findOne({ _id: bankAccount, clinic: req.clinicId }).session(session);
        if (!bank) throw Object.assign(new Error('Cuenta bancaria no encontrada'), { status: 404 });
      }
      if (method !== 'EFECTIVO') {
        if (!bank) throw Object.assign(new Error('bankAccount requerido para este método'), { status: 400 });
        if (!voucherNumber && !reference) throw Object.assign(new Error('Comprobante requerido para pagos bancarios'), { status: 400 });
        // Se permite pagar aunque el saldo del banco quede en negativo (sin bloqueo).
      }

      const prov = await getAccount(req.clinicId, 'proveedores', { session });
      const created = [];

      for (const [, sup] of bySupplier) {
        const apps = sup.list.map((x) => ({ docModel: 'PurchaseInvoice', docRef: x.pi._id, amount: x.amount }));
        const appliedAmount = +apps.reduce((s, a) => s + a.amount, 0).toFixed(2);
        const total = appliedAmount;
        const number = await nextNumber(req.clinicId, 'PAGO', session);

        const [payment] = await Payment.create([{
          clinic: req.clinicId,
          type: 'PAGO',
          number,
          date: txDate,
          partyModel: 'Supplier',
          partyRef: sup.ref,
          partyName: sup.name,
          method,
          bankAccount: bank?._id || null,
          reference,
          total,
          applications: apps,
          appliedAmount,
          advanceAmount: 0,
          description: description || `Pago masivo a ${sup.name}`,
          createdBy: req.user._id,
        }], { session });

        const lines = [{ account: prov._id, debit: appliedAmount, credit: 0, description: `Pago a ${sup.name}` }];
        if (method === 'EFECTIVO') {
          const caja = await getAccount(req.clinicId, 'caja', { session });
          lines.push({ account: caja._id, debit: 0, credit: total, description: 'Pago en efectivo' });
        } else {
          lines.push({ account: bank.chartAccount, debit: 0, credit: total, description: `Pago ${method}` });
        }

        const entry = await createEntry({
          clinicId: req.clinicId,
          date: txDate,
          description: `Pago masivo ${number} - ${sup.name}`,
          source: 'PAGO',
          sourceModel: 'Payment',
          sourceRef: payment._id,
          sourceAction: 'REGISTER',
          lines,
          userId: req.user._id,
          session,
        });

        let bankTx = null;
        let chequeGirado = null;
        if (bank) {
          // Un pago masivo con cheque gira UN cheque por proveedor (es un papel por beneficiario).
          if (method === 'CHEQUE') {
            const libre = await BankCheck.findOne({
              clinic: req.clinicId, bankAccount: bank._id, status: 'DISPONIBLE',
            }).sort({ number: 1 }).session(session);
            if (!libre) {
              throw Object.assign(new Error(
                `No quedan cheques disponibles para pagar a ${sup.name}. Genera el siguiente rango en Bancos → Cheques.`
              ), { status: 400 });
            }
            chequeGirado = String(libre.number);
            bank.nextCheckNumber = libre.number + 1;
            await bank.save({ session });
          }
          [bankTx] = await BankTransaction.create([{
            clinic: req.clinicId,
            bankAccount: bank._id,
            date: txDate,
            type: chequeGirado ? 'CHEQUE_EMITIDO' : 'PAGO',
            amount: total,
            direction: -1,
            description: `Pago masivo ${number} - ${sup.name}`,
            reference,
            voucherNumber: voucherNumber || '',
            checkNumber: chequeGirado,
            partyName: sup.name || '',
            journalEntry: entry._id,
            sourceModel: 'Payment',
            sourceRef: payment._id,
            createdBy: req.user._id,
          }], { session });
          if (chequeGirado) {
            await girarCheque({
              clinicId: req.clinicId, bankId: bank._id, number: chequeGirado,
              beneficiary: sup.name || '', amount: total, date: txDate,
              transactionId: bankTx._id, paymentId: payment._id, session,
            });
          }
        }

        payment.journalEntry = entry._id;
        payment.bankTransaction = bankTx?._id || null;
        if (chequeGirado) payment.checkNumber = chequeGirado;
        await payment.save({ session });

        for (const x of sup.list) {
          const pi = x.pi;
          const prevBalance = Number(pi.balance ?? pi.total ?? 0);
          pi.balance = Math.max(0, prevBalance - x.amount);
          if (pi.balance <= 0.005) {
            pi.balance = 0;
            pi.paid = true;
            if (pi.status !== 'ANULADA') pi.status = 'PAGADA';
          }
          await pi.save({ session });
          const supPago = await Supplier.findById(pi.supplier?._id || pi.supplier).session(session);
          const { dueDate: vencePi } = resolvePurchaseDueDate(pi, supPago);
          await openPayable({
            clinic: req.clinicId,
            party: { model: 'Supplier', ref: pi.supplier?._id || pi.supplier, name: sup.name },
            sourceModel: 'PurchaseInvoice', sourceRef: pi._id, docType: 'COMPRA',
            number: pi.serie || '', issueDate: pi.fechaEmision || new Date(),
            dueDate: vencePi,
            total: +(Number(pi.total || 0) - Number(pi.retentionTotal || 0)).toFixed(2),
            applied: +(Number(pi.total || 0) - Number(pi.retentionTotal || 0) - prevBalance).toFixed(2),
            account: prov._id,
          }, { session });
          await applyToPayable({ clinicId: req.clinicId, sourceModel: 'PurchaseInvoice', sourceRef: pi._id, amount: x.amount }, { session });
        }

        created.push({ paymentId: payment._id, number, supplier: sup.name, total });
      }

      return { created, total: grandTotal };
    });

    return res.status(201).json({ ...result, count: result.created.length });
  } catch (e) {
    return sendError(res, e);   // igual que en `create`: los fallos internos se logean, no se disfrazan de 400
  }
};

exports.void = async (req, res) => {
  try {
    {
      const result = await runInTransaction(async (session) => {
        const p = await Payment.findOne({ _id: req.params.id, clinic: req.clinicId }).session(session);
        if (!p) throw Object.assign(new Error('No encontrado'), { status: 404 });
        if (p.status === 'ANULADO') throw Object.assign(new Error('Ya anulado'), { status: 400 });
        await assertPeriodOpen(req.clinicId, p.date, { session });
        const reversalDate = req.body.date ? new Date(req.body.date) : new Date();
        await assertPeriodOpen(req.clinicId, reversalDate, { session });

        if (p.journalEntry) {
          await reverseEntry({
            clinicId: req.clinicId,
            entryId: p.journalEntry,
            userId: req.user._id,
            reason: 'Anulacion de cobro/pago',
            date: reversalDate,
            session,
          });
        }
        if (p.bankTransaction) {
          const tx = await BankTransaction.findById(p.bankTransaction).session(session);
          if (tx && !tx.voided) {
            tx.voided = true;
            tx.voidedAt = reversalDate;
            tx.voidedBy = req.user._id;
            tx.voidReason = req.body?.reason || 'Anulacion de pago';
            await tx.save({ session });
            await BankAccount.updateOne(
              { _id: tx.bankAccount },
              { $inc: { bookBalance: -(Number(tx.amount || 0) * Number(tx.direction || 0)) } },
              { session }
            );
            // El cheque de un pago anulado vuelve a la chequera: el papel no se usó.
            if (tx.type === 'CHEQUE_EMITIDO' && tx.checkNumber) {
              await liberarCheque({ clinicId: req.clinicId, bankId: tx.bankAccount, number: tx.checkNumber, session });
            }
          }
        }

        p.status = 'ANULADO';
        await p.save({ session });

        for (const a of p.applications || []) {
          if (!a.docRef || !a.amount) continue;
          if (p.type === 'PAGO' && a.docModel === 'PurchaseInvoice') {
            const pi = await PurchaseInvoice.findOne({ _id: a.docRef, clinic: req.clinicId }).session(session);
            if (pi) {
              await assertPeriodOpen(req.clinicId, pi.fechaEmision, { session });
              pi.balance = Number(pi.balance || 0) + Number(a.amount);
              if (pi.balance > 0.005 && pi.status === 'PAGADA') {
                pi.paid = false;
                pi.status = 'REGISTRADA';
              }
              await pi.save({ session });
              await unapplyFromPayable({ clinicId: req.clinicId, sourceModel: 'PurchaseInvoice', sourceRef: pi._id, amount: a.amount }, { session });
            }
          } else if (p.type === 'COBRO' && a.docModel === 'Invoice') {
            // Simétrico del cobro: si la factura tiene cartera, anular DEBE devolverle el
            // saldo. Subir `Invoice.balance` no basta: sin esto la CxC quedaba reducida para
            // siempre y el saldo desaparecía del aging y del flujo de caja.
            //
            // Y se devuelve a la MISMA cartera sobre la que se aplicó, no a la que diga el
            // documento. Los cobros NUEVOS lo llevan escrito (`appliedTo`). Los ANTIGUOS no:
            // ahí el destino se reconstruye por EVIDENCIA histórica (ver legacyUnapplyTarget),
            // nunca recalculando el canónico con los saldos de hoy —que ya incluyen el efecto
            // del cobro que se está anulando—. Si no puede demostrarse, se BLOQUEA la anulación
            // entera: es preferible pedir una conciliación manual a descuadrar la cartera.
            let origen = a.appliedTo?.sourceModel
              ? { sourceModel: a.appliedTo.sourceModel, sourceRef: a.appliedTo.sourceRef }
              : null;
            let espejo = null;
            if (!origen) {
              const ev = await legacyUnapplyTarget({
                clinicId: req.clinicId, payment: p, application: a, session,
              });
              if (ev.blocked) throw Object.assign(new Error(ev.message), { status: 409 });
              origen = ev.target;      // null ⇒ ninguna cartera refleja este cobro
              espejo = ev.mirror;      // la otra cartera del par, cuando el cobro está espejado
            }

            const inv = await Invoice.findOne({ _id: a.docRef, clinic: req.clinicId }).session(session);
            if (inv && typeof inv.balance !== 'undefined') {
              inv.balance = Number(inv.balance || 0) + Number(a.amount);
              if (inv.balance > 0.005 && inv.paid) inv.paid = false;
              await inv.save({ session });
            }

            if (origen) {
              await unapplyFromReceivable({
                clinicId: req.clinicId, sourceModel: origen.sourceModel, sourceRef: origen.sourceRef, amount: a.amount,
              }, { session });
            }
            // El MISMO cobro espejado en las dos carteras del par: se devuelve a las dos para no
            // dejar una reducida a perpetuidad. El efecto ECONÓMICO sigue siendo uno solo: el
            // flujo y el aging cuentan únicamente la cartera canónica de la obligación.
            if (espejo) {
              await unapplyFromReceivable({
                clinicId: req.clinicId, sourceModel: espejo.sourceModel, sourceRef: espejo.sourceRef, amount: a.amount,
              }, { session });
            }
            // Solo los cobros nuevos redirigidos bajaron también el documento de la venta: a esos
            // se les devuelve el saldo. A un cobro histórico no se le toca la venta, porque no se
            // puede saber si llegó a bajarla.
            if (a.appliedTo?.sourceModel === 'Sale') {
              const sv = await Sale.findOne({ _id: a.appliedTo.sourceRef, clinic: req.clinicId }).session(session);
              if (sv) {
                sv.balance = Number(sv.balance || 0) + Number(a.amount);
                if (sv.balance > 0.005 && sv.paid) sv.paid = false;
                await sv.save({ session });
              }
            }
          } else if (p.type === 'COBRO' && a.docModel === 'Sale') {
            const s = await Sale.findOne({ _id: a.docRef, clinic: req.clinicId }).session(session);
            if (s) {
              s.balance = Number(s.balance || 0) + Number(a.amount);
              if (s.balance > 0.005 && s.paid) s.paid = false;
              await s.save({ session });
              await unapplyFromReceivable({ clinicId: req.clinicId, sourceModel: 'Sale', sourceRef: s._id, amount: a.amount }, { session });
            }
          }
        }

        return { message: 'Anulado' };
      });
      return res.json(result);
    }
  } catch (e) {
    // Nunca se filtra un error interno de Mongo: si algo así llegara aquí, se traduce.
    const interno = e.code === 11000 || /E11000|MongoServerError|BSONError/i.test(e.message || '');
    return res.status(e.status || 400).json({
      message: interno
        ? 'No se pudo anular el cobro/pago por un conflicto al escribir. Inténtalo de nuevo.'
        : e.message,
    });
  }
};
