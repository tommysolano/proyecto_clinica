import { useEffect, useRef, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import Field from '../../components/Field';
import { HiOutlinePlus, HiOutlineDocumentText, HiOutlineArrowDownTray, HiOutlineXMark, HiOutlineTrash } from 'react-icons/hi2';
import { fmt, fmtDate, today } from './_utils';
import NumericInput from '../../components/NumericInput';
import JournalEntryEditor from '../../components/JournalEntryEditor';
import SearchableSelect from '../../components/SearchableSelect';
import ProductFormModal from '../../components/ProductFormModal';
import { useAuth } from '../../context/AuthContext';

const PAGE_SIZE = 100;
// Captura de activo fijo en la línea (espejo del modal "Nuevo activo fijo").
const EMPTY_FA = { category: '', assetType: '', code: '', name: '', serial: '', location: '', locationClinic: '', acquisitionDate: '', startDate: '', depreciationRate: 0, usefulLifeMonths: 0, residualPercent: 0, assetAccount: '', depreciationAccount: '', accumDepreciationAccount: '' };
const EMPTY_ITEM = { description: '', quantity: 1, unitPrice: 0, discount: 0, ivaRate: 15, account: '', accountSplits: [], lineType: 'GASTO', costCenter: '', fixedAsset: { ...EMPTY_FA }, product: '', warehouse: '', lot: '', expiryDate: '' };
const EMPTY = { supplier: '', docType: 'FACTURA', estab: '001', ptoEmi: '001', secuencial: '', serie: '', claveAcceso: '', autorizacion: '', fechaEmision: today(), fechaVencimiento: '', creditDays: 0, costCenter: '', items: [{ ...EMPTY_ITEM }], retentions: [], retentionNumber: '' };

// Vencimiento = fecha de emisión + días de crédito (YYYY-MM-DD).
const addDays = (dateStr, days) => {
  if (!dateStr || !(+days > 0)) return '';
  const d = new Date(`${dateStr}T00:00:00`);
  if (isNaN(d)) return '';
  d.setDate(d.getDate() + Number(days));
  return d.toISOString().slice(0, 10);
};
const LINE_TYPES = [['GASTO', 'Gasto'], ['INVENTARIO', 'Inventario'], ['ACTIVO_FIJO', 'Activo fijo']];

export default function PurchaseInvoices() {
  const { hasRole } = useAuth();
  const [list, setList] = useState([]);
  const [show, setShow] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importMode, setImportMode] = useState('xml'); // 'xml' | 'txt'
  const [importing, setImporting] = useState(false);
  const [importTxt, setImportTxt] = useState('');
  const [importTxtName, setImportTxtName] = useState('');
  const [xmlContents, setXmlContents] = useState([]); // array de strings XML
  const [suppliers, setSuppliers] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [products, setProducts] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [banks, setBanks] = useState([]);
  const [costCenters, setCostCenters] = useState([]);
  const [assetCategories, setAssetCategories] = useState([]); // categorías de activo fijo (con tipos)
  const [clinics, setClinics] = useState([]);
  const [recurring, setRecurring] = useState({ defaultAccount: null, accounts: [] });
  const [form, setForm] = useState(EMPTY);
  const [authorizeId, setAuthorizeId] = useState(null);
  const [editId, setEditId] = useState(null); // factura REGISTRADA en edición
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [sort, setSort] = useState('fecha_desc');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [pendingTotal, setPendingTotal] = useState(0); // total real de "por autorizar" (todas las páginas)
  const [newProductItemIdx, setNewProductItemIdx] = useState(null); // línea que dispara "Nuevo producto"
  const [journalInv, setJournalInv] = useState(null); // factura cuyo asiento se edita
  const [payInv, setPayInv] = useState(null); // factura a pagar
  const [payForm, setPayForm] = useState({ method: 'TRANSFERENCIA', bankAccount: '', voucherNumber: '', checkNumber: '', amount: 0, date: today() });

  // Solo la respuesta de la última búsqueda actualiza la lista: descarta
  // respuestas fuera de orden que sobrescribirían con datos obsoletos.
  const reqRef = useRef(0);
  const load = async () => {
    const reqId = ++reqRef.current;
    try {
      const r = await api.get('/purchase-invoices', { params: { q: search || undefined, status: statusFilter || undefined, sort, page, limit: PAGE_SIZE } });
      if (reqId !== reqRef.current) return; // respuesta obsoleta: descartar
      setList(r.data?.items || r.data || []);
      setTotal(r.data?.total ?? (r.data?.items?.length || 0));
      loadPendingCount();
    } catch (e) { if (reqId === reqRef.current) toast.error(e.response?.data?.message || 'Error'); }
  };

  // Total real de facturas pendientes de autorizar (de todas, no solo la página visible).
  const loadPendingCount = async () => {
    try {
      const r = await api.get('/purchase-invoices', { params: { status: 'POR_AUTORIZAR', limit: 1 } });
      setPendingTotal(r.data?.total ?? 0);
    } catch { /* sin bloquear la vista */ }
  };
  // Catálogo de productos físicos (los que pueden entrar a stock por compra).
  const loadProducts = () =>
    api.get('/products')
      .then((r) => setProducts((r.data?.items || r.data || []).filter((p) => !p.unlimited && p.category !== 'servicio')))
      .catch(() => {});

  useEffect(() => {
    api.get('/suppliers').then((r) => setSuppliers(r.data || []));
    api.get('/chart-of-accounts').then((r) => setAccounts((r.data || []).filter((a) => a.allowsMovement && (a.code?.startsWith('6.') || a.code?.startsWith('1.1.04') || a.code?.startsWith('1.2.')))));
    loadProducts();
    api.get('/inventory-advanced/warehouses').then((r) => setWarehouses(r.data || [])).catch(() => {});
    api.get('/banks/accounts').then((r) => setBanks(r.data || [])).catch(() => {});
    api.get('/cost-centers', { params: { active: true } }).then((r) => setCostCenters(r.data || [])).catch(() => {});
    api.get('/inventory-advanced/categories', { params: { kind: 'ACTIVO_FIJO' } }).then((r) => setAssetCategories(r.data?.items || r.data || [])).catch(() => {});
    api.get('/clinics').then((r) => setClinics(r.data?.items || r.data || [])).catch(() => {});
    load();
  }, []);
  // Al cambiar búsqueda/estado/orden, vuelve a la primera página.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setPage(1); }, [search, statusFilter, sort]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { const t = setTimeout(load, 300); return () => clearTimeout(t); }, [search, statusFilter, sort, page]);

  // Cuentas recurrentes del proveedor: sugiere y autocompleta la cuenta de gasto.
  useEffect(() => {
    if (!form.supplier) { setRecurring({ defaultAccount: null, accounts: [] }); return; }
    let active = true;
    api.get('/purchase-invoices/recurring-accounts', { params: { supplier: form.supplier } })
      .then((r) => {
        if (!active) return;
        const data = r.data || { defaultAccount: null, accounts: [] };
        setRecurring(data);
        if (data.defaultAccount) {
          setForm((f) => ({ ...f, items: f.items.map((it) => (it.account || (it.accountSplits || []).length ? it : { ...it, account: data.defaultAccount._id })) }));
        }
      })
      .catch(() => {});
    return () => { active = false; };
  }, [form.supplier]);

  // Aplica una cuenta recurrente a todos los ítems que aún no tienen cuenta.
  const applyRecurring = (accId) => setForm((f) => ({ ...f, items: f.items.map((it) => ((it.accountSplits || []).length ? it : { ...it, account: accId })) }));

  // Al elegir proveedor: prefija sus días de crédito y recalcula el vencimiento.
  const onSelectSupplier = (v) => {
    const sup = suppliers.find((s) => String(s._id) === String(v));
    const creditDays = sup?.creditDays || 0;
    setForm((f) => ({ ...f, supplier: v, creditDays: creditDays || f.creditDays, fechaVencimiento: (creditDays || f.creditDays) ? addDays(f.fechaEmision, creditDays || f.creditDays) : f.fechaVencimiento }));
  };

  // Centro de costo por defecto de la factura: se copia a las líneas que no tengan uno.
  const setInvoiceCostCenter = (cc) => setForm((f) => ({ ...f, costCenter: cc, items: f.items.map((it) => (it.costCenter ? it : { ...it, costCenter: cc })) }));

  // Al elegir categoría de activo fijo en una línea: prefija cuentas y parámetros (como en Activos Fijos).
  const onItemAssetCategory = (i, catId) => {
    const c = assetCategories.find((x) => String(x._id) === String(catId));
    const fa = {
      ...(form.items[i].fixedAsset || {}),
      category: catId, assetType: '',
      depreciationRate: c?.depreciationRate || 0,
      usefulLifeMonths: (c?.usefulLifeYears || 10) * 12,
      residualPercent: c?.residualPercent || 0,
      assetAccount: c?.assetAccount?._id || c?.assetAccount || '',
      depreciationAccount: c?.depreciationAccount?._id || c?.depreciationAccount || '',
      accumDepreciationAccount: c?.accumDepreciationAccount?._id || c?.accumDepreciationAccount || '',
    };
    setItem(i, { fixedAsset: fa, account: fa.assetAccount || form.items[i].account });
  };
  const setFa = (i, patch) => setItem(i, { fixedAsset: { ...(form.items[i].fixedAsset || {}), ...patch } });


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
    if (!form.supplier) return toast.error('Selecciona un proveedor');
    for (const it of form.items) {
      if (it.lineType === 'INVENTARIO' && !it.product) return toast.error('En las líneas de inventario, selecciona el producto');
      if (it.lineType === 'ACTIVO_FIJO' && !(it.fixedAsset?.name || it.description)) return toast.error('El activo fijo necesita un nombre o descripción');
      if ((it.accountSplits || []).length) {
        const base = +((it.quantity || 0) * (it.unitPrice || 0) - (it.discount || 0)).toFixed(2);
        const sum = +(it.accountSplits.reduce((s, sp) => s + (+sp.amount || 0), 0)).toFixed(2);
        if (Math.abs(sum - base) > 0.01) return toast.error(`La distribución de "${it.description || 'ítem'}" no cuadra (${fmt(sum)} ≠ ${fmt(base)})`);
        if (it.accountSplits.some((sp) => !sp.account)) return toast.error('Hay cuentas sin seleccionar en la distribución');
      }
    }
    try {
      const serie = form.serie || `${form.estab}-${form.ptoEmi}-${form.secuencial}`;
      // Normaliza referencias vacías a null (evita cast de ObjectId '') según el tipo de línea.
      const items = form.items.map((it) => {
        const base = {
          ...it,
          costCenter: it.costCenter || null,
          product: it.lineType === 'INVENTARIO' ? (it.product || null) : null,
          warehouse: it.lineType === 'INVENTARIO' ? (it.warehouse || null) : null,
          expiryDate: it.lineType === 'INVENTARIO' ? (it.expiryDate || null) : null,
        };
        if (it.lineType === 'ACTIVO_FIJO') {
          const fa = it.fixedAsset || {};
          base.fixedAsset = {
            ...fa,
            category: fa.category || null, assetType: fa.assetType || null, locationClinic: fa.locationClinic || null,
            assetAccount: fa.assetAccount || null, depreciationAccount: fa.depreciationAccount || null, accumDepreciationAccount: fa.accumDepreciationAccount || null,
            acquisitionDate: fa.acquisitionDate || null, startDate: fa.startDate || null,
          };
        } else {
          base.fixedAsset = null;
        }
        return base;
      });
      const payload = { ...form, items, serie, costCenter: form.costCenter || null, fechaVencimiento: form.fechaVencimiento || null, fechaEmision: new Date(form.fechaEmision) };
      if (authorizeId) {
        await api.post(`/purchase-invoices/${authorizeId}/authorize`, payload);
        toast.success('Factura contabilizada');
      } else if (editId) {
        await api.put(`/purchase-invoices/${editId}`, payload);
        toast.success('Cambios guardados');
      } else {
        await api.post('/purchase-invoices', payload);
        toast.success('Registrada');
      }
      setShow(false); setForm(EMPTY); setAuthorizeId(null); setEditId(null); load();
    } catch (err) { toast.error(err.response?.data?.message || 'Error'); }
  };

  // Carga una factura existente en el form. mode: 'authorize' (contabilizar) | 'edit'.
  const loadIntoForm = async (p, mode) => {
    try {
      const r = await api.get(`/purchase-invoices/${p._id}`);
      const d = r.data;
      setForm({
        ...EMPTY, ...d,
        supplier: d.supplier?._id || d.supplier || '',
        fechaEmision: d.fechaEmision ? d.fechaEmision.slice(0, 10) : today(),
        fechaVencimiento: d.fechaVencimiento ? String(d.fechaVencimiento).slice(0, 10) : '',
        costCenter: d.costCenter?._id || d.costCenter || '',
        items: (d.items || []).map((it) => ({ ...EMPTY_ITEM, ...it, lineType: it.lineType || (it.product ? 'INVENTARIO' : 'GASTO'), fixedAsset: it.fixedAsset ? { ...EMPTY_FA, ...it.fixedAsset, category: it.fixedAsset.category?._id || it.fixedAsset.category || '', assetType: it.fixedAsset.assetType?._id || it.fixedAsset.assetType || '', locationClinic: it.fixedAsset.locationClinic?._id || it.fixedAsset.locationClinic || '', assetAccount: it.fixedAsset.assetAccount?._id || it.fixedAsset.assetAccount || '', acquisitionDate: it.fixedAsset.acquisitionDate ? String(it.fixedAsset.acquisitionDate).slice(0, 10) : '', startDate: it.fixedAsset.startDate ? String(it.fixedAsset.startDate).slice(0, 10) : '' } : { ...EMPTY_FA }, account: it.account?._id || it.account || '', product: it.product?._id || it.product || '', warehouse: it.warehouse?._id || it.warehouse || '', costCenter: it.costCenter?._id || it.costCenter || '', expiryDate: it.expiryDate ? String(it.expiryDate).slice(0, 10) : '', accountSplits: (it.accountSplits || []).map((s) => ({ ...s, account: s.account?._id || s.account || '' })) })),
        retentions: d.retentions || [],
      });
      if (mode === 'edit') { setEditId(p._id); setAuthorizeId(null); }
      else { setAuthorizeId(p._id); setEditId(null); }
      setShow(true);
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  const openAuthorize = (p) => loadIntoForm(p, 'authorize');
  const openEdit = (p) => loadIntoForm(p, 'edit');

  const emitRetention = async (p) => {
    if (!confirm('¿Emitir el comprobante de retención electrónico de esta compra?')) return;
    try { await api.post(`/retention-vouchers/from-purchase/${p._id}`); toast.success('Retención emitida'); load(); }
    catch (e) { toast.error(e.response?.data?.message || 'Error al emitir retención'); }
  };

  const voidIt = async (p) => {
    if (!confirm('¿Anular?')) return;
    try { await api.post(`/purchase-invoices/${p._id}/void`); load(); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  // Elimina una factura individual (y sus asientos/CxP/inventario asociados).
  const removeOne = async (p) => {
    if (!confirm(`¿Eliminar la factura ${p.serie || ''} de ${p.supplier?.razonSocial || ''}? Esta acción no se puede deshacer.`)) return;
    const call = (force) => api.delete(`/purchase-invoices/${p._id}`, force ? { params: { force: 'true' } } : undefined);
    try {
      await call(false);
      toast.success('Factura eliminada');
      load();
    } catch (e) {
      if (e.response?.status === 409 && confirm(`${e.response.data.message}\n\n¿Eliminar de todas formas?`)) {
        try { await call(true); toast.success('Factura eliminada'); load(); }
        catch (e2) { toast.error(e2.response?.data?.message || 'Error'); }
      } else {
        toast.error(e.response?.data?.message || 'Error');
      }
    }
  };

  const openPay = (p) => {
    setPayInv(p);
    setPayForm({ method: 'TRANSFERENCIA', bankAccount: '', voucherNumber: '', checkNumber: '', amount: +(p.balance ?? p.total ?? 0).toFixed(2), date: today() });
  };

  const submitPay = async () => {
    const p = payInv;
    const amount = +payForm.amount;
    if (!(amount > 0)) return toast.error('Monto inválido');
    if (payForm.method !== 'EFECTIVO' && !payForm.bankAccount) return toast.error('Selecciona la cuenta bancaria');
    if (payForm.method === 'TRANSFERENCIA' && !payForm.voucherNumber) return toast.error('Ingresa el N° de comprobante de la transferencia');
    if (payForm.method === 'CHEQUE' && !payForm.checkNumber) return toast.error('Ingresa el N° de cheque');
    try {
      await api.post('/payments', {
        type: 'PAGO', date: payForm.date,
        partyModel: 'Supplier', partyRef: p.supplier?._id || p.supplier, partyName: p.supplier?.razonSocial || '',
        method: payForm.method,
        bankAccount: payForm.method === 'EFECTIVO' ? null : payForm.bankAccount,
        voucherNumber: payForm.method === 'TRANSFERENCIA' ? payForm.voucherNumber : undefined,
        checkNumber: payForm.method === 'CHEQUE' ? payForm.checkNumber : undefined,
        applications: [{ docModel: 'PurchaseInvoice', docRef: p._id, amount }],
      });
      toast.success('Pago registrado');
      setPayInv(null); load();
    } catch (e) { toast.error(e.response?.data?.message || 'Error al registrar el pago'); }
  };

  const submitImport = async () => {
    if (importing) return; // evita doble envío
    if (importMode === 'xml' && !xmlContents.length) return toast.error('Carga al menos un archivo XML');
    if (importMode === 'txt' && !importTxt.trim()) return toast.error('Carga un archivo .txt');
    setImporting(true);
    try {
      const r = importMode === 'xml'
        ? await api.post('/purchase-invoices/import-xml', { xmls: xmlContents }, { timeout: 120000 })
        : await api.post('/purchase-invoices/import-txt', { text: importTxt }, { timeout: 120000 });
      const { created = 0, skipped = 0, errors = [] } = r.data || {};
      if (created === 0 && errors.length) {
        const first = errors[0];
        toast.error(`No se importó ninguna fila. ${errors.length} con error. Ej. línea ${first.line || first.index || '?'}: ${first.error || ''}`);
      } else if (created === 0 && skipped > 0) {
        toast(`Nada nuevo: las ${skipped} facturas del archivo ya estaban registradas.`, { icon: 'ℹ️' });
      } else {
        toast.success(`${created} importada(s)${skipped ? `, ${skipped} repetida(s)` : ''}${errors.length ? `, ${errors.length} con error` : ''}`);
        if (created) toast('Quedan POR CONTABILIZAR. Revísalas y contabilízalas.', { icon: 'ℹ️' });
      }
      // Siempre cierra el modal y recarga la lista para que el usuario vea el resultado.
      setShowImport(false); setXmlContents([]); setImportTxt(''); setImportTxtName(''); load();
    } catch (e) {
      const msg = e.code === 'ECONNABORTED' ? 'La importación tardó demasiado. Intenta con un archivo más pequeño o reintenta.' : (e.response?.data?.message || 'Error al importar');
      toast.error(msg);
    } finally {
      setImporting(false);
    }
  };

  // Reinicio de compras: borra todas las facturas de esta sucursal (importaciones erróneas).
  const wipeAll = async () => {
    const phrase = window.prompt('⚠ Esto BORRARÁ todas las facturas de COMPRAS de esta sucursal y sus asientos, CxP e inventario asociados. Esta acción no se puede deshacer.\n\nEscribe BORRAR-COMPRAS para confirmar:');
    if (phrase !== 'BORRAR-COMPRAS') { if (phrase !== null) toast.error('Texto de confirmación incorrecto'); return; }
    const callWipe = async (force) => api.post('/purchase-invoices/wipe', { confirm: 'BORRAR-COMPRAS', ...(force ? { force: true } : {}) });
    try {
      const r = await callWipe(false);
      toast.success(`Borradas ${r.data.invoices} compra(s)`);
      load();
    } catch (e) {
      if (e.response?.status === 409 && window.confirm(`${e.response.data.message}\n\n¿Borrar de todas formas (los pagos quedarán inconsistentes)?`)) {
        try { const r2 = await callWipe(true); toast.success(`Borradas ${r2.data.invoices} compra(s)`); load(); }
        catch (e2) { toast.error(e2.response?.data?.message || 'Error'); }
      } else {
        toast.error(e.response?.data?.message || 'Error');
      }
    }
  };

  const onXmlFiles = (files) => {
    const arr = Array.from(files || []);
    if (!arr.length) return;
    Promise.all(arr.map((f) => f.text())).then((texts) => setXmlContents((prev) => [...prev, ...texts]));
  };

  const setItem = (i, patch) => {
    const items = [...form.items]; items[i] = { ...items[i], ...patch }; setForm({ ...form, items });
  };

  // Tras crear un producto desde la factura: refresca catálogo y lo autoselecciona en la línea.
  const handleNewProductSaved = async (saved) => {
    await loadProducts();
    const idx = newProductItemIdx;
    if (idx != null && saved?._id) {
      setForm((prev) => {
        const items = [...prev.items];
        const cur = items[idx] || {};
        items[idx] = { ...cur, product: saved._id, description: cur.description || saved.name };
        return { ...prev, items };
      });
    }
    setNewProductItemIdx(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineDocumentText className="text-emerald-600" /> Compras
          {pendingTotal > 0 && <span className="text-xs font-medium px-2 py-0.5 bg-amber-100 text-amber-700 rounded-full">{pendingTotal} por contabilizar</span>}
        </h1>
        <div className="flex gap-2">
          {hasRole('admin') && <button onClick={wipeAll} title="Borrar todas las compras de esta sucursal (reinicio)" className="px-4 py-2 bg-rose-600 text-white rounded-lg flex items-center gap-2"><HiOutlineXMark /> Reiniciar compras</button>}
          <button onClick={() => { setImportMode('xml'); setShowImport(true); }} className="px-4 py-2 bg-amber-500 text-white rounded-lg flex items-center gap-2"><HiOutlineArrowDownTray /> Importar SRI</button>
          <button onClick={() => { setForm(EMPTY); setAuthorizeId(null); setEditId(null); setShow(true); }} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center gap-2"><HiOutlinePlus /> Nueva</button>
        </div>
      </div>

      {/* Buscador */}
      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-3 flex flex-wrap items-center gap-3">
        <input aria-label="Buscar factura de compra" placeholder="Buscar por proveedor, RUC, serie, autorización, clave de acceso..." value={search} onChange={(e) => setSearch(e.target.value)} className="flex-1 min-w-[260px] border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" />
        <select aria-label="Filtrar por estado" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm">
          <option value="">Todos los estados</option>
          <option value="POR_AUTORIZAR">Por contabilizar</option>
          <option value="REGISTRADA">Registrada</option>
          <option value="PAGADA">Pagada</option>
          <option value="ANULADA">Anulada</option>
        </select>
        <select aria-label="Ordenar" value={sort} onChange={(e) => setSort(e.target.value)} className="border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" title="Ordenar la lista">
          <optgroup label="Por fecha">
            <option value="fecha_desc">Más recientes primero</option>
            <option value="fecha_asc">Más antiguas primero</option>
          </optgroup>
          <optgroup label="Por monto">
            <option value="total_desc">Monto: de mayor a menor</option>
            <option value="total_asc">Monto: de menor a mayor</option>
          </optgroup>
        </select>
      </div>
      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden">
        <table className="tbl">
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
                <td className="px-3 py-2 text-center text-xs">
                  <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${p.status === 'POR_AUTORIZAR' ? 'bg-amber-100 text-amber-700' : p.status === 'REGISTRADA' ? 'bg-emerald-100 text-emerald-700' : p.status === 'PAGADA' ? 'bg-sky-100 text-sky-700' : 'bg-rose-100 text-rose-700'}`}>{p.status === 'POR_AUTORIZAR' ? 'POR CONTABILIZAR' : p.status}{p.importedFromXml ? ' · XML' : ''}</span>
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="flex items-center justify-end gap-2">
                    {p.status === 'POR_AUTORIZAR' && <button onClick={() => openAuthorize(p)} className="text-emerald-600 text-xs font-medium hover:underline">Verificar / Contabilizar</button>}
                    {p.status === 'REGISTRADA' && <button onClick={() => openEdit(p)} className="text-slate-600 text-xs font-medium hover:underline">Editar</button>}
                    {p.status === 'REGISTRADA' && p.balance > 0 && <button onClick={() => openPay(p)} className="text-sky-600 text-xs font-medium hover:underline">Pagar</button>}
                    {(p.status === 'REGISTRADA' || p.status === 'PAGADA') && p.journalEntry && <button onClick={() => setJournalInv(p)} className="text-slate-600 text-xs font-medium hover:underline">Asiento</button>}
                    {p.status !== 'ANULADA' && p.retentionTotal > 0 && !p.retentionVoucher && (
                      <button onClick={() => emitRetention(p)} className="text-indigo-600 text-xs font-medium hover:underline">Emitir retención</button>
                    )}
                    {p.status === 'REGISTRADA' && <button onClick={() => voidIt(p)} className="text-amber-600" title="Anular (reversa el asiento, conserva el registro)"><HiOutlineXMark className="w-4 h-4" /></button>}
                    <button onClick={() => removeOne(p)} className="text-rose-600" title="Eliminar factura"><HiOutlineTrash className="w-4 h-4" /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex items-center justify-between gap-3 px-3 py-2.5 border-t border-slate-100 text-sm text-slate-600">
          <span>{total} factura(s){total > PAGE_SIZE ? ` · mostrando ${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, total)}` : ''}</span>
          {total > PAGE_SIZE && (
            <div className="flex items-center gap-2">
              <button disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} className="px-3 py-1 rounded-lg border border-slate-200 disabled:opacity-40 hover:bg-slate-50">Anterior</button>
              <span className="text-xs">Página {page} de {Math.max(1, Math.ceil(total / PAGE_SIZE))}</span>
              <button disabled={page >= Math.ceil(total / PAGE_SIZE)} onClick={() => setPage((p) => p + 1)} className="px-3 py-1 rounded-lg border border-slate-200 disabled:opacity-40 hover:bg-slate-50">Siguiente</button>
            </div>
          )}
        </div>
      </div>

      <Modal isOpen={show} onClose={() => { setShow(false); setAuthorizeId(null); setEditId(null); }} title={authorizeId ? 'Verificar y contabilizar factura' : editId ? 'Editar factura de compra' : 'Nueva factura de compra'} size="2xl">
        <form onSubmit={submit} className="space-y-3">
          {authorizeId && <div className="bg-amber-50 border border-amber-200 text-amber-800 text-xs rounded-lg px-3 py-2">Factura cargada automáticamente. Verifica los datos y asigna la cuenta contable de cada ítem antes de contabilizar.</div>}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-x-3 gap-y-2.5">
            <Field label="Proveedor" required className="col-span-2">
              <SearchableSelect
                options={suppliers}
                value={form.supplier}
                onChange={onSelectSupplier}
                getLabel={(s) => `${s.ruc} - ${s.razonSocial}`}
                getSearchText={(s) => `${s.ruc} ${s.razonSocial} ${s.nombreComercial || ''}`}
                placeholder="Seleccione un proveedor…"
                searchPlaceholder="Buscar por RUC o nombre…"
              />
            </Field>
            <Field label="Tipo de documento">
              <select value={form.docType} onChange={(e) => setForm({ ...form, docType: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm bg-white">
                <option>FACTURA</option><option>NOTA_VENTA</option><option>LIQUIDACION</option><option>NOTA_DEBITO_REC</option><option>NOTA_CREDITO_REC</option>
              </select>
            </Field>
            <Field label="Fecha de emisión" required><input type="date" required value={form.fechaEmision} onChange={(e) => setForm((f) => ({ ...f, fechaEmision: e.target.value, fechaVencimiento: f.creditDays ? addDays(e.target.value, f.creditDays) : f.fechaVencimiento }))} className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm" /></Field>
            <Field label="Establecimiento"><input placeholder="001" value={form.estab} onChange={(e) => setForm({ ...form, estab: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm" /></Field>
            <Field label="Punto de emisión"><input placeholder="001" value={form.ptoEmi} onChange={(e) => setForm({ ...form, ptoEmi: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm" /></Field>
            <Field label="Secuencial" required><input required placeholder="000000123" value={form.secuencial} onChange={(e) => setForm({ ...form, secuencial: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm" /></Field>
            <Field label="N° de autorización SRI"><input placeholder="Opcional" value={form.autorizacion} onChange={(e) => setForm({ ...form, autorizacion: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm" /></Field>
            <Field label="Días de crédito"><NumericInput value={form.creditDays} onChange={(e) => setForm((f) => ({ ...f, creditDays: +e.target.value, fechaVencimiento: +e.target.value > 0 ? addDays(f.fechaEmision, +e.target.value) : '' }))} className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm text-right" /></Field>
            <Field label="Vencimiento"><input type="date" value={form.fechaVencimiento || ''} onChange={(e) => setForm({ ...form, fechaVencimiento: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm" /></Field>
            <Field label="Centro de costo (factura)" className="col-span-2">
              <SearchableSelect options={costCenters} value={form.costCenter} onChange={setInvoiceCostCenter} getLabel={(c) => `${c.code} - ${c.name}`} getSearchText={(c) => `${c.code} ${c.name}`} placeholder="— sin centro —" searchPlaceholder="Buscar centro…" allowClear />
            </Field>
          </div>
          {recurring.accounts.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs bg-emerald-50/60 border border-emerald-100 rounded-lg px-2 py-1.5">
              <span className="text-slate-500 font-medium">Cuentas frecuentes:</span>
              {recurring.accounts.map((a) => (
                <button type="button" key={a._id} onClick={() => applyRecurring(a._id)} title={`Usar ${a.code} ${a.name} en los ítems sin cuenta`} className="px-2 py-0.5 rounded-full bg-white text-emerald-700 border border-emerald-200 hover:bg-emerald-100">
                  {a.code} {a.name}{a.forSupplier ? ' ★' : ''}
                </button>
              ))}
            </div>
          )}
          <div className="text-[11px] text-slate-400">El IVA y la cuenta de Proveedores (CxP) se calculan automáticamente. El contador solo escoge la cuenta de gasto (o distribuye en varias).</div>
          <div className="space-y-3">
            {form.items.map((it, i) => {
              const splits = it.accountSplits || [];
              const hasSplits = splits.length > 0;
              const itemBase = +((it.quantity || 0) * (it.unitPrice || 0) - (it.discount || 0)).toFixed(2);
              const splitSum = +splits.reduce((s, sp) => s + (+sp.amount || 0), 0).toFixed(2);
              const splitOk = Math.abs(splitSum - itemBase) < 0.01;
              const setSplit = (j, patch) => { const sp = [...splits]; sp[j] = { ...sp[j], ...patch }; setItem(i, { accountSplits: sp }); };
              return (
                <div key={i} className="border border-slate-200 rounded-xl p-3 bg-slate-50/40 space-y-2.5">
                  <div className="flex items-start gap-2">
                    <Field label={`Descripción${form.items.length > 1 ? ` · ítem ${i + 1}` : ''}`} required className="flex-1">
                      <input required value={it.description} onChange={(e) => setItem(i, { description: e.target.value })} className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" placeholder="Detalle del bien o servicio" />
                    </Field>
                    {form.items.length > 1 && (
                      <button type="button" onClick={() => setForm({ ...form, items: form.items.filter((_, x) => x !== i) })} className="mt-6 shrink-0 text-rose-500 hover:text-rose-600" title="Quitar ítem"><HiOutlineXMark className="w-5 h-5" /></button>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Tipo de línea">
                      <select value={it.lineType || 'GASTO'} onChange={(e) => setItem(i, { lineType: e.target.value, accountSplits: e.target.value === 'GASTO' ? it.accountSplits : [], product: e.target.value === 'INVENTARIO' ? it.product : '' })} className="w-full border border-slate-200 rounded-lg px-2 py-2 text-sm bg-white">
                        {LINE_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                    </Field>
                    <Field label="Centro de costo (línea)">
                      <SearchableSelect options={costCenters} value={it.costCenter} onChange={(v) => setItem(i, { costCenter: v })} getLabel={(c) => `${c.code} - ${c.name}`} getSearchText={(c) => `${c.code} ${c.name}`} placeholder="— sin centro —" searchPlaceholder="Buscar centro…" allowClear size="sm" />
                    </Field>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                    <Field label="Cantidad"><NumericInput step="0.01" value={it.quantity} onChange={(e) => setItem(i, { quantity: +e.target.value })} className="w-full border border-slate-200 rounded-lg px-2 py-2 text-sm text-right" /></Field>
                    <Field label="P. unitario"><NumericInput step="0.01" value={it.unitPrice} onChange={(e) => setItem(i, { unitPrice: +e.target.value })} className="w-full border border-slate-200 rounded-lg px-2 py-2 text-sm text-right" /></Field>
                    <Field label="Descuento"><NumericInput step="0.01" value={it.discount} onChange={(e) => setItem(i, { discount: +e.target.value })} className="w-full border border-slate-200 rounded-lg px-2 py-2 text-sm text-right" /></Field>
                    <Field label="IVA %">
                      <select value={it.ivaRate} onChange={(e) => setItem(i, { ivaRate: +e.target.value })} className="w-full border border-slate-200 rounded-lg px-2 py-2 text-sm bg-white">
                        <option value={0}>0%</option><option value={12}>12%</option><option value={15}>15%</option><option value={-1}>No obj</option><option value={-2}>Exento</option>
                      </select>
                    </Field>
                    <Field label="Subtotal"><div className="w-full border border-slate-200 rounded-lg px-2 py-2 text-sm text-right bg-slate-100 font-mono text-slate-700">{fmt(itemBase)}</div></Field>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <Field label={it.lineType === 'INVENTARIO' ? 'Cuenta de inventario (activo)' : it.lineType === 'ACTIVO_FIJO' ? 'Cuenta de activo fijo' : 'Cuenta de gasto'} required={!hasSplits}>
                      {hasSplits ? (
                        <div className="flex items-center justify-between border border-slate-200 rounded-xl px-3 py-2.5 text-sm bg-white text-slate-500 italic">
                          Distribuido en {splits.length} cuentas
                          <button type="button" onClick={() => setItem(i, { accountSplits: [] })} className="not-italic text-sky-600 text-xs">usar una</button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <SearchableSelect options={accounts} value={it.account} onChange={(v) => setItem(i, { account: v })} getLabel={(a) => `${a.code} ${a.name}`} placeholder="Elegir cuenta…" searchPlaceholder="Buscar por código o nombre…" className="flex-1" />
                          {it.lineType === 'GASTO' && <button type="button" title="Distribuir en varias cuentas" onClick={() => setItem(i, { accountSplits: [{ account: it.account || '', amount: itemBase, description: '' }] })} className="text-xs text-sky-600 whitespace-nowrap">➗ varias</button>}
                        </div>
                      )}
                    </Field>
                    {it.lineType === 'INVENTARIO' && (
                      <Field label="Producto" required hint="Insumo que entra a stock">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 min-w-0">
                            <SearchableSelect options={products} value={it.product} onChange={(v) => setItem(i, { product: v, warehouse: v ? it.warehouse : '' })} getLabel={(p) => p.name} placeholder="Selecciona producto…" searchPlaceholder="Buscar producto…" allowClear />
                          </div>
                          <button type="button" onClick={() => setNewProductItemIdx(i)} title="Crear producto nuevo en inventario" className="shrink-0 px-2.5 py-2 text-sm rounded-lg border border-emerald-200 text-emerald-700 hover:bg-emerald-50 flex items-center gap-1 whitespace-nowrap bg-white cursor-pointer">
                            <HiOutlinePlus className="w-4 h-4" /> Nuevo
                          </button>
                        </div>
                      </Field>
                    )}
                  </div>
                  {it.lineType === 'INVENTARIO' && it.product && (
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <Field label="Bodega"><SearchableSelect options={[{ _id: '', name: 'General' }, ...warehouses]} value={it.warehouse} onChange={(v) => setItem(i, { warehouse: v })} getLabel={(w) => w.name} placeholder="General" searchPlaceholder="Buscar bodega…" /></Field>
                      <Field label="Lote"><input value={it.lot || ''} onChange={(e) => setItem(i, { lot: e.target.value })} className="w-full border border-slate-200 rounded-lg px-2 py-2 text-sm" placeholder="Opcional" /></Field>
                      <Field label="Caducidad"><input type="date" value={it.expiryDate ? String(it.expiryDate).slice(0, 10) : ''} onChange={(e) => setItem(i, { expiryDate: e.target.value })} className="w-full border border-slate-200 rounded-lg px-2 py-2 text-sm" /></Field>
                    </div>
                  )}
                  {it.lineType === 'ACTIVO_FIJO' && (
                    <FixedAssetFields i={i} fa={it.fixedAsset || {}} categories={assetCategories} clinics={clinics} accounts={accounts} onCategory={onItemAssetCategory} setFa={setFa} />
                  )}
                  {hasSplits && (
                    <div className="bg-white border border-slate-200 rounded-lg p-2.5">
                      <div className="text-xs font-semibold text-slate-600 mb-1.5">Distribución de cuentas (subtotal {fmt(itemBase)})</div>
                      {splits.map((sp, j) => (
                        <div key={j} className="flex items-center gap-2 mb-1.5">
                          <SearchableSelect options={accounts} value={sp.account} onChange={(v) => setSplit(j, { account: v })} getLabel={(a) => `${a.code} ${a.name}`} placeholder="Cuenta…" searchPlaceholder="Buscar cuenta…" className="flex-1" size="sm" />
                          <NumericInput step="0.01" placeholder="Monto" value={sp.amount} onChange={(e) => setSplit(j, { amount: +e.target.value })} className="border border-slate-200 rounded-lg px-2 py-1.5 text-xs w-28 text-right" />
                          <input placeholder="Detalle" value={sp.description} onChange={(e) => setSplit(j, { description: e.target.value })} className="border border-slate-200 rounded-lg px-2 py-1.5 text-xs flex-1 min-w-0" />
                          <button type="button" onClick={() => setItem(i, { accountSplits: splits.filter((_, x) => x !== j) })} className="text-rose-500 shrink-0">×</button>
                        </div>
                      ))}
                      <div className="flex items-center gap-3 mt-1">
                        <button type="button" onClick={() => setItem(i, { accountSplits: [...splits, { account: '', amount: +(itemBase - splitSum).toFixed(2), description: '' }] })} className="text-emerald-600 text-xs">+ cuenta</button>
                        <span className={`text-xs ${splitOk ? 'text-emerald-600' : 'text-rose-600'}`}>Suma: {fmt(splitSum)} / {fmt(itemBase)} {splitOk ? '✓' : '✗'}</span>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <button type="button" onClick={() => setForm({ ...form, items: [...form.items, { ...EMPTY_ITEM }] })} className="text-emerald-600 text-sm flex items-center gap-1"><HiOutlinePlus /> Agregar ítem</button>

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
            {form.retentions.length > 0 && (
              <div className="grid grid-cols-6 gap-2 mt-1 text-[11px] text-slate-400 uppercase px-1">
                <span>Tipo</span><span>Código</span><span>Base</span><span>%</span><span>Monto</span><span></span>
              </div>
            )}
            {form.retentions.map((r, i) => (
              <div key={i} className="grid grid-cols-6 gap-2 mt-1 text-xs">
                <select value={r.type} onChange={(e) => { const rs = [...form.retentions]; rs[i].type = e.target.value; setForm({ ...form, retentions: rs }); }} className="border rounded px-2 py-1"><option>IVA</option><option>RENTA</option></select>
                <input placeholder="Código" value={r.code} onChange={(e) => { const rs = [...form.retentions]; rs[i].code = e.target.value; setForm({ ...form, retentions: rs }); }} className="border rounded px-2 py-1" />
                <NumericInput step="0.01" placeholder="Base" value={r.baseAmount} onChange={(e) => { const rs = [...form.retentions]; rs[i].baseAmount = +e.target.value; rs[i].amount = +(rs[i].baseAmount * (rs[i].percentage || 0) / 100).toFixed(2); setForm({ ...form, retentions: rs }); }} className="border rounded px-2 py-1" />
                <NumericInput step="0.01" placeholder="%" value={r.percentage} onChange={(e) => { const rs = [...form.retentions]; rs[i].percentage = +e.target.value; rs[i].amount = +(rs[i].baseAmount * rs[i].percentage / 100).toFixed(2); setForm({ ...form, retentions: rs }); }} className="border rounded px-2 py-1" />
                <NumericInput step="0.01" placeholder="Monto" value={r.amount} onChange={(e) => { const rs = [...form.retentions]; rs[i].amount = +e.target.value; setForm({ ...form, retentions: rs }); }} className="border rounded px-2 py-1" />
                <button type="button" onClick={() => setForm({ ...form, retentions: form.retentions.filter((_, x) => x !== i) })} className="text-rose-600">×</button>
              </div>
            ))}
            <button type="button" onClick={() => setForm({ ...form, retentions: [...form.retentions, { type: 'RENTA', code: '', baseAmount: 0, percentage: 0, amount: 0 }] })} className="text-emerald-600 text-xs mt-1">+ Retención</button>
            <Field label="N° comprobante de retención" className="mt-2"><input placeholder="Opcional" value={form.retentionNumber} onChange={(e) => setForm({ ...form, retentionNumber: e.target.value })} className="block w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
          </div>

          <div className="flex justify-end gap-2"><button type="button" onClick={() => { setShow(false); setAuthorizeId(null); setEditId(null); }} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button><button className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20">{authorizeId ? 'Contabilizar' : editId ? 'Guardar cambios' : 'Registrar'}</button></div>
        </form>
      </Modal>

      <Modal isOpen={showImport} onClose={() => setShowImport(false)} title="Importar comprobantes del SRI" size="lg">
        <div className="flex gap-2 mb-3 border-b">
          <button onClick={() => setImportMode('xml')} className={`px-3 py-2 text-sm font-medium border-b-2 ${importMode === 'xml' ? 'border-emerald-600 text-emerald-700' : 'border-transparent text-slate-500'}`}>XML (factura electrónica)</button>
          <button onClick={() => setImportMode('txt')} className={`px-3 py-2 text-sm font-medium border-b-2 ${importMode === 'txt' ? 'border-emerald-600 text-emerald-700' : 'border-transparent text-slate-500'}`}>TXT (anexo SRI)</button>
        </div>
        {importMode === 'xml' ? (
          <div>
            <p className="text-xs text-slate-500 mb-2">Carga uno o varios archivos XML de facturas electrónicas recibidas. Se cargarán como <b>POR CONTABILIZAR</b> para que el área contable las verifique antes de contabilizar.</p>
            <input
              aria-label="Cargar archivos XML"
              type="file" accept=".xml,text/xml,application/xml" multiple
              onChange={(e) => onXmlFiles(e.target.files)}
              className="block w-full text-sm text-slate-600 file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border-0 file:bg-emerald-600 file:text-white file:cursor-pointer"
            />
            {!!xmlContents.length && (
              <div className="mt-2 flex items-center justify-between text-sm bg-emerald-50 rounded-lg px-3 py-2">
                <span>{xmlContents.length} archivo(s) XML listos para importar</span>
                <button onClick={() => setXmlContents([])} className="text-rose-600 text-xs">Limpiar</button>
              </div>
            )}
          </div>
        ) : (
          <div>
            <p className="text-xs text-slate-500 mb-2">Carga el archivo <b>.txt</b> del reporte del SRI <b>“Comprobantes electrónicos recibidos”</b> (separado por tabulación). Columnas: <code>RUC_EMISOR · RAZON_SOCIAL_EMISOR · TIPO_COMPROBANTE · SERIE_COMPROBANTE · CLAVE_ACCESO · FECHA_AUTORIZACION · FECHA_EMISION · IDENTIFICACION_RECEPTOR · VALOR_SIN_IMPUESTOS · IVA · IMPORTE_TOTAL</code>. Se reconoce la cabecera automáticamente. Las facturas quedan <b>POR CONTABILIZAR</b> para asignar cuentas/inventario.</p>
            <label className="block text-xs font-medium text-slate-600 mb-1">Cargar archivo .txt</label>
            <input
              type="file" accept=".txt,text/plain,.csv,text/csv"
              onChange={(e) => { const f = e.target.files?.[0]; if (!f) return; const reader = new FileReader(); reader.onload = (ev) => { setImportTxt(String(ev.target?.result || '')); setImportTxtName(f.name); }; reader.readAsText(f, 'utf-8'); e.target.value = ''; }}
              className="block w-full text-sm text-slate-600 file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border-0 file:bg-emerald-600 file:text-white file:cursor-pointer"
            />
            {importTxt.trim() ? (
              <div className="mt-2 flex items-center justify-between text-sm bg-emerald-50 rounded-lg px-3 py-2">
                <span>📄 <b>{importTxtName || 'archivo.txt'}</b>: {importTxt.split(/\r?\n/).filter((l) => l.trim()).length} línea(s) detectada(s).</span>
                <button onClick={() => { setImportTxt(''); setImportTxtName(''); }} className="text-rose-600 text-xs">Quitar</button>
              </div>
            ) : (
              <p className="text-xs text-slate-400 mt-2">Aún no has cargado ningún archivo.</p>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2 mt-3"><button onClick={() => setShowImport(false)} disabled={importing} className="px-4 py-2 bg-slate-200 rounded-xl disabled:opacity-50">Cancelar</button><button onClick={submitImport} disabled={importing} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 disabled:opacity-60">{importing ? 'Importando…' : 'Importar'}</button></div>
      </Modal>

      {/* Editor del asiento contable (debe/haber) de la compra */}
      {journalInv && (
        <JournalEntryEditor
          isOpen={!!journalInv}
          onClose={() => setJournalInv(null)}
          entryId={journalInv.journalEntry?._id || journalInv.journalEntry}
          postUrl={`/purchase-invoices/${journalInv._id}/journal`}
          title={`Asiento de compra ${journalInv.serie || ''}`}
          onSaved={load}
        />
      )}

      {/* Pago de la factura (CxP) → genera el movimiento bancario para conciliación */}
      <Modal isOpen={!!payInv} onClose={() => setPayInv(null)} title={`Pagar compra ${payInv?.serie || ''}`} size="md">
        {payInv && (
          <div className="space-y-3">
            <div className="bg-slate-50 rounded-lg px-3 py-2 text-sm flex justify-between">
              <span>{payInv.supplier?.razonSocial}</span>
              <span>Saldo: <b>${fmt(payInv.balance ?? payInv.total)}</b></span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Método">
                <select value={payForm.method} onChange={(e) => setPayForm({ ...payForm, method: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5">
                  <option value="TRANSFERENCIA">Transferencia</option>
                  <option value="CHEQUE">Cheque</option>
                  <option value="EFECTIVO">Efectivo</option>
                </select>
              </Field>
              <Field label="Fecha"><input type="date" value={payForm.date} onChange={(e) => setPayForm({ ...payForm, date: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
              {payForm.method !== 'EFECTIVO' && (
                <Field label="Cuenta bancaria" required className="col-span-2">
                  <SearchableSelect options={banks} value={payForm.bankAccount} onChange={(v) => setPayForm({ ...payForm, bankAccount: v })} getLabel={(b) => `${b.name} — ${b.bank}`} placeholder="Seleccione…" searchPlaceholder="Buscar banco…" />
                </Field>
              )}
              {payForm.method === 'TRANSFERENCIA' && (
                <Field label="N° comprobante" required className="col-span-2"><input value={payForm.voucherNumber} onChange={(e) => setPayForm({ ...payForm, voucherNumber: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" placeholder="N° de transferencia" /></Field>
              )}
              {payForm.method === 'CHEQUE' && (
                <Field label="N° de cheque" required className="col-span-2"><input value={payForm.checkNumber} onChange={(e) => setPayForm({ ...payForm, checkNumber: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" placeholder="N° de cheque" /></Field>
              )}
              <Field label="Monto a pagar" required className="col-span-2"><NumericInput step="0.01" value={payForm.amount} onChange={(e) => setPayForm({ ...payForm, amount: +e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-right" /></Field>
            </div>
            <div className="flex justify-end gap-2"><button onClick={() => setPayInv(null)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button><button onClick={submitPay} className="px-4 py-2 bg-sky-600 text-white rounded-xl shadow-sm shadow-sky-600/20">Registrar pago</button></div>
          </div>
        )}
      </Modal>

      {/* Crear producto nuevo al vuelo desde una línea de inventario */}
      <ProductFormModal
        isOpen={newProductItemIdx !== null}
        onClose={() => setNewProductItemIdx(null)}
        editingProduct={null}
        initialValues={newProductItemIdx !== null ? {
          name: form.items[newProductItemIdx]?.description || '',
          purchasePrice: form.items[newProductItemIdx]?.unitPrice || '',
          taxRate: form.items[newProductItemIdx]?.ivaRate ?? 15,
        } : null}
        products={products}
        clinicsList={clinics}
        onSaved={handleNewProductSaved}
      />
    </div>
  );
}

// Campos de captura de activo fijo en una línea de compra (espejo del modal "Nuevo activo fijo").
function FixedAssetFields({ i, fa, categories, clinics, onCategory, setFa }) {
  const roots = categories.filter((c) => !c.parent);
  const types = categories.filter((c) => c.parent && String(c.parent) === String(fa.category));
  const inp = 'w-full border border-slate-200 rounded-lg px-2 py-2 text-sm';
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-2.5 space-y-2">
      <div className="text-xs font-semibold text-slate-600">Datos del activo fijo</div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <Field label="Categoría">
          <SearchableSelect options={roots} value={fa.category || ''} onChange={(v) => onCategory(i, v)} getLabel={(c) => `${c.code} - ${c.name}`} getSearchText={(c) => `${c.code} ${c.name}`} placeholder="Seleccione…" searchPlaceholder="Buscar categoría…" allowClear size="sm" />
        </Field>
        <Field label="Tipo de activo">
          <SearchableSelect options={types} value={fa.assetType || ''} onChange={(v) => setFa(i, { assetType: v })} getLabel={(c) => c.name} placeholder={types.length ? 'Seleccione…' : 'Sin tipos'} searchPlaceholder="Buscar tipo…" allowClear size="sm" />
        </Field>
        <Field label="Código"><input value={fa.code || ''} onChange={(e) => setFa(i, { code: e.target.value })} placeholder="Auto (AF-####)" className={inp} /></Field>
        <Field label="Nombre"><input value={fa.name || ''} onChange={(e) => setFa(i, { name: e.target.value })} placeholder="Ej: Ecógrafo" className={inp} /></Field>
        <Field label="Serial"><input value={fa.serial || ''} onChange={(e) => setFa(i, { serial: e.target.value })} className={inp} /></Field>
        <Field label="Sede / clínica">
          <SearchableSelect options={clinics} value={fa.locationClinic || ''} onChange={(v) => setFa(i, { locationClinic: v })} getLabel={(c) => c.name} placeholder="Seleccione…" searchPlaceholder="Buscar sede…" allowClear size="sm" />
        </Field>
        <Field label="Ubicación (área)"><input value={fa.location || ''} onChange={(e) => setFa(i, { location: e.target.value })} placeholder="Ej: Consultorio 2" className={inp} /></Field>
        <Field label="% Depreciación anual"><NumericInput step="0.01" value={fa.depreciationRate || 0} onChange={(e) => setFa(i, { depreciationRate: +e.target.value, usefulLifeMonths: Math.round(1200 / (+e.target.value || 1)) })} className={inp} /></Field>
        <Field label="Vida útil (meses)"><NumericInput value={fa.usefulLifeMonths || 0} onChange={(e) => setFa(i, { usefulLifeMonths: +e.target.value })} className={inp} /></Field>
        <Field label="% Valor residual"><NumericInput step="0.01" value={fa.residualPercent || 0} onChange={(e) => setFa(i, { residualPercent: +e.target.value })} className={inp} /></Field>
        <Field label="Fecha adquisición"><input type="date" value={fa.acquisitionDate ? String(fa.acquisitionDate).slice(0, 10) : ''} onChange={(e) => setFa(i, { acquisitionDate: e.target.value })} className={inp} /></Field>
        <Field label="Inicio depreciación"><input type="date" value={fa.startDate ? String(fa.startDate).slice(0, 10) : ''} onChange={(e) => setFa(i, { startDate: e.target.value })} className={inp} /></Field>
      </div>
      <p className="text-[11px] text-slate-400">El costo se toma del subtotal de la línea. La cuenta de activo fijo se prefija desde la categoría. Al contabilizar se crea el activo automáticamente.</p>
    </div>
  );
}
