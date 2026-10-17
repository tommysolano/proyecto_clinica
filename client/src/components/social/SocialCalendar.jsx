import { useMemo } from 'react';
import { HiOutlineChevronLeft, HiOutlineChevronRight, HiOutlinePlus, HiOutlinePencilSquare, HiOutlineTrash } from 'react-icons/hi2';
import NetworkIcon from './NetworkIcon';
import { ecDayKey, fmtTimeEc, todayEc } from '../../utils/date';
import { STATUS_META, FORMAT_LABELS, fmtTimeSecEc } from '../../utils/socialRules';

/**
 * Calendario del planificador: vista de MES (por defecto), SEMANA y DÍA.
 *
 * Todo en hora de Ecuador. Los días se manejan como texto 'YYYY-MM-DD' y se
 * recorren con fechas UTC a mediodía: así no hay saltos de día por zona horaria
 * del navegador. Los filtros (red, tipo de contenido) los aplica la página;
 * aquí llegan ya filtradas.
 */
const WEEKDAYS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const VISTAS = [
  { key: 'month', label: 'Mes' },
  { key: 'week', label: 'Semana' },
  { key: 'day', label: 'Día' },
];

const pad = (n) => String(n).padStart(2, '0');
const toDate = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
};
const toKey = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const addDays = (key, n) => toKey(new Date(toDate(key).getTime() + n * 86400000));
const lunesDe = (key) => addDays(key, -((toDate(key).getUTCDay() + 6) % 7));

/** Días de la cuadrícula del mes (semanas de lunes a domingo). */
function gridDays(key) {
  const d = toDate(key);
  const first = toKey(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 12)));
  const start = lunesDe(first);
  const days = [];
  for (let i = 0; i < 42; i += 1) {
    const k = addDays(start, i);
    days.push({ key: k, day: Number(k.slice(8)), inMonth: k.slice(0, 7) === first.slice(0, 7) });
  }
  return days.slice(35).every((x) => !x.inMonth) ? days.slice(0, 35) : days;
}

function titulo(view, key) {
  const d = toDate(key);
  if (view === 'month') return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  if (view === 'day') return `${DIAS[d.getUTCDay()]} ${d.getUTCDate()} de ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  const ini = toDate(lunesDe(key));
  const fin = toDate(addDays(lunesDe(key), 6));
  return `${ini.getUTCDate()} ${MONTHS[ini.getUTCMonth()].slice(0, 3)} – ${fin.getUTCDate()} ${MONTHS[fin.getUTCMonth()].slice(0, 3)} ${fin.getUTCFullYear()}`;
}

/** 'HH:mm:00' dentro de 5 minutos, en hora de Ecuador (si cruza la medianoche, 23:59:00). */
function enCincoMinutos() {
  const [h, m] = fmtTimeEc(new Date(Date.now() + 5 * 60 * 1000)).split(':').map(Number);
  const ahora = Number(fmtTimeEc(new Date()).slice(0, 2));
  return h < ahora ? '23:59:00' : `${pad(h)}:${pad(m)}:00`;
}

const redesDe = (p) => [...new Set((p.targets || []).map((t) => t.network))];
const formatosDe = (p) => [...new Set((p.targets || []).map((t) => FORMAT_LABELS[t.format]))].join(', ');
const editable = (p) => ['draft', 'in_review', 'scheduled', 'failed', 'cancelled'].includes(p.status);

function PostChip({ p, onOpen, conSegundos = false }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onOpen(p); }}
      className="w-full text-left flex items-center gap-1 px-1.5 py-1 rounded-md bg-white border border-slate-200 hover:border-emerald-400 cursor-pointer text-[11px] leading-tight min-w-0"
      title={`${p.title} · ${formatosDe(p)} · ${STATUS_META[p.status]?.label}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_META[p.status]?.dot}`} />
      <span className="text-slate-400 shrink-0">{conSegundos ? fmtTimeSecEc(p.scheduledAt) : fmtTimeEc(p.scheduledAt)}</span>
      <span className="flex gap-0.5 shrink-0">{redesDe(p).map((n) => <NetworkIcon key={n} network={n} className="w-3 h-3" />)}</span>
      <span className="truncate text-slate-700">{p.title}</span>
    </button>
  );
}

export default function SocialCalendar({ view, onViewChange, day, onDayChange, posts, onOpen, onNew, onDelete }) {
  const today = todayEc();
  const byDay = useMemo(() => {
    const m = {};
    for (const p of posts || []) {
      if (!p.scheduledAt) continue;
      const k = ecDayKey(p.scheduledAt);
      (m[k] = m[k] || []).push(p);
    }
    for (const k of Object.keys(m)) m[k].sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
    return m;
  }, [posts]);

  const mover = (dir) => {
    if (view === 'day') return onDayChange(addDays(day, dir));
    if (view === 'week') return onDayChange(addDays(day, dir * 7));
    const d = toDate(day);
    return onDayChange(toKey(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + dir, 1, 12))));
  };
  const abrirDia = (k) => { onDayChange(k); onViewChange('day'); };

  return (
    <div className="card p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button type="button" onClick={() => mover(-1)} className="btn-ghost !p-2" aria-label="Anterior"><HiOutlineChevronLeft className="w-4 h-4" /></button>
        <h2 className="text-base font-bold text-slate-800 capitalize min-w-[150px] text-center">{titulo(view, day)}</h2>
        <button type="button" onClick={() => mover(1)} className="btn-ghost !p-2" aria-label="Siguiente"><HiOutlineChevronRight className="w-4 h-4" /></button>
        <button type="button" onClick={() => onDayChange(today)} className="btn-secondary !py-1.5 !text-xs">Hoy</button>
        <div className="ml-auto inline-flex rounded-xl border border-slate-200 overflow-hidden">
          {VISTAS.map((v) => (
            <button
              key={v.key}
              type="button"
              onClick={() => onViewChange(v.key)}
              className={`px-3 py-1.5 text-xs font-semibold border-none cursor-pointer ${view === v.key ? 'bg-emerald-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>

      {view === 'month' && (
        <div className="grid grid-cols-7 gap-px bg-slate-200 rounded-xl overflow-hidden border border-slate-200">
          {WEEKDAYS.map((w) => <div key={w} className="bg-slate-50 text-[11px] font-semibold text-slate-500 text-center py-1.5">{w}</div>)}
          {gridDays(day).map((d) => {
            const list = byDay[d.key] || [];
            const isToday = d.key === today;
            return (
              <div
                key={d.key}
                role="button"
                tabIndex={0}
                onClick={() => abrirDia(d.key)}
                onKeyDown={(e) => { if (e.key === 'Enter') abrirDia(d.key); }}
                title="Ver el día"
                className={`group relative bg-white min-h-[64px] md:min-h-[112px] p-1 md:p-1.5 cursor-pointer hover:bg-emerald-50/30 ${d.inMonth ? '' : 'bg-slate-50/70'}`}
              >
                <div className="flex items-center justify-between">
                  <span className={`text-[11px] md:text-xs font-semibold w-6 h-6 flex items-center justify-center rounded-full ${isToday ? 'bg-emerald-600 text-white' : d.inMonth ? 'text-slate-700' : 'text-slate-300'}`}>
                    {d.day}
                  </span>
                  {d.key >= today && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onNew(d.key); }}
                      className="hidden md:flex opacity-0 group-hover:opacity-100 w-5 h-5 items-center justify-center rounded bg-emerald-50 text-emerald-700 border-none cursor-pointer"
                      aria-label="Nueva publicación este día"
                    >
                      <HiOutlinePlus className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                <div className="hidden md:flex flex-col gap-1 mt-1">
                  {list.slice(0, 3).map((p) => <PostChip key={p._id} p={p} onOpen={onOpen} />)}
                  {list.length > 3 && <span className="text-[10px] text-slate-500 pl-1">+{list.length - 3} más</span>}
                </div>
                <div className="flex md:hidden flex-wrap gap-0.5 mt-1">
                  {list.slice(0, 6).map((p) => <span key={p._id} className={`w-1.5 h-1.5 rounded-full ${STATUS_META[p.status]?.dot}`} />)}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {view === 'week' && (
        <div className="grid grid-cols-1 md:grid-cols-7 gap-2">
          {Array.from({ length: 7 }, (_, i) => addDays(lunesDe(day), i)).map((k) => {
            const list = byDay[k] || [];
            return (
              <div key={k} className={`rounded-xl border p-2 min-h-[120px] ${k === today ? 'border-emerald-400 bg-emerald-50/30' : 'border-slate-200 bg-white'}`}>
                <div className="flex items-center justify-between mb-1.5">
                  <button type="button" onClick={() => abrirDia(k)} className="bg-transparent border-none p-0 cursor-pointer text-xs font-semibold text-slate-700 hover:text-emerald-700">
                    {WEEKDAYS[(toDate(k).getUTCDay() + 6) % 7]} {Number(k.slice(8))}
                  </button>
                  {k >= today && (
                    <button type="button" onClick={() => onNew(k)} className="btn-ghost !p-1" aria-label="Nueva publicación este día"><HiOutlinePlus className="w-3.5 h-3.5" /></button>
                  )}
                </div>
                <div className="flex flex-col gap-1">
                  {list.length === 0 && <span className="text-[11px] text-slate-300">—</span>}
                  {list.map((p) => <PostChip key={p._id} p={p} onOpen={onOpen} />)}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {view === 'day' && (
        <DiaPorHoras day={day} today={today} list={byDay[day] || []} onOpen={onOpen} onNew={onNew} onDelete={onDelete} />
      )}
    </div>
  );
}

/** Vista de un día por horas: se crea tocando la hora; cada publicación con su hora exacta. */
function DiaPorHoras({ day, today, list, onOpen, onNew, onDelete }) {
  const porHora = {};
  for (const p of list) {
    const h = Number(fmtTimeSecEc(p.scheduledAt).slice(0, 2));
    (porHora[h] = porHora[h] || []).push(p);
  }
  const ahora = Number(fmtTimeEc(new Date()).slice(0, 2));
  // Se empieza a las 6:00 salvo que haya algo antes: la madrugada casi nunca se usa.
  const primera = Math.min(6, ...Object.keys(porHora).map(Number));
  const horas = Array.from({ length: 24 - primera }, (_, i) => primera + i);
  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden divide-y divide-slate-100">
      {horas.map((h) => {
        const items = porHora[h] || [];
        const pasada = day < today || (day === today && h < ahora);
        return (
          <div key={h} className={`flex gap-3 px-3 py-2 ${items.length ? 'bg-white' : 'bg-slate-50/40'}`}>
            <div className="w-14 shrink-0 text-xs font-semibold text-slate-500 pt-1">{pad(h)}:00</div>
            <div className="flex-1 min-w-0 space-y-1.5">
              {items.map((p) => (
                <div key={p._id} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_META[p.status]?.dot}`} />
                  <span className="text-xs font-mono text-slate-500">{fmtTimeSecEc(p.scheduledAt)}</span>
                  <span className="flex gap-1">{redesDe(p).map((n) => <NetworkIcon key={n} network={n} className="w-3.5 h-3.5" />)}</span>
                  <button type="button" onClick={() => onOpen(p)} className="bg-transparent border-none p-0 cursor-pointer text-sm font-medium text-slate-800 hover:text-emerald-700 truncate max-w-[16rem] text-left">
                    {p.title}
                  </button>
                  <span className="text-[11px] text-slate-400">{formatosDe(p)}</span>
                  <span className={`badge ${STATUS_META[p.status]?.badge}`}>{STATUS_META[p.status]?.label}</span>
                  <span className="ml-auto flex gap-1">
                    <button type="button" onClick={() => onOpen(p)} className="btn-ghost !p-1.5" title={editable(p) ? 'Editar' : 'Ver'}><HiOutlinePencilSquare className="w-4 h-4" /></button>
                    {p.status !== 'publishing' && (
                      <button type="button" onClick={() => onDelete(p)} className="btn-ghost !p-1.5 hover:!text-rose-600" title="Eliminar"><HiOutlineTrash className="w-4 h-4" /></button>
                    )}
                  </span>
                </div>
              ))}
              {!pasada && (
                <button
                  type="button"
                  // En la hora en curso, las HH:00 ya pasaron: se propone dentro de 5 minutos.
                  onClick={() => onNew(day === today && h === ahora ? `${day}T${enCincoMinutos()}` : `${day}T${pad(h)}:00:00`)}
                  className="text-[11px] text-slate-400 hover:text-emerald-700 bg-transparent border-none p-0 cursor-pointer inline-flex items-center gap-1"
                >
                  <HiOutlinePlus className="w-3.5 h-3.5" /> Programar en esta hora
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
