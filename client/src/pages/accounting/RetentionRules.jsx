import { useEffect, useMemo, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import Field from '../../components/Field';
import NumericInput from '../../components/NumericInput';
import SearchableSelect from '../../components/SearchableSelect';
import { HiOutlinePlus, HiOutlinePencilSquare, HiOutlineSparkles, HiOutlineExclamationTriangle } from 'react-icons/hi2';

const APPLIES = ['BIENES', 'SERVICIOS', 'TRANSPORTE', 'HONORARIOS', 'ARRENDAMIENTO', 'OTRO'];
const BASE_TYPES = [
  { v: 'SUBTOTAL_TOTAL', l: 'Subtotal (sin IVA)' },
  { v: 'SUBTOTAL_IVA', l: 'Subtotal gravado con IVA' },
  { v: 'SUBTOTAL_0', l: 'Subtotal 0%' },
  { v: 'IVA', l: 'Monto de IVA' },
];
const EMPTY = { type: 'RENTA', code: '', description: '', rate: 0, appliesTo: 'OTRO', baseType: 'SUBTOTAL_TOTAL', payableAccount: '', validFrom: '', validTo: '', active: true };

export default function RetentionRules() {
  const [list, setList] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [show, setShow] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [typeF, setTypeF] = useState('');
  const [stateF, setStateF] = useState('');
  const [q, setQ] = useState('');

  const load = async () => {
    try { const r = await api.get('/retention-rules'); setList(r.data || []); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  useEffect(() => {
    load();
    api.get('/chart-of-accounts').then((r) => setAccounts((r.data || []).filter((a) => a.allowsMovement))).catch(() => {});
  }, []);

  const filtered = useMemo(() => {
    const rx = q.trim().toLowerCase();
    return list.filter((r) => (!typeF || r.type === typeF)
      && (!stateF || (stateF === 'active' ? r.active : !r.active))
      && (!rx || `${r.code} ${r.description}`.toLowerCase().includes(rx)));
  }, [list, typeF, stateF, q]);

  const openNew = () => { setEditing(null); setForm(EMPTY); setShow(true); };
  const openEdit = (r) => {
    setEditing(r);
    setForm({
      ...EMPTY, ...r,
      payableAccount: r.payableAccount?._id || r.payableAccount || '',
      validFrom: r.validFrom ? String(r.validFrom).slice(0, 10) : '',
      validTo: r.validTo ? String(r.validTo).slice(0, 10) : '',
    });
    setShow(true);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!form.code.trim()) return toast.error('El código es obligatorio');
    if (!(form.rate >= 0 && form.rate <= 100)) return toast.error('El porcentaje debe estar entre 0 y 100');
    const payload = {
      ...form,
      payableAccount: form.payableAccount || null,
      validFrom: form.validFrom || null,
      validTo: form.validTo || null,
    };
    try {
      if (editing) await api.put(`/retention-rules/${editing._id}`, payload);
      else await api.post('/retention-rules', payload);
      toast.success('Guardado');
      setShow(false); setEditing(null); setForm(EMPTY); load();
    } catch (err) { toast.error(err.response?.data?.message || 'Error'); }
  };

  const toggle = async (r) => {
    try { await api.patch(`/retention-rules/${r._id}/toggle`, { active: !r.active }); load(); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  const seed = async () => {
    if (!confirm('Sembrar los códigos comunes de retención que falten. Es una BASE INICIAL: debes validar porcentajes y códigos vigentes según el SRI. ¿Continuar?')) return;
    try { const r = await api.post('/retention-rules/seed'); toast.success(r.data?.message || 'Catálogo actualizado'); load(); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  const accLabel = (a) => `${a.code} ${a.name}`;
  const accountOf = (r) => (typeof r.payableAccount === 'object' && r.payableAccount) ? r.payableAccount : accounts.find((a) => String(a._id) === String(r.payableAccount));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 tracking-tight">Retenciones — Catálogo</h1>
          <p className="text-sm text-slate-500">Códigos de retención (SRI) que se aplican por línea en compras.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={seed} className="px-3 py-2 bg-white border border-emerald-200 text-emerald-700 rounded-xl flex items-center gap-2 hover:bg-emerald-50"><HiOutlineSparkles /> Sembrar códigos comunes</button>
          <button onClick={openNew} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center gap-2"><HiOutlinePlus /> Nueva regla</button>
        </div>
      </div>

      <div className="flex items-start gap-2 text-xs bg-amber-50 border border-amber-200 text-amber-800 rounded-xl px-3 py-2">
        <HiOutlineExclamationTriangle className="w-4 h-4 mt-0.5 shrink-0" />
        <span>Los códigos sembrados son una <b>base inicial</b>. El contador debe validar porcentajes y códigos vigentes según el SRI antes de usarlos.</span>
      </div>

      <div className="flex flex-wrap gap-2">
        <select value={typeF} onChange={(e) => setTypeF(e.target.value)} className="border border-slate-200 rounded-xl px-3 py-2 text-sm"><option value="">Todos los tipos</option><option value="RENTA">Renta</option><option value="IVA">IVA</option></select>
        <select value={stateF} onChange={(e) => setStateF(e.target.value)} className="border border-slate-200 rounded-xl px-3 py-2 text-sm"><option value="">Activas e inactivas</option><option value="active">Solo activas</option><option value="inactive">Solo inactivas</option></select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar código o descripción…" className="border border-slate-200 rounded-xl px-3 py-2 text-sm flex-1 min-w-[180px]" />
      </div>

      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 overflow-x-auto">
        <table className="tbl w-full">
          <thead className="bg-emerald-50 text-xs uppercase"><tr>
            <th className="px-3 py-2 text-left">Tipo</th><th className="px-3 py-2 text-left">Código</th><th className="px-3 py-2 text-left">Descripción</th>
            <th className="px-3 py-2 text-right">%</th><th className="px-3 py-2 text-left">Base</th><th className="px-3 py-2 text-left">Aplica a</th>
            <th className="px-3 py-2 text-left">Cuenta por pagar</th><th className="px-3 py-2 text-left">Vigencia</th><th className="px-3 py-2 text-center">Estado</th><th className="px-3 py-2"></th>
          </tr></thead>
          <tbody>
            {filtered.length === 0 && <tr><td colSpan={10} className="px-3 py-6 text-center text-slate-400">Sin reglas. Usa “Sembrar códigos comunes” o “Nueva regla”.</td></tr>}
            {filtered.map((r) => {
              const acc = accountOf(r);
              const accMissing = !r.payableAccount;
              const accBad = acc && acc.allowsMovement === false;
              return (
                <tr key={r._id} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2"><span className={`text-[11px] rounded-full px-2 py-0.5 border ${r.type === 'IVA' ? 'bg-sky-50 border-sky-200 text-sky-700' : 'bg-amber-50 border-amber-200 text-amber-700'}`}>{r.type}</span></td>
                  <td className="px-3 py-2 font-mono">{r.code}</td>
                  <td className="px-3 py-2 text-slate-600">{r.description || '—'}</td>
                  <td className="px-3 py-2 text-right font-mono">{r.rate}%</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{r.baseType}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{r.appliesTo}</td>
                  <td className="px-3 py-2 text-xs">
                    {acc ? <span className="font-mono text-slate-600">{acc.code} {acc.name}</span> : <span className="text-slate-400">Por rol (según tipo)</span>}
                    {accMissing && <span className="ml-1 text-amber-600" title="Sin cuenta: se usa la cuenta de retención por rol"><HiOutlineExclamationTriangle className="w-3.5 h-3.5 inline" /></span>}
                    {accBad && <span className="ml-1 text-rose-600" title="La cuenta no permite movimiento"><HiOutlineExclamationTriangle className="w-3.5 h-3.5 inline" /></span>}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500">{r.validFrom ? String(r.validFrom).slice(0, 10) : '—'} → {r.validTo ? String(r.validTo).slice(0, 10) : '∞'}</td>
                  <td className="px-3 py-2 text-center">
                    <button onClick={() => toggle(r)} className={`text-[11px] rounded-full px-2 py-0.5 border ${r.active ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-slate-100 border-slate-200 text-slate-500'}`}>{r.active ? 'Activa' : 'Inactiva'}</button>
                  </td>
                  <td className="px-3 py-2 text-right"><button onClick={() => openEdit(r)} className="p-1.5 text-blue-600"><HiOutlinePencilSquare className="w-4 h-4" /></button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Modal isOpen={show} onClose={() => setShow(false)} title={editing ? `Editar retención ${editing.code}` : 'Nueva regla de retención'}>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Tipo" required><select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5"><option value="RENTA">Renta</option><option value="IVA">IVA</option></select></Field>
            <Field label="Código" required><input required value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="Ej: 312" className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
          </div>
          <Field label="Descripción"><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Ej: Compra de bienes muebles" className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Porcentaje (%)" required><NumericInput step="0.01" value={form.rate} onChange={(e) => setForm({ ...form, rate: +e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-right" /></Field>
            <Field label="Aplica a"><select value={form.appliesTo} onChange={(e) => setForm({ ...form, appliesTo: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5">{APPLIES.map((a) => <option key={a} value={a}>{a}</option>)}</select></Field>
          </div>
          <Field label="Tipo de base"><select value={form.baseType} onChange={(e) => setForm({ ...form, baseType: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5">{BASE_TYPES.map((b) => <option key={b.v} value={b.v}>{b.l}</option>)}</select></Field>
          <Field label="Cuenta de retención por pagar">
            <SearchableSelect options={accounts} value={form.payableAccount} onChange={(v) => setForm({ ...form, payableAccount: v })} getLabel={accLabel} getSearchText={accLabel} placeholder="— usar cuenta por rol (según tipo) —" searchPlaceholder="Buscar cuenta…" allowClear size="sm" />
            {!form.payableAccount && <p className="text-[11px] text-amber-600 mt-1">Sin cuenta: se usará la cuenta de retención por pagar estándar según el tipo (IVA/Renta).</p>}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Vigente desde"><input type="date" value={form.validFrom} onChange={(e) => setForm({ ...form, validFrom: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
            <Field label="Vigente hasta"><input type="date" value={form.validTo} onChange={(e) => setForm({ ...form, validTo: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Activa</label>
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setShow(false)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button><button className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20">Guardar</button></div>
        </form>
      </Modal>
    </div>
  );
}
