const ChartOfAccount = require('../models/ChartOfAccount');
const AccountingConfig = require('../models/AccountingConfig');
const { findAccount, ensureAccountByCode } = require('./accounting');

/**
 * Catálogo de "roles" de cuenta usados por la contabilidad automática.
 * Cada rol tiene una cuenta por defecto (code o taxCode) que se usa si el
 * contador no configuró una específica en AccountingConfig.
 *
 * REGLA DE CATEGORÍAS (contadora): la cuenta de INVENTARIO, COSTO e INGRESO de un producto sale
 * de su categoría contable (InventoryCategory), NO de estos roles genéricos. Tras esa regla:
 *   · `costoProductos` (5.1.01): YA NO se usa al vender (el costo sale de category.expenseAccount).
 *      Solo queda en el migrador `migrateProductCategoriesToInventoryCategories.js`, que SIEMBRA
 *      el expenseAccount de las categorías a partir de este rol (uso legítimo: configura la
 *      categoría, no contabiliza una venta).
 *   · `inventario` (1.1.04.01): YA NO se usa al vender/comprar (sale de category.assetAccount).
 *      Sigue en módulos que NO dependen de un solo producto/categoría o son administrativos:
 *        - Tomas físicas / ajustes de inventario (inventoryAdvancedController): usa la cuenta de
 *          la BODEGA y, si no tiene, este rol —un ajuste abarca muchos productos, no una categoría—.
 *        - Consumo interno por empleado (employeeDeductionController): ahora prefiere
 *          category.assetAccount y solo cae a este rol si el producto no tiene categoría (no bloquea).
 *   · `ingresoProductos`/`ingresoServicios`: son cuentas de INGRESO válidas; se usan como respaldo
 *      cuando el producto/servicio no tiene categoría con cuenta de ingreso (no se bloquea, porque
 *      un ingreso genérico es correcto de naturaleza, a diferencia del costo).
 * El SEED de estas cuentas (defaultChartOfAccounts) es de naturaleza correcta (5.1.01=COSTO,
 * 1.1.04.01=ACTIVO): el costo mal ubicado del pasado venía del fallback legacy del producto
 * (`product.expenseAccount`/`inventoryAccount`), ya eliminado — no del seed ni de estos roles.
 */
const ACCOUNT_ROLES = {
  caja:                 { group: 'Activo',  label: 'Caja general',              code: '1.1.01.01' },
  cajaChica:            { group: 'Activo',  label: 'Caja chica',                code: '1.1.01.02' },
  clientes:             { group: 'Activo',  label: 'Clientes (CxC)',            code: '1.1.02.01' },
  tarjetasPorLiquidar:  { group: 'Activo',  label: 'Tarjetas por liquidar',     code: '1.1.02.02' },
  anticipoProveedores:  { group: 'Activo',  label: 'Anticipos a proveedores',   code: '1.1.02.03' },
  cxcEmpleados:         { group: 'Activo',  label: 'Cuentas por cobrar empleados', code: '1.1.02.06' },
  ivaCompras:           { group: 'Activo',  label: 'IVA en compras (crédito tributario)', taxCode: 'IVA_COMPRAS' },
  ivaComprasNoCredito:  { group: 'Gasto',   label: 'IVA que se carga al gasto (no recuperable)', code: '6.3.03' },
  retIvaPorCobrar:      { group: 'Activo',  label: 'Retención IVA por cobrar',  code: '1.1.03.02' },
  retRentaPorCobrar:    { group: 'Activo',  label: 'Retención Renta por cobrar', code: '1.1.03.03' },
  anticipoIR:           { group: 'Activo',  label: 'Anticipo Impuesto a la Renta', code: '1.1.03.04' },
  creditoTributarioIva: { group: 'Activo',  label: 'Crédito tributario IVA (saldo a favor del F104)', code: '1.1.03.05' },
  inventario:           { group: 'Activo',  label: 'Inventario',                code: '1.1.04.01' },

  proveedores:          { group: 'Pasivo',  label: 'Proveedores (CxP)',         code: '2.1.01.01' },
  comisionesPorPagar:   { group: 'Pasivo',  label: 'Comisiones por pagar (personal)', code: '2.1.01.02' },
  anticipoClientes:     { group: 'Pasivo',  label: 'Anticipos de clientes',     code: '2.1.01.03' },
  ingresoDiferido:      { group: 'Pasivo',  label: 'Ingresos diferidos (paquetes)', code: '2.1.05.01' },
  ivaVentas:            { group: 'Pasivo',  label: 'IVA en ventas',             taxCode: 'IVA_VENTAS' },
  ivaPorPagar:          { group: 'Pasivo',  label: 'IVA por pagar',             code: '2.1.02.02' },
  retIvaPorPagar:       { group: 'Pasivo',  label: 'Retención IVA por pagar',   code: '2.1.02.03' },
  retRentaPorPagar:     { group: 'Pasivo',  label: 'Retención Renta por pagar', code: '2.1.02.04' },
  irPorPagar:           { group: 'Pasivo',  label: 'Impuesto a la Renta por pagar (retención a empleados)', code: '2.1.02.05' },
  sriPorPagar:          { group: 'Pasivo',  label: 'SRI por pagar (declaraciones 103/104)', code: '2.1.02.06' },

  resultadosAcumulados: { group: 'Patrimonio', label: 'Resultados acumulados',  code: '3.3.01' },
  resultadoEjercicio:   { group: 'Patrimonio', label: 'Resultado del ejercicio', code: '3.3.02' },

  bancos:               { group: 'Activo',  label: 'Bancos',                    code: '1.1.01.03' },

  interesesGanados:     { group: 'Ingreso', label: 'Intereses ganados',         code: '4.2.01' },
  otrosIngresos:        { group: 'Ingreso', label: 'Otros ingresos',            code: '4.2.02' },
  ingresoServicios:     { group: 'Ingreso', label: 'Ingreso por servicios',     code: '4.1.01' },
  ingresoProductos:     { group: 'Ingreso', label: 'Ingreso por productos',     code: '4.1.02' },
  descuentoVentas:      { group: 'Ingreso', label: 'Descuentos en ventas',      code: '4.1.03' },

  costoProductos:       { group: 'Costo',   label: 'Costo de productos',        code: '5.1.01' },
  costoServicios:       { group: 'Costo',   label: 'Costo de servicios',        code: '5.1.02' },

  comisionBancaria:     { group: 'Gasto',   label: 'Comisiones bancarias',      code: '6.1.16' },
  comisionTarjeta:      { group: 'Gasto',   label: 'Comisiones tarjeta',        code: '6.1.17' },
  comisionesPersonal:   { group: 'Gasto',   label: 'Comisiones al personal',    code: '6.1.22' },
  mermaInventario:      { group: 'Gasto',   label: 'Mermas y ajustes de inventario', code: '6.1.23' },
  consumoInterno:       { group: 'Gasto',   label: 'Consumo interno de insumos',  code: '6.1.24' },
  otrosGastos:          { group: 'Gasto',   label: 'Otros gastos administrativos', code: '6.1.99' },
  faltanteCaja:         { group: 'Gasto',   label: 'Faltantes de caja',         code: '6.1.21' },

  sobranteCaja:         { group: 'Ingreso', label: 'Sobrantes de caja',         code: '4.2.03' },
};

/**
 * Resuelve la cuenta contable para un rol: primero busca la configurada por el
 * contador; si no, cae al código/taxCode por defecto del catálogo.
 */
async function getAccount(clinicId, role, options = {}) {
  const def = ACCOUNT_ROLES[role];
  if (!def) throw Object.assign(new Error(`Rol de cuenta desconocido: ${role}`), { status: 400 });
  const cfg = await AccountingConfig.findOne({ clinic: clinicId }).session(options.session || null);
  const mappedId = cfg?.accounts?.get?.(role);
  if (mappedId) {
    const acc = await ChartOfAccount.findOne({ _id: mappedId, clinic: clinicId }).session(options.session || null);
    if (acc) return acc;
  }
  if (def.taxCode) return findAccount(clinicId, { taxCode: def.taxCode }, options);
  // Para roles por código: crea la cuenta del plan estándar si aún no existe
  // (clínicas antiguas), garantizando que la contabilidad automática no falle.
  const ensured = await ensureAccountByCode(clinicId, def.code, options);
  if (ensured) return ensured;
  return findAccount(clinicId, { code: def.code }, options);
}

module.exports = { ACCOUNT_ROLES, getAccount };
