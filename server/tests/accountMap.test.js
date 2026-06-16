const test = require('node:test');
const assert = require('node:assert/strict');
const { ACCOUNT_ROLES } = require('../utils/accountMap');
const defaultPlan = require('../utils/defaultChartOfAccounts');

const codes = new Set(defaultPlan.map((a) => a.code));
const taxCodes = new Set(defaultPlan.filter((a) => a.taxCode).map((a) => a.taxCode));

test('every account role resolves to an account in the default chart', () => {
  for (const [role, def] of Object.entries(ACCOUNT_ROLES)) {
    if (def.taxCode) {
      assert.ok(taxCodes.has(def.taxCode), `rol "${role}" usa taxCode inexistente: ${def.taxCode}`);
    } else {
      assert.ok(codes.has(def.code), `rol "${role}" usa código inexistente en el plan: ${def.code}`);
    }
  }
});

test('account roles added for payments and purchases exist', () => {
  for (const role of ['anticipoClientes', 'anticipoProveedores', 'ivaCompras', 'ivaComprasNoCredito',
    'proveedores', 'clientes', 'tarjetasPorLiquidar', 'caja', 'retIvaPorPagar', 'retRentaPorPagar', 'inventario']) {
    assert.ok(ACCOUNT_ROLES[role], `falta el rol esperado: ${role}`);
  }
});

test('default chart accounts that allow movement have non-movement parents only above them', () => {
  // Cuentas con movimiento no deben tener hijos (serían cuentas de detalle).
  const movementCodes = defaultPlan.filter((a) => a.allowsMovement !== false).map((a) => a.code);
  for (const code of movementCodes) {
    const hasChild = defaultPlan.some((a) => a.code !== code && a.code.startsWith(`${code}.`));
    assert.ok(!hasChild, `la cuenta movible ${code} tiene cuentas hijas (debería ser de grupo)`);
  }
});
