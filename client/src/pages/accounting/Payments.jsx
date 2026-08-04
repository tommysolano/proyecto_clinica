import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import Field from '../../components/Field';
import { HiOutlinePlus, HiOutlineCurrencyDollar, HiOutlineXMark, HiOutlineEye, HiOutlineArrowTopRightOnSquare, HiOutlineMagnifyingGlass, HiOutlineUser } from 'react-icons/hi2';
import { fmt, fmtDate, today } from './_utils';
import NumericInput from '../../components/NumericInput';
import SearchableSelect from '../../components/SearchableSelect';
import ExcelButton from '../../components/ExcelButton';
import useDocDeepLink from '../../hooks/useDocDeepLink';
import { newIdempotencyKey, withIdempotencyKey, intentKey } from '../../utils/idempotency';

/** Cliente sin identificar: la venta se emite a Consumidor Final y su CxC no tiene paciente. */
const CONSUMIDOR_FINAL = { _id: '__CF__', nombre: 'Consumidor Final', cedula: '9999999999999' };

const EMPTY_FORM = (t = 'PAGO') => ({
  type: t,
  date: today(),
  partyModel: t === 'PAGO' ? 'Supplier' : 'Patient',
  partyRef: '',          // id del tercero (vacío en Consumidor Final)
  partyName: '',
  partyId: '',
  method: 'TRANSFERENCIA',
  bankAccount: '',
  checkNumber: '',       // solo CHEQUE: se valida contra la chequera del banco
  applications: [],
  advanceAmount: 0,
  description: '',
  voucherNumber: '',
  voucherUrl: '',
});

export default function Payments() {
  const navigate = useNavigate();
  const [list, setList] = useState([]);
  const [type, setType] = useState('PAGO');
  // «Los pagos del 1 al 30 de julio hechos a Juan»: rango de fechas + persona, que es como el
  // contador busca. El filtro va al servidor (no se filtra una página ya recortada).
  const [filtros, setFiltros] = useState({ startDate: '', endDate: '', q: '' });
  const [show, setShow] = useState(false);
  const [detail, setDetail] = useState(null);
  const [suppliers, setSuppliers] = useState([]);
  const [banks, setBanks] = useState([]);
  const [docs, setDocs] = useState([]);          // documentos pendientes del tercero elegido
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM('PAGO'));
  const [busy, setBusy] = useState(false);   // envío en curso: evita registrar el pago dos veces
  const [intent, setIntent] = useState('');  // clave base de idempotencia de la intención abierta
  // Buscador de paciente (COBRO): se escribe y el servidor devuelve coincidencias. Un dropdown
  // con todos los pacientes no sirve cuando hay miles.
  const [patientQuery, setPatientQuery] = useState('');
  const [patientResults, setPatientResults] = useState([]);
  const [patientOpen, setPatientOpen] = useState(false);
  const [searchingPatients, setSearchingPatients] = useState(false);
  const debounceRef = useRef(null);

  // Pago masivo a proveedores
  const [showBulk, setShowBulk] = useState(false);
  const [bulkRows, setBulkRows] = useState([]); // { pi, checked, amount }
  const [bulkForm, setBulkForm] = useState({ date: today(), method: 'TRANSFERENCIA', bankAccount: '', voucherNumber: '', reference: '' });
  const [bulkSearch, setBulkSearch] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = async () => {
    try {
      const params = { type, limit: 200 };
      if (filtros.startDate) params.startDate = filtros.startDate;
      if (filtros.endDate) params.endDate = filtros.endDate;
      if (filtros.q.trim()) params.q = filtros.q.trim();
      const r = await api.get('/payments', { params });
      setList(r.data?.items || r.data || []);
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  useEffect(() => {
    // Sin `.catch` un 403 dejaba la lista vacía sin decir nada (contabilidad sí puede, cajero no).
    api.get('/suppliers').then((r) => setSuppliers(r.data?.items || r.data || [])).catch(() => setSuppliers([]));
    api.get('/banks/accounts').then((r) => setBanks(r.data || [])).catch(() => setBanks([]));
  }, []);
  useEffect(() => {
    load();
    // eslint-disable-next-line
  }, [type, filtros]);

  const openNew = (t) => {
    setForm(EMPTY_FORM(t));
    setDocs([]);
    setPatientQuery(''); setPatientResults([]); setPatientOpen(false);
    // Clave base de esta intención: un doble clic reintenta el MISMO pago (replay), no crea otro.
    setIntent(newIdempotencyKey());
    setShow(true);
  };

  /** Búsqueda de pacientes en el servidor (con espera para no disparar en cada tecla). */
  const buscarPacientes = (q) => {
    setPatientQuery(q);
    setPatientOpen(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!q.trim()) { setPatientResults([]); return; }
    debounceRef.current = setTimeout(async () => {
      setSearchingPatients(true);
      try {
        const r = await api.get('/patients', { params: { search: q.trim(), limit: 15 } });
        setPatientResults(r.data?.patients || r.data?.items || r.data || []);
      } catch { setPatientResults([]); }
      finally { setSearchingPatients(false); }
    }, 250);
  };

  /** Elige el tercero del cobro: un paciente concreto o Consumidor Final (sin id). */
  const elegirPaciente = (p) => {
    const esCF = p._id === CONSUMIDOR_FINAL._id;
    const nombre = esCF ? CONSUMIDOR_FINAL.nombre : `${p.firstName || ''} ${p.lastName || ''}`.trim();
    setForm((f) => ({
      ...f,
      partyModel: 'Patient',
      partyRef: esCF ? '' : p._id,
      partyName: nombre,
      partyId: esCF ? CONSUMIDOR_FINAL.cedula : (p.cedula || ''),
      applications: [],
    }));
    setPatientQuery(nombre);
    setPatientOpen(false);
    loadDocs({ partyRef: esCF ? '' : p._id, partyName: nombre });
  };

  const elegirProveedor = (id) => {
    const s = suppliers.find((x) => String(x._id) === String(id));
    setForm((f) => ({
      ...f,
      partyModel: 'Supplier',
      partyRef: id,
      partyName: s?.razonSocial || s?.nombreComercial || '',
      partyId: s?.ruc || '',
      applications: [],
    }));
    loadDocs({ partyRef: id, partyName: s?.razonSocial || '' });
  };

  // Detalle de un pago/cobro (para navegar desde el Libro Mayor con ?doc=<id>).
  const openDetail = async (id) => {
    try { const r = await api.get(`/payments/${id}`); setDetail(r.data); }
    catch (e) { toast.error(e.response?.data?.message || 'No se encontró el pago'); }
  };

  // Deep-link desde el Libro Mayor / asiento (?doc=<idPago>): abre el detalle del pago.
  useDocDeepLink((id) => openDetail(id));

  /**
   * DOCUMENTOS PENDIENTES del tercero elegido.
   *
   * En COBRO se consulta la CARTERA (submayor de CxC), no las facturas electrónicas: una venta
   * a crédito no genera factura por sí sola —su saldo vive en la cartera con origen `Sale`— así
   * que el listado anterior salía siempre vacío y el bloque parecía decorativo. Consumidor Final
   * no tiene id de paciente: ahí se busca por NOMBRE, que es como se abre esa cartera.
   */
  const loadDocs = async ({ partyRef, partyName }) => {
    setLoadingDocs(true);
    try {
      if (form.type === 'PAGO') {
        const r = await api.get('/purchase-invoices', { params: { supplier: partyRef, status: 'REGISTRADA', limit: 200 } });
        const items = (r.data?.items || r.data || []).filter((d) => Number(d.balance ?? d.total ?? 0) > 0.005);
        setDocs(items.map((d) => ({
          key: d._id,
          docModel: 'PurchaseInvoice',
          docRef: d._id,
          label: d.serie || `${d.estab || ''}-${d.ptoEmi || ''}-${d.secuencial || ''}`,
          date: d.fechaEmision || d.createdAt,
          dueDate: d.dueDate || null,
          total: Number(d.total || 0),
          balance: Number(d.balance ?? d.total ?? 0),
        })));
      } else {
        const params = { side: 'AR' };
        if (partyRef) params.partyRef = partyRef;
        else if (partyName) params.q = partyName;
        const r = await api.get('/subledger', { params });
        const items = (r.data || []).filter((d) => d.status !== 'ANULADO' && Number(d.balance || 0) > 0.005);
        setDocs(items.map((d) => ({
          key: d._id,
          // El submayor guarda de qué documento nació la deuda: venta a crédito o factura.
          docModel: d.sourceModel === 'Invoice' ? 'Invoice' : 'Sale',
          docRef: d.sourceRef,
          label: d.number || (d.docType || 'Documento'),
          date: d.issueDate,
          dueDate: d.dueDate,
          total: Number(d.total || 0),
          balance: Number(d.balance || 0),
        })));
      }
    } catch (e) {
      setDocs([]);
      toast.error(e.response?.data?.message || 'No se pudieron cargar los documentos pendientes');
    } finally { setLoadingDocs(false); }
  };

  const toggleDoc = (d, checked) => {
    setForm((f) => ({
      ...f,
      applications: checked
        ? [...f.applications, { docModel: d.docModel, docRef: d.docRef, amount: d.balance }]
        : f.applications.filter((a) => String(a.docRef) !== String(d.docRef)),
    }));
  };

  const totalApplied = form.applications.reduce((s, a) => s + (+a.amount || 0), 0) + (+form.advanceAmount || 0);
  const totalPendiente = docs.reduce((s, d) => s + d.balance, 0);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (!form.partyName && !form.partyRef) {
      return toast.error(form.type === 'PAGO' ? 'Selecciona el proveedor' : 'Selecciona el paciente o Consumidor Final');
    }
    if (totalApplied <= 0) return toast.error('Aplica el cobro a un documento o registra un anticipo');
    setBusy(true);
    try {
      // La clave se deriva de la intención: estable mientras no cambie nada (reintento ⇒ replay),
      // distinta en cuanto cambie importe/banco/fecha/documentos (es otra operación).
      const huella = [
        form.type, form.method, form.bankAccount, form.date, form.partyRef || form.partyName, form.advanceAmount,
        form.checkNumber || '',
        ...form.applications.map((a) => `${a.docModel}#${a.docRef}#${a.amount}`).sort(),
      ];
      // `partyRef` vacío es Consumidor Final: se manda null, no '' (mongoose no puede castear '').
      const payload = {
        ...form,
        partyRef: form.partyRef || null,
        bankAccount: form.bankAccount || null,
        checkNumber: form.method === 'CHEQUE' ? (form.checkNumber || '').trim() || null : null,
        advanceAmount: Number(form.advanceAmount) || 0,
      };
      await api.post('/payments', payload, withIdempotencyKey(intentKey(intent, huella)));
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

      {/* Filtros: rango de fechas y persona. El Excel baja EXACTAMENTE lo filtrado. */}
      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-3 flex flex-wrap gap-2 items-end">
        <label className="text-xs text-slate-500">Desde
          <input type="date" value={filtros.startDate} onChange={(e) => setFiltros({ ...filtros, startDate: e.target.value })} className="mt-1 block border border-slate-200 rounded-xl px-3 py-2 text-sm" />
        </label>
        <label className="text-xs text-slate-500">Hasta
          <input type="date" value={filtros.endDate} onChange={(e) => setFiltros({ ...filtros, endDate: e.target.value })} className="mt-1 block border border-slate-200 rounded-xl px-3 py-2 text-sm" />
        </label>
        <label className="text-xs text-slate-500 flex-1 min-w-[220px]">{type === 'PAGO' ? 'Proveedor' : 'Cliente'} / número / referencia
          <div className="relative mt-1">
            <HiOutlineMagnifyingGlass className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={filtros.q} onChange={(e) => setFiltros({ ...filtros, q: e.target.value })} placeholder={type === 'PAGO' ? 'Ej: Juan Pérez' : 'Ej: María López'} className="w-full border border-slate-200 rounded-xl pl-8 pr-3 py-2 text-sm" />
          </div>
        </label>
        {(filtros.startDate || filtros.endDate || filtros.q) && (
          <button onClick={() => setFiltros({ startDate: '', endDate: '', q: '' })} className="px-3 py-2 text-sm bg-slate-100 rounded-xl">Limpiar</button>
        )}
        <ExcelButton
          url="/payments/export.xlsx"
          params={{ type, ...filtros }}
          filename={`${type === 'PAGO' ? 'pagos' : 'cobros'}_${filtros.startDate || 'inicio'}_${filtros.endDate || 'hoy'}.xlsx`}
          title={`Descargar los ${type === 'PAGO' ? 'pagos' : 'cobros'} del filtro actual`}
        />
      </div>

      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden">
        <table className="tbl">
          <thead className="bg-emerald-50 text-xs uppercase"><tr>
            <th className="px-3 py-2 text-left">Número</th><th className="px-3 py-2 text-left">Fecha</th>
            <th className="px-3 py-2 text-left">{type === 'PAGO' ? 'Proveedor / razón social' : 'Cliente / razón social'}</th>
            <th className="px-3 py-2 text-left">Método</th>
            <th className="px-3 py-2 text-left">Banco / cheque</th>
            {/* Una sola columna de VALOR: «aplicado» y «anticipo» eran jerga interna; el detalle
                del documento sigue mostrando el desglose. */}
            <th className="px-3 py-2 text-right">Valor</th>
            <th className="px-3 py-2 text-center">Estado</th><th></th>
          </tr></thead>
          <tbody>
            {list.map((p) => {
              const anulado = p.status === 'ANULADO';
              const conciliado = !anulado && p.bankTransaction?.reconciled;
              return (
                <tr key={p._id} className={`border-t ${anulado ? 'text-slate-400 line-through' : ''}`}>
                  <td className="px-3 py-2 font-mono">
                    <button onClick={() => openDetail(p._id)} className="text-emerald-700 hover:underline" title="Ver detalle">{p.number}</button>
                  </td>
                  <td className="px-3 py-2">{fmtDate(p.date)}</td>
                  <td className="px-3 py-2 text-xs">{p.partyName || '—'}</td>
                  <td className="px-3 py-2 text-xs">{p.method}</td>
                  <td className="px-3 py-2 text-xs">
                    {p.bankAccount?.name || (p.method === 'EFECTIVO' ? 'Caja' : '—')}
                    {p.checkNumber ? <span className="text-slate-400 font-mono"> · cheque {p.checkNumber}</span> : ''}
                  </td>
                  <td className="px-3 py-2 text-right font-mono font-semibold">${fmt(p.total)}</td>
                  <td className="px-3 py-2 text-center text-[11px]">
                    {anulado
                      ? <span className="px-2 py-0.5 rounded-full bg-rose-100 text-rose-700">Anulado</span>
                      : conciliado
                        ? <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700" title="El movimiento bancario ya se concilió con el estado de cuenta">Conciliado</span>
                        : <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">Registrado</span>}
                  </td>
                  <td className="px-3 py-2 text-right flex gap-1 justify-end">
                    <button onClick={() => openDetail(p._id)} className="text-blue-600" title="Ver detalle"><HiOutlineEye className="w-4 h-4" /></button>
                    {p.status === 'REGISTRADO' && <button onClick={() => voidPay(p)} className="text-rose-600" title="Anular"><HiOutlineXMark className="w-4 h-4" /></button>}
                  </td>
                </tr>
              );
            })}
            {!list.length && (
              <tr><td colSpan={8} className="px-3 py-8 text-center text-slate-400">
                {type === 'COBRO'
                  ? 'No hay cobros con estos filtros. Se registran aquí con «Nuevo», o desde Ventas con el botón de cobrar de una venta con saldo.'
                  : 'No hay pagos con estos filtros.'}
              </td></tr>
            )}
          </tbody>
          {!!list.length && (
            <tfoot><tr className="border-t bg-slate-50 font-semibold">
              <td colSpan={5} className="px-3 py-2 text-right text-xs">Total ({list.length} documento(s)):</td>
              <td className="px-3 py-2 text-right font-mono">
                ${fmt(list.filter((p) => p.status !== 'ANULADO').reduce((s, p) => s + (Number(p.total) || 0), 0))}
              </td>
              <td colSpan={2}></td>
            </tr></tfoot>
          )}
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
            {form.type === 'PAGO' ? (
              <Field label="Proveedor" required className="col-span-2">
                <SearchableSelect
                  options={suppliers}
                  value={form.partyRef}
                  onChange={elegirProveedor}
                  getLabel={(s) => s.razonSocial || s.nombreComercial || s.ruc}
                  getSearchText={(s) => `${s.ruc || ''} ${s.razonSocial || ''} ${s.nombreComercial || ''}`}
                  placeholder={suppliers.length ? 'Escribe para buscar el proveedor…' : 'No hay proveedores'}
                  searchPlaceholder="Buscar por RUC o nombre…"
                />
              </Field>
            ) : (
              /* Buscador de paciente: se escribe y aparecen las coincidencias. Consumidor Final
                 va siempre primero porque es el caso más común en el mostrador. */
              <Field label="Paciente / cliente" required className="col-span-2">
                <div className="relative">
                  <HiOutlineMagnifyingGlass className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    value={patientQuery}
                    onChange={(e) => buscarPacientes(e.target.value)}
                    onFocus={() => setPatientOpen(true)}
                    placeholder="Escribe el nombre o la cédula…"
                    className="w-full border border-slate-200 rounded-xl pl-9 pr-3 py-2.5"
                    autoComplete="off"
                  />
                  {patientOpen && (
                    <div className="absolute z-20 mt-1 w-full bg-white border border-slate-200 rounded-xl shadow-lg max-h-64 overflow-y-auto">
                      <button
                        type="button"
                        onClick={() => elegirPaciente(CONSUMIDOR_FINAL)}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-emerald-50 flex items-center gap-2 bg-transparent border-none cursor-pointer"
                      >
                        <HiOutlineUser className="text-slate-400" /> <b>Consumidor Final</b> <span className="text-xs text-slate-400">9999999999999</span>
                      </button>
                      {searchingPatients && <p className="px-3 py-2 text-xs text-slate-400">Buscando…</p>}
                      {!searchingPatients && patientResults.map((p) => (
                        <button
                          key={p._id}
                          type="button"
                          onClick={() => elegirPaciente(p)}
                          className="w-full text-left px-3 py-2 text-sm hover:bg-emerald-50 border-t border-slate-100 bg-transparent cursor-pointer"
                        >
                          {p.firstName} {p.lastName} <span className="text-xs text-slate-400 font-mono">{p.cedula || ''}</span>
                        </button>
                      ))}
                      {!searchingPatients && !!patientQuery.trim() && !patientResults.length && (
                        <p className="px-3 py-2 text-xs text-slate-400 border-t border-slate-100">Sin pacientes con ese nombre o cédula.</p>
                      )}
                    </div>
                  )}
                </div>
                {(form.partyName || form.partyRef) && (
                  <p className="text-[11px] text-emerald-700 mt-1">
                    Cobrando a <b>{form.partyName}</b>{form.partyRef ? '' : ' (sin paciente registrado)'}
                  </p>
                )}
              </Field>
            )}
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
            {form.method === 'CHEQUE' && (
              <Field label="N° de cheque">
                {/* Debe existir en la chequera de esa cuenta y estar disponible; en blanco se
                    toma automáticamente el primer cheque libre. */}
                <input
                  value={form.checkNumber}
                  onChange={(e) => setForm({ ...form, checkNumber: e.target.value })}
                  placeholder="En blanco = el siguiente disponible"
                  className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5"
                />
              </Field>
            )}
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
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-semibold">{form.type === 'PAGO' ? 'Compras pendientes de pago' : 'Ventas / facturas por cobrar'}</p>
              {!!docs.length && <span className="text-xs text-slate-500">{docs.length} documento(s) · saldo <b className="font-mono">${fmt(totalPendiente)}</b></span>}
            </div>
            {loadingDocs && <p className="text-xs text-slate-400 py-2">Cargando documentos…</p>}
            {!loadingDocs && !form.partyName && !form.partyRef && (
              <p className="text-xs text-slate-400 py-2">Elige primero {form.type === 'PAGO' ? 'el proveedor' : 'el paciente o Consumidor Final'} para ver sus documentos pendientes.</p>
            )}
            {!loadingDocs && (form.partyName || form.partyRef) && !docs.length && (
              <p className="text-xs text-slate-500 py-2">
                No hay documentos con saldo pendiente{form.type === 'COBRO' ? ' para este cliente. Si la venta fue de contado no genera cuenta por cobrar; puedes registrar el importe como anticipo.' : '.'}
              </p>
            )}
            {!loadingDocs && docs.map((d) => {
              const app = form.applications.find((a) => String(a.docRef) === String(d.docRef));
              const vencido = d.dueDate && new Date(d.dueDate) < new Date();
              return (
                <div key={d.key} className="flex items-center gap-2 text-sm py-1 border-b border-slate-100 last:border-0">
                  <input type="checkbox" checked={!!app} onChange={(e) => toggleDoc(d, e.target.checked)} />
                  <span className="flex-1">
                    <b className="font-mono">{d.label}</b>
                    <span className="text-slate-500"> · {fmtDate(d.date)}</span>
                    {d.dueDate && <span className={vencido ? 'text-rose-600' : 'text-slate-500'}> · vence {fmtDate(d.dueDate)}</span>}
                    <span className="text-slate-500"> · total ${fmt(d.total)}</span>
                    <b className="text-amber-700"> · saldo ${fmt(d.balance)}</b>
                  </span>
                  {app && (
                    <NumericInput
                      step="0.01" max={d.balance}
                      placeholder="Monto a aplicar" title="Monto a aplicar a este documento"
                      value={app.amount}
                      onChange={(e) => setForm({ ...form, applications: form.applications.map((a) => String(a.docRef) === String(d.docRef) ? { ...a, amount: +e.target.value } : a) })}
                      className="w-28 border border-slate-200 rounded px-2 py-1 text-right"
                    />
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-3">
            <label className="text-sm">Anticipo:</label>
            <NumericInput step="0.01" value={form.advanceAmount} onChange={(e) => setForm({ ...form, advanceAmount: +e.target.value })} className="w-32 border border-slate-200 rounded-xl px-3.5 py-2.5" />
            <span className="ml-auto font-semibold">Total: ${fmt(totalApplied)}</span>
          </div>
          <Field label="Notas"><input placeholder="Observaciones / cheque #" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
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
