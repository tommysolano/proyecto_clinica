import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import JournalEntryViewModal from '../../components/JournalEntryViewModal';
import { fmt, fmtDate } from './_utils';
import { HiOutlineArrowPath, HiOutlineEye, HiOutlineDocumentText } from 'react-icons/hi2';

const ESTADO_CLS = {
  AUTORIZADO: 'bg-emerald-100 text-emerald-700',
  RECIBIDA: 'bg-sky-100 text-sky-700',
  EN_COLA: 'bg-slate-100 text-slate-600',
  FIRMADO: 'bg-slate-100 text-slate-600',
  NO_AUTORIZADO: 'bg-rose-100 text-rose-700',
  DEVUELTA: 'bg-rose-100 text-rose-700',
  ERROR: 'bg-rose-100 text-rose-700',
};

export default function RetentionVouchers() {
  const [list, setList] = useState([]);
  const [sel, setSel] = useState(null);
  const [viewEntry, setViewEntry] = useState(null);

  const load = async () => {
    try { const r = await api.get('/retention-vouchers'); setList(r.data || []); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  useEffect(() => { load(); }, []);

  const retry = async (v) => {
    try { await api.post(`/retention-vouchers/${v._id}/retry`); toast.success('Reintentado'); load(); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight">Comprobantes de Retención</h1>
        <span className="text-xs text-slate-500">Se emiten desde una compra con retenciones (Compras → Emitir retención).</span>
      </div>
      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 overflow-hidden">
        <table className="tbl">
          <thead className="bg-emerald-50 text-xs uppercase"><tr>
            <th className="px-3 py-2 text-left">Fecha</th><th className="px-3 py-2 text-left">Serie</th>
            <th className="px-3 py-2 text-left">Proveedor</th><th className="px-3 py-2 text-right">Total retenido</th>
            <th className="px-3 py-2 text-left">Estado</th><th className="px-3 py-2"></th>
          </tr></thead>
          <tbody>
            {list.map((v) => (
              <tr key={v._id} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="px-3 py-2">{fmtDate(v.fechaEmision)}</td>
                <td className="px-3 py-2 font-mono text-xs">{v.serie}</td>
                <td className="px-3 py-2">{v.supplierName}</td>
                <td className="px-3 py-2 text-right">${fmt(v.totalRetenido)}</td>
                <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded-full text-xs ${ESTADO_CLS[v.estado] || 'bg-slate-100 text-slate-600'}`}>{v.estado}</span></td>
                <td className="px-3 py-2 flex gap-1 justify-end">
                  <button onClick={() => setSel(v)} className="p-1.5 text-blue-600" title="Ver"><HiOutlineEye className="w-4 h-4" /></button>
                  <button onClick={() => setViewEntry(v)} className="p-1.5 text-emerald-700" title="Ver asiento contable"><HiOutlineDocumentText className="w-4 h-4" /></button>
                  {['ERROR', 'DEVUELTA', 'EN_COLA', 'FIRMADO'].includes(v.estado) && (
                    <button onClick={() => retry(v)} className="p-1.5 text-emerald-600" title="Reintentar"><HiOutlineArrowPath className="w-4 h-4" /></button>
                  )}
                </td>
              </tr>
            ))}
            {!list.length && <tr><td colSpan={6} className="px-3 py-8 text-center text-slate-400">Sin comprobantes</td></tr>}
          </tbody>
        </table>
      </div>

      <Modal isOpen={!!sel} onClose={() => setSel(null)} title={`Retención ${sel?.serie || ''}`}>
        {sel && (
          <div className="space-y-3 text-sm">
            {/* ENCABEZADO completo del comprobante (como Contífico): antes de los porcentajes/valores. */}
            <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
              <p className="text-[11px] uppercase tracking-wide text-slate-400 mb-2">Comprobante de retención (07)</p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                <div><span className="text-slate-500">N.º comprobante:</span> <b className="font-mono">{sel.serie}</b></div>
                <div><span className="text-slate-500">Serie (estab-ptoEmi-sec.):</span> <span className="font-mono text-xs">{sel.estab}-{sel.ptoEmi}-{sel.secuencial}</span></div>
                <div><span className="text-slate-500">Fecha de emisión:</span> <b>{fmtDate(sel.fechaEmision)}</b></div>
                <div><span className="text-slate-500">Periodo fiscal:</span> <b>{sel.periodoFiscal}</b></div>
                <div><span className="text-slate-500">Ambiente:</span> {sel.ambiente === '2' ? 'Producción' : 'Pruebas'}</div>
                <div><span className="text-slate-500">Estado:</span> <span className={`px-2 py-0.5 rounded-full text-[11px] ${ESTADO_CLS[sel.estado] || 'bg-slate-100 text-slate-600'}`}>{sel.estado}</span></div>
                <div className="col-span-2 break-all"><span className="text-slate-500">N.º autorización:</span> {sel.numeroAutorizacion ? <span className="font-mono text-xs">{sel.numeroAutorizacion}</span> : <span className="text-amber-600 text-xs">Pendiente de autorización del SRI ({sel.estado})</span>}</div>
                {sel.fechaAutorizacion && <div className="col-span-2"><span className="text-slate-500">Fecha autorización:</span> {fmtDate(sel.fechaAutorizacion)}</div>}
                <div className="col-span-2 break-all"><span className="text-slate-500">Clave de acceso:</span> <span className="font-mono text-xs">{sel.claveAcceso}</span></div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div><span className="text-slate-500">Proveedor:</span> {sel.supplierName}</div>
              <div><span className="text-slate-500">RUC/CI:</span> {sel.supplierId}</div>
              <div><span className="text-slate-500">Factura sustento:</span> <span className="font-mono text-xs">{sel.purchaseSerie || '—'}</span></div>
              <div><span className="text-slate-500">Fecha sustento:</span> {sel.purchaseIssueDate ? fmtDate(sel.purchaseIssueDate) : '—'}</div>
            </div>
            <table className="tbl text-xs">
              <thead className="bg-slate-50"><tr><th className="px-2 py-1 text-left">Tipo</th><th className="px-2 py-1 text-left">Código</th><th className="px-2 py-1 text-right">Base</th><th className="px-2 py-1 text-right">%</th><th className="px-2 py-1 text-right">Retenido</th></tr></thead>
              <tbody>
                {(sel.retentions || []).map((r, i) => (
                  <tr key={i} className="border-t border-slate-100">
                    <td className="px-2 py-1">{r.type}</td><td className="px-2 py-1">{r.code}</td>
                    <td className="px-2 py-1 text-right">${fmt(r.baseAmount)}</td><td className="px-2 py-1 text-right">{r.percentage}%</td>
                    <td className="px-2 py-1 text-right">${fmt(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!!sel.mensajesSri?.length && (
              <div className="bg-rose-50 border border-rose-200 rounded-xl p-2 text-xs text-rose-700">
                {sel.mensajesSri.map((m, i) => <div key={i}>{m.mensaje} {m.informacionAdicional}</div>)}
              </div>
            )}
          </div>
        )}
      </Modal>

      <JournalEntryViewModal
        isOpen={!!viewEntry}
        onClose={() => setViewEntry(null)}
        source={viewEntry ? { model: 'RetentionVoucher', ref: viewEntry._id } : null}
        title={`Asiento de la retención ${viewEntry?.serie || ''}`}
        emptyHint="La retención se contabiliza dentro del asiento de la compra que la origina; revisa el asiento de la factura de compra."
      />
    </div>
  );
}
