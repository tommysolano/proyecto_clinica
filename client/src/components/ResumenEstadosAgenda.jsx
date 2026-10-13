import { useState } from 'react';
import { HiOutlineChevronDown, HiOutlineBuildingOffice2 } from 'react-icons/hi2';
import { ESTADOS_RESUMEN } from '../utils/agendaResumen';

/**
 * RESUMEN DE LA AGENDA POR ESTADO Y POR SUCURSAL (oct-2026).
 *
 * Encima del calendario (el mes) y de la lista (el día): cuántas citas hay en
 * total y cuántas pendientes, confirmadas, asistidas, completadas, sin asistir
 * y canceladas; con «Por sucursal» el mismo desglose sede por sede. Respeta los
 * filtros de la agenda: cuenta lo mismo que se está mirando.
 *
 * `resumen` = { total, estados: {pendiente…}, sucursales: [{ id, nombre, total, pendiente… }] }
 */
const CLAVE_ABIERTO = 'agenda.resumenPorSucursal';
const leerAbierto = () => {
  try { return localStorage.getItem(CLAVE_ABIERTO) === '1'; } catch { return false; }
};

export default function ResumenEstadosAgenda({ resumen, titulo, cargando = false }) {
  const [porSucursal, setPorSucursal] = useState(leerAbierto);
  const alternar = () => {
    setPorSucursal((v) => {
      try { localStorage.setItem(CLAVE_ABIERTO, v ? '0' : '1'); } catch { /* sin almacenamiento */ }
      return !v;
    });
  };
  const sucursales = [...(resumen?.sucursales || [])].sort((a, b) => b.total - a.total);

  return (
    <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 mb-3 md:mb-4 p-2.5 md:p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <p className="m-0 text-xs font-semibold text-slate-600 uppercase tracking-wide">
          {titulo}{cargando && <span className="ml-2 normal-case font-normal text-slate-400">Actualizando…</span>}
        </p>
        {sucursales.length > 0 && (
          <button
            type="button"
            onClick={alternar}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium cursor-pointer border ${
              porSucursal ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-600 border-slate-200 hover:bg-emerald-50'
            }`}
          >
            <HiOutlineBuildingOffice2 className="w-3.5 h-3.5" /> Por sucursal
            <HiOutlineChevronDown className={`w-3 h-3 transition-transform ${porSucursal ? 'rotate-180' : ''}`} />
          </button>
        )}
      </div>

      <div className="grid grid-cols-4 sm:grid-cols-7 gap-1.5">
        <div className="rounded-xl border border-slate-200 bg-slate-800 px-2 py-1.5 min-w-0">
          <div className="text-[10px] text-slate-300 truncate">Total</div>
          <div className="text-lg font-bold text-white leading-tight">{resumen?.total || 0}</div>
        </div>
        {ESTADOS_RESUMEN.map(([k, label, texto, fondo]) => (
          <div key={k} className={`rounded-xl border px-2 py-1.5 min-w-0 ${fondo}`}>
            <div className="text-[10px] text-slate-500 truncate">{label}</div>
            <div className={`text-lg font-bold leading-tight ${texto}`}>{resumen?.estados?.[k] || 0}</div>
          </div>
        ))}
      </div>

      {porSucursal && sucursales.length > 0 && (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-slate-500">
              <tr>
                <th className="text-left px-2 py-1.5 font-medium">Sucursal</th>
                <th className="text-right px-2 py-1.5 font-medium">Total</th>
                {ESTADOS_RESUMEN.map(([k, label]) => (
                  <th key={k} className="text-right px-2 py-1.5 font-medium whitespace-nowrap">{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sucursales.map((s) => (
                <tr key={s.id} className="border-t border-slate-100">
                  <td className="px-2 py-1.5 text-slate-800 font-medium whitespace-nowrap">{s.nombre}</td>
                  <td className="px-2 py-1.5 text-right font-bold text-slate-800">{s.total}</td>
                  {ESTADOS_RESUMEN.map(([k, , texto]) => (
                    <td key={k} className={`px-2 py-1.5 text-right ${s[k] ? texto : 'text-slate-300'}`}>{s[k] || 0}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
