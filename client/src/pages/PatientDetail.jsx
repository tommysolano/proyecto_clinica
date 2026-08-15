import { useEffect, useState, Fragment, useRef } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import api from '../api/axios';
import { downloadFile } from '../utils/download';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { fmtDate, nowEcHHMM } from '../utils/date';
import TagEditor from '../components/TagEditor';
import NumericInput from '../components/NumericInput';
import SearchableSelect from '../components/SearchableSelect';
import Cie10Select from '../components/Cie10Select';
import Odontograma from '../components/Odontograma';
import {
  ANTECEDENTES_CATEGORIAS,
  REVISION_SISTEMAS,
  EXAMEN_REGIONAL,
  EXAMEN_SISTEMICO,
  calcIMC,
} from '../constants/mspCatalogs';
import {
  PODOLOGIA_HALLAZGOS,
  PODOLOGIA_EVALUACION,
  PODOLOGIA_HALLAZGOS_GENERALES,
  PODOLOGIA_PULSO_OPCIONES,
  PODOLOGIA_SENSIBILIDAD_OPCIONES,
  PODOLOGIA_REFLEJOS_OPCIONES,
  ODONTOGRAMA_ESTADOS,
  ODONTOGRAMA_CARAS,
  HIGIENE_ORAL_FILAS,
  HIGIENE_ORAL_INDICES,
  ENFERMEDAD_PERIODONTAL,
  MALOCLUSION,
  FLUOROSIS,
  INDICE_CPO,
  INDICE_CEO,
  COSMETOLOGIA_FOTOTIPOS,
  COSMETOLOGIA_GLOGAU,
  COSMETOLOGIA_BIOTIPOS,
  COSMETOLOGIA_ARRUGAS,
  COSMETOLOGIA_ACNE,
  COSMETOLOGIA_ROSACEA,
  COSMETOLOGIA_LESIONES,
  COSMETOLOGIA_HIPERPIGMENTACION,
  COSMETOLOGIA_DESHIDRATACION,
  COSMETOLOGIA_CABELLO,
  COSMETOLOGIA_CABELLO_TRATAMIENTOS,
  COSMETOLOGIA_CUERO_CABELLUDO,
  COSMETOLOGIA_FIBRA_CAPILAR,
  COSMETOLOGIA_AFECCIONES_CUERO,
  optionLabel,
} from '../constants/specialtyCatalogs';
import {
  HiOutlineArrowLeft,
  HiOutlineUser,
  HiOutlineClipboardDocumentList,
  HiOutlineHeart,
  HiOutlineCalendar,
  HiOutlineDocumentText,
  HiOutlinePlus,
  HiOutlineTrash,
  HiOutlinePrinter,
  HiOutlineArrowDownTray,
  HiOutlineShoppingBag,
  HiOutlinePencilSquare,
  HiOutlineChevronDown,
} from 'react-icons/hi2';
import DateInput from '../components/DateInput';

const TABS = [
  { id: 'datos', label: 'Datos', icon: HiOutlineUser },
  { id: 'ficha', label: 'Ficha clínica', icon: HiOutlineClipboardDocumentList },
  { id: 'seguimientos', label: 'Seguimientos', icon: HiOutlineHeart },
  { id: 'citas', label: 'Citas', icon: HiOutlineCalendar },
  { id: 'facturas', label: 'Facturas', icon: HiOutlineDocumentText },
];

// Adjuntos permitidos en seguimientos: PDFs e imágenes.
const isAllowedAttachment = (file) =>
  !!file && (file.type === 'application/pdf' || String(file.type || '').startsWith('image/'));

export default function PatientDetail() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const appointmentId = searchParams.get('appointment') || null;
  const tabParam = searchParams.get('tab') || null;
  const { hasRole } = useAuth();
  const initialTab = tabParam
    ? tabParam
    : appointmentId
      ? (hasRole('doctor', 'optica') ? 'ficha' : 'seguimientos')
      : 'datos';
  const [tab, setTab] = useState(initialTab);
  const [patient, setPatient] = useState(null);
  const [loading, setLoading] = useState(true);
  const [aptData, setAptData] = useState(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get(`/patients/${id}`);
        setPatient(res.data);
      } catch (err) {
        toast.error(err.response?.data?.message || 'Error al cargar paciente');
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  useEffect(() => {
    if (!appointmentId) return;
    api.get(`/appointments/${appointmentId}`)
      .then((r) => setAptData(r.data))
      .catch(() => {});
  }, [appointmentId]);

  useEffect(() => {
    if (!aptData?.consultationStartedAt || aptData?.consultationEndedAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [aptData?.consultationStartedAt, aptData?.consultationEndedAt]);

  const endConsultation = async () => {
    try {
      await api.post(`/appointments/${appointmentId}/end`);
      setAptData((d) => ({ ...d, consultationEndedAt: new Date().toISOString() }));
      toast.success('Consulta finalizada');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al finalizar');
    }
  };

  const timerSeconds = aptData?.consultationStartedAt && !aptData?.consultationEndedAt
    ? Math.max(0, Math.floor((now - new Date(aptData.consultationStartedAt).getTime()) / 1000))
    : null;

  const fmtTimer = (s) =>
    `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  const timerStyle = timerSeconds === null ? null
    : timerSeconds >= 19 * 60 ? 'bg-red-50 border-red-300 text-red-600'
    : timerSeconds >= 14 * 60 ? 'bg-amber-50 border-amber-300 text-amber-600'
    : 'bg-emerald-50 border-emerald-300 text-emerald-600';

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-600"></div>
      </div>
    );
  }

  if (!patient) {
    return <div className="p-6">Paciente no encontrado.</div>;
  }

  // Filtrar tabs visibles según rol
  const visibleTabs = TABS.filter((t) => {
    if (t.id === 'facturas') return hasRole('admin', 'cajero', 'contabilidad');
    return true;
  });

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <Link
        to="/patients"
        className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-emerald-600 mb-4 no-underline"
      >
        <HiOutlineArrowLeft className="w-4 h-4" /> Volver a pacientes
      </Link>

      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 p-6 mb-6">
        <div className="flex items-start gap-4">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-white font-bold text-xl">
            {patient.firstName?.[0]}
            {patient.lastName?.[0]}
          </div>
          <div className="flex-1">
            <h1 className="text-2xl font-bold text-slate-800 tracking-tight">
              {patient.firstName} {patient.lastName}
            </h1>
            <p className="text-sm text-slate-500 mt-1">
              {hasRole('doctor', 'optica') ? (
                <>Edad: {patient.computedAge ?? patient.age ?? '—'}</>
              ) : (
                <>
                  CI: {patient.cedula} {patient.phone ? ` · ${patient.phone}` : ''}
                  {patient.email ? ` · ${patient.email}` : ''}
                </>
              )}
            </p>
            <div className="mt-2">
              <TagEditor
                value={patient.tags || []}
                onChange={async (next) => {
                  const prev = patient.tags || [];
                  setPatient({ ...patient, tags: next });
                  try {
                    await api.put(`/patients/${patient._id}`, { tags: next });
                  } catch (err) {
                    toast.error(err.response?.data?.message || 'No se pudieron guardar las etiquetas');
                    setPatient({ ...patient, tags: prev });
                  }
                }}
              />
            </div>
          </div>
          {timerSeconds !== null && (
            <div className="flex flex-col items-end gap-1 ml-4 shrink-0">
              <span className="text-xs text-slate-400">{fmtDate(new Date().toISOString())}</span>
              <div className={`flex items-center gap-2 px-4 py-2 rounded-xl border font-mono text-2xl font-bold tabular-nums transition-colors ${timerStyle}`}>
                <span>⏱</span>
                <span>{fmtTimer(timerSeconds)}</span>
              </div>
              <button
                onClick={endConsultation}
                className="text-xs text-slate-400 hover:text-red-600 bg-transparent border-none cursor-pointer transition-colors"
              >
                Finalizar consulta
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 overflow-hidden">
        <div className="flex border-b border-slate-200 overflow-x-auto">
          {visibleTabs.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-2 px-5 py-3 text-sm font-medium border-none cursor-pointer transition-colors whitespace-nowrap ${
                  tab === t.id
                    ? 'bg-emerald-50 text-emerald-700 border-b-2 border-emerald-600'
                    : 'bg-transparent text-slate-500 hover:text-slate-700 hover:bg-slate-50'
                }`}
              >
                <Icon className="w-4 h-4" />
                {t.label}
              </button>
            );
          })}
        </div>

        <div className="p-6">
          {tab === 'datos' && <DatosTab patient={patient} />}
          {tab === 'ficha' && <FichaTab patientId={id} />}
          {tab === 'seguimientos' && <SeguimientosTab patientId={id} appointmentId={appointmentId} />}
          {tab === 'citas' && <CitasTab patientId={id} />}
          {tab === 'facturas' && <FacturasTab patientId={id} />}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── Datos ─────────────────────────
function DatosTab({ patient }) {
  const { hasRole } = useAuth();
  const isDoctor = hasRole('doctor', 'optica');
  const sourceLabels = {
    anuncio: 'Anuncio',
    referido: 'Referido',
    recepcion: 'Recepción',
    organico: 'Orgánico',
  };
  return (
    <div className="space-y-6">
      <dl className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
        {!isDoctor && <Item label="Cédula" value={patient.cedula} />}
        <Item label="Nombre completo" value={`${patient.firstName} ${patient.lastName}`} />
        <Item label="Email" value={patient.email} />
        {!isDoctor && <Item label="Teléfono" value={patient.phone} />}
        <Item label="WhatsApp" value={patient.whatsapp} />
        <Item
          label="Marketing"
          value={
            patient.marketing?.optOutAt || patient.marketing?.whatsappOptIn === false
              ? 'Opt-out activo'
              : 'Opt-in WhatsApp'
          }
        />
        <Item
          label="Fecha de nacimiento"
          value={patient.birthDate ? fmtDate(patient.birthDate) : '—'}
        />
        <Item label="Edad" value={patient.computedAge ?? patient.age ?? '—'} />
        <Item label="Género" value={patient.gender} />
        {!isDoctor && <Item label="Dirección" value={patient.address} />}
        <Item
          label="Origen del paciente"
          value={
            patient.source
              ? `${sourceLabels[patient.source] || patient.source}${patient.referredByName ? ` (${patient.referredByName})` : ''}`
              : '—'
          }
        />
      </dl>
    </div>
  );
}

function Item({ label, value, full }) {
  return (
    <div className={full ? 'md:col-span-2' : ''}>
      <dt className="text-xs uppercase text-slate-500 font-semibold">{label}</dt>
      <dd className="text-slate-800 mt-0.5">{value || '—'}</dd>
    </div>
  );
}

// ───────────────────── Ficha clínica ─────────────────────
function FichaTab({ patientId }) {
  const { hasRole } = useAuth();
  const [record, setRecord] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get(`/clinical-records/${patientId}`);
      setRecord(res.data);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al cargar ficha');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId]);

  const update = (path, value) => {
    setRecord((r) => {
      const copy = { ...r };
      const parts = path.split('.');
      let target = copy;
      for (let i = 0; i < parts.length - 1; i++) {
        target[parts[i]] = { ...(target[parts[i]] || {}) };
        target = target[parts[i]];
      }
      target[parts[parts.length - 1]] = value;
      return copy;
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        fecha: record.fecha,
        nombre: record.nombre,
        direccion: record.direccion,
        edad: record.edad,
        cedula: record.cedula,
        celular: record.celular,
        patologicosPersonales: record.patologicosPersonales || [],
        patologicosFamiliares: record.patologicosFamiliares || [],
        datosRelevantes: record.datosRelevantes || '',
        datosRelevantesFamiliares: record.datosRelevantesFamiliares || '',
      };
      const res = await api.put(`/clinical-records/${patientId}`, payload);
      setRecord(res.data);
      toast.success('Ficha guardada');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="text-slate-500 text-sm">Cargando...</div>;
  if (!record) return null;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Fecha">
          <DateInput
            value={record.fecha ? record.fecha.substring(0, 10) : ''}
            onChange={(e) => update('fecha', e.target.value)}
            className="input"
          />
        </Field>
        <Field label="Edad">
          <input
            type="text"
            inputMode="numeric"
            value={record.edad ?? ''}
            onChange={(e) => {
              const val = e.target.value.replace(/\D/g, '');
              update('edad', val === '' ? '' : Number(val));
            }}
            className="input"
          />
        </Field>
        <Field label="Nombre">
          <input
            type="text"
            value={record.nombre || ''}
            onChange={(e) => update('nombre', e.target.value)}
            className="input"
          />
        </Field>
        {!hasRole('doctor') && (
          <Field label="Cédula">
            <input
              type="text"
              value={record.cedula || ''}
              onChange={(e) => update('cedula', e.target.value)}
              className="input"
            />
          </Field>
        )}
        {!hasRole('doctor') && (
          <Field label="Dirección">
            <input
              type="text"
              value={record.direccion || ''}
              onChange={(e) => update('direccion', e.target.value)}
              className="input"
            />
          </Field>
        )}
        {!hasRole('doctor') && (
          <Field label="Celular">
            <input
              type="text"
              value={record.celular || ''}
              onChange={(e) => update('celular', e.target.value)}
              className="input"
            />
          </Field>
        )}
      </div>

      {/* C. Antecedentes patológicos personales (10 categorías MSP) */}
      <div className="space-y-3 pt-2 border-t border-slate-100">
        <div>
          <h3 className="font-semibold text-slate-800">Antecedentes patológicos personales</h3>
          <p className="text-xs text-slate-400">Marque las presentes y descríbalas en el campo de abajo. Datos clínico-quirúrgicos, obstétricos y alérgicos relevantes.</p>
        </div>
        <MspChecklist
          catalog={ANTECEDENTES_CATEGORIAS}
          value={record.patologicosPersonales}
          onChange={(v) => update('patologicosPersonales', v)}
          showDetail={false}
        />
        <Field label="Datos relevantes (clínico-quirúrgicos, obstétricos, alérgicos)">
          <textarea
            rows={2}
            value={record.datosRelevantes || ''}
            onChange={(e) => update('datosRelevantes', e.target.value)}
            className="input resize-none"
          />
        </Field>
      </div>

      {/* D. Antecedentes patológicos familiares (10 categorías MSP) */}
      <div className="space-y-3 pt-2 border-t border-slate-100">
        <div>
          <h3 className="font-semibold text-slate-800">Antecedentes patológicos familiares</h3>
          <p className="text-xs text-slate-400">Marque las presentes en familiares directos y descríbalas en el campo de abajo.</p>
        </div>
        <MspChecklist
          catalog={ANTECEDENTES_CATEGORIAS}
          value={record.patologicosFamiliares}
          onChange={(v) => update('patologicosFamiliares', v)}
          showDetail={false}
        />
        <Field label="Datos relevantes (clínico-quirúrgicos, obstétricos, alérgicos)">
          <textarea
            rows={2}
            value={record.datosRelevantesFamiliares || ''}
            onChange={(e) => update('datosRelevantesFamiliares', e.target.value)}
            className="input resize-none"
          />
        </Field>
      </div>

      <div className="flex justify-end pt-3 border-t border-slate-100">
        <button
          onClick={save}
          disabled={saving}
          className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-medium disabled:opacity-50 cursor-pointer border-none text-sm"
        >
          {saving ? 'Guardando...' : 'Guardar ficha'}
        </button>
      </div>

      <FichaStyles />
    </div>
  );
}

// ─────────────── Componentes MSP compartidos ───────────────
// Rejilla de casillas del formulario MSP (antecedentes C/D, revisión de sistemas
// G, examen físico H). `value` es un array [{ key, marked, detail }]; solo se
// emiten las casillas marcadas o con detalle. `markLabel` describe qué significa
// marcar (p.ej. "presente" o "patología").
// `showDetail={false}` deja solo las casillas (sin recuadro por casilla): en el
// seguimiento lo describido va en un único campo de hallazgos al pie de la sección.
function MspChecklist({ catalog, value = [], onChange, cols = 'md:grid-cols-3 lg:grid-cols-5', showDetail = true }) {
  const byKey = Object.fromEntries((value || []).map((c) => [c.key, c]));
  const emit = (nextByKey) => {
    const arr = catalog
      .map((cat) => nextByKey[cat.key])
      .filter((c) => c && (c.marked || (c.detail && c.detail.trim())));
    onChange(arr);
  };
  const toggle = (key) => {
    const cur = byKey[key] || { key, marked: false, detail: '' };
    emit({ ...byKey, [key]: { ...cur, key, marked: !cur.marked } });
  };
  const setDetail = (key, detail) => {
    const cur = byKey[key] || { key, marked: false, detail: '' };
    emit({ ...byKey, [key]: { ...cur, key, detail } });
  };
  return (
    <div className={`grid grid-cols-2 ${cols} gap-2`}>
      {catalog.map((cat) => {
        const cur = byKey[cat.key];
        const marked = !!cur?.marked;
        return (
          <div
            key={cat.key}
            className={`rounded-lg border p-2 transition-colors ${
              marked ? 'border-emerald-300 bg-emerald-50' : 'border-slate-200 bg-white'
            }`}
          >
            <label className="flex items-center gap-2 cursor-pointer text-xs font-medium text-slate-700">
              <input
                type="checkbox"
                checked={marked}
                onChange={() => toggle(cat.key)}
                className="accent-emerald-600 cursor-pointer"
              />
              <span>{cat.label}</span>
            </label>
            {showDetail && marked && (
              <input
                type="text"
                value={cur?.detail || ''}
                onChange={(e) => setDetail(cat.key, e.target.value)}
                placeholder="Describa…"
                className="input mt-2 text-xs py-1"
              />
            )}
            {/* Sin recuadro por casilla: lo que ya se había descrito en fichas
                antiguas se sigue viendo, en solo lectura. */}
            {!showDetail && cur?.detail?.trim() && (
              <p className="mt-1 text-[11px] text-slate-500 italic break-words">{cur.detail}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Devuelve las casillas marcadas de un checklist MSP con su etiqueta legible.
// `detail` solo lo traen seguimientos antiguos (antes había un recuadro por casilla).
function markedItems(catalog, value) {
  const byKey = Object.fromEntries((value || []).map((c) => [c.key, c]));
  return catalog
    .filter((cat) => byKey[cat.key]?.marked || String(byKey[cat.key]?.detail || '').trim())
    .map((cat) => ({ key: cat.key, label: cat.label, detail: String(byKey[cat.key]?.detail || '').trim() }));
}

// Resumen de un checklist MSP en el historial: las casillas marcadas como
// etiquetas, para que el doctor vea de un vistazo lo que registró en la consulta.
// `groups` permite varias sublistas en un mismo bloque (regional / sistémico).
function ChecksSummary({ title, groups = [], hallazgos, tone = 'amber' }) {
  const hasChecks = groups.some((g) => g.items.length > 0);
  if (!hasChecks && !hallazgos) return null;
  const tones = {
    amber: 'bg-amber-50 border-amber-200 text-amber-700',
    violet: 'bg-violet-50 border-violet-200 text-violet-700',
  };
  return (
    <div className={`mt-2 border rounded p-2 ${tones[tone]}`}>
      <p className="text-[11px] font-semibold uppercase mb-1">{title}</p>
      {groups.map((g) => g.items.length > 0 && (
        <div key={g.label || 'unico'} className="mb-1 last:mb-0">
          {g.label && <span className="text-[10px] uppercase opacity-70 mr-1">{g.label}:</span>}
          <span className="inline-flex flex-wrap gap-1 align-middle">
            {g.items.map((it) => (
              <span key={it.key} className="text-[11px] bg-white/70 border border-slate-200 rounded px-1.5 py-0.5 text-slate-700">
                {it.label}
                {it.detail && <span className="text-slate-500">: {it.detail}</span>}
              </span>
            ))}
          </span>
        </div>
      ))}
      {hallazgos && <p className="text-xs text-slate-700 mt-1 whitespace-pre-wrap">{hallazgos}</p>}
    </div>
  );
}

// Sección plegable (para mantener el seguimiento ágil: examen físico, revisión,
// etc., se abren solo cuando el médico los necesita).
function Collapsible({ title, hint, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3 bg-slate-100 hover:bg-slate-200 cursor-pointer border-none text-left transition-colors"
      >
        <span className="text-sm font-semibold text-slate-700">
          {title}
          {hint && <span className="ml-2 text-xs font-normal text-slate-400">{hint}</span>}
        </span>
        <HiOutlineChevronDown className={`w-5 h-5 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="p-4 bg-white">{children}</div>}
    </div>
  );
}

// I. Editor de diagnósticos con CIE-10 (hasta 6). Cada fila: descripción,
// buscador CIE-10, y marcas PRE (presuntivo) / DEF (definitivo).
function DiagnosticosEditor({ value = [], onChange }) {
  const rows = value.length ? value : [];
  const update = (idx, patch) => onChange(rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  const add = () =>
    onChange([...rows, { descripcion: '', cie: '', cieDescripcion: '', presuntivo: false, definitivo: false }]);
  const remove = (idx) => onChange(rows.filter((_, i) => i !== idx));
  return (
    <div className="space-y-2">
      {rows.length === 0 && (
        <p className="text-xs text-slate-400">Sin diagnósticos. Agregue al menos uno para cumplir el formato.</p>
      )}
      {rows.map((r, idx) => (
        <div key={idx} className="grid grid-cols-1 md:grid-cols-12 gap-2 items-start bg-slate-50 rounded-lg p-2">
          <div className="md:col-span-5">
            <input
              type="text"
              value={r.descripcion || ''}
              onChange={(e) => update(idx, { descripcion: e.target.value })}
              placeholder={`Diagnóstico ${idx + 1}`}
              className="input text-xs"
            />
          </div>
          <div className="md:col-span-5">
            <Cie10Select
              code={r.cie}
              description={r.cieDescripcion}
              onChange={({ code, description }) =>
                update(idx, {
                  cie: code,
                  cieDescripcion: description,
                  // Si aún no hay descripción escrita, usa la del CIE seleccionado.
                  descripcion: r.descripcion || description,
                })
              }
            />
          </div>
          <div className="md:col-span-2 flex items-center gap-2 justify-between">
            <label className="flex items-center gap-1 text-[11px] text-slate-600 cursor-pointer" title="Presuntivo">
              <input type="checkbox" checked={!!r.presuntivo} onChange={(e) => update(idx, { presuntivo: e.target.checked })} className="accent-amber-500 cursor-pointer" />
              PRE
            </label>
            <label className="flex items-center gap-1 text-[11px] text-slate-600 cursor-pointer" title="Definitivo">
              <input type="checkbox" checked={!!r.definitivo} onChange={(e) => update(idx, { definitivo: e.target.checked })} className="accent-emerald-600 cursor-pointer" />
              DEF
            </label>
            <button type="button" onClick={() => remove(idx)} className="text-slate-400 hover:text-red-600 bg-transparent border-none cursor-pointer p-0">
              <HiOutlineTrash className="w-4 h-4" />
            </button>
          </div>
        </div>
      ))}
      {rows.length < 6 && (
        <button
          type="button"
          onClick={add}
          className="inline-flex items-center gap-1 text-xs text-emerald-700 hover:text-emerald-800 bg-transparent border-none cursor-pointer"
        >
          <HiOutlinePlus className="w-4 h-4" /> Agregar diagnóstico
        </button>
      )}
    </div>
  );
}

// ──────────────────── Seguimientos ────────────────────
// Tabla editable de ítems. Se reutiliza para la Receta (insumos/medicamentos,
// variant="receta") y para las Derivaciones (servicios/programas,
// variant="derivacion"). La variante define columnas y textos; la lógica de
// productos compuestos es idéntica en ambas.
function ItemsTable({
  variant,
  items,
  productOptions, // productos elegibles para esta variante
  allProducts,    // catálogo completo (para resolver compuestos)
  onAdd,
  onAddManual,    // si se pasa, habilita agregar ítems de texto libre (manual)
  onUpdate,
  onRemove,
  onToggleComponent,
  onSetComponentQty,
}) {
  const isReceta = variant === 'receta';
  const label = isReceta ? 'Receta' : 'Derivaciones';
  const searchPlaceholder = isReceta
    ? 'Buscar medicamento o insumo...'
    : 'Buscar servicio o programa...';
  const emptyMsg = isReceta
    ? 'Sin ítems. Agrega medicamentos o insumos.'
    : 'Sin ítems. Agrega servicios o programas.';
  const productColLabel = isReceta ? 'Medicamento / Insumo' : 'Servicio / Programa';
  const colSpan = isReceta ? 7 : 4;
  // Cada fila usa un combobox con buscador integrado (SearchableSelect), así que
  // no hace falta un buscador compartido para toda la tabla.
  const productLabel = (p) => `${p.name}${p.category ? ` (${p.category})` : ''}`;
  const productSearchText = (p) => `${p.name || ''} ${p.code || ''} ${p.category || ''}`;

  return (
    <div className="md:col-span-3">
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        <label className="text-sm font-medium text-slate-700">{label}</label>
        <div className="flex items-center gap-2">
          {onAddManual && (
            <button
              type="button"
              onClick={onAddManual}
              className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-slate-300 bg-white text-slate-600 hover:border-emerald-400 hover:text-emerald-700 cursor-pointer whitespace-nowrap"
              title="Escribir un medicamento que la clínica no vende"
            >
              <HiOutlinePencilSquare className="w-3 h-3" /> Manual
            </button>
          )}
          <button
            type="button"
            onClick={onAdd}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-emerald-600 text-white border-none cursor-pointer whitespace-nowrap"
          >
            <HiOutlinePlus className="w-3 h-3" /> Agregar ítem
          </button>
        </div>
      </div>
      {items.length === 0 && (
        <p className="text-xs text-slate-400 italic">{emptyMsg}</p>
      )}
      {items.length > 0 && (
        <div className="overflow-x-auto bg-white rounded-lg border border-slate-200">
          <table className="tbl text-xs">
            <thead className="bg-slate-100 text-slate-600">
              <tr>
                <th className="text-left px-2 py-1.5">{productColLabel}</th>
                <th className="text-left px-2 py-1.5 w-16">Cant.</th>
                {isReceta && <th className="text-left px-2 py-1.5">Dosis</th>}
                {isReceta && <th className="text-left px-2 py-1.5">Frecuencia</th>}
                {isReceta && <th className="text-left px-2 py-1.5">Duración</th>}
                <th className="text-left px-2 py-1.5">Indicaciones</th>
                <th className="px-2 py-1.5 w-8"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((row, idx) => (
                <Fragment key={idx}>
                  <tr className="border-t border-slate-100">
                    <td className="px-2 py-1 min-w-[180px]">
                      {row.manual ? (
                        <input
                          type="text"
                          value={row.name}
                          onChange={(e) => onUpdate(idx, 'name', e.target.value)}
                          placeholder="Medicamento (manual)"
                          className="input text-xs py-1"
                          autoFocus
                        />
                      ) : (
                        <SearchableSelect
                          options={productOptions}
                          value={row.product}
                          onChange={(val) => onUpdate(idx, 'product', val)}
                          getLabel={productLabel}
                          getSearchText={productSearchText}
                          placeholder="— Seleccionar —"
                          searchPlaceholder={searchPlaceholder}
                          size="sm"
                          menuMinWidth={280}
                        />
                      )}
                    </td>
                    <td className="px-2 py-1">
                      <NumericInput
                        min={1}
                        value={row.quantity}
                        onChange={(e) => onUpdate(idx, 'quantity', Number(e.target.value))}
                        className="input text-xs py-1"
                      />
                    </td>
                    {isReceta && (
                      <td className="px-2 py-1">
                        <input
                          type="text"
                          value={row.dose}
                          onChange={(e) => onUpdate(idx, 'dose', e.target.value)}
                          className="input text-xs py-1"
                          placeholder="500mg"
                        />
                      </td>
                    )}
                    {isReceta && (
                      <td className="px-2 py-1">
                        <input
                          type="text"
                          value={row.frequency}
                          onChange={(e) => onUpdate(idx, 'frequency', e.target.value)}
                          className="input text-xs py-1"
                          placeholder="c/8h"
                        />
                      </td>
                    )}
                    {isReceta && (
                      <td className="px-2 py-1">
                        <input
                          type="text"
                          value={row.duration}
                          onChange={(e) => onUpdate(idx, 'duration', e.target.value)}
                          className="input text-xs py-1"
                          placeholder="7 días"
                        />
                      </td>
                    )}
                    <td className="px-2 py-1">
                      <input
                        type="text"
                        value={row.instructions}
                        onChange={(e) => onUpdate(idx, 'instructions', e.target.value)}
                        className="input text-xs py-1"
                      />
                    </td>
                    <td className="px-2 py-1 text-right">
                      <button
                        type="button"
                        onClick={() => onRemove(idx)}
                        className="p-1 text-red-500 bg-transparent border-none cursor-pointer"
                      >
                        <HiOutlineTrash className="w-3 h-3" />
                      </button>
                    </td>
                  </tr>
                  {row.isComposite && (() => {
                    const prod = allProducts.find((p) => p._id === row.product);
                    const comps = prod?.components || [];
                    return (
                      <tr key={`${idx}-comp`} className="bg-amber-50/60">
                        <td colSpan={colSpan} className="px-3 py-2">
                          <p className="text-[11px] font-semibold text-amber-800 mb-1">
                            Componentes de "{row.name}" — elige cuáles {isReceta ? 'recetar' : 'aplicar'}:
                          </p>
                          {comps.length === 0 && (
                            <p className="text-[11px] text-slate-500">Este producto compuesto no tiene componentes configurados.</p>
                          )}
                          <div className="flex flex-wrap gap-2">
                            {comps.map((c) => {
                              const cp = allProducts.find((p) => p._id === (c.product?._id || c.product));
                              const cid = c.product?._id || c.product;
                              const used = (row.componentsUsed || []).find((u) => String(u.product) === String(cid));
                              return (
                                <label key={cid} className="flex items-center gap-1 bg-white border border-amber-200 rounded px-2 py-1 text-[11px] cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={!!used}
                                    onChange={(e) =>
                                      onToggleComponent(idx, { product: cid, name: cp?.name || '', quantity: c.quantity || 1 }, e.target.checked)
                                    }
                                    className="w-3 h-3 accent-amber-600"
                                  />
                                  <span>{cp?.name || 'Componente'}</span>
                                  {used && (
                                    <NumericInput
                                      min={1}
                                      value={used.quantity}
                                      onChange={(e) => onSetComponentQty(idx, cid, e.target.value)}
                                      className="w-12 px-1 py-0.5 border border-slate-200 rounded text-[11px]"
                                    />
                                  )}
                                </label>
                              );
                            })}
                          </div>
                        </td>
                      </tr>
                    );
                  })()}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SeguimientosTab({ patientId, appointmentId }) {
  const { hasRole, user } = useAuth();
  const isOptica = hasRole('optica');
  // Cada especialidad ve SOLO su sección. `hasRole` expande hacia 'doctor', no
  // entre especialidades, así que un podólogo no ve la ficha de ginecología.
  const isGineco = hasRole('ginecologia');
  const isPodo = hasRole('podologia');
  const isOdonto = hasRole('odontologia');
  const isCosme = hasRole('cosmetologia');
  const isAdmin = hasRole('admin') || user?.isSuperAdmin;
  // Una vez guardado, solo administradores pueden eliminar/editar seguimientos.
  const canDelete = isAdmin;
  const canUpload = hasRole('admin', 'cajero', 'doctor', 'optica');
  const [record, setRecord] = useState(null);
  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState([]);
  const fileInputRef = useRef(null);
  const emptyRow = () => ({
    product: '',
    name: '',
    quantity: 1,
    dose: '',
    frequency: '',
    duration: '',
    instructions: '',
  });
  const emptyOpticaRx = () => ({
    od: { sph: '', cyl: '', ax: '', add: '', dnp: '', alt: '' },
    oi: { sph: '', cyl: '', ax: '', add: '', dnp: '', alt: '' },
  });
  const emptyGineco = () => ({
    fum: '',
    gpac: { gestas: '', partos: '', abortos: '', cesareas: '' },
    embarazoActual: null, // null = sin dato, true = sí, false = no
    metodosAnticonceptivos: { hormonal: false, barrera: false, diu: false, otro: false, otroDetalle: '' },
    pap: {
      tipo: '', // 'previo' | 'primera_vez'
      toma: { exocervical: false, endocervical: false, otros: false, otrosDetalle: '' },
    },
    controlPrenatal: { signosVitalesScore: '', bebePosicion: '', actividadCardiaca: '' },
  });
  const emptyPodologia = () => ({
    hallazgosGenerales: {
      piel: '', unas: '', hidratacion: '', temperatura: '', coloracion: '',
      edema: null, // null = sin dato, true = sí, false = no
      otros: '',
    },
    vascularNeurologica: {
      pulsoPedio: '', pulsoTibialPosterior: '', llenadoCapilar: '',
      sensibilidadMonofilamento: '', reflejos: '',
    },
    evaluacion: { piel: '', unas: '', pulsos: '', sensibilidad: '', calzado: '', marcha: '' },
    hallazgos: [],
    hallazgosDetalle: '',
  });
  const emptyOdontologia = () => ({
    odontograma: [],
    higieneOral: [],
    enfermedadPeriodontal: '',
    maloclusion: '',
    fluorosis: '',
    cpo: { c: '', p: '', o: '' },
    ceo: { c: '', e: '', o: '' },
    observaciones: '',
  });
  const emptyCosmetologia = () => ({
    datosEsteticos: { tratamientosEsteticos: '', autotratamientos: '', cosmeticosUsoActual: '' },
    evaluacion: {
      fototipo: '', glogau: '', rosacea: '',
      biotipo: [], arrugas: [], acne: [], lesionesElementales: [],
      hiperpigmentaciones: [],
      deshidratacionFacial: '', bioestimulacion: '', nutricionDermica: '', observaciones: '',
    },
    higiene: { frecuenciaLavado: '', shampoo: '', acondicionador: '', otros: '' },
    cabello: {
      longitud: '', forma: '', calibre: '', densidad: '', elasticidad: '', color: '',
      tratamientos: { alisados: false, planchas: false, secadores: false },
    },
    cueroCabelludo: { tipo: '', glandulaSebacea: '', sensibilidad: '', movilidad: '' },
    fibraCapilar: [],
    afeccionesCuero: [],
    procedimiento: { procedimiento: '', productos: '', apoyoDomiciliario: '' },
  });
  const emptyForm = () => ({
    fecha: new Date().toISOString().substring(0, 10),
    tipoConsulta: '',        // B: primera | subsecuente
    descripcion: '',
    enfermedadActual: '',    // E
    planTratamiento: '',     // J
    recetaItems: [],       // solo insumos/medicamentos
    derivacionItems: [],   // servicios/programas
    revisionSistemas: [],  // G
    revisionSistemasHallazgos: '', // G: descripción de lo marcado
    examenFisico: { regional: [], sistemico: [], hallazgos: '' }, // H
    diagnosticos: [],      // I
    opticaRx: emptyOpticaRx(),
    ginecologia: emptyGineco(),
    podologia: emptyPodologia(),
    odontologia: emptyOdontologia(),
    cosmetologia: emptyCosmetologia(),
    vitalSigns: {
      // La hora de la toma la pone el sistema (hora de Ecuador); no se digita.
      hora: nowEcHHMM(),
      temperature: '',
      bloodPressure: '',
      heartRate: '',
      respiratoryRate: '',
      oxygenSaturation: '',
      weight: '',
      height: '',
      abdominalPerimeter: '',
      capillaryHemoglobin: '',
      glucose: '',
    },
  });
  const [form, setForm] = useState(emptyForm());
  const [saving, setSaving] = useState(false);
  // La hora de la toma de signos vitales la lleva el sistema: se mantiene al
  // minuto mientras el seguimiento está abierto y se vuelve a sellar al guardar,
  // así lo que ve el doctor es exactamente lo que queda registrado.
  useEffect(() => {
    const id = setInterval(() => {
      const hora = nowEcHHMM();
      setForm((f) =>
        f.vitalSigns.hora === hora ? f : { ...f, vitalSigns: { ...f.vitalSigns, hora } },
      );
    }, 30000);
    return () => clearInterval(id);
  }, []);
  const [uploadingFuId, setUploadingFuId] = useState(null);
  // PDFs seleccionados ANTES de guardar el seguimiento. Se subirán automáticamente
  // tras crear el seguimiento.
  const [pendingFiles, setPendingFiles] = useState([]);
  // Compras y avance de tratamientos del paciente (para el seguimiento).
  const [purchases, setPurchases] = useState([]);
  const [treatmentProgress, setTreatmentProgress] = useState([]);

  const loadPurchases = async () => {
    try {
      const r = await api.get(`/patients/${patientId}/purchases`);
      setPurchases(r.data?.purchases || []);
      setTreatmentProgress(r.data?.treatments || []);
    } catch {
      setPurchases([]);
      setTreatmentProgress([]);
    }
  };

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get(`/clinical-records/${patientId}`);
      setRecord(res.data);
      loadPurchases();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    api
      .get('/products')
      .then((r) => {
        const list = Array.isArray(r.data) ? r.data : r.data?.items || [];
        setProducts(
          list.filter((p) =>
            p.isComposite ||
            ['insumo', 'servicio', 'programa'].includes(String(p.category || '').toLowerCase())
          )
        );
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId]);

  // Los handlers reciben `listKey` porque el formulario tiene DOS listas:
  // 'recetaItems' (insumos/medicamentos) y 'derivacionItems' (servicios/programas).
  const updateRow = (listKey, idx, key, val) => {
    setForm((f) => {
      const items = [...f[listKey]];
      items[idx] = { ...items[idx], [key]: val };
      if (key === 'product') {
        const p = products.find((x) => x._id === val);
        items[idx].name = p?.name || '';
        items[idx].isComposite = !!p?.isComposite;
        items[idx].componentsUsed = [];
      }
      return { ...f, [listKey]: items };
    });
  };

  // Alterna un componente de un item compuesto.
  const toggleComponent = (listKey, idx, comp, checked) => {
    setForm((f) => {
      const items = [...f[listKey]];
      const used = [...(items[idx].componentsUsed || [])];
      const pos = used.findIndex((c) => String(c.product) === String(comp.product));
      if (checked && pos < 0) used.push({ product: comp.product, name: comp.name, quantity: comp.quantity || 1 });
      if (!checked && pos >= 0) used.splice(pos, 1);
      items[idx] = { ...items[idx], componentsUsed: used };
      return { ...f, [listKey]: items };
    });
  };

  const setComponentQty = (listKey, idx, productId, qty) => {
    setForm((f) => {
      const items = [...f[listKey]];
      const used = (items[idx].componentsUsed || []).map((c) =>
        String(c.product) === String(productId) ? { ...c, quantity: Number(qty) } : c
      );
      items[idx] = { ...items[idx], componentsUsed: used };
      return { ...f, [listKey]: items };
    });
  };

  // manual=true agrega una fila de texto libre (medicamento que la clínica no
  // vende / no está en inventario): no lleva `product`, solo `name`.
  const addRow = (listKey, manual = false) =>
    setForm((f) => ({ ...f, [listKey]: [...f[listKey], { ...emptyRow(), manual }] }));
  const removeRow = (listKey, idx) =>
    setForm((f) => ({
      ...f,
      [listKey]: f[listKey].filter((_, i) => i !== idx),
    }));

  // Catálogo dividido: la Receta solo lista insumos/medicamentos; las
  // Derivaciones listan servicios y programas.
  const recetaProducts = products.filter(
    (p) => String(p.category || '').toLowerCase() === 'insumo'
  );
  const derivacionProducts = products.filter((p) =>
    ['servicio', 'programa'].includes(String(p.category || '').toLowerCase())
  );

  // Subida de PDFs adjuntos a un seguimiento existente
  // Sube uno o varios archivos (PDF o imágenes) a un seguimiento existente.
  const uploadAttachments = async (fuId, files) => {
    const list = (Array.isArray(files) ? files : [files]).filter(isAllowedAttachment);
    if (!list.length) {
      toast.error('Solo se permiten archivos PDF o imágenes');
      return;
    }
    setUploadingFuId(fuId);
    try {
      for (const file of list) {
        const fd = new FormData();
        fd.append('file', file);
        await api.post(
          `/clinical-records/${patientId}/follow-ups/${fuId}/attachments`,
          fd,
          { headers: { 'Content-Type': 'multipart/form-data' } }
        );
      }
      await load();
      toast.success(list.length > 1 ? 'Archivos adjuntados' : 'Archivo adjuntado');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al subir archivo');
    } finally {
      setUploadingFuId(null);
    }
  };

  const downloadAttachment = async (fuId, attId, originalName) => {
    try {
      await downloadFile(
        `/clinical-records/${patientId}/follow-ups/${fuId}/attachments/${attId}`,
        { filename: originalName || 'archivo' }
      );
    } catch (err) {
      toast.error(err.message || 'Error al descargar');
    }
  };

  const deleteAttachment = async (fuId, attId) => {
    if (!confirm('¿Eliminar este archivo?')) return;
    try {
      await api.delete(
        `/clinical-records/${patientId}/follow-ups/${fuId}/attachments/${attId}`
      );
      await load();
      toast.success('Archivo eliminado');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!form.descripcion) {
      toast.error('Motivo de consulta requerido');
      return;
    }
    // Óptica puede guardar sin receta de medicamentos si llenó la RX óptica.
    const hasOpticaRx = isOptica && (
      Object.values(form.opticaRx?.od || {}).some((v) => String(v).trim()) ||
      Object.values(form.opticaRx?.oi || {}).some((v) => String(v).trim())
    );
    // Un ítem es válido si tiene producto del inventario O un nombre (manual).
    const allItems = [...form.recetaItems, ...form.derivacionItems];
    const hasName = (it) => it.name && it.name.trim();
    if (!isOptica || !hasOpticaRx) {
      if (!allItems.length) {
        toast.error('Debe agregar al menos un ítem en Receta o Derivaciones');
        return;
      }
      if (allItems.some((it) => !it.product && !hasName(it))) {
        toast.error('Complete el producto/medicamento de cada ítem o elimine los vacíos');
        return;
      }
    }
    setSaving(true);
    try {
      const vs = form.vitalSigns || {};
      const vitalSigns = {
        // Sello del sistema: la hora real en que se guarda la toma (hora de Ecuador).
        hora: nowEcHHMM(),
        temperature: vs.temperature === '' ? null : Number(vs.temperature),
        bloodPressure: vs.bloodPressure || '',
        heartRate: vs.heartRate === '' ? null : Number(vs.heartRate),
        respiratoryRate: vs.respiratoryRate === '' ? null : Number(vs.respiratoryRate),
        oxygenSaturation: vs.oxygenSaturation === '' ? null : Number(vs.oxygenSaturation),
        weight: vs.weight === '' ? null : Number(vs.weight),
        height: vs.height === '' ? null : Number(vs.height),
        abdominalPerimeter: vs.abdominalPerimeter === '' ? null : Number(vs.abdominalPerimeter),
        capillaryHemoglobin: vs.capillaryHemoglobin === '' ? null : Number(vs.capillaryHemoglobin),
        glucose: vs.glucose === '' ? null : Number(vs.glucose),
      };
      const payload = {
        ...form,
        vitalSigns,
      };
      // La ficha de cada especialidad solo se envía desde su propia consulta:
      // así un seguimiento de medicina general no arrastra secciones vacías.
      if (!isGineco) delete payload.ginecologia;
      if (!isPodo) delete payload.podologia;
      if (!isOdonto) delete payload.odontologia;
      if (!isCosme) delete payload.cosmetologia;
      if (appointmentId) payload.appointmentId = appointmentId;
      const res = await api.post(`/clinical-records/${patientId}/follow-ups`, payload);
      // Subir PDFs pendientes (seleccionados ANTES de guardar) al seguimiento recién creado.
      let updated = res.data;
      const newFu = (updated.followUps || []).slice(-1)[0];
      if (newFu && pendingFiles.length > 0) {
        for (const f of pendingFiles) {
          const fd = new FormData();
          fd.append('file', f);
          // eslint-disable-next-line no-await-in-loop
          const r = await api.post(
            `/clinical-records/${patientId}/follow-ups/${newFu._id}/attachments`,
            fd,
            { headers: { 'Content-Type': 'multipart/form-data' } }
          );
          updated = r.data;
        }
        setRecord(updated);
      } else {
        setRecord(updated);
      }
      setForm(emptyForm());
      setPendingFiles([]);
      toast.success(
        appointmentId
          ? 'Seguimiento guardado. Cita finalizada.'
          : 'Seguimiento agregado'
      );
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al agregar');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (fuId) => {
    if (!confirm('¿Eliminar este seguimiento?')) return;
    try {
      const res = await api.delete(`/clinical-records/${patientId}/follow-ups/${fuId}`);
      setRecord(res.data);
      toast.success('Seguimiento eliminado');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    }
  };

  const printFollowUp = async (fuId) => {
    try {
      const res = await api.get(
        `/clinical-records/${patientId}/follow-ups/${fuId}/print`,
        { responseType: 'blob' }
      );
      const url = URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
      window.open(url, '_blank');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al imprimir');
    }
  };

  const downloadFollowUpPdf = async (fuId) => {
    try {
      await downloadFile(
        `/clinical-records/${patientId}/follow-ups/${fuId}/print`,
        { filename: `receta_${fuId}.pdf` }
      );
    } catch (err) {
      toast.error(err.message || 'Error al descargar');
    }
  };

  // Abre la hoja oficial MSP HCU-form.002 (anamnesis + examen físico).
  const openMspForm = async (fuId) => {
    try {
      const res = await api.get(
        `/clinical-records/${patientId}/follow-ups/${fuId}/msp`,
        { responseType: 'blob' }
      );
      const url = URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
      window.open(url, '_blank');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al generar el formulario MSP');
    }
  };

  if (loading) return <div className="text-slate-500 text-sm">Cargando...</div>;
  if (!record) return null;

  const followUps = [...(record.followUps || [])].sort(
    (a, b) => new Date(b.fecha) - new Date(a.fecha)
  );

  return (
    <div className="space-y-6">
      {appointmentId && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-xl p-3">
          Al guardar este seguimiento, la cita se marcará como <b>completada</b> y quedarás disponible.
        </div>
      )}

      <form
        onSubmit={submit}
        className="bg-slate-50 rounded-xl p-4 grid grid-cols-1 gap-3 md:grid-cols-3"
      >
        <Field label="Fecha">
          <DateInput
            value={form.fecha}
            onChange={(e) => setForm((f) => ({ ...f, fecha: e.target.value }))}
            className="input"
          />
        </Field>
        <Field label="Motivo de consulta" className="md:col-span-2">
          <input
            type="text"
            value={form.descripcion}
            onChange={(e) => setForm((f) => ({ ...f, descripcion: e.target.value }))}
            className="input"
            required
          />
        </Field>
        {/* B. Primera vez / subsecuente */}
        <div className="md:col-span-3">
          <label className="text-sm font-medium text-slate-700 block mb-1.5">Tipo de consulta</label>
          <div className="flex gap-2">
            {[
              { v: 'primera', l: 'Primera' },
              { v: 'subsecuente', l: 'Subsecuente' },
            ].map((opt) => (
              <button
                key={opt.v}
                type="button"
                onClick={() => setForm((f) => ({ ...f, tipoConsulta: f.tipoConsulta === opt.v ? '' : opt.v }))}
                className={`px-4 py-1.5 rounded-lg text-xs font-medium cursor-pointer border ${
                  form.tipoConsulta === opt.v
                    ? 'bg-emerald-600 text-white border-emerald-600'
                    : 'bg-white text-slate-600 border-slate-200'
                }`}
              >
                {opt.l}
              </button>
            ))}
          </div>
        </div>

        {/* E. Enfermedad o problema actual */}
        <Field label="Enfermedad o problema actual" className="md:col-span-3">
          <textarea
            rows={2}
            value={form.enfermedadActual}
            onChange={(e) => setForm((f) => ({ ...f, enfermedadActual: e.target.value }))}
            placeholder="Cronología, localización, características, intensidad, frecuencia, factores agravantes…"
            className="input resize-none"
          />
        </Field>

        {/* F. Signos vitales (colapsable) */}
        <div className="md:col-span-3">
          <Collapsible title="Signos vitales" hint="constantes vitales y antropometría">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Field label="Hora (automática)">
              <input
                type="time"
                value={form.vitalSigns.hora}
                readOnly
                tabIndex={-1}
                title="La registra el sistema al guardar el seguimiento"
                className="input text-sm bg-gray-100 text-gray-600 cursor-default"
              />
            </Field>
            <Field label="T. Arterial">
              <input
                type="text"
                value={form.vitalSigns.bloodPressure}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    vitalSigns: { ...f.vitalSigns, bloodPressure: e.target.value },
                  }))
                }
                placeholder="120/80"
                className="input text-sm"
              />
            </Field>
            <Field label="F. Cardíaca (lpm)">
              <NumericInput
                min={0}
                value={form.vitalSigns.heartRate}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    vitalSigns: { ...f.vitalSigns, heartRate: e.target.value },
                  }))
                }
                className="input text-sm"
              />
            </Field>
            <Field label="F. Respiratoria (rpm)">
              <NumericInput
                min={0}
                value={form.vitalSigns.respiratoryRate}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    vitalSigns: { ...f.vitalSigns, respiratoryRate: e.target.value },
                  }))
                }
                className="input text-sm"
              />
            </Field>
            <Field label="Temperatura (°C)">
              <NumericInput
                step="0.1"
                value={form.vitalSigns.temperature}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    vitalSigns: { ...f.vitalSigns, temperature: e.target.value },
                  }))
                }
                className="input text-sm"
              />
            </Field>
            <Field label="Sat. O₂ (%)">
              <NumericInput
                min={0}
                max={100}
                value={form.vitalSigns.oxygenSaturation}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    vitalSigns: { ...f.vitalSigns, oxygenSaturation: e.target.value },
                  }))
                }
                className="input text-sm"
              />
            </Field>
            <Field label="Peso (kg)">
              <NumericInput
                step="0.1"
                min={0}
                value={form.vitalSigns.weight}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    vitalSigns: { ...f.vitalSigns, weight: e.target.value },
                  }))
                }
                className="input text-sm"
              />
            </Field>
            <Field label="Talla (cm)">
              <NumericInput
                step="0.1"
                min={0}
                value={form.vitalSigns.height}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    vitalSigns: { ...f.vitalSigns, height: e.target.value },
                  }))
                }
                className="input text-sm"
              />
            </Field>
            <Field label="Glucosa (mg/dL)">
              <NumericInput
                min={0}
                value={form.vitalSigns.glucose}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    vitalSigns: { ...f.vitalSigns, glucose: e.target.value },
                  }))
                }
                className="input text-sm"
              />
            </Field>
            <Field label="Perímetro abdominal (cm)">
              <NumericInput
                step="0.1"
                min={0}
                value={form.vitalSigns.abdominalPerimeter}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    vitalSigns: { ...f.vitalSigns, abdominalPerimeter: e.target.value },
                  }))
                }
                className="input text-sm"
              />
            </Field>
            <Field label="Hemoglobina cap. (g/dL)">
              <NumericInput
                step="0.1"
                min={0}
                value={form.vitalSigns.capillaryHemoglobin}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    vitalSigns: { ...f.vitalSigns, capillaryHemoglobin: e.target.value },
                  }))
                }
                className="input text-sm"
              />
            </Field>
            <Field label="IMC (Kg/m²)">
              <input
                type="text"
                readOnly
                value={calcIMC(form.vitalSigns.weight, form.vitalSigns.height) || '—'}
                className="input text-sm bg-slate-50 text-slate-500"
                title="Calculado con peso y talla"
              />
            </Field>
            </div>
          </Collapsible>
        </div>

        {/* G. Revisión actual de órganos y sistemas (colapsable) */}
        <div className="md:col-span-3">
          <Collapsible title="Revisión de órganos y sistemas" hint="marque los que presenten patología">
            <div className="space-y-4">
              <MspChecklist
                catalog={REVISION_SISTEMAS}
                value={form.revisionSistemas}
                onChange={(v) => setForm((f) => ({ ...f, revisionSistemas: v }))}
                showDetail={false}
              />
              <Field label="Hallazgos de la revisión de órganos y sistemas">
                <textarea
                  rows={2}
                  value={form.revisionSistemasHallazgos}
                  onChange={(e) => setForm((f) => ({ ...f, revisionSistemasHallazgos: e.target.value }))}
                  className="input resize-none"
                />
              </Field>
            </div>
          </Collapsible>
        </div>

        {/* H. Examen físico regional + sistémico (colapsable) */}
        <div className="md:col-span-3">
          <Collapsible title="Examen físico" hint="regional y sistémico">
            <div className="space-y-4">
              <div>
                <p className="text-xs font-semibold text-slate-500 uppercase mb-2">Regional</p>
                <MspChecklist
                  catalog={EXAMEN_REGIONAL}
                  value={form.examenFisico.regional}
                  onChange={(v) => setForm((f) => ({ ...f, examenFisico: { ...f.examenFisico, regional: v } }))}
                  showDetail={false}
                />
              </div>
              <div>
                <p className="text-xs font-semibold text-slate-500 uppercase mb-2">Sistémico</p>
                <MspChecklist
                  catalog={EXAMEN_SISTEMICO}
                  value={form.examenFisico.sistemico}
                  onChange={(v) => setForm((f) => ({ ...f, examenFisico: { ...f.examenFisico, sistemico: v } }))}
                  showDetail={false}
                />
              </div>
              <Field label="Hallazgos del examen físico">
                <textarea
                  rows={2}
                  value={form.examenFisico.hallazgos}
                  onChange={(e) => setForm((f) => ({ ...f, examenFisico: { ...f.examenFisico, hallazgos: e.target.value } }))}
                  className="input resize-none"
                />
              </Field>
            </div>
          </Collapsible>
        </div>

        {/* I. Diagnósticos con CIE-10 */}
        <div className="md:col-span-3">
          <label className="text-sm font-medium text-slate-700 block mb-2">Diagnósticos (CIE-10)</label>
          <DiagnosticosEditor
            value={form.diagnosticos}
            onChange={(v) => setForm((f) => ({ ...f, diagnosticos: v }))}
          />
        </div>

        <ItemsTable
          variant="receta"
          items={form.recetaItems}
          productOptions={recetaProducts}
          allProducts={products}
          onAdd={() => addRow('recetaItems')}
          onAddManual={() => addRow('recetaItems', true)}
          onUpdate={(idx, key, val) => updateRow('recetaItems', idx, key, val)}
          onRemove={(idx) => removeRow('recetaItems', idx)}
          onToggleComponent={(idx, comp, checked) => toggleComponent('recetaItems', idx, comp, checked)}
          onSetComponentQty={(idx, pid, qty) => setComponentQty('recetaItems', idx, pid, qty)}
        />

        <ItemsTable
          variant="derivacion"
          items={form.derivacionItems}
          productOptions={derivacionProducts}
          allProducts={products}
          onAdd={() => addRow('derivacionItems')}
          onUpdate={(idx, key, val) => updateRow('derivacionItems', idx, key, val)}
          onRemove={(idx) => removeRow('derivacionItems', idx)}
          onToggleComponent={(idx, comp, checked) => toggleComponent('derivacionItems', idx, comp, checked)}
          onSetComponentQty={(idx, pid, qty) => setComponentQty('derivacionItems', idx, pid, qty)}
        />

        {/* J. Plan de tratamiento (narrado; la receta e insumos van arriba) */}
        <Field label="Plan de tratamiento" className="md:col-span-3">
          <textarea
            rows={2}
            value={form.planTratamiento}
            onChange={(e) => setForm((f) => ({ ...f, planTratamiento: e.target.value }))}
            placeholder="Diagnóstico, terapéutico y educacional"
            className="input resize-none"
          />
        </Field>

        {isOptica && <OpticaRxTable value={form.opticaRx} onChange={(rx) => setForm((f) => ({ ...f, opticaRx: rx }))} />}
        {isGineco && <GinecologiaSection value={form.ginecologia} onChange={(g) => setForm((f) => ({ ...f, ginecologia: g }))} />}
        {isPodo && <PodologiaSection value={form.podologia} onChange={(p) => setForm((f) => ({ ...f, podologia: p }))} />}
        {isOdonto && <OdontologiaSection value={form.odontologia} onChange={(o) => setForm((f) => ({ ...f, odontologia: o }))} />}
        {isCosme && <CosmetologiaSection value={form.cosmetologia} onChange={(c) => setForm((f) => ({ ...f, cosmetologia: c }))} />}

        {/* Archivos (PDF o imágenes) antes de guardar el seguimiento */}
        <div className="md:col-span-3">
          <label className="text-sm font-medium text-slate-700 block mb-2">
            Archivos a adjuntar (PDF o imágenes)
          </label>
          <div className="bg-white rounded-lg border border-slate-200 p-3 space-y-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,image/*"
              multiple
              onChange={(e) => {
                const files = Array.from(e.target.files || []).filter(isAllowedAttachment);
                setPendingFiles((prev) => [...prev, ...files]);
                e.target.value = '';
              }}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-dashed border-slate-300 bg-slate-50 hover:bg-emerald-50 hover:border-emerald-400 text-sm text-slate-600 hover:text-emerald-700 cursor-pointer transition-colors"
            >
              <HiOutlineArrowDownTray className="w-4 h-4" />
              Adjuntar archivos
            </button>
            {pendingFiles.length > 0 && (
              <ul className="space-y-1">
                {pendingFiles.map((f, i) => (
                  <li key={i} className="text-xs text-slate-600 flex items-center gap-2">
                    <span>{f.type.startsWith('image/') ? '🖼️' : '📎'} {f.name}</span>
                    <span className="text-slate-400">({Math.round(f.size / 1024)} KB)</span>
                    <button
                      type="button"
                      onClick={() => setPendingFiles((prev) => prev.filter((_, idx) => idx !== i))}
                      className="text-red-500 bg-transparent border-none cursor-pointer p-0"
                    >
                      <HiOutlineTrash className="w-3 h-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[11px] text-slate-400">
              Se subirán al guardar. También podrás adjuntar más después.
            </p>
          </div>
        </div>

        <div className="md:col-span-3 flex justify-end">
          <button
            type="submit"
            disabled={saving}
            className="flex items-center gap-1 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-medium disabled:opacity-50 cursor-pointer border-none"
          >
            <HiOutlinePlus className="w-4 h-4" /> {appointmentId ? 'Guardar y finalizar' : 'Agregar'}
          </button>
        </div>
      </form>

      {/* Compras y aplicaciones: avance de tratamientos + historial de compras */}
      {(treatmentProgress.length > 0 || purchases.length > 0) && (
        <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-4">
          <h3 className="text-sm font-bold text-slate-700 flex items-center gap-2">
            <HiOutlineShoppingBag className="w-4 h-4 text-emerald-600" /> Compras y aplicaciones
          </h3>

          {treatmentProgress.length > 0 && (
            <div className="space-y-2">
              <p className="text-[11px] font-semibold text-slate-500 uppercase">Avance de tratamientos</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {treatmentProgress.map((t) => (
                  <div key={t._id} className="border border-slate-200 rounded-lg p-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-slate-800">{t.name}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${t.status === 'completado' ? 'bg-emerald-100 text-emerald-700' : t.status === 'activo' ? 'bg-sky-100 text-sky-700' : 'bg-slate-100 text-slate-500'}`}>{t.status}</span>
                    </div>
                    <ul className="mt-1 space-y-1">
                      {t.items.map((it, i) => (
                        <li key={i} className="text-xs text-slate-600 flex items-center justify-between gap-2">
                          <span className="truncate">{it.name}</span>
                          <span className="whitespace-nowrap">
                            <b className="text-emerald-700">{it.applied}</b>/{it.prescribed} aplicados
                            {it.remaining > 0 && <span className="text-amber-600"> · faltan {it.remaining}</span>}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          )}

          {purchases.length > 0 && (
            <div className="space-y-2">
              <p className="text-[11px] font-semibold text-slate-500 uppercase">Compras</p>
              <div className="space-y-1.5 max-h-64 overflow-y-auto">
                {purchases.map((p) => (
                  <div key={p._id} className="border border-slate-200 rounded-lg p-2 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-slate-700">{fmtDate(p.date)} · {p.saleNumber}</span>
                      <span className="font-mono text-emerald-700">${Number(p.total).toFixed(2)}</span>
                    </div>
                    <div className="text-slate-600 mt-0.5">
                      {p.items.map((i) => `${i.name} (x${i.quantity})`).join(', ')}
                    </div>
                    {p.recommendedBy && (
                      <div className="text-[11px] text-indigo-600 mt-0.5">Recomendado por: {p.recommendedBy}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <table className="tbl">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="text-left px-4 py-2.5 font-semibold">Fecha</th>
              <th className="text-left px-4 py-2.5 font-semibold">Motivo de consulta</th>
              <th className="px-4 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {followUps.length === 0 && (
              <tr>
                <td colSpan={3} className="text-center py-6 text-slate-400">
                  No hay seguimientos.
                </td>
              </tr>
            )}
            {followUps.map((fu) => {
              const hasOpticaData =
                fu.opticaRx &&
                (Object.values(fu.opticaRx.od || {}).some((v) => String(v).trim()) ||
                  Object.values(fu.opticaRx.oi || {}).some((v) => String(v).trim()));
              const hasGinecoData = ginecoHasData(fu.ginecologia);
              const hasPodoData = podologiaHasData(fu.podologia);
              const hasOdontoData = odontologiaHasData(fu.odontologia);
              const hasCosmeData = cosmetologiaHasData(fu.cosmetologia);
              const vs = fu.vitalSigns || {};
              const hasVitals = ['hora', 'temperature', 'bloodPressure', 'heartRate', 'respiratoryRate', 'oxygenSaturation', 'weight', 'height', 'abdominalPerimeter', 'capillaryHemoglobin', 'glucose']
                .some((k) => vs[k] != null && vs[k] !== '');
              // Casillas marcadas de la revisión de sistemas y del examen físico.
              const revItems = markedItems(REVISION_SISTEMAS, fu.revisionSistemas);
              const regItems = markedItems(EXAMEN_REGIONAL, fu.examenFisico?.regional);
              const sisItems = markedItems(EXAMEN_SISTEMICO, fu.examenFisico?.sistemico);
              return (
                <tr key={fu._id} className="border-t border-slate-100 align-top">
                  <td className="px-4 py-2.5 text-slate-600 whitespace-nowrap">
                    {fmtDate(fu.fecha)}
                    {fu.createdBy?.name && (
                      <div className="text-[11px] text-emerald-700 mt-0.5 font-medium">
                        Dr. {fu.createdBy.name}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-slate-800">
                    {fu.kind === 'enfermeria' && (
                      <span className="inline-block mb-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-sky-100 text-sky-700">Enfermería</span>
                    )}
                    {hasOpticaData && (
                      <span className="inline-block mb-1 ml-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-indigo-100 text-indigo-700">Óptica</span>
                    )}
                    {hasGinecoData && (
                      <span className="inline-block mb-1 ml-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-rose-100 text-rose-700">Ginecología</span>
                    )}
                    {fu.tipoConsulta && (
                      <span className="inline-block mb-1 ml-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-600 capitalize">{fu.tipoConsulta}</span>
                    )}
                    <div className="font-medium">{fu.descripcion || fu.motivoConsulta}</div>
                    {fu.enfermedadActual && (
                      <div className="mt-1 text-xs text-slate-600 whitespace-pre-wrap">
                        <b>Enfermedad actual:</b> {fu.enfermedadActual}
                      </div>
                    )}
                    {/* Legacy: seguimientos antiguos que aún tienen el campo. */}
                    {fu.estudioSintomas && (
                      <div className="mt-1 text-xs text-slate-600">
                        <b>Estudio/síntomas:</b> {fu.estudioSintomas}
                      </div>
                    )}
                    <ChecksSummary
                      title="Revisión de órganos y sistemas"
                      groups={[{ label: '', items: revItems }]}
                      hallazgos={fu.revisionSistemasHallazgos}
                      tone="amber"
                    />
                    <ChecksSummary
                      title="Examen físico"
                      groups={[
                        { label: 'Regional', items: regItems },
                        { label: 'Sistémico', items: sisItems },
                      ]}
                      hallazgos={fu.examenFisico?.hallazgos}
                      tone="violet"
                    />
                    {Array.isArray(fu.diagnosticos) && fu.diagnosticos.length > 0 && (
                      <div className="mt-2 bg-rose-50 border border-rose-200 rounded p-2">
                        <p className="text-[11px] font-semibold text-rose-600 uppercase mb-1">Diagnósticos</p>
                        <ul className="text-xs text-slate-700 space-y-0.5">
                          {fu.diagnosticos.map((d, i) => (
                            <li key={i}>
                              {d.cie && <span className="font-mono font-semibold text-rose-700">{d.cie}</span>} {d.descripcion || d.cieDescripcion}
                              {d.definitivo ? ' · DEF' : d.presuntivo ? ' · PRE' : ''}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {Array.isArray(fu.recetaItems) && fu.recetaItems.length > 0 && (() => {
                      // Los ítems se guardan juntos; se separan por `isService`
                      // (servicios/programas = Derivaciones, el resto = Receta).
                      const recetaOnly = fu.recetaItems.filter((it) => !it.isService);
                      const derivOnly = fu.recetaItems.filter((it) => it.isService);
                      const renderItem = (it, i) => (
                        <li key={i}>
                          <b>{it.name}</b>
                          {it.dose ? ` · ${it.dose}` : ''}
                          {it.frequency ? ` · ${it.frequency}` : ''}
                          {it.duration ? ` · ${it.duration}` : ''}
                          {it.instructions ? ` — ${it.instructions}` : ''}
                          {it.quantity ? ` (x${it.quantity})` : ''}
                        </li>
                      );
                      return (
                        <>
                          {recetaOnly.length > 0 && (
                            <div className="mt-2 bg-slate-50 border border-slate-200 rounded p-2">
                              <p className="text-[11px] font-semibold text-slate-600 uppercase mb-1">Receta</p>
                              <ul className="text-xs text-slate-700 space-y-0.5">
                                {recetaOnly.map(renderItem)}
                              </ul>
                            </div>
                          )}
                          {derivOnly.length > 0 && (
                            <div className="mt-2 bg-indigo-50 border border-indigo-200 rounded p-2">
                              <p className="text-[11px] font-semibold text-indigo-600 uppercase mb-1">Derivaciones</p>
                              <ul className="text-xs text-slate-700 space-y-0.5">
                                {derivOnly.map(renderItem)}
                              </ul>
                            </div>
                          )}
                        </>
                      );
                    })()}
                    {hasVitals && (
                      <div className="mt-2 text-[11px] text-slate-600 bg-emerald-50 border border-emerald-100 rounded p-2 flex flex-wrap gap-x-3 gap-y-0.5">
                        {vs.hora && <span>Hora: {vs.hora}</span>}
                        {vs.bloodPressure && <span>TA: {vs.bloodPressure}</span>}
                        {vs.heartRate && <span>FC: {vs.heartRate}lpm</span>}
                        {vs.respiratoryRate && <span>FR: {vs.respiratoryRate}rpm</span>}
                        {vs.temperature != null && <span>T°: {vs.temperature}°C</span>}
                        {vs.oxygenSaturation && <span>SatO₂: {vs.oxygenSaturation}%</span>}
                        {vs.weight && <span>Peso: {vs.weight}kg</span>}
                        {vs.height && <span>Talla: {vs.height}cm</span>}
                        {calcIMC(vs.weight, vs.height) && <span>IMC: {calcIMC(vs.weight, vs.height)}</span>}
                        {vs.abdominalPerimeter && <span>P.Abd: {vs.abdominalPerimeter}cm</span>}
                        {vs.capillaryHemoglobin && <span>Hb: {vs.capillaryHemoglobin}g/dL</span>}
                        {vs.glucose && <span>Glu: {vs.glucose}mg/dL</span>}
                      </div>
                    )}
                    {/* Legacy: receta como texto libre (antes de los ítems de inventario). */}
                    {fu.receta && (
                      <div className="mt-2 text-xs text-slate-600 whitespace-pre-wrap">
                        <b>Receta:</b> {fu.receta}
                      </div>
                    )}
                    {fu.planTratamiento && (
                      <div className="mt-2 text-xs text-slate-600 whitespace-pre-wrap">
                        <b>Plan de tratamiento:</b> {fu.planTratamiento}
                      </div>
                    )}
                    {/* Legacy: seguimientos antiguos que aún tienen el campo. */}
                    {fu.observaciones && (
                      <div className="mt-2 text-xs text-slate-600 italic">
                        <b>Observaciones:</b> {fu.observaciones}
                      </div>
                    )}
                    {/* Adjuntos (PDF o imágenes) */}
                    <div className="mt-2 space-y-1">
                      {(fu.attachments || []).map((att) => (
                        <div key={att._id} className="flex items-center gap-2 text-xs text-slate-600">
                          <span>{String(att.mimeType || '').startsWith('image/') ? '🖼️' : '📎'}</span>
                          <button
                            type="button"
                            onClick={() => downloadAttachment(fu._id, att._id, att.originalName)}
                            className="underline text-emerald-700 hover:text-emerald-800 bg-transparent border-none cursor-pointer p-0"
                          >
                            {att.originalName}
                          </button>
                          <span className="text-slate-400">
                            ({Math.round((att.size || 0) / 1024)} KB)
                          </span>
                          {canDelete && (
                            <button
                              type="button"
                              onClick={() => deleteAttachment(fu._id, att._id)}
                              className="text-red-500 bg-transparent border-none cursor-pointer p-0"
                              title="Eliminar"
                            >
                              <HiOutlineTrash className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      ))}
                      {canUpload && (
                        <label className="inline-flex items-center gap-1 text-xs text-emerald-700 cursor-pointer mt-1">
                          <HiOutlinePlus className="w-3 h-3" />
                          {uploadingFuId === fu._id ? 'Subiendo...' : 'Adjuntar archivos'}
                          <input
                            type="file"
                            accept="application/pdf,image/*"
                            multiple
                            className="hidden"
                            disabled={uploadingFuId === fu._id}
                            onChange={(e) => {
                              const files = Array.from(e.target.files || []).filter(isAllowedAttachment);
                              e.target.value = '';
                              if (files.length) uploadAttachments(fu._id, files);
                            }}
                          />
                        </label>
                      )}
                    </div>
                    {hasOpticaData && <OpticaRxSummary rx={fu.opticaRx} />}
                    {hasGinecoData && <GinecologiaSummary g={fu.ginecologia} />}
                    {hasPodoData && <PodologiaSummary p={fu.podologia} />}
                    {hasOdontoData && <OdontologiaSummary o={fu.odontologia} />}
                    {hasCosmeData && <CosmetologiaSummary c={fu.cosmetologia} />}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => downloadFollowUpPdf(fu._id)}
                        title="Descargar PDF"
                        className="p-1 text-slate-500 hover:text-emerald-600 cursor-pointer bg-transparent border-none"
                      >
                        <HiOutlineArrowDownTray className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => printFollowUp(fu._id)}
                        title="Imprimir receta"
                        className="p-1 text-slate-500 hover:text-emerald-600 cursor-pointer bg-transparent border-none"
                      >
                        <HiOutlinePrinter className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => openMspForm(fu._id)}
                        title="Hoja MSP HCU-form.002"
                        className="px-1.5 py-1 text-[10px] font-bold text-slate-500 hover:text-emerald-600 cursor-pointer bg-transparent border border-slate-200 rounded"
                      >
                        HCU
                      </button>
                      {canDelete && (
                        <button
                          onClick={() => remove(fu._id)}
                          className="p-1 text-slate-400 hover:text-red-600 cursor-pointer bg-transparent border-none"
                          title="Eliminar (solo admin)"
                        >
                          <HiOutlineTrash className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <FichaStyles />
    </div>
  );
}

// ──────────────── Tabla óptica (rol optica) ────────────────
const OPTICA_COLS = ['sph', 'cyl', 'ax', 'add', 'dnp', 'alt'];
const OPTICA_COL_LABELS = { sph: 'SPH', cyl: 'CYL', ax: 'AX', add: 'ADD', dnp: 'DNP', alt: 'ALT' };

function OpticaRxTable({ value, onChange }) {
  const rx = value || { od: {}, oi: {} };
  const setCell = (row, col, val) =>
    onChange({ ...rx, [row]: { ...(rx[row] || {}), [col]: val } });
  return (
    <div className="md:col-span-3">
      <label className="text-sm font-medium text-slate-700 block mb-2">Receta óptica (RX)</label>
      <div className="overflow-x-auto bg-white rounded-lg border border-slate-200">
        <table className="tbl text-xs">
          <thead className="bg-slate-100 text-slate-600">
            <tr>
              <th className="text-left px-2 py-1.5 w-16">RX</th>
              {OPTICA_COLS.map((c) => (
                <th key={c} className="text-left px-2 py-1.5">{OPTICA_COL_LABELS[c]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {['od', 'oi'].map((row) => (
              <tr key={row} className="border-t border-slate-100">
                <td className="px-2 py-1 font-semibold text-slate-700 uppercase">{row}</td>
                {OPTICA_COLS.map((c) => (
                  <td key={c} className="px-2 py-1">
                    <input
                      type="text"
                      value={rx[row]?.[c] || ''}
                      onChange={(e) => setCell(row, c, e.target.value)}
                      className="input text-xs py-1"
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function OpticaRxSummary({ rx }) {
  const fmtRow = (row) =>
    OPTICA_COLS.map((c) => `${OPTICA_COL_LABELS[c]}:${row?.[c] || '—'}`).join('  ');
  return (
    <div className="mt-2 text-[11px] text-slate-500 bg-indigo-50 border border-indigo-100 rounded p-2">
      <div><b>OD</b> {fmtRow(rx.od)}</div>
      <div><b>OI</b> {fmtRow(rx.oi)}</div>
    </div>
  );
}

// ──────────────── Ginecología (rol ginecologia) ────────────────
const GINECO_METODOS = [
  { key: 'hormonal', label: 'Hormonal' },
  { key: 'barrera', label: 'Barrera' },
  { key: 'diu', label: 'DIU' },
  { key: 'otro', label: 'Otro' },
];
const GINECO_TOMA = [
  { key: 'exocervical', label: 'Exocervical' },
  { key: 'endocervical', label: 'Endocervical' },
  { key: 'otros', label: 'Otros' },
];

// ¿El seguimiento tiene datos ginecológicos con contenido?
function ginecoHasData(g) {
  if (!g || typeof g !== 'object') return false;
  const gpac = g.gpac || {};
  const met = g.metodosAnticonceptivos || {};
  const toma = g.pap?.toma || {};
  const cp = g.controlPrenatal || {};
  return Boolean(
    g.fum ||
    g.embarazoActual != null ||
    g.pap?.tipo ||
    ['gestas', 'partos', 'abortos', 'cesareas'].some((k) => gpac[k] != null && gpac[k] !== '') ||
    ['hormonal', 'barrera', 'diu', 'otro'].some((k) => met[k]) ||
    met.otroDetalle ||
    ['exocervical', 'endocervical', 'otros'].some((k) => toma[k]) ||
    toma.otrosDetalle ||
    ['signosVitalesScore', 'bebePosicion', 'actividadCardiaca'].some((k) => cp[k])
  );
}

// Chip de selección (toggle) reutilizado por la sección de ginecología.
function GChip({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer border ${
        active ? 'bg-rose-600 text-white border-rose-600' : 'bg-white text-slate-600 border-slate-200'
      }`}
    >
      {children}
    </button>
  );
}

function GinecologiaSection({ value, onChange }) {
  const g = value || {};
  const gpac = g.gpac || {};
  const met = g.metodosAnticonceptivos || {};
  const pap = g.pap || {};
  const toma = pap.toma || {};
  const cp = g.controlPrenatal || {};
  const setGpac = (k, v) => onChange({ ...g, gpac: { ...gpac, [k]: v } });
  const setMet = (k, v) => onChange({ ...g, metodosAnticonceptivos: { ...met, [k]: v } });
  const setToma = (k, v) => onChange({ ...g, pap: { ...pap, toma: { ...toma, [k]: v } } });
  const setCp = (k, v) => onChange({ ...g, controlPrenatal: { ...cp, [k]: v } });

  return (
    <div className="md:col-span-3">
      <label className="text-sm font-medium text-slate-700 block mb-2">Ginecología / Obstetricia</label>
      <div className="bg-white rounded-lg border border-rose-200 p-3 space-y-4">
        {/* FUM + Embarazo actual */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="FUM (última menstruación)">
            <DateInput
              value={g.fum || ''}
              onChange={(e) => onChange({ ...g, fum: e.target.value })}
              className="input"
            />
          </Field>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Embarazo actual</label>
            <div className="flex gap-2">
              <GChip active={g.embarazoActual === true} onClick={() => onChange({ ...g, embarazoActual: g.embarazoActual === true ? null : true })}>Sí</GChip>
              <GChip active={g.embarazoActual === false} onClick={() => onChange({ ...g, embarazoActual: g.embarazoActual === false ? null : false })}>No</GChip>
            </div>
          </div>
        </div>

        {/* G P A C */}
        <div>
          <label className="block text-xs font-semibold text-slate-600 mb-1">Antecedentes obstétricos (G · P · A · C)</label>
          <div className="grid grid-cols-4 gap-2">
            {[
              { k: 'gestas', l: 'Gestas' },
              { k: 'partos', l: 'Partos' },
              { k: 'abortos', l: 'Abortos' },
              { k: 'cesareas', l: 'Cesáreas' },
            ].map((it) => (
              <Field key={it.k} label={it.l}>
                <input
                  type="number"
                  min="0"
                  value={gpac[it.k] ?? ''}
                  onChange={(e) => setGpac(it.k, e.target.value)}
                  className="input"
                />
              </Field>
            ))}
          </div>
        </div>

        {/* Métodos anticonceptivos */}
        <div>
          <label className="block text-xs font-semibold text-slate-600 mb-1">Métodos anticonceptivos</label>
          <div className="flex flex-wrap gap-2">
            {GINECO_METODOS.map((m) => (
              <GChip key={m.key} active={!!met[m.key]} onClick={() => setMet(m.key, !met[m.key])}>{m.label}</GChip>
            ))}
          </div>
          {met.otro && (
            <input
              type="text"
              value={met.otroDetalle || ''}
              onChange={(e) => setMet('otroDetalle', e.target.value)}
              placeholder="¿Cuál otro método?"
              className="input mt-2"
            />
          )}
        </div>

        {/* PAP */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">PAP (Papanicolaou)</label>
            <div className="flex gap-2">
              <GChip active={pap.tipo === 'previo'} onClick={() => onChange({ ...g, pap: { ...pap, tipo: pap.tipo === 'previo' ? '' : 'previo' } })}>PAP previo</GChip>
              <GChip active={pap.tipo === 'primera_vez'} onClick={() => onChange({ ...g, pap: { ...pap, tipo: pap.tipo === 'primera_vez' ? '' : 'primera_vez' } })}>1.ª vez</GChip>
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Toma de PAP</label>
            <div className="flex flex-wrap gap-2">
              {GINECO_TOMA.map((t) => (
                <GChip key={t.key} active={!!toma[t.key]} onClick={() => setToma(t.key, !toma[t.key])}>{t.label}</GChip>
              ))}
            </div>
            {toma.otros && (
              <input
                type="text"
                value={toma.otrosDetalle || ''}
                onChange={(e) => setToma('otrosDetalle', e.target.value)}
                placeholder="Especifique otros"
                className="input mt-2"
              />
            )}
          </div>
        </div>

        {/* Control prenatal */}
        <div>
          <label className="block text-xs font-semibold text-slate-600 mb-1">Control prenatal</label>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <Field label="Signos vitales / score">
              <input
                type="text"
                value={cp.signosVitalesScore || ''}
                onChange={(e) => setCp('signosVitalesScore', e.target.value)}
                className="input"
              />
            </Field>
            <Field label="Bebé — posición">
              <input
                type="text"
                value={cp.bebePosicion || ''}
                onChange={(e) => setCp('bebePosicion', e.target.value)}
                placeholder="Cefálico, podálico…"
                className="input"
              />
            </Field>
            <Field label="Actividad cardíaca">
              <input
                type="text"
                value={cp.actividadCardiaca || ''}
                onChange={(e) => setCp('actividadCardiaca', e.target.value)}
                placeholder="FCF (lpm)"
                className="input"
              />
            </Field>
          </div>
        </div>
      </div>
    </div>
  );
}

function GinecologiaSummary({ g }) {
  if (!g) return null;
  const gpac = g.gpac || {};
  const met = g.metodosAnticonceptivos || {};
  const pap = g.pap || {};
  const toma = pap.toma || {};
  const cp = g.controlPrenatal || {};
  const metodos = GINECO_METODOS.filter((m) => met[m.key]).map((m) => (m.key === 'otro' && met.otroDetalle ? `Otro (${met.otroDetalle})` : m.label));
  const tomas = GINECO_TOMA.filter((t) => toma[t.key]).map((t) => (t.key === 'otros' && toma.otrosDetalle ? `Otros (${toma.otrosDetalle})` : t.label));
  const gpacStr = ['gestas', 'partos', 'abortos', 'cesareas']
    .map((k) => (gpac[k] != null && gpac[k] !== '' ? gpac[k] : '—'))
    .join(' / ');
  const hasGpac = ['gestas', 'partos', 'abortos', 'cesareas'].some((k) => gpac[k] != null && gpac[k] !== '');
  const papTipo = pap.tipo === 'previo' ? 'PAP previo' : pap.tipo === 'primera_vez' ? 'PAP 1.ª vez' : '';
  return (
    <div className="mt-2 text-[11px] text-slate-600 bg-rose-50 border border-rose-100 rounded p-2 flex flex-wrap gap-x-3 gap-y-0.5">
      <span className="font-semibold text-rose-600 uppercase w-full">Ginecología</span>
      {g.fum && <span>FUM: {fmtDate(g.fum)}</span>}
      {hasGpac && <span>G/P/A/C: {gpacStr}</span>}
      {g.embarazoActual != null && <span>Embarazo actual: {g.embarazoActual ? 'Sí' : 'No'}</span>}
      {metodos.length > 0 && <span>Anticoncepción: {metodos.join(', ')}</span>}
      {papTipo && <span>{papTipo}</span>}
      {tomas.length > 0 && <span>Toma PAP: {tomas.join(', ')}</span>}
      {cp.signosVitalesScore && <span>SV/score: {cp.signosVitalesScore}</span>}
      {cp.bebePosicion && <span>Posición: {cp.bebePosicion}</span>}
      {cp.actividadCardiaca && <span>Act. cardíaca: {cp.actividadCardiaca}</span>}
    </div>
  );
}

// ═══════════ Fichas por especialidad (podología / odontología / cosmetología) ═══════════
//
// Las tres siguen el mismo molde que ginecología: una sección que solo se le
// pinta a su rol en el formulario de seguimiento, y un resumen en el historial.
// Lo que se ve dentro son secciones plegables (`Collapsible`), igual que los
// signos vitales, para que el seguimiento no se vuelva un formulario kilométrico.

// Clases COMPLETAS por tono: Tailwind solo conserva las que encuentra literales,
// así que nada de `bg-${tone}-600`.
const CHIP_TONES = {
  sky: 'bg-sky-600 text-white border-sky-600',
  cyan: 'bg-cyan-600 text-white border-cyan-600',
  fuchsia: 'bg-fuchsia-600 text-white border-fuchsia-600',
};

// Chip de selección (toggle) de las fichas por especialidad.
function SChip({ active, onClick, tone = 'sky', children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer border ${
        active ? CHIP_TONES[tone] : 'bg-white text-slate-600 border-slate-200'
      }`}
    >
      {children}
    </button>
  );
}

// Selección única entre opciones cerradas (volver a pulsar la opción la quita).
function OptionChips({ options, value, onChange, tone = 'sky' }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((op) => (
        <SChip key={op} tone={tone} active={value === op} onClick={() => onChange(value === op ? '' : op)}>
          {optionLabel(op)}
        </SChip>
      ))}
    </div>
  );
}

// Caja de resumen en el historial (mismo formato que OpticaRxSummary/GinecologiaSummary).
const SUMMARY_TONES = {
  sky: { box: 'bg-sky-50 border-sky-100', label: 'text-sky-600' },
  cyan: { box: 'bg-cyan-50 border-cyan-100', label: 'text-cyan-600' },
  fuchsia: { box: 'bg-fuchsia-50 border-fuchsia-100', label: 'text-fuchsia-600' },
};

function SpecialtySummary({ title, tone, children }) {
  const t = SUMMARY_TONES[tone] || SUMMARY_TONES.sky;
  return (
    <div className={`mt-2 text-[11px] text-slate-600 border rounded p-2 flex flex-wrap gap-x-3 gap-y-0.5 ${t.box}`}>
      <span className={`font-semibold uppercase w-full ${t.label}`}>{title}</span>
      {children}
    </div>
  );
}

/**
 * ¿Hay algo escrito en este objeto (a cualquier profundidad)?
 *
 * `false` cuenta como vacío A PROPÓSITO: las casillas nacen apagadas y mongoose
 * las materializa en cada guardado, así que tomarlas por contenido pintaría la
 * caja del resumen en TODOS los seguimientos. Los campos de tres estados
 * (sí / no / sin dato) no caben en esta regla y se comprueban aparte.
 */
function hasContent(v) {
  if (v == null || v === '' || v === false) return false;
  if (Array.isArray(v)) return v.some(hasContent);
  if (typeof v === 'object') return Object.values(v).some(hasContent);
  return true;
}

// ──────────────── Podología (rol podologia) ────────────────

function podologiaHasData(p) {
  // `edema` es de tres estados: dejar constancia de que NO hay edema es un
  // hallazgo clínico (pie diabético), y `hasContent` descarta `false`. Si fuera
  // lo único registrado, el resumen no se pintaría y el dato se perdería de
  // vista. Mismo criterio que `embarazoActual` en ginecología.
  return hasContent(p) || p?.hallazgosGenerales?.edema != null;
}

function PodologiaSection({ value, onChange }) {
  const p = value || {};
  const hg = p.hallazgosGenerales || {};
  const vn = p.vascularNeurologica || {};
  const ev = p.evaluacion || {};
  const setHg = (k, v) => onChange({ ...p, hallazgosGenerales: { ...hg, [k]: v } });
  const setVn = (k, v) => onChange({ ...p, vascularNeurologica: { ...vn, [k]: v } });
  const setEv = (k, v) => onChange({ ...p, evaluacion: { ...ev, [k]: v } });

  return (
    <div className="md:col-span-3 space-y-3">
      <label className="text-sm font-medium text-slate-700 block">Ficha podológica</label>

      <Collapsible title="Hallazgos generales" hint="piel, uñas, hidratación, temperatura…">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          {PODOLOGIA_HALLAZGOS_GENERALES.map((f) => (
            <Field key={f.key} label={f.label}>
              <input
                type="text"
                value={hg[f.key] || ''}
                onChange={(e) => setHg(f.key, e.target.value)}
                className="input"
              />
            </Field>
          ))}
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Edema</label>
            <div className="flex gap-2">
              <SChip active={hg.edema === true} onClick={() => setHg('edema', hg.edema === true ? null : true)}>Sí</SChip>
              <SChip active={hg.edema === false} onClick={() => setHg('edema', hg.edema === false ? null : false)}>No</SChip>
            </div>
          </div>
        </div>
      </Collapsible>

      <Collapsible title="Evaluación vascular y neurológica" hint="pulsos, llenado capilar, sensibilidad, reflejos">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Pulso pedio</label>
            <OptionChips options={PODOLOGIA_PULSO_OPCIONES} value={vn.pulsoPedio} onChange={(v) => setVn('pulsoPedio', v)} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Pulso tibial posterior</label>
            <OptionChips options={PODOLOGIA_PULSO_OPCIONES} value={vn.pulsoTibialPosterior} onChange={(v) => setVn('pulsoTibialPosterior', v)} />
          </div>
          <Field label="Llenado capilar (segundos)">
            <input
              type="text"
              value={vn.llenadoCapilar || ''}
              onChange={(e) => setVn('llenadoCapilar', e.target.value)}
              placeholder="ej. 2 seg"
              className="input"
            />
          </Field>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Sensibilidad (monofilamento)</label>
            <OptionChips options={PODOLOGIA_SENSIBILIDAD_OPCIONES} value={vn.sensibilidadMonofilamento} onChange={(v) => setVn('sensibilidadMonofilamento', v)} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Reflejos</label>
            <OptionChips options={PODOLOGIA_REFLEJOS_OPCIONES} value={vn.reflejos} onChange={(v) => setVn('reflejos', v)} />
          </div>
        </div>
      </Collapsible>

      <Collapsible title="Evaluación podológica" hint="piel, uñas, pulsos, sensibilidad, calzado, marcha">
        <div className="space-y-2">
          {PODOLOGIA_EVALUACION.map((row) => (
            <div key={row.key} className="grid grid-cols-1 md:grid-cols-4 gap-2 md:items-center">
              <span className="text-xs font-semibold text-slate-600">{row.label}</span>
              <input
                type="text"
                value={ev[row.key] || ''}
                onChange={(e) => setEv(row.key, e.target.value)}
                placeholder="Observaciones"
                className="input md:col-span-3"
              />
            </div>
          ))}
        </div>
      </Collapsible>

      <Collapsible title="Hallazgos podológicos" hint="marque los que presente">
        <div className="space-y-4">
          <MspChecklist
            catalog={PODOLOGIA_HALLAZGOS}
            value={p.hallazgos}
            onChange={(v) => onChange({ ...p, hallazgos: v })}
            showDetail={false}
          />
          <Field label="Descripción de los hallazgos">
            <textarea
              rows={2}
              value={p.hallazgosDetalle || ''}
              onChange={(e) => onChange({ ...p, hallazgosDetalle: e.target.value })}
              placeholder="Zona, lado (pie derecho / izquierdo), características…"
              className="input resize-none"
            />
          </Field>
        </div>
      </Collapsible>
    </div>
  );
}

function PodologiaSummary({ p }) {
  if (!p) return null;
  const hg = p.hallazgosGenerales || {};
  const vn = p.vascularNeurologica || {};
  const ev = p.evaluacion || {};
  const hallazgos = markedItems(PODOLOGIA_HALLAZGOS, p.hallazgos);
  return (
    <SpecialtySummary title="Podología" tone="sky">
      {PODOLOGIA_HALLAZGOS_GENERALES.filter((f) => hg[f.key]).map((f) => (
        <span key={f.key}>{f.label}: {hg[f.key]}</span>
      ))}
      {hg.edema != null && <span>Edema: {hg.edema ? 'Sí' : 'No'}</span>}
      {vn.pulsoPedio && <span>Pulso pedio: {optionLabel(vn.pulsoPedio)}</span>}
      {vn.pulsoTibialPosterior && <span>Pulso tibial post.: {optionLabel(vn.pulsoTibialPosterior)}</span>}
      {vn.llenadoCapilar && <span>Llenado capilar: {vn.llenadoCapilar}</span>}
      {vn.sensibilidadMonofilamento && <span>Sensibilidad: {optionLabel(vn.sensibilidadMonofilamento)}</span>}
      {vn.reflejos && <span>Reflejos: {optionLabel(vn.reflejos)}</span>}
      {PODOLOGIA_EVALUACION.filter((r) => ev[r.key]).map((r) => (
        <span key={r.key}>{r.label}: {ev[r.key]}</span>
      ))}
      {hallazgos.length > 0 && <span className="w-full">Hallazgos: {hallazgos.map((h) => h.label).join(', ')}</span>}
      {p.hallazgosDetalle && <span className="w-full whitespace-pre-wrap">{p.hallazgosDetalle}</span>}
    </SpecialtySummary>
  );
}

// ──────────────── Odontología (rol odontologia) ────────────────

const dienteMarcado = (d) =>
  Boolean(
    d &&
      (d.estado ||
        String(d.nota || '').trim() ||
        d.recesion ||
        d.movilidad ||
        Object.values(d.caras || {}).some(Boolean))
  );

function odontologiaHasData(o) {
  return Boolean(
    (o?.odontograma || []).some(dienteMarcado) ||
      (o?.higieneOral || []).length > 0 ||
      o?.enfermedadPeriodontal ||
      o?.maloclusion ||
      o?.fluorosis ||
      Object.values(o?.cpo || {}).some(Boolean) ||
      Object.values(o?.ceo || {}).some(Boolean) ||
      String(o?.observaciones || '').trim()
  );
}

const estadoLabel = (key) => ODONTOGRAMA_ESTADOS.find((e) => e.key === key)?.label || '';

function OdontologiaSection({ value, onChange }) {
  const o = value || {};
  return (
    <div className="space-y-3">
      <Collapsible title="Odontograma" hint="esquema, indicadores y índices (MSP)">
        <div className="space-y-3">
          <Odontograma value={o} onChange={onChange} />
          <Field label="Observaciones del odontograma">
            <textarea
              rows={2}
              value={o.observaciones || ''}
              onChange={(e) => onChange({ ...o, observaciones: e.target.value })}
              className="input resize-none"
            />
          </Field>
        </div>
      </Collapsible>
    </div>
  );
}

function OdontologiaSummary({ o }) {
  if (!o) return null;
  const dientes = (o.odontograma || []).filter(dienteMarcado);
  const opcionLabel = (catalog, key) => catalog.find((c) => c.key === key)?.label || '';
  const suma = (obj, cols) => cols.reduce((s, c) => s + (Number.parseInt(obj?.[c.key], 10) || 0), 0);
  const higiene = (o.higieneOral || []).filter((f) => f.pieza || f.placa || f.calculo || f.gingivitis);
  const cpoTotal = suma(o.cpo, INDICE_CPO);
  const ceoTotal = suma(o.ceo, INDICE_CEO);
  // Se muestra si hay algo CAPTURADO, no si la suma es mayor que cero: un CPO
  // todo en ceros es un hallazgo válido (paciente sin caries) y ocultarlo haría
  // parecer que el odontólogo no llenó el índice.
  const hayCpo = INDICE_CPO.some((c) => String(o.cpo?.[c.key] ?? '') !== '');
  const hayCeo = INDICE_CEO.some((c) => String(o.ceo?.[c.key] ?? '') !== '');

  return (
    <SpecialtySummary title="Odontología" tone="cyan">
      {dientes.map((d) => {
        // Cada cara lleva SU estado: se dice cuál, no solo que estaba marcada.
        const caras = ODONTOGRAMA_CARAS.filter((c) => d.caras?.[c.key]).map(
          (c) => `${c.label}: ${estadoLabel(d.caras[c.key])}`
        );
        const grados = [
          d.recesion && `recesión ${d.recesion}`,
          d.movilidad && `movilidad ${d.movilidad}`,
        ].filter(Boolean);
        return (
          <span key={d.diente} className="bg-white/70 border border-cyan-200 rounded px-1.5 py-0.5">
            <b>{d.diente}</b>
            {d.estado && ` ${estadoLabel(d.estado)}`}
            {caras.length > 0 && ` (${caras.join(', ')})`}
            {grados.length > 0 && ` [${grados.join(', ')}]`}
            {d.nota && ` — ${d.nota}`}
          </span>
        );
      })}
      {higiene.length > 0 && (
        <span className="w-full">
          Higiene oral:{' '}
          {higiene
            .map((f) => {
              const fila = HIGIENE_ORAL_FILAS.find((x) => x.key === f.fila);
              const vals = HIGIENE_ORAL_INDICES.filter((i) => f[i.key]).map((i) => `${i.label} ${f[i.key]}`);
              return `${f.pieza || fila?.label || f.fila}${vals.length ? ` (${vals.join(', ')})` : ''}`;
            })
            .join(' · ')}
        </span>
      )}
      {o.enfermedadPeriodontal && (
        <span>Enf. periodontal: {opcionLabel(ENFERMEDAD_PERIODONTAL, o.enfermedadPeriodontal)}</span>
      )}
      {o.maloclusion && <span>Maloclusión: {opcionLabel(MALOCLUSION, o.maloclusion)}</span>}
      {o.fluorosis && <span>Fluorosis: {opcionLabel(FLUOROSIS, o.fluorosis)}</span>}
      {hayCpo && (
        <span>
          CPO: {INDICE_CPO.map((c) => `${c.label} ${o.cpo?.[c.key] || 0}`).join(' · ')} — Total {cpoTotal}
        </span>
      )}
      {hayCeo && (
        <span>
          ceo: {INDICE_CEO.map((c) => `${c.label} ${o.ceo?.[c.key] || 0}`).join(' · ')} — Total {ceoTotal}
        </span>
      )}
      {o.observaciones && <span className="w-full whitespace-pre-wrap">{o.observaciones}</span>}
    </SpecialtySummary>
  );
}

// ──────────────── Cosmetología (rol cosmetologia) ────────────────

function cosmetologiaHasData(c) {
  return hasContent(c);
}

function CosmetologiaSection({ value, onChange }) {
  const c = value || {};
  const de = c.datosEsteticos || {};
  const ev = c.evaluacion || {};
  const hi = c.higiene || {};
  const ca = c.cabello || {};
  const tr = ca.tratamientos || {};
  const cc = c.cueroCabelludo || {};
  const pr = c.procedimiento || {};
  const setDe = (k, v) => onChange({ ...c, datosEsteticos: { ...de, [k]: v } });
  const setEv = (k, v) => onChange({ ...c, evaluacion: { ...ev, [k]: v } });
  const setHi = (k, v) => onChange({ ...c, higiene: { ...hi, [k]: v } });
  const setCa = (k, v) => onChange({ ...c, cabello: { ...ca, [k]: v } });
  const setTr = (k, v) => onChange({ ...c, cabello: { ...ca, tratamientos: { ...tr, [k]: v } } });
  const setCc = (k, v) => onChange({ ...c, cueroCabelludo: { ...cc, [k]: v } });
  const setPr = (k, v) => onChange({ ...c, procedimiento: { ...pr, [k]: v } });

  // Hiperpigmentaciones: una zona con marca y, en los tercios, lado D / I.
  const hiper = Array.isArray(ev.hiperpigmentaciones) ? ev.hiperpigmentaciones : [];
  const hiperBy = Object.fromEntries(hiper.map((z) => [z.key, z]));
  const setHiper = (key, patch) => {
    const cur = hiperBy[key] || { key, marked: false, derecho: false, izquierdo: false };
    const next = { ...cur, ...patch };
    const resto = hiper.filter((z) => z.key !== key);
    const lista = next.marked || next.derecho || next.izquierdo ? [...resto, next] : resto;
    const orden = COSMETOLOGIA_HIPERPIGMENTACION.map((z) => z.key);
    lista.sort((a, b) => orden.indexOf(a.key) - orden.indexOf(b.key));
    setEv('hiperpigmentaciones', lista);
  };

  return (
    <div className="md:col-span-3 space-y-3">
      <label className="text-sm font-medium text-slate-700 block">Ficha cosmetológica</label>

      <Collapsible title="Datos estéticos" hint="tratamientos y cosméticos que ya usa">
        <div className="space-y-2">
          <Field label="Tratamientos estéticos">
            <textarea rows={2} value={de.tratamientosEsteticos || ''} onChange={(e) => setDe('tratamientosEsteticos', e.target.value)} className="input resize-none" />
          </Field>
          <Field label="Autotratamientos estéticos">
            <textarea rows={2} value={de.autotratamientos || ''} onChange={(e) => setDe('autotratamientos', e.target.value)} className="input resize-none" />
          </Field>
          <Field label="Cosméticos de uso actual">
            <textarea rows={2} value={de.cosmeticosUsoActual || ''} onChange={(e) => setDe('cosmeticosUsoActual', e.target.value)} className="input resize-none" />
          </Field>
        </div>
      </Collapsible>

      <Collapsible title="Evaluación" hint="fototipo, biotipo, arrugas, acné, lesiones">
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Fototipo de piel</label>
              <OptionChips options={COSMETOLOGIA_FOTOTIPOS} value={ev.fototipo} onChange={(v) => setEv('fototipo', v)} tone="fuchsia" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Escala de Glogau</label>
              <OptionChips options={COSMETOLOGIA_GLOGAU} value={ev.glogau} onChange={(v) => setEv('glogau', v)} tone="fuchsia" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Rosácea (estadio)</label>
              <OptionChips options={COSMETOLOGIA_ROSACEA} value={ev.rosacea} onChange={(v) => setEv('rosacea', v)} tone="fuchsia" />
            </div>
          </div>

          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase mb-2">Biotipo</p>
            <MspChecklist catalog={COSMETOLOGIA_BIOTIPOS} value={ev.biotipo} onChange={(v) => setEv('biotipo', v)} showDetail={false} />
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase mb-2">Arrugas</p>
            <MspChecklist catalog={COSMETOLOGIA_ARRUGAS} value={ev.arrugas} onChange={(v) => setEv('arrugas', v)} showDetail={false} />
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase mb-2">Acné</p>
            <MspChecklist catalog={COSMETOLOGIA_ACNE} value={ev.acne} onChange={(v) => setEv('acne', v)} showDetail={false} />
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase mb-2">Lesiones elementales</p>
            <MspChecklist catalog={COSMETOLOGIA_LESIONES} value={ev.lesionesElementales} onChange={(v) => setEv('lesionesElementales', v)} showDetail={false} />
          </div>

          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase mb-2">Hiperpigmentaciones</p>
            <div className="space-y-2">
              {COSMETOLOGIA_HIPERPIGMENTACION.map((z) => {
                const cur = hiperBy[z.key] || {};
                return (
                  <div key={z.key} className="flex flex-wrap items-center gap-2">
                    <SChip tone="fuchsia" active={!!cur.marked} onClick={() => setHiper(z.key, { marked: !cur.marked })}>
                      {z.label}
                    </SChip>
                    {z.lados && (
                      <>
                        <SChip tone="fuchsia" active={!!cur.derecho} onClick={() => setHiper(z.key, { derecho: !cur.derecho })}>D</SChip>
                        <SChip tone="fuchsia" active={!!cur.izquierdo} onClick={() => setHiper(z.key, { izquierdo: !cur.izquierdo })}>I</SChip>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Deshidratación dérmica facial</label>
            <OptionChips options={COSMETOLOGIA_DESHIDRATACION} value={ev.deshidratacionFacial} onChange={(v) => setEv('deshidratacionFacial', v)} tone="fuchsia" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Bioestimulación dérmica facial">
              <input type="text" value={ev.bioestimulacion || ''} onChange={(e) => setEv('bioestimulacion', e.target.value)} className="input" />
            </Field>
            <Field label="Nutrición dérmica facial">
              <input type="text" value={ev.nutricionDermica || ''} onChange={(e) => setEv('nutricionDermica', e.target.value)} className="input" />
            </Field>
          </div>
          <Field label="Evaluación">
            <textarea rows={3} value={ev.observaciones || ''} onChange={(e) => setEv('observaciones', e.target.value)} className="input resize-none" />
          </Field>
        </div>
      </Collapsible>

      <Collapsible title="Datos de higiene" hint="lavado capilar y productos">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <Field label="Frecuencia de lavado capilar">
            <input type="text" value={hi.frecuenciaLavado || ''} onChange={(e) => setHi('frecuenciaLavado', e.target.value)} className="input" />
          </Field>
          <Field label="Shampoo">
            <input type="text" value={hi.shampoo || ''} onChange={(e) => setHi('shampoo', e.target.value)} className="input" />
          </Field>
          <Field label="Acondicionador">
            <input type="text" value={hi.acondicionador || ''} onChange={(e) => setHi('acondicionador', e.target.value)} className="input" />
          </Field>
          <Field label="Otros">
            <input type="text" value={hi.otros || ''} onChange={(e) => setHi('otros', e.target.value)} className="input" />
          </Field>
        </div>
      </Collapsible>

      <Collapsible title="Características del cabello" hint="longitud, forma, calibre, densidad…">
        <div className="space-y-3">
          {COSMETOLOGIA_CABELLO.map((f) => (
            <div key={f.key}>
              <label className="block text-xs font-semibold text-slate-600 mb-1">{f.label}</label>
              <OptionChips options={f.options} value={ca[f.key]} onChange={(v) => setCa(f.key, v)} tone="fuchsia" />
            </div>
          ))}
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Tratamientos estéticos</label>
            <div className="flex flex-wrap gap-2">
              {COSMETOLOGIA_CABELLO_TRATAMIENTOS.map((t) => (
                <SChip key={t.key} tone="fuchsia" active={!!tr[t.key]} onClick={() => setTr(t.key, !tr[t.key])}>
                  {t.label}
                </SChip>
              ))}
            </div>
          </div>
        </div>
      </Collapsible>

      <Collapsible title="Características del cuero cabelludo" hint="tipo, glándula sebácea, sensibilidad, movilidad">
        <div className="space-y-3">
          {COSMETOLOGIA_CUERO_CABELLUDO.map((f) => (
            <div key={f.key}>
              <label className="block text-xs font-semibold text-slate-600 mb-1">{f.label}</label>
              <OptionChips options={f.options} value={cc[f.key]} onChange={(v) => setCc(f.key, v)} tone="fuchsia" />
            </div>
          ))}
        </div>
      </Collapsible>

      <Collapsible title="Alteración de la fibra capilar" hint="marque y describa lo que encuentre">
        <MspChecklist
          catalog={COSMETOLOGIA_FIBRA_CAPILAR}
          value={c.fibraCapilar}
          onChange={(v) => onChange({ ...c, fibraCapilar: v })}
        />
      </Collapsible>

      <Collapsible title="Afecciones del cuero cabelludo" hint="en alopecia, describa el tipo">
        <MspChecklist
          catalog={COSMETOLOGIA_AFECCIONES_CUERO}
          value={c.afeccionesCuero}
          onChange={(v) => onChange({ ...c, afeccionesCuero: v })}
        />
      </Collapsible>

      <Collapsible title="Procedimiento y productos utilizados" hint="lo realizado en la sesión">
        <div className="space-y-2">
          <Field label="Procedimiento estético">
            <textarea rows={3} value={pr.procedimiento || ''} onChange={(e) => setPr('procedimiento', e.target.value)} className="input resize-none" />
          </Field>
          <Field label="Productos con que se trabajó">
            <textarea rows={2} value={pr.productos || ''} onChange={(e) => setPr('productos', e.target.value)} className="input resize-none" />
          </Field>
          <Field label="Apoyo domiciliario">
            <textarea rows={2} value={pr.apoyoDomiciliario || ''} onChange={(e) => setPr('apoyoDomiciliario', e.target.value)} className="input resize-none" />
          </Field>
        </div>
      </Collapsible>
    </div>
  );
}

function CosmetologiaSummary({ c }) {
  if (!c) return null;
  const de = c.datosEsteticos || {};
  const ev = c.evaluacion || {};
  const hi = c.higiene || {};
  const ca = c.cabello || {};
  const tr = ca.tratamientos || {};
  const cc = c.cueroCabelludo || {};
  const pr = c.procedimiento || {};
  const chips = (catalog, value) => markedItems(catalog, value).map((i) => i.label);
  const biotipo = chips(COSMETOLOGIA_BIOTIPOS, ev.biotipo);
  const arrugas = chips(COSMETOLOGIA_ARRUGAS, ev.arrugas);
  const acne = chips(COSMETOLOGIA_ACNE, ev.acne);
  const lesiones = chips(COSMETOLOGIA_LESIONES, ev.lesionesElementales);
  const hiper = (ev.hiperpigmentaciones || []).map((z) => {
    const zona = COSMETOLOGIA_HIPERPIGMENTACION.find((x) => x.key === z.key)?.label || z.key;
    const lados = [z.derecho && 'D', z.izquierdo && 'I'].filter(Boolean).join('/');
    return lados ? `${zona} (${lados})` : zona;
  });
  const tratamientos = COSMETOLOGIA_CABELLO_TRATAMIENTOS.filter((t) => tr[t.key]).map((t) => t.label);
  // Estas dos llevan detalle por casilla: se muestra «Alopecia: androgénica».
  const conDetalle = (catalog, value) =>
    markedItems(catalog, value).map((i) => (i.detail ? `${i.label}: ${i.detail}` : i.label));
  const fibra = conDetalle(COSMETOLOGIA_FIBRA_CAPILAR, c.fibraCapilar);
  const afecciones = conDetalle(COSMETOLOGIA_AFECCIONES_CUERO, c.afeccionesCuero);
  return (
    <SpecialtySummary title="Cosmetología" tone="fuchsia">
      {de.tratamientosEsteticos && <span>Tratamientos: {de.tratamientosEsteticos}</span>}
      {de.autotratamientos && <span>Autotratamientos: {de.autotratamientos}</span>}
      {de.cosmeticosUsoActual && <span>Cosméticos: {de.cosmeticosUsoActual}</span>}
      {ev.fototipo && <span>Fototipo: {ev.fototipo}</span>}
      {ev.glogau && <span>Glogau: {ev.glogau}</span>}
      {ev.rosacea && <span>Rosácea: estadio {ev.rosacea}</span>}
      {biotipo.length > 0 && <span>Biotipo: {biotipo.join(', ')}</span>}
      {arrugas.length > 0 && <span>Arrugas: {arrugas.join(', ')}</span>}
      {acne.length > 0 && <span>Acné: {acne.join(', ')}</span>}
      {lesiones.length > 0 && <span className="w-full">Lesiones: {lesiones.join(', ')}</span>}
      {hiper.length > 0 && <span className="w-full">Hiperpigmentaciones: {hiper.join(', ')}</span>}
      {ev.deshidratacionFacial && <span>Deshidratación: {optionLabel(ev.deshidratacionFacial)}</span>}
      {ev.bioestimulacion && <span>Bioestimulación: {ev.bioestimulacion}</span>}
      {ev.nutricionDermica && <span>Nutrición dérmica: {ev.nutricionDermica}</span>}
      {ev.observaciones && <span className="w-full whitespace-pre-wrap">Evaluación: {ev.observaciones}</span>}
      {hi.frecuenciaLavado && <span>Lavado capilar: {hi.frecuenciaLavado}</span>}
      {hi.shampoo && <span>Shampoo: {hi.shampoo}</span>}
      {hi.acondicionador && <span>Acondicionador: {hi.acondicionador}</span>}
      {hi.otros && <span>Otros (higiene): {hi.otros}</span>}
      {COSMETOLOGIA_CABELLO.filter((f) => ca[f.key]).map((f) => (
        <span key={f.key}>{f.label}: {optionLabel(ca[f.key])}</span>
      ))}
      {tratamientos.length > 0 && <span>Tratamientos capilares: {tratamientos.join(', ')}</span>}
      {COSMETOLOGIA_CUERO_CABELLUDO.filter((f) => cc[f.key]).map((f) => (
        <span key={f.key}>Cuero cabelludo — {f.label}: {optionLabel(cc[f.key])}</span>
      ))}
      {fibra.length > 0 && <span className="w-full">Fibra capilar: {fibra.join(', ')}</span>}
      {afecciones.length > 0 && <span className="w-full">Afecciones del cuero cabelludo: {afecciones.join(', ')}</span>}
      {pr.procedimiento && <span className="w-full whitespace-pre-wrap">Procedimiento: {pr.procedimiento}</span>}
      {pr.productos && <span className="w-full whitespace-pre-wrap">Productos: {pr.productos}</span>}
      {pr.apoyoDomiciliario && <span className="w-full whitespace-pre-wrap">Apoyo domiciliario: {pr.apoyoDomiciliario}</span>}
    </SpecialtySummary>
  );
}

// ───────────────────── Citas ─────────────────────
function CitasTab({ patientId }) {
  const [appts, setAppts] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [aRes, sRes] = await Promise.all([
          api.get('/appointments'),
          api.get('/appointments/stats', { params: { patient: patientId } }).catch(() => ({ data: null })),
        ]);
        setAppts(
          aRes.data.filter((a) => String(a.patient?._id || a.patient) === String(patientId))
        );
        setStats(sRes.data);
      } catch (err) {
        toast.error(err.response?.data?.message || 'Error al cargar citas');
      } finally {
        setLoading(false);
      }
    })();
  }, [patientId]);

  if (loading) return <div className="text-slate-500 text-sm">Cargando...</div>;

  const attendancePct = stats?.attendanceRate ?? null;

  return (
    <div className="space-y-4">
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3">
            <p className="text-xs text-emerald-700 font-semibold uppercase">Asistencia</p>
            <p className="text-2xl font-bold text-emerald-800">
              {attendancePct != null ? `${Number(attendancePct).toFixed(0)}%` : '—'}
            </p>
          </div>
          <div className="bg-blue-50 border border-blue-200 rounded-xl p-3">
            <p className="text-xs text-blue-700 font-semibold uppercase">Asistidas</p>
            <p className="text-2xl font-bold text-blue-800">{stats.byStatus?.asistida || 0}</p>
          </div>
          <div className="bg-rose-50 border border-rose-200 rounded-xl p-3">
            <p className="text-xs text-rose-700 font-semibold uppercase">No asistió</p>
            <p className="text-2xl font-bold text-rose-800">{stats.byStatus?.no_asistio || 0}</p>
          </div>
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
            <p className="text-xs text-slate-700 font-semibold uppercase">Total</p>
            <p className="text-2xl font-bold text-slate-800 tracking-tight">{stats.total || appts.length}</p>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <table className="tbl">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="text-left px-4 py-2.5 font-semibold">Fecha</th>
              <th className="text-left px-4 py-2.5 font-semibold">Horario</th>
              <th className="text-left px-4 py-2.5 font-semibold">Doctor</th>
              <th className="text-left px-4 py-2.5 font-semibold">Estado</th>
            </tr>
          </thead>
          <tbody>
            {appts.length === 0 && (
              <tr>
                <td colSpan={4} className="text-center py-6 text-slate-400">
                  Sin citas registradas.
                </td>
              </tr>
            )}
            {appts.map((a) => (
              <tr key={a._id} className="border-t border-slate-100">
                <td className="px-4 py-2.5 text-slate-600">
                  {fmtDate(a.date)}
                </td>
                <td className="px-4 py-2.5 text-slate-600">
                  {a.startTime} - {a.endTime}
                </td>
                <td className="px-4 py-2.5 text-slate-700">{a.doctor?.name || '—'}</td>
                <td className="px-4 py-2.5">
                  <span className="text-xs px-2 py-0.5 bg-slate-100 text-slate-600 rounded capitalize">
                    {a.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─────────────────── Facturas ───────────────────
function FacturasTab({ patientId }) {
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get('/invoices', { params: { patient: patientId, limit: 100 } });
        setInvoices(res.data.invoices || []);
      } catch (err) {
        toast.error(err.response?.data?.message || 'Error al cargar facturas');
      } finally {
        setLoading(false);
      }
    })();
  }, [patientId]);

  if (loading) return <div className="text-slate-500 text-sm">Cargando...</div>;

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <table className="tbl">
        <thead className="bg-slate-50 text-slate-600">
          <tr>
            <th className="text-left px-4 py-2.5 font-semibold">N° Factura</th>
            <th className="text-left px-4 py-2.5 font-semibold">Fecha</th>
            <th className="text-right px-4 py-2.5 font-semibold">Total</th>
            <th className="text-left px-4 py-2.5 font-semibold">Estado</th>
            <th className="px-4 py-2.5"></th>
          </tr>
        </thead>
        <tbody>
          {invoices.length === 0 && (
            <tr>
              <td colSpan={5} className="text-center py-6 text-slate-400">
                Sin facturas.
              </td>
            </tr>
          )}
          {invoices.map((inv) => (
            <tr key={inv._id} className="border-t border-slate-100">
              <td className="px-4 py-2.5 text-slate-700 font-mono text-xs">
                {inv.estab}-{inv.ptoEmi}-{String(inv.secuencial).padStart(9, '0')}
              </td>
              <td className="px-4 py-2.5 text-slate-600">
                {fmtDate(inv.createdAt)}
              </td>
              <td className="px-4 py-2.5 text-right text-slate-700">
                ${Number(inv.importeTotal || 0).toFixed(2)}
              </td>
              <td className="px-4 py-2.5">
                <EstadoBadge estado={inv.estado} />
              </td>
              <td className="px-4 py-2.5 text-right">
                <Link
                  to={`/invoices`}
                  className="text-emerald-600 text-xs hover:underline"
                >
                  Ver →
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EstadoBadge({ estado }) {
  const styles = {
    AUTORIZADO: 'bg-emerald-100 text-emerald-700',
    DEVUELTA: 'bg-red-100 text-red-700',
    NO_AUTORIZADO: 'bg-red-100 text-red-700',
    EN_PROCESO: 'bg-amber-100 text-amber-700',
    RECIBIDA: 'bg-blue-100 text-blue-700',
    CREADA: 'bg-slate-100 text-slate-600',
    ANULADA: 'bg-slate-300 text-slate-700',
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded ${styles[estado] || 'bg-slate-100 text-slate-600'}`}>
      {estado}
    </span>
  );
}

// ─────────────── helpers ───────────────
function Field({ label, required, children, className = '' }) {
  return (
    <div className={className}>
      <label className="block text-xs font-semibold text-slate-600 mb-1">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      {children}
    </div>
  );
}

function FichaStyles() {
  return (
    <style>{`
      .input {
        width: 100%;
        padding: 0.5rem 0.75rem;
        border: 1px solid #e2e8f0;
        border-radius: 0.5rem;
        font-size: 0.875rem;
        background: white;
        outline: none;
      }
      .input:focus { border-color: #10b981; }
    `}</style>
  );
}
