import { useEffect, useMemo, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import { HiOutlinePresentationChartLine } from 'react-icons/hi2';

const COLORS = ['#10b981', '#0ea5e9', '#f59e0b', '#a78bfa', '#ef4444', '#6366f1', '#14b8a6'];

const fmtDate = (d) => {
  const dt = new Date(d);
  return `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}`;
};

export default function Analytics() {
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const [start, setStart] = useState(monthAgo);
  const [end, setEnd] = useState(today);
  const [chats, setChats] = useState([]);
  const [appts, setAppts] = useState([]);
  const [oppRows, setOppRows] = useState([]);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [a, c, o] = await Promise.all([
        api.get('/appointments', { params: { startDate: start, endDate: end } }),
        api.get('/chats', { params: {} }).catch(() => ({ data: [] })),
        api.get('/chats/opportunities/all', { params: { from: start, to: end } }).catch(() => ({ data: [] })),
      ]);
      const appsList = Array.isArray(a.data) ? a.data : a.data?.appointments || [];
      setAppts(appsList);
      setChats(Array.isArray(c.data) ? c.data : []);
      setOppRows(o.data || []);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al cargar analíticas');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Agrupar chats por día de creación dentro del rango
  const chatsPerDay = useMemo(() => {
    const map = {};
    const startMs = new Date(start).getTime();
    const endMs = new Date(end + 'T23:59:59').getTime();
    for (const c of chats) {
      const t = new Date(c.createdAt).getTime();
      if (t < startMs || t > endMs) continue;
      const key = new Date(c.createdAt).toISOString().slice(0, 10);
      map[key] = (map[key] || 0) + 1;
    }
    return Object.keys(map)
      .sort()
      .map((k) => ({ date: fmtDate(k), value: map[k] }));
  }, [chats, start, end]);

  // Citas por día (creación) y por estado
  const apptsPerDay = useMemo(() => {
    const map = {};
    for (const a of appts) {
      const key = (a.date || '').slice(0, 10);
      if (!key) continue;
      map[key] = (map[key] || 0) + 1;
    }
    return Object.keys(map)
      .sort()
      .map((k) => ({ date: fmtDate(k), value: map[k] }));
  }, [appts]);

  const apptsByStatus = useMemo(() => {
    const map = {};
    for (const a of appts) {
      const k = a.status || 'pendiente';
      map[k] = (map[k] || 0) + 1;
    }
    return Object.entries(map).map(([name, value]) => ({ name, value }));
  }, [appts]);

  const oppsByStage = useMemo(() => {
    const map = {};
    for (const o of oppRows) {
      const k = o.stage || 'nuevo';
      map[k] = (map[k] || 0) + 1;
    }
    return Object.entries(map).map(([name, value]) => ({ name, value }));
  }, [oppRows]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
          <HiOutlinePresentationChartLine className="text-emerald-600" /> Analíticas
        </h1>
        <div className="flex items-end gap-2">
          <label className="text-sm">Desde
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="block mt-1 border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
          </label>
          <label className="text-sm">Hasta
            <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="block mt-1 border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
          </label>
          <button onClick={load} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 text-sm border-none cursor-pointer hover:bg-emerald-700">
            {loading ? 'Cargando...' : 'Actualizar'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <KPI label="Chats" value={chats.length} color="emerald" />
        <KPI label="Citas en rango" value={appts.length} color="sky" />
        <KPI label="Oportunidades" value={oppRows.length} color="indigo" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="Chats por día">
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={chatsPerDay}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" />
              <YAxis allowDecimals={false} />
              <Tooltip />
              <Bar dataKey="value" fill="#10b981" />
            </BarChart>
          </ResponsiveContainer>
        </Card>

        <Card title="Citas agendadas por día">
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={apptsPerDay}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" />
              <YAxis allowDecimals={false} />
              <Tooltip />
              <Line type="monotone" dataKey="value" stroke="#0ea5e9" strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </Card>

        <Card title="Citas por estado">
          <ResponsiveContainer width="100%" height={260}>
            <PieChart>
              <Pie data={apptsByStatus} dataKey="value" nameKey="name" outerRadius={90} label>
                {apptsByStatus.map((_, i) => (
                  <Cell key={i} fill={COLORS[i % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </Card>

        <Card title="Oportunidades por etapa">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={oppsByStage}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" />
              <YAxis allowDecimals={false} />
              <Tooltip />
              <Bar dataKey="value" fill="#6366f1" />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>
    </div>
  );
}

function KPI({ label, value, color }) {
  return (
    <div className={`bg-${color}-50 border border-${color}-200 rounded-xl p-4`}>
      <p className={`text-xs text-${color}-700 uppercase font-semibold`}>{label}</p>
      <p className={`text-3xl font-bold text-${color}-800`}>{value}</p>
    </div>
  );
}

function Card({ title, children }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-3">
      <p className="text-sm font-semibold text-slate-700 mb-2">{title}</p>
      {children}
    </div>
  );
}
