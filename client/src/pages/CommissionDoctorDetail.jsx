import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import api from '../api/axios';
import toast from 'react-hot-toast';
import { HiOutlineArrowLeft, HiOutlineCurrencyDollar, HiOutlineUserGroup } from 'react-icons/hi2';
import { fmtDate } from '../utils/date';
import {
  STATUS_COLORS,
  STATUS_OPTIONS,
  fmtAtendientes,
  fmtPago,
  statusLabel,
} from '../utils/commissionsFormat';

export default function CommissionDoctorDetail() {
  const { doctorId } = useParams();
  const [searchParams] = useSearchParams();
  /**
   * EL DETALLE GENERAL (sep-2026): `/commissions/todos` enseña TODAS las citas
   * de todos los doctores —la misma información del detalle de un doctor, pero
   * sin el corte por profesional—, respetando los demás filtros (fechas,
   * sucursal, estados y servicios).
   */
  const esGeneral = doctorId === 'todos';
  const doctorName = searchParams.get('name') || 'Doctor';
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const params = {};
        ['start', 'end', 'clinic', 'status', 'service'].forEach((k) => {
          if (searchParams.get(k)) params[k] = searchParams.get(k);
        });
        // El corte por doctor SOLO cuando hay doctor; en el modo general el
        // servidor devuelve las citas de todos los que cumplan los filtros.
        if (!esGeneral) params.doctor = doctorId;
        const res = await api.get('/commissions/doctor-appointments', { params });
        setData(res.data);
      } catch (err) {
        toast.error(err.response?.data?.message || 'Error al cargar el detalle');
      } finally {
        setLoading(false);
      }
    })();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [doctorId]);

  const citas = data?.appointments || [];
  /**
   * Las derivaciones: del doctor en el modo individual; TODAS, aplanadas, en el
   * general (cada fila lleva quién derivó en su columna nueva).
   */
  const derivaciones = esGeneral
    ? Object.values(data?.referralsByDoctor || {}).flat()
    : data?.referralsByDoctor?.[doctorId] || [];
  const nombreReal = data?.doctorNames?.[doctorId] || doctorName;
  const totalPagos = Number(data?.totals?.payments || 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm">
        <Link
          to="/commissions"
          className="inline-flex items-center gap-1 text-emerald-600 hover:underline bg-transparent border-none cursor-pointer"
        >
          <HiOutlineArrowLeft className="w-4 h-4" /> Volver a Comisiones
        </Link>
      </div>

      <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
        {esGeneral ? (
          <>
            <HiOutlineUserGroup className="text-emerald-600" /> Citas de todos los doctores
          </>
        ) : (
          <>
            <HiOutlineCurrencyDollar className="text-emerald-600" /> Citas de {nombreReal}
          </>
        )}
      </h1>
      {data && (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-slate-500">
            {fmtDate(data.start)} — {fmtDate(data.end)} · <b>{citas.length}</b> citas en el filtro
          </p>
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 text-emerald-800 px-3 py-1 text-sm font-semibold">
            Total pagos: ${totalPagos.toFixed(2)}
          </span>
        </div>
      )}

      {loading && <div className="text-slate-500">Cargando...</div>}

      {data && (
        <div className="space-y-4">
          {citas.length > 0 ? (
            <div className="overflow-x-auto bg-white rounded-xl border border-slate-200">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="text-left px-3 py-2 whitespace-nowrap">Fecha</th>
                    <th className="text-left px-3 py-2">Paciente</th>
                    <th className="text-left px-3 py-2">Servicios</th>
                    <th className="text-left px-3 py-2">Estado</th>
                    <th className="text-left px-3 py-2">Atendida por</th>
                    <th className="text-left px-3 py-2">Pago</th>
                    <th className="text-left px-3 py-2">Seguimiento</th>
                  </tr>
                </thead>
                <tbody>
                  {citas.map((a) => (
                    <tr key={a.id} className="border-t border-slate-100 align-top">
                      <td className="px-3 py-2 whitespace-nowrap text-slate-600">
                        {fmtDate(a.date)}
                        {a.startTime ? <span className="text-slate-400"> {a.startTime}</span> : null}
                        {a.clinic ? <span className="block text-[10px] text-slate-400">{a.clinic}</span> : null}
                      </td>
                      <td className="px-3 py-2">
                        <span className="text-slate-800 font-medium">{a.patient}</span>
                        {a.visitsTotal > 1 ? (
                          <span
                            title={`Este doctor atendió ${a.visitsTotal} veces a este paciente en el filtro`}
                            className="ml-1 px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 text-[10px] font-semibold"
                          >
                            visita {a.visitNumber}/{a.visitsTotal}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-slate-600">{a.services?.join(', ') || '—'}</td>
                      <td className="px-3 py-2">
                        <span className={`px-2 py-0.5 rounded-full font-semibold ${STATUS_COLORS[a.status] || 'bg-slate-100 text-slate-600'}`}>
                          {statusLabel(a.status)}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-slate-600">
                        {fmtAtendientes(a) || '—'}
                        {/* En el detalle GENERAL la fila dice de quién era la
                            cita: es lo que sin esto no se sabría al mezclar
                            doctores. */}
                        {esGeneral && a.doctorName && (
                          <span className="block text-[10px] text-emerald-700 font-semibold mt-0.5">
                            Dr. {a.doctorName}
                          </span>
                        )}
                        {a.multiprofesional && (
                          <span className="block text-[10px] text-amber-700 font-semibold mt-0.5">
                            Atendida por {a.atendientes.filter((t) => t.kind === 'doctor').length} doctores
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{fmtPago(a)}</td>
                      <td className="px-3 py-2 min-w-[220px]">
                        {(a.seguimientos || []).length > 0 ? (
                          <div className="space-y-1">
                            {a.seguimientos.map((s, i) => (
                              <div key={i} className="bg-violet-50 border border-violet-200 rounded-lg px-2 py-1.5">
                                {s.motivoConsulta && (
                                  <div className="text-[10px] text-slate-400 uppercase tracking-wide mb-0.5">
                                    {s.motivoConsulta}
                                  </div>
                                )}
                                {s.sueros > 0 && (
                                  <div className="text-violet-700 text-xs">
                                    <b>Suero(s) recetados: ×{s.sueros}</b>
                                  </div>
                                )}
                                {(s.otros || []).length > 0 && (
                                  <div className="text-slate-600 text-xs">
                                    <span className="text-slate-400">Receta:</span> {s.otros.join(', ')}
                                  </div>
                                )}
                                {s.sueros === 0 && (s.otros || []).length === 0 && (
                                  <div className="text-[10px] text-slate-400">Seguimiento sin receta</div>
                                )}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-emerald-50 border-t-2 border-emerald-200">
                  <tr>
                    <td colSpan={5} className="px-3 py-2 text-right font-semibold text-emerald-800">Total pagos</td>
                    <td className="px-3 py-2 whitespace-nowrap font-bold text-emerald-800">${totalPagos.toFixed(2)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-slate-200 px-4 py-6 text-center text-slate-400">
              Sin citas en el período con los filtros aplicados.
            </div>
          )}

          {derivaciones.length > 0 && (
            <div className="bg-white rounded-xl border border-slate-200 px-4 py-3">
              <p className="text-xs font-semibold text-violet-700 uppercase tracking-wide mb-2">
                Derivaciones añadidas ({derivaciones.length})
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-slate-500">
                    <tr>
                      {esGeneral && <th className="text-left px-2 py-1">Doctor que derivó</th>}
                      <th className="text-left px-2 py-1">Paciente</th>
                      <th className="text-left px-2 py-1">Derivado a</th>
                      <th className="text-left px-2 py-1">Motivo</th>
                      <th className="text-left px-2 py-1">Fecha</th>
                      <th className="text-left px-2 py-1">Estado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {derivaciones.map((r) => (
                      <tr key={r.id} className="border-t border-slate-100">
                        {esGeneral && (
                          <td className="px-2 py-1.5 text-slate-800 font-medium">{r.fromDoctor || '—'}</td>
                        )}
                        <td className="px-2 py-1.5 text-slate-800">{r.patient}</td>
                        <td className="px-2 py-1.5 text-slate-600">{r.toDoctor || r.specialty || '—'}</td>
                        <td className="px-2 py-1.5 text-slate-500">{r.reason || '—'}</td>
                        <td className="px-2 py-1.5 text-slate-500">{fmtDate(r.date)}</td>
                        <td className="px-2 py-1.5">
                          <span className={`px-2 py-0.5 rounded-full font-semibold ${
                            r.status === 'atendida' ? 'bg-emerald-100 text-emerald-700'
                              : r.status === 'cancelada' ? 'bg-red-100 text-red-600'
                              : r.status === 'agendada' ? 'bg-blue-100 text-blue-700'
                              : 'bg-slate-100 text-slate-500'
                          }`}>
                            {r.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
