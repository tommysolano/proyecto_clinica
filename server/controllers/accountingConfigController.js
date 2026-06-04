const AccountingConfig = require('../models/AccountingConfig');
const ChartOfAccount = require('../models/ChartOfAccount');
const { ACCOUNT_ROLES, getAccount } = require('../utils/accountMap');

/** Devuelve el catálogo de roles, la cuenta configurada y la cuenta efectiva. */
exports.get = async (req, res) => {
  try {
    const cfg = await AccountingConfig.findOne({ clinic: req.clinicId });
    const roles = [];
    for (const [key, def] of Object.entries(ACCOUNT_ROLES)) {
      const configuredId = cfg?.accounts?.get?.(key) || null;
      let effective = null;
      try { const acc = await getAccount(req.clinicId, key); effective = { _id: acc._id, code: acc.code, name: acc.name }; }
      catch { effective = null; }
      roles.push({ key, group: def.group, label: def.label, defaultCode: def.code || def.taxCode, configured: configuredId, effective });
    }
    res.json({ roles });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

/** Guarda el mapa de cuentas (parcial). Body: { accounts: { role: accountId|null } } */
exports.update = async (req, res) => {
  try {
    const incoming = req.body?.accounts || {};
    let cfg = await AccountingConfig.findOne({ clinic: req.clinicId });
    if (!cfg) cfg = new AccountingConfig({ clinic: req.clinicId, accounts: {} });
    for (const [role, accId] of Object.entries(incoming)) {
      if (!ACCOUNT_ROLES[role]) continue;
      if (!accId) { cfg.accounts.delete(role); continue; }
      const acc = await ChartOfAccount.findOne({ _id: accId, clinic: req.clinicId });
      if (!acc) return res.status(400).json({ message: `Cuenta inválida para ${role}` });
      if (!acc.allowsMovement) return res.status(400).json({ message: `La cuenta ${acc.code} es agrupadora (no admite movimientos)` });
      cfg.accounts.set(role, acc._id);
    }
    cfg.updatedBy = req.user._id;
    await cfg.save();
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ message: e.message }); }
};
