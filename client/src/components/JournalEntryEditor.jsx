import { useEffect, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import Modal from './Modal';
import NumericInput from './NumericInput';
import AccountSelect from './AccountSelect';
import { downloadFile } from '../utils/download';
import { HiOutlinePlus, HiOutlineXMark, HiOutlineArrowDownTray } from 'react-icons/hi2';

const fmt = (n) => Number(n || 0).toLocaleString('es-EC', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Editor del asiento contable (debe/haber) de un documento (compra o venta).
 * Carga el asiento actual por `entryId`, permite editar libremente las líneas y
 * lo reenvía a `postUrl` (POST { lines }). Bloquea guardar si está descuadrado.
 *
 * Props: { isOpen, onClose, entryId, postUrl, title, onSaved }
 */
export default function JournalEntryEditor({ isOpen, onClose, entryId, postUrl, title = 'Asiento contable', onSaved }) {
  const [accounts, setAccounts] = useState([]);
  const [lines, setLines] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [meta, setMeta] = useState({ number: '', date: '', description: '' });

  useEffect(() => {
    if (!isOpen) return;
    api.get('/chart-of-accounts').then((r) => setAccounts(r.data || []));
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !entryId) { setLines([{ account: '', debit: 0, credit: 0, description: '' }, { account: '', debit: 0, credit: 0, description: '' }]); return; }
    setLoading(true);
    api.get(`/journal-entries/${entryId}`)
      .then((r) => {
        const e = r.data || {};
        setMeta({ number: e.number || '', date: e.date ? String(e.date).slice(0, 10) : '', description: e.description || '' });
        setLines((e.lines || []).map((l) => ({
          account: l.account?._id || l.account || '',
          debit: +l.debit || 0, credit: +l.credit || 0, description: l.description || '',
        })));
      })
      .catch((err) => toast.error(err.response?.data?.message || 'No se pudo cargar el asiento'))
      .finally(() => setLoading(false));
  }, [isOpen, entryId]);

  const setLine = (i, patch) => { const l = [...lines]; l[i] = { ...l[i], ...patch }; setLines(l); };
  const addLine = () => setLines([...lines, { account: '', debit: 0, credit: 0, description: '' }]);
  const removeLine = (i) => setLines(lines.filter((_, x) => x !== i));

  const totalDebit = +lines.reduce((s, l) => s + (+l.debit || 0), 0).toFixed(2);
  const totalCredit = +lines.reduce((s, l) => s + (+l.credit || 0), 0).toFixed(2);
  const balanced = Math.abs(totalDebit - totalCredit) < 0.01 && totalDebit > 0;

  const save = async () => {
    const clean = lines.filter((l) => l.account && ((+l.debit || 0) > 0 || (+l.credit || 0) > 0));
    if (clean.length < 2) return toast.error('El asiento debe tener al menos 2 líneas con cuenta y valor');
    if (clean.some((l) => (+l.debit || 0) > 0 && (+l.credit || 0) > 0)) return toast.error('Una línea no puede tener débito y crédito a la vez');
    if (!balanced) return toast.error(`Asiento descuadrado: Debe ${fmt(totalDebit)} ≠ Haber ${fmt(totalCredit)}`);
    setSaving(true);
    try {
      await api.post(postUrl, { lines: clean.map((l) => ({ account: l.account, debit: +l.debit || 0, credit: +l.credit || 0, description: l.description })) });
      toast.success('Asiento actualizado');
      onSaved?.();
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al guardar el asiento');
    } finally { setSaving(false); }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="2xl">
      {loading ? (
        <div className="text-center text-slate-500 py-8">Cargando asiento…</div>
      ) : (
        <div className="space-y-3">
          <div className="text-xs text-slate-500 flex flex-wrap gap-4 items-center">
            {meta.number && <span>Asiento: <b className="font-mono">{meta.number}</b></span>}
            {meta.date && <span>Fecha: <b>{meta.date}</b></span>}
            {entryId && (
              <button
                type="button"
                onClick={() => downloadFile(`/journal-entries/${entryId}/pdf`, { filename: `asiento_${meta.number || entryId}.pdf` }).catch((e) => toast.error(e.message))}
                className="inline-flex items-center gap-1 px-2.5 py-1 bg-slate-700 text-white rounded-lg text-[11px]"
                title="Descargar PDF del asiento"
              >
                <HiOutlineArrowDownTray className="w-3.5 h-3.5" /> PDF
              </button>
            )}
          </div>
          <div className="bg-amber-50 border border-amber-200 text-amber-800 text-xs rounded-lg px-3 py-2">
            Al guardar se <b>reversa</b> el asiento actual y se crea uno nuevo con estas líneas. El debe y el haber deben cuadrar.
          </div>
          <table className="w-full text-sm">
            <thead className="bg-slate-100 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-2 py-1 text-left">Cuenta</th>
                <th className="px-2 py-1 text-left">Detalle</th>
                <th className="px-2 py-1 text-right w-32">Debe</th>
                <th className="px-2 py-1 text-right w-32">Haber</th>
                <th className="w-8"></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i} className="border-t border-slate-100">
                  <td className="px-1 py-1 min-w-[200px]">
                    <AccountSelect accounts={accounts} value={l.account} onChange={(v) => setLine(i, { account: v })} size="sm" />
                  </td>
                  <td className="px-1 py-1"><input value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} className="w-full border border-slate-200 rounded px-2 py-1 text-xs" placeholder="Glosa" /></td>
                  <td className="px-1 py-1"><NumericInput step="0.01" value={l.debit || ''} onChange={(e) => setLine(i, { debit: +e.target.value, credit: 0 })} className="w-full border border-slate-200 rounded px-1 py-1 text-right text-xs" /></td>
                  <td className="px-1 py-1"><NumericInput step="0.01" value={l.credit || ''} onChange={(e) => setLine(i, { credit: +e.target.value, debit: 0 })} className="w-full border border-slate-200 rounded px-1 py-1 text-right text-xs" /></td>
                  <td className="px-1 py-1 text-center">{lines.length > 2 && <button type="button" onClick={() => removeLine(i)} className="text-rose-600"><HiOutlineXMark className="w-4 h-4" /></button>}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-300 font-semibold">
                <td className="px-2 py-1.5" colSpan={2}>Totales</td>
                <td className="px-2 py-1.5 text-right font-mono">{fmt(totalDebit)}</td>
                <td className="px-2 py-1.5 text-right font-mono">{fmt(totalCredit)}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
          <div className="flex items-center justify-between">
            <button type="button" onClick={addLine} className="text-emerald-600 text-sm flex items-center gap-1"><HiOutlinePlus /> Línea</button>
            <span className={`text-xs font-medium ${balanced ? 'text-emerald-600' : 'text-rose-600'}`}>
              {balanced ? '✓ Cuadrado' : `Diferencia: ${fmt(Math.abs(totalDebit - totalCredit))}`}
            </span>
          </div>
          <div className="flex justify-end gap-2 pt-2 border-t">
            <button type="button" onClick={onClose} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button>
            <button type="button" disabled={!balanced || saving} onClick={save} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 disabled:opacity-50">{saving ? 'Guardando…' : 'Guardar asiento'}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
