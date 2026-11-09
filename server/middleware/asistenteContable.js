/** Accesos que siguen disponibles para contabilidad, pero no para su asistente. */
function restrictedAssistantApi(url, method = 'GET') {
  let path = String(url || '').split('?')[0];
  try { path = decodeURIComponent(path); } catch { return true; }
  path = path.toLowerCase().replace(/\/+$/, '');
  const under = (base) => path === base || path.startsWith(`${base}/`);
  const blocked = [
    '/api/accounting-config', '/api/fiscal-periods', '/api/deferred-income', '/api/budgets',
    '/api/cash-flow', '/api/accounting-health', '/api/audit-logs',
  ];
  if (blocked.some(under)) return true;
  // El catálogo activo también lo necesitan Compras y Liquidaciones.
  if (under('/api/retention-rules')) return method.toUpperCase() !== 'GET';
  if (under('/api/retention-vouchers')) {
    // Desde Compras se siguen consultando los datos para emitir su retención.
    if (path === '/api/retention-vouchers/config' && method.toUpperCase() === 'GET') return false;
    if (path.startsWith('/api/retention-vouchers/from-purchase/') && method.toUpperCase() === 'POST') return false;
    return true;
  }
  if (/^\/api\/journal-entries\/(ledger|trial-balance)(\.xlsx)?$/.test(path)) return true;
  if (under('/api/accounting-reports')) {
    // Reportes SRI, rentabilidad, cobros y el detalle de ventas siguen disponibles.
    return !['/api/accounting-reports/sri', '/api/accounting-reports/profitability',
      '/api/accounting-reports/collections', '/api/accounting-reports/sales/drilldown']
      .some((allowed) => path === allowed || path.startsWith(`${allowed}/`) || path === `${allowed}.xlsx`);
  }
  return false;
}

module.exports = { restrictedAssistantApi };
