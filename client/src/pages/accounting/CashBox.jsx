import { useEffect, useMemo, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import { HiOutlineCurrencyDollar, HiOutlineArrowsRightLeft } from 'react-icons/hi2';
import { fmt, fmtDate, today } from './_utils';

/**
 * Caja — Cash on hand y depósitos a banco.
 * - Muestra ventas en efectivo pendientes de depositar (efectivo + status completada).
 * - Permite seleccionar varias y enviarlas a una cuenta bancaria, registrando
 *   el número de papeleta/comprobante que entrega el banco.
 */
export default function CashBox() {
  const [pending, setPending] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(new Set());
  const [bankAccounts, setBankAccounts] = useState([]);
  const [showDeposit, setShowDeposit] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    bankAccount: '',
    voucher: '',
    date: today(),
    description: '',
  });

  const load = async () => {
    setLoading(true);
    try {
      const [r1, r2] = await Promise.all([
        // Mismo origen que la pantalla de Depósitos: ventas y cobros en efectivo aún no
        // depositados (una venta mixta entra solo por su parte en efectivo).
        api.get('/cash-deposits/pending'),
        api.get('/banks/accounts', { params: { active: true } }),
      ]);
      setPending(r1.data?.items || []);
      setTotal(Number(r1.data?.total || 0));
      setBankAccounts(r2.data || []);
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al cargar caja');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // La clave es documento+id: en la lista conviven ventas y cobros de cartera.
  const keyOf = (i) => `${i.docModel}:${i.docRef}`;

  const toggle = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === pending.length) setSelected(new Set());
    else setSelected(new Set(pending.map(keyOf)));
  };

  const selectedTotal = useMemo(() => {
    return pending
      .filter((s) => selected.has(keyOf(s)))
      .reduce((acc, s) => acc + Number(s.amount || 0), 0);
  }, [pending, selected]);

  const openDeposit = () => {
    if (selected.size === 0) {
      toast.error('Selecciona al menos una venta');
      return;
    }
    setForm({
      bankAccount: bankAccounts[0]?._id || '',
      voucher: '',
      date: today(),
      description: `Depósito ventas en efectivo (${selected.size} venta(s))`,
    });
    setShowDeposit(true);
  };

  const submitDeposit = async (e) => {
    e.preventDefault();
    if (!form.bankAccount) return toast.error('Selecciona una cuenta bancaria');
    if (!form.voucher.trim()) return toast.error('Ingresa el número de comprobante');
    setSubmitting(true);
    try {
      const res = await api.post('/cash-deposits', {
        items: pending.filter((i) => selected.has(keyOf(i))).map((i) => ({ docModel: i.docModel, docRef: i.docRef })),
        bankAccount: form.bankAccount,
        voucherNumber: form.voucher.trim(),
        date: form.date,
        description: form.description,
      });
      toast.success(`Depositado: $${Number(res.data?.total || 0).toFixed(2)}`);
      setShowDeposit(false);
      setSelected(new Set());
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al depositar');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
            <HiOutlineCurrencyDollar className="w-7 h-7 text-emerald-600" /> Caja
          </h1>
          <p className="text-sm text-slate-500">
            Ventas y cobros en efectivo pendientes de depósito bancario. El historial de depósitos
            hechos está en <b>Bancos → Depósitos</b>.
          </p>
        </div>
        <button
          onClick={openDeposit}
          disabled={selected.size === 0}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed border-none cursor-pointer"
        >
          <HiOutlineArrowsRightLeft className="w-4 h-4" />
          Depositar a banco {selected.size > 0 && `(${selected.size})`}
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4">
          <p className="text-xs uppercase font-semibold text-emerald-700">Efectivo en caja</p>
          <p className="text-3xl font-bold text-emerald-800">{fmt(total)}</p>
          <p className="text-xs text-emerald-700 mt-1">{pending.length} venta(s) pendientes</p>
        </div>
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
          <p className="text-xs uppercase font-semibold text-blue-700">Seleccionado</p>
          <p className="text-3xl font-bold text-blue-800">{fmt(selectedTotal)}</p>
          <p className="text-xs text-blue-700 mt-1">{selected.size} venta(s) marcadas</p>
        </div>
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
          <p className="text-xs uppercase font-semibold text-slate-600">Cuentas bancarias</p>
          <p className="text-3xl font-bold text-slate-800">{bankAccounts.length}</p>
          <p className="text-xs text-slate-600 mt-1">disponibles para depósito</p>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <table className="tbl">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="px-3 py-2.5 w-10">
                <input
                  type="checkbox"
                  checked={pending.length > 0 && selected.size === pending.length}
                  onChange={toggleAll}
                />
              </th>
              <th className="text-left px-3 py-2.5 font-semibold">Fecha</th>
              <th className="text-left px-3 py-2.5 font-semibold">Documento</th>
              <th className="text-left px-3 py-2.5 font-semibold">Cliente</th>
              <th className="text-left px-3 py-2.5 font-semibold">Origen</th>
              <th className="text-right px-3 py-2.5 font-semibold">Efectivo</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={6} className="text-center py-6 text-slate-400">Cargando...</td></tr>
            )}
            {!loading && pending.length === 0 && (
              <tr><td colSpan={6} className="text-center py-6 text-slate-400">No hay ventas en efectivo pendientes.</td></tr>
            )}
            {pending.map((s) => (
              <tr
                key={keyOf(s)}
                className={`border-t border-slate-100 hover:bg-slate-50 ${selected.has(keyOf(s)) ? 'bg-emerald-50/50' : ''}`}
              >
                <td className="px-3 py-2 text-center">
                  <input
                    type="checkbox"
                    checked={selected.has(keyOf(s))}
                    onChange={() => toggle(keyOf(s))}
                  />
                </td>
                <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{fmtDate(s.docDate)}</td>
                <td className="px-3 py-2 text-slate-700 font-mono">{s.number || '—'}</td>
                <td className="px-3 py-2 text-slate-800">{s.party || '—'}</td>
                <td className="px-3 py-2 text-slate-600">{s.docModel === 'Sale' ? 'Venta' : 'Cobro'}{s.mixta ? ' (mixta)' : ''}</td>
                <td className="px-3 py-2 text-right text-slate-800 font-medium">{fmt(s.amount)}</td>
              </tr>
            ))}
          </tbody>
          {pending.length > 0 && (
            <tfoot className="bg-slate-50 border-t-2 border-slate-200">
              <tr>
                <td colSpan={5} className="px-3 py-2 text-right text-sm font-semibold text-slate-700">Total efectivo:</td>
                <td className="px-3 py-2 text-right text-base font-bold text-emerald-700">{fmt(total)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <Modal
        isOpen={showDeposit}
        onClose={() => setShowDeposit(false)}
        title="Depositar a cuenta bancaria"
      >
        <form onSubmit={submitDeposit} className="space-y-3">
          <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3">
            <p className="text-xs text-emerald-700 font-medium uppercase">Total a depositar</p>
            <p className="text-2xl font-bold text-emerald-800">{fmt(selectedTotal)}</p>
            <p className="text-xs text-emerald-700">{selected.size} venta(s) seleccionada(s)</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Cuenta bancaria destino *
            </label>
            <select
              value={form.bankAccount}
              onChange={(e) => setForm((f) => ({ ...f, bankAccount: e.target.value }))}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              required
            >
              <option value="">— Seleccionar cuenta —</option>
              {bankAccounts.map((b) => (
                <option key={b._id} value={b._id}>
                  {b.name} — {b.bank} {b.accountNumber ? `(${b.accountNumber})` : ''}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Número de papeleta / comprobante *
            </label>
            <input
              type="text"
              value={form.voucher}
              onChange={(e) => setForm((f) => ({ ...f, voucher: e.target.value }))}
              placeholder="Ej: 1234567890"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              required
            />
            <p className="text-xs text-slate-500 mt-1">
              Es el número que entrega el banco al momento del depósito.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Fecha</label>
            <input
              type="date"
              value={form.date}
              onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Descripción</label>
            <input
              type="text"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setShowDeposit(false)}
              className="px-4 py-2 rounded-lg border border-slate-300 bg-white text-slate-700 text-sm cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium disabled:opacity-50 border-none cursor-pointer"
            >
              {submitting ? 'Procesando...' : 'Confirmar depósito'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
