import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import Field from '../../components/Field';
import { HiOutlineCalculator, HiOutlineLockOpen, HiOutlineLockClosed, HiOutlineEye, HiOutlinePlus } from 'react-icons/hi2';
import { fmt, fmtDate } from './_utils';

const MOV_EMPTY = { type: 'GASTO', amount: 0, description: '', bankAccount: '' };

export default function CashClosing() {
  const [list, setList] = useState([]);
  const [session, setSession] = useState({ open: null, live: null });
  const [view, setView] = useState(null);
  const [openModal, setOpenModal] = useState(false);
  const [closeModal, setCloseModal] = useState(false);
  const [openForm, setOpenForm] = useState({ openingBalance: 0, notes: '' });
  const [closeForm, setCloseForm] = useState({ countedCash: 0, notes: '' });
  const [busy, setBusy] = useState(false);
  const [movements, setMovements] = useState([]);
  const [movModal, setMovModal] = useState(false);
  const [movForm, setMovForm] = useState(MOV_EMPTY);
  const [banks, setBanks] = useState([]);

  const load = async () => {
    try {
      const [l, s] = await Promise.all([
        api.get('/cash-closings'),
        api.get('/cash-closings/current'),
      ]);
      setList(l.data || []);
      setSession(s.data || { open: null, live: null });
      if (s.data?.open) {
        const m = await api.get('/cash-closings/movements');
        setMovements(m.data || []);
      } else {
        setMovements([]);
      }
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  useEffect(() => { load(); }, []);
  useEffect(() => { api.get('/banks').then((r) => setBanks(r.data || [])).catch(() => {}); }, []);

  const addMovement = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/cash-closings/movements', movForm);
      toast.success('Movimiento registrado');
      setMovModal(false); setMovForm(MOV_EMPTY); load();
    } catch (err) { toast.error(err.response?.data?.message || 'Error'); }
    finally { setBusy(false); }
  };
  const voidMovement = async (m) => {
    if (!confirm('¿Anular este movimiento?')) return;
    try { await api.post(`/cash-closings/movements/${m._id}/void`); toast.success('Anulado'); load(); }
    catch (err) { toast.error(err.response?.data?.message || 'Error'); }
  };

  const live = session.live;
  const open = session.open;
  const expectedCash = live?.expectedCash || 0;
  const closeDiff = (+closeForm.countedCash || 0) - expectedCash;

  const doOpen = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/cash-closings/open', openForm);
      toast.success('Caja abierta');
      setOpenModal(false);
      setOpenForm({ openingBalance: 0, notes: '' });
      load();
    } catch (err) { toast.error(err.response?.data?.message || 'Error'); }
    finally { setBusy(false); }
  };

  const doClose = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api.post(`/cash-closings/${open._id}/close`, closeForm);
      if (res.data?.accountingWarning) {
        toast(res.data.accountingWarning, { icon: '⚠️', duration: 7000 });
      } else {
        toast.success('Caja cerrada y contabilizada');
      }
      setCloseModal(false);
      setCloseForm({ countedCash: 0, notes: '' });
      load();
    } catch (err) { toast.error(err.response?.data?.message || 'Error'); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineCalculator className="text-emerald-600" /> Caja</h1>
        {open ? (
          <button onClick={() => { setCloseForm({ countedCash: expectedCash, notes: '' }); setCloseModal(true); }} className="px-4 py-2 bg-rose-600 text-white rounded-lg flex items-center gap-2 border-none cursor-pointer hover:bg-rose-700"><HiOutlineLockClosed /> Cerrar caja</button>
        ) : (
          <button onClick={() => setOpenModal(true)} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center gap-2 border-none cursor-pointer hover:bg-emerald-700"><HiOutlineLockOpen /> Abrir caja</button>
        )}
      </div>

      {/* Estado de la caja actual */}
      {open ? (
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-200 p-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="px-2 py-0.5 rounded-full text-[11px] bg-emerald-100 text-emerald-700 font-semibold">CAJA ABIERTA</span>
            <span className="text-xs text-slate-500">desde {fmtDate(open.openedAt)} · {open.openedBy?.name || ''}</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-sm">
            <div className="bg-slate-50 rounded-lg p-2"><p className="text-xs text-slate-500">Fondo inicial</p><p className="font-bold">${fmt(open.openingBalance)}</p></div>
            <div className="bg-emerald-50 rounded-lg p-2"><p className="text-xs text-emerald-700">Efectivo ventas</p><p className="font-bold text-emerald-800">${fmt(live?.byMethod?.efectivo)}</p></div>
            <div className="bg-sky-50 rounded-lg p-2"><p className="text-xs text-sky-700">Tarjeta</p><p className="font-bold text-sky-800">${fmt(live?.byMethod?.tarjeta)}</p></div>
            <div className="bg-violet-50 rounded-lg p-2"><p className="text-xs text-violet-700">Transferencia</p><p className="font-bold text-violet-800">${fmt(live?.byMethod?.transferencia)}</p></div>
            <div className="bg-amber-50 rounded-lg p-2"><p className="text-xs text-amber-700">Efectivo esperado</p><p className="font-bold text-amber-800">${fmt(expectedCash)}</p></div>
          </div>

          {/* Movimientos de caja (caja chica / ingresos / egresos / depósitos) */}
          <div className="mt-4 border-t border-slate-100 pt-3">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-slate-700">Movimientos de caja {live?.movementsNet != null && <span className="text-xs text-slate-400">(neto ${fmt(live.movementsNet)})</span>}</h3>
              <button onClick={() => { setMovForm(MOV_EMPTY); setMovModal(true); }} className="px-3 py-1.5 text-xs bg-emerald-600 text-white rounded-lg flex items-center gap-1"><HiOutlinePlus className="w-3.5 h-3.5" /> Movimiento</button>
            </div>
            {movements.length === 0 ? (
              <p className="text-xs text-slate-400">Sin movimientos en este turno.</p>
            ) : (
              <table className="tbl text-xs">
                <thead className="bg-slate-50"><tr><th className="px-2 py-1 text-left">Tipo</th><th className="px-2 py-1 text-left">Descripción</th><th className="px-2 py-1 text-right">Monto</th><th></th></tr></thead>
                <tbody>
                  {movements.map((m) => (
                    <tr key={m._id} className={`border-t border-slate-100 ${m.voided ? 'line-through text-slate-400' : ''}`}>
                      <td className="px-2 py-1">{m.type}</td>
                      <td className="px-2 py-1">{m.description}</td>
                      <td className={`px-2 py-1 text-right font-mono ${m.type === 'INGRESO' ? 'text-emerald-600' : 'text-rose-600'}`}>{m.type === 'INGRESO' ? '+' : '−'}${fmt(m.amount)}</td>
                      <td className="px-2 py-1 text-right">{!m.voided && <button onClick={() => voidMovement(m)} className="text-rose-500 text-[11px]">anular</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      ) : (
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-slate-200 p-6 text-center text-slate-400 text-sm">
          No hay una caja abierta. Abre la caja para empezar a registrar ventas del turno.
        </div>
      )}

      {/* Historial */}
      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-x-auto">
        <table className="tbl">
          <thead className="bg-emerald-50 text-xs uppercase"><tr>
            <th className="px-3 py-2 text-left">Fecha</th><th className="px-3 py-2 text-right">Fondo inicial</th>
            <th className="px-3 py-2 text-right">Efectivo ventas</th><th className="px-3 py-2 text-right">Esperado</th>
            <th className="px-3 py-2 text-right">Contado</th><th className="px-3 py-2 text-right">Diferencia</th>
            <th className="px-3 py-2 text-left">Cajero</th><th className="px-3 py-2 text-center">Estado</th><th></th>
          </tr></thead>
          <tbody>
            {list.filter((c) => c.status !== 'ABIERTA').map((c) => (
              <tr key={c._id} className="border-t hover:bg-slate-50">
                <td className="px-3 py-2">{fmtDate(c.date)}</td>
                <td className="px-3 py-2 text-right font-mono">{fmt(c.openingBalance)}</td>
                <td className="px-3 py-2 text-right font-mono">{fmt(c.byMethod?.efectivo)}</td>
                <td className="px-3 py-2 text-right font-mono">{fmt(c.expectedCash)}</td>
                <td className="px-3 py-2 text-right font-mono">{fmt(c.countedCash)}</td>
                <td className={`px-3 py-2 text-right font-mono font-semibold ${c.difference < 0 ? 'text-rose-600' : c.difference > 0 ? 'text-amber-600' : 'text-emerald-700'}`}>{fmt(c.difference)}</td>
                <td className="px-3 py-2 text-xs">{c.closedBy?.name || '—'}</td>
                <td className="px-3 py-2 text-center"><span className={`px-2 py-0.5 rounded-full text-[11px] ${c.status === 'CERRADO' ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>{c.status}</span></td>
                <td className="px-3 py-2 text-right"><button onClick={() => setView(c)} className="text-slate-500 bg-transparent border-none cursor-pointer"><HiOutlineEye className="w-5 h-5" /></button></td>
              </tr>
            ))}
            {!list.filter((c) => c.status !== 'ABIERTA').length && <tr><td colSpan={9} className="px-3 py-8 text-center text-slate-400">Sin cierres registrados</td></tr>}
          </tbody>
        </table>
      </div>

      {/* Modal abrir caja */}
      <Modal isOpen={openModal} onClose={() => setOpenModal(false)} title="Abrir caja" size="sm">
        <form onSubmit={doOpen} className="space-y-3">
          <label className="text-xs text-slate-500 block">Fondo de caja inicial ($)
            <input type="number" step="0.01" value={openForm.openingBalance} onChange={(e) => setOpenForm({ ...openForm, openingBalance: +e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm text-right" autoFocus />
          </label>
          <label className="text-xs text-slate-500 block">Observaciones
            <textarea value={openForm.notes} onChange={(e) => setOpenForm({ ...openForm, notes: e.target.value })} rows={2} className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" />
          </label>
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setOpenModal(false)} className="px-4 py-2 bg-slate-200 rounded-xl border-none cursor-pointer">Cancelar</button><button disabled={busy} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 border-none cursor-pointer disabled:opacity-50">Abrir caja</button></div>
        </form>
      </Modal>

      {/* Modal cerrar caja */}
      <Modal isOpen={closeModal} onClose={() => setCloseModal(false)} title="Cerrar caja" size="lg">
        <form onSubmit={doClose} className="space-y-3">
          {live && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
              <div className="bg-slate-50 rounded-lg p-2"><p className="text-xs text-slate-500">Fondo inicial</p><p className="font-bold">${fmt(open?.openingBalance)}</p></div>
              <div className="bg-emerald-50 rounded-lg p-2"><p className="text-xs text-emerald-700">Efectivo ventas</p><p className="font-bold text-emerald-800">${fmt(live.byMethod.efectivo)}</p></div>
              <div className="bg-sky-50 rounded-lg p-2"><p className="text-xs text-sky-700">Tarjeta</p><p className="font-bold text-sky-800">${fmt(live.byMethod.tarjeta)}</p></div>
              <div className="bg-violet-50 rounded-lg p-2"><p className="text-xs text-violet-700">Transferencia</p><p className="font-bold text-violet-800">${fmt(live.byMethod.transferencia)}</p></div>
            </div>
          )}
          <label className="text-xs text-slate-500 block">Efectivo físico contado ($)
            <input type="number" step="0.01" value={closeForm.countedCash} onChange={(e) => setCloseForm({ ...closeForm, countedCash: +e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm text-right" autoFocus />
          </label>
          <div className="bg-slate-50 rounded-lg p-3 flex flex-wrap justify-between gap-3 text-sm">
            <span>Efectivo esperado: <b className="font-mono">${fmt(expectedCash)}</b></span>
            <span>Contado: <b className="font-mono">${fmt(closeForm.countedCash)}</b></span>
            <span>Diferencia: <b className={`font-mono ${closeDiff < 0 ? 'text-rose-600' : closeDiff > 0 ? 'text-amber-600' : 'text-emerald-700'}`}>${fmt(closeDiff)} {closeDiff < 0 ? '(faltante)' : closeDiff > 0 ? '(sobrante)' : '(cuadrado)'}</b></span>
          </div>
          <p className="text-[11px] text-slate-400">La diferencia genera automáticamente un asiento contable (faltante = gasto, sobrante = ingreso).</p>
          <label className="text-xs text-slate-500 block">Observaciones
            <textarea value={closeForm.notes} onChange={(e) => setCloseForm({ ...closeForm, notes: e.target.value })} rows={2} className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" />
          </label>
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setCloseModal(false)} className="px-4 py-2 bg-slate-200 rounded-xl border-none cursor-pointer">Cancelar</button><button disabled={busy} className="px-4 py-2 bg-rose-600 text-white rounded-lg border-none cursor-pointer disabled:opacity-50">Cerrar caja</button></div>
        </form>
      </Modal>

      {/* Modal ver */}
      <Modal isOpen={!!view} onClose={() => setView(null)} title={`Cierre ${view ? fmtDate(view.date) : ''}`} size="md">
        {view && (
          <div className="space-y-2 text-sm">
            <div className="grid grid-cols-2 gap-2">
              <div><span className="text-slate-500">Fondo inicial:</span> ${fmt(view.openingBalance)}</div>
              <div><span className="text-slate-500">Efectivo ventas:</span> ${fmt(view.byMethod?.efectivo)}</div>
              <div><span className="text-slate-500">Esperado:</span> ${fmt(view.expectedCash)}</div>
              <div><span className="text-slate-500">Contado:</span> ${fmt(view.countedCash)}</div>
              <div><span className="text-slate-500">Diferencia:</span> <b className={view.difference < 0 ? 'text-rose-600' : view.difference > 0 ? 'text-amber-600' : 'text-emerald-700'}>${fmt(view.difference)}</b></div>
              <div><span className="text-slate-500">Ventas:</span> {view.salesCount} (${fmt(view.totalSales)})</div>
              <div><span className="text-slate-500">Tarjeta:</span> ${fmt(view.byMethod?.tarjeta)}</div>
              <div><span className="text-slate-500">Transferencia:</span> ${fmt(view.byMethod?.transferencia)}</div>
            </div>
            {view.journalEntry && <p className="text-[11px] text-emerald-700">✓ Asiento contable de diferencia generado</p>}
            {view.notes && <p className="text-slate-600 border-t pt-2">{view.notes}</p>}
          </div>
        )}
      </Modal>

      <Modal isOpen={movModal} onClose={() => setMovModal(false)} title="Movimiento de caja" size="sm">
        <form onSubmit={addMovement} className="space-y-3">
          <Field label="Tipo de movimiento" required>
            <select value={movForm.type} onChange={(e) => setMovForm({ ...movForm, type: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5">
              <option value="INGRESO">Ingreso a caja</option>
              <option value="GASTO">Gasto (caja chica)</option>
              <option value="EGRESO">Egreso</option>
              <option value="RETIRO">Retiro</option>
              <option value="DEPOSITO">Depósito a banco</option>
            </select>
          </Field>
          <Field label="Monto ($)" required>
            <input type="number" step="0.01" required placeholder="0.00" value={movForm.amount} onChange={(e) => setMovForm({ ...movForm, amount: +e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" />
          </Field>
          <Field label="Descripción">
            <input placeholder="Concepto del movimiento" value={movForm.description} onChange={(e) => setMovForm({ ...movForm, description: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" />
          </Field>
          {movForm.type === 'DEPOSITO' && (
            <Field label="Banco destino" required>
              <select required value={movForm.bankAccount} onChange={(e) => setMovForm({ ...movForm, bankAccount: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5">
                <option value="">Selecciona…</option>
                {banks.map((b) => <option key={b._id} value={b._id}>{b.name}</option>)}
              </select>
            </Field>
          )}
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setMovModal(false)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button><button disabled={busy} className="px-4 py-2 bg-emerald-600 text-white rounded-xl disabled:opacity-60">Registrar</button></div>
        </form>
      </Modal>
    </div>
  );
}
