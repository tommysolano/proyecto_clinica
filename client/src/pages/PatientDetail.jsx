import { useEffect, useState, Fragment, useRef, lazy, Suspense } from 'react';
import { useParams, useSearchParams, Link, useNavigate } from 'react-router-dom';
import api from '../api/axios';
import { downloadFile } from '../utils/download';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { fmtDate, fmtDateTime, nowEcHHMM, todayEc } from '../utils/date';
import TagEditor from '../components/TagEditor';
import NumericInput from '../components/NumericInput';
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
  CARDIOLOGIA_ANTECEDENTES,
  CARDIOLOGIA_ESTUDIOS,
  CARDIOLOGIA_RITMOS,
  PODOLOGIA_HALLAZGOS,
  PODOLOGIA_EVALUACION,
  PODOLOGIA_HALLAZGOS_GENERALES,
  PODOLOGIA_PULSO_OPCIONES,
  PODOLOGIA_SENSIBILIDAD_OPCIONES,
  PODOLOGIA_REFLEJOS_OPCIONES,
  labelOdonto,
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
  HiOutlineCheck,
  HiOutlineEye,
  HiOutlineTrash,
  HiOutlinePrinter,
  HiOutlineArrowDownTray,
  HiOutlineShoppingBag,
  HiOutlinePencilSquare,
  HiOutlineChevronDown,
  HiOutlineChatBubbleLeftRight,
  HiOutlinePaperClip,
  HiOutlineXMark,
} from 'react-icons/hi2';
import DateInput from '../components/DateInput';
import AttachmentPreviewModal from '../components/AttachmentPreviewModal';
import { inicioDeMiTurno } from '../utils/appointmentTurns';
import { cargarPagina } from '../utils/lazyPage';
import { edadGestacional, fechaProbableParto } from '../constants/gestacion';
import {
  SCORE_MAMA_PARAMETROS,
  SCORE_MAMA_CONCIENCIA,
  SCORE_MAMA_PROTEINURIA,
  calcularScoreMama,
  mezclarScoreMama,
  scoreMamaDesdeSignos,
  scoreMamaTieneDatos,
  scoreMamaTono,
} from '../constants/scoreMama';

// La curva arrastra recharts (~90 kB comprimidos). Se baja al abrirla, no al
// entrar en la ficha de un paciente que quizá ni es de ginecología.
const CurvaPesoGestacional = lazy(() => cargarPagina(() => import('../components/CurvaPesoGestacional')));

const TABS = [
  { id: 'datos', label: 'Datos', icon: HiOutlineUser },
  { id: 'ficha', label: 'Ficha clínica', icon: HiOutlineClipboardDocumentList },
  { id: 'seguimientos', label: 'Seguimientos', icon: HiOutlineHeart },
  { id: 'citas', label: 'Citas', icon: HiOutlineCalendar },
  { id: 'facturas', label: 'Facturas', icon: HiOutlineDocumentText },
  // Observaciones cierra la fila: es la bitácora libre del paciente, lo último
  // que se consulta. El orden de este arreglo es el orden de las pestañas.
  { id: 'observaciones', label: 'Observaciones', icon: HiOutlineChatBubbleLeftRight },
];

// ¿Esta línea de Receta/Derivaciones tiene algo escrito, aparte del nombre?
// La cantidad nace en 1, así que una fila recién creada NO cuenta como escrita.
const filaConDatos = (it) =>
  ['dose', 'frequency', 'duration', 'instructions'].some((k) => String(it?.[k] || '').trim()) ||
  (String(it?.quantity ?? '').trim() !== '' && Number(it.quantity) !== 1);

// Adjuntos permitidos en seguimientos: PDFs e imágenes.
const isAllowedAttachment = (file) =>
  !!file && (file.type === 'application/pdf' || String(file.type || '').startsWith('image/'));

// Observaciones: mismo tope que acepta el servidor (multer .array('files', 10)).
const OBSERVATION_MAX_FILES = 10;

/**
 * Un archivo demasiado grande lo corta nginx ANTES de llegar al servidor: la
 * respuesta es un 413 sin cuerpo JSON, y el aviso salía vacío.
 */
const observationUploadError = (err, fallback) => {
  if (err?.response?.status === 413) return 'El archivo es demasiado grande para subirlo';
  return err?.response?.data?.message || fallback;
};

/** Tamaño legible de un adjunto: «820 KB», «3.4 MB». */
const observationFileSize = (bytes) => {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

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

  // El cronómetro mide la duración de la CONSULTA médica (avisa a los 14 y a los
  // 19 minutos). Enfermería no consulta: pone un suero o hace una curación, que
  // duran lo que tienen que durar. Ponerle un reloj en rojo sería meterle prisa
  // sin motivo.
  const esEnfermero = hasRole('enfermero');
  // Cuenta desde que empezó EL TURNO en curso. `consultationStartedAt` es de la
  // cita entera: el segundo doctor entraba con el tiempo del primero ya corrido.
  const inicioTurno = inicioDeMiTurno(aptData);
  const timerSeconds = !esEnfermero && inicioTurno && !aptData?.consultationEndedAt
    ? Math.max(0, Math.floor((now - inicioTurno) / 1000))
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
    return <div className="p-3 sm:p-6">Paciente no encontrado.</div>;
  }

  // Filtrar tabs visibles según rol.
  //
  // Quien atiende (doctores, especialidades y enfermería) entra aquí a lo suyo:
  // la ficha y los seguimientos. La agenda del paciente y la bitácora de
  // observaciones son trabajo de recepción, y tenerlas delante solo alarga la
  // fila de pestañas en la pantalla donde menos sitio hay.
  const soloAtiende = hasRole('doctor', 'enfermero') && !hasRole('admin');
  const visibleTabs = TABS.filter((t) => {
    if (t.id === 'facturas') return hasRole('admin', 'cajero', 'contabilidad');
    if (t.id === 'citas' || t.id === 'observaciones') return !soloAtiende;
    return true;
  });
  // Un enlace viejo (?tab=citas) o un rol sin esa pestaña dejaría el panel en
  // blanco: se cae a la primera que sí puede ver.
  const tabActiva = visibleTabs.some((t) => t.id === tab) ? tab : visibleTabs[0]?.id;

  return (
    <div className="px-0 py-1 sm:p-6 max-w-6xl mx-auto">
      <Link
        to="/patients"
        className="inline-flex items-center gap-1 text-xs sm:text-sm text-slate-500 hover:text-emerald-600 mb-2 sm:mb-4 no-underline"
      >
        <HiOutlineArrowLeft className="w-4 h-4" /> Volver a pacientes
      </Link>

      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 p-3 sm:p-6 mb-4 sm:mb-6">
        <div className="flex flex-col sm:flex-row sm:items-start gap-4">
          <div className="flex items-start gap-2.5 sm:gap-4 min-w-0 flex-1">
          <div className="w-10 h-10 sm:w-14 sm:h-14 shrink-0 rounded-xl sm:rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-white font-bold text-sm sm:text-xl">
            {patient.firstName?.[0]}
            {patient.lastName?.[0]}
          </div>
          <div className="flex-1 min-w-0">
            {/* El nombre en dos líneas gigantes se comía media pantalla del
                teléfono antes de llegar al formulario, que es a lo que se entra. */}
            <h1 className="text-base sm:text-2xl font-bold text-slate-800 tracking-tight break-words leading-tight">
              {patient.firstName} {patient.lastName}
            </h1>
            {/* Cédula, teléfono y correo son solo del administrador: el servidor ni
                siquiera los envía al resto (ver CONTACT_FIELDS en patientController). */}
            <p className="text-xs sm:text-sm text-slate-500 mt-0.5 sm:mt-1">
              {hasRole('admin') ? (
                <>
                  CI: {patient.cedula} {patient.phone ? ` · ${patient.phone}` : ''}
                  {patient.email ? ` · ${patient.email}` : ''}
                </>
              ) : (
                <>Edad: {patient.computedAge ?? patient.age ?? '—'}</>
              )}
            </p>
            <div className="mt-1.5 sm:mt-2">
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
          </div>
          {timerSeconds !== null && (
            <div className="flex flex-row sm:flex-col items-center sm:items-end justify-between gap-2 sm:gap-1 shrink-0 border-t sm:border-t-0 border-slate-100 pt-3 sm:pt-0">
              <span className="hidden sm:block text-xs text-slate-400">{fmtDate(new Date().toISOString())}</span>
              <div className={`flex items-center gap-2 px-3 sm:px-4 py-2 rounded-xl border font-mono text-xl sm:text-2xl font-bold tabular-nums transition-colors ${timerStyle}`}>
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
                className={`flex items-center gap-1.5 sm:gap-2 px-3 sm:px-5 py-2.5 sm:py-3 text-sm font-medium border-none cursor-pointer transition-colors whitespace-nowrap ${
                  tabActiva === t.id
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

        <div className="p-3 sm:p-6">
          {tabActiva === 'datos' && <DatosTab patient={patient} />}
          {tabActiva === 'ficha' && <FichaTab patientId={id} />}
          {tabActiva === 'seguimientos' && <SeguimientosTab patientId={id} appointmentId={appointmentId} />}
          {tabActiva === 'citas' && <CitasTab patientId={id} />}
          {tabActiva === 'observaciones' && <ObservacionesTab patientId={id} />}
          {tabActiva === 'facturas' && <FacturasTab patientId={id} />}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── Datos ─────────────────────────
function DatosTab({ patient }) {
  const { hasRole } = useAuth();
  // Datos de contacto (cédula, correo, teléfono, WhatsApp y dirección): solo el
  // administrador. Para los demás el servidor los omite, así que ni se pintan.
  const showContact = hasRole('admin');
  const sourceLabels = {
    anuncio: 'Anuncio',
    referido: 'Referido',
    recepcion: 'Recepción',
    organico: 'Orgánico',
  };
  return (
    <div className="space-y-6">
      <dl className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
        {showContact && <Item label="Cédula" value={patient.cedula} />}
        <Item label="Nombre completo" value={`${patient.firstName} ${patient.lastName}`} />
        {showContact && <Item label="Email" value={patient.email} />}
        {showContact && <Item label="Teléfono" value={patient.phone} />}
        {showContact && <Item label="WhatsApp" value={patient.whatsapp} />}
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
        {showContact && <Item label="Dirección" value={patient.address} />}
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
        {/* Copia de los datos de contacto en la cabecera de la hoja MSP: solo el
            admin (al resto el servidor tampoco se los manda). */}
        {hasRole('admin') && (
          <Field label="Cédula">
            <input
              type="text"
              value={record.cedula || ''}
              onChange={(e) => update('cedula', e.target.value)}
              className="input"
            />
          </Field>
        )}
        {hasRole('admin') && (
          <Field label="Dirección">
            <input
              type="text"
              value={record.direccion || ''}
              onChange={(e) => update('direccion', e.target.value)}
              className="input"
            />
          </Field>
        )}
        {hasRole('admin') && (
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
    <div className={`grid grid-cols-1 sm:grid-cols-2 ${cols} gap-2`}>
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
/**
 * Tabla de líneas escritas a mano. Se reutiliza para la Receta
 * (medicamentos/insumos, variant="receta") y para las Derivaciones
 * (servicios/programas, variant="derivacion").
 *
 * TODO ES TEXTO LIBRE, y es deliberado. Antes cada línea obligaba a elegir un
 * producto del inventario con un buscador —o a pulsar "Manual" para poder
 * escribir— y eso ataba la consulta clínica al catálogo de lo que la clínica
 * vende: el médico no podía recetar algo que no estuviera en existencias sin dar
 * un rodeo. El seguimiento describe lo que se receta y a dónde se deriva; lo que
 * haya que cobrar se factura por su lado.
 *
 * Los campos se ven desde el primer momento (no hay que pulsar "Agregar ítem"
 * antes de poder escribir) y "Agregar línea" añade la siguiente. Nunca se queda
 * sin filas: borrar la última la deja en blanco en vez de hacer desaparecer la
 * tabla.
 */
function ItemsTable({ variant, items, onAdd, onUpdate, onRemove }) {
  const isReceta = variant === 'receta';
  const label = isReceta ? 'Receta' : 'Derivaciones';
  const hint = isReceta
    ? 'medicamentos e insumos indicados'
    : 'servicios o programas a los que se deriva';

  // Columnas por variante. En Derivaciones manda el orden de trabajo: cuántas
  // sesiones, de qué, y con qué indicaciones.
  const columnas = isReceta
    ? [
        { key: 'name', label: 'Medicamento / Insumo', placeholder: 'Paracetamol 500 mg', ancho: 'min-w-[200px]' },
        { key: 'quantity', label: 'Cant.', numero: true, ancho: 'w-16' },
        { key: 'dose', label: 'Dosis', placeholder: '1 tableta' },
        { key: 'frequency', label: 'Frecuencia', placeholder: 'c/8 h' },
        { key: 'duration', label: 'Duración', placeholder: '7 días' },
        { key: 'instructions', label: 'Indicaciones', placeholder: 'Después de comer' },
        // Marcarlo como suero es lo que hace que enfermería pueda ir anotando
        // cada aplicación y que la receta lleve la cuenta ("3 de 7, faltan 4").
        { key: 'isSerum', label: 'Suero', check: true, ancho: 'w-16', ayuda: 'Se administra por dosis' },
      ]
    : [
        { key: 'quantity', label: 'Cant.', numero: true, ancho: 'w-16' },
        { key: 'name', label: 'Servicio / Programa', placeholder: 'Fisioterapia, ecografía, laboratorio…', ancho: 'min-w-[240px]' },
        { key: 'instructions', label: 'Indicaciones', placeholder: 'Motivo de la derivación o instrucciones', ancho: 'min-w-[200px]' },
      ];

  // Un solo sitio donde se decide qué campo pintar: la tabla del escritorio y
  // las tarjetas del móvil comparten los mismos controles.
  const campo = (c, row, idx) =>
    c.check ? (
      <label className="flex items-center gap-1.5 cursor-pointer" title={c.ayuda || ''}>
        <input
          type="checkbox"
          checked={!!row[c.key]}
          onChange={(e) => onUpdate(idx, c.key, e.target.checked)}
          className="w-4 h-4 accent-emerald-600 cursor-pointer"
        />
        <span className="md:hidden text-xs text-slate-500">{c.ayuda}</span>
      </label>
    ) : c.numero ? (
      <NumericInput
        min={1}
        value={row[c.key]}
        onChange={(e) => onUpdate(idx, c.key, e.target.value === '' ? '' : Number(e.target.value))}
        className="input text-xs py-1"
      />
    ) : (
      <input
        type="text"
        value={row[c.key] || ''}
        onChange={(e) => onUpdate(idx, c.key, e.target.value)}
        placeholder={c.placeholder}
        className="input text-xs py-1"
      />
    );

  return (
    <div className="md:col-span-3">
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        <label className="text-sm font-medium text-slate-700">
          {label}
          <span className="ml-2 text-xs font-normal text-slate-400">{hint}</span>
        </label>
        <button
          type="button"
          onClick={onAdd}
          className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-emerald-600 text-white border-none cursor-pointer whitespace-nowrap"
        >
          <HiOutlinePlus className="w-3 h-3" /> Agregar línea
        </button>
      </div>
      {/* En el escritorio, una línea por fila. En el móvil NO: seis columnas con
          ancho mínimo obligan a arrastrar la tabla de lado mientras se escribe,
          que es lo último que quiere quien está con el paciente delante. Ahí
          cada medicamento es una tarjeta con sus campos uno debajo de otro. */}
      <div className="hidden md:block overflow-x-auto bg-white rounded-lg border border-slate-200">
        <table className="tbl text-xs">
          <thead className="bg-slate-100 text-slate-600">
            <tr>
              {columnas.map((c) => (
                <th key={c.key} className={`text-left px-2 py-1.5 ${c.ancho || ''}`}>{c.label}</th>
              ))}
              <th className="px-2 py-1.5 w-8"></th>
            </tr>
          </thead>
          <tbody>
            {items.map((row, idx) => (
              <tr key={idx} className="border-t border-slate-100">
                {columnas.map((c) => (
                  <td key={c.key} className={`px-2 py-1 ${c.ancho || ''}`}>
                    {campo(c, row, idx)}
                  </td>
                ))}
                <td className="px-2 py-1 text-right">
                  <button
                    type="button"
                    onClick={() => onRemove(idx)}
                    title="Quitar línea"
                    className="p-1 text-red-500 bg-transparent border-none cursor-pointer"
                  >
                    <HiOutlineTrash className="w-3 h-3" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="md:hidden space-y-2">
        {items.map((row, idx) => (
          <div key={idx} className="bg-white rounded-lg border border-slate-200 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">
                {isReceta ? 'Medicamento' : 'Derivación'} {idx + 1}
              </span>
              <button
                type="button"
                onClick={() => onRemove(idx)}
                className="flex items-center gap-1 text-[11px] text-red-500 bg-transparent border-none cursor-pointer p-0"
              >
                <HiOutlineTrash className="w-3.5 h-3.5" /> Quitar
              </button>
            </div>
            {columnas.map((c) => (
              <label key={c.key} className="block">
                <span className="block text-[11px] font-medium text-slate-500 mb-0.5">{c.label}</span>
                {campo(c, row, idx)}
              </label>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function SeguimientosTab({ patientId, appointmentId }) {
  const navigate = useNavigate();
  const { hasRole, user } = useAuth();
  const isOptica = hasRole('optica');
  // Cada especialidad ve SOLO su sección. `hasRole` expande hacia 'doctor', no
  // entre especialidades, así que un podólogo no ve la ficha de ginecología.
  const isGineco = hasRole('ginecologia');
  const isPodo = hasRole('podologia');
  const isOdonto = hasRole('odontologia');
  const isCosme = hasRole('cosmetologia');
  const isCardio = hasRole('cardiologia');
  const isAdmin = hasRole('admin') || user?.isSuperAdmin;

  /**
   * ENFERMERÍA: solo lectura, y solo la receta.
   *
   * Entra aquí para ver qué le mandaron poner al paciente y para ir anotando
   * cada suero. No redacta la consulta —eso es de quien la atiende— ni tiene por
   * qué leer el motivo, los diagnósticos o los antecedentes: es historia clínica
   * y su trabajo no la necesita.
   */
  const soloReceta = hasRole('enfermero') && !isAdmin;
  const puedeEscribir = !soloReceta;
  const puedeAdministrarSuero = hasRole('admin', 'doctor', 'enfermero');

  // Una vez guardado, solo administradores pueden eliminar/editar seguimientos.
  const canDelete = isAdmin;
  const canUpload = hasRole('admin', 'cajero', 'doctor', 'optica', 'enfermero');
  // «Compras y aplicaciones» dice qué compró el paciente y cuánto pagó: es
  // información económica, solo para administración y contabilidad. El servidor
  // devuelve 403 al resto (ver routes/patients.js).
  const canSeePurchases = hasRole('admin', 'contabilidad');
  const [record, setRecord] = useState(null);
  const [loading, setLoading] = useState(true);
  const fileInputRef = useRef(null);
  const emptyRow = () => ({
    name: '',
    quantity: 1,
    dose: '',
    frequency: '',
    duration: '',
    instructions: '',
    isSerum: false,
  });
  const emptyOpticaRx = () => ({
    od: { sph: '', cyl: '', ax: '', add: '', dnp: '', alt: '' },
    oi: { sph: '', cyl: '', ax: '', add: '', dnp: '', alt: '' },
  });
  const emptyGineco = () => ({
    fum: '',
    gpac: { gestas: '', partos: '', abortos: '', cesareas: '' },
    embarazoActual: null, // null = sin dato, true = sí, false = no
    pesoPreconcepcional: '', // peso antes del embarazo (kg)
    metodosAnticonceptivos: { hormonal: false, barrera: false, diu: false, otro: false, otroDetalle: '' },
    pap: {
      tipo: '', // 'previo' | 'primera_vez'
      toma: { exocervical: false, endocervical: false, otros: false, otrosDetalle: '' },
    },
    controlPrenatal: { scoreMama: null, bebePosicion: '', actividadCardiaca: '' },
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
  const emptyCardiologia = () => ({
    antecedentes: [],
    antecedentesOtros: '',
    alergias: '',
    medicacionActual: '',
    electrocardiograma: { ritmo: '', fc: null, hallazgos: '' },
    estudios: { ecocardiograma: '', holter: '', mapa: '', ergometria: '', laboratorio: '' },
    plan: { estudiosSolicitados: '', proximoControl: '' },
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
    // todayEc, no toISOString: este último da la fecha en UTC y a partir de
    // las 19:00 de Ecuador ya es el día siguiente — el seguimiento nacía fechado
    // mañana.
    fecha: todayEc(),
    tipoConsulta: '',        // B: primera | subsecuente
    descripcion: '',
    enfermedadActual: '',    // E
    planTratamiento: '',     // J
    evolucion: '',           // evolución respecto de controles anteriores
    // Con una línea en blanco: los campos se ven desde el inicio, sin tener
    // que pulsar nada antes de poder escribir. Las vacías se descartan al guardar.
    recetaItems: [emptyRow()],     // medicamentos/insumos (texto libre)
    derivacionItems: [emptyRow()], // servicios/programas (texto libre)
    revisionSistemas: [],  // G
    revisionSistemasHallazgos: '', // G: descripción de lo marcado
    examenFisico: { regional: [], sistemico: [], hallazgos: '' }, // H
    diagnosticos: [],      // I
    opticaRx: emptyOpticaRx(),
    ginecologia: emptyGineco(),
    podologia: emptyPodologia(),
    odontologia: emptyOdontologia(),
    cosmetologia: emptyCosmetologia(),
    cardiologia: emptyCardiologia(),
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
  // Adjunto que se está viendo en pantalla: { fuId, att }.
  const [previewAtt, setPreviewAtt] = useState(null);
  // PDFs seleccionados ANTES de guardar el seguimiento. Se subirán automáticamente
  // tras crear el seguimiento.
  const [pendingFiles, setPendingFiles] = useState([]);
  // Compras y avance de tratamientos del paciente (para el seguimiento).
  const [purchases, setPurchases] = useState([]);
  const [treatmentProgress, setTreatmentProgress] = useState([]);

  const loadPurchases = async () => {
    // Solo administración y contabilidad: el bloque muestra lo que el paciente
    // compró y pagó. El servidor devuelve 403 al resto (ver routes/patients.js).
    if (!canSeePurchases) return;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId]);

  // Los handlers reciben `listKey` porque el formulario tiene DOS listas:
  // 'recetaItems' (medicamentos/insumos) y 'derivacionItems' (servicios/programas).
  // Ambas son texto libre desde el rediseño (ver ItemsTable).
  const updateRow = (listKey, idx, key, val) => {
    setForm((f) => {
      const items = [...f[listKey]];
      items[idx] = { ...items[idx], [key]: val };
      return { ...f, [listKey]: items };
    });
  };

  const addRow = (listKey) =>
    setForm((f) => ({ ...f, [listKey]: [...f[listKey], emptyRow()] }));
  // Quitar la última línea la deja EN BLANCO en vez de vaciar la tabla: los
  // campos tienen que seguir a la vista para poder escribir sin más clics.
  const removeRow = (listKey, idx) =>
    setForm((f) => {
      const items = f[listKey].filter((_, i) => i !== idx);
      return { ...f, [listKey]: items.length ? items : [emptyRow()] };
    });

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

  /**
   * Impide que ENTER envíe el seguimiento.
   *
   * Pasó de verdad: un usuario estaba rellenando un campo, pulsó Enter y el
   * navegador —que envía el formulario al pulsar Enter en cualquier input—
   * guardó el seguimiento entero y dio la cita por terminada. El seguimiento
   * SOLO se envía con el botón "Guardar".
   *
   * Se dejan pasar los textarea (necesitan el salto de línea) y los botones
   * (Enter sobre un botón enfocado es su forma de activarse con el teclado). Los
   * combobox como el de CIE-10 gestionan Enter en su propio onKeyDown, que ya se
   * ha ejecutado cuando el evento llega hasta aquí.
   *
   * NO se exime Shift+Enter: el envío implícito del navegador ignora los
   * modificadores, así que Shift+Enter en un input o en una casilla enviaba el
   * formulario igual — el mismo accidente, con la tecla de al lado. El salto de
   * línea de los textarea ya lo garantiza la comprobación de arriba.
   */
  const evitarEnvioConEnter = (e) => {
    if (e.key !== 'Enter') return;
    const t = e.target;
    if (t.tagName === 'TEXTAREA' || t.tagName === 'BUTTON') return;
    e.preventDefault();
  };

  const submit = async (e) => {
    e.preventDefault();
    // Único campo obligatorio del seguimiento. Todo lo demás (receta,
    // derivaciones, diagnósticos, signos vitales…) es opcional: hay consultas
    // que no recetan nada y antes no se dejaban guardar.
    if (!String(form.descripcion || '').trim()) {
      toast.error('El motivo de consulta es obligatorio');
      return;
    }
    // Una línea a medias NO se tira en silencio. Las tablas de Receta y
    // Derivaciones nacen con una fila en blanco y las vacías se descartan al
    // guardar; pero si alguien escribió la cantidad y las indicaciones y se
    // saltó el nombre, descartarla haría desaparecer una derivación de la
    // historia clínica con un tranquilizador "Seguimiento guardado".
    const sinNombre = [
      ['Receta', form.recetaItems],
      ['Derivaciones', form.derivacionItems],
    ].flatMap(([titulo, lista]) =>
      (lista || [])
        .map((it, i) => ({ titulo, n: i + 1, it }))
        .filter(({ it }) => !String(it.name || '').trim() && filaConDatos(it)),
    );
    if (sinNombre.length) {
      const { titulo, n } = sinNombre[0];
      toast.error(`Falta el nombre en la línea ${n} de ${titulo} (o bórrala)`);
      return;
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
      // Las líneas en blanco de Receta/Derivaciones no viajan: la tabla siempre
      // muestra una fila vacía lista para escribir, y guardar sin usarla no debe
      // dejar un ítem fantasma en la historia clínica.
      const conNombre = (lista) => (lista || []).filter((it) => String(it.name || '').trim());
      const payload = {
        ...form,
        recetaItems: conNombre(form.recetaItems),
        derivacionItems: conNombre(form.derivacionItems),
        vitalSigns,
      };
      // Score MAMÁ: se envía con los signos vitales ya incorporados, para que el
      // score quede completo aunque la ginecóloga solo haya tocado la conciencia
      // o la proteinuria. El servidor vuelve a puntuar de todos modos.
      const smEfectivo = mezclarScoreMama(form.ginecologia?.controlPrenatal?.scoreMama, vitalSigns);
      payload.ginecologia = {
        ...form.ginecologia,
        controlPrenatal: {
          ...(form.ginecologia?.controlPrenatal || {}),
          scoreMama: scoreMamaTieneDatos(smEfectivo) ? smEfectivo : null,
        },
      };

      // La ficha de cada especialidad solo se envía desde su propia consulta:
      // así un seguimiento de medicina general no arrastra secciones vacías.
      if (!isGineco) delete payload.ginecologia;
      if (!isPodo) delete payload.podologia;
      if (!isOdonto) delete payload.odontologia;
      if (!isCosme) delete payload.cosmetologia;
      if (!isCardio) delete payload.cardiologia;
      if (appointmentId) payload.appointmentId = appointmentId;
      const res = await api.post(`/clinical-records/${patientId}/follow-ups`, payload);

      // A partir de aquí el seguimiento YA ESTÁ GUARDADO. Los adjuntos van en su
      // propio try: si falla la subida de un PDF y el error subiera al catch de
      // fuera, el usuario leería "Error al guardar el seguimiento" con el
      // formulario intacto, volvería a darle a Guardar y crearía un seguimiento
      // DUPLICADO en la historia clínica.
      let updated = res.data;
      const newFu = (updated.followUps || []).slice(-1)[0];
      let fallaronAdjuntos = null;
      if (newFu && pendingFiles.length > 0) {
        try {
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
        } catch (err) {
          fallaronAdjuntos = err.response?.data?.message || 'No se pudieron subir todos los archivos';
        }
      }
      setRecord(updated);
      setForm(emptyForm());
      setPendingFiles([]);

      /**
       * Guardar desde una CITA cierra el turno y devuelve a la agenda.
       *
       * Antes se quedaba en la ficha del paciente con el formulario en blanco,
       * que es exactamente igual a "no se guardó nada": había que ir al menú a
       * volver a la agenda para comprobar que sí. Y el aviso decía siempre "cita
       * finalizada", aunque detrás quedara otro profesional — el servidor
       * responde `nextTurn` justo para poder decir la verdad.
       */
      const siguiente = updated.nextTurn || res.data?.nextTurn;
      if (appointmentId) {
        const quien = siguiente?.user?.name || (siguiente?.kind === 'enfermeria' ? 'enfermería' : null);
        toast.success(
          siguiente
            ? `Seguimiento guardado. Pasa a ${quien || 'el siguiente profesional'}.`
            : 'Seguimiento guardado. Cita finalizada.'
        );
      } else {
        toast.success('Seguimiento guardado');
      }

      if (fallaronAdjuntos) {
        // El seguimiento se guardó: los archivos se vuelven a adjuntar desde la
        // lista de abajo, sin repetir la consulta.
        toast.error(`${fallaronAdjuntos}. Adjúntalos desde el seguimiento ya guardado.`, { duration: 8000 });
      }

      // Si falló algún adjunto se queda en la ficha, que es donde se vuelven a
      // subir; si no, a la agenda.
      if (appointmentId && !fallaronAdjuntos) navigate('/appointments');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al guardar el seguimiento');
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

  const followUps = [...(record.followUps || [])]
    .sort((a, b) => new Date(b.fecha) - new Date(a.fecha))
    // A enfermería solo le interesan las consultas QUE RECETARON algo: de las
    // demás vería una tarjeta con la fecha y nada dentro.
    .filter((fu) => !soloReceta || (fu.recetaItems || []).some((it) => !it.isService) || fu.receta);

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Ya no promete que la cita se completa: con varios profesionales, guardar
          cierra TU turno y puede pasarla al siguiente. Decir "completada" hacía
          que el segundo doctor creyera que el primero ya había cerrado todo. */}
      {appointmentId && puedeEscribir && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 text-xs sm:text-sm rounded-xl px-3 py-2">
          Al guardar cierras tu parte de la consulta y vuelves a la agenda.
        </div>
      )}

      {/* Enfermería no redacta la consulta: solo consulta la receta y anota los sueros. */}
      {puedeEscribir && (
      <form
        onSubmit={submit}
        onKeyDown={evitarEnvioConEnter}
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

        {/* I. Diagnósticos con CIE-10 (plegable, como el resto de bloques
            largos: se abre cuando el médico lo necesita). */}
        <div className="md:col-span-3">
          <Collapsible title="Diagnósticos" hint="CIE-10, hasta 6">
            <DiagnosticosEditor
              value={form.diagnosticos}
              onChange={(v) => setForm((f) => ({ ...f, diagnosticos: v }))}
            />
          </Collapsible>
        </div>

        {/* Ficha de la especialidad: va pegada al diagnóstico, antes de recetar. */}
        {isOptica && <OpticaRxTable value={form.opticaRx} onChange={(rx) => setForm((f) => ({ ...f, opticaRx: rx }))} />}
        {isGineco && (
          <GinecologiaSection
            value={form.ginecologia}
            onChange={(g) => setForm((f) => ({ ...f, ginecologia: g }))}
            vitalSigns={form.vitalSigns}
            fecha={form.fecha}
            followUps={followUps}
          />
        )}
        {isPodo && <PodologiaSection value={form.podologia} onChange={(p) => setForm((f) => ({ ...f, podologia: p }))} />}
        {isOdonto && <OdontologiaSection value={form.odontologia} onChange={(o) => setForm((f) => ({ ...f, odontologia: o }))} />}
        {isCosme && <CosmetologiaSection value={form.cosmetologia} onChange={(c) => setForm((f) => ({ ...f, cosmetologia: c }))} />}
        {isCardio && <CardiologiaSection value={form.cardiologia} onChange={(c) => setForm((f) => ({ ...f, cardiologia: c }))} />}

        {/* Orden de la consulta: cómo va el paciente → a dónde se le deriva →
            qué se le receta → el plan narrado que cierra todo. */}
        <Field label="Evolución" className="md:col-span-3">
          <textarea
            rows={2}
            value={form.evolucion}
            onChange={(e) => setForm((f) => ({ ...f, evolucion: e.target.value }))}
            placeholder="Cómo evoluciona el paciente respecto de los controles anteriores"
            className="input resize-none"
          />
        </Field>

        <ItemsTable
          variant="derivacion"
          items={form.derivacionItems}
          onAdd={() => addRow('derivacionItems')}
          onUpdate={(idx, key, val) => updateRow('derivacionItems', idx, key, val)}
          onRemove={(idx) => removeRow('derivacionItems', idx)}
        />

        <ItemsTable
          variant="receta"
          items={form.recetaItems}
          onAdd={() => addRow('recetaItems')}
          onUpdate={(idx, key, val) => updateRow('recetaItems', idx, key, val)}
          onRemove={(idx) => removeRow('recetaItems', idx)}
        />

        {/* J. Plan de tratamiento (narrado; la receta y las derivaciones van arriba) */}
        <Field label="Plan de tratamiento" className="md:col-span-3">
          <textarea
            rows={2}
            value={form.planTratamiento}
            onChange={(e) => setForm((f) => ({ ...f, planTratamiento: e.target.value }))}
            placeholder="Diagnóstico, terapéutico y educacional"
            className="input resize-none"
          />
        </Field>


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
          {/* ÚNICA forma de enviar el seguimiento (ver evitarEnvioConEnter). */}
          <button
            type="submit"
            disabled={saving}
            className="flex items-center gap-1 px-5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-medium disabled:opacity-50 cursor-pointer border-none"
          >
            <HiOutlineCheck className="w-4 h-4" />
            {saving ? 'Guardando…' : appointmentId ? 'Guardar y finalizar' : 'Guardar'}
          </button>
        </div>
      </form>
      )}

      {/* Compras y aplicaciones: avance de tratamientos + historial de compras */}
      {canSeePurchases && (treatmentProgress.length > 0 || purchases.length > 0) && (
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

      {/* El historial NO es una tabla: la columna del medio lleva la consulta
          entera (diagnósticos, receta, signos, adjuntos) y en un teléfono se
          quedaba en un hilo de texto con scroll lateral. En el móvil cada
          seguimiento es una tarjeta y de `md` en adelante recupera sus tres
          columnas de siempre. */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="hidden md:flex bg-slate-50 text-slate-600 text-xs font-semibold uppercase tracking-wider px-4 py-2.5 border-b border-slate-200">
          <span className="w-40 shrink-0">Fecha</span>
          <span className="flex-1">Motivo de consulta</span>
          <span className="w-32 shrink-0 text-right">Acciones</span>
        </div>
        <div className="divide-y divide-slate-100">
          {followUps.length === 0 && (
            <p className="text-center py-6 text-slate-400 text-sm m-0">
              No hay seguimientos.
            </p>
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
              const hasCardioData = cardiologiaHasData(fu.cardiologia);
              const vs = fu.vitalSigns || {};
              const hasVitals = ['hora', 'temperature', 'bloodPressure', 'heartRate', 'respiratoryRate', 'oxygenSaturation', 'weight', 'height', 'abdominalPerimeter', 'capillaryHemoglobin', 'glucose']
                .some((k) => vs[k] != null && vs[k] !== '');
              // Casillas marcadas de la revisión de sistemas y del examen físico.
              const revItems = markedItems(REVISION_SISTEMAS, fu.revisionSistemas);
              const regItems = markedItems(EXAMEN_REGIONAL, fu.examenFisico?.regional);
              const sisItems = markedItems(EXAMEN_SISTEMICO, fu.examenFisico?.sistemico);
              return (
                <article
                  key={fu._id}
                  className="flex flex-col md:flex-row md:items-start gap-2 md:gap-0 p-4 md:p-0 text-sm"
                >
                  <div className="md:w-40 md:shrink-0 md:px-4 md:py-2.5 text-slate-600 whitespace-nowrap font-medium md:font-normal">
                    {fmtDate(fu.fecha)}
                    {fu.createdBy?.name && (
                      <span className="text-[11px] text-emerald-700 font-medium ml-2 md:ml-0 md:mt-0.5 md:block">
                        Dr. {fu.createdBy.name}
                      </span>
                    )}
                  </div>
                  <div className="flex-1 min-w-0 break-words md:px-4 md:py-2.5 text-slate-800">
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
                    {!soloReceta && <div className="font-medium">{fu.descripcion || fu.motivoConsulta}</div>}
                    {!soloReceta && hasOpticaData && <OpticaRxSummary rx={fu.opticaRx} />}
                    {!soloReceta && hasGinecoData && <GinecologiaSummary g={fu.ginecologia} fecha={fu.fecha} />}
                    {!soloReceta && hasPodoData && <PodologiaSummary p={fu.podologia} />}
                    {!soloReceta && hasOdontoData && <OdontologiaSummary o={fu.odontologia} />}
                    {!soloReceta && hasCosmeData && <CosmetologiaSummary c={fu.cosmetologia} />}
                    {!soloReceta && hasCardioData && <CardiologiaSummary value={fu.cardiologia} />}
                    {!soloReceta && fu.enfermedadActual && (
                      <div className="mt-1 text-xs text-slate-600 whitespace-pre-wrap">
                        <b>Enfermedad actual:</b> {fu.enfermedadActual}
                      </div>
                    )}
                    {/* Legacy: seguimientos antiguos que aún tienen el campo. */}
                    {!soloReceta && fu.estudioSintomas && (
                      <div className="mt-1 text-xs text-slate-600">
                        <b>Estudio/síntomas:</b> {fu.estudioSintomas}
                      </div>
                    )}
                    {!soloReceta && (

                      <ChecksSummary
                        title="Revisión de órganos y sistemas"
                        groups={[{ label: '', items: revItems }]}
                        hallazgos={fu.revisionSistemasHallazgos}
                        tone="amber"
                      />

                    )}
                    {!soloReceta && (

                      <ChecksSummary
                        title="Examen físico"
                        groups={[
                          { label: 'Regional', items: regItems },
                          { label: 'Sistémico', items: sisItems },
                        ]}
                        hallazgos={fu.examenFisico?.hallazgos}
                        tone="violet"
                      />

                    )}
                    {!soloReceta && Array.isArray(fu.diagnosticos) && fu.diagnosticos.length > 0 && (
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
                      const renderItem = (it, i) => {
                        // Un suero no es una línea de texto: es una cuenta abierta.
                        // Enfermería va poniendo dosis y aquí se ve cuántas
                        // quedan, que es lo único que hay que mirar para no
                        // pasarse ni dejarlo a medias.
                        if (it.isSerum) {
                          return (
                            <li key={it._id || i}>
                              <SueroLinea
                                item={it}
                                patientId={patientId}
                                followUpId={fu._id}
                                puedeAdministrar={puedeAdministrarSuero}
                                onCambio={setRecord}
                              />
                            </li>
                          );
                        }
                        return (
                          <li key={it._id || i}>
                            <b>{it.name}</b>
                            {it.dose ? ` · ${it.dose}` : ''}
                            {it.frequency ? ` · ${it.frequency}` : ''}
                            {it.duration ? ` · ${it.duration}` : ''}
                            {it.instructions ? ` — ${it.instructions}` : ''}
                            {it.quantity ? ` (x${it.quantity})` : ''}
                          </li>
                        );
                      };
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
                          {!soloReceta && derivOnly.length > 0 && (
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
                    {!soloReceta && hasVitals && (
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
                    {!soloReceta && fu.planTratamiento && (
                      <div className="mt-2 text-xs text-slate-600 whitespace-pre-wrap">
                        <b>Plan de tratamiento:</b> {fu.planTratamiento}
                      </div>
                    )}
                    {!soloReceta && fu.evolucion && (
                      <div className="mt-2 text-xs text-slate-600 whitespace-pre-wrap">
                        <b>Evolución:</b> {fu.evolucion}
                      </div>
                    )}
                    {/* Legacy: seguimientos antiguos que aún tienen el campo. */}
                    {!soloReceta && fu.observaciones && (
                      <div className="mt-2 text-xs text-slate-600 italic">
                        <b>Observaciones:</b> {fu.observaciones}
                      </div>
                    )}
                    {!soloReceta && (
                    <>
                    {/* Adjuntos (PDF o imágenes) */}
                    <div className="mt-2 space-y-1">
                      {(fu.attachments || []).map((att) => (
                        <div key={att._id} className="flex items-center gap-2 text-xs text-slate-600">
                          <span>{String(att.mimeType || '').startsWith('image/') ? '🖼️' : '📎'}</span>
                          {/* Clic en el nombre = VER el archivo, no bajarlo: para
                              mirar una ecografía o un examen no hace falta llenar
                              la carpeta de descargas. La descarga sigue ahí, en su
                              propio botón. */}
                          <button
                            type="button"
                            onClick={() => setPreviewAtt({ fuId: fu._id, att })}
                            title="Ver el archivo"
                            className="underline text-emerald-700 hover:text-emerald-800 bg-transparent border-none cursor-pointer p-0 text-left"
                          >
                            {att.originalName}
                          </button>
                          <span className="text-slate-400">
                            ({Math.round((att.size || 0) / 1024)} KB)
                          </span>
                          <button
                            type="button"
                            onClick={() => setPreviewAtt({ fuId: fu._id, att })}
                            className="text-slate-400 hover:text-emerald-700 bg-transparent border-none cursor-pointer p-0"
                            title="Ver"
                          >
                            <HiOutlineEye className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => downloadAttachment(fu._id, att._id, att.originalName)}
                            className="text-slate-400 hover:text-emerald-700 bg-transparent border-none cursor-pointer p-0"
                            title="Descargar"
                          >
                            <HiOutlineArrowDownTray className="w-3.5 h-3.5" />
                          </button>
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
                    </>
                    )}
                  </div>
                  <div className="md:w-32 md:shrink-0 md:px-4 md:py-2.5 border-t border-slate-100 pt-2 md:border-t-0 md:pt-0">
                    <div className="flex items-center gap-1 md:justify-end">
                      {!soloReceta && (
                      <button
                        onClick={() => downloadFollowUpPdf(fu._id)}
                        title="Descargar PDF"
                        className="p-1 text-slate-500 hover:text-emerald-600 cursor-pointer bg-transparent border-none"
                      >
                        <HiOutlineArrowDownTray className="w-4 h-4" />
                      </button>
                      )}
                      <button
                        onClick={() => printFollowUp(fu._id)}
                        title="Imprimir receta"
                        className="p-1 text-slate-500 hover:text-emerald-600 cursor-pointer bg-transparent border-none"
                      >
                        <HiOutlinePrinter className="w-4 h-4" />
                      </button>
                      {!soloReceta && (
                      <button
                        onClick={() => openMspForm(fu._id)}
                        title="Hoja MSP HCU-form.002"
                        className="px-1.5 py-1 text-[10px] font-bold text-slate-500 hover:text-emerald-600 cursor-pointer bg-transparent border border-slate-200 rounded"
                      >
                        HCU
                      </button>
                      )}
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
                  </div>
                </article>
              );
            })}
        </div>
      </div>


      {previewAtt && (
        <AttachmentPreviewModal
          key={previewAtt.att._id}
          url={`/clinical-records/${patientId}/follow-ups/${previewAtt.fuId}/attachments/${previewAtt.att._id}`}
          filename={previewAtt.att.originalName}
          mimeType={previewAtt.att.mimeType}
          onClose={() => setPreviewAtt(null)}
        />
      )}
      <FichaStyles />
    </div>
  );
}

// ──────────────── Suero: cuenta de aplicaciones ────────────────

/**
 * Una línea de receta marcada como SUERO.
 *
 * El doctor receta 7; enfermería los va poniendo en días distintos. Aquí se ve
 * cuántos van y cuántos faltan, y con un clic se anota el siguiente. La cuenta
 * la lleva el sistema porque llevarla de memoria es como se ponía uno de más o
 * se dejaba de poner el último.
 *
 * El servidor no deja pasar de lo recetado: para más hace falta receta nueva.
 */
function SueroLinea({ item, patientId, followUpId, puedeAdministrar, onCambio }) {
  const [confirmar, setConfirmar] = useState(false);
  const [nota, setNota] = useState('');
  const [busy, setBusy] = useState(false);

  const recetados = Math.max(0, Number(item.quantity) || 0);
  const puestos = (item.administrations || []).length;
  const faltan = Math.max(0, recetados - puestos);
  const completo = recetados > 0 && faltan === 0;

  const registrar = async () => {
    setBusy(true);
    try {
      const { data } = await api.post(
        `/clinical-records/${patientId}/follow-ups/${followUpId}/receta/${item._id}/administer`,
        { note: nota.trim() }
      );
      onCambio(data);
      toast.success(
        faltan - 1 > 0
          ? `Suero administrado. Faltan ${faltan - 1}.`
          : 'Suero administrado. Ya no queda ninguno.'
      );
      setConfirmar(false);
      setNota('');
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo registrar');
    } finally {
      setBusy(false);
    }
  };

  const deshacer = async () => {
    if (!window.confirm('¿Deshacer la última aplicación registrada?')) return;
    try {
      const { data } = await api.delete(
        `/clinical-records/${patientId}/follow-ups/${followUpId}/receta/${item._id}/administer`
      );
      onCambio(data);
      toast.success('Aplicación deshecha');
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo deshacer');
    }
  };

  const ultima = (item.administrations || [])[puestos - 1];

  return (
    <div className="my-1 rounded-lg border border-sky-200 bg-sky-50/70 px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-[10px] font-bold uppercase tracking-wide text-sky-700 bg-sky-100 rounded px-1.5 py-0.5">
          Suero
        </span>
        <b className="text-slate-800">{item.name}</b>
        {item.dose && <span className="text-slate-600">· {item.dose}</span>}
        {item.instructions && <span className="text-slate-600">— {item.instructions}</span>}
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <span className={`text-xs font-semibold ${completo ? 'text-emerald-700' : 'text-sky-800'}`}>
          {puestos} de {recetados || '—'} administrados
          {recetados > 0 && (completo ? ' · completo' : ` · faltan ${faltan}`)}
        </span>

        {/* Barra: de un vistazo se ve si va por la mitad o casi termina. */}
        {recetados > 0 && (
          <span className="h-1.5 w-24 rounded-full bg-sky-200 overflow-hidden">
            <span
              className={`block h-full ${completo ? 'bg-emerald-500' : 'bg-sky-500'}`}
              style={{ width: `${Math.min(100, (puestos / recetados) * 100)}%` }}
            />
          </span>
        )}

        {puedeAdministrar && !completo && (
          <button
            type="button"
            onClick={() => setConfirmar(true)}
            className="text-xs font-medium px-2.5 py-1 rounded-lg bg-sky-600 text-white border-none cursor-pointer hover:bg-sky-700"
          >
            Administrar
          </button>
        )}
        {puedeAdministrar && puestos > 0 && (
          <button
            type="button"
            onClick={deshacer}
            className="text-xs text-slate-500 hover:text-red-600 bg-transparent border-none cursor-pointer p-0 underline"
          >
            Deshacer la última
          </button>
        )}
      </div>

      {ultima && (
        <p className="mt-1 text-[11px] text-slate-500 m-0">
          Última: {fmtDateTime(ultima.at)}
          {ultima.byName ? ` · ${ultima.byName}` : ''}
          {ultima.note ? ` · ${ultima.note}` : ''}
        </p>
      )}

      <Modal
        isOpen={confirmar}
        onClose={() => setConfirmar(false)}
        title="Administrar suero"
        size="sm"
      >
        <div className="space-y-3">
          <p className="text-sm text-slate-700 m-0">
            ¿Confirmas que se le administró <b>{item.name}</b> al paciente?
          </p>
          <p className="text-xs text-slate-500 m-0">
            Van {puestos} de {recetados}. Con este quedarían {Math.max(0, faltan - 1)} por poner.
          </p>
          <label className="block text-sm">
            Nota <span className="text-slate-400 font-normal">(opcional)</span>
            <input
              type="text"
              value={nota}
              onChange={(e) => setNota(e.target.value)}
              placeholder="Reacción, vía, observación…"
              className="block w-full mt-1 border border-slate-200 rounded-xl px-3 py-2 text-sm"
            />
          </label>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirmar(false)}
              className="px-4 py-2 rounded-lg border border-slate-200 bg-white text-sm text-slate-600 cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={registrar}
              disabled={busy}
              className="px-4 py-2 rounded-lg bg-sky-600 text-white text-sm font-medium border-none cursor-pointer disabled:opacity-50"
            >
              {busy ? 'Registrando…' : 'Sí, se administró'}
            </button>
          </div>
        </div>
      </Modal>
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
    (g.pesoPreconcepcional != null && g.pesoPreconcepcional !== '') ||
    g.pap?.tipo ||
    ['gestas', 'partos', 'abortos', 'cesareas'].some((k) => gpac[k] != null && gpac[k] !== '') ||
    ['hormonal', 'barrera', 'diu', 'otro'].some((k) => met[k]) ||
    met.otroDetalle ||
    ['exocervical', 'endocervical', 'otros'].some((k) => toma[k]) ||
    toma.otrosDetalle ||
    ['signosVitalesScore', 'bebePosicion', 'actividadCardiaca'].some((k) => cp[k]) ||
    scoreMamaTieneDatos(cp.scoreMama)
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

/**
 * SCORE MAMÁ (MSP) — tabla del control prenatal.
 *
 * Una fila por parámetro: se escribe el valor y el sistema pone el puntaje al
 * lado y el total abajo, con semáforo. Sustituye al antiguo campo de texto
 * "Signos vitales / score", donde el puntaje se calculaba a mano y no quedaba
 * constancia de con qué números se había calculado.
 *
 * Los valores que el seguimiento YA tomó arriba (FC, TA, FR, T°, SatO₂) vienen
 * puestos: se pueden pisar, pero no hay que teclearlos dos veces.
 */
function ScoreMamaTabla({ value, vitalSigns, onChange }) {
  const sm = mezclarScoreMama(value, vitalSigns);
  const { puntajes, total } = calcularScoreMama(sm);
  const derivado = scoreMamaDesdeSignos(vitalSigns);
  const tono = scoreMamaTono(total);

  // Al tocar cualquier celda se sube el objeto COMPLETO (con lo derivado de los
  // signos vitales ya incorporado): así lo que se guarda es exactamente lo que
  // se está viendo, sin depender de en qué orden se rellenó.
  const set = (key, val) => onChange({ ...sm, [key]: val });

  const TONOS = {
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-700',
    amber: 'bg-amber-50 border-amber-200 text-amber-700',
    red: 'bg-red-50 border-red-300 text-red-700',
    slate: 'bg-slate-50 border-slate-200 text-slate-500',
  };
  const AVISOS = {
    emerald: 'Puntaje 0 · control normal',
    amber: 'Puntaje 1-5 · vigilancia y valoración',
    red: 'Puntaje 6 o más · active la clave obstétrica',
    slate: 'Sin parámetros consignados',
  };

  const celdaPuntaje = (p) => (
    <td className="px-2 py-1 text-center font-semibold">
      {p == null ? <span className="text-slate-300">—</span> : (
        <span className={p === 0 ? 'text-emerald-600' : p >= 3 ? 'text-red-600' : 'text-amber-600'}>{p}</span>
      )}
    </td>
  );

  return (
    <div className="rounded-lg border border-rose-200 bg-white overflow-hidden">
      <div className="px-3 py-2 bg-rose-50 border-b border-rose-200">
        <span className="text-xs font-bold text-rose-700 uppercase tracking-wide">Score MAMÁ</span>
        <span className="ml-2 text-[11px] text-rose-500">MSP · muerte materna</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-100 text-slate-500">
            <tr>
              <th className="text-left px-2 py-1 font-semibold">Parámetro</th>
              <th className="text-left px-2 py-1 font-semibold w-32">Valor</th>
              <th className="px-2 py-1 font-semibold w-20">Puntaje</th>
            </tr>
          </thead>
          <tbody>
            {SCORE_MAMA_PARAMETROS.map((p) => (
              <tr key={p.key} className="border-t border-slate-100">
                <td className="px-2 py-1 text-slate-700">
                  {p.label}
                  <span className="text-slate-400 ml-1">({p.unidad})</span>
                  {/* Se avisa cuándo el número no lo escribió ella aquí. */}
                  {derivado[p.key] != null && sm[p.key] === derivado[p.key] && (
                    <span className="ml-1 text-[10px] text-slate-400">· de signos vitales</span>
                  )}
                </td>
                <td className="px-2 py-1">
                  <NumericInput
                    value={sm[p.key] ?? ''}
                    onChange={(e) => set(p.key, e.target.value === '' ? null : Number(e.target.value))}
                    className="input text-xs py-1"
                  />
                </td>
                {celdaPuntaje(puntajes[p.key])}
              </tr>
            ))}
            <tr className="border-t border-slate-100">
              <td className="px-2 py-1 text-slate-700">Estado de conciencia</td>
              <td className="px-2 py-1">
                <select
                  value={sm.conciencia || ''}
                  onChange={(e) => set('conciencia', e.target.value)}
                  className="input text-xs py-1"
                >
                  <option value="">— Sin dato —</option>
                  {SCORE_MAMA_CONCIENCIA.map((o) => (
                    <option key={o.key} value={o.key}>{o.label}</option>
                  ))}
                </select>
              </td>
              {celdaPuntaje(puntajes.conciencia)}
            </tr>
            <tr className="border-t border-slate-100">
              <td className="px-2 py-1 text-slate-700">Proteinuria</td>
              <td className="px-2 py-1">
                <select
                  value={sm.proteinuria || ''}
                  onChange={(e) => set('proteinuria', e.target.value)}
                  className="input text-xs py-1"
                >
                  <option value="">— Sin dato —</option>
                  {SCORE_MAMA_PROTEINURIA.map((o) => (
                    <option key={o.key} value={o.key}>{o.label}</option>
                  ))}
                </select>
              </td>
              {celdaPuntaje(puntajes.proteinuria)}
            </tr>
          </tbody>
        </table>
      </div>
      <div className={`flex items-center justify-between gap-2 px-3 py-2 border-t ${TONOS[tono]}`}>
        <span className="text-[11px] font-medium">{AVISOS[tono]}</span>
        <span className="text-sm font-bold whitespace-nowrap">
          Total: {total == null ? '—' : total}
        </span>
      </div>
    </div>
  );
}

function GinecologiaSection({ value, onChange, vitalSigns, fecha, followUps = [] }) {
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

  const [verCurva, setVerCurva] = useState(false);

  // Las semanas se cuentan hasta la FECHA DEL CONTROL, no hasta hoy: así un
  // seguimiento con fecha atrasada sigue mostrando la edad que tocaba ese día.
  const embarazada = g.embarazoActual === true;
  const eg = embarazada && g.fum ? edadGestacional(g.fum, fecha) : null;
  const fpp = embarazada && g.fum ? fechaProbableParto(g.fum) : '';
  const talla = vitalSigns?.height;
  const peso = vitalSigns?.weight;
  const faltaParaCurva = !g.fum
    ? 'Registre la FUM para ubicar el control en la curva'
    : !(Number(peso) > 0)
      ? 'Registre el peso en signos vitales'
      : !(Number(talla) > 0)
        ? 'Registre la talla en signos vitales'
        : '';

  return (
    <div className="md:col-span-3">
      <Collapsible
        title="Ginecología / Obstetricia"
        hint={eg && !eg.problema ? `embarazo de ${eg.texto}` : 'FUM, antecedentes, PAP y control prenatal'}
      >
        <div className="space-y-4">
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

          {/* Embarazo en curso: edad gestacional, peso previo y curva de peso */}
          {embarazada && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 space-y-3">
              {!g.fum && (
                <p className="text-xs text-slate-600">
                  Ingrese la FUM para calcular las semanas de embarazo.
                </p>
              )}
              {eg?.problema === 'futura' && (
                <p className="text-xs text-amber-700">
                  La FUM es posterior a la fecha de este control: revise el dato.
                </p>
              )}
              {eg?.problema === 'lejana' && (
                <p className="text-xs text-amber-700">
                  Han pasado más de 45 semanas desde la FUM ({eg.texto}): probablemente quedó de un embarazo anterior.
                </p>
              )}
              {eg && !eg.problema && (
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <span className="text-sm font-semibold text-rose-700">
                    {eg.texto} de gestación
                  </span>
                  <span className="text-xs text-slate-600">{eg.dias} días</span>
                  {fpp && <span className="text-xs text-slate-600">Fecha probable de parto: {fmtDate(fpp)}</span>}
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-end">
                <Field label="Peso preconcepcional (kg)">
                  <NumericInput
                    step="0.1"
                    min={0}
                    value={g.pesoPreconcepcional ?? ''}
                    onChange={(e) => onChange({ ...g, pesoPreconcepcional: e.target.value })}
                    placeholder="Peso antes del embarazo"
                    className="input"
                  />
                </Field>
                <div>
                  <button
                    type="button"
                    onClick={() => setVerCurva(true)}
                    disabled={!!faltaParaCurva}
                    title={faltaParaCurva || 'Curva de IMC por semanas de gestación'}
                    className={`w-full px-3 py-2 rounded-lg text-xs font-semibold border ${
                      faltaParaCurva
                        ? 'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed'
                        : 'bg-rose-600 text-white border-rose-600 cursor-pointer hover:bg-rose-700'
                    }`}
                  >
                    Ver curva de aumento de peso
                  </button>
                  {faltaParaCurva && <p className="text-[11px] text-slate-500 mt-1">{faltaParaCurva}.</p>}
                </div>
              </div>
            </div>
          )}

          {/* G P A C */}
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Antecedentes obstétricos (G · P · A · C)</label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
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
            <ScoreMamaTabla
              value={cp.scoreMama}
              vitalSigns={vitalSigns}
              onChange={(sm) => setCp('scoreMama', sm)}
            />
            {/* Fichas anteriores al Score MAMÁ: si tenían texto, se sigue viendo. */}
            {cp.signosVitalesScore ? (
              <p className="text-[11px] text-slate-500 mt-1">
                Registro anterior: {cp.signosVitalesScore}
              </p>
            ) : null}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-2">
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
      </Collapsible>

      {/* Fuera del Collapsible: plegar la ficha no debe cerrar la gráfica. */}
      {verCurva && (
        <Suspense fallback={null}>
          <CurvaPesoGestacional
            isOpen
            onClose={() => setVerCurva(false)}
            fum={g.fum}
            pesoPreconcepcional={g.pesoPreconcepcional}
            talla={talla}
            pesoActual={peso}
            fechaActual={fecha}
            followUps={followUps}
          />
        </Suspense>
      )}
    </div>
  );
}

function GinecologiaSummary({ g, fecha }) {
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
  // Las semanas que tenía el día del control, no las de hoy.
  const eg = g.embarazoActual === true && g.fum ? edadGestacional(g.fum, fecha) : null;
  return (
    <div className="mt-2 text-[11px] text-slate-600 bg-rose-50 border border-rose-100 rounded p-2 flex flex-wrap gap-x-3 gap-y-0.5">
      <span className="font-semibold text-rose-600 uppercase w-full">Ginecología</span>
      {g.fum && <span>FUM: {fmtDate(g.fum)}</span>}
      {hasGpac && <span>G/P/A/C: {gpacStr}</span>}
      {g.embarazoActual != null && <span>Embarazo actual: {g.embarazoActual ? 'Sí' : 'No'}</span>}
      {eg && !eg.problema && <span className="font-semibold text-rose-700">{eg.texto} de gestación</span>}
      {g.pesoPreconcepcional != null && g.pesoPreconcepcional !== '' && (
        <span>Peso preconcepcional: {g.pesoPreconcepcional}kg</span>
      )}
      {metodos.length > 0 && <span>Anticoncepción: {metodos.join(', ')}</span>}
      {papTipo && <span>{papTipo}</span>}
      {tomas.length > 0 && <span>Toma PAP: {tomas.join(', ')}</span>}
      {cp.scoreMama?.total != null && (
        <span className={'font-semibold ' + (cp.scoreMama.total >= 6 ? 'text-red-700' : cp.scoreMama.total >= 1 ? 'text-amber-700' : 'text-emerald-700')}>
          Score MAMÁ: {cp.scoreMama.total}
        </span>
      )}
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
  rose: 'bg-rose-600 text-white border-rose-600',
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
  rose: { box: 'bg-rose-50 border-rose-100', label: 'text-rose-600' },
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

// ──────────────── Cardiología (rol cardiologia) ────────────────
//
// La hoja del cardiólogo pide varias cosas que el seguimiento YA captura: el
// motivo de consulta, la enfermedad actual, los signos vitales (PA, FC, SatO₂,
// peso, talla, IMC), la impresión diagnóstica con CIE-10 y el plan narrado.
// Aquí abajo va SOLO lo que falta, para no pedir dos veces lo mismo y que los
// dos registros acaben distintos.

function cardiologiaHasData(c) {
  // Los antecedentes son de tres estados: "consta que NO es hipertenso" es un
  // hallazgo, y `hasContent` descarta los `false`. Por eso se miran aparte.
  return hasContent(c) || (c?.antecedentes || []).some((a) => typeof a?.value === 'boolean');
}

/** Valor Sí/No/sin dato de un antecedente dentro del arreglo. */
const antecedenteValor = (lista, key) => {
  const a = (lista || []).find((x) => x.key === key);
  return typeof a?.value === 'boolean' ? a.value : null;
};

function CardiologiaSection({ value, onChange }) {
  const c = value || {};
  const ecg = c.electrocardiograma || {};
  const est = c.estudios || {};
  const plan = c.plan || {};
  const set = (k, v) => onChange({ ...c, [k]: v });
  const setEcg = (k, v) => onChange({ ...c, electrocardiograma: { ...ecg, [k]: v } });
  const setEst = (k, v) => onChange({ ...c, estudios: { ...est, [k]: v } });
  const setPlan = (k, v) => onChange({ ...c, plan: { ...plan, [k]: v } });

  // Al pulsar el mismo valor se quita: se vuelve a "sin consignar".
  const setAntecedente = (key, val) => {
    const otros = (c.antecedentes || []).filter((a) => a.key !== key);
    const actual = antecedenteValor(c.antecedentes, key);
    const nuevos = actual === val ? otros : [...otros, { key, value: val }];
    onChange({ ...c, antecedentes: nuevos });
  };

  return (
    <div className="md:col-span-3 space-y-3">
      <label className="text-sm font-medium text-slate-700 block">Ficha cardiológica</label>

      <Collapsible title="Antecedentes relevantes" hint="HTA, DM, dislipidemia, arritmias…" defaultOpen>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          {CARDIOLOGIA_ANTECEDENTES.map((a) => {
            const v = antecedenteValor(c.antecedentes, a.key);
            return (
              <div key={a.key} className="flex items-center justify-between gap-2 bg-slate-50 rounded-lg px-2 py-1.5">
                <span className="text-xs text-slate-700">{a.label}</span>
                <div className="flex gap-1 shrink-0">
                  <SChip tone="rose" active={v === true} onClick={() => setAntecedente(a.key, true)}>Sí</SChip>
                  <SChip tone="rose" active={v === false} onClick={() => setAntecedente(a.key, false)}>No</SChip>
                </div>
              </div>
            );
          })}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-3">
          <Field label="Otros antecedentes">
            <input
              type="text"
              value={c.antecedentesOtros || ''}
              onChange={(e) => set('antecedentesOtros', e.target.value)}
              className="input"
            />
          </Field>
          <Field label="Alergias">
            <input
              type="text"
              value={c.alergias || ''}
              onChange={(e) => set('alergias', e.target.value)}
              className="input"
            />
          </Field>
        </div>
      </Collapsible>

      <Collapsible title="Medicación actual" hint="lo que toma hoy el paciente">
        <textarea
          rows={2}
          value={c.medicacionActual || ''}
          onChange={(e) => set('medicacionActual', e.target.value)}
          placeholder="Fármaco, dosis y frecuencia"
          className="input resize-none"
        />
      </Collapsible>

      <Collapsible title="Electrocardiograma" hint="ritmo, frecuencia y conclusión" defaultOpen>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <Field label="Ritmo" className="md:col-span-2">
            {/* Lista abierta: se elige uno de los habituales o se escribe otro. */}
            <input
              type="text"
              list="cardio-ritmos"
              value={ecg.ritmo || ''}
              onChange={(e) => setEcg('ritmo', e.target.value)}
              placeholder="Sinusal…"
              className="input"
            />
            <datalist id="cardio-ritmos">
              {CARDIOLOGIA_RITMOS.map((r) => <option key={r} value={r} />)}
            </datalist>
          </Field>
          <Field label="FC (lpm)">
            <NumericInput
              value={ecg.fc ?? ''}
              onChange={(e) => setEcg('fc', e.target.value === '' ? null : Number(e.target.value))}
              className="input"
            />
          </Field>
          <Field label="Hallazgos / conclusión" className="md:col-span-3">
            <textarea
              rows={2}
              value={ecg.hallazgos || ''}
              onChange={(e) => setEcg('hallazgos', e.target.value)}
              className="input resize-none"
            />
          </Field>
        </div>
      </Collapsible>

      <Collapsible title="Estudios relevantes" hint="ecocardiograma, Holter, MAPA, ergometría, laboratorio">
        <div className="space-y-2">
          {CARDIOLOGIA_ESTUDIOS.map((e) => (
            <Field key={e.key} label={e.label}>
              <input
                type="text"
                value={est[e.key] || ''}
                onChange={(e2) => setEst(e.key, e2.target.value)}
                placeholder="Resultado o conclusión"
                className="input"
              />
            </Field>
          ))}
        </div>
      </Collapsible>

      <Collapsible title="Plan cardiológico" hint="estudios solicitados y próximo control">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <Field label="Estudios solicitados">
            <input
              type="text"
              value={plan.estudiosSolicitados || ''}
              onChange={(e) => setPlan('estudiosSolicitados', e.target.value)}
              className="input"
            />
          </Field>
          <Field label="Próximo control">
            <input
              type="text"
              value={plan.proximoControl || ''}
              onChange={(e) => setPlan('proximoControl', e.target.value)}
              placeholder="En 3 meses, con ecocardiograma…"
              className="input"
            />
          </Field>
        </div>
      </Collapsible>
    </div>
  );
}

function CardiologiaSummary({ value }) {
  const c = value || {};
  if (!cardiologiaHasData(c)) return null;
  const ecg = c.electrocardiograma || {};
  const est = c.estudios || {};
  const plan = c.plan || {};
  const positivos = CARDIOLOGIA_ANTECEDENTES
    .filter((a) => antecedenteValor(c.antecedentes, a.key) === true)
    .map((a) => a.label);
  const negativos = CARDIOLOGIA_ANTECEDENTES
    .filter((a) => antecedenteValor(c.antecedentes, a.key) === false)
    .map((a) => a.label);
  const estudios = CARDIOLOGIA_ESTUDIOS.filter((e) => est[e.key]).map((e) => `${e.label}: ${est[e.key]}`);
  return (
    <SpecialtySummary title="Cardiología" tone="rose">
      {positivos.length > 0 && <span><b>Antecedentes:</b> {positivos.join(', ')}</span>}
      {negativos.length > 0 && <span className="text-slate-400">Niega: {negativos.join(', ')}</span>}
      {c.antecedentesOtros && <span>Otros: {c.antecedentesOtros}</span>}
      {c.alergias && <span>Alergias: {c.alergias}</span>}
      {c.medicacionActual && <span className="w-full whitespace-pre-wrap">Medicación: {c.medicacionActual}</span>}
      {(ecg.ritmo || ecg.fc != null || ecg.hallazgos) && (
        <span className="w-full">
          <b>ECG:</b> {[ecg.ritmo, ecg.fc != null ? `${ecg.fc} lpm` : '', ecg.hallazgos].filter(Boolean).join(' · ')}
        </span>
      )}
      {estudios.length > 0 && <span className="w-full">{estudios.join(' · ')}</span>}
      {plan.estudiosSolicitados && <span>Solicita: {plan.estudiosSolicitados}</span>}
      {plan.proximoControl && <span>Próximo control: {plan.proximoControl}</span>}
    </SpecialtySummary>
  );
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

// La marca guardada puede traer el color elegido ('caries:azul'), así que la
// etiqueta la arma el catálogo: un find por clave devolvería vacío.
const estadoLabel = (valor) => labelOdonto(valor);

function OdontologiaSection({ value, onChange }) {
  const o = value || {};
  return (
    // `md:col-span-3` como el resto de fichas de especialidad (óptica, gineco,
    // podología, cosmetología): el formulario del seguimiento es una rejilla de
    // tres columnas y sin esto el odontograma se quedaba metido en una sola,
    // con el esquema dental apretado en un tercio del ancho.
    <div className="md:col-span-3 space-y-3">
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

      <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto">
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

// ─────────────────── Observaciones ───────────────────
//
// Bitácora libre del paciente: cualquiera del equipo anota lo que haga falta y
// adjunta archivos. La más reciente aparece primero, con su fecha y su autor.
//
// Quién puede corregir una nota: SOLO quien la escribió… y el administrador. Que
// el admin pueda no significa que se disimule: la tarjeta muestra siempre "Creado
// por" y, en cuanto alguien la toca, "Modificado por".
function ObservacionesTab({ patientId }) {
  const { user, hasRole } = useAuth();
  const isAdmin = hasRole('admin');
  const meId = user?.id || user?._id; // /auth/me devuelve los dos

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [pendingFiles, setPendingFiles] = useState([]);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);   // observación con una acción en curso
  const [editing, setEditing] = useState(null); // { id, text }
  const newFileRef = useRef(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get(`/patients/${patientId}/observations`);
      setRows(Array.isArray(r.data) ? r.data : []);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al cargar las observaciones');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId]);

  const canEdit = (obs) =>
    isAdmin || String(obs.createdBy?._id || obs.createdBy) === String(meId);

  /** Reemplaza una observación en la lista sin recargarlas todas. */
  const replaceRow = (obs) => setRows((prev) => prev.map((o) => (o._id === obs._id ? obs : o)));

  const addFiles = (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    if (files.length + pendingFiles.length > OBSERVATION_MAX_FILES) {
      toast.error(`Puedes adjuntar hasta ${OBSERVATION_MAX_FILES} archivos por observación`);
    }
    setPendingFiles((prev) => [...prev, ...files].slice(0, OBSERVATION_MAX_FILES));
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!text.trim() && pendingFiles.length === 0) {
      toast.error('Escribe una observación o adjunta un archivo');
      return;
    }
    setSaving(true);
    try {
      // Un archivo por petición: diez de 20 MB juntos se pasan del
      // `client_max_body_size` de nginx y el 413 llega sin explicación.
      const fd = new FormData();
      fd.append('text', text.trim());
      if (pendingFiles[0]) fd.append('files', pendingFiles[0]);
      const r = await api.post(`/patients/${patientId}/observations`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      let saved = r.data;
      for (const file of pendingFiles.slice(1)) {
        const one = new FormData();
        one.append('files', file);
        // eslint-disable-next-line no-await-in-loop
        const extra = await api.post(
          `/patients/${patientId}/observations/${saved._id}/attachments`,
          one,
          { headers: { 'Content-Type': 'multipart/form-data' } }
        );
        saved = extra.data;
      }
      setRows((prev) => [saved, ...prev]); // la más nueva, arriba
      setText('');
      setPendingFiles([]);
      toast.success('Observación agregada');
    } catch (err) {
      toast.error(observationUploadError(err, 'No se pudo guardar la observación'));
    } finally {
      setSaving(false);
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    setBusyId(editing.id);
    try {
      const r = await api.put(`/patients/${patientId}/observations/${editing.id}`, {
        text: editing.text.trim(),
      });
      replaceRow(r.data);
      setEditing(null);
      toast.success('Observación modificada');
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo modificar');
    } finally {
      setBusyId(null);
    }
  };

  const removeObservation = async (obs) => {
    if (!confirm('¿Eliminar esta observación y sus archivos?')) return;
    setBusyId(obs._id);
    try {
      await api.delete(`/patients/${patientId}/observations/${obs._id}`);
      setRows((prev) => prev.filter((o) => o._id !== obs._id));
      toast.success('Observación eliminada');
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo eliminar');
    } finally {
      setBusyId(null);
    }
  };

  const uploadTo = async (obs, fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setBusyId(obs._id);
    try {
      let saved = obs;
      for (const file of files.slice(0, OBSERVATION_MAX_FILES)) {
        const fd = new FormData();
        fd.append('files', file);
        // eslint-disable-next-line no-await-in-loop
        const r = await api.post(
          `/patients/${patientId}/observations/${obs._id}/attachments`,
          fd,
          { headers: { 'Content-Type': 'multipart/form-data' } }
        );
        saved = r.data;
      }
      replaceRow(saved);
      toast.success(files.length > 1 ? 'Archivos adjuntados' : 'Archivo adjuntado');
    } catch (err) {
      toast.error(observationUploadError(err, 'No se pudo adjuntar'));
    } finally {
      setBusyId(null);
    }
  };

  const downloadAttachment = async (obs, att) => {
    try {
      await downloadFile(
        `/patients/${patientId}/observations/${obs._id}/attachments/${att._id}`,
        { filename: att.originalName || 'archivo' }
      );
    } catch (err) {
      toast.error(err.message || 'Error al descargar');
    }
  };

  const removeAttachment = async (obs, att) => {
    if (!confirm(`¿Eliminar "${att.originalName}"?`)) return;
    setBusyId(obs._id);
    try {
      const r = await api.delete(
        `/patients/${patientId}/observations/${obs._id}/attachments/${att._id}`
      );
      replaceRow(r.data);
      toast.success('Archivo eliminado');
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo eliminar el archivo');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Nueva observación */}
      <form onSubmit={submit} className="bg-slate-50 rounded-xl border border-slate-200 p-4 space-y-3">
        <textarea
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Escribe una observación sobre el paciente…"
          className="input resize-y"
        />
        <input
          ref={newFileRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = '';
          }}
        />
        {pendingFiles.length > 0 && (
          <ul className="space-y-1">
            {pendingFiles.map((f, i) => (
              <li key={`${f.name}-${i}`} className="text-xs text-slate-600 flex items-center gap-2">
                <HiOutlinePaperClip className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                <span className="truncate">{f.name}</span>
                <span className="text-slate-400 shrink-0">({observationFileSize(f.size)})</span>
                <button
                  type="button"
                  title="Quitar"
                  onClick={() => setPendingFiles((prev) => prev.filter((_, idx) => idx !== i))}
                  className="text-slate-400 hover:text-red-600 bg-transparent border-none cursor-pointer p-0"
                >
                  <HiOutlineXMark className="w-3.5 h-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => newFileRef.current?.click()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-dashed border-slate-300 bg-white hover:bg-emerald-50 hover:border-emerald-400 text-xs text-slate-600 hover:text-emerald-700 cursor-pointer transition-colors"
          >
            <HiOutlinePaperClip className="w-4 h-4" /> Adjuntar archivos
          </button>
          <button
            type="submit"
            disabled={saving}
            className="flex items-center gap-1 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-medium disabled:opacity-50 cursor-pointer border-none"
          >
            <HiOutlinePlus className="w-4 h-4" /> {saving ? 'Guardando…' : 'Agregar observación'}
          </button>
        </div>
      </form>

      {/* Historial: la última que se escribió, primera */}
      {loading ? (
        <div className="text-sm text-slate-400">Cargando…</div>
      ) : rows.length === 0 ? (
        <div className="text-center py-10">
          <HiOutlineChatBubbleLeftRight className="w-10 h-10 text-slate-300 mx-auto" />
          <p className="text-sm text-slate-500 mt-2">Todavía no hay observaciones.</p>
          <p className="text-xs text-slate-400">La primera que escribas aparecerá aquí.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((obs) => {
            const mine = canEdit(obs);
            const busy = busyId === obs._id;
            const isEditing = editing?.id === obs._id;
            return (
              <div key={obs._id} className="border border-slate-200 rounded-xl p-4 space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="text-xs text-slate-500">
                    <div className="font-semibold text-slate-700">
                      Creado por {obs.createdBy?.name || 'usuario eliminado'}
                    </div>
                    <div>{fmtDateTime(obs.createdAt)}</div>
                    {obs.updatedBy && (
                      <div className="text-amber-700">
                        Modificado por {obs.updatedBy.name || 'otro usuario'} ·{' '}
                        {fmtDateTime(obs.editedAt || obs.updatedAt)}
                      </div>
                    )}
                  </div>
                  {mine && !isEditing && (
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        title="Modificar"
                        disabled={busy}
                        onClick={() => setEditing({ id: obs._id, text: obs.text || '' })}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 bg-transparent border-none cursor-pointer disabled:opacity-50"
                      >
                        <HiOutlinePencilSquare className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        title="Eliminar"
                        disabled={busy}
                        onClick={() => removeObservation(obs)}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 bg-transparent border-none cursor-pointer disabled:opacity-50"
                      >
                        <HiOutlineTrash className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                </div>

                {isEditing ? (
                  <div className="space-y-2">
                    <textarea
                      rows={3}
                      value={editing.text}
                      onChange={(e) => setEditing((s) => ({ ...s, text: e.target.value }))}
                      className="input resize-y"
                    />
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setEditing(null)}
                        className="px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-xs text-slate-600 hover:bg-slate-50 cursor-pointer"
                      >
                        Cancelar
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={saveEdit}
                        className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium border-none cursor-pointer disabled:opacity-50"
                      >
                        Guardar cambios
                      </button>
                    </div>
                  </div>
                ) : (
                  obs.text && (
                    <p className="text-sm text-slate-700 whitespace-pre-wrap break-words">{obs.text}</p>
                  )
                )}

                {(obs.attachments || []).length > 0 && (
                  <div className="space-y-1 pt-1">
                    {obs.attachments.map((att) => (
                      <div key={att._id} className="flex items-center gap-2 text-xs text-slate-600">
                        <span>{String(att.mimeType || '').startsWith('image/') ? '🖼️' : '📎'}</span>
                        <button
                          type="button"
                          onClick={() => downloadAttachment(obs, att)}
                          className="underline text-emerald-700 hover:text-emerald-800 bg-transparent border-none cursor-pointer p-0 truncate"
                        >
                          {att.originalName}
                        </button>
                        <span className="text-slate-400 shrink-0">({observationFileSize(att.size)})</span>
                        {mine && (
                          <button
                            type="button"
                            title="Eliminar archivo"
                            disabled={busy}
                            onClick={() => removeAttachment(obs, att)}
                            className="text-slate-400 hover:text-red-600 bg-transparent border-none cursor-pointer p-0 disabled:opacity-50"
                          >
                            <HiOutlineTrash className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {mine && (
                  <label className="inline-flex items-center gap-1 text-xs text-emerald-700 cursor-pointer">
                    <HiOutlinePlus className="w-3.5 h-3.5" />
                    {busy ? 'Trabajando…' : 'Adjuntar archivos'}
                    <input
                      type="file"
                      multiple
                      className="hidden"
                      disabled={busy}
                      onChange={(e) => {
                        const files = e.target.files;
                        e.target.value = '';
                        uploadTo(obs, files);
                      }}
                    />
                  </label>
                )}
              </div>
            );
          })}
        </div>
      )}
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
    <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto">
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
