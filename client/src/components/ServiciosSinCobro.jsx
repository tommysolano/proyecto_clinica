import { conTipo } from '../utils/serviciosSinCobro';

const OPCIONES = [
  { kind: '', etiqueta: 'Se cobra', activa: 'bg-emerald-600 text-white border-emerald-600' },
  { kind: 'canje', etiqueta: 'Canje', activa: 'bg-amber-500 text-white border-amber-500' },
  { kind: 'cortesia', etiqueta: 'Cortesía', activa: 'bg-violet-600 text-white border-violet-600' },
];

/**
 * QUÉ SERVICIO DE LA VISITA SE COBRA (oct-2026).
 *
 * Con varios servicios en la misma cita, uno puede pagarse y otro ser canje o
 * cortesía. Cada fila es un servicio con «Se cobra / Canje / Cortesía». Si
 * todos quedan sin cobro, la visita entera es canje (o cortesía) — eso lo
 * decide el servidor (`aplicarValorDeCita`).
 *
 * Props: servicios [{id, name}], value [{serviceItem, kind}], onChange(lista), disabled
 */
export default function ServiciosSinCobro({ servicios = [], value = [], onChange, disabled = false, className = '' }) {
  if (servicios.length < 2) return null;
  const tipoDe = (id) => (value || []).find((e) => String(e.serviceItem) === String(id))?.kind || '';
  const sinCobro = servicios.filter((s) => tipoDe(s.id)).length;
  return (
    <div className={className}>
      <p className="m-0 mb-1.5 text-sm font-medium text-slate-700">¿Qué servicios se cobran?</p>
      <ul className="m-0 p-0 list-none divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
        {servicios.map((s) => {
          const actual = tipoDe(s.id);
          return (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span className={`text-sm min-w-0 ${actual ? 'text-slate-500' : 'text-slate-800'}`}>{s.name}</span>
              <span className="flex gap-1">
                {OPCIONES.map((o) => (
                  <button
                    key={o.kind || 'cobra'}
                    type="button"
                    disabled={disabled}
                    onClick={() => onChange(conTipo(value, s.id, o.kind))}
                    className={`px-2.5 py-1 rounded-lg border text-xs font-medium cursor-pointer disabled:opacity-50 ${
                      actual === o.kind ? o.activa : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    {o.etiqueta}
                  </button>
                ))}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="text-[11px] text-slate-400 mt-1 mb-0">
        {sinCobro === servicios.length
          ? 'Ningún servicio se cobra: la cita entera queda como canje/cortesía.'
          : sinCobro
            ? 'El valor de la cita es solo lo de los servicios que se cobran.'
            : 'Marca canje o cortesía solo en el servicio que no se paga.'}
      </p>
    </div>
  );
}
