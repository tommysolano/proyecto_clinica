import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AuthProvider, useAuth } from './context/AuthContext';
import { SocketProvider } from './context/SocketContext';
import PrivateRoute from './components/PrivateRoute';
import RoleRoute from './components/RoleRoute';
import Layout from './components/Layout';
import Spinner from './components/Spinner';
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
const DashboardAdmin = lazy(() => import('./pages/dashboards/DashboardAdmin'));
const DashboardCajero = lazy(() => import('./pages/dashboards/DashboardCajero'));
const DashboardDoctor = lazy(() => import('./pages/dashboards/DashboardDoctor'));
const DashboardOptica = lazy(() => import('./pages/dashboards/DashboardOptica'));
const DashboardCallCenter = lazy(() => import('./pages/dashboards/DashboardCallCenter'));
const DashboardMarketing = lazy(() => import('./pages/dashboards/DashboardMarketing'));
const DashboardEnfermero = lazy(() => import('./pages/dashboards/DashboardEnfermero'));
const Patients = lazy(() => import('./pages/Patients'));
const PatientDetail = lazy(() => import('./pages/PatientDetail'));
const Appointments = lazy(() => import('./pages/Appointments'));
const Inventory = lazy(() => import('./pages/Inventory'));
const Sales = lazy(() => import('./pages/Sales'));
const Invoices = lazy(() => import('./pages/Invoices'));
const InvoicingConfig = lazy(() => import('./pages/InvoicingConfig'));
const Users = lazy(() => import('./pages/Users'));
const Clinics = lazy(() => import('./pages/Clinics'));
const Treatments = lazy(() => import('./pages/Treatments'));
const Referrals = lazy(() => import('./pages/Referrals'));
const Quotations = lazy(() => import('./pages/Quotations'));
const Marketing = lazy(() => import('./pages/Marketing'));
const Chats = lazy(() => import('./pages/Chats'));
const OpportunitiesGlobal = lazy(() => import('./pages/OpportunitiesGlobal'));
const Analytics = lazy(() => import('./pages/Analytics'));
const MessageTemplates = lazy(() => import('./pages/MessageTemplates'));
const WhatsappSpend = lazy(() => import('./pages/WhatsappSpend'));
const SavedReplies = lazy(() => import('./pages/SavedReplies'));
const Contacts = lazy(() => import('./pages/Contacts'));
const Segments = lazy(() => import('./pages/Segments'));
const Campaigns = lazy(() => import('./pages/Campaigns'));
const Workflows = lazy(() => import('./pages/Workflows'));
const WorkflowEditor = lazy(() => import('./pages/WorkflowEditor'));
const RecycleBin = lazy(() => import('./pages/RecycleBin'));
const Attribution = lazy(() => import('./pages/Attribution'));
const Reputation = lazy(() => import('./pages/Reputation'));
const Tasks = lazy(() => import('./pages/Tasks'));
const PublicBooking = lazy(() => import('./pages/PublicBooking'));
const BookingConfig = lazy(() => import('./pages/BookingConfig'));
const CallCenterConfig = lazy(() => import('./pages/CallCenterConfig'));
const CommissionRules = lazy(() => import('./pages/CommissionRules'));
const Settings = lazy(() => import('./pages/Settings'));
const Reports = lazy(() => import('./pages/Reports'));
const Discounts = lazy(() => import('./pages/Discounts'));
const Rooms = lazy(() => import('./pages/Rooms'));
const Blocks = lazy(() => import('./pages/Blocks'));
const AccessBlocks = lazy(() => import('./pages/AccessBlocks'));
const ChartOfAccounts = lazy(() => import('./pages/accounting/ChartOfAccounts'));
const DataImport = lazy(() => import('./pages/accounting/DataImport'));
const CostCenters = lazy(() => import('./pages/accounting/CostCenters'));
const FiscalPeriods = lazy(() => import('./pages/accounting/FiscalPeriods'));
const JournalEntries = lazy(() => import('./pages/accounting/JournalEntries'));
const Ledger = lazy(() => import('./pages/accounting/Ledger'));
const TrialBalance = lazy(() => import('./pages/accounting/TrialBalance'));
const BankAccounts = lazy(() => import('./pages/accounting/BankAccounts'));
const BankMovements = lazy(() => import('./pages/accounting/BankMovements'));
const CashDeposits = lazy(() => import('./pages/accounting/CashDeposits'));
const CashBox = lazy(() => import('./pages/accounting/CashBox'));
const Reconciliations = lazy(() => import('./pages/accounting/Reconciliations'));
const Suppliers = lazy(() => import('./pages/accounting/Suppliers'));
const Payments = lazy(() => import('./pages/accounting/Payments'));
const PurchaseInvoices = lazy(() => import('./pages/accounting/PurchaseInvoices'));
const RetentionRules = lazy(() => import('./pages/accounting/RetentionRules'));
const CreditDebitNotes = lazy(() => import('./pages/accounting/CreditDebitNotes'));
const Warehouses = lazy(() => import('./pages/accounting/Warehouses'));
const InventoryCategories = lazy(() => import('./pages/accounting/InventoryCategories'));
const ConsolidatedInventory = lazy(() => import('./pages/accounting/ConsolidatedInventory'));
const PhysicalCounts = lazy(() => import('./pages/accounting/PhysicalCounts'));
const FixedAssets = lazy(() => import('./pages/accounting/FixedAssets'));
const FinancialReports = lazy(() => import('./pages/accounting/FinancialReports'));
const ManagementReports = lazy(() => import('./pages/accounting/ManagementReports'));
const SriReports = lazy(() => import('./pages/accounting/SriReports'));
const SriDeclarations = lazy(() => import('./pages/accounting/SriDeclarations'));
const SriAnnexes = lazy(() => import('./pages/accounting/SriAnnexes'));
const Employees = lazy(() => import('./pages/accounting/Employees'));
const EmployeeLoans = lazy(() => import('./pages/accounting/EmployeeLoans'));
const Deductions = lazy(() => import('./pages/accounting/Deductions'));
const Payroll = lazy(() => import('./pages/accounting/Payroll'));
const CreditCardBatches = lazy(() => import('./pages/accounting/CreditCardBatches'));
const AuditLogs = lazy(() => import('./pages/accounting/AuditLogs'));
const AccountingDashboard = lazy(() => import('./pages/accounting/AccountingDashboard'));
const Kardex = lazy(() => import('./pages/accounting/Kardex'));
const CashFlow = lazy(() => import('./pages/accounting/CashFlow'));
const PayrollConfig = lazy(() => import('./pages/accounting/PayrollConfig'));
const Decimos = lazy(() => import('./pages/accounting/Decimos'));
const Checks = lazy(() => import('./pages/accounting/Checks'));
const CreditCards = lazy(() => import('./pages/accounting/CreditCards'));
const CardSettlements = lazy(() => import('./pages/accounting/CardSettlements'));
const SalesReports = lazy(() => import('./pages/accounting/SalesReports'));
const CashClosing = lazy(() => import('./pages/accounting/CashClosing'));
const AccountMapping = lazy(() => import('./pages/accounting/AccountMapping'));
const PeriodBalances = lazy(() => import('./pages/accounting/PeriodBalances'));
const Budgets = lazy(() => import('./pages/accounting/Budgets'));
const Receivables = lazy(() => import('./pages/accounting/Receivables'));
const DeferredIncome = lazy(() => import('./pages/accounting/DeferredIncome'));
const RetentionVouchers = lazy(() => import('./pages/accounting/RetentionVouchers'));
const AccountingHealth = lazy(() => import('./pages/accounting/AccountingHealth'));
const Profitability = lazy(() => import('./pages/accounting/Profitability'));

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
    case 'doctor': return <DashboardDoctor />;
    case 'ginecologia': return <DashboardDoctor />;
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
                    vez de desmontarse y volver a montarse en cada salto. */}
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
