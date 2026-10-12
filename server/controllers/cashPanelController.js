const mongoose = require('mongoose');
const ChartOfAccount = require('../models/ChartOfAccount');
const BankAccount = require('../models/BankAccount');
const CashClosing = require('../models/CashClosing');
const CashMovement = require('../models/CashMovement');
const CashDeposit = require('../models/CashDeposit');
const JournalEntry = require('../models/JournalEntry');
const { createEntry, reverseEntry, runInTransaction, assertPeriodOpen } = require('../utils/accounting');
const { getAccount } = require('../utils/accountMap');
const {
  construirPanel, listarSalidas, cuentasDeCaja, periodoDe, diaLocal, hoyYmd,
} = require('../services/cashPanel');

/**
 * CAJA E INGRESOS (oct-2026) — la página que el contador conocía de micartaonline.
 *
 * Opera sobre la SUCURSAL (como Cierre de caja y Depósitos: sin `accountingScope`), que es
 * donde viven la cuenta Caja que mueven las ventas, los vales y los depósitos.
 * Ver `services/cashPanel.js` para el cuadre.
 */

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const fallo = (res, e, def = 'Error en caja') => res.status(e.status || 500).json({ message: e.message || def, code: e.code });
const puedeAnularDepositos = (req) => !!req.user?.isSuperAdmin || ['admin', 'contabilidad'].includes(req.role);

/** GET /cash-panel?from=&to= — el cuadre del período. */
exports.panel = async (req, res) => {
  try {
    res.json(await construirPanel(req.clinicId, req.query));
  } catch (e) { fallo(res, e, 'No se pudo armar el cuadre de caja'); }
};

/** GET /cash-panel/salidas?from=&to= — historial de salidas de efectivo. */
exports.salidas = async (req, res) => {
  try {
    res.json(await listarSalidas(req.clinicId, req.query, {
      puedeAnularDepositos: puedeAnularDepositos(req),
      userId: req.user?._id,
      esCajero: req.role === 'cajero' && !req.user?.isSuperAdmin,
    }));
  } catch (e) { fallo(res, e, 'No se pudieron listar las salidas'); }
};

/**
 * GET /cash-panel/depositos?from=&to= — historial de depósitos del período, con sus
 * documentos para el detalle. Lo ve también el cajero (el listado de Bancos → Depósitos
 * es solo de administración y contabilidad).
 */
exports.depositos = async (req, res) => {
  try {
    const { from, to, start, end } = periodoDe(req.query);
    const items = await CashDeposit.find({ clinic: req.clinicId, date: { $gte: start, $lte: end } })
      .populate('bankAccount', 'name bank accountNumber')
      .populate('createdBy', 'name')
      .populate('journalEntry', 'number date')
      .sort({ date: -1, createdAt: -1 })
      .limit(500)
      .lean();
    const total = r2(items.filter((d) => d.status !== 'ANULADO').reduce((s, d) => s + Number(d.total || 0), 0));
    res.json({ from, to, items, total });
  } catch (e) { fallo(res, e, 'No se pudieron listar los depósitos'); }
};

/**
 * Las cuentas a las que puede ir un vale: gasto, costo, pasivo o activo de movimiento,
 * de ESTA sucursal. Fuera quedan las de caja (un vale de caja a caja no mueve nada) y
 * las de los bancos: llevar efectivo al banco es un depósito, con su papeleta, y tiene
 * su propia acción (si no, el banco quedaría con una entrada sin documento).
 */
async function cuentasParaVale(clinicId) {
  const caja = await cuentasDeCaja(clinicId);
  const bancos = await BankAccount.find({ clinic: clinicId, chartAccount: { $ne: null } }).select('chartAccount').lean();
  const fuera = new Set([...caja.ids.map(String), ...bancos.map((b) => String(b.chartAccount))]);
  const cuentas = await ChartOfAccount.find({
    clinic: clinicId,
    type: { $in: ['GASTO', 'COSTO', 'PASIVO', 'ACTIVO'] },
    allowsMovement: { $ne: false },
    active: { $ne: false },
  }).select('code name type parent').sort({ code: 1 }).lean();
  return { cuentas: cuentas.filter((c) => !fuera.has(String(c._id))), fuera };
}

/** GET /cash-panel/cuentas — cuentas elegibles para el vale. */
exports.cuentas = async (req, res) => {
  try {
    const { cuentas } = await cuentasParaVale(req.clinicId);
    res.json(cuentas);
  } catch (e) { fallo(res, e, 'No se pudieron cargar las cuentas'); }
};

/**
 * POST /cash-panel/vales — EL VALE DE CAJA: efectivo del cajón que se usó para una
 * compra o un gasto (un taxi, insumos, un mensajero).
 *
 * Body: { date: 'YYYY-MM-DD', amount, account, description }
 * Asiento: D la cuenta elegida / H Caja. Queda como movimiento de caja (`VALE`) y, si
 * quien lo registra tiene su caja abierta, dentro de esa sesión: el arqueo lo descuenta.
 */
exports.crearVale = async (req, res) => {
  try {
    const amount = r2(req.body?.amount);
    if (!(amount > 0)) return res.status(400).json({ message: 'Escribe el valor del vale.' });
    if (!req.body?.account) return res.status(400).json({ message: 'Escoge la cuenta contable del vale.' });
    const fechaTxt = String(req.body?.date || hoyYmd()).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaTxt)) return res.status(400).json({ message: 'Fecha inválida.' });
    if (fechaTxt > hoyYmd()) return res.status(400).json({ message: 'El vale no puede tener una fecha futura.' });
    // Hoy: la hora real, para que caiga dentro de la caja abierta. Otro día: el mediodía.
    const date = fechaTxt === hoyYmd()
      ? new Date()
      : new Date(diaLocal(fechaTxt).getTime() + 12 * 3600 * 1000);
    const description = String(req.body?.description || '').trim() || 'Vale de caja';

    const { cuentas, fuera } = await cuentasParaVale(req.clinicId);
    if (fuera.has(String(req.body.account))) {
      return res.status(400).json({
        message: 'Para llevar efectivo al banco usa «Pasar efectivo al banco»: deja la papeleta y el movimiento del banco.',
        code: 'VALE_A_BANCO',
      });
    }
    const cuenta = cuentas.find((c) => String(c._id) === String(req.body.account));
    if (!cuenta) return res.status(400).json({ message: 'La cuenta escogida no admite vales (debe ser de gasto, costo, pasivo o activo).' });

    const movementId = await runInTransaction(async (session) => {
      await assertPeriodOpen(req.clinicId, date, { session });
      const caja = await getAccount(req.clinicId, 'caja', { session });
      const abierta = await CashClosing.findOne({ clinic: req.clinicId, status: 'ABIERTA', openedBy: req.user._id })
        .select('_id').session(session);
      const entry = await createEntry({
        clinicId: req.clinicId,
        date,
        description: `Vale de caja: ${description}`,
        source: 'CAJA',
        sourceModel: 'CashMovement',
        lines: [
          { account: cuenta._id, debit: amount, credit: 0, description },
          { account: caja._id, debit: 0, credit: amount, description },
        ],
        userId: req.user._id,
        session,
      });
      const [movement] = await CashMovement.create([{
        clinic: req.clinicId,
        cashSession: abierta?._id || null,
        date,
        type: 'VALE',
        amount,
        description,
        counterpartAccount: cuenta._id,
        journalEntry: entry._id,
        createdBy: req.user._id,
      }], { session });
      entry.sourceRef = movement._id;
      await entry.save({ session });
      return movement._id;
    });
    const movement = await CashMovement.findById(movementId).populate('counterpartAccount', 'code name');
    res.status(201).json({ message: `Vale de $${amount.toFixed(2)} registrado.`, movement });
  } catch (e) { fallo(res, e, 'No se pudo registrar el vale'); }
};

/**
 * POST /cash-panel/salidas/:entryId/void { reason } — anula una salida desde el historial.
 *  · Vale o gasto de caja: reversa su asiento y marca el movimiento anulado.
 *  · Depósito al banco: su anulación formal (Depósitos), que además retira la entrada del
 *    banco y deja otra vez pendientes las ventas y cobros que contenía.
 *  · Lo demás se anula desde su módulo (compras, pagos, nómina…).
 */
exports.anularSalida = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.entryId))) {
      return res.status(400).json({ message: 'Salida no válida.' });
    }
    const asiento = await JournalEntry.findOne({ _id: req.params.entryId, clinic: req.clinicId })
      .select('sourceModel sourceRef isReversed reverses').lean();
    if (!asiento) return res.status(404).json({ message: 'Salida no encontrada.' });
    if (asiento.isReversed) return res.status(400).json({ message: 'Esta salida ya está anulada.' });
    const motivo = String(req.body?.reason || '').trim();

    if (asiento.sourceModel === 'CashDeposit') {
      if (!puedeAnularDepositos(req)) {
        return res.status(403).json({ message: 'Un depósito lo anulan administración o contabilidad.' });
      }
      const depositos = require('./cashDepositController');
      return depositos.void({ ...req, params: { id: String(asiento.sourceRef) }, body: { reason: motivo } }, res);
    }

    if (asiento.sourceModel !== 'CashMovement') {
      return res.status(400).json({ message: 'Esta salida se registró en otro módulo: anúlala desde allí.' });
    }
    const resultado = await runInTransaction(async (session) => {
      const mov = await CashMovement.findOne({ _id: asiento.sourceRef, clinic: req.clinicId }).session(session);
      if (!mov) throw Object.assign(new Error('Movimiento de caja no encontrado'), { status: 404 });
      if (mov.voided) throw Object.assign(new Error('Ya está anulado'), { status: 400 });
      if (req.role === 'cajero' && !req.user?.isSuperAdmin && String(mov.createdBy) !== String(req.user._id)) {
        throw Object.assign(new Error('Solo quien lo registró, administración o contabilidad pueden anularlo.'), { status: 403 });
      }
      if (mov.bankTransaction) {
        throw Object.assign(new Error('Este movimiento tiene una entrada de banco: anúlalo desde Cierre de caja.'), { status: 400 });
      }
      const date = new Date();
      if (mov.journalEntry) {
        await reverseEntry({
          clinicId: req.clinicId,
          entryId: mov.journalEntry,
          userId: req.user._id,
          reason: motivo || 'Anulación de vale de caja',
          date,
          session,
        });
      }
      mov.voided = true;
      await mov.save({ session });
      return { message: `${mov.type === 'VALE' ? 'Vale' : 'Movimiento'} anulado: el efectivo vuelve a caja.` };
    });
    res.json(resultado);
  } catch (e) { fallo(res, e, 'No se pudo anular la salida'); }
};
