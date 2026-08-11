import { useEffect, useMemo, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import Field from '../../components/Field';
import { HiOutlinePlus, HiOutlineBanknotes, HiOutlineEye, HiOutlineXMark } from 'react-icons/hi2';
import { fmt, fmtDate, today } from './_utils';
import NumericInput from '../../components/NumericInput';
import SearchableSelect from '../../components/SearchableSelect';
import JournalEntryViewModal from '../../components/JournalEntryViewModal';
import DateInput from '../../components/DateInput';

/**
 * PRÉSTAMOS Y DESCUENTOS AL EMPLEADO.
 *
 * Cubre lo que la empresa entrega (préstamo, anticipo, seguro que paga por el empleado) y lo
 * que solo se descuenta del rol (multa, descuento, impuesto a la renta, cuotas del IESS).
 *
 * Cada registro genera SU asiento: debe la cuenta por cobrar del tipo, haber el origen del
 * dinero (banco, caja, caja chica) o la contrapartida indicada. La cuota entra sola al rol de
 * pagos del mes con el nombre del préstamo, y al cerrarlo se acredita esa MISMA cuenta.
 */
const EMPTY = {
  employee: '',
  type: 'EMPRESA',
  principal: 0,
  installmentsCount: 12,
  grantDate: today(),
  description: '',
  disbursementMethod: 'TRANSFERENCIA',
  bankAccount: '',
  checkNumber: '',
  reference: '',
  receivableAccount: '',
  counterAccount: '',
};

const METODO_LABEL = {
  TRANSFERENCIA: 'Transferencia bancaria',
  CHEQUE: 'Cheque',
  EFECTIVO: 'Efectivo (caja)',
  CAJA_CHICA: 'Caja chica',
  SIN_DESEMBOLSO: 'Sin desembolso (solo se descuenta)',
};

export default function EmployeeLoans() {
  const [list, setList] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [banks, setBanks] = useState([]);
  const [chart, setChart] = useState([]);
  const [tipos, setTipos] = useState([]);
  const [show, setShow] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [entryLoan, setEntryLoan] = useState(null); // préstamo cuyo asiento se está viendo

  const load = async () => {
    try { const r = await api.get('/payroll/loans'); setList(r.data || []); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  useEffect(() => {
    api.get('/payroll/employees').then((r) => setEmployees(r.data || [])).catch(() => {});
    api.get('/banks/accounts').then((r) => setBanks(r.data || [])).catch(() => {});
    api.get('/chart-of-accounts', { params: { active: true } }).then((r) => setChart(r.data || [])).catch(() => {});
    api.get('/payroll/loans/types').then((r) => setTipos(r.data?.types || [])).catch(() => setTipos([]));
    load();
  }, []);

  const tipoDef = useMemo(() => tipos.find((t) => t.type === form.type), [tipos, form.type]);
  const cuentasElegibles = useMemo(
    () => chart.filter((a) => a.allowsMovement !== false)
      .sort((x, y) => String(x.code || '').localeCompare(String(y.code || ''), undefined, { numeric: true })),
    [chart]
  );
  const cuota = form.installmentsCount > 0 ? Number(form.principal || 0) / Number(form.installmentsCount) : 0;

  /** Al cambiar el tipo se propone su origen habitual (préstamo/anticipo se entregan; multa no). */
  const cambiarTipo = (type) => {
    const def = tipos.find((t) => t.type === type);
    setForm((f) => ({
      ...f,
      type,
      disbursementMethod: def ? (def.disburses ? 'TRANSFERENCIA' : 'SIN_DESEMBOLSO') : f.disbursementMethod,
      receivableAccount: '',   // se vuelve a proponer desde la configuración
      counterAccount: '',
    }));
  };

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (!(Number(form.principal) > 0)) return toast.error('El monto debe ser mayor que cero');
    if (['TRANSFERENCIA', 'CHEQUE'].includes(form.disbursementMethod) && !form.bankAccount) {
      return toast.error('Selecciona la cuenta bancaria desde la que sale el dinero');
    }
    if (form.disbursementMethod === 'SIN_DESEMBOLSO' && !form.counterAccount) {
      return toast.error('Sin desembolso hay que indicar la contrapartida contable');
    }
    setBusy(true);
    try {
      await api.post('/payroll/loans', {
        ...form,
        principal: Number(form.principal) || 0,
        installmentsCount: Number(form.installmentsCount) || 1,
        bankAccount: ['TRANSFERENCIA', 'CHEQUE'].includes(form.disbursementMethod) ? form.bankAccount : null,
        receivableAccount: form.receivableAccount || null,
        counterAccount: form.disbursementMethod === 'SIN_DESEMBOLSO' ? form.counterAccount : null,
      });
      toast.success('Registrado con su asiento contable');
      setShow(false); setForm(EMPTY); load();
    } catch (err) { toast.error(err.response?.data?.message || 'Error'); }
    finally { setBusy(false); }
  };

  const anular = async (l) => {
    const motivo = prompt('Motivo de la anulación:', '');
    if (motivo === null) return;
    try {
      await api.post(`/payroll/loans/${l._id}/void`, { reason: motivo });
      toast.success('Anulado: se reversó su asiento');
      load();
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  const etiquetaTipo = (t) => tipos.find((x) => x.type === t)?.label || t;
  const pendientes = (l) => (l.installments || []).filter((i) => !i.paid).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineBanknotes className="text-emerald-600" /> Préstamos y descuentos</h1>
          <p className="text-sm text-slate-500">Se contabilizan al registrarlos y su cuota entra sola al rol de pagos del mes.</p>
        </div>
        <button onClick={() => { setForm(EMPTY); setShow(true); }} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center gap-2"><HiOutlinePlus /> Nuevo</button>
      </div>
      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-x-auto">
        <table className="tbl">
          <thead className="bg-emerald-50 text-xs uppercase"><tr>
            <th className="px-3 py-2 text-left">Empleado</th><th className="px-3 py-2 text-left">Tipo</th>
            <th className="px-3 py-2 text-left">Fecha</th><th className="px-3 py-2 text-left">Origen</th>
            <th className="px-3 py-2 text-left">Cuenta</th>
            <th className="px-3 py-2 text-right">Monto</th>
            <th className="px-3 py-2 text-right">Cuota</th><th className="px-3 py-2 text-right">Saldo</th>
            <th className="px-3 py-2 text-center">Estado</th>
            <th className="px-3 py-2 text-center">Asiento</th>
            <th></th>
          </tr></thead>
          <tbody>
            {list.map((l) => (
              <tr key={l._id} className={`border-t ${l.status === 'ANULADO' ? 'text-slate-400 line-through' : ''}`}>
                <td className="px-3 py-2">{l.employee?.firstName} {l.employee?.lastName}</td>
                <td className="px-3 py-2 text-xs">{etiquetaTipo(l.type)}</td>
                <td className="px-3 py-2">{fmtDate(l.grantDate)}</td>
                <td className="px-3 py-2 text-xs">
                  {METODO_LABEL[l.disbursementMethod] || '—'}
                  {l.checkNumber ? <span className="text-slate-400 font-mono"> · cheque {l.checkNumber}</span> : ''}
                </td>
                <td className="px-3 py-2 text-xs font-mono" title={l.receivableAccount?.name || ''}>{l.receivableAccount?.code || '—'}</td>
                <td className="px-3 py-2 text-right font-mono">${fmt(l.principal)}</td>
                <td className="px-3 py-2 text-right font-mono">
                  ${fmt(l.installmentAmount)}
                  <span className="text-[10px] text-slate-400 block">{pendientes(l)} pendiente(s)</span>
                </td>
                <td className="px-3 py-2 text-right font-mono font-semibold">${fmt(l.balance)}</td>
                <td className="px-3 py-2 text-center text-xs">{l.status}</td>
                <td className="px-3 py-2 text-center">
                  <button onClick={() => setEntryLoan(l)} className="inline-flex items-center gap-1 text-slate-600 hover:text-emerald-600 text-xs" title="Ver el asiento contable del préstamo (solo lectura)"><HiOutlineEye className="w-4 h-4" /> Ver</button>
                </td>
                <td className="px-3 py-2 text-right">
                  {l.status === 'ACTIVO' && (
                    <button onClick={() => anular(l)} className="text-rose-600" title="Anular (reversa el asiento)"><HiOutlineXMark className="w-4 h-4" /></button>
                  )}
                </td>
              </tr>
            ))}
            {!list.length && <tr><td colSpan={11} className="px-3 py-8 text-center text-slate-400">Sin préstamos ni descuentos registrados.</td></tr>}
          </tbody>
        </table>
      </div>

      <JournalEntryViewModal
        isOpen={!!entryLoan}
        onClose={() => setEntryLoan(null)}
        source={entryLoan ? { model: 'EmployeeLoan', ref: entryLoan._id } : null}
        title="Asiento del préstamo"
        emptyHint="Este préstamo se registró antes de que el sistema contabilizara el otorgamiento, por eso no tiene asiento propio. Su recuperación sí se refleja en el asiento del rol de pagos."
      />

      <Modal isOpen={show} onClose={() => setShow(false)} title="Nuevo préstamo o descuento" size="lg">
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Empleado" required>
              <select required value={form.employee} onChange={(e) => setForm({ ...form, employee: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5">
                <option value="">Seleccione…</option>
                {employees.map((e) => <option key={e._id} value={e._id}>{e.firstName} {e.lastName}</option>)}
              </select>
            </Field>
            <Field label="Tipo" required>
              <select value={form.type} onChange={(e) => cambiarTipo(e.target.value)} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5">
                {tipos.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
              </select>
            </Field>
            <Field label="Fecha" required>
              <DateInput required value={form.grantDate} onChange={(e) => setForm({ ...form, grantDate: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" />
            </Field>
            <Field label="Monto" required>
              <NumericInput step="0.01" required value={form.principal} onChange={(e) => setForm({ ...form, principal: +e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-right" />
            </Field>
            <Field label="N° de cuotas" required>
              <NumericInput required min="1" value={form.installmentsCount} onChange={(e) => setForm({ ...form, installmentsCount: +e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-right" />
            </Field>
            <div className="flex items-end pb-1 text-sm text-slate-600">
              Cuota mensual estimada: <b className="font-mono ml-1">${fmt(cuota)}</b>
            </div>
          </div>

          {/* Origen del dinero: de dónde sale, o si no sale nada ahora. */}
          <div className="border border-emerald-100 rounded-xl p-3 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Origen del dinero" required>
                <select value={form.disbursementMethod} onChange={(e) => setForm({ ...form, disbursementMethod: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5">
                  {Object.entries(METODO_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </Field>
              {['TRANSFERENCIA', 'CHEQUE'].includes(form.disbursementMethod) && (
                <Field label="Cuenta bancaria" required>
                  <select required value={form.bankAccount} onChange={(e) => setForm({ ...form, bankAccount: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5">
                    <option value="">Seleccione…</option>
                    {banks.map((b) => <option key={b._id} value={b._id}>{b.name}{b.bank ? ` — ${b.bank}` : ''}</option>)}
                  </select>
                </Field>
              )}
              {form.disbursementMethod === 'CHEQUE' && (
                <Field label="N° de cheque">
                  <input value={form.checkNumber} onChange={(e) => setForm({ ...form, checkNumber: e.target.value })} placeholder="En blanco = el siguiente disponible" className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" />
                </Field>
              )}
              {form.disbursementMethod === 'SIN_DESEMBOLSO' && (
                <Field label="Contrapartida contable (haber)" required className="sm:col-span-2">
                  <SearchableSelect
                    options={cuentasElegibles}
                    value={form.counterAccount}
                    onChange={(v) => setForm({ ...form, counterAccount: v })}
                    getLabel={(a) => (a.code ? `${a.code} — ${a.name}` : a.name)}
                    getSearchText={(a) => `${a.code || ''} ${a.name || ''}`}
                    placeholder="Contra qué cuenta se registra"
                    searchPlaceholder="Buscar por código o nombre…"
                    size="sm"
                    menuMinWidth={420}
                  />
                </Field>
              )}
              {form.disbursementMethod !== 'SIN_DESEMBOLSO' && (
                <Field label="Referencia / comprobante" className="sm:col-span-2">
                  <input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" />
                </Field>
              )}
            </div>

            {/* El asiento a la vista: qué se debita y qué se acredita, antes de guardar. */}
            <div className="text-xs bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 space-y-1">
              <p>
                <b>Debe</b> {tipoDef?.account
                  ? <span className="font-mono">{tipoDef.account.code} — {tipoDef.account.name}</span>
                  : <span className="text-amber-700">sin cuenta configurada para este tipo (elígela abajo o configúrala en Nómina → Cuentas Contables)</span>}
                {' '}· <b>Haber</b> {METODO_LABEL[form.disbursementMethod].toLowerCase()}
              </p>
              <p className="text-slate-500">
                Al cerrar el rol del mes, la cuota descontada acredita esa misma cuenta: así el préstamo se cancela solo.
              </p>
            </div>

            <Field label="Cuenta por cobrar / descuento (debe) — opcional">
              <SearchableSelect
                options={cuentasElegibles}
                value={form.receivableAccount}
                onChange={(v) => setForm({ ...form, receivableAccount: v })}
                getLabel={(a) => (a.code ? `${a.code} — ${a.name}` : a.name)}
                getSearchText={(a) => `${a.code || ''} ${a.name || ''}`}
                placeholder={tipoDef?.account ? `Por defecto: ${tipoDef.account.code} — ${tipoDef.account.name}` : 'Elige la cuenta'}
                searchPlaceholder="Buscar por código o nombre…"
                size="sm"
                menuMinWidth={420}
                allowClear
              />
            </Field>
          </div>

          <Field label="Descripción"><input placeholder="Concepto" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setShow(false)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button>
            <button disabled={busy} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 disabled:opacity-50">{busy ? 'Guardando…' : 'Guardar'}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
