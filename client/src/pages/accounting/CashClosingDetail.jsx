import { Fragment, useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts';
import {
  HiOutlineCalculator, HiOutlinePrinter, HiOutlineChevronDown, HiOutlineChevronRight, HiOutlineArrowTopRightOnSquare,
  HiOutlinePlus, HiOutlineXMark,
} from 'react-icons/hi2';
import api from '../../api/axios';
import { useAuth } from '../../context/AuthContext';
import DateInput from '../../components/DateInput';
import { fmt, fmtDate } from './_utils';

/**
 * Detalle de una sesión de caja (se abre en pestaña nueva desde Caja → ojo): todo lo vendido
 * en ella —ventas con su factura, servicios y productos, cobros por método, por hora, por
 * vendedor y por doctor— con gráficas, más el cuadre y los movimientos de caja.
 */

const METODO = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia', credito: 'Crédito', anticipo: 'Anticipo', otro: 'Otro' };
const TIPO_TARJETA = { DEBITO: 'débito', CREDITO: 'crédito', CORRIENTE: 'corriente' };
/** «Tarjeta crédito $20.00», «Transferencia $15.00 (N° 123)»… */
const etiquetaPago = (p) => `${METODO[p.method] || p.method}${TIPO_TARJETA[p.cardType] ? ` ${TIPO_TARJETA[p.cardType]}` : ''} ${money(p.amount)}${p.reference ? ` (N° ${p.reference})` : ''}`;
const TIPO = { servicio: 'Servicios', programa: 'Programas', producto: 'Productos' };
const COLORS = ['#059669', '#0284c7', '#7c3aed', '#d97706', '#e11d48', '#475569'];
const TIPO_COLOR = { servicio: '#0284c7', programa: '#7c3aed', producto: '#059669' };

const fmtHora = (d) => (d ? new Date(d).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Guayaquil' }) : '');
const fmtFechaHora = (d) => (d ? `${fmtDate(d)} ${fmtHora(d)}` : '—');
const money = (v) => `$${fmt(v)}`;

function Kpi({ label, value, hint, tone = 'slate' }) {
  const tones = {
    slate: 'bg-slate-50 text-slate-800', emerald: 'bg-emerald-50 text-emerald-800', sky: 'bg-sky-50 text-sky-800',
    violet: 'bg-violet-50 text-violet-800', amber: 'bg-amber-50 text-amber-800', rose: 'bg-rose-50 text-rose-800',
  };
  return (
    <div className={`rounded-xl p-3 ${tones[tone]}`}>
      <p className="text-[11px] uppercase tracking-wide opacity-70">{label}</p>
      <p className="text-xl font-bold font-mono">{value}</p>
      {hint && <p className="text-[11px] opacity-70 mt-0.5">{hint}</p>}
    </div>
  );
}

function Card({ title, children, right }) {
  return (
    <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-slate-200 p-4">
      <div className="flex items-center justify-between mb-3 gap-2">
        <h2 className="text-sm font-semibold text-slate-700">{title}</h2>
        {right}
      </div>
      {children}
    </div>
  );
}

const Vacio = ({ children = 'Sin datos' }) => <p className="text-xs text-slate-400 py-6 text-center">{children}</p>;

const ymd = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};

/**
 * SUMAR CAJAS (solo super administrador): elige otras cajas —de cualquier sucursal— para
 * ver todo junto. Arranca con las del mismo día de la caja abierta.
 */
function SumarCajas({ baseId, baseDate, selected, onApply, onClose }) {
  const [filters, setFilters] = useState({ startDate: ymd(baseDate), endDate: ymd(baseDate) });
  const [list, setList] = useState(null);
  const [marcadas, setMarcadas] = useState(() => new Set(selected));

  useEffect(() => {
    api.get('/cash-closings', { params: { clinic: 'all', ...filters } })
      .then((r) => setList((r.data || []).filter((x) => String(x._id) !== String(baseId) && x.status !== 'ANULADO')))
      .catch(() => setList([]));
  }, [filters, baseId]);

  const toggle = (cid) => setMarcadas((s) => {
    const n = new Set(s);
    if (n.has(cid)) n.delete(cid); else n.add(cid);
    return n;
  });
  const todasMarcadas = !!list?.length && list.every((x) => marcadas.has(String(x._id)));

  return (
    <Card
      title="Sumar otras cajas"
      right={<button onClick={onClose} className="text-slate-400 hover:text-slate-600 bg-transparent border-none cursor-pointer" title="Cerrar"><HiOutlineXMark className="w-5 h-5" /></button>}
    >
      <div className="flex flex-wrap items-end gap-3 mb-3">
        <label className="text-xs text-slate-500 block">Desde
          <DateInput value={filters.startDate} onChange={(e) => setFilters({ ...filters, startDate: e.target.value })} className="mt-1" />
        </label>
        <label className="text-xs text-slate-500 block">Hasta
          <DateInput value={filters.endDate} onChange={(e) => setFilters({ ...filters, endDate: e.target.value })} className="mt-1" />
        </label>
        {!!list?.length && (
          <button
            type="button"
            onClick={() => setMarcadas((s) => {
              const n = new Set(s);
              list.forEach((x) => (todasMarcadas ? n.delete(String(x._id)) : n.add(String(x._id))));
              return n;
            })}
            className="text-xs font-medium text-emerald-700 bg-white border border-emerald-200 rounded-lg px-2.5 py-1.5 cursor-pointer hover:bg-emerald-50"
          >
            {todasMarcadas ? 'Quitar todas' : 'Marcar todas'}
          </button>
        )}
      </div>
      {list === null ? <Vacio>Cargando cajas…</Vacio> : !list.length ? <Vacio>No hay otras cajas en esas fechas</Vacio> : (
        <div className="max-h-72 overflow-y-auto border border-slate-100 rounded-lg">
          <table className="tbl text-sm">
            <thead className="bg-slate-50 text-xs uppercase sticky top-0"><tr>
              <th className="px-2 py-1.5 w-8"></th><th className="px-2 py-1.5 text-left">Fecha</th>
              <th className="px-2 py-1.5 text-left">Sucursal</th><th className="px-2 py-1.5 text-left">Caja</th>
              <th className="px-2 py-1.5 text-left">Cajero</th><th className="px-2 py-1.5 text-right">Ventas</th>
              <th className="px-2 py-1.5 text-center">Estado</th>
            </tr></thead>
            <tbody>
              {list.map((x) => {
                const cid = String(x._id);
                return (
                  <tr key={cid} onClick={() => toggle(cid)} className={`border-t border-slate-100 cursor-pointer ${marcadas.has(cid) ? 'bg-emerald-50' : 'hover:bg-slate-50'}`}>
                    <td className="px-2 py-1.5"><input type="checkbox" readOnly checked={marcadas.has(cid)} className="accent-emerald-600" /></td>
                    <td className="px-2 py-1.5">{fmtDate(x.date)}</td>
                    <td className="px-2 py-1.5 text-xs">{x.clinic?.name || '—'}</td>
                    <td className="px-2 py-1.5 text-xs font-mono">{x.puntoEmision ? `${x.puntoEmision.establecimiento}-${x.puntoEmision.codigo}` : '—'}</td>
                    <td className="px-2 py-1.5 text-xs">{x.openedBy?.name || x.closedBy?.name || '—'}</td>
                    <td className="px-2 py-1.5 text-right font-mono">{x.status === 'ABIERTA' ? 'en curso' : money(x.totalSales)}</td>
                    <td className="px-2 py-1.5 text-center text-[11px]">{x.status}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex justify-end gap-2 mt-3">
        <button type="button" onClick={onClose} className="px-4 py-2 bg-slate-100 rounded-xl border-none cursor-pointer text-sm">Cancelar</button>
        <button type="button" onClick={() => onApply([...marcadas])} className="px-4 py-2 bg-emerald-600 text-white rounded-xl border-none cursor-pointer text-sm hover:bg-emerald-700">
          Ver {marcadas.size + 1} caja{marcadas.size ? 's' : ''} juntas
        </button>
      </div>
    </Card>
  );
}

export default function CashClosingDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const add = searchParams.get('add') || '';
  const sumadas = useMemo(() => add.split(',').filter(Boolean), [add]);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [itemTab, setItemTab] = useState('todos');
  const [abiertas, setAbiertas] = useState({});
  const [sumarOpen, setSumarOpen] = useState(false);

  useEffect(() => {
    api.get(`/cash-closings/${id}/detail`, { params: add ? { add } : {} })
      .then((r) => setData(r.data))
      .catch((e) => {
        const msg = e.response?.data?.message || 'No se pudo cargar la caja';
        setError(msg);
        toast.error(msg);
      });
  }, [id, add]);

  const aplicarSuma = (ids) => {
    setSumarOpen(false);
    setSearchParams(ids.length ? { add: ids.join(',') } : {});
  };
  const quitarCaja = (cid) => aplicarSuma(sumadas.filter((x) => x !== String(cid)));

  const c = data?.closing;
  const varias = (data?.closings?.length || 0) > 1;
  useEffect(() => {
    if (!c) return;
    document.title = varias
      ? `${data.closings.length} cajas · ${fmtDate(data.range.start)}`
      : `Caja ${fmtDate(c.date)}${c.clinic?.name ? ` · ${c.clinic.name}` : ''}`;
  }, [c, varias, data]);

  const items = useMemo(() => {
    const all = data?.items || [];
    return itemTab === 'todos' ? all : all.filter((i) => i.type === itemTab);
  }, [data, itemTab]);

  if (error) return <div className="p-8 text-center text-rose-600">{error}</div>;
  if (!data) return <div className="p-8 text-center text-slate-400">Cargando detalle de la caja…</div>;

  const t = data.totals;
  const serie = c.puntoEmision ? `${c.puntoEmision.establecimiento}-${c.puntoEmision.codigo}${c.puntoEmision.nombre ? ` · ${c.puntoEmision.nombre}` : ''}` : 'Caja única';
  const methodData = data.byMethod.filter((m) => m.total > 0).map((m) => ({ name: METODO[m.method] || m.method, value: m.total }));
  const typeData = data.byType.filter((x) => x.total > 0).map((x) => ({ name: TIPO[x.type], value: x.total, type: x.type }));
  const hourData = data.byHour.map((h) => ({ hora: `${String(h.hour).padStart(2, '0')}:00`, total: h.total, ventas: h.count }));
  const topItems = data.items.slice(0, 10).map((i) => ({ name: i.name.length > 28 ? `${i.name.slice(0, 27)}…` : i.name, total: i.total, type: i.type }));
  const abierta = c.status === 'ABIERTA';
  const diffTone = c.difference < 0 ? 'rose' : c.difference > 0 ? 'amber' : 'emerald';
  const movNeto = data.movements.filter((m) => !m.voided).reduce((s, m) => s + (m.type === 'INGRESO' ? 1 : -1) * m.amount, 0);
  const cs = data.closings || [];
  const suma = (k) => cs.reduce((s, x) => s + (Number(x[k]) || 0), 0);
  const clinicData = (data.byClinic || []).map((r) => ({ name: r.name, Efectivo: r.efectivo, Tarjeta: r.tarjeta, Transferencia: r.transferencia, Otros: r.otros }));

  return (
    <div className="space-y-4 print:space-y-3">
      {/* Encabezado */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          {varias ? (
            <>
              <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
                <HiOutlineCalculator className="text-emerald-600" /> {cs.length} cajas sumadas
              </h1>
              <p className="text-sm text-slate-500 mt-1">
                Del {fmtFechaHora(data.range.start)} al {fmtFechaHora(data.range.end)} · {data.byClinic.length || new Set(cs.map((x) => x.clinic)).size} sucursal{(data.byClinic.length || 1) === 1 ? '' : 'es'}
              </p>
            </>
          ) : (
            <>
              <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
                <HiOutlineCalculator className="text-emerald-600" /> Detalle de caja · {fmtDate(c.date)}
                <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${c.status === 'CERRADO' ? 'bg-emerald-100 text-emerald-700' : abierta ? 'bg-sky-100 text-sky-700' : 'bg-rose-100 text-rose-700'}`}>{c.status}</span>
              </h1>
              <p className="text-sm text-slate-500 mt-1 flex flex-wrap gap-x-3 gap-y-1">
                {c.clinic?.name && <span><b className="text-slate-700">{c.clinic.name}</b></span>}
                <span className="font-mono">{serie}</span>
                <span>Apertura: {fmtFechaHora(data.range.start)}{c.openedBy?.name ? ` · ${c.openedBy.name}` : ''}</span>
                <span>{abierta ? 'Sigue abierta (datos hasta ahora)' : `Cierre: ${fmtFechaHora(c.closedAt || data.range.end)}${c.closedBy?.name ? ` · ${c.closedBy.name}` : ''}`}</span>
              </p>
            </>
          )}
        </div>
        <div className="flex gap-2 print:hidden">
          {user?.isSuperAdmin && (
            <button onClick={() => setSumarOpen((v) => !v)} className="px-4 py-2 bg-emerald-600 text-white rounded-xl flex items-center gap-2 border-none cursor-pointer hover:bg-emerald-700">
              <HiOutlinePlus /> Sumar cajas
            </button>
          )}
          <button onClick={() => window.print()} className="px-4 py-2 bg-white border border-slate-200 rounded-xl flex items-center gap-2 cursor-pointer hover:bg-slate-50">
            <HiOutlinePrinter /> Imprimir
          </button>
        </div>
      </div>

      {sumarOpen && (
        <div className="print:hidden">
          <SumarCajas baseId={id} baseDate={c.date} selected={sumadas} onApply={aplicarSuma} onClose={() => setSumarOpen(false)} />
        </div>
      )}

      {/* Indicadores */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2">
        <Kpi label="Total vendido" value={money(t.total)} hint={`${t.count} venta${t.count === 1 ? '' : 's'}`} tone="emerald" />
        <Kpi label="Ticket promedio" value={money(data.averageTicket)} tone="sky" />
        <Kpi label="Subtotal" value={money(t.subtotal)} hint={`IVA ${money(t.tax)}`} />
        <Kpi label="Descuentos" value={money(t.discount)} tone="amber" />
        <Kpi label="Facturado (SRI)" value={money(t.invoicedTotal)} hint={`${t.invoiced} factura${t.invoiced === 1 ? '' : 's'} autorizada${t.invoiced === 1 ? '' : 's'}`} tone="violet" />
        <Kpi label="Anuladas" value={money(t.voidedTotal)} hint={`${t.voidedCount} venta${t.voidedCount === 1 ? '' : 's'}`} tone="rose" />
      </div>

      {/* Varias cajas: lo hecho por sucursal y el cuadre de cada caja */}
      {varias && (
        <>
          <Card title="Por sucursal">
            {data.byClinic.length ? (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-center">
                <ResponsiveContainer width="100%" height={Math.max(220, data.byClinic.length * 50)}>
                  <BarChart data={clinicData} layout="vertical" margin={{ left: 10 }}>
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                    <XAxis type="number" fontSize={11} tickFormatter={(v) => `$${v}`} />
                    <YAxis type="category" dataKey="name" width={130} fontSize={11} />
                    <Tooltip formatter={(v) => money(v)} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="Efectivo" stackId="a" fill={COLORS[0]} />
                    <Bar dataKey="Tarjeta" stackId="a" fill={COLORS[1]} />
                    <Bar dataKey="Transferencia" stackId="a" fill={COLORS[2]} />
                    <Bar dataKey="Otros" stackId="a" fill={COLORS[5]} />
                  </BarChart>
                </ResponsiveContainer>
                <div className="overflow-x-auto">
                  <table className="tbl text-sm">
                    <thead className="bg-slate-50 text-xs uppercase"><tr>
                      <th className="px-2 py-1.5 text-left">Sucursal</th><th className="px-2 py-1.5 text-right">Ventas</th>
                      <th className="px-2 py-1.5 text-right">Efectivo</th><th className="px-2 py-1.5 text-right">Tarjeta</th>
                      <th className="px-2 py-1.5 text-right">Transf.</th><th className="px-2 py-1.5 text-right">Otros</th>
                      <th className="px-2 py-1.5 text-right">Total</th>
                    </tr></thead>
                    <tbody>
                      {data.byClinic.map((r) => (
                        <tr key={r.name} className="border-t border-slate-100">
                          <td className="px-2 py-1.5 font-medium">{r.name}</td>
                          <td className="px-2 py-1.5 text-right font-mono">{r.count}</td>
                          <td className="px-2 py-1.5 text-right font-mono">{money(r.efectivo)}</td>
                          <td className="px-2 py-1.5 text-right font-mono">{money(r.tarjeta)}</td>
                          <td className="px-2 py-1.5 text-right font-mono">{money(r.transferencia)}</td>
                          <td className="px-2 py-1.5 text-right font-mono">{money(r.otros)}</td>
                          <td className="px-2 py-1.5 text-right font-mono font-semibold">{money(r.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot><tr className="border-t-2 border-slate-200 font-semibold">
                      <td className="px-2 py-1.5">Total</td>
                      <td className="px-2 py-1.5 text-right font-mono">{t.count}</td>
                      {['efectivo', 'tarjeta', 'transferencia', 'otros'].map((k) => (
                        <td key={k} className="px-2 py-1.5 text-right font-mono">{money(data.byClinic.reduce((s, r) => s + r[k], 0))}</td>
                      ))}
                      <td className="px-2 py-1.5 text-right font-mono">{money(t.total)}</td>
                    </tr></tfoot>
                  </table>
                </div>
              </div>
            ) : <Vacio>No hubo ventas en estas cajas</Vacio>}
          </Card>

          <Card title={`Cajas incluidas (${cs.length})`}>
            <div className="overflow-x-auto">
              <table className="tbl text-sm">
                <thead className="bg-slate-50 text-xs uppercase"><tr>
                  <th className="px-2 py-1.5 text-left">Fecha</th><th className="px-2 py-1.5 text-left">Sucursal</th>
                  <th className="px-2 py-1.5 text-left">Caja</th><th className="px-2 py-1.5 text-left">Cajero</th>
                  <th className="px-2 py-1.5 text-right">Vendido</th><th className="px-2 py-1.5 text-right">Fondo</th>
                  <th className="px-2 py-1.5 text-right">Esperado</th><th className="px-2 py-1.5 text-right">Contado</th>
                  <th className="px-2 py-1.5 text-right">Diferencia</th><th className="px-2 py-1.5 print:hidden"></th>
                </tr></thead>
                <tbody>
                  {cs.map((x) => {
                    const ab = x.status === 'ABIERTA';
                    return (
                      <tr key={x._id} className="border-t border-slate-100">
                        <td className="px-2 py-1.5">{fmtDate(x.date)}{ab && <span className="ml-1 text-[10px] text-sky-700">(abierta)</span>}</td>
                        <td className="px-2 py-1.5 text-xs">{x.clinic || '—'}</td>
                        <td className="px-2 py-1.5 text-xs font-mono">{x.punto || '—'}</td>
                        <td className="px-2 py-1.5 text-xs">{x.openedBy || x.closedBy || '—'}</td>
                        <td className="px-2 py-1.5 text-right font-mono font-semibold">{money(x.sales?.total)}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{money(x.openingBalance)}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{ab ? '—' : money(x.expectedCash)}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{ab ? '—' : money(x.countedCash)}</td>
                        <td className={`px-2 py-1.5 text-right font-mono ${ab ? '' : x.difference < 0 ? 'text-rose-600' : x.difference > 0 ? 'text-amber-600' : 'text-emerald-700'}`}>{ab ? '—' : money(x.difference)}</td>
                        <td className="px-2 py-1.5 text-right print:hidden">
                          {String(x._id) !== String(id) && (
                            <button onClick={() => quitarCaja(x._id)} title="Quitar de la suma" className="text-slate-400 hover:text-rose-600 bg-transparent border-none cursor-pointer"><HiOutlineXMark className="w-4 h-4" /></button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot><tr className="border-t-2 border-slate-200 font-semibold">
                  <td className="px-2 py-1.5" colSpan={4}>Total</td>
                  <td className="px-2 py-1.5 text-right font-mono">{money(t.total)}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{money(suma('openingBalance'))}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{money(suma('expectedCash'))}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{money(suma('countedCash'))}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{money(suma('difference'))}</td>
                  <td className="print:hidden"></td>
                </tr></tfoot>
              </table>
            </div>
            <p className="text-[11px] text-slate-400 mt-2">Las ventas que caen en dos cajas a la vez se cuentan una sola vez. Las cajas abiertas no suman a esperado, contado ni diferencia.</p>
          </Card>
        </>
      )}

      {/* Cuadre */}
      {!varias && (
      <Card title="Cuadre de caja">
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2 text-sm">
          <Kpi label="Fondo inicial" value={money(c.openingBalance)} />
          <Kpi label="Efectivo ventas" value={money(data.byMethod.find((m) => m.method === 'efectivo')?.total)} tone="emerald" />
          <Kpi label="Movimientos neto" value={money(movNeto)} hint={`${data.movements.length} movimiento${data.movements.length === 1 ? '' : 's'}`} />
          <Kpi label="Efectivo esperado" value={abierta ? '—' : money(c.expectedCash)} tone="amber" />
          <Kpi label="Contado" value={abierta ? '—' : money(c.countedCash)} />
          <Kpi label="Diferencia" value={abierta ? '—' : money(c.difference)} hint={abierta ? '' : c.difference < 0 ? 'Faltante' : c.difference > 0 ? 'Sobrante' : 'Cuadrado'} tone={abierta ? 'slate' : diffTone} />
        </div>
        {c.journalEntry && <p className="text-[11px] text-emerald-700 mt-2">✓ Asiento contable de la diferencia generado</p>}
        {c.notes && <p className="text-sm text-slate-600 border-t border-slate-100 mt-3 pt-2">{c.notes}</p>}
      </Card>
      )}

      {/* Gráficas */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="Cobros por método de pago">
          {methodData.length ? (
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie data={methodData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={95} paddingAngle={2}
                  label={({ name, value }) => `${name} ${money(value)}`}>
                  {methodData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <Tooltip formatter={(v) => money(v)} />
              </PieChart>
            </ResponsiveContainer>
          ) : <Vacio />}
        </Card>
        <Card title="Servicios vs productos">
          {typeData.length ? (
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie data={typeData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={95} paddingAngle={2}
                  label={({ name, value }) => `${name} ${money(value)}`}>
                  {typeData.map((d) => <Cell key={d.type} fill={TIPO_COLOR[d.type]} />)}
                </Pie>
                <Tooltip formatter={(v) => money(v)} />
              </PieChart>
            </ResponsiveContainer>
          ) : <Vacio />}
        </Card>
        <Card title="Ventas por hora">
          {hourData.length ? (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={hourData}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="hora" fontSize={11} />
                <YAxis fontSize={11} tickFormatter={(v) => `$${v}`} />
                <Tooltip formatter={(v, n) => (n === 'total' ? [money(v), 'Total'] : [v, n])} labelFormatter={(l) => `Hora ${l}`} />
                <Bar dataKey="total" fill="#059669" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <Vacio />}
        </Card>
        <Card title="Lo más vendido (top 10)">
          {topItems.length ? (
            <ResponsiveContainer width="100%" height={Math.max(260, topItems.length * 28)}>
              <BarChart data={topItems} layout="vertical" margin={{ left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" fontSize={11} tickFormatter={(v) => `$${v}`} />
                <YAxis type="category" dataKey="name" width={170} fontSize={11} />
                <Tooltip formatter={(v) => money(v)} />
                <Bar dataKey="total" radius={[0, 4, 4, 0]}>
                  {topItems.map((d, i) => <Cell key={i} fill={TIPO_COLOR[d.type]} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : <Vacio />}
        </Card>
      </div>

      {/* Servicios y productos */}
      <Card
        title="Servicios y productos vendidos"
        right={(
          <div className="flex gap-1 text-xs print:hidden">
            {['todos', 'servicio', 'producto', 'programa'].map((k) => (
              <button key={k} onClick={() => setItemTab(k)}
                className={`px-2.5 py-1 rounded-lg border cursor-pointer ${itemTab === k ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white border-slate-200 text-slate-600'}`}>
                {k === 'todos' ? 'Todos' : TIPO[k]}
              </button>
            ))}
          </div>
        )}
      >
        {items.length ? (
          <div className="overflow-x-auto">
            <table className="tbl text-sm">
              <thead className="bg-slate-50 text-xs uppercase"><tr>
                <th className="px-2 py-1.5 text-left">Ítem</th><th className="px-2 py-1.5 text-left">Tipo</th>
                <th className="px-2 py-1.5 text-right">Cantidad</th><th className="px-2 py-1.5 text-right">Ventas</th>
                <th className="px-2 py-1.5 text-right">Descuento</th><th className="px-2 py-1.5 text-right">Total</th>
                <th className="px-2 py-1.5 text-right">% del total</th>
              </tr></thead>
              <tbody>
                {items.map((i) => (
                  <tr key={`${i.product}-${i.name}`} className="border-t border-slate-100">
                    <td className="px-2 py-1.5">{i.code && <span className="text-[11px] text-slate-400 font-mono mr-1">{i.code}</span>}{i.name}</td>
                    <td className="px-2 py-1.5 text-xs"><span className="px-2 py-0.5 rounded-full text-white" style={{ background: TIPO_COLOR[i.type] }}>{TIPO[i.type]}</span></td>
                    <td className="px-2 py-1.5 text-right font-mono">{i.qty}</td>
                    <td className="px-2 py-1.5 text-right font-mono">{i.sales}</td>
                    <td className="px-2 py-1.5 text-right font-mono">{i.discount ? money(i.discount) : '—'}</td>
                    <td className="px-2 py-1.5 text-right font-mono font-semibold">{money(i.total)}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-slate-500">{t.total ? `${((i.total / t.total) * 100).toFixed(1)}%` : '—'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr className="border-t-2 border-slate-200 font-semibold">
                <td className="px-2 py-1.5" colSpan={2}>Total</td>
                <td className="px-2 py-1.5 text-right font-mono">{items.reduce((s, i) => s + i.qty, 0)}</td>
                <td></td>
                <td className="px-2 py-1.5 text-right font-mono">{money(items.reduce((s, i) => s + i.discount, 0))}</td>
                <td className="px-2 py-1.5 text-right font-mono">{money(items.reduce((s, i) => s + i.total, 0))}</td>
                <td></td>
              </tr></tfoot>
            </table>
          </div>
        ) : <Vacio>No se vendió nada de este tipo</Vacio>}
      </Card>

      {/* Por vendedor / doctor / método */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {[
          ['Por quien registró la venta', data.bySeller],
          ['Por doctor', data.byDoctor],
          ['Por método de pago', data.byMethod.map((m) => ({ name: METODO[m.method] || m.method, total: m.total }))],
        ].map(([title, rows]) => (
          <Card key={title} title={title}>
            {rows.length ? (
              <table className="tbl text-sm">
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.name} className="border-t border-slate-100">
                      <td className="px-2 py-1.5">{r.name}</td>
                      {r.count != null && <td className="px-2 py-1.5 text-right text-xs text-slate-500">{r.count} vta{r.count === 1 ? '' : 's'}</td>}
                      <td className="px-2 py-1.5 text-right font-mono font-semibold">{money(r.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <Vacio />}
          </Card>
        ))}
      </div>

      {/* Ventas */}
      <Card title={`Ventas de la caja (${data.sales.length})`}>
        {data.sales.length ? (
          <div className="overflow-x-auto">
            <table className="tbl text-sm">
              <thead className="bg-slate-50 text-xs uppercase"><tr>
                <th className="px-2 py-1.5 w-6"></th>
                <th className="px-2 py-1.5 text-left">{varias ? 'Fecha' : 'Hora'}</th>{varias && <th className="px-2 py-1.5 text-left">Sucursal</th>}<th className="px-2 py-1.5 text-left">Venta</th>
                <th className="px-2 py-1.5 text-left">Factura</th><th className="px-2 py-1.5 text-left">Cliente</th>
                <th className="px-2 py-1.5 text-left">Pago</th><th className="px-2 py-1.5 text-left">Registró</th>
                <th className="px-2 py-1.5 text-right">Desc.</th><th className="px-2 py-1.5 text-right">IVA</th>
                <th className="px-2 py-1.5 text-right">Total</th><th className="px-2 py-1.5"></th>
              </tr></thead>
              <tbody>
                {data.sales.map((s) => {
                  const open = !!abiertas[s._id];
                  const anulada = s.status === 'anulada';
                  return (
                    <Fragment key={s._id}>
                      <tr className={`border-t border-slate-100 hover:bg-slate-50 cursor-pointer ${anulada ? 'text-slate-400 line-through' : ''}`}
                        onClick={() => setAbiertas((a) => ({ ...a, [s._id]: !a[s._id] }))}>
                        <td className="px-2 py-1.5 text-slate-400">{open ? <HiOutlineChevronDown /> : <HiOutlineChevronRight />}</td>
                        <td className="px-2 py-1.5 font-mono text-xs">{varias ? fmtFechaHora(s.createdAt) : fmtHora(s.createdAt)}</td>
                        {varias && <td className="px-2 py-1.5 text-xs">{s.clinic}</td>}
                        <td className="px-2 py-1.5 font-mono text-xs">{s.saleNumber}{anulada && <span className="ml-1 no-underline text-rose-600">(anulada)</span>}</td>
                        <td className="px-2 py-1.5 font-mono text-xs">
                          {s.invoice ? (
                            <span title={s.invoice.estado}>{s.invoice.number} <span className={s.invoice.estado === 'AUTORIZADO' ? 'text-emerald-600' : 'text-amber-600'}>●</span></span>
                          ) : <span className="text-slate-400">Sin factura</span>}
                        </td>
                        <td className="px-2 py-1.5"><div>{s.clientName}</div><div className="text-[11px] text-slate-400 font-mono">{s.clientCedula}</div></td>
                        <td className="px-2 py-1.5 text-xs">{s.payments.map(etiquetaPago).join(' + ')}</td>
                        <td className="px-2 py-1.5 text-xs">{s.seller || '—'}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{s.discount ? money(s.discount) : '—'}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{money(s.tax)}</td>
                        <td className="px-2 py-1.5 text-right font-mono font-semibold">{money(s.total)}</td>
                        <td className="px-2 py-1.5 text-right print:hidden">
                          <button onClick={(e) => { e.stopPropagation(); window.open(`/sales?doc=${s._id}`, '_blank'); }} title="Abrir venta"
                            className="text-slate-400 hover:text-emerald-700 bg-transparent border-none cursor-pointer"><HiOutlineArrowTopRightOnSquare className="w-4 h-4" /></button>
                        </td>
                      </tr>
                      {open && (
                        <tr className="bg-slate-50/60">
                          <td></td>
                          <td colSpan={varias ? 11 : 10} className="px-2 py-2">
                            <table className="w-full text-xs">
                              <thead className="text-slate-500"><tr>
                                <th className="text-left py-1">Ítem</th><th className="text-left py-1">Tipo</th>
                                <th className="text-right py-1">Cant.</th><th className="text-right py-1">P. unit.</th>
                                <th className="text-right py-1">Desc.</th><th className="text-right py-1">Total</th>
                              </tr></thead>
                              <tbody>
                                {s.items.map((it, k) => (
                                  <tr key={k} className="border-t border-slate-200/70">
                                    <td className="py-1">{it.name}</td>
                                    <td className="py-1">{TIPO[it.type]}</td>
                                    <td className="py-1 text-right font-mono">{it.qty}</td>
                                    <td className="py-1 text-right font-mono">{money(it.unitPrice)}</td>
                                    <td className="py-1 text-right font-mono">{it.discount ? money(it.discount) : '—'}</td>
                                    <td className="py-1 text-right font-mono">{money(it.total)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            <p className="mt-2 text-slate-500 flex flex-wrap gap-x-4">
                              {s.doctor && <span>Doctor: <b>{s.doctor}</b></span>}
                              {s.recommendedBy && <span>Recomendado por: <b>{s.recommendedBy}</b></span>}
                              {s.discountReason && <span>Motivo/comentario: <b>{s.discountReason}</b></span>}
                            </p>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <Vacio>No hubo ventas en esta caja</Vacio>}
      </Card>

      {/* Movimientos de caja */}
      <Card title={`Movimientos de caja (${data.movements.length})`}>
        {data.movements.length ? (
          <table className="tbl text-sm">
            <thead className="bg-slate-50 text-xs uppercase"><tr>
              <th className="px-2 py-1.5 text-left">Fecha</th><th className="px-2 py-1.5 text-left">Tipo</th>
              <th className="px-2 py-1.5 text-left">Descripción</th><th className="px-2 py-1.5 text-left">Cuenta</th>
              <th className="px-2 py-1.5 text-left">Registró</th><th className="px-2 py-1.5 text-right">Monto</th>
            </tr></thead>
            <tbody>
              {data.movements.map((m) => (
                <tr key={m._id} className={`border-t border-slate-100 ${m.voided ? 'line-through text-slate-400' : ''}`}>
                  <td className="px-2 py-1.5 text-xs">{fmtFechaHora(m.date)}</td>
                  <td className="px-2 py-1.5 text-xs">{m.type}</td>
                  <td className="px-2 py-1.5">{m.description || '—'}</td>
                  <td className="px-2 py-1.5 text-xs">{m.counterpartAccount ? `${m.counterpartAccount.code} ${m.counterpartAccount.name}` : '—'}</td>
                  <td className="px-2 py-1.5 text-xs">{m.createdBy?.name || '—'}</td>
                  <td className={`px-2 py-1.5 text-right font-mono ${m.type === 'INGRESO' ? 'text-emerald-600' : 'text-rose-600'}`}>{m.type === 'INGRESO' ? '+' : '−'}{money(m.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <Vacio>Sin movimientos de caja</Vacio>}
      </Card>
    </div>
  );
}
