/**
 * ALCANCE CONTABLE: la sucursal o toda la empresa.
 *
 * Central, Extensión y Laboratorio están ligadas a su centro de costo de Contífico: sus
 * pantallas contables muestran los datos de ese centro (server/middleware/accountingScope).
 * «Toda la empresa» quita el filtro. La elección se recuerda en este navegador y viaja en
 * cada petición como `X-Accounting-Scope: company` (ver api/axios.js).
 */
const KEY = 'accountingScope';
const listeners = new Set();

export function isCompanyScope() {
  try {
    return localStorage.getItem(KEY) === 'company';
  } catch {
    return false;
  }
}

export function setCompanyScope(company) {
  try {
    if (company) localStorage.setItem(KEY, 'company');
    else localStorage.removeItem(KEY);
  } catch {
    /* sin almacenamiento: la elección dura lo que la pestaña */
  }
  listeners.forEach((fn) => fn(company));
}

export function subscribeAccountingScope(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Pantallas que leen la contabilidad de la empresa. Caja, depósitos y tarjetas son de la
// sucursal (el cajero opera la suya) y no llevan selector.
const OWN_SUCURSAL = ['/accounting/cash', '/accounting/cash-deposits', '/accounting/cash-closing',
  '/accounting/credit-card-batches', '/accounting/card-settlements'];

export function isAccountingPath(pathname) {
  if (pathname === '/sales' || pathname === '/invoices') return true;
  if (!pathname.startsWith('/accounting/')) return false;
  return !OWN_SUCURSAL.includes(pathname);
}
