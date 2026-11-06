import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import api from '../api/axios';
import toast from 'react-hot-toast';
import {
  HiOutlineArrowLeft, HiOutlineMegaphone, HiOutlineUserGroup,
  HiOutlineChatBubbleLeftRight, HiOutlineCalendarDays, HiOutlineHeart,
} from 'react-icons/hi2';
import { fmtDate, fmtDateTime } from '../utils/date';
import DateInput from '../components/DateInput';
import Paginador from '../components/Paginador';
import { STATUS_COLORS, STATUS_OPTIONS, money, statusLabel } from '../utils/commissionsFormat';

const lista = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const POR_PAGINA = 200;

/** Los tipos de agendamiento de marketing (ver `clasificarAgendamientos` en el servidor). */
const TIPOS = [
  { value: 'nuevo', label: 'Nuevos', badge: 'Nuevo', cls: 'bg-emerald-100 text-emerald-700', hint: 'Primera cita atendida del paciente: es la que paga comisión' },
  { value: 'recurrente', label: 'Recurrentes', badge: 'Recurrente', cls: 'bg-slate-200/70 text-slate-700', hint: 'El paciente ya se había atendido antes' },
  { value: 'nuevoSinAsistir', label: 'Nuevos sin asistir', badge: 'Nuevo sin asistir', cls: 'bg-amber-100 text-amber-700', hint: 'Paciente nuevo que todavía no ha asistido: cuenta cuando asista' },
  { value: 'reemplazada', label: 'Reemplazadas', badge: 'Reemplazada', cls: 'bg-slate-100 text-slate-500', hint: 'Faltó y se le agendó otra cita a la que sí asistió' },
];
const TIPO = Object.fromEntries(TIPOS.map((t) => [t.value, t]));

const irA = 'inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs border border-slate-200 bg-white text-slate-600 hover:text-emerald-700 hover:border-emerald-300 no-underline whitespace-nowrap';

/**
 * DETALLE DE MARKETING (nov-2026): los pacientes que agendó un agente de call
 * center (o todos, `/commissions/marketing/todos`), cita por cita, con su tipo
 * —nuevo, recurrente, sin asistir—, lo que se le facturó y lo que gana el agente.
 * Es el equivalente de «Ver citas» de los doctores: se abre en otra pestaña desde
 * Comisiones > Marketing y los filtros viven en la URL.
 */
export default function CommissionMarketingDetail() {
  const { agentId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const esGeneral = agentId === 'todos';
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [clinics, setClinics] = useState([]);

  const start = searchParams.get('start') || '';
  const end = searchParams.get('end') || '';
  const clinic = searchParams.get('clinic') || 'all';
  const fecha = searchParams.get('fecha') || 'cita';
  const tipoFilter = lista(searchParams.get('tipo'));
  const statusFilter = lista(searchParams.get('status'));
  const page = Math.max(parseInt(searchParams.get('page'), 10) || 1, 1);

  const setParam = (key, value) => {
    const next = new URLSearchParams(searchParams);
    if (key !== 'page') next.delete('page');
    if (value == null || value === '' || (Array.isArray(value) && !value.length)) next.delete(key);
    else next.set(key, Array.isArray(value) ? value.join(',') : value);
    setSearchParams(next, { replace: true });
  };
  const irAPagina = (n) => {
    setParam('page', n <= 1 ? '' : String(n));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const alternar = (key, actual, valor) => setParam(key, actual.includes(valor) ? actual.filter((x) => x !== valor) : [...actual, valor]);

  useEffect(() => {
    api.get('/clinics').then((r) => setClinics(r.data || [])).catch(() => {});
  }, []);

  useEffect(() => {
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const params = { limit: POR_PAGINA, page, agent: agentId };
        ['start', 'end', 'clinic', 'fecha', 'tipo', 'status'].forEach((k) => {
          if (searchParams.get(k)) params[k] = searchParams.get(k);
        });
        const res = await api.get('/commissions/callcenter-appointments', { params });
        setData(res.data);
      } catch (err) {
        toast.error(err.response?.data?.message || 'Error al cargar los pacientes');
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [agentId, searchParams.toString()]);

  const rows = data?.rows || [];
  const nombre = data?.agentName || searchParams.get('name') || 'Agente';

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm">
        <Link to="/commissions" className="inline-flex items-center gap-1 text-emerald-600 hover:underline">
          <HiOutlineArrowLeft className="w-4 h-4" /> Volver a Comisiones
        </Link>
      </div>

      <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
        {esGeneral ? (
          <><HiOutlineUserGroup className="text-emerald-600" /> Pacientes agendados por el call center</>
        ) : (
          <><HiOutlineMegaphone className="text-emerald-600" /> Pacientes agendados por {nombre}</>
        )}
      </h1>

      <div className="bg-white rounded-xl border border-slate-200 p-3 space-y-3">
        <div className="flex flex-wrap gap-3 items-end">
          <label className="text-sm">Desde
            <DateInput value={start} onChange={(e) => setParam('start', e.target.value)} className="block mt-1 border border-slate-200 rounded-xl px-2 py-1.5 text-sm" />
          </label>
          <label className="text-sm">Hasta
            <DateInput value={end} onChange={(e) => setParam('end', e.target.value)} className="block mt-1 border border-slate-200 rounded-xl px-2 py-1.5 text-sm" />
          </label>
          <label className="text-sm">Sucursal
            <select
              value={clinic}
              onChange={(e) => setParam('clinic', e.target.value)}
              className="block mt-1 border border-slate-200 rounded-xl px-2 py-1.5 text-sm min-w-[180px]"
            >
              <option value="all">Todas las sucursales</option>
              {clinics.map((c) => (
                <option key={c._id} value={c._id}>{c.nombreComercial || c.name}</option>
              ))}
            </select>
          </label>
          <label className="text-sm">Filtrar por
            <select
              value={fecha}
              onChange={(e) => setParam('fecha', e.target.value === 'cita' ? '' : e.target.value)}
              className="block mt-1 border border-slate-200 rounded-xl px-2 py-1.5 text-sm"
            >
              <option value="cita">Fecha de la cita</option>
              <option value="agendada">Fecha en que se agendó</option>
            </select>
          </label>
        </div>

        {/* TIPO: el contador de cada botón no depende de este filtro, así se ve
            cuántos hay de cada uno aunque se esté mirando solo a los nuevos. */}
        <div className="flex flex-wrap gap-1.5 items-center">
          <span className="text-xs text-slate-500">Paciente:</span>
          <button
            type="button"
            onClick={() => setParam('tipo', [])}
            className={`px-2.5 py-1 rounded-full text-xs cursor-pointer border-none ${
              !tipoFilter.length ? 'bg-slate-800 text-white font-semibold' : 'bg-slate-50 text-slate-500 border border-slate-200'
            }`}
          >
            Todos {data ? data.totals?.appointments ?? 0 : ''}
          </button>
          {TIPOS.map((t) => {
            const on = tipoFilter.includes(t.value);
            return (
              <button
                key={t.value}
                type="button"
                title={t.hint}
                onClick={() => alternar('tipo', tipoFilter, t.value)}
                className={`px-2.5 py-1 rounded-full text-xs cursor-pointer border-none ${
                  on ? `${t.cls} font-semibold ring-1 ring-current` : 'bg-slate-50 text-slate-500 border border-slate-200'
                }`}
              >
                {t.label} {data?.counts?.[t.value] ?? ''}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap gap-1.5 items-center">
          <span className="text-xs text-slate-500">Estado de la cita:</span>
          {STATUS_OPTIONS.map((s) => {
            const on = statusFilter.includes(s.value);
            return (
              <button
                key={s.value}
                type="button"
                onClick={() => alternar('status', statusFilter, s.value)}
                className={`px-2.5 py-1 rounded-full text-xs cursor-pointer border-none ${
                  on ? `${STATUS_COLORS[s.value]} font-semibold` : 'bg-slate-50 text-slate-400 border border-slate-200'
                }`}
              >
                {s.label}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setParam('status', ['asistida', 'completada'])}
            className="text-xs text-emerald-600 hover:underline bg-transparent border-none cursor-pointer px-1"
          >
            Solo atendidos
          </button>
          {statusFilter.length > 0 && (
            <button
              type="button"
              onClick={() => setParam('status', [])}
              className="text-xs text-slate-500 hover:underline bg-transparent border-none cursor-pointer px-1"
            >
              Todos los estados
            </button>
          )}
        </div>
      </div>

      {data && (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-slate-500 m-0">
            {fmtDate(data.start)} — {fmtDate(data.end)} · <b>{data.pagination?.total ?? rows.length}</b> cita(s) en el filtro
          </p>
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 text-emerald-800 px-3 py-1 text-sm font-semibold">
            Nuevos: {data.counts?.nuevo ?? 0}
          </span>
          <span
            title="Lo que gana por los pacientes nuevos del período, con la tarifa vigente el día en que cada uno asistió"
            className="inline-flex items-center gap-1 rounded-full bg-sky-100 text-sky-800 px-3 py-1 text-sm font-semibold"
          >
            Comisión: {money(data.totals?.ganado || 0)}
          </span>
        </div>
      )}

      {loading && <div className="text-slate-500">Cargando...</div>}

      {data && <Paginador pagination={data.pagination} onPage={irAPagina} unidad="citas" />}

      {data && (rows.length > 0 ? (
        <div className="tbl-wrap">
          <div className="tbl-scroll">
            <table className={`tbl tbl-cards text-sm ${loading ? 'opacity-60' : ''}`}>
              <thead>
                <tr>
                  <th>Cita</th>
                  <th>Paciente</th>
                  {esGeneral && <th>Agendado por</th>}
                  <th>Servicios agendados</th>
                  <th>Estado</th>
                  <th>Facturado en la cita</th>
                  <th>Comisión</th>
                  <th>Ir a</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const t = TIPO[r.tipo];
                  return (
                    <tr key={r.appointmentId}>
                      <td data-cell="detalle">
                        <span className="whitespace-nowrap">{fmtDate(r.appointmentDate)}{r.startTime ? ` ${r.startTime}` : ''}</span>
                        {r.clinic && <span className="block text-[11px] text-slate-500">{r.clinic}</span>}
                        <span className="block text-[11px] text-slate-400">Agendada el {fmtDateTime(r.scheduledAt)}</span>
                      </td>
                      <td data-cell="principal">
                        <span className="font-medium text-slate-800">{r.patient}</span>
                        {t && (
                          <span title={t.hint} className={`ml-1.5 inline-flex px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${t.cls}`}>
                            {t.badge}
                          </span>
                        )}
                        {r.patientRegisteredAt && (
                          <span className="block text-[11px] text-slate-400">Registrado el {fmtDate(r.patientRegisteredAt)}</span>
                        )}
                      </td>
                      {esGeneral && <td data-cell="detalle">{r.agent}</td>}
                      <td data-cell="detalle">
                        <span className="md:hidden text-slate-400">Servicios: </span>
                        {r.services.length ? r.services.join(', ') : <span className="text-slate-300">—</span>}
                      </td>
                      <td data-cell="estado">
                        <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold ${STATUS_COLORS[r.status] || 'bg-slate-100 text-slate-600'}`}>
                          {statusLabel(r.status)}
                        </span>
                        {r.attendedAt && (
                          <span className="block text-[11px] text-slate-400 mt-0.5">Asistió el {fmtDate(r.attendedAt)}</span>
                        )}
                      </td>
                      <td data-cell="detalle">
                        <span className="md:hidden text-slate-400">Facturado: </span>
                        {r.billedTotal != null ? (
                          <>
                            <b className="tabular-nums">{money(r.billedTotal)}</b>
                            <span className="block text-[11px] text-slate-500">{r.billedItems.join(', ')}</span>
                            {r.saleNumbers.length > 0 && (
                              <span className="block text-[11px] text-slate-400 font-mono">{r.saleNumbers.join(', ')}</span>
                            )}
                          </>
                        ) : (
                          <span className="text-slate-400 text-xs">Sin factura</span>
                        )}
                      </td>
                      <td data-cell="detalle">
                        <span className="md:hidden text-slate-400">Comisión: </span>
                        {r.tipo !== 'nuevo' ? (
                          <span className="text-slate-300">—</span>
                        ) : r.commission != null ? (
                          <b className="text-emerald-700 tabular-nums">{money(r.commission)}</b>
                        ) : (
                          <span className="text-slate-400 text-xs" title="No había tarifa vigente el día en que asistió">Sin tarifa</span>
                        )}
                      </td>
                      <td data-cell="acciones">
                        <div className="flex flex-wrap gap-1">
                          {r.chatId ? (
                            <Link to={`/chats?chat=${r.chatId}`} target="_blank" rel="noopener" className={irA} title="Abrir el chat del paciente">
                              <HiOutlineChatBubbleLeftRight className="w-3.5 h-3.5" /> Chat
                            </Link>
                          ) : (
                            <span className={`${irA} opacity-40 cursor-not-allowed`} title="Este paciente no tiene chat">
                              <HiOutlineChatBubbleLeftRight className="w-3.5 h-3.5" /> Chat
                            </span>
                          )}
                          <Link to={`/appointments?cita=${r.appointmentId}`} target="_blank" rel="noopener" className={irA} title="Abrir la cita">
                            <HiOutlineCalendarDays className="w-3.5 h-3.5" /> Cita
                          </Link>
                          {r.patientId && (
                            <Link to={`/patients/${r.patientId}?tab=seguimientos`} target="_blank" rel="noopener" className={irA} title="Ver los seguimientos del paciente">
                              <HiOutlineHeart className="w-3.5 h-3.5" /> Seguimientos
                            </Link>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 px-4 py-6 text-center text-slate-400">
          Sin pacientes en el período con los filtros aplicados.
        </div>
      ))}

      {data && rows.length > 0 && <Paginador pagination={data.pagination} onPage={irAPagina} unidad="citas" />}
    </div>
  );
}
