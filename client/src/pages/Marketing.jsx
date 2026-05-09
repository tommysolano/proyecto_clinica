import { useEffect, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import { HiOutlineMegaphone, HiOutlineSparkles, HiOutlineUserPlus, HiOutlineExclamationCircle } from 'react-icons/hi2';

const SOURCE_LABELS = {
  anuncio: 'Anuncio',
  referido: 'Referido',
  recepcion: 'Recepción',
  organico: 'Orgánico',
};

const STATUS_LABELS = {
  pendiente: 'Pendientes',
  confirmada: 'Confirmadas',
  asistida: 'Asistieron',
  completada: 'Completadas',
  no_asistio: 'No asistieron',
  cancelada: 'Canceladas',
};

export default function Marketing() {
  const [data, setData] = useState(null);
  const [reminders, setReminders] = useState([]);
  const [predictions, setPredictions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [reminderDays, setReminderDays] = useState(14);

  const load = async () => {
    setLoading(true);
    try {
      const [d, r, p] = await Promise.all([
        api.get('/marketing/dashboard'),
        api.get('/marketing/reminders', { params: { daysSinceLastVisit: reminderDays } }),
        api.get('/marketing/predictions').catch(() => ({ data: { predictions: [] } })),
      ]);
      setData(d.data);
      setReminders(r.data.reminders || []);
      setPredictions(p.data.predictions || []);
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

      <section className="bg-white rounded-xl border border-slate-200 p-4">
        <h2 className="font-semibold text-slate-800 mb-2">Estadísticas de citas</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          {Object.keys(STATUS_LABELS).map((k) => (
            <div key={k} className="bg-slate-50 rounded-lg p-2 text-center">
              <div className="text-xs text-slate-500">{STATUS_LABELS[k]}</div>
              <div className="text-xl font-bold text-slate-800">{apptTotals[k] || 0}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="grid lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <h2 className="font-semibold text-slate-800 mb-2 flex items-center gap-2">
            <HiOutlineUserPlus className="text-emerald-600" /> ¿Cómo nos conocieron?
          </h2>
          <div className="space-y-1.5">
            {Object.keys(SOURCE_LABELS).map((k) => {
              const v = sources[k] || 0;
              const pct = totalSources ? Math.round((v / totalSources) * 100) : 0;
              return (
                <div key={k}>
                  <div className="flex justify-between text-sm">
                    <span>{SOURCE_LABELS[k]}</span>
                    <span className="text-slate-500">{v} ({pct}%)</span>
                  </div>
                  <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                    <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <h2 className="font-semibold text-slate-800 mb-2 flex items-center gap-2">
            <HiOutlineExclamationCircle className="text-amber-600" /> Servicios más faltantes
          </h2>
          <p className="text-xs text-slate-500 mb-2">
            Servicios que más se necesitan para completar tratamientos activos.
          </p>
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {(data?.missingServices || []).map((s) => (
              <div key={s._id} className="flex justify-between text-sm py-1 border-b border-slate-100">
                <span>{s.name}</span>
                <span className="font-semibold text-rose-600">{s.missing} pendientes</span>
              </div>
            ))}
            {data?.missingServices?.length === 0 && (
              <div className="text-sm text-slate-400">Sin pendientes</div>
            )}
          </div>
        </div>
      </section>

      <section className="bg-white rounded-xl border border-slate-200 p-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="font-semibold text-slate-800">Recordatorios de pacientes ausentes</h2>
          <div className="flex items-center gap-2 text-sm">
            <span>Sin venir hace</span>
            <input type="number" min="1" value={reminderDays} onChange={(e) => setReminderDays(Number(e.target.value))} className="w-16 border border-slate-200 rounded px-2 py-1 text-sm" />
            <span>días</span>
            <button onClick={load} className="px-3 py-1 bg-emerald-600 text-white rounded text-sm">Actualizar</button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="text-left px-2 py-1">Paciente</th>
                <th className="text-left px-2 py-1">Tratamiento</th>
                <th className="text-left px-2 py-1">Avance</th>
                <th className="text-left px-2 py-1">Última visita</th>
                <th className="text-left px-2 py-1">Servicios pendientes</th>
                <th className="text-left px-2 py-1">Contacto</th>
              </tr>
            </thead>
            <tbody>
              {reminders.slice(0, 50).map((r) => (
                <tr key={r.treatmentId} className="border-t border-slate-100">
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
                <tr><td colSpan={6} className="text-center py-4 text-slate-400">Sin recordatorios</td></tr>
              )}
            </tbody>
          </table>
        </div>
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
