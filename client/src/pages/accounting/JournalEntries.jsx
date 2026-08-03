import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import JournalEntryViewModal from '../../components/JournalEntryViewModal';
import { HiOutlinePlus, HiOutlineArrowUturnLeft, HiOutlineEye, HiOutlineXMark, HiOutlineCheckCircle, HiOutlineTrash } from 'react-icons/hi2';
import { fmt, fmtDate, today, startOfMonth, endOfMonth } from './_utils';
import NumericInput from '../../components/NumericInput';
import AccountSelect from '../../components/AccountSelect';
import ExcelButton from '../../components/ExcelButton';
import useDocDeepLink from '../../hooks/useDocDeepLink';

const EMPTY = { date: today(), description: '', source: 'MANUAL', lines: [{ account: '', debit: 0, credit: 0, description: '' }, { account: '', debit: 0, credit: 0, description: '' }] };

export default function JournalEntries() {
  const [list, setList] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [show, setShow] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [filters, setFilters] = useState({ startDate: startOfMonth(), endDate: endOfMonth(), status: '', q: '' });
  const [viewing, setViewing] = useState(null); // id del asiento a ver

  // Deep-link (?doc=<idAsiento>): abre el asiento aunque no esté en el filtro actual.
  useDocDeepLink((id) => setViewing(id));

  const load = async () => {
    try {
      const r = await api.get('/journal-entries', { params: filters });
      setList(r.data?.entries || r.data || []);
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  useEffect(() => {
    api.get('/chart-of-accounts', { params: { active: true } }).then((r) => setAccounts(r.data || []));
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addLine = () => setForm({ ...form, lines: [...form.lines, { account: '', debit: 0, credit: 0, description: '' }] });
  const setLine = (i, patch) => {
    const lines = [...form.lines]; lines[i] = { ...lines[i], ...patch }; setForm({ ...form, lines });
  };
  const removeLine = (i) => setForm({ ...form, lines: form.lines.filter((_, idx) => idx !== i) });

  const totalD = form.lines.reduce((s, l) => s + (+l.debit || 0), 0);
  const totalC = form.lines.reduce((s, l) => s + (+l.credit || 0), 0);

  const submit = async (e, draft = false) => {
    e.preventDefault();
    if (Math.abs(totalD - totalC) > 0.01) return toast.error('Asiento descuadrado');
    try {
      await api.post('/journal-entries', { ...form, draft });
      toast.success(draft ? 'Borrador guardado' : 'Asiento contabilizado');
      setShow(false); setForm(EMPTY); load();
    } catch (err) { toast.error(err.response?.data?.message || 'Error'); }
  };

  const reverse = async (e) => {
    const reason = prompt('Razón de la reversión:');
    if (!reason) return;
    try { await api.post(`/journal-entries/${e._id}/reverse`, { reason }); toast.success('Revertido'); load(); }
    catch (err) { toast.error(err.response?.data?.message || 'Error'); }
  };

  const approve = async (e) => {
    if (!confirm('¿Aprobar y contabilizar este asiento?')) return;
    try { await api.post(`/journal-entries/${e._id}/approve`); toast.success('Asiento contabilizado'); load(); }
    catch (err) { toast.error(err.response?.data?.message || 'Error'); }
  };
  const removeDraft = async (e) => {
    if (!confirm('¿Eliminar este borrador?')) return;
    try { await api.delete(`/journal-entries/${e._id}`); toast.success('Eliminado'); load(); }
    catch (err) { toast.error(err.response?.data?.message || 'Error'); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight">Asientos Contables</h1>
        <button onClick={() => { setForm(EMPTY); setShow(true); }} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center gap-2"><HiOutlinePlus /> Nuevo asiento</button>
      </div>

      <div className="bg-white rounded-xl p-3 shadow-sm border border-emerald-100 flex flex-wrap gap-2 items-end">
        <div><label className="text-xs">Desde</label><input type="date" value={filters.startDate} onChange={(e) => setFilters({ ...filters, startDate: e.target.value })} className="block px-3 py-2 border border-slate-200 rounded-lg" /></div>
        <div><label className="text-xs">Hasta</label><input type="date" value={filters.endDate} onChange={(e) => setFilters({ ...filters, endDate: e.target.value })} className="block px-3 py-2 border border-slate-200 rounded-lg" /></div>
        <div><label className="text-xs">Estado</label>
          <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })} className="block px-3 py-2 border border-slate-200 rounded-lg">
            <option value="">Todos</option><option>BORRADOR</option><option>CONTABILIZADO</option><option>ANULADO</option>
          </select>
        </div>
        <input aria-label="Buscar asiento" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} placeholder="Buscar por número o descripción…" className="flex-1 px-3 py-2 border border-slate-200 rounded-lg" />
        <button onClick={load} className="px-4 py-2 bg-slate-700 text-white rounded-lg">Filtrar</button>
        {/* El Excel exporta el RANGO COMPLETO del filtro, una fila por línea de asiento (que
            es como se cuadra), no solo la página que se está viendo. */}
        <ExcelButton
          url="/journal-entries/export.xlsx"
          params={filters}
          filename={`libro_diario_${filters.startDate}_${filters.endDate}.xlsx`}
          title="Descargar el libro diario del rango filtrado (todas las líneas)"
        />
      </div>

      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 overflow-hidden">
        <table className="tbl">
          <thead className="bg-emerald-50 text-xs uppercase"><tr>
            <th className="px-3 py-2 text-left">Número</th><th className="px-3 py-2 text-left">Fecha</th>
            <th className="px-3 py-2 text-left">Origen</th><th className="px-3 py-2 text-left">Descripción</th>
            <th className="px-3 py-2 text-right">Débito</th><th className="px-3 py-2 text-right">Crédito</th>
            <th className="px-3 py-2 text-center">Estado</th><th></th>
          </tr></thead>
          <tbody>
            {list.map((e) => (
              <tr key={e._id} className={`border-t border-slate-100 ${e.status === 'ANULADO' ? 'text-slate-400 line-through' : ''}`}>
                <td className="px-3 py-2 font-mono">{e.number}</td>
                <td className="px-3 py-2">{fmtDate(e.date)}</td>
                <td className="px-3 py-2 text-xs">{e.source}</td>
                <td className="px-3 py-2">{e.description}</td>
                <td className="px-3 py-2 text-right font-mono">{fmt(e.totalDebit)}</td>
                <td className="px-3 py-2 text-right font-mono">{fmt(e.totalCredit)}</td>
                <td className="px-3 py-2 text-center text-xs">
                  <span className={`px-2 py-0.5 rounded-full text-[11px] ${e.status === 'BORRADOR' ? 'bg-amber-100 text-amber-700' : e.status === 'CONTABILIZADO' ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>{e.status}</span>
                </td>
                <td className="px-3 py-2 flex gap-1 justify-end">
                  <button onClick={() => setViewing(e._id)} className="p-1.5 text-blue-600" title="Ver"><HiOutlineEye className="w-4 h-4" /></button>
                  {e.status === 'BORRADOR' && <button onClick={() => approve(e)} className="p-1.5 text-emerald-600" title="Aprobar/contabilizar"><HiOutlineCheckCircle className="w-4 h-4" /></button>}
                  {e.status === 'BORRADOR' && <button onClick={() => removeDraft(e)} className="p-1.5 text-rose-500" title="Eliminar borrador"><HiOutlineTrash className="w-4 h-4" /></button>}
                  {e.status === 'CONTABILIZADO' && <button onClick={() => reverse(e)} className="p-1.5 text-rose-600" title="Reversar"><HiOutlineArrowUturnLeft className="w-4 h-4" /></button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal isOpen={show} onClose={() => setShow(false)} title="Nuevo asiento manual" size="xl">
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <div><label className="text-xs">Fecha</label><input type="date" required value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></div>
            <div className="col-span-2"><label className="text-xs">Descripción</label><input required value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></div>
          </div>
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead className="bg-slate-100 text-xs"><tr>
                <th className="px-2 py-1 text-left">Cuenta</th><th className="px-2 py-1">Descripción</th>
                <th className="px-2 py-1 text-right">Débito</th><th className="px-2 py-1 text-right">Crédito</th><th></th>
              </tr></thead>
              <tbody>
                {form.lines.map((l, i) => (
                  <tr key={i}>
                    <td className="p-1 min-w-[220px]">
                      <AccountSelect accounts={accounts} value={l.account} onChange={(v) => setLine(i, { account: v })} placeholder="--" required size="sm" />
                    </td>
                    <td className="p-1"><input value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} className="w-full border border-slate-200 rounded px-2 py-1" /></td>
                    <td className="p-1"><NumericInput step="0.01" value={l.debit} onChange={(e) => setLine(i, { debit: +e.target.value })} className="w-24 border border-slate-200 rounded px-2 py-1 text-right" /></td>
                    <td className="p-1"><NumericInput step="0.01" value={l.credit} onChange={(e) => setLine(i, { credit: +e.target.value })} className="w-24 border border-slate-200 rounded px-2 py-1 text-right" /></td>
                    <td className="p-1"><button type="button" onClick={() => removeLine(i)} className="text-rose-600"><HiOutlineXMark /></button></td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-slate-100 font-semibold"><tr>
                <td colSpan={2} className="px-2 py-1 text-right">Totales</td>
                <td className="px-2 py-1 text-right">{fmt(totalD)}</td>
                <td className="px-2 py-1 text-right">{fmt(totalC)}</td><td></td>
              </tr></tfoot>
            </table>
          </div>
          <button type="button" onClick={addLine} className="text-emerald-600 text-sm flex items-center gap-1"><HiOutlinePlus /> Agregar línea</button>
          <div className={`text-sm ${Math.abs(totalD - totalC) < 0.01 ? 'text-emerald-600' : 'text-rose-600'}`}>
            Diferencia: {fmt(totalD - totalC)}
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setShow(false)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button>
            <button type="button" onClick={(e) => submit(e, true)} className="px-4 py-2 bg-amber-500 text-white rounded-lg">Guardar borrador</button>
            <button className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20">Contabilizar</button>
          </div>
        </form>
      </Modal>

      <JournalEntryViewModal isOpen={!!viewing} onClose={() => setViewing(null)} entryId={viewing} />
    </div>
  );
}
