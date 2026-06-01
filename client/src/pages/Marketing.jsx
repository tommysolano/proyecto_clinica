import { useEffect, useMemo, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import Modal from '../components/Modal';
import {
  HiOutlineMegaphone,
  HiOutlineSparkles,
  HiOutlineUserPlus,
  HiOutlineExclamationCircle,
  HiOutlineMapPin,
  HiOutlineCalendarDays,
  HiOutlineChartBar,
  HiOutlineGift,
} from 'react-icons/hi2';
import {
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
  BarChart,
  Bar,
  Tooltip,
  ResponsiveContainer,
  XAxis,
  YAxis,
  Legend,
  CartesianGrid,
} from 'recharts';

const SOURCE_LABELS = {
  anuncio: 'Anuncio',
  referido: 'Referido',
  recepcion: 'Recepción',
  organico: 'Orgánico',
};

const SOURCE_COLORS = {
  anuncio: '#0ea5e9',
  referido: '#10b981',
  recepcion: '#f59e0b',
  organico: '#8b5cf6',
};

const STATUS_LABELS = {
  pendiente: 'Pendientes',
  confirmada: 'Confirmadas',
  asistida: 'Asistieron',
  completada: 'Completadas',
  no_asistio: 'No asistieron',
  cancelada: 'Canceladas',
};

const RANGE_OPTIONS = [
  { value: 'today', label: 'Hoy' },
  { value: 'yesterday', label: 'Ayer' },
  { value: 'week', label: 'Última semana' },
  { value: 'month', label: 'Este mes' },
  { value: 'next7days', label: 'Próximos 7 días' },
  { value: 'custom', label: 'Personalizado' },
];

export default function Marketing() {
  const [data, setData] = useState(null);
  const [reminders, setReminders] = useState([]);
  const [predictions, setPredictions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [reminderDays, setReminderDays] = useState(14);
  const [reminderLimit, setReminderLimit] = useState(10);

  // Nuevos datasets
  const [incompleteServices, setIncompleteServices] = useState([]);
  const [services, setServices] = useState([]);
  const [evolutionService, setEvolutionService] = useState('');
  const [evolutionRange, setEvolutionRange] = useState('month');
  const [evolutionCustom, setEvolutionCustom] = useState({ startDate: '', endDate: '' });
  const [evolution, setEvolution] = useState(null);
  const [heatmap, setHeatmap] = useState(null);
  const [heatmapFilter, setHeatmapFilter] = useState({ service: '', program: '' });
  const [programs, setPrograms] = useState([]);
  const [nextWeek, setNextWeek] = useState(null);
  const [breakdown, setBreakdown] = useState(null);
  const [breakdownFilter, setBreakdownFilter] = useState({ service: '', program: '', range: 'month' });
  const [referrers, setReferrers] = useState([]);
  const [programsList, setProgramsList] = useState([]);
  // Servicios no completados: expandir lista de pacientes
  const [expandedService, setExpandedService] = useState(null);
  // Recordatorios ausentes: filtros + selección + envío WhatsApp masivo
  const [reminderFilter, setReminderFilter] = useState({ service: '', program: '' });
  const [selectedReminders, setSelectedReminders] = useState({}); // { treatmentId: true }
  const [waModal, setWaModal] = useState(null); // { recipients, message } | null
  const [waSending, setWaSending] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const reminderParams = { daysSinceLastVisit: reminderDays };
      if (reminderFilter.service) reminderParams.service = reminderFilter.service;
      if (reminderFilter.program) reminderParams.program = reminderFilter.program;
      const [d, r, p, inc, svc, prgList, hm, prog, nw, ref] = await Promise.all([
        api.get('/marketing/dashboard'),
        api.get('/marketing/reminders', { params: reminderParams }),
        api.get('/marketing/predictions').catch(() => ({ data: { predictions: [] } })),
        api.get('/marketing/incomplete-services').catch(() => ({ data: [] })),
        api.get('/products', { params: { category: 'servicio', active: true } }).catch(() => ({ data: [] })),
        api.get('/products', { params: { category: 'programa', active: true } }).catch(() => ({ data: [] })),
        api.get('/marketing/heatmap').catch(() => ({ data: null })),
        api.get('/marketing/programs').catch(() => ({ data: [] })),
        api.get('/marketing/next-week').catch(() => ({ data: null })),
        api.get('/marketing/referrers').catch(() => ({ data: [] })),
      ]);
      setData(d.data);
      setReminders(r.data.reminders || []);
      setPredictions(p.data.predictions || []);
      setIncompleteServices(inc.data || []);
      const svcList = Array.isArray(svc.data) ? svc.data : svc.data?.items || [];
      setServices(svcList);
      const prList = Array.isArray(prgList.data) ? prgList.data : prgList.data?.items || [];
      setProgramsList(prList);
      setHeatmap(hm.data);
      setPrograms(prog.data || []);
      setNextWeek(nw.data);
      setReferrers(ref.data || []);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al cargar marketing');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cargar evolución cuando cambia el servicio o el rango
  useEffect(() => {
    if (!evolutionService) { setEvolution(null); return; }
    const params = { service: evolutionService, range: evolutionRange };
    if (evolutionRange === 'custom') {
      if (!evolutionCustom.startDate || !evolutionCustom.endDate) return;
      params.startDate = evolutionCustom.startDate;
      params.endDate = evolutionCustom.endDate;
    }
    api
      .get('/marketing/service-evolution', { params })
      .then((r) => setEvolution(r.data))
      .catch(() => setEvolution(null));
  }, [evolutionService, evolutionRange, evolutionCustom]);

  // Cargar breakdown
  useEffect(() => {
    const params = { range: breakdownFilter.range };
    if (breakdownFilter.service) params.service = breakdownFilter.service;
    if (breakdownFilter.program) params.program = breakdownFilter.program;
    api
      .get('/marketing/appointments-breakdown', { params })
      .then((r) => setBreakdown(r.data))
      .catch(() => setBreakdown(null));
  }, [breakdownFilter]);

  // Recargar heatmap cuando cambia el filtro de programa/servicio
  useEffect(() => {
    const params = {};
    if (heatmapFilter.service) params.service = heatmapFilter.service;
    if (heatmapFilter.program) params.program = heatmapFilter.program;
    api
      .get('/marketing/heatmap', { params })
      .then((r) => setHeatmap(r.data))
      .catch(() => {});
  }, [heatmapFilter]);

  const tStatus = (data?.treatmentsByStatus || []).reduce((acc, x) => {
    acc[x._id || 'activo'] = x.count;
    return acc;
  }, {});

  const apptTotals = (data?.apptStats || []).reduce((acc, x) => {
    acc[x._id || 'pendiente'] = x.count;
    return acc;
  }, {});

  const sources = (data?.patientSources || []).reduce((acc, x) => {
    acc[x._id || 'organico'] = x.count;
    return acc;
  }, {});
  const totalSources = Object.values(sources).reduce((s, v) => s + v, 0);

  const sourcePieData = useMemo(
    () =>
      Object.keys(SOURCE_LABELS)
        .map((k) => ({ key: k, name: SOURCE_LABELS[k], value: sources[k] || 0 }))
        .filter((x) => x.value > 0),
    [sources]
  );

  // Construye los destinatarios (seleccionados, o todos los que tengan teléfono).
  const buildRecipients = () => {
    const chosen = reminders.filter((r) =>
      Object.keys(selectedReminders).length > 0
        ? selectedReminders[r.treatmentId]
        : r.patient?.phone || r.patient?.whatsapp
    );
    return chosen
      .map((r) => ({
        name: `${r.patient?.firstName || ''} ${r.patient?.lastName || ''}`.trim(),
        phone: r.patient?.phone,
        whatsapp: r.patient?.whatsapp,
      }))
      .filter((r) => r.phone || r.whatsapp);
  };

  const openWhatsappModal = () => {
    const recipients = buildRecipients();
    if (recipients.length === 0) {
      toast.error('No hay pacientes con teléfono/WhatsApp para enviar.');
      return;
    }
    setWaModal({
      recipients,
      message:
        'Hola {{nombre}}, te recordamos que tienes un tratamiento pendiente en la clínica. ¡Te esperamos para continuar! 😊',
    });
  };

  const sendWhatsapp = async () => {
    if (!waModal) return;
    setWaSending(true);
    try {
      const res = await api.post('/marketing/reminders/whatsapp', {
        recipients: waModal.recipients,
        message: waModal.message,
      });
      const { sent = 0, failed = 0 } = res.data || {};
      toast.success(`Enviados: ${sent}${failed ? ` · Fallaron: ${failed}` : ''}`);
      setWaModal(null);
      setSelectedReminders({});
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al enviar WhatsApp');
    } finally {
      setWaSending(false);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
          <HiOutlineMegaphone className="text-emerald-600" /> Marketing
        </h1>
        <p className="text-sm text-slate-500">
          Tablero global de tratamientos, conversiones y campañas.
        </p>
      </div>

      {loading && <div className="text-slate-500">Cargando...</div>}

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Card title="Tratamientos activos" value={tStatus.activo || 0} color="emerald" />
        <Card title="Tratamientos completados" value={tStatus.completado || 0} color="sky" />
        <Card title="Tratamientos abandonados" value={tStatus.abandonado || 0} color="rose" />
        <Card title="Recordatorios pendientes" value={reminders.length} color="amber" />
      </div>

      <section className="grid lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <h2 className="font-semibold text-slate-800 mb-2 flex items-center gap-2">
            <HiOutlineUserPlus className="text-emerald-600" /> ¿Cómo nos conocieron?
          </h2>
          {totalSources === 0 ? (
            <div className="text-sm text-slate-400">Sin datos suficientes</div>
          ) : (
            <div className="flex flex-col md:flex-row items-center gap-4">
              <div className="w-full md:w-1/2" style={{ height: 240 }}>
                <ResponsiveContainer>
                  <PieChart>
                    <Pie
                      data={sourcePieData}
                      dataKey="value"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      outerRadius={80}
                      label={(e) => `${e.name}: ${e.value}`}
                    >
                      {sourcePieData.map((entry) => (
                        <Cell key={entry.key} fill={SOURCE_COLORS[entry.key] || '#94a3b8'} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="flex-1 space-y-1 text-sm">
                {sourcePieData.map((s) => (
                  <div key={s.key} className="flex items-center justify-between">
                    <span className="flex items-center gap-2">
                      <span
                        className="inline-block w-3 h-3 rounded-full"
                        style={{ background: SOURCE_COLORS[s.key] || '#94a3b8' }}
                      />
                      {s.name}
                    </span>
                    <span className="text-slate-500">
                      {s.value} ({Math.round((s.value / totalSources) * 100)}%)
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <h2 className="font-semibold text-slate-800 mb-2 flex items-center gap-2">
            <HiOutlineExclamationCircle className="text-amber-600" /> Servicios no completados
          </h2>
          <p className="text-xs text-slate-500 mb-2">
            Productos / servicios prescritos pero no realizados (tratamientos activos, completados parcialmente o abandonados).
          </p>
          <div className="space-y-1 max-h-80 overflow-y-auto">
            {incompleteServices.map((s) => {
              const open = expandedService === s.product;
              return (
                <div key={s.product} className="py-1.5 border-b border-slate-100">
                  <button
                    onClick={() => setExpandedService(open ? null : s.product)}
                    className="w-full text-left bg-transparent border-none cursor-pointer p-0"
                  >
                    <div className="flex justify-between text-sm items-center">
                      <span className="font-medium flex items-center gap-1">
                        <span className="text-slate-400">{open ? '▾' : '▸'}</span>
                        {s.name}
                      </span>
                      <span className="font-bold text-rose-600">{s.totalMissing} faltantes</span>
                    </div>
                    <div className="flex gap-3 text-[11px] text-slate-500 mt-0.5 pl-4">
                      <span>Activos: {s.activeMissing}</span>
                      <span className="text-rose-500">Abandonados: {s.abandoned}</span>
                      <span className="text-emerald-600">Completados: {s.completed}</span>
                      <span className="text-slate-400">{(s.patients || []).length} paciente(s)</span>
                    </div>
                  </button>
                  {open && (
                    <div className="mt-1 pl-4 space-y-0.5">
                      {(s.patients || []).length === 0 ? (
                        <div className="text-[11px] text-slate-400">Sin pacientes</div>
                      ) : (
                        s.patients.map((p, i) => (
                          <div key={(p._id || '') + i} className="flex justify-between text-[11px] text-slate-600 bg-slate-50 rounded px-2 py-1">
                            <span>{p.name || 'Paciente'}</span>
                            <span className="flex gap-2">
                              {p.phone && <span>📞 {p.phone}</span>}
                              <span className="text-rose-500">faltan {p.missing}</span>
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {incompleteServices.length === 0 && (
              <div className="text-sm text-slate-400">Sin pendientes</div>
            )}
          </div>
        </div>
      </section>

      {/* Evolución de un servicio en el tiempo */}
      <section className="bg-white rounded-xl border border-slate-200 p-4">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <h2 className="font-semibold text-slate-800 flex items-center gap-2">
            <HiOutlineChartBar className="text-emerald-600" /> Evolución de un servicio
          </h2>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <select
              value={evolutionService}
              onChange={(e) => setEvolutionService(e.target.value)}
              className="border border-slate-200 rounded-lg px-2 py-1"
            >
              <option value="">Selecciona un servicio...</option>
              {services.map((s) => (
                <option key={s._id} value={s._id}>{s.name}</option>
              ))}
            </select>
            <select
              value={evolutionRange}
              onChange={(e) => setEvolutionRange(e.target.value)}
              className="border border-slate-200 rounded-lg px-2 py-1"
            >
              {RANGE_OPTIONS.filter((o) => o.value !== 'next7days').map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            {evolutionRange === 'custom' && (
              <>
                <input
                  type="date"
                  value={evolutionCustom.startDate}
                  onChange={(e) => setEvolutionCustom((p) => ({ ...p, startDate: e.target.value }))}
                  className="border border-slate-200 rounded-lg px-2 py-1"
                />
                <input
                  type="date"
                  value={evolutionCustom.endDate}
                  onChange={(e) => setEvolutionCustom((p) => ({ ...p, endDate: e.target.value }))}
                  className="border border-slate-200 rounded-lg px-2 py-1"
                />
              </>
            )}
          </div>
        </div>
        {!evolution || !evolution.series?.length ? (
          <div className="text-sm text-slate-400">Selecciona un servicio para ver su evolución.</div>
        ) : (
          <div className="grid lg:grid-cols-[1fr_220px] gap-4">
            <div style={{ height: 280 }}>
              <ResponsiveContainer>
                <LineChart data={evolution.series}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="date" fontSize={11} />
                  <YAxis fontSize={11} />
                  <Tooltip />
                  <Legend />
                  <Line type="monotone" dataKey="salesQty" name="Vendidos" stroke="#10b981" strokeWidth={2} />
                  <Line type="monotone" dataKey="apptsQty" name="En citas" stroke="#0ea5e9" strokeWidth={2} />
                  <Line type="monotone" dataKey="patients" name="Pacientes únicos" stroke="#f59e0b" strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="space-y-2 text-sm">
              <div className="bg-emerald-50 rounded-lg p-3">
                <div className="text-xs text-slate-500">Total vendido</div>
                <div className="text-2xl font-bold text-emerald-700">{evolution.total?.sales || 0}</div>
              </div>
              <div className="bg-sky-50 rounded-lg p-3">
                <div className="text-xs text-slate-500">Total en citas</div>
                <div className="text-2xl font-bold text-sky-700">{evolution.total?.appts || 0}</div>
              </div>
              <div className="text-xs text-slate-500">
                Rango: {evolution.range?.startDate?.slice(0, 10)} → {evolution.range?.endDate?.slice(0, 10)}
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="bg-white rounded-xl border border-slate-200 p-4">
        <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
          <h2 className="font-semibold text-slate-800">
            Recordatorios de pacientes ausentes{' '}
            <span className="text-xs text-slate-400 font-normal">({reminders.length} total)</span>
          </h2>
          <div className="flex items-center gap-2 text-sm flex-wrap">
            <select
              value={reminderFilter.service}
              onChange={(e) => setReminderFilter((p) => ({ ...p, service: e.target.value, program: '' }))}
              className="border border-slate-200 rounded px-2 py-1 text-sm"
            >
              <option value="">Todos los servicios</option>
              {services.map((s) => <option key={s._id} value={s._id}>{s.name}</option>)}
            </select>
            <select
              value={reminderFilter.program}
              onChange={(e) => setReminderFilter((p) => ({ ...p, program: e.target.value, service: '' }))}
              className="border border-slate-200 rounded px-2 py-1 text-sm"
            >
              <option value="">Todos los programas</option>
              {programsList.map((p) => <option key={p._id} value={p._id}>{p.name}</option>)}
            </select>
            <span>Sin venir hace</span>
            <input type="number" min="1" value={reminderDays} onChange={(e) => setReminderDays(Number(e.target.value))} className="w-16 border border-slate-200 rounded px-2 py-1 text-sm" />
            <span>días</span>
            <button onClick={load} className="px-3 py-1 bg-emerald-600 text-white rounded text-sm cursor-pointer border-none">Actualizar</button>
            <button onClick={openWhatsappModal} className="px-3 py-1 bg-green-600 text-white rounded text-sm cursor-pointer border-none">
              WhatsApp masivo
            </button>
          </div>
        </div>
        <div className="max-h-[420px] overflow-y-auto rounded border border-slate-100">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 sticky top-0 z-10">
              <tr>
                <th className="px-2 py-2 w-8">
                  <input
                    type="checkbox"
                    checked={reminders.length > 0 && reminders.every((r) => selectedReminders[r.treatmentId])}
                    onChange={(e) => {
                      if (e.target.checked) {
                        const all = {};
                        reminders.forEach((r) => { if (r.patient?.phone || r.patient?.whatsapp) all[r.treatmentId] = true; });
                        setSelectedReminders(all);
                      } else setSelectedReminders({});
                    }}
                  />
                </th>
                <th className="text-left px-2 py-2">Paciente</th>
                <th className="text-left px-2 py-2">Tratamiento</th>
                <th className="text-left px-2 py-2">Avance</th>
                <th className="text-left px-2 py-2">Última visita</th>
                <th className="text-left px-2 py-2">Servicios pendientes</th>
                <th className="text-left px-2 py-2">Contacto</th>
              </tr>
            </thead>
            <tbody>
              {reminders.slice(0, reminderLimit).map((r) => (
                <tr key={r.treatmentId} className="border-t border-slate-100">
                  <td className="px-2 py-1 text-center">
                    <input
                      type="checkbox"
                      checked={!!selectedReminders[r.treatmentId]}
                      disabled={!r.patient?.phone && !r.patient?.whatsapp}
                      onChange={(e) =>
                        setSelectedReminders((prev) => {
                          const next = { ...prev };
                          if (e.target.checked) next[r.treatmentId] = true;
                          else delete next[r.treatmentId];
                          return next;
                        })
                      }
                    />
                  </td>
                  <td className="px-2 py-1">{r.patient?.firstName} {r.patient?.lastName}</td>
                  <td className="px-2 py-1">{r.treatmentName}</td>
                  <td className="px-2 py-1">{r.progress}%</td>
                  <td className="px-2 py-1">hace {r.daysSince} días</td>
                  <td className="px-2 py-1 text-xs text-slate-500">
                    {r.missingItems.map((m) => `${m.name} (${m.missing})`).join(', ')}
                  </td>
                  <td className="px-2 py-1 text-xs">
                    {r.patient?.phone && <div>📞 {r.patient.phone}</div>}
                    {r.patient?.email && <div>✉️ {r.patient.email}</div>}
                  </td>
                </tr>
              ))}
              {reminders.length === 0 && (
                <tr><td colSpan={7} className="text-center py-4 text-slate-400">Sin recordatorios</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {reminders.length > reminderLimit && (
          <div className="mt-2 flex items-center justify-center gap-2 text-sm">
            <button
              onClick={() => setReminderLimit((l) => l + 10)}
              className="px-3 py-1 bg-slate-100 hover:bg-slate-200 rounded text-slate-700"
            >
              Mostrar 10 más
            </button>
            <button
              onClick={() => setReminderLimit(reminders.length)}
              className="px-3 py-1 text-emerald-700 hover:underline"
            >
              Ver todos ({reminders.length})
            </button>
          </div>
        )}
        {reminders.length > 10 && reminderLimit > 10 && (
          <div className="mt-2 text-center">
            <button
              onClick={() => setReminderLimit(10)}
              className="text-xs text-slate-500 hover:underline"
            >
              Colapsar a 10
            </button>
          </div>
        )}
      </section>

      <section className="bg-white rounded-xl border border-slate-200 p-4">
        <h2 className="font-semibold text-slate-800 mb-2 flex items-center gap-2">
          <HiOutlineSparkles className="text-emerald-600" /> Predicciones de demanda (próximo mes)
        </h2>
        <p className="text-xs text-slate-500 mb-2">
          Basadas en estacionalidad y promedio de los últimos 3 meses. Para predicciones más precisas se puede conectar un servicio Python con sklearn.
        </p>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {predictions.slice(0, 12).map((p) => (
            <div key={p.product} className="bg-slate-50 rounded-lg p-2 text-sm">
              <div className="font-semibold text-slate-700">{p.name}</div>
              <div className="text-emerald-700 text-lg font-bold">{p.forecastNextMonth}</div>
              <div className="text-xs text-slate-400">3m: {p.last3MonthAvg} · estacional: {p.seasonalAvg}</div>
            </div>
          ))}
          {predictions.length === 0 && <div className="text-sm text-slate-400">Sin datos suficientes</div>}
        </div>
      </section>

      {/* Predicción próxima semana */}
      {nextWeek && (
        <section className="bg-white rounded-xl border border-slate-200 p-4">
          <h2 className="font-semibold text-slate-800 mb-2 flex items-center gap-2">
            <HiOutlineCalendarDays className="text-emerald-600" /> Próxima semana
          </h2>
          <p className="text-xs text-slate-500 mb-3">
            Citas y proyección general para los próximos 7 días ({nextWeek.from?.slice(0,10)} → {nextWeek.to?.slice(0,10)}).
          </p>
          <div className="grid sm:grid-cols-3 gap-3 mb-3">
            <div className="bg-emerald-50 rounded-lg p-3">
              <div className="text-xs text-slate-500">Cita general</div>
              <div className="text-2xl font-bold text-emerald-700">{nextWeek.totalScheduled || 0}</div>
            </div>
            <div className="bg-sky-50 rounded-lg p-3">
              <div className="text-xs text-slate-500">Promedio histórico/día</div>
              <div className="text-2xl font-bold text-sky-700">{(nextWeek.historicalDailyAvg || 0).toFixed(1)}</div>
            </div>
            <div className="bg-amber-50 rounded-lg p-3">
              <div className="text-xs text-slate-500">Pronóstico 7 días</div>
              <div className="text-2xl font-bold text-amber-700">{nextWeek.forecastNext7 || 0}</div>
            </div>
          </div>
          {nextWeek.scheduled?.length > 0 && (
            <div style={{ height: 220 }}>
              <ResponsiveContainer>
                <BarChart data={nextWeek.scheduled.map((s) => ({ date: s._id || s.date, count: s.count }))}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="date" fontSize={11} />
                  <YAxis fontSize={11} allowDecimals={false} />
                  <Tooltip />
                  <Bar dataKey="count" fill="#10b981" name="Citas" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
          {nextWeek.services?.length > 0 && (
            <div className="mt-3">
              <div className="text-xs font-semibold text-slate-600 mb-1">Top servicios próxima semana</div>
              <div className="flex flex-wrap gap-2">
                {nextWeek.services.slice(0, 8).map((s) => (
                  <span key={s.productId} className="bg-slate-100 text-slate-700 text-xs px-2 py-1 rounded-full">
                    {s.name} <strong className="text-emerald-700">×{s.count}</strong>
                  </span>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* Estadísticas de citas (unificadas con desglose) */}
      <section className="bg-white rounded-xl border border-slate-200 p-4">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <h2 className="font-semibold text-slate-800">Estadísticas de citas</h2>
          <div className="flex flex-wrap gap-2 text-sm">
            <select
              value={breakdownFilter.range}
              onChange={(e) => setBreakdownFilter((p) => ({ ...p, range: e.target.value }))}
              className="border border-slate-200 rounded-lg px-2 py-1"
            >
              {RANGE_OPTIONS.filter((o) => o.value !== 'custom').map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <select
              value={breakdownFilter.service}
              onChange={(e) => setBreakdownFilter((p) => ({ ...p, service: e.target.value, program: '' }))}
              className="border border-slate-200 rounded-lg px-2 py-1"
            >
              <option value="">Todos los servicios</option>
              {services.map((s) => (
                <option key={s._id} value={s._id}>{s.name}</option>
              ))}
            </select>
            <select
              value={breakdownFilter.program}
              onChange={(e) => setBreakdownFilter((p) => ({ ...p, program: e.target.value, service: '' }))}
              className="border border-slate-200 rounded-lg px-2 py-1"
            >
              <option value="">Todos los programas</option>
              {programsList.map((p) => (
                <option key={p._id} value={p._id}>{p.name}</option>
              ))}
            </select>
          </div>
        </div>
        {breakdown ? (
          <>
            {/* Principales: solo lo solicitado */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
              <KPI label="Total de citas" value={breakdown.total} color="slate" />
              <KPI label="Pendientes" value={breakdown.pendientes} color="amber" />
              <KPI label="Asistidos" value={breakdown.asistidos} color="emerald" />
              <KPI label="No asistidos" value={breakdown.noAsistidos} color="rose" />
              <KPI label="Nuevos" value={breakdown.nuevos} color="sky" />
            </div>
            {/* Desglose adicional */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-2">
              <KPI label="Nuevos que asistieron" value={breakdown.nuevosAsistidos} color="emerald" />
              <KPI label="Canceladas" value={breakdown.canceladas} color="slate" />
              <KPI label="Por Call Center" value={breakdown.porCallCenter} color="indigo" />
              <KPI label="Asist. Call Center" value={breakdown.asistieronCallCenter} color="violet" />
            </div>
            {breakdown.byDoctor?.length > 0 && (
              <div className="mt-3">
                <div className="text-xs font-semibold text-slate-600 mb-1">Atendidas por doctor</div>
                <div className="flex flex-wrap gap-2">
                  {breakdown.byDoctor.map((d) => (
                    <span key={d._id || d.name} className="bg-slate-100 text-slate-700 text-xs px-2 py-1 rounded-full">
                      {d.name || 'Sin doctor'} <strong className="text-emerald-700">×{d.count}</strong>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="text-sm text-slate-400">Cargando estadísticas...</div>
        )}
      </section>

      {/* Programas y sus servicios (con desempeño mensual) */}
      {programs.length > 0 && (
        <section className="bg-white rounded-xl border border-slate-200 p-4">
          <h2 className="font-semibold text-slate-800 mb-3 flex items-center gap-2">
            <HiOutlineGift className="text-emerald-600" /> Programas y servicios — desempeño mensual
          </h2>
          {(() => {
            // Etiquetas de los últimos 12 meses (YYYY-MM) para columnas uniformes
            const months = [];
            const now = new Date();
            for (let i = 11; i >= 0; i--) {
              const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
              months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
            }
            const monthLabel = (ym) => {
              const [, m] = ym.split('-');
              return ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'][Number(m) - 1] + ' ' + ym.slice(2, 4);
            };
            return (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-slate-600">
                    <tr>
                      <th className="text-left px-3 py-2 sticky left-0 bg-slate-50">Programa</th>
                      {months.map((m) => (
                        <th key={m} className="text-center px-2 py-2 text-[11px] whitespace-nowrap">{monthLabel(m)}</th>
                      ))}
                      <th className="text-right px-3 py-2">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {programs.map((p) => {
                      const byMonth = new Map((p.monthly || []).map((m) => [m.month, m]));
                      return (
                        <tr key={p._id} className="border-t border-slate-100 align-top">
                          <td className="px-3 py-2 font-medium sticky left-0 bg-white">
                            <div>{p.name}</div>
                            {p.code && <div className="text-[11px] text-slate-400">{p.code}</div>}
                          </td>
                          {months.map((m) => {
                            const cell = byMonth.get(m);
                            const count = cell?.count || 0;
                            return (
                              <td key={m} className="text-center px-2 py-2 text-xs">
                                {count > 0 ? (
                                  <span title={`$${cell.revenue?.toFixed(2)}`} className="inline-block min-w-[24px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-semibold">
                                    {count}
                                  </span>
                                ) : (
                                  <span className="text-slate-300">·</span>
                                )}
                              </td>
                            );
                          })}
                          <td className="px-3 py-2 text-right font-bold text-emerald-700">{p.timesSold || 0}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          })()}
        </section>
      )}

      {/* Heatmap zonas de Guayaquil */}
      {heatmap && (
        <section className="bg-white rounded-xl border border-slate-200 p-4">
          <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
            <h2 className="font-semibold text-slate-800 flex items-center gap-2">
              <HiOutlineMapPin className="text-emerald-600" /> Mapa de zonas de Guayaquil
            </h2>
            <div className="flex gap-2 text-sm">
              <select
                value={heatmapFilter.program}
                onChange={(e) => setHeatmapFilter({ program: e.target.value, service: '' })}
                className="border border-slate-200 rounded-lg px-2 py-1"
              >
                <option value="">Todos los programas</option>
                {programsList.map((p) => (
                  <option key={p._id} value={p._id}>{p.name}</option>
                ))}
              </select>
              <select
                value={heatmapFilter.service}
                onChange={(e) => setHeatmapFilter({ service: e.target.value, program: '' })}
                className="border border-slate-200 rounded-lg px-2 py-1"
                disabled={!!heatmapFilter.program}
              >
                <option value="">Todos los servicios</option>
                {services.map((s) => (
                  <option key={s._id} value={s._id}>{s.name}</option>
                ))}
              </select>
              {(heatmapFilter.program || heatmapFilter.service) && (
                <button
                  onClick={() => setHeatmapFilter({ service: '', program: '' })}
                  className="text-xs text-slate-500 hover:underline"
                >
                  Limpiar
                </button>
              )}
            </div>
          </div>
          <p className="text-xs text-slate-500 mb-3">
            Procedencia geográfica de los clientes según facturación{heatmapFilter.program ? ' (filtrado por programa)' : heatmapFilter.service ? ' (filtrado por servicio)' : ''}.
          </p>
          {(() => {
            const zonesWithData = (heatmap.zones || [])
              .filter((z) => z.count > 0)
              .sort((a, b) => b.count - a.count);
            const maxCount = zonesWithData[0]?.count || 1;
            if (zonesWithData.length === 0) {
              return <div className="text-sm text-slate-400 py-8 text-center">Sin datos de ventas con zona para este filtro.</div>;
            }
            // Bounding box ajustado a Guayaquil urbano
            const URBAN_LAT = [-2.27, -2.07];
            const URBAN_LNG = [-80.02, -79.84];
            const urbanZones = zonesWithData.filter(
              (z) => z.lat && z.lng && z.lat >= URBAN_LAT[0] && z.lat <= URBAN_LAT[1] && z.lng >= URBAN_LNG[0] && z.lng <= URBAN_LNG[1]
            );
            const ruralZones = zonesWithData.filter((z) => !urbanZones.includes(z));
            const W = 640;
            const H = 560;
            const PAD = 30;
            const xOf = (lng) => PAD + ((lng - URBAN_LNG[0]) / (URBAN_LNG[1] - URBAN_LNG[0])) * (W - 2 * PAD);
            const yOf = (lat) => PAD + ((URBAN_LAT[1] - lat) / (URBAN_LAT[1] - URBAN_LAT[0])) * (H - 2 * PAD);
            // Escala de radio más visible
            const radius = (count) => 10 + Math.sqrt(count / maxCount) * 40;
            const colorOf = (count) => {
              const t = count / maxCount;
              if (t > 0.75) return '#047857';
              if (t > 0.5)  return '#059669';
              if (t > 0.25) return '#10b981';
              if (t > 0.1)  return '#34d399';
              return '#a7f3d0';
            };
            return (
              <div className="grid lg:grid-cols-[1fr_300px] gap-4">
                <div className="relative bg-gradient-to-br from-slate-50 to-blue-50 rounded-lg border border-slate-200 overflow-hidden">
                  <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block" preserveAspectRatio="xMidYMid meet">
                    <defs>
                      <radialGradient id="bubbleGradient">
                        <stop offset="0%" stopColor="white" stopOpacity="0.3" />
                        <stop offset="100%" stopColor="white" stopOpacity="0" />
                      </radialGradient>
                      <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
                        <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#e2e8f0" strokeWidth="0.5" />
                      </pattern>
                    </defs>
                    {/* Fondo grilla */}
                    <rect width={W} height={H} fill="url(#grid)" />
                    {/* Río Guayas (lado este) */}
                    <path
                      d={`M ${xOf(-79.880)} 0
                          C ${xOf(-79.860)} ${H * 0.25} ${xOf(-79.855)} ${H * 0.5} ${xOf(-79.870)} ${H * 0.75}
                          L ${xOf(-79.880)} ${H}
                          L ${W} ${H} L ${W} 0 Z`}
                      fill="#bfdbfe"
                      opacity={0.75}
                    />
                    <text x={W - 80} y={H / 2} fill="#1e40af" fontSize="13" fontStyle="italic" opacity={0.7}>
                      Río Guayas
                    </text>
                    {/* Estero Salado */}
                    <path
                      d={`M 0 ${yOf(-2.20)}
                          C ${xOf(-79.965)} ${yOf(-2.18)} ${xOf(-79.955)} ${yOf(-2.16)} ${xOf(-79.945)} ${yOf(-2.13)}
                          L 0 ${yOf(-2.10)} Z`}
                      fill="#bfdbfe"
                      opacity={0.6}
                    />
                    <text x={10} y={yOf(-2.16)} fill="#1e40af" fontSize="11" fontStyle="italic" opacity={0.7}>
                      Estero
                    </text>
                    {/* Título y compass */}
                    <text x={W / 2} y={20} textAnchor="middle" fontSize="13" fill="#475569" fontWeight="600">
                      Guayaquil
                    </text>
                    <g transform={`translate(${W - 50}, 30)`}>
                      <circle r="14" fill="white" stroke="#cbd5e1" />
                      <text textAnchor="middle" y="-3" fontSize="9" fill="#64748b">N</text>
                      <path d="M 0 -8 L -3 4 L 0 1 L 3 4 Z" fill="#475569" />
                    </g>
                    {/* Zonas: primero las grandes (al fondo) para que las pequeñas queden visibles encima */}
                    {urbanZones.slice().reverse().map((z) => {
                      const cx = xOf(z.lng);
                      const cy = yOf(z.lat);
                      const r = radius(z.count);
                      const c = colorOf(z.count);
                      return (
                        <g key={z.name}>
                          <circle cx={cx} cy={cy} r={r} fill={c} opacity={0.5} stroke={c} strokeWidth="1.5" />
                          <circle cx={cx} cy={cy} r={r} fill="url(#bubbleGradient)" />
                          <circle cx={cx} cy={cy} r={4} fill="#fff" stroke={c} strokeWidth="2" />
                          <title>{z.name}: {z.count} ventas · {z.uniquePatients} pacientes</title>
                        </g>
                      );
                    })}
                    {/* Etiquetas: solo las que más resaltan */}
                    {urbanZones.slice(0, 10).map((z) => {
                      const cx = xOf(z.lng);
                      const cy = yOf(z.lat);
                      const r = radius(z.count);
                      return (
                        <g key={`lbl-${z.name}`}>
                          <text x={cx} y={cy - r - 6} textAnchor="middle" fontSize="11" fill="#0f172a" fontWeight="700" stroke="white" strokeWidth="3" paintOrder="stroke">
                            {z.name}
                          </text>
                          <text x={cx} y={cy + 4} textAnchor="middle" fontSize="10" fill="#0f766e" fontWeight="700">
                            {z.count}
                          </text>
                        </g>
                      );
                    })}
                    {/* Leyenda */}
                    <g transform={`translate(${PAD}, ${H - 50})`}>
                      <rect x="-4" y="-12" width="200" height="42" fill="white" opacity={0.85} rx="4" stroke="#e2e8f0" />
                      <text x="0" y="0" fontSize="10" fill="#475569" fontWeight="600">Intensidad de ventas</text>
                      {[0.1, 0.3, 0.6, 0.9].map((t, i) => (
                        <g key={i} transform={`translate(${i * 45}, 14)`}>
                          <circle cx="8" cy="6" r={4 + t * 8} fill={colorOf(t * maxCount)} opacity={0.6} />
                          <text x="22" y="9" fontSize="9" fill="#475569">{Math.round(t * maxCount)}+</text>
                        </g>
                      ))}
                    </g>
                  </svg>
                </div>
                <div className="bg-white border border-slate-200 rounded-lg p-2 max-h-[560px] overflow-y-auto">
                  <div className="text-xs font-semibold text-slate-600 px-2 py-1 sticky top-0 bg-white border-b border-slate-100">
                    Ranking de zonas
                  </div>
                  <ul className="space-y-1 mt-1">
                    {zonesWithData.map((z, i) => {
                      const pct = (z.count / maxCount) * 100;
                      return (
                        <li key={z.name} className="px-2 py-1.5 rounded hover:bg-slate-50">
                          <div className="flex items-center justify-between text-sm">
                            <span className="font-medium text-slate-800 truncate flex-1">
                              <span className="text-slate-400 mr-1">#{i + 1}</span>{z.name}
                            </span>
                            <span className="text-emerald-700 font-bold ml-2">{z.count}</span>
                          </div>
                          <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden mt-1">
                            <div className="h-full rounded-full" style={{ width: `${pct}%`, background: colorOf(z.count) }} />
                          </div>
                          <div className="text-[10px] text-slate-400 flex justify-between mt-0.5">
                            <span>{z.uniquePatients} pacientes</span>
                            <span>${Number(z.total || 0).toFixed(0)}</span>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  {ruralZones.length > 0 && (
                    <div className="mt-2 px-2 py-1 border-t border-slate-100 text-[10px] text-slate-500">
                      <strong>Fuera del mapa:</strong> {ruralZones.map((z) => `${z.name} (${z.count})`).join(', ')}
                    </div>
                  )}
                </div>
              </div>
            );
          })()}
          {heatmap.other?.length > 0 && (
            <div className="mt-3 text-xs text-slate-500">
              <strong>Otras direcciones ({heatmap.other.length}):</strong>{' '}
              {heatmap.other.slice(0, 5).map((o) => o.address).join(' · ')}
              {heatmap.other.length > 5 && '...'}
            </div>
          )}
        </section>
      )}

      {/* Quién refirió a cada paciente */}
      {referrers.length > 0 && (
        <section className="bg-white rounded-xl border border-slate-200 p-4">
          <h2 className="font-semibold text-slate-800 mb-2 flex items-center gap-2">
            <HiOutlineUserPlus className="text-emerald-600" /> Quién refirió a cada paciente
          </h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {referrers.map((r, i) => (
              <div key={i} className="bg-slate-50 rounded-lg p-3">
                <div className="flex justify-between items-start">
                  <div className="font-semibold text-slate-800">{r.referrer || '— Sin detalle —'}</div>
                  <div className="text-emerald-700 font-bold">{r.count}</div>
                </div>
                <div className="text-xs text-slate-500 mt-1 space-y-0.5 max-h-20 overflow-y-auto">
                  {(r.patients || []).slice(0, 5).map((p) => (
                    <div key={p._id}>{p.name} {p.cedula ? `· ${p.cedula}` : ''}</div>
                  ))}
                  {r.patients?.length > 5 && <div>+{r.patients.length - 5} más...</div>}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="bg-white rounded-xl border border-slate-200 p-4">
        <h2 className="font-semibold text-slate-800 mb-2">Top doctores por derivaciones</h2>
        <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-2">
          {(data?.refsByDoctor || []).map((d) => (
            <div key={d._id} className="bg-slate-50 rounded-lg p-3">
              <div className="text-xs text-slate-500">{d.specialty || ''}</div>
              <div className="font-semibold">{d.name}</div>
              <div className="text-emerald-700 font-bold text-lg">{d.count}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Modal de WhatsApp masivo */}
      <Modal isOpen={!!waModal} onClose={() => setWaModal(null)} title="Enviar WhatsApp masivo" size="lg">
        {waModal && (
          <div className="space-y-3">
            <div className="text-sm text-slate-600">
              Se enviará a <strong>{waModal.recipients.length}</strong> paciente(s) con teléfono/WhatsApp.
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Mensaje</label>
              <textarea
                rows={5}
                value={waModal.message}
                onChange={(e) => setWaModal((m) => ({ ...m, message: e.target.value }))}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500"
              />
              <p className="text-xs text-slate-400 mt-1">
                Usa <code>{'{{nombre}}'}</code> para personalizar con el nombre del paciente.
              </p>
            </div>
            <div className="text-xs text-slate-500 bg-amber-50 border border-amber-100 rounded-lg p-2">
              Nota: WhatsApp solo permite mensajes de texto libre dentro de la ventana de 24h tras el último mensaje del paciente. Fuera de esa ventana se requiere una plantilla aprobada.
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setWaModal(null)} className="px-4 py-2 border border-slate-200 rounded-lg text-sm cursor-pointer bg-white">Cancelar</button>
              <button onClick={sendWhatsapp} disabled={waSending} className="px-5 py-2 bg-green-600 text-white rounded-lg text-sm font-medium cursor-pointer border-none disabled:opacity-50">
                {waSending ? 'Enviando...' : 'Enviar'}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function Card({ title, value, color }) {
  const colors = {
    emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    sky: 'bg-sky-50 text-sky-700 border-sky-200',
    rose: 'bg-rose-50 text-rose-700 border-rose-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
  };
  return (
    <div className={`rounded-xl border p-4 ${colors[color]}`}>
      <div className="text-xs font-medium uppercase tracking-wider opacity-80">{title}</div>
      <div className="text-3xl font-bold mt-1">{value}</div>
    </div>
  );
}

function KPI({ label, value, color }) {
  const colors = {
    emerald: 'bg-emerald-50 text-emerald-700',
    sky: 'bg-sky-50 text-sky-700',
    indigo: 'bg-indigo-50 text-indigo-700',
    violet: 'bg-violet-50 text-violet-700',
    slate: 'bg-slate-50 text-slate-700',
    amber: 'bg-amber-50 text-amber-700',
    rose: 'bg-rose-50 text-rose-700',
  };
  return (
    <div className={`rounded-lg p-3 ${colors[color] || colors.slate}`}>
      <div className="text-xs opacity-80">{label}</div>
      <div className="text-2xl font-bold">{value || 0}</div>
    </div>
  );
}
