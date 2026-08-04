import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import Field from '../../components/Field';
import NumericInput from '../../components/NumericInput';
import SearchableSelect from '../../components/SearchableSelect';
import ExcelButton from '../../components/ExcelButton';
import { HiOutlinePlus, HiOutlineArrowsRightLeft, HiOutlinePencilSquare, HiOutlineTrash, HiOutlineArrowTopRightOnSquare, HiOutlineMagnifyingGlass } from 'react-icons/hi2';
import { fmt, fmtDate, today } from './_utils';
import { sourceLabel, sourceDeepLink, sourceActionLabel } from './sourceDocs';

/**
 * MOVIMIENTOS BANCARIOS · todo lo que entra y sale de los bancos, venga de donde venga.
 *
 * Qué se puede corregir y qué no:
 *   · Los movimientos MANUALES (registrados aquí) se corrigen o se anulan.
 *   · Los que espejan otro documento —un cobro, una venta, una nómina, una liquidación de
 *     tarjeta— comparten el asiento de ese documento: tocarlos desde aquí reversaría el
 *     asiento completo y dejaría el documento origen descuadrado. Por eso se muestran, pero
 *     la corrección se hace en su documento (hay acceso directo cuando existe).
 *   · Un movimiento ya CONCILIADO no se toca: primero hay que reabrir la conciliación.
 *
 * Corregir NO edita el asiento (son inmutables): anula el movimiento equivocado, reversa su
 * asiento y registra el corregido. En la tabla queda la traza completa.
 */
const TIPOS = ['DEPOSITO', 'RETIRO', 'TRANSFERENCIA_IN', 'TRANSFERENCIA_OUT', 'ANTICIPO', 'CAJA_CHICA', 'CHEQUE_EMITIDO', 'COMISION', 'INTERES', 'COBRO', 'PAGO', 'AJUSTE'];
const TIPO_LABEL = {
  DEPOSITO: 'Depósito', RETIRO: 'Retiro', TRANSFERENCIA_IN: 'Transferencia recibida', TRANSFERENCIA_OUT: 'Transferencia enviada',
  ANTICIPO: 'Anticipo', CAJA_CHICA: 'Caja chica', CHEQUE_EMITIDO: 'Cheque emitido', COMISION: 'Comisión',
  INTERES: 'Interés', COBRO: 'Cobro', PAGO: 'Pago', AJUSTE: 'Ajuste',
};
const EMPTY_MOV = { bankAccount: '', date: today(), type: 'DEPOSITO', amount: 0, counterpartAccount: '', counterAccountCode: '', description: '', reference: '', voucherNumber: '', voucherUrl: '', partyName: '', costCenter: '' };
const EMPTY_FILTER = { bankAccount: '', type: '', startDate: '', endDate: '', q: '', costCenter: '' };

/** Motivo por el que un movimiento no se puede corregir/anular desde esta pantalla (o null). */
const bloqueo = (m) => {
  if (m.voided) return 'Ya está anulado.';
  if (m.reconciled) return 'Está conciliado: reabre la conciliación para poder corregirlo.';
  if (m.sourceModel) return `Lo generó ${sourceLabel(m).toLowerCase()}: corrígelo en su documento de origen.`;
  return null;
};

export default function BankMovements() {
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [meta, setMeta] = useState({ total: 0, pages: 1, currentPage: 1 });
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState(EMPTY_FILTER);
  const [accounts, setAccounts] = useState([]);
  const [chart, setChart] = useState([]);
  const [costCenters, setCostCenters] = useState([]);
  const [loading, setLoading] = useState(false);
  const [show, setShow] = useState(false);
  const [editing, setEditing] = useState(null); // movimiento que se está corrigiendo
  const [form, setForm] = useState(EMPTY_MOV);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, limit: 50 };
      Object.entries(filter).forEach(([k, v]) => { if (v) params[k] = v; });
      const r = await api.get('/banks/transactions', { params });
      setItems(r.data?.items || []);
      setMeta({ total: r.data?.total || 0, pages: r.data?.pages || 1, currentPage: r.data?.currentPage || 1 });
    } catch (e) { toast.error(e.response?.data?.message || 'Error al cargar los movimientos'); }
    finally { setLoading(false); }
  }, [page, filter]);

  useEffect(() => {
    api.get('/banks/accounts').then((r) => setAccounts(r.data || [])).catch(() => {});
    api.get('/chart-of-accounts', { params: { active: true } }).then((r) => setChart(r.data || [])).catch(() => {});
    api.get('/cost-centers', { params: { active: true } }).then((r) => setCostCenters(r.data || [])).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const setFiltro = (patch) => { setPage(1); setFilter((f) => ({ ...f, ...patch })); };

  const openNew = () => {
    setEditing(null);
    setForm({ ...EMPTY_MOV, bankAccount: filter.bankAccount || accounts[0]?._id || '' });
    setShow(true);
  };

  const openEdit = (m) => {
    const motivo = bloqueo(m);
    if (motivo) return toast.error(motivo);
    setEditing(m);
    setForm({
      bankAccount: m.bankAccount?._id || m.bankAccount || '',
      date: (m.date || '').slice(0, 10) || today(),
      type: m.type,
      amount: m.amount,
      counterpartAccount: m.counterpartAccount || '',
      counterAccountCode: '',
      description: m.description || '',
      reference: m.reference || '',
      voucherNumber: m.voucherNumber || '',
      voucherUrl: m.voucherUrl || '',
      partyName: m.partyName || '',
      costCenter: m.costCenter?._id || m.costCenter || '',
    });
    setShow(true);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (!form.bankAccount) return toast.error('Selecciona la cuenta bancaria');
    if (!(Number(form.amount) > 0)) return toast.error('El monto debe ser mayor que cero');
    setBusy(true);
    try {
      const payload = { ...form };
      if (!payload.counterAccountCode) delete payload.counterAccountCode;
      if (!['TRANSFERENCIA_IN', 'TRANSFERENCIA_OUT'].includes(payload.type)) delete payload.counterpartAccount;
      if (editing) {
        await api.put(`/banks/transactions/${editing._id}`, payload);
        toast.success('Movimiento corregido: se anuló el anterior y se registró el corregido');
      } else {
        await api.post('/banks/transactions', payload);
        toast.success('Movimiento registrado');
      }
      setShow(false); setEditing(null); load();
    } catch (err) { toast.error(err.response?.data?.message || 'Error'); }
    finally { setBusy(false); }
  };

  const anular = async (m) => {
    const motivo = bloqueo(m);
    if (motivo) return toast.error(motivo);
    const razon = prompt('Motivo de la anulación (opcional):', '');
    if (razon === null) return;
    try {
      await api.post(`/banks/transactions/${m._id}/void`, { reason: razon });
      toast.success('Movimiento anulado');
      load();
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  const irAlOrigen = (m) => {
    const url = sourceDeepLink(m);
    if (url) return navigate(url);
    toast(`${sourceLabel(m)} — se consulta desde su propia pantalla`, { icon: 'ℹ️' });
  };

  // Solo cuentas de detalle: las agrupadoras no reciben movimientos.
  const cuentasElegibles = chart
    .filter((a) => a.allowsMovement !== false)
    .sort((x, y) => String(x.code || '').localeCompare(String(y.code || ''), undefined, { numeric: true }));

  const totalEntradas = items.filter((m) => !m.voided && m.direction > 0).reduce((s, m) => s + (+m.amount || 0), 0);
  const totalSalidas = items.filter((m) => !m.voided && m.direction < 0).reduce((s, m) => s + (+m.amount || 0), 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
          <HiOutlineArrowsRightLeft className="text-emerald-600" /> Movimientos bancarios
        </h1>
        <div className="flex gap-2">
          {/* El Excel baja el RANGO filtrado completo, no la página que se está viendo. */}
          <ExcelButton
            url="/banks/transactions/export.xlsx"
            params={filter}
            filename={`movimientos_bancarios_${filter.startDate || 'inicio'}_${filter.endDate || 'hoy'}.xlsx`}
            title="Descargar los movimientos del filtro actual"
          />
          <button onClick={openNew} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center gap-2"><HiOutlinePlus /> Nuevo movimiento</button>
        </div>
      </div>

      {/* Filtros */}
      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-3 grid grid-cols-2 md:grid-cols-6 gap-2 items-end">
        <label className="text-xs text-slate-500">Cuenta
          <select value={filter.bankAccount} onChange={(e) => setFiltro({ bankAccount: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm">
            <option value="">Todas</option>{accounts.map((a) => <option key={a._id} value={a._id}>{a.name}</option>)}
          </select>
        </label>
        <label className="text-xs text-slate-500">Tipo
          <select value={filter.type} onChange={(e) => setFiltro({ type: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm">
            <option value="">Todos</option>{TIPOS.map((t) => <option key={t} value={t}>{TIPO_LABEL[t]}</option>)}
          </select>
        </label>
        <label className="text-xs text-slate-500">Desde
          <input type="date" value={filter.startDate} onChange={(e) => setFiltro({ startDate: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm" />
        </label>
        <label className="text-xs text-slate-500">Hasta
          <input type="date" value={filter.endDate} onChange={(e) => setFiltro({ endDate: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm" />
        </label>
        <label className="text-xs text-slate-500">Centro de costo
          <select value={filter.costCenter} onChange={(e) => setFiltro({ costCenter: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm">
            <option value="">Todos</option>{costCenters.map((c) => <option key={c._id} value={c._id}>{c.code ? `${c.code} — ${c.name}` : c.name}</option>)}
          </select>
        </label>
        <label className="text-xs text-slate-500">Buscar
          <div className="relative mt-1">
            <HiOutlineMagnifyingGlass className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={filter.q} onChange={(e) => setFiltro({ q: e.target.value })} placeholder="Persona, comprobante, cheque…" className="w-full border border-slate-200 rounded-xl pl-8 pr-3 py-2 text-sm" />
          </div>
        </label>
      </div>

      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-x-auto">
        <table className="tbl">
          <thead className="bg-emerald-50 text-xs uppercase"><tr>
            <th className="px-3 py-2 text-left">Fecha</th><th className="px-3 py-2 text-left">Cuenta</th>
            <th className="px-3 py-2 text-left">Tipo</th><th className="px-3 py-2 text-left">Persona</th>
            <th className="px-3 py-2 text-left">Descripción</th>
            <th className="px-3 py-2 text-left">Referencia</th><th className="px-3 py-2 text-left">Origen</th>
            <th className="px-3 py-2 text-right">Entrada</th><th className="px-3 py-2 text-right">Salida</th>
            <th className="px-3 py-2 text-center">Estado</th><th className="px-3 py-2"></th>
          </tr></thead>
          <tbody>
            {items.map((m) => {
              const motivo = bloqueo(m);
              const deLote = !!m.sourceModel;
              return (
                <tr key={m._id} className={`border-t hover:bg-slate-50 ${m.voided ? 'text-slate-400 line-through' : ''}`}>
                  <td className="px-3 py-2 whitespace-nowrap">{fmtDate(m.date)}</td>
                  <td className="px-3 py-2 text-xs">{m.bankAccount?.name || '—'}</td>
                  <td className="px-3 py-2 text-xs">{TIPO_LABEL[m.type] || m.type}</td>
                  <td className="px-3 py-2 text-xs max-w-[200px] truncate" title={m.partyName || ''}>{m.partyName || '—'}</td>
                  <td className="px-3 py-2 text-xs max-w-[260px] truncate" title={m.description}>{m.description || '—'}</td>
                  <td className="px-3 py-2 text-xs font-mono">{m.reference || m.voucherNumber || m.checkNumber || '—'}</td>
                  <td className="px-3 py-2 text-xs">
                    {deLote
                      ? <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">{sourceLabel(m)}</span>
                      : <span className="px-2 py-0.5 rounded-full bg-sky-50 text-sky-700">Manual</span>}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-emerald-700">{m.direction > 0 ? `$${fmt(m.amount)}` : ''}</td>
                  <td className="px-3 py-2 text-right font-mono text-rose-600">{m.direction < 0 ? `$${fmt(m.amount)}` : ''}</td>
                  <td className="px-3 py-2 text-center text-[11px]">
                    {m.voided
                      ? <span className="px-2 py-0.5 rounded-full bg-rose-100 text-rose-700" title={m.voidReason || ''}>Anulado</span>
                      : m.reconciled
                        ? <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">Conciliado</span>
                        : <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">Registrado</span>}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1.5">
                      {deLote && (
                        <button onClick={() => irAlOrigen(m)} className="text-slate-500 hover:text-slate-700" title={sourceActionLabel(m) || `Origen: ${sourceLabel(m)}`}>
                          <HiOutlineArrowTopRightOnSquare className="w-5 h-5" />
                        </button>
                      )}
                      <button
                        onClick={() => openEdit(m)}
                        disabled={!!motivo}
                        title={motivo || 'Corregir'}
                        className="text-sky-600 disabled:text-slate-300 disabled:cursor-not-allowed"
                      ><HiOutlinePencilSquare className="w-5 h-5" /></button>
                      <button
                        onClick={() => anular(m)}
                        disabled={!!motivo}
                        title={motivo || 'Anular'}
                        className="text-rose-500 disabled:text-slate-300 disabled:cursor-not-allowed"
                      ><HiOutlineTrash className="w-5 h-5" /></button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {!items.length && !loading && <tr><td colSpan={11} className="px-3 py-8 text-center text-slate-400">No hay movimientos con esos filtros</td></tr>}
            {loading && <tr><td colSpan={11} className="px-3 py-8 text-center text-slate-400">Cargando…</td></tr>}
          </tbody>
          {!!items.length && (
            <tfoot><tr className="border-t bg-slate-50 font-semibold">
              <td colSpan={7} className="px-3 py-2 text-right text-xs">Total de la página ({items.length} de {meta.total}):</td>
              <td className="px-3 py-2 text-right font-mono text-emerald-700">${fmt(totalEntradas)}</td>
              <td className="px-3 py-2 text-right font-mono text-rose-600">${fmt(totalSalidas)}</td>
              <td colSpan={2}></td>
            </tr></tfoot>
          )}
        </table>
      </div>

      {meta.pages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="px-3 py-1.5 text-sm bg-white border rounded-lg disabled:opacity-40">Anterior</button>
          <span className="text-sm text-slate-600">Página {meta.currentPage} de {meta.pages}</span>
          <button onClick={() => setPage((p) => Math.min(meta.pages, p + 1))} disabled={page >= meta.pages} className="px-3 py-1.5 text-sm bg-white border rounded-lg disabled:opacity-40">Siguiente</button>
        </div>
      )}

      <Modal isOpen={show} onClose={() => { setShow(false); setEditing(null); }} title={editing ? 'Corregir movimiento' : 'Nuevo movimiento bancario'} size="lg">
        <form onSubmit={submit} className="space-y-3">
          {editing && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              Al guardar se <b>anula</b> el movimiento actual (con el reverso de su asiento) y se registra uno nuevo con estos datos. Los asientos no se editan: queda la traza de la corrección.
            </p>
          )}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <Field label="Cuenta bancaria" required>
              <select required value={form.bankAccount} onChange={(e) => setForm({ ...form, bankAccount: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5">
                <option value="">Seleccione…</option>{accounts.map((a) => <option key={a._id} value={a._id}>{a.name}</option>)}
              </select>
            </Field>
            <Field label="Fecha" required>
              <input type="date" required value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" />
            </Field>
            <Field label="Tipo" required>
              <select required value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} disabled={!!editing} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 disabled:bg-slate-100">
                {TIPOS.map((t) => <option key={t} value={t}>{TIPO_LABEL[t]}</option>)}
              </select>
            </Field>
            <Field label="Monto" required>
              <NumericInput step="0.01" required value={form.amount} onChange={(e) => setForm({ ...form, amount: +e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-right" />
            </Field>
            {['TRANSFERENCIA_IN', 'TRANSFERENCIA_OUT'].includes(form.type) && (
              <Field label="Cuenta contraparte" required className="col-span-2">
                <select required value={form.counterpartAccount} onChange={(e) => setForm({ ...form, counterpartAccount: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5">
                  <option value="">Seleccione…</option>{accounts.filter((a) => a._id !== form.bankAccount).map((a) => <option key={a._id} value={a._id}>{a.name}</option>)}
                </select>
              </Field>
            )}
            <Field label="N° comprobante"><input value={form.voucherNumber} onChange={(e) => setForm({ ...form, voucherNumber: e.target.value })} placeholder="Papeleta / transferencia" className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
            <Field label="Persona (a nombre de quién)">
              <input value={form.partyName} onChange={(e) => setForm({ ...form, partyName: e.target.value })} placeholder="Cliente / proveedor / beneficiario" className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" />
            </Field>
            <Field label="Centro de costo">
              <select value={form.costCenter} onChange={(e) => setForm({ ...form, costCenter: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5">
                <option value="">Sin centro</option>{costCenters.map((c) => <option key={c._id} value={c._id}>{c.code ? `${c.code} — ${c.name}` : c.name}</option>)}
              </select>
            </Field>
            <Field label="Referencia" className="col-span-2"><input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
            <Field label="Descripción" className="col-span-2 md:col-span-3"><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
            <Field label="Contrapartida contable (opcional)" className="col-span-2 md:col-span-3">
              {/* El backend espera el CÓDIGO de la cuenta (counterAccountCode), no su id. */}
              <SearchableSelect
                options={cuentasElegibles}
                value={form.counterAccountCode}
                onChange={(v) => setForm({ ...form, counterAccountCode: v })}
                getValue={(a) => a.code}
                getLabel={(a) => (a.code ? `${a.code} — ${a.name}` : a.name)}
                getSearchText={(a) => `${a.code || ''} ${a.name || ''} ${a.type || ''}`}
                placeholder="Predeterminada según el tipo"
                searchPlaceholder="Buscar por código o nombre…"
                size="sm"
                menuMinWidth={420}
                allowClear
              />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => { setShow(false); setEditing(null); }} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button>
            <button disabled={busy} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 disabled:opacity-50">
              {busy ? 'Guardando…' : (editing ? 'Guardar corrección' : 'Registrar')}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
