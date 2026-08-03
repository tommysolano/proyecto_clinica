import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import Field from '../../components/Field';
import { HiOutlinePlus, HiOutlineCurrencyDollar, HiOutlineXMark, HiOutlineEye, HiOutlineArrowTopRightOnSquare } from 'react-icons/hi2';
import { fmt, fmtDate, today } from './_utils';
import NumericInput from '../../components/NumericInput';
import useDocDeepLink from '../../hooks/useDocDeepLink';
import { newIdempotencyKey, withIdempotencyKey, intentKey } from '../../utils/idempotency';

export default function Payments() {
  const navigate = useNavigate();
  const [list, setList] = useState([]);
  const [type, setType] = useState('PAGO');
  const [show, setShow] = useState(false);
  const [detail, setDetail] = useState(null);
  const [suppliers, setSuppliers] = useState([]);
  const [banks, setBanks] = useState([]);
  const [purchases, setPurchases] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [form, setForm] = useState({ type: 'PAGO', date: today(), partyModel: 'Supplier', party: '', method: 'TRANSFERENCIA', bankAccount: '', applications: [], advanceAmount: 0, notes: '', voucherNumber: '', voucherUrl: '' });
  const [busy, setBusy] = useState(false);   // envío en curso: evita registrar el pago dos veces
  const [intent, setIntent] = useState('');  // clave base de idempotencia de la intención abierta

  // Pago masivo a proveedores
  const [showBulk, setShowBulk] = useState(false);
  const [bulkRows, setBulkRows] = useState([]); // { pi, checked, amount }
  const [bulkForm, setBulkForm] = useState({ date: today(), method: 'TRANSFERENCIA', bankAccount: '', voucherNumber: '', reference: '' });
  const [bulkSearch, setBulkSearch] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = async () => {
    try { const r = await api.get('/payments', { params: { type } }); setList(r.data?.items || r.data || []); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  useEffect(() => {
    api.get('/suppliers').then((r) => setSuppliers(r.data || []));
    api.get('/banks/accounts').then((r) => setBanks(r.data || []));
    load();
    // eslint-disable-next-line
  }, [type]);

  const openNew = (t) => {
    setForm({ type: t, date: today(), partyModel: t === 'PAGO' ? 'Supplier' : 'Patient', party: '', method: 'TRANSFERENCIA', bankAccount: '', applications: [], advanceAmount: 0, notes: '', voucherNumber: '', voucherUrl: '' });
    // Clave base de esta intención: un doble clic reintenta el MISMO pago (replay), no crea otro.
    setIntent(newIdempotencyKey());
    setShow(true);
  };

  // Detalle de un pago/cobro (para navegar desde el Libro Mayor con ?doc=<id>).
  const openDetail = async (id) => {
    try { const r = await api.get(`/payments/${id}`); setDetail(r.data); }
    catch (e) { toast.error(e.response?.data?.message || 'No se encontró el pago'); }
  };

  // Deep-link desde el Libro Mayor / asiento (?doc=<idPago>): abre el detalle del pago.
  useDocDeepLink((id) => openDetail(id));

  const loadDocs = async (partyId) => {
    if (form.type === 'PAGO') {
      const r = await api.get('/purchase-invoices', { params: { supplier: partyId, status: 'REGISTRADA' } });
      setPurchases(r.data || []);
    } else {
      const r = await api.get('/invoices', { params: { client: partyId } });
      setInvoices(r.data || []);
    }
  };

  const totalApplied = form.applications.reduce((s, a) => s + (+a.amount || 0), 0) + (+form.advanceAmount || 0);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      // La clave se deriva de la intención: estable mientras no cambie nada (reintento ⇒ replay),
      // distinta en cuanto cambie importe/banco/fecha/documentos (es otra operación).
      const huella = [
        form.type, form.method, form.bankAccount, form.date, form.party, form.advanceAmount,
        ...form.applications.map((a) => `${a.docModel}#${a.docRef}#${a.amount}`).sort(),
      ];
      await api.post('/payments', form, withIdempotencyKey(intentKey(intent, huella)));
      toast.success('Registrado');
      setShow(false); load();
    } catch (err) { toast.error(err.response?.data?.message || 'Error'); }
    finally { setBusy(false); }
  };

  const voidPay = async (p) => {
    if (!confirm('¿Anular?')) return;
    try { await api.post(`/payments/${p._id}/void`); load(); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  const openBulk = async () => {
    setBulkForm({ date: today(), method: 'TRANSFERENCIA', bankAccount: '', voucherNumber: '', reference: '' });
    setBulkSearch('');
    try {
      const r = await api.get('/purchase-invoices', { params: { status: 'REGISTRADA', limit: 500 } });
      const items = (r.data?.items || r.data || []).filter((p) => Number(p.balance ?? p.total ?? 0) > 0.005);
      setBulkRows(items.map((pi) => ({ pi, checked: false, amount: +Number(pi.balance ?? pi.total ?? 0).toFixed(2) })));
      setShowBulk(true);
    } catch (e) { toast.error(e.response?.data?.message || 'Error al cargar compras'); }
  };

  const bulkSelected = bulkRows.filter((r) => r.checked);
  const bulkTotal = bulkSelected.reduce((s, r) => s + (+r.amount || 0), 0);

  const submitBulk = async (e) => {
    e.preventDefault();
    if (!bulkSelected.length) return toast.error('Selecciona al menos una factura');
    if (bulkForm.method !== 'EFECTIVO' && !bulkForm.bankAccount) return toast.error('Selecciona el banco');
    if (bulkForm.method !== 'EFECTIVO' && !bulkForm.voucherNumber && !bulkForm.reference) return toast.error('Ingresa el comprobante / referencia');
    setBulkBusy(true);
    try {
      const payload = {
        date: bulkForm.date,
        method: bulkForm.method,
        bankAccount: bulkForm.method === 'EFECTIVO' ? null : bulkForm.bankAccount,
        voucherNumber: bulkForm.voucherNumber,
        reference: bulkForm.reference,
        items: bulkSelected.map((r) => ({ purchaseInvoice: r.pi._id, amount: +r.amount })),
      };
      const res = await api.post('/payments/bulk', payload);
      toast.success(`${res.data?.count || 0} pago(s) creados por $${fmt(res.data?.total)}`);
      setShowBulk(false); load();
    } catch (err) { toast.error(err.response?.data?.message || 'Error'); }
    finally { setBulkBusy(false); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineCurrencyDollar className="text-emerald-600" /> {type === 'PAGO' ? 'Pagos' : 'Cobros'}</h1>
        <div className="flex gap-2">
          <div className="flex rounded-lg overflow-hidden border border-emerald-200">
            <button onClick={() => setType('COBRO')} className={`px-3 py-2 text-sm ${type === 'COBRO' ? 'bg-emerald-600 text-white' : 'bg-white'}`}>Cobros</button>
            <button onClick={() => setType('PAGO')} className={`px-3 py-2 text-sm ${type === 'PAGO' ? 'bg-emerald-600 text-white' : 'bg-white'}`}>Pagos</button>
          </div>
          {type === 'PAGO' && (
            <button onClick={openBulk} className="px-4 py-2 bg-sky-600 text-white rounded-xl shadow-sm shadow-sky-600/20 flex items-center gap-2"><HiOutlineCurrencyDollar /> Pago masivo</button>
          )}
          <button onClick={() => openNew(type)} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center gap-2"><HiOutlinePlus /> Nuevo</button>
        </div>
      </div>
      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden">
        <table className="tbl">
          <thead className="bg-emerald-50 text-xs uppercase"><tr>
            <th className="px-3 py-2 text-left">Número</th><th className="px-3 py-2 text-left">Fecha</th>
            <th className="px-3 py-2 text-left">Método</th><th className="px-3 py-2 text-right">Aplicado</th>
            <th className="px-3 py-2 text-right">Anticipo</th><th className="px-3 py-2 text-center">Estado</th><th></th>
          </tr></thead>
          <tbody>
            {list.map((p) => (
              <tr key={p._id} className={`border-t ${p.status === 'ANULADO' ? 'text-slate-400 line-through' : ''}`}>
                <td className="px-3 py-2 font-mono">
                  <button onClick={() => openDetail(p._id)} className="text-emerald-700 hover:underline" title="Ver detalle">{p.number}</button>
                </td>
                <td className="px-3 py-2">{fmtDate(p.date)}</td>
                <td className="px-3 py-2 text-xs">{p.method}</td>
                <td className="px-3 py-2 text-right font-mono">${fmt(p.appliedAmount)}</td>
                <td className="px-3 py-2 text-right font-mono">${fmt(p.advanceAmount)}</td>
                <td className="px-3 py-2 text-center text-xs">{p.status}</td>
                <td className="px-3 py-2 text-right flex gap-1 justify-end">
                  <button onClick={() => openDetail(p._id)} className="text-blue-600" title="Ver detalle"><HiOutlineEye className="w-4 h-4" /></button>
                  {p.status === 'REGISTRADO' && <button onClick={() => voidPay(p)} className="text-rose-600" title="Anular"><HiOutlineXMark className="w-4 h-4" /></button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal isOpen={!!detail} onClose={() => setDetail(null)} title={`Detalle ${detail?.number || ''}`} size="lg">
        {detail && (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap gap-x-5 gap-y-1">
              <span><b>Tipo:</b> {detail.type === 'PAGO' ? 'Pago a proveedor' : 'Cobro a cliente'}</span>
              <span><b>Fecha:</b> {fmtDate(detail.date)}</span>
              <span><b>Método:</b> {detail.method}</span>
              <span><b>Estado:</b> {detail.status}</span>
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-1">
              {detail.partyName && <span><b>{detail.type === 'PAGO' ? 'Proveedor' : 'Cliente'}:</b> {detail.partyName}</span>}
              {detail.bankAccount && <span><b>Banco:</b> {detail.bankAccount.name} {detail.bankAccount.bank ? `(${detail.bankAccount.bank})` : ''}</span>}
              {detail.reference && <span><b>Comprobante:</b> {detail.reference}</span>}
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-1">
              <span><b>Aplicado:</b> ${fmt(detail.appliedAmount)}</span>
              <span><b>Anticipo:</b> ${fmt(detail.advanceAmount)}</span>
            </div>

            {detail.journalEntry && (
              <button
                onClick={() => { setDetail(null); navigate(`/accounting/journal?doc=${detail.journalEntry._id}`); }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-slate-700 text-white rounded-lg"
              >
                <HiOutlineArrowTopRightOnSquare className="w-4 h-4" /> Ver asiento contable {detail.journalEntry.number || ''}
              </button>
            )}

            {(detail.applications || []).length > 0 && (
              <div className="border rounded-lg overflow-hidden">
                <table className="tbl text-xs">
                  <thead className="bg-slate-100"><tr>
                    <th className="px-2 py-1 text-left">Documento aplicado</th>
                    <th className="px-2 py-1 text-right">Monto</th>
                  </tr></thead>
                  <tbody>
                    {detail.applications.map((a, i) => (
                      <tr key={i} className="border-t">
                        <td className="px-2 py-1">{a.docModel === 'PurchaseInvoice' ? 'Factura de compra' : a.docModel === 'Invoice' ? 'Factura de venta' : a.docModel} · {String(a.docRef).slice(-6)}</td>
                        <td className="px-2 py-1 text-right font-mono">${fmt(a.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {detail.description && <p className="text-slate-600"><b>Notas:</b> {detail.description}</p>}
          </div>
        )}
      </Modal>

      <Modal isOpen={show} onClose={() => setShow(false)} title={`Nuevo ${form.type === 'PAGO' ? 'pago' : 'cobro'}`} size="xl">
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <Field label="Fecha" required><input type="date" required value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
            <Field label={form.type === 'PAGO' ? 'Proveedor' : 'Paciente'} required className="col-span-2">
              <select required value={form.party} onChange={(e) => { setForm({ ...form, party: e.target.value, applications: [] }); loadDocs(e.target.value); }} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5">
                <option value="">{form.type === 'PAGO' ? 'Seleccione proveedor…' : 'Seleccione paciente…'}</option>
                {form.type === 'PAGO' && suppliers.map((s) => <option key={s._id} value={s._id}>{s.razonSocial}</option>)}
              </select>
            </Field>
            <Field label="Método de pago">
              <select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5">
                <option>EFECTIVO</option><option>TRANSFERENCIA</option><option>CHEQUE</option><option>TARJETA</option><option>DEPOSITO</option>
              </select>
            </Field>
            {form.method !== 'EFECTIVO' &&
              <Field label="Banco" required className="col-span-2">
                <select required value={form.bankAccount} onChange={(e) => setForm({ ...form, bankAccount: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5">
                  <option value="">Seleccione…</option>{banks.map((b) => <option key={b._id} value={b._id}>{b.name} {b.initialBalance != null ? `(saldo inicial $${fmt(b.initialBalance)})` : ''}</option>)}
                </select>
              </Field>}
            {form.type === 'PAGO' && form.method !== 'EFECTIVO' && (
              <>
                <Field label="N° Comprobante" required><input required placeholder="Transferencia / cheque" value={form.voucherNumber} onChange={(e) => setForm({ ...form, voucherNumber: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
                <Field label="URL comprobante (opcional)" className="col-span-2"><input placeholder="https://…" value={form.voucherUrl} onChange={(e) => setForm({ ...form, voucherUrl: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
              </>
            )}
          </div>
          {form.type === 'PAGO' && form.method !== 'EFECTIVO' && (
            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              ⚠ Para pagos a proveedor por medios no efectivo se requiere número de comprobante (transferencia/cheque/depósito). El sistema validará que el banco seleccionado tenga saldo suficiente.
            </div>
          )}
          <div className="border rounded-lg p-3">
            <p className="text-sm font-semibold mb-2">Documentos a aplicar</p>
            {(form.type === 'PAGO' ? purchases : invoices).map((d) => {
              const docId = d._id;
              const app = form.applications.find((a) => a.docRef === docId);
              return (
                <div key={docId} className="flex items-center gap-2 text-sm py-1">
                  <input type="checkbox" checked={!!app} onChange={(e) => {
                    if (e.target.checked) setForm({ ...form, applications: [...form.applications, { docModel: form.type === 'PAGO' ? 'PurchaseInvoice' : 'Invoice', docRef: docId, amount: d.balance || d.total || 0 }] });
                    else setForm({ ...form, applications: form.applications.filter((a) => a.docRef !== docId) });
                  }} />
                  <span className="flex-1">{d.serie || `${d.estab}-${d.ptoEmi}-${d.secuencial}`} - {fmtDate(d.fechaEmision || d.createdAt)} - Total ${fmt(d.total || d.importeTotal)}</span>
                  {app && <NumericInput step="0.01" placeholder="Monto a aplicar" title="Monto a aplicar a este documento" value={app.amount} onChange={(e) => setForm({ ...form, applications: form.applications.map((a) => a.docRef === docId ? { ...a, amount: +e.target.value } : a) })} className="w-28 border border-slate-200 rounded px-2 py-1 text-right" />}
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-3">
            <label className="text-sm">Anticipo:</label>
            <NumericInput step="0.01" value={form.advanceAmount} onChange={(e) => setForm({ ...form, advanceAmount: +e.target.value })} className="w-32 border border-slate-200 rounded-xl px-3.5 py-2.5" />
            <span className="ml-auto font-semibold">Total: ${fmt(totalApplied)}</span>
          </div>
          <Field label="Notas"><input placeholder="Observaciones / cheque #" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setShow(false)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button><button disabled={busy} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 disabled:opacity-60 disabled:cursor-not-allowed">{busy ? 'Registrando…' : 'Registrar'}</button></div>
        </form>
      </Modal>

      {/* Pago masivo a proveedores */}
      <Modal isOpen={showBulk} onClose={() => setShowBulk(false)} title="Pago masivo a proveedores" size="xl">
        <form onSubmit={submitBulk} className="space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Field label="Fecha" required><input type="date" required value={bulkForm.date} onChange={(e) => setBulkForm({ ...bulkForm, date: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
            <Field label="Método">
              <select value={bulkForm.method} onChange={(e) => setBulkForm({ ...bulkForm, method: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5">
                <option>EFECTIVO</option><option>TRANSFERENCIA</option><option>CHEQUE</option><option>DEPOSITO</option>
              </select>
            </Field>
            {bulkForm.method !== 'EFECTIVO' && (
              <Field label="Banco" required>
                <select required value={bulkForm.bankAccount} onChange={(e) => setBulkForm({ ...bulkForm, bankAccount: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5">
                  <option value="">Seleccione…</option>{banks.map((b) => <option key={b._id} value={b._id}>{b.name}</option>)}
                </select>
              </Field>
            )}
            {bulkForm.method !== 'EFECTIVO' && (
              <Field label="N° Comprobante / referencia"><input value={bulkForm.voucherNumber} onChange={(e) => setBulkForm({ ...bulkForm, voucherNumber: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
            )}
          </div>

          <input placeholder="Buscar por proveedor o serie..." value={bulkSearch} onChange={(e) => setBulkSearch(e.target.value)} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" />

          <div className="border rounded-xl overflow-auto max-h-80">
            <table className="tbl text-sm">
              <thead className="bg-slate-100 text-xs uppercase sticky top-0"><tr>
                <th className="px-2 py-2 w-8"></th>
                <th className="px-2 py-2 text-left">Proveedor</th>
                <th className="px-2 py-2 text-left">Serie</th>
                <th className="px-2 py-2 text-left">Fecha</th>
                <th className="px-2 py-2 text-right">Saldo</th>
                <th className="px-2 py-2 text-right">A pagar</th>
              </tr></thead>
              <tbody>
                {bulkRows
                  .filter((r) => {
                    const q = bulkSearch.trim().toLowerCase();
                    if (!q) return true;
                    return (r.pi.supplier?.razonSocial || '').toLowerCase().includes(q) || (r.pi.serie || '').toLowerCase().includes(q);
                  })
                  .map((r) => {
                    const balance = Number(r.pi.balance ?? r.pi.total ?? 0);
                    return (
                      <tr key={r.pi._id} className={`border-t ${r.checked ? 'bg-sky-50/50' : ''}`}>
                        <td className="px-2 py-1 text-center">
                          <input type="checkbox" checked={r.checked} onChange={() => setBulkRows((rows) => rows.map((x) => x.pi._id === r.pi._id ? { ...x, checked: !x.checked } : x))} />
                        </td>
                        <td className="px-2 py-1">{r.pi.supplier?.razonSocial || '—'}</td>
                        <td className="px-2 py-1 font-mono text-xs">{r.pi.serie}</td>
                        <td className="px-2 py-1 text-xs">{fmtDate(r.pi.fechaEmision)}</td>
                        <td className="px-2 py-1 text-right font-mono">{fmt(balance)}</td>
                        <td className="px-2 py-1 text-right">
                          <NumericInput step="0.01" min="0" max={balance}
                            value={r.amount}
                            disabled={!r.checked}
                            onChange={(e) => { const v = +e.target.value; setBulkRows((rows) => rows.map((x) => x.pi._id === r.pi._id ? { ...x, amount: v } : x)); }}
                            className="w-24 border border-slate-200 rounded px-2 py-1 text-right disabled:bg-slate-100"
                          />
                        </td>
                      </tr>
                    );
                  })}
                {!bulkRows.length && <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">No hay compras registradas con saldo pendiente.</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-600">{bulkSelected.length} factura(s) seleccionada(s)</span>
            <span className="font-semibold">Total a pagar: ${fmt(bulkTotal)}</span>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setShowBulk(false)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button>
            <button disabled={bulkBusy} className="px-4 py-2 bg-sky-600 text-white rounded-xl shadow-sm shadow-sky-600/20 disabled:opacity-50">{bulkBusy ? 'Procesando...' : 'Registrar pagos'}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
