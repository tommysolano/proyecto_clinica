import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import {
  HiOutlineCurrencyDollar,
  HiOutlineUserGroup,
  HiOutlineTrophy,
  HiOutlineCalendarDays,
  HiOutlineArrowPath,
} from 'react-icons/hi2';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line } from 'recharts';
import api from '../api/axios';
import { useAuth } from '../context/AuthContext';

const RANGES = [
  { value: 'today', label: 'Hoy' },
  { value: 'week', label: 'Semana' },
  { value: 'month', label: 'Mes' },
  { value: 'quarter', label: 'Trimestre' },
  { value: 'year', label: 'Año' },
];

export default function Commissions() {
  const { role, user } = useAuth();
  const isAgent = role === 'call_center' && !user?.isSuperAdmin;
  const isSupervisor = role === 'supervisor_call_center' || role === 'admin' || user?.isSuperAdmin;

  const [range, setRange] = useState('month');
  const [agent, setAgent] = useState('');
  const [agents, setAgents] = useState([]);
  const [data, setData] = useState(null);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const params = { range };
      if (agent) params.agent = agent;
      const [c, s] = await Promise.all([
        api.get('/call-center/commissions', { params }),
        api.get('/call-center/summary', { params }),
      ]);
      setData(c.data);
      setSummary(s.data);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al cargar comisiones');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isSupervisor) {
      api.get('/call-center/agents').then((r) => setAgents(r.data || [])).catch(() => {});
    }
  }, [isSupervisor]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, agent]);

  const totalCommissions = data?.total || 0;
  const myRow = data?.byAgent?.find((a) => String(a._id) === String(user?._id));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
            <HiOutlineTrophy className="text-emerald-600" /> Comisiones del call center
          </h1>
          <p className="text-xs text-slate-500">
            Cada comisión equivale a un paciente <strong>nuevo</strong> que <strong>asistió</strong>{' '}
            a una cita creada por el agente. Se cuenta en unidades, no en dinero.
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <select
            value={range}
            onChange={(e) => setRange(e.target.value)}
            className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm"
          >
            {RANGES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
          {isSupervisor && (
            <select
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
              className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm"
            >
              <option value="">Todos los agentes</option>
              {agents.map((a) => (
                <option key={a._id} value={a._id}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
          <button
            onClick={load}
            className="p-1.5 border border-slate-200 rounded-lg hover:bg-slate-50"
            title="Recargar"
          >
            <HiOutlineArrowPath className="w-4 h-4" />
          </button>
        </div>
      </div>

      {loading ? (
        <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-400">
          Cargando...
        </div>
      ) : (
        <>
          {/* KPIs */}
          <div className="grid sm:grid-cols-4 gap-3">
            <KPICard
              label={isAgent ? 'Mis comisiones' : 'Comisiones totales'}
              value={isAgent ? myRow?.commissions || 0 : totalCommissions}
              icon={HiOutlineTrophy}
              color="emerald"
              suffix=" pac."
            />
            <KPICard
              label={isAgent ? 'Pacientes únicos' : 'Pacientes nuevos atendidos'}
              value={isAgent ? myRow?.uniquePatients || 0 : data?.byAgent?.reduce((a, x) => a + x.uniquePatients, 0) || 0}
              icon={HiOutlineUserGroup}
              color="sky"
            />
            <KPICard
              label="Citas creadas (período)"
              value={summary?.agents?.reduce((a, x) => a + x.totalCreated, 0) || 0}
              icon={HiOutlineCalendarDays}
              color="indigo"
            />
            <KPICard
              label="Tasa asistencia 1ras citas"
              value={(() => {
                const first = summary?.agents?.reduce((a, x) => a + x.firstVisit, 0) || 0;
                const firstAtt = summary?.agents?.reduce((a, x) => a + x.firstAttended, 0) || 0;
                if (!first) return '—';
                return `${Math.round((firstAtt / first) * 100)}%`;
              })()}
              icon={HiOutlineTrophy}
              color="amber"
            />
          </div>

          {/* Gráfico evolución */}
          {data?.timeline?.length > 0 && (
            <section className="bg-white rounded-xl border border-slate-200 p-4">
              <h2 className="font-semibold text-slate-800 mb-2">Evolución de comisiones</h2>
              <div style={{ height: 240 }}>
                <ResponsiveContainer>
                  <LineChart data={data.timeline}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="_id" fontSize={11} />
                    <YAxis allowDecimals={false} fontSize={11} />
                    <Tooltip />
                    <Line type="monotone" dataKey="commissions" stroke="#059669" strokeWidth={2} dot={{ r: 3 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </section>
          )}

          {/* Ranking por agente (supervisor/admin) */}
          {isSupervisor && (
            <section className="bg-white rounded-xl border border-slate-200 p-4">
              <h2 className="font-semibold text-slate-800 mb-2">Ranking por agente</h2>
              {data?.byAgent?.length > 0 ? (
                <>
                  <div style={{ height: Math.max(200, data.byAgent.length * 40) }}>
                    <ResponsiveContainer>
                      <BarChart data={data.byAgent} layout="vertical" margin={{ left: 20 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                        <XAxis type="number" allowDecimals={false} fontSize={11} />
                        <YAxis type="category" dataKey="name" fontSize={11} width={140} />
                        <Tooltip />
                        <Bar dataKey="commissions" fill="#10b981" name="Comisiones" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="overflow-x-auto mt-3">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 text-slate-600">
                        <tr>
                          <th className="text-left px-3 py-2">#</th>
                          <th className="text-left px-3 py-2">Agente</th>
                          <th className="text-right px-3 py-2">Comisiones</th>
                          <th className="text-right px-3 py-2">Pacientes únicos</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.byAgent.map((a, i) => (
                          <tr key={a._id} className="border-t border-slate-100">
                            <td className="px-3 py-2 text-slate-400">#{i + 1}</td>
                            <td className="px-3 py-2 font-medium">{a.name}</td>
                            <td className="px-3 py-2 text-right text-emerald-700 font-bold">{a.commissions}</td>
                            <td className="px-3 py-2 text-right">{a.uniquePatients}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <div className="text-sm text-slate-400 py-4 text-center">Sin comisiones en el período</div>
              )}
            </section>
          )}

          {/* Detalle de pacientes que generaron comisión */}
          <section className="bg-white rounded-xl border border-slate-200 p-4">
            <h2 className="font-semibold text-slate-800 mb-2">
              Detalle ({data?.details?.length || 0} citas)
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="text-left px-3 py-2">Fecha</th>
                    <th className="text-left px-3 py-2">Paciente</th>
                    {isSupervisor && <th className="text-left px-3 py-2">Agente</th>}
                    <th className="text-left px-3 py-2">Servicios</th>
                    <th className="text-right px-3 py-2">Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.details || []).map((d) => (
                    <tr key={d._id} className="border-t border-slate-100">
                      <td className="px-3 py-2 text-slate-600 text-xs">
                        {d.date ? new Date(d.date).toLocaleDateString() : ''} {d.startTime}
                      </td>
                      <td className="px-3 py-2">
                        <div className="font-medium">
                          {d.patient?.firstName} {d.patient?.lastName}
                        </div>
                        <div className="text-[11px] text-slate-400">{d.patient?.cedula}</div>
                      </td>
                      {isSupervisor && (
                        <td className="px-3 py-2 text-xs text-slate-600">{d.createdBy?.name}</td>
                      )}
                      <td className="px-3 py-2 text-xs">
                        {(d.services || []).map((s) => s.name).join(', ') || '—'}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <span className="text-[11px] px-2 py-0.5 bg-emerald-100 text-emerald-700 rounded-full">
                          {d.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {(!data?.details || data.details.length === 0) && (
                    <tr>
                      <td colSpan={isSupervisor ? 5 : 4} className="px-3 py-8 text-center text-slate-400 text-sm">
                        Sin comisiones en este período
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function KPICard({ label, value, icon: Icon, color, suffix = '' }) {
  const colors = {
    emerald: 'bg-emerald-50 text-emerald-700',
    sky: 'bg-sky-50 text-sky-700',
    indigo: 'bg-indigo-50 text-indigo-700',
    amber: 'bg-amber-50 text-amber-700',
  };
  return (
    <div className={`rounded-xl p-4 ${colors[color] || colors.emerald}`}>
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs">{label}</div>
          <div className="text-2xl font-bold">
            {value}
            {suffix}
          </div>
        </div>
        {Icon && <Icon className="w-8 h-8 opacity-30" />}
      </div>
    </div>
  );
}
