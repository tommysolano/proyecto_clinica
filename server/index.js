require('dotenv').config();
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
app.use(express.json({ limit: '10mb' }));

// Auditoría contable
app.use(require('./middleware/audit'));

// Rutas
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/clinics', require('./routes/clinics'));
app.use('/api/patients', require('./routes/patients'));
app.use('/api/clinical-records', require('./routes/clinicalRecords'));
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
app.use('/api/chats', require('./routes/chats'));
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
app.use('/api/purchase-invoices', require('./routes/purchaseInvoices'));
app.use('/api/credit-debit-notes', require('./routes/creditDebitNotes'));
app.use('/api/inventory-advanced', require('./routes/inventoryAdvanced'));
app.use('/api/accounting-reports', require('./routes/accountingReports'));
app.use('/api/payroll', require('./routes/payroll'));
app.use('/api/credit-card-batches', require('./routes/creditCardBatches'));
app.use('/api/card-settlements', require('./routes/cardSettlements'));
app.use('/api/sales-reports', require('./routes/salesReports'));
app.use('/api/cash-closings', require('./routes/cashClosings'));
app.use('/api/audit-logs', require('./routes/auditLogs'));

// Ruta de salud
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 5000;
const server = http.createServer(app);
realtime.init(server);

// Conectar a MongoDB primero, luego arrancar el servidor
connectDB().then(() => {
  server.listen(PORT, () => {
    console.log(`Servidor corriendo en puerto ${PORT} (HTTP + Socket.IO)`);
  });
  // Job: marcar automáticamente como "no asistió" las citas de días pasados.
  require('./utils/autoNoShow').startAutoNoShowJob();
  // Job: reanudar flujos de mensajes con pasos de espera vencidos (cada 60s).
  const { processDueFlowRuns } = require('./controllers/chatController');
  setInterval(() => { processDueFlowRuns().catch(() => {}); }, 60 * 1000);
}).catch((err) => {
  console.error('No se pudo conectar a MongoDB, abortando:', err.message);
  process.exit(1);
});
