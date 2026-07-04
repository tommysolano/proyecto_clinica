const ChartOfAccount = require('../models/ChartOfAccount');

/**
 * Jerarquía del plan de cuentas: dada una cuenta (padre o de movimiento) devuelve
 * la cuenta raíz + TODAS sus descendientes de la clínica, combinando dos criterios
 * porque el plan de clínicas antiguas no siempre tiene `parent` seteado:
 *
 *   1. relación explícita por `parent` (recorrido BFS de hijos → nietos → …);
 *   2. compatibilidad por PREFIJO de código contable (`code` empieza por `<code>.`).
 *
 * Ejemplo: consultar `1.1.01.03 Bancos` incluye `1.1.01.03`, `1.1.01.03.01`,
 * `1.1.01.03.02` y cualquier cuenta cuyo código empiece por `1.1.01.03.`.
 */

/** Reúne la raíz y sus descendientes a partir de un documento de cuenta (lean). */
async function collectDescendants(clinicId, root) {
  const all = await ChartOfAccount.find({ clinic: clinicId }).lean();

  // Índice hijos por parent para el recorrido BFS.
  const childrenByParent = new Map();
  for (const a of all) {
    const p = a.parent ? String(a.parent) : null;
    if (!p) continue;
    if (!childrenByParent.has(p)) childrenByParent.set(p, []);
    childrenByParent.get(p).push(a);
  }

  const selected = new Map();
  selected.set(String(root._id), root);

  // 1) Descendientes por relación `parent` (BFS).
  const queue = [String(root._id)];
  while (queue.length) {
    const id = queue.shift();
    for (const child of childrenByParent.get(id) || []) {
      const key = String(child._id);
      if (!selected.has(key)) {
        selected.set(key, child);
        queue.push(key);
      }
    }
  }

  // 2) Descendientes por prefijo de código (planes sin `parent`).
  if (root.code) {
    const prefix = `${root.code}.`;
    for (const a of all) {
      if (a.code && a.code.startsWith(prefix)) selected.set(String(a._id), a);
    }
  }

  const accounts = Array.from(selected.values());
  const ids = accounts.map((a) => a._id);
  // Es padre si agrupa a más de una cuenta o si no admite movimientos directos.
  const isParent = accounts.length > 1 || root.allowsMovement === false;
  return { root, accounts, ids, isParent };
}

/**
 * @param {Object} args
 * @param {string} args.clinicId
 * @param {string} [args.accountId]  _id de la cuenta a resolver.
 * @param {Object} [args.account]    documento de cuenta ya cargado (evita una consulta).
 * @returns {Promise<{root, accounts, ids, isParent}|null>}
 */
async function getAccountAndDescendants({ clinicId, accountId, account }) {
  const root = account
    ? (account.toObject ? account.toObject() : account)
    : await ChartOfAccount.findOne({ _id: accountId, clinic: clinicId }).lean();
  if (!root) return null;
  return collectDescendants(clinicId, root);
}

/**
 * @param {Object} args
 * @param {string} args.clinicId
 * @param {string} args.code  código contable de la cuenta a resolver.
 * @returns {Promise<{root, accounts, ids, isParent}|null>}
 */
async function getAccountAndDescendantsByCode({ clinicId, code }) {
  const root = await ChartOfAccount.findOne({ code, clinic: clinicId }).lean();
  if (!root) return null;
  return collectDescendants(clinicId, root);
}

module.exports = { getAccountAndDescendants, getAccountAndDescendantsByCode };
