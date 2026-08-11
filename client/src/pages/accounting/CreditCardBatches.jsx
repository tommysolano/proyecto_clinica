import { useEffect, useMemo, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import Field from '../../components/Field';
import { HiOutlinePlus, HiOutlineCreditCard, HiOutlineCheckCircle, HiOutlineEye, HiOutlineMagnifyingGlass } from 'react-icons/hi2';
import { fmt, fmtDate, today } from './_utils';
import NumericInput from '../../components/NumericInput';
import { newIdempotencyKey, withIdempotencyKey } from '../../utils/idempotency';
import DateInput from '../../components/DateInput';

const EMPTY = { closeDate: today(), cardType: 'CREDITO', acquirer: '', commissionRate: 5, retentionRate: 0, ivaCommissionRate: 15, bankAccount: '', vouchers: [] };
// Sin fechas por defecto: si se busca por lote, un rango preestablecido escondería los cobros
// de días anteriores (el lote del POS se cierra un día y se procesa al siguiente).
const EMPTY_PICKER = { lote: '', from: '', to: '' };

const round = (n) => +(Number(n) || 0).toFixed(2);

export default function CreditCardBatches() {
  const [list, setList] = useState([]);
  const [banks, setBanks] = useState([]);
  const [show, setShow] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [idemKey, setIdemKey] = useState(newIdempotencyKey());
  const [viewItem, setViewItem] = useState(null);
  // Cargador de cobros con tarjeta (reutiliza el buscador de las liquidaciones)
  const [picker, setPicker] = useState(EMPTY_PICKER);
  const [pickerResults, setPickerResults] = useState([]);
  const [picked, setPicked] = useState({});
  const [searching, setSearching] = useState(false);
  const [pickerHint, setPickerHint] = useState('');

  const load = async () => {
    try { const r = await api.get('/credit-card-batches'); setList(r.data || []); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  useEffect(() => {
    api.get('/banks/accounts').then((r) => setBanks(r.data || [])).catch(() => {});
    load();
  }, []);

  const totals = useMemo(() => round(form.vouchers.reduce((acc, v) => acc + (+v.grossAmount || 0), 0)), [form.vouchers]);

  const openNew = () => {
    setForm(EMPTY); setPicker(EMPTY_PICKER); setPickerResults([]); setPicked({}); setPickerHint('');
    setIdemKey(newIdempotencyKey());
    setShow(true);
  };

  const addVoucher = () => setForm({ ...form, vouchers: [...form.vouchers, { voucherNumber: '', lote: '', cardLast4: '', cardType: form.cardType, grossAmount: 0 }] });
  const setVoucher = (i, patch) => { const vs = [...form.vouchers]; vs[i] = { ...vs[i], ...patch }; setForm({ ...form, vouchers: vs }); };

  /** Trae los cobros con tarjeta (ventas) para no digitar los vouchers uno a uno. */
  const searchSales = async () => {
    if (!picker.lote.trim() && !picker.from && !picker.to) return toast.error('Ingresa el N° de lote o un rango de fechas');
    setSearching(true); setPickerHint('');
    try {
      const params = { forBatch: true };
      if (picker.lote.trim()) params.lote = picker.lote.trim();
      if (picker.from) params.from = picker.from;
      if (picker.to) params.to = picker.to;
      const r = await api.get('/card-settlements/card-sales', { params });
      const yaEnLote = new Set((form.vouchers || []).map((v) => String(v.sale || '')));
      const results = (r.data || []).filter((s) => !yaEnLote.has(String(s._id)));
      setPickerResults(results);
      const pick = {}; results.forEach((s) => { pick[s._id] = true; });
      setPicked(pick);
      if (!results.length) {
        setPickerHint('No hay cobros con tarjeta pendientes para esos filtros: o no existen, o ya están en otro lote / liquidación.');
        toast('Sin cobros con tarjeta para esos filtros', { icon: 'ℹ️' });
      }
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
    finally { setSearching(false); }
  };

  const pickedList = pickerResults.filter((s) => picked[s._id]);
  const pickedTotal = round(pickedList.reduce((a, s) => a + (+s.total || 0), 0));
  const allPicked = pickerResults.length > 0 && pickedList.length === pickerResults.length;
  const toggleAll = () => { const v = !allPicked; const p = {}; pickerResults.forEach((s) => { p[s._id] = v; }); setPicked(p); };

  const addPicked = () => {
    if (!pickedList.length) return toast.error('Selecciona al menos un cobro');
    const nuevos = pickedList.map((s) => ({
      sale: s._id, invoice: s.invoice || null,
      voucherNumber: s.cardVoucher || '', lote: s.cardLote || '',
      cardLast4: '', cardType: form.cardType,
      grossAmount: round(+s.total || 0), date: s.createdAt,
    }));
    setForm((f) => ({ ...f, vouchers: [...f.vouchers, ...nuevos] }));
    setPickerResults((rs) => rs.filter((s) => !picked[s._id]));
    setPicked({});
    toast.success(`${nuevos.length} cobro(s) cargado(s) · $${fmt(pickedTotal)}`);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (saving) return; // doble clic: la primera petición ya va en camino
    if (!form.vouchers.length) return toast.error('Carga o agrega al menos un cobro');
    setSaving(true);
    try {
      await api.post('/credit-card-batches', form, withIdempotencyKey(idemKey));
      toast.success('Lote creado');
      setShow(false); setForm(EMPTY); setIdemKey(newIdempotencyKey()); load();
    } catch (err) { toast.error(err.response?.data?.message || 'Error'); }
    finally { setSaving(false); }
  };

  const liquidate = async (b) => {
    if (!confirm('¿Liquidar lote? Se registrará en banco con comisión/retención.')) return;
    try {
      // El banco y la fecha van EXPLÍCITOS: sin ellos el backend no sabía en qué cuenta
      // depositar y el movimiento terminaba en una cuenta bancaria cualquiera.
      await api.post(`/credit-card-batches/${b._id}/liquidate`, {
        bankAccount: b.bankAccount?._id || b.bankAccount || '',
        liquidationDate: today(),
      });
      toast.success('Liquidado'); load();
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  const statusBadge = (st) => {
    const map = { ABIERTO: 'bg-amber-100 text-amber-700', LIQUIDADO: 'bg-emerald-100 text-emerald-700', ANULADO: 'bg-rose-100 text-rose-700' };
    return <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${map[st] || 'bg-slate-100 text-slate-600'}`}>{st}</span>;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineCreditCard className="text-emerald-600" /> Lotes Tarjetas de Crédito</h1>
        <button onClick={openNew} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center gap-2"><HiOutlinePlus /> Nuevo lote</button>
      </div>
      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-x-auto">
        <table className="tbl">
          <thead className="bg-emerald-50 text-xs uppercase"><tr>
            <th className="px-3 py-2 text-left">Código</th><th className="px-3 py-2 text-left">Fecha</th>
            <th className="px-3 py-2 text-left">Adquirente</th>
            <th className="px-3 py-2 text-center">Cobros</th><th className="px-3 py-2 text-right">Bruto</th>
            <th className="px-3 py-2 text-right">Comis.</th><th className="px-3 py-2 text-right">Reten.</th>
            <th className="px-3 py-2 text-right">Neto</th><th className="px-3 py-2 text-left">Banco</th>
            <th className="px-3 py-2 text-center">Estado</th><th></th>
          </tr></thead>
          <tbody>
            {list.map((b) => (
              <tr key={b._id} className="border-t hover:bg-slate-50">
                <td className="px-3 py-2 font-mono text-xs">{b.code}</td>
                <td className="px-3 py-2">{fmtDate(b.closeDate)}</td>
                <td className="px-3 py-2 text-xs">{b.acquirer}</td>
                <td className="px-3 py-2 text-center font-mono">{(b.vouchers || []).length}</td>
                <td className="px-3 py-2 text-right font-mono">${fmt(b.grossAmount)}</td>
                <td className="px-3 py-2 text-right font-mono text-rose-600">{fmt(b.commissionAmount)}</td>
                <td className="px-3 py-2 text-right font-mono text-rose-600">{fmt(b.retentionAmount)}</td>
                <td className="px-3 py-2 text-right font-mono font-semibold text-emerald-700">${fmt(b.netAmount)}</td>
                <td className="px-3 py-2 text-xs">{b.bankAccount?.name || '—'}</td>
                <td className="px-3 py-2 text-center">{statusBadge(b.status)}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center justify-end gap-1.5">
                    <button onClick={() => setViewItem(b)} className="text-slate-500 hover:text-slate-700" title="Ver cobros"><HiOutlineEye className="w-5 h-5" /></button>
                    {b.status === 'ABIERTO' && <button onClick={() => liquidate(b)} className="text-emerald-600" title="Liquidar"><HiOutlineCheckCircle className="w-5 h-5" /></button>}
                  </div>
                </td>
              </tr>
            ))}
            {!list.length && <tr><td colSpan={11} className="px-3 py-8 text-center text-slate-400">Sin lotes registrados</td></tr>}
          </tbody>
        </table>
      </div>

      <Modal isOpen={show} onClose={() => setShow(false)} title="Nuevo lote de tarjetas" size="full">
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Field label="Fecha de cierre" required><DateInput required value={form.closeDate} onChange={(e) => setForm({ ...form, closeDate: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
            <Field label="Tipo de tarjeta"><select value={form.cardType} onChange={(e) => setForm({ ...form, cardType: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5"><option>CREDITO</option><option>DEBITO</option></select></Field>
            <Field label="Adquirente" required className="col-span-2"><input required placeholder="Datafast / Medianet" value={form.acquirer} onChange={(e) => setForm({ ...form, acquirer: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
            <Field label="% comisión"><NumericInput step="0.01" value={form.commissionRate} onChange={(e) => setForm({ ...form, commissionRate: +e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
            <Field label="% retención"><NumericInput step="0.01" value={form.retentionRate} onChange={(e) => setForm({ ...form, retentionRate: +e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
            <Field label="% IVA comisión"><NumericInput step="0.01" value={form.ivaCommissionRate} onChange={(e) => setForm({ ...form, ivaCommissionRate: +e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
            <Field label="Banco de acreditación" required><select required value={form.bankAccount} onChange={(e) => setForm({ ...form, bankAccount: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5"><option value="">Seleccione…</option>{banks.map((b) => <option key={b._id} value={b._id}>{b.name}</option>)}</select></Field>
          </div>

          {/* Cargar los cobros con tarjeta que ya se registraron en el sistema */}
          <div className="border border-emerald-200 bg-emerald-50/40 rounded-lg p-3 space-y-3">
            <div className="flex items-center gap-2">
              <HiOutlineMagnifyingGlass className="text-emerald-600" />
              <p className="font-semibold text-sm text-slate-700">Cargar cobros con tarjeta</p>
              <span className="text-xs text-slate-500">Busca por lote y/o fecha; los cobros seleccionados entran al lote como vouchers.</span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 items-end">
              <label className="text-xs text-slate-500">N° de lote
                <input value={picker.lote} onChange={(e) => setPicker({ ...picker, lote: e.target.value })} placeholder="Ej. 0457" title="Los ceros a la izquierda no importan" className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm" />
              </label>
              <label className="text-xs text-slate-500">Desde (opcional)
                <DateInput value={picker.from} onChange={(e) => setPicker({ ...picker, from: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm" />
              </label>
              <label className="text-xs text-slate-500">Hasta (opcional)
                <DateInput value={picker.to} onChange={(e) => setPicker({ ...picker, to: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm" />
              </label>
              <button type="button" onClick={searchSales} disabled={searching} className="px-3 py-2 bg-emerald-600 text-white rounded-xl text-sm flex items-center justify-center gap-1.5 disabled:opacity-50">
                <HiOutlineMagnifyingGlass /> {searching ? 'Buscando…' : 'Buscar'}
              </button>
            </div>

            {!!pickerHint && !pickerResults.length && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">{pickerHint}</p>
            )}

            {pickerResults.length > 0 && (
              <div className="bg-white rounded-lg border overflow-x-auto">
                <table className="tbl text-xs min-w-[720px]">
                  <thead className="bg-slate-50 text-slate-500"><tr>
                    <th className="px-2 py-1.5 text-center"><input type="checkbox" checked={allPicked} onChange={toggleAll} /></th>
                    <th className="px-2 py-1.5 text-left">Venta</th><th className="px-2 py-1.5 text-left">Fecha</th>
                    <th className="px-2 py-1.5 text-left">Cliente</th><th className="px-2 py-1.5 text-left">Tarjeta</th>
                    <th className="px-2 py-1.5 text-left">Lote</th><th className="px-2 py-1.5 text-left">Voucher</th>
                    <th className="px-2 py-1.5 text-right">Monto</th>
                  </tr></thead>
                  <tbody>
                    {pickerResults.map((s) => (
                      <tr key={s._id} className={`border-t ${picked[s._id] ? 'bg-emerald-50/60' : ''}`}>
                        <td className="px-2 py-1.5 text-center"><input type="checkbox" checked={!!picked[s._id]} onChange={(e) => setPicked({ ...picked, [s._id]: e.target.checked })} /></td>
                        <td className="px-2 py-1.5 font-mono">{s.saleNumber}</td>
                        <td className="px-2 py-1.5">{fmtDate(s.createdAt)}</td>
                        <td className="px-2 py-1.5">{s.clientName}</td>
                        <td className="px-2 py-1.5">{s.creditCard?.name || '—'}</td>
                        <td className="px-2 py-1.5 font-mono">{s.cardLote || '—'}</td>
                        <td className="px-2 py-1.5 font-mono">{s.cardVoucher || '—'}</td>
                        <td className="px-2 py-1.5 text-right font-mono">${fmt(s.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="flex items-center justify-between px-3 py-2 bg-slate-50 border-t">
                  <span className="text-xs text-slate-600">{pickedList.length} de {pickerResults.length} seleccionados · <b className="font-mono">${fmt(pickedTotal)}</b></span>
                  <button type="button" onClick={addPicked} className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs flex items-center gap-1.5"><HiOutlinePlus /> Agregar seleccionados</button>
                </div>
              </div>
            )}
          </div>

          <div className="border rounded-lg p-3">
            <div className="flex justify-between items-center mb-2">
              <p className="font-semibold text-sm">Cobros del lote <span className="text-xs font-normal text-slate-500">({form.vouchers.length})</span></p>
              <button type="button" onClick={addVoucher} className="text-emerald-600 text-sm flex items-center gap-1"><HiOutlinePlus /> Voucher manual</button>
            </div>
            {form.vouchers.length > 0 && (
              <div className="grid grid-cols-6 gap-2 mb-1 text-[11px] text-slate-400 uppercase px-1">
                <span>Voucher #</span><span>Lote</span><span>Últ. 4</span><span>Fecha</span><span className="text-right">Monto bruto</span><span></span>
              </div>
            )}
            {form.vouchers.map((v, i) => (
              <div key={i} className="grid grid-cols-6 gap-2 mb-1 items-center">
                <input placeholder="Voucher #" value={v.voucherNumber} onChange={(e) => setVoucher(i, { voucherNumber: e.target.value })} className="border border-slate-200 rounded px-2 py-1 text-sm" />
                <input placeholder="Lote" value={v.lote} onChange={(e) => setVoucher(i, { lote: e.target.value })} className="border border-slate-200 rounded px-2 py-1 text-sm" />
                <input placeholder="Últ 4" value={v.cardLast4} onChange={(e) => setVoucher(i, { cardLast4: e.target.value })} className="border border-slate-200 rounded px-2 py-1 text-sm" />
                <span className="text-xs text-slate-500 px-1">{v.date ? fmtDate(v.date) : '—'}</span>
                <NumericInput step="0.01" placeholder="Monto bruto" value={v.grossAmount} onChange={(e) => setVoucher(i, { grossAmount: +e.target.value })} className="border border-slate-200 rounded px-2 py-1 text-sm text-right" />
                <button type="button" onClick={() => setForm({ ...form, vouchers: form.vouchers.filter((_, x) => x !== i) })} className="text-rose-600 text-sm">×</button>
              </div>
            ))}
            {!form.vouchers.length && <p className="text-xs text-slate-400 py-2">Sin cobros: búscalos arriba por lote/fecha o agrega un voucher manual.</p>}
            <div className="text-right font-semibold mt-2">Total bruto: ${fmt(totals)}</div>
          </div>

          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setShow(false)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button>
            <button disabled={saving} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 disabled:opacity-50">{saving ? 'Creando…' : 'Crear lote'}</button>
          </div>
        </form>
      </Modal>

      {/* Detalle: el resumen de los cobros que entraron al lote */}
      <Modal isOpen={!!viewItem} onClose={() => setViewItem(null)} title={`Lote ${viewItem?.code || ''}`} size="xl">
        {viewItem && (
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <div><span className="text-slate-500">Fecha de cierre:</span> {fmtDate(viewItem.closeDate)}</div>
              <div><span className="text-slate-500">Adquirente:</span> {viewItem.acquirer || '—'}</div>
              <div><span className="text-slate-500">Banco:</span> {viewItem.bankAccount?.name || '—'}</div>
              <div><span className="text-slate-500">Estado:</span> {statusBadge(viewItem.status)}</div>
            </div>
            <div className="overflow-x-auto">
              <table className="tbl text-xs">
                <thead className="bg-slate-50"><tr>
                  <th className="px-2 py-1 text-left">Voucher</th><th className="px-2 py-1 text-left">Lote</th>
                  <th className="px-2 py-1 text-left">Últ. 4</th><th className="px-2 py-1 text-left">Fecha</th>
                  <th className="px-2 py-1 text-right">Monto bruto</th>
                </tr></thead>
                <tbody>
                  {(viewItem.vouchers || []).map((v, i) => (
                    <tr key={i} className="border-t">
                      <td className="px-2 py-1 font-mono">{v.voucherNumber || '—'}</td>
                      <td className="px-2 py-1 font-mono">{v.lote || '—'}</td>
                      <td className="px-2 py-1 font-mono">{v.cardLast4 || '—'}</td>
                      <td className="px-2 py-1">{v.date ? fmtDate(v.date) : '—'}</td>
                      <td className="px-2 py-1 text-right font-mono">${fmt(v.grossAmount)}</td>
                    </tr>
                  ))}
                  {!(viewItem.vouchers || []).length && <tr><td colSpan={5} className="px-2 py-6 text-center text-slate-400">Este lote no tiene cobros registrados</td></tr>}
                </tbody>
                <tfoot><tr className="font-semibold border-t">
                  <td colSpan={4} className="px-2 py-1 text-right">{(viewItem.vouchers || []).length} cobro(s):</td>
                  <td className="px-2 py-1 text-right font-mono">${fmt(viewItem.grossAmount)}</td>
                </tr></tfoot>
              </table>
            </div>
            <div className="flex flex-wrap justify-end gap-4 bg-slate-50 rounded-lg p-3">
              <span>Bruto: <b className="font-mono">${fmt(viewItem.grossAmount)}</b></span>
              <span>Comisión: <b className="font-mono text-rose-600">${fmt(viewItem.commissionAmount)}</b></span>
              <span>IVA comisión: <b className="font-mono text-rose-600">${fmt(viewItem.ivaCommissionAmount)}</b></span>
              <span>Retención: <b className="font-mono text-rose-600">${fmt(viewItem.retentionAmount)}</b></span>
              <span>Neto acreditado: <b className="font-mono text-emerald-700">${fmt(viewItem.netAmount)}</b></span>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
