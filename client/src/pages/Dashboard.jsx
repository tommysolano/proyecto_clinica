import { useEffect, useState, useCallback } from 'react';
import api from '../api/axios';
import { useAuth } from '../context/AuthContext';
import { useSocketEvent } from '../context/SocketContext';
import {
  HiOutlineUsers,
  HiOutlineCalendar,
  HiOutlineCurrencyDollar,
  HiOutlineExclamationTriangle,
} from 'react-icons/hi2';

export default function Dashboard() {
  const { user, hasRole } = useAuth();
  const showSales = hasRole('admin', 'cajero', 'contabilidad');
  const showStock = hasRole('admin', 'contabilidad', 'cajero');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    api.get('/dashboard')
      .then(res => setData(res.data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    reload();
    setLoading(false);
  }, [reload]);

  useSocketEvent('appointment:created', reload, [reload]);
  useSocketEvent('appointment:updated', reload, [reload]);
  useSocketEvent('sale:created', reload, [reload]);
  useSocketEvent('patient:created', reload, [reload]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-600"></div>
      </div>
    );
  }

  const stats = [
    {
      label: 'Citas Hoy',
      value: data?.todayAppointments?.length || 0,
      icon: HiOutlineCalendar,
      color: 'bg-gradient-to-br from-emerald-500 to-teal-500',
      bgLight: 'bg-emerald-50',
    },
    {
      label: 'Total Pacientes',
      value: data?.totalPatients || 0,
      icon: HiOutlineUsers,
      color: 'bg-gradient-to-br from-teal-500 to-cyan-500',
      bgLight: 'bg-teal-50',
    },
    showSales && {
      label: 'Ventas del Mes',
      value: `$${(data?.monthSales?.total || 0).toFixed(2)}`,
      icon: HiOutlineCurrencyDollar,
      color: 'bg-gradient-to-br from-cyan-500 to-blue-500',
      bgLight: 'bg-cyan-50',
    },
    showStock && {
      label: 'Stock Bajo',
      value: data?.lowStockProducts?.length || 0,
      icon: HiOutlineExclamationTriangle,
      color: 'bg-gradient-to-br from-amber-400 to-orange-500',
      bgLight: 'bg-amber-50',
    },
  ].filter(Boolean);

  const statusColors = {
    pendiente: 'bg-blue-100 text-blue-700',
    completada: 'bg-emerald-100 text-emerald-700',
  };

  const statusLabels = {
    pendiente: 'Pendiente',
    completada: 'Completada',
  };

  const normalizeStatus = (s) => (s === 'completada' ? 'completada' : 'pendiente');

  return (
    <div>
      <div className="mb-8">
        <h1 className="page-title text-2xl sm:text-3xl">
          Hola, {user?.name} 👋
        </h1>
        <p className="page-subtitle">Resumen general de Shiluv</p>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-5 mb-8">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <div key={stat.label} className="card card-hover relative overflow-hidden p-5">
              <div className={`${stat.color} pointer-events-none absolute -right-6 -top-6 w-24 h-24 rounded-full opacity-10`} />
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[13px] text-slate-500 font-medium">{stat.label}</p>
                  <p className="text-2xl sm:text-3xl font-bold text-slate-800 mt-1 tracking-tight">{stat.value}</p>
                </div>
                <div className={`${stat.color} p-3 rounded-2xl shadow-lg shadow-emerald-200/40`}>
                  <Icon className="w-6 h-6 text-white" />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Citas de hoy */}
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100">
          <div className="px-6 py-4 border-b border-emerald-100">
            <h2 className="text-lg font-semibold text-slate-800">Citas de Hoy</h2>
          </div>
          <div className="p-6">
            {data?.todayAppointments?.length === 0 ? (
              <p className="text-slate-500 text-sm text-center py-8">No hay citas programadas para hoy</p>
            ) : (
              <div className="space-y-3">
                {data?.todayAppointments?.map((apt) => (
                  <div key={apt._id} className="flex items-center gap-4 p-3 rounded-xl bg-emerald-50/50">
                    <div className="text-center min-w-[60px]">
                      <p className="text-sm font-semibold text-emerald-700">{apt.startTime}</p>
                      <p className="text-xs text-slate-400">{apt.endTime}</p>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-800 truncate">
                        {apt.patient?.firstName} {apt.patient?.lastName}
                      </p>
                      <p className="text-xs text-slate-500">
                        Dr. {apt.doctor?.name}
                      </p>
                    </div>
                    <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${statusColors[normalizeStatus(apt.status)]}`}>
                      {statusLabels[normalizeStatus(apt.status)]}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Stock bajo */}
        {showStock && (
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100">
          <div className="px-6 py-4 border-b border-emerald-100">
            <h2 className="text-lg font-semibold text-slate-800">Productos con Stock Bajo</h2>
          </div>
          <div className="p-6">
            {data?.lowStockProducts?.length === 0 ? (
              <p className="text-slate-500 text-sm text-center py-8">Todos los productos tienen stock suficiente</p>
            ) : (
              <div className="space-y-3">
                {data?.lowStockProducts?.map((product) => (
                  <div key={product._id} className="flex items-center justify-between p-3 rounded-xl bg-emerald-50/50">
                    <div>
                      <p className="text-sm font-medium text-slate-800">{product.name}</p>
                      <p className="text-xs text-slate-500">Código: {product.code}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-bold text-red-500">{product.stock}</p>
                      <p className="text-xs text-slate-400">Min: {product.minStock}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        )}
      </div>
    </div>
  );
}
