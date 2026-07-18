import { useEffect, useState, useMemo } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import { HiOutlinePlus, HiOutlineCreditCard, HiOutlineCheckCircle, HiOutlineEye, HiOutlinePencilSquare, HiOutlineTrash, HiOutlineXCircle, HiOutlineMagnifyingGlass } from 'react-icons/hi2';
import { fmt, fmtDate, today } from './_utils';
import NumericInput from '../../components/NumericInput';
import SearchableSelect from '../../components/SearchableSelect';
import AccountSelect from '../../components/AccountSelect';

// Las retenciones se derivan de las bases digitadas en las transacciones: una fila RENTA (si hay
// base ret IR) y/o una fila IVA (si hay base ret IVA). El código SRI se escoge del catálogo de
// reglas de la clínica y el % viene de la regla (nunca se digita). Ver recomputeSettlement.
const RET_TYPES = ['RENTA', 'IVA'];
const RET_LABEL = { RENTA: 'Retención en la fuente (renta)', IVA: 'Retención de IVA' };

const EMPTY_TXN = { date: today(), recap: '', account: '', costCenter: '', deposit: 0, commission: 0, iva: 0, baseRetIr: 0, baseRetIva: 0 };
const EMPTY_RET_META = () => ({ RENTA: emptyMeta(), IVA: emptyMeta() });
const emptyMeta = () => ({ issueDate: today(), retentionNumber: '', authorization: '', sriCode: '', percentage: 0 });
const EMPTY = {
  issueDate: today(), docType: 'LIQUIDACION', supplier: '', bankAccount: '', docNumber: '', commissionToSettle: 0,
  receivableAccount: '', commissionAccount: '', ivaAccount: '', retIvaAccount: '', retIrAccount: '',
  transactions: [{ ...EMPTY_TXN }], sourceSales: [], notes: '',
};
const EMPTY_PICKER = { lote: '', from: today(), to: today(), includeSettled: false };

const round = (n) => +(Number(n) || 0).toFixed(2);

export default function CardSettlements() {
  const [list, setList] = useState([]);
  const [banks, setBanks] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [costCenters, setCostCenters] = useState([]);
  const [rules, setRules] = useState([]);        // catálogo de reglas de retención (activas)
  const [show, setShow] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [retMeta, setRetMeta] = useState(EMPTY_RET_META()); // datos que sí digita el usuario por tipo
  const [viewItem, setViewItem] = useState(null);
  // Cargador de facturas por lote/fecha
  const [picker, setPicker] = useState(EMPTY_PICKER);
  const [pickerResults, setPickerResults] = useState([]);
  const [picked, setPicked] = useState({});
  const [searching, setSearching] = useState(false);

  const load = async () => {
    try { const r = await api.get('/card-settlements'); setList(r.data || []); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  useEffect(() => {
    api.get('/banks/accounts').then((r) => setBanks(r.data || [])).catch(() => {});
    api.get('/suppliers').then((r) => setSuppliers((r.data || []).filter((s) => (s.roles || []).includes('PROVEEDOR')))).catch(() => {});
    api.get('/chart-of-accounts').then((r) => setAccounts(r.data || [])).catch(() => {});
    api.get('/cost-centers').then((r) => setCostCenters(r.data || [])).catch(() => {});
    api.get('/retention-rules', { params: { active: 'true' } }).then((r) => setRules(r.data || [])).catch(() => {});
    load();
  }, []);

  // Reglas por tipo (para el dropdown) e indexadas por código (para resolver el %).
  const rulesByType = useMemo(() => ({
    RENTA: rules.filter((r) => r.type === 'RENTA'),
    IVA: rules.filter((r) => r.type === 'IVA'),
  }), [rules]);
  const ruleByKey = useMemo(() => {
    const m = {};
    rules.forEach((r) => { m[`${r.type}|${r.code}`] = r; });
    return m;
  }, [rules]);

  // Bases sumadas de TODAS las transacciones, por tipo (fuente única de la base de cada retención).
  const baseByType = useMemo(() => {
    const b = { RENTA: 0, IVA: 0 };
    (form.transactions || []).forEach((t) => { b.RENTA += +t.baseRetIr || 0; b.IVA += +t.baseRetIva || 0; });
    return { RENTA: round(b.RENTA), IVA: round(b.IVA) };
  }, [form.transactions]);

  // Filas de retención DERIVADAS: existe una fila por tipo solo si su base > 0. El % viene de la
  // regla del código elegido (si no, cae al snapshot previo); el valor = base × % / 100.
  const retentionRows = useMemo(() => RET_TYPES
    .filter((type) => baseByType[type] > 0)
    .map((type) => {
      const meta = retMeta[type] || emptyMeta();
      const rule = meta.sriCode ? ruleByKey[`${type}|${meta.sriCode}`] : null;
      const percentage = rule ? Number(rule.rate) || 0 : (+meta.percentage || 0);
      const base = baseByType[type];
      return {
        type, base,
        issueDate: meta.issueDate, retentionNumber: meta.retentionNumber, authorization: meta.authorization,
        sriCode: meta.sriCode, percentage: round(percentage), value: round(base * percentage / 100),
      };
    }), [baseByType, retMeta, ruleByKey]);

  // Totales derivados (espejo del backend): a pagar = depósito - comisión - iva; neto resta ambas retenciones.
  const totals = useMemo(() => {
    let deposit = 0, commission = 0, iva = 0, toPay = 0;
    (form.transactions || []).forEach((t) => {
      const d = +t.deposit || 0, c = +t.commission || 0, i = +t.iva || 0;
      deposit += d; commission += c; iva += i; toPay += round(d - c - i);
    });
    const retIr = retentionRows.filter((r) => r.type === 'RENTA').reduce((s, r) => s + r.value, 0);
    const retIva = retentionRows.filter((r) => r.type === 'IVA').reduce((s, r) => s + r.value, 0);
    return { deposit: round(deposit), commission: round(commission), iva: round(iva), retIva: round(retIva), retIr: round(retIr), toPay: round(toPay), net: round(toPay - retIr - retIva) };
  }, [form.transactions, retentionRows]);

  const setRetMetaField = (type, patch) => setRetMeta((m) => ({ ...m, [type]: { ...m[type], ...patch } }));

  const resetPicker = () => { setPicker(EMPTY_PICKER); setPickerResults([]); setPicked({}); };
  const openNew = () => { setEditId(null); setForm(EMPTY); setRetMeta(EMPTY_RET_META()); resetPicker(); setShow(true); };
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
        sourceSales: d.sourceSales || [],
      });
      // Los datos que digita el usuario (fecha/número/autorización/código) se rehidratan por tipo;
      // la base, el % y el valor se vuelven a derivar solos.
      const rm = EMPTY_RET_META();
      (d.retentions || []).forEach((r2) => {
        if (!rm[r2.type]) return;
        rm[r2.type] = {
          issueDate: r2.issueDate ? r2.issueDate.slice(0, 10) : today(),
          retentionNumber: r2.retentionNumber || '', authorization: r2.authorization || '',
          sriCode: r2.sriCode || '', percentage: +r2.percentage || 0,
        };
      });
      setRetMeta(rm);
      resetPicker();
      setEditId(id); setShow(true);
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  // Buscar ventas con tarjeta por lote/fecha para cargarlas en la liquidación
  const searchSales = async () => {
    if (!picker.lote.trim() && !picker.from && !picker.to) return toast.error('Ingresa el N° de lote o un rango de fechas');
    setSearching(true);
    try {
      const params = {};
      if (picker.lote.trim()) params.lote = picker.lote.trim();
      if (picker.from) params.from = picker.from;
      if (picker.to) params.to = picker.to;
      if (picker.includeSettled) params.includeSettled = true;
      const r = await api.get('/card-settlements/card-sales', { params });
      const already = new Set((form.sourceSales || []).map((x) => String(x.sale)));
      const results = (r.data || []).filter((s) => !already.has(String(s._id)));
      setPickerResults(results);
      const pick = {}; results.forEach((s) => { pick[s._id] = true; });
      setPicked(pick);
      if (!results.length) toast('Sin facturas con tarjeta para esos filtros', { icon: 'ℹ️' });
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
    finally { setSearching(false); }
  };

  const pickedList = pickerResults.filter((s) => picked[s._id]);
  const pickedTotal = round(pickedList.reduce((a, s) => a + (+s.total || 0), 0));
  const allPicked = pickerResults.length > 0 && pickedList.length === pickerResults.length;
  const toggleAll = () => { const v = !allPicked; const p = {}; pickerResults.forEach((s) => { p[s._id] = v; }); setPicked(p); };

  const addPicked = () => {
    if (!pickedList.length) return toast.error('Selecciona al menos una factura');
    const newSources = pickedList.map((s) => ({
      sale: s._id, saleNumber: s.saleNumber, date: s.createdAt,
      lote: s.cardLote || '', voucher: s.cardVoucher || '', amount: round(+s.total || 0),
    }));
    const txn = { ...EMPTY_TXN, date: picker.to || picker.from || today(), recap: picker.lote || '', deposit: pickedTotal };
    setForm((f) => {
      // Descarta la fila vacía inicial (sin depósito ni #recap)
      const base = (f.transactions || []).filter((t) => (+t.deposit || 0) !== 0 || (t.recap || '').trim());
      return { ...f, sourceSales: [...(f.sourceSales || []), ...newSources], transactions: [...base, txn] };
    });
    setPickerResults((rs) => rs.filter((s) => !picked[s._id]));
    setPicked({});
    toast.success(`${newSources.length} factura(s) cargada(s) · $${fmt(pickedTotal)}`);
  };

  const clearSources = () => setForm((f) => ({ ...f, sourceSales: [] }));
  const sourcesTotal = round((form.sourceSales || []).reduce((a, x) => a + (+x.amount || 0), 0));

  const setTxn = (i, patch) => { const a = [...form.transactions]; a[i] = { ...a[i], ...patch }; setForm({ ...form, transactions: a }); };
  const addTxn = () => setForm({ ...form, transactions: [...form.transactions, { ...EMPTY_TXN }] });
  const delTxn = (i) => setForm({ ...form, transactions: form.transactions.filter((_, x) => x !== i) });

  const submit = async (e) => {
    e.preventDefault();
    if (!form.transactions.length) return toast.error('Agrega al menos una transacción');
    // Misma validación que el backend: ninguna retención sin código SRI (fuente de error humano).
    const sinCodigo = retentionRows.find((r) => !String(r.sriCode || '').trim());
    if (sinCodigo) return toast.error(`Escoge el código SRI de la ${RET_LABEL[sinCodigo.type].toLowerCase()} (base $${fmt(sinCodigo.base)}).`);
    try {
      const payload = { ...form, retentions: retentionRows };
      ['receivableAccount', 'commissionAccount', 'ivaAccount', 'retIvaAccount', 'retIrAccount', 'supplier', 'bankAccount'].forEach((k) => { if (!payload[k]) payload[k] = null; });
      payload.transactions = payload.transactions.map((t) => ({ ...t, account: t.account || null, costCenter: t.costCenter || null }));
      if (editId) { await api.put(`/card-settlements/${editId}`, payload); toast.success('Liquidación actualizada'); }
      else { await api.post('/card-settlements', payload); toast.success('Liquidación creada'); }
      setShow(false); setForm(EMPTY); setRetMeta(EMPTY_RET_META()); setEditId(null); load();
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineCreditCard className="text-emerald-600" /> Liquidaciones de Tarjetas de Crédito</h1>
        <button onClick={openNew} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center gap-2"><HiOutlinePlus /> Nueva liquidación</button>
      </div>

      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-x-auto">
        <table className="tbl">
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
                <td className="px-3 py-2 text-right font-mono font-semibold text-emerald-700">${fmt(s.totalDeposit - s.totalCommission - s.totalIva - s.totalRetIr - s.totalRetIva)}</td>
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
              <input type="date" required value={form.issueDate} onChange={(e) => setForm({ ...form, issueDate: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" />
            </label>
            <label className="text-xs text-slate-500">Tipo de documento
              <select value={form.docType} onChange={(e) => setForm({ ...form, docType: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm">
                <option value="LIQUIDACION">Liquidación</option><option value="FACTURA">Factura</option><option value="NOTA_CREDITO">Nota de crédito</option><option value="OTRO">Otro</option>
              </select>
            </label>
            <label className="text-xs text-slate-500">Proveedor (adquirente)
              <div className="mt-1">
                <SearchableSelect
                  options={suppliers}
                  value={form.supplier}
                  onChange={(v) => setForm({ ...form, supplier: v })}
                  getLabel={(s) => s.razonSocial || s.nombreComercial || s.ruc}
                  getSearchText={(s) => `${s.ruc || ''} ${s.razonSocial || ''} ${s.nombreComercial || ''}`}
                  placeholder="Selecciona..."
                  searchPlaceholder="Buscar por RUC o nombre…"
                  allowClear
                />
              </div>
            </label>
            <label className="text-xs text-slate-500">Banco (acreditación)
              <select value={form.bankAccount} onChange={(e) => setForm({ ...form, bankAccount: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm">
                <option value="">Selecciona...</option>{banks.map((b) => <option key={b._id} value={b._id}>{b.name}</option>)}
              </select>
            </label>
            <label className="text-xs text-slate-500">Número de documento
              <input value={form.docNumber} onChange={(e) => setForm({ ...form, docNumber: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" />
            </label>
            <label className="text-xs text-slate-500">Comisión por liquidar ($)
              <NumericInput step="0.01" value={form.commissionToSettle} onChange={(e) => setForm({ ...form, commissionToSettle: +e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm text-right" />
            </label>
          </div>

          {/* Cargar facturas por lote / fecha */}
          <div className="border border-emerald-200 bg-emerald-50/40 rounded-lg p-3 space-y-3">
            <div className="flex items-center gap-2">
              <HiOutlineMagnifyingGlass className="text-emerald-600" />
              <p className="font-semibold text-sm text-slate-700">Cargar facturas por lote</p>
              <span className="text-xs text-slate-500">Digita el lote y/o la fecha; selecciona las facturas y se cargan como depósito.</span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2 items-end">
              <label className="text-xs text-slate-500">N° de lote
                <input value={picker.lote} onChange={(e) => setPicker({ ...picker, lote: e.target.value })} placeholder="Ej. 0457" className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm" />
              </label>
              <label className="text-xs text-slate-500">Desde
                <input type="date" value={picker.from} onChange={(e) => setPicker({ ...picker, from: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm" />
              </label>
              <label className="text-xs text-slate-500">Hasta
                <input type="date" value={picker.to} onChange={(e) => setPicker({ ...picker, to: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm" />
              </label>
              <label className="text-xs text-slate-500 flex items-center gap-1.5 pb-2">
                <input type="checkbox" checked={picker.includeSettled} onChange={(e) => setPicker({ ...picker, includeSettled: e.target.checked })} className="rounded" />
                Incluir ya liquidadas
              </label>
              <button type="button" onClick={searchSales} disabled={searching} className="px-3 py-2 bg-emerald-600 text-white rounded-xl text-sm flex items-center justify-center gap-1.5 disabled:opacity-50">
                <HiOutlineMagnifyingGlass /> {searching ? 'Buscando…' : 'Buscar'}
              </button>
            </div>

            {pickerResults.length > 0 && (
              <div className="bg-white rounded-lg border overflow-x-auto">
                <table className="tbl text-xs min-w-[760px]">
                  <thead className="bg-slate-50 text-slate-500">
                    <tr>
                      <th className="px-2 py-1.5 text-center"><input type="checkbox" checked={allPicked} onChange={toggleAll} /></th>
                      <th className="px-2 py-1.5 text-left">Venta</th><th className="px-2 py-1.5 text-left">Fecha</th>
                      <th className="px-2 py-1.5 text-left">Cliente</th><th className="px-2 py-1.5 text-left">Tarjeta</th>
                      <th className="px-2 py-1.5 text-left">Lote</th><th className="px-2 py-1.5 text-left">Voucher</th>
                      <th className="px-2 py-1.5 text-right">Monto</th>
                    </tr>
                  </thead>
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
                  <span className="text-xs text-slate-600">{pickedList.length} de {pickerResults.length} seleccionadas · <b className="font-mono">${fmt(pickedTotal)}</b></span>
                  <button type="button" onClick={addPicked} className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs flex items-center gap-1.5"><HiOutlinePlus /> Agregar seleccionadas</button>
                </div>
              </div>
            )}

            {!!(form.sourceSales || []).length && (
              <div className="flex items-center justify-between text-xs bg-white border rounded-lg px-3 py-2">
                <span className="text-slate-600"><b>{form.sourceSales.length}</b> factura(s) vinculada(s) a esta liquidación · <b className="font-mono">${fmt(sourcesTotal)}</b></span>
                <button type="button" onClick={clearSources} className="text-rose-600 hover:underline">Quitar vínculo</button>
              </div>
            )}
          </div>

          {/* Cuentas contables seleccionables */}
          <details className="border rounded-lg p-3">
            <summary className="cursor-pointer text-sm font-semibold text-slate-700">Cuentas contables (opcional — si se dejan vacías se usan las predeterminadas)</summary>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-3">
              {[['receivableAccount', 'Tarjetas por cobrar'], ['commissionAccount', 'Gasto comisión'], ['ivaAccount', 'IVA en compras'], ['retIvaAccount', 'Retención IVA por cobrar'], ['retIrAccount', 'Retención IR por cobrar']].map(([key, label]) => (
                <label key={key} className="text-xs text-slate-500 block">{label}
                  <div className="mt-1"><AccountSelect accounts={accounts} value={form[key] || ''} onChange={(v) => setForm({ ...form, [key]: v })} emptyOption="Predeterminada" size="sm" /></div>
                </label>
              ))}
            </div>
          </details>

          {/* Transacciones */}
          <div className="border rounded-lg p-3">
            <div className="flex justify-between items-center mb-2"><p className="font-semibold text-sm">Transacciones</p><button type="button" onClick={addTxn} className="text-emerald-600 text-sm flex items-center gap-1"><HiOutlinePlus /> Transacción</button></div>
            <div className="overflow-x-auto">
              <table className="tbl text-xs min-w-[900px]">
                <thead><tr className="text-slate-500 text-left">
                  <th className="px-1 py-1">Fecha</th><th className="px-1 py-1">#Recap</th><th className="px-1 py-1">Cuenta</th><th className="px-1 py-1">Centro de costo</th>
                  <th className="px-1 py-1 text-right">Depósito</th><th className="px-1 py-1 text-right">Comisión</th><th className="px-1 py-1 text-right">IVA</th>
                  <th className="px-1 py-1 text-right">Base retención renta</th><th className="px-1 py-1 text-right">Base retención IVA</th>
                  <th className="px-1 py-1 text-right">A pagar</th><th></th>
                </tr></thead>
                <tbody>
                  {form.transactions.map((t, i) => {
                    const toPay = round((+t.deposit || 0) - (+t.commission || 0) - (+t.iva || 0));
                    return (
                      <tr key={i}>
                        <td className="px-0.5 py-0.5"><input type="date" value={t.date} onChange={(e) => setTxn(i, { date: e.target.value })} className="border border-slate-200 rounded px-1 py-1 w-32" /></td>
                        <td className="px-0.5 py-0.5"><input value={t.recap} onChange={(e) => setTxn(i, { recap: e.target.value })} className="border border-slate-200 rounded px-1 py-1 w-20" /></td>
                        <td className="px-0.5 py-0.5 min-w-[160px]"><AccountSelect accounts={accounts} value={t.account || ''} onChange={(v) => setTxn(i, { account: v })} placeholder="—" allowClear size="sm" /></td>
                        <td className="px-0.5 py-0.5"><select value={t.costCenter || ''} onChange={(e) => setTxn(i, { costCenter: e.target.value })} className="border border-slate-200 rounded px-1 py-1 w-36"><option value="">—</option>{costCenters.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}</select></td>
                        <td className="px-0.5 py-0.5"><NumericInput step="0.01" value={t.deposit} onChange={(e) => setTxn(i, { deposit: +e.target.value })} className="border border-slate-200 rounded px-1 py-1 w-24 text-right" /></td>
                        <td className="px-0.5 py-0.5"><NumericInput step="0.01" value={t.commission} onChange={(e) => setTxn(i, { commission: +e.target.value })} className="border border-slate-200 rounded px-1 py-1 w-24 text-right" /></td>
                        <td className="px-0.5 py-0.5"><NumericInput step="0.01" value={t.iva} onChange={(e) => setTxn(i, { iva: +e.target.value })} className="border border-slate-200 rounded px-1 py-1 w-20 text-right" /></td>
                        <td className="px-0.5 py-0.5"><NumericInput step="0.01" value={t.baseRetIr} onChange={(e) => setTxn(i, { baseRetIr: +e.target.value })} className="border border-slate-200 rounded px-1 py-1 w-28 text-right" title="Base para la retención en la fuente (renta)" /></td>
                        <td className="px-0.5 py-0.5"><NumericInput step="0.01" value={t.baseRetIva} onChange={(e) => setTxn(i, { baseRetIva: +e.target.value })} className="border border-slate-200 rounded px-1 py-1 w-28 text-right" title="Base para la retención de IVA" /></td>
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
                  <td className="px-1 py-1 text-right font-mono">{fmt(baseByType.RENTA)}</td>
                  <td className="px-1 py-1 text-right font-mono">{fmt(baseByType.IVA)}</td>
                  <td className="px-1 py-1 text-right font-mono text-emerald-700">{fmt(totals.toPay)}</td><td></td>
                </tr></tfoot>
              </table>
            </div>
          </div>

          {/* Retenciones (se generan solas desde las bases de las transacciones) */}
          <div className="border rounded-lg p-3">
            <div className="flex items-center gap-2 mb-2">
              <p className="font-semibold text-sm">Retenciones</p>
              <span className="text-xs text-slate-500">Se crean solas al ingresar bases en las transacciones. Solo escoge el código SRI; el % y el valor se calculan solos.</span>
            </div>
            {retentionRows.length === 0 ? (
              <p className="text-xs text-slate-400 py-2">Sin retenciones: ingresa una base de retención (renta o IVA) en alguna transacción y la fila aparecerá aquí.</p>
            ) : (
              <>
                <div className="hidden md:grid grid-cols-12 gap-1.5 mb-1 text-[10px] text-slate-400 uppercase px-1">
                  <span className="col-span-2">Tipo</span><span className="col-span-2">Fecha emisión</span><span className="col-span-2">N° retención</span><span className="col-span-2">Autorización</span>
                  <span className="col-span-2">Código SRI</span><span className="text-right">Base</span><span className="text-right">%</span>
                </div>
                {retentionRows.map((r) => {
                  const faltaCodigo = !String(r.sriCode || '').trim();
                  return (
                    <div key={r.type} className="grid grid-cols-2 md:grid-cols-12 gap-1.5 mb-2 md:mb-1 items-center border-b md:border-0 pb-2 md:pb-0">
                      <span className="md:col-span-2 text-xs font-semibold text-slate-700">{RET_LABEL[r.type]}</span>
                      <input type="date" value={r.issueDate || ''} onChange={(e) => setRetMetaField(r.type, { issueDate: e.target.value })} className="md:col-span-2 border border-slate-200 rounded px-1 py-1 text-xs" title="Fecha emisión" />
                      <input placeholder="N° retención" value={r.retentionNumber} onChange={(e) => setRetMetaField(r.type, { retentionNumber: e.target.value })} className="md:col-span-2 border border-slate-200 rounded px-1 py-1 text-xs" />
                      <input placeholder="Autorización" value={r.authorization} onChange={(e) => setRetMetaField(r.type, { authorization: e.target.value })} className="md:col-span-2 border border-slate-200 rounded px-1 py-1 text-xs" />
                      <div className={`md:col-span-2 ${faltaCodigo ? 'rounded ring-1 ring-rose-300' : ''}`}>
                        <SearchableSelect
                          options={rulesByType[r.type] || []}
                          value={r.sriCode}
                          onChange={(v) => setRetMetaField(r.type, { sriCode: v })}
                          getValue={(o) => o.code}
                          getLabel={(o) => `${o.code} — ${o.description || ''} (${o.rate}%)`}
                          getSearchText={(o) => `${o.code} ${o.description || ''}`}
                          placeholder="Escoge el código…"
                          searchPlaceholder="Buscar código o descripción…"
                          size="sm"
                          menuMinWidth={320}
                          wrapOptions
                        />
                      </div>
                      <span className="text-right font-mono text-xs" title="Base = suma de las bases de las transacciones">{fmt(r.base)}</span>
                      <span className="text-right font-mono text-xs">{r.percentage ? `${r.percentage}%` : '—'}</span>
                      <span className="col-span-2 md:hidden text-right font-mono text-xs">Valor: ${fmt(r.value)}</span>
                    </div>
                  );
                })}
                <p className="text-[11px] text-slate-400 mt-1">La base es la suma de las bases de las transacciones (solo lectura). El porcentaje viene de la regla del código y el valor se calcula solo.</p>
              </>
            )}
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
            <button type="button" onClick={() => setShow(false)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button>
            <button className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20">{editId ? 'Guardar' : 'Crear liquidación'}</button>
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
              <table className="tbl text-xs">
                <thead className="bg-slate-50"><tr>
                  <th className="px-2 py-1 text-left">Fecha</th><th className="px-2 py-1 text-left">#Recap</th><th className="px-2 py-1 text-right">Depósito</th>
                  <th className="px-2 py-1 text-right">Comisión</th><th className="px-2 py-1 text-right">IVA</th>
                  <th className="px-2 py-1 text-right">Base ret. renta</th><th className="px-2 py-1 text-right">Base ret. IVA</th><th className="px-2 py-1 text-right">A pagar</th>
                </tr></thead>
                <tbody>
                  {(viewItem.transactions || []).map((t, i) => (
                    <tr key={i} className="border-t">
                      <td className="px-2 py-1">{fmtDate(t.date)}</td><td className="px-2 py-1">{t.recap}</td>
                      <td className="px-2 py-1 text-right font-mono">{fmt(t.deposit)}</td><td className="px-2 py-1 text-right font-mono">{fmt(t.commission)}</td>
                      <td className="px-2 py-1 text-right font-mono">{fmt(t.iva)}</td>
                      <td className="px-2 py-1 text-right font-mono">{fmt(t.baseRetIr)}</td><td className="px-2 py-1 text-right font-mono">{fmt(t.baseRetIva)}</td>
                      <td className="px-2 py-1 text-right font-mono font-semibold">{fmt(t.toPay)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!!(viewItem.retentions || []).length && (
              <div>
                <p className="font-semibold mb-1">Retenciones</p>
                <table className="tbl text-xs">
                  <thead className="bg-slate-50"><tr><th className="px-2 py-1 text-left">N°</th><th className="px-2 py-1 text-left">Tipo</th><th className="px-2 py-1 text-left">Cód SRI</th><th className="px-2 py-1 text-right">Base</th><th className="px-2 py-1 text-right">%</th><th className="px-2 py-1 text-right">Valor</th></tr></thead>
                  <tbody>{viewItem.retentions.map((r, i) => (<tr key={i} className="border-t"><td className="px-2 py-1">{r.retentionNumber}</td><td className="px-2 py-1">{r.type}</td><td className="px-2 py-1">{r.sriCode}</td><td className="px-2 py-1 text-right font-mono">{fmt(r.base)}</td><td className="px-2 py-1 text-right">{r.percentage}</td><td className="px-2 py-1 text-right font-mono">{fmt(r.value)}</td></tr>))}</tbody>
                </table>
              </div>
            )}
            {!!(viewItem.sourceSales || []).length && (
              <div>
                <p className="font-semibold mb-1">Facturas vinculadas ({viewItem.sourceSales.length})</p>
                <table className="tbl text-xs">
                  <thead className="bg-slate-50"><tr><th className="px-2 py-1 text-left">Venta</th><th className="px-2 py-1 text-left">Fecha</th><th className="px-2 py-1 text-left">Lote</th><th className="px-2 py-1 text-left">Voucher</th><th className="px-2 py-1 text-right">Monto</th></tr></thead>
                  <tbody>{viewItem.sourceSales.map((x, i) => (<tr key={i} className="border-t"><td className="px-2 py-1 font-mono">{x.saleNumber}</td><td className="px-2 py-1">{fmtDate(x.date)}</td><td className="px-2 py-1 font-mono">{x.lote || '—'}</td><td className="px-2 py-1 font-mono">{x.voucher || '—'}</td><td className="px-2 py-1 text-right font-mono">{fmt(x.amount)}</td></tr>))}</tbody>
                </table>
              </div>
            )}
            <div className="flex flex-wrap justify-end gap-4 bg-slate-50 rounded-lg p-3">
              <span>Depósito: <b className="font-mono">${fmt(viewItem.totalDeposit)}</b></span>
              <span>Ret. IVA: <b className="font-mono">${fmt(viewItem.totalRetIva)}</b></span>
              <span>Ret. renta: <b className="font-mono">${fmt(viewItem.totalRetIr)}</b></span>
              <span>Neto a banco: <b className="font-mono text-emerald-700">${fmt(viewItem.totalDeposit - viewItem.totalCommission - viewItem.totalIva - viewItem.totalRetIr - viewItem.totalRetIva)}</b></span>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
