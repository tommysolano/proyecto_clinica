import { todayEc } from '../utils/date';

const DAY_MS = 24 * 60 * 60 * 1000;
const shift = (ymd, days) => new Date(Date.parse(`${ymd}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** «Hoy», «Ayer», «Anteayer» o el día con su nombre («lun 13/10»). */
function nombreDelDia(ymd, hoy = todayEc()) {
  if (ymd === hoy) return 'Hoy';
  if (ymd === shift(hoy, -1)) return 'Ayer';
  if (ymd === shift(hoy, -2)) return 'Anteayer';
  const d = new Date(`${ymd}T12:00:00Z`);
  const dia = d.toLocaleDateString('es-EC', { weekday: 'short', timeZone: 'UTC' }).replace('.', '');
  return `${dia} ${ymd.slice(8, 10)}/${ymd.slice(5, 7)}`;
}

/**
 * PASAR DE UN DÍA A OTRO (oct-2026), como en la agenda: «‹ Día anterior», el día,
 * «Día siguiente ›». Trabaja sobre un rango {from, to}: las flechas lo convierten
 * en UN día (el anterior/siguiente al último del rango: desde «30 días» lleva a
 * ayer). No pasa de hoy. «Hoy» lo pone cada página junto a sus atajos.
 *
 * Props: from, to (YYYY-MM-DD), onChange({ from, to }), max (por defecto hoy).
 */
export default function DayStepper({ from, to, onChange, max = todayEc() }) {
  const unDia = from === to;
  const base = to || max;
  const ir = (d) => onChange({ from: d, to: d });
  const siguiente = shift(base, 1);
  const btn = 'px-3 py-1.5 rounded-lg bg-white border border-slate-200 hover:bg-slate-50 cursor-pointer text-sm shrink-0 disabled:opacity-40 disabled:cursor-not-allowed';
  return (
    <div className="flex items-center gap-1.5">
      <button type="button" onClick={() => ir(shift(base, -1))} title="Día anterior" aria-label="Día anterior" className={btn}>
        <span className="md:hidden">‹</span>
        <span className="hidden md:inline">‹ Día anterior</span>
      </button>
      <span className="min-w-[5.5rem] text-center text-sm font-semibold text-slate-700 capitalize" aria-live="polite">
        {unDia ? nombreDelDia(from) : 'Varios días'}
      </span>
      <button type="button" onClick={() => ir(siguiente)} disabled={siguiente > max}
        title="Día siguiente" aria-label="Día siguiente" className={btn}>
        <span className="md:hidden">›</span>
        <span className="hidden md:inline">Día siguiente ›</span>
      </button>
    </div>
  );
}
