import { useEffect, useRef, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import Field from '../../components/Field';
import NumericInput from '../../components/NumericInput';
import { HiOutlinePlus, HiOutlineScale, HiOutlineCheck, HiOutlineArrowDownTray, HiOutlineCheckCircle, HiOutlineTrash } from 'react-icons/hi2';
import { fmt, fmtDate, today } from './_utils';

const EMPTY = { bankAccount: '', cutDate: today(), statementBalance: '', description: '' };

export default function Reconciliations() {
  const [list, setList] = useState([]);
  const [banks, setBanks] = useState([]);
  const [show, setShow] = useState(false);
  const [selected, setSelected] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [creates, setCreates] = useState({}); // idx -> { include, counterAccountCode }
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  const isDraft = selected?.status === 'BORRADOR';

  const load = async () => {
    try { const r = await api.get('/banks/reconciliations'); setList(r.data || []); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  useEffect(() => {
    api.get('/banks/accounts').then((r) => setBanks(r.data || []));
    load();
  }, []);

  const openDetail = async (c) => {
    try { const r = await api.get(`/banks/reconciliations/${c._id}`); setSelected(r.data); setCreates({}); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  // Mueve la fecha de corte: recarga los movimientos del libro y recalcula el saldo contable.
  const changeCutDate = async (val) => {
    if (!val) return;
    setBusy(true);
    try {
      const r = await api.put(`/banks/reconciliations/${selected._id}`, { cutDate: val });
      setSelected(r.data); load(); toast.success('Fecha de corte actualizada');
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
    finally { setBusy(false); }
  };

  const start = async (e) => {
    e.preventDefault();
    try {
      const r = await api.post('/banks/reconciliations', { ...form, statementBalance: Number(form.statementBalance) || 0 });
      setSelected(r.data); setShow(false); setForm(EMPTY); load(); toast.success('Conciliación iniciada');
    } catch (err) { toast.error(err.response?.data?.message || 'Error'); }
  };

  const toggle = (idx) => {
    if (!isDraft) return;
    const items = selected.items.map((it, i) => i === idx ? { ...it, matched: !it.matched } : it);
    setSelected({ ...selected, items });
  };

  const save = async () => {
    setBusy(true);
    try {
      const payload = {
        items: selected.items.map((it) => ({ transaction: it.transaction?._id || it.transaction, matched: it.matched, statementRef: it.statementRef })),
        statementBalance: Number(selected.statementBalance) || 0,
        description: selected.description,
      };
      const r = await api.put(`/banks/reconciliations/${selected._id}`, payload);
      setSelected(r.data); load(); toast.success('Guardado');
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
    finally { setBusy(false); }
  };

  const close = async () => {
    const pend = selected.items.filter((i) => !i.matched).length;
    if (!confirm(`¿Marcar como CONCILIADA?${pend ? ` Quedan ${pend} movimiento(s) sin marcar.` : ''}`)) return;
    setBusy(true);
    try {
      await save();
      const r = await api.post(`/banks/reconciliations/${selected._id}/close`);
      setSelected(r.data); load(); toast.success('Conciliada');
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
    finally { setBusy(false); }
  };

  // Importar el extracto bancario (CSV/Excel) dentro de la conciliación.
  const onImportFile = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', f);
      const parsed = await api.post('/banks/statement/parse', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      const r = await api.post(`/banks/reconciliations/${selected._id}/import`, { lines: parsed.data.lines });
      setSelected(r.data.reconciliation); setCreates({});
      toast.success(`${r.data.matched} emparejadas, ${r.data.unmatched} sin coincidencia`);
    } catch (err) { toast.error(err.response?.data?.message || 'No se pudo importar el extracto'); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const createMovements = async () => {
    const toCreate = (selected.statementLines || [])
      .map((l, idx) => ({ l, idx }))
      .filter(({ l, idx }) => !l.matched && creates[idx]?.include)
      .map(({ l, idx }) => ({ date: l.date, amount: l.amount, description: l.description, reference: l.reference, counterAccountCode: creates[idx]?.counterAccountCode || undefined }));
    if (!toCreate.length) return toast.error('Marca al menos una línea para crear');
    setBusy(true);
    try {
      const r = await api.post(`/banks/reconciliations/${selected._id}/create-movements`, { creates: toCreate });
      setSelected(r.data); setCreates({}); load(); toast.success(`${toCreate.length} movimiento(s) creado(s)`);
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
    finally { setBusy(false); }
  };

  /**
   * Elimina una conciliación PENDIENTE. Una abierta con la cuenta o el corte equivocados era
   * imposible de quitar y quedaba estorbando en la lista para siempre. La cerrada no se toca:
   * es la evidencia de que el saldo cuadró.
   */
  const eliminar = async (c, e) => {
    e.stopPropagation();
    if (!confirm(`¿Eliminar la conciliación pendiente de ${c.bankAccount?.name || 'esta cuenta'} al ${fmtDate(c.cutDate || c.periodEnd)}?\n\nNo afecta a ningún asiento: aún no ha conciliado nada.`)) return;
    try {
      await api.delete(`/banks/reconciliations/${c._id}`);
      if (selected?._id === c._id) setSelected(null);
      load();
      toast.success('Conciliación eliminada');
    } catch (err) { toast.error(err.response?.data?.message || 'Error'); }
  };

  const statusBadge = (s) => s === 'CONCILIADO'
    ? <span className="px-2 py-0.5 bg-emerald-100 text-emerald-700 rounded-full text-[11px] font-semibold">Conciliado</span>
    : <span className="px-2 py-0.5 bg-amber-100 text-amber-700 rounded-full text-[11px] font-semibold">Pendiente</span>;

  const matchedCount = selected?.items.filter((i) => i.matched).length || 0;
  const unmatchedLines = (selected?.statementLines || []).filter((l) => !l.matched);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineScale className="text-emerald-600" /> Conciliaciones Bancarias</h1>
        <button onClick={() => { setForm(EMPTY); setShow(true); }} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center gap-2"><HiOutlinePlus /> Nueva conciliación</button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* Lista */}
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden h-fit">
          <table className="tbl">
            <thead className="bg-emerald-50 text-xs uppercase"><tr><th className="px-3 py-2 text-left">Banco</th><th className="px-3 py-2 text-left">Corte</th><th className="px-3 py-2 text-center">Estado</th><th></th></tr></thead>
            <tbody>
              {list.length === 0 && <tr><td colSpan={4} className="px-3 py-6 text-center text-slate-500 text-sm">Sin conciliaciones.</td></tr>}
              {list.map((c) => (
                <tr key={c._id} className={`border-t cursor-pointer hover:bg-slate-50 ${selected?._id === c._id ? 'bg-emerald-50/60' : ''}`} onClick={() => openDetail(c)}>
                  <td className="px-3 py-2 text-xs">{c.bankAccount?.name}</td>
                  <td className="px-3 py-2 text-xs">{fmtDate(c.cutDate || c.periodEnd)}</td>
                  <td className="px-3 py-2 text-center">{statusBadge(c.status)}</td>
                  <td className="px-3 py-2 text-right">
                    {c.status !== 'CONCILIADO' && (
                      <button onClick={(e) => eliminar(c, e)} className="text-rose-500 hover:text-rose-700" title="Eliminar esta conciliación pendiente">
                        <HiOutlineTrash className="w-4 h-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Detalle */}
        {selected && (
          <div className="lg:col-span-2 space-y-3">
            {/* Panel de información */}
            <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-semibold text-slate-700">Información de la Conciliación</h2>
                {statusBadge(selected.status)}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <div className="flex justify-between items-center"><span className="text-slate-500">Fecha de Corte:</span>
                  {isDraft ? (
                    <input type="date" value={String(selected.cutDate || selected.periodEnd || '').slice(0, 10)} onChange={(e) => changeCutDate(e.target.value)} disabled={busy}
                      className="w-36 border border-slate-200 rounded px-2 py-1 text-sm text-right disabled:bg-slate-50" />
                  ) : <b>{fmtDate(selected.cutDate || selected.periodEnd)}</b>}
                </div>
                <div className="flex justify-between items-center"><span className="text-slate-500">Saldo Bancario:</span>
                  <NumericInput allowNegative value={selected.statementBalance ?? ''} disabled={!isDraft}
                    onChange={(e) => setSelected({ ...selected, statementBalance: e.target.value })}
                    className="w-32 border border-slate-200 rounded px-2 py-1 text-right text-sm disabled:bg-slate-50" />
                </div>
                <div className="flex justify-between"><span className="text-slate-500">Cuenta de Banco:</span><b className="text-right">{selected.bankAccount?.name}{selected.bankAccount?.bank ? ` · ${selected.bankAccount.bank}` : ''}</b></div>
                <div className="flex justify-between"><span className="text-slate-500">Saldo Contable:</span><b>${fmt(selected.bookBalance)}</b></div>
                <div className="flex justify-between items-start"><span className="text-slate-500">Descripción:</span>
                  <input value={selected.description || ''} disabled={!isDraft} onChange={(e) => setSelected({ ...selected, description: e.target.value })}
                    placeholder="P/R conciliación bancaria…" className="w-48 border border-slate-200 rounded px-2 py-1 text-sm disabled:bg-slate-50" />
                </div>
                <div className="flex justify-between"><span className="text-slate-500">Diferencia:</span>
                  <b className={Math.abs((Number(selected.statementBalance) || 0) - (selected.bookBalance || 0)) < 0.01 ? 'text-emerald-700' : 'text-rose-600'}>
                    ${fmt((Number(selected.statementBalance) || 0) - (selected.bookBalance || 0))}
                  </b>
                </div>
              </div>
              {isDraft && (
                <div className="flex flex-wrap gap-2 mt-4 justify-end">
                  <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls,text/csv,text/plain" onChange={onImportFile} className="hidden" />
                  <button onClick={() => fileRef.current?.click()} disabled={busy} className="px-3 py-1.5 bg-sky-600 text-white rounded-lg text-sm flex items-center gap-1 disabled:opacity-50"><HiOutlineArrowDownTray className="w-4 h-4" /> Importar extracto (CSV/Excel)</button>
                  <button onClick={save} disabled={busy} className="px-3 py-1.5 bg-slate-600 text-white rounded-lg text-sm disabled:opacity-50">Guardar</button>
                  <button onClick={close} disabled={busy} className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-sm flex items-center gap-1 disabled:opacity-50"><HiOutlineCheck className="w-4 h-4" /> Conciliar</button>
                </div>
              )}
            </div>

            {/* Movimientos del libro */}
            <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden">
              <div className="px-4 py-2 bg-slate-50 text-sm font-medium text-slate-600 flex justify-between">
                <span>Movimientos del libro hasta el corte</span>
                <span className="text-xs text-slate-500">{matchedCount}/{selected.items.length} marcados</span>
              </div>
              <table className="tbl">
                <thead className="bg-slate-100 text-xs"><tr>
                  <th className="px-2 py-1 text-left">Fecha</th><th className="px-2 py-1 text-left">Tipo</th>
                  <th className="px-2 py-1 text-left">Descripción</th><th className="px-2 py-1 text-right">Monto</th>
                  <th className="px-2 py-1 text-center">Concil.</th>
                </tr></thead>
                <tbody>
                  {selected.items.length === 0 && <tr><td colSpan={5} className="px-2 py-4 text-center text-slate-400 text-sm">No hay movimientos pendientes hasta esta fecha.</td></tr>}
                  {selected.items.map((it, i) => {
                    const t = it.transaction || {};
                    const signed = (t.amount || 0) * (t.direction || 1);
                    return (
                      <tr key={i} className="border-t">
                        <td className="px-2 py-1 text-xs">{fmtDate(t.date)}</td>
                        <td className="px-2 py-1 text-xs">{t.type}</td>
                        <td className="px-2 py-1 text-xs">{t.description} {t.reference && <span className="text-slate-400">· {t.reference}</span>}</td>
                        <td className={`px-2 py-1 text-right font-mono ${signed < 0 ? 'text-rose-600' : 'text-emerald-700'}`}>${fmt(signed)}</td>
                        <td className="px-2 py-1 text-center"><input type="checkbox" disabled={!isDraft} checked={!!it.matched} onChange={() => toggle(i)} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Extracto importado */}
            {(selected.statementLines || []).length > 0 && (
              <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden">
                <div className="px-4 py-2 bg-slate-50 text-sm font-medium text-slate-600">Extracto bancario importado</div>
                <table className="tbl">
                  <thead className="bg-slate-100 text-xs"><tr>
                    <th className="px-2 py-1 text-left">Fecha</th><th className="px-2 py-1 text-left">Descripción (banco)</th>
                    <th className="px-2 py-1 text-right">Monto</th><th className="px-2 py-1 text-left">Estado</th>
                    {isDraft && <th className="px-2 py-1 text-left">Acción</th>}
                  </tr></thead>
                  <tbody>
                    {selected.statementLines.map((l, idx) => (
                      <tr key={idx} className="border-t">
                        <td className="px-2 py-1 text-xs">{fmtDate(l.date)}</td>
                        <td className="px-2 py-1 text-xs">{l.description} {l.reference && <span className="text-slate-400">· {l.reference}</span>}</td>
                        <td className={`px-2 py-1 text-right font-mono ${l.amount < 0 ? 'text-rose-600' : 'text-emerald-700'}`}>${fmt(l.amount)}</td>
                        <td className="px-2 py-1 text-xs">{l.matched ? <span className="text-emerald-700 flex items-center gap-1"><HiOutlineCheckCircle className="w-4 h-4" /> Conciliada</span> : <span className="text-amber-600">Sin coincidencia</span>}</td>
                        {isDraft && (
                          <td className="px-2 py-1">
                            {!l.matched && (
                              <label className="flex items-center gap-2 text-xs">
                                <input type="checkbox" checked={!!creates[idx]?.include} onChange={(e) => setCreates({ ...creates, [idx]: { ...creates[idx], include: e.target.checked } })} />
                                Crear movimiento
                                {creates[idx]?.include && (
                                  <input placeholder="Cód. contrapartida" value={creates[idx]?.counterAccountCode || ''} onChange={(e) => setCreates({ ...creates, [idx]: { ...creates[idx], counterAccountCode: e.target.value } })} className="border border-slate-200 rounded px-2 py-1 w-32" />
                                )}
                              </label>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {isDraft && unmatchedLines.length > 0 && (
                  <div className="p-3 flex justify-end">
                    <button onClick={createMovements} disabled={busy} className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-sm disabled:opacity-50">Crear movimientos marcados</button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <Modal isOpen={show} onClose={() => setShow(false)} title="Nueva conciliación">
        <form onSubmit={start} className="space-y-3">
          <Field label="Cuenta bancaria" required>
            <select required value={form.bankAccount} onChange={(e) => setForm({ ...form, bankAccount: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5">
              <option value="">Seleccione…</option>{banks.map((b) => <option key={b._id} value={b._id}>{b.name} — {b.bank}</option>)}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Fecha de corte" required>
              <input type="date" required value={form.cutDate} onChange={(e) => setForm({ ...form, cutDate: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" />
            </Field>
            <Field label="Saldo bancario (extracto)">
              <NumericInput allowNegative value={form.statementBalance} onChange={(e) => setForm({ ...form, statementBalance: e.target.value })} placeholder="0.00" className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-right" />
            </Field>
          </div>
          <Field label="Descripción">
            <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Ej: P/R CONCILIACION BANCARIA 02-2026" className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" />
          </Field>
          <p className="text-xs text-slate-400">Se traerán los movimientos del libro <b>hasta la fecha de corte</b> que aún no estén conciliados. No se usa fecha inicial.</p>
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setShow(false)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button><button className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20">Iniciar</button></div>
        </form>
      </Modal>
    </div>
  );
}
