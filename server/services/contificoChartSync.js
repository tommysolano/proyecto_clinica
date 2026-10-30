'use strict';

/**
 * PLAN DE CUENTAS = EL DE CONTÍFICO (30-10-2026).
 *
 * El plan se importó una sola vez (migración) y solo en Central. Una cuenta creada después
 * en Contífico, o una sucursal que cobra con su propio plan, dejaba la contabilidad
 * automática sin cuenta: «Cuenta contable no encontrada: IVA_VENTAS» al cobrar con IVA.
 *
 * Es UNA empresa con UN plan de cuentas: el de la sucursal de archivo de Contífico (Central),
 * el que se ve desde todas las sucursales (middleware accountingScope). Una vez por hora, en la
 * sincronización (contificoFinancialSync), se trae el plan de Contífico y se crea en ese plan
 * la cuenta que falte por código. Lo que ya existe no se toca (nombre, marcas y configuración
 * son del contador). Al final se asegura que las de impuesto (IVA en ventas / compras) estén
 * marcadas. Una sucursal que necesita una cuenta al cobrar la toma de este plan
 * (utils/accountMap, igual que las cuentas de categoría en saleController).
 */
const zlib = require('zlib');
const Account = require('../models/ChartOfAccount');
const Record = require('../models/ContificoRecord');
const { checksum } = require('../scripts/migrateContifico');
const { accountType, nature } = require('../scripts/migrateContificoProject');

// El plan no cambia a cada rato: basta con revisarlo una vez por hora.
const CADA_MS = 60 * 60 * 1000;
let ultimo = 0;

const codigoDe = (row) => String(row?.codigo || '').trim();

/** Crea en `clinicId` las cuentas de `rows` cuyo código no existe. Devuelve los códigos creados. */
async function crearFaltantes(clinicId, rows) {
  const actuales = await Account.find({ clinic: clinicId }).select('code').lean();
  const tiene = new Set(actuales.map((a) => String(a.code)));
  const nuevas = rows.filter((row) => !tiene.has(codigoDe(row)));
  if (!nuevas.length) return [];
  // Padres antes que hijos: así cada una encuentra a su padre.
  nuevas.sort((a, b) => codigoDe(a).split('.').length - codigoDe(b).split('.').length || codigoDe(a).localeCompare(codigoDe(b)));
  await Account.bulkWrite(nuevas.map((row) => {
    const code = codigoDe(row), type = accountType(code);
    return { updateOne: { filter: { clinic: clinicId, code }, update: { $setOnInsert: {
      clinic: clinicId, code, name: String(row.nombre || code), type, nature: nature(type), level: code.split('.').length,
      allowsMovement: String(row.tipo).toUpperCase() === 'C', active: String(row.estado || 'A').toUpperCase() !== 'I',
      description: `Contífico ${row.id}`,
    } }, upsert: true } };
  }), { ordered: false });
  const todas = await Account.find({ clinic: clinicId }).select('code parent').lean();
  const porCodigo = new Map(todas.map((a) => [String(a.code), a]));
  const padres = [];
  for (const row of nuevas) {
    const code = codigoDe(row);
    if (!code.includes('.')) continue;
    const padre = porCodigo.get(code.split('.').slice(0, -1).join('.'));
    const cuenta = porCodigo.get(code);
    if (padre && cuenta && !cuenta.parent) padres.push({ updateOne: { filter: { _id: cuenta._id }, update: { $set: { parent: padre._id } } } });
  }
  if (padres.length) await Account.bulkWrite(padres, { ordered: false });
  return nuevas.map(codigoDe);
}

/**
 * Trae el plan de Contífico y completa el de la empresa. `force` salta el intervalo.
 * `clinic` es Central (la sucursal de archivo de Contífico, dueña del plan).
 */
async function syncChartOfAccounts({ clinic, api, force = false }) {
  if (!force && Date.now() - ultimo < CADA_MS) return { state: 'SKIPPED' };
  const rows = (await api.listV1('/api/v1/contabilidad/cuenta-contable/')).filter((row) => codigoDe(row));
  if (!rows.length) throw new Error('Contífico devolvió el plan de cuentas vacío');

  // Archivo de Contífico (Central): los asientos se traducen por estos registros.
  await Record.bulkWrite(rows.map((row) => ({ updateOne: {
    filter: { clinic: clinic._id, entity: 'chart_account', externalId: String(row.id) },
    update: { $set: { payloadCompressed: zlib.gzipSync(Buffer.from(JSON.stringify(row))), payloadEncoding: 'gzip-json', checksum: checksum(row), capturedAt: new Date() },
      $setOnInsert: { clinic: clinic._id, entity: 'chart_account', externalId: String(row.id) } },
    upsert: true,
  } })), { ordered: false });

  const creadas = await crearFaltantes(clinic._id, rows);
  // Las cuentas de impuesto se buscan por su marca: que el plan la tenga.
  const { getAccount } = require('../utils/accountMap');
  for (const rol of ['ivaVentas', 'ivaCompras']) {
    try { await getAccount(clinic._id, rol); } catch (error) {
      console.error(`[contifico-plan] Sin cuenta para ${rol}:`, error.message);
    }
  }
  ultimo = Date.now();
  if (creadas.length) console.log(`[contifico-plan] ${creadas.length} cuenta(s) creadas:`, creadas.join(', '));
  return { state: 'COMPLETED', source: rows.length, created: creadas };
}

module.exports = { syncChartOfAccounts, crearFaltantes };
