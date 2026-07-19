import { useEffect, useRef, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import Field from '../../components/Field';
import {
  HiOutlinePlus, HiOutlineCalculator, HiOutlineLockClosed, HiOutlineCheck,
  HiOutlineTrash, HiOutlinePencilSquare, HiOutlineBanknotes, HiOutlineEye,
  HiOutlineLockOpen,
} from 'react-icons/hi2';
import { fmt, fmtDate, today } from './_utils';
import NumericInput from '../../components/NumericInput';
import JournalEntryViewModal from '../../components/JournalEntryViewModal';
import { newIdempotencyKey, withIdempotencyKey } from '../../utils/idempotency';
import useDocDeepLink from '../../hooks/useDocDeepLink';

/** Último día del mes (fecha contable por defecto del cierre). */
const lastDayOfMonth = (year, month) => new Date(year, month, 0).toISOString().slice(0, 10);

const MONTHS = ['', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const PERIOD_TYPES = [
  ['MENSUAL', 'Rol mensual', 'Mes completo (todos los empleados).'],
  ['QUINCENA_1', 'Quincena (anticipo)', 'Anticipo del sueldo a los empleados quincenales. Solo sueldo, sin IESS ni beneficios.'],
  ['CIERRE_MES', 'Cierre de mes', 'Liquida el mes completo y descuenta el anticipo ya pagado en la quincena.'],
];
const PERIOD_LABEL = { MENSUAL: 'Mensual', QUINCENA_1: 'Quincena', CIERRE_MES: 'Cierre de mes' };
const STATUS_STYLE = {
  BORRADOR: 'bg-amber-100 text-amber-700',
  CERRADO: 'bg-emerald-100 text-emerald-700',
  PAGADO: 'bg-blue-100 text-blue-700',
  ANULADO: 'bg-slate-200 text-slate-600',
};

// Valor de la hora normal (base mensual / 240) para calcular horas extra.
const hourlyRate = (monthly) => (Number(monthly) || 0) / 240;

// Chip de resumen (etiqueta + valor).
function Chip({ label, value, tone = 'slate' }) {
  const tones = { slate: 'bg-slate-50 text-slate-700', emerald: 'bg-emerald-50 text-emerald-700', rose: 'bg-rose-50 text-rose-700', sky: 'bg-sky-50 text-sky-700' };
  return (
    <div className={`rounded-xl px-3 py-2 ${tones[tone]}`}>
      <div className="text-[11px] uppercase tracking-wide opacity-70">{label}</div>
      <div className="font-mono font-semibold text-sm">{value}</div>
    </div>
  );
}

/**
 * Detalle editable de un empleado dentro del rol. Trabaja sobre un BORRADOR local
 * y persiste todo con un único guardado (patch). NO pide cuentas contables: los
 * rubros se eligen del catálogo de conceptos y el backend resuelve la cuenta.
 */
function EmployeeDetail({ item, concepts, editable, onSave, onClose }) {
  const monthly = Number(item.monthlySalary) || Number(item.baseSalary) || 0;
  const [draft, setDraft] = useState(() => ({
    absenceDays: item.absenceDays || 0,
    vacaciones: item.vacaciones || 0,
    vacContraProv: (item.vacacionesContraProvision || 0) > 0,
    prestamoEmpresa: item.prestamoEmpresa || 0,
    anticipos: item.anticipos || 0,
    multas: item.multas || 0,
    otherDeductions: item.otherDeductions || 0,
    earnings: (item.earnings || []).map((e) => ({ ...e })),
    deductions: (item.deductions || []).map((d) => ({ ...d })),
  }));
  const [busy, setBusy] = useState(false);
  // Composer de nuevo rubro flexible.
  const [newEarnConcept, setNewEarnConcept] = useState('');
  const [newEarnAmount, setNewEarnAmount] = useState('');
  const [newEarnHours, setNewEarnHours] = useState('');
  const [newDedConcept, setNewDedConcept] = useState('');
  const [newDedAmount, setNewDedAmount] = useState('');

  const ingresoConcepts = concepts.filter((c) => c.type === 'INGRESO' && c.active !== false);
  const egresoConcepts = concepts.filter((c) => c.type === 'EGRESO' && c.active !== false);
  const conceptById = (id) => concepts.find((c) => String(c._id) === String(id));

  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const daysWorked = Math.max(0, 30 - (Number(draft.absenceDays) || 0));

  const selectedEarnConcept = conceptById(newEarnConcept);
  const isOvertime = selectedEarnConcept?.category === 'HORAS_EXTRAS';
  const overtimeAmount = isOvertime
    ? +(hourlyRate(monthly) * (Number(newEarnHours) || 0) * (1 + (Number(selectedEarnConcept.rate) || 0) / 100)).toFixed(2)
    : 0;

  const addEarning = () => {
    const c = selectedEarnConcept;
    if (!c) return toast.error('Elige un concepto de ingreso');
    const amount = isOvertime ? overtimeAmount : +(Number(newEarnAmount) || 0);
    if (!(amount > 0)) return toast.error('Ingresa un valor mayor a 0');
    const name = isOvertime ? `${c.name} (${Number(newEarnHours) || 0}h)` : c.name;
    set({ earnings: [...draft.earnings, { concept: c._id, code: c.code, name, amount }] });
    setNewEarnConcept(''); setNewEarnAmount(''); setNewEarnHours('');
  };
  const addDeduction = () => {
    const c = conceptById(newDedConcept);
    if (!c) return toast.error('Elige un concepto de egreso');
    const amount = +(Number(newDedAmount) || 0);
    if (!(amount > 0)) return toast.error('Ingresa un valor mayor a 0');
    set({ deductions: [...draft.deductions, { concept: c._id, code: c.code, name: c.name, amount }] });
    setNewDedConcept(''); setNewDedAmount('');
  };
  const removeEarning = (i) => set({ earnings: draft.earnings.filter((_, idx) => idx !== i) });
  const removeDeduction = (i) => set({ deductions: draft.deductions.filter((_, idx) => idx !== i) });

  const save = async () => {
    setBusy(true);
    try {
      await onSave({
        absenceDays: +(Number(draft.absenceDays) || 0),
        vacaciones: +(Number(draft.vacaciones) || 0),
        vacacionesContraProvision: draft.vacContraProv ? +(Number(draft.vacaciones) || 0) : 0,
        prestamoEmpresa: +(Number(draft.prestamoEmpresa) || 0),
        anticipos: +(Number(draft.anticipos) || 0),
        multas: +(Number(draft.multas) || 0),
        otherDeductions: +(Number(draft.otherDeductions) || 0),
        earnings: draft.earnings,
        deductions: draft.deductions,
      });
    } finally { setBusy(false); }
  };

  // Vista previa de ingresos/egresos (el backend recalcula el valor definitivo).
  const flexEarn = draft.earnings.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const flexDed = draft.deductions.reduce((s, d) => s + (Number(d.amount) || 0), 0);
  const earnedBase = +(monthly * (daysWorked / 30)).toFixed(2);
  const num = (v) => (editable
    ? <NumericInput step="0.01" min="0" value={v.value} onChange={(e) => set({ [v.key]: e.target.value })} className="w-24 border border-slate-200 rounded px-2 py-1 text-right" />
    : <span className="font-mono">{fmt(item[v.key])}</span>);

  return (
    <div className="space-y-4">
      {/* Resumen */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Chip label="Sueldo mensual" value={`$${fmt(monthly)}`} />
        <Chip label="Días laborados" value={daysWorked} tone="sky" />
        <Chip label="Sueldo ganado" value={`$${fmt(earnedBase)}`} tone="emerald" />
        <Chip label="Neto (guardado)" value={`$${fmt(item.netoPagar)}`} tone="emerald" />
      </div>
      {!item.departmentRef && (
        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          Este empleado no tiene <b>departamento parametrizado</b>: el gasto usará las cuentas generales de nómina. Asigna un departamento en su ficha para clasificar el gasto (Admin/Ventas/Costos).
        </div>
      )}

      {/* Días, ausencias y vacaciones */}
      <section className="border border-slate-200 rounded-xl p-3">
        <h3 className="text-sm font-semibold text-slate-700 mb-2">Días, ausencias y vacaciones</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field label="Ausencias (días)">
            {editable
              ? <NumericInput min="0" max="30" value={draft.absenceDays} onChange={(e) => set({ absenceDays: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3 py-2" />
              : <span className="font-mono">{item.absenceDays || 0}</span>}
          </Field>
          <Field label="Vacaciones gozadas ($)">
            {editable
              ? <NumericInput step="0.01" min="0" value={draft.vacaciones} onChange={(e) => set({ vacaciones: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3 py-2" />
              : <span className="font-mono">{fmt(item.vacaciones)}</span>}
          </Field>
          <Field label="Pago de vacaciones">
            <label className="flex items-center gap-2 text-xs text-slate-600 mt-2">
              <input type="checkbox" disabled={!editable} checked={draft.vacContraProv} onChange={(e) => set({ vacContraProv: e.target.checked })} />
              Contra provisión acumulada
            </label>
          </Field>
        </div>
        <p className="text-[11px] text-slate-400 mt-1">Las ausencias reducen el sueldo proporcional; las vacaciones no reducen días. Si se pagan contra provisión, disminuyen «Vacaciones por pagar» en vez de generar gasto nuevo.</p>
      </section>

      {/* Ingresos */}
      <section className="border border-emerald-200 rounded-xl p-3">
        <h3 className="text-sm font-semibold text-emerald-700 mb-2">Ingresos</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 text-xs">
          <Row label="Sueldo ganado" value={earnedBase} />
          <Row label="Décimo tercero" value={item.decimoTercero} />
          <Row label="Décimo cuarto" value={item.decimoCuarto} />
          <Row label="Fondos de reserva" value={item.fondosReserva} />
        </div>
        <div className="mt-2">
          {draft.earnings.map((e, i) => (
            <div key={i} className="flex items-center gap-2 text-sm py-1 border-t border-emerald-50">
              <span className="flex-1">{e.name || e.code}</span>
              {editable
                ? <NumericInput step="0.01" min="0" value={e.amount} onChange={(ev) => set({ earnings: draft.earnings.map((x, idx) => idx === i ? { ...x, amount: +ev.target.value } : x) })} className="w-24 border border-slate-200 rounded px-2 py-1 text-right" />
                : <span className="font-mono w-24 text-right">{fmt(e.amount)}</span>}
              {editable && <button onClick={() => removeEarning(i)} className="text-rose-500" title="Quitar"><HiOutlineTrash className="w-4 h-4" /></button>}
            </div>
          ))}
          {editable && (
            <div className="flex flex-wrap items-end gap-2 mt-2 bg-emerald-50/40 rounded-lg p-2">
              <div className="flex-1 min-w-40">
                <label className="text-[11px] text-slate-500">Concepto de ingreso</label>
                <select value={newEarnConcept} onChange={(e) => { setNewEarnConcept(e.target.value); setNewEarnHours(''); setNewEarnAmount(''); }} className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
                  <option value="">Seleccione…</option>
                  {ingresoConcepts.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
                </select>
              </div>
              {isOvertime ? (
                <>
                  <div>
                    <label className="text-[11px] text-slate-500">Horas</label>
                    <NumericInput step="0.5" min="0" value={newEarnHours} onChange={(e) => setNewEarnHours(e.target.value)} className="w-20 border border-slate-200 rounded-lg px-2 py-1.5 text-right" />
                  </div>
                  <div className="text-xs text-slate-500 pb-1.5">≈ <b className="font-mono">${fmt(overtimeAmount)}</b> ({selectedEarnConcept.rate}% · ${fmt(hourlyRate(monthly))}/h)</div>
                </>
              ) : (
                <div>
                  <label className="text-[11px] text-slate-500">Valor ($)</label>
                  <NumericInput step="0.01" min="0" value={newEarnAmount} onChange={(e) => setNewEarnAmount(e.target.value)} className="w-24 border border-slate-200 rounded-lg px-2 py-1.5 text-right" />
                </div>
              )}
              <button onClick={addEarning} className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-sm flex items-center gap-1"><HiOutlinePlus className="w-4 h-4" /> Agregar</button>
            </div>
          )}
        </div>
      </section>

      {/* Egresos */}
      <section className="border border-rose-200 rounded-xl p-3">
        <h3 className="text-sm font-semibold text-rose-700 mb-2">Egresos y descuentos</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 text-xs">
          <Row label="IESS personal" value={item.iessPersonal} rose />
          <Row label="Impuesto a la renta" value={item.impuestoRenta} rose />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-2">
          <Field label="Préstamo/anticipo empresa">{num({ key: 'prestamoEmpresa', value: draft.prestamoEmpresa })}</Field>
          <Field label="Anticipo de sueldo">{num({ key: 'anticipos', value: draft.anticipos })}</Field>
          <Field label="Multas">{num({ key: 'multas', value: draft.multas })}</Field>
        </div>
        <div className="mt-2">
          {draft.deductions.map((d, i) => (
            <div key={i} className="flex items-center gap-2 text-sm py-1 border-t border-rose-50">
              <span className="flex-1">{d.name || d.code}</span>
              {editable
                ? <NumericInput step="0.01" min="0" value={d.amount} onChange={(ev) => set({ deductions: draft.deductions.map((x, idx) => idx === i ? { ...x, amount: +ev.target.value } : x) })} className="w-24 border border-slate-200 rounded px-2 py-1 text-right" />
                : <span className="font-mono w-24 text-right">{fmt(d.amount)}</span>}
              {editable && <button onClick={() => removeDeduction(i)} className="text-rose-500" title="Quitar"><HiOutlineTrash className="w-4 h-4" /></button>}
            </div>
          ))}
          {editable && (
            <div className="flex flex-wrap items-end gap-2 mt-2 bg-rose-50/40 rounded-lg p-2">
              <div className="flex-1 min-w-40">
                <label className="text-[11px] text-slate-500">Concepto de egreso</label>
                <select value={newDedConcept} onChange={(e) => setNewDedConcept(e.target.value)} className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
                  <option value="">Seleccione…</option>
                  {egresoConcepts.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <label className="text-[11px] text-slate-500">Valor ($)</label>
                <NumericInput step="0.01" min="0" value={newDedAmount} onChange={(e) => setNewDedAmount(e.target.value)} className="w-24 border border-slate-200 rounded-lg px-2 py-1.5 text-right" />
              </div>
              <button onClick={addDeduction} className="px-3 py-1.5 bg-rose-600 text-white rounded-lg text-sm flex items-center gap-1"><HiOutlinePlus className="w-4 h-4" /> Agregar</button>
            </div>
          )}
        </div>
      </section>

      {/* Aportes patronales y provisiones (informativo, no editable) */}
      <section className="border border-slate-200 rounded-xl p-3">
        <h3 className="text-sm font-semibold text-slate-700 mb-2">Aportes patronales y provisiones (empresa)</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 text-xs">
          <Row label="Aporte patronal IESS" value={(item.iessPatronal || 0) + (item.iece || 0) + (item.secap || 0)} />
          <Row label="Prov. décimo tercero" value={item.provDecimoTercero} />
          <Row label="Prov. décimo cuarto" value={item.provDecimoCuarto} />
          <Row label="Prov. vacaciones" value={item.provVacaciones} />
          <Row label="Prov. fondos reserva" value={item.provFondosReserva} />
        </div>
      </section>

      {/* Totales + acciones */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
        <div className="flex gap-4 text-sm">
          <span>Ingresos: <b className="font-mono text-emerald-700">${fmt(item.totalIngresos)}</b></span>
          <span>Egresos: <b className="font-mono text-rose-600">${fmt(item.totalEgresos)}</b></span>
          <span>Neto: <b className="font-mono">${fmt(item.netoPagar)}</b></span>
          {editable && (flexEarn > 0 || flexDed > 0) && <span className="text-[11px] text-slate-400">Los totales se actualizan al guardar.</span>}
        </div>
        <div className="flex gap-2">
          <button onClick={onClose} className="px-4 py-2 bg-slate-200 rounded-xl text-sm">Cerrar</button>
          {editable && <button onClick={save} disabled={busy} className="px-4 py-2 bg-emerald-600 text-white rounded-xl text-sm disabled:opacity-60">{busy ? 'Guardando…' : 'Guardar y recalcular'}</button>}
        </div>
      </div>
      <p className="text-[11px] text-slate-400">Al guardar, el sistema recalcula IESS, impuesto a la renta, décimos y provisiones con las tasas/tabla configuradas. No se eligen cuentas contables aquí: salen del concepto y del departamento al cerrar.</p>
    </div>
  );
}

function Row({ label, value, rose }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-slate-500">{label}</span>
      <span className={`font-mono ${rose ? 'text-rose-600' : ''}`}>{fmt(value)}</span>
    </div>
  );
}

export default function Payroll() {
  const [year, setYear] = useState(new Date().getFullYear());
  const [list, setList] = useState([]);
  const [show, setShow] = useState(false);
  const [form, setForm] = useState({ year: new Date().getFullYear(), month: new Date().getMonth() + 1, periodType: 'MENSUAL' });
  const [fondosPending, setFondosPending] = useState(null); // { list, year, month, periodType }
  const [selected, setSelected] = useState(null);
  const [banks, setBanks] = useState([]);
  const [concepts, setConcepts] = useState([]);
  const [payModal, setPayModal] = useState(null);
  const [closeModal, setCloseModal] = useState(null);
  const [showEntry, setShowEntry] = useState(false);
  const [cashBusy, setCashBusy] = useState(false);
  const cashKeyRef = useRef(null); // clave de idempotencia de la intención de pago en efectivo
  const [detailIdx, setDetailIdx] = useState(null); // índice del empleado abierto en detalle

  const load = async () => {
    try { const r = await api.get('/payroll', { params: { year } }); setList(r.data || []); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [year]);
  useEffect(() => {
    api.get('/banks/accounts').then((r) => setBanks(r.data || [])).catch(() => {});
    api.get('/payroll/concepts').then((r) => setConcepts(r.data || [])).catch(() => {});
  }, []);

  const generate = async (e) => {
    if (e?.preventDefault) e.preventDefault();
    try {
      const r = await api.post('/payroll/generate', form);
      toast.success('Rol generado');
      setShow(false); setSelected(r.data); load();
      // Empleados que cumplieron 1 año y aún no tienen definido el modo de fondos de reserva:
      // se pregunta MENSUALIZAR/ACUMULAR y luego se regenera para que el cálculo los incluya.
      const pend = r.data?.pendingFondosDecisions || [];
      if (pend.length) setFondosPending({ list: pend, year: form.year, month: form.month, periodType: form.periodType });
    } catch (err) { toast.error(err.response?.data?.message || 'Error'); }
  };

  // Define el modo de fondos de reserva de un empleado (desde el modal del aniversario).
  const decideFondos = async (employeeId, mode) => {
    try {
      await api.post(`/payroll/employees/${employeeId}/fondos-mode`, { mode });
      setFondosPending((fp) => {
        const rest = (fp?.list || []).filter((x) => String(x.employee) !== String(employeeId));
        if (rest.length) return { ...fp, list: rest };
        // Última decisión: regenerar el rol para incluir los fondos ya definidos.
        generate();
        return null;
      });
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  const open = async (p) => { const r = await api.get(`/payroll/${p._id}`); setSelected(r.data); };

  // Deep-link desde el Libro Mayor (?doc=<id>): abre la planilla de nómina.
  useDocDeepLink(async (id) => {
    try { await open({ _id: id }); }
    catch (e) { toast.error(e.response?.data?.message || 'No se encontró la planilla'); }
  });

  const saveItem = async (employeeId, patch) => {
    try {
      const r = await api.put(`/payroll/${selected._id}/item`, { employeeId, patch });
      setSelected(r.data); load(); toast.success('Recalculado');
      setDetailIdx(null);
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); throw e; }
  };

  // Cierre: el usuario elige la fecha CONTABLE (devengo) y la fecha PLANIFICADA de pago.
  // Esta última es el vencimiento de la obligación y alimenta el flujo de caja.
  const close = async () => {
    try {
      const r = await api.post(`/payroll/${selected._id}/close`, {
        accountingDate: closeModal.accountingDate,
        scheduledPaymentDate: closeModal.scheduledPaymentDate || null,
      });
      setSelected(r.data); setCloseModal(null); load();
      toast.success('Rol cerrado, contabilizado y con su obligación abierta');
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  const reopen = async () => {
    if (!confirm('¿Reabrir el rol? Se reversará el asiento de cierre y se anulará la obligación por pagar.')) return;
    try { const r = await api.post(`/payroll/${selected._id}/reopen`); setSelected(r.data); load(); toast.success('Rol reabierto'); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  /**
   * Pago en efectivo. La clave de idempotencia se guarda en un ref: si el intento falla
   * (p.ej. la red se cae sin saber si el pago entró), el reintento usa LA MISMA clave y el
   * backend hace replay en vez de pagar dos veces. Tras el éxito se descarta.
   */
  const markPaid = async () => {
    if (cashBusy) return;
    if (!confirm('¿Registrar el pago del saldo pendiente en EFECTIVO (contra Caja)? Se generará el asiento Sueldos por pagar → Caja.')) return;
    if (!cashKeyRef.current) cashKeyRef.current = newIdempotencyKey();
    setCashBusy(true);
    try {
      const r = await api.post(`/payroll/${selected._id}/pay`, { confirmNoBank: true }, withIdempotencyKey(cashKeyRef.current));
      cashKeyRef.current = null; // éxito: el próximo pago es otra intención
      setSelected(r.data); load();
      toast.success(r.data.idempotentReplay ? 'El pago ya estaba registrado' : 'Pagada en efectivo (Caja)');
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
    finally { setCashBusy(false); }
  };

  // Cambiar banco, fecha o importe es OTRA intención de pago ⇒ clave nueva.
  const setPayField = (patch) => setPayModal((m) => ({ ...m, ...patch, key: newIdempotencyKey() }));

  const payFromBank = async () => {
    if (!payModal?.bankAccountId) { toast.error('Selecciona un banco'); return; }
    if (payModal.busy) return; // evita el doble submit (la protección real está en backend)
    setPayModal((m) => ({ ...m, busy: true }));
    try {
      const r = await api.post(
        `/payroll/${selected._id}/pay`,
        {
          bankAccountId: payModal.bankAccountId,
          date: payModal.date,
          amount: payModal.amount ? Number(payModal.amount) : undefined,
        },
        withIdempotencyKey(payModal.key),
      );
      setSelected(r.data); setPayModal(null); load(); // al cerrar el modal se descarta la clave
      if (r.data.idempotentReplay) toast.success('El pago ya estaba registrado');
      else toast.success(r.data.status === 'PAGADO' ? 'Nómina pagada por completo' : 'Pago parcial registrado');
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error');
      // Se conserva la MISMA clave: reintentar esta intención no puede duplicar el pago.
      setPayModal((m) => (m ? { ...m, busy: false } : m));
    }
  };

  const editable = selected?.status === 'BORRADOR';
  const detailItem = detailIdx != null ? selected?.items?.[detailIdx] : null;
  // Pagado/pendiente los calcula el backend (virtuales del rol, espejo de la CxP, que es la
  // fuente de verdad del saldo). No se rederivan aquí para no discrepar con la cartera.
  const paidAmount = Number(selected?.paidAmount) || 0;
  const pending = Number(selected?.pendingAmount ?? selected?.totalNeto) || 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineCalculator className="text-emerald-600" /> Nómina</h1>
        <div className="flex gap-2 items-end">
          <Field label="Año"><NumericInput value={year} onChange={(e) => setYear(+e.target.value)} className="w-24 border border-slate-200 rounded-xl px-3.5 py-2" /></Field>
          <button onClick={() => setShow(true)} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center gap-2 h-[38px]"><HiOutlinePlus /> Generar período</button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-3">
        {/* Lista de períodos */}
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden self-start">
          <div className="px-3 py-2 bg-emerald-50 text-xs uppercase font-semibold text-emerald-700">Períodos {year}</div>
          <div className="divide-y">
            {list.map((p) => (
              <button key={p._id} onClick={() => { open(p); setDetailIdx(null); }} className={`w-full text-left px-3 py-2 hover:bg-slate-50 ${selected?._id === p._id ? 'bg-emerald-50/60' : ''}`}>
                <div className="flex items-center justify-between">
                  <span className="font-medium text-sm">{MONTHS[p.month]} {p.year}</span>
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${STATUS_STYLE[p.status] || ''}`}>{p.status}</span>
                </div>
                <div className="text-xs text-slate-500 font-mono flex items-center gap-1.5">
                  {p.periodType && p.periodType !== 'MENSUAL' && <span className="px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 text-[9px] font-semibold not-italic">{PERIOD_LABEL[p.periodType]}</span>}
                  Neto ${fmt(p.totalNeto)}
                </div>
              </button>
            ))}
            {!list.length && <div className="px-3 py-6 text-center text-xs text-slate-400">Sin roles en {year}. Genera un período.</div>}
          </div>
        </div>

        {/* Detalle del período: lista de empleados */}
        {selected ? (
          <div className="lg:col-span-3 bg-white rounded-2xl shadow-md shadow-slate-200/60 p-4">
            <div className="flex flex-wrap justify-between items-center gap-2 mb-3">
              <div>
                <h2 className="font-semibold text-slate-800">Rol {MONTHS[selected.month]} {selected.year}{selected.periodType && selected.periodType !== 'MENSUAL' ? ` · ${PERIOD_LABEL[selected.periodType]}` : ''}</h2>
                <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${STATUS_STYLE[selected.status] || ''}`}>{selected.status}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {selected.status === 'BORRADOR' && (
                  <button
                    onClick={() => setCloseModal({
                      accountingDate: lastDayOfMonth(selected.year, selected.month),
                      scheduledPaymentDate: lastDayOfMonth(selected.year, selected.month),
                    })}
                    className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-sm flex items-center gap-1"
                  >
                    <HiOutlineLockClosed className="w-4 h-4" /> Cerrar y contabilizar
                  </button>
                )}
                {selected.status === 'CERRADO' && <button onClick={() => setPayModal({ bankAccountId: banks[0]?._id || '', date: today(), amount: '', key: newIdempotencyKey(), busy: false })} className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm flex items-center gap-1"><HiOutlineBanknotes className="w-4 h-4" /> Pagar desde banco</button>}
                {selected.status === 'CERRADO' && <button onClick={markPaid} disabled={cashBusy} className="px-3 py-1.5 bg-slate-200 text-slate-700 rounded-lg text-sm disabled:opacity-60" title="Genera el asiento Sueldos por pagar → Caja">{cashBusy ? 'Pagando…' : 'Pagar en efectivo'}</button>}
                {selected.status === 'CERRADO' && !(selected.payments || []).length && (
                  <button onClick={reopen} className="px-3 py-1.5 bg-slate-200 text-slate-700 rounded-lg text-sm flex items-center gap-1" title="Reversa el asiento y anula la obligación">
                    <HiOutlineLockOpen className="w-4 h-4" /> Reabrir
                  </button>
                )}
                {selected.status !== 'BORRADOR' && (
                  <button onClick={() => setShowEntry(true)} className="px-3 py-1.5 bg-slate-700 text-white rounded-lg text-sm flex items-center gap-1" title="Ver el asiento de cierre y los pagos">
                    <HiOutlineEye className="w-4 h-4" /> Ver asiento
                  </button>
                )}
              </div>
            </div>

            {/* Totales del período */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
              <Chip label="Total ingresos" value={`$${fmt(selected.totalIngresos)}`} tone="emerald" />
              <Chip label="Total egresos" value={`$${fmt(selected.totalEgresos)}`} tone="rose" />
              <Chip label="Provisiones (empresa)" value={`$${fmt(selected.totalProvisiones)}`} tone="sky" />
              <Chip label="Neto a pagar" value={`$${fmt(selected.totalNeto)}`} tone="emerald" />
            </div>

            {/* Obligación y pagos (alimenta el flujo de caja) */}
            {selected.status !== 'BORRADOR' && (
              <div className="mb-3 rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2 text-xs text-slate-600 flex flex-wrap items-center gap-x-5 gap-y-1">
                <span>Fecha contable: <b>{fmtDate(selected.accountingDate) || '—'}</b></span>
                <span>Pago programado: <b>{fmtDate(selected.scheduledPaymentDate) || 'sin fecha'}</b></span>
                <span>Pagado: <b className="font-mono">${fmt(paidAmount)}</b></span>
                <span>Pendiente: <b className={`font-mono ${pending > 0 ? 'text-rose-600' : 'text-emerald-700'}`}>${fmt(pending)}</b></span>
                {(selected.payments || []).length > 0 && (
                  <span className="text-slate-400">({selected.payments.length} pago{selected.payments.length > 1 ? 's' : ''}: {selected.payments.map((p) => `$${fmt(p.amount)} el ${fmtDate(p.date)}`).join(' · ')})</span>
                )}
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="tbl text-sm">
                <thead className="bg-slate-100 text-xs uppercase"><tr>
                  <th className="px-2 py-2 text-left">Empleado</th>
                  <th className="px-2 py-2 text-left">Departamento</th>
                  <th className="px-2 py-2 text-right">Días</th>
                  <th className="px-2 py-2 text-right">Ingresos</th>
                  <th className="px-2 py-2 text-right">Egresos</th>
                  <th className="px-2 py-2 text-right">Neto</th>
                  <th className="px-2 py-2"></th>
                </tr></thead>
                <tbody>
                  {selected.items.map((it, i) => (
                    <tr key={i} className="border-t hover:bg-slate-50 cursor-pointer" onClick={() => setDetailIdx(i)}>
                      <td className="px-2 py-2">{it.employeeName || '—'}</td>
                      <td className="px-2 py-2 text-xs text-slate-500">{it.departmentType || '—'}</td>
                      <td className="px-2 py-2 text-right font-mono">{it.daysWorked}</td>
                      <td className="px-2 py-2 text-right font-mono text-emerald-700">{fmt(it.totalIngresos)}</td>
                      <td className="px-2 py-2 text-right font-mono text-rose-600">{fmt(it.totalEgresos)}</td>
                      <td className="px-2 py-2 text-right font-mono font-semibold">${fmt(it.netoPagar)}</td>
                      <td className="px-2 py-2 text-right">
                        <button onClick={(e) => { e.stopPropagation(); setDetailIdx(i); }} className="text-emerald-700 hover:underline text-xs inline-flex items-center gap-1">
                          {editable ? <><HiOutlinePencilSquare className="w-4 h-4" /> Editar</> : 'Ver'}
                        </button>
                      </td>
                    </tr>
                  ))}
                  {!selected.items.length && <tr><td colSpan={7} className="px-2 py-6 text-center text-slate-400 text-sm">El rol no tiene empleados. Verifica que existan empleados activos con fecha de ingreso anterior al período.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="lg:col-span-3 bg-white rounded-2xl shadow-md shadow-slate-200/60 p-10 text-center text-slate-400 text-sm">
            Selecciona un período o genera uno nuevo para trabajar el rol por empleado.
          </div>
        )}
      </div>

      {/* Detalle por empleado */}
      <Modal isOpen={detailItem != null} onClose={() => setDetailIdx(null)} title={detailItem ? `${detailItem.employeeName} — ${MONTHS[selected?.month]} ${selected?.year}` : ''} size="xl">
        {detailItem && (
          <EmployeeDetail
            item={detailItem}
            concepts={concepts}
            editable={editable}
            onClose={() => setDetailIdx(null)}
            onSave={(patch) => saveItem(detailItem.employee?._id || detailItem.employee, patch)}
          />
        )}
      </Modal>

      {/* Cierre: fechas contable y de pago programado */}
      <Modal isOpen={!!closeModal} onClose={() => setCloseModal(null)} title="Cerrar y contabilizar el rol">
        {closeModal && (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">
              Se generará el asiento de gastos, provisiones y pasivos, y se abrirá la <b>obligación por el neto</b> (${fmt(selected?.totalNeto)}) para el flujo de caja. El rol ya no podrá editarse.
            </p>
            <Field label="Fecha contable" required hint="Devengo del gasto. Por defecto, el último día del período.">
              <input type="date" value={closeModal.accountingDate} onChange={(e) => setCloseModal({ ...closeModal, accountingDate: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" />
            </Field>
            <Field label="Fecha programada de pago" hint="Cuándo se pagará el neto. Es el vencimiento de la obligación: si cae fin de semana, la fecha legal no se mueve; el flujo de caja proyecta el siguiente día hábil.">
              <input type="date" value={closeModal.scheduledPaymentDate} onChange={(e) => setCloseModal({ ...closeModal, scheduledPaymentDate: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" />
            </Field>
            <div className="flex justify-end gap-2">
              <button onClick={() => setCloseModal(null)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button>
              <button onClick={close} className="px-4 py-2 bg-emerald-600 text-white rounded-xl flex items-center gap-1"><HiOutlineLockClosed className="w-4 h-4" /> Cerrar y contabilizar</button>
            </div>
          </div>
        )}
      </Modal>

      {/* Pago desde banco (total o parcial) */}
      <Modal isOpen={!!payModal} onClose={() => setPayModal(null)} title="Pagar nómina desde banco">
        {payModal && (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">Neto del rol: <b>${fmt(selected?.totalNeto)}</b> · Pendiente: <b className="text-rose-600">${fmt(pending)}</b></p>
            <Field label="Banco" required>
              <select value={payModal.bankAccountId} onChange={(e) => setPayField({ bankAccountId: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5">
                <option value="">Seleccione…</option>
                {banks.map((b) => <option key={b._id} value={b._id}>{b.name} · {b.bank} {b.accountNumber}</option>)}
              </select>
            </Field>
            <Field label="Fecha de pago"><input type="date" value={payModal.date} onChange={(e) => setPayField({ date: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
            <Field label="Monto" hint="Vacío = paga todo el saldo pendiente. Se admite pago parcial: el rol sigue CERRADO hasta liquidar el total.">
              <NumericInput step="0.01" min="0" value={payModal.amount} onChange={(e) => setPayField({ amount: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" />
            </Field>
            <p className="text-xs text-slate-500">Se generará el asiento (Sueldos por pagar → Banco), una transacción bancaria y se aplicará la obligación.</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setPayModal(null)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button>
              <button onClick={payFromBank} disabled={payModal.busy} className="px-4 py-2 bg-blue-600 text-white rounded-xl flex items-center gap-1 disabled:opacity-60">
                <HiOutlineCheck className="w-4 h-4" /> {payModal.busy ? 'Pagando…' : 'Pagar'}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Asiento(s) del rol: cierre + pagos */}
      <JournalEntryViewModal
        isOpen={showEntry}
        onClose={() => setShowEntry(false)}
        source={selected ? { model: 'Payroll', ref: selected._id } : null}
        title={selected ? `Asientos del rol ${MONTHS[selected.month]} ${selected.year}` : 'Asiento'}
        emptyHint="El rol aún no se ha cerrado: el asiento se genera al cerrar y contabilizar."
        hideOriginLink
      />

      {/* Fondos de reserva: decisión al cumplir el año */}
      <Modal isOpen={!!fondosPending} onClose={() => setFondosPending(null)} title="Fondos de reserva — empleados que cumplieron el año">
        {fondosPending && (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">
              Estos empleados cumplieron <b>un año</b> y ya tienen derecho a fondos de reserva. Decide cómo se manejan:
              <b> Mensualizar</b> (se paga en el rol cada mes) o <b>Acumular</b> (se provisiona al pasivo, no se paga en el rol).
              Al terminar se regenera el rol para incluirlos.
            </p>
            <div className="space-y-2">
              {fondosPending.list.map((f) => (
                <div key={f.employee} className="flex items-center justify-between gap-2 border border-slate-200 rounded-xl px-3 py-2">
                  <div>
                    <p className="text-sm font-medium text-slate-800">{f.name}</p>
                    <p className="text-[11px] text-slate-500">Cumplió el año el {fmtDate(f.anniversary)}</p>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => decideFondos(f.employee, 'MENSUALIZADO')} className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs">Mensualizar</button>
                    <button onClick={() => decideFondos(f.employee, 'ACUMULADO')} className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs">Acumular</button>
                  </div>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-slate-400">También puedes definir el modo luego en la ficha del empleado.</p>
          </div>
        )}
      </Modal>

      {/* Generar período */}
      <Modal isOpen={show} onClose={() => setShow(false)} title="Generar rol de nómina">
        <form onSubmit={generate} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Año" required><NumericInput required value={form.year} onChange={(e) => setForm({ ...form, year: +e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
            <Field label="Mes" required>
              <select required value={form.month} onChange={(e) => setForm({ ...form, month: +e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5">
                {MONTHS.slice(1).map((m, i) => <option key={i + 1} value={i + 1}>{m}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Tipo de período" required>
            <select value={form.periodType} onChange={(e) => setForm({ ...form, periodType: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5">
              {PERIOD_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <p className="text-[11px] text-slate-500 mt-1">{PERIOD_TYPES.find((p) => p[0] === form.periodType)?.[2]}</p>
          </Field>
          <p className="text-xs text-slate-500">Se generará (o regenerará, si está en borrador) el rol con los empleados activos del período, sus préstamos y deducciones pendientes.</p>
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setShow(false)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button><button className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20">Generar</button></div>
        </form>
      </Modal>
    </div>
  );
}
