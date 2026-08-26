import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { roleSatisfies, ROLE_LABELS } from '../utils/roles';
import NotificationBell from './NotificationBell';
import shiluvLogo from '../Shiluv-logo-4.png';
import {
  HiOutlineHome,
  HiOutlineUsers,
  HiOutlineCalendarDays,
  HiOutlineHeart,
  HiOutlineShoppingCart,
  HiOutlineCube,
  HiOutlineTruck,
  HiOutlineCurrencyDollar,
  HiOutlineBanknotes,
  HiOutlineBuildingLibrary,
  HiOutlineCreditCard,
  HiOutlineUserGroup,
  HiOutlineCalculator,
  HiOutlineFire,
  HiOutlineDocumentChartBar,
  HiOutlineDocumentText,
  HiOutlineCog6Tooth,
  HiOutlineUserCircle,
  HiOutlineArrowRightOnRectangle,
  HiOutlineBars3,
  HiOutlineXMark,
  HiOutlineChevronDown,
  HiOutlineChevronRight,
  HiOutlineMagnifyingGlass,
} from 'react-icons/hi2';

// Menú unificado por grupos. Cada ítem declara qué roles pueden verlo
// (superOnly = solo isSuperAdmin). Un grupo se muestra si el rol ve al menos
// uno de sus ítems. El super-admin ve todo.
const ALL_ROLES = ['admin', 'cajero', 'contabilidad', 'doctor', 'ginecologia', 'podologia', 'odontologia', 'cosmetologia', 'optica', 'call_center', 'marketing', 'enfermero'];

const MENU_GROUPS = [
  {
    key: 'herramientas', label: 'Herramientas', icon: HiOutlineDocumentText, items: [
      // El escáner de documentos está disponible para TODOS los roles.
      { path: '/scanner', label: 'Escáner de documentos', roles: ALL_ROLES },
    ],
  },
  {
    key: 'personas', label: 'Personas', icon: HiOutlineUsers, items: [
      { path: '/patients', label: 'Clientes', roles: ['admin', 'cajero', 'call_center', 'marketing', 'enfermero'] },
      { path: '/accounting/suppliers', label: 'Proveedores', roles: ['admin', 'contabilidad'] },
    ],
  },
  {
    key: 'agenda', label: 'Agenda', icon: HiOutlineCalendarDays, items: [
      { path: '/appointments', label: 'Calendario y Citas', roles: ['admin', 'cajero', 'doctor', 'optica', 'call_center', 'enfermero', 'marketing'] },
      { path: '/tasks', label: 'Tareas', roles: ['admin', 'call_center', 'marketing'] },
    ],
  },
  {
    key: 'clinica', label: 'Clínica', icon: HiOutlineHeart, items: [
      { path: '/treatments', label: 'Tratamientos', roles: ['admin', 'cajero', 'marketing', 'enfermero'] },
      { path: '/referrals', label: 'Derivaciones', roles: ['admin', 'marketing', 'cajero'] },
    ],
  },
  {
    key: 'comercial', label: 'Comercial', icon: HiOutlineShoppingCart, items: [
      { path: '/quotations', label: 'Cotizaciones', roles: ['admin', 'cajero', 'call_center', 'contabilidad', 'marketing'] },
      { path: '/sales', label: 'Ventas', roles: ['admin', 'cajero', 'contabilidad'] },
      { path: '/invoices', label: 'Facturación', roles: ['admin', 'cajero', 'contabilidad'] },
      { path: '/discounts', label: 'Descuentos', roles: ['admin', 'cajero', 'contabilidad'] },
      { path: '/commission-rules', label: 'Reglas de Comisión', roles: ['admin', 'contabilidad'] },
      { path: '/accounting/credit-debit-notes', label: 'NC / ND Clientes', roles: ['admin', 'contabilidad'] },
    ],
  },
  {
    key: 'inventario', label: 'Inventario', icon: HiOutlineCube, items: [
      { path: '/inventory', label: 'Productos', roles: ['admin', 'contabilidad'] },
      { path: '/accounting/inv-categories', label: 'Categorías', roles: ['admin', 'contabilidad'] },
      { path: '/accounting/warehouses', label: 'Bodegas', roles: ['admin', 'contabilidad'] },
      { path: '/accounting/kardex', label: 'Kardex', roles: ['admin', 'contabilidad'] },
      { path: '/accounting/inv-consolidated', label: 'Inv. Consolidado', roles: ['admin', 'contabilidad'] },
      { path: '/accounting/counts', label: 'Tomas Físicas', roles: ['admin', 'contabilidad'] },
      { path: '/accounting/assets', label: 'Activos Fijos', roles: ['admin', 'contabilidad'] },
    ],
  },
  {
    key: 'compras', label: 'Compras', icon: HiOutlineTruck, items: [
      { path: '/accounting/purchases', label: 'Compras', roles: ['admin', 'contabilidad'] },
      { path: '/accounting/credit-debit-notes', label: 'NC / ND Proveedores', roles: ['admin', 'contabilidad'] },
    ],
  },
  {
    // CxC y CxP se unifican por ahora en la página Cartera existente; cuando
    // se construyan las páginas hijas (cobros, vencimientos, anticipos, etc.)
    // se separan en dos grupos.
    key: 'cartera', label: 'CxC / CxP', icon: HiOutlineCurrencyDollar, items: [
      { path: '/accounting/cartera', label: 'Cartera (Clientes/Proveedores)', roles: ['admin', 'contabilidad'] },
    ],
  },
  {
    key: 'tesoreria', label: 'Tesorería', icon: HiOutlineBanknotes, items: [
      { path: '/cash-register', label: 'Caja (Apertura/Cierre)', roles: ['admin', 'contabilidad', 'cajero'] },
      { path: '/accounting/cash', label: 'Movimientos de Caja', roles: ['admin', 'contabilidad'] },
    ],
  },
  {
    key: 'bancos', label: 'Bancos', icon: HiOutlineBuildingLibrary, items: [
      { path: '/accounting/banks', label: 'Cuentas Bancarias', roles: ['admin', 'contabilidad'] },
      { path: '/accounting/bank-movements', label: 'Movimientos', roles: ['admin', 'contabilidad'] },
      { path: '/accounting/cash-deposits', label: 'Depósitos', roles: ['admin', 'contabilidad'] },
      { path: '/accounting/reconciliations', label: 'Conciliaciones', roles: ['admin', 'contabilidad'] },
      { path: '/accounting/checks', label: 'Cheques', roles: ['admin', 'contabilidad'] },
      { path: '/accounting/payments', label: 'Pagos / Cobros', roles: ['admin', 'contabilidad'] },
    ],
  },
  {
    key: 'tarjetas', label: 'Tarjetas de Crédito', icon: HiOutlineCreditCard, items: [
      { path: '/accounting/cards', label: 'Tarjetas / POS', roles: ['admin', 'contabilidad'] },
      { path: '/accounting/credit-card-batches', label: 'Lotes', roles: ['admin', 'contabilidad'] },
      { path: '/accounting/card-settlements', label: 'Liquidaciones', roles: ['admin', 'contabilidad'] },
    ],
  },
  {
    key: 'rrhh', label: 'Recursos Humanos', icon: HiOutlineUserGroup, items: [
      { path: '/accounting/employees', label: 'Empleados', roles: ['admin', 'contabilidad'] },
      { path: '/accounting/payroll', label: 'Nómina', roles: ['admin', 'contabilidad'] },
      { path: '/accounting/loans', label: 'Préstamos y descuentos', roles: ['admin', 'contabilidad'] },
      { path: '/accounting/deductions', label: 'Deducciones / Consumo', roles: ['admin', 'contabilidad'] },
      { path: '/accounting/decimos', label: 'Plantillas Décimos', roles: ['admin', 'contabilidad'] },
      { path: '/accounting/payroll-config', label: 'Configuración', roles: ['admin', 'contabilidad'] },
    ],
  },
  {
    key: 'contabilidad', label: 'Contabilidad', icon: HiOutlineCalculator, items: [
      { path: '/accounting/chart', label: 'Plan de Cuentas', roles: ['admin', 'contabilidad'] },
      { path: '/accounting/data-import', label: 'Importar Datos', roles: ['admin', 'contabilidad'] },
      { path: '/accounting/account-mapping', label: 'Config. Cuentas', roles: ['admin', 'contabilidad'] },
      { path: '/accounting/retention-rules', label: 'Config. Retenciones', roles: ['admin', 'contabilidad'] },
      { path: '/accounting/cost-centers', label: 'Centros de Costo', roles: ['admin', 'contabilidad'] },
      { path: '/accounting/periods', label: 'Períodos Fiscales', roles: ['admin', 'contabilidad'] },
      { path: '/accounting/journal', label: 'Asientos', roles: ['admin', 'contabilidad'] },
      { path: '/accounting/ledger', label: 'Consultas Mayor', roles: ['admin', 'contabilidad'] },
      { path: '/accounting/trial-balance', label: 'Balance Comprobación', roles: ['admin', 'contabilidad'] },
      { path: '/accounting/period-balances', label: 'Saldos por Período', roles: ['admin', 'contabilidad'] },
      { path: '/accounting/deferred-income', label: 'Ingresos Diferidos', roles: ['admin', 'contabilidad'] },
      { path: '/accounting/retention-vouchers', label: 'Retenciones', roles: ['admin', 'contabilidad'] },
      { path: '/accounting/budgets', label: 'Presupuesto', roles: ['admin', 'contabilidad'] },
      { path: '/accounting/cash-flow', label: 'Flujo de Caja', roles: ['admin', 'contabilidad'] },
      { path: '/accounting/accounting-health', label: 'Salud Contable', roles: ['admin', 'contabilidad'] },
    ],
  },
  {
    // `alias`: el módulo se llama Fénix, pero el equipo lleva años buscándolo
    // por "marketing" o "crm" — el buscador del menú sigue encontrándolo así.
    key: 'marketing', label: 'Fénix', alias: 'marketing crm', icon: HiOutlineFire, items: [
      { path: '/marketing', label: 'Marketing', roles: ['admin', 'marketing'] },
      { path: '/chats', label: 'Chats / WhatsApp', roles: ['admin', 'call_center', 'marketing'] },
      { path: '/contacts', label: 'Contactos', roles: ['admin', 'call_center', 'marketing'] },
      { path: '/opportunities', label: 'Oportunidades', roles: ['admin', 'call_center', 'marketing'] },
      { path: '/campaigns', label: 'Campañas', roles: ['admin', 'marketing'] },
      { path: '/segments', label: 'Segmentos', roles: ['admin', 'marketing'] },
      { path: '/message-templates', label: 'Plantillas de Mensaje', roles: ['admin', 'marketing'] },
      { path: '/whatsapp-spend', label: 'Gasto de WhatsApp', roles: ['admin', 'marketing'] },
      { path: '/saved-replies', label: 'Mensajes Guardados', roles: ['admin', 'call_center', 'marketing'] },
      { path: '/workflows', label: 'Automatizaciones', roles: ['admin', 'marketing', 'call_center'] },
      { path: '/recycle-bin', label: 'Papelera de reciclaje', roles: ['admin', 'marketing'] },
      { path: '/attribution', label: 'Atribución / ROI', roles: ['admin', 'marketing'] },
      { path: '/reputation', label: 'Reputación', roles: ['admin', 'marketing'] },
      { path: '/booking-config', label: 'Auto-agendamiento', roles: ['admin', 'marketing'] },
      { path: '/analytics', label: 'Analíticas', roles: ['admin', 'marketing'] },
      { path: '/call-center-config', label: 'Config. Call Center', roles: ['admin', 'marketing'] },
      { path: '/reports', label: 'Reportes de Atención', roles: ['admin', 'marketing'] },
    ],
  },
  {
    key: 'reporteria', label: 'Reportería', icon: HiOutlineDocumentChartBar, items: [
      { path: '/accounting/sales-reports', label: 'Rep. Ventas', roles: ['admin', 'contabilidad'] },
      { path: '/accounting/financial-reports', label: 'Rep. Financieros', roles: ['admin', 'contabilidad'] },
      { path: '/accounting/management-reports', label: 'Rep. Gerenciales', roles: ['admin', 'contabilidad'] },
      { path: '/accounting/sri-reports', label: 'Rep. SRI', roles: ['admin', 'contabilidad'] },
      { path: '/accounting/sri-declarations', label: 'Declaraciones SRI', roles: ['admin', 'contabilidad'] },
      { path: '/accounting/sri-annexes', label: 'Anexos SRI (RDEP / Accionistas)', roles: ['admin', 'contabilidad'] },
      { path: '/accounting/profitability', label: 'Rentabilidad x Médico', roles: ['admin', 'contabilidad'] },
      { path: '/accounting/audit-logs', label: 'Auditoría', roles: ['admin', 'contabilidad'] },
    ],
  },
  {
    key: 'configuracion', label: 'Configuración', icon: HiOutlineCog6Tooth, items: [
      { path: '/invoicing-config', label: 'Config. SRI', roles: ['admin', 'contabilidad'] },
      { path: '/users', label: 'Usuarios', roles: ['admin'] },
      { path: '/rooms', label: 'Consultorios', roles: ['admin'] },
      { path: '/blocks', label: 'Bloqueos', roles: ['admin'] },
      { path: '/access-blocks', label: 'Bloqueo de Acceso', roles: [], superOnly: true },
      { path: '/clinics', label: 'Sucursales', roles: [], superOnly: true },
    ],
  },
];

const isPathActive = (pathname, path) =>
  pathname === path || (path !== '/' && pathname.startsWith(path));

// Normaliza para buscar sin acentos ni mayúsculas.
const norm = (s) => (s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();

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
  const [query, setQuery] = useState('');

  // Al navegar desde el buscador: cierra el overlay móvil y limpia la búsqueda.
  const handleNavigate = () => {
    setSidebarOpen(false);
    setQuery('');
  };

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

  // ¿El usuario puede ver este ítem del menú?
  const canSee = (item) => {
    if (item.superOnly) return !!user?.isSuperAdmin;
    if (user?.isSuperAdmin) return true;
    if (!role) return false;
    return roleSatisfies(role, item.roles);
  };

  // Grupos visibles con sus ítems filtrados por rol.
  const visibleGroups = MENU_GROUPS
    .map((g) => ({ ...g, items: g.items.filter(canSee) }))
    .filter((g) => g.items.length > 0);

  // Lista plana de todas las opciones visibles (incluye Dashboard y Mi Cuenta)
  // para el buscador del menú.
  const searchItems = [
    { path: '/', label: 'Dashboard', group: 'Inicio', roles: ALL_ROLES },
    ...MENU_GROUPS.flatMap((g) =>
      g.items.map((it) => ({ path: it.path, label: it.label, group: g.label, alias: g.alias || '', roles: it.roles, superOnly: it.superOnly }))
    ),
    { path: '/settings', label: 'Configuración de Cuenta', group: 'Mi Cuenta', roles: ALL_ROLES },
  ].filter(canSee);
  const nq = norm(query);
  const searchResults = nq
    ? searchItems.filter((it) =>
        norm(it.label).includes(nq) || norm(it.group).includes(nq) || norm(it.alias).includes(nq))
    : [];

  // Título de la página actual (derivado de la ruta) para mostrarlo en el header.
  const TITLE_MAP = [
    ...MENU_GROUPS.flatMap((g) => g.items.map((it) => ({ path: it.path, label: it.label }))),
    { path: '/settings', label: 'Configuración de Cuenta' },
  ];
  const matchedTitle = TITLE_MAP
    .filter((p) => p.path !== '/' && location.pathname.startsWith(p.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
  const pageTitle = location.pathname === '/' ? 'Inicio' : (matchedTitle?.label || 'Vikingo');
  // La página de chats gestiona su propio alto/scroll interno: se le da todo el
  // espacio (padding mínimo) para no desperdiciar la parte superior.
  const isChatsPage = location.pathname.startsWith('/chats');

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
              <img src={shiluvLogo} alt="Vikingo" className="w-full h-full object-contain" />
            </div>
            {/* El nombre del SISTEMA manda (Vikingo); debajo, en pequeño, la
                sucursal activa — que sigue siendo lo que cambia al alternar de
                clínica y por eso no puede desaparecer de aquí. */}
            <div className="min-w-0">
              <span className="text-white font-bold text-base block leading-tight">Vikingo</span>
              <span className="text-emerald-300 text-[11px] font-medium block truncate">
                {activeClinic?.nombreComercial || activeClinic?.name || 'Sistema Médico'}
              </span>
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
          {/* Buscador del menú */}
          <div className="relative mb-3">
            <HiOutlineMagnifyingGlass className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar opción..."
              className="w-full bg-white/10 text-white placeholder-slate-400 border border-white/15 rounded-xl pl-9 pr-8 py-2 text-[13px] focus:outline-none focus:border-emerald-400/60"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                title="Limpiar"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white bg-transparent border-none cursor-pointer p-1"
              >
                <HiOutlineXMark className="w-4 h-4" />
              </button>
            )}
          </div>

          {query ? (
            /* Resultados de búsqueda */
            <div className="space-y-0.5">
              {searchResults.length === 0 ? (
                <p className="text-[12px] text-slate-500 px-3 py-3">Sin resultados para “{query}”.</p>
              ) : (
                searchResults.map((it) => (
                  <Link
                    key={`${it.group}-${it.path}-${it.label}`}
                    to={it.path}
                    onClick={handleNavigate}
                    className={`flex flex-col px-3 py-2 rounded-lg no-underline ${
                      isPathActive(location.pathname, it.path)
                        ? 'bg-emerald-500/15 text-white'
                        : 'text-slate-300 hover:bg-white/10 hover:text-white'
                    }`}
                  >
                    <span className="text-[13px] font-medium">{it.label}</span>
                    <span className="text-[10px] text-slate-500">{it.group}</span>
                  </Link>
                ))
              )}
            </div>
          ) : (
          <>
          <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold px-3 mb-2">
            Menú principal
          </p>

          {/* Dashboard: botón único, contenido según el rol */}
          <Link
            to="/"
            onClick={() => setSidebarOpen(false)}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13px] font-medium no-underline ${
              location.pathname === '/'
                ? 'bg-emerald-500/15 text-white shadow-lg shadow-black/10'
                : 'text-slate-300 hover:bg-white/10 hover:text-white'
            }`}
          >
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${location.pathname === '/' ? 'bg-emerald-500' : 'bg-white/5'}`}>
              <HiOutlineHome className="w-[18px] h-[18px]" />
            </div>
            Dashboard
          </Link>

          {visibleGroups.map((group) => {
            const GroupIcon = group.icon;
            const groupActive = group.items.some((it) => isPathActive(location.pathname, it.path));
            const isOpen = group.key in openGroups ? openGroups[group.key] : groupActive;
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
                          key={`${group.key}-${it.path}`}
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
                <HiOutlineUserCircle className="w-[18px] h-[18px]" />
              </div>
              Configuración de Cuenta
            </Link>
          </div>
          </>
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
                {user?.isSuperAdmin ? 'Super Admin' : (ROLE_LABELS[role] || role || '')}
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
                {activeClinic?.nombreComercial || activeClinic?.name || 'Vikingo'}
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
            {/* Bandeja de notificaciones: entre la fecha y la inicial del usuario. */}
            <NotificationBell />
            <div className="w-9 h-9 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-white text-sm font-bold shadow-sm" title={user?.name}>
              {(user?.name || '?').trim().charAt(0).toUpperCase()}
            </div>
          </div>
        </header>

        {/* El chat usa TODO el alto y ancho, con padding mínimo: el espacio que
            antes se desperdiciaba en la parte superior ahora es conversación. El
            resto de páginas conserva el padding cómodo y el scroll vertical. */}
        <main
          className={
            isChatsPage
              ? 'flex-1 min-h-0 overflow-hidden p-2 lg:p-3'
              : 'flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8'
          }
        >
          <div
            key={location.pathname}
            className={`page-enter mx-auto w-full ${
              isChatsPage ? 'max-w-none h-full' : 'max-w-screen-xl'
            }`}
          >
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
