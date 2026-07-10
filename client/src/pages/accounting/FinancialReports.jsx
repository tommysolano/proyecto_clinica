import { useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import {
  HiOutlineArrowsRightLeft,
  HiOutlineBookOpen,
  HiOutlineClipboardDocumentList,
  HiOutlineDocumentChartBar,
  HiOutlineInformationCircle,
} from 'react-icons/hi2';
import { fmt, fmtDate, startOfMonth, today, downloadBlob } from './_utils';
import LiquidityProjection from './_LiquidityProjection';

const REPORT_TABS = [
  ['PYG', 'Estado Resultados'],
  ['BG', 'Balance General'],
  ['FC', 'Flujo de Caja'],
];

const DETAIL_TABS = [
  { key: 'RESUMEN', label: 'Resumen' },
  { key: 'MAYOR', label: 'Mayor' },
  { key: 'DIARIO', label: 'Libro diario' },
  { key: 'FLUJO', label: 'Flujo' },
];

const SOURCE_LABELS = {
  VENTA: 'Venta',
  COMPRA: 'Compra',
  COBRO: 'Cobro',
  PAGO: 'Pago',
  NOMINA: 'Nomina',
  DEPRECIACION: 'Depreciacion',
  AJUSTE: 'Ajuste',
  APERTURA: 'Apertura',
  CIERRE: 'Cierre',
  MANUAL: 'Manual',
  BANCO: 'Banco',
  NC: 'Nota credito',
  ND: 'Nota debito',
  CHEQUE: 'Cheque',
  TARJETA: 'Tarjeta',
};

export default function FinancialReports() {
  const [tab, setTab] = useState('PYG');
  const [startDate, setStart] = useState(startOfMonth());
  const [endDate, setEnd] = useState(today());
  const [data, setData] = useState(null);
  const [accountDetail, setAccountDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailTab, setDetailTab] = useState('RESUMEN');

  const load = async () => {
    try {
      let url = '/accounting-reports/income-statement';
      let params = { startDate, endDate };
      if (tab === 'BG') {
        url = '/accounting-reports/balance-sheet';
        params = { date: endDate, startDate, endDate };
      }
      if (tab === 'FC') url = '/accounting-reports/cash-flow';
      const r = await api.get(url, { params });
      setData(r.data);
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  const downloadSupercias = async () => {
    try {
      const url =
        tab === 'BG'
          ? '/accounting-reports/supercias/balance-sheet.txt'
          : '/accounting-reports/supercias/income-statement.txt';
      const params = tab === 'BG' ? { date: endDate } : { startDate, endDate };
      const r = await api.get(url, { params, responseType: 'blob' });
      const fname =
        tab === 'BG'
          ? `supercias-balance-${endDate}.txt`
          : `supercias-resultados-${startDate}_${endDate}.txt`;
      downloadBlob(r.data, fname, 'text/plain');
      toast.success('TXT Supercias descargado');
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al descargar TXT');
    }
  };

  const openAccount = async (account) => {
    const id = typeof account === 'string' ? account : account?._id || account?.accountId;
    if (!id) return;
    setDetailLoading(true);
    setAccountDetail(null);
    setDetailTab('RESUMEN');
    try {
      const r = await api.get(`/accounting-reports/account-flow/${id}`, { params: { startDate, endDate } });
      setAccountDetail(r.data);
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al cargar cuenta');
    } finally {
      setDetailLoading(false);
    }
  };

  const renderReport = () => {
    if (!data) return null;
    if (tab === 'PYG') return <IncomeStatement data={data} onAccountClick={openAccount} />;
    if (tab === 'BG') return <BalanceSheet data={data} onAccountClick={openAccount} />;
    return <CashFlowReport data={data} onAccountClick={openAccount} />;
  };

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineDocumentChartBar className="text-emerald-600" /> Reportes Financieros</h1>
      <div className="flex gap-2 flex-wrap">
        {REPORT_TABS.map(([k, l]) =>
          <button key={k} onClick={() => { setTab(k); setData(null); }} className={`px-4 py-2 rounded-lg text-sm ${tab === k ? 'bg-emerald-600 text-white' : 'bg-white border'}`}>{l}</button>)}
      </div>
      <div className="bg-white p-3 rounded-xl shadow-sm flex gap-2 items-end flex-wrap">
        <div><label className="text-xs text-slate-500 block">Desde</label><input type="date" value={startDate} onChange={(e) => setStart(e.target.value)} className="border border-slate-200 rounded-xl px-3.5 py-2.5" /></div>
        <div><label className="text-xs text-slate-500 block">Hasta</label><input type="date" value={endDate} onChange={(e) => setEnd(e.target.value)} className="border border-slate-200 rounded-xl px-3.5 py-2.5" /></div>
        <button onClick={load} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20">Generar</button>
        {(tab === 'BG' || tab === 'PYG') && (
          <button
            onClick={downloadSupercias}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm"
            title="Archivo plano para subir a Supercias"
          >
            Descargar TXT (Supercias)
          </button>
        )}
      </div>
      {data && (
        <div className="bg-white rounded-xl p-4 shadow-sm overflow-hidden">
          {renderReport()}
        </div>
      )}

      <AccountDetailModal
        detail={accountDetail}
        loading={detailLoading}
        activeTab={detailTab}
        onTabChange={setDetailTab}
        onClose={() => { setAccountDetail(null); setDetailLoading(false); }}
        onAccountClick={openAccount}
        period={{ startDate, endDate }}
      />
    </div>
  );
}

// Aplana el árbol jerárquico en filas con sangría y subtotales (estilo Contífico).
function renderTree(nodes, depth, onAccountClick) {
  const rows = [];
  for (const n of (nodes || [])) {
    const isGroup = !n.allowsMovement || (n.children && n.children.length > 0);
    rows.push(
      <tr key={n.code} className={`border-t border-slate-100 ${isGroup ? 'bg-slate-50/60' : 'hover:bg-slate-50'}`}>
        <td className="px-3 py-1.5 font-mono text-xs text-slate-500" style={{ paddingLeft: `${depth * 18 + 12}px` }}>{n.code}</td>
        <td className={`px-3 py-1.5 ${isGroup ? 'font-semibold text-slate-700' : ''}`}>
          {n.allowsMovement
            ? <AccountButton account={n} onAccountClick={onAccountClick}>{n.name}</AccountButton>
            : <span>{n.name}</span>}
        </td>
        <td className={`px-3 py-1.5 text-right font-mono ${isGroup ? 'font-semibold' : ''}`}>${fmt(n.total)}</td>
      </tr>
    );
    if (n.children && n.children.length) rows.push(...renderTree(n.children, depth + 1, onAccountClick));
  }
  return rows;
}

function TreeSection({ title, nodes = [], total: totalValue = 0, totalClass = '', onAccountClick, extraRows = [] }) {
  return (
    <section className="space-y-1">
      <h3 className="font-semibold text-emerald-700 border-b pb-1">{title}</h3>
      <div className="overflow-x-auto rounded-lg border border-slate-100">
        <table className="tbl min-w-[560px]">
          <thead className="bg-emerald-50 text-xs uppercase text-slate-600"><tr>
            <th className="px-3 py-2 text-left w-32">Código</th>
            <th className="px-3 py-2 text-left">Cuenta</th>
            <th className="px-3 py-2 text-right w-40">Saldo</th>
          </tr></thead>
          <tbody>
            {renderTree(nodes, 0, onAccountClick)}
            {extraRows.map((r) => (
              <tr key={r.label} className="border-t border-slate-100 bg-slate-50"><td colSpan={2} className="px-3 py-1.5 text-right font-semibold">{r.label}</td><td className="px-3 py-1.5 text-right font-mono font-semibold">${fmt(r.amount)}</td></tr>
            ))}
            {!nodes.length && !extraRows.length && <tr><td colSpan={3} className="px-3 py-6 text-center text-slate-400 text-xs">Sin cuentas con saldo en el rango.</td></tr>}
          </tbody>
          <tfoot className="bg-slate-100 font-bold"><tr>
            <td colSpan={2} className="px-3 py-2 text-right">Total {title}</td>
            <td className={`px-3 py-2 text-right font-mono ${totalClass}`}>${fmt(totalValue)}</td>
          </tr></tfoot>
        </table>
      </div>
    </section>
  );
}

// Fila de la cascada tributaria del Estado de Resultados.
function WaterfallRow({ label, value, sub }) {
  return (
    <div className={`flex justify-between px-3 py-1.5 text-sm ${sub ? 'text-slate-500' : 'text-slate-700'}`}>
      <span>{label}</span><span className="font-mono">${fmt(value)}</span>
    </div>
  );
}

function IncomeStatement({ data, onAccountClick }) {
  const tree = data.tree;
  if (!Array.isArray(tree)) {
    // Compatibilidad con respuestas antiguas (lista plana).
    return (
      <div className="space-y-4">
        <FinancialTable title="Ingresos" rows={data.ingresos} total={total(data, 'totalIngresos')} totalClass="text-emerald-700" onAccountClick={onAccountClick} />
        <FinancialTable title="Costo de ventas" rows={data.costos} total={total(data, 'totalCostos')} totalClass="text-rose-600" onAccountClick={onAccountClick} />
        <TotalBand label="Utilidad bruta" value={total(data, 'utilidadBruta')} />
        <FinancialTable title="Gastos" rows={data.gastos} total={total(data, 'totalGastos')} totalClass="text-rose-600" onAccountClick={onAccountClick} />
        <TotalBand label="Utilidad neta" value={total(data, 'utilidadNeta') || total(data, 'utilidadOperacional')} prominent />
      </div>
    );
  }
  const irPct = Math.round((Number(data.incomeTaxRate) || 0.25) * 100);
  const ptPct = Math.round((Number(data.profitSharingRate) || 0.15) * 100);
  return (
    <div className="space-y-3">
      <TreeSection title="Ingresos" nodes={tree.filter((n) => n.type === 'INGRESO')} total={data.totalIngresos} totalClass="text-emerald-700" onAccountClick={onAccountClick} />
      <TreeSection title="Costo de ventas" nodes={tree.filter((n) => n.type === 'COSTO')} total={data.totalCostos} totalClass="text-rose-600" onAccountClick={onAccountClick} />
      <TotalBand label="Utilidad bruta" value={data.utilidadBruta} />
      <TreeSection title="Gastos operativos" nodes={tree.filter((n) => n.type === 'GASTO')} total={data.totalGastos} totalClass="text-rose-600" onAccountClick={onAccountClick} />
      <TotalBand label="Utilidad operacional" value={data.utilidadOperacional} />
      <div className="rounded-lg border border-slate-100 divide-y divide-slate-100">
        <WaterfallRow label="Utilidad antes de participación e impuestos" value={data.utilidadAntesParticipacion} />
        <WaterfallRow label={`(−) ${ptPct}% participación trabajadores (estimado)`} value={-(data.participacionTrabajadores || 0)} sub />
        <WaterfallRow label="Utilidad antes de impuesto a la renta" value={data.utilidadAntesImpuesto} />
        <WaterfallRow label={`(−) Impuesto a la renta ${irPct}% (estimado)`} value={-(data.impuestoRenta || 0)} sub />
      </div>
      <TotalBand label="Utilidad neta del ejercicio" value={data.utilidadNeta} prominent />
      <p className="text-[11px] text-slate-400">La participación de trabajadores ({ptPct}%) y el impuesto a la renta ({irPct}%) son <b>estimados</b> sobre la utilidad del período; el valor definitivo se calcula con la conciliación tributaria anual.</p>
    </div>
  );
}

function BalanceSheet({ data, onAccountClick }) {
  const t = data.tree;
  const totalActivos = total(data, 'totalActivos');
  const totalPasivos = total(data, 'totalPasivos');
  const totalPatrimonio = total(data, 'totalPatrimonio');
  const totalPasivoPatrimonio = total(data, 'totalPasivoPatrimonio') || (totalPasivos + totalPatrimonio);
  const utilidad = Number(data.utilidadEjercicio) || 0;
  const descuadre = Number(data.descuadre) || (totalActivos - totalPasivoPatrimonio);

  if (!t || typeof t !== 'object') {
    return (
      <div className="space-y-4">
        <FinancialTable title="Activos" rows={data.activos} total={totalActivos} totalClass="text-emerald-700" onAccountClick={onAccountClick} />
        <FinancialTable title="Pasivos" rows={data.pasivos} total={totalPasivos} totalClass="text-rose-600" onAccountClick={onAccountClick} />
        <FinancialTable title="Patrimonio" rows={data.patrimonio} total={totalPatrimonio} totalClass="text-blue-700" onAccountClick={onAccountClick} extraRows={money(utilidad) ? [{ label: 'Resultado del ejercicio', amount: utilidad }] : []} />
        <TotalBand label="Pasivo + Patrimonio" value={totalPasivoPatrimonio} prominent />
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <TreeSection title="Activos" nodes={t.activos || []} total={totalActivos} totalClass="text-emerald-700" onAccountClick={onAccountClick} />
      <TreeSection title="Pasivos" nodes={t.pasivos || []} total={totalPasivos} totalClass="text-rose-600" onAccountClick={onAccountClick} />
      <TreeSection title="Patrimonio" nodes={t.patrimonio || []} total={totalPatrimonio} totalClass="text-blue-700" onAccountClick={onAccountClick}
        extraRows={money(utilidad) ? [{ label: 'Resultado del ejercicio', amount: utilidad }] : []} />
      <TotalBand label="Total Pasivo + Patrimonio" value={totalPasivoPatrimonio} prominent />
      {Math.abs(descuadre) > 0.01 && (
        <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
          ⚠ El balance no cuadra por <b>${fmt(descuadre)}</b> (Activo ≠ Pasivo + Patrimonio). Revisa Salud Contable o recalcula saldos.
        </div>
      )}
    </div>
  );
}

function CashFlowReport({ data, onAccountClick }) {
  const accounts = data.accounts || data.cuentas || [];
  const flows = data.flows || [];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat title="Saldo inicial" value={`$${fmt(data.opening)}`} />
        <Stat title="Entradas" value={`$${fmt(data.totalIn)}`} color="text-emerald-700" />
        <Stat title="Salidas" value={`$${fmt(data.totalOut)}`} color="text-rose-600" />
        <Stat title="Saldo final" value={`$${fmt(data.saldoFinal)}`} color={(data.saldoFinal || 0) < 0 ? 'text-rose-600' : 'text-slate-800'} />
      </div>
      <LiquidityProjection p={data.proyeccion} />
      <FinancialTable
        title="Cuentas de efectivo y bancos"
        rows={accounts}
        total={data.saldoFinal}
        totalClass={(data.saldoFinal || 0) < 0 ? 'text-rose-600' : 'text-emerald-700'}
        amountKey="closing"
        amountLabel="Saldo final"
        onAccountClick={onAccountClick}
      />
      <CashFlowTable flows={flows} onAccountClick={onAccountClick} />
    </div>
  );
}

function FinancialTable({ title, rows = [], total: totalValue = 0, totalClass = '', amountKey = 'balance', amountLabel = 'Saldo', onAccountClick, extraRows = [] }) {
  const visibleRows = [...(rows || [])]
    .filter((row) => hasData(row, amountKey))
    .sort((a, b) => String(a.code || '').localeCompare(String(b.code || '')));

  return (
    <section className="space-y-2">
      <h3 className="font-semibold text-emerald-700 border-b pb-1">{title}</h3>
      <div className="overflow-x-auto rounded-lg border border-slate-100">
        <table className="tbl min-w-[840px]">
          <thead className="bg-emerald-50 text-xs uppercase text-slate-600">
            <tr>
              <th className="px-3 py-2 text-left">Codigo</th>
              <th className="px-3 py-2 text-left">Cuenta</th>
              <th className="px-3 py-2 text-left">Tipo</th>
              <th className="px-3 py-2 text-left">Naturaleza</th>
              <th className="px-3 py-2 text-right">Debitos</th>
              <th className="px-3 py-2 text-right">Creditos</th>
              <th className="px-3 py-2 text-right">{amountLabel}</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => (
              <tr key={row._id || row.code} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="px-3 py-2 font-mono text-xs text-slate-500">{row.code}</td>
                <td className="px-3 py-2">
                  <AccountButton account={row} onAccountClick={onAccountClick}>{row.name}</AccountButton>
                </td>
                <td className="px-3 py-2 text-xs text-slate-500">{row.type}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{row.nature}</td>
                <td className="px-3 py-2 text-right font-mono">{money(row.debit) ? fmt(row.debit) : ''}</td>
                <td className="px-3 py-2 text-right font-mono">{money(row.credit) ? fmt(row.credit) : ''}</td>
                <td className="px-3 py-2 text-right font-mono font-semibold">{fmt(amount(row, amountKey))}</td>
              </tr>
            ))}
            {extraRows.map((row) => (
              <tr key={row.label} className="border-t border-slate-100 bg-slate-50">
                <td colSpan={6} className="px-3 py-2 text-right font-semibold">{row.label}</td>
                <td className="px-3 py-2 text-right font-mono font-semibold">{fmt(row.amount)}</td>
              </tr>
            ))}
            {!visibleRows.length && !extraRows.length && (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400 text-xs">Sin cuentas con movimiento o saldo en el rango seleccionado.</td></tr>
            )}
          </tbody>
          <tfoot className="bg-slate-100 font-bold">
            <tr>
              <td colSpan={6} className="px-3 py-2 text-right">Total {title}</td>
              <td className={`px-3 py-2 text-right font-mono ${totalClass}`}>${fmt(totalValue)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

function CashFlowTable({ flows = [], onAccountClick }) {
  return (
    <section className="space-y-2">
      <h3 className="font-semibold text-emerald-700 border-b pb-1">Movimientos de caja</h3>
      <div className="overflow-x-auto rounded-lg border border-slate-100">
        <table className="tbl min-w-[920px]">
          <thead className="bg-emerald-50 text-xs uppercase text-slate-600">
            <tr>
              <th className="px-3 py-2 text-left">Fecha</th>
              <th className="px-3 py-2 text-left">Asiento</th>
              <th className="px-3 py-2 text-left">Cuenta</th>
              <th className="px-3 py-2 text-left">Descripcion</th>
              <th className="px-3 py-2 text-right">Entrada</th>
              <th className="px-3 py-2 text-right">Salida</th>
              <th className="px-3 py-2 text-right">Saldo</th>
            </tr>
          </thead>
          <tbody>
            {flows.map((flow, index) => (
              <tr key={`${flow.entryId || flow.number}-${index}`} className={`border-t border-slate-100 ${flow.saldo < 0 ? 'bg-rose-50' : ''}`}>
                <td className="px-3 py-2 text-xs">{fmtDate(flow.date)}</td>
                <td className="px-3 py-2 font-mono text-xs">{flow.number}</td>
                <td className="px-3 py-2">
                  <AccountButton account={{ _id: flow.accountId, code: flow.accountCode, name: flow.accountName }} onAccountClick={onAccountClick}>
                    {flow.accountCode ? `${flow.accountCode} - ${flow.accountName}` : 'Cuenta'}
                  </AccountButton>
                </td>
                <td className="px-3 py-2 text-xs">{flow.description}</td>
                <td className="px-3 py-2 text-right font-mono text-emerald-700">{money(flow.in) ? fmt(flow.in) : ''}</td>
                <td className="px-3 py-2 text-right font-mono text-rose-600">{money(flow.out) ? fmt(flow.out) : ''}</td>
                <td className={`px-3 py-2 text-right font-mono font-semibold ${flow.saldo < 0 ? 'text-rose-600' : ''}`}>{fmt(flow.saldo)}</td>
              </tr>
            ))}
            {!flows.length && (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400 text-xs">Sin movimientos de caja en el rango seleccionado.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function AccountDetailModal({ detail, loading, activeTab, onTabChange, onClose, onAccountClick, period }) {
  const isOpen = loading || !!detail;
  const account = detail?.account;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={account ? `${account.code} - ${account.name}` : 'Detalle de cuenta'} size="full">
      {loading && <div className="py-10 text-center text-slate-400">Cargando cuenta...</div>}
      {!loading && detail && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span>Periodo: <b>{period.startDate}</b> a <b>{period.endDate}</b></span>
            <span>Tipo: <b>{account.type}</b></span>
            <span>Naturaleza: <b>{account.nature}</b></span>
            <span>Movimientos: <b>{detail.summary?.movements || 0}</b></span>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat title="Saldo inicial" value={`$${fmt(detail.summary?.opening)}`} />
            <Stat title="Debitos" value={`$${fmt(detail.summary?.debit)}`} color="text-emerald-700" />
            <Stat title="Creditos" value={`$${fmt(detail.summary?.credit)}`} color="text-rose-600" />
            <Stat title="Saldo final" value={`$${fmt(detail.summary?.closing)}`} />
          </div>
          <div className="flex gap-2 flex-wrap border-b border-slate-100 pb-2">
            {DETAIL_TABS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                onClick={() => onTabChange(key)}
                className={`px-3 py-2 rounded-lg text-xs flex items-center gap-1 ${activeTab === key ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-600'}`}
              >
                {detailIcon(key)} {label}
              </button>
            ))}
          </div>
          {activeTab === 'RESUMEN' && <DetailSummary detail={detail} />}
          {activeTab === 'MAYOR' && <LedgerDetail rows={detail.ledger || []} opening={detail.summary?.opening} />}
          {activeTab === 'DIARIO' && <JournalDetail entries={detail.journal || []} onAccountClick={onAccountClick} />}
          {activeTab === 'FLUJO' && <FlowDetail detail={detail} onAccountClick={onAccountClick} />}
        </div>
      )}
    </Modal>
  );
}

function DetailSummary({ detail }) {
  const account = detail.account || {};
  const reports = detail.relatedReports || [];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
        <Info label="Codigo" value={account.code} />
        <Info label="Cuenta" value={account.name} />
        <Info label="Tipo" value={account.type} />
        <Info label="Naturaleza" value={account.nature} />
        <Info label="Nivel" value={account.level} />
        <Info label="Permite movimientos" value={account.allowsMovement ? 'Si' : 'No'} />
        <Info label="Codigo fiscal" value={account.taxCode || 'No definido'} />
        <Info label="Estado" value={account.active ? 'Activa' : 'Inactiva'} />
      </div>
      {account.description && (
        <div className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">{account.description}</div>
      )}
      <div>
        <h3 className="text-sm font-semibold text-slate-700 mb-2">Reportes ligados</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {reports.map((report) => (
            <div key={report.key} className="rounded-lg border border-slate-100 p-3">
              <p className="text-sm font-semibold text-slate-800">{report.label}</p>
              <p className="text-xs text-slate-500">{report.description}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function LedgerDetail({ rows = [], opening }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-100">
      <table className="tbl min-w-[860px]">
        <thead className="bg-emerald-50 text-xs uppercase text-slate-600">
          <tr>
            <th className="px-3 py-2 text-left">Fecha</th>
            <th className="px-3 py-2 text-left">Asiento</th>
            <th className="px-3 py-2 text-left">Origen</th>
            <th className="px-3 py-2 text-left">Descripcion</th>
            <th className="px-3 py-2 text-right">Debito</th>
            <th className="px-3 py-2 text-right">Credito</th>
            <th className="px-3 py-2 text-right">Saldo</th>
          </tr>
        </thead>
        <tbody>
          <tr className="bg-slate-50">
            <td colSpan={6} className="px-3 py-2 text-right font-semibold">Saldo inicial</td>
            <td className="px-3 py-2 text-right font-mono font-semibold">{fmt(opening)}</td>
          </tr>
          {rows.map((row, index) => (
            <tr key={`${row.entryId}-${index}`} className="border-t border-slate-100">
              <td className="px-3 py-2 text-xs">{fmtDate(row.date)}</td>
              <td className="px-3 py-2 font-mono text-xs">{row.number}</td>
              <td className="px-3 py-2 text-xs">{source(row.source)}</td>
              <td className="px-3 py-2 text-xs">{row.description}</td>
              <td className="px-3 py-2 text-right font-mono text-emerald-700">{money(row.debit) ? fmt(row.debit) : ''}</td>
              <td className="px-3 py-2 text-right font-mono text-rose-600">{money(row.credit) ? fmt(row.credit) : ''}</td>
              <td className="px-3 py-2 text-right font-mono font-semibold">{fmt(row.saldo)}</td>
            </tr>
          ))}
          {!rows.length && (
            <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400 text-xs">Sin movimientos en el rango seleccionado.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function JournalDetail({ entries = [], onAccountClick }) {
  return (
    <div className="space-y-3">
      {entries.map((entry) => (
        <div key={entry._id} className="rounded-lg border border-slate-100 overflow-hidden">
          <div className="bg-slate-50 px-3 py-2 text-sm flex flex-wrap gap-3">
            <span className="font-mono">{entry.number}</span>
            <span>{fmtDate(entry.date)}</span>
            <span>{source(entry.source)}</span>
            {entry.sourceModel && <span className="text-xs text-slate-500">{entry.sourceModel}</span>}
            <span className="text-slate-600">{entry.description}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="tbl min-w-[760px]">
              <thead className="bg-emerald-50 text-xs uppercase text-slate-600">
                <tr>
                  <th className="px-3 py-2 text-left">Codigo</th>
                  <th className="px-3 py-2 text-left">Cuenta</th>
                  <th className="px-3 py-2 text-left">Detalle</th>
                  <th className="px-3 py-2 text-right">Debito</th>
                  <th className="px-3 py-2 text-right">Credito</th>
                </tr>
              </thead>
              <tbody>
                {(entry.lines || []).map((line, index) => (
                  <tr key={`${line.accountId}-${index}`} className={`border-t border-slate-100 ${line.isSelected ? 'bg-emerald-50' : ''}`}>
                    <td className="px-3 py-2 font-mono text-xs text-slate-500">{line.accountCode}</td>
                    <td className="px-3 py-2">
                      <AccountButton account={{ _id: line.accountId, code: line.accountCode, name: line.accountName }} onAccountClick={onAccountClick}>{line.accountName}</AccountButton>
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500">{line.description}</td>
                    <td className="px-3 py-2 text-right font-mono text-emerald-700">{money(line.debit) ? fmt(line.debit) : ''}</td>
                    <td className="px-3 py-2 text-right font-mono text-rose-600">{money(line.credit) ? fmt(line.credit) : ''}</td>
                  </tr>
                ))}
                <tr className="bg-slate-50 font-semibold">
                  <td colSpan={3} className="px-3 py-2 text-right">Totales</td>
                  <td className="px-3 py-2 text-right font-mono">{fmt(entry.totalDebit)}</td>
                  <td className="px-3 py-2 text-right font-mono">{fmt(entry.totalCredit)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      ))}
      {!entries.length && <div className="py-8 text-center text-slate-400 text-sm">Sin asientos en el rango seleccionado.</div>}
    </div>
  );
}

function FlowDetail({ detail, onAccountClick }) {
  const counterparts = detail.counterpartSummary || [];
  const ledger = detail.ledger || [];

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-lg border border-slate-100">
        <table className="tbl min-w-[760px]">
          <thead className="bg-emerald-50 text-xs uppercase text-slate-600">
            <tr>
              <th className="px-3 py-2 text-left">Cuenta relacionada</th>
              <th className="px-3 py-2 text-right">Veces</th>
              <th className="px-3 py-2 text-right">Debitos</th>
              <th className="px-3 py-2 text-right">Creditos</th>
              <th className="px-3 py-2 text-right">Neto</th>
            </tr>
          </thead>
          <tbody>
            {counterparts.map((row) => (
              <tr key={row.accountId || row.accountCode} className="border-t border-slate-100">
                <td className="px-3 py-2">
                  <AccountButton account={{ _id: row.accountId, code: row.accountCode, name: row.accountName }} onAccountClick={onAccountClick}>
                    {row.accountCode} - {row.accountName}
                  </AccountButton>
                </td>
                <td className="px-3 py-2 text-right font-mono">{row.count}</td>
                <td className="px-3 py-2 text-right font-mono text-emerald-700">{fmt(row.debit)}</td>
                <td className="px-3 py-2 text-right font-mono text-rose-600">{fmt(row.credit)}</td>
                <td className="px-3 py-2 text-right font-mono font-semibold">{fmt((row.debit || 0) - (row.credit || 0))}</td>
              </tr>
            ))}
            {!counterparts.length && (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-400 text-xs">Sin cuentas relacionadas en el rango seleccionado.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-100">
        <table className="tbl min-w-[980px]">
          <thead className="bg-emerald-50 text-xs uppercase text-slate-600">
            <tr>
              <th className="px-3 py-2 text-left">Fecha</th>
              <th className="px-3 py-2 text-left">Asiento</th>
              <th className="px-3 py-2 text-left">Movimiento cuenta</th>
              <th className="px-3 py-2 text-left">Contrapartidas</th>
              <th className="px-3 py-2 text-left">Descripcion</th>
              <th className="px-3 py-2 text-right">Saldo</th>
            </tr>
          </thead>
          <tbody>
            {ledger.map((row, index) => (
              <tr key={`${row.entryId}-${index}`} className="border-t border-slate-100 align-top">
                <td className="px-3 py-2 text-xs">{fmtDate(row.date)}</td>
                <td className="px-3 py-2 font-mono text-xs">{row.number}</td>
                <td className="px-3 py-2 font-mono text-xs">{lineAmount(row)}</td>
                <td className="px-3 py-2">
                  <div className="space-y-1">
                    {(row.counterparts || []).map((cp, cpIndex) => (
                      <div key={`${cp.accountId}-${cpIndex}`} className="flex items-center justify-between gap-3 text-xs">
                        <AccountButton account={{ _id: cp.accountId, code: cp.accountCode, name: cp.accountName }} onAccountClick={onAccountClick}>
                          {cp.accountCode} - {cp.accountName}
                        </AccountButton>
                        <span className="font-mono text-slate-500">{lineAmount(cp)}</span>
                      </div>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2 text-xs">{row.description}</td>
                <td className="px-3 py-2 text-right font-mono font-semibold">{fmt(row.saldo)}</td>
              </tr>
            ))}
            {!ledger.length && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400 text-xs">Sin flujo contable en el rango seleccionado.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AccountButton({ account, onAccountClick, children }) {
  const id = account?._id || account?.accountId;
  if (!id || !onAccountClick) return <span>{children}</span>;
  return (
    <button
      type="button"
      onClick={() => onAccountClick(account)}
      className="text-left text-emerald-700 hover:text-emerald-900 hover:underline font-medium"
    >
      {children}
    </button>
  );
}

function Stat({ title, value, color = 'text-slate-800' }) {
  return <div className="bg-slate-50 rounded-lg p-3"><p className="text-xs text-slate-500">{title}</p><p className={`text-xl font-bold ${color}`}>{value}</p></div>;
}

function Info({ label, value }) {
  return <div className="bg-slate-50 rounded-lg p-3"><p className="text-xs text-slate-500">{label}</p><p className="text-sm font-semibold text-slate-800">{value || '-'}</p></div>;
}

function TotalBand({ label, value, prominent = false }) {
  return (
    <div className={`flex justify-between px-3 ${prominent ? 'py-3 text-lg bg-emerald-50' : 'py-2 bg-slate-50'} font-bold rounded-lg`}>
      <span>{label}</span>
      <span className="font-mono">${fmt(value)}</span>
    </div>
  );
}

function total(data, key) {
  return Number(data?.totales?.[key] ?? data?.[key] ?? 0) || 0;
}

function amount(row, key) {
  return Number(row?.[key] ?? row?.balance ?? row?.amount ?? row?.closing ?? 0) || 0;
}

function hasData(row, amountKey) {
  return money(row?.debit) || money(row?.credit) || money(amount(row, amountKey));
}

function money(value) {
  return Math.abs(Number(value) || 0) > 0.004;
}

function source(value) {
  return SOURCE_LABELS[value] || value || '';
}

function lineAmount(row) {
  if (money(row?.debit)) return `D ${fmt(row.debit)}`;
  if (money(row?.credit)) return `C ${fmt(row.credit)}`;
  return '0.00';
}

function detailIcon(key) {
  const className = 'w-4 h-4';
  if (key === 'MAYOR') return <HiOutlineBookOpen className={className} />;
  if (key === 'DIARIO') return <HiOutlineClipboardDocumentList className={className} />;
  if (key === 'FLUJO') return <HiOutlineArrowsRightLeft className={className} />;
  return <HiOutlineInformationCircle className={className} />;
}
