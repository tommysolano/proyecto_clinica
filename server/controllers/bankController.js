const BankAccount = require('../models/BankAccount');
const BankTransaction = require('../models/BankTransaction');
const Reconciliation = require('../models/Reconciliation');
const BankCheck = require('../models/BankCheck');
const CreditCard = require('../models/CreditCard');
const Sale = require('../models/Sale');
const ChartOfAccount = require('../models/ChartOfAccount');
const Payment = require('../models/Payment');
const { createEntry, findAccount, runInTransaction, assertPeriodOpen, reverseEntry } = require('../utils/accounting');
const { getAccount } = require('../utils/accountMap');
const { girarCheque, liberarCheque } = require('../services/bankChecks');
const { newWorkbook, addSheet, sendWorkbook, excelHandler, periodLabel } = require('../utils/excelReport');
const ExcelJS = require('exceljs');
const multer = require('multer');

// Carga de archivos en memoria para parsear estados de cuenta (CSV/Excel).
exports.uploadStatementMiddleware = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }).single('file');

/**
 * Opciones de medios de pago para el punto de cobro (cajero / recepción).
 * Devuelve solo lo necesario para los selectores: cuentas bancarias y
 * tarjetas/POS activos. No expone saldos ni datos sensibles.
 */
exports.paymentOptions = async (req, res) => {
  try {
    const [accounts, cards] = await Promise.all([
      BankAccount.find({ clinic: req.clinicId, active: true })
        .select('name bank accountNumber accountType')
        .sort({ name: 1 }),
      CreditCard.find({ clinic: req.clinicId, active: true })
        // `accountType` lo necesita el punto de cobro para ofrecer las tarjetas del tipo
        // elegido (débito / crédito), que contablemente se tratan distinto.
        .select('name brand acquirer accountType pos')
        .sort({ name: 1 }),
    ]);
    const cardsOut = cards.map((c) => ({
      _id: c._id,
      name: c.name,
      brand: c.brand,
      acquirer: c.acquirer,
      accountType: c.accountType || '',
      pos: (c.pos || []).filter((p) => p.active !== false).map((p) => ({ code: p.code, name: p.name, terminal: p.terminal })),
    }));
    res.json({ accounts, cards: cardsOut });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// ---------- Cuentas bancarias ----------
exports.listAccounts = async (req, res) => {
  const filter = { clinic: req.clinicId };
  if (req.query.active !== undefined) filter.active = req.query.active === 'true';
  const accs = await BankAccount.find(filter).populate('chartAccount', 'code name').sort({ name: 1 });
  res.json(accs);
};

exports.createAccount = async (req, res) => {
  try {
    const data = { ...req.body, clinic: req.clinicId };
    const acc = await BankAccount.create(data);
    res.status(201).json(acc);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.updateAccount = async (req, res) => {
  try {
    const acc = await BankAccount.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!acc) return res.status(404).json({ message: 'No encontrada' });
    Object.assign(acc, req.body);
    await acc.save();
    res.json(acc);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.deleteAccount = async (req, res) => {
  const acc = await BankAccount.findOne({ _id: req.params.id, clinic: req.clinicId });
  if (!acc) return res.status(404).json({ message: 'No encontrada' });
  const has = await BankTransaction.countDocuments({ bankAccount: acc._id, voided: false });
  if (has) return res.status(400).json({ message: 'Tiene movimientos, no se puede eliminar' });
  await acc.deleteOne();
  res.json({ message: 'Eliminada' });
};

// ---------- Saldos ----------
exports.balances = async (req, res) => {
  try {
    const accounts = await BankAccount.find({ clinic: req.clinicId, active: true }).populate('chartAccount', 'code name');
    const out = [];
    for (const a of accounts) {
      const agg = await BankTransaction.aggregate([
        { $match: { clinic: a.clinic, bankAccount: a._id, voided: false } },
        { $group: { _id: null, total: { $sum: { $multiply: ['$amount', '$direction'] } } } },
      ]);
      const bookBalance = (a.initialBalance || 0) + (agg[0]?.total || 0);
      out.push({ _id: a._id, name: a.name, bank: a.bank, accountNumber: a.accountNumber,
                 chartAccount: a.chartAccount, bookBalance });
    }
    res.json(out);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ---------- Helper: genera asiento contable de banco ----------
async function postBankJournal({
  clinicId,
  userId,
  date,
  description,
  bank,
  counterAccountCode,
  amount,
  direction,
  source = 'BANCO',
  sourceModel,
  sourceRef,
  sourceAction,
  session,
}) {
  const bankAcc = await ChartOfAccount.findById(bank.chartAccount).session(session || null);
  const counter = await findAccount(clinicId, { code: counterAccountCode }, { session });
  const lines = direction > 0
    ? [
        { account: bankAcc._id, debit: amount, credit: 0, description },
        { account: counter._id, debit: 0, credit: amount, description },
      ]
    : [
        { account: counter._id, debit: amount, credit: 0, description },
        { account: bankAcc._id, debit: 0, credit: amount, description },
      ];
  return createEntry({
    clinicId,
    date,
    description,
    source,
    sourceModel,
    sourceRef,
    sourceAction,
    lines,
    userId,
    session,
  });
}

// ---------- Movimientos genéricos ----------

/**
 * Registra un movimiento bancario MANUAL con su asiento, dentro de una transacción ya abierta.
 * Se extrajo de `createMovement` para poder reutilizarlo al CORREGIR un movimiento
 * (`updateMovement` = anular el anterior + registrar este), sin duplicar las reglas de
 * comprobante obligatorio, contrapartida por tipo, transferencias y cheques.
 */
async function registrarMovimiento(clinicId, userId, body, session) {
  const { bankAccount, type, amount, date, description, reference,
          counterAccountCode, checkNumber, counterpartAccount,
          voucherUrl, voucherNumber, partyName, costCenter } = body;
  {
    {
        if (!bankAccount || !type || !amount) {
          throw Object.assign(new Error('bankAccount, type y amount requeridos'), { status: 400 });
        }
        const txAmount = +Number(amount).toFixed(2);
        if (txAmount <= 0) throw Object.assign(new Error('Monto invalido'), { status: 400 });
        const txDate = date ? new Date(date) : new Date();
        await assertPeriodOpen(clinicId, txDate, { session });

        const bank = await BankAccount.findOne({ _id: bankAccount, clinic: clinicId }).session(session);
        if (!bank) throw Object.assign(new Error('Cuenta bancaria no encontrada'), { status: 404 });

        const inflow = ['DEPOSITO', 'TRANSFERENCIA_IN', 'INTERES', 'COBRO'].includes(type);
        const direction = inflow ? 1 : -1;
        const requiresVoucher = ['DEPOSITO', 'TRANSFERENCIA_IN', 'TRANSFERENCIA_OUT', 'CHEQUE_EMITIDO'].includes(type);
        if (requiresVoucher && !voucherNumber && !voucherUrl && !reference) {
          throw Object.assign(new Error('Comprobante requerido (voucherNumber, voucherUrl o reference)'), { status: 400 });
        }

        const counterRoleByType = {
          DEPOSITO: 'caja',
          RETIRO: 'caja',
          CAJA_CHICA: 'cajaChica',
          ANTICIPO: 'anticipoProveedores',
          COMISION: 'comisionBancaria',
          INTERES: 'interesesGanados',
          AJUSTE: 'resultadosAcumulados',
          CHEQUE_EMITIDO: 'proveedores',
        };
        let defaultCounter = counterAccountCode || null;
        if (!defaultCounter && counterRoleByType[type]) {
          defaultCounter = (await getAccount(clinicId, counterRoleByType[type], { session })).code;
        }

        let counterpartTx = null;
        let entry = null;
        let realCheckNumber = checkNumber;

        if (type === 'TRANSFERENCIA_OUT' || type === 'TRANSFERENCIA_IN') {
          if (!counterpartAccount) throw Object.assign(new Error('counterpartAccount requerido para transferencia'), { status: 400 });
          const other = await BankAccount.findOne({ _id: counterpartAccount, clinic: clinicId }).session(session);
          if (!other) throw Object.assign(new Error('Cuenta contraparte no encontrada'), { status: 404 });
          const out = direction < 0 ? bank : other;
          const inn = direction > 0 ? bank : other;
          // Se permite la transferencia aunque el saldo origen quede en negativo (sin bloqueo).

          const [mainTx] = await BankTransaction.create([{
            clinic: clinicId,
            bankAccount: bank._id,
            date: txDate,
            type,
            amount: txAmount,
            direction,
            description,
            reference,
            voucherUrl: voucherUrl || '',
            voucherNumber: voucherNumber || '',
            partyName: partyName || '',
            costCenter: costCenter || null,
            counterpartAccount: other._id,
            createdBy: userId,
          }], { session });
          [counterpartTx] = await BankTransaction.create([{
            clinic: clinicId,
            bankAccount: other._id,
            date: txDate,
            type: direction > 0 ? 'TRANSFERENCIA_OUT' : 'TRANSFERENCIA_IN',
            amount: txAmount,
            direction: -direction,
            description,
            reference,
            voucherUrl: voucherUrl || '',
            voucherNumber: voucherNumber || '',
            partyName: partyName || '',
            costCenter: costCenter || null,
            counterpartAccount: bank._id,
            createdBy: userId,
          }], { session });
          entry = await createEntry({
            clinicId: clinicId,
            date: txDate,
            description: description || 'Transferencia bancaria',
            source: 'BANCO',
            sourceModel: 'BankTransaction',
            sourceRef: mainTx._id,
            sourceAction: 'TRANSFER',
            userId: userId,
            costCenter: costCenter || null,
            session,
            lines: [
              { account: inn.chartAccount, debit: txAmount, credit: 0, description },
              { account: out.chartAccount, debit: 0, credit: txAmount, description },
            ],
          });
          mainTx.journalEntry = entry._id;
          counterpartTx.journalEntry = entry._id;
          await mainTx.save({ session });
          await counterpartTx.save({ session });
          return { transaction: mainTx, journalEntry: entry, counterpartTx };
        }

        // Se permite el egreso aunque el saldo del banco quede en negativo (sin bloqueo).

        if (type === 'CHEQUE_EMITIDO') {
          // Sin número explícito se toma el PRIMERO DISPONIBLE de la chequera, no un contador
          // suelto: el contador podía adelantarse a la chequera y girar un cheque inexistente.
          if (!checkNumber) {
            const libre = await BankCheck.findOne({
              clinic: clinicId, bankAccount: bank._id, status: 'DISPONIBLE',
            }).sort({ number: 1 }).session(session);
            if (!libre) {
              throw Object.assign(new Error(
                'No quedan cheques disponibles en la chequera de esta cuenta. '
                + 'Genera el siguiente rango en Bancos → Cheques.'
              ), { status: 400 });
            }
            realCheckNumber = String(libre.number);
          }
          bank.nextCheckNumber = (parseInt(realCheckNumber, 10) || bank.nextCheckNumber) + 1;
          await bank.save({ session });
        }

        const [tx] = await BankTransaction.create([{
          clinic: clinicId,
          bankAccount: bank._id,
          date: txDate,
          type,
          amount: txAmount,
          direction,
          description,
          reference,
          checkNumber: realCheckNumber,
          voucherUrl: voucherUrl || '',
          voucherNumber: voucherNumber || '',
          partyName: partyName || '',
          costCenter: costCenter || null,
          createdBy: userId,
        }], { session });

        entry = await postBankJournal({
          clinicId: clinicId,
          userId: userId,
          date: txDate,
          description: description || type,
          bank,
          counterAccountCode: defaultCounter,
          amount: txAmount,
          direction,
          sourceModel: 'BankTransaction',
          sourceRef: tx._id,
          sourceAction: 'POST',
          costCenter: costCenter || null,
          session,
        });
        tx.journalEntry = entry._id;
        await tx.save({ session });

        if (type === 'CHEQUE_EMITIDO' && realCheckNumber) {
          await girarCheque({
            clinicId,
            bankId: bank._id,
            number: realCheckNumber,
            beneficiary: partyName || description || '',
            amount: txAmount,
            date: txDate,
            transactionId: tx._id,
            session,
          });
        }
        return { transaction: tx, journalEntry: entry, counterpartTx: null };
    }
  }
}

exports.createMovement = async (req, res) => {
  try {
    const result = await runInTransaction((session) => registrarMovimiento(req.clinicId, req.user._id, req.body, session));
    return res.status(201).json(result);
  } catch (e) {
    res.status(e.status || 400).json({ message: e.message });
  }
};

/**
 * CORRIGE un movimiento manual: anula el anterior (reversando su asiento) y registra uno nuevo
 * con los datos corregidos. No se edita el asiento —son inmutables—: queda la traza completa
 * (movimiento equivocado anulado + reverso + movimiento correcto), que es lo que exige la
 * auditoría. Solo aplica a movimientos MANUALES no conciliados; ver `assertMovimientoManual`.
 */
exports.updateMovement = async (req, res) => {
  try {
    const result = await runInTransaction(async (session) => {
      const tx = await BankTransaction.findOne({ _id: req.params.id, clinic: req.clinicId }).session(session);
      if (!tx) throw Object.assign(new Error('No encontrado'), { status: 404 });
      if (tx.voided) throw Object.assign(new Error('El movimiento está anulado: no se puede corregir'), { status: 400 });
      if (tx.reconciled) throw Object.assign(new Error('El movimiento ya está conciliado: no se puede corregir'), { status: 400 });
      assertMovimientoManual(tx, 'corregir');
      if (['TRANSFERENCIA_IN', 'TRANSFERENCIA_OUT'].includes(tx.type)) {
        throw Object.assign(new Error('Una transferencia mueve dos cuentas: anúlala y vuelve a registrarla.'), { status: 400 });
      }

      const fechaReverso = new Date();
      await assertPeriodOpen(req.clinicId, fechaReverso, { session });
      if (tx.journalEntry) {
        await reverseEntry({
          clinicId: req.clinicId,
          entryId: tx.journalEntry,
          userId: req.user._id,
          reason: 'Correccion de movimiento bancario',
          date: fechaReverso,
          session,
        });
      }
      tx.voided = true;
      tx.voidedAt = fechaReverso;
      tx.voidedBy = req.user._id;
      tx.voidReason = 'Corregido (reemplazado por un movimiento nuevo)';
      await tx.save({ session });
      await BankAccount.updateOne(
        { _id: tx.bankAccount },
        { $inc: { bookBalance: -(Number(tx.amount || 0) * Number(tx.direction || 0)) } },
        { session }
      );
      // Se libera el cheque ANTES de registrar el corregido: si no, corregir el monto de un
      // cheque conservando su número chocaría contra su propio giro («ya fue usado»).
      if (tx.type === 'CHEQUE_EMITIDO' && tx.checkNumber) {
        await liberarCheque({ clinicId: req.clinicId, bankId: tx.bankAccount, number: tx.checkNumber, session });
      }

      // Lo no enviado se conserva del movimiento original: corregir el monto no debe borrar
      // la referencia ni el comprobante.
      const nuevo = {
        bankAccount: req.body.bankAccount || tx.bankAccount,
        type: req.body.type || tx.type,
        amount: req.body.amount !== undefined ? req.body.amount : tx.amount,
        date: req.body.date || tx.date,
        description: req.body.description !== undefined ? req.body.description : tx.description,
        reference: req.body.reference !== undefined ? req.body.reference : tx.reference,
        counterAccountCode: req.body.counterAccountCode || undefined,
        checkNumber: req.body.checkNumber !== undefined ? req.body.checkNumber : tx.checkNumber,
        voucherUrl: req.body.voucherUrl !== undefined ? req.body.voucherUrl : tx.voucherUrl,
        voucherNumber: req.body.voucherNumber !== undefined ? req.body.voucherNumber : tx.voucherNumber,
        partyName: req.body.partyName !== undefined ? req.body.partyName : tx.partyName,
        costCenter: req.body.costCenter !== undefined ? (req.body.costCenter || null) : tx.costCenter,
      };
      const creado = await registrarMovimiento(req.clinicId, req.user._id, nuevo, session);
      return { ...creado, replacedId: tx._id };
    });
    return res.json(result);
  } catch (e) {
    res.status(e.status || 400).json({ message: e.message });
  }
};

const escaparRegex = (v) => String(v).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Filtro de la lista de movimientos. Lo comparten la pantalla y el Excel para que no puedan
 * decir cosas distintas.
 *
 * La búsqueda libre (`q`) cubre lo que el contador tiene en la mano cuando busca un movimiento:
 * número de comprobante/papeleta, número de cheque, referencia, descripción y PERSONA. Los
 * movimientos que nacieron de un cobro/pago llevan la persona copiada (`partyName`), pero los
 * anteriores a ese campo no: por eso, además, se resuelven los cobros/pagos cuyo tercero
 * coincide y se buscan sus movimientos por `sourceRef`.
 */
async function buildMovementFilter(req) {
  const { bankAccount, startDate, endDate, type, reconciled, q, costCenter, status } = req.query;
  const filter = { clinic: req.clinicId };
  if (bankAccount) filter.bankAccount = bankAccount;
  if (type) filter.type = type;
  if (costCenter) filter.costCenter = costCenter;
  if (reconciled !== undefined) filter.reconciled = reconciled === 'true';
  if (status === 'ANULADO') filter.voided = true;
  else if (status === 'VIGENTE') filter.voided = false;
  if (q && q.trim()) {
    const rx = new RegExp(escaparRegex(q), 'i');
    const or = [
      { description: rx }, { reference: rx }, { voucherNumber: rx },
      { checkNumber: rx }, { partyName: rx },
    ];
    const pagos = await Payment.find({ clinic: req.clinicId, partyName: rx }).select('_id').limit(500);
    if (pagos.length) or.push({ sourceModel: 'Payment', sourceRef: { $in: pagos.map((p) => p._id) } });
    filter.$or = or;
  }
  if (startDate || endDate) {
    filter.date = {};
    if (startDate) filter.date.$gte = new Date(startDate);
    // Hasta el FIN del día: con la medianoche se perdían los movimientos del propio día de corte.
    if (endDate) filter.date.$lte = new Date(`${String(endDate).slice(0, 10)}T23:59:59.999`);
  }
  return filter;
}

/**
 * Completa la PERSONA de los movimientos que no la llevan copiada (los anteriores al campo
 * `partyName`), leyéndola del cobro/pago o de la venta que los originó. Es una sola consulta
 * por página, no una por fila.
 */
async function resolverPersonas(items) {
  const pendientes = items.filter((m) => !m.partyName && m.sourceRef && ['Payment', 'Sale'].includes(m.sourceModel));
  if (!pendientes.length) return items;
  const ids = { Payment: [], Sale: [] };
  for (const m of pendientes) ids[m.sourceModel].push(m.sourceRef);
  const [pagos, ventas] = await Promise.all([
    ids.Payment.length ? Payment.find({ _id: { $in: ids.Payment } }).select('partyName').lean() : [],
    ids.Sale.length ? Sale.find({ _id: { $in: ids.Sale } }).select('clientName').lean() : [],
  ]);
  const nombre = new Map([
    ...pagos.map((p) => [String(p._id), p.partyName || '']),
    ...ventas.map((s) => [String(s._id), s.clientName || '']),
  ]);
  for (const m of items) {
    if (!m.partyName && m.sourceRef) m.partyName = nombre.get(String(m.sourceRef)) || '';
  }
  return items;
}

exports.listMovements = async (req, res) => {
  const { page = 1, limit = 50 } = req.query;
  const filter = await buildMovementFilter(req);
  const lim = Math.min(parseInt(limit, 10) || 50, 200);
  const pag = Math.max(parseInt(page, 10) || 1, 1);
  const total = await BankTransaction.countDocuments(filter);
  const items = await BankTransaction.find(filter)
    .populate('bankAccount', 'name bank accountNumber')
    .populate('createdBy', 'name')
    .populate('voidedBy', 'name')
    .populate('costCenter', 'code name')
    .sort({ date: -1, createdAt: -1 })
    .skip((pag - 1) * lim).limit(lim)
    .lean();
  await resolverPersonas(items);
  res.json({ items, total, pages: Math.ceil(total / lim), currentPage: pag });
};

/**
 * Excel de los movimientos bancarios con los MISMOS filtros de la pantalla (sin paginar: el
 * contador descarga el rango completo, no la página que está viendo).
 */
exports.movementsExcel = excelHandler(async (req, res) => {
  const filter = await buildMovementFilter(req);
  const items = await BankTransaction.find(filter)
    .populate('bankAccount', 'name bank accountNumber')
    .populate('costCenter', 'code name')
    .sort({ date: 1, createdAt: 1 })
    .limit(10000)
    .lean();
  await resolverPersonas(items);

  const rows = items.map((m) => ({
    date: m.date,
    bank: m.bankAccount?.name || '',
    type: m.type,
    party: m.partyName || '',
    description: m.description || '',
    voucher: m.voucherNumber || '',
    check: m.checkNumber || '',
    reference: m.reference || '',
    costCenter: m.costCenter ? `${m.costCenter.code || ''} ${m.costCenter.name || ''}`.trim() : '',
    origin: m.sourceModel ? m.sourceModel : 'Manual',
    inflow: m.voided ? 0 : (m.direction > 0 ? m.amount : 0),
    outflow: m.voided ? 0 : (m.direction < 0 ? m.amount : 0),
    status: m.voided ? 'ANULADO' : (m.reconciled ? 'CONCILIADO' : 'REGISTRADO'),
  }));
  const totals = {
    inflow: +rows.reduce((s, r) => s + r.inflow, 0).toFixed(2),
    outflow: +rows.reduce((s, r) => s + r.outflow, 0).toFixed(2),
  };

  const wb = newWorkbook();
  addSheet(wb, {
    title: 'Movimientos bancarios',
    meta: [
      ['Reporte', 'Movimientos bancarios'],
      ['Período', periodLabel(req.query)],
      ['Filtros', [
        req.query.bankAccount ? 'una cuenta' : 'todas las cuentas',
        req.query.type || null,
        req.query.q ? `búsqueda: ${req.query.q}` : null,
      ].filter(Boolean).join(' · ')],
      ['Movimientos', rows.length],
    ],
    columns: [
      { header: 'Fecha', key: 'date', width: 12, date: true },
      { header: 'Cuenta bancaria', key: 'bank', width: 24 },
      { header: 'Tipo', key: 'type', width: 18 },
      { header: 'Persona', key: 'party', width: 30 },
      { header: 'Descripción', key: 'description', width: 38 },
      { header: 'N° comprobante', key: 'voucher', width: 16 },
      { header: 'N° cheque', key: 'check', width: 12 },
      { header: 'Referencia', key: 'reference', width: 18 },
      { header: 'Centro de costo', key: 'costCenter', width: 22 },
      { header: 'Origen', key: 'origin', width: 16 },
      { header: 'Entrada', key: 'inflow', width: 14, money: true },
      { header: 'Salida', key: 'outflow', width: 14, money: true },
      { header: 'Estado', key: 'status', width: 14 },
    ],
    rows,
    totals,
    notes: ['Los movimientos anulados aparecen con importe 0: se conservan como traza, no suman.'],
  });
  await sendWorkbook(res, wb, `movimientos_bancarios_${Date.now()}.xlsx`);
});

/**
 * Nombre legible del documento que originó un movimiento, para explicar por qué no se puede
 * tocar desde Bancos. La clave es `sourceModel` (null = movimiento manual de bancos).
 */
const ORIGEN_LABEL = {
  Payment: 'un cobro/pago',
  Sale: 'una venta',
  CardSettlement: 'una liquidación de tarjeta',
  CreditCardBatch: 'un lote de tarjetas',
  Payroll: 'una nómina',
  SriDeclaration: 'una declaración del SRI',
  CashMovement: 'un cierre de caja',
  CashDeposit: 'un depósito de caja',
  CashFlowManualItem: 'una partida de flujo de caja',
};

/**
 * Un movimiento solo se puede EDITAR o ANULAR desde Bancos si nació aquí.
 *
 * Los movimientos que espejan otro documento COMPARTEN su asiento contable: anularlos desde
 * Bancos reversaría el asiento completo del cobro / la nómina / la liquidación y dejaría el
 * documento origen marcado como contabilizado, con la contabilidad descuadrada y en silencio.
 * Esos se corrigen desde su propio documento.
 */
function assertMovimientoManual(tx, verbo) {
  if (tx.sourceModel) {
    const que = ORIGEN_LABEL[tx.sourceModel] || `un documento de ${tx.sourceModel}`;
    throw Object.assign(
      new Error(`Este movimiento lo generó ${que}: no se puede ${verbo} desde Bancos. Corrígelo o anúlalo en su documento de origen.`),
      { status: 400 }
    );
  }
}

exports.voidMovement = async (req, res) => {
  try {
    {
      const result = await runInTransaction(async (session) => {
        const tx = await BankTransaction.findOne({ _id: req.params.id, clinic: req.clinicId }).session(session);
        if (!tx) throw Object.assign(new Error('No encontrado'), { status: 404 });
        if (tx.voided) throw Object.assign(new Error('Ya anulado'), { status: 400 });
        if (tx.reconciled) throw Object.assign(new Error('Conciliado, no se puede anular'), { status: 400 });
        assertMovimientoManual(tx, 'anular');
        const reversalDate = req.body.date ? new Date(req.body.date) : new Date();
        await assertPeriodOpen(req.clinicId, reversalDate, { session });

        const toVoid = [tx];
        if (tx.journalEntry && ['TRANSFERENCIA_IN', 'TRANSFERENCIA_OUT'].includes(tx.type)) {
          const pair = await BankTransaction.findOne({
            _id: { $ne: tx._id },
            clinic: req.clinicId,
            journalEntry: tx.journalEntry,
            voided: false,
          }).session(session);
          if (pair) {
            if (pair.reconciled) throw Object.assign(new Error('La contraparte esta conciliada, no se puede anular'), { status: 400 });
            toVoid.push(pair);
          }
        }

        if (tx.journalEntry) {
          await reverseEntry({
            clinicId: req.clinicId,
            entryId: tx.journalEntry,
            userId: req.user._id,
            reason: `Anulacion tx ${tx._id}`,
            date: reversalDate,
            session,
          });
        }

        for (const item of toVoid) {
          item.voided = true;
          item.voidedAt = reversalDate;
          item.voidedBy = req.user._id;
          item.voidReason = req.body?.reason || '';
          await item.save({ session });
          await BankAccount.updateOne(
            { _id: item.bankAccount },
            { $inc: { bookBalance: -(Number(item.amount || 0) * Number(item.direction || 0)) } },
            { session }
          );
          // El cheque de un movimiento anulado vuelve a estar disponible: si no, se perdería
          // un número de la chequera por cada error de digitación.
          if (item.type === 'CHEQUE_EMITIDO' && item.checkNumber) {
            await liberarCheque({ clinicId: req.clinicId, bankId: item.bankAccount, number: item.checkNumber, session });
          }
        }
        return { message: 'Anulado', voidedCount: toVoid.length };
      });
      return res.json(result);
    }
  } catch (e) { res.status(400).json({ message: e.message }); }
};

// ---------- Depósitos de efectivo (compatibilidad) ----------
//
// El depósito de efectivo vive ahora en su propio módulo (`cashDepositController`): es un
// documento con número, papeleta, detalle de qué facturas lo componen y anulación. Estos dos
// endpoints se conservan porque la pantalla de Caja los usaba, pero solo REENVÍAN al módulo:
// la lógica no puede estar en dos sitios o volverían a divergir.
//
// La versión anterior, además de no dejar documento, marcaba las ventas depositadas cambiándoles
// `paymentMethod` a 'transferencia' y pisándoles las notas: la venta quedaba mintiendo sobre cómo
// se cobró. Ahora se marcan con `cashDeposit` y conservan su forma de pago real.
const cashDeposits = require('./cashDepositController');

exports.getCashPending = cashDeposits.pending;

exports.cashToTransfer = async (req, res) => {
  const { saleIds, bankAccount, voucher, voucherNumber, date, description } = req.body || {};
  if (!Array.isArray(saleIds) || !saleIds.length) {
    return res.status(400).json({ message: 'saleIds requerido' });
  }
  req.body = {
    bankAccount,
    voucherNumber: voucherNumber || voucher,
    date,
    description,
    items: saleIds.map((id) => ({ docModel: 'Sale', docRef: id })),
  };
  return cashDeposits.create(req, res);
};

// ---------- Conciliación bancaria ----------

/** Calcula el saldo contable (libro) de una cuenta hasta una fecha de corte (incl.). */
async function bookBalanceAt(clinicId, bank, cutDate, session) {
  const q = BankTransaction.aggregate([
    { $match: { clinic: bank.clinic, bankAccount: bank._id, voided: false, date: { $lte: cutDate } } },
    { $group: { _id: null, total: { $sum: { $multiply: ['$amount', '$direction'] } } } },
  ]);
  if (session) q.session(session);
  const agg = await q;
  return +(((bank.initialBalance || 0) + (agg[0]?.total || 0))).toFixed(2);
}

/**
 * Recarga en la conciliación los movimientos del libro pendientes hasta su fecha de corte y
 * recalcula el saldo contable, CONSERVANDO los "marcados" que ya tenía.
 *
 * Se usa al abrir el detalle y al guardar: una conciliación en BORRADOR es un documento de
 * trabajo y tiene que mostrar el libro tal como está HOY. Antes solo se recargaba al mover la
 * fecha de corte, así que todo lo contabilizado después de abrirla —una acreditación de
 * liquidación de tarjetas, por ejemplo— quedaba invisible en esa conciliación para siempre.
 *
 * @returns {boolean} true si cambió algo (hay que guardar)
 */
async function syncReconciliationItems(rec, clinicId, cutDate) {
  const bank = await BankAccount.findOne({ _id: rec.bankAccount, clinic: clinicId });
  if (!bank) throw Object.assign(new Error('Cuenta no encontrada'), { status: 404 });
  const cut = cutDate ? new Date(cutDate) : rec.cutDate;
  const txs = await BankTransaction.find({
    clinic: clinicId, bankAccount: bank._id, voided: false,
    date: { $lte: cut },
    // Pendientes de conciliar MÁS los que esta misma conciliación ya creó desde el extracto
    // (comisiones, intereses…), que nacen con `reconciled: true`: si no, la recarga los
    // expulsaría de la conciliación que los generó.
    $or: [{ reconciled: false }, { reconciliation: rec._id }],
  }).sort({ date: 1 });
  const prevFlags = new Map((rec.items || []).map((it) => [String(it.transaction?._id || it.transaction), it]));
  const antes = [...prevFlags.keys()].join(',');
  rec.items = txs.map((t) => {
    const prev = prevFlags.get(String(t._id));
    return { transaction: t._id, matched: prev ? !!prev.matched : false, statementRef: prev?.statementRef || '' };
  });
  rec.cutDate = cut;
  rec.periodEnd = cut;
  const saldo = await bookBalanceAt(clinicId, bank, cut);
  const cambio = antes !== txs.map((t) => String(t._id)).join(',') || rec.bookBalance !== saldo;
  rec.bookBalance = saldo;
  rec.difference = +(rec.statementBalance - rec.bookBalance).toFixed(2);
  return cambio;
}

/** Devuelve la conciliación con sus movimientos del libro y líneas del extracto poblados. */
async function populatedReconciliation(id) {
  return Reconciliation.findById(id)
    .populate('bankAccount', 'name bank initialBalance')
    .populate('items.transaction', 'date type description amount direction reference voucherNumber')
    .populate('statementLines.transaction', 'date description amount direction');
}

/**
 * Inicia una conciliación por FECHA DE CORTE (no se usa fecha inicial). Trae todos
 * los movimientos del libro NO conciliados hasta el corte y calcula el saldo contable.
 * Body: { bankAccount, cutDate, statementBalance, description }
 */
exports.startReconciliation = async (req, res) => {
  try {
    const { bankAccount, cutDate, statementBalance = 0, description = '' } = req.body;
    if (!bankAccount || !cutDate) return res.status(400).json({ message: 'bankAccount y fecha de corte son requeridos' });
    const bank = await BankAccount.findOne({ _id: bankAccount, clinic: req.clinicId });
    if (!bank) return res.status(404).json({ message: 'Cuenta no encontrada' });
    const cut = new Date(cutDate);
    // Movimientos del libro pendientes de conciliar hasta el corte.
    const txs = await BankTransaction.find({
      clinic: req.clinicId, bankAccount: bank._id, voided: false, reconciled: false,
      date: { $lte: cut },
    }).sort({ date: 1 });
    const items = txs.map((t) => ({ transaction: t._id, matched: false }));
    const bookBalance = await bookBalanceAt(req.clinicId, bank, cut);
    const rec = await Reconciliation.create({
      clinic: req.clinicId, bankAccount: bank._id,
      cutDate: cut, periodEnd: cut, description,
      statementBalance: Number(statementBalance) || 0, bookBalance,
      difference: +((Number(statementBalance) || 0) - bookBalance).toFixed(2),
      items, createdBy: req.user._id,
    });
    res.status(201).json(await populatedReconciliation(rec._id));
  } catch (e) { res.status(400).json({ message: e.message }); }
};

/**
 * Detalle de una conciliación (con movimientos y extracto poblados). Si está en BORRADOR se
 * ponen al día sus movimientos del libro: lo que se contabilizó después de abrirla también
 * tiene que verse (ver `syncReconciliationItems`). Una conciliación CERRADA no se toca.
 */
exports.getReconciliation = async (req, res) => {
  try {
    const raw = await Reconciliation.findById(req.params.id);
    if (!raw || String(raw.clinic) !== String(req.clinicId)) return res.status(404).json({ message: 'No encontrada' });
    if (raw.status === 'BORRADOR') {
      const cambio = await syncReconciliationItems(raw, req.clinicId);
      if (cambio) await raw.save();
    }
    res.json(await populatedReconciliation(raw._id));
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};

exports.updateReconciliation = async (req, res) => {
  try {
    const rec = await Reconciliation.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!rec) return res.status(404).json({ message: 'No encontrada' });
    if (rec.status === 'CONCILIADO') return res.status(400).json({ message: 'Ya cerrada' });

    // Los movimientos del libro se recargan SIEMPRE (no solo al mover la fecha de corte),
    // conservando los que ya estaban marcados. Ver `syncReconciliationItems`.
    await syncReconciliationItems(rec, req.clinicId, req.body.cutDate);

    // Solo persistimos los flags de match (no se reescriben las transacciones).
    if (Array.isArray(req.body.items)) {
      const flags = new Map(req.body.items.map((i) => [String(i.transaction?._id || i.transaction), i]));
      rec.items = rec.items.map((it) => {
        const f = flags.get(String(it.transaction));
        return f ? { transaction: it.transaction, matched: !!f.matched, statementRef: f.statementRef || it.statementRef || '' } : it;
      });
    }
    if (req.body.statementBalance !== undefined) rec.statementBalance = Number(req.body.statementBalance) || 0;
    if (req.body.description !== undefined) rec.description = req.body.description;
    if (req.body.notes !== undefined) rec.notes = req.body.notes;
    rec.difference = +(rec.statementBalance - rec.bookBalance).toFixed(2);
    await rec.save();
    res.json(await populatedReconciliation(rec._id));
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};

/**
 * Libro del banco: todos los movimientos de una cuenta (cobros/ventas depositadas, pagos,
 * cheques, transferencias) con saldo corrido hasta la fecha de corte. Devuelve el saldo
 * inicial (antes del rango), las filas con runningBalance y el saldo final al corte.
 * Query: ?startDate&endDate (o cutDate como fin).
 */
exports.bankLedger = async (req, res) => {
  try {
    const bank = await BankAccount.findOne({ _id: req.params.id, clinic: req.clinicId }).populate('chartAccount', 'code name');
    if (!bank) return res.status(404).json({ message: 'Cuenta no encontrada' });
    const startDate = req.query.startDate ? new Date(req.query.startDate) : null;
    const endDate = req.query.endDate || req.query.cutDate ? new Date(req.query.endDate || req.query.cutDate) : null;

    // Saldo de apertura = saldo inicial de la cuenta + movimientos anteriores a startDate.
    let opening = bank.initialBalance || 0;
    if (startDate) {
      const aggPrev = await BankTransaction.aggregate([
        { $match: { clinic: bank.clinic, bankAccount: bank._id, voided: false, date: { $lt: startDate } } },
        { $group: { _id: null, total: { $sum: { $multiply: ['$amount', '$direction'] } } } },
      ]);
      opening = +((bank.initialBalance || 0) + (aggPrev[0]?.total || 0)).toFixed(2);
    }

    const filter = { clinic: bank.clinic, bankAccount: bank._id, voided: false };
    if (startDate || endDate) {
      filter.date = {};
      if (startDate) filter.date.$gte = startDate;
      if (endDate) filter.date.$lte = endDate;
    }
    const txs = await BankTransaction.find(filter).sort({ date: 1, createdAt: 1 });
    let running = opening;
    const rows = txs.map((t) => {
      const signed = +(Number(t.amount || 0) * Number(t.direction || 0)).toFixed(2);
      running = +(running + signed).toFixed(2);
      return {
        _id: t._id, date: t.date, type: t.type, description: t.description, reference: t.reference,
        voucherNumber: t.voucherNumber, checkNumber: t.checkNumber,
        inflow: t.direction > 0 ? t.amount : 0,
        outflow: t.direction < 0 ? t.amount : 0,
        reconciled: t.reconciled, runningBalance: running,
      };
    });
    const totalIn = +rows.reduce((s, r) => s + (r.inflow || 0), 0).toFixed(2);
    const totalOut = +rows.reduce((s, r) => s + (r.outflow || 0), 0).toFixed(2);
    res.json({
      bankAccount: { _id: bank._id, name: bank.name, bank: bank.bank, accountNumber: bank.accountNumber, chartAccount: bank.chartAccount },
      opening, rows, totalIn, totalOut, closing: running, count: rows.length,
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.closeReconciliation = async (req, res) => {
  try {
    const recId = await runInTransaction(async (session) => {
      const rec = await Reconciliation.findOne({ _id: req.params.id, clinic: req.clinicId }).session(session);
      if (!rec) throw Object.assign(new Error('No encontrada'), { status: 404 });
      if (rec.status === 'CONCILIADO') throw Object.assign(new Error('Ya está conciliada'), { status: 400 });
      rec.status = 'CONCILIADO';
      rec.closedAt = new Date();
      await rec.save({ session });
      const matchedIds = rec.items.filter((i) => i.matched).map((i) => i.transaction);
      if (matchedIds.length) {
        await BankTransaction.updateMany(
          { _id: { $in: matchedIds }, clinic: req.clinicId, bankAccount: rec.bankAccount },
          { reconciled: true, reconciliation: rec._id },
          { session }
        );
      }
      return rec._id;
    });
    res.json(await populatedReconciliation(recId));
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};

/**
 * Importa el extracto bancario DENTRO de una conciliación: empareja cada línea con
 * un movimiento del libro pendiente (por monto con signo y fecha cercana), marca
 * esos movimientos como conciliados y guarda las líneas (las sin match quedan para
 * crear como movimiento). Body: { lines: [{date, description, reference, amount}] }
 */
exports.reconcileImport = async (req, res) => {
  try {
    const { lines = [] } = req.body;
    const rec = await Reconciliation.findOne({ _id: req.params.id, clinic: req.clinicId }).populate('items.transaction', 'date amount direction reference voucherNumber');
    if (!rec) return res.status(404).json({ message: 'No encontrada' });
    if (rec.status === 'CONCILIADO') return res.status(400).json({ message: 'Ya está conciliada' });

    const used = new Set();
    const statementLines = lines.map((ln) => {
      const amt = Number(ln.amount) || 0;
      const ref = String(ln.reference || '').trim().toLowerCase();
      const lineDate = ln.date ? new Date(ln.date) : null;
      let best = null, bestScore = -1;
      for (const it of rec.items) {
        const t = it.transaction;
        if (!t || used.has(String(t._id))) continue;
        const signed = t.amount * t.direction;
        if (Math.abs(signed - amt) > 0.01) continue;
        let score = 1;
        if (ref && (String(t.reference || '').toLowerCase() === ref || String(t.voucherNumber || '').toLowerCase() === ref)) score += 3;
        if (lineDate) { const days = Math.abs((new Date(t.date) - lineDate) / 86400000); if (days <= 1) score += 2; else if (days <= 5) score += 1; }
        if (score > bestScore) { bestScore = score; best = it; }
      }
      if (best) {
        used.add(String(best.transaction._id));
        best.matched = true;
        best.statementRef = ln.reference || '';
      }
      return {
        date: lineDate, description: ln.description || '', reference: ln.reference || '', amount: amt,
        matched: !!best, transaction: best ? best.transaction._id : null,
      };
    });
    rec.statementLines = statementLines;
    rec.difference = +(rec.statementBalance - rec.bookBalance).toFixed(2);
    await rec.save();
    const matched = statementLines.filter((l) => l.matched).length;
    const out = await populatedReconciliation(rec._id);
    res.json({ reconciliation: out, matched, unmatched: statementLines.length - matched });
  } catch (e) { res.status(400).json({ message: e.message }); }
};

/**
 * Crea movimientos del libro (con asiento) para líneas del extracto sin match dentro
 * de una conciliación (comisiones, intereses, notas de débito del banco, etc.) y los
 * agrega a la conciliación ya marcados. Body: { creates: [{date, amount, description, reference, counterAccountCode}] }
 */
exports.reconcileCreateMovements = async (req, res) => {
  try {
    const { creates = [] } = req.body;
    const recId = await runInTransaction(async (session) => {
      const rec = await Reconciliation.findOne({ _id: req.params.id, clinic: req.clinicId }).session(session);
      if (!rec) throw Object.assign(new Error('No encontrada'), { status: 404 });
      if (rec.status === 'CONCILIADO') throw Object.assign(new Error('Ya está conciliada'), { status: 400 });
      const bank = await BankAccount.findOne({ _id: rec.bankAccount, clinic: req.clinicId }).session(session);
      if (!bank) throw Object.assign(new Error('Cuenta no encontrada'), { status: 404 });

      for (const c of creates) {
        const amount = Math.abs(Number(c.amount) || 0);
        if (!amount) continue;
        const direction = (Number(c.amount) || 0) >= 0 ? 1 : -1;
        const txDate = c.date ? new Date(c.date) : new Date();
        await assertPeriodOpen(req.clinicId, txDate, { session });
        const counterCode = c.counterAccountCode
          || (await getAccount(req.clinicId, direction > 0 ? 'interesesGanados' : 'comisionBancaria', { session })).code;
        const [tx] = await BankTransaction.create([{
          clinic: req.clinicId, bankAccount: bank._id, date: txDate,
          type: c.type || (direction > 0 ? 'DEPOSITO' : 'COMISION'),
          amount, direction,
          description: c.description || 'Movimiento de estado de cuenta',
          reference: c.reference || '', reconciled: true, reconciliation: rec._id,
          createdBy: req.user._id,
        }], { session });
        const entry = await postBankJournal({
          clinicId: req.clinicId, userId: req.user._id, date: txDate,
          description: c.description || 'Movimiento de estado de cuenta',
          bank, counterAccountCode: counterCode, amount, direction,
          sourceModel: 'BankTransaction', sourceRef: tx._id, sourceAction: 'STATEMENT', session,
        });
        tx.journalEntry = entry._id;
        await tx.save({ session });
        // Lo agregamos a la conciliación ya conciliado.
        rec.items.push({ transaction: tx._id, matched: true, statementRef: c.reference || '' });
        // Si la línea del extracto existía, la marcamos enlazada.
        const sl = rec.statementLines.find((l) => !l.matched && Math.abs((l.amount || 0) - amount * direction) < 0.01);
        if (sl) { sl.matched = true; sl.transaction = tx._id; }
      }
      // El saldo contable sube/baja con los nuevos movimientos.
      rec.bookBalance = await bookBalanceAt(req.clinicId, bank, rec.cutDate, session);
      rec.difference = +(rec.statementBalance - rec.bookBalance).toFixed(2);
      await rec.save({ session });
      return rec._id;
    });
    res.json(await populatedReconciliation(recId));
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};

exports.listReconciliations = async (req, res) => {
  const filter = { clinic: req.clinicId };
  if (req.query.bankAccount) filter.bankAccount = req.query.bankAccount;
  const items = await Reconciliation.find(filter).populate('bankAccount', 'name bank').sort({ cutDate: -1, createdAt: -1 });
  res.json(items);
};

/**
 * Elimina una conciliación PENDIENTE (en borrador). Una conciliación en borrador es papel de
 * trabajo: no ha marcado nada como conciliado ni ha tocado un asiento, así que una abierta por
 * error —con la cuenta o el corte equivocados— se puede tirar sin dejar rastro contable.
 *
 * Una conciliación CERRADA no se elimina: marcó movimientos como conciliados y es la evidencia
 * de que el saldo del banco cuadró a esa fecha.
 */
exports.deleteReconciliation = async (req, res) => {
  try {
    const rec = await Reconciliation.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!rec) return res.status(404).json({ message: 'No encontrada' });
    if (rec.status === 'CONCILIADO') {
      return res.status(400).json({
        message: 'Esta conciliación ya está cerrada: no se elimina. Es la evidencia de que el saldo cuadró a esa fecha.',
      });
    }
    // Red de seguridad: si por cualquier vía quedaron movimientos apuntando a este borrador
    // (p. ej. creados desde el extracto), se sueltan antes de borrarlo para no dejarlos
    // marcados como conciliados contra una conciliación que ya no existe.
    await BankTransaction.updateMany(
      { clinic: req.clinicId, reconciliation: rec._id },
      { $set: { reconciled: false, reconciliation: null } }
    );
    await rec.deleteOne();
    res.json({ message: 'Conciliación eliminada' });
  } catch (e) { res.status(400).json({ message: e.message }); }
};

// ---------- Importación de estado de cuenta bancario + matching ----------
// ----- Parseo de estado de cuenta (CSV / Excel) -----

/** Normaliza el valor de una celda (fórmula, rich text, hipervínculo) a algo simple. */
function cellValue(v) {
  if (v == null) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if ('result' in v) return v.result;        // fórmula
    if ('text' in v) return v.text;             // rich text / hipervínculo
    if ('hyperlink' in v && 'text' in v) return v.text;
  }
  return v;
}

/** Convierte una fecha (Date de Excel o texto DD/MM/AAAA / AAAA-MM-DD) a 'AAAA-MM-DD'. */
function normalizeDate(v) {
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  const s = String(v || '').trim();
  if (!s) return '';
  // DD/MM/AAAA o DD-MM-AAAA
  const m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = '20' + y;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return s; // ya viene AAAA-MM-DD u otro formato; se deja como está
}

/** Parsea un número de monto tolerando símbolos, miles y coma decimal. */
function parseAmount(v) {
  if (typeof v === 'number') return v;
  let s = String(v == null ? '' : v).trim();
  if (!s) return 0;
  const neg = /^\(.*\)$/.test(s) || /-/.test(s); // (123) o -123 = negativo
  s = s.replace(/[()]/g, '');
  // Si hay coma y punto, el último separador es el decimal.
  if (s.includes(',') && s.includes('.')) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (s.includes(',')) {
    // Solo coma: si parece decimal (una coma con 1-2 decimales), tratar como decimal
    s = /,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
  }
  const n = Math.abs(parseFloat(s.replace(/[^0-9.]/g, ''))) || 0;
  return neg ? -n : n;
}

/**
 * Convierte filas crudas (array de celdas) en líneas { date, description, reference, amount }.
 * Detecta encabezado por palabras clave; si no hay, usa orden posicional
 * (fecha, descripción, [referencia], monto). Soporta columnas Débito/Crédito separadas.
 */
function rowsToLines(rows) {
  const out = [];
  if (!rows.length) return out;

  // ¿La primera fila es encabezado?
  const first = rows[0].map((c) => String(cellValue(c) || '').trim().toLowerCase());
  const looksHeader = first.some((h) => /fecha|date/.test(h)) && first.some((h) => /monto|amount|valor|d[ée]bito|cr[ée]dito|debe|haber|cargo|abono/.test(h));
  let idx = { date: -1, desc: -1, ref: -1, amount: -1, debit: -1, credit: -1 };
  let startRow = 0;
  if (looksHeader) {
    startRow = 1;
    first.forEach((h, i) => {
      if (idx.date < 0 && /fecha|date/.test(h)) idx.date = i;
      else if (idx.desc < 0 && /descrip|concepto|detalle|glosa/.test(h)) idx.desc = i;
      else if (idx.ref < 0 && /refer|documento|comprob|n[uú]mero|nro/.test(h)) idx.ref = i;
      else if (idx.debit < 0 && /d[ée]bito|debe|cargo|retiro/.test(h)) idx.debit = i;
      else if (idx.credit < 0 && /cr[ée]dito|haber|abono|dep[oó]sito/.test(h)) idx.credit = i;
      else if (idx.amount < 0 && /monto|amount|valor|importe/.test(h)) idx.amount = i;
    });
  }

  for (let r = startRow; r < rows.length; r++) {
    const cols = rows[r].map(cellValue);
    if (!cols.length || cols.every((c) => String(c || '').trim() === '')) continue;

    let date, description, reference, amount;
    if (looksHeader && (idx.amount >= 0 || idx.debit >= 0 || idx.credit >= 0)) {
      date = normalizeDate(cols[idx.date]);
      description = idx.desc >= 0 ? String(cols[idx.desc] || '').trim() : '';
      reference = idx.ref >= 0 ? String(cols[idx.ref] || '').trim() : '';
      if (idx.amount >= 0) {
        amount = parseAmount(cols[idx.amount]);
      } else {
        const debit = idx.debit >= 0 ? Math.abs(parseAmount(cols[idx.debit])) : 0;
        const credit = idx.credit >= 0 ? Math.abs(parseAmount(cols[idx.credit])) : 0;
        amount = credit - debit; // crédito = +, débito = -
      }
    } else {
      // Posicional: fecha, descripción, [referencia], monto (última columna con valor).
      const vals = cols;
      date = normalizeDate(vals[0]);
      if (vals.length >= 4) { description = String(vals[1] || '').trim(); reference = String(vals[2] || '').trim(); amount = parseAmount(vals[3]); }
      else if (vals.length === 3) { description = String(vals[1] || '').trim(); reference = ''; amount = parseAmount(vals[2]); }
      else { description = String(vals[1] || '').trim(); reference = ''; amount = parseAmount(vals[vals.length - 1]); }
    }
    if (!amount) continue;
    out.push({ date, description, reference, amount });
  }
  return out;
}

/** Lee un buffer CSV/TXT a filas de celdas. */
function csvBufferToRows(buf) {
  const text = buf.toString('utf-8');
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((ln) => ln.split(/[,;\t]/).map((c) => c.trim()));
}

/** Lee un buffer Excel (.xlsx) a filas de celdas usando la primera hoja. */
async function excelBufferToRows(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  if (!ws) throw Object.assign(new Error('El archivo Excel no tiene hojas'), { status: 400 });
  const rows = [];
  ws.eachRow((row) => {
    const cells = [];
    // row.values es 1-based; el índice 0 es undefined.
    const vals = Array.isArray(row.values) ? row.values.slice(1) : [];
    for (let i = 0; i < vals.length; i++) cells.push(vals[i] === undefined ? '' : vals[i]);
    rows.push(cells);
  });
  return rows;
}

/**
 * Parsea un estado de cuenta subido (CSV, TXT o Excel .xlsx/.xls) y devuelve las
 * líneas normalizadas para conciliar. Body: multipart con campo `file`.
 * Respuesta: { lines: [{ date, description, reference, amount }], count }.
 */
exports.parseStatement = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Archivo requerido' });
    const name = (req.file.originalname || '').toLowerCase();
    const isExcel = /\.xlsx?$/.test(name) || /spreadsheetml|excel/.test(req.file.mimetype || '');
    let rows;
    if (isExcel) {
      try {
        rows = await excelBufferToRows(req.file.buffer);
      } catch (loadErr) {
        return res.status(400).json({
          message: 'No se pudo leer el Excel. Ábrelo en Excel/Google Sheets/LibreOffice y vuelve a guardarlo como .xlsx, o expórtalo a CSV.',
        });
      }
    } else {
      rows = csvBufferToRows(req.file.buffer);
    }
    const lines = rowsToLines(rows);
    if (!lines.length) return res.status(400).json({ message: 'No se detectaron movimientos válidos en el archivo. Revisa que tenga columnas de fecha y monto.' });
    res.json({ lines, count: lines.length });
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};

/**
 * Recibe líneas del estado de cuenta (parseadas del CSV en el cliente) y sugiere
 * conciliación contra las transacciones del libro no conciliadas.
 * Body: { bankAccount, lines: [{ date, description, reference, amount }] }
 *   amount: positivo = crédito/depósito, negativo = débito/retiro.
 */
exports.statementMatch = async (req, res) => {
  try {
    const { bankAccount, lines = [] } = req.body;
    const bank = await BankAccount.findOne({ _id: bankAccount, clinic: req.clinicId });
    if (!bank) return res.status(404).json({ message: 'Cuenta no encontrada' });

    const book = await BankTransaction.find({ clinic: req.clinicId, bankAccount: bank._id, voided: false, reconciled: false }).sort({ date: 1 });
    const used = new Set();
    const result = lines.map((ln, idx) => {
      const amt = Number(ln.amount) || 0;
      const ref = String(ln.reference || '').trim().toLowerCase();
      const lineDate = ln.date ? new Date(ln.date) : null;
      let best = null, bestScore = -1;
      for (const t of book) {
        if (used.has(String(t._id))) continue;
        const signed = t.amount * t.direction;
        if (Math.abs(signed - amt) > 0.01) continue;
        let score = 1;
        if (ref && (String(t.reference || '').toLowerCase() === ref || String(t.voucherNumber || '').toLowerCase() === ref)) score += 3;
        if (lineDate) { const days = Math.abs((t.date - lineDate) / 86400000); if (days <= 1) score += 2; else if (days <= 5) score += 1; else score -= Math.min(2, Math.floor(days / 5)); }
        if (score > bestScore) { bestScore = score; best = t; }
      }
      if (best) used.add(String(best._id));
      return {
        index: idx, line: { date: ln.date, description: ln.description, reference: ln.reference, amount: amt },
        match: best ? { _id: best._id, date: best.date, description: best.description, amount: best.amount, direction: best.direction, reference: best.reference } : null,
      };
    });
    const matched = result.filter((r) => r.match).length;
    res.json({ rows: result, matched, unmatched: result.length - matched });
  } catch (e) { res.status(400).json({ message: e.message }); }
};

/**
 * Aplica la conciliación: marca como conciliadas las transacciones emparejadas y
 * crea transacciones nuevas (con asiento) para las líneas sin match (comisiones,
 * intereses, notas de débito del banco, etc.).
 * Body: { bankAccount, matchTransactionIds: [], creates: [{ date, amount, type, description, counterAccountCode }] }
 */
exports.statementApply = async (req, res) => {
  try {
    const { bankAccount, matchTransactionIds = [], creates = [] } = req.body;
    {
      const result = await runInTransaction(async (session) => {
        const bank = await BankAccount.findOne({ _id: bankAccount, clinic: req.clinicId }).session(session);
        if (!bank) throw Object.assign(new Error('Cuenta no encontrada'), { status: 404 });

        if (matchTransactionIds.length) {
          await BankTransaction.updateMany(
            { _id: { $in: matchTransactionIds }, clinic: req.clinicId, bankAccount: bank._id },
            { reconciled: true },
            { session }
          );
        }

        const created = [];
        for (const c of creates) {
          const amount = Math.abs(Number(c.amount) || 0);
          if (!amount) continue;
          const direction = (Number(c.amount) || 0) >= 0 ? 1 : -1;
          const txDate = c.date ? new Date(c.date) : new Date();
          await assertPeriodOpen(req.clinicId, txDate, { session });
          const counterCode = c.counterAccountCode
            || (await getAccount(req.clinicId, direction > 0 ? 'interesesGanados' : 'comisionBancaria', { session })).code;
          const [tx] = await BankTransaction.create([{
            clinic: req.clinicId,
            bankAccount: bank._id,
            date: txDate,
            type: c.type || (direction > 0 ? 'DEPOSITO' : 'COMISION'),
            amount,
            direction,
            description: c.description || 'Movimiento de estado de cuenta',
            reference: c.reference || '',
            reconciled: true,
            createdBy: req.user._id,
          }], { session });
          const entry = await postBankJournal({
            clinicId: req.clinicId,
            userId: req.user._id,
            date: txDate,
            description: c.description || 'Movimiento de estado de cuenta',
            bank,
            counterAccountCode: counterCode,
            amount,
            direction,
            sourceModel: 'BankTransaction',
            sourceRef: tx._id,
            sourceAction: 'STATEMENT',
            session,
          });
          tx.journalEntry = entry._id;
          await tx.save({ session });
          created.push(tx);
        }
        return { ok: true, matched: matchTransactionIds.length, created: created.length };
      });
      return res.json(result);
    }
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};

/** Recalcula el bookBalance almacenado de una cuenta (o todas) desde sus transacciones. */
exports.recomputeBankBalances = async (req, res) => {
  try {
    const accounts = await BankAccount.find({ clinic: req.clinicId });
    for (const a of accounts) {
      const agg = await BankTransaction.aggregate([
        { $match: { clinic: a.clinic, bankAccount: a._id, voided: false } },
        { $group: { _id: null, total: { $sum: { $multiply: ['$amount', '$direction'] } } } },
      ]);
      a.bookBalance = +((a.initialBalance || 0) + (agg[0]?.total || 0)).toFixed(2);
      await a.save();
    }
    res.json({ ok: true, cuentas: accounts.length });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ---------- Chequera / secuencias de cheques ----------
/**
 * Chequera de una cuenta. Devuelve, además del estado, EN QUÉ se usó cada cheque girado
 * (el pago o el movimiento bancario), que es lo que la pantalla necesita para responder
 * "¿a quién le di este cheque?" sin salir de aquí.
 */
exports.listChecks = async (req, res) => {
  const filter = { clinic: req.clinicId };
  if (req.query.bankAccount) filter.bankAccount = req.query.bankAccount;
  if (req.query.status) filter.status = req.query.status;
  if (req.query.q && req.query.q.trim()) {
    const rx = new RegExp(escaparRegex(req.query.q), 'i');
    const n = parseInt(req.query.q, 10);
    filter.$or = Number.isFinite(n) ? [{ beneficiary: rx }, { number: n }] : [{ beneficiary: rx }];
  }
  const items = await BankCheck.find(filter)
    .populate('payment', 'number type date total partyName status')
    .populate('transaction', 'date description amount voided')
    .sort({ number: 1 })
    .limit(2000);
  res.json(items);
};

/** Genera un rango de cheques (chequera) para una cuenta. body: { bankAccount, from, to } */
exports.generateChecks = async (req, res) => {
  try {
    const { bankAccount, from, to } = req.body;
    const bank = await BankAccount.findOne({ _id: bankAccount, clinic: req.clinicId });
    if (!bank) return res.status(404).json({ message: 'Cuenta no encontrada' });
    const start = parseInt(from, 10), end = parseInt(to, 10);
    if (!start || !end || end < start) return res.status(400).json({ message: 'Rango inválido' });
    if (end - start > 1000) return res.status(400).json({ message: 'Rango demasiado grande (máx 1000)' });
    let created = 0;
    for (let n = start; n <= end; n++) {
      try { await BankCheck.create({ clinic: req.clinicId, bankAccount: bank._id, number: n }); created++; }
      catch { /* duplicado, ignorar */ }
    }
    res.json({ created });
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.voidCheck = async (req, res) => {
  try {
    const chk = await BankCheck.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!chk) return res.status(404).json({ message: 'Cheque no encontrado' });
    if (chk.status === 'COBRADO') return res.status(400).json({ message: 'Cheque ya cobrado' });
    chk.status = 'ANULADO';
    chk.voidReason = req.body?.reason || '';
    await chk.save();
    res.json(chk);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

// ---------- Tarjetas de crédito + POS ----------
exports.listCards = async (req, res) => {
  const items = await CreditCard.find({ clinic: req.clinicId }).populate('chartAccount', 'code name').sort({ name: 1 });
  res.json(items);
};
exports.createCard = async (req, res) => {
  try { const card = await CreditCard.create({ ...req.body, clinic: req.clinicId }); res.status(201).json(card); }
  catch (e) { res.status(400).json({ message: e.message }); }
};
exports.updateCard = async (req, res) => {
  try {
    const card = await CreditCard.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!card) return res.status(404).json({ message: 'No encontrada' });
    const patch = { ...req.body }; delete patch.clinic;
    Object.assign(card, patch); await card.save(); res.json(card);
  } catch (e) { res.status(400).json({ message: e.message }); }
};
exports.deleteCard = async (req, res) => {
  const card = await CreditCard.findOne({ _id: req.params.id, clinic: req.clinicId });
  if (!card) return res.status(404).json({ message: 'No encontrada' });
  await card.deleteOne(); res.json({ message: 'Eliminada' });
};
