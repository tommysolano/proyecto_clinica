'use strict';
const mongoose = require('mongoose');
const Journal = require('../models/JournalEntry');
const Account = require('../models/ChartOfAccount');

const rounded = (value) => Math.round((Number(value) || 0) * 100);
const money = (cents) => +(cents / 100).toFixed(2);
const matches = (code, root) => code === root || code.startsWith(`${root}.`);

const operatingDefinitions = [
  ['Cuenta por Cobrar', ['1.1.2.5.1'], 'DEBIT', -1],
  ['Cuenta por Pagar', ['2.1.3.1'], 'CREDIT', 1],
  ['Documento por Pagar', ['2.1.3.2'], 'CREDIT', 1],
  ['Obligaciones Sociales con el IESS', ['2.1.7.1', '2.1.7.6'], 'CREDIT', 1],
  ['Obligaciones Tributarias', ['2.1.7.4'], 'CREDIT', 1],
  ['Cuenta por Cobrar (Tarjetas de Crédito)', ['1.1.2.5.7'], 'DEBIT', -1],
  ['Cuenta por Pagar (Tarjetas de Crédito)', ['2.1.4.3'], 'CREDIT', 1],
  ['Cuenta por Cobrar Relacionadas', ['1.1.2.5.4'], 'DEBIT', -1],
  ['Productos terminados y mercadería comprados a terceros', ['1.1.3.6'], 'DEBIT', -1],
  ['Inventarios, repuestos, herramientas y accesorios', ['1.1.3.9'], 'DEBIT', -1],
  ['Anticipo Proveedores', ['1.1.4.3'], 'DEBIT', -1],
  ['Crédito Tributario a favor de la Empresa (IVA)', ['1.1.5.1'], 'DEBIT', -1],
  ['Crédito Tributario a favor de la Empresa (IR)', ['1.1.5.3'], 'DEBIT', -1],
  ['(-) Depreciación Acumulada Propiedades, Planta y Equipo', ['1.2.1.11'], 'DEBIT', -1],
  ['Anticipo de Clientes', ['2.1.10'], 'CREDIT', 1],
];
const investingDefinitions = [
  ['Activos Financieros disponibles para la Venta', ['1.1.2.2'], 'DEBIT', -1],
  ['Otros Activos Corrientes', ['1.1.7'], 'DEBIT', -1],
  ['Instalaciones', ['1.2.1.4'], 'DEBIT', -1],
  // El flujo de Contífico agrupa Equipos Médicos (1.2.1.15) bajo este renglón;
  // el balance sí presenta esa cuenta por separado.
  ['Muebles y Enseres', ['1.2.1.5', '1.2.1.15'], 'DEBIT', -1],
  ['Maquinarias y Equipos', ['1.2.1.6'], 'DEBIT', -1],
  ['Equipos de Computación', ['1.2.1.7'], 'DEBIT', -1],
  ['Otras Propiedades, Planta y Equipo', ['1.2.1.9'], 'DEBIT', -1],
];

function calculateFromMovements(movements) {
  const accounts = movements.map((row) => ({ ...row,
    debitCents: rounded(row.debit), creditCents: rounded(row.credit) }));
  const aggregate = (roots, nature) => accounts.filter((row) => roots.some((root) => matches(row.code, root)))
    .reduce((total, row) => total + (nature === 'CREDIT'
      ? row.creditCents - row.debitCents : row.debitCents - row.creditCents), 0);
  const typeTotal = (type) => accounts.filter((row) => row.type === type && row.allowsMovement)
    .reduce((total, row) => total + (row.nature === 'CREDITO'
      ? row.creditCents - row.debitCents : row.debitCents - row.creditCents), 0);
  const resultCents = typeTotal('INGRESO') - typeTotal('COSTO') - typeTotal('GASTO');
  const makeRows = (definitions) => definitions.map(([label, roots, nature, sign]) => {
    const value = aggregate(roots, nature);
    return { label, accounts: roots, amount: money(value), effect: money(value * sign) };
  });
  const operatingRows = makeRows(operatingDefinitions);
  const investingRows = makeRows(investingDefinitions);
  const operatingCents = resultCents + operatingRows.reduce((total, row) => total + rounded(row.effect), 0);
  const investingCents = investingRows.reduce((total, row) => total + rounded(row.effect), 0);
  const cashCents = aggregate(['1.1.1', '1.1.01'], 'DEBIT');
  return {
    result: money(resultCents), operating: { rows: operatingRows, total: money(operatingCents) },
    investing: { rows: investingRows, total: money(investingCents) },
    net: money(operatingCents + investingCents), cashMovement: money(cashCents),
    difference: money(operatingCents + investingCents - cashCents),
  };
}

async function indirectCashFlow({ clinicId, startDate, endDate }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate || '') || !/^\d{4}-\d{2}-\d{2}$/.test(endDate || ''))
    throw new Error('Se requieren fechas YYYY-MM-DD');
  const from = new Date(`${startDate}T00:00:00.000Z`);
  const through = new Date(`${endDate}T00:00:00.000Z`);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(through.getTime()) || from > through)
    throw new Error('Rango de fechas inválido');
  const endExclusive = new Date(through.getTime() + 86400000);
  const clinic = new mongoose.Types.ObjectId(String(clinicId));
  const [sums, chart] = await Promise.all([
    Journal.aggregate([{ $match: { clinic, status: 'CONTABILIZADO', date: { $gte: from, $lt: endExclusive } } },
      { $unwind: '$lines' }, { $group: { _id: '$lines.account', debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } }]),
    Account.find({ clinic }).select('code type nature allowsMovement').lean(),
  ]);
  const byId = new Map(chart.map((row) => [String(row._id), row]));
  const movements = sums.map((row) => ({ ...byId.get(String(row._id)), debit: row.debit, credit: row.credit }))
    .filter((row) => row.code);
  return { from: startDate, through: endDate, ...calculateFromMovements(movements) };
}

module.exports = { calculateFromMovements, indirectCashFlow };
