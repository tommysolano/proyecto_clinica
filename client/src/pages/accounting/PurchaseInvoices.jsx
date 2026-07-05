import { useEffect, useRef, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import Field from '../../components/Field';
import { HiOutlinePlus, HiOutlineDocumentText, HiOutlineArrowDownTray, HiOutlineXMark, HiOutlineTrash, HiOutlineExclamationTriangle, HiOutlineCube, HiOutlineBanknotes, HiOutlineBuildingOffice2 } from 'react-icons/hi2';
import { fmt, fmtDate, today } from './_utils';
import NumericInput from '../../components/NumericInput';
import JournalEntryEditor from '../../components/JournalEntryEditor';
import SearchableSelect from '../../components/SearchableSelect';
import ProductFormModal from '../../components/ProductFormModal';
import { useAuth } from '../../context/AuthContext';
import useDocDeepLink from '../../hooks/useDocDeepLink';

const PAGE_SIZE = 100;
// Captura de activo fijo (los datos contables —cuentas, depreciación, vida útil,
// residual— NO se piden: se derivan de la categoría de activo fijo).
const EMPTY_FA = { category: '', assetType: '', code: '', name: '', serial: '', location: '', locationClinic: '', acquisitionDate: '', startDate: '', depreciationRate: 0, usefulLifeMonths: 0, residualPercent: 0, assetAccount: '', depreciationAccount: '', accumDepreciationAccount: '' };
const EMPTY = { supplier: '', docType: 'FACTURA', estab: '001', ptoEmi: '001', secuencial: '', serie: '', claveAcceso: '', autorizacion: '', fechaEmision: today(), fechaVencimiento: '', creditDays: 0, costCenter: '', notes: '', items: [], retentions: [], retentionNumber: '' };

// Contador para claves de fila del formulario (no se envían al backend).
let _uidc = 0;
const uid = () => `it_${Date.now().toString(36)}_${(_uidc++).toString(36)}`;
// Selección de retención por línea (basada en catálogo): se guarda la regla escogida;
// el backend recalcula base/monto/cuenta. base/amount aquí son SOLO estimación visual.
const emptyRetention = () => ({ rule: '', type: 'RENTA', code: '', description: '', rate: 0, base: 0, amount: 0 });

// Base estimada de retención en el cliente (informativa; el backend es la fuente).
const retentionBaseForDisplay = (it, baseType) => {
  const b = +(((it.quantity || 0) * (it.unitPrice || 0)) - (it.discount || 0)).toFixed(2);
  const iva = it.ivaRate > 0 ? +(b * it.ivaRate / 100).toFixed(2) : 0;
  if (baseType === 'IVA') return iva;
  if (baseType === 'SUBTOTAL_IVA') return it.ivaRate > 0 ? b : 0;
  if (baseType === 'SUBTOTAL_0') return it.ivaRate === 0 ? b : 0;
  return b; // SUBTOTAL_TOTAL
};
const estimateRetention = (it, rule) => {
  if (!rule) return { base: 0, amount: 0 };
  const base = retentionBaseForDisplay(it, rule.baseType);
  return { base, amount: +(base * (Number(rule.rate) || 0) / 100).toFixed(2) };
};
const makeItem = (lineType) => ({
  _uid: uid(), lineType,
  description: '', quantity: 1, unitPrice: 0, discount: 0, ivaRate: 15,
  account: '', accountSplits: [],
  product: '', inventoryCategory: '', warehouse: '', lot: '', expiryDate: '',
  costCenter: '', fixedAsset: { ...EMPTY_FA }, retention: emptyRetention(),
});
// Subtotal (base) de una línea.
const lineBase = (it) => +(((it.quantity || 0) * (it.unitPrice || 0)) - (it.discount || 0)).toFixed(2);

// Vencimiento = fecha de emisión + días de crédito (YYYY-MM-DD).
const addDays = (dateStr, days) => {
  if (!dateStr || !(+days > 0)) return '';
  const d = new Date(`${dateStr}T00:00:00`);
  if (isNaN(d)) return '';
  d.setDate(d.getDate() + Number(days));
  return d.toISOString().slice(0, 10);
};

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
  const [retentionRules, setRetentionRules] = useState([]); // catálogo de retenciones (activas)
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
  const [newProductItemUid, setNewProductItemUid] = useState(null); // línea que dispara "Nuevo producto"
  const [journalInv, setJournalInv] = useState(null); // factura cuyo asiento se edita
  const [payInv, setPayInv] = useState(null); // factura a pagar
  const [payForm, setPayForm] = useState({ method: 'TRANSFERENCIA', bankAccount: '', voucherNumber: '', checkNumber: '', amount: 0, date: today() });

  // Solo la respuesta de la última búsqueda actualiza la lista.
  const reqRef = useRef(0);
  const load = async () => {
    const reqId = ++reqRef.current;
    try {
      const r = await api.get('/purchase-invoices', { params: { q: search || undefined, status: statusFilter || undefined, sort, page, limit: PAGE_SIZE } });
      if (reqId !== reqRef.current) return;
      setList(r.data?.items || r.data || []);
      setTotal(r.data?.total ?? (r.data?.items?.length || 0));
      loadPendingCount();
    } catch (e) { if (reqId === reqRef.current) toast.error(e.response?.data?.message || 'Error'); }
  };

  const loadPendingCount = async () => {
    try {
      const r = await api.get('/purchase-invoices', { params: { status: 'POR_AUTORIZAR', limit: 1 } });
      setPendingTotal(r.data?.total ?? 0);
    } catch { /* sin bloquear la vista */ }
  };
  // Catálogo de productos físicos (con su categoría contable poblada para mostrar la cuenta).
  const loadProducts = () =>
    api.get('/products')
      .then((r) => setProducts((r.data?.items || r.data || []).filter((p) => !p.unlimited && p.category !== 'servicio')))
      .catch(() => {});

  useEffect(() => {
    api.get('/suppliers').then((r) => setSuppliers(r.data || []));
    api.get('/chart-of-accounts').then((r) => setAccounts((r.data || []).filter((a) => a.allowsMovement && (a.code?.startsWith('6.') || a.code?.startsWith('5.') || a.code?.startsWith('1.1.04') || a.code?.startsWith('1.2.')))));
    loadProducts();
    api.get('/inventory-advanced/warehouses').then((r) => setWarehouses(r.data || [])).catch(() => {});
    api.get('/banks/accounts').then((r) => setBanks(r.data || [])).catch(() => {});
    api.get('/cost-centers', { params: { active: true } }).then((r) => setCostCenters(r.data || [])).catch(() => {});
    api.get('/inventory-advanced/categories', { params: { kind: 'ACTIVO_FIJO' } }).then((r) => setAssetCategories(r.data?.items || r.data || [])).catch(() => {});
    api.get('/retention-rules', { params: { active: true } }).then((r) => setRetentionRules(r.data || [])).catch(() => {});
    api.get('/clinics').then((r) => setClinics(r.data?.items || r.data || [])).catch(() => {});
    load();
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setPage(1); }, [search, statusFilter, sort]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { const t = setTimeout(load, 300); return () => clearTimeout(t); }, [search, statusFilter, sort, page]);

  // Cuentas recurrentes del proveedor: sugiere/autocompleta la cuenta de GASTO.
  useEffect(() => {
    if (!form.supplier) { setRecurring({ defaultAccount: null, accounts: [] }); return; }
    let active = true;
    api.get('/purchase-invoices/recurring-accounts', { params: { supplier: form.supplier } })
      .then((r) => {
        if (!active) return;
        const data = r.data || { defaultAccount: null, accounts: [] };
        setRecurring(data);
        if (data.defaultAccount) {
          setForm((f) => ({ ...f, items: f.items.map((it) => (it.lineType === 'GASTO' && !it.account && !(it.accountSplits || []).length ? { ...it, account: data.defaultAccount._id } : it)) }));
        }
      })
      .catch(() => {});
    return () => { active = false; };
  }, [form.supplier]);

  // Aplica una cuenta recurrente a las líneas de GASTO que aún no tienen cuenta.
  const applyRecurring = (accId) => setForm((f) => ({ ...f, items: f.items.map((it) => (it.lineType === 'GASTO' && !(it.accountSplits || []).length ? { ...it, account: accId } : it)) }));

  const onSelectSupplier = (v) => {
    const sup = suppliers.find((s) => String(s._id) === String(v));
    const creditDays = sup?.creditDays || 0;
    setForm((f) => ({ ...f, supplier: v, creditDays: creditDays || f.creditDays, fechaVencimiento: (creditDays || f.creditDays) ? addDays(f.fechaEmision, creditDays || f.creditDays) : f.fechaVencimiento }));
  };

  const setInvoiceCostCenter = (cc) => setForm((f) => ({ ...f, costCenter: cc, items: f.items.map((it) => (it.costCenter ? it : { ...it, costCenter: cc })) }));

  // ---- Manipulación de líneas por _uid ----
  const setItem = (u, patch) => setForm((f) => ({ ...f, items: f.items.map((it) => (it._uid === u ? { ...it, ...patch } : it)) }));
  const removeItem = (u) => setForm((f) => ({ ...f, items: f.items.filter((it) => it._uid !== u) }));
  const addItem = (lineType) => setForm((f) => {
    const it = makeItem(lineType);
    if (lineType === 'GASTO' && recurring.defaultAccount) it.account = recurring.defaultAccount._id;
    if (f.costCenter) it.costCenter = f.costCenter;
    return { ...f, items: [...f.items, it] };
  });
  // Retención por línea desde el catálogo: al escoger la regla se guarda su snapshot y se
  // estima base/monto (informativo). El backend recalcula al guardar.
  const setLineRetentionRule = (u, ruleId) => setForm((f) => ({
    ...f,
    items: f.items.map((it) => {
      if (it._uid !== u) return it;
      if (!ruleId) return { ...it, retention: emptyRetention() };
      const rule = retentionRules.find((r) => String(r._id) === String(ruleId));
      if (!rule) return { ...it, retention: emptyRetention() };
      const { base, amount } = estimateRetention(it, rule);
      return { ...it, retention: { rule: rule._id, type: rule.type, code: rule.code, description: rule.description || '', rate: rule.rate, base, amount } };
    }),
  }));

  // Al elegir producto en una línea de inventario: autoselecciona su categoría contable.
  const onPickProduct = (u, productId) => {
    const prod = products.find((p) => String(p._id) === String(productId));
    setForm((f) => ({
      ...f,
      items: f.items.map((it) => (it._uid === u ? {
        ...it, product: productId || '',
        inventoryCategory: prod?.inventoryCategory?._id || prod?.inventoryCategory || '',
        description: it.description || prod?.name || '',
        unitPrice: it.unitPrice || prod?.purchasePrice || 0,
        warehouse: productId ? it.warehouse : '',
      } : it)),
    }));
  };

  // Al elegir categoría de activo fijo: prefija cuentas/parámetros ocultos (desde la categoría).
  const onItemAssetCategory = (u, catId) => {
    const c = assetCategories.find((x) => String(x._id) === String(catId));
    setForm((f) => ({
      ...f,
      items: f.items.map((it) => (it._uid === u ? {
        ...it,
        fixedAsset: {
          ...(it.fixedAsset || {}), category: catId, assetType: '',
          depreciationRate: c?.depreciationRate || 0,
          usefulLifeMonths: (c?.usefulLifeYears || 10) * 12,
          residualPercent: c?.residualPercent || 0,
          assetAccount: c?.assetAccount?._id || c?.assetAccount || '',
          depreciationAccount: c?.depreciationAccount?._id || c?.depreciationAccount || '',
          accumDepreciationAccount: c?.accumDepreciationAccount?._id || c?.accumDepreciationAccount || '',
        },
      } : it)),
    }));
  };
  const setFa = (u, patch) => setForm((f) => ({ ...f, items: f.items.map((it) => (it._uid === u ? { ...it, fixedAsset: { ...(it.fixedAsset || {}), ...patch } } : it)) }));

  const gastoItems = form.items.filter((it) => it.lineType === 'GASTO');
  const invItems = form.items.filter((it) => it.lineType === 'INVENTARIO');
  const afItems = form.items.filter((it) => it.lineType === 'ACTIVO_FIJO');

  // Estimación viva de la retención de una línea (informativa; el backend recalcula).
  const ruleById = (id) => retentionRules.find((r) => String(r._id) === String(id));
  const lineRetInfo = (it) => {
    if (!it.retention?.rule) return null;
    const rule = ruleById(it.retention.rule);
    if (rule) { const { base, amount } = estimateRetention(it, rule); return { type: rule.type, code: rule.code, description: rule.description, rate: rule.rate, base, amount, account: rule.payableAccount }; }
    // Regla no cargada (p.ej. compra legacy): usa el snapshot guardado.
    const r = it.retention;
    return { type: r.type, code: r.code, description: r.description, rate: r.rate || r.percentage || 0, base: r.base ?? r.baseAmount ?? 0, amount: r.amount || 0, account: r.account };
  };
  // Resumen de retenciones DERIVADO de las líneas (o de la cabecera legacy si no hay líneas).
  const retSummary = (() => {
    const map = new Map();
    let anyLine = false;
    for (const it of form.items) {
      const info = lineRetInfo(it);
      if (!info || !(info.amount > 0)) continue;
      anyLine = true;
      const key = `${info.type}|${info.code}`;
      if (!map.has(key)) map.set(key, { ...info, base: 0, amount: 0 });
      const g = map.get(key);
      g.base = +(g.base + info.base).toFixed(2);
      g.amount = +(g.amount + info.amount).toFixed(2);
    }
    if (anyLine) return [...map.values()];
    // Legacy: retenciones de cabecera capturadas manualmente.
    return (form.retentions || []).map((r) => ({ type: r.type, code: r.code, description: r.description || '', rate: r.percentage || 0, base: r.baseAmount || 0, amount: r.amount || 0, account: r.account }));
  })();

  // Selector compacto de retención por línea (catálogo). Muestra el monto estimado.
  const retCell = (it) => {
    const info = lineRetInfo(it);
    return (
      <div className="min-w-[150px]">
        <select value={it.retention?.rule || ''} onChange={(e) => setLineRetentionRule(it._uid, e.target.value)} className={`${inputCls} text-xs`}>
          <option value="">Sin retención</option>
          <optgroup label="Renta">
            {retentionRules.filter((r) => r.type === 'RENTA').map((r) => <option key={r._id} value={r._id}>{r.code} · {r.rate}% · {r.description}</option>)}
          </optgroup>
          <optgroup label="IVA">
            {retentionRules.filter((r) => r.type === 'IVA').map((r) => <option key={r._id} value={r._id}>{r.code} · {r.rate}% · {r.description}</option>)}
          </optgroup>
        </select>
        {info && info.amount > 0 && <div className="text-[11px] text-slate-400 mt-0.5 text-right">≈ {fmt(info.amount)}</div>}
      </div>
    );
  };

  const totals = (() => {
    let s0 = 0, s12 = 0, s15 = 0, sNo = 0, sEx = 0, iva = 0, discount = 0;
    for (const it of form.items) {
      const base = lineBase(it);
      discount += it.discount || 0;
      if (it.ivaRate === 0) s0 += base;
      else if (it.ivaRate === 12) { s12 += base; iva += base * 0.12; }
      else if (it.ivaRate === 15) { s15 += base; iva += base * 0.15; }
      else if (it.ivaRate === -1) sNo += base;
      else if (it.ivaRate === -2) sEx += base;
    }
    const subtotal = s0 + s12 + s15 + sNo + sEx;
    const retTotal = +(retSummary.reduce((s, r) => s + (+r.amount || 0), 0)).toFixed(2);
    return { s0, s12, s15, sNo, sEx, subtotal, subtotalConIva: s12 + s15, iva: +iva.toFixed(2), discount, total: +(subtotal + iva).toFixed(2), retTotal, balance: +(subtotal + iva - retTotal).toFixed(2) };
  })();

  const submit = async (e) => {
    e.preventDefault();
    if (!form.supplier) return toast.error('Selecciona un proveedor');
    if (!form.items.length) return toast.error('Agrega al menos una línea (producto, gasto o activo fijo)');
    for (const it of form.items) {
      if (it.lineType === 'INVENTARIO' && !it.product) return toast.error('En productos/inventario, selecciona el producto en cada línea');
      if (it.lineType === 'ACTIVO_FIJO' && !(it.fixedAsset?.category)) return toast.error('En activos fijos, selecciona la categoría de activo fijo');
      if (it.lineType === 'ACTIVO_FIJO' && !(it.fixedAsset?.name || it.description)) return toast.error('El activo fijo necesita un nombre');
      if (it.lineType === 'GASTO') {
        const hasSplits = (it.accountSplits || []).length > 0;
        if (!it.account && !hasSplits) return toast.error('Cada gasto necesita una cuenta contable (o una distribución)');
        if (hasSplits) {
          const base = lineBase(it);
          const sum = +(it.accountSplits.reduce((s, sp) => s + (+sp.amount || 0), 0)).toFixed(2);
          if (Math.abs(sum - base) > 0.01) return toast.error(`La distribución de "${it.description || 'gasto'}" no cuadra (${fmt(sum)} ≠ ${fmt(base)})`);
          if (it.accountSplits.some((sp) => !sp.account)) return toast.error('Hay cuentas sin seleccionar en la distribución');
        }
      }
    }
    try {
      const serie = form.serie || `${form.estab}-${form.ptoEmi}-${form.secuencial}`;
      const items = form.items.map((it) => {
        // Solo se envía la SELECCIÓN de retención (regla/código); el backend recalcula.
        const retSel = it.retention?.rule
          ? { rule: it.retention.rule, code: it.retention.code, type: it.retention.type }
          : null;
        const base = {
          lineType: it.lineType,
          description: it.description || (it.lineType === 'ACTIVO_FIJO' ? (it.fixedAsset?.name || '') : ''),
          quantity: Number(it.quantity) || (it.lineType === 'INVENTARIO' ? 0 : 1),
          unitPrice: Number(it.unitPrice) || 0,
          discount: Number(it.discount) || 0,
          ivaRate: it.ivaRate,
          costCenter: it.costCenter || null,
          retention: retSel,
        };
        if (it.lineType === 'INVENTARIO') {
          base.product = it.product || null;
          base.inventoryCategory = it.inventoryCategory || null;
          base.warehouse = it.warehouse || null;
          base.lot = it.lot || '';
          base.expiryDate = it.expiryDate || null;
        } else if (it.lineType === 'ACTIVO_FIJO') {
          const fa = it.fixedAsset || {};
          base.fixedAsset = {
            ...fa,
            category: fa.category || null, assetType: fa.assetType || null, locationClinic: fa.locationClinic || null,
            assetAccount: fa.assetAccount || null, depreciationAccount: fa.depreciationAccount || null, accumDepreciationAccount: fa.accumDepreciationAccount || null,
            acquisitionDate: fa.acquisitionDate || null, startDate: fa.startDate || null,
          };
        } else { // GASTO
          base.account = it.account || null;
          base.accountSplits = (it.accountSplits || []).map((s) => ({ account: s.account || null, amount: Number(s.amount) || 0, description: s.description || '' }));
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
        notes: d.notes || '',
        items: (d.items || []).map((it) => ({
          ...makeItem(it.lineType || (it.product ? 'INVENTARIO' : (it.fixedAsset ? 'ACTIVO_FIJO' : 'GASTO'))),
          ...it,
          _uid: uid(),
          lineType: it.lineType || (it.product ? 'INVENTARIO' : (it.fixedAsset?.category || it.fixedAsset?.name ? 'ACTIVO_FIJO' : 'GASTO')),
          account: it.account?._id || it.account || '',
          product: it.product?._id || it.product || '',
          inventoryCategory: it.inventoryCategory?._id || it.inventoryCategory || '',
          warehouse: it.warehouse?._id || it.warehouse || '',
          costCenter: it.costCenter?._id || it.costCenter || '',
          expiryDate: it.expiryDate ? String(it.expiryDate).slice(0, 10) : '',
          retention: it.retention ? { ...emptyRetention(), ...it.retention, rule: it.retention.rule?._id || it.retention.rule || '', account: it.retention.account?._id || it.retention.account || null } : emptyRetention(),
          accountSplits: (it.accountSplits || []).map((s) => ({ ...s, account: s.account?._id || s.account || '' })),
          fixedAsset: it.fixedAsset ? {
            ...EMPTY_FA, ...it.fixedAsset,
            category: it.fixedAsset.category?._id || it.fixedAsset.category || '',
            assetType: it.fixedAsset.assetType?._id || it.fixedAsset.assetType || '',
            locationClinic: it.fixedAsset.locationClinic?._id || it.fixedAsset.locationClinic || '',
            assetAccount: it.fixedAsset.assetAccount?._id || it.fixedAsset.assetAccount || '',
            acquisitionDate: it.fixedAsset.acquisitionDate ? String(it.fixedAsset.acquisitionDate).slice(0, 10) : '',
            startDate: it.fixedAsset.startDate ? String(it.fixedAsset.startDate).slice(0, 10) : '',
          } : { ...EMPTY_FA },
        })),
        retentions: d.retentions || [],
      });
      if (mode === 'edit') { setEditId(p._id); setAuthorizeId(null); }
      else { setAuthorizeId(p._id); setEditId(null); }
      setShow(true);
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  const openAuthorize = (p) => loadIntoForm(p, 'authorize');
  const openEdit = (p) => loadIntoForm(p, 'edit');

  // Deep-link desde el Libro Mayor (?doc=<id>): abre la factura de compra.
  useDocDeepLink((id) => loadIntoForm({ _id: id }, 'edit'));

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
    if (importing) return;
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
        if (created) toast('Quedan POR CONTABILIZAR. Clasifica sus líneas (gasto/inventario/activo) y contabilízalas.', { icon: 'ℹ️' });
      }
      setShowImport(false); setXmlContents([]); setImportTxt(''); setImportTxtName(''); load();
    } catch (e) {
      const msg = e.code === 'ECONNABORTED' ? 'La importación tardó demasiado. Intenta con un archivo más pequeño o reintenta.' : (e.response?.data?.message || 'Error al importar');
      toast.error(msg);
    } finally {
      setImporting(false);
    }
  };

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

  // Tras crear un producto desde la factura: refresca catálogo y lo autoselecciona en la línea.
  const handleNewProductSaved = async (saved) => {
    await loadProducts();
    const u = newProductItemUid;
    if (u != null && saved?._id) {
      setForm((prev) => ({
        ...prev,
        items: prev.items.map((it) => (it._uid === u ? {
          ...it, product: saved._id,
          inventoryCategory: saved.inventoryCategory?._id || saved.inventoryCategory || '',
          description: it.description || saved.name,
        } : it)),
      }));
    }
    setNewProductItemUid(null);
  };

  const inputCls = 'w-full border border-slate-200 rounded-lg px-2 py-2 text-sm';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineDocumentText className="text-emerald-600" /> Compras
          {pendingTotal > 0 && <span className="text-xs font-medium px-2 py-0.5 bg-amber-100 text-amber-700 rounded-full">{pendingTotal} por contabilizar</span>}
        </h1>
        <div className="flex gap-2">
          {hasRole('admin') && <button onClick={wipeAll} title="Borrar todas las compras de esta sucursal (reinicio)" className="px-4 py-2 bg-rose-600 text-white rounded-lg flex items-center gap-2"><HiOutlineXMark /> Reiniciar compras</button>}
          <button onClick={() => { setImportMode('xml'); setShowImport(true); }} className="px-4 py-2 bg-amber-500 text-white rounded-lg flex items-center gap-2"><HiOutlineArrowDownTray /> Importar SRI</button>
          <button onClick={() => { setForm({ ...EMPTY, items: [] }); setAuthorizeId(null); setEditId(null); setShow(true); }} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center gap-2"><HiOutlinePlus /> Nueva</button>
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
        <form onSubmit={submit} className="space-y-4">
          {authorizeId && <div className="bg-amber-50 border border-amber-200 text-amber-800 text-xs rounded-lg px-3 py-2">Factura cargada automáticamente. Clasifica cada renglón (Productos, Gastos o Activos fijos) y verifica los datos antes de contabilizar.</div>}

          {/* ── 1. Datos generales ── */}
          <SectionCard title="Datos de la factura" icon={HiOutlineDocumentText}>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-x-3 gap-y-2.5">
              <Field label="Proveedor" required className="col-span-2">
                <SearchableSelect options={suppliers} value={form.supplier} onChange={onSelectSupplier} getLabel={(s) => `${s.ruc} - ${s.razonSocial}`} getSearchText={(s) => `${s.ruc} ${s.razonSocial} ${s.nombreComercial || ''}`} placeholder="Seleccione un proveedor…" searchPlaceholder="Buscar por RUC o nombre…" />
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
              <Field label="Forma de pago (SRI)"><input placeholder="Opcional" value={form.paymentMethodSri || ''} onChange={(e) => setForm({ ...form, paymentMethodSri: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm" /></Field>
              <Field label="Centro de costo (factura)" className="col-span-2">
                <SearchableSelect options={costCenters} value={form.costCenter} onChange={setInvoiceCostCenter} getLabel={(c) => `${c.code} - ${c.name}`} getSearchText={(c) => `${c.code} ${c.name}`} placeholder="— sin centro —" searchPlaceholder="Buscar centro…" allowClear />
              </Field>
              <Field label="Observación (factura)" className="col-span-2 md:col-span-4"><input placeholder="Descripción general de la factura (opcional)" value={form.notes || ''} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm" /></Field>
            </div>
          </SectionCard>

          {/* ── 2. Productos / Inventario ── */}
          <SectionCard title="Productos / Inventario" icon={HiOutlineCube} onAdd={() => addItem('INVENTARIO')} addLabel="Agregar producto" count={invItems.length}>
            {invItems.length === 0 ? (
              <EmptyHint>Sin productos de inventario. Usa “Agregar producto” si la factura incluye insumos que entran a stock.</EmptyHint>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-[11px] uppercase text-slate-400"><tr className="text-left">
                    <th className="py-1 pr-2">Producto</th><th className="py-1 px-2">Categoría contable</th><th className="py-1 px-2">Bodega</th>
                    <th className="py-1 px-2 text-right">Cant.</th><th className="py-1 px-2 text-right">Precio</th><th className="py-1 px-2">IVA</th>
                    <th className="py-1 px-2">Retención</th><th className="py-1 px-2 text-right">Subtotal</th><th></th>
                  </tr></thead>
                  <tbody>
                    {invItems.map((it) => {
                      const prod = products.find((p) => String(p._id) === String(it.product));
                      const cat = prod?.inventoryCategory;
                      const assetAcc = cat?.assetAccount;
                      const missing = prod && (!cat || !assetAcc);
                      return (
                        <tr key={it._uid} className="border-t border-slate-100 align-top">
                          <td className="py-1.5 pr-2 min-w-[200px]">
                            <div className="flex items-center gap-1.5">
                              <div className="flex-1 min-w-0"><SearchableSelect options={products} value={it.product} onChange={(v) => onPickProduct(it._uid, v)} getLabel={(p) => p.name} getSearchText={(p) => `${p.name} ${p.code}`} placeholder="Selecciona producto…" searchPlaceholder="Buscar producto…" allowClear size="sm" /></div>
                              <button type="button" onClick={() => setNewProductItemUid(it._uid)} title="Crear producto nuevo" className="shrink-0 p-1.5 rounded-lg border border-emerald-200 text-emerald-700 hover:bg-emerald-50 bg-white"><HiOutlinePlus className="w-4 h-4" /></button>
                            </div>
                          </td>
                          <td className="py-1.5 px-2 text-xs min-w-[150px]">
                            {cat ? (
                              <div>
                                <div className="text-slate-700">{cat.name}</div>
                                <div className="text-[11px] text-slate-400 font-mono">{assetAcc ? `${assetAcc.code || ''} ${assetAcc.name || ''}`.trim() : '—'}</div>
                              </div>
                            ) : <span className="text-slate-400">—</span>}
                            {missing && <div className="text-[11px] text-rose-600 flex items-center gap-1 mt-0.5"><HiOutlineExclamationTriangle className="w-3.5 h-3.5" /> {cat ? 'Categoría sin cuenta de inventario' : 'Producto sin categoría contable'}</div>}
                          </td>
                          <td className="py-1.5 px-2 min-w-[110px]"><SearchableSelect options={[{ _id: '', name: 'General' }, ...warehouses]} value={it.warehouse} onChange={(v) => setItem(it._uid, { warehouse: v })} getLabel={(w) => w.name} placeholder="General" searchPlaceholder="Buscar bodega…" size="sm" /></td>
                          <td className="py-1.5 px-2 w-20"><NumericInput step="0.01" value={it.quantity} onChange={(e) => setItem(it._uid, { quantity: +e.target.value })} className={`${inputCls} text-right`} /></td>
                          <td className="py-1.5 px-2 w-24"><NumericInput step="0.01" value={it.unitPrice} onChange={(e) => setItem(it._uid, { unitPrice: +e.target.value })} className={`${inputCls} text-right`} /></td>
                          <td className="py-1.5 px-2 w-20"><IvaSelect value={it.ivaRate} onChange={(v) => setItem(it._uid, { ivaRate: v })} /></td>
                          <td className="py-1.5 px-2">{retCell(it)}</td>
                          <td className="py-1.5 px-2 text-right font-mono text-slate-700 w-24">{fmt(lineBase(it))}</td>
                          <td className="py-1.5 pl-1"><button type="button" onClick={() => removeItem(it._uid)} className="text-rose-500 hover:text-rose-600"><HiOutlineXMark className="w-4 h-4" /></button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="text-[11px] text-slate-400 mt-1.5">La cuenta de inventario se toma de la categoría contable del producto (no se edita aquí).</p>
              </div>
            )}
          </SectionCard>

          {/* ── 3. Cuentas / Gastos ── */}
          <SectionCard title="Cuentas / Gastos" icon={HiOutlineBanknotes} onAdd={() => addItem('GASTO')} addLabel="Agregar gasto" count={gastoItems.length}>
            {recurring.accounts.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 text-xs bg-emerald-50/60 border border-emerald-100 rounded-lg px-2 py-1.5 mb-2">
                <span className="text-slate-500 font-medium">Cuentas frecuentes:</span>
                {recurring.accounts.map((a) => (
                  <button type="button" key={a._id} onClick={() => applyRecurring(a._id)} title={`Usar ${a.code} ${a.name} en los gastos sin cuenta`} className="px-2 py-0.5 rounded-full bg-white text-emerald-700 border border-emerald-200 hover:bg-emerald-100">{a.code} {a.name}{a.forSupplier ? ' ★' : ''}</button>
                ))}
              </div>
            )}
            {gastoItems.length === 0 ? (
              <EmptyHint>Sin gastos. Usa “Agregar gasto” para transporte, servicios, comisiones, etc.</EmptyHint>
            ) : (
              <div className="space-y-2">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-[11px] uppercase text-slate-400"><tr className="text-left">
                      <th className="py-1 pr-2">Cuenta</th><th className="py-1 px-2">Descripción</th><th className="py-1 px-2 text-right">Valor</th>
                      <th className="py-1 px-2">IVA</th><th className="py-1 px-2">Centro de costo</th><th className="py-1 px-2">Retención</th><th></th>
                    </tr></thead>
                    <tbody>
                      {gastoItems.map((it) => {
                        const splits = it.accountSplits || [];
                        const hasSplits = splits.length > 0;
                        const base = lineBase(it);
                        const splitSum = +splits.reduce((s, sp) => s + (+sp.amount || 0), 0).toFixed(2);
                        const splitOk = Math.abs(splitSum - base) < 0.01;
                        const setSplit = (j, patch) => { const sp = [...splits]; sp[j] = { ...sp[j], ...patch }; setItem(it._uid, { accountSplits: sp }); };
                        return (
                          <RowGroup key={it._uid}>
                            <tr className="border-t border-slate-100 align-top">
                              <td className="py-1.5 pr-2 min-w-[190px]">
                                {hasSplits ? (
                                  <div className="flex items-center justify-between border border-slate-200 rounded-lg px-2 py-1.5 text-xs bg-white text-slate-500 italic">Distribuido en {splits.length}<button type="button" onClick={() => setItem(it._uid, { accountSplits: [] })} className="not-italic text-sky-600">una</button></div>
                                ) : (
                                  <div className="flex items-center gap-1">
                                    <div className="flex-1 min-w-0"><SearchableSelect options={accounts} value={it.account} onChange={(v) => setItem(it._uid, { account: v })} getLabel={(a) => `${a.code} ${a.name}`} getSearchText={(a) => `${a.code} ${a.name}`} placeholder="Cuenta de gasto…" searchPlaceholder="Buscar cuenta…" size="sm" /></div>
                                    <button type="button" title="Distribuir en varias cuentas" onClick={() => setItem(it._uid, { accountSplits: [{ account: it.account || '', amount: base, description: '' }] })} className="text-xs text-sky-600 shrink-0">➗</button>
                                  </div>
                                )}
                              </td>
                              <td className="py-1.5 px-2 min-w-[160px]"><input value={it.description} onChange={(e) => setItem(it._uid, { description: e.target.value })} placeholder="Detalle del gasto" className={inputCls} /></td>
                              <td className="py-1.5 px-2 w-24"><NumericInput step="0.01" value={it.unitPrice} onChange={(e) => setItem(it._uid, { unitPrice: +e.target.value, quantity: 1 })} className={`${inputCls} text-right`} /></td>
                              <td className="py-1.5 px-2 w-20"><IvaSelect value={it.ivaRate} onChange={(v) => setItem(it._uid, { ivaRate: v })} /></td>
                              <td className="py-1.5 px-2 min-w-[130px]"><SearchableSelect options={costCenters} value={it.costCenter} onChange={(v) => setItem(it._uid, { costCenter: v })} getLabel={(c) => `${c.code} - ${c.name}`} getSearchText={(c) => `${c.code} ${c.name}`} placeholder="— sin centro —" searchPlaceholder="Buscar centro…" allowClear size="sm" /></td>
                              <td className="py-1.5 px-2">{retCell(it)}</td>
                              <td className="py-1.5 pl-1"><button type="button" onClick={() => removeItem(it._uid)} className="text-rose-500 hover:text-rose-600"><HiOutlineXMark className="w-4 h-4" /></button></td>
                            </tr>
                            {hasSplits && (
                              <tr className="bg-slate-50/60"><td colSpan={7} className="px-2 py-2">
                                <div className="text-[11px] font-semibold text-slate-600 mb-1">Distribución de cuentas (valor {fmt(base)})</div>
                                {splits.map((sp, j) => (
                                  <div key={j} className="flex items-center gap-2 mb-1.5">
                                    <div className="flex-1 min-w-0"><SearchableSelect options={accounts} value={sp.account} onChange={(v) => setSplit(j, { account: v })} getLabel={(a) => `${a.code} ${a.name}`} placeholder="Cuenta…" searchPlaceholder="Buscar cuenta…" size="sm" /></div>
                                    <NumericInput step="0.01" placeholder="Monto" value={sp.amount} onChange={(e) => setSplit(j, { amount: +e.target.value })} className="border border-slate-200 rounded-lg px-2 py-1.5 text-xs w-28 text-right" />
                                    <input placeholder="Detalle" value={sp.description} onChange={(e) => setSplit(j, { description: e.target.value })} className="border border-slate-200 rounded-lg px-2 py-1.5 text-xs flex-1 min-w-0" />
                                    <button type="button" onClick={() => setItem(it._uid, { accountSplits: splits.filter((_, x) => x !== j) })} className="text-rose-500 shrink-0">×</button>
                                  </div>
                                ))}
                                <div className="flex items-center gap-3 mt-1">
                                  <button type="button" onClick={() => setItem(it._uid, { accountSplits: [...splits, { account: '', amount: +(base - splitSum).toFixed(2), description: '' }] })} className="text-emerald-600 text-xs">+ cuenta</button>
                                  <span className={`text-xs ${splitOk ? 'text-emerald-600' : 'text-rose-600'}`}>Suma: {fmt(splitSum)} / {fmt(base)} {splitOk ? '✓' : '✗'}</span>
                                </div>
                              </td></tr>
                            )}
                          </RowGroup>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </SectionCard>

          {/* ── 4. Activos fijos ── */}
          <SectionCard title="Activos fijos" icon={HiOutlineBuildingOffice2} onAdd={() => addItem('ACTIVO_FIJO')} addLabel="Agregar activo fijo" count={afItems.length}>
            {afItems.length === 0 ? (
              <EmptyHint>Sin activos fijos. Usa “Agregar activo fijo” si la factura incluye equipos/muebles a capitalizar.</EmptyHint>
            ) : (
              <div className="space-y-3">
                {afItems.map((it) => {
                  const fa = it.fixedAsset || {};
                  const roots = assetCategories.filter((c) => !c.parent);
                  const types = assetCategories.filter((c) => c.parent && String(c.parent) === String(fa.category));
                  return (
                    <div key={it._uid} className="border border-slate-200 rounded-xl p-3 bg-slate-50/40 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-slate-500">Activo fijo</span>
                        <button type="button" onClick={() => removeItem(it._uid)} className="text-rose-500 hover:text-rose-600"><HiOutlineXMark className="w-4 h-4" /></button>
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                        <Field label="Categoría de activo fijo" required className="col-span-2">
                          <SearchableSelect options={roots} value={fa.category || ''} onChange={(v) => onItemAssetCategory(it._uid, v)} getLabel={(c) => `${c.code} - ${c.name}`} getSearchText={(c) => `${c.code} ${c.name}`} placeholder="Seleccione…" searchPlaceholder="Buscar categoría…" allowClear size="sm" />
                        </Field>
                        <Field label="Tipo de activo"><SearchableSelect options={types} value={fa.assetType || ''} onChange={(v) => setFa(it._uid, { assetType: v })} getLabel={(c) => c.name} placeholder={types.length ? 'Seleccione…' : 'Sin tipos'} searchPlaceholder="Buscar tipo…" allowClear size="sm" /></Field>
                        <Field label="Código"><input value={fa.code || ''} onChange={(e) => setFa(it._uid, { code: e.target.value })} placeholder="Auto (AF-####)" className={inputCls} /></Field>
                        <Field label="Nombre" required className="col-span-2"><input value={fa.name || ''} onChange={(e) => setFa(it._uid, { name: e.target.value })} placeholder="Ej: Ecógrafo" className={inputCls} /></Field>
                        <Field label="Serie"><input value={fa.serial || ''} onChange={(e) => setFa(it._uid, { serial: e.target.value })} className={inputCls} /></Field>
                        <Field label="Sede / clínica"><SearchableSelect options={clinics} value={fa.locationClinic || ''} onChange={(v) => setFa(it._uid, { locationClinic: v })} getLabel={(c) => c.name} placeholder="Seleccione…" searchPlaceholder="Buscar sede…" allowClear size="sm" /></Field>
                        <Field label="Ubicación (área)" className="col-span-2"><input value={fa.location || ''} onChange={(e) => setFa(it._uid, { location: e.target.value })} placeholder="Ej: Consultorio 2" className={inputCls} /></Field>
                        <Field label="Valor"><NumericInput step="0.01" value={it.unitPrice} onChange={(e) => setItem(it._uid, { unitPrice: +e.target.value, quantity: 1 })} className={`${inputCls} text-right`} /></Field>
                        <Field label="IVA"><IvaSelect value={it.ivaRate} onChange={(v) => setItem(it._uid, { ivaRate: v })} /></Field>
                        <Field label="Retención">{retCell(it)}</Field>
                      </div>
                      <p className="text-[11px] text-slate-400">Las cuentas (activo, depreciación), la vida útil y el % residual se toman de la categoría. Al contabilizar se crea el activo automáticamente.</p>
                    </div>
                  );
                })}
              </div>
            )}
          </SectionCard>

          {/* ── 5. Retenciones (resumen derivado de las líneas) ── */}
          <SectionCard title="Retenciones" icon={HiOutlineBanknotes}>
            <p className="text-[11px] text-slate-400 mb-2">Resumen de las retenciones seleccionadas por línea (catálogo SRI). El backend recalcula base y monto al guardar. Para cambiarlas, ajusta la retención en cada línea.</p>
            {retSummary.length === 0 ? (
              <EmptyHint>Sin retenciones. Elige el código de retención en cada línea (Productos, Gastos o Activos fijos).</EmptyHint>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-[11px] uppercase text-slate-400"><tr className="text-left">
                    <th className="py-1 pr-2">Tipo</th><th className="py-1 px-2">Código</th><th className="py-1 px-2">Descripción</th>
                    <th className="py-1 px-2 text-right">Base</th><th className="py-1 px-2 text-right">%</th><th className="py-1 px-2 text-right">Monto</th><th className="py-1 px-2">Cuenta</th>
                  </tr></thead>
                  <tbody>
                    {retSummary.map((r, i) => {
                      const acc = r.account && typeof r.account === 'object' ? `${r.account.code || ''} ${r.account.name || ''}`.trim() : null;
                      return (
                        <tr key={`${r.type}-${r.code}-${i}`} className="border-t border-slate-100">
                          <td className="py-1.5 pr-2">{r.type}</td>
                          <td className="py-1.5 px-2 font-mono">{r.code}</td>
                          <td className="py-1.5 px-2 text-slate-600">{r.description || '—'}</td>
                          <td className="py-1.5 px-2 text-right font-mono">{fmt(r.base)}</td>
                          <td className="py-1.5 px-2 text-right font-mono">{r.rate}%</td>
                          <td className="py-1.5 px-2 text-right font-mono">{fmt(r.amount)}</td>
                          <td className="py-1.5 px-2 text-[11px] text-slate-400 font-mono">{acc || 'Según tipo (por pagar)'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot><tr className="border-t border-slate-200 font-semibold"><td colSpan={5} className="py-1.5 px-2 text-right">Total retenido</td><td className="py-1.5 px-2 text-right font-mono">{fmt(totals.retTotal)}</td><td></td></tr></tfoot>
                </table>
              </div>
            )}
            <Field label="N° comprobante de retención" className="mt-3"><input placeholder="Opcional" value={form.retentionNumber} onChange={(e) => setForm({ ...form, retentionNumber: e.target.value })} className="block w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
          </SectionCard>

          {/* ── 6. Totales ── */}
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
            <div>Subtotal 0%: <b>{fmt(totals.s0)}</b></div>
            <div>Subtotal con IVA: <b>{fmt(totals.subtotalConIva)}</b></div>
            <div>No obj/Exento: <b>{fmt(totals.sNo + totals.sEx)}</b></div>
            <div>Descuentos: <b>{fmt(totals.discount)}</b></div>
            <div>IVA: <b>{fmt(totals.iva)}</b></div>
            <div>Total factura: <b>${fmt(totals.total)}</b></div>
            <div>Retenciones: <b>{fmt(totals.retTotal)}</b></div>
            <div className="text-right">Total a pagar: <b className="text-lg">${fmt(totals.balance)}</b></div>
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
            <p className="text-xs text-slate-500 mb-2">Carga uno o varios archivos XML de facturas electrónicas recibidas. Se cargarán como <b>POR CONTABILIZAR</b> (sin cuenta asignada) para que el área contable clasifique cada línea antes de contabilizar.</p>
            <input aria-label="Cargar archivos XML" type="file" accept=".xml,text/xml,application/xml" multiple onChange={(e) => onXmlFiles(e.target.files)} className="block w-full text-sm text-slate-600 file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border-0 file:bg-emerald-600 file:text-white file:cursor-pointer" />
            {!!xmlContents.length && (
              <div className="mt-2 flex items-center justify-between text-sm bg-emerald-50 rounded-lg px-3 py-2"><span>{xmlContents.length} archivo(s) XML listos para importar</span><button onClick={() => setXmlContents([])} className="text-rose-600 text-xs">Limpiar</button></div>
            )}
          </div>
        ) : (
          <div>
            <p className="text-xs text-slate-500 mb-2">Carga el archivo <b>.txt</b> del reporte del SRI <b>“Comprobantes electrónicos recibidos”</b> (separado por tabulación). Las facturas quedan <b>POR CONTABILIZAR</b> para clasificar sus líneas y asignar cuentas/inventario.</p>
            <label className="block text-xs font-medium text-slate-600 mb-1">Cargar archivo .txt</label>
            <input type="file" accept=".txt,text/plain,.csv,text/csv" onChange={(e) => { const f = e.target.files?.[0]; if (!f) return; const reader = new FileReader(); reader.onload = (ev) => { setImportTxt(String(ev.target?.result || '')); setImportTxtName(f.name); }; reader.readAsText(f, 'utf-8'); e.target.value = ''; }} className="block w-full text-sm text-slate-600 file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border-0 file:bg-emerald-600 file:text-white file:cursor-pointer" />
            {importTxt.trim() ? (
              <div className="mt-2 flex items-center justify-between text-sm bg-emerald-50 rounded-lg px-3 py-2"><span>📄 <b>{importTxtName || 'archivo.txt'}</b>: {importTxt.split(/\r?\n/).filter((l) => l.trim()).length} línea(s) detectada(s).</span><button onClick={() => { setImportTxt(''); setImportTxtName(''); }} className="text-rose-600 text-xs">Quitar</button></div>
            ) : (
              <p className="text-xs text-slate-400 mt-2">Aún no has cargado ningún archivo.</p>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2 mt-3"><button onClick={() => setShowImport(false)} disabled={importing} className="px-4 py-2 bg-slate-200 rounded-xl disabled:opacity-50">Cancelar</button><button onClick={submitImport} disabled={importing} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 disabled:opacity-60">{importing ? 'Importando…' : 'Importar'}</button></div>
      </Modal>

      {/* Editor del asiento contable (debe/haber) de la compra */}
      {journalInv && (
        <JournalEntryEditor isOpen={!!journalInv} onClose={() => setJournalInv(null)} entryId={journalInv.journalEntry?._id || journalInv.journalEntry} postUrl={`/purchase-invoices/${journalInv._id}/journal`} title={`Asiento de compra ${journalInv.serie || ''}`} onSaved={load} />
      )}

      {/* Pago de la factura (CxP) → genera el movimiento bancario para conciliación */}
      <Modal isOpen={!!payInv} onClose={() => setPayInv(null)} title={`Pagar compra ${payInv?.serie || ''}`} size="md">
        {payInv && (
          <div className="space-y-3">
            <div className="bg-slate-50 rounded-lg px-3 py-2 text-sm flex justify-between"><span>{payInv.supplier?.razonSocial}</span><span>Saldo: <b>${fmt(payInv.balance ?? payInv.total)}</b></span></div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Método">
                <select value={payForm.method} onChange={(e) => setPayForm({ ...payForm, method: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5"><option value="TRANSFERENCIA">Transferencia</option><option value="CHEQUE">Cheque</option><option value="EFECTIVO">Efectivo</option></select>
              </Field>
              <Field label="Fecha"><input type="date" value={payForm.date} onChange={(e) => setPayForm({ ...payForm, date: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
              {payForm.method !== 'EFECTIVO' && (
                <Field label="Cuenta bancaria" required className="col-span-2"><SearchableSelect options={banks} value={payForm.bankAccount} onChange={(v) => setPayForm({ ...payForm, bankAccount: v })} getLabel={(b) => `${b.name} — ${b.bank}`} placeholder="Seleccione…" searchPlaceholder="Buscar banco…" /></Field>
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
        isOpen={newProductItemUid !== null}
        onClose={() => setNewProductItemUid(null)}
        editingProduct={null}
        initialValues={newProductItemUid !== null ? {
          name: form.items.find((it) => it._uid === newProductItemUid)?.description || '',
          purchasePrice: form.items.find((it) => it._uid === newProductItemUid)?.unitPrice || '',
          taxRate: form.items.find((it) => it._uid === newProductItemUid)?.ivaRate ?? 15,
        } : null}
        products={products}
        clinicsList={clinics}
        onSaved={handleNewProductSaved}
      />
    </div>
  );
}

// Bloque/sección del formulario con encabezado y botón opcional "+ Agregar".
function SectionCard({ title, icon: Icon, children, onAdd, addLabel, count }) {
  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden">
      <div className="flex items-center justify-between bg-slate-50 px-3 py-2 border-b border-slate-200">
        <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-1.5">{Icon && <Icon className="w-4 h-4 text-emerald-600" />}{title}{typeof count === 'number' && count > 0 && <span className="text-[11px] font-normal text-slate-400">({count})</span>}</h3>
        {onAdd && <button type="button" onClick={onAdd} className="text-emerald-600 text-xs font-medium flex items-center gap-1 hover:underline"><HiOutlinePlus className="w-4 h-4" /> {addLabel}</button>}
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}
const EmptyHint = ({ children }) => <p className="text-xs text-slate-400 italic">{children}</p>;
// Agrupa filas relacionadas (línea + su distribución) sin romper el <tbody>.
const RowGroup = ({ children }) => <>{children}</>;
function IvaSelect({ value, onChange }) {
  return (
    <select value={value} onChange={(e) => onChange(+e.target.value)} className="w-full border border-slate-200 rounded-lg px-2 py-2 text-sm bg-white">
      <option value={0}>0%</option><option value={12}>12%</option><option value={15}>15%</option><option value={-1}>No obj</option><option value={-2}>Exento</option>
    </select>
  );
}
