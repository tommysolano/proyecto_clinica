import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import { HiOutlinePlus, HiOutlineCreditCard, HiOutlineCheckCircle, HiOutlineEye, HiOutlinePencilSquare, HiOutlineTrash, HiOutlineXCircle } from 'react-icons/hi2';
import { fmt, fmtDate, today } from './_utils';

// Códigos SRI frecuentes en liquidaciones de tarjeta (referenciales, editables)
const SRI_RENTA = ['332', '343', '344', '304'];
const SRI_IVA = ['721', '723', '725'];

const EMPTY_TXN = { date: today(), recap: '', account: '', costCenter: '', deposit: 0, commission: 0, iva: 0, baseRetIr: 0, baseRetIva: 0, baseIr: 0, retIva: 0 };
const EMPTY_RET = { issueDate: today(), retentionNumber: '', authorization: '', type: 'RENTA', sriCode: '', base: 0, percentage: 0, value: 0 };
const EMPTY = {
  issueDate: today(), docType: 'LIQUIDACION', supplier: '', bankAccount: '', docNumber: '', commissionToSettle: 0,
  receivableAccount: '', commissionAccount: '', ivaAccount: '', retIvaAccount: '', retIrAccount: '',
  transactions: [{ ...EMPTY_TXN }], retentions: [], notes: '',
};

const round = (n) => +(Number(n) || 0).toFixed(2);

export default function CardSettlements() {
  const [list, setList] = useState([]);
  const [banks, setBanks] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [costCenters, setCostCenters] = useState([]);
  const [show, setShow] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [viewItem, setViewItem] = useState(null);

  const load = async () => {
    try { const r = await api.get('/card-settlements'); setList(r.data || []); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  useEffect(() => {
    api.get('/banks/accounts').then((r) => setBanks(r.data || [])).catch(() => {});
    api.get('/suppliers').then((r) => setSuppliers((r.data || []).filter((s) => (s.roles || []).includes('PROVEEDOR')))).catch(() => {});
    api.get('/chart-of-accounts').then((r) => setAccounts((r.data || []).filter((a) => a.allowsMovement))).catch(() => {});
    api.get('/cost-centers').then((r) => setCostCenters(r.data || [])).catch(() => {});
    load();
  }, []);

  // Totales derivados (espejo del backend)
  const totals = (() => {
    let deposit = 0, commission = 0, iva = 0, retIva = 0, toPay = 0;
    (form.transactions || []).forEach((t) => {
      const d = +t.deposit || 0, c = +t.commission || 0, i = +t.iva || 0, ri = +t.retIva || 0;
      deposit += d; commission += c; iva += i; retIva += ri; toPay += round(d - c - i - ri);
    });
    const retIr = (form.retentions || []).filter((r) => r.type === 'RENTA').reduce((s, r) => s + (+r.value || 0), 0);
    return { deposit: round(deposit), commission: round(commission), iva: round(iva), retIva: round(retIva), retIr: round(retIr), toPay: round(toPay), net: round(toPay - retIr) };
  })();

  const openNew = () => { setEditId(null); setForm(EMPTY); setShow(true); };
  const openEdit = async (id) => {
    try {
      const r = await api.get(`/card-settlements/${id}`);
      const d = r.data;
      setForm({
        ...EMPTY, ...d,
        issueDate: d.issueDate ? d.issueDate.slice(0, 10) : today(),
        supplier: d.supplier?._id || d.supplier || '',
        bankAccount: d.bankAccount?._id || d.bankAccount || '',
        receivableAccount: d.receivableAccount || '', commissionAccount: d.commissionAccount || '',
        ivaAccount: d.ivaAccount || '', retIvaAccount: d.retIvaAccount || '', retIrAccount: d.retIrAccount || '',
        transactions: (d.transactions || []).map((t) => ({
          ...t, date: t.date ? t.date.slice(0, 10) : '', account: t.account?._id || t.account || '', costCenter: t.costCenter?._id || t.costCenter || '',
        })),
        retentions: (d.retentions || []).map((r2) => ({ ...r2, issueDate: r2.issueDate ? r2.issueDate.slice(0, 10) : '' })),
      });
      setEditId(id); setShow(true);
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  const setTxn = (i, patch) => { const a = [...form.transactions]; a[i] = { ...a[i], ...patch }; setForm({ ...form, transactions: a }); };
  const addTxn = () => setForm({ ...form, transactions: [...form.transactions, { ...EMPTY_TXN }] });
  const delTxn = (i) => setForm({ ...form, transactions: form.transactions.filter((_, x) => x !== i) });
  const setRet = (i, patch) => { const a = [...form.retentions]; a[i] = { ...a[i], ...patch }; setForm({ ...form, retentions: a }); };
  const addRet = () => setForm({ ...form, retentions: [...form.retentions, { ...EMPTY_RET }] });
  const delRet = (i) => setForm({ ...form, retentions: form.retentions.filter((_, x) => x !== i) });

  const submit = async (e) => {
    e.preventDefault();
    if (!form.transactions.length) return toast.error('Agrega al menos una transacción');
    try {
      const payload = { ...form };
      ['receivableAccount', 'commissionAccount', 'ivaAccount', 'retIvaAccount', 'retIrAccount', 'supplier', 'bankAccount'].forEach((k) => { if (!payload[k]) payload[k] = null; });
      payload.transactions = payload.transactions.map((t) => ({ ...t, account: t.account || null, costCenter: t.costCenter || null }));
      if (editId) { await api.put(`/card-settlements/${editId}`, payload); toast.success('Liquidación actualizada'); }
      else { await api.post('/card-settlements', payload); toast.success('Liquidación creada'); }
      setShow(false); setForm(EMPTY); setEditId(null); load();
    } catch (err) { toast.error(err.response?.data?.message || 'Error'); }
  };

  const accredit = async (s) => {
    if (!confirm('¿Acreditar/contabilizar la liquidación? Se registrará el depósito en banco, comisión, IVA y retenciones.')) return;
    try { await api.post(`/card-settlements/${s._id}/accredit`); toast.success('Liquidación acreditada'); load(); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  const cancel = async (s) => {
    if (!confirm('¿Anular la liquidación? Se reversará el asiento contable.')) return;
    try { await api.post(`/card-settlements/${s._id}/cancel`); toast.success('Anulada'); load(); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  const remove = async (s) => {
    if (!confirm('¿Eliminar la liquidación en borrador?')) return;
    try { await api.delete(`/card-settlements/${s._id}`); toast.success('Eliminada'); load(); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  const statusBadge = (st) => {
    const map = { BORRADOR: 'bg-amber-100 text-amber-700', CONTABILIZADO: 'bg-emerald-100 text-emerald-700', ANULADO: 'bg-rose-100 text-rose-700' };
    return <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${map[st] || 'bg-slate-100 text-slate-600'}`}>{st}</span>;
  };

  const accountLabel = (a) => `${a.code} — ${a.name}`;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2"><HiOutlineCreditCard className="text-emerald-600" /> Liquidaciones de Tarjetas de Crédito</h1>
        <button onClick={openNew} className="px-4 py-2 bg-emerald-600 text-white rounded-lg flex items-center gap-2"><HiOutlinePlus /> Nueva liquidación</button>
      </div>

      <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-emerald-50 text-xs uppercase"><tr>
            <th className="px-3 py-2 text-left">Código</th><th className="px-3 py-2 text-left">F. Emisión</th>
            <th className="px-3 py-2 text-left">Proveedor</th><th className="px-3 py-2 text-left"># Doc.</th>
            <th className="px-3 py-2 text-left">Banco</th><th className="px-3 py-2 text-right">Depósito</th>
            <th className="px-3 py-2 text-right">Comis.</th><th className="px-3 py-2 text-right">A pagar</th>
            <th className="px-3 py-2 text-center">Estado</th><th className="px-3 py-2"></th>
          </tr></thead>
          <tbody>
            {list.map((s) => (
              <tr key={s._id} className="border-t hover:bg-slate-50">
                <td className="px-3 py-2 font-mono text-xs">{s.code}</td>
                <td className="px-3 py-2">{fmtDate(s.issueDate)}</td>
                <td className="px-3 py-2 text-xs">{s.supplier?.razonSocial || s.supplier?.nombreComercial || '—'}</td>
                <td className="px-3 py-2 text-xs">{s.docNumber}</td>
                <td className="px-3 py-2 text-xs">{s.bankAccount?.name || '—'}</td>
                <td className="px-3 py-2 text-right font-mono">${fmt(s.totalDeposit)}</td>
                <td className="px-3 py-2 text-right font-mono text-rose-600">{fmt(s.totalCommission)}</td>
                <td className="px-3 py-2 text-right font-mono font-semibold text-emerald-700">${fmt(s.totalToPay - s.totalRetIr)}</td>
                <td className="px-3 py-2 text-center">{statusBadge(s.status)}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center justify-end gap-1.5">
                    <button onClick={() => setViewItem(s)} className="text-slate-500 hover:text-slate-700" title="Ver"><HiOutlineEye className="w-5 h-5" /></button>
                    {s.status === 'BORRADOR' && <>
                      <button onClick={() => openEdit(s._id)} className="text-sky-600" title="Editar"><HiOutlinePencilSquare className="w-5 h-5" /></button>
                      <button onClick={() => accredit(s)} className="text-emerald-600" title="Acreditar"><HiOutlineCheckCircle className="w-5 h-5" /></button>
                      <button onClick={() => remove(s)} className="text-rose-500" title="Eliminar"><HiOutlineTrash className="w-5 h-5" /></button>
                    </>}
                    {s.status === 'CONTABILIZADO' && <button onClick={() => cancel(s)} className="text-rose-600" title="Anular"><HiOutlineXCircle className="w-5 h-5" /></button>}
                  </div>
                </td>
              </tr>
            ))}
            {!list.length && <tr><td colSpan={10} className="px-3 py-8 text-center text-slate-400">Sin liquidaciones registradas</td></tr>}
          </tbody>
        </table>
      </div>

      {/* Modal crear/editar */}
      <Modal isOpen={show} onClose={() => setShow(false)} title={editId ? 'Editar liquidación' : 'Registrar liquidación de tarjeta'} size="full">
        <form onSubmit={submit} className="space-y-4">
          {/* Cabecera */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <label className="text-xs text-slate-500">Fecha de emisión
              <input type="date" required value={form.issueDate} onChange={(e) => setForm({ ...form, issueDate: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" />
            </label>
            <label className="text-xs text-slate-500">Tipo de documento
              <select value={form.docType} onChange={(e) => setForm({ ...form, docType: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm">
                <option value="LIQUIDACION">Liquidación</option><option value="FACTURA">Factura</option><option value="NOTA_CREDITO">Nota de crédito</option><option value="OTRO">Otro</option>
              </select>
            </label>
            <label className="text-xs text-slate-500">Proveedor (adquirente)
              <select value={form.supplier} onChange={(e) => setForm({ ...form, supplier: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm">
                <option value="">Selecciona...</option>{suppliers.map((s) => <option key={s._id} value={s._id}>{s.razonSocial || s.nombreComercial}</option>)}
              </select>
            </label>
            <label className="text-xs text-slate-500">Banco (acreditación)
              <select value={form.bankAccount} onChange={(e) => setForm({ ...form, bankAccount: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm">
                <option value="">Selecciona...</option>{banks.map((b) => <option key={b._id} value={b._id}>{b.name}</option>)}
              </select>
            </label>
            <label className="text-xs text-slate-500">Número de documento
              <input value={form.docNumber} onChange={(e) => setForm({ ...form, docNumber: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" />
            </label>
            <label className="text-xs text-slate-500">Comisión por liquidar ($)
              <input type="number" step="0.01" value={form.commissionToSettle} onChange={(e) => setForm({ ...form, commissionToSettle: +e.target.value })} className="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-right" />
            </label>
          </div>

          {/* Cuentas contables seleccionables */}
          <details className="border rounded-lg p-3">
            <summary className="cursor-pointer text-sm font-semibold text-slate-700">Cuentas contables (opcional — si se dejan vacías se usan las predeterminadas)</summary>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-3">
              {[['receivableAccount', 'Tarjetas por cobrar'], ['commissionAccount', 'Gasto comisión'], ['ivaAccount', 'IVA en compras'], ['retIvaAccount', 'Retención IVA por cobrar'], ['retIrAccount', 'Retención IR por cobrar']].map(([key, label]) => (
                <label key={key} className="text-xs text-slate-500">{label}
                  <select value={form[key] || ''} onChange={(e) => setForm({ ...form, [key]: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-lg px-2 py-2 text-sm">
                    <option value="">Predeterminada</option>{accounts.map((a) => <option key={a._id} value={a._id}>{accountLabel(a)}</option>)}
                  </select>
                </label>
              ))}
            </div>
          </details>

          {/* Transacciones */}
          <div className="border rounded-lg p-3">
            <div className="flex justify-between items-center mb-2"><p className="font-semibold text-sm">Transacciones</p><button type="button" onClick={addTxn} className="text-emerald-600 text-sm flex items-center gap-1"><HiOutlinePlus /> Transacción</button></div>
            <div className="overflow-x-auto">
              <table className="text-xs w-full min-w-[1100px]">
                <thead><tr className="text-slate-500 text-left">
                  <th className="px-1 py-1">Fecha</th><th className="px-1 py-1">#Recap</th><th className="px-1 py-1">Cuenta</th><th className="px-1 py-1">Centro de costo</th>
                  <th className="px-1 py-1 text-right">Depósito</th><th className="px-1 py-1 text-right">Comisión</th><th className="px-1 py-1 text-right">IVA</th>
                  <th className="px-1 py-1 text-right">Base ret IR</th><th className="px-1 py-1 text-right">Base ret IVA</th><th className="px-1 py-1 text-right">Base IR</th>
                  <th className="px-1 py-1 text-right">Ret IVA</th><th className="px-1 py-1 text-right">A pagar</th><th></th>
                </tr></thead>
                <tbody>
                  {form.transactions.map((t, i) => {
                    const toPay = round((+t.deposit || 0) - (+t.commission || 0) - (+t.iva || 0) - (+t.retIva || 0));
                    return (
                      <tr key={i}>
                        <td className="px-0.5 py-0.5"><input type="date" value={t.date} onChange={(e) => setTxn(i, { date: e.target.value })} className="border border-slate-200 rounded px-1 py-1 w-32" /></td>
                        <td className="px-0.5 py-0.5"><input value={t.recap} onChange={(e) => setTxn(i, { recap: e.target.value })} className="border border-slate-200 rounded px-1 py-1 w-20" /></td>
                        <td className="px-0.5 py-0.5"><select value={t.account || ''} onChange={(e) => setTxn(i, { account: e.target.value })} className="border border-slate-200 rounded px-1 py-1 w-40"><option value="">—</option>{accounts.map((a) => <option key={a._id} value={a._id}>{a.code}</option>)}</select></td>
                        <td className="px-0.5 py-0.5"><select value={t.costCenter || ''} onChange={(e) => setTxn(i, { costCenter: e.target.value })} className="border border-slate-200 rounded px-1 py-1 w-36"><option value="">—</option>{costCenters.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}</select></td>
                        <td className="px-0.5 py-0.5"><input type="number" step="0.01" value={t.deposit} onChange={(e) => setTxn(i, { deposit: +e.target.value })} className="border border-slate-200 rounded px-1 py-1 w-24 text-right" /></td>
                        <td className="px-0.5 py-0.5"><input type="number" step="0.01" value={t.commission} onChange={(e) => setTxn(i, { commission: +e.target.value })} className="border border-slate-200 rounded px-1 py-1 w-24 text-right" /></td>
                        <td className="px-0.5 py-0.5"><input type="number" step="0.01" value={t.iva} onChange={(e) => setTxn(i, { iva: +e.target.value })} className="border border-slate-200 rounded px-1 py-1 w-20 text-right" /></td>
                        <td className="px-0.5 py-0.5"><input type="number" step="0.01" value={t.baseRetIr} onChange={(e) => setTxn(i, { baseRetIr: +e.target.value })} className="border border-slate-200 rounded px-1 py-1 w-24 text-right" /></td>
                        <td className="px-0.5 py-0.5"><input type="number" step="0.01" value={t.baseRetIva} onChange={(e) => setTxn(i, { baseRetIva: +e.target.value })} className="border border-slate-200 rounded px-1 py-1 w-24 text-right" /></td>
                        <td className="px-0.5 py-0.5"><input type="number" step="0.01" value={t.baseIr} onChange={(e) => setTxn(i, { baseIr: +e.target.value })} className="border border-slate-200 rounded px-1 py-1 w-20 text-right" /></td>
                        <td className="px-0.5 py-0.5"><input type="number" step="0.01" value={t.retIva} onChange={(e) => setTxn(i, { retIva: +e.target.value })} className="border border-slate-200 rounded px-1 py-1 w-20 text-right" /></td>
                        <td className="px-1 py-0.5 text-right font-mono font-semibold text-emerald-700">{fmt(toPay)}</td>
                        <td className="px-0.5 py-0.5 text-center"><button type="button" onClick={() => delTxn(i)} className="text-rose-600">×</button></td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot><tr className="font-semibold border-t">
                  <td colSpan={4} className="px-1 py-1 text-right">Totales:</td>
                  <td className="px-1 py-1 text-right font-mono">{fmt(totals.deposit)}</td>
                  <td className="px-1 py-1 text-right font-mono">{fmt(totals.commission)}</td>
                  <td className="px-1 py-1 text-right font-mono">{fmt(totals.iva)}</td>
                  <td colSpan={2}></td><td></td>
                  <td className="px-1 py-1 text-right font-mono">{fmt(totals.retIva)}</td>
                  <td className="px-1 py-1 text-right font-mono text-emerald-700">{fmt(totals.toPay)}</td><td></td>
                </tr></tfoot>
              </table>
            </div>
          </div>

          {/* Retenciones */}
          <div className="border rounded-lg p-3">
            <div className="flex justify-between items-center mb-2"><p className="font-semibold text-sm">Retenciones</p><button type="button" onClick={addRet} className="text-emerald-600 text-sm flex items-center gap-1"><HiOutlinePlus /> Retención</button></div>
            <datalist id="sri-renta">{SRI_RENTA.map((c) => <option key={c} value={c} />)}</datalist>
            <datalist id="sri-iva">{SRI_IVA.map((c) => <option key={c} value={c} />)}</datalist>
            {form.retentions.map((r, i) => (
              <div key={i} className="grid grid-cols-2 md:grid-cols-9 gap-1.5 mb-1 items-center">
                <input type="date" value={r.issueDate} onChange={(e) => setRet(i, { issueDate: e.target.value })} className="border border-slate-200 rounded px-1 py-1 text-xs" title="Fecha emisión" />
                <input placeholder="N° retención" value={r.retentionNumber} onChange={(e) => setRet(i, { retentionNumber: e.target.value })} className="border border-slate-200 rounded px-1 py-1 text-xs" />
                <input placeholder="Autorización" value={r.authorization} onChange={(e) => setRet(i, { authorization: e.target.value })} className="border border-slate-200 rounded px-1 py-1 text-xs" />
                <select value={r.type} onChange={(e) => setRet(i, { type: e.target.value })} className="border border-slate-200 rounded px-1 py-1 text-xs"><option value="RENTA">RENTA</option><option value="IVA">IVA</option></select>
                <input placeholder="Cód. SRI" list={r.type === 'IVA' ? 'sri-iva' : 'sri-renta'} value={r.sriCode} onChange={(e) => setRet(i, { sriCode: e.target.value })} className="border border-slate-200 rounded px-1 py-1 text-xs" />
                <input type="number" step="0.01" placeholder="Base" value={r.base} onChange={(e) => setRet(i, { base: +e.target.value })} className="border border-slate-200 rounded px-1 py-1 text-xs text-right" title="Base" />
                <input type="number" step="0.01" placeholder="%" value={r.percentage} onChange={(e) => { const p = +e.target.value; setRet(i, { percentage: p, value: round((+r.base || 0) * p / 100) }); }} className="border border-slate-200 rounded px-1 py-1 text-xs text-right" title="%" />
                <input type="number" step="0.01" placeholder="Valor" value={r.value} onChange={(e) => setRet(i, { value: +e.target.value })} className="border border-slate-200 rounded px-1 py-1 text-xs text-right" title="Valor" />
                <button type="button" onClick={() => delRet(i)} className="text-rose-600 text-sm">×</button>
              </div>
            ))}
          </div>

          {/* Resumen */}
          <div className="flex flex-wrap justify-end gap-4 text-sm bg-slate-50 rounded-lg p-3">
            <span>Depósito: <b className="font-mono">${fmt(totals.deposit)}</b></span>
            <span>Comisión: <b className="font-mono text-rose-600">${fmt(totals.commission)}</b></span>
            <span>IVA: <b className="font-mono">${fmt(totals.iva)}</b></span>
            <span>Ret. IVA: <b className="font-mono">${fmt(totals.retIva)}</b></span>
            <span>Ret. IR: <b className="font-mono">${fmt(totals.retIr)}</b></span>
            <span>Neto a banco: <b className="font-mono text-emerald-700">${fmt(totals.net)}</b></span>
          </div>

          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setShow(false)} className="px-4 py-2 bg-slate-200 rounded-lg">Cancelar</button>
            <button className="px-4 py-2 bg-emerald-600 text-white rounded-lg">{editId ? 'Guardar' : 'Crear liquidación'}</button>
          </div>
        </form>
      </Modal>

      {/* Modal ver */}
      <Modal isOpen={!!viewItem} onClose={() => setViewItem(null)} title={`Liquidación ${viewItem?.code || ''}`} size="xl">
        {viewItem && (
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              <div><span className="text-slate-500">F. Emisión:</span> {fmtDate(viewItem.issueDate)}</div>
              <div><span className="text-slate-500">Tipo:</span> {viewItem.docType}</div>
              <div><span className="text-slate-500">N° Doc:</span> {viewItem.docNumber || '—'}</div>
              <div><span className="text-slate-500">Proveedor:</span> {viewItem.supplier?.razonSocial || '—'}</div>
              <div><span className="text-slate-500">Banco:</span> {viewItem.bankAccount?.name || '—'}</div>
              <div><span className="text-slate-500">Estado:</span> {statusBadge(viewItem.status)}</div>
            </div>
            <div className="overflow-x-auto">
              <table className="text-xs w-full">
                <thead className="bg-slate-50"><tr>
                  <th className="px-2 py-1 text-left">Fecha</th><th className="px-2 py-1 text-left">#Recap</th><th className="px-2 py-1 text-right">Depósito</th>
                  <th className="px-2 py-1 text-right">Comisión</th><th className="px-2 py-1 text-right">IVA</th><th className="px-2 py-1 text-right">Ret IVA</th><th className="px-2 py-1 text-right">A pagar</th>
                </tr></thead>
                <tbody>
                  {(viewItem.transactions || []).map((t, i) => (
                    <tr key={i} className="border-t">
                      <td className="px-2 py-1">{fmtDate(t.date)}</td><td className="px-2 py-1">{t.recap}</td>
                      <td className="px-2 py-1 text-right font-mono">{fmt(t.deposit)}</td><td className="px-2 py-1 text-right font-mono">{fmt(t.commission)}</td>
                      <td className="px-2 py-1 text-right font-mono">{fmt(t.iva)}</td><td className="px-2 py-1 text-right font-mono">{fmt(t.retIva)}</td>
                      <td className="px-2 py-1 text-right font-mono font-semibold">{fmt(t.toPay)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!!(viewItem.retentions || []).length && (
              <div>
                <p className="font-semibold mb-1">Retenciones</p>
                <table className="text-xs w-full">
                  <thead className="bg-slate-50"><tr><th className="px-2 py-1 text-left">N°</th><th className="px-2 py-1 text-left">Tipo</th><th className="px-2 py-1 text-left">Cód SRI</th><th className="px-2 py-1 text-right">Base</th><th className="px-2 py-1 text-right">%</th><th className="px-2 py-1 text-right">Valor</th></tr></thead>
                  <tbody>{viewItem.retentions.map((r, i) => (<tr key={i} className="border-t"><td className="px-2 py-1">{r.retentionNumber}</td><td className="px-2 py-1">{r.type}</td><td className="px-2 py-1">{r.sriCode}</td><td className="px-2 py-1 text-right font-mono">{fmt(r.base)}</td><td className="px-2 py-1 text-right">{r.percentage}</td><td className="px-2 py-1 text-right font-mono">{fmt(r.value)}</td></tr>))}</tbody>
                </table>
              </div>
            )}
            <div className="flex flex-wrap justify-end gap-4 bg-slate-50 rounded-lg p-3">
              <span>Depósito: <b className="font-mono">${fmt(viewItem.totalDeposit)}</b></span>
              <span>Neto a banco: <b className="font-mono text-emerald-700">${fmt(viewItem.totalToPay - viewItem.totalRetIr)}</b></span>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
