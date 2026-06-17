import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import shiluvLogo from '../Shiluv-logo-4.png';
import {
  HiOutlineHome,
  HiOutlineUsers,
  HiOutlineFunnel,
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
  HiOutlineChatBubbleLeftRight,
  HiOutlineTrophy,
  HiOutlineBolt,
} from 'react-icons/hi2';

// Cada item declara qué roles pueden verlo. superOnly = solo isSuperAdmin.
const ALL_ITEMS = [
  { path: '/', label: 'Dashboard', icon: HiOutlineHome, roles: ['admin', 'cajero', 'contabilidad', 'doctor', 'optica', 'call_center', 'marketing', 'enfermero'] },
  { path: '/patients', label: 'Pacientes', icon: HiOutlineUsers, roles: ['admin', 'cajero', 'marketing', 'enfermero', 'call_center'] },
  { path: '/appointments', label: 'Citas y Calendario', icon: HiOutlineCalendar, roles: ['admin', 'cajero', 'doctor', 'optica', 'call_center', 'enfermero', 'marketing'] },
  { path: '/treatments', label: 'Tratamientos', icon: HiOutlineHeart, roles: ['admin', 'cajero', 'marketing', 'enfermero'] },
  { path: '/referrals', label: 'Derivaciones', icon: HiOutlineArrowsRightLeft, roles: ['admin', 'marketing', 'cajero'] },
  { path: '/quotations', label: 'Cotizaciones', icon: HiOutlineDocumentDuplicate, roles: ['admin', 'cajero', 'call_center', 'contabilidad', 'marketing'] },
  { path: '/chats', label: 'Chats / WhatsApp', icon: HiOutlineChatBubbleLeftRight, roles: ['admin', 'call_center', 'marketing'] },
  { path: '/opportunities', label: 'Oportunidades', icon: HiOutlineMegaphone, roles: ['admin', 'call_center', 'marketing'] },
  { path: '/auto-messages', label: 'Mensajes automáticos', icon: HiOutlineBolt, roles: ['admin', 'call_center', 'marketing'] },
  { path: '/message-templates', label: 'Plantillas de mensaje', icon: HiOutlineDocumentText, roles: ['admin', 'marketing'] },
  { path: '/segments', label: 'Segmentos', icon: HiOutlineFunnel, roles: ['admin', 'marketing'] },
  { path: '/campaigns', label: 'Campañas', icon: HiOutlineMegaphone, roles: ['admin', 'marketing'] },
  { path: '/call-center-config', label: 'Configuración Call Center', icon: HiOutlineCog6Tooth, roles: ['admin', 'marketing'] },
  { path: '/analytics', label: 'Analíticas', icon: HiOutlineChartBar, roles: ['admin', 'marketing'] },
  { path: '/commission-rules', label: 'Reglas de Comisión', icon: HiOutlineTrophy, roles: ['admin', 'contabilidad'] },
  { path: '/inventory', label: 'Inventario', icon: HiOutlineCube, roles: ['admin', 'contabilidad'] },
  { path: '/sales', label: 'Ventas', icon: HiOutlineShoppingCart, roles: ['admin', 'contabilidad', 'cajero'] },
  { path: '/cash-register', label: 'Caja (Apertura/Cierre)', icon: HiOutlineCalculator, roles: ['admin', 'cajero', 'contabilidad'] },
  { path: '/invoices', label: 'Facturación', icon: HiOutlineDocumentText, roles: ['admin', 'cajero', 'contabilidad'] },
  { path: '/marketing', label: 'Marketing', icon: HiOutlineMegaphone, roles: ['admin', 'marketing'] },
  { path: '/reports', label: 'Reportes de atención', icon: HiOutlineChartBar, roles: ['admin', 'marketing'] },
  { path: '/discounts', label: 'Descuentos', icon: HiOutlineTag, roles: ['admin', 'cajero', 'contabilidad'] },
  { path: '/rooms', label: 'Consultorios', icon: HiOutlineBuildingStorefront, roles: ['admin'] },
  { path: '/blocks', label: 'Bloqueos', icon: HiOutlineNoSymbol, roles: ['admin'] },
  { path: '/users', label: 'Usuarios', icon: HiOutlineUserGroup, roles: ['admin'] },
  { path: '/invoicing-config', label: 'Config. SRI', icon: HiOutlineCog6Tooth, roles: ['admin', 'contabilidad'] },
  { path: '/clinics', label: 'Sucursales', icon: HiOutlineBuildingOffice2, roles: [], superOnly: true },
  { path: '/settings', label: 'Configuración', icon: HiOutlineCog6Tooth, roles: ['admin', 'cajero', 'contabilidad', 'doctor', 'optica', 'call_center', 'marketing', 'enfermero'] },
];

// Menú contable agrupado (visible para admin/contabilidad).
const ACCT_GROUPS = [
  {
    key: 'ventas', label: 'Ventas', icon: HiOutlineShoppingCart, items: [
      { path: '/sales', label: 'Ventas' },
      { path: '/quotations', label: 'Cotizaciones' },
      { path: '/invoices', label: 'Facturación' },
      { path: '/discounts', label: 'Descuentos' },
    ],
  },
  {
    key: 'inventario', label: 'Inventario', icon: HiOutlineCube, items: [
      { path: '/inventory', label: 'Productos' },
      { path: '/accounting/warehouses', label: 'Bodegas' },
      { path: '/accounting/inv-categories', label: 'Categorías Inv.' },
      { path: '/accounting/inv-consolidated', label: 'Inv. Consolidado' },
      { path: '/accounting/counts', label: 'Tomas Físicas' },
      { path: '/accounting/assets', label: 'Activos Fijos' },
      { path: '/accounting/kardex', label: 'Kardex' },
    ],
  },
  {
    key: 'bancos', label: 'Bancos', icon: HiOutlineBanknotes, items: [
      { path: '/accounting/banks', label: 'Cuentas Bancarias' },
      { path: '/accounting/cash', label: 'Caja' },
      { path: '/accounting/cash-closing', label: 'Cierre de Caja' },
      { path: '/accounting/reconciliations', label: 'Conciliaciones' },
      { path: '/accounting/bank-import', label: 'Importar Estado Cta.' },
      { path: '/accounting/checks', label: 'Cheques' },
      { path: '/accounting/payments', label: 'Pagos / Cobros' },
    ],
  },
  {
    key: 'tarjetas', label: 'Tarjetas de Crédito', icon: HiOutlineCreditCard, items: [
      { path: '/accounting/cards', label: 'Tarjetas / POS' },
      { path: '/accounting/credit-card-batches', label: 'Lotes' },
      { path: '/accounting/card-settlements', label: 'Liquidaciones' },
    ],
  },
  {
    key: 'rrhh', label: 'Recursos Humanos', icon: HiOutlineUserGroup, items: [
      { path: '/accounting/employees', label: 'Empleados' },
      { path: '/accounting/payroll', label: 'Nómina' },
      { path: '/accounting/loans', label: 'Préstamos' },
      { path: '/accounting/decimos', label: 'Plantillas Décimos' },
      { path: '/accounting/payroll-config', label: 'Configuración' },
    ],
  },
  {
    key: 'contabilidad', label: 'Contabilidad', icon: HiOutlineCalculator, items: [
      { path: '/accounting/dashboard', label: 'Dashboard Contable' },
      { path: '/accounting/chart', label: 'Plan de Cuentas' },
      { path: '/accounting/account-mapping', label: 'Config. Cuentas' },
      { path: '/accounting/cost-centers', label: 'Centros de Costo' },
      { path: '/accounting/periods', label: 'Períodos Fiscales' },
      { path: '/accounting/journal', label: 'Asientos' },
      { path: '/accounting/ledger', label: 'Consultas Mayor' },
      { path: '/accounting/trial-balance', label: 'Balance Comprobación' },
      { path: '/accounting/period-balances', label: 'Saldos por Período' },
      { path: '/accounting/suppliers', label: 'Personas' },
      { path: '/accounting/cartera', label: 'Cartera (CxC/CxP)' },
      { path: '/accounting/purchases', label: 'Compras' },
      { path: '/accounting/credit-debit-notes', label: 'NC / ND' },
      { path: '/accounting/retention-vouchers', label: 'Retenciones' },
      { path: '/accounting/accounting-health', label: 'Salud Contable' },
    ],
  },
  {
    key: 'reporteria', label: 'Reportería', icon: HiOutlineDocumentChartBar, items: [
      { path: '/accounting/sales-reports', label: 'Rep. Ventas' },
      { path: '/accounting/financial-reports', label: 'Rep. Financieros' },
      { path: '/accounting/management-reports', label: 'Rep. Gerenciales' },
      { path: '/accounting/profitability', label: 'Rentabilidad x Médico' },
      { path: '/accounting/budgets', label: 'Presupuesto' },
      { path: '/accounting/cash-flow', label: 'Flujo de Caja' },
      { path: '/accounting/sri-reports', label: 'Rep. SRI' },
      { path: '/accounting/audit-logs', label: 'Auditoría' },
    ],
  },
];

// Rutas que viven dentro de los grupos contables (se ocultan del menú plano
// para admin/contabilidad y así evitar duplicados).
const GROUPED_PATHS = new Set(ACCT_GROUPS.flatMap((g) => g.items.map((i) => i.path)));

export default function Layout({ children }) {
  const { user, role, activeClinic, clinics, selectClinic, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Colapso de la barra lateral en escritorio. En escritorio la barra divide el
  // espacio con el contenido; al colapsarla, el contenido ocupa todo el ancho.
  const [desktopCollapsed, setDesktopCollapsed] = useState(
    () => localStorage.getItem('sidebarCollapsed') === '1'
  );
  const toggleDesktop = () => {
    setDesktopCollapsed((v) => {
      const next = !v;
      localStorage.setItem('sidebarCollapsed', next ? '1' : '0');
      return next;
    });
  };
  const [openGroups, setOpenGroups] = useState({});
  const toggleGroup = (key) => setOpenGroups((g) => ({ ...g, [key]: !g[key] }));

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

  const showAccounting = user?.isSuperAdmin || role === 'admin' || role === 'contabilidad';

  // Título de la página actual (derivado de la ruta) para mostrarlo en el header.
  const TITLE_MAP = [
    ...ALL_ITEMS.map((i) => ({ path: i.path, label: i.label })),
    ...ACCT_GROUPS.flatMap((g) => g.items.map((it) => ({ path: it.path, label: it.label }))),
  ];
  const matchedTitle = TITLE_MAP
    .filter((p) => p.path !== '/' && location.pathname.startsWith(p.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
  const pageTitle = location.pathname === '/' ? 'Inicio' : (matchedTitle?.label || 'Shiluv');

  const menuItems = ALL_ITEMS.filter((item) => {
    // Para usuarios con menú contable, ocultar los items que ya viven en los grupos
    // y Settings (que aparece en sección separada al final del sidebar).
    if (showAccounting && (GROUPED_PATHS.has(item.path) || item.path === '/settings')) return false;
    if (item.superOnly) return user?.isSuperAdmin;
    if (user?.isSuperAdmin) return true;
    if (!role) return false;
    return item.roles.includes(role);
  });

  return (
    <div className="flex h-screen overflow-hidden bg-body">
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/40 backdrop-blur-sm z-20 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside
        className={`fixed lg:static inset-y-0 left-0 z-30 w-[270px] bg-gradient-to-b from-slate-900 via-slate-900 to-slate-950 border-r border-slate-800/60 text-white transform transition-transform duration-200 ease-in-out ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        } ${desktopCollapsed ? 'lg:hidden' : ''} flex flex-col shadow-2xl`}
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
            <label className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold px-1 block mb-1">
              Sucursal activa
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
          <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold px-3 mb-2">
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
                    ? 'bg-emerald-500/15 text-white shadow-lg shadow-black/10'
                    : 'text-slate-300 hover:bg-white/10 hover:text-white'
                }`}
              >
                <div
                  className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                    isActive ? 'bg-emerald-500' : 'bg-white/5'
                  }`}
                >
                  <Icon className="w-[18px] h-[18px]" />
                </div>
                {item.label}
              </Link>
            );
          })}
          {showAccounting && (
            <div className="mt-4 space-y-1">
              <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold px-3 mb-1">
                Contabilidad
              </p>
              {ACCT_GROUPS.map((group) => {
                const GroupIcon = group.icon;
                const isOpen = !!openGroups[group.key];
                const groupActive = group.items.some((it) => location.pathname === it.path);
                return (
                  <div key={group.key}>
                    <button
                      onClick={() => toggleGroup(group.key)}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13px] font-medium bg-transparent border-none cursor-pointer ${
                        groupActive ? 'text-white' : 'text-slate-300 hover:bg-white/10 hover:text-white'
                      }`}
                    >
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${groupActive ? 'bg-emerald-500' : 'bg-white/5'}`}>
                        <GroupIcon className="w-[18px] h-[18px]" />
                      </div>
                      <span className="flex-1 text-left">{group.label}</span>
                      {isOpen ? <HiOutlineChevronDown className="w-4 h-4" /> : <HiOutlineChevronRight className="w-4 h-4" />}
                    </button>
                    {isOpen && (
                      <div className="ml-3 mt-1 space-y-0.5 border-l border-white/10 pl-2">
                        {group.items.map((it) => {
                          const isActive = location.pathname === it.path;
                          return (
                            <Link
                              key={it.path}
                              to={it.path}
                              onClick={() => setSidebarOpen(false)}
                              className={`flex items-center gap-2 px-2 py-1.5 rounded-lg text-[12px] no-underline ${
                                isActive ? 'bg-emerald-500/15 text-white' : 'text-slate-400 hover:bg-white/10 hover:text-white'
                              }`}
                            >
                              <span className="truncate">{it.label}</span>
                            </Link>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {showAccounting && (
            <div className="mt-4 space-y-1">
              <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold px-3 mb-1">
                Mi Cuenta
              </p>
              <Link
                to="/settings"
                onClick={() => setSidebarOpen(false)}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13px] font-medium no-underline ${
                  location.pathname === '/settings'
                    ? 'bg-emerald-500/15 text-white shadow-lg shadow-black/10'
                    : 'text-slate-300 hover:bg-white/10 hover:text-white'
                }`}
              >
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${location.pathname === '/settings' ? 'bg-emerald-500' : 'bg-white/5'}`}>
                  <HiOutlineCog6Tooth className="w-[18px] h-[18px]" />
                </div>
                Configuración de Cuenta
              </Link>
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
                {user?.isSuperAdmin ? 'Super Admin' : (role === 'call_center' ? 'Call Center' : role === 'optica' ? 'Óptica' : role || '')}
              </p>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="flex items-center gap-3 px-3 py-2 mt-1 w-full rounded-xl text-[13px] font-medium text-emerald-200/60 hover:bg-white/10 hover:text-white cursor-pointer bg-transparent border-none"
          >
            <HiOutlineArrowRightOnRectangle className="w-4 h-4" />
            Cerrar Sesión
          </button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="sticky top-0 z-10 bg-white/85 backdrop-blur-md border-b border-slate-200/70 px-4 lg:px-8 h-16 flex items-center justify-between gap-3 shadow-sm shadow-slate-900/[0.03]">
          <div className="flex items-center gap-3 min-w-0">
            {/* Móvil: abre la barra como overlay */}
            <button
              className="lg:hidden p-2 rounded-xl hover:bg-emerald-50 bg-transparent border-none cursor-pointer"
              onClick={() => setSidebarOpen(true)}
              title="Menú"
            >
              <HiOutlineBars3 className="w-6 h-6 text-slate-600" />
            </button>
            {/* Escritorio: colapsa/expande la barra reclamando el espacio */}
            <button
              className="hidden lg:inline-flex p-2 rounded-xl hover:bg-emerald-50 bg-transparent border-none cursor-pointer text-slate-500 hover:text-emerald-600"
              onClick={toggleDesktop}
              title={desktopCollapsed ? 'Mostrar menú' : 'Ocultar menú'}
            >
              <HiOutlineBars3 className="w-6 h-6" />
            </button>
            <div className="min-w-0">
              <h1 className="text-base sm:text-lg font-bold text-slate-800 tracking-tight truncate leading-tight">{pageTitle}</h1>
              <p className="hidden sm:block text-[11px] text-slate-400 leading-tight">
                {activeClinic?.nombreComercial || activeClinic?.name || 'Shiluv'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden md:flex items-center gap-2 bg-emerald-50 px-3.5 py-2 rounded-xl border border-emerald-100">
              <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></div>
              <span className="text-xs font-medium text-emerald-700 capitalize">
                {new Date().toLocaleDateString('es-EC', { weekday: 'long', day: 'numeric', month: 'long' })}
              </span>
            </div>
            <div className="w-9 h-9 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-white text-sm font-bold shadow-sm" title={user?.name}>
              {(user?.name || '?').trim().charAt(0).toUpperCase()}
            </div>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
          <div key={location.pathname} className="page-enter mx-auto w-full max-w-screen-xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
