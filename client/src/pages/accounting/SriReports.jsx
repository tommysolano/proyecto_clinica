import { useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import { HiOutlineDocumentArrowDown } from 'react-icons/hi2';
import { fmt, fmtDate, downloadBlob } from './_utils';
import NumericInput from '../../components/NumericInput';

export default function SriReports() {
  const [tab, setTab] = useState('F104');
  const [year, setYear] = useState(new Date().getFullYear());
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [data, setData] = useState(null);

  const URLS = { F104: '/accounting-reports/sri/form-104', F103: '/accounting-reports/sri/form-103', ATS: '/accounting-reports/sri/ats', VC: '/accounting-reports/sri/purchases-sales', RDEP: '/accounting-reports/sri/rdep', RET: '/accounting-reports/sri/retentions-received' };

  const load = async () => {
    try {
      const params = { year, month };
      if (tab === 'ATS') {
        const r = await api.get(URLS[tab], { params, responseType: 'blob' });
        downloadBlob(r.data, `ATS_${year}_${String(month).padStart(2, '0')}.xml`);
        toast.success('ATS descargado');
        return;
      }
      if (tab === 'RDEP') { const r = await api.get(URLS[tab], { params: { year } }); setData(r.data); return; }
      if (tab === 'RET') { const r = await api.get(URLS[tab], { params }); setData(r.data); return; }
      const r = await api.get(URLS[tab], { params }); setData(r.data);
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  const downloadRdepXml = async () => {
    try { const r = await api.get('/accounting-reports/sri/rdep', { params: { year, format: 'xml' }, responseType: 'blob' }); downloadBlob(r.data, `RDEP_${year}.xml`); toast.success('RDEP descargado'); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  const downloadXml = async () => {
    try {
      const url =
        tab === 'F104'
          ? '/accounting-reports/sri/form-104.xml'
          : tab === 'F103'
          ? '/accounting-reports/sri/form-103.xml'
          : '/accounting-reports/sri/ats';
      const r = await api.get(url, { params: { year, month }, responseType: 'blob' });
      downloadBlob(r.data, `${tab}_${year}_${String(month).padStart(2, '0')}.xml`);
      toast.success('XML descargado');
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al descargar XML');
    }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineDocumentArrowDown className="text-emerald-600" /> Reportes SRI</h1>
      <div className="flex gap-2">
        {[['F104', 'Formulario 104 (IVA)'], ['F103', 'Formulario 103 (Retenciones)'], ['ATS', 'Anexo Trans Simplif (XML)'], ['RDEP', 'RDEP (Rel. dependencia)'], ['RET', 'Retenciones recibidas'], ['VC', 'Ventas/Compras']].map(([k, l]) =>
          <button key={k} onClick={() => { setTab(k); setData(null); }} className={`px-3 py-2 rounded-lg text-xs ${tab === k ? 'bg-emerald-600 text-white' : 'bg-white border'}`}>{l}</button>)}
      </div>
      <div className="bg-white p-3 rounded-xl shadow-sm flex gap-2 items-end">
        <div><label className="text-xs text-slate-500">Año</label><NumericInput value={year} onChange={(e) => setYear(+e.target.value)} className="border border-slate-200 rounded-xl px-3.5 py-2.5 w-24" /></div>
        <div><label className="text-xs text-slate-500">Mes</label><NumericInput min="1" max="12" value={month} onChange={(e) => setMonth(+e.target.value)} className="border border-slate-200 rounded-xl px-3.5 py-2.5 w-20" /></div>
        <button onClick={load} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20">{tab === 'ATS' ? 'Descargar XML' : 'Generar'}</button>
        {tab === 'RDEP' && <button onClick={downloadRdepXml} className="px-4 py-2 bg-indigo-600 text-white rounded-lg flex items-center gap-1"><HiOutlineDocumentArrowDown className="w-4 h-4" /> Descargar XML</button>}
        {(tab === 'F103' || tab === 'F104') && (
          <button
            onClick={downloadXml}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg flex items-center gap-1"
          >
            <HiOutlineDocumentArrowDown className="w-4 h-4" /> Descargar XML (DIMM)
          </button>
        )}
        {tab === 'VC' && (
          <button
            onClick={async () => {
              try { const r = await api.get('/accounting-reports/sri/purchases-sales.xlsx', { params: { year, month }, responseType: 'blob' }); downloadBlob(r.data, `compras_ventas_${year}_${String(month).padStart(2, '0')}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); }
              catch { toast.error('Error al exportar'); }
            }}
            className="px-4 py-2 bg-slate-700 text-white rounded-lg flex items-center gap-1"
          >
            <HiOutlineDocumentArrowDown className="w-4 h-4" /> Excel
          </button>
        )}
      </div>
      {data && (
        <div className="space-y-4">
          {tab === 'VC' && <PurchasesSales data={data} />}
          {tab === 'F104' && <Form104 data={data} />}
          {tab === 'F103' && <RetentionTable title="Retenciones en la fuente (Form. 103)" data={data} cols={[['code', 'Código'], ['description', 'Descripción'], ['base', 'Base', true], ['amount', 'Valor retenido', true]]} />}
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
  const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
  return (
    <>
      <Section title={`Ventas (${ventas.length})`} subtitle="Comprobantes de venta autorizados del período.">
        <table className="tbl text-xs">
          <thead className="bg-emerald-50 uppercase"><tr>
            <th className="px-2 py-1 text-left">Fecha</th><th className="px-2 py-1 text-left">Comprobante</th>
            <th className="px-2 py-1 text-left">Cliente</th><th className="px-2 py-1 text-left">Identificación</th>
            <th className="px-2 py-1 text-right">Subtotal</th><th className="px-2 py-1 text-right">IVA</th><th className="px-2 py-1 text-right">Total</th>
          </tr></thead>
          <tbody>
            {ventas.map((v, i) => (
              <tr key={i} className="border-t">
                <td className="px-2 py-1">{fmtDate(v.fechaEmision || v.createdAt)}</td>
                <td className="px-2 py-1 font-mono">{[v.estab, v.ptoEmi, v.secuencial].filter(Boolean).join('-')}</td>
                <td className="px-2 py-1">{v.razonSocialComprador || '—'}</td>
                <td className="px-2 py-1 font-mono">{v.identificacionComprador || '—'}</td>
                <td className="px-2 py-1 text-right font-mono">{fmt(v.totalSinImpuestos ?? v.subtotal)}</td>
                <td className="px-2 py-1 text-right font-mono">{fmt(v.totalImpuesto)}</td>
                <td className="px-2 py-1 text-right font-mono">{fmt(v.importeTotal ?? v.total)}</td>
              </tr>
            ))}
            {ventas.length === 0 && <tr><td colSpan={7} className="px-2 py-4 text-center text-slate-400">Sin ventas en el período.</td></tr>}
          </tbody>
          {ventas.length > 0 && <tfoot className="bg-slate-100 font-bold"><tr>
            <td colSpan={4} className="px-2 py-1 text-right">TOTALES</td>
            <td className="px-2 py-1 text-right font-mono">{fmt(sum(ventas, (v) => v.totalSinImpuestos ?? v.subtotal ?? 0))}</td>
            <td className="px-2 py-1 text-right font-mono">{fmt(sum(ventas, (v) => v.totalImpuesto ?? 0))}</td>
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
                <td className="px-2 py-1 font-mono">{c.serie || '—'}</td>
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
    ['Ventas — base imponible', data?.ventas?.base],
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
