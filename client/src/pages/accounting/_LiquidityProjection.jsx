import { HiOutlineExclamationTriangle, HiOutlineBanknotes, HiOutlineArrowTrendingUp, HiOutlineArrowTrendingDown, HiOutlineScale } from 'react-icons/hi2';
import { fmt, fmtDate } from './_utils';

/**
 * Proyección de liquidez del flujo de caja (compartida por Contabilidad → Flujo
 * de Caja y Reportería → Rep. Financieros): con el disponible de HOY más las
 * CxC abiertas, ¿alcanza para cubrir las CxP? Incluye alertas y tablas de
 * vencimientos. Recibe `p` = respuesta `proyeccion` de /accounting-reports/cash-flow.
 */
export default function LiquidityProjection({ p }) {
  if (!p) return null;
  const projColor = p.saldoProyectado < 0 ? 'text-rose-600' : 'text-emerald-700';
  return (
    <div className="space-y-3">
      {p.alertas?.deficitProyectado && (
        <div className="bg-rose-50 border border-rose-200 rounded-xl p-3 flex items-center gap-2 text-rose-700">
          <HiOutlineExclamationTriangle className="w-5 h-5 shrink-0" /> <span className="text-sm font-semibold">Alerta de liquidez: las cuentas por pagar (${fmt(p.cxp.total)}) superan el disponible más los ingresos esperados (${fmt(p.disponible + p.cxc.total)}).</span>
        </div>
      )}
      {!p.alertas?.deficitProyectado && p.alertas?.vencidasSuperanDisponible && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-center gap-2 text-amber-700">
          <HiOutlineExclamationTriangle className="w-5 h-5 shrink-0" /> <span className="text-sm font-semibold">Atención: las cuentas por pagar ya vencidas (${fmt(p.cxp.vencido)}) superan el efectivo disponible (${fmt(p.disponible)}).</span>
        </div>
      )}

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
