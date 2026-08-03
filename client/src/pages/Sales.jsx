import { useState, useEffect } from 'react';
import api from '../api/axios';
import Modal from '../components/Modal';
import { downloadFile } from '../utils/download';
import ProductAutocomplete from '../components/ProductAutocomplete';
import PageHeader, { EmptyState } from '../components/PageHeader';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { fmtDateTime } from '../utils/date';
import NumericInput from '../components/NumericInput';
import useDocDeepLink from '../hooks/useDocDeepLink';
import useSriLookup, { fillField } from '../hooks/useSriLookup';
import SriStatus from '../components/SriStatus';
import EmailStatus from '../components/EmailStatus';
import ConsumidorFinalAlert from '../components/ConsumidorFinalAlert';
import useEmailValidation from '../hooks/useEmailValidation';
import {
  HiOutlinePlus,
  HiOutlineEye,
  HiOutlineXCircle,
  HiOutlineTrash,
  HiOutlineDocumentText,
  HiOutlineBanknotes,
  HiOutlineArrowDownTray,
  HiOutlineCalculator,
  HiOutlineUser,
  HiOutlineShoppingCart,
  HiOutlineBuildingStorefront,
} from 'react-icons/hi2';
import JournalEntryViewModal from '../components/JournalEntryViewModal';

const paymentMethods = {
  efectivo: 'Efectivo',
  tarjeta: 'Tarjeta',
  transferencia: 'Transferencia',
  credito: 'Crédito (CxC)',
};
// Etiqueta legible de un método (incluye 'mixto' para el detalle).
const methodLabel = (m) => paymentMethods[m] || (m === 'mixto' ? 'Pago mixto' : m || '—');

/**
 * TIPO DE TARJETA. Contablemente no es lo mismo: el débito entra casi de inmediato y el
 * crédito queda "por liquidar" con su comisión y su retención. El reporte de ventas ya separa
 * `tarjeta_debito` de `tarjeta_credito` a partir del snapshot que guarda la venta, pero hasta
 * ahora ese dato solo se podía deducir de la configuración de la tarjeta: si un mismo
 * adquirente (Datafast) procesaba ambas, todo se reportaba igual. Aquí se elige explícitamente.
 */
const CARD_TYPES = [
  { value: 'CREDITO', label: 'Crédito' },
  { value: 'DEBITO', label: 'Débito' },
];

/** Sección del modal de venta: agrupa campos afines con su título. */
function FormSection({ title, subtitle, icon: Icon, children, className = '' }) {
  return (
    <section className={`border border-slate-200 rounded-xl overflow-hidden ${className}`}>
      <header className="bg-slate-50 px-3 py-2 border-b border-slate-200">
        <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-1.5">
          {Icon && <Icon className="w-4 h-4 text-emerald-600" />}{title}
        </h3>
        {subtitle && <p className="text-[11px] text-slate-500 mt-0.5">{subtitle}</p>}
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

/**
 * Lista de precios de un producto, normalizada. Los productos anteriores a la lista solo
 * tienen `salePrice`: se sintetiza una entrada para que la UI sea la misma en ambos casos.
 */
const priceListOf = (product) => (
  Array.isArray(product?.salePrices) && product.salePrices.length
    ? product.salePrices.map((p) => ({ name: p.name || 'General', price: Number(p.price) || 0, active: !!p.active }))
    : [{ name: 'General', price: Number(product?.salePrice) || 0, active: true }]
);
const activePriceOf = (product) => {
  const list = priceListOf(product);
  return list.find((p) => p.active) || list[0];
};

export default function Sales() {
  const { hasRole } = useAuth();
  const [journalSale, setJournalSale] = useState(null); // venta cuyos asientos se consultan (solo lectura)
  const canCreate = hasRole('admin', 'cajero', 'contabilidad');
  const canCancel = hasRole('admin');
  const canInvoice = hasRole('admin', 'cajero');
  const canAccounting = hasRole('admin', 'contabilidad');
  // El cajero crea ventas pero NO ve el historial (solo admin/contabilidad).
  const canViewHistory = hasRole('admin', 'contabilidad');

  const [sales, setSales] = useState([]);
  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState([]);
  const [patients, setPatients] = useState([]);
  const [treatments, setTreatments] = useState([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [detailModal, setDetailModal] = useState(null);
  const [saving, setSaving] = useState(false);
  const [invoicingId, setInvoicingId] = useState(null);
  const [filter, setFilter] = useState({ startDate: '', endDate: '', product: '', client: '' });
  const [downloadingZip, setDownloadingZip] = useState(false);
  const [topProducts, setTopProducts] = useState([]);
  const [showChart, setShowChart] = useState(false);

  const [form, setForm] = useState({
    clientName: 'Consumidor Final',
    clientCedula: '9999999999999',
    clientEmail: '',
    clientPhone: '',
    clientAddress: '',
    clientCity: 'Guayaquil',
    clientZone: '',
    patient: '',
    paymentMethod: 'efectivo',
    bankAccount: '',
    creditCard: '',
    cardType: '',      // DEBITO | CREDITO (elegido por el cajero, no deducido de la tarjeta)
    cardPos: '',
    cardLote: '',
    cardVoucher: '',
    recommendedBy: '',
    notes: '',
    // Bodega de la que sale la mercadería y centro de costo con el que se registra la venta.
    // El centro lo PROPONE la bodega; se puede cambiar confirmando la diferencia.
    warehouse: '',
    costCenter: '',
    items: [],
  });
  const [warehouses, setWarehouses] = useState([]);
  const [costCenters, setCostCenters] = useState([]);
  // { warehouse, esperado, elegido } cuando el backend rechaza por centro distinto (409).
  const [ccMismatch, setCcMismatch] = useState(null);
  const [currentItem, setCurrentItem] = useState({ product: '', quantity: 1 });
  // Pago dividido: el cliente paga con varios métodos (p.ej. mitad efectivo + mitad
  // tarjeta) o deja una parte a crédito. Cuando está activo, `splitPayments` es la
  // fuente de verdad y se envía como `payments` al backend.
  const [splitMode, setSplitMode] = useState(false);
  const [splitPayments, setSplitPayments] = useState([]);
  const [patientSearch, setPatientSearch] = useState('');
  const [guayaquilZones, setGuayaquilZones] = useState([]);
  // Medios de pago (cuentas bancarias / tarjetas) y personal para recomendación
  const [payOptions, setPayOptions] = useState({ accounts: [], cards: [] });
  const [staff, setStaff] = useState([]);

  // Autocompletado del cliente por cédula/RUC desde el SRI (nombre + dirección).
  const cedulaLookup = useSriLookup(form.clientCedula, {
    enabled: modalOpen,
    onData: (d, prev) => {
      setForm((f) => ({
        ...f,
        clientName: fillField(f.clientName, d.found ? d.fullName || '' : '', prev?.fullName, ['Consumidor Final']),
        clientAddress: fillField(f.clientAddress, d.found ? d.address || '' : '', prev?.address),
      }));
    },
  });
  const emailCheck = useEmailValidation(form.clientEmail, { enabled: modalOpen });

  useEffect(() => {
    api
      .get('/marketing/guayaquil-zones')
      .then((r) => setGuayaquilZones(r.data || []))
      .catch(() => setGuayaquilZones([]));
  }, []);

  const fetchSales = async () => {
    if (!canViewHistory) { setLoading(false); return; }
    try {
      const params = {};
      if (filter.startDate) params.startDate = filter.startDate;
      if (filter.endDate) params.endDate = filter.endDate;
      if (filter.product) params.product = filter.product;
      if (filter.client) params.client = filter.client;
      const res = await api.get('/sales', { params });
      setSales(res.data.sales);
    } catch {
      toast.error('Error al cargar ventas');
    } finally {
      setLoading(false);
    }
  };

  const fetchTopProducts = async () => {
    try {
      const params = {};
      if (filter.startDate) params.startDate = filter.startDate;
      if (filter.endDate) params.endDate = filter.endDate;
      const res = await api.get('/dashboard/top-products', { params });
      setTopProducts(res.data || []);
    } catch {
      // silent
    }
  };

  useEffect(() => {
    if (showChart) fetchTopProducts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showChart, filter.startDate, filter.endDate]);

  const fetchProducts = async () => {
    try {
      const res = await api.get('/products');
      setProducts(res.data);
    } catch (err) {
      // contabilidad puede no tener acceso a /products en algunos casos; ignoramos.
      void err;
    }
  };

  const fetchPatients = async () => {
    try {
      const res = await api.get('/patients', { params: { limit: 1000 } });
      setPatients(res.data.patients);
    } catch (err) {
      void err;
    }
  };

  useEffect(() => {
    fetchSales();
    if (canCreate) {
      fetchProducts();
      fetchPatients();
      api.get('/banks/payment-options')
        .then((r) => setPayOptions({ accounts: r.data?.accounts || [], cards: r.data?.cards || [] }))
        .catch(() => setPayOptions({ accounts: [], cards: [] }));
      api.get('/users')
        .then((r) => setStaff(r.data || []))
        .catch(() => setStaff([]));
      // Bodegas (con su centro predeterminado) y centros activos. Si el usuario no tiene
      // permiso para verlas, la venta sigue funcionando sin bodega (como hasta ahora).
      api.get('/inventory-advanced/warehouses')
        .then((r) => setWarehouses((r.data || []).filter((w) => w.active !== false)))
        .catch(() => setWarehouses([]));
      api.get('/cost-centers', { params: { active: true } })
        .then((r) => setCostCenters(r.data || []))
        .catch(() => setCostCenters([]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    fetchSales();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  const openNew = () => {
    setForm({
      clientName: 'Consumidor Final',
      clientCedula: '9999999999999',
      clientEmail: '',
      clientPhone: '',
      clientAddress: '',
      clientCity: 'Guayaquil',
      clientZone: '',
      patient: '',
      paymentMethod: 'efectivo',
      bankAccount: '',
      creditCard: '',
      cardPos: '',
      cardLote: '',
      cardVoucher: '',
      recommendedBy: '',
      notes: '',
      warehouse: '',
      costCenter: '',
      items: [],
    });
    setCurrentItem({ product: '', quantity: 1 });
    setPatientSearch('');
    setSplitMode(false);
    setSplitPayments([]);
    setCcMismatch(null);
    setModalOpen(true);
  };

  /**
   * Al elegir la BODEGA se PROPONE su centro de costo (solo si aún no hay uno elegido: lo que
   * el usuario ya escogió no se pisa). La validación real y el rechazo de una diferencia sin
   * confirmar los hace el backend.
   */
  const onPickWarehouse = (warehouseId) => {
    const wh = warehouses.find((w) => String(w._id) === String(warehouseId));
    const propuesto = wh?.costCenter?._id || wh?.costCenter || '';
    setForm((f) => ({ ...f, warehouse: warehouseId, costCenter: f.costCenter || propuesto || '' }));
  };

  /**
   * Tarjetas ofrecidas para un tipo (débito/crédito). Se filtra por `accountType` cuando la
   * configuración lo distingue; si ninguna tarjeta coincide (p. ej. un único registro
   * "Datafast" que procesa las dos), se muestran todas: el tipo que manda es el que eligió
   * el cajero, y esconder las tarjetas dejaría la venta sin poder registrarse.
   */
  const cardsOfType = (type) => {
    if (!type) return payOptions.cards;
    const match = payOptions.cards.filter((c) => !c.accountType || c.accountType === type);
    return match.length ? match : payOptions.cards;
  };
  const cardOptions = cardsOfType(form.cardType);

  const nombreCentro = (id) => {
    const c = costCenters.find((x) => String(x._id) === String(id));
    return c ? `${c.code} - ${c.name}` : '';
  };
  // El centro elegido difiere del predeterminado de la bodega: se avisa ANTES de enviar.
  const centroEsperado = (() => {
    const wh = warehouses.find((w) => String(w._id) === String(form.warehouse));
    return wh?.costCenter?._id || wh?.costCenter || '';
  })();
  const centroDistinto = !!(form.warehouse && centroEsperado && form.costCenter
    && String(centroEsperado) !== String(form.costCenter));

  const addItem = () => {
    if (!currentItem.product) return toast.error('Selecciona un producto');
    const product = products.find((p) => p._id === currentItem.product);
    if (!product) return;

    const isService = product.category === 'servicio' || product.unlimited === true;
    if (!isService && product.stock <= 0) {
      return toast.error(`${product.name} sin stock disponible`);
    }
    if (form.items.find((i) => i.product === currentItem.product)) {
      return toast.error('El producto ya está en la lista');
    }
    const qty = parseInt(currentItem.quantity) || 1;
    if (!isService && qty > product.stock) {
      return toast.error(`Stock insuficiente. Disponible: ${product.stock}`);
    }

    // Precio: el ACTIVO del producto por defecto; si en el buscador se eligió otro de la lista,
    // ese. Se guarda el NOMBRE del precio además del importe: es lo que valida el backend
    // (dos precios pueden coincidir en importe y el nombre no depende de redondeos).
    const lista = priceListOf(product);
    const elegido = lista.find((p) => p.name === currentItem.priceName) || activePriceOf(product);

    setForm((f) => ({
      ...f,
      items: [
        ...f.items,
        {
          product: product._id,
          productName: product.name,
          category: product.category,
          unlimited: product.unlimited === true,
          quantity: qty,
          unitPrice: elegido.price,
          priceName: elegido.name,
          priceList: lista,
          taxRate: product.taxRate,
          stock: product.stock,
          discount: 0,
          treatment: '',
        },
      ],
    }));
    setCurrentItem({ product: '', quantity: 1, priceName: '' });
  };

  const removeItem = (idx) => {
    setForm({ ...form, items: form.items.filter((_, i) => i !== idx) });
  };

  const updateItemQty = (idx, qty) => {
    const items = [...form.items];
    const newQty = parseInt(qty) || 1;
    const it = items[idx];
    const isService = it.category === 'servicio' || it.unlimited === true;
    if (!isService && newQty > it.stock) {
      toast.error(`Stock máximo: ${it.stock}`);
      return;
    }
    items[idx].quantity = newQty;
    setForm({ ...form, items });
  };

  const subtotal = form.items.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
  const discountTotal = form.items.reduce((s, i) => s + (Number(i.discount) || 0), 0);
  // El IVA lo calcula el backend por línea (`utils/tax`): aquí solo se muestra el total.
  const total = subtotal - discountTotal;

  // ── Pago dividido ── (debe ir DESPUÉS de `total`: se evalúa en cada render y
  // usarlo antes de su declaración rompía la página completa con ReferenceError)
  const splitPaid = splitPayments.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const splitRemaining = +(total - splitPaid).toFixed(2);
  const enableSplit = () => {
    // Al activar, arranca con lo que haya en el método simple + el restante sugerido.
    setSplitPayments([{ method: form.paymentMethod || 'efectivo', amount: +total.toFixed(2), bankAccount: form.bankAccount || '', creditCard: form.creditCard || '', cardPos: form.cardPos || '', cardLote: form.cardLote || '', cardVoucher: form.cardVoucher || '' }]);
    setSplitMode(true);
  };
  const addSplitRow = () => setSplitPayments((rows) => [...rows, { method: 'efectivo', amount: splitRemaining > 0 ? +splitRemaining.toFixed(2) : 0, bankAccount: '', creditCard: '', cardPos: '', cardLote: '', cardVoucher: '' }]);
  const setSplitRow = (i, patch) => setSplitPayments((rows) => rows.map((r, x) => (x === i ? { ...r, ...patch } : r)));
  const removeSplitRow = (i) => setSplitPayments((rows) => rows.filter((_, x) => x !== i));

  const handlePatientSelect = (patientId) => {
    const patient = patients.find((p) => p._id === patientId);
    if (patient) {
      setForm((f) => ({
        ...f,
        patient: patientId,
        clientName: `${patient.firstName} ${patient.lastName}`,
        clientCedula: patient.cedula,
        clientEmail: patient.email || '',
        clientPhone: patient.phone || '',
        clientAddress: patient.address || '',
      }));
      setPatientSearch(`${patient.firstName} ${patient.lastName} - ${patient.cedula}`);
      // cargar tratamientos activos del paciente
      api
        .get('/treatments', { params: { patient: patientId } })
        .then((r) => setTreatments(r.data || []))
        .catch(() => setTreatments([]));
    } else {
      setForm((f) => ({
        ...f,
        patient: '',
        clientName: 'Consumidor Final',
        clientCedula: '9999999999999',
        clientEmail: '',
        clientPhone: '',
        clientAddress: '',
      }));
      setPatientSearch('');
      setTreatments([]);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (form.items.length === 0) return toast.error('Agrega al menos un producto');
    setSaving(true);
    try {
      // Datos de pago: modo dividido (varios métodos) o método simple.
      let paymentPayload;
      if (splitMode) {
        const rows = splitPayments.filter((p) => (Number(p.amount) || 0) > 0);
        if (!rows.length) { setSaving(false); return toast.error('Agrega al menos un método de pago con monto'); }
        if (Math.abs(splitRemaining) > 0.01) {
          setSaving(false);
          return toast.error(`Los pagos ($${splitPaid.toFixed(2)}) no cuadran con el total ($${total.toFixed(2)}). Falta $${splitRemaining.toFixed(2)}.`);
        }
        for (const p of rows) {
          if (p.method === 'transferencia' && payOptions.accounts.length && !p.bankAccount) { setSaving(false); return toast.error('Selecciona la cuenta bancaria en el pago por transferencia'); }
          if (p.method === 'tarjeta' && payOptions.cards.length && !p.creditCard) { setSaving(false); return toast.error('Selecciona la tarjeta en el pago con tarjeta'); }
        }
        paymentPayload = {
          payments: rows.map((p) => ({
            method: p.method,
            amount: Number(p.amount) || 0,
            bankAccount: p.method === 'transferencia' ? p.bankAccount || null : null,
            creditCard: p.method === 'tarjeta' ? p.creditCard || null : null,
            cardType: p.method === 'tarjeta' ? p.cardType || '' : '',
            cardPos: p.method === 'tarjeta' ? p.cardPos || '' : '',
            cardLote: p.method === 'tarjeta' ? p.cardLote || '' : '',
            cardVoucher: p.method === 'tarjeta' ? p.cardVoucher || '' : '',
          })),
          dueDate: form.dueDate || null,
        };
      } else {
        if (form.paymentMethod === 'transferencia' && payOptions.accounts.length && !form.bankAccount) {
          setSaving(false);
          return toast.error('Selecciona la cuenta bancaria de destino');
        }
        if (form.paymentMethod === 'tarjeta' && payOptions.cards.length && !form.creditCard) {
          setSaving(false);
          return toast.error('Selecciona la tarjeta / POS');
        }
        paymentPayload = {
          bankAccount: form.paymentMethod === 'transferencia' ? form.bankAccount || null : null,
          creditCard: form.paymentMethod === 'tarjeta' ? form.creditCard || null : null,
          cardType: form.paymentMethod === 'tarjeta' ? form.cardType || '' : '',
          cardPos: form.paymentMethod === 'tarjeta' ? form.cardPos || '' : '',
          cardLote: form.paymentMethod === 'tarjeta' ? form.cardLote || '' : '',
          cardVoucher: form.paymentMethod === 'tarjeta' ? form.cardVoucher || '' : '',
        };
      }
      await enviarVenta(paymentPayload, {});
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al crear venta');
      setSaving(false);
    }
  };

  /**
   * POST de la venta. `extra` lleva las confirmaciones explícitas (por ahora, el centro de
   * costo distinto al de la bodega). El backend es quien rechaza la diferencia sin confirmar.
   */
  const enviarVenta = async (paymentPayload, extra = {}) => {
    try {
      const res = await api.post('/sales', {
        ...form,
        ...paymentPayload,
        recommendedBy: form.recommendedBy || null,
        warehouse: form.warehouse || null,
        costCenter: form.costCenter || null,
        items: form.items.map((i) => ({
          product: i.product,
          quantity: i.quantity,
          // Precio elegido de la lista del producto. El backend lo valida contra esa lista
          // (`priceName` manda; el importe es solo respaldo para clientes antiguos).
          priceName: i.priceName || undefined,
          unitPrice: i.unitPrice,
          discount: Number(i.discount) || 0,
          treatment: i.treatment || null,
        })),
        ...extra,
      });
      toast.success(extra.costCenterConfirmed
        ? 'Venta registrada con el centro de costo elegido (diferencia auditada)'
        : 'Venta registrada');
      // Avisos no bloqueantes (p.ej. servicios sin categoría: su ingreso fue a la cuenta genérica).
      for (const w of (res.data?.warnings || [])) toast(w, { icon: '⚠️', duration: 7000 });
      setCcMismatch(null);
      setModalOpen(false);
      fetchSales();
      fetchProducts();
    } catch (err) {
      const data = err.response?.data;
      if (data?.code === 'COST_CENTER_MISMATCH') {
        // Se explica la diferencia y se pide confirmación; el pago ya calculado se conserva
        // para reenviar exactamente la misma venta.
        setCcMismatch({ ...data, paymentPayload });
        return;
      }
      throw err;
    } finally {
      setSaving(false);
    }
  };

  const cancelSale = async (sale) => {
    if (sale.invoice && sale.invoice.estado === 'AUTORIZADO') {
      return toast.error('No se puede anular: la factura ya fue autorizada por el SRI');
    }
    if (!window.confirm('¿Anular esta venta? Se restaurará el stock.')) return;
    try {
      await api.put(`/sales/${sale._id}/cancel`);
      toast.success('Venta anulada');
      fetchSales();
      fetchProducts();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al anular');
    }
  };

  const facturar = async (sale) => {
    if (sale.invoice) return toast.error('Esta venta ya tiene factura asociada');
    if (!window.confirm(`¿Emitir factura electrónica para la venta ${sale.saleNumber}?`)) return;
    setInvoicingId(sale._id);
    try {
      const res = await api.post(`/invoices/from-sale/${sale._id}`);
      // Respuesta: la factura directa (201 autorizada) o { message, invoice } (202/en cola).
      const inv = res.data?.invoice || res.data;
      if (inv.estado === 'AUTORIZADO') {
        toast.success('Factura autorizada por el SRI');
      } else if (inv.estado === 'DEVUELTA' || inv.estado === 'NO_AUTORIZADO') {
        toast.error(`Factura rechazada: ${inv.errorUltimo || inv.estado}`);
      } else if (inv.estado === 'EN_COLA') {
        // SRI caído: la factura no se pierde, queda en cola y se reintenta sola.
        toast(res.data?.message || 'SRI no disponible: la factura quedó en cola y se reintentará automáticamente.', {
          icon: '⏳',
          duration: 8000,
        });
      } else {
        toast.success(res.data?.message || `Factura emitida (${inv.estado})`);
      }
      fetchSales();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al facturar');
    } finally {
      setInvoicingId(null);
    }
  };

  const openDetail = async (id) => {
    try {
      const res = await api.get(`/sales/${id}`);
      setDetailModal(res.data);
    } catch {
      toast.error('Error al cargar detalle');
    }
  };

  // Deep-link desde el Libro Mayor (?doc=<id>): abre el detalle de la venta.
  useDocDeepLink((id) => openDetail(id));

  const collectSale = async (s) => {
    const input = window.prompt(`Saldo pendiente: $${(s.balance || 0).toFixed(2)}\nMonto a cobrar (efectivo):`, (s.balance || 0).toFixed(2));
    if (input == null) return;
    const amount = parseFloat(input);
    if (!amount || amount <= 0) return toast.error('Monto inválido');
    try {
      const r = await api.post(`/sales/${s._id}/collect`, { amount, paymentMethod: 'efectivo' });
      toast.success(r.data.paid ? 'Cobro completado (saldado)' : `Cobro registrado. Saldo: $${r.data.balance.toFixed(2)}`);
      fetchSales();
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  return (
    <div className="space-y-6">
      <PageHeader icon={HiOutlineBanknotes} title="Ventas" subtitle="Registro y facturación electrónica">
        {canCreate && (
          <>
            <button
              onClick={async () => {
                try {
                  const params = {};
                  if (filter.startDate) params.startDate = filter.startDate;
                  if (filter.endDate) params.endDate = filter.endDate;
                  await downloadFile('/reports/sales.xlsx', { params, filename: `ventas_${Date.now()}.xlsx` });
                } catch (err) {
                  toast.error(err.message || 'Error al exportar');
                }
              }}
              className="btn-secondary"
            >
              <HiOutlineArrowDownTray className="w-4 h-4" /> Excel
            </button>
            <button onClick={openNew} className="btn-primary">
              <HiOutlinePlus className="w-5 h-5" /> Nueva Venta
            </button>
          </>
        )}
      </PageHeader>

      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 p-4">
        <div className="flex flex-col sm:flex-row gap-3 flex-wrap">
          <input
            type="date"
            value={filter.startDate}
            onChange={(e) => setFilter({ ...filter, startDate: e.target.value })}
            className="px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none bg-slate-50/50"
          />
          <input
            type="date"
            value={filter.endDate}
            onChange={(e) => setFilter({ ...filter, endDate: e.target.value })}
            className="px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none bg-slate-50/50"
          />
          <input
            type="text"
            value={filter.client}
            onChange={(e) => setFilter({ ...filter, client: e.target.value })}
            placeholder="Filtrar por cliente..."
            className="px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none bg-slate-50/50 min-w-[180px]"
          />
          <div className="flex-1 min-w-[200px]">
            <ProductAutocomplete
              products={products}
              value={filter.product}
              onSelect={(p) => setFilter({ ...filter, product: p?._id || '' })}
              placeholder="Filtrar por producto/servicio..."
            />
          </div>
          <button
            type="button"
            onClick={async () => {
              setDownloadingZip(true);
              try {
                const params = {};
                if (filter.startDate) params.startDate = filter.startDate;
                if (filter.endDate) params.endDate = filter.endDate;
                if (filter.client) params.client = filter.client;
                await downloadFile('/invoices/bulk-pdf', { params, filename: `facturas_${Date.now()}.zip` });
              } catch (err) {
                toast.error(err.message || 'Error al descargar facturas');
              } finally {
                setDownloadingZip(false);
              }
            }}
            disabled={downloadingZip}
            className="px-4 py-2.5 rounded-xl text-sm font-medium border bg-white text-emerald-700 border-emerald-200 hover:bg-emerald-50 cursor-pointer disabled:opacity-50"
            title="Descargar en ZIP los PDF (RIDE) de las facturas autorizadas del filtro"
          >
            {downloadingZip ? 'Generando...' : 'Descargar facturas (ZIP)'}
          </button>
          <button
            type="button"
            onClick={() => setShowChart((s) => !s)}
            className={`px-4 py-2.5 rounded-xl text-sm font-medium border cursor-pointer ${
              showChart
                ? 'bg-emerald-600 text-white border-emerald-600'
                : 'bg-white text-emerald-700 border-emerald-200 hover:bg-emerald-50'
            }`}
          >
            {showChart ? 'Ocultar gráfico' : 'Top productos'}
          </button>
        </div>
      </div>

      {showChart && <TopProductsChart data={topProducts} />}

      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr className="bg-emerald-50/50 border-b border-emerald-100">
                <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">N° Venta</th>
                <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Fecha</th>
                <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Cliente</th>
                <th className="text-right px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Total</th>
                <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Estado</th>
                <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Factura</th>
                <th className="text-right px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={`sk-${i}`} className="border-b border-emerald-50">
                    {Array.from({ length: 7 }).map((__, j) => (
                      <td key={j} className="px-6 py-3.5"><div className="skeleton h-4 w-full max-w-[140px]" /></td>
                    ))}
                  </tr>
                ))
              ) : sales.length === 0 ? (
                <tr>
                  <td colSpan="7">
                    <EmptyState icon={HiOutlineBanknotes} title="No se encontraron ventas" hint="Registra una venta o ajusta los filtros." />
                  </td>
                </tr>
              ) : (
                sales.map((s) => (
                  <tr key={s._id} className="border-b border-emerald-50 hover:bg-emerald-50/30">
                    <td className="px-6 py-3 text-sm font-mono text-slate-600">{s.saleNumber}</td>
                    <td className="px-6 py-3 text-sm text-slate-600">
                      {fmtDateTime(s.createdAt)}
                    </td>
                    <td className="px-6 py-3 text-sm text-slate-800">
                      <div className="flex items-center gap-2">
                        <span>{s.clientName}</span>
                        {s.isFirstVisit && (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-700 uppercase">
                            Nuevo
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-3 text-sm font-bold text-slate-800 text-right">
                      ${s.total.toFixed(2)}
                      {s.balance > 0.01 && (
                        <span className="block text-[10px] font-medium text-amber-600">Saldo ${s.balance.toFixed(2)}</span>
                      )}
                    </td>
                    <td className="px-6 py-3">
                      <span
                        className={`px-2 py-1 rounded-full text-xs font-medium ${
                          s.status === 'completada'
                            ? 'bg-emerald-100 text-emerald-700'
                            : 'bg-red-100 text-red-700'
                        }`}
                      >
                        {s.status === 'completada' ? 'Completada' : 'Anulada'}
                      </span>
                    </td>
                    <td className="px-6 py-3 text-xs">
                      {s.invoice ? (
                        <span
                          className={`px-2 py-0.5 rounded ${
                            s.invoice.estado === 'AUTORIZADO'
                              ? 'bg-emerald-100 text-emerald-700'
                              : s.invoice.estado === 'ANULADA'
                              ? 'bg-slate-300 text-slate-700'
                              : 'bg-amber-100 text-amber-700'
                          }`}
                        >
                          {s.invoice.estado}
                        </span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-6 py-3 text-right">
                      <button
                        onClick={() => openDetail(s._id)}
                        className="p-1.5 rounded-lg hover:bg-emerald-50 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer"
                        title="Detalle"
                      >
                        <HiOutlineEye className="w-4 h-4" />
                      </button>
                      {canInvoice && s.status === 'completada' && !s.invoice && (
                        <button
                          onClick={() => facturar(s)}
                          disabled={invoicingId === s._id}
                          className="p-1.5 rounded-lg hover:bg-blue-50 text-slate-400 hover:text-blue-600 bg-transparent border-none cursor-pointer disabled:opacity-50"
                          title="Facturar electrónicamente"
                        >
                          <HiOutlineDocumentText className="w-4 h-4" />
                        </button>
                      )}
                      {s.status === 'completada' && s.balance > 0.01 && (
                        <button
                          onClick={() => collectSale(s)}
                          className="p-1.5 rounded-lg hover:bg-emerald-50 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer"
                          title="Registrar cobro"
                        >
                          <HiOutlineBanknotes className="w-4 h-4" />
                        </button>
                      )}
                      {canAccounting && s.status === 'completada' && s.journalEntry && (
                        <button
                          onClick={() => setJournalSale(s)}
                          className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-700 bg-transparent border-none cursor-pointer"
                          title="Ver asientos contables (ingreso y costo)"
                        >
                          <HiOutlineCalculator className="w-4 h-4" />
                        </button>
                      )}
                      {canCancel && s.status === 'completada' && (
                        <button
                          onClick={() => cancelSale(s)}
                          className="p-1.5 rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-600 bg-transparent border-none cursor-pointer"
                          title="Anular"
                        >
                          <HiOutlineXCircle className="w-4 h-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} title="Nueva Venta" size="xl">
        {/* El modal está ordenado por SECCIONES, en el orden en que se cobra: quién es el
            cliente → de dónde sale la mercadería → qué se lleva → cómo paga. El aviso de
            consumidor final va arriba del todo porque condiciona la factura entera. */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <ConsumidorFinalAlert cedula={form.clientCedula} />

          <FormSection title="Datos del cliente" icon={HiOutlineUser}>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="sm:col-span-3 relative">
              <label className="lbl">Buscar paciente registrado (opcional)</label>
              <input
                type="text"
                value={patientSearch}
                onChange={(e) => {
                  setPatientSearch(e.target.value);
                  if (form.patient) {
                    setForm((f) => ({ ...f, patient: '' }));
                  }
                }}
                placeholder="Escribe nombre o cédula..."
                className="input"
              />
              {patientSearch && !form.patient && (
                <div className="absolute z-10 left-0 right-0 mt-1 max-h-56 overflow-y-auto bg-white border border-emerald-100 rounded-xl shadow-lg">
                  {patients
                    .filter((p) => {
                      const q = patientSearch.toLowerCase();
                      return (
                        p.firstName?.toLowerCase().includes(q) ||
                        p.lastName?.toLowerCase().includes(q) ||
                        p.cedula?.includes(q) ||
                        p.phone?.includes(q)
                      );
                    })
                    .slice(0, 20)
                    .map((p) => (
                      <button
                        type="button"
                        key={p._id}
                        onClick={() => handlePatientSelect(p._id)}
                        className="w-full text-left px-4 py-2 text-sm hover:bg-emerald-50 cursor-pointer bg-white border-none border-b border-emerald-50"
                      >
                        <span className="font-medium text-slate-800">
                          {p.firstName} {p.lastName}
                        </span>
                        <span className="text-slate-400 ml-2">{p.cedula}</span>
                        {p.phone && (
                          <span className="text-slate-400 ml-2">• {p.phone}</span>
                        )}
                      </button>
                    ))}
                  {patients.filter((p) => {
                    const q = patientSearch.toLowerCase();
                    return (
                      p.firstName?.toLowerCase().includes(q) ||
                      p.lastName?.toLowerCase().includes(q) ||
                      p.cedula?.includes(q) ||
                      p.phone?.includes(q)
                    );
                  }).length === 0 && (
                    <p className="px-4 py-2 text-xs text-slate-400">Sin coincidencias</p>
                  )}
                </div>
              )}
              {form.patient && (
                <button
                  type="button"
                  onClick={() => handlePatientSelect('')}
                  className="absolute right-3 top-9 text-xs text-emerald-600 hover:text-emerald-800 bg-transparent border-none cursor-pointer"
                >
                  Limpiar
                </button>
              )}
            </div>
            <div>
              <label className="lbl">Cliente</label>
              <input
                value={form.clientName}
                onChange={(e) => setForm({ ...form, clientName: e.target.value })}
                className="input"
              />
            </div>
            <div>
              <label className="lbl">Cédula / RUC / Pasaporte</label>
              <input
                value={form.clientCedula}
                onChange={(e) => setForm({ ...form, clientCedula: e.target.value })}
                className="input"
                maxLength={20}
                placeholder="Cédula, RUC o pasaporte"
              />
              <SriStatus status={cedulaLookup} />
            </div>
            <div>
              <label className="lbl">Email cliente</label>
              <input
                type="email"
                value={form.clientEmail}
                onChange={(e) => setForm({ ...form, clientEmail: e.target.value })}
                className="input"
              />
              <EmailStatus status={emailCheck} onApplySuggestion={(s) => setForm({ ...form, clientEmail: s })} />
            </div>
            <div>
              <label className="lbl">Teléfono cliente</label>
              <input
                value={form.clientPhone}
                onChange={(e) => setForm({ ...form, clientPhone: e.target.value })}
                className="input"
              />
            </div>
            <div className="sm:col-span-3">
              <label className="lbl">Dirección cliente</label>
              <input
                value={form.clientAddress}
                onChange={(e) => setForm({ ...form, clientAddress: e.target.value })}
                className="input"
              />
            </div>
            <div>
              <label className="lbl">Ciudad</label>
              <select
                value={form.clientCity === 'Guayaquil' ? 'Guayaquil' : 'Otra'}
                onChange={(e) => {
                  if (e.target.value === 'Guayaquil') {
                    setForm({ ...form, clientCity: 'Guayaquil' });
                  } else {
                    setForm({ ...form, clientCity: '', clientZone: '' });
                  }
                }}
                className="input"
              >
                <option value="Guayaquil">Guayaquil</option>
                <option value="Otra">Otra ciudad</option>
              </select>
              {form.clientCity !== 'Guayaquil' && (
                <input
                  value={form.clientCity}
                  onChange={(e) => setForm({ ...form, clientCity: e.target.value })}
                  placeholder="Nombre de la ciudad"
                  className="input mt-1"
                />
              )}
            </div>
            <div>
              <label className="lbl">
                {form.clientCity === 'Guayaquil' ? 'Zona / Parroquia' : 'Sector'}
              </label>
              {form.clientCity === 'Guayaquil' ? (
                <>
                  <input
                    list="guayaquil-zones-datalist"
                    value={form.clientZone}
                    onChange={(e) => setForm({ ...form, clientZone: e.target.value })}
                    placeholder="Ej. Tarqui, Urdesa, Alborada..."
                    className="input"
                  />
                  <datalist id="guayaquil-zones-datalist">
                    {guayaquilZones.map((z) => (
                      <option key={z.name} value={z.name}>
                        {z.parroquia}
                      </option>
                    ))}
                  </datalist>
                  {form.clientZone && !guayaquilZones.some((z) => z.name.toLowerCase() === form.clientZone.toLowerCase()) && (
                    <p className="text-[11px] text-amber-600 mt-1">
                      Zona no reconocida. Selecciona una de la lista.
                    </p>
                  )}
                </>
              ) : (
                <input
                  value={form.clientZone}
                  onChange={(e) => setForm({ ...form, clientZone: e.target.value })}
                  className="input"
                />
              )}
            </div>
            <div>
              <label className="lbl">Recomendado por (comisión)</label>
              <select
                value={form.recommendedBy || ''}
                onChange={(e) => setForm({ ...form, recommendedBy: e.target.value })}
                className="input"
              >
                <option value="">— Nadie / No aplica —</option>
                {staff.map((u) => (
                  <option key={u._id} value={u._id}>{u.name}</option>
                ))}
              </select>
            </div>
          </div>
          </FormSection>

          {/* Bodega y centro de costo. La bodega decide de qué capas FIFO sale la mercadería
              (y por tanto el costo de venta) y PROPONE el centro. Una venta de solo servicios
              no necesita bodega: entonces no hay centro de bodega que proponer. */}
          {warehouses.length > 0 && (
            <FormSection
              title="Bodega y centro de costo"
              subtitle="La bodega decide de qué existencias sale la mercadería (y con ello el costo de venta) y propone el centro."
              icon={HiOutlineBuildingStorefront}
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="lbl">Bodega (de dónde sale la mercadería)</label>
                  <select value={form.warehouse || ''} onChange={(e) => onPickWarehouse(e.target.value)} className="input">
                    <option value="">— Sin bodega (stock general) —</option>
                    {warehouses.map((w) => (
                      <option key={w._id} value={w._id}>{w.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="lbl">Centro de costo</label>
                  <select value={form.costCenter || ''} onChange={(e) => setForm({ ...form, costCenter: e.target.value })} className="input">
                    <option value="">— Sin centro —</option>
                    {costCenters.map((c) => (
                      <option key={c._id} value={c._id}>{c.code} - {c.name}</option>
                    ))}
                  </select>
                  {form.warehouse && centroEsperado && !centroDistinto && form.costCenter && (
                    <p className="text-xs text-slate-500 mt-1">Propuesto por la bodega. Puedes cambiarlo.</p>
                  )}
                </div>
                {centroDistinto && (
                  <div className="sm:col-span-2 bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-800">
                    <b>Centro distinto al de la bodega.</b> La bodega{' '}
                    <b>{warehouses.find((w) => String(w._id) === String(form.warehouse))?.name}</b> espera{' '}
                    <b>{nombreCentro(centroEsperado) || '(sin centro)'}</b> y la venta se registrará con{' '}
                    <b>{nombreCentro(form.costCenter)}</b>. Al guardar se te pedirá confirmarlo y quedará auditado.
                  </div>
                )}
              </div>
            </FormSection>
          )}

          <FormSection title="Producto / servicio" icon={HiOutlineShoppingCart}>
          {/* Agregar productos: el buscador manda (es lo que hay que leer para elegir bien) y
              la cantidad ocupa un ancho fijo pequeño. Anchos con `basis/shrink-0` en vez de
              `flex-1` + `w-20` sueltos, para que el buscador no se colapse. */}
          <div className="bg-emerald-50/50 rounded-xl p-4">
            <div className="flex flex-wrap sm:flex-nowrap items-end gap-2">
              <div className="basis-full sm:basis-auto sm:flex-1 min-w-0">
                <label className="block text-[11px] font-semibold text-slate-500 mb-1">Producto o servicio</label>
                <ProductAutocomplete
                  products={products}
                  value={currentItem.product}
                  onSelect={(p) =>
                    // Al cambiar de producto se descarta el precio elegido: pertenecía al anterior.
                    setCurrentItem({ ...currentItem, product: p?._id || '', priceName: '' })
                  }
                  placeholder="Buscar producto o servicio..."
                  filter={(p) => p.active !== false}
                />
              </div>
              {/* Lista de precios del producto elegido. Solo aparece si tiene más de uno: con un
                  único precio el desplegable sería ruido. Por defecto viene marcado el activo. */}
              {(() => {
                const prod = products.find((p) => p._id === currentItem.product);
                const lista = prod ? priceListOf(prod) : [];
                if (lista.length < 2) return null;
                const sel = currentItem.priceName || activePriceOf(prod).name;
                return (
                  <div className="basis-full sm:basis-auto sm:w-52 shrink-0">
                    <label className="block text-[11px] font-semibold text-slate-500 mb-1">Precio</label>
                    <select
                      value={sel}
                      onChange={(e) => setCurrentItem({ ...currentItem, priceName: e.target.value })}
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white outline-none"
                    >
                      {lista.map((p) => (
                        <option key={p.name} value={p.name}>
                          {p.name} — ${Number(p.price).toFixed(2)}{p.active ? ' (activo)' : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })()}
              <div className="w-24 shrink-0">
                <label className="block text-[11px] font-semibold text-slate-500 mb-1">Cantidad</label>
                <NumericInput
                  min="1"
                  value={currentItem.quantity}
                  onChange={(e) =>
                    setCurrentItem({ ...currentItem, quantity: e.target.value })
                  }
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white text-center outline-none"
                />
              </div>
              <button
                type="button"
                onClick={addItem}
                className="shrink-0 px-4 py-2 bg-cyan-600 hover:bg-cyan-700 text-white rounded-lg text-sm font-medium cursor-pointer border-none"
              >
                Agregar
              </button>
            </div>
          </div>

          {form.items.length > 0 && (
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left py-2">Producto</th>
                    <th className="text-right py-2">Precio</th>
                    <th className="text-center py-2">Cant.</th>
                    <th className="text-right py-2">Desc. $</th>
                    {form.patient && treatments.length > 0 && (
                      <th className="text-left py-2 pl-2">Tratamiento</th>
                    )}
                    <th className="text-right py-2">Subtotal</th>
                    <th className="text-right py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {form.items.map((item, idx) => (
                    <tr key={idx} className="border-b border-slate-100">
                      <td className="py-2 text-slate-800">{item.productName}</td>
                      {/* El precio también se puede cambiar DESPUÉS de agregar la línea: es
                          habitual darse cuenta al final de que va a precio corporativo. Solo
                          se ofrecen los precios de la lista del producto (el backend los valida). */}
                      <td className="py-2 text-right">
                        {(item.priceList || []).length > 1 ? (
                          <select
                            value={item.priceName || ''}
                            onChange={(e) => {
                              const elegido = item.priceList.find((p) => p.name === e.target.value);
                              if (!elegido) return;
                              const items = [...form.items];
                              items[idx] = { ...items[idx], priceName: elegido.name, unitPrice: elegido.price };
                              setForm({ ...form, items });
                            }}
                            title="Precio de la lista del producto"
                            className="px-2 py-1 border border-slate-300 rounded text-sm bg-white outline-none text-right"
                          >
                            {item.priceList.map((p) => (
                              <option key={p.name} value={p.name}>{p.name} — ${Number(p.price).toFixed(2)}</option>
                            ))}
                          </select>
                        ) : (
                          <>${item.unitPrice.toFixed(2)}</>
                        )}
                      </td>
                      <td className="py-2 text-center">
                        <NumericInput
                          min="1"
                          value={item.quantity}
                          onChange={(e) => updateItemQty(idx, e.target.value)}
                          className="w-16 px-2 py-1 border border-slate-300 rounded text-center text-sm outline-none"
                        />
                      </td>
                      <td className="py-2 text-right">
                        <NumericInput
                          min="0"
                          step="0.01"
                          value={item.discount ?? 0}
                          onChange={(e) => {
                            const items = [...form.items];
                            items[idx].discount = parseFloat(e.target.value) || 0;
                            setForm({ ...form, items });
                          }}
                          className="w-20 px-2 py-1 border border-slate-300 rounded text-right text-sm outline-none"
                        />
                      </td>
                      {form.patient && treatments.length > 0 && (
                        <td className="py-2 pl-2">
                          <select
                            value={item.treatment || ''}
                            onChange={(e) => {
                              const items = [...form.items];
                              items[idx].treatment = e.target.value;
                              setForm({ ...form, items });
                            }}
                            className="w-full px-2 py-1 border border-slate-300 rounded text-sm bg-white"
                          >
                            <option value="">— Ninguno —</option>
                            {treatments.map((t) => (
                              <option key={t._id} value={t._id}>
                                {t.name || t.product?.name || 'Tratamiento'}
                              </option>
                            ))}
                          </select>
                        </td>
                      )}
                      <td className="py-2 text-right font-medium">
                        ${(item.unitPrice * item.quantity - (Number(item.discount) || 0)).toFixed(2)}
                      </td>
                      <td className="py-2 text-right">
                        <button
                          type="button"
                          onClick={() => removeItem(idx)}
                          className="p-1 text-red-400 hover:text-red-600 bg-transparent border-none cursor-pointer"
                        >
                          <HiOutlineTrash className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {form.items.length > 0 && (
            <div className="bg-emerald-50/50 rounded-xl p-4 space-y-1">
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">Subtotal:</span>
                <span className="font-medium">${subtotal.toFixed(2)}</span>
              </div>
              {discountTotal > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-slate-500">Descuento:</span>
                  <span className="font-medium text-rose-600">-${discountTotal.toFixed(2)}</span>
                </div>
              )}
              <div className="flex justify-between text-base font-bold border-t border-emerald-200 pt-2">
                <span>Total:</span>
                <span className="text-emerald-700">${total.toFixed(2)}</span>
              </div>
            </div>
          )}
          </FormSection>

          {/* ── Método(s) de pago y todas sus subopciones ────────────────────────────── */}
          <FormSection title="Método de pago" icon={HiOutlineBanknotes}>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {!splitMode && (
                <div>
                  <label className="lbl">Forma de pago</label>
                  <select
                    value={form.paymentMethod}
                    onChange={(e) => setForm({ ...form, paymentMethod: e.target.value, bankAccount: '', creditCard: '', cardType: '', cardPos: '', cardLote: '', cardVoucher: '' })}
                    className="input"
                  >
                    {Object.entries(paymentMethods).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                  <button type="button" onClick={enableSplit} className="mt-1 text-xs text-emerald-700 hover:underline bg-transparent border-none cursor-pointer p-0">Dividir en varios métodos</button>
                </div>
              )}
              {!splitMode && form.paymentMethod === 'transferencia' && (
                <div className="sm:col-span-2">
                  <label className="lbl">Cuenta bancaria de destino</label>
                  <select
                    value={form.bankAccount || ''}
                    onChange={(e) => setForm({ ...form, bankAccount: e.target.value })}
                    className="input"
                  >
                    <option value="">{payOptions.accounts.length ? 'Seleccionar cuenta…' : 'No hay cuentas configuradas'}</option>
                    {payOptions.accounts.map((a) => (
                      <option key={a._id} value={a._id}>{a.name} — {a.bank} ({a.accountNumber})</option>
                    ))}
                  </select>
                </div>
              )}
              {!splitMode && form.paymentMethod === 'tarjeta' && (
                <>
                  {/* Débito o crédito: contablemente NO es lo mismo (el crédito queda por
                      liquidar, con comisión y retención) y el reporte los separa en columnas. */}
                  <div>
                    <label className="lbl">Tipo de tarjeta</label>
                    <select
                      value={form.cardType || ''}
                      onChange={(e) => setForm({ ...form, cardType: e.target.value, creditCard: '', cardPos: '' })}
                      className="input"
                    >
                      <option value="">Seleccionar tipo…</option>
                      {CARD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="lbl">Tarjeta / Adquirente</label>
                    <select
                      value={form.creditCard || ''}
                      onChange={(e) => setForm({ ...form, creditCard: e.target.value, cardPos: '' })}
                      className="input"
                    >
                      <option value="">{cardOptions.length ? 'Seleccionar tarjeta…' : 'No hay tarjetas configuradas'}</option>
                      {cardOptions.map((c) => (
                        <option key={c._id} value={c._id}>{c.name} ({c.brand}{c.acquirer ? ` · ${c.acquirer}` : ''})</option>
                      ))}
                    </select>
                  </div>
                  {(() => {
                    const card = payOptions.cards.find((c) => c._id === form.creditCard);
                    if (!card || !card.pos?.length) return null;
                    return (
                      <div>
                        <label className="lbl">POS / Terminal</label>
                        <select
                          value={form.cardPos || ''}
                          onChange={(e) => setForm({ ...form, cardPos: e.target.value })}
                          className="input"
                        >
                          <option value="">Seleccionar POS…</option>
                          {card.pos.map((p) => (
                            <option key={p.code} value={p.code}>{p.name || p.code}{p.terminal ? ` · ${p.terminal}` : ''}</option>
                          ))}
                        </select>
                      </div>
                    );
                  })()}
                  <div>
                    <label className="lbl">N° de lote</label>
                    <input
                      value={form.cardLote || ''}
                      onChange={(e) => setForm({ ...form, cardLote: e.target.value })}
                      placeholder="Del voucher POS (para la liquidación)"
                      className="input"
                    />
                  </div>
                  <div>
                    <label className="lbl">N° de voucher</label>
                    <input
                      value={form.cardVoucher || ''}
                      onChange={(e) => setForm({ ...form, cardVoucher: e.target.value })}
                      placeholder="Opcional"
                      className="input"
                    />
                  </div>
                </>
              )}
              {!splitMode && form.paymentMethod === 'credito' && (
                <div>
                  <label className="lbl">Vence (crédito)</label>
                  <input type="date" value={form.dueDate || ''} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} className="input" />
                </div>
              )}
              {splitMode && (
                <div className="sm:col-span-3 rounded-xl border border-slate-200 p-3 space-y-2 bg-slate-50/40">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-slate-700">Pago dividido (varios métodos)</span>
                    <button type="button" onClick={() => { setSplitMode(false); setSplitPayments([]); }} className="text-xs text-slate-500 hover:text-slate-700 bg-transparent border-none cursor-pointer">Volver a un solo método</button>
                  </div>
                  {splitPayments.map((p, i) => (
                    <div key={i} className="flex flex-wrap items-end gap-2 bg-white rounded-lg border border-slate-100 p-2">
                      <div className="w-36">
                        <label className="lbl">Método</label>
                        <select value={p.method} onChange={(e) => setSplitRow(i, { method: e.target.value, bankAccount: '', creditCard: '', cardType: '', cardPos: '', cardLote: '', cardVoucher: '' })} className="input">
                          {Object.entries(paymentMethods).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                        </select>
                      </div>
                      <div className="w-28">
                        <label className="lbl">Monto</label>
                        <NumericInput step="0.01" value={p.amount} onChange={(e) => setSplitRow(i, { amount: e.target.value })} className="input" />
                      </div>
                      {p.method === 'transferencia' && (
                        <div className="flex-1 min-w-[180px]">
                          <label className="lbl">Cuenta bancaria</label>
                          <select value={p.bankAccount || ''} onChange={(e) => setSplitRow(i, { bankAccount: e.target.value })} className="input">
                            <option value="">{payOptions.accounts.length ? 'Seleccionar cuenta…' : 'No hay cuentas'}</option>
                            {payOptions.accounts.map((a) => <option key={a._id} value={a._id}>{a.name} — {a.bank}</option>)}
                          </select>
                        </div>
                      )}
                      {p.method === 'tarjeta' && (
                        <>
                          <div className="w-28">
                            <label className="lbl">Tipo</label>
                            <select value={p.cardType || ''} onChange={(e) => setSplitRow(i, { cardType: e.target.value, creditCard: '' })} className="input">
                              <option value="">Tipo…</option>
                              {CARD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                            </select>
                          </div>
                          <div className="flex-1 min-w-[150px]">
                            <label className="lbl">Tarjeta</label>
                            <select value={p.creditCard || ''} onChange={(e) => setSplitRow(i, { creditCard: e.target.value })} className="input">
                              <option value="">{cardsOfType(p.cardType).length ? 'Seleccionar…' : 'No hay tarjetas'}</option>
                              {cardsOfType(p.cardType).map((c) => <option key={c._id} value={c._id}>{c.name} ({c.brand})</option>)}
                            </select>
                          </div>
                          <div className="w-24">
                            <label className="lbl">N° lote</label>
                            <input value={p.cardLote || ''} onChange={(e) => setSplitRow(i, { cardLote: e.target.value })} className="input" />
                          </div>
                        </>
                      )}
                      <button type="button" onClick={() => removeSplitRow(i)} className="text-rose-500 hover:text-rose-600 pb-2 bg-transparent border-none cursor-pointer" title="Quitar método"><HiOutlineTrash className="w-4 h-4" /></button>
                    </div>
                  ))}
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <button type="button" onClick={addSplitRow} className="text-emerald-600 text-sm flex items-center gap-1 bg-transparent border-none cursor-pointer"><HiOutlinePlus className="w-4 h-4" /> Agregar método</button>
                    <div className="text-sm text-slate-600">
                      Pagado: <b className="font-mono">${splitPaid.toFixed(2)}</b> / Total: <b className="font-mono">${total.toFixed(2)}</b>
                      {Math.abs(splitRemaining) > 0.01
                        ? <span className={`ml-2 font-semibold ${splitRemaining > 0 ? 'text-amber-600' : 'text-rose-600'}`}>{splitRemaining > 0 ? `Falta $${splitRemaining.toFixed(2)}` : `Sobra $${(-splitRemaining).toFixed(2)}`}</span>
                        : <span className="ml-2 text-emerald-600 font-semibold">✓ Cuadra</span>}
                    </div>
                  </div>
                  {splitPayments.some((p) => p.method === 'credito') && (
                    <div className="w-48">
                      <label className="lbl">Vence (parte a crédito)</label>
                      <input type="date" value={form.dueDate || ''} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} className="input" />
                    </div>
                  )}
                </div>
              )}
            </div>
          </FormSection>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => setModalOpen(false)}
              className="px-5 py-2.5 border border-slate-200 rounded-xl text-sm text-slate-600 hover:bg-slate-50 cursor-pointer bg-white"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving || form.items.length === 0}
              className="px-6 py-2.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white rounded-xl text-sm font-medium disabled:opacity-50 cursor-pointer border-none shadow-lg shadow-emerald-200/50"
            >
              {saving ? 'Procesando...' : `Cobrar $${total.toFixed(2)}`}
            </button>
          </div>
        </form>
      </Modal>

      {/* El backend rechazó la venta porque su centro no es el predeterminado de la bodega.
          No se bloquea: se explica y se confirma. La venta queda con el centro ELEGIDO. */}
      <Modal isOpen={!!ccMismatch} onClose={() => setCcMismatch(null)} title="Centro de costo distinto al de la bodega" size="md">
        {ccMismatch && (
          <div className="space-y-3">
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-800">
              La bodega <b>{ccMismatch.warehouse?.name}</b> tiene un centro de costo predeterminado distinto
              del que estás usando en esta venta.
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
              La venta, su asiento de ingreso, el costo de venta (COGS) y la salida de inventario
              quedarán con <b>{ccMismatch.elegido?.name}</b>. La diferencia queda auditada.
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setCcMismatch(null)} className="px-4 py-2 bg-slate-200 rounded-xl">Volver a revisar</button>
              <button
                type="button"
                disabled={saving}
                onClick={() => { setSaving(true); enviarVenta(ccMismatch.paymentPayload, { costCenterConfirmed: true }).catch((e) => toast.error(e.response?.data?.message || 'Error al crear venta')); }}
                className="px-4 py-2 bg-amber-600 text-white rounded-xl shadow-sm shadow-amber-600/20"
              >
                Registrar con el centro elegido
              </button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        isOpen={!!detailModal}
        onClose={() => setDetailModal(null)}
        title={`Venta ${detailModal?.saleNumber || ''}`}
        size="lg"
      >
        {detailModal && (
          <div className="space-y-4">
            {detailModal.isFirstVisit && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-2 text-amber-700 text-sm font-semibold uppercase tracking-wide">
                ✨ Paciente Nuevo
              </div>
            )}
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-xs text-slate-500">Cliente</p>
                <p className="font-medium">{detailModal.clientName}</p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Cédula / RUC</p>
                <p>{detailModal.clientCedula}</p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Fecha</p>
                <p>{fmtDateTime(detailModal.createdAt)}</p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Método de pago</p>
                <p>
                  {methodLabel(detailModal.paymentMethod)}
                  {detailModal.bankAccount && ` · ${detailModal.bankAccount.name}`}
                  {detailModal.creditCard && ` · ${detailModal.creditCard.name}${detailModal.cardPos ? ` (POS ${detailModal.cardPos})` : ''}`}
                </p>
                {/* Desglose cuando la venta se pagó con varios métodos. */}
                {Array.isArray(detailModal.payments) && detailModal.payments.length > 1 && (
                  <ul className="mt-1 text-xs text-slate-600 space-y-0.5">
                    {detailModal.payments.map((p, i) => (
                      <li key={i} className="flex justify-between gap-3">
                        <span>{methodLabel(p.method)}{p.cardLote ? ` · lote ${p.cardLote}` : ''}</span>
                        <span className="font-mono">${Number(p.amount || 0).toFixed(2)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {detailModal.balance > 0.01 && (
                  <p className="text-xs text-amber-600 font-medium mt-0.5">Saldo por cobrar: ${detailModal.balance.toFixed(2)}</p>
                )}
              </div>
            </div>
            {(detailModal.cashier || detailModal.callCenter || detailModal.doctor || detailModal.nurse || detailModal.recommendedBy) && (
              <div className="bg-indigo-50/60 border border-indigo-100 rounded-xl p-3 grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                {detailModal.recommendedBy && (
                  <div>
                    <p className="text-indigo-700 font-semibold">Recomendado por</p>
                    <p className="text-slate-700">{detailModal.recommendedBy.name}</p>
                  </div>
                )}
                {detailModal.cashier && (
                  <div>
                    <p className="text-indigo-700 font-semibold">Cajero</p>
                    <p className="text-slate-700">{detailModal.cashier.name}</p>
                  </div>
                )}
                {detailModal.callCenter && (
                  <div>
                    <p className="text-indigo-700 font-semibold">Call Center</p>
                    <p className="text-slate-700">{detailModal.callCenter.name}</p>
                  </div>
                )}
                {detailModal.doctor && (
                  <div>
                    <p className="text-indigo-700 font-semibold">Doctor</p>
                    <p className="text-slate-700">{detailModal.doctor.name}</p>
                  </div>
                )}
                {detailModal.nurse && (
                  <div>
                    <p className="text-indigo-700 font-semibold">Enfermero/a</p>
                    <p className="text-slate-700">{detailModal.nurse.name}</p>
                  </div>
                )}
              </div>
            )}
            <table className="tbl">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="text-left py-2">Producto</th>
                  <th className="text-right py-2">Precio</th>
                  <th className="text-center py-2">Cant.</th>
                  <th className="text-right py-2">Desc.</th>
                  <th className="text-right py-2">Subtotal</th>
                </tr>
              </thead>
              <tbody>
                {detailModal.items.map((item, idx) => (
                  <tr key={idx} className="border-b border-slate-100">
                    <td className="py-2">
                      {item.productName}
                      {item.treatment && (
                        <span className="ml-2 text-[10px] uppercase tracking-wide bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">
                          tratamiento
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-right">${item.unitPrice.toFixed(2)}</td>
                    <td className="py-2 text-center">{item.quantity}</td>
                    <td className="py-2 text-right text-rose-600">
                      {item.discount ? `-$${Number(item.discount).toFixed(2)}` : '—'}
                    </td>
                    <td className="py-2 text-right">${item.subtotal.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="bg-emerald-50/50 rounded-xl p-4 space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-500">Subtotal:</span>
                <span>${detailModal.subtotal.toFixed(2)}</span>
              </div>
              {detailModal.discountTotal > 0 && (
                <div className="flex justify-between">
                  <span className="text-slate-500">Descuento:</span>
                  <span className="text-rose-600">-${detailModal.discountTotal.toFixed(2)}</span>
                </div>
              )}
              {detailModal.taxAmount > 0 && (
                <div className="flex justify-between">
                  <span className="text-slate-500">IVA:</span>
                  <span>${detailModal.taxAmount.toFixed(2)}</span>
                </div>
              )}
              <div className="flex justify-between font-bold border-t border-emerald-200 pt-2">
                <span>Total:</span>
                <span className="text-emerald-700">${detailModal.total.toFixed(2)}</span>
              </div>
            </div>
          </div>
        )}
      </Modal>

      {/* Asiento de la venta: SOLO LECTURA y por DOCUMENTO ORIGEN, no por un único id.
          Una venta genera VARIOS asientos (ingreso + costo de ventas, y sus reversas si se
          anuló): buscándolos por `source` se ven todos, incluido el del COSTO, que antes
          había que ir a buscar a los reportes. */}
      {journalSale && (
        <JournalEntryViewModal
          isOpen={!!journalSale}
          onClose={() => setJournalSale(null)}
          source={{ model: 'Sale', ref: journalSale._id }}
          title={`Asientos de la venta ${journalSale.saleNumber || ''}`}
          emptyHint="Al completar la venta se generan el asiento de INGRESO (cliente/caja contra ventas e IVA) y el de COSTO DE VENTAS (costo contra inventario). Aquí se listan todos."
          hideOriginLink
        />
      )}
    </div>
  );
}

function TopProductsChart({ data }) {
  if (!data || data.length === 0) {
    return (
      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 p-6 mb-6 text-center text-slate-400 text-sm">
        Sin datos para mostrar
      </div>
    );
  }
  const top = data.slice(0, 10);
  const maxQty = Math.max(...top.map((d) => d.quantity || 0), 1);
  return (
    <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 p-6 mb-6">
      <h3 className="text-lg font-bold text-slate-800 mb-4">Top productos/servicios vendidos</h3>
      <div className="space-y-3">
        {top.map((p) => {
          const pct = ((p.quantity || 0) / maxQty) * 100;
          return (
            <div key={p._id} className="grid grid-cols-12 gap-2 items-center">
              <div className="col-span-4 text-sm text-slate-700 truncate" title={p.name}>
                {p.name}
              </div>
              <div className="col-span-6 bg-slate-100 rounded-full h-6 overflow-hidden relative">
                <div
                  className="h-full bg-gradient-to-r from-emerald-500 to-teal-500 rounded-full flex items-center justify-end pr-2 text-white text-xs font-bold"
                  style={{ width: `${pct}%` }}
                >
                  {p.quantity}
                </div>
              </div>
              <div className="col-span-2 text-right text-sm font-medium text-emerald-700">
                ${Number(p.revenue || 0).toFixed(2)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
