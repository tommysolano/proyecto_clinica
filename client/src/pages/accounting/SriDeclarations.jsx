import { useCallback, useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import {
  HiOutlineDocumentText, HiOutlineArrowPath, HiOutlineLockClosed, HiOutlineDocumentDuplicate,
  HiOutlineArrowDownTray, HiOutlinePrinter, HiOutlineBanknotes, HiOutlineClipboardDocumentList,
  HiOutlineExclamationTriangle, HiOutlineCheckCircle, HiOutlineEye, HiOutlineTrash,
} from 'react-icons/hi2';
import Modal from '../../components/Modal';
import Field from '../../components/Field';
import NumericInput from '../../components/NumericInput';
import JournalEntryViewModal from '../../components/JournalEntryViewModal';
import { fmt, fmtDate, today, downloadBlob } from './_utils';
import { newIdempotencyKey, withIdempotencyKey } from '../../utils/idempotency';
import useDocDeepLink from '../../hooks/useDocDeepLink';

const MONTHS = ['', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

const STATUS_STYLE = {
  DRAFT: 'bg-amber-100 text-amber-700',
  FINALIZED: 'bg-emerald-100 text-emerald-700',
  SUBSTITUTIVE: 'bg-slate-200 text-slate-600',
  VOID: 'bg-rose-100 text-rose-700',
};
const STATUS_LABEL = {
  DRAFT: 'Borrador',
  FINALIZED: 'Finalizada',
  SUBSTITUTIVE: 'Sustituida',
  VOID: 'Anulada',
};

/** Valor de un casillero con el formato que declara la definición. */
const cellText = (cell, value) => {
  if (cell.format === 'PERCENT') return `${(Number(value || 0) * 100).toFixed(2)} %`;
  return fmt(value);
};

/**
 * Una fila del formulario. Los casilleros EDITABLE se capturan; el resto se muestran
 * calculados. La estructura (número, etiqueta, orden, fórmula, ayuda) NO está escrita
 * aquí: viene de la definición versionada del backend.
 */
function CellRow({ cell, value, editable, onChange }) {
  const isEditable = cell.kind === 'EDITABLE' && editable;
  return (
    <tr className="border-t border-slate-100 align-top">
      <td className="px-2 py-2 font-mono text-xs text-slate-500 w-16">{cell.box}</td>
      <td className="px-2 py-2">
        <div className="text-sm text-slate-700">{cell.label}</div>
        {(cell.formula || cell.help) && (
          <div className="text-[11px] text-slate-400 mt-0.5">
            {cell.formula && <span className="font-mono">{cell.formula}</span>}
            {cell.formula && cell.help && ' · '}
            {cell.help}
          </div>
        )}
      </td>
      <td className="px-2 py-2 text-right w-40">
        {isEditable ? (
          <NumericInput
            step="0.01"
            value={value ?? 0}
            onChange={(e) => onChange(cell.box, e.target.value)}
            className="w-32 border border-amber-300 bg-amber-50/50 rounded-lg px-2 py-1 text-right font-mono"
          />
        ) : (
          <span className={`font-mono text-sm ${cell.kind === 'FORMULA' ? 'font-semibold text-slate-800' : 'text-slate-600'}`}>
            {cellText(cell, value)}
          </span>
        )}
      </td>
    </tr>
  );
}

/** Una celda de valor (bruto/neto/impuesto) dentro de la grilla oficial de 3 columnas. */
function GridValueCell({ cell, value, editable, onChange }) {
  if (!cell) return <td className="px-2 py-2 text-right text-slate-300">—</td>;
  const isEditable = cell.kind === 'EDITABLE' && editable;
  return (
    <td className="px-2 py-2 text-right align-top">
      <div className="text-[10px] font-mono text-slate-400 leading-none mb-1">{cell.box}</div>
      {isEditable ? (
        <NumericInput
          step="0.01"
          value={value ?? 0}
          onChange={(e) => onChange(cell.box, e.target.value)}
          className="w-24 border border-amber-300 bg-amber-50/50 rounded-lg px-2 py-1 text-right font-mono text-sm"
        />
      ) : (
        <span className={`font-mono text-sm ${cell.kind === 'FORMULA' ? 'font-semibold text-slate-800' : 'text-slate-600'}`}>
          {cellText(cell, value)}
        </span>
      )}
    </td>
  );
}

/**
 * Sección del 104 con el formato OFICIAL de 3 columnas (Valor Bruto / Valor Neto = Bruto −
 * N/C / Impuesto Generado). Agrupa los casilleros por `rowKey`: cada concepto es una fila y
 * cada `col` (BRUTO/NETO/IVA) su casillero. Mantiene visibles los números de casillero.
 */
function GridSection({ cells, cellValue, editable, onChange }) {
  const groups = [];
  const byKey = new Map();
  for (const c of cells) {
    if (!byKey.has(c.rowKey)) {
      const g = { rowKey: c.rowKey, label: c.rowLabel || c.label, order: c.order, total: c.kind === 'FORMULA', help: c.help };
      byKey.set(c.rowKey, g);
      groups.push(g);
    }
    const g = byKey.get(c.rowKey);
    g[c.col] = c;
    if (c.help) g.help = c.help;
    if (c.kind === 'FORMULA') g.total = true;
  }
  groups.sort((a, b) => a.order - b.order);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-[11px] uppercase text-slate-500">
          <tr>
            <th className="px-3 py-1.5 text-left">Concepto</th>
            <th className="px-2 py-1.5 text-right w-28">Valor bruto</th>
            <th className="px-2 py-1.5 text-right w-28">Valor neto</th>
            <th className="px-2 py-1.5 text-right w-28">Impuesto</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.rowKey} className={`border-t border-slate-100 align-top ${g.total ? 'bg-slate-50/80 font-semibold' : ''}`}>
              <td className="px-3 py-2">
                <div className="text-sm text-slate-700">{g.label}</div>
                {g.help && <div className="text-[11px] text-slate-400 mt-0.5">{g.help}</div>}
              </td>
              <GridValueCell cell={g.BRUTO} value={g.BRUTO && cellValue(g.BRUTO.box)} editable={editable} onChange={onChange} />
              <GridValueCell cell={g.NETO} value={g.NETO && cellValue(g.NETO.box)} editable={editable} onChange={onChange} />
              <GridValueCell cell={g.IVA} value={g.IVA && cellValue(g.IVA.box)} editable={editable} onChange={onChange} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function SriDeclarations() {
  const now = new Date();
  const [formType, setFormType] = useState('104');
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);

  const [data, setData] = useState(null); // { declaration, definition, cells, conciliaciones, warnings }
  const [history, setHistory] = useState([]);
  const [dirty, setDirty] = useState({}); // casilleros editados sin guardar
  const [loading, setLoading] = useState(false);
  const [finalizeModal, setFinalizeModal] = useState(null);
  const [payModal, setPayModal] = useState(null);
  const [banks, setBanks] = useState([]);
  const [entryModal, setEntryModal] = useState(null);

  const decl = data?.declaration;
  const def = data?.definition;
  const isDraft = decl?.status === 'DRAFT';

  const loadHistory = useCallback(async () => {
    try {
      const r = await api.get('/tax-declarations', { params: { formType, year } });
      setHistory(r.data.items || []);
    } catch { /* el historial es informativo */ }
  }, [formType, year]);

  useEffect(() => { loadHistory(); }, [loadHistory]);
  useEffect(() => { api.get('/banks/accounts').then((r) => setBanks(r.data || [])).catch(() => {}); }, []);

  const openDeclaration = async (id) => {
    setLoading(true);
    try {
      const r = await api.get(`/tax-declarations/${id}`);
      setData(r.data);
      setDirty({});
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
    finally { setLoading(false); }
  };

  // Deep-link desde el Libro Mayor / modal de asiento (?doc=<id>).
  useDocDeepLink(async (id) => {
    try { await openDeclaration(id); }
    catch { toast.error('No se encontró la declaración'); }
  });

  /** Abre (o crea) el borrador del período. */
  const loadDraft = async () => {
    setLoading(true);
    try {
      const r = await api.post('/tax-declarations/draft', { formType, year, month });
      setData(r.data);
      setDirty({});
      loadHistory();
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
    finally { setLoading(false); }
  };

  const recompute = async () => {
    try {
      const r = await api.post(`/tax-declarations/${decl._id}/recompute`);
      setData(r.data);
      setDirty({});
      toast.success('Recalculado con los datos actuales');
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  const saveDraft = async () => {
    try {
      const cells = Object.fromEntries(Object.entries(dirty).map(([k, v]) => [k, Number(v) || 0]));
      const r = await api.put(`/tax-declarations/${decl._id}`, { cells });
      setData(r.data);
      setDirty({});
      toast.success('Borrador guardado');
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  const finalize = async () => {
    try {
      const r = await api.post(`/tax-declarations/${decl._id}/finalize`, {
        accountingDate: finalizeModal.accountingDate || undefined,
        dueDate: finalizeModal.dueDate || null,
        plannedPaymentDate: finalizeModal.plannedPaymentDate || null,
      });
      setData(r.data);
      setFinalizeModal(null);
      loadHistory();
      toast.success('Declaración finalizada y contabilizada');
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  const substitute = async () => {
    if (!confirm('¿Crear una declaración SUSTITUTIVA? Se creará una nueva versión; al finalizarla se reversará el asiento de la anterior.')) return;
    try {
      const r = await api.post(`/tax-declarations/${decl._id}/substitute`);
      setData(r.data);
      setDirty({});
      loadHistory();
      toast.success(`Sustitutiva creada (versión ${r.data.declaration.version})`);
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  /** Elimina un borrador (solo borradores: no tocan contabilidad). */
  const removeDraft = async () => {
    if (!confirm('¿Eliminar este borrador? Se borra definitivamente. Solo aplica a borradores; no afecta la contabilidad.')) return;
    try {
      await api.delete(`/tax-declarations/${decl._id}`);
      setData(null);
      setDirty({});
      loadHistory();
      toast.success('Borrador eliminado');
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  /**
   * Cambiar importe, banco o fecha es OTRA intención de pago: se renueva la clave de
   * idempotencia. Un reintento de la misma intención conserva la suya.
   */
  const setPayField = (patch) => setPayModal((m) => ({ ...m, ...patch, key: newIdempotencyKey() }));

  const pay = async () => {
    if (!payModal?.bankAccountId) { toast.error('Selecciona un banco'); return; }
    if (payModal.busy) return; // evita el doble submit (la protección real está en backend)
    setPayModal((m) => ({ ...m, busy: true }));
    try {
      const r = await api.post(
        `/tax-declarations/${decl._id}/pay`,
        {
          bankAccountId: payModal.bankAccountId,
          date: payModal.date,
          amount: payModal.amount ? Number(payModal.amount) : undefined,
        },
        withIdempotencyKey(payModal.key),
      );
      setData(r.data);
      setPayModal(null); // éxito: se descarta la clave (el siguiente pago es otra intención)
      toast.success(r.data.idempotentReplay ? 'El pago ya estaba registrado' : 'Pago registrado');
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error');
      // Se conserva la MISMA clave: reintentar esta intención no puede duplicar el pago.
      setPayModal((m) => (m ? { ...m, busy: false } : m));
    }
  };

  const downloadXml = async () => {
    try {
      const r = await api.get(`/tax-declarations/${decl._id}/draft.xml`, { responseType: 'blob' });
      downloadBlob(r.data, `borrador-tecnico-F${decl.formType}-${decl.periodKey}-v${decl.version}.xml`);
      toast.success('Borrador técnico descargado');
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  const setCell = (box, value) => setDirty((d) => ({ ...d, [box]: value }));
  const cellValue = (box) => (dirty[box] !== undefined ? dirty[box] : data?.cells?.[box] ?? 0);

  const warnings = data?.warnings || [];
  const conciliaciones = data?.conciliaciones || [];
  const totals = decl?.totals || {};
  const rows103 = decl?.snapshot?.proveedores?.rows || [];
  // Estado real de la obligación (viene de la CxP, no se deriva de los totales).
  const obligacion = data?.obligacion || null;
  const pendiente = obligacion ? obligacion.balance : 0;
  const yaPagado = obligacion ? obligacion.applied : 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
          <HiOutlineDocumentText className="text-emerald-600" /> Declaraciones SRI
        </h1>
      </div>

      {/* Advertencia de verificación: la numeración de casilleros no está validada. */}
      <div className="text-xs rounded-lg px-3 py-2 bg-amber-50 border border-amber-200 text-amber-800 flex items-start gap-1.5 print:hidden">
        <HiOutlineExclamationTriangle className="w-4 h-4 shrink-0 mt-0.5" />
        <span>
          Los <b>importes</b> se calculan desde las ventas, compras y nóminas del período y son auditables.
          La <b>numeración de casilleros</b> y el XML que genera el sistema son un <b>borrador técnico</b>:
          no están validados contra el formulario ni el XSD vigentes del SRI, no son un archivo DIMM y no están listos para cargar.
          Confirme la numeración con su contador antes de declarar.
        </span>
      </div>

      {/* Selector de período */}
      <div className="bg-white p-3 rounded-xl shadow-sm flex gap-3 items-end flex-wrap print:hidden">
        <Field label="Formulario">
          <select
            value={formType}
            onChange={(e) => { setFormType(e.target.value); setData(null); }}
            className="border border-slate-200 rounded-xl px-3 py-2.5"
          >
            <option value="104">104 — IVA</option>
            <option value="103">103 — Retenciones en la fuente</option>
          </select>
        </Field>
        <Field label="Año">
          <NumericInput value={year} onChange={(e) => setYear(+e.target.value)} className="border border-slate-200 rounded-xl px-3.5 py-2.5 w-24" />
        </Field>
        <Field label="Mes">
          <select value={month} onChange={(e) => setMonth(+e.target.value)} className="border border-slate-200 rounded-xl px-3 py-2.5">
            {MONTHS.slice(1).map((m, i) => <option key={i + 1} value={i + 1}>{m}</option>)}
          </select>
        </Field>
        <button onClick={loadDraft} disabled={loading} className="px-4 py-2.5 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 disabled:opacity-60">
          {loading ? 'Cargando…' : 'Abrir borrador del período'}
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-3">
        {/* Historial */}
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden self-start print:hidden">
          <div className="px-3 py-2 bg-emerald-50 text-xs uppercase font-semibold text-emerald-700 flex items-center gap-1">
            <HiOutlineClipboardDocumentList className="w-4 h-4" /> Historial {year}
          </div>
          <div className="divide-y max-h-[520px] overflow-auto">
            {history.map((h) => (
              <button
                key={h._id}
                onClick={() => openDeclaration(h._id)}
                className={`w-full text-left px-3 py-2 hover:bg-slate-50 ${decl?._id === h._id ? 'bg-emerald-50/60' : ''}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-sm">{MONTHS[h.month]} · v{h.version}</span>
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${STATUS_STYLE[h.status]}`}>{STATUS_LABEL[h.status]}</span>
                </div>
                <div className="text-xs text-slate-500 font-mono">
                  {h.totals?.totalAPagar > 0 ? `A pagar $${fmt(h.totals.totalAPagar)}` : (h.totals?.creditoTributario > 0 ? `Crédito $${fmt(h.totals.creditoTributario)}` : 'Sin obligación')}
                </div>
              </button>
            ))}
            {!history.length && <div className="px-3 py-6 text-center text-xs text-slate-400">Sin declaraciones del formulario {formType} en {year}.</div>}
          </div>
        </div>

        {/* Formulario */}
        {data ? (
          <div className="lg:col-span-3 space-y-3">
            {/* Cabecera + acciones */}
            <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div>
                  <h2 className="font-semibold text-slate-800">{def.title}</h2>
                  <div className="flex items-center gap-2 mt-1 text-xs text-slate-500">
                    <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${STATUS_STYLE[decl.status]}`}>{STATUS_LABEL[decl.status]}</span>
                    <span>{MONTHS[decl.month]} {decl.year}</span>
                    <span>· versión {decl.version}</span>
                    <span className="font-mono">· def. {decl.definitionVersion}</span>
                    {decl.finalizedAt && <span>· finalizada {fmtDate(decl.finalizedAt)}</span>}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 print:hidden">
                  {isDraft && (
                    <>
                      <button onClick={recompute} className="px-3 py-1.5 bg-slate-200 text-slate-700 rounded-lg text-sm flex items-center gap-1">
                        <HiOutlineArrowPath className="w-4 h-4" /> Recalcular
                      </button>
                      <button
                        onClick={saveDraft}
                        disabled={!Object.keys(dirty).length}
                        className="px-3 py-1.5 bg-amber-500 text-white rounded-lg text-sm disabled:opacity-50"
                      >
                        Guardar borrador
                      </button>
                      <button onClick={() => setFinalizeModal({ accountingDate: '', dueDate: '', plannedPaymentDate: '' })} className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-sm flex items-center gap-1">
                        <HiOutlineLockClosed className="w-4 h-4" /> Finalizar
                      </button>
                      <button
                        onClick={removeDraft}
                        title="Eliminar este borrador (solo borradores; no afecta la contabilidad)"
                        className="px-3 py-1.5 bg-rose-100 text-rose-700 rounded-lg text-sm flex items-center gap-1 hover:bg-rose-200"
                      >
                        <HiOutlineTrash className="w-4 h-4" /> Eliminar
                      </button>
                    </>
                  )}
                  {decl.status === 'FINALIZED' && (
                    <>
                      {/* Con pagos aplicados la sustitutiva reversaría un asiento ya pagado:
                          el backend la bloquea, así que aquí no se ofrece. */}
                      <button
                        onClick={substitute}
                        disabled={yaPagado > 0}
                        title={yaPagado > 0 ? `La declaración ya tiene pagos por $${fmt(yaPagado)}: debe reversarse el pago antes de sustituirla.` : ''}
                        className={`px-3 py-1.5 rounded-lg text-sm flex items-center gap-1 ${yaPagado > 0 ? 'bg-slate-200 text-slate-400 cursor-not-allowed' : 'bg-indigo-600 text-white'}`}
                      >
                        <HiOutlineDocumentDuplicate className="w-4 h-4" /> Sustitutiva
                      </button>
                      {pendiente > 0 && (
                        <button
                          onClick={() => setPayModal({ bankAccountId: banks[0]?._id || '', date: today(), amount: '', key: newIdempotencyKey(), busy: false })}
                          className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm flex items-center gap-1"
                        >
                          <HiOutlineBanknotes className="w-4 h-4" /> Pagar al SRI
                        </button>
                      )}
                    </>
                  )}
                  {decl.journalEntry && (
                    <button onClick={() => setEntryModal(decl.journalEntry)} className="px-3 py-1.5 bg-slate-700 text-white rounded-lg text-sm flex items-center gap-1">
                      <HiOutlineEye className="w-4 h-4" /> Ver asiento
                    </button>
                  )}
                  <button onClick={downloadXml} className="px-3 py-1.5 bg-slate-200 text-slate-700 rounded-lg text-sm flex items-center gap-1" title="No es el XML oficial del SRI">
                    <HiOutlineArrowDownTray className="w-4 h-4" /> Borrador técnico (XML)
                  </button>
                  <button onClick={() => window.print()} className="px-3 py-1.5 bg-slate-200 text-slate-700 rounded-lg text-sm flex items-center gap-1">
                    <HiOutlinePrinter className="w-4 h-4" /> Imprimir
                  </button>
                </div>
              </div>

              {/* Totales */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <Chip label="Impuesto por pagar" value={`$${fmt(totals.impuestoPorPagar)}`} tone={totals.impuestoPorPagar > 0 ? 'rose' : 'slate'} />
                <Chip label="Crédito tributario" value={`$${fmt(totals.creditoTributario)}`} tone="sky" />
                <Chip label="Retenciones a pagar" value={`$${fmt(totals.retencionesEfectuadas)}`} />
                <Chip label="Total a pagar al SRI" value={`$${fmt(totals.totalAPagar)}`} tone="emerald" />
              </div>

              {/* Estado de la obligación (saldo real de la CxP, no derivado de los totales) */}
              {obligacion && (
                <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2 text-xs text-slate-600 flex flex-wrap items-center gap-x-5 gap-y-1">
                  <span>Obligación: <b className="font-mono">${fmt(obligacion.total)}</b></span>
                  <span>Pagado: <b className="font-mono">${fmt(obligacion.applied)}</b></span>
                  <span>Pendiente: <b className={`font-mono ${obligacion.balance > 0 ? 'text-rose-600' : 'text-emerald-700'}`}>${fmt(obligacion.balance)}</b></span>
                  {obligacion.dueDate && <span>Vence: <b>{fmtDate(obligacion.dueDate)}</b></span>}
                  {obligacion.plannedPaymentDate && <span>Pago previsto: <b>{fmtDate(obligacion.plannedPaymentDate)}</b></span>}
                </div>
              )}
            </div>

            {/* Advertencias */}
            {warnings.length > 0 && (
              <div className="bg-white rounded-2xl shadow-sm p-3 space-y-1">
                {warnings.map((w, i) => (
                  <div key={i} className={`text-xs rounded-lg px-3 py-2 flex items-start gap-1.5 ${w.severity === 'info' ? 'bg-sky-50 text-sky-800 border border-sky-200' : 'bg-amber-50 text-amber-800 border border-amber-200'}`}>
                    <HiOutlineExclamationTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>{w.message}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Secciones del formulario (dibujadas desde la definición) */}
            {def.sections.map((section) => {
              const cells = def.cells.filter((c) => c.section === section.key).sort((a, b) => a.order - b.order);
              if (!cells.length) return null;
              return (
                <div key={section.key} className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden">
                  <div className="px-4 py-2 bg-slate-100 text-xs uppercase font-semibold text-slate-600">{section.label}</div>
                  {section.layout === 'GRID3' ? (
                    <GridSection cells={cells} cellValue={cellValue} editable={isDraft} onChange={setCell} />
                  ) : (
                    <table className="w-full">
                      <tbody>
                        {cells.map((c) => (
                          <CellRow key={c.box} cell={c} value={cellValue(c.box)} editable={isDraft} onChange={setCell} />
                        ))}
                      </tbody>
                    </table>
                  )}

                  {/* El 103 lleva un casillero DINÁMICO por cada código de retención usado. */}
                  {formType === '103' && section.key === 'PROVEEDORES' && (
                    <>
                      <p className="px-4 pt-2 text-[11px] text-slate-400">
                        Un casillero por cada <b>código de retención</b> usado en el período. Van apareciendo
                        automáticamente a medida que se emiten retenciones a proveedores; su base y valor retenido
                        salen de los comprobantes de retención.
                      </p>
                      <table className="w-full text-sm">
                        <thead className="bg-slate-50 text-[11px] uppercase text-slate-500">
                          <tr>
                            <th className="px-3 py-1.5 text-left">Casillero (código)</th>
                            <th className="px-3 py-1.5 text-left">Concepto</th>
                            <th className="px-3 py-1.5 text-right">Comprob.</th>
                            <th className="px-3 py-1.5 text-right">Base</th>
                            <th className="px-3 py-1.5 text-right">Valor retenido</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows103.map((r) => (
                            <tr key={r.code} className="border-t border-slate-100">
                              <td className="px-3 py-1.5 font-mono">{r.code}</td>
                              <td className="px-3 py-1.5 text-slate-600">{r.description || '—'}</td>
                              <td className="px-3 py-1.5 text-right font-mono text-slate-500">{r.docs?.length || 0}</td>
                              <td className="px-3 py-1.5 text-right font-mono">{fmt(r.base)}</td>
                              <td className="px-3 py-1.5 text-right font-mono">{fmt(r.amount)}</td>
                            </tr>
                          ))}
                          {rows103.length > 0 && (
                            <tr className="border-t border-slate-200 bg-slate-50/80 font-semibold">
                              <td className="px-3 py-1.5" colSpan={3}>Total retenido a proveedores</td>
                              <td className="px-3 py-1.5 text-right font-mono">{fmt(rows103.reduce((s, r) => s + (r.base || 0), 0))}</td>
                              <td className="px-3 py-1.5 text-right font-mono">{fmt(rows103.reduce((s, r) => s + (r.amount || 0), 0))}</td>
                            </tr>
                          )}
                          {!rows103.length && (
                            <tr><td colSpan={5} className="px-3 py-4 text-center text-slate-400 text-xs">Aún no hay retenciones de renta a proveedores en el período. Los casilleros aparecen al emitir retenciones.</td></tr>
                          )}
                        </tbody>
                      </table>
                    </>
                  )}
                </div>
              );
            })}

            {/* Conciliaciones */}
            {conciliaciones.length > 0 && (
              <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden">
                <div className="px-4 py-2 bg-slate-100 text-xs uppercase font-semibold text-slate-600">Conciliaciones</div>
                <div className="divide-y">
                  {conciliaciones.map((c) => (
                    <div key={c.key} className="px-4 py-2 flex items-start gap-2">
                      {c.ok
                        ? <HiOutlineCheckCircle className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                        : <HiOutlineExclamationTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />}
                      <div>
                        <div className="text-sm text-slate-700">{c.label}</div>
                        <div className="text-xs text-slate-500 font-mono">{c.detalle}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Detalle laboral auditable (103) */}
            {formType === '103' && decl.snapshot?.dependencia?.empleados?.length > 0 && (
              <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden">
                <div className="px-4 py-2 bg-slate-100 text-xs uppercase font-semibold text-slate-600">
                  Relación de dependencia — rubros incluidos y excluidos
                </div>
                <div className="overflow-x-auto">
                  <table className="tbl text-xs">
                    <thead className="bg-slate-50 uppercase text-[11px]">
                      <tr>
                        <th className="px-3 py-1.5 text-left">Empleado</th>
                        <th className="px-3 py-1.5 text-left">Rubros</th>
                        <th className="px-3 py-1.5 text-right">Base gravada</th>
                        <th className="px-3 py-1.5 text-right">IESS personal</th>
                        <th className="px-3 py-1.5 text-right">IR retenido</th>
                      </tr>
                    </thead>
                    <tbody>
                      {decl.snapshot.dependencia.empleados.map((e, i) => (
                        <tr key={i} className="border-t align-top">
                          <td className="px-3 py-1.5">{e.nombre}<div className="text-[11px] text-slate-400 font-mono">{e.identificacion}</div></td>
                          <td className="px-3 py-1.5">
                            {(e.detalle || []).map((d, j) => (
                              <div key={j} className={d.incluido ? 'text-slate-700' : 'text-slate-400'}>
                                {d.incluido ? '✓' : '✕'} {d.rubro} <span className="font-mono">${fmt(d.monto)}</span>
                                {!d.incluido && d.motivo && <span className="text-[10px] italic"> — {d.motivo}</span>}
                              </div>
                            ))}
                          </td>
                          <td className="px-3 py-1.5 text-right font-mono">{fmt(e.baseGravada)}</td>
                          <td className="px-3 py-1.5 text-right font-mono">{fmt(e.iessPersonal)}</td>
                          <td className="px-3 py-1.5 text-right font-mono">{fmt(e.impuestoRenta)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="px-4 py-2 text-[11px] text-slate-400">
                  Base declarada = ingresos gravados. La base imponible neta de aporte personal IESS
                  (${fmt(decl.snapshot.dependencia.baseImponibleNeta)}) se muestra por si el instructivo vigente la exige.
                </p>
              </div>
            )}
          </div>
        ) : (
          <div className="lg:col-span-3 bg-white rounded-2xl shadow-md shadow-slate-200/60 p-10 text-center text-slate-400 text-sm">
            Elige formulario y período, y abre el borrador para trabajar la declaración.
          </div>
        )}
      </div>

      {/* Finalizar */}
      <Modal isOpen={!!finalizeModal} onClose={() => setFinalizeModal(null)} title="Finalizar declaración">
        {finalizeModal && (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">
              Se generará el asiento de cierre de impuestos{totals.totalAPagar > 0 ? ` y la cuenta por pagar al SRI por $${fmt(totals.totalAPagar)}` : ' (sin obligación: el período cierra con saldo a favor)'}.
              El banco <b>no</b> se afecta: eso ocurre al pagar.
            </p>
            <Field label="Fecha contable" hint="Devengo del impuesto. Por defecto, el último día del período declarado.">
              <input type="date" value={finalizeModal.accountingDate} onChange={(e) => setFinalizeModal({ ...finalizeModal, accountingDate: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" />
            </Field>
            <Field label="Fecha de vencimiento" hint="Fecha legal de pago según el 9º dígito del RUC. Sin ella, la obligación se proyecta a la fecha de emisión.">
              <input type="date" value={finalizeModal.dueDate} onChange={(e) => setFinalizeModal({ ...finalizeModal, dueDate: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" />
            </Field>
            <Field label="Fecha planificada de pago" hint="Cuándo se planea pagar (alimenta el flujo de caja).">
              <input type="date" value={finalizeModal.plannedPaymentDate} onChange={(e) => setFinalizeModal({ ...finalizeModal, plannedPaymentDate: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" />
            </Field>
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              Una vez finalizada, la declaración es <b>inmutable</b>: para corregirla habrá que crear una sustitutiva.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setFinalizeModal(null)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button>
              <button onClick={finalize} className="px-4 py-2 bg-emerald-600 text-white rounded-xl">Finalizar y contabilizar</button>
            </div>
          </div>
        )}
      </Modal>

      {/* Pagar */}
      <Modal isOpen={!!payModal} onClose={() => setPayModal(null)} title="Pagar la obligación al SRI">
        {payModal && (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">
              Obligación: <b>${fmt(obligacion?.total)}</b> · Pendiente: <b className="text-rose-600">${fmt(pendiente)}</b>
            </p>
            <Field label="Banco" required>
              <select value={payModal.bankAccountId} onChange={(e) => setPayField({ bankAccountId: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5">
                <option value="">Seleccione…</option>
                {banks.map((b) => <option key={b._id} value={b._id}>{b.name} · {b.bank} {b.accountNumber}</option>)}
              </select>
            </Field>
            <Field label="Fecha de pago">
              <input type="date" value={payModal.date} onChange={(e) => setPayField({ date: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" />
            </Field>
            <Field label="Monto" hint="Vacío = paga el saldo pendiente completo. Se admite pago parcial.">
              <NumericInput step="0.01" min="0" value={payModal.amount} onChange={(e) => setPayField({ amount: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" />
            </Field>
            <div className="flex justify-end gap-2">
              <button onClick={() => setPayModal(null)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button>
              <button onClick={pay} disabled={payModal.busy} className="px-4 py-2 bg-blue-600 text-white rounded-xl disabled:opacity-60">
                {payModal.busy ? 'Pagando…' : 'Pagar'}
              </button>
            </div>
          </div>
        )}
      </Modal>

      <JournalEntryViewModal
        isOpen={!!entryModal}
        onClose={() => setEntryModal(null)}
        entryId={entryModal}
        title="Asiento de la declaración"
        hideOriginLink
      />
    </div>
  );
}

function Chip({ label, value, tone = 'slate' }) {
  const tones = {
    slate: 'bg-slate-50 text-slate-700',
    emerald: 'bg-emerald-50 text-emerald-700',
    rose: 'bg-rose-50 text-rose-700',
    sky: 'bg-sky-50 text-sky-700',
  };
  return (
    <div className={`rounded-xl px-3 py-2 ${tones[tone]}`}>
      <div className="text-[11px] uppercase tracking-wide opacity-70">{label}</div>
      <div className="font-mono font-semibold text-sm">{value}</div>
    </div>
  );
}
