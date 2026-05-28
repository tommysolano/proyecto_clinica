import { useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import { HiOutlineChartBar, HiOutlineArrowDownTray } from 'react-icons/hi2';
import { fmt, fmtDate, startOfMonth, today } from './_utils';

const TABS = [
  { key: 'PERIODO', label: 'Ventas por período', url: '/accounting-reports/sales/by-period' },
  { key: 'PRODUCTO', label: 'Ventas por producto', url: '/accounting-reports/sales/by-product' },
  { key: 'VENDEDOR', label: 'Ventas por vendedor', url: '/accounting-reports/sales/by-seller' },
  { key: 'CAJERO', label: 'Ventas por cajero', url: '/accounting-reports/sales/by-cashier' },
  { key: 'COSTO', label: 'Costo de venta', url: '/accounting-reports/sales/cost' },
  { key: 'COSTO_CAT', label: 'Costo por categoría', url: '/accounting-reports/sales/cost-by-category' },
  { key: 'AR', label: 'Cuentas por cobrar', url: '/accounting-reports/ar-aging' },
  { key: 'AP', label: 'Cuentas por pagar', url: '/accounting-reports/ap-aging' },
  { key: 'ANT', label: 'Anticipos', url: '/accounting-reports/advances' },
  { key: 'NODED', label: 'Gastos no deducibles', url: '/accounting-reports/non-deductible' },
  { key: 'INV', label: 'Inventario valorizado', url: '/accounting-reports/inventory' },
];

const AGING_LABELS = { POR_VENCER: 'Por vencer', VENCIDO_30: '1-30', VENCIDO_60: '31-60', VENCIDO_90: '61-90', VENCIDO_120: '91-120', VENCIDO_MAS_120: '> 120' };

export default function ManagementReports() {
  const [tab, setTab] = useState('PERIODO');
  const [granularity, setGranularity] = useState('month');
  const [startDate, setStart] = useState(startOfMonth());
  const [endDate, setEnd] = useState(today());
  const [data, setData] = useState(null);

  const current = TABS.find((t) => t.key === tab);

  const load = async () => {
    try {
      const params = { startDate, endDate };
      if (tab === 'PERIODO') params.granularity = granularity;
      const r = await api.get(current.url, { params });
      setData(r.data);
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  const downloadXlsx = async (url, name) => {
    try {
      const res = await api.get(url, { params: { startDate, endDate }, responseType: 'blob' });
      const u = URL.createObjectURL(res.data); const a = document.createElement('a'); a.href = u; a.download = name; a.click(); URL.revokeObjectURL(u);
    } catch { toast.error('Error al exportar'); }
  };

  const renderTable = () => {
    if (!data) return null;
    const arr = Array.isArray(data) ? data : [];
    const rows = Array.isArray(data?.rows) ? data.rows : [];
    const totals = data?.totals || {};
    if (tab === 'PERIODO') return (
      <Table head={['Período', 'N° ventas', 'Subtotal', 'IVA', 'Total']} rows={arr.map((r) => [r._id, r.count, `$${fmt(r.subtotal)}`, `$${fmt(r.tax)}`, `$${fmt(r.total)}`])} />
    );
    if (tab === 'PRODUCTO') return (
      <Table head={['Producto', 'Cantidad', 'Total']} rows={arr.map((r) => [r._id?.name || '—', r.qty, `$${fmt(r.subtotal)}`])} />
    );
    if (tab === 'VENDEDOR' || tab === 'CAJERO') return (
      <Table head={['Usuario', 'N° ventas', 'Total']} rows={arr.map((r) => [r._id?.name || 'Sin asignar', r.count, `$${fmt(r.total)}`])} />
    );
    if (tab === 'COSTO') return (
      <div className="grid grid-cols-3 gap-3">
        <Stat title="Ventas" value={`$${fmt(data.totalSales)}`} />
        <Stat title="Costo" value={`$${fmt(data.totalCost)}`} color="text-rose-600" />
        <Stat title="Utilidad bruta" value={`$${fmt(data.grossProfit)}`} color="text-emerald-700" />
      </div>
    );
    if (tab === 'COSTO_CAT') return (
      <Table head={['Categoría', 'Cantidad', 'Ingresos', 'Costo', 'Utilidad', 'Margen']} rows={rows.map((r) => [r.category, r.qty, `$${fmt(r.revenue)}`, `$${fmt(r.cost)}`, `$${fmt(r.grossProfit)}`, `${r.margin}%`])} />
    );
    if (tab === 'AR' || tab === 'AP') return (
      <div className="space-y-3">
        <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
          {Object.keys(AGING_LABELS).map((k) => <Stat key={k} title={AGING_LABELS[k]} value={`$${fmt(totals[k] || 0)}`} small />)}
        </div>
        <Table head={[tab === 'AR' ? 'Cliente' : 'Proveedor', 'Documento', 'Fecha', 'Antigüedad', 'Saldo']} rows={rows.map((r) => [r.client || r.supplier || '—', r.number, fmtDate(r.date), AGING_LABELS[r.bucket], `$${fmt(r.balance)}`])} />
      </div>
    );
    if (tab === 'INV') return (
      <div className="space-y-2">
        <div className="grid grid-cols-3 gap-3"><Stat title="Unidades" value={totals.units} /><Stat title="Valor al costo" value={`$${fmt(totals.valueAtCost)}`} /><Stat title="Valor a venta" value={`$${fmt(totals.valueAtSale)}`} /></div>
        <Table head={['Código', 'Producto', 'Stock', 'Costo', 'Valor costo']} rows={rows.map((r) => [r.code, r.name, r.stock, `$${fmt(r.purchasePrice)}`, `$${fmt(r.valueAtCost)}`])} />
      </div>
    );
    return <pre className="text-xs overflow-auto">{JSON.stringify(data, null, 2)}</pre>;
  };

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2"><HiOutlineChartBar className="text-emerald-600" /> Reportes Gerenciales</h1>
      <div className="flex gap-2 flex-wrap">
        {TABS.map((t) => <button key={t.key} onClick={() => { setTab(t.key); setData(null); }} className={`px-3 py-2 rounded-lg text-xs ${tab === t.key ? 'bg-emerald-600 text-white' : 'bg-white border'}`}>{t.label}</button>)}
      </div>
      <div className="bg-white p-3 rounded-xl shadow-sm flex gap-2 items-end flex-wrap">
        <div><label className="text-xs text-slate-500 block">Desde</label><input type="date" value={startDate} onChange={(e) => setStart(e.target.value)} className="border border-slate-200 rounded-lg px-3 py-2" /></div>
        <div><label className="text-xs text-slate-500 block">Hasta</label><input type="date" value={endDate} onChange={(e) => setEnd(e.target.value)} className="border border-slate-200 rounded-lg px-3 py-2" /></div>
        {tab === 'PERIODO' && (
          <div><label className="text-xs text-slate-500 block">Agrupar</label>
            <select value={granularity} onChange={(e) => setGranularity(e.target.value)} className="border border-slate-200 rounded-lg px-3 py-2"><option value="day">Diario</option><option value="week">Semanal</option><option value="month">Mensual</option><option value="quarter">Trimestral</option><option value="year">Anual</option></select>
          </div>
        )}
        <button onClick={load} className="px-4 py-2 bg-emerald-600 text-white rounded-lg">Generar</button>
        {tab === 'AR' && <button onClick={() => downloadXlsx('/accounting-reports/ar-aging.xlsx', 'cartera_cobrar.xlsx')} className="px-4 py-2 bg-slate-700 text-white rounded-lg flex items-center gap-2"><HiOutlineArrowDownTray /> Excel</button>}
        {tab === 'AP' && <button onClick={() => downloadXlsx('/accounting-reports/ap-aging.xlsx', 'cartera_pagar.xlsx')} className="px-4 py-2 bg-slate-700 text-white rounded-lg flex items-center gap-2"><HiOutlineArrowDownTray /> Excel</button>}
      </div>
      {data && <div className="bg-white rounded-xl p-4 shadow-sm overflow-auto">{renderTable()}</div>}
    </div>
  );
}

function Table({ head, rows }) {
  return (
    <table className="w-full text-sm">
      <thead className="bg-emerald-50 text-xs uppercase"><tr>{head.map((h, i) => <th key={i} className={`px-3 py-2 ${i === 0 ? 'text-left' : 'text-right'}`}>{h}</th>)}</tr></thead>
      <tbody>
        {rows.map((r, i) => <tr key={i} className="border-t">{r.map((c, j) => <td key={j} className={`px-3 py-2 ${j === 0 ? 'text-left' : 'text-right font-mono'}`}>{c}</td>)}</tr>)}
        {rows.length === 0 && <tr><td colSpan={head.length} className="px-3 py-6 text-center text-slate-400">Sin datos</td></tr>}
      </tbody>
    </table>
  );
}

function Stat({ title, value, color = 'text-slate-800', small }) {
  return <div className="bg-slate-50 rounded-lg p-3"><p className="text-xs text-slate-500">{title}</p><p className={`${small ? 'text-base' : 'text-xl'} font-bold ${color}`}>{value}</p></div>;
}
