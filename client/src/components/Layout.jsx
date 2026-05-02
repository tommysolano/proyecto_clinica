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
} from 'react-icons/hi2';

// Cada item declara qué roles pueden verlo. superOnly = solo isSuperAdmin.
const ALL_ITEMS = [
  { path: '/', label: 'Dashboard', icon: HiOutlineHome, roles: ['admin', 'cajero', 'contabilidad', 'doctor', 'call_center'] },
  { path: '/patients', label: 'Pacientes', icon: HiOutlineUsers, roles: ['admin', 'cajero', 'doctor', 'call_center'] },
  { path: '/appointments', label: 'Citas', icon: HiOutlineCalendar, roles: ['admin', 'cajero', 'doctor', 'call_center'] },
  { path: '/inventory', label: 'Inventario', icon: HiOutlineCube, roles: ['admin', 'contabilidad'] },
  { path: '/sales', label: 'Ventas', icon: HiOutlineShoppingCart, roles: ['admin', 'cajero', 'contabilidad'] },
  { path: '/invoices', label: 'Facturación', icon: HiOutlineDocumentText, roles: ['admin', 'cajero', 'contabilidad'] },
  { path: '/users', label: 'Usuarios', icon: HiOutlineUserGroup, roles: ['admin'] },
  { path: '/invoicing-config', label: 'Config. SRI', icon: HiOutlineCog6Tooth, roles: ['admin', 'contabilidad'] },
  { path: '/clinics', label: 'Clínicas', icon: HiOutlineBuildingOffice2, roles: [], superOnly: true },
];

export default function Layout({ children }) {
  const { user, role, activeClinic, clinics, selectClinic, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);

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
              Clínica activa
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

        <main className="flex-1 overflow-y-auto p-4 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
