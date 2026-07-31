import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import {
  HiOutlineClipboardDocumentList, HiOutlineArrowDownTray, HiOutlineUsers, HiOutlinePlus,
  HiOutlineExclamationTriangle, HiOutlineCheckCircle, HiOutlinePencilSquare, HiOutlineTrash,
} from 'react-icons/hi2';
import Modal from '../../components/Modal';
import Field from '../../components/Field';
import NumericInput from '../../components/NumericInput';
import { fmt } from './_utils';
import { downloadFile } from '../../utils/download';

/**
 * ANEXOS DEL SRI: RDEP (anual, acompaña al Formulario 103) y Anexo de Accionistas (APS).
 *
 * El RDEP se CALCULA de las nóminas cerradas del año: en la tabla solo se capturan las
 * columnas ámbar (gastos personales del empleado, otros empleadores y exoneraciones), que son
 * las que el sistema no puede conocer. El anexo de accionistas es 100 % captura: la
 * composición societaria no vive en ningún otro punto del sistema.
 */

const ROLE_LABEL = {
  ACCIONISTA: 'Accionista',
  SOCIO: 'Socio',
  PARTICIPE: 'Partícipe',
  MIEMBRO_DIRECTORIO: 'Miembro del directorio',
  ADMINISTRADOR: 'Administrador',
  BENEFICIARIO_EFECTIVO: 'Beneficiario efectivo',
};

// Columnas CAPTURABLES del RDEP (las ámbar). El resto sale de la nómina.
const RDEP_INPUTS = [
  { key: 'ingresosOtrosEmpleadores', label: 'Ingresos otros empl.' },
  { key: 'iessOtrosEmpleadores', label: 'IESS otros empl.' },
  { key: 'retenidoOtrosEmpleadores', label: 'Retenido otros empl.' },
  { key: 'gastosVivienda', label: 'Vivienda' },
  { key: 'gastosSalud', label: 'Salud' },
  { key: 'gastosEducacion', label: 'Educación' },
  { key: 'gastosAlimentacion', label: 'Alimentación' },
  { key: 'gastosVestimenta', label: 'Vestimenta' },
  { key: 'gastosTurismo', label: 'Turismo' },
  { key: 'exoneracionDiscapacidad', label: 'Exon. discapacidad' },
  { key: 'exoneracionTerceraEdad', label: 'Exon. tercera edad' },
];

const EMPTY_SHAREHOLDER = {
  tipoPersona: 'NATURAL', tipoIdentificacion: 'CEDULA', identificacion: '', razonSocial: '',
  role: 'ACCIONISTA', paisResidencia: 'ECUADOR', paraisoFiscal: false,
  porcentajeParticipacion: 0, capitalInvertido: 0, numeroAcciones: 0,
  fechaDesde: '', fechaHasta: '', active: true, notes: '',
};

export default function SriAnnexes() {
  const [tab, setTab] = useState('rdep');
  // Permite llegar desde el 103 con el ejercicio ya elegido (?year=2026).
  const [params] = useSearchParams();
  const [year, setYear] = useState(() => {
    const q = parseInt(params.get('year'), 10);
    return Number.isInteger(q) && q >= 2000 && q <= 2100 ? q : new Date().getFullYear();
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
          <HiOutlineClipboardDocumentList className="text-emerald-600" /> Anexos SRI
        </h1>
        <div className="flex items-end gap-2">
          <Field label="Ejercicio fiscal">
            <NumericInput
              value={year}
              onChange={(e) => setYear(+e.target.value || new Date().getFullYear())}
              className="border border-slate-200 rounded-xl px-3.5 py-2.5 w-28 bg-white"
            />
          </Field>
        </div>
      </div>

      <div className="text-xs rounded-lg px-3 py-2 bg-amber-50 border border-amber-200 text-amber-800 flex items-start gap-1.5 print:hidden">
        <HiOutlineExclamationTriangle className="w-4 h-4 shrink-0 mt-0.5" />
        <span>
          Los <b>importes</b> son auditables: el RDEP sale de las nóminas cerradas del año (la misma
          fuente que el casillero de relación de dependencia del 103) y el anexo de accionistas, de lo
          que se registre aquí. El <b>XML</b> es un <b>borrador técnico</b>: no está validado contra el
          XSD vigente del SRI ni es un archivo DIMM. Use el Excel para revisar y transcribir al DIMM.
        </span>
      </div>

      <div className="flex gap-1 border-b border-slate-200">
        {[['rdep', 'RDEP — Relación de dependencia'], ['aps', 'Anexo de Accionistas']].map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${tab === k ? 'border-emerald-600 text-emerald-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'rdep' ? <RdepTab year={year} /> : <ApsTab year={year} />}
    </div>
  );
}

// ─────────────────────────────────── RDEP ───────────────────────────────────

function RdepTab({ year }) {
  const [data, setData] = useState(null);
  const [dirty, setDirty] = useState({}); // { identificacion: { campo: valor } }
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get('/sri-annexes/rdep', { params: { year } });
      setData(r.data);
      setDirty({});
    } catch (e) { toast.error(e.response?.data?.message || 'No se pudo cargar el RDEP'); }
    finally { setLoading(false); }
  }, [year]);

  useEffect(() => { load(); }, [load]);

  const setCell = (ident, key, value) => setDirty((d) => ({ ...d, [ident]: { ...(d[ident] || {}), [key]: value } }));
  const cellValue = (row, key) => (dirty[row.identificacion]?.[key] !== undefined ? dirty[row.identificacion][key] : row[key] ?? 0);

  const save = async () => {
    setSaving(true);
    try {
      const entries = Object.fromEntries(Object.entries(dirty).map(([ident, patch]) => [
        ident, Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, Number(v) || 0])),
      ]));
      const r = await api.put('/sri-annexes/rdep', { entries }, { params: { year } });
      setData(r.data);
      setDirty({});
      toast.success('RDEP guardado');
    } catch (e) { toast.error(e.response?.data?.message || 'No se pudo guardar'); }
    finally { setSaving(false); }
  };

  const download = async (kind) => {
    const url = kind === 'xlsx' ? '/sri-annexes/rdep/export.xlsx' : '/sri-annexes/rdep/draft.xml';
    const filename = kind === 'xlsx' ? `rdep-${year}.xlsx` : `borrador-tecnico-rdep-${year}.xml`;
    try { await downloadFile(url, { filename, params: { year } }); }
    catch (e) { toast.error(e.message); }
  };

  const rows = data?.rows || [];
  const totals = data?.totals || {};

  return (
    <div className="space-y-3">
      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div>
            <h2 className="font-semibold text-slate-800">Anexo de retenciones en relación de dependencia (RDEP) {year}</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Detalle anual, empleado por empleado, de lo que el Formulario 103 declaró mes a mes en el casillero laboral.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={save} disabled={!Object.keys(dirty).length || saving} className="px-3 py-1.5 bg-amber-500 text-white rounded-lg text-sm disabled:opacity-50">
              {saving ? 'Guardando…' : 'Guardar capturado'}
            </button>
            <button onClick={() => download('xlsx')} className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-sm flex items-center gap-1">
              <HiOutlineArrowDownTray className="w-4 h-4" /> Excel
            </button>
            <button onClick={() => download('xml')} className="px-3 py-1.5 bg-slate-200 text-slate-700 rounded-lg text-sm flex items-center gap-1" title="No es el XML oficial del SRI">
              <HiOutlineArrowDownTray className="w-4 h-4" /> Borrador técnico (XML)
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          <Chip label="Empleados" value={totals.empleados ?? 0} />
          <Chip label="Ingresos gravados" value={`$${fmt(totals.gravadoEmpleador)}`} />
          <Chip label="Aporte IESS" value={`$${fmt(totals.iessPersonal)}`} />
          <Chip label="Base imponible" value={`$${fmt(totals.baseImponible)}`} tone="sky" />
          <Chip label="IR retenido" value={`$${fmt(totals.retenidoEmpleador)}`} tone="emerald" />
        </div>
      </div>

      <Warnings items={data?.warnings} />

      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden">
        <div className="px-4 py-2 bg-slate-100 text-xs uppercase font-semibold text-slate-600 flex flex-wrap items-center gap-2">
          Detalle por empleado
          <span className="normal-case font-normal text-slate-400">
            Las columnas en <b className="text-amber-700">ámbar</b> las captura el contador (el empleado las declara);
            el resto sale de la nómina y no se edita.
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-[10px] uppercase text-slate-500">
              <tr>
                <th className="px-2 py-2 text-left sticky left-0 bg-slate-50 z-10">Empleado</th>
                <th className="px-2 py-2 text-right">Sueldos</th>
                <th className="px-2 py-2 text-right">Sobresueldos</th>
                <th className="px-2 py-2 text-right">Gravado</th>
                <th className="px-2 py-2 text-right">IESS</th>
                {RDEP_INPUTS.map((c) => (
                  <th key={c.key} className="px-2 py-2 text-right bg-amber-50 text-amber-700">{c.label}</th>
                ))}
                <th className="px-2 py-2 text-right">Base imponible</th>
                <th className="px-2 py-2 text-right">IR causado</th>
                <th className="px-2 py-2 text-right">IR retenido</th>
                <th className="px-2 py-2 text-right">Diferencia</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={20} className="px-3 py-8 text-center text-slate-400">Cargando…</td></tr>}
              {!loading && !rows.length && (
                <tr><td colSpan={20} className="px-3 py-8 text-center text-slate-400">
                  Sin nóminas cerradas en {year}: no hay nada que reportar en el RDEP.
                </td></tr>
              )}
              {rows.map((r) => (
                <tr key={r.identificacion} className="border-t border-slate-100">
                  <td className="px-2 py-1.5 sticky left-0 bg-white z-10">
                    <div className="font-medium text-slate-700 whitespace-nowrap">{r.nombre}</div>
                    <div className="text-[10px] text-slate-400 font-mono">{r.identificacion} · {r.meses} rol(es)</div>
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono">{fmt(r.sueldos)}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{fmt(r.sobresueldos)}</td>
                  <td className="px-2 py-1.5 text-right font-mono font-semibold">{fmt(r.gravadoEmpleador)}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{fmt(r.iessPersonal)}</td>
                  {RDEP_INPUTS.map((c) => (
                    <td key={c.key} className="px-1 py-1 bg-amber-50/40">
                      <NumericInput
                        step="0.01"
                        value={cellValue(r, c.key)}
                        onChange={(e) => setCell(r.identificacion, c.key, e.target.value)}
                        className="w-20 border border-amber-300 bg-amber-50/60 rounded px-1.5 py-1 text-right font-mono text-xs"
                      />
                    </td>
                  ))}
                  <td className="px-2 py-1.5 text-right font-mono font-semibold">{fmt(r.baseImponible)}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{fmt(r.impuestoCausado)}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{fmt(r.retenidoEmpleador)}</td>
                  <td className={`px-2 py-1.5 text-right font-mono ${Math.abs(r.saldoPorRetener) > 0.5 ? 'text-rose-600 font-semibold' : 'text-slate-400'}`}>
                    {fmt(r.saldoPorRetener)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length > 0 && (
          <p className="px-4 py-2 text-[11px] text-slate-400">
            «Diferencia» = impuesto causado − retenido por este empleador − retenido por otros. Distinto de cero
            significa que en el ejercicio se retuvo de menos (positivo) o de más (negativo): revíselo con su contador
            antes de presentar el anexo.
          </p>
        )}
      </div>

      <Conciliaciones items={data?.conciliaciones} />
    </div>
  );
}

// ────────────────────────── Anexo de Accionistas (APS) ──────────────────────────

function ApsTab({ year }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [modal, setModal] = useState(null); // { ...shareholder, _id? }
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get('/sri-annexes/aps', { params: { year } });
      setData(r.data);
    } catch (e) { toast.error(e.response?.data?.message || 'No se pudo cargar el anexo'); }
    finally { setLoading(false); }
  }, [year]);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!modal.identificacion?.trim()) return toast.error('Ingresa la identificación');
    if (!modal.razonSocial?.trim()) return toast.error('Ingresa los apellidos y nombres o la razón social');
    setSaving(true);
    try {
      const payload = { ...modal, fechaDesde: modal.fechaDesde || null, fechaHasta: modal.fechaHasta || null };
      if (modal._id) await api.put(`/sri-annexes/shareholders/${modal._id}`, payload);
      else await api.post('/sri-annexes/shareholders', payload);
      toast.success(modal._id ? 'Actualizado' : 'Registrado');
      setModal(null);
      load();
    } catch (e) { toast.error(e.response?.data?.message || 'No se pudo guardar'); }
    finally { setSaving(false); }
  };

  const remove = async (row) => {
    if (!confirm(`¿Quitar a ${row.razonSocial} del anexo? Si solo dejó de ser titular, es mejor ponerle una fecha "hasta" para conservar el histórico.`)) return;
    try { await api.delete(`/sri-annexes/shareholders/${row._id}`); toast.success('Eliminado'); load(); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  const download = async (kind) => {
    const url = kind === 'xlsx' ? '/sri-annexes/aps/export.xlsx' : '/sri-annexes/aps/draft.xml';
    const filename = kind === 'xlsx' ? `anexo-accionistas-${year}.xlsx` : `borrador-tecnico-accionistas-${year}.xml`;
    try { await downloadFile(url, { filename, params: { year } }); }
    catch (e) { toast.error(e.message); }
  };

  const rows = data?.rows || [];
  const totals = data?.totals || {};
  const pctOk = Math.abs((totals.porcentajeTotal || 0) - 100) <= 0.01;

  return (
    <div className="space-y-3">
      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div>
            <h2 className="font-semibold text-slate-800 flex items-center gap-2">
              <HiOutlineUsers className="text-emerald-600" /> Accionistas, socios, partícipes y administradores {year}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Composición societaria al corte del ejercicio. La participación de los titulares de capital debe sumar 100 %.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setModal({ ...EMPTY_SHAREHOLDER })} className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-sm flex items-center gap-1">
              <HiOutlinePlus className="w-4 h-4" /> Nuevo
            </button>
            <button onClick={() => download('xlsx')} className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-sm flex items-center gap-1">
              <HiOutlineArrowDownTray className="w-4 h-4" /> Excel
            </button>
            <button onClick={() => download('xml')} className="px-3 py-1.5 bg-slate-200 text-slate-700 rounded-lg text-sm flex items-center gap-1" title="No es el XML oficial del SRI">
              <HiOutlineArrowDownTray className="w-4 h-4" /> Borrador técnico (XML)
            </button>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Chip label="Titulares de capital" value={totals.titulares ?? 0} />
          <Chip label="% total" value={`${fmt(totals.porcentajeTotal)} %`} tone={pctOk ? 'emerald' : 'rose'} />
          <Chip label="Capital declarado" value={`$${fmt(totals.capitalTotal)}`} />
          <Chip label="Directorio / administración" value={totals.otrosRoles ?? 0} tone="sky" />
        </div>
      </div>

      <Warnings items={data?.warnings} />

      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left">Calidad</th>
                <th className="px-3 py-2 text-left">Identificación</th>
                <th className="px-3 py-2 text-left">Apellidos y nombres / Razón social</th>
                <th className="px-3 py-2 text-left">Residencia</th>
                <th className="px-3 py-2 text-right">% part.</th>
                <th className="px-3 py-2 text-right">Capital</th>
                <th className="px-3 py-2 text-right">Acciones</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={8} className="px-3 py-8 text-center text-slate-400">Cargando…</td></tr>}
              {!loading && !rows.length && (
                <tr><td colSpan={8} className="px-3 py-8 text-center text-slate-400">
                  Aún no hay accionistas registrados. Usa «Nuevo» para capturar la composición societaria.
                </td></tr>
              )}
              {rows.map((r) => (
                <tr key={r._id} className="border-t border-slate-100">
                  <td className="px-3 py-2">
                    <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${r.titularDeCapital ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>
                      {ROLE_LABEL[r.role] || r.role}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {r.identificacion}
                    <div className="text-[10px] text-slate-400">{r.tipoIdentificacion} · {r.tipoPersona === 'JURIDICA' ? 'Sociedad' : 'Natural'}</div>
                  </td>
                  <td className="px-3 py-2 text-slate-700">{r.razonSocial}</td>
                  <td className="px-3 py-2 text-slate-600">
                    {r.paisResidencia || '—'}
                    {r.paraisoFiscal && <span className="ml-1 text-[10px] text-rose-600 font-medium">paraíso fiscal</span>}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{fmt(r.porcentajeParticipacion)} %</td>
                  <td className="px-3 py-2 text-right font-mono">{fmt(r.capitalInvertido)}</td>
                  <td className="px-3 py-2 text-right font-mono">{r.numeroAcciones || 0}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <button
                      onClick={() => setModal({
                        ...EMPTY_SHAREHOLDER, ...r,
                        fechaDesde: r.fechaDesde ? String(r.fechaDesde).slice(0, 10) : '',
                        fechaHasta: r.fechaHasta ? String(r.fechaHasta).slice(0, 10) : '',
                      })}
                      className="p-1.5 text-slate-500 hover:text-emerald-700" title="Editar"
                    >
                      <HiOutlinePencilSquare className="w-4 h-4" />
                    </button>
                    <button onClick={() => remove(r)} className="p-1.5 text-slate-400 hover:text-rose-600" title="Eliminar">
                      <HiOutlineTrash className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
              {rows.length > 0 && (
                <tr className="border-t-2 border-slate-200 bg-slate-50/80 font-semibold">
                  <td className="px-3 py-2" colSpan={4}>Total titulares de capital</td>
                  <td className={`px-3 py-2 text-right font-mono ${pctOk ? 'text-emerald-700' : 'text-rose-600'}`}>{fmt(totals.porcentajeTotal)} %</td>
                  <td className="px-3 py-2 text-right font-mono">{fmt(totals.capitalTotal)}</td>
                  <td className="px-3 py-2 text-right font-mono">{totals.accionesTotal || 0}</td>
                  <td />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Conciliaciones items={data?.conciliaciones} />

      <Modal isOpen={!!modal} onClose={() => setModal(null)} title={modal?._id ? 'Editar registro del anexo' : 'Nuevo accionista / socio / administrador'} size="lg">
        {modal && (
          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Field label="Calidad" required>
                <select value={modal.role} onChange={(e) => setModal({ ...modal, role: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm bg-white">
                  {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </Field>
              <Field label="Tipo de persona">
                <select value={modal.tipoPersona} onChange={(e) => setModal({ ...modal, tipoPersona: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm bg-white">
                  <option value="NATURAL">Persona natural</option>
                  <option value="JURIDICA">Sociedad</option>
                </select>
              </Field>
              <Field label="Tipo de identificación">
                <select value={modal.tipoIdentificacion} onChange={(e) => setModal({ ...modal, tipoIdentificacion: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm bg-white">
                  <option value="CEDULA">Cédula</option>
                  <option value="RUC">RUC</option>
                  <option value="PASAPORTE">Pasaporte</option>
                </select>
              </Field>
              <Field label="Identificación" required>
                <input value={modal.identificacion} onChange={(e) => setModal({ ...modal, identificacion: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm font-mono" />
              </Field>
              <Field label="Apellidos y nombres / Razón social" required className="sm:col-span-2">
                <input value={modal.razonSocial} onChange={(e) => setModal({ ...modal, razonSocial: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm" />
              </Field>
              <Field label="País de residencia" hint="Define la retención de dividendos.">
                <input value={modal.paisResidencia} onChange={(e) => setModal({ ...modal, paisResidencia: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm" />
              </Field>
              <Field label="% de participación" hint="Los miembros del directorio van en 0.">
                <NumericInput value={modal.porcentajeParticipacion} onChange={(e) => setModal({ ...modal, porcentajeParticipacion: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm text-right" />
              </Field>
              <Field label="Capital invertido">
                <NumericInput value={modal.capitalInvertido} onChange={(e) => setModal({ ...modal, capitalInvertido: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm text-right" />
              </Field>
              <Field label="N° de acciones">
                <NumericInput allowDecimal={false} value={modal.numeroAcciones} onChange={(e) => setModal({ ...modal, numeroAcciones: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm text-right" />
              </Field>
              <Field label="Titular desde">
                <input type="date" value={modal.fechaDesde} onChange={(e) => setModal({ ...modal, fechaDesde: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm" />
              </Field>
              <Field label="Titular hasta" hint="Con fecha, deja de contar en el anexo desde ese corte.">
                <input type="date" value={modal.fechaHasta} onChange={(e) => setModal({ ...modal, fechaHasta: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm" />
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" checked={!!modal.paraisoFiscal} onChange={(e) => setModal({ ...modal, paraisoFiscal: e.target.checked })} />
              Reside en un paraíso fiscal o régimen fiscal preferente
            </label>
            <Field label="Observación">
              <input value={modal.notes} onChange={(e) => setModal({ ...modal, notes: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm" />
            </Field>
            <div className="flex justify-end gap-2 pt-2 border-t">
              <button onClick={() => setModal(null)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button>
              <button onClick={save} disabled={saving} className="px-4 py-2 bg-emerald-600 text-white rounded-xl disabled:opacity-60">
                {saving ? 'Guardando…' : 'Guardar'}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

// ─────────────────────────────── Compartidos ───────────────────────────────

function Warnings({ items }) {
  if (!items?.length) return null;
  return (
    <div className="bg-white rounded-2xl shadow-sm p-3 space-y-1">
      {items.map((w, i) => (
        <div key={i} className={`text-xs rounded-lg px-3 py-2 flex items-start gap-1.5 ${w.severity === 'info' ? 'bg-sky-50 text-sky-800 border border-sky-200' : 'bg-amber-50 text-amber-800 border border-amber-200'}`}>
          <HiOutlineExclamationTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{w.message}</span>
        </div>
      ))}
    </div>
  );
}

function Conciliaciones({ items }) {
  if (!items?.length) return null;
  return (
    <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden">
      <div className="px-4 py-2 bg-slate-100 text-xs uppercase font-semibold text-slate-600">Conciliaciones</div>
      <div className="divide-y">
        {items.map((c) => (
          <div key={c.key} className="px-4 py-2 flex items-start gap-2">
            {c.ok
              ? <HiOutlineCheckCircle className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
              : <HiOutlineExclamationTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />}
            <div>
              <div className="text-sm text-slate-700">{c.label}</div>
              <div className="text-xs text-slate-500">{c.detalle}</div>
            </div>
          </div>
        ))}
      </div>
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
