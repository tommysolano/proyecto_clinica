import { useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import { HiOutlineDocumentArrowDown, HiOutlineInformationCircle } from 'react-icons/hi2';
import { fmt, fmtDate, downloadBlob } from './_utils';
import NumericInput from '../../components/NumericInput';

// Nota explicativa: en los reportes SRI las ventas provienen SOLO de facturas electrónicas
// AUTORIZADAS. Si hay ventas registradas sin autorizar, se avisa para que no parezca un bug.
function SalesAuthNote({ pending }) {
  return (
    <div className="text-xs rounded-lg px-3 py-2 mb-2 bg-sky-50 border border-sky-200 text-sky-800 flex items-start gap-1.5">
      <HiOutlineInformationCircle className="w-4 h-4 shrink-0 mt-0.5" />
      <span>
        Este reporte incluye <b>solo ventas con factura electrónica autorizada</b>. Las ventas sin factura autorizada no aparecen en reportes SRI.
        {pending > 0 && <> <b className="text-amber-700">Hay {pending} venta(s) registrada(s) sin autorizar</b> en este período; por eso no se muestran aquí.</>}
      </span>
    </div>
  );
}

const PERIOD_TYPES = [
  ['MONTHLY', 'Mensual'],
  ['FIRST_SEMESTER', 'Primer semestre'],
  ['SECOND_SEMESTER', 'Segundo semestre'],
  ['ANNUAL', 'Anual'],
  ['CUSTOM', 'Rango personalizado'],
];

const iso = (d) => d.toISOString().slice(0, 10);

export default function SriReports() {
  const [tab, setTab] = useState('F104');
  const [periodType, setPeriodType] = useState('MONTHLY');
  const [year, setYear] = useState(new Date().getFullYear());
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [startDate, setStartDate] = useState(iso(new Date(new Date().getFullYear(), 0, 1)));
  const [endDate, setEndDate] = useState(iso(new Date()));
  const [data, setData] = useState(null);

  const URLS = { F104: '/accounting-reports/sri/form-104', F103: '/accounting-reports/sri/form-103', ATS: '/accounting-reports/sri/ats-preview', VC: '/accounting-reports/sri/purchases-sales', RDEP: '/accounting-reports/sri/rdep', RET: '/accounting-reports/sri/retentions-received' };

  // RDEP es anual por diseño (anexo de relación de dependencia): solo usa año.
  const isRdep = tab === 'RDEP';
  const isMonthly = periodType === 'MONTHLY';

  // Parámetros del período según el tipo seleccionado (compat con year/month legacy).
  const buildParams = () => {
    if (isRdep) return { year };
    if (periodType === 'MONTHLY') return { periodType, year, month };
    if (periodType === 'CUSTOM') return { periodType, startDate, endDate };
    return { periodType, year }; // semestres / anual
  };

  const suffix = () => {
    if (periodType === 'MONTHLY') return `${year}_${String(month).padStart(2, '0')}`;
    if (periodType === 'CUSTOM') return `${startDate}_${endDate}`;
    if (periodType === 'FIRST_SEMESTER') return `${year}_S1`;
    if (periodType === 'SECOND_SEMESTER') return `${year}_S2`;
    return `${year}`;
  };

  const load = async () => {
    try {
      const params = buildParams();
      if (isRdep) { const r = await api.get(URLS.RDEP, { params }); setData(r.data); return; }
      const r = await api.get(URLS[tab], { params });
      setData(r.data);
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  const downloadRdepXml = async () => {
    try { const r = await api.get('/accounting-reports/sri/rdep', { params: { year, format: 'xml' }, responseType: 'blob' }); downloadBlob(r.data, `RDEP_${year}.xml`); toast.success('RDEP descargado'); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  // XML oficiales (Form 103/104): SOLO mensuales.
  const downloadXml = async () => {
    if (!isMonthly) { toast.error('El XML oficial se genera por mes. Cambie el período a "Mensual".'); return; }
    try {
      const url = tab === 'F104' ? '/accounting-reports/sri/form-104.xml' : '/accounting-reports/sri/form-103.xml';
      const r = await api.get(url, { params: { periodType: 'MONTHLY', year, month }, responseType: 'blob' });
      downloadBlob(r.data, `${tab}_${suffix()}.xml`);
      toast.success('XML descargado');
    } catch (e) { toast.error(e.response?.data?.message || 'Error al descargar XML'); }
  };

  // ATS oficial (XML): SOLO mensual. El reporte visual sí acepta rangos.
  const downloadAtsXml = async () => {
    if (!isMonthly) { toast.error('El ATS XML se genera por mes. Cambie el período a "Mensual".'); return; }
    try {
      const r = await api.get('/accounting-reports/sri/ats', { params: { periodType: 'MONTHLY', year, month }, responseType: 'blob' });
      downloadBlob(r.data, `ATS_${suffix()}.xml`);
      toast.success('ATS descargado');
    } catch (e) { toast.error(e.response?.data?.message || 'Error al descargar ATS'); }
  };

  const label = data?.period?.label;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineDocumentArrowDown className="text-emerald-600" /> Reportes SRI</h1>
      <div className="flex gap-2 flex-wrap">
        {[['F104', 'Formulario 104 (IVA)'], ['F103', 'Formulario 103 (Retenciones)'], ['ATS', 'ATS (visual + XML)'], ['RDEP', 'RDEP (Rel. dependencia)'], ['RET', 'Retenciones recibidas'], ['VC', 'Ventas/Compras']].map(([k, l]) =>
          <button key={k} onClick={() => { setTab(k); setData(null); }} className={`px-3 py-2 rounded-lg text-xs ${tab === k ? 'bg-emerald-600 text-white' : 'bg-white border'}`}>{l}</button>)}
      </div>

      <div className="bg-white p-3 rounded-xl shadow-sm flex gap-3 items-end flex-wrap">
        {!isRdep && (
          <div>
            <label className="text-xs text-slate-500 block">Tipo de período</label>
            <select value={periodType} onChange={(e) => { setPeriodType(e.target.value); setData(null); }} className="border border-slate-200 rounded-xl px-3 py-2.5">
              {PERIOD_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </div>
        )}

        {(isRdep || periodType !== 'CUSTOM') && (
          <div><label className="text-xs text-slate-500 block">Año</label><NumericInput value={year} onChange={(e) => setYear(+e.target.value)} className="border border-slate-200 rounded-xl px-3.5 py-2.5 w-24" /></div>
        )}
        {!isRdep && periodType === 'MONTHLY' && (
          <div><label className="text-xs text-slate-500 block">Mes</label><NumericInput min="1" max="12" value={month} onChange={(e) => setMonth(+e.target.value)} className="border border-slate-200 rounded-xl px-3.5 py-2.5 w-20" /></div>
        )}
        {!isRdep && periodType === 'CUSTOM' && (
          <>
            <div><label className="text-xs text-slate-500 block">Desde</label><input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="border border-slate-200 rounded-xl px-3 py-2.5" /></div>
            <div><label className="text-xs text-slate-500 block">Hasta</label><input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="border border-slate-200 rounded-xl px-3 py-2.5" /></div>
          </>
        )}

        <button onClick={load} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20">Generar</button>

        {isRdep && <button onClick={downloadRdepXml} className="px-4 py-2 bg-indigo-600 text-white rounded-lg flex items-center gap-1"><HiOutlineDocumentArrowDown className="w-4 h-4" /> Descargar XML</button>}

        {(tab === 'F103' || tab === 'F104') && (
          <button onClick={downloadXml} disabled={!isMonthly} title={isMonthly ? '' : 'El XML oficial se genera por mes'} className={`px-4 py-2 rounded-lg flex items-center gap-1 ${isMonthly ? 'bg-indigo-600 text-white' : 'bg-slate-200 text-slate-400 cursor-not-allowed'}`}>
            <HiOutlineDocumentArrowDown className="w-4 h-4" /> Descargar XML (DIMM)
          </button>
        )}

        {tab === 'ATS' && (
          <button onClick={downloadAtsXml} disabled={!isMonthly} title={isMonthly ? '' : 'El ATS XML se genera por mes'} className={`px-4 py-2 rounded-lg flex items-center gap-1 ${isMonthly ? 'bg-indigo-600 text-white' : 'bg-slate-200 text-slate-400 cursor-not-allowed'}`}>
            <HiOutlineDocumentArrowDown className="w-4 h-4" /> Descargar XML (ATS)
          </button>
        )}

        {tab === 'VC' && (
          <button
            onClick={async () => {
              try { const r = await api.get('/accounting-reports/sri/purchases-sales.xlsx', { params: buildParams(), responseType: 'blob' }); downloadBlob(r.data, `compras_ventas_${suffix()}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); }
              catch { toast.error('Error al exportar'); }
            }}
            className="px-4 py-2 bg-slate-700 text-white rounded-lg flex items-center gap-1"
          >
            <HiOutlineDocumentArrowDown className="w-4 h-4" /> Excel
          </button>
        )}
      </div>

      {!isRdep && (tab === 'F103' || tab === 'F104' || tab === 'ATS') && !isMonthly && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          El XML oficial solo se genera por mes. Con este período verá el reporte visual; para descargar el XML cambie a período <b>Mensual</b>.
        </p>
      )}

      {label && <p className="text-sm text-slate-600">Período: <b>{label}</b></p>}

      {data && (
        <div className="space-y-4">
          {tab === 'VC' && <PurchasesSales data={data} />}
          {tab === 'F104' && <Form104 data={data} />}
          {tab === 'F103' && <RetentionTable title="Retenciones en la fuente (Form. 103)" data={data} cols={[['code', 'Código'], ['description', 'Descripción'], ['base', 'Base', true], ['amount', 'Valor retenido', true]]} />}
          {tab === 'ATS' && <AtsPreview data={data} />}
          {tab === 'RET' && <RetentionTable title="Retenciones recibidas" data={data} cols={[['type', 'Tipo'], ['sriCode', 'Código SRI'], ['count', '# Comprob.'], ['base', 'Base', true], ['value', 'Valor', true]]} />}
          {tab === 'RDEP' && <Rdep data={data} />}
        </div>
      )}
    </div>
  );
}

function Section({ title, subtitle, children }) {
  return (
    <div className="bg-white rounded-xl p-4 shadow-sm overflow-auto">
      {title && <h2 className="font-semibold text-slate-800 mb-1">{title}</h2>}
      {subtitle && <p className="text-xs text-slate-500 mb-2">{subtitle}</p>}
      {children}
    </div>
  );
}

// Libro de Compras y Ventas (tab VC): dos tablas con las columnas del SRI.
function PurchasesSales({ data }) {
  const ventas = data?.ventas || [];
  const compras = data?.compras || [];
  const pending = data?.salesPending || 0;
  const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
  return (
    <>
      <Section title={`Ventas (${ventas.length})`} subtitle="Comprobantes de venta autorizados del período (por fecha de emisión). Base separada por tarifa 0% y 15%.">
        <SalesAuthNote pending={pending} />
        <table className="tbl text-xs">
          <thead className="bg-emerald-50 uppercase"><tr>
            <th className="px-2 py-1 text-left">Fecha</th><th className="px-2 py-1 text-left">Comprobante</th>
            <th className="px-2 py-1 text-left">Cliente</th><th className="px-2 py-1 text-left">Identificación</th>
            <th className="px-2 py-1 text-right">Base 0%</th><th className="px-2 py-1 text-right">Base 15%</th>
            <th className="px-2 py-1 text-right">IVA</th><th className="px-2 py-1 text-right">Total</th>
          </tr></thead>
          <tbody>
            {ventas.map((v, i) => {
              const tb = v.taxBreakdown || {};
              const doc = [v.estab, v.ptoEmi, v.secuencial].filter(Boolean).join('-');
              return (
              <tr key={i} className="border-t">
                <td className="px-2 py-1">{fmtDate(v.fechaEmision || v.createdAt)}</td>
                <td className="px-2 py-1 font-mono">{v._id ? <Link to={`/invoices?doc=${v._id}`} className="text-emerald-700 hover:underline" title="Abrir factura electrónica">{doc || '—'}</Link> : (doc || '—')}</td>
                <td className="px-2 py-1">{v.razonSocialComprador || '—'}</td>
                <td className="px-2 py-1 font-mono">{v.identificacionComprador || '—'}</td>
                <td className="px-2 py-1 text-right font-mono">{fmt(tb.base0 ?? 0)}</td>
                <td className="px-2 py-1 text-right font-mono">{fmt(tb.baseGravada ?? 0)}</td>
                <td className="px-2 py-1 text-right font-mono">{fmt(tb.iva ?? v.totalImpuesto)}</td>
                <td className="px-2 py-1 text-right font-mono">{fmt(v.importeTotal ?? v.total)}</td>
              </tr>
              );
            })}
            {ventas.length === 0 && <tr><td colSpan={8} className="px-2 py-4 text-center text-slate-400">{pending > 0 ? `No hay ventas autorizadas; hay ${pending} sin autorizar que no se reportan.` : 'No hay ventas autorizadas en este período.'}</td></tr>}
          </tbody>
          {ventas.length > 0 && <tfoot className="bg-slate-100 font-bold"><tr>
            <td colSpan={4} className="px-2 py-1 text-right">TOTALES</td>
            <td className="px-2 py-1 text-right font-mono">{fmt(sum(ventas, (v) => v.taxBreakdown?.base0 ?? 0))}</td>
            <td className="px-2 py-1 text-right font-mono">{fmt(sum(ventas, (v) => v.taxBreakdown?.baseGravada ?? 0))}</td>
            <td className="px-2 py-1 text-right font-mono">{fmt(sum(ventas, (v) => v.taxBreakdown?.iva ?? v.totalImpuesto ?? 0))}</td>
            <td className="px-2 py-1 text-right font-mono">{fmt(sum(ventas, (v) => v.importeTotal ?? v.total ?? 0))}</td>
          </tr></tfoot>}
        </table>
      </Section>
      <Section title={`Compras (${compras.length})`} subtitle="Comprobantes recibidos de proveedores del período.">
        <table className="tbl text-xs">
          <thead className="bg-emerald-50 uppercase"><tr>
            <th className="px-2 py-1 text-left">Fecha</th><th className="px-2 py-1 text-left">Comprobante</th>
            <th className="px-2 py-1 text-left">Proveedor</th><th className="px-2 py-1 text-left">RUC</th>
            <th className="px-2 py-1 text-right">Subtotal</th><th className="px-2 py-1 text-right">IVA</th>
            <th className="px-2 py-1 text-right">Retención</th><th className="px-2 py-1 text-right">Total</th>
          </tr></thead>
          <tbody>
            {compras.map((c, i) => (
              <tr key={i} className="border-t">
                <td className="px-2 py-1">{fmtDate(c.fechaEmision)}</td>
                <td className="px-2 py-1 font-mono">{c._id ? <Link to={`/accounting/purchases?doc=${c._id}`} className="text-emerald-700 hover:underline" title="Abrir factura de compra">{c.serie || '—'}</Link> : (c.serie || '—')}</td>
                <td className="px-2 py-1">{c.supplier?.razonSocial || '—'}</td>
                <td className="px-2 py-1 font-mono">{c.supplier?.ruc || '—'}</td>
                <td className="px-2 py-1 text-right font-mono">{fmt(c.subtotal)}</td>
                <td className="px-2 py-1 text-right font-mono">{fmt(c.iva)}</td>
                <td className="px-2 py-1 text-right font-mono">{fmt(c.retentionTotal)}</td>
                <td className="px-2 py-1 text-right font-mono">{fmt(c.total)}</td>
              </tr>
            ))}
            {compras.length === 0 && <tr><td colSpan={8} className="px-2 py-4 text-center text-slate-400">Sin compras en el período.</td></tr>}
          </tbody>
          {compras.length > 0 && <tfoot className="bg-slate-100 font-bold"><tr>
            <td colSpan={4} className="px-2 py-1 text-right">TOTALES</td>
            <td className="px-2 py-1 text-right font-mono">{fmt(sum(compras, (c) => c.subtotal ?? 0))}</td>
            <td className="px-2 py-1 text-right font-mono">{fmt(sum(compras, (c) => c.iva ?? 0))}</td>
            <td className="px-2 py-1 text-right font-mono">{fmt(sum(compras, (c) => c.retentionTotal ?? 0))}</td>
            <td className="px-2 py-1 text-right font-mono">{fmt(sum(compras, (c) => c.total ?? 0))}</td>
          </tr></tfoot>}
        </table>
      </Section>
    </>
  );
}

// Preliquidación del Formulario 104 (IVA).
function Form104({ data }) {
  const rows = [
    ['Ventas — base tarifa 0%', data?.ventas?.base0],
    ['Ventas — base gravada (15%)', data?.ventas?.baseGravada],
    ['Ventas — base imponible total', data?.ventas?.base],
    ['Ventas — IVA generado', data?.ventas?.iva],
    ['Compras — base imponible', data?.compras?.base],
    ['Compras — IVA', data?.compras?.iva],
    ['Compras — IVA con crédito tributario', data?.compras?.ivaCredito],
    ['Compras — IVA sin crédito (al gasto)', data?.compras?.ivaNoCredito],
    ['Retención de IVA que nos hicieron', data?.compras?.retIVA],
  ];
  return (
    <Section title={`Formulario 104 — IVA · ${data?.periodo || ''}`} subtitle={data?.nota}>
      <table className="tbl text-sm max-w-xl">
        <tbody>
          {rows.map(([label, val], i) => (
            <tr key={i} className="border-t"><td className="px-3 py-2">{label}</td><td className="px-3 py-2 text-right font-mono">{fmt(val)}</td></tr>
          ))}
          <tr className="border-t bg-emerald-50 font-bold"><td className="px-3 py-2">IVA por pagar (estimado)</td><td className="px-3 py-2 text-right font-mono">{fmt(data?.ivaPorPagar)}</td></tr>
        </tbody>
      </table>
    </Section>
  );
}

// ATS visual (compras + ventas del período). El XML oficial es mensual.
function AtsPreview({ data }) {
  const compras = data?.compras || [];
  const ventas = data?.ventas || [];
  const t = data?.totals || {};
  const pending = data?.salesPending || 0;
  return (
    <>
      <Section title={`ATS — Compras (${compras.length})`} subtitle="Detalle de compras del período con retenciones (base para el ATS).">
        <table className="tbl text-xs">
          <thead className="bg-emerald-50 uppercase"><tr>
            <th className="px-2 py-1 text-left">Fecha</th><th className="px-2 py-1 text-left">Comprobante</th>
            <th className="px-2 py-1 text-left">Proveedor</th><th className="px-2 py-1 text-left">RUC</th>
            <th className="px-2 py-1 text-right">Base gravada</th><th className="px-2 py-1 text-right">Base 0%</th>
            <th className="px-2 py-1 text-right">IVA</th><th className="px-2 py-1 text-right">Ret. IVA</th>
            <th className="px-2 py-1 text-right">Ret. Renta</th><th className="px-2 py-1 text-right">Total</th>
          </tr></thead>
          <tbody>
            {compras.map((c, i) => (
              <tr key={i} className="border-t">
                <td className="px-2 py-1">{fmtDate(c.fecha)}</td>
                <td className="px-2 py-1 font-mono">{c.serie || '—'}</td>
                <td className="px-2 py-1">{c.proveedor || '—'}</td>
                <td className="px-2 py-1 font-mono">{c.ruc || '—'}</td>
                <td className="px-2 py-1 text-right font-mono">{fmt(c.baseGrav)}</td>
                <td className="px-2 py-1 text-right font-mono">{fmt(c.base0)}</td>
                <td className="px-2 py-1 text-right font-mono">{fmt(c.iva)}</td>
                <td className="px-2 py-1 text-right font-mono">{fmt(c.retIva)}</td>
                <td className="px-2 py-1 text-right font-mono">{fmt(c.retRenta)}</td>
                <td className="px-2 py-1 text-right font-mono">{fmt(c.total)}</td>
              </tr>
            ))}
            {compras.length === 0 && <tr><td colSpan={10} className="px-2 py-4 text-center text-slate-400">Sin compras en el período.</td></tr>}
          </tbody>
          {compras.length > 0 && <tfoot className="bg-slate-100 font-bold"><tr>
            <td colSpan={6} className="px-2 py-1 text-right">TOTALES</td>
            <td className="px-2 py-1 text-right font-mono">{fmt(t.comprasIva)}</td>
            <td className="px-2 py-1 text-right font-mono">{fmt(t.comprasRetIva)}</td>
            <td className="px-2 py-1 text-right font-mono">{fmt(t.comprasRetRenta)}</td>
            <td className="px-2 py-1 text-right font-mono">{fmt(t.comprasTotal)}</td>
          </tr></tfoot>}
        </table>
      </Section>
      <Section title={`ATS — Ventas (${ventas.length})`} subtitle="Ventas agrupadas por cliente (comprobantes autorizados). Base separada por tarifa 0% y 15%.">
        <SalesAuthNote pending={pending} />
        <table className="tbl text-xs">
          <thead className="bg-emerald-50 uppercase"><tr>
            <th className="px-2 py-1 text-left">Identificación</th><th className="px-2 py-1 text-left">Cliente</th>
            <th className="px-2 py-1 text-right"># Comprob.</th><th className="px-2 py-1 text-right">Base 0%</th>
            <th className="px-2 py-1 text-right">Base 15%</th><th className="px-2 py-1 text-right">IVA</th><th className="px-2 py-1 text-right">Total</th>
          </tr></thead>
          <tbody>
            {ventas.map((v, i) => (
              <tr key={i} className="border-t">
                <td className="px-2 py-1 font-mono">{v.idCliente}</td>
                <td className="px-2 py-1">{v.razonSocial}</td>
                <td className="px-2 py-1 text-right font-mono">{v.numComprobantes}</td>
                <td className="px-2 py-1 text-right font-mono">{fmt(v.base0)}</td>
                <td className="px-2 py-1 text-right font-mono">{fmt(v.baseGrav)}</td>
                <td className="px-2 py-1 text-right font-mono">{fmt(v.iva)}</td>
                <td className="px-2 py-1 text-right font-mono">{fmt(v.total)}</td>
              </tr>
            ))}
            {ventas.length === 0 && <tr><td colSpan={7} className="px-2 py-4 text-center text-slate-400">{pending > 0 ? `No hay ventas autorizadas; hay ${pending} sin autorizar que no se reportan.` : 'No hay ventas autorizadas en este período.'}</td></tr>}
          </tbody>
          {ventas.length > 0 && <tfoot className="bg-slate-100 font-bold"><tr>
            <td colSpan={3} className="px-2 py-1 text-right">TOTALES</td>
            <td className="px-2 py-1 text-right font-mono">{fmt(t.ventasBase0)}</td>
            <td className="px-2 py-1 text-right font-mono">{fmt(t.ventasBaseGrav)}</td>
            <td className="px-2 py-1 text-right font-mono">{fmt(t.ventasIva)}</td>
            <td className="px-2 py-1 text-right font-mono">{fmt(t.ventasTotal)}</td>
          </tr></tfoot>}
        </table>
      </Section>
    </>
  );
}

// Tabla genérica de retenciones (Form. 103 / recibidas). cols: [key, label, isMoney?].
function RetentionTable({ title, data, cols }) {
  const rows = data?.rows || [];
  return (
    <Section title={`${title} · ${data?.periodo || ''}`}>
      <table className="tbl text-sm">
        <thead className="bg-emerald-50 text-xs uppercase"><tr>
          {cols.map(([k, label, money]) => <th key={k} className={`px-3 py-2 ${money ? 'text-right' : 'text-left'}`}>{label}</th>)}
        </tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t">
              {cols.map(([k, , money]) => <td key={k} className={`px-3 py-2 ${money ? 'text-right font-mono' : ''}`}>{money ? fmt(r[k]) : String(r[k] ?? '')}</td>)}
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={cols.length} className="px-3 py-4 text-center text-slate-400">Sin datos en el período.</td></tr>}
        </tbody>
        <tfoot className="bg-slate-100 font-bold"><tr>
          <td colSpan={cols.length - 1} className="px-3 py-2 text-right">TOTAL</td>
          <td className="px-3 py-2 text-right font-mono">{fmt(data?.total)}</td>
        </tr></tfoot>
      </table>
    </Section>
  );
}

// RDEP — retenciones en relación de dependencia (anual).
function Rdep({ data }) {
  const rows = data?.empleados || [];
  return (
    <Section title={`RDEP — Relación de dependencia · ${data?.year || ''}`}>
      <table className="tbl text-sm">
        <thead className="bg-emerald-50 text-xs uppercase"><tr>
          <th className="px-3 py-2 text-left">Identificación</th><th className="px-3 py-2 text-left">Nombre</th>
          <th className="px-3 py-2 text-right">Sueldos</th><th className="px-3 py-2 text-right">Ingreso exento</th>
          <th className="px-3 py-2 text-right">Aporte IESS</th><th className="px-3 py-2 text-right">Imp. renta retenido</th>
        </tr></thead>
        <tbody>
          {rows.map((e, i) => (
            <tr key={i} className="border-t">
              <td className="px-3 py-2 font-mono">{e.identificacion}</td><td className="px-3 py-2">{e.nombre}</td>
              <td className="px-3 py-2 text-right font-mono">{fmt(e.sueldo)}</td>
              <td className="px-3 py-2 text-right font-mono">{fmt(e.ingresoExento)}</td>
              <td className="px-3 py-2 text-right font-mono">{fmt(e.aporteIess)}</td>
              <td className="px-3 py-2 text-right font-mono">{fmt(e.impuestoRenta)}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={6} className="px-3 py-4 text-center text-slate-400">Sin roles cerrados en el año.</td></tr>}
        </tbody>
        <tfoot className="bg-slate-100 font-bold"><tr>
          <td colSpan={5} className="px-3 py-2 text-right">TOTAL IMP. RENTA RETENIDO</td>
          <td className="px-3 py-2 text-right font-mono">{fmt(data?.total)}</td>
        </tr></tfoot>
      </table>
    </Section>
  );
}
