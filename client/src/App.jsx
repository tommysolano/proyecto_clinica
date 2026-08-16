import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AuthProvider, useAuth } from './context/AuthContext';
import { SocketProvider } from './context/SocketContext';
import PrivateRoute from './components/PrivateRoute';
import RoleRoute from './components/RoleRoute';
import Layout from './components/Layout';
import Spinner from './components/Spinner';
import ErrorBoundary from './components/ErrorBoundary';
import { cargarPagina } from './utils/lazyPage';
// Login va EAGER a propósito: es la primera pantalla y hacerla perezosa añadiría
// una petición extra en cadena justo antes de poder escribir el usuario.
import Login from './pages/Login';

// =============================================================================
//  CARGA PEREZOSA DE LAS PÁGINAS (code-splitting)
// =============================================================================
//  Antes, las ~90 páginas se importaban de forma estática y Vite las metía TODAS
//  en un único fichero. Medido el 30-jul-2026: `index-*.js` = 2 661 373 bytes.
//  Eso significa que la recepcionista descargaba el módulo de nómina, las
//  declaraciones del SRI, el kárdex, el editor de workflows (`reactflow`) y las
//  gráficas (`recharts`) ANTES de ver la pantalla de login — para luego no entrar
//  en ninguna de esas pantallas en todo el día.
//
//  Con `lazy()` cada página se convierte en su propio fichero que se descarga la
//  primera vez que alguien entra en esa ruta. El arranque solo paga el armazón
//  (router + contextos + Layout + Login) y lo que la ruta actual necesite.
//
//  REQUISITO: cada página debe tener `export default`. Si alguna pasa a export
//  nombrado, aquí hay que hacer `.then(m => ({ default: m.Nombre }))`.
//
//  ─────────────────────────────────────────────────────────────────────────────
//  PANTALLA EN BLANCO AL NAVEGAR (o al darle a "atrás") — por qué pasaba.
//
//  Cada despliegue genera los ficheros con un hash nuevo (`Analytics-BNSmvEiw.js`)
//  y borra los de la versión anterior. Una pestaña abierta desde antes del
//  despliegue sigue teniendo en memoria los nombres VIEJOS: al entrar en una
//  pantalla que aún no había visitado, el `import()` pide un fichero que ya no
//  existe (404), la promesa se rompe y —sin nadie que recoja ese error— React
//  desmonta el árbol entero. Resultado: pantalla en blanco y ahí se queda, hasta
//  recargar a mano. Justo lo que reportó el usuario.
//
//  `pagina()` recoge ese fallo y recarga UNA vez para coger la versión nueva (la
//  lógica y su porqué, en utils/lazyPage.js). Si aun así falla, lo pinta la
//  barrera de error en vez de dejar el hueco en blanco.
const pagina = (importar) => lazy(() => cargarPagina(importar));
const DashboardAdmin = pagina(() => import('./pages/dashboards/DashboardAdmin'));
const DashboardCajero = pagina(() => import('./pages/dashboards/DashboardCajero'));
const DashboardDoctor = pagina(() => import('./pages/dashboards/DashboardDoctor'));
const DashboardOptica = pagina(() => import('./pages/dashboards/DashboardOptica'));
const DashboardCallCenter = pagina(() => import('./pages/dashboards/DashboardCallCenter'));
const DashboardMarketing = pagina(() => import('./pages/dashboards/DashboardMarketing'));
const DashboardEnfermero = pagina(() => import('./pages/dashboards/DashboardEnfermero'));
const Patients = pagina(() => import('./pages/Patients'));
const PatientDetail = pagina(() => import('./pages/PatientDetail'));
const ScanReview = pagina(() => import('./pages/ScanReview'));
const Appointments = pagina(() => import('./pages/Appointments'));
const Inventory = pagina(() => import('./pages/Inventory'));
const Sales = pagina(() => import('./pages/Sales'));
const Invoices = pagina(() => import('./pages/Invoices'));
const InvoicingConfig = pagina(() => import('./pages/InvoicingConfig'));
const Users = pagina(() => import('./pages/Users'));
const Clinics = pagina(() => import('./pages/Clinics'));
const Treatments = pagina(() => import('./pages/Treatments'));
const Referrals = pagina(() => import('./pages/Referrals'));
const Quotations = pagina(() => import('./pages/Quotations'));
const Marketing = pagina(() => import('./pages/Marketing'));
const Chats = pagina(() => import('./pages/Chats'));
const OpportunitiesGlobal = pagina(() => import('./pages/OpportunitiesGlobal'));
const Analytics = pagina(() => import('./pages/Analytics'));
const MessageTemplates = pagina(() => import('./pages/MessageTemplates'));
const WhatsappSpend = pagina(() => import('./pages/WhatsappSpend'));
const SavedReplies = pagina(() => import('./pages/SavedReplies'));
const Contacts = pagina(() => import('./pages/Contacts'));
const Segments = pagina(() => import('./pages/Segments'));
const Campaigns = pagina(() => import('./pages/Campaigns'));
const Workflows = pagina(() => import('./pages/Workflows'));
const WorkflowEditor = pagina(() => import('./pages/WorkflowEditor'));
const RecycleBin = pagina(() => import('./pages/RecycleBin'));
const Attribution = pagina(() => import('./pages/Attribution'));
const Reputation = pagina(() => import('./pages/Reputation'));
const Tasks = pagina(() => import('./pages/Tasks'));
const Scanner = pagina(() => import('./pages/Scanner'));
const PublicBooking = pagina(() => import('./pages/PublicBooking'));
const BookingConfig = pagina(() => import('./pages/BookingConfig'));
const CallCenterConfig = pagina(() => import('./pages/CallCenterConfig'));
const CommissionRules = pagina(() => import('./pages/CommissionRules'));
const Settings = pagina(() => import('./pages/Settings'));
const Reports = pagina(() => import('./pages/Reports'));
const Discounts = pagina(() => import('./pages/Discounts'));
const Rooms = pagina(() => import('./pages/Rooms'));
const Blocks = pagina(() => import('./pages/Blocks'));
const AccessBlocks = pagina(() => import('./pages/AccessBlocks'));
const ChartOfAccounts = pagina(() => import('./pages/accounting/ChartOfAccounts'));
const DataImport = pagina(() => import('./pages/accounting/DataImport'));
const CostCenters = pagina(() => import('./pages/accounting/CostCenters'));
const FiscalPeriods = pagina(() => import('./pages/accounting/FiscalPeriods'));
const JournalEntries = pagina(() => import('./pages/accounting/JournalEntries'));
const Ledger = pagina(() => import('./pages/accounting/Ledger'));
const TrialBalance = pagina(() => import('./pages/accounting/TrialBalance'));
const BankAccounts = pagina(() => import('./pages/accounting/BankAccounts'));
const BankMovements = pagina(() => import('./pages/accounting/BankMovements'));
const CashDeposits = pagina(() => import('./pages/accounting/CashDeposits'));
const CashBox = pagina(() => import('./pages/accounting/CashBox'));
const Reconciliations = pagina(() => import('./pages/accounting/Reconciliations'));
const Suppliers = pagina(() => import('./pages/accounting/Suppliers'));
const Payments = pagina(() => import('./pages/accounting/Payments'));
const PurchaseInvoices = pagina(() => import('./pages/accounting/PurchaseInvoices'));
const RetentionRules = pagina(() => import('./pages/accounting/RetentionRules'));
const CreditDebitNotes = pagina(() => import('./pages/accounting/CreditDebitNotes'));
const Warehouses = pagina(() => import('./pages/accounting/Warehouses'));
const InventoryCategories = pagina(() => import('./pages/accounting/InventoryCategories'));
const ConsolidatedInventory = pagina(() => import('./pages/accounting/ConsolidatedInventory'));
const PhysicalCounts = pagina(() => import('./pages/accounting/PhysicalCounts'));
const FixedAssets = pagina(() => import('./pages/accounting/FixedAssets'));
const FinancialReports = pagina(() => import('./pages/accounting/FinancialReports'));
const ManagementReports = pagina(() => import('./pages/accounting/ManagementReports'));
const SriReports = pagina(() => import('./pages/accounting/SriReports'));
const SriDeclarations = pagina(() => import('./pages/accounting/SriDeclarations'));
const SriAnnexes = pagina(() => import('./pages/accounting/SriAnnexes'));
const Employees = pagina(() => import('./pages/accounting/Employees'));
const EmployeeLoans = pagina(() => import('./pages/accounting/EmployeeLoans'));
const Deductions = pagina(() => import('./pages/accounting/Deductions'));
const Payroll = pagina(() => import('./pages/accounting/Payroll'));
const CreditCardBatches = pagina(() => import('./pages/accounting/CreditCardBatches'));
const AuditLogs = pagina(() => import('./pages/accounting/AuditLogs'));
const AccountingDashboard = pagina(() => import('./pages/accounting/AccountingDashboard'));
const Kardex = pagina(() => import('./pages/accounting/Kardex'));
const CashFlow = pagina(() => import('./pages/accounting/CashFlow'));
const PayrollConfig = pagina(() => import('./pages/accounting/PayrollConfig'));
const Decimos = pagina(() => import('./pages/accounting/Decimos'));
const Checks = pagina(() => import('./pages/accounting/Checks'));
const CreditCards = pagina(() => import('./pages/accounting/CreditCards'));
const CardSettlements = pagina(() => import('./pages/accounting/CardSettlements'));
const SalesReports = pagina(() => import('./pages/accounting/SalesReports'));
const CashClosing = pagina(() => import('./pages/accounting/CashClosing'));
const AccountMapping = pagina(() => import('./pages/accounting/AccountMapping'));
const PeriodBalances = pagina(() => import('./pages/accounting/PeriodBalances'));
const Budgets = pagina(() => import('./pages/accounting/Budgets'));
const Receivables = pagina(() => import('./pages/accounting/Receivables'));
const DeferredIncome = pagina(() => import('./pages/accounting/DeferredIncome'));
const RetentionVouchers = pagina(() => import('./pages/accounting/RetentionVouchers'));
const AccountingHealth = pagina(() => import('./pages/accounting/AccountingHealth'));
const Profitability = pagina(() => import('./pages/accounting/Profitability'));

function SuperAdminRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user?.isSuperAdmin) return <Navigate to="/" replace />;
  return children;
}

// Dashboard por rol. Nadie ve un dashboard genérico: cada rol tiene el suyo.
// Contabilidad reutiliza el dashboard contable existente; el resto de roles
// tiene su propio componente de bienvenida (contenido específico se agrega luego).
function RoleDashboard() {
  const { role, user, loading } = useAuth();
  if (loading) return null;
  if (!user?.isSuperAdmin && role === 'contabilidad') return <AccountingDashboard />;
  switch (role) {
    case 'cajero': return <DashboardCajero />;
    // Las especialidades usan el dashboard del doctor (WelcomeDashboard toma la
    // etiqueta del rol, así que cada una se saluda por su nombre).
    case 'doctor':
    case 'ginecologia':
    case 'podologia':
    case 'odontologia':
    case 'cosmetologia': return <DashboardDoctor />;
    case 'optica': return <DashboardOptica />;
    case 'call_center': return <DashboardCallCenter />;
    case 'marketing': return <DashboardMarketing />;
    case 'enfermero': return <DashboardEnfermero />;
    case 'admin':
    default: return <DashboardAdmin />;
  }
}

/**
 * Lo que se ve mientras se descarga el fichero de una página perezosa. Con la
 * red de la clínica y los ficheros ya cacheados es casi imperceptible; en la
 * primera visita a una pantalla evita el fogonazo en blanco.
 */
function PageFallback() {
  return (
    <div className="flex items-center justify-center py-16 text-slate-400">
      <Spinner className="h-6 w-6" />
    </div>
  );
}

/**
 * Barrera del área de contenido. Se rearma al cambiar de ruta: si no, una pantalla
 * que falló dejaba el hueco con el error para siempre, aunque el usuario se fuera
 * a otra parte del menú.
 */
function ContentBoundary({ children }) {
  const { pathname } = useLocation();
  return <ErrorBoundary resetKey={pathname}>{children}</ErrorBoundary>;
}

function AppRoutes() {
  return (
    <Suspense fallback={<PageFallback />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/book/:token" element={<PublicBooking />} />
        <Route
          path="/*"
          element={
            <PrivateRoute>
              <Layout>
                {/* Suspense propio DENTRO del Layout: al navegar entre páginas se
                    recarga solo el contenido y el menú lateral se queda fijo, en
                    vez de desmontarse y volver a montarse en cada salto.
                    La barrera va POR FUERA del Suspense (es donde React entrega el
                    error de un import roto) y DENTRO del Layout, para que un fallo
                    de una pantalla no se lleve por delante el menú. */}
                <ContentBoundary>
                <Suspense fallback={<PageFallback />}>
              <Routes>
                <Route path="/" element={<RoleDashboard />} />

                <Route
                  path="/patients"
                  element={
                    <RoleRoute roles={['admin', 'cajero', 'call_center', 'marketing', 'enfermero']}>
                      <Patients />
                    </RoleRoute>
                  }
                />
                {/* Va antes de '/patients/:id' para que no se lea como un id. */}
                <Route
                  path="/patients/scan-review"
                  element={
                    <RoleRoute roles={['admin', 'cajero', 'call_center']}>
                      <ScanReview />
                    </RoleRoute>
                  }
                />
                <Route
                  path="/patients/:id"
                  element={
                    <RoleRoute roles={['admin', 'cajero', 'doctor', 'optica', 'call_center', 'marketing', 'enfermero']}>
                      <PatientDetail />
                    </RoleRoute>
                  }
                />

                <Route
                  path="/appointments"
                  element={
                    <RoleRoute roles={['admin', 'cajero', 'doctor', 'optica', 'call_center', 'enfermero', 'marketing']}>
                      <Appointments />
                    </RoleRoute>
                  }
                />

                <Route
                  path="/inventory"
                  element={
                    <RoleRoute roles={['admin', 'contabilidad']}>
                      <Inventory />
                    </RoleRoute>
                  }
                />

                <Route
                  path="/sales"
                  element={
                    <RoleRoute roles={['admin', 'cajero', 'contabilidad']}>
                      <Sales />
                    </RoleRoute>
                  }
                />

                <Route
                  path="/invoices"
                  element={
                    <RoleRoute roles={['admin', 'cajero', 'contabilidad']}>
                      <Invoices />
                    </RoleRoute>
                  }
                />

                <Route
                  path="/invoicing-config"
                  element={
                    <RoleRoute roles={['admin', 'contabilidad']}>
                      <InvoicingConfig />
                    </RoleRoute>
                  }
                />

                <Route
                  path="/users"
                  element={
                    <RoleRoute roles={['admin']}>
                      <Users />
                    </RoleRoute>
                  }
                />

                {/* Calendario y Citas unificados en /appointments */}
                <Route path="/calendar" element={<Navigate to="/appointments" replace />} />
                <Route
                  path="/treatments"
                  element={
                    <RoleRoute roles={['admin', 'cajero', 'marketing', 'enfermero']}>
                      <Treatments />
                    </RoleRoute>
                  }
                />
                <Route
                  path="/referrals"
                  element={
                    <RoleRoute roles={['admin', 'marketing', 'cajero']}>
                      <Referrals />
                    </RoleRoute>
                  }
                />
                <Route
                  path="/quotations"
                  element={
                    <RoleRoute roles={['admin', 'cajero', 'call_center', 'contabilidad', 'marketing']}>
                      <Quotations />
                    </RoleRoute>
                  }
                />
                <Route
                  path="/marketing"
                  element={
                    <RoleRoute roles={['admin', 'marketing']}>
                      <Marketing />
                    </RoleRoute>
                  }
                />
                <Route
                  path="/chats"
                  element={
                    <RoleRoute roles={['admin', 'call_center', 'marketing']}>
                      <Chats />
                    </RoleRoute>
                  }
                />
                <Route
                  path="/opportunities"
                  element={
                    <RoleRoute roles={['admin', 'call_center', 'marketing']}>
                      <OpportunitiesGlobal />
                    </RoleRoute>
                  }
                />
                <Route
                  path="/analytics"
                  element={
                    <RoleRoute roles={['admin', 'marketing']}>
                      <Analytics />
                    </RoleRoute>
                  }
                />
                <Route
                  path="/message-templates"
                  element={
                    <RoleRoute roles={['admin', 'marketing']}>
                      <MessageTemplates />
                    </RoleRoute>
                  }
                />
                <Route
                  path="/whatsapp-spend"
                  element={
                    <RoleRoute roles={['admin', 'marketing']}>
                      <WhatsappSpend />
                    </RoleRoute>
                  }
                />
                <Route
                  path="/saved-replies"
                  element={
                    <RoleRoute roles={['admin', 'call_center', 'marketing']}>
                      <SavedReplies />
                    </RoleRoute>
                  }
                />
                <Route
                  path="/contacts"
                  element={
                    <RoleRoute roles={['admin', 'call_center', 'marketing']}>
                      <Contacts />
                    </RoleRoute>
                  }
                />
                <Route
                  path="/segments"
                  element={
                    <RoleRoute roles={['admin', 'marketing']}>
                      <Segments />
                    </RoleRoute>
                  }
                />
                <Route
                  path="/campaigns"
                  element={
                    <RoleRoute roles={['admin', 'marketing']}>
                      <Campaigns />
                    </RoleRoute>
                  }
                />
                <Route
                  path="/workflows"
                  element={
                    <RoleRoute roles={['admin', 'marketing', 'call_center']}>
                      <Workflows />
                    </RoleRoute>
                  }
                />
                <Route
                  path="/workflows/new"
                  element={
                    <RoleRoute roles={['admin', 'marketing', 'call_center']}>
                      <WorkflowEditor />
                    </RoleRoute>
                  }
                />
                <Route
                  path="/workflows/:id/edit"
                  element={
                    <RoleRoute roles={['admin', 'marketing', 'call_center']}>
                      <WorkflowEditor />
                    </RoleRoute>
                  }
                />
                <Route
                  path="/recycle-bin"
                  element={
                    <RoleRoute roles={['admin', 'marketing']}>
                      <RecycleBin />
                    </RoleRoute>
                  }
                />
                <Route
                  path="/attribution"
                  element={
                    <RoleRoute roles={['admin', 'marketing']}>
                      <Attribution />
                    </RoleRoute>
                  }
                />
                <Route
                  path="/reputation"
                  element={
                    <RoleRoute roles={['admin', 'marketing']}>
                      <Reputation />
                    </RoleRoute>
                  }
                />
                <Route
                  path="/tasks"
                  element={
                    <RoleRoute roles={['admin', 'call_center', 'marketing']}>
                      <Tasks />
                    </RoleRoute>
                  }
                />
                {/* Escáner de documentos: sin RoleRoute, es para todos los usuarios. */}
                <Route path="/scanner" element={<Scanner />} />
                <Route
                  path="/booking-config"
                  element={
                    <RoleRoute roles={['admin', 'marketing']}>
                      <BookingConfig />
                    </RoleRoute>
                  }
                />
                <Route
                  path="/call-center-config"
                  element={
                    <RoleRoute roles={['admin', 'marketing']}>
                      <CallCenterConfig />
                    </RoleRoute>
                  }
                />
                <Route
                  path="/commission-rules"
                  element={
                    <RoleRoute roles={['admin', 'contabilidad']}>
                      <CommissionRules />
                    </RoleRoute>
                  }
                />
                <Route
                  path="/discounts"
                  element={
                    <RoleRoute roles={['admin', 'cajero', 'contabilidad']}>
                      <Discounts />
                    </RoleRoute>
                  }
                />
                <Route
                  path="/rooms"
                  element={
                    <RoleRoute roles={['admin']}>
                      <Rooms />
                    </RoleRoute>
                  }
                />
                <Route
                  path="/blocks"
                  element={
                    <RoleRoute roles={['admin']}>
                      <Blocks />
                    </RoleRoute>
                  }
                />

                <Route
                  path="/clinics"
                  element={
                    <SuperAdminRoute>
                      <Clinics />
                    </SuperAdminRoute>
                  }
                />

                <Route
                  path="/access-blocks"
                  element={
                    <SuperAdminRoute>
                      <AccessBlocks />
                    </SuperAdminRoute>
                  }
                />

                {/* Contabilidad */}
                {[
                  ['dashboard', AccountingDashboard],
                  ['kardex', Kardex],
                  ['cash-flow', CashFlow],
                  ['payroll-config', PayrollConfig],
                  ['decimos', Decimos],
                  ['checks', Checks],
                  ['cards', CreditCards],
                  ['chart', ChartOfAccounts],
                  ['data-import', DataImport],
                  ['account-mapping', AccountMapping],
                  ['cost-centers', CostCenters],
                  ['periods', FiscalPeriods],
                  ['journal', JournalEntries],
                  ['ledger', Ledger],
                  ['trial-balance', TrialBalance],
                  ['period-balances', PeriodBalances],
                  ['banks', BankAccounts],
                  ['bank-movements', BankMovements],
                  ['cash', CashBox],
                  ['cash-deposits', CashDeposits],
                  ['cash-closing', CashClosing],
                  ['reconciliations', Reconciliations],
                  ['suppliers', Suppliers],
                  ['payments', Payments],
                  ['cartera', Receivables],
                  ['deferred-income', DeferredIncome],
                  ['purchases', PurchaseInvoices],
                  ['credit-debit-notes', CreditDebitNotes],
                  ['retention-rules', RetentionRules],
                  ['retention-vouchers', RetentionVouchers],
                  ['accounting-health', AccountingHealth],
                  ['profitability', Profitability],
                  ['warehouses', Warehouses],
                  ['inv-categories', InventoryCategories],
                  ['inv-consolidated', ConsolidatedInventory],
                  ['counts', PhysicalCounts],
                  ['assets', FixedAssets],
                  ['financial-reports', FinancialReports],
                  ['management-reports', ManagementReports],
                  ['budgets', Budgets],
                  ['sri-reports', SriReports],
                  ['sri-declarations', SriDeclarations],
                  ['sri-annexes', SriAnnexes],
                  ['employees', Employees],
                  ['loans', EmployeeLoans],
                  ['deductions', Deductions],
                  ['payroll', Payroll],
                  ['credit-card-batches', CreditCardBatches],
                  ['card-settlements', CardSettlements],
                  ['sales-reports', SalesReports],
                  ['audit-logs', AuditLogs],
                ].map(([path, Comp]) => (
                  <Route
                    key={path}
                    path={`/accounting/${path}`}
                    element={
                      <RoleRoute roles={['admin', 'contabilidad']}>
                        <Comp />
                      </RoleRoute>
                    }
                  />
                ))}

                {/* Caja (apertura/cierre) accesible también al cajero */}
                <Route
                  path="/cash-register"
                  element={
                    <RoleRoute roles={['admin', 'contabilidad', 'cajero']}>
                      <CashClosing />
                    </RoleRoute>
                  }
                />

                <Route path="/settings" element={<Settings />} />
                <Route
                  path="/reports"
                  element={
                    <RoleRoute roles={['admin', 'marketing']}>
                      <Reports />
                    </RoleRoute>
                  }
                />

                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
                </Suspense>
                </ContentBoundary>
              </Layout>
            </PrivateRoute>
          }
        />
      </Routes>
    </Suspense>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <SocketProvider>
          {/* zIndex 20000: los toasts (sobre todo errores) deben verse ENCIMA de los
              modales (z-9999) y de los dropdowns (z-10001), nunca tapados. */}
          <Toaster position="top-right" containerStyle={{ zIndex: 20000 }} toastOptions={{ duration: 3000, error: { duration: 6000 } }} />
          <AppRoutes />
        </SocketProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
