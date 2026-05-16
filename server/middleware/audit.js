const AuditLog = require('../models/AuditLog');

/**
 * Middleware ligero de auditoría: registra acciones de escritura (POST/PUT/PATCH/DELETE)
 * sobre rutas contables sensibles. Captura el resultado al terminar la respuesta.
 */
const SENSITIVE_PREFIXES = [
  '/api/journal-entries',
  '/api/fiscal-periods',
  '/api/chart-of-accounts',
  '/api/banks',
  '/api/purchase-invoices',
  '/api/credit-debit-notes',
  '/api/payments',
  '/api/payroll',
  '/api/credit-card-batches',
  '/api/inventory-advanced',
];

function actionFromMethod(method, path) {
  if (method === 'POST') {
    if (path.includes('/reverse')) return 'REVERSE';
    if (path.includes('/close')) return 'CLOSE';
    if (path.includes('/reopen') || path.includes('/open')) return 'OPEN';
    if (path.includes('/liquidate')) return 'LIQUIDATE';
    if (path.includes('/confirm')) return 'POST';
    return 'CREATE';
  }
  if (method === 'PUT' || method === 'PATCH') return 'UPDATE';
  if (method === 'DELETE') return 'DELETE';
  return method;
}

module.exports = function audit(req, res, next) {
  const m = req.method;
  if (m === 'GET' || m === 'OPTIONS') return next();
  const sensitive = SENSITIVE_PREFIXES.some((p) => req.originalUrl.startsWith(p));
  if (!sensitive) return next();

  const startBody = req.body;
  res.on('finish', () => {
    try {
      if (!req.user || !req.clinicId) return;
      const success = res.statusCode < 400;
      const entity = req.originalUrl.split('/')[2] || 'unknown';
      AuditLog.create({
        clinic: req.clinicId,
        user: req.user._id,
        userName: req.user.name || req.user.email,
        role: req.user.role,
        action: actionFromMethod(m, req.originalUrl),
        entity,
        entityId: req.params?.id,
        method: m,
        path: req.originalUrl,
        ip: req.ip,
        before: undefined,
        after: success ? startBody : undefined,
        success,
      }).catch(() => {});
    } catch { /* no romper request */ }
  });
  next();
};
