import { useEffect, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import { HiOutlineStar, HiStar } from 'react-icons/hi2';

const STATUS_LABEL = {
  sent: { label: 'Enviada', cls: 'bg-slate-100 text-slate-600' },
  clicked: { label: 'Abrió el enlace', cls: 'bg-blue-100 text-blue-700' },
  rated: { label: 'Calificó', cls: 'bg-amber-100 text-amber-700' },
  redirected: { label: 'Reseña en Google', cls: 'bg-emerald-100 text-emerald-700' },
};

function Stars({ value }) {
  if (!value) return <span className="text-slate-300 text-xs">—</span>;
  return (
    <span className="inline-flex">
      {[1, 2, 3, 4, 5].map((n) =>
        n <= value ? (
          <HiStar key={n} className="w-4 h-4 text-amber-500" />
        ) : (
          <HiOutlineStar key={n} className="w-4 h-4 text-slate-300" />
        )
      )}
    </span>
  );
}

export default function Reputation() {
  const [stats, setStats] = useState(null);
  const [rows, setRows] = useState([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const [s, l] = await Promise.all([
        api.get('/reviews/stats'),
        api.get('/reviews', { params: filter ? { status: filter } : {} }),
      ]);
      setStats(s.data);
      setRows(l.data || []);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al cargar reputación');
    } finally {
      setLoading(false);
    }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [filter]);

  const fmt = (d) => (d ? new Date(d).toLocaleString('es-EC', { timeZone: 'America/Guayaquil', day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
  const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : 0);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
          <HiStar className="text-amber-500" /> Reputación
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Resultado de las solicitudes de reseña post-visita: cuántos calificaron y cuántos
          fueron enviados a dejar reseña en Google.
        </p>
      </div>

      <div className="grid sm:grid-cols-4 gap-3">
        <Kpi label="Solicitudes enviadas" value={stats?.total ?? '—'} />
        <Kpi label="Calificaron" value={stats?.rated ?? '—'} sub={stats ? `${pct(stats.rated, stats.total)}%` : ''} />
        <Kpi label="Reseñas a Google" value={stats?.redirected ?? '—'} color="emerald" />
        <Kpi label="Calificación promedio" value={stats?.avgRating != null ? `${stats.avgRating} ★` : '—'} color="amber" />
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-slate-800">Solicitudes</h2>
          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-500">Filtrar</label>
            <select value={filter} onChange={(e) => setFilter(e.target.value)} className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
              <option value="">Todas</option>
              <option value="sent">Enviada</option>
              <option value="clicked">Abrió el enlace</option>
              <option value="rated">Calificó</option>
              <option value="redirected">Reseña en Google</option>
            </select>
          </div>
        </div>
        {loading ? (
          <div className="text-center py-10 text-slate-400 text-sm">Cargando…</div>
        ) : rows.length === 0 ? (
          <div className="text-center py-10 text-slate-400 text-sm">Sin solicitudes de reseña aún.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl w-full">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="text-left px-3 py-2">Paciente</th>
                  <th className="text-center px-3 py-2">Estado</th>
                  <th className="text-center px-3 py-2">Calificación</th>
                  <th className="text-left px-3 py-2">Comentario</th>
                  <th className="text-left px-3 py-2">Enviada</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const st = STATUS_LABEL[r.status] || STATUS_LABEL.sent;
                  const name = r.patient ? `${r.patient.firstName || ''} ${r.patient.lastName || ''}`.trim() : '';
                  return (
                    <tr key={r._id} className="border-t border-slate-100">
                      <td className="px-3 py-2">{name || r.patient?.phone || 'Paciente'}</td>
                      <td className="px-3 py-2 text-center"><span className={`text-[11px] px-2 py-0.5 rounded-full ${st.cls}`}>{st.label}</span></td>
                      <td className="px-3 py-2 text-center"><Stars value={r.rating} /></td>
                      <td className="px-3 py-2 text-slate-600 text-xs max-w-xs truncate" title={r.feedback}>{r.feedback || '—'}</td>
                      <td className="px-3 py-2 text-xs text-slate-500">{fmt(r.sentAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Kpi({ label, value, sub, color = 'slate' }) {
  const colors = {
    slate: 'bg-slate-50 text-slate-700',
    emerald: 'bg-emerald-50 text-emerald-700',
    amber: 'bg-amber-50 text-amber-700',
  };
  return (
    <div className={`rounded-xl p-3 ${colors[color]}`}>
      <div className="text-xs">{label}</div>
      <div className="text-2xl font-bold">{value}</div>
      {sub && <div className="text-[11px] opacity-70">{sub}</div>}
    </div>
  );
}
