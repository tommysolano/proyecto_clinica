import { useEffect, useState } from 'react';
import api from '../api/axios';
import { useAuth } from '../context/AuthContext';
import {
  HiOutlineUsers,
  HiOutlineCalendar,
  HiOutlineCurrencyDollar,
  HiOutlineExclamationTriangle,
} from 'react-icons/hi2';

export default function Dashboard() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/dashboard')
      .then(res => setData(res.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

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
    {
      label: 'Ventas del Mes',
      value: `$${(data?.monthSales?.total || 0).toFixed(2)}`,
      icon: HiOutlineCurrencyDollar,
      color: 'bg-gradient-to-br from-cyan-500 to-blue-500',
      bgLight: 'bg-cyan-50',
    },
    {
      label: 'Stock Bajo',
      value: data?.lowStockProducts?.length || 0,
      icon: HiOutlineExclamationTriangle,
      color: 'bg-gradient-to-br from-amber-400 to-orange-500',
      bgLight: 'bg-amber-50',
    },
  ];

  const statusColors = {
    programada: 'bg-blue-100 text-blue-700',
    confirmada: 'bg-emerald-100 text-emerald-700',
    en_curso: 'bg-amber-100 text-amber-700',
    completada: 'bg-slate-100 text-slate-700',
    cancelada: 'bg-red-100 text-red-700',
    no_asistio: 'bg-orange-100 text-orange-700',
  };

  const statusLabels = {
    programada: 'Programada',
    confirmada: 'Confirmada',
    en_curso: 'En curso',
    completada: 'Completada',
    cancelada: 'Cancelada',
    no_asistio: 'No asistió',
  };

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-800">
          Hola, {user?.name} 👋
        </h1>
        <p className="text-sm text-slate-500 mt-1">Resumen general de tu clínica</p>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 mb-8">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <div key={stat.label} className="bg-white rounded-2xl p-5 shadow-sm border border-emerald-100 hover:shadow-md hover:shadow-emerald-100/50 transition-shadow">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[13px] text-slate-500 font-medium">{stat.label}</p>
                  <p className="text-2xl font-bold text-slate-800 mt-1">{stat.value}</p>
                </div>
                <div className={`${stat.color} p-3 rounded-xl shadow-lg shadow-emerald-200/30`}>
                  <Icon className="w-6 h-6 text-white" />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Citas de hoy */}
        <div className="bg-white rounded-2xl shadow-sm border border-emerald-100">
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
                    <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${statusColors[apt.status]}`}>
                      {statusLabels[apt.status]}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Stock bajo */}
        <div className="bg-white rounded-2xl shadow-sm border border-emerald-100">
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
      </div>
    </div>
  );
}
