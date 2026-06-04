const ChartOfAccount = require('../models/ChartOfAccount');
const AccountingConfig = require('../models/AccountingConfig');
const { findAccount } = require('./accounting');

/**
 * Catálogo de "roles" de cuenta usados por la contabilidad automática.
 * Cada rol tiene una cuenta por defecto (code o taxCode) que se usa si el
 * contador no configuró una específica en AccountingConfig.
 */
const ACCOUNT_ROLES = {
  caja:                 { group: 'Activo',  label: 'Caja general',              code: '1.1.01.01' },
  cajaChica:            { group: 'Activo',  label: 'Caja chica',                code: '1.1.01.02' },
  clientes:             { group: 'Activo',  label: 'Clientes (CxC)',            code: '1.1.02.01' },
  tarjetasPorLiquidar:  { group: 'Activo',  label: 'Tarjetas por liquidar',     code: '1.1.02.02' },
  anticipoProveedores:  { group: 'Activo',  label: 'Anticipos a proveedores',   code: '1.1.02.03' },
  ivaCompras:           { group: 'Activo',  label: 'IVA en compras',            taxCode: 'IVA_COMPRAS' },
  retIvaPorCobrar:      { group: 'Activo',  label: 'Retención IVA por cobrar',  code: '1.1.03.02' },
  retRentaPorCobrar:    { group: 'Activo',  label: 'Retención Renta por cobrar', code: '1.1.03.03' },
  anticipoIR:           { group: 'Activo',  label: 'Anticipo Impuesto a la Renta', code: '1.1.03.04' },
  inventario:           { group: 'Activo',  label: 'Inventario',                code: '1.1.04.01' },

  proveedores:          { group: 'Pasivo',  label: 'Proveedores (CxP)',         code: '2.1.01.01' },
  ivaVentas:            { group: 'Pasivo',  label: 'IVA en ventas',             taxCode: 'IVA_VENTAS' },
  ivaPorPagar:          { group: 'Pasivo',  label: 'IVA por pagar',             code: '2.1.02.02' },
  retIvaPorPagar:       { group: 'Pasivo',  label: 'Retención IVA por pagar',   code: '2.1.02.03' },
  retRentaPorPagar:     { group: 'Pasivo',  label: 'Retención Renta por pagar', code: '2.1.02.04' },

  resultadosAcumulados: { group: 'Patrimonio', label: 'Resultados acumulados',  code: '3.3.01' },
  resultadoEjercicio:   { group: 'Patrimonio', label: 'Resultado del ejercicio', code: '3.3.02' },

  ingresoServicios:     { group: 'Ingreso', label: 'Ingreso por servicios',     code: '4.1.01' },
  ingresoProductos:     { group: 'Ingreso', label: 'Ingreso por productos',     code: '4.1.02' },
  descuentoVentas:      { group: 'Ingreso', label: 'Descuentos en ventas',      code: '4.1.03' },

  costoProductos:       { group: 'Costo',   label: 'Costo de productos',        code: '5.1.01' },
  costoServicios:       { group: 'Costo',   label: 'Costo de servicios',        code: '5.1.02' },

  comisionBancaria:     { group: 'Gasto',   label: 'Comisiones bancarias',      code: '6.1.16' },
  comisionTarjeta:      { group: 'Gasto',   label: 'Comisiones tarjeta',        code: '6.1.17' },
  faltanteCaja:         { group: 'Gasto',   label: 'Faltantes de caja',         code: '6.1.18' },

  sobranteCaja:         { group: 'Ingreso', label: 'Sobrantes de caja',         code: '4.1.04' },
};

/**
 * Resuelve la cuenta contable para un rol: primero busca la configurada por el
 * contador; si no, cae al código/taxCode por defecto del catálogo.
 */
async function getAccount(clinicId, role) {
  const def = ACCOUNT_ROLES[role];
  if (!def) throw Object.assign(new Error(`Rol de cuenta desconocido: ${role}`), { status: 400 });
  const cfg = await AccountingConfig.findOne({ clinic: clinicId });
  const mappedId = cfg?.accounts?.get?.(role);
  if (mappedId) {
    const acc = await ChartOfAccount.findOne({ _id: mappedId, clinic: clinicId });
    if (acc) return acc;
  }
  return findAccount(clinicId, def.taxCode ? { taxCode: def.taxCode } : { code: def.code });
}

module.exports = { ACCOUNT_ROLES, getAccount };
