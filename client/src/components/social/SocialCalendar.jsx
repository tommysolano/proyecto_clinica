import { useMemo, useState } from 'react';
import { HiOutlineChevronLeft, HiOutlineChevronRight, HiOutlinePlus } from 'react-icons/hi2';
import NetworkIcon from './NetworkIcon';
import { ecDayKey, fmtTimeEc, todayEc } from '../../utils/date';
import { STATUS_META } from '../../utils/socialRules';

const WEEKDAYS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

const pad = (n) => String(n).padStart(2, '0');
const keyOf = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;

/** Días de la cuadrícula (semanas de lunes a domingo) del mes `year`/`month` (0-11). */
function gridDays(year, month) {
  const first = new Date(Date.UTC(year, month, 1));
  const offset = (first.getUTCDay() + 6) % 7; // lunes = 0
  const start = new Date(Date.UTC(year, month, 1 - offset));
  const days = [];
  for (let i = 0; i < 42; i += 1) {
    const d = new Date(start.getTime() + i * 86400000);
    days.push({ key: keyOf(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()), day: d.getUTCDate(), inMonth: d.getUTCMonth() === month });
  }
  // Si la última semana es entera del mes siguiente, sobra.
  return days.slice(35).every((d) => !d.inMonth) ? days.slice(0, 35) : days;
}

function PostChip({ p, onOpen }) {
  const nets = [...new Set((p.targets || []).map((t) => t.network))];
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onOpen(p); }}
      className="w-full text-left flex items-center gap-1 px-1.5 py-1 rounded-md bg-white border border-slate-200 hover:border-emerald-400 cursor-pointer text-[11px] leading-tight min-w-0"
      title={`${p.title} · ${STATUS_META[p.status]?.label}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_META[p.status]?.dot}`} />
      <span className="text-slate-400 shrink-0">{fmtTimeEc(p.scheduledAt)}</span>
      <span className="flex gap-0.5 shrink-0">{nets.map((n) => <NetworkIcon key={n} network={n} className="w-3 h-3" />)}</span>
      <span className="truncate text-slate-700">{p.title}</span>
    </button>
  );
}

export default function SocialCalendar({ year, month, posts, onMonthChange, onOpen, onNew }) {
  const [selected, setSelected] = useState(null);
  const today = todayEc();
  const days = useMemo(() => gridDays(year, month), [year, month]);
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

  const go = (delta) => {
    const d = new Date(Date.UTC(year, month + delta, 1));
    onMonthChange(d.getUTCFullYear(), d.getUTCMonth());
    setSelected(null);
  };
  const goToday = () => {
    const [y, m] = today.split('-').map(Number);
    onMonthChange(y, m - 1);
    setSelected(today);
  };

  const selectedPosts = selected ? byDay[selected] || [] : [];

  return (
    <div className="card p-3 sm:p-4">
      <div className="flex items-center gap-2 mb-3">
        <button type="button" onClick={() => go(-1)} className="btn-ghost !p-2" aria-label="Mes anterior"><HiOutlineChevronLeft className="w-4 h-4" /></button>
        <h2 className="text-base font-bold text-slate-800 capitalize min-w-[150px] text-center">{MONTHS[month]} {year}</h2>
        <button type="button" onClick={() => go(1)} className="btn-ghost !p-2" aria-label="Mes siguiente"><HiOutlineChevronRight className="w-4 h-4" /></button>
        <button type="button" onClick={goToday} className="btn-secondary !py-1.5 !text-xs ml-1">Hoy</button>
      </div>

      <div className="grid grid-cols-7 gap-px bg-slate-200 rounded-xl overflow-hidden border border-slate-200">
        {WEEKDAYS.map((w) => (
          <div key={w} className="bg-slate-50 text-[11px] font-semibold text-slate-500 text-center py-1.5">{w}</div>
        ))}
        {days.map((d) => {
          const list = byDay[d.key] || [];
          const isToday = d.key === today;
          const isPast = d.key < today;
          return (
            <div
              key={d.key}
              role="button"
              tabIndex={0}
              onClick={() => setSelected(d.key)}
              onKeyDown={(e) => { if (e.key === 'Enter') setSelected(d.key); }}
              className={`group relative bg-white min-h-[64px] md:min-h-[112px] p-1 md:p-1.5 cursor-pointer ${d.inMonth ? '' : 'bg-slate-50/70'} ${selected === d.key ? 'ring-2 ring-inset ring-emerald-500' : ''}`}
            >
              <div className="flex items-center justify-between">
                <span className={`text-[11px] md:text-xs font-semibold w-6 h-6 flex items-center justify-center rounded-full ${isToday ? 'bg-emerald-600 text-white' : d.inMonth ? 'text-slate-700' : 'text-slate-300'}`}>
                  {d.day}
                </span>
                {!isPast && (
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
              {/* Escritorio: chips. Móvil: puntos (la lista del día va debajo). */}
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

      {selected && (
        <div className="mt-3">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-semibold text-slate-700">{selected.split('-').reverse().join('/')}</p>
            {selected >= today && (
              <button type="button" onClick={() => onNew(selected)} className="btn-secondary !py-1.5 !text-xs"><HiOutlinePlus className="w-4 h-4" /> Nueva este día</button>
            )}
          </div>
          {selectedPosts.length === 0 ? (
            <p className="text-xs text-slate-400">Nada programado este día.</p>
          ) : (
            <div className="grid gap-1.5">
              {selectedPosts.map((p) => <PostChip key={p._id} p={p} onOpen={onOpen} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
