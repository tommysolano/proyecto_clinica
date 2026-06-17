import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import Field from '../../components/Field';
import { HiOutlinePlus, HiOutlineCreditCard, HiOutlineCheckCircle } from 'react-icons/hi2';
import { fmt, fmtDate, today } from './_utils';

const EMPTY = { closeDate: today(), cardType: 'CREDITO', acquirer: '', commissionRate: 5, retentionRate: 0, ivaCommissionRate: 15, bankAccount: '', vouchers: [] };

export default function CreditCardBatches() {
  const [list, setList] = useState([]);
  const [banks, setBanks] = useState([]);
  const [show, setShow] = useState(false);
  const [form, setForm] = useState(EMPTY);

  const load = async () => {
    try { const r = await api.get('/credit-card-batches'); setList(r.data || []); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  useEffect(() => {
    api.get('/banks/accounts').then((r) => setBanks(r.data || []));
    load();
  }, []);

  const totals = form.vouchers.reduce((acc, v) => acc + (+v.grossAmount || 0), 0);

  const addVoucher = () => setForm({ ...form, vouchers: [...form.vouchers, { voucherNumber: '', lote: '', cardLast4: '', cardType: form.cardType, grossAmount: 0 }] });
  const setVoucher = (i, patch) => { const vs = [...form.vouchers]; vs[i] = { ...vs[i], ...patch }; setForm({ ...form, vouchers: vs }); };

  const submit = async (e) => {
    e.preventDefault();
    try { await api.post('/credit-card-batches', form); toast.success('Lote creado'); setShow(false); setForm(EMPTY); load(); }
    catch (err) { toast.error(err.response?.data?.message || 'Error'); }
  };

  const liquidate = async (b) => {
    if (!confirm('¿Liquidar lote? Se registrará en banco con comisión/retención.')) return;
    try { await api.post(`/credit-card-batches/${b._id}/liquidate`); toast.success('Liquidado'); load(); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineCreditCard className="text-emerald-600" /> Lotes Tarjetas de Crédito</h1>
        <button onClick={() => { setForm(EMPTY); setShow(true); }} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center gap-2"><HiOutlinePlus /> Nuevo lote</button>
      </div>
      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden">
        <table className="tbl">
          <thead className="bg-emerald-50 text-xs uppercase"><tr>
            <th className="px-3 py-2 text-left">Código</th><th className="px-3 py-2 text-left">Fecha</th>
            <th className="px-3 py-2 text-left">Adquirente</th><th className="px-3 py-2 text-right">Bruto</th>
            <th className="px-3 py-2 text-right">Comis.</th><th className="px-3 py-2 text-right">Reten.</th>
            <th className="px-3 py-2 text-right">Neto</th><th className="px-3 py-2 text-center">Estado</th><th></th>
          </tr></thead>
          <tbody>
            {list.map((b) => (
              <tr key={b._id} className="border-t">
                <td className="px-3 py-2 font-mono text-xs">{b.code}</td>
                <td className="px-3 py-2">{fmtDate(b.closeDate)}</td>
                <td className="px-3 py-2 text-xs">{b.acquirer}</td>
                <td className="px-3 py-2 text-right font-mono">${fmt(b.grossAmount)}</td>
                <td className="px-3 py-2 text-right font-mono text-rose-600">{fmt(b.commissionAmount)}</td>
                <td className="px-3 py-2 text-right font-mono text-rose-600">{fmt(b.retentionAmount)}</td>
                <td className="px-3 py-2 text-right font-mono font-semibold text-emerald-700">${fmt(b.netAmount)}</td>
                <td className="px-3 py-2 text-center text-xs">{b.status}</td>
                <td className="px-3 py-2 text-right">{b.status === 'ABIERTO' && <button onClick={() => liquidate(b)} className="text-emerald-600" title="Liquidar"><HiOutlineCheckCircle className="w-5 h-5" /></button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal isOpen={show} onClose={() => setShow(false)} title="Nuevo lote de tarjetas" size="xl">
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-4 gap-3">
            <Field label="Fecha de cierre" required><input type="date" required value={form.closeDate} onChange={(e) => setForm({ ...form, closeDate: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
            <Field label="Tipo de tarjeta"><select value={form.cardType} onChange={(e) => setForm({ ...form, cardType: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5"><option>CREDITO</option><option>DEBITO</option></select></Field>
            <Field label="Adquirente" required className="col-span-2"><input required placeholder="Datafast / Medianet" value={form.acquirer} onChange={(e) => setForm({ ...form, acquirer: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
            <Field label="% comisión"><input type="number" step="0.01" value={form.commissionRate} onChange={(e) => setForm({ ...form, commissionRate: +e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
            <Field label="% retención"><input type="number" step="0.01" value={form.retentionRate} onChange={(e) => setForm({ ...form, retentionRate: +e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
            <Field label="% IVA comisión"><input type="number" step="0.01" value={form.ivaCommissionRate} onChange={(e) => setForm({ ...form, ivaCommissionRate: +e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
            <Field label="Banco de acreditación" required><select required value={form.bankAccount} onChange={(e) => setForm({ ...form, bankAccount: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5"><option value="">Seleccione…</option>{banks.map((b) => <option key={b._id} value={b._id}>{b.name}</option>)}</select></Field>
          </div>
          <div className="border rounded-lg p-3">
            <div className="flex justify-between items-center mb-2"><p className="font-semibold text-sm">Vouchers</p><button type="button" onClick={addVoucher} className="text-emerald-600 text-sm flex items-center gap-1"><HiOutlinePlus /> Voucher</button></div>
            {form.vouchers.length > 0 && (
              <div className="grid grid-cols-5 gap-2 mb-1 text-[11px] text-slate-400 uppercase px-1">
                <span>Voucher #</span><span>Lote</span><span>Últ. 4</span><span className="text-right">Monto bruto</span><span></span>
              </div>
            )}
            {form.vouchers.map((v, i) => (
              <div key={i} className="grid grid-cols-5 gap-2 mb-1">
                <input placeholder="Voucher #" value={v.voucherNumber} onChange={(e) => setVoucher(i, { voucherNumber: e.target.value })} className="border border-slate-200 rounded px-2 py-1 text-sm" />
                <input placeholder="Lote" value={v.lote} onChange={(e) => setVoucher(i, { lote: e.target.value })} className="border border-slate-200 rounded px-2 py-1 text-sm" />
                <input placeholder="Últ 4" value={v.cardLast4} onChange={(e) => setVoucher(i, { cardLast4: e.target.value })} className="border border-slate-200 rounded px-2 py-1 text-sm" />
                <input type="number" step="0.01" placeholder="Monto bruto" value={v.grossAmount} onChange={(e) => setVoucher(i, { grossAmount: +e.target.value })} className="border border-slate-200 rounded px-2 py-1 text-sm text-right" />
                <button type="button" onClick={() => setForm({ ...form, vouchers: form.vouchers.filter((_, x) => x !== i) })} className="text-rose-600 text-sm">×</button>
              </div>
            ))}
            <div className="text-right font-semibold mt-2">Total bruto: ${fmt(totals)}</div>
          </div>
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setShow(false)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button><button className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20">Crear lote</button></div>
        </form>
      </Modal>
    </div>
  );
}
