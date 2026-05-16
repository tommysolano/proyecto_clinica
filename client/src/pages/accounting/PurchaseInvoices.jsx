import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import { HiOutlinePlus, HiOutlineDocumentText, HiOutlineArrowDownTray, HiOutlineXMark } from 'react-icons/hi2';
import { fmt, fmtDate, today } from './_utils';

const EMPTY_ITEM = { description: '', quantity: 1, unitPrice: 0, discount: 0, ivaRate: 15, account: '', product: null };
const EMPTY = { supplier: '', docType: 'FACTURA', estab: '001', ptoEmi: '001', secuencial: '', serie: '', claveAcceso: '', autorizacion: '', fechaEmision: today(), fechaVencimiento: '', items: [{ ...EMPTY_ITEM }], retentions: [], retentionNumber: '' };

export default function PurchaseInvoices() {
  const [list, setList] = useState([]);
  const [show, setShow] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importTxt, setImportTxt] = useState('');
  const [suppliers, setSuppliers] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [form, setForm] = useState(EMPTY);

  const load = async () => {
    try { const r = await api.get('/purchase-invoices'); setList(r.data?.items || r.data || []); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  useEffect(() => {
    api.get('/suppliers').then((r) => setSuppliers(r.data || []));
    api.get('/chart-of-accounts').then((r) => setAccounts((r.data || []).filter((a) => a.allowsMovement && (a.code?.startsWith('6.') || a.code?.startsWith('1.1.04') || a.code?.startsWith('1.2.')))));
    load();
  }, []);

  const totals = (() => {
    let s0 = 0, s12 = 0, s15 = 0, sNo = 0, sEx = 0, iva = 0;
    for (const it of form.items) {
      const base = (it.quantity * it.unitPrice) - (it.discount || 0);
      if (it.ivaRate === 0) s0 += base;
      else if (it.ivaRate === 12) { s12 += base; iva += base * 0.12; }
      else if (it.ivaRate === 15) { s15 += base; iva += base * 0.15; }
      else if (it.ivaRate === -1) sNo += base;
      else if (it.ivaRate === -2) sEx += base;
    }
    const subtotal = s0 + s12 + s15 + sNo + sEx;
    const retTotal = (form.retentions || []).reduce((s, r) => s + (+r.amount || 0), 0);
    return { s0, s12, s15, sNo, sEx, subtotal, iva, total: subtotal + iva, retTotal, balance: subtotal + iva - retTotal };
  })();

  const submit = async (e) => {
    e.preventDefault();
    try {
      const serie = form.serie || `${form.estab}-${form.ptoEmi}-${form.secuencial}`;
      await api.post('/purchase-invoices', { ...form, serie, fechaEmision: new Date(form.fechaEmision) });
      toast.success('Registrada');
      setShow(false); setForm(EMPTY); load();
    } catch (err) { toast.error(err.response?.data?.message || 'Error'); }
  };

  const voidIt = async (p) => {
    if (!confirm('¿Anular?')) return;
    try { await api.post(`/purchase-invoices/${p._id}/void`); load(); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  const submitImport = async () => {
    try {
      const r = await api.post('/purchase-invoices/import-txt', { text: importTxt });
      toast.success(`${r.data.created || 0} facturas importadas`);
      setShowImport(false); load();
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  const setItem = (i, patch) => {
    const items = [...form.items]; items[i] = { ...items[i], ...patch }; setForm({ ...form, items });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2"><HiOutlineDocumentText className="text-emerald-600" /> Compras</h1>
        <div className="flex gap-2">
          <button onClick={() => setShowImport(true)} className="px-4 py-2 bg-amber-500 text-white rounded-lg flex items-center gap-2"><HiOutlineArrowDownTray /> Importar TXT</button>
          <button onClick={() => { setForm(EMPTY); setShow(true); }} className="px-4 py-2 bg-emerald-600 text-white rounded-lg flex items-center gap-2"><HiOutlinePlus /> Nueva</button>
        </div>
      </div>
      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-emerald-50 text-xs uppercase"><tr>
            <th className="px-3 py-2 text-left">Serie</th><th className="px-3 py-2 text-left">Fecha</th>
            <th className="px-3 py-2 text-left">Tipo</th><th className="px-3 py-2 text-left">Proveedor</th>
            <th className="px-3 py-2 text-right">Subtotal</th><th className="px-3 py-2 text-right">IVA</th>
            <th className="px-3 py-2 text-right">Total</th><th className="px-3 py-2 text-right">Retenc.</th>
            <th className="px-3 py-2 text-center">Estado</th><th></th>
          </tr></thead>
          <tbody>
            {list.map((p) => (
              <tr key={p._id} className={`border-t ${p.status === 'ANULADA' ? 'text-slate-400 line-through' : ''}`}>
                <td className="px-3 py-2 font-mono text-xs">{p.serie}</td>
                <td className="px-3 py-2">{fmtDate(p.fechaEmision)}</td>
                <td className="px-3 py-2 text-xs">{p.docType}</td>
                <td className="px-3 py-2">{p.supplier?.razonSocial}</td>
                <td className="px-3 py-2 text-right font-mono">{fmt(p.subtotal)}</td>
                <td className="px-3 py-2 text-right font-mono">{fmt(p.iva)}</td>
                <td className="px-3 py-2 text-right font-mono font-semibold">{fmt(p.total)}</td>
                <td className="px-3 py-2 text-right font-mono">{fmt(p.retentionTotal)}</td>
                <td className="px-3 py-2 text-center text-xs">{p.status}</td>
                <td className="px-3 py-2 text-right">{p.status === 'REGISTRADA' && <button onClick={() => voidIt(p)} className="text-rose-600"><HiOutlineXMark className="w-4 h-4" /></button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal isOpen={show} onClose={() => setShow(false)} title="Nueva factura de compra" size="xl">
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-4 gap-3">
            <select required value={form.supplier} onChange={(e) => setForm({ ...form, supplier: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2 col-span-2">
              <option value="">Proveedor...</option>
              {suppliers.map((s) => <option key={s._id} value={s._id}>{s.ruc} - {s.razonSocial}</option>)}
            </select>
            <select value={form.docType} onChange={(e) => setForm({ ...form, docType: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2">
              <option>FACTURA</option><option>NOTA_VENTA</option><option>LIQUIDACION</option><option>NOTA_DEBITO_REC</option><option>NOTA_CREDITO_REC</option>
            </select>
            <input type="date" required value={form.fechaEmision} onChange={(e) => setForm({ ...form, fechaEmision: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
            <input placeholder="Estab" value={form.estab} onChange={(e) => setForm({ ...form, estab: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
            <input placeholder="Pto Emi" value={form.ptoEmi} onChange={(e) => setForm({ ...form, ptoEmi: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
            <input required placeholder="Secuencial" value={form.secuencial} onChange={(e) => setForm({ ...form, secuencial: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
            <input placeholder="Autorización" value={form.autorizacion} onChange={(e) => setForm({ ...form, autorizacion: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
          </div>
          <table className="w-full text-sm">
            <thead className="bg-slate-100 text-xs"><tr>
              <th className="px-2 py-1">Descripción</th><th>Cant.</th><th>P.U.</th><th>Desc.</th><th>IVA%</th><th>Cuenta gasto</th><th></th>
            </tr></thead>
            <tbody>
              {form.items.map((it, i) => (
                <tr key={i}>
                  <td><input required value={it.description} onChange={(e) => setItem(i, { description: e.target.value })} className="w-full border border-slate-200 rounded px-2 py-1" /></td>
                  <td><input type="number" step="0.01" value={it.quantity} onChange={(e) => setItem(i, { quantity: +e.target.value })} className="w-16 border border-slate-200 rounded px-1 py-1 text-right" /></td>
                  <td><input type="number" step="0.01" value={it.unitPrice} onChange={(e) => setItem(i, { unitPrice: +e.target.value })} className="w-24 border border-slate-200 rounded px-1 py-1 text-right" /></td>
                  <td><input type="number" step="0.01" value={it.discount} onChange={(e) => setItem(i, { discount: +e.target.value })} className="w-20 border border-slate-200 rounded px-1 py-1 text-right" /></td>
                  <td><select value={it.ivaRate} onChange={(e) => setItem(i, { ivaRate: +e.target.value })} className="border border-slate-200 rounded px-1 py-1">
                    <option value={0}>0%</option><option value={12}>12%</option><option value={15}>15%</option><option value={-1}>No obj</option><option value={-2}>Exento</option>
                  </select></td>
                  <td><select required value={it.account} onChange={(e) => setItem(i, { account: e.target.value })} className="w-48 border border-slate-200 rounded px-1 py-1 text-xs">
                    <option value="">--</option>{accounts.map((a) => <option key={a._id} value={a._id}>{a.code} {a.name}</option>)}
                  </select></td>
                  <td><button type="button" onClick={() => setForm({ ...form, items: form.items.filter((_, x) => x !== i) })} className="text-rose-600"><HiOutlineXMark /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" onClick={() => setForm({ ...form, items: [...form.items, { ...EMPTY_ITEM }] })} className="text-emerald-600 text-sm flex items-center gap-1"><HiOutlinePlus /> Línea</button>

          <div className="bg-slate-50 p-3 rounded grid grid-cols-4 gap-3 text-sm">
            <div>Subt 0%: <b>{fmt(totals.s0)}</b></div>
            <div>Subt 12%: <b>{fmt(totals.s12)}</b></div>
            <div>Subt 15%: <b>{fmt(totals.s15)}</b></div>
            <div>No obj/Exe: <b>{fmt(totals.sNo + totals.sEx)}</b></div>
            <div>IVA: <b>{fmt(totals.iva)}</b></div>
            <div>Retenc: <b>{fmt(totals.retTotal)}</b></div>
            <div className="col-span-2 text-right">Total: <b className="text-lg">${fmt(totals.total)}</b> → Saldo: <b>${fmt(totals.balance)}</b></div>
          </div>

          <div className="border-t pt-2">
            <p className="text-sm font-semibold">Retenciones</p>
            {form.retentions.map((r, i) => (
              <div key={i} className="grid grid-cols-6 gap-2 mt-1 text-xs">
                <select value={r.type} onChange={(e) => { const rs = [...form.retentions]; rs[i].type = e.target.value; setForm({ ...form, retentions: rs }); }} className="border rounded px-2 py-1"><option>IVA</option><option>RENTA</option></select>
                <input placeholder="Código" value={r.code} onChange={(e) => { const rs = [...form.retentions]; rs[i].code = e.target.value; setForm({ ...form, retentions: rs }); }} className="border rounded px-2 py-1" />
                <input type="number" step="0.01" placeholder="Base" value={r.baseAmount} onChange={(e) => { const rs = [...form.retentions]; rs[i].baseAmount = +e.target.value; rs[i].amount = +(rs[i].baseAmount * (rs[i].percentage || 0) / 100).toFixed(2); setForm({ ...form, retentions: rs }); }} className="border rounded px-2 py-1" />
                <input type="number" step="0.01" placeholder="%" value={r.percentage} onChange={(e) => { const rs = [...form.retentions]; rs[i].percentage = +e.target.value; rs[i].amount = +(rs[i].baseAmount * rs[i].percentage / 100).toFixed(2); setForm({ ...form, retentions: rs }); }} className="border rounded px-2 py-1" />
                <input type="number" step="0.01" placeholder="Monto" value={r.amount} onChange={(e) => { const rs = [...form.retentions]; rs[i].amount = +e.target.value; setForm({ ...form, retentions: rs }); }} className="border rounded px-2 py-1" />
                <button type="button" onClick={() => setForm({ ...form, retentions: form.retentions.filter((_, x) => x !== i) })} className="text-rose-600">×</button>
              </div>
            ))}
            <button type="button" onClick={() => setForm({ ...form, retentions: [...form.retentions, { type: 'RENTA', code: '', baseAmount: 0, percentage: 0, amount: 0 }] })} className="text-emerald-600 text-xs mt-1">+ Retención</button>
            <input placeholder="Nro comprobante retención" value={form.retentionNumber} onChange={(e) => setForm({ ...form, retentionNumber: e.target.value })} className="block mt-1 w-full border border-slate-200 rounded-lg px-3 py-2" />
          </div>

          <div className="flex justify-end gap-2"><button type="button" onClick={() => setShow(false)} className="px-4 py-2 bg-slate-200 rounded-lg">Cancelar</button><button className="px-4 py-2 bg-emerald-600 text-white rounded-lg">Registrar</button></div>
        </form>
      </Modal>

      <Modal isOpen={showImport} onClose={() => setShowImport(false)} title="Importar facturas (TXT pipe)" size="lg">
        <p className="text-xs text-slate-500 mb-2">Formato por línea: RUC|RazonSocial|Tipo|Serie|Autorizacion|Fecha(DD/MM/YYYY)|Subtotal|IVA|Total</p>
        <div className="mb-2">
          <label className="block text-xs font-medium text-slate-600 mb-1">Cargar archivo .txt</label>
          <input
            type="file"
            accept=".txt,text/plain"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const reader = new FileReader();
              reader.onload = (ev) => setImportTxt(String(ev.target?.result || ''));
              reader.readAsText(f, 'utf-8');
            }}
            className="block w-full text-sm text-slate-600 file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border-0 file:bg-emerald-600 file:text-white file:cursor-pointer"
          />
        </div>
        <p className="text-xs text-slate-500 mb-1">O pega el contenido aquí:</p>
        <textarea value={importTxt} onChange={(e) => setImportTxt(e.target.value)} rows={10} className="w-full border border-slate-200 rounded-lg px-3 py-2 font-mono text-xs" />
        <div className="flex justify-end gap-2 mt-3"><button onClick={() => setShowImport(false)} className="px-4 py-2 bg-slate-200 rounded-lg">Cancelar</button><button onClick={submitImport} className="px-4 py-2 bg-emerald-600 text-white rounded-lg">Importar</button></div>
      </Modal>
    </div>
  );
}
