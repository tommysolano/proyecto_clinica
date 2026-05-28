import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AuthProvider, useAuth } from './context/AuthContext';
import { SocketProvider } from './context/SocketContext';
import PrivateRoute from './components/PrivateRoute';
import RoleRoute from './components/RoleRoute';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Patients from './pages/Patients';
import PatientDetail from './pages/PatientDetail';
import Appointments from './pages/Appointments';
import Inventory from './pages/Inventory';
import Sales from './pages/Sales';
import Invoices from './pages/Invoices';
import InvoicingConfig from './pages/InvoicingConfig';
import Users from './pages/Users';
import Clinics from './pages/Clinics';
import Calendar from './pages/Calendar';
import Treatments from './pages/Treatments';
import Referrals from './pages/Referrals';
import Quotations from './pages/Quotations';
import Marketing from './pages/Marketing';
import Chats from './pages/Chats';
import OpportunitiesGlobal from './pages/OpportunitiesGlobal';
import Analytics from './pages/Analytics';
import AutoMessages from './pages/AutoMessages';
import Commissions from './pages/Commissions';
import CommissionRules from './pages/CommissionRules';
import Settings from './pages/Settings';
import Reports from './pages/Reports';
import Discounts from './pages/Discounts';
import Rooms from './pages/Rooms';
import Blocks from './pages/Blocks';
import ChartOfAccounts from './pages/accounting/ChartOfAccounts';
import CostCenters from './pages/accounting/CostCenters';
import FiscalPeriods from './pages/accounting/FiscalPeriods';
import JournalEntries from './pages/accounting/JournalEntries';
import Ledger from './pages/accounting/Ledger';
import TrialBalance from './pages/accounting/TrialBalance';
import BankAccounts from './pages/accounting/BankAccounts';
import CashBox from './pages/accounting/CashBox';
import Reconciliations from './pages/accounting/Reconciliations';
import Suppliers from './pages/accounting/Suppliers';
import Payments from './pages/accounting/Payments';
import PurchaseInvoices from './pages/accounting/PurchaseInvoices';
import CreditDebitNotes from './pages/accounting/CreditDebitNotes';
import Warehouses from './pages/accounting/Warehouses';
import InventoryCategories from './pages/accounting/InventoryCategories';
import ConsolidatedInventory from './pages/accounting/ConsolidatedInventory';
import PhysicalCounts from './pages/accounting/PhysicalCounts';
import FixedAssets from './pages/accounting/FixedAssets';
import FinancialReports from './pages/accounting/FinancialReports';
import ManagementReports from './pages/accounting/ManagementReports';
import SriReports from './pages/accounting/SriReports';
import Employees from './pages/accounting/Employees';
import EmployeeLoans from './pages/accounting/EmployeeLoans';
import Payroll from './pages/accounting/Payroll';
import CreditCardBatches from './pages/accounting/CreditCardBatches';
import AuditLogs from './pages/accounting/AuditLogs';
import AccountingDashboard from './pages/accounting/AccountingDashboard';
import Kardex from './pages/accounting/Kardex';
import CashFlow from './pages/accounting/CashFlow';
import PayrollConfig from './pages/accounting/PayrollConfig';
import Decimos from './pages/accounting/Decimos';
import Checks from './pages/accounting/Checks';
import CreditCards from './pages/accounting/CreditCards';

function SuperAdminRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user?.isSuperAdmin) return <Navigate to="/" replace />;
  return children;
}

function RootRoute() {
  const { role, user, loading } = useAuth();
  if (loading) return null;
  if (!user?.isSuperAdmin && role === 'contabilidad') {
    return <Navigate to="/accounting/dashboard" replace />;
  }
  return <Dashboard />;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/*"
        element={
          <PrivateRoute>
            <Layout>
              <Routes>
                <Route path="/" element={<RootRoute />} />

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
                    <RoleRoute roles={['admin']}>
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

                <Route
                  path="/calendar"
                  element={
                    <RoleRoute roles={['admin', 'cajero', 'doctor', 'optica', 'call_center', 'enfermero', 'marketing']}>
                      <Calendar />
                    </RoleRoute>
                  }
                />
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
                  path="/auto-messages"
                  element={
                    <RoleRoute roles={['admin', 'call_center', 'marketing']}>
                      <AutoMessages />
                    </RoleRoute>
                  }
                />
                <Route
                  path="/commissions"
                  element={
                    <RoleRoute roles={['admin', 'call_center', 'marketing']}>
                      <Commissions />
                    </RoleRoute>
                  }
                />
                <Route
                  path="/commission-rules"
                  element={
                    <RoleRoute roles={['admin']}>
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
                  ['cost-centers', CostCenters],
                  ['periods', FiscalPeriods],
                  ['journal', JournalEntries],
                  ['ledger', Ledger],
                  ['trial-balance', TrialBalance],
                  ['banks', BankAccounts],
                  ['cash', CashBox],
                  ['reconciliations', Reconciliations],
                  ['suppliers', Suppliers],
                  ['payments', Payments],
                  ['purchases', PurchaseInvoices],
                  ['credit-debit-notes', CreditDebitNotes],
                  ['warehouses', Warehouses],
                  ['inv-categories', InventoryCategories],
                  ['inv-consolidated', ConsolidatedInventory],
                  ['counts', PhysicalCounts],
                  ['assets', FixedAssets],
                  ['financial-reports', FinancialReports],
                  ['management-reports', ManagementReports],
                  ['sri-reports', SriReports],
                  ['employees', Employees],
                  ['loans', EmployeeLoans],
                  ['payroll', Payroll],
                  ['credit-card-batches', CreditCardBatches],
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
            </Layout>
          </PrivateRoute>
        }
      />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <SocketProvider>
          <Toaster position="top-right" toastOptions={{ duration: 3000 }} />
          <AppRoutes />
        </SocketProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
