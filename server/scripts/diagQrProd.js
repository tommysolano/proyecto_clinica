/**
 * Diagnóstico de producción: prueba la generación del QR de WhatsApp contra el
 * server VIVO (pm2), vía la API real, y observa el estado hasta 'qr_pending'.
 *
 * Se corre EN el VPS (workflow "Diagnostico VPS"):
 *   cd /var/www/clinica/server && node scripts/diagQrProd.js
 *
 * No modifica datos: usa la cuenta QR existente y el mismo endpoint que pulsa
 * el botón "Conectar" de la UI. Requiere .env (JWT_SECRET, MONGODB_URI).
 */
require('dotenv').config();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const BASE = `http://127.0.0.1:${process.env.PORT || 5000}/api`;

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const User = require('../models/User');
  const WhatsappAccount = require('../models/WhatsappAccount');
  const Clinic = require('../models/Clinic');

  const user =
    (await User.findOne({ isSuperAdmin: true, active: true })) ||
    (await User.findOne({ active: true, 'clinics.role': 'admin' }));
  const clinic = await Clinic.findOne().sort({ createdAt: 1 });
  const acc = await WhatsappAccount.findOne({ connectionType: 'qr' }).sort({ createdAt: 1 });
  if (!user || !clinic || !acc) {
    console.log('FALTAN DATOS:', { user: !!user, clinic: !!clinic, cuentaQr: !!acc });
    process.exit(1);
  }
  console.log(`cuenta QR: "${acc.label}" (${acc._id}) status BD: ${acc.status} connectedPhone: ${acc.connectedPhone || '-'}`);

  const token = jwt.sign({ id: String(user._id), clinicId: String(clinic._id) }, process.env.JWT_SECRET, {
    expiresIn: '10m',
  });
  const headers = { Authorization: `Bearer ${token}` };

  const post = await fetch(`${BASE}/call-center-config/whatsapp/accounts/${acc._id}/connect`, {
    method: 'POST',
    headers,
  });
  console.log('POST /connect →', post.status, (await post.text()).slice(0, 200));

  for (let i = 1; i <= 24; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const res = await fetch(`${BASE}/call-center-config/whatsapp/accounts`, { headers });
    const list = await res.json();
    const a = (Array.isArray(list) ? list : []).find((x) => String(x._id) === String(acc._id));
    console.log(`[${i * 5}s] status=${a && a.status} live=${a && a.liveStatus} lastQrAt=${(a && a.lastQrAt) || '-'}`);
    if (a && (a.liveStatus === 'qr_pending' || a.status === 'qr_pending')) {
      console.log('QR GENERADO EN PRODUCCION OK');
      process.exit(0);
    }
    if (a && a.status === 'auth_failure' && a.liveStatus !== 'connecting') {
      console.log('FALLO: la cuenta quedo en auth_failure (revisar [whatsapp-qr] en pm2 logs)');
      process.exit(1);
    }
  }
  console.log('TIMEOUT: 120s sin qr_pending');
  process.exit(1);
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
