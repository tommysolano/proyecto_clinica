import { useEffect, useMemo, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import Modal from './Modal';
import Field from './Field';
import NumericInput from './NumericInput';
import ProductSelect from './ProductSelect';
import { HiOutlinePlus, HiOutlineTrash, HiOutlineArrowsRightLeft } from 'react-icons/hi2';
import DateInput from './DateInput';

const fmt = (n) => Number(n || 0).toLocaleString('es-EC', { minimumFractionDigits: 0, maximumFractionDigits: 4 });
const hoy = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });
const nuevaLinea = () => ({ key: `l${Math.random().toString(36).slice(2, 9)}`, product: '', quantity: '' });

/**
 * TRASLADO ENTRE BODEGAS de UNO O VARIOS PRODUCTOS.
 *
 * Un traslado es un DOCUMENTO: se eligen las dos bodegas una sola vez y debajo van
 * tantas líneas de producto/cantidad como haga falta. El servidor lo mueve todo dentro
 * de la misma transacción, así que o entra el traslado completo o no entra nada.
 *
 * Debajo de cada línea se muestra lo que hay REALMENTE en la bodega de origen (de las
 * capas del kardex, vía `/inventory-advanced/warehouse-stock`), para no enviar a mano una
 * cantidad que el servidor va a rechazar.
 */
export default function TransferStockModal({
  isOpen,
  onClose,
  onDone,
  warehouses = [],
  products = [],
  costCenters = [],
  defaultProduct = '',
}) {
  const [fromWarehouse, setFromWarehouse] = useState('');
  const [toWarehouse, setToWarehouse] = useState('');
  const [date, setDate] = useState(hoy());
  const [reason, setReason] = useState('');
  const [costCenter, setCostCenter] = useState('');
  const [lines, setLines] = useState([nuevaLinea()]);
  const [stock, setStock] = useState([]);
  const [saving, setSaving] = useState(false);

  const activas = useMemo(() => warehouses.filter((w) => w.active !== false), [warehouses]);

  useEffect(() => {
    if (!isOpen) return;
    const principal = activas.find((w) => w.isMain) || activas[0];
    setFromWarehouse(principal?._id || '');
    setToWarehouse('');
    setDate(hoy());
    setReason('');
    setCostCenter(principal?.costCenter?._id || principal?.costCenter || '');
    setLines([{ ...nuevaLinea(), product: defaultProduct || '' }]);
    api.get('/inventory-advanced/warehouse-stock')
      .then((r) => setStock(r.data || []))
      .catch(() => setStock([]));
  }, [isOpen, defaultProduct]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Existencia real del producto en la bodega de origen (null = todavía no se sabe). */
  const disponible = (productId) => {
    if (!productId || !fromWarehouse) return null;
    const fila = stock.find((s) => String(s.product?._id) === String(productId));
    if (!fila) return 0;
    const w = fila.warehouses.find((x) => String(x.warehouse?._id) === String(fromWarehouse));
    return w?.qty || 0;
  };

  const centroDeBodega = (id) => {
    const w = warehouses.find((x) => String(x._id) === String(id));
    return w?.costCenter?._id || w?.costCenter || '';
  };
  const centroEsperado = centroDeBodega(fromWarehouse);
  const centroDistinto = !!centroEsperado && !!costCenter && String(centroEsperado) !== String(costCenter);
  const nombreCentro = (id) => costCenters.find((c) => String(c._id) === String(id))?.name || '—';

  // Al cambiar el origen se PROPONE su centro de costo, sin pisar uno ya elegido a mano.
  const elegirOrigen = (id) => {
    setFromWarehouse(id);
    setCostCenter((actual) => actual || centroDeBodega(id));
  };

  const setLinea = (key, campo, valor) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, [campo]: valor } : l)));
  const quitarLinea = (key) => setLines((ls) => (ls.length > 1 ? ls.filter((l) => l.key !== key) : ls));

  const llenas = lines.filter((l) => l.product && Number(l.quantity) > 0);
  const totalUnidades = llenas.reduce((s, l) => s + Number(l.quantity || 0), 0);

  const submit = async (e) => {
    e.preventDefault();
    if (!fromWarehouse || !toWarehouse) return toast.error('Elige la bodega de origen y la de destino');
    if (String(fromWarehouse) === String(toWarehouse)) return toast.error('Las bodegas deben ser distintas');
    if (!llenas.length) return toast.error('Agrega al menos un producto con cantidad');

    const repetido = llenas.map((l) => String(l.product)).find((p, i, arr) => arr.indexOf(p) !== i);
    if (repetido) {
      const nombre = products.find((p) => String(p._id) === repetido)?.name || 'un producto';
      return toast.error(`"${nombre}" está repetido: júntalo en una sola línea`);
    }
    // Se avisa ANTES de enviar: el servidor también lo valida, pero así se ve qué línea falla.
    for (const l of llenas) {
      const hay = disponible(l.product);
      if (hay != null && Number(l.quantity) > hay) {
        const nombre = products.find((p) => String(p._id) === String(l.product))?.name || 'el producto';
        return toast.error(`Solo hay ${fmt(hay)} de "${nombre}" en la bodega de origen`);
      }
    }
    if (centroDistinto && !window.confirm(
      `El centro de costo de la bodega es "${nombreCentro(centroEsperado)}" y elegiste `
      + `"${nombreCentro(costCenter)}". El traslado se registrará con el que elegiste. ¿Continuar?`
    )) return;

    setSaving(true);
    try {
      const r = await api.post('/inventory-advanced/transfer', {
        fromWarehouse,
        toWarehouse,
        date: date || undefined,
        reason,
        costCenter: costCenter || undefined,
        items: llenas.map((l) => ({ product: l.product, quantity: Number(l.quantity) })),
      });
      const n = r.data?.lines || llenas.length;
      toast.success(
        `${n === 1 ? 'Traslado registrado' : `Traslado de ${n} productos registrado`}`
        + (r.data?.journalEntryCreated ? ' con asiento contable' : '')
      );
      onDone?.(r.data);
      onClose?.();
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo registrar el traslado');
    } finally {
      setSaving(false);
    }
  };

  const nombreBodega = (id) => warehouses.find((w) => String(w._id) === String(id))?.name || '';

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Traslado entre bodegas" size="lg">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Bodega origen" required>
            <select required value={fromWarehouse} onChange={(e) => elegirOrigen(e.target.value)} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5">
              <option value="">Seleccione…</option>
              {activas.map((w) => <option key={w._id} value={w._id}>{w.code ? `${w.code} — ${w.name}` : w.name}</option>)}
            </select>
          </Field>
          <Field label="Bodega destino" required>
            <select required value={toWarehouse} onChange={(e) => setToWarehouse(e.target.value)} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5">
              <option value="">Seleccione…</option>
              {activas.filter((w) => String(w._id) !== String(fromWarehouse)).map((w) => (
                <option key={w._id} value={w._id}>{w.code ? `${w.code} — ${w.name}` : w.name}</option>
              ))}
            </select>
          </Field>
        </div>

        {/* Líneas: uno o varios productos en el mismo traslado */}
        <div className="border border-slate-200 rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 bg-slate-50 border-b border-slate-200">
            <span className="text-sm font-semibold text-slate-700">Productos a trasladar</span>
            <button
              type="button"
              onClick={() => setLines((ls) => [...ls, nuevaLinea()])}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg cursor-pointer"
            >
              <HiOutlinePlus className="w-3.5 h-3.5" /> Agregar producto
            </button>
          </div>
          <div className="divide-y divide-slate-100">
            {lines.map((l) => {
              const hay = disponible(l.product);
              const excede = hay != null && Number(l.quantity) > hay;
              return (
                <div key={l.key} className="p-3 grid grid-cols-12 gap-2 items-start">
                  <div className="col-span-12 sm:col-span-7">
                    <ProductSelect
                      products={products}
                      value={l.product}
                      onChange={(v) => setLinea(l.key, 'product', v)}
                      placeholder="Buscar producto…"
                    />
                    {l.product && fromWarehouse && (
                      <p className={`text-[11px] mt-1 ${hay > 0 ? 'text-slate-500' : 'text-rose-600'}`}>
                        Disponible en {nombreBodega(fromWarehouse)}: <b>{fmt(hay || 0)}</b>
                      </p>
                    )}
                  </div>
                  <div className="col-span-9 sm:col-span-4">
                    <NumericInput
                      min="0.0001" step="any"
                      placeholder="Cantidad"
                      value={l.quantity}
                      onChange={(e) => setLinea(l.key, 'quantity', e.target.value)}
                      className={`w-full border rounded-xl px-3.5 py-2.5 text-right ${excede ? 'border-rose-300 bg-rose-50' : 'border-slate-200'}`}
                    />
                    {excede && <p className="text-[11px] text-rose-600 mt-1">Más de lo que hay en origen</p>}
                  </div>
                  <div className="col-span-3 sm:col-span-1 flex justify-end pt-1">
                    <button
                      type="button"
                      onClick={() => quitarLinea(l.key)}
                      disabled={lines.length === 1}
                      title="Quitar esta línea"
                      className="p-2 text-slate-400 hover:text-rose-600 disabled:opacity-30 disabled:cursor-not-allowed bg-transparent border-none cursor-pointer"
                    >
                      <HiOutlineTrash className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="px-3 py-2 bg-slate-50 border-t border-slate-200 text-xs text-slate-600 flex justify-between">
            <span>{llenas.length} producto(s)</span>
            <span>Total: <b>{fmt(totalUnidades)}</b> unidad(es)</span>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Fecha del traslado" hint="La fecha real del movimiento, no la de grabación.">
            <DateInput value={date} onChange={(e) => setDate(e.target.value)} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" />
          </Field>
          <Field label="Centro de costo">
            <select value={costCenter} onChange={(e) => setCostCenter(e.target.value)} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5">
              <option value="">Sin centro de costo</option>
              {costCenters.map((c) => <option key={c._id} value={c._id}>{c.code} — {c.name}</option>)}
            </select>
          </Field>
        </div>

        {/* El centro de la bodega es una PROPUESTA: si eliges otro, se avisa y se registra el elegido. */}
        {centroDistinto && (
          <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
            <b>Centro de costo distinto al de la bodega.</b><br />
            Esperado (bodega {nombreBodega(fromWarehouse)}): <b>{nombreCentro(centroEsperado)}</b> ·
            Seleccionado: <b>{nombreCentro(costCenter)}</b>.<br />
            El traslado quedará registrado con el centro <b>seleccionado</b>. Confirma para continuar.
          </div>
        )}

        <Field label="Motivo">
          <input placeholder="Opcional (ej. reposición de farmacia)" value={reason} onChange={(e) => setReason(e.target.value)} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" />
        </Field>

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-2 bg-slate-200 rounded-xl cursor-pointer border-none">Cancelar</button>
          <button
            disabled={saving || !llenas.length}
            className="px-4 py-2 bg-sky-600 text-white rounded-xl shadow-sm shadow-sky-600/20 disabled:opacity-50 inline-flex items-center gap-2 cursor-pointer border-none"
          >
            <HiOutlineArrowsRightLeft className="w-4 h-4" />
            {saving ? 'Trasladando…' : 'Trasladar'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
