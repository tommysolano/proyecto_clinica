import { useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import { HiOutlineArrowsRightLeft, HiOutlineArrowDownTray, HiOutlineExclamationTriangle, HiOutlineBanknotes, HiOutlineArrowTrendingUp, HiOutlineArrowTrendingDown, HiOutlineScale } from 'react-icons/hi2';
import { fmt, fmtDate, startOfMonth, today } from './_utils';

export default function CashFlow() {
  const [startDate, setStart] = useState(startOfMonth());
  const [endDate, setEnd] = useState(today());
  const [data, setData] = useState(null);

  const load = async () => {
    try { const r = await api.get('/accounting-reports/cash-flow', { params: { startDate, endDate } }); setData(r.data); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  const downloadXlsx = async () => {
    try {
      const res = await api.get('/accounting-reports/cash-flow.xlsx', { params: { startDate, endDate }, responseType: 'blob' });
      const u = URL.createObjectURL(res.data); const a = document.createElement('a'); a.href = u; a.download = 'flujo_caja.xlsx'; a.click(); URL.revokeObjectURL(u);
    } catch { toast.error('Error al exportar'); }
  };

  const negativeCount = data?.flows?.filter((f) => f.saldo < 0).length || 0;
  const p = data?.proyeccion;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineArrowsRightLeft className="text-emerald-600" /> Flujo de Caja</h1>
      <div className="bg-white p-3 rounded-xl shadow-sm flex gap-2 items-end flex-wrap">
        <div><label className="text-xs text-slate-500 block">Desde</label><input type="date" value={startDate} onChange={(e) => setStart(e.target.value)} className="border border-slate-200 rounded-xl px-3.5 py-2.5" /></div>
        <div><label className="text-xs text-slate-500 block">Hasta</label><input type="date" value={endDate} onChange={(e) => setEnd(e.target.value)} className="border border-slate-200 rounded-xl px-3.5 py-2.5" /></div>
        <button onClick={load} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20">Generar</button>
        {data && <button onClick={downloadXlsx} className="px-4 py-2 bg-slate-700 text-white rounded-lg flex items-center gap-2"><HiOutlineArrowDownTray /> Excel</button>}
      </div>

      {data && (
        <>
          {negativeCount > 0 && (
            <div className="bg-rose-50 border border-rose-200 rounded-xl p-3 flex items-center gap-2 text-rose-700">
              <HiOutlineExclamationTriangle className="w-5 h-5" /> <span className="text-sm font-semibold">Alerta: en {negativeCount} momento(s) el saldo de caja queda en negativo.</span>
            </div>
          )}
          {p?.alertas?.deficitProyectado && (
            <div className="bg-rose-50 border border-rose-200 rounded-xl p-3 flex items-center gap-2 text-rose-700">
              <HiOutlineExclamationTriangle className="w-5 h-5 shrink-0" /> <span className="text-sm font-semibold">Alerta de liquidez: las cuentas por pagar (${fmt(p.cxp.total)}) superan el disponible más los ingresos esperados (${fmt(p.disponible + p.cxc.total)}).</span>
            </div>
          )}
          {!p?.alertas?.deficitProyectado && p?.alertas?.vencidasSuperanDisponible && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-center gap-2 text-amber-700">
              <HiOutlineExclamationTriangle className="w-5 h-5 shrink-0" /> <span className="text-sm font-semibold">Atención: las cuentas por pagar ya vencidas (${fmt(p.cxp.vencido)}) superan el efectivo disponible (${fmt(p.disponible)}).</span>
            </div>
          )}
          <div className="grid grid-cols-3 gap-3">
            <Stat title="Total ingresos" value={`$${fmt(data.totalIn)}`} color="text-emerald-700" />
            <Stat title="Total egresos" value={`$${fmt(data.totalOut)}`} color="text-rose-600" />
            <Stat title="Saldo final" value={`$${fmt(data.saldoFinal)}`} color={data.saldoFinal < 0 ? 'text-rose-600' : 'text-slate-800'} />
          </div>

          {p && <Projection p={p} />}

          <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden">
            <div className="px-4 pt-3 pb-1 text-sm font-semibold text-slate-700">Movimientos de caja y bancos del período</div>
            <table className="tbl">
              <thead className="bg-emerald-50 text-xs uppercase"><tr><th className="px-3 py-2 text-left">Fecha</th><th className="px-3 py-2 text-left">Asiento</th><th className="px-3 py-2 text-left">Descripción</th><th className="px-3 py-2 text-right">Ingreso</th><th className="px-3 py-2 text-right">Egreso</th><th className="px-3 py-2 text-right">Saldo</th></tr></thead>
              <tbody>
                {data.flows.map((f, i) => (
                  <tr key={i} className={`border-t ${f.saldo < 0 ? 'bg-rose-50' : f.saldo < 500 ? 'bg-amber-50' : ''}`}>
                    <td className="px-3 py-2 text-xs">{fmtDate(f.date)}</td>
                    <td className="px-3 py-2 text-xs font-mono">{f.number}</td>
                    <td className="px-3 py-2 text-xs">{f.description}</td>
                    <td className="px-3 py-2 text-right font-mono text-emerald-600">{f.in ? fmt(f.in) : ''}</td>
                    <td className="px-3 py-2 text-right font-mono text-rose-600">{f.out ? fmt(f.out) : ''}</td>
                    <td className={`px-3 py-2 text-right font-mono font-semibold ${f.saldo < 0 ? 'text-rose-600' : 'text-slate-800'}`}>{fmt(f.saldo)}</td>
                  </tr>
                ))}
                {data.flows.length === 0 && <tr><td colSpan={6} className="px-3 py-8 text-center text-slate-400">Sin movimientos de caja en el período</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/** Proyección de liquidez: disponible hoy + CxC − CxP, con vencimientos próximos. */
function Projection({ p }) {
  const projColor = p.saldoProyectado < 0 ? 'text-rose-600' : 'text-emerald-700';
  return (
    <div className="space-y-3">
      <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2 pt-2"><HiOutlineScale className="text-emerald-600" /> Proyección de liquidez <span className="text-xs font-normal text-slate-400">(saldos abiertos a hoy)</span></h2>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat title="Disponible hoy (caja + bancos)" value={`$${fmt(p.disponible)}`} icon={<HiOutlineBanknotes className="w-5 h-5 text-slate-400" />} />
        <Stat title={`Ingresos esperados · ${p.cxc.count} doc. CxC`} value={`$${fmt(p.cxc.total)}`} color="text-emerald-700" icon={<HiOutlineArrowTrendingUp className="w-5 h-5 text-emerald-400" />}
          sub={<>Vencidas: <b className="text-amber-600">${fmt(p.cxc.vencido)}</b> · Por vencer: <b>${fmt(p.cxc.porVencer)}</b></>} />
        <Stat title={`Cuentas por pagar · ${p.cxp.count} doc. CxP`} value={`$${fmt(p.cxp.total)}`} color="text-rose-600" icon={<HiOutlineArrowTrendingDown className="w-5 h-5 text-rose-400" />}
          sub={<>Vencidas: <b className="text-rose-600">${fmt(p.cxp.vencido)}</b> · Por vencer: <b>${fmt(p.cxp.porVencer)}</b></>} />
        <Stat title="Saldo proyectado (disponible + CxC − CxP)" value={`$${fmt(p.saldoProyectado)}`} color={projColor} />
      </div>

      <div className="grid lg:grid-cols-2 gap-3 items-start">
        <MaturityTable
          title="Vencimientos de cuentas por pagar"
          empty="Sin cuentas por pagar pendientes"
          docs={p.cxp.docs}
          headBg="bg-rose-50"
          running={{ start: p.disponible, label: 'Disponible tras pagar', sign: -1 }}
        />
        <MaturityTable
          title="Ingresos esperados (cuentas por cobrar)"
          empty="Sin cuentas por cobrar pendientes"
          docs={p.cxc.docs}
          headBg="bg-emerald-50"
        />
      </div>
    </div>
  );
}

/**
 * Tabla de documentos abiertos ordenados por vencimiento. Si `running` viene,
 * agrega una columna acumulada (disponible − pagos en orden de vencimiento)
 * que muestra en qué punto el efectivo deja de alcanzar.
 */
function MaturityTable({ title, empty, docs = [], headBg, running }) {
  let acc = running?.start || 0;
  return (
    <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden">
      <div className="px-4 pt-3 pb-1 text-sm font-semibold text-slate-700">{title}</div>
      <div className="overflow-x-auto max-h-80 overflow-y-auto">
        <table className="tbl w-full">
          <thead className={`${headBg} text-xs uppercase sticky top-0`}>
            <tr>
              <th className="px-3 py-2 text-left">Vence</th>
              <th className="px-3 py-2 text-left">Contraparte</th>
              <th className="px-3 py-2 text-left">Documento</th>
              <th className="px-3 py-2 text-left">Estado</th>
              <th className="px-3 py-2 text-right">Saldo</th>
              {running && <th className="px-3 py-2 text-right">{running.label}</th>}
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => {
              if (running) acc = +(acc + running.sign * d.balance).toFixed(2);
              const overdue = d.dias > 0;
              return (
                <tr key={d.id} className={`border-t ${overdue ? 'bg-rose-50/60' : ''}`}>
                  <td className="px-3 py-2 text-xs whitespace-nowrap">{d.dueDate ? fmtDate(d.dueDate) : '—'}</td>
                  <td className="px-3 py-2 text-xs">{d.party}</td>
                  <td className="px-3 py-2 text-xs font-mono whitespace-nowrap">{d.number || d.docType}</td>
                  <td className={`px-3 py-2 text-xs font-semibold whitespace-nowrap ${overdue ? 'text-rose-600' : 'text-slate-500'}`}>
                    {overdue ? `Vencida ${d.dias} d` : `En ${-d.dias} d`}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{fmt(d.balance)}</td>
                  {running && <td className={`px-3 py-2 text-right font-mono font-semibold ${acc < 0 ? 'text-rose-600' : 'text-slate-700'}`}>{fmt(acc)}</td>}
                </tr>
              );
            })}
            {docs.length === 0 && <tr><td colSpan={running ? 6 : 5} className="px-3 py-6 text-center text-slate-400">{empty}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ title, value, color = 'text-slate-800', sub, icon }) {
  return (
    <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-4">
      <p className="text-xs text-slate-500 flex items-center justify-between gap-2">{title}{icon}</p>
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
      {sub && <p className="text-[11px] text-slate-500 mt-1">{sub}</p>}
    </div>
  );
}
