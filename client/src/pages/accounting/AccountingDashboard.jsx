import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  Tooltip, ResponsiveContainer, XAxis, YAxis, Legend, CartesianGrid,
} from 'recharts';
import { HiOutlineChartPie, HiOutlineArrowTrendingUp, HiOutlineArrowTrendingDown, HiOutlineBanknotes, HiOutlineExclamationTriangle } from 'react-icons/hi2';
import { fmt } from './_utils';

const PIE_COLORS = ['#10b981', '#0ea5e9', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#64748b'];

export default function AccountingDashboard() {
  const [data, setData] = useState(null);
  const [bankBalances, setBankBalances] = useState([]);
  const [granularity, setGranularity] = useState('month');
  const [showLowStock, setShowLowStock] = useState(false);

  const load = async () => {
    try { const r = await api.get('/dashboard/accounting', { params: { granularity, periods: 12 } }); setData(r.data); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [granularity]);
  useEffect(() => { api.get('/banks/balances').then((r) => setBankBalances(r.data || [])).catch(() => {}); }, []);

  if (!data) return <div className="p-8 text-slate-400">Cargando dashboard...</div>;

  const Card = ({ title, value, sub, color = 'text-slate-800', icon: Icon }) => (
    <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-4">
      <div className="flex items-center justify-between"><p className="text-xs text-slate-500">{title}</p>{Icon && <Icon className="w-5 h-5 text-emerald-500" />}</div>
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
      {sub && <p className="text-xs text-slate-400 mt-1">{sub}</p>}
    </div>
  );

  const Trend = ({ pct }) => (
    <span className={`inline-flex items-center gap-0.5 text-xs font-semibold ${pct >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
      {pct >= 0 ? <HiOutlineArrowTrendingUp className="w-3 h-3" /> : <HiOutlineArrowTrendingDown className="w-3 h-3" />}{Math.abs(pct).toFixed(1)}%
    </span>
  );

  // Combinar series ventas/gastos por período para gráfico comparativo
  const periodMap = {};
  (data.salesSeries || []).forEach((s) => { periodMap[s._id] = { period: s._id, ventas: s.total, gastos: 0 }; });
  (data.expenseSeries || []).forEach((e) => { periodMap[e._id] = { ...(periodMap[e._id] || { period: e._id, ventas: 0 }), gastos: e.total }; });
  const combined = Object.values(periodMap).sort((a, b) => a.period.localeCompare(b.period));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineChartPie className="text-emerald-600" /> Dashboard Contable</h1>
        <label className="text-xs text-slate-500 flex flex-col">Período
          <select value={granularity} onChange={(e) => setGranularity(e.target.value)} className="px-3 py-2 border border-slate-200 rounded-lg bg-white">
            <option value="day">Diario</option><option value="week">Semanal</option><option value="month">Mensual</option><option value="quarter">Trimestral</option><option value="year">Anual</option>
          </select>
        </label>
      </div>

      {/* Indicadores */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card title="Ventas del mes" value={`$${fmt(data.ratios.monthRevenue)}`} sub={<>vs mes ant. <Trend pct={data.comparison.month.pct} /></>} icon={HiOutlineArrowTrendingUp} />
        <Card title="Gastos del mes" value={`$${fmt(data.ratios.monthExpense)}`} color="text-rose-600" icon={HiOutlineArrowTrendingDown} />
        <Card title="Utilidad del mes" value={`$${fmt(data.ratios.profit)}`} color={data.ratios.profit >= 0 ? 'text-emerald-700' : 'text-rose-600'} sub={`Margen ${data.ratios.margin}%`} />
        <Card title="Proyección próx. período" value={`$${fmt(data.ratios.projectionNextPeriod)}`} sub="Promedio últimos períodos" />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card title="Ventas del año" value={`$${fmt(data.comparison.year.current)}`} sub={<>vs año ant. <Trend pct={data.comparison.year.pct} /></>} />
        <Card title="Saldo total en bancos" value={`$${fmt(data.cash.bankTotal)}`} icon={HiOutlineBanknotes} />
        <Card title="Ventas efectivo hoy" value={`$${fmt(data.cash.todayCashSales)}`} />
        <Card title="Cuentas por pagar" value={`$${fmt(data.ratios.accountsPayable)}`} color="text-amber-600" />
      </div>

      {/* Saldo por banco (no general) */}
      {bankBalances.length > 0 && (
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-4">
          <h2 className="font-semibold text-slate-700 mb-3 flex items-center gap-2"><HiOutlineBanknotes className="w-5 h-5 text-emerald-500" /> Saldo por banco</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {bankBalances.map((b) => (
              <div key={b._id} className="border border-slate-100 rounded-lg p-3">
                <p className="text-sm font-medium text-slate-700 truncate">{b.name}</p>
                <p className="text-xs text-slate-400">{b.bank} {b.accountNumber ? `· ${b.accountNumber}` : ''}</p>
                <p className={`text-xl font-bold mt-1 ${b.bookBalance >= 0 ? 'text-emerald-700' : 'text-rose-600'}`}>${fmt(b.bookBalance)}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Stock bajo - clicable */}
      {(data.lowStock || []).length > 0 && (
        <button onClick={() => setShowLowStock(true)} className="w-full bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-center justify-between hover:bg-amber-100 text-left">
          <div className="flex items-center gap-3"><HiOutlineExclamationTriangle className="w-6 h-6 text-amber-600" /><div><p className="font-semibold text-amber-800">{data.lowStock.length} productos con stock bajo</p><p className="text-xs text-amber-600">Clic para ver el detalle</p></div></div>
          <span className="text-amber-700 text-sm font-semibold">Ver resumen →</span>
        </button>
      )}

      {/* Ventas vs Gastos */}
      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-4">
        <h2 className="font-semibold text-slate-700 mb-2">Ventas vs Gastos por período</h2>
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={combined}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis dataKey="period" fontSize={11} /><YAxis fontSize={11} />
            <Tooltip formatter={(v) => `$${fmt(v)}`} /><Legend />
            <Line type="monotone" dataKey="ventas" stroke="#10b981" strokeWidth={2} />
            <Line type="monotone" dataKey="gastos" stroke="#ef4444" strokeWidth={2} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {/* Más vendido - barras */}
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-4">
          <h2 className="font-semibold text-slate-700 mb-2">Lo que más se vende (mes)</h2>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={data.topSold || []} layout="vertical" margin={{ left: 20 }}>
              <XAxis type="number" fontSize={11} /><YAxis type="category" dataKey="_id" width={120} fontSize={10} />
              <Tooltip formatter={(v) => `$${fmt(v)}`} /><Bar dataKey="revenue" fill="#10b981" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        {/* Más gastado - pie */}
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-4">
          <h2 className="font-semibold text-slate-700 mb-2">En lo que más se gasta (mes)</h2>
          <ResponsiveContainer width="100%" height={280}>
            <PieChart>
              <Pie data={data.topSpent || []} dataKey="total" nameKey="_id" cx="50%" cy="50%" outerRadius={100} label={(e) => `$${fmt(e.total)}`}>
                {(data.topSpent || []).map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
              </Pie>
              <Tooltip formatter={(v) => `$${fmt(v)}`} /><Legend />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      <Modal isOpen={showLowStock} onClose={() => setShowLowStock(false)} title="Productos con stock bajo" size="lg">
        <div className="max-h-96 overflow-y-auto">
          <table className="tbl">
            <thead className="bg-slate-50 sticky top-0"><tr><th className="px-3 py-2 text-left">Código</th><th className="px-3 py-2 text-left">Producto</th><th className="px-3 py-2 text-right">Stock</th><th className="px-3 py-2 text-right">Mínimo</th></tr></thead>
            <tbody>
              {(data.lowStock || []).map((p) => (
                <tr key={p._id} className="border-t"><td className="px-3 py-2 font-mono text-xs">{p.code}</td><td className="px-3 py-2">{p.name}</td><td className={`px-3 py-2 text-right font-mono ${p.stock === 0 ? 'text-rose-600 font-bold' : 'text-amber-600'}`}>{p.stock}</td><td className="px-3 py-2 text-right font-mono text-slate-400">{p.minStock}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </Modal>
    </div>
  );
}
