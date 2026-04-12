import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
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
  HiOutlineHeart,
} from 'react-icons/hi2';

const menuItems = [
  { path: '/', label: 'Dashboard', icon: HiOutlineHome },
  { path: '/patients', label: 'Pacientes', icon: HiOutlineUsers },
  { path: '/appointments', label: 'Citas', icon: HiOutlineCalendar },
  { path: '/inventory', label: 'Inventario', icon: HiOutlineCube },
  { path: '/sales', label: 'Ventas', icon: HiOutlineShoppingCart },
  { path: '/invoicing', label: 'Facturación', icon: HiOutlineDocumentText },
];

export default function Layout({ children }) {
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <div className="flex h-screen overflow-hidden bg-body">
      {/* Overlay mobile */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/40 backdrop-blur-sm z-20 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed lg:static inset-y-0 left-0 z-30 w-[270px] bg-gradient-to-b from-emerald-900 via-emerald-900 to-teal-900 text-white transform transition-transform duration-200 ease-in-out ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        } flex flex-col shadow-2xl`}
      >
        {/* Logo */}
        <div className="flex items-center justify-between px-6 py-6">
          <Link to="/" className="flex items-center gap-3 no-underline">
            <div className="w-10 h-10 bg-white/15 backdrop-blur rounded-xl flex items-center justify-center">
              <HiOutlineHeart className="w-5 h-5 text-emerald-300" />
            </div>
            <div>
              <span className="text-white font-bold text-base block leading-tight">Clínica</span>
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

        {/* Nav */}
        <nav className="flex-1 px-4 py-2 space-y-1 overflow-y-auto">
          <p className="text-[10px] uppercase tracking-wider text-emerald-400/70 font-semibold px-3 mb-2">
            Menú principal
          </p>
          {menuItems.map((item) => {
            const Icon = item.icon;
            const isActive = location.pathname === item.path ||
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
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                  isActive ? 'bg-emerald-500' : 'bg-white/8'
                }`}>
                  <Icon className="w-[18px] h-[18px]" />
                </div>
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* User */}
        <div className="px-4 py-4 border-t border-white/10 mx-2">
          <div className="flex items-center gap-3 px-2 py-2">
            <div className="w-9 h-9 rounded-full bg-emerald-500/30 flex items-center justify-center">
              <HiOutlineUserCircle className="w-5 h-5 text-emerald-300" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-white truncate">{user?.name}</p>
              <p className="text-[11px] text-emerald-300/80 capitalize">{user?.role}</p>
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

      {/* Main */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar */}
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

        {/* Content */}
        <main className="flex-1 overflow-y-auto p-4 lg:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
