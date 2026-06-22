/**
 * Migración: pasa el WhatsApp por-clínica (CallCenterConfig.whatsapp) al modelo
 * GLOBAL multi-número. Crea:
 *   - la primera WhatsappAccount (cloud_api, isDefault) con las credenciales que
 *     ya estaban configuradas, y
 *   - el singleton CallCenterWhatsappConfig (appSecret/verifyToken + callCenterClinic).
 *
 * Los secrets (accessToken/appSecret) ya venían cifrados en la config previa: se
 * copian tal cual. Idempotente: si ya existe alguna WhatsappAccount, no hace nada.
 *
 *   node scripts/migrateWhatsappAccounts.js            (dry-run)
 *   node scripts/migrateWhatsappAccounts.js --commit   (aplica)
 */
const { parseArgs, connect, disconnect, banner } = require('./_common');
const CallCenterConfig = require('../models/CallCenterConfig');
const CallCenterWhatsappConfig = require('../models/CallCenterWhatsappConfig');
const WhatsappAccount = require('../models/WhatsappAccount');

async function run() {
  const opts = parseArgs();
  banner('Migrar WhatsApp por-clínica → cuentas globales multi-número', opts);
  await connect();
  try {
    const existing = await WhatsappAccount.countDocuments();
    if (existing > 0) {
      console.log(`Ya existen ${existing} cuenta(s) de WhatsApp globales. Nada que migrar.`);
      return;
    }

    // Clínicas con WhatsApp configurado (al menos phoneNumberId + accessToken).
    const configs = await CallCenterConfig.find({
      'whatsapp.phoneNumberId': { $ne: '' },
      'whatsapp.accessToken': { $ne: '' },
    }).lean();

    if (configs.length === 0) {
      console.log('Ninguna clínica tiene WhatsApp Cloud API configurado. No hay nada que migrar.');
      return;
    }
    if (configs.length > 1) {
      console.log(`Aviso: ${configs.length} clínicas tienen WhatsApp configurado. Se usa la primera`);
      console.log('como número por defecto y sede del call center; las demás se migran como números extra.');
    }

    let isFirst = true;
    for (const cfg of configs) {
      const wa = cfg.whatsapp || {};
      console.log(
        `  [clínica ${cfg.clinic}] número ${wa.displayPhone || wa.phoneNumberId}` +
          `${isFirst ? ' (por defecto + sede)' : ''}`
      );
      if (opts.commit) {
        await WhatsappAccount.create({
          label: wa.displayPhone || 'WhatsApp principal',
          connectionType: 'cloud_api',
          enabled: !!wa.enabled,
          isDefault: isFirst,
          displayPhone: wa.displayPhone || '',
          phoneNumberId: wa.phoneNumberId || '',
          businessAccountId: wa.businessAccountId || '',
          accessToken: wa.accessToken || '', // ya cifrado
        });
        if (isFirst) {
          const singleton = await CallCenterWhatsappConfig.getSingleton();
          singleton.cloudApi = {
            appSecret: wa.appSecret || '', // ya cifrado
            verifyToken: wa.verifyToken || '',
          };
          singleton.callCenterClinic = cfg.clinic;
          await singleton.save();
        }
      }
      isFirst = false;
    }

    console.log(`\n${configs.length} número(s) ${opts.commit ? 'migrados' : 'por migrar'}.`);
    if (opts.dryRun) console.log('DRY-RUN: nada se escribió. Usa --commit para aplicar.');
  } finally {
    await disconnect();
  }
}

run().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
