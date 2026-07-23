require('dotenv').config();

// Guardia de arranque: SECRETS_KEY cifra/descifra los tokens de WhatsApp/Meta en
// reposo. Si el proceso arranca SIN ella (típico: un deploy con `pm2 --update-env`
// desde una shell sin la clave, o falta en server/.env), los tokens quedan
// ILEGIBLES y los envíos fallan con "no se pudo descifrar el token" — un fallo
// que antes era mudo y difícil de diagnosticar. Aquí gritamos en los logs para
// detectarlo al instante. NO tumbamos el proceso: el resto de la API debe seguir
// viva; solo el envío por Cloud API se degrada (con su propio error accionable).
(() => {
  const k = process.env.SECRETS_KEY;
  const valid = typeof k === 'string' && (/^[0-9a-fA-F]{64}$/.test(k) || Buffer.from(k, 'base64').length === 32);
  if (!valid) {
    console.error('\n' + '='.repeat(70));
    console.error('[SECRETS_KEY] ⚠️  FALTA o es INVÁLIDA al arrancar.');
    console.error('  → Los tokens de WhatsApp/Meta NO se podrán descifrar y los');
    console.error('    envíos por Cloud API fallarán ("no se pudo descifrar el token").');
    console.error('  → Debe estar en server/.env (64 hex). Revisa que el deploy no la');
    console.error('    borre (pm2 --update-env desde una shell sin la clave).');
    console.error('='.repeat(70) + '\n');
  }
})();

// Zona horaria de TODO el proceso = Ecuador (Guayaquil, UTC-5, sin horario de
// verano). Debe ir ANTES de cualquier uso de Date para que getDate()/getHours()/
// setHours()/toLocaleString(), la fecha de emisión SRI, cortes de "hoy", etc. se
// calculen siempre en hora de Ecuador y NUNCA en la del servidor (que en el VPS
// suele estar en UTC). Node re-lee process.env.TZ al reasignarlo.
process.env.TZ = process.env.TZ || 'America/Guayaquil';

// Una promesa sin manejar NO debe tumbar toda la API de la clínica (Node >=15
// mata el proceso por defecto). Caso real: RemoteAuth de whatsapp-web.js
// crasheaba el server entero al fallar el guardado de la sesión. Se loguea con
// stack para poder corregir la causa; las excepciones síncronas no capturadas
// sí siguen matando el proceso (estado potencialmente corrupto, pm2 reinicia).
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

// Apagado ORDENADO: pm2 manda SIGINT en cada deploy (5 deploys en una tarde son
// 5 reinicios). Sin esto Node muere de golpe y los Chromium de WhatsApp QR
// quedan degollados a mitad de escritura de la sesión: tras varios deploys la
// sesión guardada se corrompe → auth_failure → a re-escanear el QR. El deploy
// da 15 s de gracia (--kill-timeout); aquí nos autoimponemos 10 s por si un
// destroy se cuelga.
let shuttingDown = false;
function gracefulExit(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal}: cerrando sesiones de WhatsApp QR…`);
  const forced = setTimeout(() => process.exit(0), 10 * 1000);
  require('./utils/whatsappQrManager')
    .shutdownAll()
    .then(() => console.log('[shutdown] sesiones cerradas limpiamente'))
    .catch(() => {})
    .finally(() => {
      clearTimeout(forced);
      process.exit(0);
    });
}
process.on('SIGINT', () => gracefulExit('SIGINT'));
process.on('SIGTERM', () => gracefulExit('SIGTERM'));

const express = require('express');
const http = require('http');
const cors = require('cors');
const connectDB = require('./config/db');
const realtime = require('./realtime');

const app = express();

// Conectar base de datos
connectDB();

// Middleware
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : ['http://localhost:5173', 'http://localhost:4173'];

app.use(
  cors({
    origin: (origin, cb) => {
      // Permitir peticiones sin origin (Postman, Render health-checks, etc.)
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error(`CORS: origin no permitido: ${origin}`));
    },
    credentials: true,
  })
);
app.use(express.json({
  // La media del chat viaja como data URL base64 dentro del JSON (base64 infla
  // ~33%), así que este tope es el techo real de subida. 50mb admite un video de
  // ~32MB. OJO PRODUCCIÓN: nginx debe tener client_max_body_size >= 50m o cortará
  // el upload con 413 antes de llegar aquí.
  limit: '50mb',
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  },
}));

// Auditoría contable
app.use(require('./middleware/audit'));

// Rutas
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/access-blocks', require('./routes/accessBlocks'));
app.use('/api/clinics', require('./routes/clinics'));
app.use('/api/patients', require('./routes/patients'));
app.use('/api/lookup', require('./routes/lookup'));
app.use('/api/clinical-records', require('./routes/clinicalRecords'));
app.use('/api/cie10', require('./routes/cie10'));
app.use('/api/appointments', require('./routes/appointments'));
app.use('/api/products', require('./routes/products'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/sales', require('./routes/sales'));
app.use('/api/invoicing-config', require('./routes/invoicingConfig'));
app.use('/api/invoices', require('./routes/invoices'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/rooms', require('./routes/rooms'));
app.use('/api/time-blocks', require('./routes/timeBlocks'));
app.use('/api/treatments', require('./routes/treatments'));
app.use('/api/referrals', require('./routes/referrals'));
app.use('/api/discounts', require('./routes/discounts'));
app.use('/api/quotations', require('./routes/quotations'));
app.use('/api/marketing', require('./routes/marketing'));
app.use('/api/message-templates', require('./routes/messageTemplates'));
app.use('/api/segments', require('./routes/segments'));
app.use('/api/campaigns', require('./routes/campaigns'));
app.use('/api/workflows', require('./routes/workflows'));
app.use('/api/agent-tasks', require('./routes/agentTasks'));
app.use('/api/reviews', require('./routes/reviews'));
app.use('/api/booking-config', require('./routes/bookingConfig'));
app.use('/api/public', require('./routes/public'));
app.use('/api/chats', require('./routes/chats'));
app.use('/api/contacts', require('./routes/contacts'));
app.use('/api/call-center', require('./routes/callCenter'));
app.use('/api/call-center-config', require('./routes/callCenterConfig'));
app.use('/api/commissions', require('./routes/commissions'));

// === Módulo contable ===
app.use('/api/chart-of-accounts', require('./routes/chartOfAccounts'));
app.use('/api/cost-centers', require('./routes/costCenters'));
app.use('/api/fiscal-periods', require('./routes/fiscalPeriods'));
app.use('/api/journal-entries', require('./routes/journalEntries'));
app.use('/api/banks', require('./routes/banks'));
app.use('/api/suppliers', require('./routes/suppliers'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/subledger', require('./routes/subledger'));
app.use('/api/purchase-invoices', require('./routes/purchaseInvoices'));
app.use('/api/retention-rules', require('./routes/retentionRules'));
app.use('/api/retention-vouchers', require('./routes/retentionVouchers'));
app.use('/api/credit-debit-notes', require('./routes/creditDebitNotes'));
app.use('/api/inventory-advanced', require('./routes/inventoryAdvanced'));
app.use('/api/accounting-reports', require('./routes/accountingReports'));
app.use('/api/tax-declarations', require('./routes/taxDeclarations'));
app.use('/api/cash-flow', require('./routes/cashFlow'));
app.use('/api/payroll', require('./routes/payroll'));
app.use('/api/credit-card-batches', require('./routes/creditCardBatches'));
app.use('/api/card-settlements', require('./routes/cardSettlements'));
app.use('/api/sales-reports', require('./routes/salesReports'));
app.use('/api/cash-closings', require('./routes/cashClosings'));
app.use('/api/accounting-config', require('./routes/accountingConfig'));
app.use('/api/accounting-health', require('./routes/accountingHealth'));
app.use('/api/deferred-income', require('./routes/deferredIncome'));
app.use('/api/budgets', require('./routes/budgets'));
app.use('/api/audit-logs', require('./routes/auditLogs'));
app.use('/api/data-import', require('./routes/dataImport'));

// Ruta de salud
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Middleware de errores GLOBAL: red de seguridad para cualquier error no atrapado. Traduce los
// errores crudos de Mongo (E11000, validación, cast) a mensajes legibles con el status correcto;
// el detalle técnico se queda en los logs del servidor. Va al final, después de todas las rutas.
app.use(require('./utils/apiError').errorHandler);

const PORT = process.env.PORT || 5000;
const server = http.createServer(app);
realtime.init(server);

// Conectar a MongoDB primero, luego arrancar el servidor
connectDB().then(() => {
  server.listen(PORT, () => {
    console.log(`Servidor corriendo en puerto ${PORT} (HTTP + Socket.IO)`);
  });

  // Registro de instancias + elección de LÍDER. Cada backend late en la base; el
  // que consigue el arriendo de 'jobs' es el ÚNICO que ejecuta los jobs y las
  // sesiones QR. Esto ataca la causa raíz de los mensajes DUPLICADOS y de las
  // burbujas rojas "no se envió" en chats donde el mensaje sí llegó: eran dos
  // backends corriendo a la vez contra la misma base (uno sin SECRETS_KEY / sin
  // la sesión de WhatsApp Web). Un proceso con JOBS_DISABLED=1 (dev contra prod)
  // late igual — para ser VISIBLE en el diagnóstico — pero nunca toma el arriendo.
  const registry = require('./utils/instanceRegistry');
  // Al GANAR el liderazgo: cablear los jobs (una sola vez) + arrancar las sesiones
  // QR. Al PERDERLO: APAGAR las sesiones QR para que el nuevo líder pueda tomarlas
  // sin pelearse (WhatsApp Web solo admite UNA sesión activa por número — dos
  // servidores a la vez = auth_failure y flapping). Los jobs por intervalo quedan
  // cableados una vez y no disparan si no somos líder (leaderOnly).
  let jobsWired = false;
  registry.start(
    () => {
      if (!jobsWired) { jobsWired = true; wireLeaderJobs(); }
      // A los 5s para no competir con la inicialización del resto.
      setTimeout(() => { require('./utils/whatsappQrManager').initEnabledOnBoot().catch(() => {}); }, 5 * 1000);
    },
    () => {
      require('./utils/whatsappQrManager').shutdownAll().catch(() => {});
    }
  );
  process.on('SIGINT', () => registry.release());
  process.on('SIGTERM', () => registry.release());

  // Cablea los jobs periódicos (una sola vez). Cada intervalo se envuelve en
  // `leaderOnly`: si el proceso NO es el líder, no dispara — así nunca envía en
  // paralelo con el líder real.
  function wireLeaderJobs() {
    const only = registry.leaderOnly;
    // Job: marcar automáticamente como "no asistió" las citas de días pasados.
    require('./utils/autoNoShow').startAutoNoShowJob();
    // Job: reanudar flujos de mensajes con pasos de espera vencidos (cada 60s).
    const { processDueFlowRuns } = require('./controllers/chatController');
    setInterval(only(() => { processDueFlowRuns().catch(() => {}); }), 60 * 1000);
    // Job: procesar mensajes de campañas encolados/vencidos (cada 60s).
    const { processDueScheduledMessages } = require('./controllers/campaignController');
    setInterval(only(() => { processDueScheduledMessages().catch(() => {}); }), 60 * 1000);
    // Job: importaciones de contactos pendientes (cada 60s). Van fuera de la
    // petición HTTP porque 47k filas tardan minutos y nginx corta a los 60s.
    const { processPendingImports } = require('./utils/contactImportRunner');
    setInterval(only(() => { processPendingImports().catch(() => {}); }), 60 * 1000);
    // Job: tandas del envío masivo por goteo (cada 60s). El goteo es lo que evita
    // que una ráfaga tumbe el número (por QR) o rebote contra el límite de Meta.
    const { processDueDrips } = require('./utils/dripRunner');
    setInterval(only(() => { processDueDrips().catch(() => {}); }), 60 * 1000);
    // Motor de workflows: suscribe a eventos de dominio + reanuda esperas vencidas.
    const workflowEngine = require('./utils/workflowEngine');
    workflowEngine.subscribeDomainEvents();
    // Meta Conversions API (CAPI): reporta Lead/Schedule/Purchase a Meta si está configurada.
    require('./utils/metaConversions').subscribeDomainEvents();
    // Cada 20s (antes 60s): así las esperas de menos de un minuto del paso "Esperar
    // (tiempo)" — p. ej. 15/30 segundos entre dos mensajes — se retoman con una
    // resolución razonable en vez de esperar siempre al minuto.
    setInterval(only(() => { workflowEngine.processDueEnrollments().catch(() => {}); }), 20 * 1000);
    // Job: cumpleaños del día (dispara workflows patient_birthday).
    require('./utils/birthdayJob').startBirthdayJob();
    // Job: abandono automático de tratamientos (dispara workflows
    // treatment_abandoned aunque nadie abra la página de Tratamientos).
    require('./utils/treatmentAbandonment').startTreatmentAbandonmentJob();
    // Job: reintentar facturas electrónicas pendientes cuando el SRI se cae
    // (reenvía las EN_COLA y consulta autorización de las recibidas). Cada
    // SRI_RETRY_INTERVAL_MIN minutos (por defecto 5).
    require('./utils/invoiceRetry').startInvoiceRetryJob();
    // (Las sesiones QR las arranca/para el manejador de liderazgo, no aquí: deben
    //  vivir SOLO mientras este proceso sea líder para no pelearse con otro server.)
    // Job: sincronizar plantillas de WhatsApp con Meta para detectar cambios de
    // categoría/estado y alertar (recategorización = impacto en costo). El webhook
    // notifica al instante; este sondeo es la red de seguridad. Frecuencia
    // configurable con TEMPLATE_SYNC_INTERVAL_MIN (min 5, por defecto 60 minutos).
    const { syncAllClinicsTemplates } = require('./controllers/messageTemplateController');
    const TPL_SYNC_MS = Math.max(5, Number(process.env.TEMPLATE_SYNC_INTERVAL_MIN) || 60) * 60 * 1000;
    setTimeout(only(() => { syncAllClinicsTemplates().catch(() => {}); }), 30 * 1000);
    setInterval(only(() => { syncAllClinicsTemplates().catch(() => {}); }), TPL_SYNC_MS);
  }
}).catch((err) => {
  console.error('No se pudo conectar a MongoDB, abortando:', err.message);
  process.exit(1);
});
