import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import Field from '../../components/Field';
import { HiOutlinePlus, HiOutlineClipboardDocumentCheck, HiOutlineCheck } from 'react-icons/hi2';
import { fmt, fmtDate } from './_utils';

export default function PhysicalCounts() {
  const [list, setList] = useState([]);
  const [show, setShow] = useState(false);
  const [warehouses, setWarehouses] = useState([]);
  const [selected, setSelected] = useState(null);
  const [form, setForm] = useState({ warehouse: '', description: '' });

  const load = async () => {
    try { const r = await api.get('/inventory-advanced/counts'); setList(r.data || []); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  useEffect(() => {
    api.get('/inventory-advanced/warehouses').then((r) => setWarehouses(r.data || []));
    load();
  }, []);

  const start = async (e) => {
    e.preventDefault();
    try { const r = await api.post('/inventory-advanced/counts', form); toast.success('Toma iniciada'); setShow(false); setSelected(r.data); load(); }
    catch (err) { toast.error(err.response?.data?.message || 'Error'); }
  };

  const setCounted = (idx, qty) => {
    const items = [...selected.items];
    items[idx].countedQty = +qty;
    items[idx].difference = (items[idx].countedQty || 0) - (items[idx].systemQty || 0);
    items[idx].adjustmentValue = items[idx].difference * (items[idx].unitCost || 0);
    setSelected({ ...selected, items });
  };
  const saveDraft = async () => {
    try { await api.put(`/inventory-advanced/counts/${selected._id}`, { items: selected.items }); toast.success('Guardado'); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  const confirm = async () => {
    if (!window.confirm('¿Confirmar y ajustar stock?')) return;
    try {
      await api.put(`/inventory-advanced/counts/${selected._id}`, { items: selected.items });
      const r = await api.post(`/inventory-advanced/counts/${selected._id}/confirm`);
      toast.success('Confirmada y stock ajustado'); setSelected(r.data); load();
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineClipboardDocumentCheck className="text-emerald-600" /> Tomas Físicas</h1>
        <button onClick={() => setShow(true)} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center gap-2"><HiOutlinePlus /> Nueva toma</button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden">
          <table className="tbl">
            <thead className="bg-emerald-50 text-xs uppercase"><tr><th className="px-2 py-2 text-left">Código</th><th className="px-2 py-2 text-left">Fecha</th><th className="px-2 py-2 text-center">Estado</th></tr></thead>
            <tbody>
              {list.map((c) => (
                <tr key={c._id} className="border-t cursor-pointer hover:bg-slate-50" onClick={() => setSelected(c)}>
                  <td className="px-2 py-2 font-mono text-xs">{c.code}</td>
                  <td className="px-2 py-2">{fmtDate(c.date)}</td>
                  <td className="px-2 py-2 text-center text-xs">{c.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {selected && (
          <div className="md:col-span-2 bg-white rounded-xl p-4 shadow-sm">
            <div className="flex justify-between items-center mb-3">
              <h2 className="font-semibold">{selected.code} — {selected.status}</h2>
              {selected.status === 'BORRADOR' && (
                <div className="flex gap-2">
                  <button onClick={saveDraft} className="px-3 py-1.5 bg-slate-600 text-white rounded text-sm">Guardar</button>
                  <button onClick={confirm} className="px-3 py-1.5 bg-emerald-600 text-white rounded text-sm flex items-center gap-1"><HiOutlineCheck /> Confirmar</button>
                </div>
              )}
            </div>
            <table className="tbl">
              <thead className="bg-slate-100 text-xs"><tr>
                <th className="px-2 py-1 text-left">Cód.</th><th className="px-2 py-1 text-left">Producto</th>
                <th className="px-2 py-1 text-right">Sistema</th><th className="px-2 py-1 text-right">Contado</th>
                <th className="px-2 py-1 text-right">Dif.</th><th className="px-2 py-1 text-right">Costo</th>
              </tr></thead>
              <tbody>
                {selected.items.map((it, i) => (
                  <tr key={i} className="border-t">
                    <td className="px-2 py-1 font-mono text-xs">{it.productCode}</td>
                    <td className="px-2 py-1">{it.productName}</td>
                    <td className="px-2 py-1 text-right font-mono">{it.systemQty}</td>
                    <td className="px-2 py-1 text-right"><input type="number" disabled={selected.status !== 'BORRADOR'} value={it.countedQty} onChange={(e) => setCounted(i, e.target.value)} className="w-20 border border-slate-200 rounded px-1 py-0.5 text-right" /></td>
                    <td className={`px-2 py-1 text-right font-mono ${it.difference > 0 ? 'text-emerald-700' : it.difference < 0 ? 'text-rose-600' : ''}`}>{it.difference}</td>
                    <td className="px-2 py-1 text-right font-mono">{fmt(it.unitCost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <Modal isOpen={show} onClose={() => setShow(false)} title="Nueva toma física">
        <form onSubmit={start} className="space-y-3">
          <Field label="Bodega (opcional)">
            <select value={form.warehouse} onChange={(e) => setForm({ ...form, warehouse: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5">
              <option value="">Todas las bodegas</option>{warehouses.map((w) => <option key={w._id} value={w._id}>{w.name}</option>)}
            </select>
          </Field>
          <Field label="Descripción"><input placeholder="Ej: Conteo mensual diciembre" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setShow(false)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button><button className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20">Iniciar</button></div>
        </form>
      </Modal>
    </div>
  );
}
