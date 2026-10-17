import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { HiOutlineMegaphone, HiOutlinePlus, HiOutlineMagnifyingGlass } from 'react-icons/hi2';
import api from '../api/axios';
import PageHeader from '../components/PageHeader';
import { useAuth } from '../context/AuthContext';
import SocialCalendar from '../components/social/SocialCalendar';
import SocialAccountsPanel from '../components/social/SocialAccountsPanel';
import SocialSettingsPanel from '../components/social/SocialSettingsPanel';
import PostEditorModal from '../components/social/PostEditorModal';
import NetworkIcon from '../components/social/NetworkIcon';
import { fmtDateTime, todayEc } from '../utils/date';
import { NETWORKS, NETWORK_LABELS, FORMAT_LABELS, STATUS_META } from '../utils/socialRules';

/**
 * Fénix → Redes sociales. Planificador de publicaciones para Facebook,
 * Instagram, TikTok y YouTube por sus APIs oficiales.
 *
 * Es parte del CRM, que es el MISMO para todas las empresas: las cuentas y el
 * calendario no cambian al cambiar de empresa o sucursal.
 */
const TABS = [
  { key: 'calendar', label: 'Calendario' },
  { key: 'list', label: 'Lista' },
  { key: 'accounts', label: 'Cuentas' },
  { key: 'settings', label: 'Configuración' },
];

function monthRange(year, month) {
  // Un margen de una semana a cada lado: la cuadrícula enseña días de los meses vecinos.
  const from = new Date(Date.UTC(year, month, 1 - 7, 5));
  const to = new Date(Date.UTC(year, month + 1, 7, 5));
  return { from: from.toISOString(), to: to.toISOString() };
}

export default function SocialPlanner() {
  const { role, user } = useAuth();
  const isAdmin = role === 'admin' || Boolean(user?.isSuperAdmin);
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState('calendar');
  const [accounts, setAccounts] = useState([]);
  const [config, setConfig] = useState(null);
  const [team, setTeam] = useState([]);
  const [posts, setPosts] = useState([]);
  const [undated, setUndated] = useState([]);
  const [listPosts, setListPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [ym, setYm] = useState(() => {
    const [y, m] = todayEc().split('-').map(Number);
    return { year: y, month: m - 1 };
  });
  const [filters, setFilters] = useState({ status: '', network: '', search: '' });
  const [editor, setEditor] = useState(null); // { postId?, initialDate? }

  const loadMeta = useCallback(async () => {
    try {
      const [a, c, t] = await Promise.all([api.get('/social/accounts'), api.get('/social/config'), api.get('/social/team').catch(() => ({ data: [] }))]);
      setAccounts(a.data);
      setConfig(c.data);
      setTeam(t.data);
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudo cargar la configuración de redes');
    }
  }, []);

  const loadCalendar = useCallback(async () => {
    try {
      const { data } = await api.get('/social/posts', { params: monthRange(ym.year, ym.month) });
      setPosts(data.items || []);
      setUndated(data.undated || []);
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudieron cargar las publicaciones');
    } finally {
      setLoading(false);
    }
  }, [ym]);

  const loadList = useCallback(async () => {
    try {
      const params = {};
      if (filters.status) params.status = filters.status;
      if (filters.network) params.network = filters.network;
      if (filters.search.trim()) params.search = filters.search.trim();
      const { data } = await api.get('/social/posts', { params });
      setListPosts(data.items || []);
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudieron cargar las publicaciones');
    }
  }, [filters]);

  useEffect(() => { loadMeta(); }, [loadMeta]);
  useEffect(() => { loadCalendar(); }, [loadCalendar]);
  useEffect(() => {
    if (tab !== 'list') return undefined;
    const h = setTimeout(loadList, 250);
    return () => clearTimeout(h);
  }, [tab, loadList]);

  // Mientras algo se está publicando, se refresca solo para ver cómo avanza.
  const busy = posts.some((p) => p.status === 'publishing');
  useEffect(() => {
    if (!busy) return undefined;
    const h = setInterval(loadCalendar, 20000);
    return () => clearInterval(h);
  }, [busy, loadCalendar]);

  // Enlace desde la campana: /social?post=<id> abre esa publicación.
  useEffect(() => {
    const id = searchParams.get('post');
    if (id) {
      setEditor({ postId: id });
      searchParams.delete('post');
      setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const refreshAll = () => {
    loadCalendar();
    if (tab === 'list') loadList();
  };

  const pendingReview = useMemo(() => [...posts, ...undated].filter((p) => p.status === 'in_review'), [posts, undated]);
  const needsAction = useMemo(() => posts.filter((p) => ['needs_action', 'failed', 'partial'].includes(p.status)), [posts]);

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-5 page-enter">
      <PageHeader icon={HiOutlineMegaphone} title="Redes sociales" subtitle="Planifica y programa publicaciones, reels, historias y videos en Facebook, Instagram, TikTok y YouTube.">
        <button type="button" onClick={() => setEditor({ initialDate: null })} className="btn-primary"><HiOutlinePlus className="w-4 h-4" /> Nueva publicación</button>
      </PageHeader>

      <div className="flex gap-1 border-b border-slate-200 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-semibold border-0 border-b-2 bg-transparent cursor-pointer whitespace-nowrap ${tab === t.key ? 'border-emerald-600 text-emerald-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
          >
            {t.label}
            {t.key === 'accounts' && accounts.some((a) => a.status === 'error') && <span className="ml-1 inline-block w-2 h-2 rounded-full bg-rose-500" />}
          </button>
        ))}
      </div>

      {tab === 'calendar' && (
        <div className="space-y-4">
          {(needsAction.length > 0 || pendingReview.length > 0) && (
            <div className="grid md:grid-cols-2 gap-3">
              {needsAction.length > 0 && (
                <AttentionBox title="Requieren atención" posts={needsAction} onOpen={(p) => setEditor({ postId: p._id })} tone="rose" />
              )}
              {pendingReview.length > 0 && (
                <AttentionBox title={isAdmin ? 'Esperan tu aprobación' : 'En revisión'} posts={pendingReview} onOpen={(p) => setEditor({ postId: p._id })} tone="amber" />
              )}
            </div>
          )}
          {loading ? (
            <p className="text-center text-slate-400 py-16">Cargando…</p>
          ) : (
            <SocialCalendar
              year={ym.year}
              month={ym.month}
              posts={posts}
              onMonthChange={(year, month) => setYm({ year, month })}
              onOpen={(p) => setEditor({ postId: p._id })}
              onNew={(day) => setEditor({ initialDate: day })}
            />
          )}
          {undated.filter((p) => p.status === 'draft').length > 0 && (
            <div className="card p-4">
              <p className="text-sm font-semibold text-slate-700 mb-2">Borradores sin fecha</p>
              <div className="flex flex-wrap gap-2">
                {undated.filter((p) => p.status === 'draft').map((p) => (
                  <button key={p._id} type="button" onClick={() => setEditor({ postId: p._id })} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-xs cursor-pointer hover:border-emerald-400">
                    {[...new Set((p.targets || []).map((t) => t.network))].map((n) => <NetworkIcon key={n} network={n} className="w-3 h-3" />)}
                    {p.title}
                  </button>
                ))}
              </div>
            </div>
          )}
          <Legend />
        </div>
      )}

      {tab === 'list' && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <div className="relative flex-1 min-w-[200px]">
              <HiOutlineMagnifyingGlass className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input className="input !pl-9" value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} placeholder="Buscar por nombre, texto, campaña o hashtag…" />
            </div>
            <select className="input !w-auto" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
              <option value="">Todos los estados</option>
              {Object.entries(STATUS_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <select className="input !w-auto" value={filters.network} onChange={(e) => setFilters({ ...filters, network: e.target.value })}>
              <option value="">Todas las redes</option>
              {NETWORKS.map((n) => <option key={n} value={n}>{NETWORK_LABELS[n]}</option>)}
            </select>
          </div>
          <div className="tbl-wrap">
            <table className="tbl tbl-cards">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Publicación</th>
                  <th>Destinos</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {listPosts.length === 0 && (
                  <tr><td colSpan={4} className="text-center text-slate-400 py-10">No hay publicaciones con estos filtros.</td></tr>
                )}
                {listPosts.map((p) => (
                  <tr key={p._id} onClick={() => setEditor({ postId: p._id })} className="cursor-pointer">
                    <td data-cell="hora" className="whitespace-nowrap">{p.scheduledAt ? fmtDateTime(p.scheduledAt) : 'Sin fecha'}</td>
                    <td data-cell="principal">
                      <div className="font-medium text-slate-800">{p.title}</div>
                      {p.campaign && <div className="text-[11px] text-slate-400">{p.campaign}</div>}
                    </td>
                    <td data-cell="detalle">
                      <div className="flex flex-wrap gap-1.5">
                        {(p.targets || []).map((t) => (
                          <span key={t._id} className="inline-flex items-center gap-1 text-[11px] text-slate-600 bg-slate-50 rounded px-1.5 py-0.5">
                            <NetworkIcon network={t.network} className="w-3 h-3" /> {FORMAT_LABELS[t.format]}
                            {t.status === 'failed' && <span className="text-rose-600">· falló</span>}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td data-cell="estado"><span className={`badge ${STATUS_META[p.status]?.badge}`}>{STATUS_META[p.status]?.label}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'accounts' && <SocialAccountsPanel accounts={accounts} config={config} onChanged={loadMeta} />}
      {tab === 'settings' && <SocialSettingsPanel config={config} onChanged={loadMeta} />}

      <PostEditorModal
        isOpen={Boolean(editor)}
        postId={editor?.postId || null}
        initialDate={editor?.initialDate || null}
        accounts={accounts}
        config={config}
        team={team}
        isAdmin={isAdmin}
        onClose={() => setEditor(null)}
        onChanged={refreshAll}
      />
    </div>
  );
}

function AttentionBox({ title, posts, onOpen, tone }) {
  const box = tone === 'rose' ? 'border-rose-200 bg-rose-50' : 'border-amber-200 bg-amber-50';
  const text = tone === 'rose' ? 'text-rose-800' : 'text-amber-800';
  return (
    <div className={`rounded-xl border p-3 ${box}`}>
      <p className={`text-xs font-semibold mb-2 ${text}`}>{title} ({posts.length})</p>
      <div className="flex flex-col gap-1">
        {posts.slice(0, 6).map((p) => (
          <button key={p._id} type="button" onClick={() => onOpen(p)} className="flex items-center gap-2 text-left text-xs bg-white/70 hover:bg-white rounded-lg px-2 py-1.5 border-none cursor-pointer min-w-0">
            <span className={`badge ${STATUS_META[p.status]?.badge} shrink-0`}>{STATUS_META[p.status]?.label}</span>
            <span className="truncate text-slate-700">{p.title}</span>
            <span className="text-slate-400 ml-auto shrink-0">{p.scheduledAt ? fmtDateTime(p.scheduledAt) : ''}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap gap-3 text-[11px] text-slate-500">
      {Object.entries(STATUS_META).map(([k, v]) => (
        <span key={k} className="inline-flex items-center gap-1"><span className={`w-2 h-2 rounded-full ${v.dot}`} /> {v.label}</span>
      ))}
    </div>
  );
}
