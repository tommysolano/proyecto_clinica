import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import shiluvLogo from '../Shiluv-logo-4.png';
import {
  HiOutlineHome,
  HiOutlineUsers,
  HiOutlineCalendar,
  HiOutlineCube,
  HiOutlineShoppingCart,
  HiOutlineDocumentText,
  HiOutlineArrowRightOnRectangle,
  HiOutlineBars3,
  HiOutlineXMark,
  HiOutlineUserCircle,
  HiOutlineBuildingOffice2,
  HiOutlineUserGroup,
  HiOutlineCog6Tooth,
  HiOutlineSparkles,
  HiOutlineMegaphone,
  HiOutlineArrowsRightLeft,
  HiOutlineHeart,
  HiOutlineDocumentDuplicate,
  HiOutlineTag,
  HiOutlineNoSymbol,
  HiOutlineBuildingStorefront,
  HiOutlineCalculator,
  HiOutlineBookOpen,
  HiOutlineBanknotes,
  HiOutlineScale,
  HiOutlineDocumentChartBar,
  HiOutlineChartBar,
  HiOutlineDocumentArrowDown,
  HiOutlineShieldCheck,
  HiOutlineCreditCard,
  HiOutlineTruck,
  HiOutlineCurrencyDollar,
  HiOutlineDocumentMinus,
  HiOutlineClipboardDocumentCheck,
  HiOutlineBuildingLibrary,
  HiOutlineSquares2X2,
  HiOutlineChevronDown,
  HiOutlineChevronRight,
} from 'react-icons/hi2';

// Cada item declara qué roles pueden verlo. superOnly = solo isSuperAdmin.
const ALL_ITEMS = [
  { path: '/', label: 'Dashboard', icon: HiOutlineHome, roles: ['admin', 'cajero', 'contabilidad', 'doctor', 'call_center', 'marketing', 'enfermero'] },
  { path: '/patients', label: 'Pacientes', icon: HiOutlineUsers, roles: ['admin', 'cajero', 'doctor', 'call_center', 'marketing', 'enfermero'] },
  { path: '/appointments', label: 'Citas', icon: HiOutlineCalendar, roles: ['admin', 'cajero', 'doctor', 'call_center', 'enfermero', 'marketing'] },
  { path: '/calendar', label: 'Calendario', icon: HiOutlineCalendar, roles: ['admin', 'cajero', 'doctor', 'call_center', 'enfermero'] },
  { path: '/treatments', label: 'Tratamientos', icon: HiOutlineHeart, roles: ['admin', 'doctor', 'cajero', 'marketing', 'enfermero'] },
  { path: '/referrals', label: 'Derivaciones', icon: HiOutlineArrowsRightLeft, roles: ['admin', 'doctor', 'marketing', 'cajero'] },
  { path: '/quotations', label: 'Cotizaciones', icon: HiOutlineDocumentDuplicate, roles: ['admin', 'cajero', 'call_center', 'contabilidad'] },
  { path: '/inventory', label: 'Inventario', icon: HiOutlineCube, roles: ['admin', 'contabilidad'] },
  { path: '/sales', label: 'Ventas', icon: HiOutlineShoppingCart, roles: ['admin', 'contabilidad'] },
  { path: '/invoices', label: 'Facturación', icon: HiOutlineDocumentText, roles: ['admin', 'cajero', 'contabilidad'] },
  { path: '/marketing', label: 'Marketing', icon: HiOutlineMegaphone, roles: ['admin', 'marketing'] },
  { path: '/discounts', label: 'Descuentos', icon: HiOutlineTag, roles: ['admin', 'cajero', 'contabilidad'] },
  { path: '/rooms', label: 'Consultorios', icon: HiOutlineBuildingStorefront, roles: ['admin'] },
  { path: '/blocks', label: 'Bloqueos', icon: HiOutlineNoSymbol, roles: ['admin'] },
  { path: '/users', label: 'Usuarios', icon: HiOutlineUserGroup, roles: ['admin'] },
  { path: '/invoicing-config', label: 'Config. SRI', icon: HiOutlineCog6Tooth, roles: ['admin', 'contabilidad'] },
  { path: '/clinics', label: 'Consultorios médicos', icon: HiOutlineBuildingOffice2, roles: [], superOnly: true },
];

const ACCOUNTING_ITEMS = [
  { path: '/accounting/chart', label: 'Plan de Cuentas', icon: HiOutlineBookOpen },
  { path: '/accounting/cost-centers', label: 'Centros de Costo', icon: HiOutlineSquares2X2 },
  { path: '/accounting/periods', label: 'Períodos Fiscales', icon: HiOutlineCalendar },
  { path: '/accounting/journal', label: 'Asientos', icon: HiOutlineDocumentText },
  { path: '/accounting/ledger', label: 'Libro Mayor', icon: HiOutlineBookOpen },
  { path: '/accounting/trial-balance', label: 'Balance Comprobación', icon: HiOutlineScale },
  { path: '/accounting/banks', label: 'Bancos', icon: HiOutlineBanknotes },
  { path: '/accounting/reconciliations', label: 'Conciliaciones', icon: HiOutlineScale },
  { path: '/accounting/suppliers', label: 'Proveedores', icon: HiOutlineTruck },
  { path: '/accounting/purchases', label: 'Compras', icon: HiOutlineDocumentText },
  { path: '/accounting/credit-debit-notes', label: 'NC / ND', icon: HiOutlineDocumentMinus },
  { path: '/accounting/payments', label: 'Pagos/Cobros', icon: HiOutlineCurrencyDollar },
  { path: '/accounting/credit-card-batches', label: 'Lotes Tarjetas', icon: HiOutlineCreditCard },
  { path: '/accounting/warehouses', label: 'Bodegas', icon: HiOutlineCube },
  { path: '/accounting/inv-categories', label: 'Categorías Inv.', icon: HiOutlineSquares2X2 },
  { path: '/accounting/counts', label: 'Tomas Físicas', icon: HiOutlineClipboardDocumentCheck },
  { path: '/accounting/assets', label: 'Activos Fijos', icon: HiOutlineBuildingLibrary },
  { path: '/accounting/employees', label: 'Empleados', icon: HiOutlineUserGroup },
  { path: '/accounting/loans', label: 'Préstamos', icon: HiOutlineBanknotes },
  { path: '/accounting/payroll', label: 'Nómina', icon: HiOutlineCalculator },
  { path: '/accounting/financial-reports', label: 'Rep. Financieros', icon: HiOutlineDocumentChartBar },
  { path: '/accounting/management-reports', label: 'Rep. Gerenciales', icon: HiOutlineChartBar },
  { path: '/accounting/sri-reports', label: 'Rep. SRI', icon: HiOutlineDocumentArrowDown },
  { path: '/accounting/audit-logs', label: 'Auditoría', icon: HiOutlineShieldCheck },
];

export default function Layout({ children }) {
  const { user, role, activeClinic, clinics, selectClinic, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [accountingOpen, setAccountingOpen] = useState(false);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const handleClinicChange = async (e) => {
    const id = e.target.value;
    if (!id || (activeClinic && id === activeClinic._id)) return;
    try {
      await selectClinic(id);
      navigate('/');
    } catch {
      // ignore
    }
  };

  const menuItems = ALL_ITEMS.filter((item) => {
    if (item.superOnly) return user?.isSuperAdmin;
    return user?.isSuperAdmin || (role && item.roles.includes(role));
  });

  const showAccounting = user?.isSuperAdmin || role === 'admin' || role === 'contabilidad';

  return (
    <div className="flex h-screen overflow-hidden bg-body">
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/40 backdrop-blur-sm z-20 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside
        className={`fixed lg:static inset-y-0 left-0 z-30 w-[270px] bg-gradient-to-b from-emerald-900 via-emerald-900 to-teal-900 text-white transform transition-transform duration-200 ease-in-out ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        } flex flex-col shadow-2xl`}
      >
        <div className="flex items-center justify-between px-6 py-6">
          <Link to="/" className="flex items-center gap-3 no-underline">
            <div className="w-11 h-11 bg-white rounded-xl flex items-center justify-center p-1.5 shadow-md">
              <img src={shiluvLogo} alt="Shiluv" className="w-full h-full object-contain" />
            </div>
            <div>
              <span className="text-white font-bold text-base block leading-tight">
                {activeClinic?.nombreComercial || activeClinic?.name || 'Shiluv'}
              </span>
              <span className="text-emerald-300 text-[11px] font-medium">Sistema Médico</span>
            </div>
          </Link>
          <button
            className="lg:hidden text-white/70 hover:text-white bg-transparent border-none cursor-pointer"
            onClick={() => setSidebarOpen(false)}
          >
            <HiOutlineXMark className="w-6 h-6" />
          </button>
        </div>

        {clinics.length > 1 && (
          <div className="px-4 mb-3">
            <label className="text-[10px] uppercase tracking-wider text-emerald-400/70 font-semibold px-1 block mb-1">
              Consultorio médico activo
            </label>
            <select
              value={activeClinic?._id || ''}
              onChange={handleClinicChange}
              className="w-full bg-white/10 text-white border border-white/20 rounded-lg px-3 py-2 text-sm cursor-pointer"
            >
              {clinics.map((c) => (
                <option key={c._id} value={c._id} className="text-slate-800">
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <nav className="flex-1 px-4 py-2 space-y-1 overflow-y-auto">
          <p className="text-[10px] uppercase tracking-wider text-emerald-400/70 font-semibold px-3 mb-2">
            Menú principal
          </p>
          {menuItems.map((item) => {
            const Icon = item.icon;
            const isActive =
              location.pathname === item.path ||
              (item.path !== '/' && location.pathname.startsWith(item.path));
            return (
              <Link
                key={item.path}
                to={item.path}
                onClick={() => setSidebarOpen(false)}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13px] font-medium no-underline ${
                  isActive
                    ? 'bg-white/15 text-white shadow-lg shadow-black/10'
                    : 'text-emerald-100/70 hover:bg-white/8 hover:text-white'
                }`}
              >
                <div
                  className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                    isActive ? 'bg-emerald-500' : 'bg-white/8'
                  }`}
                >
                  <Icon className="w-[18px] h-[18px]" />
                </div>
                {item.label}
              </Link>
            );
          })}
          {showAccounting && (
            <div className="mt-4">
              <button
                onClick={() => setAccountingOpen((v) => !v)}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13px] font-medium text-emerald-100/70 hover:bg-white/8 hover:text-white bg-transparent border-none cursor-pointer"
              >
                <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-white/8">
                  <HiOutlineCalculator className="w-[18px] h-[18px]" />
                </div>
                <span className="flex-1 text-left">Contabilidad</span>
                {accountingOpen ? <HiOutlineChevronDown className="w-4 h-4" /> : <HiOutlineChevronRight className="w-4 h-4" />}
              </button>
              {accountingOpen && (
                <div className="ml-3 mt-1 space-y-0.5 border-l border-white/10 pl-2">
                  {ACCOUNTING_ITEMS.map((it) => {
                    const Icon = it.icon;
                    const isActive = location.pathname === it.path;
                    return (
                      <Link
                        key={it.path}
                        to={it.path}
                        onClick={() => setSidebarOpen(false)}
                        className={`flex items-center gap-2 px-2 py-1.5 rounded-lg text-[12px] no-underline ${
                          isActive ? 'bg-white/15 text-white' : 'text-emerald-100/60 hover:bg-white/8 hover:text-white'
                        }`}
                      >
                        <Icon className="w-4 h-4 flex-shrink-0" />
                        <span className="truncate">{it.label}</span>
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </nav>

        <div className="px-4 py-4 border-t border-white/10 mx-2">
          <div className="flex items-center gap-3 px-2 py-2">
            <div className="w-9 h-9 rounded-full bg-emerald-500/30 flex items-center justify-center">
              <HiOutlineUserCircle className="w-5 h-5 text-emerald-300" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-white truncate">{user?.name}</p>
              <p className="text-[11px] text-emerald-300/80 capitalize">
                {user?.isSuperAdmin ? 'Super Admin' : (role === 'call_center' ? 'Call Center' : role || '')}
              </p>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="flex items-center gap-3 px-3 py-2 mt-1 w-full rounded-xl text-[13px] font-medium text-emerald-200/60 hover:bg-white/8 hover:text-white cursor-pointer bg-transparent border-none"
          >
            <HiOutlineArrowRightOnRectangle className="w-4 h-4" />
            Cerrar Sesión
          </button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="bg-white/80 backdrop-blur-md border-b border-emerald-100 px-4 lg:px-8 py-4 flex items-center justify-between">
          <button
            className="lg:hidden p-2 rounded-xl hover:bg-emerald-50 bg-transparent border-none cursor-pointer"
            onClick={() => setSidebarOpen(true)}
          >
            <HiOutlineBars3 className="w-6 h-6 text-slate-600" />
          </button>
          <div className="flex-1" />
          <div className="flex items-center gap-4">
            <div className="hidden sm:flex items-center gap-2 bg-emerald-50 px-4 py-2 rounded-xl">
              <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></div>
              <span className="text-sm text-emerald-700 font-medium">
                {new Date().toLocaleDateString('es-EC', {
                  weekday: 'long',
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                })}
              </span>
            </div>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-4 lg:p-8">
          <div className="mx-auto w-full max-w-screen-xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
