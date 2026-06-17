import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import { fmt, fmtDate } from './_utils';
import { HiOutlineArrowPath, HiOutlineEye } from 'react-icons/hi2';

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
            <div className="grid grid-cols-2 gap-2">
              <div><span className="text-slate-500">Proveedor:</span> {sel.supplierName}</div>
              <div><span className="text-slate-500">RUC:</span> {sel.supplierId}</div>
              <div><span className="text-slate-500">Período:</span> {sel.periodoFiscal}</div>
              <div><span className="text-slate-500">Estado:</span> {sel.estado}</div>
              <div className="col-span-2 break-all"><span className="text-slate-500">Clave acceso:</span> <span className="font-mono text-xs">{sel.claveAcceso}</span></div>
              {sel.numeroAutorizacion && <div className="col-span-2 break-all"><span className="text-slate-500">Autorización:</span> <span className="font-mono text-xs">{sel.numeroAutorizacion}</span></div>}
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
    </div>
  );
}
