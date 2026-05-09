import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AuthProvider, useAuth } from './context/AuthContext';
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
import Discounts from './pages/Discounts';
import Rooms from './pages/Rooms';
import Blocks from './pages/Blocks';

function SuperAdminRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user?.isSuperAdmin) return <Navigate to="/" replace />;
  return children;
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
                <Route path="/" element={<Dashboard />} />

                <Route
                  path="/patients"
                  element={
                    <RoleRoute roles={['admin', 'cajero', 'doctor', 'call_center', 'marketing', 'enfermero']}>
                      <Patients />
                    </RoleRoute>
                  }
                />
                <Route
                  path="/patients/:id"
                  element={
                    <RoleRoute roles={['admin', 'cajero', 'doctor', 'call_center', 'marketing', 'enfermero']}>
                      <PatientDetail />
                    </RoleRoute>
                  }
                />

                <Route
                  path="/appointments"
                  element={
                    <RoleRoute roles={['admin', 'cajero', 'doctor', 'call_center', 'enfermero', 'marketing']}>
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

                <Route
                  path="/calendar"
                  element={
                    <RoleRoute roles={['admin', 'cajero', 'doctor', 'call_center', 'enfermero']}>
                      <Calendar />
                    </RoleRoute>
                  }
                />
                <Route
                  path="/treatments"
                  element={
                    <RoleRoute roles={['admin', 'doctor', 'cajero', 'marketing', 'enfermero']}>
                      <Treatments />
                    </RoleRoute>
                  }
                />
                <Route
                  path="/referrals"
                  element={
                    <RoleRoute roles={['admin', 'doctor', 'marketing', 'cajero']}>
                      <Referrals />
                    </RoleRoute>
                  }
                />
                <Route
                  path="/quotations"
                  element={
                    <RoleRoute roles={['admin', 'cajero', 'call_center', 'contabilidad']}>
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
        <Toaster position="top-right" toastOptions={{ duration: 3000 }} />
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
