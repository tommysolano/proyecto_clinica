import { useState } from 'react';
import { HiOutlineChevronDown, HiOutlineChevronRight } from 'react-icons/hi2';
import { fmt } from './_utils';

/**
 * Matriz del flujo diario: fechas en columnas, categorías en filas.
 *
 * No calcula NADA: todos los saldos vienen ya sumados de la API (un único motor). Aquí solo
 * se dibujan, se colorea el déficit y se abre el detalle al pulsar una celda.
 */

const dow = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const cabecera = (k) => {
  const [y, m, d] = k.split('-').map(Number);
  const fecha = new Date(y, m - 1, d);
  return { dia: `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`, semana: dow[fecha.getDay()] };
};

const Celda = ({ value, onClick, className = '' }) => (
  <td className={`px-2 py-1.5 text-right font-mono text-xs whitespace-nowrap ${className}`}>
    {value ? (
      <button
        onClick={onClick}
        className="bg-transparent border-none p-0 font-mono text-xs text-slate-700 hover:text-emerald-700 hover:underline cursor-pointer"
      >
        {fmt(value)}
      </button>
    ) : <span className="text-slate-300">—</span>}
  </td>
);

export default function CashFlowMatrix({ data, onCell }) {
  const [abiertas, setAbiertas] = useState({});
  const dias = data.days;
  const cats = data.config.categories;
  const toggle = (k) => setAbiertas((s) => ({ ...s, [k]: !s[k] }));

  const valor = (d, dir, cat, sub) => {
    const c = d.categorias?.[dir]?.[cat];
    if (!c) return 0;
    return sub ? (c.subs?.[sub] || 0) : c.total;
  };
  const tieneDatos = (dir, cat, sub) =>
    data.config.showEmptyCategories || dias.some((d) => valor(d, dir, cat.key, sub));

  // Función que devuelve FILAS (no un componente): declarar un componente dentro del render
  // lo recrearía en cada pintado y perdería su estado.
  const filasSeccion = (direction, titulo, color) => [
    <tr key={`${direction}:head`} className={color}>
      <th className="sticky left-0 z-10 px-3 py-1.5 text-left text-xs font-bold uppercase tracking-wide" style={{ background: 'inherit' }}>
        {titulo}
      </th>
      {dias.map((d) => <td key={d.date} />)}
    </tr>,
    ...(cats?.[direction] || [])
      .filter((c) => c.isActive !== false && tieneDatos(direction, c))
      .flatMap((cat) => {
        const subs = (cat.subcategories || []).filter((s) => s.isActive !== false && tieneDatos(direction, cat, s.key));
        const abierta = abiertas[`${direction}:${cat.key}`];
        const filas = [
          <tr key={`${direction}:${cat.key}`} className="border-t border-slate-100 hover:bg-slate-50">
            <th className="sticky left-0 z-10 bg-white px-3 py-1.5 text-left text-xs font-semibold text-slate-700">
              <span className="flex items-center gap-1">
                {subs.length > 0 ? (
                  <button
                    onClick={() => toggle(`${direction}:${cat.key}`)}
                    className="bg-transparent border-none p-0 text-slate-400 hover:text-slate-700 cursor-pointer flex items-center"
                    aria-label={abierta ? 'Contraer' : 'Expandir'}
                  >
                    {abierta ? <HiOutlineChevronDown className="w-3.5 h-3.5" /> : <HiOutlineChevronRight className="w-3.5 h-3.5" />}
                  </button>
                ) : <span className="w-3.5" />}
                {cat.label}
                {cat.isLoan && <span className="text-[9px] font-bold text-violet-600 bg-violet-50 px-1 rounded">PRÉSTAMO</span>}
              </span>
            </th>
            {dias.map((d) => (
              <Celda
                key={d.date}
                value={valor(d, direction, cat.key)}
                onClick={() => onCell({ date: d.date, direction, category: cat.key, label: cat.label })}
              />
            ))}
          </tr>,
        ];
        if (abierta) {
          for (const s of subs) {
            filas.push(
              <tr key={`${direction}:${cat.key}:${s.key}`} className="border-t border-slate-50 bg-slate-50/40">
                <th className="sticky left-0 z-10 bg-slate-50 px-3 py-1 pl-9 text-left text-[11px] font-normal text-slate-500">
                  {s.label}
                </th>
                {dias.map((d) => (
                  <Celda
                    key={d.date}
                    value={valor(d, direction, cat.key, s.key)}
                    className="text-slate-500"
                    onClick={() => onCell({
                      date: d.date, direction, category: cat.key, subcategory: s.key,
                      label: `${cat.label} · ${s.label}`,
                    })}
                  />
                ))}
              </tr>
            );
          }
        }
        return filas;
      }),
    <tr key={`${direction}:total`} className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
      <th className="sticky left-0 z-10 bg-slate-50 px-3 py-1.5 text-left text-xs text-slate-700">
        {direction === 'INGRESO' ? 'Total ingresos' : 'Total egresos'}
      </th>
      {dias.map((d) => (
        <td key={d.date} className="px-2 py-1.5 text-right font-mono text-xs whitespace-nowrap text-slate-800">
          {direction === 'INGRESO' ? (d.ingresos ? fmt(d.ingresos) : '—') : (d.egresos ? fmt(d.egresos) : '—')}
        </td>
      ))}
    </tr>,
  ];

  return (
    <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="min-w-full border-collapse">
          <thead className="sticky top-0 z-20">
            <tr className="bg-slate-800 text-white">
              <th className="sticky left-0 z-30 bg-slate-800 px-3 py-2 text-left text-xs font-semibold min-w-[240px]">
                Concepto
              </th>
              {dias.map((d) => {
                const h = cabecera(d.date);
                return (
                  <th key={d.date} className="px-2 py-2 text-right text-xs font-semibold whitespace-nowrap min-w-[92px]">
                    <div>{h.dia}</div>
                    <div className="text-[10px] font-normal text-slate-300">{h.semana}</div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            <tr className="bg-slate-100 font-semibold">
              <th className="sticky left-0 z-10 bg-slate-100 px-3 py-2 text-left text-xs text-slate-700">
                Saldo bancario inicial
              </th>
              {dias.map((d) => (
                <td key={d.date} className="px-2 py-2 text-right font-mono text-xs whitespace-nowrap text-slate-700">
                  {fmt(d.saldoInicial)}
                </td>
              ))}
            </tr>

            {filasSeccion('INGRESO', 'Ingresos', 'bg-emerald-50 text-emerald-800')}
            {filasSeccion('EGRESO', 'Egresos', 'bg-rose-50 text-rose-800')}

            {/* Neutral: un traspaso entre cuentas propias cambia el dinero de sitio pero no
                entra ni sale. Se muestra para poder verlo, pero NO suma a ingresos ni egresos
                y por eso no altera el saldo proyectado. */}
            {dias.some((d) => d.transferenciasInternas) && (
              <tr className="border-t border-slate-200 bg-slate-50/70">
                <th className="sticky left-0 z-10 bg-slate-50 px-3 py-1.5 text-left text-xs font-normal text-slate-500">
                  <span className="flex items-center gap-1">
                    Transferencias internas
                    <span className="text-[9px] font-bold text-slate-500 bg-slate-200 px-1 rounded">NO SUMA</span>
                  </span>
                </th>
                {dias.map((d) => (
                  <td key={d.date} className="px-2 py-1.5 text-right font-mono text-xs whitespace-nowrap text-slate-400"
                    title="Traspaso entre cuentas propias: no es ingreso ni egreso">
                    {d.transferenciasInternas ? fmt(d.transferenciasInternas) : '—'}
                  </td>
                ))}
              </tr>
            )}

            <tr className="border-t-2 border-slate-800 bg-blue-50">
              <th className="sticky left-0 z-10 bg-blue-50 px-3 py-2.5 text-left text-xs font-bold text-slate-800">
                Saldo proyectado
              </th>
              {dias.map((d) => (
                <td
                  key={d.date}
                  className={`px-2 py-2.5 text-right font-mono text-xs font-bold whitespace-nowrap ${
                    d.saldoFinal < 0 ? 'bg-rose-100 text-rose-700' : 'text-slate-800'
                  }`}
                  // El color no es la única señal: el negativo también va entre paréntesis.
                  title={d.saldoFinal < 0 ? 'Saldo negativo' : ''}
                >
                  {d.saldoFinal < 0 ? `(${fmt(Math.abs(d.saldoFinal))})` : fmt(d.saldoFinal)}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
