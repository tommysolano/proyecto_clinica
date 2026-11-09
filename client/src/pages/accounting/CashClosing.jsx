import { useEffect, useState } from 'react';
import api from '../../api/axios';
import { useAuth } from '../../context/AuthContext';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import Field from '../../components/Field';
import { HiOutlineCalculator, HiOutlineLockOpen, HiOutlineLockClosed, HiOutlineEye, HiOutlinePlus } from 'react-icons/hi2';
import { fmt, fmtDate } from './_utils';
import NumericInput from '../../components/NumericInput';
import AccountSelect from '../../components/AccountSelect';
import DateInput from '../../components/DateInput';

const MOV_EMPTY = { type: 'GASTO', amount: 0, description: '', counterpartAccount: '' };

// Por defecto el historial muestra los últimos 30 días (fechas locales, no UTC).
const ymdLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hace30Dias = () => {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return ymdLocal(d);
};

export default function CashClosing() {
  const { role, user } = useAuth();
  // Marketing revisa todas las cajas sin operar ninguna: no tiene caja propia.
  const soloLectura = role === 'marketing' && !user?.isSuperAdmin;
  const [list, setList] = useState([]);
  const [session, setSession] = useState({ open: null, live: null });
  // Filtros del historial. Admin y super admin pueden ver las cajas de todas las sucursales.
  const [branches, setBranches] = useState({ clinics: [], canSeeAll: false });
  const [filters, setFilters] = useState({ clinic: 'all', startDate: hace30Dias(), endDate: ymdLocal(new Date()) });
  const [openModal, setOpenModal] = useState(false);
  const [closeModal, setCloseModal] = useState(false);
  const [openForm, setOpenForm] = useState({ openingBalance: 0, notes: '' });
  const [closeForm, setCloseForm] = useState({ countedCash: 0, notes: '' });
  const [busy, setBusy] = useState(false);
  const [movements, setMovements] = useState([]);
  const [sesionVentas, setSesionVentas] = useState([]);
  const [movModal, setMovModal] = useState(false);
  const [movForm, setMovForm] = useState(MOV_EMPTY);
  const [accounts, setAccounts] = useState([]);

  const load = async (f = filters) => {
    try {
      const [l, s] = await Promise.all([
        api.get('/cash-closings', { params: f }),
        soloLectura ? { data: null } : api.get('/cash-closings/current'),
      ]);
      setList(l.data || []);
      setSession(s.data || { open: null, live: null });
      if (s.data?.open) {
        // Movimientos y las ventas/facturas que este usuario hizo en esta apertura de caja.
        const [m, d] = await Promise.all([
          api.get('/cash-closings/movements'),
          api.get(`/cash-closings/${s.data.open._id}/detail`).catch(() => null),
        ]);
        setMovements(m.data || []);
        setSesionVentas(d?.data?.sales || []);
      } else {
        setMovements([]);
        setSesionVentas([]);
      }
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(filters); }, [filters]);
  useEffect(() => {
    api.get('/cash-closings/branches')
      .then((r) => setBranches(r.data || { clinics: [], canSeeAll: false }))
      .catch(() => {});
    if (soloLectura) return;
    api.get('/chart-of-accounts')
      .then((r) => setAccounts(r.data || []))
      .catch(() => {});
  }, [soloLectura]);

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
  // Caja por punto de venta: cada usuario abre y cierra la de SU punto.
  const miPunto = session.miPunto || null;
  const sinPunto = !!session.usaPuntos && !miPunto;
  const serie = (p) => (p ? `${p.establecimiento}-${p.codigo}${p.nombre ? ` · ${p.nombre}` : ''}` : '');
  const historial = list.filter((c) => !(open && c._id === open._id) && (c.status !== 'ABIERTA' || c.puntoEmision));
  const conSucursal = branches.canSeeAll && branches.clinics.length > 1;
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
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
          <HiOutlineCalculator className="text-emerald-600" /> Caja
          {miPunto && <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 font-mono">{serie(miPunto)}</span>}
        </h1>
        {soloLectura ? (
          <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-100 text-slate-600 border border-slate-200">Solo lectura</span>
        ) : open ? (
          <button onClick={() => { setCloseForm({ countedCash: expectedCash, notes: '' }); setCloseModal(true); }} className="px-4 py-2 bg-rose-600 text-white rounded-lg flex items-center gap-2 border-none cursor-pointer hover:bg-rose-700"><HiOutlineLockClosed /> Cerrar caja</button>
        ) : (
          <button onClick={() => setOpenModal(true)} disabled={sinPunto} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center gap-2 border-none cursor-pointer hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"><HiOutlineLockOpen /> Abrir caja</button>
        )}
      </div>

      {sinPunto && !open && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Esta sucursal trabaja con cajas por punto de venta y no tienes uno asignado. Pide al administrador que te
          asigne un punto en Configuración SRI → Puntos de emisión para poder abrir tu caja.
        </div>
      )}

      {/* Estado de la caja actual */}
      {open ? (
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-200 p-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="px-2 py-0.5 rounded-full text-[11px] bg-emerald-100 text-emerald-700 font-semibold">CAJA ABIERTA</span>
            <span className="text-xs text-slate-500">desde {fmtDate(open.openedAt)} · {open.openedBy?.name || ''}</span>
            {open.puntoEmision && <span className="text-xs text-slate-500 font-mono">· {serie(open.puntoEmision)}</span>}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-sm">
            <div className="bg-slate-50 rounded-lg p-2"><p className="text-xs text-slate-500">Fondo inicial</p><p className="font-bold">${fmt(open.openingBalance)}</p></div>
            <div className="bg-emerald-50 rounded-lg p-2"><p className="text-xs text-emerald-700">Efectivo ventas</p><p className="font-bold text-emerald-800">${fmt(live?.byMethod?.efectivo)}</p></div>
            <div className="bg-sky-50 rounded-lg p-2"><p className="text-xs text-sky-700">Tarjeta</p><p className="font-bold text-sky-800">${fmt(live?.byMethod?.tarjeta)}</p></div>
            <div className="bg-violet-50 rounded-lg p-2"><p className="text-xs text-violet-700">Transferencia</p><p className="font-bold text-violet-800">${fmt(live?.byMethod?.transferencia)}</p></div>
            <div className="bg-amber-50 rounded-lg p-2"><p className="text-xs text-amber-700">Total facturado</p><p className="font-bold text-amber-800">${fmt(live?.totalSales)}</p>{live?.salesCount != null && <p className="text-[11px] text-amber-700/80">{live.salesCount} venta{live.salesCount === 1 ? '' : 's'}</p>}</div>
          </div>

          {/* Facturas / ventas de ESTA apertura de caja (las que registró quien la abrió). */}
          <div className="mt-4 border-t border-slate-100 pt-3">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-slate-700">
                Facturas de esta caja <span className="text-xs text-slate-400">({sesionVentas.length})</span>
              </h3>
              <button onClick={() => window.open(`/cash-register/${open._id}`, '_blank')} className="text-xs text-emerald-700 bg-transparent border-none cursor-pointer hover:underline">
                Ver detalle completo
              </button>
            </div>
            {sesionVentas.length === 0 ? (
              <p className="text-xs text-slate-400">Aún no hay ventas en esta apertura de caja.</p>
            ) : (
              <div className="overflow-x-auto max-h-80 overflow-y-auto">
                <table className="tbl text-xs">
                  <thead className="bg-slate-50 sticky top-0"><tr>
                    <th className="px-2 py-1 text-left">Hora</th><th className="px-2 py-1 text-left">Venta</th>
                    <th className="px-2 py-1 text-left">Factura</th><th className="px-2 py-1 text-left">Cliente</th>
                    <th className="px-2 py-1 text-left">Pago</th><th className="px-2 py-1 text-right">Total</th>
                  </tr></thead>
                  <tbody>
                    {[...sesionVentas].reverse().map((v) => (
                      <tr key={v._id} className={`border-t border-slate-100 ${v.status === 'anulada' ? 'line-through text-slate-400' : ''}`}>
                        <td className="px-2 py-1 font-mono">{new Date(v.createdAt).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Guayaquil' })}</td>
                        <td className="px-2 py-1 font-mono">{v.saleNumber}</td>
                        <td className="px-2 py-1 font-mono">
                          {v.invoice ? (
                            <span title={v.invoice.estado}>{v.invoice.number} <span className={v.invoice.estado === 'AUTORIZADO' ? 'text-emerald-600' : 'text-amber-600'}>●</span></span>
                          ) : <span className="text-slate-400">Sin factura</span>}
                        </td>
                        <td className="px-2 py-1">{v.clientName}</td>
                        <td className="px-2 py-1">{v.payments.map((p) => `${p.method} $${fmt(p.amount)}${p.reference ? ` (N° ${p.reference})` : ''}`).join(' + ')}</td>
                        <td className="px-2 py-1 text-right font-mono font-semibold">${fmt(v.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
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
      ) : !soloLectura && (
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-slate-200 p-6 text-center text-slate-400 text-sm">
          No hay una caja abierta. Abre la caja para empezar a registrar ventas del turno.
        </div>
      )}

      {/* Historial */}
      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-slate-200 p-3 flex flex-wrap items-end gap-3">
        {branches.canSeeAll && branches.clinics.length > 1 && (
          <label className="text-xs text-slate-500 block">Sucursal
            <select value={filters.clinic} onChange={(e) => setFilters({ ...filters, clinic: e.target.value })} className="mt-1 block border border-slate-200 rounded-xl px-3 py-2 text-sm min-w-[200px]">
              <option value="all">Todas las sucursales</option>
              {branches.clinics.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
            </select>
          </label>
        )}
        <label className="text-xs text-slate-500 block">Desde
          <DateInput value={filters.startDate} onChange={(e) => setFilters({ ...filters, startDate: e.target.value })} className="mt-1" />
        </label>
        <label className="text-xs text-slate-500 block">Hasta
          <DateInput value={filters.endDate} onChange={(e) => setFilters({ ...filters, endDate: e.target.value })} className="mt-1" />
        </label>
        <span className="text-xs text-slate-400 ml-auto">{historial.length} caja{historial.length === 1 ? '' : 's'}</span>
      </div>
      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-x-auto">
        <table className="tbl">
          <thead className="bg-emerald-50 text-xs uppercase"><tr>
            <th className="px-3 py-2 text-left">Fecha</th>{conSucursal && <th className="px-3 py-2 text-left">Sucursal</th>}<th className="px-3 py-2 text-right">Fondo inicial</th>
            <th className="px-3 py-2 text-right">Efectivo ventas</th><th className="px-3 py-2 text-right">Esperado</th>
            <th className="px-3 py-2 text-right">Contado</th><th className="px-3 py-2 text-right">Diferencia</th>
            <th className="px-3 py-2 text-left">Caja</th><th className="px-3 py-2 text-left">Cajero</th><th className="px-3 py-2 text-center">Estado</th><th></th>
          </tr></thead>
          <tbody>
            {historial.map((c) => (
              <tr key={c._id} className="border-t hover:bg-slate-50">
                <td className="px-3 py-2">{fmtDate(c.date)}</td>
                {conSucursal && <td className="px-3 py-2 text-xs">{c.clinic?.name || '—'}</td>}
                <td className="px-3 py-2 text-right font-mono">{fmt(c.openingBalance)}</td>
                <td className="px-3 py-2 text-right font-mono">{fmt(c.byMethod?.efectivo)}</td>
                <td className="px-3 py-2 text-right font-mono">{fmt(c.expectedCash)}</td>
                <td className="px-3 py-2 text-right font-mono">{fmt(c.countedCash)}</td>
                <td className={`px-3 py-2 text-right font-mono font-semibold ${c.difference < 0 ? 'text-rose-600' : c.difference > 0 ? 'text-amber-600' : 'text-emerald-700'}`}>{fmt(c.difference)}</td>
                <td className="px-3 py-2 text-xs font-mono">{c.puntoEmision ? `${c.puntoEmision.establecimiento}-${c.puntoEmision.codigo}` : '—'}</td>
                <td className="px-3 py-2 text-xs">{c.openedBy?.name || c.closedBy?.name || '—'}</td>
                <td className="px-3 py-2 text-center"><span className={`px-2 py-0.5 rounded-full text-[11px] ${c.status === 'CERRADO' ? 'bg-emerald-100 text-emerald-700' : c.status === 'ABIERTA' ? 'bg-sky-100 text-sky-700' : 'bg-rose-100 text-rose-700'}`}>{c.status}</span></td>
                <td className="px-3 py-2 text-right"><button onClick={() => window.open(`/cash-register/${c._id}`, '_blank')} title="Ver detalle en una pestaña nueva" className="text-slate-500 bg-transparent border-none cursor-pointer hover:text-emerald-700"><HiOutlineEye className="w-5 h-5" /></button></td>
              </tr>
            ))}
            {!historial.length && <tr><td colSpan={conSucursal ? 11 : 10} className="px-3 py-8 text-center text-slate-400">Sin cierres en el período</td></tr>}
          </tbody>
        </table>
      </div>

      {/* Modal abrir caja */}
      <Modal isOpen={openModal} onClose={() => setOpenModal(false)} title="Abrir caja" size="sm">
        <form onSubmit={doOpen} className="space-y-3">
          <label className="text-xs text-slate-500 block">Fondo de caja inicial ($)
            <NumericInput step="0.01" value={openForm.openingBalance} onChange={(e) => setOpenForm({ ...openForm, openingBalance: +e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm text-right" autoFocus />
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
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-sm">
              <div className="bg-slate-50 rounded-lg p-2"><p className="text-xs text-slate-500">Fondo inicial</p><p className="font-bold">${fmt(open?.openingBalance)}</p></div>
              <div className="bg-emerald-50 rounded-lg p-2"><p className="text-xs text-emerald-700">Efectivo ventas</p><p className="font-bold text-emerald-800">${fmt(live.byMethod.efectivo)}</p></div>
              <div className="bg-sky-50 rounded-lg p-2"><p className="text-xs text-sky-700">Tarjeta</p><p className="font-bold text-sky-800">${fmt(live.byMethod.tarjeta)}</p></div>
              <div className="bg-violet-50 rounded-lg p-2"><p className="text-xs text-violet-700">Transferencia</p><p className="font-bold text-violet-800">${fmt(live.byMethod.transferencia)}</p></div>
              {/* Suma de lo cobrado en el turno (efectivo + tarjeta + transferencia). */}
              <div className="bg-emerald-600 rounded-lg p-2 col-span-2 md:col-span-1"><p className="text-xs text-emerald-50">Total cobrado</p><p className="font-bold text-white text-lg">${fmt((live.byMethod.efectivo || 0) + (live.byMethod.tarjeta || 0) + (live.byMethod.transferencia || 0))}</p></div>
            </div>
          )}
          <label className="text-xs text-slate-500 block">Efectivo físico contado ($)
            <NumericInput step="0.01" value={closeForm.countedCash} onChange={(e) => setCloseForm({ ...closeForm, countedCash: +e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm text-right" autoFocus />
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

      <Modal isOpen={movModal} onClose={() => setMovModal(false)} title="Movimiento de caja" size="sm">
        <form onSubmit={addMovement} className="space-y-3">
          <Field label="Tipo de movimiento" required>
            <select value={movForm.type} onChange={(e) => setMovForm({ ...movForm, type: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5">
              <option value="INGRESO">Ingreso a caja</option>
              <option value="GASTO">Gasto (caja chica)</option>
              <option value="EGRESO">Egreso</option>
              <option value="RETIRO">Retiro</option>
            </select>
          </Field>
          <Field label="Monto ($)" required>
            <NumericInput step="0.01" required placeholder="0.00" value={movForm.amount} onChange={(e) => setMovForm({ ...movForm, amount: +e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" />
          </Field>
          <Field label="Descripción">
            <input placeholder="Concepto del movimiento" value={movForm.description} onChange={(e) => setMovForm({ ...movForm, description: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" />
          </Field>
          <Field label={movForm.type === 'INGRESO' ? 'Cuenta de ingreso' : 'Cuenta de gasto'}>
              <AccountSelect
                accounts={accounts}
                value={movForm.counterpartAccount}
                onChange={(v) => setMovForm({ ...movForm, counterpartAccount: v })}
                filter={(a) => (movForm.type === 'INGRESO' ? a.code?.startsWith('4.') : (a.code?.startsWith('6.') || a.code?.startsWith('5.')))}
                emptyOption={movForm.type === 'INGRESO' ? 'Otros ingresos (por defecto)' : 'Otros gastos (por defecto)'}
              />
          </Field>
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setMovModal(false)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button><button disabled={busy} className="px-4 py-2 bg-emerald-600 text-white rounded-xl disabled:opacity-60">Registrar</button></div>
        </form>
      </Modal>
    </div>
  );
}
