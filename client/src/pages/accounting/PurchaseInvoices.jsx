import { useEffect, useRef, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import Field from '../../components/Field';
import { HiOutlinePlus, HiOutlineDocumentText, HiOutlineArrowDownTray, HiOutlineXMark, HiOutlineTrash, HiOutlineExclamationTriangle, HiOutlineCube, HiOutlineBanknotes, HiOutlineBuildingOffice2, HiOutlineCheck, HiOutlineEllipsisVertical } from 'react-icons/hi2';
import { fmt, fmtDate, today } from './_utils';
import NumericInput from '../../components/NumericInput';
import JournalEntryEditor from '../../components/JournalEntryEditor';
import SearchableSelect from '../../components/SearchableSelect';
import AccountSelect from '../../components/AccountSelect';
import ProductFormModal from '../../components/ProductFormModal';
import { useAuth } from '../../context/AuthContext';
import useDocDeepLink from '../../hooks/useDocDeepLink';

const PAGE_SIZE = 100;
// Cuentas elegibles como destino de una línea de compra: gasto, costo, inventario o activo.
const expenseAccountFilter = (a) => a.code?.startsWith('6.') || a.code?.startsWith('5.') || a.code?.startsWith('1.1.04') || a.code?.startsWith('1.2.');
// Captura de activo fijo (los datos contables —cuentas, depreciación, vida útil,
// residual— NO se piden: se derivan de la categoría de activo fijo).
const EMPTY_FA = { category: '', assetType: '', code: '', name: '', serial: '', location: '', locationClinic: '', acquisitionDate: '', startDate: '', depreciationRate: 0, usefulLifeMonths: 0, residualPercent: 0, assetAccount: '', depreciationAccount: '', accumDepreciationAccount: '' };
const EMPTY = { supplier: '', docType: 'FACTURA', estab: '001', ptoEmi: '001', secuencial: '', serie: '', claveAcceso: '', autorizacion: '', fechaEmision: today(), fechaVencimiento: '', creditDays: 0, costCenter: '', notes: '', items: [], retentions: [], retentionNumber: '' };

// Tipos de línea que puede contener una factura. La UI muestra solo las secciones
// activadas (experiencia progresiva) — ver `activeSections` / "¿Qué contiene esta factura?".
const LINE_TYPES = [
  { t: 'GASTO', label: 'Gasto / cuenta', icon: HiOutlineBanknotes },
  { t: 'INVENTARIO', label: 'Productos / inventario', icon: HiOutlineCube },
  { t: 'ACTIVO_FIJO', label: 'Activo fijo', icon: HiOutlineBuildingOffice2 },
];

// Contador para claves de fila del formulario (no se envían al backend).
let _uidc = 0;
const uid = () => `it_${Date.now().toString(36)}_${(_uidc++).toString(36)}`;
// Selección de retención por línea (basada en catálogo): se guarda la regla escogida;
// el backend recalcula base/monto/cuenta. base/amount aquí son SOLO estimación visual.
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
  costCenter: '', fixedAsset: { ...EMPTY_FA }, retentions: [], // varias retenciones por línea (RENTA + IVA, etc.)
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

// N° de comprobante como un solo campo ("001-001-000000123") en vez de tres campos
// técnicos (establecimiento / punto de emisión / secuencial). Se parte al guardar
// para conservar el payload que espera el backend (estab/ptoEmi/secuencial + serie).
const joinComprobante = (estab, ptoEmi, secuencial) =>
  [estab, ptoEmi, secuencial].some((x) => x != null && x !== '') ? `${estab || ''}-${ptoEmi || ''}-${secuencial || ''}` : '';
const parseComprobante = (v) => {
  const [estab = '', ptoEmi = '', secuencial = ''] = String(v || '').split('-').map((s) => s.trim());
  return { estab, ptoEmi, secuencial };
};

export default function PurchaseInvoices() {
  const { hasRole } = useAuth();
  const [list, setList] = useState([]);
  const [show, setShow] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false); // datos SRI opcionales del comprobante
  const [activeSections, setActiveSections] = useState(['GASTO']); // secciones de línea visibles (progresivo)
  const [rowMenuUid, setRowMenuUid] = useState(null); // fila de gasto con el menú avanzado (⋮) abierto
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
  const [formError, setFormError] = useState(''); // error visible DENTRO del modal (no solo toast)
  const [retModal, setRetModal] = useState(null); // { purchase, series, estab, ptoEmi, periodMonth, periodYear }
  const [retEmitting, setRetEmitting] = useState(false);
  const [sriMismatch, setSriMismatch] = useState(null); // { sri, entered, diff, payload } → modal de confirmación
  // { warehouse, esperado, elegido } → el centro elegido no es el predeterminado de la bodega.
  const [ccMismatch, setCcMismatch] = useState(null);

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
    // Plan completo: AccountSelect filtra las elegibles (gasto/costo/inventario/activo)
    // y usa las agrupadoras para mostrar la ruta padre de cada cuenta.
    api.get('/chart-of-accounts').then((r) => setAccounts(r.data || []));
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

  /**
   * Al elegir la BODEGA de una línea se PROPONE su centro de costo. Es una propuesta:
   *   · si la línea aún no tiene centro, se rellena con el de la bodega;
   *   · si ya tiene uno elegido, NO se pisa (el documento manda).
   * La advertencia de "centro distinto al de la bodega" y la confirmación las decide el
   * BACKEND (`COST_CENTER_MISMATCH`): aquí solo se anticipa para que el usuario lo vea antes.
   */
  const onPickWarehouse = (u, warehouseId) => {
    const wh = warehouses.find((w) => String(w._id) === String(warehouseId));
    const propuesto = wh?.costCenter?._id || wh?.costCenter || '';
    setForm((f) => ({
      ...f,
      items: f.items.map((it) => {
        if (it._uid !== u) return it;
        const centroActual = it.costCenter || '';
        return { ...it, warehouse: warehouseId || '', costCenter: centroActual || propuesto || '' };
      }),
    }));
  };

  /** Centro esperado por la bodega de la línea (para avisar de la diferencia). */
  const centroDeBodega = (it) => {
    const wh = warehouses.find((w) => String(w._id) === String(it.warehouse));
    return wh?.costCenter?._id || wh?.costCenter || '';
  };
  const nombreCentro = (id) => {
    const c = costCenters.find((x) => String(x._id) === String(id));
    return c ? `${c.code} - ${c.name}` : '(sin centro)';
  };
  // Líneas cuya bodega tiene un centro predeterminado distinto del elegido.
  const diferenciasCentro = form.items
    .map((it) => {
      const esperado = centroDeBodega(it);
      if (!it.warehouse || !esperado || !it.costCenter) return null;
      if (String(esperado) === String(it.costCenter)) return null;
      const wh = warehouses.find((w) => String(w._id) === String(it.warehouse));
      return {
        linea: it.description || '(sin descripción)',
        bodega: wh?.name || '',
        esperado: nombreCentro(esperado),
        elegido: nombreCentro(it.costCenter),
      };
    })
    .filter(Boolean);
  const removeItem = (u) => setForm((f) => ({ ...f, items: f.items.filter((it) => it._uid !== u) }));
  const addItem = (lineType) => setForm((f) => {
    const it = makeItem(lineType);
    if (lineType === 'GASTO' && recurring.defaultAccount) it.account = recurring.defaultAccount._id;
    if (f.costCenter) it.costCenter = f.costCenter;
    return { ...f, items: [...f.items, it] };
  });
  // Agrega una retención (regla del catálogo) a una línea. Evita duplicar type+code y no
  // permite retención de IVA en una línea sin IVA (la base sería 0). El backend recalcula.
  const addLineRetention = (u, ruleId) => {
    if (!ruleId) return;
    const rule = retentionRules.find((r) => String(r._id) === String(ruleId));
    if (!rule) return;
    const line = form.items.find((it) => it._uid === u);
    if (rule.type === 'IVA' && !(Number(line?.ivaRate) > 0)) {
      return toast.error('No se puede aplicar retención de IVA a una línea sin IVA');
    }
    setForm((f) => ({
      ...f,
      items: f.items.map((it) => {
        if (it._uid !== u) return it;
        const rets = it.retentions || [];
        if (rets.some((x) => x.type === rule.type && String(x.code) === String(rule.code))) {
          toast.error(`La línea ya tiene la retención ${rule.type} ${rule.code}`);
          return it;
        }
        return { ...it, retentions: [...rets, { rule: rule._id, type: rule.type, code: rule.code, description: rule.description || '', rate: rule.rate }] };
      }),
    }));
  };
  const removeLineRetention = (u, idx) => setForm((f) => ({
    ...f,
    items: f.items.map((it) => (it._uid === u ? { ...it, retentions: (it.retentions || []).filter((_, i) => i !== idx) } : it)),
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
  // Al elegir la categoría de activo fijo NO se copian cuentas ni parámetros contables al
  // formulario: los define la categoría y se muestran solo lectura. El backend los toma
  // de la categoría al contabilizar.
  const onItemAssetCategory = (u, catId) => setForm((f) => ({
    ...f,
    items: f.items.map((it) => (it._uid === u ? {
      ...it,
      fixedAsset: { ...(it.fixedAsset || {}), category: catId, assetType: '' },
    } : it)),
  }));

  // Configuración contable/depreciación de una categoría de activo fijo (solo lectura).
  const assetCatConfig = (catId) => {
    const c = assetCategories.find((x) => String(x._id) === String(catId));
    if (!c) return null;
    const months = c.usefulLifeMonths || (c.usefulLifeYears ? c.usefulLifeYears * 12 : 0);
    const accName = (a) => (a && typeof a === 'object' ? `${a.code || ''} ${a.name || ''}`.trim() : (a ? '—' : null));
    const missing = [];
    if (!c.assetAccount) missing.push('cuenta de activo');
    if (!c.noDepreciate) {
      if (!c.depreciationAccount) missing.push('gasto depreciación');
      if (!c.accumDepreciationAccount) missing.push('dep. acumulada');
      if (!months) missing.push('vida útil');
      if (!c.expenseType) missing.push('tipo de gasto');
    }
    return {
      noDepreciate: !!c.noDepreciate, months, residualPercent: c.residualPercent || 0, expenseType: c.expenseType || '',
      assetAccount: accName(c.assetAccount), depreciationAccount: accName(c.depreciationAccount), accumDepreciationAccount: accName(c.accumDepreciationAccount),
      missing,
    };
  };
  const setFa = (u, patch) => setForm((f) => ({ ...f, items: f.items.map((it) => (it._uid === u ? { ...it, fixedAsset: { ...(it.fixedAsset || {}), ...patch } } : it)) }));

  const gastoItems = form.items.filter((it) => it.lineType === 'GASTO');
  const invItems = form.items.filter((it) => it.lineType === 'INVENTARIO');
  const afItems = form.items.filter((it) => it.lineType === 'ACTIVO_FIJO');

  // La visibilidad de cada sección refleja EXACTAMENTE la intención del usuario (los chips).
  // Al desactivar un tipo se eliminan sus líneas, así que `activeSections` es la única fuente.
  const visibleSections = {
    GASTO: activeSections.includes('GASTO'),
    INVENTARIO: activeSections.includes('INVENTARIO'),
    ACTIVO_FIJO: activeSections.includes('ACTIVO_FIJO'),
  };
  // ¿La línea tiene datos reales (no es un placeholder vacío recién agregado)?
  const lineHasData = (it) => {
    if (it.lineType === 'INVENTARIO') return !!it.product || lineBase(it) > 0;
    if (it.lineType === 'ACTIVO_FIJO') return !!(it.fixedAsset?.category || it.fixedAsset?.name || (it.description || '').trim()) || lineBase(it) > 0;
    return !!it.account || (it.accountSplits || []).length > 0 || (it.description || '').trim() !== '' || lineBase(it) > 0; // GASTO
  };
  // Chip de "¿Qué contiene esta factura?": alterna un tipo de línea.
  //  - Inactivo → se activa y se agrega su primera línea (vacía).
  //  - Activo → se desactiva y se quitan sus líneas (sin confirmación).
  //  - Se pueden quitar las 3: si al contabilizar no queda ninguna línea, el submit avisa el error.
  const toggleSection = (t) => {
    if (activeSections.includes(t)) {
      setActiveSections((s) => s.filter((x) => x !== t));
      setForm((f) => ({ ...f, items: f.items.filter((it) => it.lineType !== t) }));
      setRowMenuUid(null);
    } else {
      setActiveSections((s) => [...s, t]);
      addItem(t); // primera línea (vacía) para que la sección sea operativa
    }
  };

  // Retenciones de una línea normalizadas a arreglo (soporta el singular legacy).
  const ruleById = (id) => retentionRules.find((r) => String(r._id) === String(id));
  const lineRetList = (it) => {
    if (Array.isArray(it.retentions) && it.retentions.length) return it.retentions;
    if (it.retention && (it.retention.rule || it.retention.code)) return [it.retention];
    return [];
  };
  // Estimación viva de UNA retención (informativa; el backend recalcula al guardar).
  const retInfoOne = (it, r) => {
    const rule = r.rule ? ruleById(r.rule) : null;
    if (rule) { const { base, amount } = estimateRetention(it, rule); return { type: rule.type, code: rule.code, description: rule.description, rate: rule.rate, base, amount, account: rule.payableAccount }; }
    return { type: r.type, code: r.code, description: r.description, rate: r.rate || r.percentage || 0, base: r.base ?? r.baseAmount ?? 0, amount: r.amount || 0, account: r.account };
  };
  // Resumen de retenciones DERIVADO de todas las líneas (o de la cabecera legacy si no hay).
  const retSummary = (() => {
    const map = new Map();
    let anyLine = false;
    for (const it of form.items) {
      for (const r of lineRetList(it)) {
        const info = retInfoOne(it, r);
        if (!info || !(info.amount > 0)) continue;
        anyLine = true;
        const key = `${info.type}|${info.code}`;
        if (!map.has(key)) map.set(key, { ...info, base: 0, amount: 0 });
        const g = map.get(key);
        g.base = +(g.base + info.base).toFixed(2);
        g.amount = +(g.amount + info.amount).toFixed(2);
      }
    }
    if (anyLine) return [...map.values()];
    // Legacy: retenciones de cabecera capturadas manualmente.
    return (form.retentions || []).map((r) => ({ type: r.type, code: r.code, description: r.description || '', rate: r.percentage || 0, base: r.baseAmount || 0, amount: r.amount || 0, account: r.account }));
  })();

  // Etiqueta de una regla de retención: "312 · Renta · 1.75% · Compra de bienes muebles".
  const retentionLabel = (r) => `${r.code} · ${r.type === 'IVA' ? 'IVA' : 'Renta'} · ${r.rate}% · ${r.description || ''}`.trim();
  // Retenciones por línea (varias): chips de las seleccionadas + buscador de reglas del catálogo.
  const retCell = (it) => {
    const rets = lineRetList(it);
    const lineIva = Number(it.ivaRate) > 0;
    const selectedKeys = new Set(rets.map((r) => `${r.type}|${r.code}`));
    // Solo reglas reales del catálogo; se ocultan las ya elegidas y las de IVA si la línea no tiene IVA.
    const opts = retentionRules
      .filter((r) => (r.type === 'IVA' ? lineIva : true))
      .filter((r) => !selectedKeys.has(`${r.type}|${r.code}`));
    return (
      <div className="min-w-[180px] space-y-1">
        {rets.map((r, i) => {
          const info = retInfoOne(it, r);
          return (
            <span key={`${r.type}-${r.code}-${i}`} className={`inline-flex items-center gap-1 text-[11px] rounded-full px-2 py-0.5 border ${r.type === 'IVA' ? 'bg-sky-50 border-sky-200 text-sky-700' : 'bg-amber-50 border-amber-200 text-amber-700'}`} title={info.description || ''}>
              {r.type} {r.code} {info.rate}% <span className="font-mono">≈{fmt(info.amount)}</span>
              <button type="button" onClick={() => removeLineRetention(it._uid, i)} className="text-rose-500 hover:text-rose-600">×</button>
            </span>
          );
        })}
        {retentionRules.length === 0 ? (
          <span className="text-[11px] text-slate-400 italic">Catálogo de retenciones vacío</span>
        ) : (
          <SearchableSelect
            options={opts}
            value=""
            onChange={(v) => addLineRetention(it._uid, v)}
            getLabel={retentionLabel}
            getSearchText={(r) => `${r.code} ${r.type} ${r.rate} ${r.description || ''}`}
            placeholder="+ Agregar retención…"
            searchPlaceholder="Buscar código o concepto SRI…"
            size="sm"
            menuMinWidth={320}
            wrapOptions
          />
        )}
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

  // Error de validación/contabilización: visible DENTRO del modal (banner) además del toast.
  const fail = (msg) => { setFormError(msg); toast.error(msg); return undefined; };

  // Mapea las líneas del form al payload del backend (solo datos que el servidor espera;
  // de las retenciones solo va la SELECCIÓN regla/código: el backend recalcula).
  const buildItemsPayload = (cleanItems) => cleanItems.map((it) => {
    const retSel = lineRetList(it)
      .filter((r) => r.rule || r.code)
      .map((r) => ({ rule: r.rule || null, code: r.code, type: r.type }));
    const base = {
      lineType: it.lineType,
      description: it.description || (it.lineType === 'ACTIVO_FIJO' ? (it.fixedAsset?.name || '') : ''),
      quantity: Number(it.quantity) || (it.lineType === 'INVENTARIO' ? 0 : 1),
      unitPrice: Number(it.unitPrice) || 0,
      discount: Number(it.discount) || 0,
      ivaRate: it.ivaRate,
      costCenter: it.costCenter || null,
      retentions: retSel,
    };
    if (it.lineType === 'INVENTARIO') {
      base.product = it.product || null;
      base.inventoryCategory = it.inventoryCategory || null;
      base.warehouse = it.warehouse || null;
      base.lot = it.lot || '';
      base.expiryDate = it.expiryDate || null;
    } else if (it.lineType === 'ACTIVO_FIJO') {
      const fa = it.fixedAsset || {};
      // Solo datos DESCRIPTIVOS: las cuentas/parámetros contables los define la
      // categoría (el backend los ignora si se envían).
      base.fixedAsset = {
        category: fa.category || null, assetType: fa.assetType || null,
        code: fa.code || '', name: fa.name || it.description || '', serial: fa.serial || '',
        location: fa.location || '', locationClinic: fa.locationClinic || null, responsible: fa.responsible || null,
        acquisitionDate: fa.acquisitionDate || null, startDate: fa.startDate || null,
      };
    } else { // GASTO
      base.account = it.account || null;
      base.accountSplits = (it.accountSplits || []).map((s) => ({ account: s.account || null, amount: Number(s.amount) || 0, description: s.description || '' }));
    }
    return base;
  });

  // Envía la factura al endpoint que corresponde según el modo del modal.
  const sendInvoice = async (payload) => {
    if (authorizeId) return api.post(`/purchase-invoices/${authorizeId}/authorize`, payload);
    if (editId) return api.put(`/purchase-invoices/${editId}`, payload);
    return api.post('/purchase-invoices', payload);
  };

  const closeForm = () => { setShow(false); setForm(EMPTY); setAuthorizeId(null); setEditId(null); setFormError(''); setSriMismatch(null); setCcMismatch(null); };

  const submit = async (e) => {
    e.preventDefault();
    setFormError('');
    if (!form.supplier) return fail('Selecciona un proveedor');
    // El N° de comprobante ahora es un solo campo (001-001-000000123): exige el secuencial
    // salvo que la factura ya traiga una serie (documentos importados/editados).
    if (!form.serie && !(form.secuencial || '').trim()) return fail('Ingresa el N° de comprobante (formato 001-001-000000123)');
    // Ignora líneas placeholder totalmente vacías (p.ej. la línea inicial de una sección
    // recién activada que no se llegó a usar) para no bloquear el guardado.
    const cleanItems = form.items.filter(lineHasData);
    if (!cleanItems.length) return fail('Agrega al menos una línea (producto, gasto o activo fijo)');
    for (const it of cleanItems) {
      if (it.lineType === 'INVENTARIO' && !it.product) return fail('En productos/inventario, selecciona el producto en cada línea');
      if (it.lineType === 'ACTIVO_FIJO' && !(it.fixedAsset?.category)) return fail('En activos fijos, selecciona la categoría de activo fijo');
      if (it.lineType === 'ACTIVO_FIJO' && !(it.fixedAsset?.name || it.description)) return fail('El activo fijo necesita un nombre');
      if (it.lineType === 'GASTO') {
        const hasSplits = (it.accountSplits || []).length > 0;
        if (!it.account && !hasSplits) return fail(`Selecciona la cuenta contable de gasto para la línea "${it.description || '(sin descripción)'}"`);
        if (hasSplits) {
          const base = lineBase(it);
          const sum = +(it.accountSplits.reduce((s, sp) => s + (+sp.amount || 0), 0)).toFixed(2);
          if (Math.abs(sum - base) > 0.01) return fail(`La distribución de "${it.description || 'gasto'}" no cuadra (${fmt(sum)} ≠ ${fmt(base)})`);
          if (it.accountSplits.some((sp) => !sp.account)) return fail('Hay cuentas sin seleccionar en la distribución');
        }
      }
    }
    await enviar({}, authorizeId ? 'Factura contabilizada' : editId ? 'Cambios guardados' : 'Registrada');
  };

  /**
   * Envío ÚNICO. `extra` acumula las confirmaciones explícitas del usuario (diferencia con el
   * SRI, centro de costo distinto al de la bodega) para que confirmar una no pierda la otra:
   * el backend puede rechazar por las dos, una detrás de otra.
   */
  const enviar = async (extra = {}, okMsg = 'Guardada') => {
    try {
      const serie = form.serie || `${form.estab}-${form.ptoEmi}-${form.secuencial}`;
      const items = buildItemsPayload(form.items.filter(lineHasData));
      await sendInvoice({
        ...form, items, serie,
        costCenter: form.costCenter || null,
        fechaVencimiento: form.fechaVencimiento || null,
        fechaEmision: new Date(form.fechaEmision),
        ...extra,
      });
      toast.success(okMsg);
      closeForm(); load();
    } catch (err) {
      const data = err.response?.data;
      // Los totales editados no coinciden con los del SRI: modal de verificación
      // (no bloquea; el usuario puede confirmar bajo su responsabilidad).
      if (data?.code === 'SRI_MISMATCH') { setSriMismatch({ sri: data.sri, entered: data.entered, diff: data.diff, extra }); return; }
      // El centro de costo elegido no es el predeterminado de la bodega: se explica y se pide
      // confirmación. La compra queda con el centro ELEGIDO, y la diferencia, auditada.
      if (data?.code === 'COST_CENTER_MISMATCH') { setCcMismatch({ ...data, extra }); return; }
      fail(data?.message || 'Error');
    }
  };

  // El usuario revisó la comparación contra el SRI y decide continuar: se reenvía con
  // la aceptación explícita (queda marcada en la factura y en el log de auditoría).
  const confirmSriMismatch = () => enviar(
    { ...(sriMismatch?.extra || {}), acceptSriMismatch: true },
    'Factura contabilizada (diferencia con SRI aceptada y auditada)'
  );

  const confirmCostCenter = () => enviar(
    { ...(ccMismatch?.extra || {}), costCenterConfirmed: true },
    'Registrada con el centro de costo elegido (diferencia auditada)'
  );

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
          // Normaliza retenciones: usa el arreglo si viene; si no, envuelve el singular legacy.
          retentions: (Array.isArray(it.retentions) && it.retentions.length ? it.retentions : (it.retention ? [it.retention] : []))
            .filter((r) => r && (r.rule || r.code))
            .map((r) => ({ rule: r.rule?._id || r.rule || '', type: r.type, code: r.code, description: r.description || '', rate: r.rate ?? r.percentage ?? 0, account: r.account?._id || r.account || null })),
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
      // Activa solo las secciones cuyas líneas traen datos reales (no placeholders vacíos).
      const rawType = (it) => it.lineType || (it.product ? 'INVENTARIO' : ((it.fixedAsset?.category || it.fixedAsset?.name) ? 'ACTIVO_FIJO' : 'GASTO'));
      const rawHasData = (it) => {
        const value = Number(it.subtotal) || ((Number(it.quantity) || 0) * (Number(it.unitPrice) || 0) - (Number(it.discount) || 0));
        const lt = rawType(it);
        if (lt === 'INVENTARIO') return !!it.product || value > 0;
        if (lt === 'ACTIVO_FIJO') return !!(it.fixedAsset?.category || it.fixedAsset?.name || (it.description || '').trim()) || value > 0;
        return !!it.account || (it.accountSplits || []).length > 0 || (it.description || '').trim() !== '' || value > 0;
      };
      const loadedTypes = [...new Set((d.items || []).filter(rawHasData).map(rawType))];
      setActiveSections(loadedTypes.length ? loadedTypes : ['GASTO']);
      setRowMenuUid(null);
      setShowAdvanced(!!(d.autorizacion || d.paymentMethodSri || d.claveAcceso));
      setShow(true);
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  const openAuthorize = (p) => loadIntoForm(p, 'authorize');
  const openEdit = (p) => loadIntoForm(p, 'edit');

  // Deep-link desde el Libro Mayor (?doc=<id>): abre la factura de compra.
  useDocDeepLink((id) => loadIntoForm({ _id: id }, 'edit'));

  // Abre el modal de emisión: carga series (estab/ptoEmi) y precarga el periodo fiscal con el
  // de la FACTURA SUSTENTO (regla de los 5 días de la contadora).
  const emitRetention = async (p) => {
    try {
      const { data: cfg } = await api.get('/retention-vouchers/config');
      if (!cfg.configured) { toast.error('Falta configurar la facturación electrónica.'); return; }
      const sustento = p.fechaEmision ? new Date(p.fechaEmision) : new Date();
      const series = cfg.series || [];
      const estab = cfg.defaultEstab || series[0]?.estab || '001';
      const ptoEmi = (series.find((s) => s.estab === estab)?.puntosEmision || [cfg.defaultPtoEmi || '001'])[0];
      setRetModal({
        purchase: p, series,
        estab, ptoEmi,
        periodMonth: sustento.getMonth() + 1,
        periodYear: sustento.getFullYear(),
        sustentoLabel: `${p.serie || ''} · ${fmtDate(p.fechaEmision)}`,
      });
    } catch (e) { toast.error(e.response?.data?.message || 'No se pudo preparar la emisión'); }
  };

  const submitRetention = async () => {
    if (!retModal) return;
    setRetEmitting(true);
    try {
      await api.post(`/retention-vouchers/from-purchase/${retModal.purchase._id}`, {
        estab: retModal.estab, ptoEmi: retModal.ptoEmi,
        periodMonth: retModal.periodMonth, periodYear: retModal.periodYear,
      });
      toast.success('Retención emitida'); setRetModal(null); load();
    } catch (e) { toast.error(e.response?.data?.message || 'Error al emitir retención'); }
    finally { setRetEmitting(false); }
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
          <button onClick={() => { setForm({ ...EMPTY, items: [makeItem('GASTO')] }); setActiveSections(['GASTO']); setRowMenuUid(null); setAuthorizeId(null); setEditId(null); setShowAdvanced(false); setShow(true); }} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center gap-2"><HiOutlinePlus /> Nueva</button>
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

      <Modal isOpen={show} onClose={closeForm} title={authorizeId ? 'Verificar y contabilizar factura' : editId ? 'Editar factura de compra' : 'Nueva factura de compra'} size="2xl">
        <form onSubmit={submit} className="space-y-4">
          {formError && (
            <div className="sticky top-16 z-20 bg-rose-50 border border-rose-300 rounded-xl p-3 flex items-start gap-2 text-rose-700 shadow-md shadow-rose-100">
              <HiOutlineExclamationTriangle className="w-5 h-5 shrink-0 mt-0.5" />
              <div className="text-sm font-semibold flex-1">{formError}</div>
              <button type="button" onClick={() => setFormError('')} aria-label="Cerrar error" className="shrink-0 text-rose-400 hover:text-rose-600"><HiOutlineXMark className="w-4 h-4" /></button>
            </div>
          )}
          {/* Aviso ANTES de enviar: alguna línea usa un centro distinto al predeterminado de su
              bodega. No bloquea (el documento manda), pero al guardar habrá que confirmarlo. */}
          {diferenciasCentro.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-start gap-2 text-amber-800">
              <HiOutlineExclamationTriangle className="w-5 h-5 shrink-0 mt-0.5" />
              <div className="text-sm flex-1">
                <p className="font-semibold">Centro de costo distinto al de la bodega</p>
                <ul className="mt-1 space-y-0.5 text-xs">
                  {diferenciasCentro.map((d, i) => (
                    <li key={i}>
                      <b>{d.linea}</b> · bodega <b>{d.bodega}</b>: esperado {d.esperado}, se registrará con <b>{d.elegido}</b>.
                    </li>
                  ))}
                </ul>
                <p className="text-xs mt-1">Al guardar se te pedirá confirmarlo y quedará auditado.</p>
              </div>
            </div>
          )}
          {authorizeId && <div className="bg-amber-50 border border-amber-200 text-amber-800 text-xs rounded-lg px-3 py-2">Factura cargada automáticamente. Clasifica cada renglón (Productos, Gastos o Activos fijos) y verifica los datos antes de contabilizar.</div>}
          <SriCompareBanner sri={form.sriTotals} totals={totals} ice={+form.ice || 0} propina={+form.propina || 0} />

          {/* ── 1. Datos generales ── */}
          <SectionCard title="Datos de la factura" icon={HiOutlineDocumentText}>
            <div className="grid grid-cols-2 md:grid-cols-6 gap-x-3 gap-y-2.5">
              <Field label="Proveedor" required className="col-span-2 md:col-span-3">
                <SearchableSelect options={suppliers} value={form.supplier} onChange={onSelectSupplier} getLabel={(s) => `${s.ruc} - ${s.razonSocial}`} getSearchText={(s) => `${s.ruc} ${s.razonSocial} ${s.nombreComercial || ''}`} placeholder="Seleccione un proveedor…" searchPlaceholder="Buscar por RUC o nombre…" />
              </Field>
              <Field label="N° de comprobante" required className="col-span-2 md:col-span-2" hint="Formato 001-001-000000123">
                <input required placeholder="001-001-000000123" value={joinComprobante(form.estab, form.ptoEmi, form.secuencial) || form.serie || ''} onChange={(e) => setForm((f) => ({ ...f, ...parseComprobante(e.target.value), serie: '' }))} className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm font-mono" />
              </Field>
              <Field label="Tipo">
                <select value={form.docType} onChange={(e) => setForm({ ...form, docType: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm bg-white">
                  <option value="FACTURA">Factura</option><option value="NOTA_VENTA">Nota de venta</option><option value="LIQUIDACION">Liquidación</option><option value="NOTA_DEBITO_REC">Nota débito</option><option value="NOTA_CREDITO_REC">Nota crédito</option>
                </select>
              </Field>
              <Field label="Fecha de emisión" required className="col-span-1 md:col-span-2"><input type="date" required value={form.fechaEmision} onChange={(e) => setForm((f) => ({ ...f, fechaEmision: e.target.value, fechaVencimiento: f.creditDays ? addDays(e.target.value, f.creditDays) : f.fechaVencimiento }))} className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm" /></Field>
              <Field label="Días de crédito"><NumericInput value={form.creditDays} onChange={(e) => setForm((f) => ({ ...f, creditDays: +e.target.value, fechaVencimiento: +e.target.value > 0 ? addDays(f.fechaEmision, +e.target.value) : '' }))} className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm text-right" /></Field>
              <Field label="Vencimiento"><input type="date" value={form.fechaVencimiento || ''} onChange={(e) => setForm({ ...form, fechaVencimiento: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm" /></Field>
              <Field label="Centro de costo (factura)" className="col-span-2 md:col-span-2">
                <SearchableSelect options={costCenters} value={form.costCenter} onChange={setInvoiceCostCenter} getLabel={(c) => `${c.code} - ${c.name}`} getSearchText={(c) => `${c.code} ${c.name}`} placeholder="— sin centro —" searchPlaceholder="Buscar centro…" allowClear />
              </Field>
              <Field label="Observación (factura)" className="col-span-2 md:col-span-6"><input placeholder="Descripción general de la factura (opcional)" value={form.notes || ''} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm" /></Field>
            </div>
            {/* Campos SRI menos usados: ocultos por defecto para no saturar la pantalla. */}
            <button type="button" onClick={() => setShowAdvanced((v) => !v)} className="mt-3 text-xs font-medium text-emerald-700 hover:underline flex items-center gap-1">
              {showAdvanced ? '− Ocultar datos adicionales' : '+ Datos adicionales (autorización SRI, forma de pago)'}
            </button>
            {showAdvanced && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-x-3 gap-y-2.5 mt-2 pt-3 border-t border-slate-100">
                <Field label="N° de autorización SRI" className="col-span-2"><input placeholder="Opcional" value={form.autorizacion} onChange={(e) => setForm({ ...form, autorizacion: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm" /></Field>
                <Field label="Forma de pago (SRI)" className="col-span-2"><input placeholder="Opcional" value={form.paymentMethodSri || ''} onChange={(e) => setForm({ ...form, paymentMethodSri: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm" /></Field>
              </div>
            )}
          </SectionCard>

          {/* ── ¿Qué contiene esta factura? — activa solo las secciones que apliquen ── */}
          <div className="border border-slate-200 rounded-xl px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-slate-700 mr-1">¿Qué contiene esta factura?</span>
              {LINE_TYPES.map(({ t, label, icon: Icon }) => {
                const on = visibleSections[t];
                return (
                  <button type="button" key={t} onClick={() => toggleSection(t)}
                    title={on ? 'Clic para quitar este tipo de línea' : 'Clic para agregar este tipo de línea'}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm border transition ${on ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-600 border-slate-200 hover:border-emerald-300 hover:text-emerald-700'}`}>
                    {Icon && <Icon className="w-4 h-4" />} {label} {on && <HiOutlineCheck className="w-3.5 h-3.5" />}
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-slate-400 mt-2">Activa solo lo que trae la factura; toca de nuevo un tipo para quitarlo. Puedes combinar varios para una factura mixta.</p>
          </div>

          {/* ── Productos / Inventario (solo si aplica) ── */}
          {visibleSections.INVENTARIO && (
          <SectionCard title="Productos / Inventario" icon={HiOutlineCube} onAdd={() => addItem('INVENTARIO')} addLabel="Agregar producto" count={invItems.length}>
            {invItems.length === 0 ? (
              <EmptyHint>Sin productos aún. Usa “Agregar producto” para insumos que entran a stock.</EmptyHint>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-[11px] uppercase text-slate-400"><tr className="text-left">
                    <th className="py-1 pr-2">Producto</th><th className="py-1 px-2">Bodega</th>
                    <th className="py-1 px-2 text-right">Cant.</th><th className="py-1 px-2 text-right">Precio</th><th className="py-1 px-2 text-right">Desc.</th><th className="py-1 px-2">IVA</th>
                    <th className="py-1 px-2">Centro de costo</th><th className="py-1 px-2">Retención</th><th className="py-1 px-2 text-right">Total</th><th></th>
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
                              <div className="flex-1 min-w-0"><SearchableSelect options={products} value={it.product} onChange={(v) => onPickProduct(it._uid, v)} getLabel={(p) => p.name} getSearchText={(p) => `${p.name} ${p.code || ''}`} renderOption={(p) => (<span className="block">{p.name}{p.code ? <span className="block text-[11px] text-slate-400 font-mono">{p.code}</span> : null}</span>)} placeholder="Selecciona producto…" searchPlaceholder="Buscar producto…" allowClear size="sm" menuMinWidth={340} wrapOptions /></div>
                              <button type="button" onClick={() => setNewProductItemUid(it._uid)} title="Crear producto nuevo" className="shrink-0 p-1.5 rounded-lg border border-emerald-200 text-emerald-700 hover:bg-emerald-50 bg-white"><HiOutlinePlus className="w-4 h-4" /></button>
                            </div>
                            {missing && <div className="text-[11px] text-rose-600 flex items-center gap-1 mt-1"><HiOutlineExclamationTriangle className="w-3.5 h-3.5" /> {cat ? 'La categoría del producto no tiene cuenta de inventario' : 'El producto no tiene categoría contable'}</div>}
                          </td>
                          <td className="py-1.5 px-2 min-w-[110px]"><SearchableSelect options={[{ _id: '', name: 'General' }, ...warehouses]} value={it.warehouse} onChange={(v) => onPickWarehouse(it._uid, v)} getLabel={(w) => w.name} placeholder="General" searchPlaceholder="Buscar bodega…" size="sm" /></td>
                          <td className="py-1.5 px-2 w-20"><NumericInput step="0.01" value={it.quantity} onChange={(e) => setItem(it._uid, { quantity: +e.target.value })} className={`${inputCls} text-right`} /></td>
                          <td className="py-1.5 px-2 w-24"><NumericInput step="0.01" value={it.unitPrice} onChange={(e) => setItem(it._uid, { unitPrice: +e.target.value })} className={`${inputCls} text-right`} /></td>
                          <td className="py-1.5 px-2 w-20"><NumericInput step="0.01" value={it.discount} onChange={(e) => setItem(it._uid, { discount: +e.target.value })} className={`${inputCls} text-right`} /></td>
                          <td className="py-1.5 px-2 w-20"><IvaSelect value={it.ivaRate} onChange={(v) => setItem(it._uid, { ivaRate: v })} /></td>
                          <td className="py-1.5 px-2 min-w-[130px]"><SearchableSelect options={costCenters} value={it.costCenter} onChange={(v) => setItem(it._uid, { costCenter: v })} getLabel={(c) => `${c.code} - ${c.name}`} getSearchText={(c) => `${c.code} ${c.name}`} placeholder="— sin centro —" searchPlaceholder="Buscar centro…" allowClear size="sm" /></td>
                          <td className="py-1.5 px-2">{retCell(it)}</td>
                          <td className="py-1.5 px-2 text-right font-mono text-slate-700 w-24">{fmt(lineBase(it))}</td>
                          <td className="py-1.5 pl-1"><button type="button" onClick={() => removeItem(it._uid)} className="text-rose-500 hover:text-rose-600"><HiOutlineXMark className="w-4 h-4" /></button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="text-[11px] text-slate-400 mt-1.5">La cuenta de inventario se toma automáticamente de la categoría del producto.</p>
              </div>
            )}
          </SectionCard>
          )}

          {/* ── Cuentas / Gastos (solo si aplica) ── */}
          {visibleSections.GASTO && (
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
              <EmptyHint>Sin gastos aún. Usa “Agregar gasto” para transporte, servicios, comisiones, etc.</EmptyHint>
            ) : (
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
                                <div className="text-xs text-slate-500 border border-slate-200 rounded-lg px-2 py-2 bg-slate-50">Cuentas distribuidas (ver abajo)</div>
                              ) : (
                                <AccountSelect accounts={accounts} value={it.account} onChange={(v) => setItem(it._uid, { account: v })} filter={expenseAccountFilter} placeholder="Cuenta de gasto…" size="sm" />
                              )}
                            </td>
                            <td className="py-1.5 px-2 min-w-[160px]"><input value={it.description} onChange={(e) => setItem(it._uid, { description: e.target.value })} placeholder="Detalle del gasto" className={inputCls} /></td>
                            <td className="py-1.5 px-2 w-24"><NumericInput step="0.01" value={it.unitPrice} onChange={(e) => setItem(it._uid, { unitPrice: +e.target.value, quantity: 1 })} className={`${inputCls} text-right`} /></td>
                            <td className="py-1.5 px-2 w-20"><IvaSelect value={it.ivaRate} onChange={(v) => setItem(it._uid, { ivaRate: v })} /></td>
                            <td className="py-1.5 px-2 min-w-[130px]"><SearchableSelect options={costCenters} value={it.costCenter} onChange={(v) => setItem(it._uid, { costCenter: v })} getLabel={(c) => `${c.code} - ${c.name}`} getSearchText={(c) => `${c.code} ${c.name}`} placeholder="— sin centro —" searchPlaceholder="Buscar centro…" allowClear size="sm" /></td>
                            <td className="py-1.5 px-2">{retCell(it)}</td>
                            <td className="py-1.5 pl-1">
                              <div className="flex items-center justify-end gap-1">
                                {!hasSplits && <button type="button" onClick={() => setRowMenuUid(rowMenuUid === it._uid ? null : it._uid)} title="Opciones avanzadas" className="text-slate-400 hover:text-slate-600"><HiOutlineEllipsisVertical className="w-4 h-4" /></button>}
                                <button type="button" onClick={() => removeItem(it._uid)} title="Eliminar" className="text-rose-500 hover:text-rose-600"><HiOutlineXMark className="w-4 h-4" /></button>
                              </div>
                            </td>
                          </tr>
                          {rowMenuUid === it._uid && !hasSplits && (
                            <tr className="bg-slate-50/60"><td colSpan={7} className="px-2 py-2">
                              <div className="flex flex-wrap items-center gap-2 text-xs">
                                <span className="font-semibold text-slate-500">Opciones avanzadas:</span>
                                <button type="button" onClick={() => { setItem(it._uid, { accountSplits: [{ account: it.account || '', amount: base, description: it.description || '' }] }); setRowMenuUid(null); }} className="px-2 py-1 rounded-lg border border-slate-200 bg-white text-slate-600 hover:border-emerald-300 hover:text-emerald-700">Dividir en varias cuentas contables</button>
                                <span className="text-slate-400">Solo para casos especiales (un gasto que se reparte entre varias cuentas).</span>
                              </div>
                            </td></tr>
                          )}
                          {hasSplits && (
                            <tr className="bg-slate-50/60"><td colSpan={7} className="px-2 py-2">
                              <div className="flex items-center justify-between mb-1">
                                <div className="text-[11px] font-semibold text-slate-600">Distribución en varias cuentas (valor {fmt(base)})</div>
                                <button type="button" onClick={() => setItem(it._uid, { accountSplits: [] })} className="text-xs text-sky-600">Usar una sola cuenta</button>
                              </div>
                              {splits.map((sp, j) => (
                                <div key={j} className="flex items-center gap-2 mb-1.5">
                                  <div className="flex-1 min-w-0"><AccountSelect accounts={accounts} value={sp.account} onChange={(v) => setSplit(j, { account: v })} filter={expenseAccountFilter} placeholder="Cuenta…" size="sm" /></div>
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
            )}
          </SectionCard>
          )}

          {/* ── Activos fijos (solo si aplica) ── */}
          {visibleSections.ACTIVO_FIJO && (
          <SectionCard title="Activos fijos" icon={HiOutlineBuildingOffice2} onAdd={() => addItem('ACTIVO_FIJO')} addLabel="Agregar activo fijo" count={afItems.length}>
            {afItems.length === 0 ? (
              <EmptyHint>Sin activos fijos aún. Usa “Agregar activo fijo” para equipos/muebles a capitalizar.</EmptyHint>
            ) : (
              <div className="space-y-3">
                {afItems.map((it) => {
                  const fa = it.fixedAsset || {};
                  const roots = assetCategories.filter((c) => !c.parent);
                  const types = assetCategories.filter((c) => c.parent && String(c.parent) === String(fa.category));
                  const cfg = assetCatConfig(fa.category);
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
                        <Field label="Centro de costo"><SearchableSelect options={costCenters} value={it.costCenter} onChange={(v) => setItem(it._uid, { costCenter: v })} getLabel={(c) => `${c.code} - ${c.name}`} getSearchText={(c) => `${c.code} ${c.name}`} placeholder="— sin centro —" searchPlaceholder="Buscar centro…" allowClear size="sm" /></Field>
                        <Field label="Retención">{retCell(it)}</Field>
                      </div>
                      {cfg && (cfg.missing.length ? (
                        <div className="rounded-lg border px-2.5 py-2 text-[11px] bg-rose-50 border-rose-200 text-rose-600 flex items-center gap-1"><HiOutlineExclamationTriangle className="w-3.5 h-3.5" /> La categoría tiene configuración contable incompleta: falta {cfg.missing.join(', ')}. No se podrá contabilizar.</div>
                      ) : (
                        <details className="rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-[11px]">
                          <summary className="cursor-pointer text-slate-500 font-medium">Ver configuración contable (automática desde la categoría)</summary>
                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-0.5 text-slate-600 font-mono mt-1.5">
                            <span>Activo: {cfg.assetAccount || '—'}</span>
                            <span>Gasto dep.: {cfg.noDepreciate ? 'No deprecia' : (cfg.depreciationAccount || '—')}</span>
                            <span>Dep. acum.: {cfg.noDepreciate ? '—' : (cfg.accumDepreciationAccount || '—')}</span>
                            <span>Vida útil: {cfg.noDepreciate ? '—' : `${cfg.months} meses`}</span>
                            <span>Residual: {cfg.noDepreciate ? '—' : `${cfg.residualPercent}%`}</span>
                            <span>Tipo gasto: {cfg.expenseType || '—'}</span>
                          </div>
                        </details>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
          </SectionCard>
          )}

          {/* ── Retenciones: resumen compacto de solo lectura (solo si hay retenciones) ── */}
          {retSummary.length > 0 && (
            <div className="border border-slate-200 rounded-xl overflow-hidden">
              <div className="flex flex-wrap items-center gap-2 bg-slate-50 px-3 py-2 border-b border-slate-200">
                <HiOutlineBanknotes className="w-4 h-4 text-emerald-600" />
                <h3 className="text-sm font-semibold text-slate-700">Retenciones</h3>
                <span className="text-[11px] text-slate-400">Automáticas: se calculan del código elegido en cada línea.</span>
              </div>
              <div className="p-3 space-y-2">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-[11px] uppercase text-slate-400"><tr className="text-left">
                      <th className="py-1 pr-2">Código</th><th className="py-1 px-2">Concepto</th>
                      <th className="py-1 px-2 text-right">Base</th><th className="py-1 px-2 text-right">%</th><th className="py-1 px-2 text-right">Valor</th>
                    </tr></thead>
                    <tbody>
                      {retSummary.map((r, i) => (
                        <tr key={`${r.type}-${r.code}-${i}`} className="border-t border-slate-100">
                          <td className="py-1.5 pr-2 font-mono">{r.type} {r.code}</td>
                          <td className="py-1.5 px-2 text-slate-600">{r.description || '—'}</td>
                          <td className="py-1.5 px-2 text-right font-mono">{fmt(r.base)}</td>
                          <td className="py-1.5 px-2 text-right font-mono">{r.rate}%</td>
                          <td className="py-1.5 px-2 text-right font-mono">{fmt(r.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot><tr className="border-t border-slate-200 font-semibold"><td colSpan={4} className="py-1.5 px-2 text-right">Total retenido</td><td className="py-1.5 px-2 text-right font-mono">{fmt(totals.retTotal)}</td></tr></tfoot>
                  </table>
                </div>
                <details className="text-[11px]">
                  <summary className="cursor-pointer text-slate-500">Datos adicionales de retención</summary>
                  <div className="mt-2 max-w-xs">
                    <Field label="N° comprobante de retención (opcional)"><input placeholder="Opcional" value={form.retentionNumber} onChange={(e) => setForm({ ...form, retentionNumber: e.target.value })} className="block w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" /></Field>
                  </div>
                </details>
              </div>
            </div>
          )}

          {/* ── 6. Totales ── */}
          <div className="rounded-xl border border-slate-200 overflow-hidden grid grid-cols-1 sm:grid-cols-3">
            <div className="sm:col-span-2 p-4 grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm bg-white">
              <span className="text-slate-500">Subtotal 0%</span><span className="text-right font-mono">{fmt(totals.s0)}</span>
              <span className="text-slate-500">Subtotal con IVA</span><span className="text-right font-mono">{fmt(totals.subtotalConIva)}</span>
              {(totals.sNo + totals.sEx) > 0 && (<><span className="text-slate-500">No objeto / Exento</span><span className="text-right font-mono">{fmt(totals.sNo + totals.sEx)}</span></>)}
              {totals.discount > 0 && (<><span className="text-slate-500">Descuentos</span><span className="text-right font-mono">-{fmt(totals.discount)}</span></>)}
              <span className="text-slate-500">IVA</span><span className="text-right font-mono">{fmt(totals.iva)}</span>
              <span className="text-slate-600 font-medium border-t border-slate-100 pt-1.5 mt-0.5">Total factura</span><span className="text-right font-mono font-semibold border-t border-slate-100 pt-1.5 mt-0.5">${fmt(totals.total)}</span>
              {totals.retTotal > 0 && (<><span className="text-amber-700">(−) Retenciones</span><span className="text-right font-mono text-amber-700">-{fmt(totals.retTotal)}</span></>)}
            </div>
            <div className="bg-emerald-50 p-4 flex flex-col justify-center items-end border-t sm:border-t-0 sm:border-l border-slate-200">
              <span className="text-[11px] uppercase tracking-wide text-emerald-700/70">Total a pagar</span>
              <span className="text-2xl font-bold text-emerald-700 font-mono">${fmt(totals.balance)}</span>
            </div>
          </div>

          <div className="flex justify-end gap-2"><button type="button" onClick={closeForm} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button><button className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20">{authorizeId ? 'Contabilizar' : editId ? 'Guardar cambios' : 'Registrar'}</button></div>
        </form>
      </Modal>

      {/* Verificación contra el SRI: los totales editados no coinciden con el comprobante.
          Se muestra ENCIMA del modal de la factura; permite volver a revisar o continuar
          bajo responsabilidad (queda auditado). */}
      <Modal isOpen={!!sriMismatch} onClose={() => setSriMismatch(null)} title="Los valores no coinciden con el SRI" size="md">
        {sriMismatch && (
          <div className="space-y-3">
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-start gap-2 text-amber-800">
              <HiOutlineExclamationTriangle className="w-5 h-5 shrink-0 mt-0.5" />
              <p className="text-sm">Los valores ingresados no coinciden con los reportados por el SRI para este comprobante. <b>Revise antes de contabilizar.</b></p>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-slate-100 text-xs uppercase text-slate-500">
                <tr><th className="px-3 py-2 text-left">Concepto</th><th className="px-3 py-2 text-right">SRI</th><th className="px-3 py-2 text-right">Ingresado</th><th className="px-3 py-2 text-right">Diferencia</th></tr>
              </thead>
              <tbody>
                {[['Subtotal', 'subtotal'], ['IVA', 'iva'], ['Total', 'total']].map(([label, k]) => (
                  <tr key={k} className={`border-t ${Math.abs(sriMismatch.diff?.[k] || 0) > 0.01 ? 'bg-rose-50' : ''}`}>
                    <td className="px-3 py-2 font-medium text-slate-700">{label}</td>
                    <td className="px-3 py-2 text-right font-mono">${fmt(sriMismatch.sri?.[k])}</td>
                    <td className="px-3 py-2 text-right font-mono">${fmt(sriMismatch.entered?.[k])}</td>
                    <td className={`px-3 py-2 text-right font-mono font-semibold ${Math.abs(sriMismatch.diff?.[k] || 0) > 0.01 ? 'text-rose-600' : 'text-slate-400'}`}>{sriMismatch.diff?.[k] > 0 ? '+' : ''}{fmt(sriMismatch.diff?.[k])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-xs text-slate-500">Si continúa, la factura se contabilizará con los valores ingresados y quedará registrado en la auditoría que usted aceptó la diferencia.</p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setSriMismatch(null)} className="px-4 py-2 bg-slate-200 rounded-xl">Volver a revisar</button>
              <button type="button" onClick={confirmSriMismatch} className="px-4 py-2 bg-amber-600 text-white rounded-xl shadow-sm shadow-amber-600/20">Continuar bajo mi responsabilidad</button>
            </div>
          </div>
        )}
      </Modal>

      {/* El centro de costo elegido no es el predeterminado de la bodega. No se bloquea: se
          explica (bodega, centro esperado, centro elegido) y se pide confirmación. La compra
          queda con el centro ELEGIDO y la diferencia se audita. */}
      <Modal isOpen={!!ccMismatch} onClose={() => setCcMismatch(null)} title="Centro de costo distinto al de la bodega" size="md">
        {ccMismatch && (
          <div className="space-y-3">
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-start gap-2 text-amber-800">
              <HiOutlineExclamationTriangle className="w-5 h-5 shrink-0 mt-0.5" />
              <p className="text-sm">
                La bodega <b>{ccMismatch.warehouse?.name}</b> tiene un centro de costo predeterminado
                distinto del que estás usando en esta compra.
              </p>
            </div>
            <table className="w-full text-sm">
              <tbody>
                <tr className="border-t">
                  <td className="px-3 py-2 font-medium text-slate-700">Centro esperado (bodega)</td>
                  <td className="px-3 py-2 text-right">{ccMismatch.esperado?.code} - {ccMismatch.esperado?.name}</td>
                </tr>
                <tr className="border-t bg-amber-50">
                  <td className="px-3 py-2 font-medium text-slate-700">Centro elegido</td>
                  <td className="px-3 py-2 text-right font-semibold text-amber-700">{ccMismatch.elegido?.code} - {ccMismatch.elegido?.name}</td>
                </tr>
              </tbody>
            </table>
            <p className="text-xs text-slate-500">
              Si continúas, la compra <b>quedará registrada con el centro elegido</b> ({ccMismatch.elegido?.name}),
              y así irá al asiento, al movimiento de inventario y a los activos fijos que genere.
              La diferencia queda en el log de auditoría.
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setCcMismatch(null)} className="px-4 py-2 bg-slate-200 rounded-xl">Volver a revisar</button>
              <button type="button" onClick={confirmCostCenter} className="px-4 py-2 bg-amber-600 text-white rounded-xl shadow-sm shadow-amber-600/20">Registrar con el centro elegido</button>
            </div>
          </div>
        )}
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

      {/* Emisión del comprobante de retención: serie (estab/ptoEmi) y periodo fiscal (regla 5 días) */}
      <Modal isOpen={!!retModal} onClose={() => setRetModal(null)} title="Emitir comprobante de retención" size="md">
        {retModal && (
          <div className="space-y-3 text-sm">
            <p className="text-xs text-slate-500">Factura sustento: <b>{retModal.sustentoLabel}</b>. El secuencial y el número de autorización son electrónicos: se generan automáticamente.</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Establecimiento</label>
                <select value={retModal.estab}
                  onChange={(e) => {
                    const estab = e.target.value;
                    const pts = retModal.series.find((s) => s.estab === estab)?.puntosEmision || ['001'];
                    setRetModal((m) => ({ ...m, estab, ptoEmi: pts.includes(m.ptoEmi) ? m.ptoEmi : pts[0] }));
                  }}
                  className="w-full border border-slate-200 rounded-xl px-3 py-2">
                  {retModal.series.map((s) => <option key={s.estab} value={s.estab}>{s.estab}{s.name ? ` — ${s.name}` : ''}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Punto de emisión</label>
                <select value={retModal.ptoEmi} onChange={(e) => setRetModal((m) => ({ ...m, ptoEmi: e.target.value }))} className="w-full border border-slate-200 rounded-xl px-3 py-2">
                  {(retModal.series.find((s) => s.estab === retModal.estab)?.puntosEmision || ['001']).map((pt) => <option key={pt} value={pt}>{pt}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Periodo fiscal — mes</label>
                <select value={retModal.periodMonth} onChange={(e) => setRetModal((m) => ({ ...m, periodMonth: +e.target.value }))} className="w-full border border-slate-200 rounded-xl px-3 py-2">
                  {['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'].map((mn, i) => <option key={i} value={i + 1}>{mn}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Periodo fiscal — año</label>
                <input type="number" value={retModal.periodYear} onChange={(e) => setRetModal((m) => ({ ...m, periodYear: +e.target.value }))} className="w-full border border-slate-200 rounded-xl px-3 py-2" />
              </div>
            </div>
            <p className="text-[11px] text-slate-400">El periodo fiscal pertenece al mes de la factura sustento (aunque la retención se emita días después). No puede ser anterior al mes del sustento ni posterior al mes de hoy.</p>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => setRetModal(null)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button>
              <button type="button" disabled={retEmitting} onClick={submitRetention} className="px-4 py-2 bg-indigo-600 text-white rounded-xl disabled:opacity-60">{retEmitting ? 'Emitiendo…' : 'Emitir retención'}</button>
            </div>
          </div>
        )}
      </Modal>

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
/**
 * Aviso en vivo para facturas importadas del SRI (TXT/XML): compara los totales del
 * comprobante contra lo que el usuario tiene EN PANTALLA. Verde si cuadra; ámbar con
 * el detalle de cada diferencia si no (la verificación dura la hace el backend al
 * contabilizar, esto es solo para que el usuario lo vea venir).
 */
function SriCompareBanner({ sri, totals, ice = 0, propina = 0 }) {
  if (!sri || sri.total == null) return null;
  const entered = {
    subtotal: +(totals.subtotal || 0).toFixed(2),
    iva: +(totals.iva || 0).toFixed(2),
    total: +((totals.subtotal || 0) + (totals.iva || 0) + ice + propina).toFixed(2),
  };
  const rows = [['Subtotal', 'subtotal'], ['IVA', 'iva'], ['Total', 'total']]
    .map(([label, k]) => ({ label, sri: +(sri[k] || 0).toFixed(2), entered: entered[k], diff: +(entered[k] - (sri[k] || 0)).toFixed(2) }));
  const mismatched = rows.filter((r) => Math.abs(r.diff) > 0.01);
  if (!mismatched.length) {
    return (
      <div className="bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs rounded-lg px-3 py-2 flex items-center gap-2">
        <HiOutlineCheck className="w-4 h-4 shrink-0" /> Los valores coinciden con el comprobante del SRI (Subtotal ${fmt(sri.subtotal)} · IVA ${fmt(sri.iva)} · Total ${fmt(sri.total)}).
      </div>
    );
  }
  return (
    <div className="bg-amber-50 border border-amber-300 text-amber-800 text-xs rounded-lg px-3 py-2">
      <div className="flex items-center gap-2 font-semibold"><HiOutlineExclamationTriangle className="w-4 h-4 shrink-0" /> Los valores en pantalla no coinciden con el comprobante del SRI:</div>
      <ul className="mt-1 ml-6 list-disc space-y-0.5">
        {mismatched.map((r) => (
          <li key={r.label}><b>{r.label}</b>: SRI ${fmt(r.sri)} / Ingresado ${fmt(r.entered)} (diferencia {r.diff > 0 ? '+' : ''}{fmt(r.diff)})</li>
        ))}
      </ul>
      <p className="mt-1 ml-6 text-amber-700/80">Al contabilizar se le pedirá confirmar la diferencia (queda en auditoría).</p>
    </div>
  );
}

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
