import { useCallback, useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import Field from '../../components/Field';
import { HiOutlinePlus, HiOutlineBanknotes, HiOutlineEye, HiOutlineXMark, HiOutlineMagnifyingGlass } from 'react-icons/hi2';
import { fmt, fmtDate, today } from './_utils';
import useDocDeepLink from '../../hooks/useDocDeepLink';
import { newIdempotencyKey, withIdempotencyKey, intentKey } from '../../utils/idempotency';

/**
 * DEPÓSITOS DE EFECTIVO — el efectivo del mostrador que se lleva al banco.
 *
 * Cada depósito es un documento: fecha de corte, banco, número de papeleta y el DETALLE de qué
 * facturas y cobros lo componen. Antes esto era un botón suelto en Caja que movía el dinero sin
 * dejar rastro: no había forma de ver los depósitos hechos ni de saber qué entró en cada uno.
 *
 * Solo entra dinero EN EFECTIVO: lo cobrado por transferencia ya está en el banco y lo de
 * tarjeta se acredita por la liquidación del adquirente.
 */
const EMPTY = { date: today(), bankAccount: '', voucherNumber: '', description: '' };

export default function CashDeposits() {
  const [list, setList] = useState([]);
  const [banks, setBanks] = useState([]);
  const [filtros, setFiltros] = useState({ startDate: '', endDate: '', q: '' });
  const [detail, setDetail] = useState(null);

  // Alta de un depósito
  const [show, setShow] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [pendientes, setPendientes] = useState([]);
  const [marcados, setMarcados] = useState(new Set());
  const [cargando, setCargando] = useState(false);
  const [busy, setBusy] = useState(false);
  const [intent, setIntent] = useState('');

  const load = useCallback(async () => {
    try {
      const params = {};
      if (filtros.startDate) params.startDate = filtros.startDate;
      if (filtros.endDate) params.endDate = filtros.endDate;
      if (filtros.q.trim()) params.q = filtros.q.trim();
      const r = await api.get('/cash-deposits', { params });
      setList(r.data?.items || []);
    } catch (e) { toast.error(e.response?.data?.message || 'Error al cargar los depósitos'); }
  }, [filtros]);

  useEffect(() => { api.get('/banks/accounts').then((r) => setBanks(r.data || [])).catch(() => setBanks([])); }, []);
  useEffect(() => { load(); }, [load]);

  /** Trae el efectivo pendiente hasta la fecha de corte elegida. */
  const cargarPendientes = async (cutDate) => {
    setCargando(true);
    try {
      const r = await api.get('/cash-deposits/pending', { params: { cutDate } });
      setPendientes(r.data?.items || []);
      // Por defecto se marca todo: lo normal es depositar el efectivo completo del corte.
      setMarcados(new Set((r.data?.items || []).map((i) => `${i.docModel}:${i.docRef}`)));
    } catch (e) {
      setPendientes([]); setMarcados(new Set());
      toast.error(e.response?.data?.message || 'No se pudo cargar el efectivo pendiente');
    } finally { setCargando(false); }
  };

  const abrirNuevo = async () => {
    const inicial = { ...EMPTY, bankAccount: banks[0]?._id || '' };
    setForm(inicial);
    setIntent(newIdempotencyKey());
    setShow(true);
    await cargarPendientes(inicial.date);
  };

  const cambiarCorte = async (fecha) => {
    setForm((f) => ({ ...f, date: fecha }));
    if (fecha) await cargarPendientes(fecha);
  };

  const alternar = (item) => {
    const k = `${item.docModel}:${item.docRef}`;
    setMarcados((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  };
  const alternarTodo = () => {
    if (marcados.size === pendientes.length) setMarcados(new Set());
    else setMarcados(new Set(pendientes.map((i) => `${i.docModel}:${i.docRef}`)));
  };

  const seleccionados = pendientes.filter((i) => marcados.has(`${i.docModel}:${i.docRef}`));
  const totalSeleccionado = seleccionados.reduce((s, i) => s + Number(i.amount || 0), 0);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (!form.bankAccount) return toast.error('Selecciona la cuenta bancaria');
    if (!form.voucherNumber.trim()) return toast.error('Ingresa el número de papeleta del banco');
    if (!seleccionados.length) return toast.error('Marca al menos una factura o cobro en efectivo');
    setBusy(true);
    try {
      const huella = [form.date, form.bankAccount, form.voucherNumber, ...seleccionados.map((i) => `${i.docModel}#${i.docRef}`).sort()];
      await api.post('/cash-deposits', {
        date: form.date,
        bankAccount: form.bankAccount,
        voucherNumber: form.voucherNumber.trim(),
        description: form.description,
        items: seleccionados.map((i) => ({ docModel: i.docModel, docRef: i.docRef })),
      }, withIdempotencyKey(intentKey(intent, huella)));
      toast.success(`Depósito registrado por $${totalSeleccionado.toFixed(2)}`);
      setShow(false);
      load();
    } catch (err) { toast.error(err.response?.data?.message || 'Error al registrar el depósito'); }
    finally { setBusy(false); }
  };

  const anular = async (d) => {
    const motivo = prompt(`Motivo de la anulación del depósito ${d.number}:`, '');
    if (motivo === null) return;
    try {
      await api.post(`/cash-deposits/${d._id}/void`, { reason: motivo });
      toast.success('Depósito anulado: los documentos vuelven a quedar pendientes');
      load();
      if (detail?._id === d._id) setDetail(null);
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  const verDetalle = async (d) => {
    try { const r = await api.get(`/cash-deposits/${d._id}`); setDetail(r.data); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  // Deep-link desde el movimiento bancario o el asiento (?doc=<idDeposito>).
  useDocDeepLink((id) => verDetalle({ _id: id }));

  const totalListado = list.filter((d) => d.status !== 'ANULADO').reduce((s, d) => s + Number(d.total || 0), 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
            <HiOutlineBanknotes className="text-emerald-600" /> Depósitos
          </h1>
          <p className="text-sm text-slate-500">Efectivo del mostrador llevado al banco, con su papeleta y el detalle de qué facturas lo componen.</p>
        </div>
        <button onClick={abrirNuevo} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center gap-2"><HiOutlinePlus /> Nuevo depósito</button>
      </div>

      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-3 flex flex-wrap gap-2 items-end">
        <label className="text-xs text-slate-500">Desde
          <input type="date" value={filtros.startDate} onChange={(e) => setFiltros({ ...filtros, startDate: e.target.value })} className="mt-1 block border border-slate-200 rounded-xl px-3 py-2 text-sm" />
        </label>
        <label className="text-xs text-slate-500">Hasta
          <input type="date" value={filtros.endDate} onChange={(e) => setFiltros({ ...filtros, endDate: e.target.value })} className="mt-1 block border border-slate-200 rounded-xl px-3 py-2 text-sm" />
        </label>
        <label className="text-xs text-slate-500 flex-1 min-w-[220px]">Buscar
          <div className="relative mt-1">
            <HiOutlineMagnifyingGlass className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={filtros.q} onChange={(e) => setFiltros({ ...filtros, q: e.target.value })} placeholder="Nº de depósito o papeleta…" className="w-full border border-slate-200 rounded-xl pl-8 pr-3 py-2 text-sm" />
          </div>
        </label>
      </div>

      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-x-auto">
        <table className="tbl">
          <thead className="bg-emerald-50 text-xs uppercase"><tr>
            <th className="px-3 py-2 text-left">Número</th><th className="px-3 py-2 text-left">Fecha de corte</th>
            <th className="px-3 py-2 text-left">Banco</th><th className="px-3 py-2 text-left">Papeleta</th>
            <th className="px-3 py-2 text-center">Documentos</th><th className="px-3 py-2 text-right">Valor</th>
            <th className="px-3 py-2 text-center">Estado</th><th></th>
          </tr></thead>
          <tbody>
            {list.map((d) => (
              <tr key={d._id} className={`border-t ${d.status === 'ANULADO' ? 'text-slate-400 line-through' : ''}`}>
                <td className="px-3 py-2 font-mono">
                  <button onClick={() => verDetalle(d)} className="text-emerald-700 hover:underline bg-transparent border-none cursor-pointer p-0">{d.number}</button>
                </td>
                <td className="px-3 py-2">{fmtDate(d.date)}</td>
                <td className="px-3 py-2 text-xs">{d.bankAccount?.name || '—'}</td>
                <td className="px-3 py-2 font-mono text-xs">{d.voucherNumber}</td>
                <td className="px-3 py-2 text-center text-xs">{d.items?.length || 0}</td>
                <td className="px-3 py-2 text-right font-mono font-semibold">${fmt(d.total)}</td>
                <td className="px-3 py-2 text-center text-[11px]">
                  {d.status === 'ANULADO'
                    ? <span className="px-2 py-0.5 rounded-full bg-rose-100 text-rose-700">Anulado</span>
                    : <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">Registrado</span>}
                </td>
                <td className="px-3 py-2 text-right flex gap-1 justify-end">
                  <button onClick={() => verDetalle(d)} className="text-blue-600" title="Ver detalle"><HiOutlineEye className="w-4 h-4" /></button>
                  {d.status !== 'ANULADO' && <button onClick={() => anular(d)} className="text-rose-600" title="Anular"><HiOutlineXMark className="w-4 h-4" /></button>}
                </td>
              </tr>
            ))}
            {!list.length && (
              <tr><td colSpan={8} className="px-3 py-8 text-center text-slate-400">
                No hay depósitos con estos filtros. Con «Nuevo depósito» se listan las facturas y cobros en efectivo pendientes de llevar al banco.
              </td></tr>
            )}
          </tbody>
          {!!list.length && (
            <tfoot><tr className="border-t bg-slate-50 font-semibold">
              <td colSpan={5} className="px-3 py-2 text-right text-xs">Total depositado ({list.length}):</td>
              <td className="px-3 py-2 text-right font-mono">${fmt(totalListado)}</td>
              <td colSpan={2}></td>
            </tr></tfoot>
          )}
        </table>
      </div>

      {/* Alta */}
      <Modal isOpen={show} onClose={() => setShow(false)} title="Nuevo depósito de efectivo" size="xl">
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <Field label="Fecha de corte" required>
              {/* Hasta qué día se recoge el efectivo que se lleva al banco. */}
              <input type="date" required value={form.date} onChange={(e) => cambiarCorte(e.target.value)} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" />
            </Field>
            <Field label="Banco" required className="sm:col-span-2">
              <select required value={form.bankAccount} onChange={(e) => setForm({ ...form, bankAccount: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5">
                <option value="">Seleccione…</option>
                {banks.map((b) => <option key={b._id} value={b._id}>{b.name}{b.bank ? ` — ${b.bank}` : ''}</option>)}
              </select>
            </Field>
            <Field label="N° de papeleta" required>
              <input required value={form.voucherNumber} onChange={(e) => setForm({ ...form, voucherNumber: e.target.value })} placeholder="El que entrega el banco" className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" />
            </Field>
            <Field label="Descripción" className="sm:col-span-4">
              <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Ej: Depósito ventas del 1 al 15 de julio" className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" />
            </Field>
          </div>

          <div className="border rounded-xl overflow-hidden">
            <div className="px-3 py-2 bg-slate-50 flex items-center justify-between text-sm">
              <span className="font-semibold">Facturas y cobros en efectivo pendientes</span>
              <span className="text-xs text-slate-500">{seleccionados.length} de {pendientes.length} marcados</span>
            </div>
            <div className="max-h-80 overflow-y-auto">
              <table className="tbl text-sm">
                <thead className="bg-slate-100 text-xs uppercase sticky top-0"><tr>
                  <th className="px-2 py-2 w-8"><input type="checkbox" checked={pendientes.length > 0 && marcados.size === pendientes.length} onChange={alternarTodo} /></th>
                  <th className="px-2 py-2 text-left">Documento</th>
                  <th className="px-2 py-2 text-left">Fecha</th>
                  <th className="px-2 py-2 text-left">Cliente</th>
                  <th className="px-2 py-2 text-right">Total doc.</th>
                  <th className="px-2 py-2 text-right">Efectivo</th>
                </tr></thead>
                <tbody>
                  {cargando && <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">Cargando…</td></tr>}
                  {!cargando && pendientes.map((i) => {
                    const k = `${i.docModel}:${i.docRef}`;
                    return (
                      <tr key={k} className={`border-t ${marcados.has(k) ? 'bg-emerald-50/50' : ''}`}>
                        <td className="px-2 py-1 text-center"><input type="checkbox" checked={marcados.has(k)} onChange={() => alternar(i)} /></td>
                        <td className="px-2 py-1 font-mono text-xs">
                          {i.number || '—'}
                          <span className="ml-1 text-[10px] uppercase text-slate-400">{i.docModel === 'Sale' ? 'Venta' : 'Cobro'}</span>
                          {i.mixta && <span className="ml-1 text-[10px] uppercase text-amber-600" title="Venta con varias formas de pago: solo entra la parte en efectivo">mixta</span>}
                        </td>
                        <td className="px-2 py-1 text-xs">{fmtDate(i.docDate)}</td>
                        <td className="px-2 py-1 text-xs">{i.party || '—'}</td>
                        <td className="px-2 py-1 text-right font-mono text-slate-500">{fmt(i.total)}</td>
                        <td className="px-2 py-1 text-right font-mono font-semibold">{fmt(i.amount)}</td>
                      </tr>
                    );
                  })}
                  {!cargando && !pendientes.length && (
                    <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">No hay efectivo pendiente de depositar hasta esta fecha.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex items-center justify-between bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3">
            <span className="text-sm text-emerald-800">Total a depositar</span>
            <span className="text-2xl font-bold text-emerald-800">${fmt(totalSeleccionado)}</span>
          </div>

          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setShow(false)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button>
            <button disabled={busy} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 disabled:opacity-50">
              {busy ? 'Registrando…' : 'Registrar depósito'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Detalle */}
      <Modal isOpen={!!detail} onClose={() => setDetail(null)} title={`Depósito ${detail?.number || ''}`} size="lg">
        {detail && (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap gap-x-5 gap-y-1">
              <span><b>Fecha de corte:</b> {fmtDate(detail.date)}</span>
              <span><b>Banco:</b> {detail.bankAccount?.name}{detail.bankAccount?.bank ? ` (${detail.bankAccount.bank})` : ''}</span>
              <span><b>Papeleta:</b> {detail.voucherNumber}</span>
              <span><b>Estado:</b> {detail.status}</span>
            </div>
            {detail.description && <p className="text-slate-600">{detail.description}</p>}
            <div className="border rounded-lg overflow-hidden">
              <table className="tbl text-xs">
                <thead className="bg-slate-100"><tr>
                  <th className="px-2 py-1 text-left">Documento</th><th className="px-2 py-1 text-left">Fecha</th>
                  <th className="px-2 py-1 text-left">Cliente</th><th className="px-2 py-1 text-right">Efectivo</th>
                </tr></thead>
                <tbody>
                  {(detail.items || []).map((i, idx) => (
                    <tr key={idx} className="border-t">
                      <td className="px-2 py-1 font-mono">{i.number} <span className="text-slate-400">{i.docModel === 'Sale' ? 'venta' : 'cobro'}</span></td>
                      <td className="px-2 py-1">{fmtDate(i.docDate)}</td>
                      <td className="px-2 py-1">{i.party || '—'}</td>
                      <td className="px-2 py-1 text-right font-mono">${fmt(i.amount)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr className="bg-slate-50 font-semibold"><td colSpan={3} className="px-2 py-1 text-right">Total</td><td className="px-2 py-1 text-right font-mono">${fmt(detail.total)}</td></tr></tfoot>
              </table>
            </div>
            {detail.status === 'ANULADO' && detail.voidReason && (
              <p className="text-xs text-rose-600">Anulado: {detail.voidReason}</p>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
