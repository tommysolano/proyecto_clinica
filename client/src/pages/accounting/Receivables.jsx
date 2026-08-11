import { useEffect, useState, useCallback } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import { fmt, fmtDate } from './_utils';
import SourceDocLink from '../../components/SourceDocLink';
import { HiOutlineDocumentText, HiOutlineArrowDownTray } from 'react-icons/hi2';

const STATUS_CLS = {
  ABIERTO: 'bg-slate-100 text-slate-600',
  PARCIAL: 'bg-amber-100 text-amber-700',
  PAGADO: 'bg-emerald-100 text-emerald-700',
  ANULADO: 'bg-rose-100 text-rose-700',
};

/** Fecha de hoy LOCAL (Ecuador) en YYYY-MM-DD, no UTC (ver docs/FLUJO_DE_CAJA.md). */
const hoyLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export default function Receivables() {
  const [side, setSide] = useState('AR'); // AR = CxC, AP = CxP
  const [view, setView] = useState('aging'); // aging | docs
  const [asOf, setAsOf] = useState(hoyLocal()); // fecha de corte del aging / días vencidos
  const [q, setQ] = useState(''); // filtro por nombre de cliente/proveedor
  const [aging, setAging] = useState({ rows: [], totals: {} });
  const [docs, setDocs] = useState([]);
  const [statement, setStatement] = useState(null);
  const [stmtParty, setStmtParty] = useState('');

  /** Los mismos filtros que se envían a pantalla se envían al Excel: cuadran por construcción. */
  const queryParams = useCallback(() => {
    const p = { side };
    if (asOf) p.asOf = asOf;
    if (q.trim()) p.q = q.trim();
    return p;
  }, [side, asOf, q]);

  const load = useCallback(async () => {
    try {
      if (view === 'aging') {
        const r = await api.get('/subledger/aging', { params: queryParams() });
        setAging(r.data || { rows: [], totals: {} });
      } else {
        const r = await api.get('/subledger', { params: queryParams() });
        setDocs(r.data || []);
      }
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  }, [view, queryParams]);
  useEffect(() => { load(); }, [load]);

  /** Descarga el Excel de la vista actual respetando side, vista y filtros (mismo patrón que el flujo de caja). */
  const exportar = async () => {
    try {
      const params = { ...queryParams(), view: view === 'aging' ? 'aging' : 'documents' };
      const res = await api.get('/subledger/export.xlsx', { params, responseType: 'blob' });
      const u = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      const base = side === 'AP' ? 'cuentas_por_pagar' : 'cuentas_por_cobrar';
      a.href = u; a.download = `${base}_${view === 'aging' ? 'antiguedad' : 'documentos'}.xlsx`; a.click();
      URL.revokeObjectURL(u);
    } catch { toast.error('Error al exportar'); }
  };

  const openStatement = async (partyRef, partyName) => {
    if (!partyRef) return;
    try {
      const r = await api.get('/subledger/statement', { params: { side, partyRef } });
      setStmtParty(partyName || '');
      setStatement(r.data);
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  const t = aging.totals || {};
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight">Cartera</h1>
        <div className="flex gap-2 flex-wrap items-center">
          <div className="flex rounded-xl overflow-hidden border border-emerald-200">
            <button onClick={() => setSide('AR')} className={`px-4 py-2 text-sm ${side === 'AR' ? 'bg-emerald-600 text-white' : 'bg-white text-slate-600'}`}>Por Cobrar</button>
            <button onClick={() => setSide('AP')} className={`px-4 py-2 text-sm ${side === 'AP' ? 'bg-emerald-600 text-white' : 'bg-white text-slate-600'}`}>Por Pagar</button>
          </div>
          <div className="flex rounded-xl overflow-hidden border border-slate-200">
            <button onClick={() => setView('aging')} className={`px-4 py-2 text-sm ${view === 'aging' ? 'bg-slate-700 text-white' : 'bg-white text-slate-600'}`}>Antigüedad</button>
            <button onClick={() => setView('docs')} className={`px-4 py-2 text-sm ${view === 'docs' ? 'bg-slate-700 text-white' : 'bg-white text-slate-600'}`}>Documentos</button>
          </div>
        </div>
      </div>

      {/* Filtros: fecha de corte y contraparte. Se envían igual a la pantalla y al Excel. */}
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-500 flex flex-col gap-1">
          Fecha de corte
          <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)}
            className="px-3 py-2 border border-slate-200 rounded-lg text-sm" />
        </label>
        <label className="text-xs text-slate-500 flex flex-col gap-1 flex-1 min-w-[180px]">
          {side === 'AR' ? 'Cliente' : 'Proveedor'}
          <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por nombre…"
            className="px-3 py-2 border border-slate-200 rounded-lg text-sm" />
        </label>
        <button onClick={exportar}
          className="px-3 py-2 bg-slate-700 text-white rounded-xl text-sm flex items-center gap-1.5">
          <HiOutlineArrowDownTray className="w-4 h-4" /> Descargar Excel
        </button>
      </div>

      {view === 'aging' && (
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 overflow-hidden">
          <table className="tbl">
            <thead className="bg-emerald-50 text-xs uppercase"><tr>
              <th className="px-3 py-2 text-left">{side === 'AR' ? 'Cliente' : 'Proveedor'}</th>
              <th className="px-3 py-2 text-right">Por vencer</th><th className="px-3 py-2 text-right">1-30</th>
              <th className="px-3 py-2 text-right">31-60</th><th className="px-3 py-2 text-right">61-90</th>
              <th className="px-3 py-2 text-right">+90</th><th className="px-3 py-2 text-right">Total</th><th></th>
            </tr></thead>
            <tbody>
              {aging.rows.map((r) => (
                <tr key={String(r.partyRef) + r.partyName} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2">{r.partyName}</td>
                  <td className="px-3 py-2 text-right">${fmt(r.current)}</td>
                  <td className="px-3 py-2 text-right">${fmt(r.d30)}</td>
                  <td className="px-3 py-2 text-right">${fmt(r.d60)}</td>
                  <td className="px-3 py-2 text-right">${fmt(r.d90)}</td>
                  <td className="px-3 py-2 text-right text-rose-600">${fmt(r.d90plus)}</td>
                  <td className="px-3 py-2 text-right font-semibold">${fmt(r.total)}</td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => openStatement(r.partyRef, r.partyName)} className="p-1.5 text-blue-600" title="Estado de cuenta"><HiOutlineDocumentText className="w-4 h-4" /></button>
                  </td>
                </tr>
              ))}
              {!aging.rows.length && <tr><td colSpan={8} className="px-3 py-8 text-center text-slate-400">Sin saldos pendientes</td></tr>}
            </tbody>
            {aging.rows.length > 0 && (
              <tfoot className="bg-slate-50 font-semibold"><tr>
                <td className="px-3 py-2">Total</td>
                <td className="px-3 py-2 text-right">${fmt(t.current)}</td><td className="px-3 py-2 text-right">${fmt(t.d30)}</td>
                <td className="px-3 py-2 text-right">${fmt(t.d60)}</td><td className="px-3 py-2 text-right">${fmt(t.d90)}</td>
                <td className="px-3 py-2 text-right">${fmt(t.d90plus)}</td><td className="px-3 py-2 text-right">${fmt(t.total)}</td><td></td>
              </tr></tfoot>
            )}
          </table>
        </div>
      )}

      {view === 'docs' && (
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 overflow-hidden">
          <table className="tbl">
            <thead className="bg-emerald-50 text-xs uppercase"><tr>
              <th className="px-3 py-2 text-left">Fecha</th><th className="px-3 py-2 text-left">Tipo</th>
              <th className="px-3 py-2 text-left">Número</th><th className="px-3 py-2 text-left">Contraparte</th>
              <th className="px-3 py-2 text-right">Total</th><th className="px-3 py-2 text-right">Aplicado</th>
              <th className="px-3 py-2 text-right">Saldo</th><th className="px-3 py-2 text-left">Estado</th>
            </tr></thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d._id} className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer" onClick={() => openStatement(d.party?.ref, d.party?.name)}>
                  <td className="px-3 py-2">{fmtDate(d.issueDate)}</td>
                  <td className="px-3 py-2">{d.docType}</td>
                  {/* El número abre el documento que generó el saldo (venta, factura
                      o compra): la cartera es la primera pantalla donde se pregunta
                      "¿y esto de dónde salió?". */}
                  <td className="px-3 py-2 font-mono text-xs">
                    <SourceDocLink row={d} number={d.number || '—'} />
                  </td>
                  <td className="px-3 py-2">{d.party?.name}</td>
                  <td className="px-3 py-2 text-right">${fmt(d.total)}</td>
                  <td className="px-3 py-2 text-right">${fmt(d.applied)}</td>
                  <td className="px-3 py-2 text-right font-semibold">${fmt(d.balance)}</td>
                  <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded-full text-xs ${STATUS_CLS[d.status] || ''}`}>{d.status}</span></td>
                </tr>
              ))}
              {!docs.length && <tr><td colSpan={8} className="px-3 py-8 text-center text-slate-400">Sin documentos</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      <Modal isOpen={!!statement} onClose={() => setStatement(null)} title={`Estado de cuenta — ${stmtParty}`}>
        {statement && (
          <div className="space-y-3 text-sm">
            <div className="text-right font-semibold">Saldo: ${fmt(statement.outstanding)}</div>
            <table className="tbl text-xs">
              <thead className="bg-slate-50"><tr>
                <th className="px-2 py-1 text-left">Fecha</th><th className="px-2 py-1 text-left">Doc</th>
                <th className="px-2 py-1 text-right">Total</th><th className="px-2 py-1 text-right">Aplicado</th>
                <th className="px-2 py-1 text-right">Saldo</th><th className="px-2 py-1 text-right">Acum.</th>
              </tr></thead>
              <tbody>
                {(statement.rows || []).map((r) => (
                  <tr key={r.id} className="border-t border-slate-100">
                    <td className="px-2 py-1">{fmtDate(r.date)}</td>
                    <td className="px-2 py-1">{r.docType} {r.number}</td>
                    <td className="px-2 py-1 text-right">${fmt(r.total)}</td>
                    <td className="px-2 py-1 text-right">${fmt(r.applied)}</td>
                    <td className="px-2 py-1 text-right">${fmt(r.balance)}</td>
                    <td className="px-2 py-1 text-right">${fmt(r.runningBalance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Modal>
    </div>
  );
}
