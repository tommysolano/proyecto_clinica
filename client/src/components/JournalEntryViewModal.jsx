import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/axios';
import toast from 'react-hot-toast';
import Modal from './Modal';
import { downloadFile } from '../utils/download';
import { sourceLabel, sourceActionLabel, sourceDeepLink } from '../pages/accounting/sourceDocs';
import { HiOutlineArrowDownTray, HiOutlineArrowTopRightOnSquare } from 'react-icons/hi2';

const fmt = (n) => Number(n || 0).toLocaleString('es-EC', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('es-EC', { timeZone: 'America/Guayaquil' }) : '');
const fmtDateTime = (d) => (d ? new Date(d).toLocaleString('es-EC', { timeZone: 'America/Guayaquil' }) : '');

/**
 * Visor de asiento(s) contable(s), reutilizable desde cualquier módulo.
 * Muestra cuentas afectadas, origen, usuario, fecha/hora y permite descargar el PDF.
 *
 * Dos modos:
 *  - `entryId`: muestra ese asiento.
 *  - `source={{ model, ref }}`: busca TODOS los asientos generados por ese
 *    documento (venta, compra, rol, traslado, …); útil porque un documento
 *    puede generar varios (ingreso + costo, reversas, etc.).
 *
 * Props: { isOpen, onClose, entryId, source, title, emptyHint, hideOriginLink }
 */
export default function JournalEntryViewModal({ isOpen, onClose, entryId, source, title = 'Asiento contable', emptyHint, hideOriginLink = false }) {
  const navigate = useNavigate();
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setEntries([]);
    const load = async () => {
      setLoading(true);
      try {
        if (entryId) {
          const r = await api.get(`/journal-entries/${entryId}`);
          setEntries(r.data ? [r.data] : []);
        } else if (source?.model && source?.ref) {
          const r = await api.get('/journal-entries/by-source', { params: { model: source.model, ref: source.ref } });
          setEntries(r.data || []);
        }
      } catch (e) {
        toast.error(e.response?.data?.message || 'No se pudo cargar el asiento');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [isOpen, entryId, source?.model, source?.ref]);

  const downloadPdf = async (e) => {
    try {
      await downloadFile(`/journal-entries/${e._id}/pdf`, { filename: `asiento_${e.number}.pdf` });
    } catch (err) {
      toast.error(err.message);
    }
  };

  const openOrigin = (e) => {
    const url = sourceDeepLink(e);
    if (!url) return;
    onClose();
    navigate(url);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="xl">
      {loading && <div className="text-center text-slate-500 py-8">Cargando asiento…</div>}

      {!loading && entries.length === 0 && (
        <div className="text-center py-8 text-slate-500 text-sm">
          <p className="font-medium text-slate-600">Este documento no tiene asiento contable asociado.</p>
          {emptyHint && <p className="mt-2 text-xs text-slate-400 max-w-md mx-auto">{emptyHint}</p>}
        </div>
      )}

      {entries.length > 1 && (
        <p className="mb-3 text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
          Este documento tiene varios asientos (en orden cronológico). Los reversados/anulados se conservan para auditoría y quedan atenuados; el <b className="text-emerald-700">VIGENTE</b> es el que está en efecto.
        </p>
      )}

      <div className="space-y-5">
        {entries.map((e) => {
          // "Reversado" = el asiento fue anulado por una edición/anulación posterior (isReversed)
          // o su estado es ANULADO. El resto de asientos contabilizados están VIGENTES.
          const reversed = e.isReversed || e.status === 'ANULADO';
          const badge = reversed
            ? { cls: 'bg-rose-100 text-rose-700', text: e.status === 'ANULADO' ? 'ANULADO' : 'REVERSADO' }
            : e.status === 'BORRADOR'
              ? { cls: 'bg-amber-100 text-amber-700', text: 'BORRADOR' }
              : { cls: 'bg-emerald-100 text-emerald-700', text: 'VIGENTE' };
          return (
          <div key={e._id} className={`border rounded-xl overflow-hidden ${reversed ? 'border-rose-200 opacity-70' : 'border-slate-200'}`}>
            <div className="bg-slate-50 px-4 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
              <span>Asiento: <b className="font-mono text-slate-800">{e.number}</b></span>
              <span>Fecha: <b>{fmtDate(e.date)}</b></span>
              <span>Origen: <b>{sourceLabel(e)}</b></span>
              <span>Usuario: <b>{e.createdBy?.name || '—'}</b></span>
              <span>Registrado: <b>{fmtDateTime(e.createdAt)}</b></span>
              <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${badge.cls}`}>{badge.text}</span>
              <span className="flex-1" />
              <button onClick={() => downloadPdf(e)} className="inline-flex items-center gap-1 px-2.5 py-1 bg-slate-700 text-white rounded-lg text-[11px]" title="Descargar PDF del asiento">
                <HiOutlineArrowDownTray className="w-3.5 h-3.5" /> PDF
              </button>
              {!hideOriginLink && sourceDeepLink(e) && (
                <button onClick={() => openOrigin(e)} className="inline-flex items-center gap-1 px-2.5 py-1 bg-emerald-600 text-white rounded-lg text-[11px]">
                  <HiOutlineArrowTopRightOnSquare className="w-3.5 h-3.5" /> {sourceActionLabel(e)}
                </button>
              )}
            </div>
            {e.description && <p className="px-4 pt-2 text-sm text-slate-600">{e.description}</p>}
            {e.isReversed && (
              <p className="px-4 pt-1 text-xs text-rose-600 font-medium">⚠ Asiento reversado{e.reversalReason ? ` — ${e.reversalReason}` : ''}</p>
            )}
            <div className="p-3 overflow-x-auto">
              <table className="tbl text-sm w-full">
                <thead className="bg-slate-100 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-2 py-1.5 text-left">Código</th>
                    <th className="px-2 py-1.5 text-left">Cuenta</th>
                    <th className="px-2 py-1.5 text-left">Detalle</th>
                    <th className="px-2 py-1.5 text-right">Debe</th>
                    <th className="px-2 py-1.5 text-right">Haber</th>
                  </tr>
                </thead>
                <tbody>
                  {(e.lines || []).map((l, i) => (
                    <tr key={i} className="border-t border-slate-100">
                      <td className="px-2 py-1.5 font-mono text-xs">{l.accountCode}</td>
                      <td className="px-2 py-1.5">{l.accountName}</td>
                      <td className="px-2 py-1.5 text-xs text-slate-500">{l.description}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{l.debit ? fmt(l.debit) : ''}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{l.credit ? fmt(l.credit) : ''}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-300 font-semibold bg-slate-50">
                    <td colSpan={3} className="px-2 py-1.5 text-right">Totales</td>
                    <td className="px-2 py-1.5 text-right font-mono">{fmt(e.totalDebit)}</td>
                    <td className="px-2 py-1.5 text-right font-mono">{fmt(e.totalCredit)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
          );
        })}
      </div>
    </Modal>
  );
}
