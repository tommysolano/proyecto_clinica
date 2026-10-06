import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  HiOutlinePhone,
  HiOutlinePhoneArrowDownLeft,
  HiOutlinePhoneArrowUpRight,
  HiOutlineMagnifyingGlass,
  HiOutlineChatBubbleLeftRight,
  HiOutlineArrowPath,
  HiOutlineClock,
} from 'react-icons/hi2';
import api from '../api/axios';
import { useSocketEvent } from '../context/SocketContext';
import useDebounce from '../hooks/useDebounce';
import DateInput from '../components/DateInput';
import { formatEc, fmtTimeEc, todayEc } from '../utils/date';
import { formatPhone } from '../utils/phone';

/**
 * REGISTRO DE LLAMADAS (Fénix, oct-2026): quién nos llamó o a quién llamamos,
 * por qué número de la clínica, si se contestó, quién atendió, cuánto timbró y
 * cuánto duró.
 *
 * El RESULTADO lo calcula el servidor a partir de si la llamada llegó a
 * conectarse, no del estado guardado (ver server/controllers/callLogController).
 * Se refresca solo cuando entra, se contesta o termina una llamada.
 */

const RESULTADOS = {
  contestada: { label: 'Contestada', badge: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  perdida: { label: 'Perdida', badge: 'bg-rose-50 text-rose-700 border-rose-200' },
  rechazada: { label: 'Rechazada', badge: 'bg-amber-50 text-amber-800 border-amber-200' },
  no_contesto: { label: 'No contestó', badge: 'bg-slate-100 text-slate-600 border-slate-200' },
  fallida: { label: 'Fallida', badge: 'bg-slate-100 text-slate-600 border-slate-300' },
  en_curso: { label: 'En curso', badge: 'bg-sky-50 text-sky-700 border-sky-200' },
};

const dayMs = 24 * 60 * 60 * 1000;
const shiftDays = (ymd, days) =>
  new Date(Date.parse(`${ymd}T12:00:00Z`) + days * dayMs).toISOString().slice(0, 10);

function rangePresets() {
  const today = todayEc();
  const firstOfMonth = `${today.slice(0, 7)}-01`;
  const lastMonthEnd = shiftDays(firstOfMonth, -1);
  return [
    { key: 'today', label: 'Hoy', from: today, to: today },
    { key: 'yesterday', label: 'Ayer', from: shiftDays(today, -1), to: shiftDays(today, -1) },
    { key: '7d', label: '7 días', from: shiftDays(today, -6), to: today },
    { key: '30d', label: '30 días', from: shiftDays(today, -29), to: today },
    { key: 'month', label: 'Este mes', from: firstOfMonth, to: today },
    { key: 'lastMonth', label: 'Mes pasado', from: `${lastMonthEnd.slice(0, 7)}-01`, to: lastMonthEnd },
  ];
}

/** 75 → «1:15»; 3725 → «1:02:05». */
function duracion(seg) {
  if (seg == null) return '—';
  const s = Math.max(0, Math.round(seg));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

/** Tiempo total legible para las tarjetas: «2 h 05 min», «12 min», «45 s». */
function tiempoTotal(seg) {
  const s = Math.round(seg || 0);
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}

const tituloDia = (fecha) => {
  const t = formatEc(fecha, 'es-EC', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
  return t.charAt(0).toUpperCase() + t.slice(1);
};

export default function CallLog() {
  const presets = useMemo(rangePresets, []);
  const [range, setRange] = useState(() => ({ from: presets[2].from, to: presets[2].to }));
  const [direction, setDirection] = useState('');
  const [result, setResult] = useState('');
  const [account, setAccount] = useState('');
  const [agent, setAgent] = useState('');
  const [search, setSearch] = useState('');
  const q = useDebounce(search.trim(), 400);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  // La página va ligada a los filtros con los que se eligió: con cualquier
  // filtro nuevo se vuelve sola a la primera.
  const filtros = `${range.from}|${range.to}|${direction}|${result}|${account}|${agent}|${q}`;
  const [pagina, setPagina] = useState({ filtros, n: 1 });
  const paginaEfectiva = pagina.filtros === filtros ? pagina.n : 1;
  const setPage = (fn) => setPagina({ filtros, n: fn(paginaEfectiva) });

  const pedidoRef = useRef(0);
  const load = async ({ silencioso = false } = {}) => {
    const id = ++pedidoRef.current;
    if (!silencioso) setLoading(true);
    try {
      const { data: d } = await api.get('/chats/calls/log', {
        params: {
          from: range.from,
          to: range.to,
          direction: direction || undefined,
          result: result || undefined,
          account: account || undefined,
          agent: agent || undefined,
          q: q || undefined,
          page: paginaEfectiva,
          limit: 50,
        },
      });
      // Una respuesta vieja (filtro cambiado mientras viajaba) no pisa la nueva.
      if (id === pedidoRef.current) setData(d);
    } catch (e) {
      if (!silencioso) toast.error(e.response?.data?.message || 'No se pudo cargar el registro de llamadas');
    } finally {
      if (id === pedidoRef.current) setLoading(false);
    }
  };
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    loadRef.current();
  }, [filtros, paginaEfectiva]);

  // En vivo: entra, se contesta o termina una llamada → se refresca (agrupado).
  const timerRef = useRef(null);
  const refrescar = () => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => loadRef.current({ silencioso: true }), 1200);
  };
  useEffect(() => () => clearTimeout(timerRef.current), []);
  useSocketEvent('call:incoming', refrescar);
  useSocketEvent('call:status', refrescar);
  useSocketEvent('call:ended', refrescar);

  const activePreset = presets.find((p) => p.from === range.from && p.to === range.to)?.key || '';
  const resumen = data?.resumen;
  const calls = useMemo(() => data?.calls || [], [data]);
  const pag = data?.pagination;

  // Agrupadas por día (en hora de Ecuador), como la agenda.
  const porDia = useMemo(() => {
    const grupos = [];
    for (const c of calls) {
      const key = formatEc(c.startedAt, 'en-CA');
      let g = grupos[grupos.length - 1];
      if (!g || g.key !== key) {
        g = { key, fecha: c.startedAt, items: [] };
        grupos.push(g);
      }
      g.items.push(c);
    }
    return grupos;
  }, [calls]);

  const pctContestadas = resumen?.entrantes
    ? Math.round((resumen.entrantesContestadas / resumen.entrantes) * 100)
    : null;

  const tarjetas = resumen
    ? [
        { key: '', label: 'Todas', value: resumen.total, hint: `${resumen.entrantes} entrantes · ${resumen.salientes} salientes`, tone: 'slate' },
        { key: 'contestada', label: 'Contestadas', value: resumen.contestada, hint: pctContestadas != null ? `${pctContestadas}% de las entrantes` : '', tone: 'emerald' },
        { key: 'perdida', label: 'Perdidas', value: resumen.perdida, hint: 'Nos llamaron y nadie contestó', tone: 'rose' },
        { key: 'rechazada', label: 'Rechazadas', value: resumen.rechazada, hint: 'Rechazadas desde el CRM', tone: 'amber' },
        ...(resumen.no_contesto ? [{ key: 'no_contesto', label: 'No contestó', value: resumen.no_contesto, hint: 'Llamamos y el contacto no contestó', tone: 'slate' }] : []),
        ...(resumen.fallida ? [{ key: 'fallida', label: 'Fallidas', value: resumen.fallida, hint: 'Error de WhatsApp o de red', tone: 'slate' }] : []),
      ]
    : [];
  const TONO = {
    slate: 'text-slate-800',
    emerald: 'text-emerald-700',
    rose: 'text-rose-600',
    amber: 'text-amber-700',
  };

  const hayFiltros = direction || result || account || agent || search;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
            <HiOutlinePhone className="text-emerald-600" /> Registro de llamadas
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Llamadas de WhatsApp entrantes y salientes: quién llamó, a qué número, si se contestó y cuánto duró.
          </p>
        </div>
        <button
          onClick={() => load()}
          disabled={loading}
          className="px-3 py-2 border border-slate-200 rounded-xl text-sm flex items-center gap-1.5 bg-white cursor-pointer hover:bg-slate-50 disabled:opacity-50"
        >
          <HiOutlineArrowPath className={loading ? 'animate-spin' : ''} /> Actualizar
        </button>
      </div>

      {/* Rango de fechas */}
      <div className="bg-white rounded-xl border border-slate-200 p-3 flex flex-wrap items-center gap-2">
        {presets.map((p) => (
          <button
            key={p.key}
            onClick={() => setRange({ from: p.from, to: p.to })}
            className={`px-3 py-1.5 rounded-lg text-sm border cursor-pointer ${
              activePreset === p.key
                ? 'bg-emerald-50 text-emerald-700 border-emerald-200 font-semibold'
                : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
            }`}
          >
            {p.label}
          </button>
        ))}
        <span className="hidden sm:block w-px h-6 bg-slate-200 mx-1" />
        <label className="text-xs text-slate-500 flex items-center gap-1.5">
          Desde
          <DateInput
            value={range.from}
            max={range.to}
            onChange={(e) => e.target.value && setRange((r) => ({ ...r, from: e.target.value }))}
            className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm text-slate-700"
          />
        </label>
        <label className="text-xs text-slate-500 flex items-center gap-1.5">
          Hasta
          <DateInput
            value={range.to}
            min={range.from}
            max={todayEc()}
            onChange={(e) => e.target.value && setRange((r) => ({ ...r, to: e.target.value }))}
            className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm text-slate-700"
          />
        </label>
      </div>

      {/* Resumen: cada tarjeta filtra por su resultado */}
      {resumen && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          {tarjetas.map((t) => (
            <button
              key={t.key || 'todas'}
              onClick={() => setResult(t.key)}
              className={`text-left rounded-xl border p-3 cursor-pointer transition-colors ${
                result === t.key ? 'bg-emerald-50/60 border-emerald-300 ring-1 ring-emerald-200' : 'bg-white border-slate-200 hover:border-slate-300'
              }`}
            >
              <p className="text-xs text-slate-500 m-0">{t.label}</p>
              <p className={`text-2xl font-bold tabular-nums m-0 mt-0.5 ${TONO[t.tone]}`}>{t.value}</p>
              {t.hint && <p className="text-[11px] text-slate-400 m-0 mt-0.5 leading-snug">{t.hint}</p>}
            </button>
          ))}
        </div>
      )}
      {resumen && resumen.contestada > 0 && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-slate-600 px-1">
          <span className="flex items-center gap-1.5">
            <HiOutlineClock className="w-4 h-4 text-slate-400" />
            Tiempo en llamada: <b className="text-slate-800 tabular-nums">{tiempoTotal(resumen.duracionTotal)}</b>
          </span>
          {resumen.duracionPromedio != null && (
            <span>Duración promedio: <b className="text-slate-800 tabular-nums">{duracion(resumen.duracionPromedio)}</b></span>
          )}
          {resumen.esperaPromedio != null && (
            <span title="Cuánto timbra una llamada entrante antes de que alguien la conteste">
              Espera promedio para contestar: <b className="text-slate-800 tabular-nums">{resumen.esperaPromedio} s</b>
            </span>
          )}
        </div>
      )}

      {/* Filtros */}
      <div className="bg-white rounded-xl border border-slate-200 p-3 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <HiOutlineMagnifyingGlass className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nombre o teléfono"
            className="w-full border border-slate-200 rounded-lg pl-8 pr-2 py-1.5 text-sm"
          />
        </div>
        <div className="flex rounded-lg border border-slate-200 overflow-hidden text-sm">
          {[
            { v: '', label: 'Todas' },
            { v: 'in', label: 'Entrantes' },
            { v: 'out', label: 'Salientes' },
          ].map((o) => (
            <button
              key={o.v || 'todas'}
              onClick={() => setDirection(o.v)}
              className={`px-3 py-1.5 border-none cursor-pointer ${direction === o.v ? 'bg-emerald-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
            >
              {o.label}
            </button>
          ))}
        </div>
        <select
          value={account}
          onChange={(e) => setAccount(e.target.value)}
          className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm text-slate-700 bg-white"
          title="Número de la clínica"
        >
          <option value="">Todos los números</option>
          {(data?.opciones?.numeros || []).map((n) => (
            <option key={n.id} value={n.id}>{n.label}{n.phone ? ` · ${n.phone}` : ''}</option>
          ))}
        </select>
        <select
          value={agent}
          onChange={(e) => setAgent(e.target.value)}
          className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm text-slate-700 bg-white"
          title="Quién atendió o hizo la llamada"
        >
          <option value="">Todos los agentes</option>
          {(data?.opciones?.agentes || []).map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
        {hayFiltros && (
          <button
            onClick={() => { setDirection(''); setResult(''); setAccount(''); setAgent(''); setSearch(''); }}
            className="text-xs text-emerald-700 underline bg-transparent border-none cursor-pointer"
          >
            Quitar filtros
          </button>
        )}
      </div>

      {/* Tabla (tarjetas en el móvil) */}
      <div className="tbl-wrap">
        <div className="tbl-scroll">
          <table className="tbl tbl-cards">
            <thead>
              <tr>
                <th>Hora</th>
                <th>Contacto</th>
                <th>Número de la clínica</th>
                <th>Resultado</th>
                <th>Atendió</th>
                <th className="text-right">Timbró</th>
                <th className="text-right">Duración</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {loading && !calls.length && (
                <tr><td colSpan={8} className="text-center text-slate-400 py-8">Cargando llamadas…</td></tr>
              )}
              {!loading && !calls.length && (
                <tr>
                  <td colSpan={8} className="py-10">
                    <div className="empty-state">
                      <HiOutlinePhone className="w-8 h-8" />
                      <p className="m-0 text-sm">No hay llamadas con estos filtros.</p>
                    </div>
                  </td>
                </tr>
              )}
              {porDia.map((g) => (
                <FilasDelDia key={g.key} grupo={g} />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {pag && pag.pages > 1 && (
        <div className="flex items-center justify-between gap-2 text-sm text-slate-600">
          <span>
            {pag.total} llamadas · página {pag.page} de {pag.pages}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={pag.page <= 1 || loading}
              className="px-3 py-1.5 rounded-lg border border-slate-200 bg-white cursor-pointer disabled:opacity-40"
            >
              Anterior
            </button>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={pag.page >= pag.pages || loading}
              className="px-3 py-1.5 rounded-lg border border-slate-200 bg-white cursor-pointer disabled:opacity-40"
            >
              Siguiente
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function FilasDelDia({ grupo }) {
  return (
    <>
      <tr className="bg-emerald-50/70">
        <td colSpan={8} className="px-3 py-1.5 text-xs font-semibold text-emerald-800">
          {tituloDia(grupo.fecha)} · {grupo.items.length} {grupo.items.length === 1 ? 'llamada' : 'llamadas'}
        </td>
      </tr>
      {grupo.items.map((c) => <FilaLlamada key={c.id} c={c} />)}
    </>
  );
}

function FilaLlamada({ c }) {
  const entrante = c.direction === 'in';
  const res = RESULTADOS[c.resultado] || RESULTADOS.fallida;
  const telefono = formatPhone(c.phone);
  const numero = c.numero ? `${c.numero.label}${c.numero.phone ? ` · ${c.numero.phone}` : ''}` : '—';
  const DirIcon = entrante ? HiOutlinePhoneArrowDownLeft : HiOutlinePhoneArrowUpRight;
  const colorDir = c.resultado === 'contestada' ? 'text-emerald-600' : c.resultado === 'perdida' ? 'text-rose-500' : 'text-slate-400';
  const conversacion = c.resultado === 'contestada';

  return (
    <tr>
      <td data-cell="hora" className="md:whitespace-nowrap">
        <span className="flex items-center gap-1.5">
          <DirIcon className={`w-4 h-4 shrink-0 ${colorDir}`} title={entrante ? 'Entrante' : 'Saliente'} />
          <span className="tabular-nums">{fmtTimeEc(c.startedAt)}</span>
          <span className="text-[11px] font-normal text-slate-400">{entrante ? 'Entrante' : 'Saliente'}</span>
        </span>
      </td>
      <td data-cell="principal">
        <span className="block font-medium text-slate-800">{c.contacto || telefono || 'Sin nombre'}</span>
        {c.contacto && telefono && <span className="block text-xs text-slate-500 tabular-nums">{telefono}</span>}
      </td>
      <td className="hidden md:table-cell text-sm text-slate-600">{numero}</td>
      <td data-cell="estado">
        <span
          className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold border whitespace-nowrap ${res.badge}`}
          title={c.errorMessage || undefined}
        >
          {res.label}
        </span>
      </td>
      <td className="hidden md:table-cell text-sm text-slate-600">{c.agente || <span className="text-slate-300">—</span>}</td>
      <td className="hidden md:table-cell text-right tabular-nums text-sm text-slate-500">
        {c.timbre != null ? `${c.timbre} s` : '—'}
      </td>
      <td className="hidden md:table-cell text-right tabular-nums text-sm font-semibold text-slate-800">
        {conversacion ? duracion(c.duracion) : <span className="font-normal text-slate-300">—</span>}
      </td>
      {/* En el móvil, todo el detalle en una línea (las columnas de arriba se ocultan). */}
      <td data-cell="detalle" className="md:hidden text-slate-500">
        {[
          numero !== '—' && `A: ${numero}`,
          c.agente && `Atendió: ${c.agente}`,
          conversacion ? `Duración: ${duracion(c.duracion)}` : c.timbre != null && `Timbró ${c.timbre} s`,
        ].filter(Boolean).join(' · ')}
      </td>
      <td data-cell="acciones" className="md:text-right">
        {c.conversationId && (
          <Link
            to={`/chats?chat=${encodeURIComponent(c.conversationId)}`}
            title="Abrir el chat de este contacto"
            className="inline-flex items-center gap-1 text-xs text-emerald-700 hover:text-emerald-800 no-underline whitespace-nowrap"
          >
            <HiOutlineChatBubbleLeftRight className="w-4 h-4" /> Chat
          </Link>
        )}
      </td>
    </tr>
  );
}
