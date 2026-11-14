import { useState, useEffect, useRef, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../api/axios';
import Modal from '../components/Modal';
import { downloadFile } from '../utils/download';
import ProductAutocomplete from '../components/ProductAutocomplete';
import PageHeader, { EmptyState } from '../components/PageHeader';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { fmtDateTime } from '../utils/date';
import NumericInput from '../components/NumericInput';
import SearchableSelect from '../components/SearchableSelect';
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
  HiOutlineDocumentArrowDown,
} from 'react-icons/hi2';
import JournalEntryViewModal from '../components/JournalEntryViewModal';
import { newIdempotencyKey, withIdempotencyKey, intentKey } from '../utils/idempotency';
import DateInput from '../components/DateInput';
import ServiciosSinCobro from '../components/ServiciosSinCobro';
import ItemsVinculadosCobro from '../components/ItemsVinculadosCobro';
import { FUENTES_VINCULADO } from '../constants/itemsVinculados';
import { includedLimit, totalIncluded } from '../utils/includedComponents';
import { serviciosDeLaCita, listaSinCobro, tipoSinCobro } from '../utils/serviciosSinCobro';
import { soloActivos as soloUsuariosActivos } from '../utils/activeUsers';
import { ROLE_LABELS } from '../utils/roles';

const paymentMethods = {
  efectivo: 'Efectivo',
  tarjeta: 'Tarjeta',
  transferencia: 'Transferencia',
  credito: 'Crédito (CxC)',
};
// Etiqueta legible de un método (incluye 'mixto' para el detalle).
const methodLabel = (m) => paymentMethods[m]
  || (m === 'mixto' ? 'Pago mixto' : m === 'anticipo' ? 'Saldo a favor' : m || '—');

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

/**
 * DIFERIDO de tarjeta de crédito. No cambia el asiento de la venta (se debita el bruto igual),
 * pero sí la comisión que cobra el adquirente: sin el diferido, la liquidación de tarjeta no
 * cuadra contra el recap del POS. Solo aplica a tarjeta de CRÉDITO.
 */
const DEFERRED_TYPES = [
  { value: 'CORRIENTE', label: 'Corriente (sin diferir)' },
  { value: 'SIN_INTERES', label: 'Diferido SIN intereses' },
  { value: 'CON_INTERES', label: 'Diferido CON intereses' },
];
const DEFERRED_MONTHS = [3, 6, 9, 12, 18, 24];

/**
 * PLAZOS DE CRÉDITO. La contadora trabaja con plazos ("a 30 días"), no con fechas: el
 * calendario obligaba a contar los días a mano y a equivocarse. El vencimiento lo calcula el
 * backend desde el plazo; queda 'CUSTOM' para el caso raro que necesite una fecha exacta.
 */
const CREDIT_TERMS = [
  { value: 0, label: 'Contado (0 días)' },
  { value: 5, label: '5 días' },
  { value: 8, label: '8 días' },
  { value: 15, label: '15 días' },
  { value: 30, label: '30 días' },
  { value: 45, label: '45 días' },
  { value: 60, label: '60 días' },
  { value: 90, label: '90 días' },
];

/** Fecha de vencimiento previsualizada en el modal (el backend la recalcula igual). */
const vencimientoDesdePlazo = (dias) => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + (parseInt(dias, 10) || 0));
  return d.toLocaleDateString('es-EC');
};

/** Sección del modal de venta: agrupa campos afines con su título. */
/**
 * `tone="destacado"` (nov-2026): la sección del MÉTODO DE PAGO va con borde y
 * encabezado de color y fondo suave, para que el cajero la distinga del resto del
 * cobro de un vistazo (lo pidieron los usuarios con facturación electrónica).
 */
const SECTION_TONES = {
  normal: {
    section: 'border border-slate-200',
    header: 'bg-slate-50 border-b border-slate-200',
    title: 'text-sm font-semibold text-slate-700',
    icon: 'text-emerald-600',
    subtitle: 'text-slate-500',
    body: '',
  },
  destacado: {
    section: 'border-2 border-sky-300 shadow-sm shadow-sky-100',
    header: 'bg-sky-600 border-b border-sky-600',
    title: 'text-sm font-bold text-white uppercase tracking-wide',
    icon: 'text-white',
    subtitle: 'text-sky-100',
    body: 'bg-sky-50/60',
  },
};
function FormSection({ title, subtitle, icon: Icon, children, className = '', tone = 'normal' }) {
  const t = SECTION_TONES[tone] || SECTION_TONES.normal;
  return (
    <section className={`${t.section} rounded-xl overflow-hidden ${className}`}>
      <header className={`${t.header} px-3 py-2`}>
        <h3 className={`${t.title} flex items-center gap-1.5`}>
          {Icon && <Icon className={`w-4 h-4 ${t.icon}`} />}{title}
        </h3>
        {subtitle && <p className={`text-[11px] ${t.subtitle} mt-0.5`}>{subtitle}</p>}
      </header>
      <div className={`p-3 ${t.body}`}>{children}</div>
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
/**
 * IVA de una línea, espejo de `calculateSaleLine` (server/utils/tax.js): el backend es quien
 * factura, esto solo lo muestra. Con `priceIncludesVat` (lo normal) el precio YA lleva el IVA
 * y se desglosa por dentro; sin él, el IVA se suma encima.
 */
const r2 = (n) => +Number(n || 0).toFixed(2);
/**
 * DESCUENTO DE LA LÍNEA: por defecto el del PRODUCTO (inventario). Desde el 29-10-2026 el
 * cajero lo puede cambiar al cobrar (`manualDiscount`, en $); si lo cambia, la venta exige
 * el motivo. Espejo de server/utils/productDiscount.js (`descuentoAlCobrar`).
 */
const descuentoDeLinea = (item) => {
  if (item?.manualDiscount !== undefined && item?.manualDiscount !== null && item?.manualDiscount !== '') {
    const bruto = Math.max(r2(Number(item.unitPrice || 0) * Number(item.quantity || 0)), 0);
    return Math.min(Math.max(r2(item.manualDiscount), 0), bruto);
  }
  return item?.automaticDiscount ?? descuentoDelProducto(item);
};
const descuentoDelProducto = (item) => {
  const valor = Number(item?.discountValue) || 0;
  if (!item?.discountType || valor <= 0) return 0;
  const bruto = r2(Number(item.unitPrice || 0) * Number(item.quantity || 0));
  if (bruto <= 0) return 0;
  const d = item.discountType === 'percentage'
    ? r2(bruto * Math.min(valor, 100) / 100)
    : item.discountType === 'amount' ? r2(valor * Number(item.quantity || 0)) : 0;
  return Math.min(d, bruto);
};
const esServicioLinea = (item) => item?.category === 'servicio' || item?.unlimited === true;
// En qué se guarda lo que el paciente deja en la clínica (igual que el servidor): un compuesto
// de UN componente entero (2 × ampolla) se guarda como sus ampollas; lo demás, como sí mismo.
const unidadGuardable = (product) => {
  const comp = product?.isComposite ? (product.composition || []) : [];
  const q = Number(comp[0]?.quantity);
  if (comp.length === 1 && Number.isInteger(q) && q >= 1) return { factor: q, nombre: comp[0].productName || 'componente' };
  return { factor: 1, nombre: product?.unit && product.unit !== 'unidad' ? product.unit : 'unidad(es)' };
};
// Identificaciones con las que un paciente puede aparecer: su cédula y, en un RUC de
// persona natural (cédula + 001), la cédula de dentro. Consumidor Final no cuenta.
const cedulasCandidatas = (identificacion) => {
  const id = String(identificacion || '').replace(/\s+/g, '').trim();
  if (!/^\d{10}$|^\d{13}$/.test(id) || /^9{10,13}$/.test(id)) return [];
  return id.length === 13 && id.endsWith('001') ? [id, id.slice(0, 10)] : [id];
};
/**
 * COMPUESTO CON COMPOSICIÓN FIJA (29-10-2026, server/utils/composicion): no tiene stock propio;
 * se vende por lo que alcanzan sus componentes (`compositeAvailable`, lo calcula el servidor)
 * y al cobrarlo salen ellos del inventario.
 */
const esCompuestoFijo = (product) => typeof product?.compositeAvailable === 'number';
const stockVendible = (product) => (esCompuestoFijo(product) ? product.compositeAvailable : Number(product?.stock || 0));
const componentesTexto = (product) => (product?.composition || [])
  .map((c) => `${c.quantity} × ${c.productName || 'componente'}, hay ${c.stock}`).join('; ');
/**
 * ÍTEMS VINCULADOS del producto (oct-2026), con nombre y código del catálogo cargado:
 * lo que se puede escoger como «usado» al cobrarlo. Los inactivos no salen.
 */
const opcionesVinculadas = (product, catalogo) => {
  if (product?.includedComponents?.enabled) {
    const categorias = new Set((product.includedComponents.categories || []).map((c) => String(c?._id || c)));
    return catalogo.filter((p) => p.active !== false && p.category === 'insumo' && !p.unlimited &&
      String(p._id) !== String(product._id) && categorias.has(String(p.inventoryCategory?._id || p.inventoryCategory || '')))
      .map((p) => ({ product: String(p._id), productName: p.name, code: p.code, quantity: 1, preselect: false }));
  }
  // Nov-2026: los ítems vinculados normales NO se escogen al cobrar. Los descuenta el
  // servidor solo, según lo configurado en la ficha del producto.
  return [];
};
// Las cantidades de los vinculados que nadie tocó siguen a la cantidad de la línea.
const reescalarVinculados = (linked, qty) => (linked || [])
  .map((l) => (l.cantAuto ? { ...l, quantity: +(Number(l.base || 1) * Number(qty || 1)).toFixed(4) } : l));
// Filtro del buscador de productos. Fuera del componente: una función nueva en cada
// render obliga al buscador a recalcular su lista a cada rato.
const soloActivos = (p) => p.active !== false;
/**
 * ENTER NO COBRA (oct-2026). En la ventana de cobro, Enter en cualquier campo enviaba el
 * formulario y registraba la venta sin querer. Ahora cobrar es SOLO con el clic en el
 * botón. Enter sigue sirviendo en los textos largos y en los botones de acción normales.
 */
const enterNoEnvia = (e) => {
  if (e.key !== 'Enter') return;
  const t = e.target;
  if (t.tagName === 'TEXTAREA') return;
  if (t.tagName === 'BUTTON' && t.type !== 'submit') return;
  e.preventDefault();
};
const ivaDeLinea = (item) => {
  // Como el servidor (utils/tax): IVA_15 con tasa 0 es IVA quitado desde la ficha.
  const sinIva = item.taxCategory === 'IVA_15' && item.taxRate !== null && item.taxRate !== undefined && Number(item.taxRate) === 0;
  const cat = sinIva ? 'IVA_0' : (item.taxCategory || 'IVA_15');
  const norm = (n) => (Number(n) > 0 ? (Number(n) <= 1 ? Number(n) * 100 : Number(n)) : 0);
  const rate = ['IVA_0', 'EXENTO', 'NO_OBJETO'].includes(cat) ? 0
    : cat === 'IVA_5' ? 5
      : cat === 'IVA_12' ? 12
        : cat === 'IVA_15' ? (norm(item.taxRate) || 15)
          : norm(item.taxRate);
  const neto = r2(r2(item.unitPrice * item.quantity) - descuentoDeLinea(item));
  if (item.priceIncludesVat !== false && rate > 0) {
    const base = r2(neto / (1 + rate / 100));
    return { rate, base, iva: r2(neto - base), total: neto };
  }
  const iva = r2(neto * (rate / 100));
  return { rate, base: neto, iva, total: r2(neto + iva) };
};
const activePriceOf = (product) => {
  const list = priceListOf(product);
  return list.find((p) => p.active) || list[0];
};

/**
 * Props del modo INCRUSTADO (oct-2026, factura desde la agenda). La página de
 * Ventas se monta sin ellas. La agenda la monta con:
 *   embebido       solo los modales, sin la página;
 *   citaId         la cita que se cobra (la venta nace enlazada a ella);
 *   itemsIniciales [{ product, quantity }] — la RECETA a cobrar. Sin esto se
 *                  cobra la VISITA: los servicios de la cita, su valor acordado y
 *                  lo que ya abonó;
 *   onCobrado(venta) al registrar la venta (venta = null si se continúa sin
 *                  cobrar un canje);
 *   onCerrar()     al cerrar sin cobrar.
 */
export default function Sales({ embebido = false, citaId = null, itemsIniciales = null, onCobrado, onCerrar, abrirNueva = false } = {}) {
  const { hasRole } = useAuth();
  const [journalSale, setJournalSale] = useState(null); // venta cuyos asientos se consultan (solo lectura)
  const canCreate = hasRole('admin', 'cajero', 'contabilidad');
  const canCancel = hasRole('admin', 'contabilidad');
  const canInvoice = hasRole('admin', 'cajero');
  const canAccounting = hasRole('admin', 'contabilidad');
  // Historial: admin y contabilidad ven todo; el cajero (29-10-2026) solo lo que él registró,
  // cobró o facturó (lo filtra el servidor).
  const canViewHistory = hasRole('admin', 'contabilidad', 'cajero');

  const [sales, setSales] = useState([]);
  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState([]);
  const [treatments, setTreatments] = useState([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [discountPreview, setDiscountPreview] = useState({ key: '', items: [], error: '' });
  const [discountRefresh, setDiscountRefresh] = useState(0);
  const [detailModal, setDetailModal] = useState(null);
  const [saving, setSaving] = useState(false);
  // Anulación de una venta con factura autorizada (se anula la factura y la venta).
  const [anularFactura, setAnularFactura] = useState(null);
  const [motivoAnulacion, setMotivoAnulacion] = useState('');
  const [anulando, setAnulando] = useState(false);
  const [invoicingId, setInvoicingId] = useState(null);
  const [filter, setFilter] = useState({ startDate: '', endDate: '', product: '', client: '' });
  const [downloadingZip, setDownloadingZip] = useState(false);
  const [topProducts, setTopProducts] = useState([]);
  const [showChart, setShowChart] = useState(false);
  // Punto de venta (caja) del usuario: de él sale la serie de sus facturas. Con puntos en la
  // sucursal, quien no tiene uno no puede facturar.
  const [miPunto, setMiPunto] = useState({ usaPuntos: false, punto: null });
  const [facturarAlGuardar, setFacturarAlGuardar] = useState(false);
  const puedeFacturarAqui = canInvoice && (!miPunto.usaPuntos || !!miPunto.punto);
  // Quien factura electrónicamente (tiene punto) no cobra ni factura con la caja cerrada.
  const cajaCerrada = !!miPunto.punto && miPunto.cajaAbierta === false;
  const MSG_CAJA_CERRADA = 'No puedes facturar hasta tener la caja abierta. Abre tu caja en Caja (Apertura/Cierre).';
  const serieTexto = miPunto.punto
    ? `${miPunto.punto.establecimiento}-${miPunto.punto.codigo}${miPunto.punto.nombre ? ` (${miPunto.punto.nombre})` : ''}`
    : '';

  useEffect(() => {
    if (!canCreate) return;
    api.get('/puntos-emision/mio')
      .then((r) => {
        const d = r.data || { usaPuntos: false, punto: null };
        setMiPunto(d);
        // Quien tiene su propia caja factura al cobrar; el resto, como antes, desde el historial.
        setFacturarAlGuardar(!!d.punto && canInvoice);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Al abrir el cobro se relee el punto: su secuencial avanza con cada factura (de esta caja o
  // de otra pestaña) y el cajero ve en el modal el número que llevará la factura.
  useEffect(() => {
    if (!modalOpen || !canCreate || !miPunto.punto) return;
    api.get('/puntos-emision/mio')
      .then((r) => { if (r.data) setMiPunto(r.data); })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modalOpen]);
  const proximaFactura = miPunto.punto?.secuencialFactura
    ? `${miPunto.punto.establecimiento}-${miPunto.punto.codigo}-${String(miPunto.punto.secuencialFactura).padStart(9, '0')}`
    : '';

  const [form, setForm] = useState({
    clientName: 'Consumidor Final',
    clientCedula: '9999999999999',
    clientEmail: '',
    clientPhone: '',
    clientAddress: '',
    clientCity: 'Guayaquil',
    clientZone: '',
    patient: '',
    paymentMethod: '',  // sin preselección: el cajero escoge el método (obligatorio)
    bankAccount: '',
    creditCard: '',
    cardType: '',      // DEBITO | CREDITO (elegido por el cajero, no deducido de la tarjeta)
    cardPos: '',
    cardLote: '',
    cardVoucher: '',
    transferRef: '',   // N° de la transferencia (lo pide contabilidad para conciliar)
    cardDeferredType: 'CORRIENTE',  // solo tarjeta de crédito
    cardDeferredMonths: 0,
    creditTerm: 30,    // plazo en días de la parte a crédito ('CUSTOM' = fecha exacta)
    dueDate: '',
    recommendedBy: '',
    notes: '',
    discountReason: '', // motivo del descuento / comentario del cobro (uno por venta)
    // CITA que se está cobrando (deep-link desde la agenda, «Cobrar cita»).
    // Va en el cuerpo de la venta y queda en `Sale.appointment`: es lo que
    // permite a Analíticas sumar lo cobrado en mostrador por cada cita.
    appointment: null,
    // Bodega de la que sale la mercadería y centro de costo con el que se registra la venta.
    // El centro lo PROPONE la bodega; se puede cambiar confirmando la diferencia.
    warehouse: '',
    costCenter: '',
    items: [],
  });
  // { warehouse, esperado, elegido } cuando el backend rechaza por centro distinto (409).
  const [ccMismatch, setCcMismatch] = useState(null);
  // Cobro de la CxC de una venta (se registra como documento de Cobro, ver openCollect).
  const [collectItem, setCollectItem] = useState(null);
  const [collectForm, setCollectForm] = useState({ date: '', amount: 0, method: 'EFECTIVO', bankAccount: '', reference: '' });
  const [collectBusy, setCollectBusy] = useState(false);
  const [collectIntent, setCollectIntent] = useState('');
  const [currentItem, setCurrentItem] = useState({ product: '', quantity: 1 });
  // Pago dividido: el cliente paga con varios métodos (p.ej. mitad efectivo + mitad
  // tarjeta) o deja una parte a crédito. Cuando está activo, `splitPayments` es la
  // fuente de verdad y se envía como `payments` al backend.
  const [splitMode, setSplitMode] = useState(false);
  const [splitPayments, setSplitPayments] = useState([]);
  // LO QUE ENTREGA EL PACIENTE con un solo método (oct-2026). Vacío = paga justo
  // el total. Si entrega más (45 de total y deja 100), se factura solo el total
  // y el resto queda como SALDO A FAVOR suyo para próximos cobros.
  const [recibido, setRecibido] = useState('');
  const [patientSearch, setPatientSearch] = useState('');
  // Personas registradas en Personas con el rol CLIENTE. El buscador de la venta solo miraba
  // los PACIENTES: quien registraba un cliente por allí no lo encontraba nunca al facturar,
  // ni por nombre ni por cédula. Se consultan al servidor mientras se escribe.
  const [clientResults, setClientResults] = useState([]);
  /**
   * PACIENTES: se buscan en el SERVIDOR mientras se escribe (29-10-2026). Antes se bajaban
   * los 1000 más recientes y se filtraba aquí: con ~12.000 pacientes, quien no estaba entre
   * esos 1000 (p. ej. «JESSICA GRANDA PACHECO», el 2.008) no aparecía nunca.
   */
  const [patientResults, setPatientResults] = useState([]);
  const [buscandoCliente, setBuscandoCliente] = useState(false);
  const busquedaClienteRef = useRef(0);
  const [pickedFromList, setPickedFromList] = useState(false); // ya se eligió: cierra el desplegable
  const clientDebounceRef = useRef(null);
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

  // Solo vale la respuesta de la ÚLTIMA búsqueda: al teclear, una más vieja que llegue tarde
  // pisaba la lista con resultados de un texto que ya no está.
  const busquedaRef = useRef(0);
  const fetchSales = async () => {
    if (!canViewHistory || embebido) { setLoading(false); return; }
    const mia = ++busquedaRef.current;
    try {
      const params = {};
      if (filter.startDate) params.startDate = filter.startDate;
      if (filter.endDate) params.endDate = filter.endDate;
      if (filter.product) params.product = filter.product;
      if (filter.client) params.client = filter.client;
      const res = await api.get('/sales', { params });
      if (mia === busquedaRef.current) setSales(res.data.sales);
    } catch {
      if (mia === busquedaRef.current) toast.error('Error al cargar ventas');
    } finally {
      if (mia === busquedaRef.current) setLoading(false);
    }
  };

  // Buscador de cliente: se escribe en `clienteTexto` y se busca al dejar de teclear.
  const [clienteTexto, setClienteTexto] = useState('');
  useEffect(() => {
    const t = setTimeout(() => {
      setFilter((f) => (f.client === clienteTexto.trim() ? f : { ...f, client: clienteTexto.trim() }));
    }, 350);
    return () => clearTimeout(t);
  }, [clienteTexto]);

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

  useEffect(() => {
    fetchSales();
    if (canCreate) {
      fetchProducts();
      api.get('/banks/payment-options')
        .then((r) => setPayOptions({ accounts: r.data?.accounts || [], cards: r.data?.cards || [] }))
        .catch(() => setPayOptions({ accounts: [], cards: [] }));
      // A quién se atribuye la venta (comisión): cualquier usuario activo de la
      // empresa. Caja puede leer este listado aunque no administre usuarios.
      api.get('/users/purchase-recommenders')
        .then((r) => setStaff(r.data || []))
        .catch(() => setStaff([]));
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
      paymentMethod: '',
      bankAccount: '',
      creditCard: '',
      cardType: '',
      cardPos: '',
      cardLote: '',
      cardVoucher: '',
      transferRef: '',
      cardDeferredType: 'CORRIENTE',
      cardDeferredMonths: 0,
      creditTerm: 30,
      dueDate: '',
      recommendedBy: '',
      notes: '',
      discountReason: '',
      appointment: null,
      warehouse: '',
      costCenter: '',
      items: [],
    });
    setCurrentItem({ product: '', quantity: 1 });
    setPatientSearch('');
    setClientResults([]);
    setPickedFromList(false);
    setSplitMode(false);
    setSplitPayments([]);
    setRecibido('');
    setCcMismatch(null);
    setModalOpen(true);
  };

  useEffect(() => {
    if (abrirNueva && canCreate) openNew();
    // Solo al montar: los cambios de formulario no deben reabrir el modal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Tarjetas ofrecidas para un tipo (débito/crédito). Se filtra por `accountType` cuando la
   * configuración lo distingue; si ninguna tarjeta coincide (p. ej. un único registro
   * "Datafast" que procesa las dos), se muestran todas: el tipo que manda es el que eligió
   * el cajero, y esconder las tarjetas dejaría la venta sin poder registrarse.
   */
  const cardsOfType = (type) => {
    if (!type) return payOptions.cards;
    // Datafast procesa débito y crédito con un mismo registro: sale con cualquier tipo.
    const match = payOptions.cards.filter((c) => !c.accountType || c.accountType === type || /datafast/i.test(`${c.name} ${c.acquirer || ''}`));
    return match.length ? match : payOptions.cards;
  };
  const cardOptions = cardsOfType(form.cardType);
  // «Datafast», o «Visa crédito (VISA · Medianet)»: sin repetir el adquirente ni la marca «OTRA».
  const etiquetaTarjeta = (c) => {
    const extra = [c.brand && c.brand !== 'OTRA' ? c.brand : '', c.acquirer && !String(c.name).toLowerCase().includes(String(c.acquirer).toLowerCase()) ? c.acquirer : '']
      .filter(Boolean).join(' · ');
    return extra ? `${c.name} (${extra})` : c.name;
  };

  // `elegido`: el producto escogido con ENTER en el buscador (se agrega directo, sin
  // esperar a que `currentItem` se actualice). Desde el botón llega el evento: se ignora.
  const addItem = (elegidoConEnter) => {
    const directo = elegidoConEnter && elegidoConEnter._id ? elegidoConEnter : null;
    if (!directo && !currentItem.product) return toast.error('Selecciona un producto');
    const product = directo || products.find((p) => p._id === currentItem.product);
    if (!product) return;

    const isService = product.category === 'servicio' || product.unlimited === true;
    if (form.items.find((i) => String(i.product) === String(product._id))) {
      return toast.error('El producto ya está en la lista');
    }
    const qty = parseInt(currentItem.quantity) || 1;
    // Sin stock NO bloquea (29-10-2026): solo avisa; el servidor descuenta lo que haya.
    if (!isService && qty > stockVendible(product)) {
      toast(esCompuestoFijo(product)
        ? `${product.name}: no alcanzan sus componentes (${componentesTexto(product)}). Se cobra igual.`
        : `${product.name}: el inventario tiene ${stockVendible(product)}. Se cobra igual.`, { icon: '⚠️' });
    }

    // Precio: el ACTIVO del producto por defecto; si en el buscador se eligió otro de la lista,
    // ese. Se guarda el NOMBRE del precio además del importe: es lo que valida el backend
    // junto con el importe, para distinguir tambien nombres repetidos.
    const lista = priceListOf(product);
    // (El precio escogido en el buscador es del producto de `currentItem`, no de otro.)
    const precioPedido = String(currentItem.product) === String(product._id) ? currentItem.priceIndex : undefined;
    const elegido = lista[precioPedido] || activePriceOf(product);

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
          discountType: product.discountType || '',
          discountValue: Number(product.discountValue) || 0,
          taxRate: product.taxRate,
          taxCategory: product.taxCategory,
          priceIncludesVat: product.priceIncludesVat,
          stock: stockVendible(product),
          composite: esCompuestoFijo(product),
          treatment: '',
          // Un servicio que se agrega al cobrar una cita y que la cita no lleva es, casi
          // siempre, algo que se deja pagado para después. Se puede desmarcar.
          prepaid: isService && prepagoPorDefecto(product._id, qty),
          ...extrasDeLinea(product, qty),
        },
      ],
    }));
    setCurrentItem({ product: '', quantity: 1 });
  };

  const removeItem = (idx) => {
    setForm({ ...form, items: form.items.filter((_, i) => i !== idx) });
  };

  const updateItemQty = (idx, qty) => {
    const items = [...form.items];
    const newQty = parseInt(qty) || 1;
    const it = items[idx];
    const isService = it.category === 'servicio' || it.unlimited === true;
    if (!isService && newQty > it.stock && !(it.quantity > it.stock)) {
      toast(`${it.productName}: el inventario tiene ${it.stock}. Se cobra igual.`, { icon: '⚠️' });
    }
    const linked = reescalarVinculados(it.linked, newQty);
    const limite = includedLimit({ ...it, quantity: newQty });
    if (limite != null && totalIncluded(linked) > limite) {
      return toast.error(`Reduce primero los componentes de «${it.productName}»: el máximo sería ${limite}.`);
    }
    items[idx] = { ...items[idx], quantity: newQty, linked };
    // Al subir la cantidad de un servicio de la cita, lo que pasa de lo de hoy queda
    // para citas futuras (sigue pudiéndose desmarcar).
    if (isService && citaPorCobrar && !modoReceta) items[idx].prepaid = prepagoPorDefecto(it.product, newQty);
    setForm({ ...form, items });
  };

  const discountKey = JSON.stringify({ patient: form.patient || null, items: form.items.map((i) => ({
    product: i.product, quantity: Number(i.quantity), priceName: i.priceName || undefined, unitPrice: Number(i.unitPrice),
  })) });
  useEffect(() => {
    if (!modalOpen || !form.items.length) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      api.post('/sales/discount-preview', JSON.parse(discountKey))
        .then((r) => { if (!cancelled) setDiscountPreview({ key: discountKey, items: r.data.items || [], error: '' }); })
        .catch((e) => { if (!cancelled) setDiscountPreview({ key: discountKey, items: [], error: e.response?.data?.message || 'No se pudieron calcular los descuentos' }); });
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [discountKey, discountRefresh, modalOpen, form.items.length]);
  const previewReady = discountPreview.key === discountKey && !discountPreview.error && discountPreview.items.length === form.items.length;
  const lineasVenta = form.items.map((item, i) => ({ ...item,
    automaticDiscount: previewReady ? discountPreview.items[i].discount : descuentoDelProducto(item),
    appliedDiscounts: previewReady ? discountPreview.items[i].applied : [],
  }));
  const subtotal = lineasVenta.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
  const discountTotal = lineasVenta.reduce((s, i) => s + descuentoDeLinea(i), 0);
  // El motivo es obligatorio si alguna línea lleva un descuento distinto al del producto.
  const descuentoCambiado = lineasVenta.some((i) => descuentoDeLinea(i) > 0
    && Math.abs(descuentoDeLinea(i) - i.automaticDiscount) > 0.005);
  // El IVA lo calcula el backend por línea (`utils/tax`); `ivaDeLinea` lo replica para mostrar
  // el desglose y para que el total coincida con lo que se va a facturar.
  const lineasIva = lineasVenta.map(ivaDeLinea);
  const ivaTotal = r2(lineasIva.reduce((s, l) => s + l.iva, 0));
  const baseGravada = r2(lineasIva.reduce((s, l) => s + (l.rate > 0 ? l.base : 0), 0));
  const total = r2(lineasIva.reduce((s, l) => s + l.total, 0));

  // ── Pago dividido ── (debe ir DESPUÉS de `total`: se evalúa en cada render y
  // usarlo antes de su declaración rompía la página completa con ReferenceError)
  const splitPaid = splitPayments.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const splitRemaining = +(total - splitPaid).toFixed(2);

  // «Recibido del paciente» (un solo método): solo con dinero que entra.
  const metodoConRecibido = ['efectivo', 'tarjeta', 'transferencia'].includes(form.paymentMethod);
  const recibidoNum = !splitMode && metodoConRecibido && String(recibido).trim() !== '' ? Number(recibido) : null;
  const recibidoDif = recibidoNum !== null && Number.isFinite(recibidoNum) ? +(recibidoNum - total).toFixed(2) : 0;

  const filaDePago = (method, amount) => ({ method, amount, bankAccount: '', creditCard: '', cardType: '', cardPos: '', cardLote: '', cardVoucher: '', reference: '', cardDeferredType: 'CORRIENTE', cardDeferredMonths: 0 });
  /**
   * «Agregar otro método de pago»: con UN clic quedan las DOS filas a la vista —la del
   * método que ya estaba elegido (con el total) y la nueva—. Antes entraba con una sola
   * fila y había que pulsar «Agregar método» otra vez para ver la segunda.
   */
  const enableSplit = () => {
    const primero = {
      ...filaDePago(form.paymentMethod || '', +total.toFixed(2)),
      bankAccount: form.bankAccount || '', creditCard: form.creditCard || '', cardType: form.cardType || '',
      cardPos: form.cardPos || '', cardLote: form.cardLote || '', cardVoucher: form.cardVoucher || '',
      reference: form.transferRef || '', cardDeferredType: form.cardDeferredType || 'CORRIENTE', cardDeferredMonths: form.cardDeferredMonths || 0,
    };
    setSplitPayments([primero, filaDePago('', 0)]);
    setSplitMode(true);
  };
  const addSplitRow = () => setSplitPayments((rows) => [...rows, filaDePago('', splitRemaining > 0 ? +splitRemaining.toFixed(2) : 0)]);
  const setSplitRow = (i, patch) => setSplitPayments((rows) => rows.map((r, x) => (x === i ? { ...r, ...patch } : r)));
  // Con DOS pagos, lo que se escribe en uno ajusta el otro para que sumen el total.
  const setSplitAmount = (i, value) => setSplitPayments((rows) => {
    const next = rows.map((r, x) => (x === i ? { ...r, amount: value } : r));
    if (next.length === 2) {
      const otro = 1 - i;
      next[otro] = { ...next[otro], amount: Math.max(0, +(total - (Number(value) || 0)).toFixed(2)) };
    }
    return next;
  });
  // Lo que falta se suma al último pago (un clic en vez de hacer la resta a mano).
  const completarRestante = () => setSplitPayments((rows) => rows.map((r, x) => (
    x === rows.length - 1 ? { ...r, amount: +((Number(r.amount) || 0) + splitRemaining).toFixed(2) } : r
  )));
  // Si al quitar queda un solo pago, se vuelve al modo de un método con sus datos.
  const removeSplitRow = (i) => {
    const rest = splitPayments.filter((_, x) => x !== i);
    if (rest.length > 1) { setSplitPayments(rest); return; }
    const r = rest[0] || filaDePago('', 0);
    setForm((f) => ({
      ...f, paymentMethod: r.method, bankAccount: r.bankAccount || '', creditCard: r.creditCard || '', cardType: r.cardType || '',
      cardPos: r.cardPos || '', cardLote: r.cardLote || '', cardVoucher: r.cardVoucher || '', transferRef: r.reference || '',
      cardDeferredType: r.cardDeferredType || 'CORRIENTE', cardDeferredMonths: r.cardDeferredMonths || 0,
    }));
    setSplitPayments([]);
    setSplitMode(false);
  };

  /**
   * Escribe en el buscador de cliente: pregunta al servidor, en paralelo, por los PACIENTES
   * (todos, por palabras sueltas, sin tildes, cédula o teléfono) y por las PERSONAS con rol
   * CLIENTE (que no son pacientes y viven en otra colección). Solo vale la última búsqueda.
   */
  const onClientSearch = (texto) => {
    setPatientSearch(texto);
    setPickedFromList(false);
    if (form.patient) setForm((f) => ({ ...f, patient: '' }));
    if (clientDebounceRef.current) clearTimeout(clientDebounceRef.current);
    const q = texto.trim();
    const mia = ++busquedaClienteRef.current;
    if (q.length < 2) { setClientResults([]); setPatientResults([]); setBuscandoCliente(false); return; }
    setBuscandoCliente(true);
    clientDebounceRef.current = setTimeout(async () => {
      const [pac, cli] = await Promise.all([
        // withContact: el comprobante del SRI necesita cédula, correo y teléfono del cliente.
        // Es la excepción de facturación a "solo el admin ve el contacto del paciente"
        // (capacidad patients.billingData en el servidor).
        // Un RUC de persona natural (cédula + 001) encuentra al paciente por su cédula.
        api.get('/patients', { params: { search: /^\d{10}001$/.test(q) ? q.slice(0, 10) : q, limit: 15, withContact: 1 } })
          .then((r) => r.data?.patients || []).catch(() => []),
        api.get('/suppliers/clients', { params: { q, limit: 10 } }).then((r) => r.data || []).catch(() => []),
      ]);
      if (mia !== busquedaClienteRef.current) return;
      setPatientResults(pac);
      setClientResults(cli);
      setBuscandoCliente(false);
    }, 250);
  };

  /**
   * COBRAR UNA CITA (deep-link desde la agenda, «Cobrar cita», sep-2026).
   *
   * La agenda abre esta página con `?cita=<id>`: se precarga la cita, se
   * escoge su paciente y la venta nace ya ENLAZADA a la cita
   * (`Sale.appointment`). Sin ese enlace, Analíticas solo puede sumar el
   * abono del agendamiento y lo cobrado en mostrador quedaba invisible.
   */
  const [citaPorCobrar, setCitaPorCobrar] = useState(null);
  const citaCargadaRef = useRef(null);
  const [searchParams] = useSearchParams();
  const citaParam = searchParams.get('cita');
  // Incrustada en la agenda, la cita llega por props; en la página, por la URL.
  const citaObjetivo = embebido ? citaId : citaParam;
  const modoReceta = Array.isArray(itemsIniciales);
  const compraSinReceta = modoReceta && itemsIniciales.length === 0;
  /**
   * SESIONES PREPAGADAS (oct-2026). Cuántas veces lleva la cita cada servicio (por su
   * producto): eso se hace hoy. Lo que se cobre de más de un servicio queda pagado para
   * citas futuras y la cita lo muestra como «Sesión 1 de N».
   */
  const usoEnCita = useMemo(() => {
    const m = new Map();
    if (!citaPorCobrar || modoReceta) return m;
    const sumar = (si) => {
      const id = si?.product?._id || si?.product;
      if (id) m.set(String(id), (m.get(String(id)) || 0) + 1);
    };
    // El servicio que va como canje/cortesía (oct-2026) no se cobra ni gasta sesión.
    if (!tipoSinCobro(citaPorCobrar, citaPorCobrar.serviceItem)) sumar(citaPorCobrar.serviceItem);
    for (const extra of citaPorCobrar.additionalServices || []) {
      if (!tipoSinCobro(citaPorCobrar, extra.serviceItem)) sumar(extra.serviceItem);
    }
    return m;
  }, [citaPorCobrar, modoReceta]);
  const prepagoPorDefecto = (productId, qty) => {
    if (!citaPorCobrar || modoReceta) return false;
    return Number(qty) > (usoEnCita.get(String(productId)) || 0);
  };
  // Para citas futuras: lo que sobra de lo de hoy (o la línea entera sin cita).
  const sesionesFuturas = (item) => Math.max(0, Number(item.quantity || 0) - (usoEnCita.get(String(item.product)) || 0));
  /**
   * A NOMBRE DE QUIÉN SE FACTURA (oct-2026): consumidor final, el paciente de la
   * cita (sus datos se llenan solos) u otra persona (se busca o se escribe). En
   * los tres casos la venta queda enlazada al PACIENTE de la cita: a quién se le
   * factura no cambia quién se atendió.
   */
  const [pacienteCita, setPacienteCita] = useState(null);
  const [facturarA, setFacturarA] = useState('paciente');
  const datosDePaciente = (p) => ({
    clientName: `${p?.firstName || ''} ${p?.lastName || ''}`.trim(),
    clientCedula: p?.cedula || '',
    clientEmail: p?.email || '',
    clientPhone: p?.phone || '',
    clientAddress: p?.address || '',
  });
  const elegirFacturarA = (modo) => {
    setFacturarA(modo);
    setPatientSearch('');
    setPickedFromList(false);
    setClientResults([]);
    if (modo === 'consumidor') {
      setForm((f) => ({ ...f, clientName: 'Consumidor Final', clientCedula: '9999999999999', clientEmail: '', clientPhone: '', clientAddress: '' }));
    } else if (modo === 'paciente' && pacienteCita) {
      setForm((f) => ({ ...f, ...datosDePaciente(pacienteCita) }));
    } else if (modo === 'otro') {
      setForm((f) => ({ ...f, clientName: '', clientCedula: '', clientEmail: '', clientPhone: '', clientAddress: '' }));
    }
  };
  // Lo que no se pudo precargar porque no está en el inventario (se avisa).
  const [noPrecargados, setNoPrecargados] = useState([]);
  // Servicios de la cita que ya están pagados por adelantado (no se cobran ahora).
  const [yaPrepagados, setYaPrepagados] = useState([]);
  // Clave de idempotencia de ESTE cobro: un doble clic no registra dos ventas.
  const claveCobroRef = useRef('');

  useEffect(() => {
    if (!canCreate || !citaObjetivo || citaCargadaRef.current === citaObjetivo) return undefined;
    citaCargadaRef.current = citaObjetivo;
    let vivo = true;
    (async () => {
      try {
        const { data: apt } = await api.get(`/appointments/${citaObjetivo}`);
        const pid = apt.patient?._id || apt.patient;
        // Solo SU paciente, con los datos del comprobante: no hace falta esperar a
        // la lista entera de pacientes para empezar a cobrar.
        const pac = pid
          ? (await api.get(`/patients/${pid}`, { params: { withContact: 1 } }).catch(() => null))?.data || null
          : null;
        if (!vivo) return;
        setCitaPorCobrar(apt);
        setPacienteCita(pac);
        openNew();
        claveCobroRef.current = `cita-${apt._id}-${modoReceta ? 'receta' : 'visita'}-${Date.now()}`;
        const conDatos = !!String(pac?.cedula || '').trim();
        setFacturarA(conDatos ? 'paciente' : 'consumidor');
        setForm((f) => ({
          ...f,
          patient: pid ? String(pid) : '',
          ...(conDatos ? datosDePaciente(pac) : {}),
          appointment: String(apt._id),
          notes: `${compraSinReceta ? 'Compra de productos' : modoReceta ? 'Receta' : 'Cobro'} de la cita del ${String(apt.date || '').slice(0, 10)} ${apt.startTime || ''}${apt.serviceItem?.name ? ` · ${apt.serviceItem.name}` : ''}`,
        }));
      } catch {
        toast.error('No se pudo leer la cita a cobrar');
        if (embebido) onCerrar?.();
      }
    })();
    return () => {
      vivo = false;
      // Si se desmonta antes de terminar (o React repite el efecto), se vuelve a
      // cargar en la siguiente vuelta en vez de quedarse sin cita.
      citaCargadaRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [citaObjetivo]);

  /**
   * LO QUE SE COBRA, PRECARGADO (oct-2026). En la visita: los servicios de la
   * cita (su producto del inventario), con el VALOR ACORDADO como descuento si
   * es menor que la lista, y lo ya ABONADO al agendar como un pago más. En la
   * receta: los productos que recetó el doctor. Todo se puede cambiar antes de
   * cobrar; lo que no está en el inventario se avisa y no se inventa.
   */
  const precargaRef = useRef(false);
  useEffect(() => {
    if (!citaPorCobrar || precargaRef.current || !products.length) return;
    precargaRef.current = true;
    const lineas = [];
    const faltan = [];
    const agregar = (productId, qty, nombre) => {
      const product = products.find((p) => String(p._id) === String(productId));
      if (!product) { if (nombre) faltan.push(nombre); return; }
      const ya = lineas.find((l) => String(l.product) === String(product._id));
      if (ya) { ya.quantity += qty; ya.linked = reescalarVinculados(ya.linked, ya.quantity); return; }
      const lista = priceListOf(product);
      const elegido = activePriceOf(product);
      lineas.push({
        product: product._id,
        productName: product.name,
        category: product.category,
        unlimited: product.unlimited === true,
        quantity: qty,
        unitPrice: elegido.price,
        priceName: elegido.name,
        priceList: lista,
        discountType: product.discountType || '',
        discountValue: Number(product.discountValue) || 0,
        taxRate: product.taxRate,
        taxCategory: product.taxCategory,
        priceIncludesVat: product.priceIncludesVat,
        stock: stockVendible(product),
        composite: esCompuestoFijo(product),
        treatment: '',
        prepaid: false,
        ...extrasDeLinea(product, qty),
      });
    };
    const apt = citaPorCobrar;
    const cubiertos = [];
    if (modoReceta) {
      for (const it of itemsIniciales) {
        if (it.product) agregar(it.product, Number(it.quantity) > 0 ? Number(it.quantity) : 1, it.name);
        else if (it.name) faltan.push(it.name);
      }
    } else {
      /**
       * Lo que el paciente ya dejó PAGADO por adelantado no se vuelve a cobrar: al
       * asignar la atención se gasta una de sus sesiones (`apt.prepago`, del servidor).
       */
      const quedan = new Map((apt.prepago?.cubre || []).map((c) => [String(c.product), { ...c }]));
      // Y lo que esta cita YA pagó con una sesión («Sesión 2 de 5»): tampoco se cobra.
      const usadas = [...(apt.sesiones || [])];
      const servicio = (productId, nombre) => {
        const iu = usadas.findIndex((s) => String(s.product) === String(productId));
        if (iu >= 0) {
          const [s] = usadas.splice(iu, 1);
          cubiertos.push(`${s.productName || nombre} (${s.apartada ? 'sesión apartada' : `sesión ${s.n} de ${s.total}`})`);
          return;
        }
        const c = quedan.get(String(productId));
        if (c && c.quedan > 0) {
          c.quedan -= 1;
          cubiertos.push(`${c.productName || nombre} (le quedan ${c.quedan + 1} de ${c.total})`);
          return;
        }
        agregar(productId, 1, nombre);
      };
      // Lo que va como canje/cortesía por su cuenta (oct-2026) no entra al cobro.
      const svc = apt.serviceItem;
      if (tipoSinCobro(apt, svc)) { /* no se cobra */ }
      else if (svc?.product) servicio(svc.product, svc.name || apt.serviceName);
      else if (svc?.name || apt.serviceName) faltan.push(svc?.name || apt.serviceName);
      for (const extra of apt.additionalServices || []) {
        const si = extra.serviceItem;
        if (tipoSinCobro(apt, si)) continue;
        if (si?.product) servicio(si.product, si.name || extra.name);
        else if (extra.name || si?.name) faltan.push(extra.name || si?.name);
      }
      /**
       * EL VALOR ACORDADO YA NO ES UN DESCUENTO (oct-2026): al cobrar no hay descuentos
       * (los pone el inventario). El cajero ESCOGE el precio de la lista del producto;
       * si alguno coincide con lo acordado, viene ya escogido.
       */
      const acordado = apt.isCanje || apt.isCortesia ? null : apt.agreedValue;
      if (acordado != null && lineas.length === 1 && lineas[0].quantity === 1) {
        const igual = (lineas[0].priceList || []).find((p) => Math.abs(Number(p.price) - Number(acordado)) < 0.005);
        if (igual) { lineas[0].unitPrice = igual.price; lineas[0].priceName = igual.name; }
      }
      // Lo ya abonado al agendar entra como un PAGO de esta venta con su forma;
      // lo que falta, sin método: el cajero escoge con qué lo paga.
      const neto = lineas.reduce((s, l) => s + l.unitPrice * l.quantity - descuentoDeLinea(l), 0);
      if (apt.advancePayment && !apt.isCanje && !apt.isCortesia && neto > 0) {
        const abonado = apt.advancePayment === 'abono'
          ? Math.min(Number(apt.advanceAmount) || 0, neto)
          : neto;
        const FORMA = {
          efectivo: { method: 'efectivo', cardType: '' },
          transferencia: { method: 'transferencia', cardType: '' },
          tarjeta_credito: { method: 'tarjeta', cardType: 'CREDITO' },
          tarjeta_debito: { method: 'tarjeta', cardType: 'DEBITO' },
        }[apt.advanceMethod] || { method: 'efectivo', cardType: '' };
        const fila = (base, amount) => ({
          method: base.method, cardType: base.cardType, amount: +amount.toFixed(2),
          bankAccount: '', creditCard: '', cardPos: '', cardLote: '', cardVoucher: '',
          cardDeferredType: 'CORRIENTE', cardDeferredMonths: 0,
        });
        const resto = +(neto - abonado).toFixed(2);
        if (abonado > 0 && resto > 0.01) {
          setSplitPayments([fila(FORMA, abonado), fila({ method: '', cardType: '' }, resto)]);
          setSplitMode(true);
        } else if (abonado > 0) {
          setForm((f) => ({ ...f, paymentMethod: FORMA.method, cardType: FORMA.cardType }));
        }
      }
    }
    setForm((f) => ({ ...f, items: lineas }));
    setNoPrecargados(faltan);
    setYaPrepagados(cubiertos);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [citaPorCobrar, products]);

  /**
   * SALDO A FAVOR DEL PACIENTE (oct-2026). Si paga MÁS que el total (300 por un
   * servicio de 100 porque sigue un tratamiento), se factura solo lo vendido y el
   * excedente queda a su favor; y lo que ya tiene a favor se puede usar como
   * forma de pago («Saldo a favor»). El paciente de la venta es el de la cita, o
   * el que se eligió en el buscador.
   */
  const pacienteVenta = citaPorCobrar
    ? String(citaPorCobrar.patient?._id || citaPorCobrar.patient || '')
    : String(form.patient || '');

  /**
   * CLIENTE = PACIENTE SI ES LA MISMA PERSONA (nov-2026). Las personas «Cliente» vienen de
   * Contífico y son también pacientes (misma cédula, o RUC = cédula + 001). Si se factura a
   * esa identificación sin haber elegido al paciente —fila «Cliente» del buscador o cédula
   * escrita a mano— la venta se enlaza sola a él (el servidor hace lo mismo al guardar).
   */
  const [enlazadoPorCedula, setEnlazadoPorCedula] = useState('');
  // Cédula con la que se enlazó solo: si luego se cambia la cédula, el enlace se suelta.
  const cedulaEnlazadaRef = useRef('');
  useEffect(() => {
    if (cedulaEnlazadaRef.current && form.patient && String(form.clientCedula) !== cedulaEnlazadaRef.current) {
      cedulaEnlazadaRef.current = '';
      setForm((f) => ({ ...f, patient: '' }));
      setTreatments([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.clientCedula]);
  useEffect(() => {
    // Mientras se escribe en el buscador no se adivina nada: se espera a que elija.
    if (!modalOpen || citaPorCobrar || form.patient || (patientSearch.trim() && !pickedFromList)) return undefined;
    const ids = cedulasCandidatas(form.clientCedula);
    if (!ids.length) return undefined;
    let vivo = true;
    const t = setTimeout(async () => {
      const lista = await api.get('/patients', { params: { search: ids[ids.length - 1], limit: 5, withContact: 1 } })
        .then((r) => r.data?.patients || []).catch(() => []);
      const iguales = lista.filter((p) => ids.includes(String(p.cedula || '').trim()));
      if (!vivo || iguales.length !== 1) return;
      const p = iguales[0];
      setForm((f) => (f.patient || String(f.clientCedula) !== String(form.clientCedula) ? f : { ...f, patient: p._id }));
      cedulaEnlazadaRef.current = String(form.clientCedula);
      setEnlazadoPorCedula(`${p.firstName || ''} ${p.lastName || ''}`.trim());
      api.get('/treatments', { params: { patient: p._id } }).then((r) => vivo && setTreatments(r.data || [])).catch(() => {});
    }, 400);
    return () => { vivo = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.clientCedula, form.patient, modalOpen, citaPorCobrar, pickedFromList]);
  useEffect(() => {
    if (!form.patient) { setEnlazadoPorCedula(''); cedulaEnlazadaRef.current = ''; }
  }, [form.patient]);
  const [saldoAFavor, setSaldoAFavor] = useState(0);
  useEffect(() => {
    if (!modalOpen || !pacienteVenta) { setSaldoAFavor(0); return undefined; }
    let vivo = true;
    api.get(`/patients/${pacienteVenta}/saldo-a-favor`)
      .then((r) => { if (vivo) setSaldoAFavor(Number(r.data?.saldo) || 0); })
      .catch(() => { if (vivo) setSaldoAFavor(0); });
    return () => { vivo = false; };
  }, [modalOpen, pacienteVenta]);
  /**
   * ÍTEMS DEL PACIENTE (oct-2026): lo que compró y dejó en la clínica (ya pagado, no se
   * cobra otra vez) y lo que se llevó siendo ítem vinculado de un servicio. Se ofrece en
   * los vinculados de cada línea; lo que deja guardado en ESTE cobro también cuenta.
   */
  const [itemsPaciente, setItemsPaciente] = useState([]);
  useEffect(() => {
    if (!modalOpen || !pacienteVenta) { setItemsPaciente([]); return undefined; }
    let vivo = true;
    api.get(`/patients/${pacienteVenta}/items`)
      .then((r) => { if (vivo) setItemsPaciente(Array.isArray(r.data) ? r.data : []); })
      .catch(() => { if (vivo) setItemsPaciente([]); });
    return () => { vivo = false; };
  }, [modalOpen, pacienteVenta]);
  const guardados = useMemo(() => {
    const m = new Map();
    const de = (id) => {
      const k = String(id);
      if (!m.has(k)) m.set(k, { enClinica: 0, llevado: 0, ultimaLlevada: null });
      return m.get(k);
    };
    for (const h of itemsPaciente) {
      const g = de(h.product);
      if (h.mode === 'en_clinica') g.enClinica += Number(h.remaining) || 0;
      else {
        g.llevado += Number(h.remaining) || 0;
        if (!g.ultimaLlevada || new Date(h.date) > new Date(g.ultimaLlevada)) g.ultimaLlevada = h.date;
      }
    }
    for (const it of form.items) {
      if (!esServicioLinea(it) && it.delivery === 'en_clinica') de(it.product).enClinica += Number(it.quantity) || 0;
    }
    return m;
  }, [itemsPaciente, form.items]);
  /** Entrega y vinculados de una línea nueva: los marcados «Siempre» vienen escogidos. */
  function extrasDeLinea(product, qty) {
    const linkOptions = opcionesVinculadas(product, products);
    return {
      delivery: 'llevado',
      linkOptions,
      includedMax: product.includedComponents?.enabled ? Number(product.includedComponents.maxQuantity) : null,
      linked: linkOptions.filter((o) => o.preselect).map((o) => ({
        product: o.product, productName: o.productName, code: o.code, base: o.quantity,
        quantity: +(o.quantity * qty).toFixed(4), source: 'inventario', cantAuto: true, fuenteAuto: true,
      })),
    };
  }
  // Si el paciente tiene guardado lo que la línea usa, se toma de lo suyo (el cajero lo puede cambiar).
  useEffect(() => {
    const deLoSuyo = (l) => l.fuenteAuto && l.source === 'inventario' && (guardados.get(String(l.product))?.enClinica || 0) > 0;
    if (!pacienteVenta || !form.items.some((it) => (it.linked || []).some(deLoSuyo))) return;
    setForm((f) => ({
      ...f,
      items: f.items.map((it) => ({ ...it, linked: (it.linked || []).map((l) => (deLoSuyo(l) ? { ...l, source: 'paciente' } : l)) })),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guardados, pacienteVenta]);
  const setLinea = (idx, patch) => setForm((f) => ({ ...f, items: f.items.map((it, i) => (i === idx ? { ...it, ...patch } : it)) }));

  const metodosDePago = saldoAFavor > 0.005
    ? { ...paymentMethods, anticipo: `Saldo a favor ($${saldoAFavor.toFixed(2)})` }
    : paymentMethods;
  /** Usar el saldo a favor: un renglón con lo que alcanza y el resto sin método (lo escoge el cajero). */
  const usarSaldoAFavor = () => {
    const usa = +Math.min(saldoAFavor, total).toFixed(2);
    const resto = +(total - usa).toFixed(2);
    const fila = (method, amount) => ({ method, amount, bankAccount: '', creditCard: '', cardPos: '', cardLote: '', cardVoucher: '', cardDeferredType: 'CORRIENTE', cardDeferredMonths: 0 });
    setSplitPayments(resto > 0.01 ? [fila('anticipo', usa), fila('', resto)] : [fila('anticipo', usa)]);
    setSplitMode(true);
  };

  /** Cerrar el formulario: incrustado, se le avisa a la agenda. */
  const cerrarVenta = () => {
    setModalOpen(false);
    if (embebido) onCerrar?.();
  };

  /**
   * La cita NO se cobra: canje (`isCanje`) o cortesía (`isCortesia`), las dos con valor 0. Se guarda en
   * la cita —con su huella de quién lo decidió— y la agenda sigue a la
   * asignación sin venta ni factura.
   */
  const [sinCobrar, setSinCobrar] = useState(false);
  const marcarSinCobro = async (canje) => {
    if (!citaPorCobrar) return;
    const que = canje ? 'CANJE' : 'CORTESÍA';
    const abono = citaPorCobrar.advancePayment && Number(citaPorCobrar.advanceAmount) > 0
      ? `\n\nOJO: tiene un abono de $${Number(citaPorCobrar.advanceAmount).toFixed(2)} registrado al agendar.`
      : '';
    if (!confirm(`¿Marcar esta cita como ${que}? No se factura y su valor queda en $0.00.${abono}`)) return;
    setSinCobrar(true);
    try {
      await api.patch(`/appointments/${citaPorCobrar._id}/service-value`, { agreedValue: 0, isCanje: !!canje, isCortesia: !canje });
      toast.success(canje ? 'Cita marcada como canje' : 'Cita marcada como cortesía');
      setModalOpen(false);
      onCobrado?.(null);
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo marcar la cita');
    } finally {
      setSinCobrar(false);
    }
  };

  /**
   * UN SERVICIO SIN COBRO (oct-2026): en una visita con varios servicios, el
   * cajero marca aquí cuál es canje o cortesía. Se guarda en la cita y el cobro
   * se vuelve a armar solo con los que se pagan. Si al final ninguno se cobra,
   * la cita entera queda como canje/cortesía (lo decide el servidor).
   */
  const [guardandoSinCobro, setGuardandoSinCobro] = useState(false);
  const cambiarSinCobro = async (lista) => {
    if (!citaPorCobrar) return;
    setGuardandoSinCobro(true);
    try {
      await api.patch(`/appointments/${citaPorCobrar._id}/service-value`, { noChargeServices: lista });
      const { data: fresca } = await api.get(`/appointments/${citaPorCobrar._id}`);
      precargaRef.current = false;
      setCitaPorCobrar(fresca);
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo guardar qué servicio se cobra');
    } finally {
      setGuardandoSinCobro(false);
    }
  };

  /** Suelta el enlace con la cita (el cajero decide registrarla suelta). */
  const soltarCita = () => {
    setForm((f) => ({ ...f, appointment: null }));
    setCitaPorCobrar(null);
  };

  /** Factura a una persona del maestro de Personas (rol CLIENTE): no es un paciente, no lleva ficha. */
  const handleClientSelect = (cli) => {
    cedulaEnlazadaRef.current = '';
    const nombre = cli.razonSocial || cli.nombreComercial || '';
    setForm((f) => ({
      ...f,
      patient: '',
      clientName: nombre,
      clientCedula: cli.ruc || '',
      clientEmail: cli.email || '',
      clientPhone: cli.phone || '',
      clientAddress: cli.address || '',
    }));
    setPatientSearch(`${nombre} - ${cli.ruc || ''}`);
    setPickedFromList(true);
    setTreatments([]);
  };

  const handlePatientSelect = (patientId) => {
    cedulaEnlazadaRef.current = '';
    const patient = patientResults.find((p) => p._id === patientId);
    setPickedFromList(!!patientId);
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

  /**
   * Plazo de la parte a crédito. Se manda `creditDays` (el plazo elegido) y el backend calcula
   * el vencimiento anclado al mediodía local; solo con "Otra fecha…" se manda la fecha.
   */
  const plazoPayload = () => (form.creditTerm === 'CUSTOM'
    ? { dueDate: form.dueDate || null, creditDays: null }
    : { creditDays: form.creditTerm ?? 30, dueDate: null });

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (cajaCerrada) {
      // Puede haberla abierto en otra pestaña con el modal abierto: se vuelve a preguntar.
      const r = await api.get('/puntos-emision/mio').catch(() => null);
      if (r?.data) setMiPunto(r.data);
      if (!r?.data || r.data.cajaAbierta === false) return toast.error(MSG_CAJA_CERRADA, { duration: 7000 });
    }
    if (form.items.length === 0) return toast.error('Agrega al menos un producto');
    if (!previewReady) return toast.error(discountPreview.key === discountKey && discountPreview.error ? discountPreview.error : 'Espera a que se calculen los descuentos');
    if (descuentoCambiado && !String(form.discountReason || '').trim()) {
      return toast.error('Escribe el motivo del descuento aplicado');
    }
    // Ítems vinculados: cantidad válida y, lo del paciente, que le alcance.
    const usoDelPaciente = new Map();
    for (const it of form.items) {
      if (it.includedMax != null) {
        const totalComponentes = (it.linked || []).reduce((n, l) => n + Number(l.quantity || 0), 0);
        if ((it.linked || []).some((l) => !Number.isSafeInteger(Number(l.quantity)) || Number(l.quantity) < 1)) return toast.error(`Las cantidades de componentes de «${it.productName}» deben ser enteros mayores que cero.`);
        if (totalComponentes > it.includedMax * Number(it.quantity)) return toast.error(`«${it.productName}» admite hasta ${it.includedMax} componentes por unidad.`);
      }
      for (const l of it.linked || []) {
        if (!(Number(l.quantity) > 0)) return toast.error(`Escribe cuántos «${l.productName}» se usaron en «${it.productName}» (o quítalo)`);
        if (l.source === 'paciente') usoDelPaciente.set(String(l.product), (usoDelPaciente.get(String(l.product)) || 0) + Number(l.quantity));
      }
    }
    for (const [pid, usa] of usoDelPaciente) {
      const tiene = guardados.get(pid)?.enClinica || 0;
      if (usa > tiene + 1e-9) {
        const nombre = form.items.flatMap((i) => i.linked || []).find((l) => String(l.product) === pid)?.productName || 'un ítem';
        return toast.error(`El paciente tiene ${tiene} de «${nombre}» guardado${tiene === 1 ? '' : 's'}; se están usando ${usa}. Cambia el resto a «${FUENTES_VINCULADO.inventario}».`);
      }
    }
    // Sin identificación no hay venta: la factura y el ATS la exigen. Consumidor Final vale.
    if (!String(form.clientCedula || '').trim()) {
      return toast.error('Falta la cédula / RUC / pasaporte del cliente. Si no lo identificas, usa Consumidor Final (9999999999999).');
    }
    if (form.creditTerm === 'CUSTOM' && !form.dueDate
      && (form.paymentMethod === 'credito' || (splitMode && splitPayments.some((p) => p.method === 'credito')))) {
      return toast.error('Elige la fecha de vencimiento del crédito');
    }
    setSaving(true);
    try {
      // Datos de pago: modo dividido (varios métodos) o método simple.
      let paymentPayload;
      if (splitMode) {
        const rows = splitPayments.filter((p) => (Number(p.amount) || 0) > 0);
        if (!rows.length) { setSaving(false); return toast.error('Agrega al menos un método de pago con monto'); }
        if (splitRemaining > 0.01) {
          setSaving(false);
          return toast.error(`Los pagos ($${splitPaid.toFixed(2)}) no cubren el total ($${total.toFixed(2)}). Falta $${splitRemaining.toFixed(2)}.`);
        }
        // Pago DE MÁS: el excedente queda a favor del paciente (lo valida también el servidor).
        if (splitRemaining < -0.01) {
          if (!pacienteVenta) {
            setSaving(false);
            return toast.error(`Sobran $${(-splitRemaining).toFixed(2)}. Para dejarlo como saldo a favor, elige un paciente.`);
          }
          if (rows.some((p) => p.method === 'credito' || p.method === 'anticipo')) {
            setSaving(false);
            return toast.error('El saldo a favor solo puede salir de dinero que entra (efectivo, transferencia o tarjeta).');
          }
        }
        const usaSaldo = rows.filter((p) => p.method === 'anticipo').reduce((s, p) => s + (Number(p.amount) || 0), 0);
        if (usaSaldo > saldoAFavor + 0.01) {
          setSaving(false);
          return toast.error(`El paciente solo tiene $${saldoAFavor.toFixed(2)} de saldo a favor.`);
        }
        for (const p of rows) {
          if (!p.method) { setSaving(false); return toast.error('Escoge el método de cada pago'); }
          if (p.method === 'transferencia' && payOptions.accounts.length && !p.bankAccount) { setSaving(false); return toast.error('Selecciona la cuenta bancaria en el pago por transferencia'); }
          if (p.method === 'transferencia' && !String(p.reference || '').trim()) { setSaving(false); return toast.error('Ingresa el número de transferencia'); }
          if (p.method === 'tarjeta' && payOptions.cards.length && !p.creditCard) { setSaving(false); return toast.error('Selecciona la tarjeta en el pago con tarjeta'); }
          if (p.method === 'tarjeta' && !String(p.cardLote || '').trim()) { setSaving(false); return toast.error('Ingresa el número de lote del pago con tarjeta'); }
        }
        paymentPayload = {
          payments: rows.map((p) => ({
            method: p.method,
            amount: Number(p.amount) || 0,
            bankAccount: p.method === 'transferencia' ? p.bankAccount || null : null,
            reference: p.method === 'transferencia' ? String(p.reference || '').trim() : '',
            creditCard: p.method === 'tarjeta' ? p.creditCard || null : null,
            cardType: p.method === 'tarjeta' ? p.cardType || '' : '',
            cardPos: p.method === 'tarjeta' ? p.cardPos || '' : '',
            cardLote: p.method === 'tarjeta' ? p.cardLote || '' : '',
            cardVoucher: p.method === 'tarjeta' ? p.cardVoucher || '' : '',
            cardDeferredType: p.method === 'tarjeta' && p.cardType === 'CREDITO' ? p.cardDeferredType || 'CORRIENTE' : 'CORRIENTE',
            cardDeferredMonths: p.method === 'tarjeta' && p.cardType === 'CREDITO' && p.cardDeferredType && p.cardDeferredType !== 'CORRIENTE' ? p.cardDeferredMonths || 0 : 0,
          })),
          ...plazoPayload(),
        };
      } else {
        if (!form.paymentMethod && total > 0.005) {
          setSaving(false);
          return toast.error('Escoge la forma de pago');
        }
        if (form.paymentMethod === 'transferencia' && payOptions.accounts.length && !form.bankAccount) {
          setSaving(false);
          return toast.error('Selecciona la cuenta bancaria de destino');
        }
        if (form.paymentMethod === 'transferencia' && !String(form.transferRef || '').trim()) {
          setSaving(false);
          return toast.error('Ingresa el número de transferencia');
        }
        if (form.paymentMethod === 'tarjeta' && payOptions.cards.length && !form.creditCard) {
          setSaving(false);
          return toast.error('Selecciona la tarjeta / POS');
        }
        if (form.paymentMethod === 'tarjeta' && !String(form.cardLote || '').trim()) {
          setSaving(false);
          return toast.error('Ingresa el número de lote');
        }
        if (form.paymentMethod === 'anticipo' && total > saldoAFavor + 0.01) {
          setSaving(false);
          return toast.error(`El saldo a favor ($${saldoAFavor.toFixed(2)}) no alcanza: usa «Usar saldo a favor» para completar con otro método.`);
        }
        if (recibidoNum !== null) {
          if (!Number.isFinite(recibidoNum) || recibidoDif < -0.01) {
            setSaving(false);
            return toast.error(`Lo recibido no cubre el total ($${total.toFixed(2)}). Corrige el monto o usa «Agregar otro método de pago».`);
          }
          if (recibidoDif > 0.01 && !pacienteVenta) {
            setSaving(false);
            return toast.error(`Sobran $${recibidoDif.toFixed(2)}. Para dejarlo como saldo a favor, elige un paciente.`);
          }
        }
        paymentPayload = {
          // Entregó de más: un solo pago por lo RECIBIDO; el servidor factura el
          // total y deja el excedente como saldo a favor del paciente.
          ...(recibidoDif > 0.01
            ? {
                payments: [{
                  method: form.paymentMethod,
                  amount: +recibidoNum.toFixed(2),
                  bankAccount: form.paymentMethod === 'transferencia' ? form.bankAccount || null : null,
                  reference: form.paymentMethod === 'transferencia' ? String(form.transferRef || '').trim() : '',
                  creditCard: form.paymentMethod === 'tarjeta' ? form.creditCard || null : null,
                  cardType: form.paymentMethod === 'tarjeta' ? form.cardType || '' : '',
                  cardPos: form.paymentMethod === 'tarjeta' ? form.cardPos || '' : '',
                  cardLote: form.paymentMethod === 'tarjeta' ? form.cardLote || '' : '',
                  cardVoucher: form.paymentMethod === 'tarjeta' ? form.cardVoucher || '' : '',
                  cardDeferredType: form.paymentMethod === 'tarjeta' && form.cardType === 'CREDITO' ? form.cardDeferredType || 'CORRIENTE' : 'CORRIENTE',
                  cardDeferredMonths: form.paymentMethod === 'tarjeta' && form.cardType === 'CREDITO' && form.cardDeferredType && form.cardDeferredType !== 'CORRIENTE' ? form.cardDeferredMonths || 0 : 0,
                }],
              }
            : {}),
          bankAccount: form.paymentMethod === 'transferencia' ? form.bankAccount || null : null,
          reference: form.paymentMethod === 'transferencia' ? String(form.transferRef || '').trim() : '',
          creditCard: form.paymentMethod === 'tarjeta' ? form.creditCard || null : null,
          cardType: form.paymentMethod === 'tarjeta' ? form.cardType || '' : '',
          cardPos: form.paymentMethod === 'tarjeta' ? form.cardPos || '' : '',
          cardLote: form.paymentMethod === 'tarjeta' ? form.cardLote || '' : '',
          cardVoucher: form.paymentMethod === 'tarjeta' ? form.cardVoucher || '' : '',
          cardDeferredType: form.paymentMethod === 'tarjeta' && form.cardType === 'CREDITO' ? form.cardDeferredType || 'CORRIENTE' : 'CORRIENTE',
          cardDeferredMonths: form.paymentMethod === 'tarjeta' && form.cardType === 'CREDITO' && form.cardDeferredType && form.cardDeferredType !== 'CORRIENTE' ? form.cardDeferredMonths || 0 : 0,
          ...plazoPayload(),
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
        discountPreview: discountPreview.items.map((item) => item.discount),
        items: form.items.map((i) => ({
          product: i.product,
          quantity: i.quantity,
          // Precio elegido de la lista del producto. El backend lo valida contra esa lista
          // (`priceName` manda; el importe es solo respaldo para clientes antiguos).
          priceName: i.priceName || undefined,
          unitPrice: i.unitPrice,
          // Descuento en $: solo si el cajero lo cambió; si no, el servidor pone el del producto.
          discount: i.manualDiscount !== undefined && i.manualDiscount !== null && i.manualDiscount !== ''
            ? descuentoDeLinea(i) : undefined,
          treatment: i.treatment || null,
          prepaid: !!i.prepaid && esServicioLinea(i) && !!pacienteVenta,
          // ¿Se lo lleva o lo deja para aplicárselo aquí? (solo físicos de un paciente)
          // Se lo lleva / se lo aplica aquí (ambos salen hoy) / lo deja en la clínica (sale al aplicarlo).
          // De lo que deja en la clínica, cuánto se aplica hoy (sale del inventario hoy).
          appliedNow: !esServicioLinea(i) && pacienteVenta && i.delivery === 'en_clinica' ? (Number(i.appliedNow) || 0) : undefined,
          delivery: esServicioLinea(i) ? undefined
            : (pacienteVenta ? (i.delivery || 'llevado') : (i.delivery === 'aplicado' ? 'aplicado' : undefined)),
          // Solo los componentes elegidos por categoría. Los ítems vinculados del producto
          // los pone el servidor solo (no suman al precio y salen del inventario).
          linkedItems: (i.includedMax != null ? (i.linked || []) : [])
            .filter((l) => Number(l.quantity) > 0)
            .map((l) => ({ product: l.product, quantity: Number(l.quantity), source: l.source || 'inventario' })),
        })),
        ...extra,
        // Cobrando una cita: la venta es SIEMPRE de su paciente (aunque se le
        // facture a otra persona) y un doble clic no registra dos ventas.
        ...(citaPorCobrar && form.appointment
          ? {
              patient: String(citaPorCobrar.patient?._id || citaPorCobrar.patient || '') || null,
              idempotencyKey: claveCobroRef.current || undefined,
            }
          : {}),
      });
      toast.success(
        extra.costCenterConfirmed
          ? 'Venta registrada con el centro de costo elegido (diferencia auditada)'
          : form.appointment
            ? 'Venta registrada y enlazada a la cita'
            : 'Venta registrada'
      );
      if (Number(res.data?.advanceCreated) > 0.005) {
        toast.success(`Quedan $${Number(res.data.advanceCreated).toFixed(2)} a favor del paciente para sus próximas ventas.`, { duration: 7000 });
      }
      // Avisos no bloqueantes (p.ej. servicios sin categoría: su ingreso fue a la cuenta genérica).
      for (const w of (res.data?.warnings || [])) toast(w, { icon: '⚠️', duration: 7000 });
      setCcMismatch(null);
      setModalOpen(false);
      fetchSales();
      fetchProducts();
      // Factura electrónica desde el punto de venta de quien cobra (no bloquea la venta:
      // si falla, la venta queda registrada y se puede facturar luego).
      if (facturarAlGuardar && puedeFacturarAqui && res.data?._id) emitirFactura(res.data);
      // Incrustada en la agenda: la agenda sigue (asignar doctor/enfermero).
      if (embebido) onCobrado?.(res.data);
    } catch (err) {
      const data = err.response?.data;
      if (data?.code === 'DISCOUNT_CHANGED') {
        setDiscountPreview({ key: '', items: [], error: '' });
        setDiscountRefresh((n) => n + 1);
      }
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

  const submitAnularFactura = async () => {
    if (!motivoAnulacion || motivoAnulacion.trim().length < 10) {
      toast.error('El motivo debe tener al menos 10 caracteres');
      return;
    }
    setAnulando(true);
    try {
      const res = await api.post(`/invoices/${anularFactura.invoice._id}/anular`, { motivo: motivoAnulacion.trim(), anularVenta: true });
      toast.success(res.data?.saleReversed ? 'Factura y venta anuladas' : 'Factura anulada');
      setAnularFactura(null);
      setMotivoAnulacion('');
      fetchSales();
      fetchProducts();
    } catch (err) {
      toast.error(err.response?.data?.error || err.response?.data?.message || 'Error al anular');
    } finally {
      setAnulando(false);
    }
  };

  const cancelSale = async (sale) => {
    // Factura AUTORIZADA: se anula la factura (y con ella la venta), pidiendo el motivo.
    if (sale.invoice && sale.invoice.estado === 'AUTORIZADO') {
      setMotivoAnulacion('');
      setAnularFactura(sale);
      return;
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
    // Una factura NO AUTORIZADA no vale: la venta se puede facturar de nuevo (otro número).
    if (sale.invoice && sale.invoice.estado !== 'NO_AUTORIZADO') return toast.error('Esta venta ya tiene factura asociada');
    if (!puedeFacturarAqui) {
      return toast.error('No tienes un punto de emisión asignado en esta sucursal. Pide al administrador que te asigne uno en Configuración SRI.');
    }
    if (cajaCerrada) return toast.error(MSG_CAJA_CERRADA, { duration: 7000 });
    const conSerie = serieTexto ? ` con la serie ${serieTexto}` : '';
    if (!window.confirm(`¿Emitir factura electrónica para la venta ${sale.saleNumber}${conSerie}?`)) return;
    emitirFactura(sale);
  };

  const verFacturaPdf = async (invoiceId) => {
    try {
      const res = await api.get(`/invoices/${invoiceId}/pdf`, { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
      window.open(url, '_blank');
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo abrir el PDF de la factura');
    }
  };

  const emitirFactura = async (sale) => {
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
      // Con el MOTIVO (oct-2026): un «Error al emitir factura» a secas no decía qué
      // falló (era la firma electrónica); el servidor lo manda en `error`.
      const d = err.response?.data;
      const motivo = d?.error && d?.message ? `${d.message}: ${d.error}` : d?.message;
      toast.error(motivo || 'Error al facturar', { duration: 10000 });
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

  /**
   * COBRO DE LA CxC. Se registra como un COBRO normal (documento CB-####) en vez del atajo
   * anterior: aquel solo dejaba el asiento, así que el cobro no aparecía en la pantalla de
   * Cobros, no se podía anular desde ahí y no tenía comprobante. Es el mismo asiento y la
   * misma cartera; lo que cambia es que ahora queda el documento.
   */
  const openCollect = (s) => {
    setCollectItem(s);
    setCollectForm({
      date: new Date().toISOString().slice(0, 10),
      amount: +(Number(s.balance) || 0).toFixed(2),
      method: 'EFECTIVO',
      bankAccount: '',
      reference: '',
    });
    setCollectIntent(newIdempotencyKey());
  };

  const submitCollect = async (e) => {
    e.preventDefault();
    if (collectBusy || !collectItem) return;
    const amount = Number(collectForm.amount) || 0;
    if (amount <= 0) return toast.error('Monto inválido');
    if (amount > Number(collectItem.balance || 0) + 0.01) return toast.error(`El monto excede el saldo ($${Number(collectItem.balance || 0).toFixed(2)})`);
    if (!['EFECTIVO', 'TARJETA'].includes(collectForm.method) && !collectForm.bankAccount) return toast.error('Selecciona la cuenta bancaria');
    setCollectBusy(true);
    try {
      const payload = {
        type: 'COBRO',
        date: collectForm.date,
        partyModel: 'Patient',
        partyRef: collectItem.patient?._id || collectItem.patient || null,
        partyName: collectItem.clientName || '',
        partyId: collectItem.clientCedula || '',
        method: collectForm.method,
        bankAccount: ['EFECTIVO', 'TARJETA'].includes(collectForm.method) ? null : collectForm.bankAccount,
        reference: collectForm.reference,
        applications: [{ docModel: 'Sale', docRef: collectItem._id, amount }],
        advanceAmount: 0,
        description: `Cobro venta ${collectItem.saleNumber || ''}`.trim(),
      };
      const huella = [payload.method, payload.bankAccount, payload.date, collectItem._id, amount];
      await api.post('/payments', payload, withIdempotencyKey(intentKey(collectIntent, huella)));
      toast.success('Cobro registrado');
      setCollectItem(null);
      fetchSales();
    } catch (err) { toast.error(err.response?.data?.message || 'Error'); }
    finally { setCollectBusy(false); }
  };

  /**
   * LOS MODALES DE LA VENTA, aparte del resto de la página: la agenda los usa
   * INCRUSTADOS (`embebido`) para cobrar una cita sin salir de ella — el mismo
   * formulario, la misma contabilidad (ver Appointments → CobrarCitaModal).
   */
  const modalesDeVenta = (
    <>
        <Modal
          isOpen={modalOpen}
          onClose={cerrarVenta}
          title={embebido ? (compraSinReceta ? 'Registrar compra de productos' : modoReceta ? 'Cobrar la receta' : 'Cobrar la cita') : 'Nueva Venta'}
          size="xl"
        >
          {/* El modal está ordenado por SECCIONES, en el orden en que se cobra: quién es el
              cliente → de dónde sale la mercadería → qué se lleva → cómo paga. El aviso de
              consumidor final va arriba del todo porque condiciona la factura entera. */}
          {citaPorCobrar && (
            <div className="mb-4 flex items-start justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50/70 p-3">
              <p className="text-xs text-emerald-900 m-0">
                {compraSinReceta ? 'Registrando productos comprados en la cita del ' : modoReceta ? 'Cobrando la receta de la cita del ' : 'Cobrando la cita del '}
                <b>{String(citaPorCobrar.date || '').slice(0, 10)} {citaPorCobrar.startTime || ''}</b>
                {citaPorCobrar.serviceItem?.name ? ` · ${citaPorCobrar.serviceItem.name}` : ''}.
                {!modoReceta && (
                  <>
                    {' '}Abonado al reservar: <b>${Number(citaPorCobrar.advanceAmount || 0).toFixed(2)}</b>
                    {citaPorCobrar.agreedValue != null
                      ? <> de <b>${Number(citaPorCobrar.agreedValue).toFixed(2)}</b> acordados</>
                      : ''}.
                  </>
                )}
                {' '}La venta queda <b>enlazada a la cita</b>
                {!modoReceta && citaPorCobrar.advancePayment ? ' y lo ya abonado entra como un pago (revisa a qué cuenta llegó)' : ''}.
              </p>
              {!embebido && (
                <button
                  type="button"
                  onClick={soltarCita}
                  className="shrink-0 text-xs text-slate-500 underline bg-transparent border-none cursor-pointer hover:text-rose-600"
                >
                  Quitar
                </button>
              )}
            </div>
          )}
          {/**
            * CANJE O CORTESÍA EN EL MISMO COBRO (oct-2026). Con la factura desde
            * la agenda, la cita que no se cobra en dinero se marca aquí: canje
            * (`isCanje`, valor 0) o cortesía (`isCortesia`, valor 0). No se factura nada y se
            * sigue directo a asignar doctor/enfermero.
            */}
          {embebido && !modoReceta && citaPorCobrar && !citaPorCobrar.isCanje && !citaPorCobrar.isCortesia && citaPorCobrar.agreedValue !== 0 && (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-violet-200 bg-violet-50 p-3">
              <p className="m-0 text-xs text-violet-900">
                ¿Esta cita <b>no se cobra</b>? Márcala como canje o cortesía: no se factura y pasa directo a la asignación.
              </p>
              <div className="flex gap-2">
                <button type="button" disabled={sinCobrar} onClick={() => marcarSinCobro(true)} className="btn-secondary text-xs">
                  Es canje
                </button>
                <button type="button" disabled={sinCobrar} onClick={() => marcarSinCobro(false)} className="btn-secondary text-xs">
                  Es cortesía
                </button>
              </div>
              {/* Con varios servicios: canje/cortesía de UNO solo y se cobra el resto. */}
              {serviciosDeLaCita(citaPorCobrar).length > 1 && (
                <ServiciosSinCobro
                  className="w-full mt-1"
                  servicios={serviciosDeLaCita(citaPorCobrar)}
                  value={listaSinCobro(citaPorCobrar)}
                  onChange={cambiarSinCobro}
                  disabled={guardandoSinCobro || sinCobrar}
                />
              )}
            </div>
          )}
          {/* CANJE o valor cero: no hay dinero que cobrar; se sigue a la asignación. */}
          {embebido && !modoReceta && citaPorCobrar && (citaPorCobrar.isCanje || citaPorCobrar.isCortesia || citaPorCobrar.agreedValue === 0) && (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-sky-200 bg-sky-50 p-3">
              <p className="m-0 text-xs text-sky-900">
                {citaPorCobrar.isCanje ? 'Esta cita es un CANJE: no se cobra en dinero.' : citaPorCobrar.isCortesia ? 'Esta cita es una CORTESÍA: no se cobra.' : 'Esta cita tiene valor $0.00: no hay nada que cobrar.'}
              </p>
              <button
                type="button"
                onClick={() => { setModalOpen(false); onCobrado?.(null); }}
                className="btn-secondary text-xs"
              >
                Continuar sin cobrar
              </button>
            </div>
          )}
          {noPrecargados.length > 0 && (
            <p className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 m-0">
              No están en el inventario y no se precargaron: <b>{noPrecargados.join(', ')}</b>. Si se cobran, agrégalos abajo con su producto.
            </p>
          )}
          {/* SESIONES PREPAGADAS: lo que el paciente ya pagó por adelantado no se cobra otra vez. */}
          {yaPrepagados.length > 0 && (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-indigo-200 bg-indigo-50 p-3">
              <p className="m-0 text-xs text-indigo-900">
                Ya pagado por adelantado: <b>{yaPrepagados.join(', ')}</b>. No se cobra otra vez: se paga con sus sesiones prepagadas.
              </p>
              {embebido && form.items.length === 0 && (
                <button
                  type="button"
                  onClick={() => { setModalOpen(false); onCobrado?.(null); }}
                  className="btn-secondary text-xs"
                >
                  Continuar a la asignación
                </button>
              )}
            </div>
          )}
          <form onSubmit={handleSubmit} onKeyDown={enterNoEnvia} className="space-y-4">
            <ConsumidorFinalAlert cedula={form.clientCedula} />

            {/* A NOMBRE DE QUIÉN SE FACTURA (cobro de una cita). */}
            {citaPorCobrar && (
              <div className="flex flex-wrap gap-2">
                {[
                  ['paciente', 'Datos del paciente', !pacienteCita?.cedula],
                  ['consumidor', 'Consumidor final', false],
                  ['otro', 'A otra persona', false],
                ].map(([k, label, deshabilitado]) => (
                  <button
                    key={k}
                    type="button"
                    disabled={deshabilitado}
                    title={deshabilitado ? 'El paciente no tiene cédula registrada' : undefined}
                    onClick={() => elegirFacturarA(k)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-semibold border cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                      facturarA === k
                        ? 'bg-emerald-600 text-white border-emerald-600'
                        : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    {label}
                  </button>
                ))}
                {facturarA === 'otro' && (
                  <span className="text-[11px] text-slate-500 self-center">
                    Búscala abajo o escribe sus datos. La venta sigue siendo del paciente de la cita.
                  </span>
                )}
              </div>
            )}

            <FormSection title="Datos del cliente" icon={HiOutlineUser}>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="sm:col-span-3 relative">
                <label className="lbl">Buscar cliente registrado (opcional)</label>
                <input
                  type="text"
                  value={patientSearch}
                  onChange={(e) => onClientSearch(e.target.value)}
                  placeholder="Escribe nombre, cédula o RUC..."
                  className="input"
                />
                {/* Busca en los DOS maestros: pacientes de la clínica y personas registradas como
                    CLIENTE en Personas (proveedores/clientes). Antes solo miraba pacientes. */}
                {patientSearch.trim().length >= 2 && !pickedFromList && (() => {
                  // La búsqueda la hace el servidor sobre TODOS los pacientes, por palabras
                  // sueltas y sin tildes (utils/nameSearch), igual que la agenda.
                  const pac = patientResults;
                  return (
                    <div className="absolute z-10 left-0 right-0 mt-1 max-h-56 overflow-y-auto bg-white border border-emerald-100 rounded-xl shadow-lg">
                      {pac.map((p) => (
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
                          <span className="ml-2 text-[10px] uppercase text-emerald-600">Paciente</span>
                        </button>
                      ))}
                      {clientResults.map((c) => (
                        <button
                          type="button"
                          key={c._id}
                          onClick={() => handleClientSelect(c)}
                          className="w-full text-left px-4 py-2 text-sm hover:bg-sky-50 cursor-pointer bg-white border-none border-b border-emerald-50"
                        >
                          <span className="font-medium text-slate-800">{c.razonSocial || c.nombreComercial}</span>
                          <span className="text-slate-400 ml-2">{c.ruc}</span>
                          <span className="ml-2 text-[10px] uppercase text-sky-600">Cliente</span>
                        </button>
                      ))}
                      {buscandoCliente && !pac.length && !clientResults.length && (
                        <p className="px-4 py-2 text-xs text-slate-400">Buscando…</p>
                      )}
                      {!buscandoCliente && !pac.length && !clientResults.length && (
                        <p className="px-4 py-2 text-xs text-slate-400">
                          Sin coincidencias. Se buscó entre los pacientes y entre las personas registradas como cliente.
                        </p>
                      )}
                    </div>
                  );
                })()}
                {/* También tras elegir una PERSONA (que no deja `patient`): sin esto no había
                    forma de volver a Consumidor Final salvo reabrir el modal. */}
                {(form.patient || pickedFromList) && (
                  <button
                    type="button"
                    onClick={() => { setClientResults([]); handlePatientSelect(''); }}
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
                <label className="lbl">Cédula / RUC / Pasaporte <span className="text-rose-500">*</span></label>
                {/* Obligatoria: sin identificación la venta no se puede facturar ni declarar (ATS).
                    Si no se identifica al comprador, va Consumidor Final (9999999999999). */}
                <input
                  value={form.clientCedula}
                  onChange={(e) => setForm({ ...form, clientCedula: e.target.value })}
                  className="input"
                  required
                  minLength={5}
                  maxLength={20}
                  placeholder="Cédula, RUC o pasaporte"
                />
                <SriStatus status={cedulaLookup} />
                {enlazadoPorCedula && !citaPorCobrar && (
                  <p className="text-[11px] text-emerald-700 mt-1">
                    Es el paciente <b>{enlazadoPorCedula}</b>: la venta queda en su historia.
                  </p>
                )}
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
                        Zona fuera del listado: se guarda tal como la escribiste.
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
                <label className="lbl">{embebido ? 'Compra recomendada por' : 'Recomendado por (comisión)'}</label>
                <SearchableSelect
                  options={soloUsuariosActivos(staff, form.recommendedBy)}
                  value={form.recommendedBy || ''}
                  onChange={(v) => setForm((f) => ({ ...f, recommendedBy: v || '' }))}
                  getLabel={(u) => `${u.name}${u.role ? ` · ${ROLE_LABELS[u.role] || u.role}` : ''}`}
                  getSearchText={(u) => `${u.name || ''} ${ROLE_LABELS[u.role] || u.role || ''}`}
                  placeholder="— Nadie / No aplica —"
                  searchPlaceholder="Buscar usuario por nombre o cargo…"
                  allowClear
                />
                <p className="text-[11px] text-slate-500 mt-1">
                  {embebido
                    ? 'Usuario que recomendó la compra; quien registra el cobro queda identificado por separado.'
                    : 'Usuario al que se atribuye la venta para su comisión.'}
                </p>
              </div>
            </div>
            </FormSection>

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
                      setCurrentItem({ ...currentItem, product: p?._id || '', priceIndex: undefined })
                    }
                    // ENTER escoge y agrega directo (sin el botón «Agregar»); las flechas
                    // recorren las opciones.
                    onEnter={(p) => addItem(p)}
                    placeholder="Buscar producto o servicio... (↓ ↑ y Enter para agregar)"
                    filter={soloActivos}
                  />
                </div>
                {/* Lista de precios del producto elegido. Solo aparece si tiene más de uno: con un
                    único precio el desplegable sería ruido. Por defecto viene marcado el activo. */}
                {(() => {
                  const prod = products.find((p) => p._id === currentItem.product);
                  const lista = prod ? priceListOf(prod) : [];
                  if (lista.length < 2) return null;
                  const sel = currentItem.priceIndex ?? Math.max(0, lista.findIndex((p) => p.active));
                  return (
                    <div className="basis-full sm:basis-auto sm:w-52 shrink-0">
                      <label className="block text-[11px] font-semibold text-slate-500 mb-1">Precio</label>
                      <select
                        value={sel}
                        onChange={(e) => setCurrentItem({ ...currentItem, priceIndex: Number(e.target.value) })}
                        className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white outline-none"
                      >
                        {lista.map((p, i) => (
                          <option key={i} value={i}>
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
                    // Enter en la cantidad agrega el producto escogido.
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addItem(); } }}
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
                      <th className="text-right py-2">Descuento $</th>
                      {form.patient && treatments.length > 0 && (
                        <th className="text-left py-2 pl-2">Tratamiento</th>
                      )}
                      <th className="text-right py-2">Subtotal</th>
                      <th className="text-right py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {lineasVenta.map((item, idx) => (
                      <tr key={idx} className="border-b border-slate-100">
                        <td className="py-2 text-slate-800">
                          {item.productName}
                          {/* PARA CITAS FUTURAS (oct-2026): un servicio que el paciente deja
                              pagado queda como sesiones a su favor; al asignar la atención de
                              la próxima cita se gasta una («Sesión 2 de 5») y no se cobra otra vez. */}
                          {/* Nov-2026: las opciones de la línea salen SIEMPRE, igual que al cobrar una
                              cita. Necesitan un paciente (son sesiones y productos a su nombre): sin
                              él se ven desactivadas y dicen cómo habilitarlas. */}
                          {(() => {
                            const paq = products.find((p) => String(p._id) === String(item.product))?.packageSessions || [];
                            if (!esServicioLinea(item) || !paq.length) return null;
                            const nombreDe = (id) => products.find((p) => String(p._id) === String(id?._id || id))?.name || 'servicio';
                            return (
                              <span className={`mt-1 block text-[11px] ${pacienteVenta ? 'text-indigo-700' : 'text-slate-400'}`}>
                                Paquete: {paq.map((x) => `${Number(x.quantity) * Number(item.quantity || 1)} × ${nombreDe(x.product)}`).join(', ')}.
                                {pacienteVenta ? ' La cita de hoy usa una; las demás quedan a su favor.' : ' Elige al paciente en el buscador para dejarle las sesiones.'}
                              </span>
                            );
                          })()}
                          {esServicioLinea(item) && (!citaPorCobrar || !modoReceta)
                            && !(products.find((p) => String(p._id) === String(item.product))?.packageSessions || []).length && (
                            <label className={`mt-1 flex items-start gap-1.5 text-[11px] ${pacienteVenta ? 'text-indigo-700 cursor-pointer' : 'text-slate-400 cursor-not-allowed'}`}
                              title={pacienteVenta ? '' : 'Elige al paciente en el buscador de cliente para dejarle sesiones a su favor'}>
                              <input
                                type="checkbox"
                                disabled={!pacienteVenta}
                                checked={!!item.prepaid && !!pacienteVenta}
                                onChange={(e) => {
                                  const items = [...form.items];
                                  items[idx] = { ...items[idx], prepaid: e.target.checked };
                                  setForm({ ...form, items });
                                }}
                                className="w-3.5 h-3.5 mt-px accent-indigo-600 cursor-pointer"
                              />
                              <span>
                                Para citas futuras
                                {item.prepaid && (citaPorCobrar && !modoReceta
                                  ? (sesionesFuturas(item) > 0
                                    ? ` · ${usoEnCita.get(String(item.product)) ? `esta cita es 1 de ${item.quantity}, ` : ''}quedan ${sesionesFuturas(item)} a su favor`
                                    : ' · sube la cantidad: hoy se usa la que hay')
                                  : ` · quedan ${item.quantity} a su favor`)}
                                {!pacienteVenta && ' · elige al paciente en el buscador para usarlo'}
                              </span>
                            </label>
                          )}
                          {/* ENTREGA (nov-2026), también para los COMPUESTOS:
                              · Se lo lleva / Se lo aplica aquí → sale del inventario hoy.
                              · Lo compra y lo deja en la clínica → se factura, NO sale hoy: queda a
                                su nombre y sale (o salen sus componentes) el día que se le aplica. */}
                          {item.composite && (
                            <span className="mt-1 block text-[11px] text-slate-500">
                              {(pacienteVenta && item.delivery === 'en_clinica') ? 'Al aplicárselo saldrá' : 'Sale del inventario'}: {(products.find((p) => String(p._id) === String(item.product))?.composition || [])
                                .map((c) => `${+(c.quantity * item.quantity).toFixed(4)} × ${c.productName}`).join(', ')}
                            </span>
                          )}
                          {!esServicioLinea(item) && (
                            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                              <select
                                value={!pacienteVenta && item.delivery === 'en_clinica' ? 'llevado' : (item.delivery || 'llevado')}
                                onChange={(e) => setLinea(idx, { delivery: e.target.value })}
                                className="input-sm w-auto"
                                title="¿Qué hace con lo que compra?"
                              >
                                <option value="llevado">Se lo lleva</option>
                                <option value="aplicado">Se lo aplica aquí (hoy)</option>
                                <option value="en_clinica" disabled={!pacienteVenta}>
                                  Lo compra y lo deja en la clínica{pacienteVenta ? '' : ' (elige al paciente)'}
                                </option>
                              </select>
                              {pacienteVenta && item.delivery === 'en_clinica' && (() => {
                                const u = unidadGuardable(products.find((p) => String(p._id) === String(item.product)));
                                const total = +(u.factor * Number(item.quantity || 0)).toFixed(4);
                                return (
                                  <span className="flex flex-wrap items-center gap-1.5 text-amber-700">
                                    <span>Hoy se aplica</span>
                                    <NumericInput
                                      value={item.appliedNow ?? 0}
                                      onChange={(e) => {
                                        const n = Math.min(Math.max(0, Number(String(e.target.value).replace(',', '.')) || 0), total);
                                        setLinea(idx, { appliedNow: n });
                                      }}
                                      className="w-14 px-1 py-0.5 border border-amber-300 rounded text-right text-xs bg-white"
                                      title="Cuántas se aplican hoy (salen del inventario hoy)"
                                    />
                                    <span>de {total} {u.nombre}. El resto queda a su nombre y sale del inventario cuando se le aplique.</span>
                                  </span>
                                );
                              })()}
                              {!pacienteVenta && (
                                <span className="text-slate-400">Para dejarlo guardado en la clínica, elige al paciente en el buscador.</span>
                              )}
                            </div>
                          )}
                          <ItemsVinculadosCobro
                            item={item}
                            guardados={guardados}
                            hayPaciente={!!pacienteVenta}
                            onChange={(linked) => setLinea(idx, { linked })}
                          />
                        </td>
                        {/* El precio también se puede cambiar DESPUÉS de agregar la línea: es
                            habitual darse cuenta al final de que va a precio corporativo. Solo
                            se ofrecen los precios de la lista del producto (el backend los valida). */}
                        <td className="py-2 text-right">
                          {(item.priceList || []).length > 1 ? (
                            <select
                              value={Math.max(0, item.priceList.findIndex((p) => p.name === item.priceName && p.price === item.unitPrice))}
                              onChange={(e) => {
                                const elegido = item.priceList[Number(e.target.value)];
                                if (!elegido) return;
                                const items = [...form.items];
                                items[idx] = { ...items[idx], priceName: elegido.name, unitPrice: elegido.price };
                                setForm({ ...form, items });
                              }}
                              title="Precio de la lista del producto"
                              className="px-2 py-1 border border-slate-300 rounded text-sm bg-white outline-none text-right"
                            >
                              {item.priceList.map((p, i) => (
                                <option key={i} value={i}>{p.name} — ${Number(p.price).toFixed(2)}</option>
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
                        {/* Viene el descuento del producto (inventario); el cajero lo puede cambiar
                            y entonces tiene que escribir el motivo abajo. */}
                        <td className="py-2 text-right">
                          <NumericInput
                            value={item.manualDiscount ?? (item.automaticDiscount || '')}
                            onChange={(e) => setLinea(idx, { manualDiscount: e.target.value })}
                            title="Descuento de la línea en dólares"
                            placeholder="0.00"
                            className="w-20 px-2 py-1 border border-slate-300 rounded text-right text-sm text-rose-600 outline-none"
                          />
                          {item.discountType === 'percentage' && descuentoDelProducto(item) > 0 && (
                            <span className="block text-[10px] text-slate-400">Producto: {Number(item.discountValue)}%</span>
                          )}
                          {item.appliedDiscounts?.map((d) => <span key={d.id} className="block text-[10px] text-emerald-700">{d.name}: -${Number(d.amount).toFixed(2)}</span>)}
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
                          ${(item.unitPrice * item.quantity - descuentoDeLinea(item)).toFixed(2)}
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
                {ivaTotal > 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-500">IVA (base gravada ${baseGravada.toFixed(2)}):</span>
                    <span className="font-medium">${ivaTotal.toFixed(2)}</span>
                  </div>
                )}
                <div className="flex justify-between text-base font-bold border-t border-emerald-200 pt-2">
                  <span>Total:</span>
                  <span className="text-emerald-700">${total.toFixed(2)}</span>
                </div>
              </div>
            )}

            {/* MOTIVO DEL DESCUENTO (29-10-2026): uno por cobro, no por línea. Obligatorio si
                el cajero cambió el descuento que trae el producto; sirve para cualquier comentario. */}
            {form.items.length > 0 && discountTotal > 0 && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Motivo del descuento / comentario{descuentoCambiado && <span className="text-rose-600"> *</span>}
                </label>
                <textarea
                  value={form.discountReason || ''}
                  onChange={(e) => setForm((f) => ({ ...f, discountReason: e.target.value }))}
                  rows={2}
                  maxLength={1000}
                  placeholder="¿Por qué se aplicó el descuento? Cualquier otro comentario del cobro."
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-emerald-400"
                />
              </div>
            )}
            </FormSection>

            {/* ── Método(s) de pago y todas sus subopciones ────────────────────────────── */}
            <FormSection title="Método de pago" icon={HiOutlineBanknotes} tone="destacado">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {!splitMode && (
                  <div>
                    <label className="lbl">Forma de pago *</label>
                    <select
                      value={form.paymentMethod}
                      onChange={(e) => setForm({ ...form, paymentMethod: e.target.value, bankAccount: '', creditCard: '', cardType: '', cardPos: '', cardLote: '', cardVoucher: '', transferRef: '', cardDeferredType: 'CORRIENTE', cardDeferredMonths: 0 })}
                      className="input"
                    >
                      <option value="">Seleccionar forma de pago…</option>
                      {Object.entries(metodosDePago).map(([k, v]) => (
                        <option key={k} value={k}>{v}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={enableSplit}
                      className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-emerald-700 bg-white border border-dashed border-emerald-300 rounded-lg px-2.5 py-1.5 cursor-pointer hover:bg-emerald-50"
                    >
                      <HiOutlinePlus className="w-3.5 h-3.5" /> Agregar otro método de pago
                    </button>
                  </div>
                )}
                {/* RECIBIDO DEL PACIENTE (oct-2026): lo que entrega. Si es más que
                    el total, se factura el total y el resto queda a su favor. */}
                {!splitMode && metodoConRecibido && total > 0 && (
                  <div>
                    <label className="lbl">Recibido del paciente</label>
                    <NumericInput
                      step="0.01"
                      value={recibido}
                      onChange={(e) => setRecibido(e.target.value)}
                      placeholder={`${total.toFixed(2)} (exacto)`}
                      className="input"
                    />
                    {recibidoNum !== null && recibidoDif > 0.01 && (
                      pacienteVenta ? (
                        <p className="text-[11px] mt-1 font-semibold text-sky-700">
                          Quedan ${recibidoDif.toFixed(2)} a favor del paciente para sus próximos cobros.
                        </p>
                      ) : (
                        <p className="text-[11px] mt-1 font-semibold text-rose-600">
                          Sobran ${recibidoDif.toFixed(2)}: elige un paciente para dejarlo a su favor.
                        </p>
                      )
                    )}
                    {recibidoNum !== null && recibidoDif < -0.01 && (
                      <p className="text-[11px] mt-1 font-semibold text-amber-600">
                        Falta ${(-recibidoDif).toFixed(2)} para cubrir el total.
                      </p>
                    )}
                    {recibidoNum === null && (
                      <p className="text-[11px] mt-1 text-slate-400">Si deja más del total, el resto queda como saldo a favor.</p>
                    )}
                  </div>
                )}
                {/* SALDO A FAVOR disponible del paciente: se puede usar para pagar. */}
                {saldoAFavor > 0.005 && (
                  <div className="sm:col-span-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2">
                    <span className="text-xs text-sky-900">
                      El paciente tiene <b>${saldoAFavor.toFixed(2)}</b> de saldo a favor.
                    </span>
                    <button type="button" onClick={usarSaldoAFavor} className="btn-secondary text-xs">
                      Usar saldo a favor
                    </button>
                  </div>
                )}
                {!splitMode && form.paymentMethod === 'transferencia' && (
                  <>
                    <div>
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
                    <div>
                      <label className="lbl">Número de transferencia *</label>
                      <input
                        value={form.transferRef || ''}
                        onChange={(e) => setForm({ ...form, transferRef: e.target.value })}
                        placeholder="N° de comprobante del banco"
                        className="input"
                      />
                    </div>
                  </>
                )}
                {!splitMode && form.paymentMethod === 'tarjeta' && (
                  <>
                    {/* Débito o crédito: contablemente NO es lo mismo (el crédito queda por
                        liquidar, con comisión y retención) y el reporte los separa en columnas. */}
                    <div>
                      <label className="lbl">Tipo de tarjeta</label>
                      <select
                        value={form.cardType || ''}
                        onChange={(e) => setForm({ ...form, cardType: e.target.value, creditCard: '', cardPos: '', cardDeferredType: 'CORRIENTE', cardDeferredMonths: 0 })}
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
                          <option key={c._id} value={c._id}>{etiquetaTarjeta(c)}</option>
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
                      <label className="lbl">N° de lote *</label>
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
                    {form.cardType === 'CREDITO' && (
                      <>
                        <div>
                          <label className="lbl">Diferido</label>
                          <select
                            value={form.cardDeferredType || 'CORRIENTE'}
                            onChange={(e) => setForm({ ...form, cardDeferredType: e.target.value, cardDeferredMonths: e.target.value === 'CORRIENTE' ? 0 : (form.cardDeferredMonths || 3) })}
                            className="input"
                          >
                            {DEFERRED_TYPES.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                          </select>
                        </div>
                        {form.cardDeferredType && form.cardDeferredType !== 'CORRIENTE' && (
                          <div>
                            <label className="lbl">Meses</label>
                            <select value={form.cardDeferredMonths || 3} onChange={(e) => setForm({ ...form, cardDeferredMonths: +e.target.value })} className="input">
                              {DEFERRED_MONTHS.map((m) => <option key={m} value={m}>{m} meses</option>)}
                            </select>
                          </div>
                        )}
                      </>
                    )}
                  </>
                )}
                {!splitMode && form.paymentMethod === 'credito' && (
                  <>
                    <div>
                      <label className="lbl">Plazo de crédito</label>
                      <select
                        value={form.creditTerm ?? 30}
                        onChange={(e) => setForm({ ...form, creditTerm: e.target.value === 'CUSTOM' ? 'CUSTOM' : +e.target.value, dueDate: '' })}
                        className="input"
                      >
                        {CREDIT_TERMS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                        <option value="CUSTOM">Otra fecha…</option>
                      </select>
                      {form.creditTerm !== 'CUSTOM' && (
                        <p className="text-[11px] text-slate-500 mt-1">Vence el {vencimientoDesdePlazo(form.creditTerm ?? 30)}</p>
                      )}
                    </div>
                    {form.creditTerm === 'CUSTOM' && (
                      <div>
                        <label className="lbl">Vence (fecha exacta)</label>
                        <DateInput value={form.dueDate || ''} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} className="input" />
                      </div>
                    )}
                  </>
                )}
                {splitMode && (
                  <div className="sm:col-span-3 rounded-xl border border-emerald-200 p-3 space-y-2 bg-emerald-50/30">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold text-slate-700">Pago con {splitPayments.length} métodos</p>
                        <p className="text-[11px] text-slate-500">Indica cuánto paga con cada método. Los montos deben sumar el total de ${total.toFixed(2)}.</p>
                      </div>
                      <button type="button" onClick={() => { setSplitMode(false); setSplitPayments([]); }} className="text-xs text-slate-500 hover:text-slate-700 bg-transparent border-none cursor-pointer whitespace-nowrap">Usar un solo método</button>
                    </div>
                    {splitPayments.map((p, i) => (
                      <div key={i} className="flex flex-wrap items-end gap-2 bg-white rounded-lg border border-slate-200 p-2">
                        <span className="self-center shrink-0 w-6 h-6 rounded-full bg-emerald-600 text-white text-xs font-bold flex items-center justify-center" title={`Pago ${i + 1}`}>{i + 1}</span>
                        <div className="w-36">
                          <label className="lbl">Método *</label>
                          <select value={p.method} onChange={(e) => setSplitRow(i, { method: e.target.value, bankAccount: '', reference: '', creditCard: '', cardType: '', cardPos: '', cardLote: '', cardVoucher: '', cardDeferredType: 'CORRIENTE', cardDeferredMonths: 0 })} className="input">
                            <option value="">Seleccionar…</option>
                            {Object.entries(metodosDePago).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                          </select>
                        </div>
                        <div className="w-28">
                          <label className="lbl">Monto</label>
                          <NumericInput step="0.01" value={p.amount} onChange={(e) => setSplitAmount(i, e.target.value)} className="input" />
                        </div>
                        {p.method === 'transferencia' && (
                          <>
                            <div className="flex-1 min-w-[180px]">
                              <label className="lbl">Cuenta bancaria</label>
                              <select value={p.bankAccount || ''} onChange={(e) => setSplitRow(i, { bankAccount: e.target.value })} className="input">
                                <option value="">{payOptions.accounts.length ? 'Seleccionar cuenta…' : 'No hay cuentas'}</option>
                                {payOptions.accounts.map((a) => <option key={a._id} value={a._id}>{a.name} — {a.bank}</option>)}
                              </select>
                            </div>
                            <div className="w-40">
                              <label className="lbl">N° transferencia *</label>
                              <input value={p.reference || ''} onChange={(e) => setSplitRow(i, { reference: e.target.value })} placeholder="Comprobante" className="input" />
                            </div>
                          </>
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
                                {cardsOfType(p.cardType).map((c) => <option key={c._id} value={c._id}>{etiquetaTarjeta(c)}</option>)}
                              </select>
                            </div>
                            <div className="w-24">
                              <label className="lbl">N° lote *</label>
                              <input value={p.cardLote || ''} onChange={(e) => setSplitRow(i, { cardLote: e.target.value })} className="input" />
                            </div>
                            {p.cardType === 'CREDITO' && (
                              <>
                                <div className="w-40">
                                  <label className="lbl">Diferido</label>
                                  <select
                                    value={p.cardDeferredType || 'CORRIENTE'}
                                    onChange={(e) => setSplitRow(i, { cardDeferredType: e.target.value, cardDeferredMonths: e.target.value === 'CORRIENTE' ? 0 : (p.cardDeferredMonths || 3) })}
                                    className="input"
                                  >
                                    {DEFERRED_TYPES.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                                  </select>
                                </div>
                                {p.cardDeferredType && p.cardDeferredType !== 'CORRIENTE' && (
                                  <div className="w-24">
                                    <label className="lbl">Meses</label>
                                    <select value={p.cardDeferredMonths || 3} onChange={(e) => setSplitRow(i, { cardDeferredMonths: +e.target.value })} className="input">
                                      {DEFERRED_MONTHS.map((m) => <option key={m} value={m}>{m}</option>)}
                                    </select>
                                  </div>
                                )}
                              </>
                            )}
                          </>
                        )}
                        <button type="button" onClick={() => removeSplitRow(i)} className="text-rose-500 hover:text-rose-600 pb-2 bg-transparent border-none cursor-pointer" title="Quitar método"><HiOutlineTrash className="w-4 h-4" /></button>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={addSplitRow}
                      className="w-full flex items-center justify-center gap-1 text-sm font-medium text-emerald-700 bg-white border border-dashed border-emerald-300 rounded-lg py-2 cursor-pointer hover:bg-emerald-50"
                    >
                      <HiOutlinePlus className="w-4 h-4" /> Agregar otro método de pago
                    </button>
                    {/* Barra de lo pagado vs el total */}
                    <div className="h-1.5 rounded-full bg-slate-200 overflow-hidden">
                      <div
                        className={`h-full transition-all ${splitRemaining > 0.01 ? 'bg-amber-500' : splitRemaining < -0.01 ? 'bg-sky-500' : 'bg-emerald-500'}`}
                        style={{ width: `${total > 0 ? Math.min(100, (splitPaid / total) * 100) : 0}%` }}
                      />
                    </div>
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      {splitRemaining > 0.01 ? (
                        <button type="button" onClick={completarRestante} className="text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1 cursor-pointer hover:bg-amber-100">
                          Sumar lo que falta (${splitRemaining.toFixed(2)}) al pago {splitPayments.length}
                        </button>
                      ) : <span />}
                      <div className="text-sm text-slate-600">
                        Pagado: <b className="font-mono">${splitPaid.toFixed(2)}</b> / Total: <b className="font-mono">${total.toFixed(2)}</b>
                        {splitRemaining > 0.01
                          ? <span className="ml-2 font-semibold text-amber-600">Falta ${splitRemaining.toFixed(2)}</span>
                          : splitRemaining < -0.01
                            ? (pacienteVenta
                              ? <span className="ml-2 font-semibold text-sky-700" title="Se factura solo el total; el excedente queda como saldo a favor del paciente">Queda a favor del paciente: ${(-splitRemaining).toFixed(2)}</span>
                              : <span className="ml-2 font-semibold text-rose-600">Sobra ${(-splitRemaining).toFixed(2)} (elige un paciente para dejarlo a su favor)</span>)
                            : <span className="ml-2 text-emerald-600 font-semibold">✓ Cuadra</span>}
                      </div>
                    </div>
                    {splitPayments.some((p) => p.method === 'credito') && (
                      <div className="flex flex-wrap items-end gap-2">
                        <div className="w-48">
                          <label className="lbl">Plazo (parte a crédito)</label>
                          <select
                            value={form.creditTerm ?? 30}
                            onChange={(e) => setForm({ ...form, creditTerm: e.target.value === 'CUSTOM' ? 'CUSTOM' : +e.target.value, dueDate: '' })}
                            className="input"
                          >
                            {CREDIT_TERMS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                            <option value="CUSTOM">Otra fecha…</option>
                          </select>
                        </div>
                        {form.creditTerm === 'CUSTOM' ? (
                          <div className="w-48">
                            <label className="lbl">Vence</label>
                            <DateInput value={form.dueDate || ''} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} className="input" />
                          </div>
                        ) : (
                          <p className="text-[11px] text-slate-500 pb-2">Vence el {vencimientoDesdePlazo(form.creditTerm ?? 30)}</p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </FormSection>

            {cajaCerrada && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
                <span><b>Tu caja está cerrada.</b> No puedes facturar hasta tener la caja abierta.</span>
                <a href="/cash-register" target="_blank" rel="noreferrer" className="text-xs font-semibold text-rose-700 underline">
                  Abrir caja
                </a>
              </div>
            )}
            {canInvoice && (miPunto.usaPuntos || miPunto.punto) && !cajaCerrada && (
              puedeFacturarAqui ? (
                <label className="flex items-center gap-2 rounded-xl border border-emerald-100 bg-emerald-50/50 px-4 py-3 text-sm text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    className="w-4 h-4"
                    checked={facturarAlGuardar}
                    onChange={(e) => setFacturarAlGuardar(e.target.checked)}
                  />
                  <span>
                    Emitir factura electrónica al cobrar · serie{' '}
                    <b className="font-mono">{miPunto.punto.establecimiento}-{miPunto.punto.codigo}</b>
                    {miPunto.punto.nombre ? ` (${miPunto.punto.nombre})` : ''}
                    {/* El número de la factura que se va a emitir, bien visible (nov-2026:
                        antes iba en letra pequeña y el cajero no lo veía). */}
                    {proximaFactura && (
                      <span className="block text-lg text-slate-600 mt-1 leading-tight">
                        Factura N.º <b className="font-mono font-bold text-emerald-800 tracking-wide">{proximaFactura}</b>
                      </span>
                    )}
                  </span>
                </label>
              ) : (
                <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 m-0">
                  No tienes un punto de emisión (caja) asignado: la venta se registra, pero no podrás facturarla.
                  Pide al administrador que te asigne uno en Configuración SRI.
                </p>
              )
            )}

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
                // Solo con CLIC: un clic de ratón trae `detail` ≥ 1; Enter/espacio sobre el
                // botón (o el envío implícito del formulario) llegan con 0 y no cobran.
                onClick={(e) => { if (e.detail === 0) e.preventDefault(); }}
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
    </>
  );

  if (embebido) return modalesDeVenta;

  return (
    <div className="space-y-6">
      <PageHeader icon={HiOutlineBanknotes} title="Facturación" subtitle="Registro e historial de ventas">
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
          <DateInput
            value={filter.startDate}
            onChange={(e) => setFilter({ ...filter, startDate: e.target.value })}
            className="px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none bg-slate-50/50"
          />
          <DateInput
            value={filter.endDate}
            onChange={(e) => setFilter({ ...filter, endDate: e.target.value })}
            className="px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none bg-slate-50/50"
          />
          <input
            type="text"
            value={clienteTexto}
            onChange={(e) => setClienteTexto(e.target.value)}
            placeholder="Buscar cliente: nombre, cédula o teléfono..."
            title="Por palabras sueltas, sin tildes y en cualquier orden (p. ej. «cesar guatumillo»)"
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
                      ) : null}
                      {s.invoice?.estab && (
                        <span className="block mt-0.5 font-mono text-[10px] text-slate-400">
                          {s.invoice.estab}-{s.invoice.ptoEmi}-{s.invoice.secuencial}
                        </span>
                      )}
                      {!s.invoice && <span className="text-slate-400">—</span>}
                    </td>
                    <td className="px-6 py-3 text-right">
                      <button
                        onClick={() => openDetail(s._id)}
                        className="p-1.5 rounded-lg hover:bg-emerald-50 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer"
                        title="Detalle"
                      >
                        <HiOutlineEye className="w-4 h-4" />
                      </button>
                      {/* RIDE: la factura en PDF con el formato del SRI (sale del XML enviado). */}
                      {s.invoice?._id && s.invoice.estado !== 'NO_AUTORIZADO' && (
                        <button
                          onClick={() => verFacturaPdf(s.invoice._id)}
                          className="p-1.5 rounded-lg hover:bg-blue-50 text-slate-400 hover:text-blue-600 bg-transparent border-none cursor-pointer"
                          title="Ver factura en PDF (RIDE)"
                        >
                          <HiOutlineDocumentArrowDown className="w-4 h-4" />
                        </button>
                      )}
                      {canInvoice && s.status === 'completada' && (!s.invoice || s.invoice.estado === 'NO_AUTORIZADO') && (
                        <button
                          onClick={() => facturar(s)}
                          disabled={invoicingId === s._id}
                          className="p-1.5 rounded-lg hover:bg-blue-50 text-slate-400 hover:text-blue-600 bg-transparent border-none cursor-pointer disabled:opacity-50"
                          title={s.invoice ? 'La factura anterior no fue autorizada: facturar de nuevo' : 'Facturar electrónicamente'}
                        >
                          <HiOutlineDocumentText className="w-4 h-4" />
                        </button>
                      )}
                      {s.status === 'completada' && s.balance > 0.01 && (
                        <button
                          onClick={() => openCollect(s)}
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

      {modalesDeVenta}

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
                      {item.delivery === 'en_clinica' && (
                        <span className="block text-[11px] text-amber-700">Lo compró y lo dejó en la clínica: quedó guardado a su nombre</span>
                      )}
                      {item.delivery === 'aplicado' && (
                        <span className="block text-[11px] text-sky-700">Se lo aplicó aquí</span>
                      )}
                      {(item.linkedItems || []).length > 0 && (
                        <span className="block text-[11px] text-cyan-800">
                          Usó: {item.linkedItems.map((l) => `${l.productName} ×${l.quantity}${l.source === 'inventario' ? '' : ` (${FUENTES_VINCULADO[l.source]?.toLowerCase() || l.source})`}`).join(' · ')}
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
            {detailModal.discountReason && (
              <div className="text-sm">
                <span className="block text-slate-500">Motivo del descuento / comentario:</span>
                <p className="text-slate-800 whitespace-pre-wrap">{detailModal.discountReason}</p>
              </div>
            )}
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

      {/* Anular una venta con factura AUTORIZADA (nov-2026): se anula la factura y, con ella,
          la venta (mismo endpoint que Facturación). Antes Ventas lo impedía. */}
      <Modal isOpen={!!anularFactura} onClose={() => setAnularFactura(null)}
        title={`Anular factura ${anularFactura?.invoice ? `${anularFactura.invoice.estab}-${anularFactura.invoice.ptoEmi}-${String(anularFactura.invoice.secuencial).padStart(9, '0')}` : ''}`} size="md">
        {anularFactura && (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">
              La factura está autorizada por el SRI. Se anulará en el sistema junto con la venta {anularFactura.saleNumber}
              (se devuelve el stock y se reversan sus asientos). Recuerda anularla también en el portal del SRI.
            </p>
            <label className="block text-sm font-medium text-slate-700">Motivo de la anulación</label>
            <textarea
              value={motivoAnulacion}
              onChange={(e) => setMotivoAnulacion(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm"
              placeholder="Mínimo 10 caracteres"
            />
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-secondary" onClick={() => setAnularFactura(null)}>Cancelar</button>
              <button type="button" className="btn-primary" disabled={anulando} onClick={submitAnularFactura}>
                {anulando ? 'Anulando…' : 'Anular factura y venta'}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Cobro de la parte a crédito: genera un documento de Cobro (visible en Pagos / Cobros). */}
      <Modal isOpen={!!collectItem} onClose={() => setCollectItem(null)} title={`Cobrar venta ${collectItem?.saleNumber || ''}`} size="md">
        {collectItem && (
          <form onSubmit={submitCollect} className="space-y-3">
            <div className="bg-slate-50 rounded-lg p-3 text-sm space-y-1">
              <div className="flex justify-between"><span className="text-slate-500">Cliente:</span><b>{collectItem.clientName}</b></div>
              <div className="flex justify-between"><span className="text-slate-500">Total de la venta:</span><b className="font-mono">${Number(collectItem.total || 0).toFixed(2)}</b></div>
              <div className="flex justify-between"><span className="text-slate-500">Saldo pendiente:</span><b className="font-mono text-amber-600">${Number(collectItem.balance || 0).toFixed(2)}</b></div>
              {collectItem.dueDate && <div className="flex justify-between"><span className="text-slate-500">Vence:</span><b>{fmtDateTime(collectItem.dueDate).slice(0, 10)}</b></div>}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="lbl">Fecha</label>
                <DateInput required value={collectForm.date} onChange={(e) => setCollectForm({ ...collectForm, date: e.target.value })} className="input" />
              </div>
              <div>
                <label className="lbl">Monto a cobrar</label>
                <NumericInput step="0.01" required value={collectForm.amount} onChange={(e) => setCollectForm({ ...collectForm, amount: e.target.value })} className="input" />
              </div>
              <div>
                <label className="lbl">Forma de cobro</label>
                <select value={collectForm.method} onChange={(e) => setCollectForm({ ...collectForm, method: e.target.value, bankAccount: '' })} className="input">
                  <option value="EFECTIVO">Efectivo</option>
                  <option value="TRANSFERENCIA">Transferencia</option>
                  <option value="DEPOSITO">Depósito</option>
                  <option value="TARJETA">Tarjeta</option>
                  <option value="CHEQUE">Cheque</option>
                </select>
              </div>
              {!['EFECTIVO', 'TARJETA'].includes(collectForm.method) && (
                <div>
                  <label className="lbl">Cuenta bancaria</label>
                  <select required value={collectForm.bankAccount} onChange={(e) => setCollectForm({ ...collectForm, bankAccount: e.target.value })} className="input">
                    <option value="">{payOptions.accounts.length ? 'Seleccionar…' : 'No hay cuentas'}</option>
                    {payOptions.accounts.map((a) => <option key={a._id} value={a._id}>{a.name} — {a.bank}</option>)}
                  </select>
                </div>
              )}
              <div className="col-span-2">
                <label className="lbl">Comprobante / referencia</label>
                <input value={collectForm.reference} onChange={(e) => setCollectForm({ ...collectForm, reference: e.target.value })} placeholder="N° de transferencia, papeleta, cheque…" className="input" />
              </div>
            </div>
            <p className="text-[11px] text-slate-500">Se registra un documento de cobro que puedes ver y anular en Contabilidad → Bancos → Pagos / Cobros.</p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setCollectItem(null)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button>
              <button disabled={collectBusy} className="px-4 py-2 bg-emerald-600 text-white rounded-xl disabled:opacity-50">{collectBusy ? 'Registrando…' : 'Registrar cobro'}</button>
            </div>
          </form>
        )}
      </Modal>
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
