import { useEffect, useState, useMemo, memo, Fragment, useRef, lazy, Suspense } from 'react';
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
import CincoElementos from '../components/CincoElementos';
import { ROLES_VEN_CEDULA, ROLES_VEN_CORREO, ROLES_VEN_DIRECCION, ROLES_VEN_TELEFONO } from '../utils/roles';
import {
  ANTECEDENTES_CATEGORIAS,
  HABITOS_CATEGORIAS,
  REVISION_SISTEMAS,
  EXAMEN_REGIONAL,
  EXAMEN_SISTEMICO,
  calcIMC,
} from '../constants/mspCatalogs';
import {
  SUERO_CLORURO_NOMBRE,
  SUERO_CLORURO_VOLUMENES,
  SUERO_GRUPO_LABEL,
  buscarComponenteSuero,
} from '../constants/sueroterapia';
import SelectorComponentesSuero from '../components/SelectorComponentesSuero';
import SuggestInput from '../components/SuggestInput';
import {
  CARDIOLOGIA_ANTECEDENTES,
  CARDIOLOGIA_ESTUDIOS,
  CARDIOLOGIA_RITMOS,
  TERAPIA_FODA,
  TERAPIA_FODA_KEYS,
  TERAPIA_HABITOS_FILAS,
  TERAPIA_HABITOS_NIVELES,
  recetaEtiquetas,
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
  HiOutlineCheckCircle,
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
  HiOutlineSparkles,
} from 'react-icons/hi2';
import DateInput from '../components/DateInput';
import AttachmentPreviewModal from '../components/AttachmentPreviewModal';
import Modal from '../components/Modal';
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
  /**
   * TERAPIAS COMPLEMENTARIAS: solo para el terapeuta (y la administración, que
   * ve todo lo suyo). Va pegada a Seguimientos porque es la otra mitad de su
   * consulta. Está VACÍA a propósito: la pestaña se abrió primero y el
   * contenido lo define la clínica — ver `TerapiasComplementariasTab`.
   */
  { id: 'terapias', label: 'Terapias complementarias', icon: HiOutlineSparkles },
  /**
   * ARCHIVOS: estudios que se resuelven subiendo el archivo.
   *
   * Hay médicos que no hacen seguimiento ni recetan: hacen la ecografía, suben
   * la imagen y escriben su impresión diagnóstica. Con el formulario de
   * seguimiento entero delante tenían que ignorar veinte campos —y el sistema
   * les exigía un «motivo de consulta» que no existe— para dejar dos cosas.
   * Aquí solo se pide lo que hay: la fecha, el archivo y la impresión.
   */
  { id: 'archivos', label: 'Archivos', icon: HiOutlinePaperClip },
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
  (String(it?.quantity ?? '').trim() !== '' && Number(it.quantity) !== 1) ||
  // Un suero al que ya se le puso el cloruro o una ampolla NO es una línea en
  // blanco: descartarlo en silencio borraría una preparación de la historia.
  //
  // Solo cuenta si la casilla SIGUE marcada. Si el doctor marcó «Suero», eligió
  // el volumen y se lo pensó mejor, la fila vuelve a estar visualmente vacía: sin
  // esta condición quedaba una línea sin nombre que bloqueaba el guardado del
  // seguimiento entero con un «Falta el nombre en la línea 1» imposible de
  // entender, porque la composición ya no se ve por ningún lado.
  (!!it?.isSerum &&
    (!!it?.serumBase?.volumeMl ||
      (Array.isArray(it?.serumComponents) && it.serumComponents.some((c) => String(c?.name || '').trim()))));

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
  // Quien entra desde una cita entra a atender: el doctor arranca en la ficha
  // (los antecedentes antes de explorar) y el resto directo a seguimientos.
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
  // El correo lo ve el admin y quien atiende (capacidad `patients.email`).
  const showEmail = hasRole(...ROLES_VEN_CORREO);
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
    // Las terapias complementarias son del terapeuta. El administrador también
    // las ve, como ve su ficha y sus consultas.
    if (t.id === 'terapias') return hasRole('terapeuta', 'admin');
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
            {/**
              * LA CABECERA DICE LO IMPRESCINDIBLE DE CADA UNO, y nada más.
              *
              * Mostrador identifica por la CÉDULA; quien atiende necesita la
              * EDAD (de ella salen las dosis) y el CORREO (por ahí manda el
              * resultado o la receta). El teléfono, el WhatsApp y la dirección
              * siguen siendo del administrador — y a quien no le toca, el
              * servidor ni se los envía (ver CONTACT_FIELDS en
              * patientController): esto solo decide si se pinta el hueco.
              */}
            <p className="text-xs sm:text-sm text-slate-500 mt-0.5 sm:mt-1">
              {[
                hasRole(...ROLES_VEN_CEDULA) ? `CI: ${patient.cedula || '—'}` : '',
                `Edad: ${patient.computedAge ?? patient.age ?? '—'}`,
                hasRole(...ROLES_VEN_TELEFONO) ? patient.phone : '',
                showEmail ? patient.email : '',
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            <div className="mt-1.5 sm:mt-2">
              <TagEditor
                value={patient.tags || []}
                /**
                 * Las etiquetas se GUARDAN con `PUT /patients/:id`, que solo
                 * acepta admin, cajero, call_center y doctor (con 'optica'
                 * enumerada a mano: en el cliente no expande desde 'doctor').
                 * Desde que enfermería y odontología entran a esta pantalla,
                 * sin esto verían la X y el buscador y se comerían un 403 al
                 * tocarlos — y la etiqueta desaparecería sola al revertir.
                 */
                readOnly={!hasRole('admin', 'cajero', 'call_center', 'doctor', 'optica')}
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
          {/**
            * El terapeuta no llena la hoja MSP: la suya es otra (y privada). El
            * ADMINISTRADOR ve las dos — el servidor se la manda y le deja
            * guardarla, así que esconderla aquí era tirar el dato en el cliente.
            */}
          {tabActiva === 'ficha' && (hasRole('terapeuta')
            ? <FichaTerapiaTab patientId={id} />
            : (
              <>
                <FichaTab patientId={id} />
                {hasRole('admin') && (
                  <div className="mt-6 pt-6 border-t-2 border-violet-200">
                    <FichaTerapiaTab patientId={id} />
                  </div>
                )}
              </>
            ))}
          {tabActiva === 'seguimientos' && <SeguimientosTab patientId={id} appointmentId={appointmentId} />}
          {tabActiva === 'terapias' && <TerapiasComplementariasTab />}
          {tabActiva === 'archivos' && <ArchivosTab patientId={id} appointmentId={appointmentId} />}
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
  // Teléfono y WhatsApp: admin y mostrador (es quien llama). Para los demás el
  // servidor los omite, así que ni se pintan.
  const showContact = hasRole(...ROLES_VEN_TELEFONO);
  // Cédula, dirección y correo son las excepciones: los tres campos que lleva la
  // factura, así que mostrador los ve (el correo, además, quien atiende).
  const showCedula = hasRole(...ROLES_VEN_CEDULA);
  const showEmail = hasRole(...ROLES_VEN_CORREO);
  const showDireccion = hasRole(...ROLES_VEN_DIRECCION);
  const sourceLabels = {
    anuncio: 'Anuncio',
    referido: 'Referido',
    recepcion: 'Recepción',
    organico: 'Orgánico',
  };
  /**
   * Lo que decía la ficha física cuando NO coincide con lo que hay en el sistema.
   *
   * No se pisó ninguno de los dos: el del sistema lo tecleó una persona y el de la
   * ficha se leyó de letra manuscrita, así que se enseñan ambos y decide quien
   * mira (con el PDF a un clic en «Fichas por revisar»).
   */
  const otros = (campo) =>
    (patient.scanImport?.alternos || []).filter((a) => a.campo === campo);
  return (
    <div className="space-y-6">
      <dl className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
        {showCedula && <Item label="Cédula" value={patient.cedula} otros={otros('cedula')} />}
        <Item label="Nombre completo" value={`${patient.firstName} ${patient.lastName}`} />
        {showEmail && <Item label="Email" value={patient.email} otros={otros('correo')} />}
        {showContact && <Item label="Teléfono" value={patient.phone} otros={otros('celular')} />}
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
        <Item label="Edad" value={patient.computedAge ?? patient.age ?? '—'} otros={otros('edad')} />
        <Item label="Género" value={patient.gender} />
        {showDireccion && <Item label="Dirección" value={patient.address} otros={otros('direccion')} />}
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

function Item({ label, value, full, otros = [] }) {
  return (
    <div className={full ? 'md:col-span-2' : ''}>
      <dt className="text-xs uppercase text-slate-500 font-semibold">{label}</dt>
      <dd className="text-slate-800 mt-0.5">{value || '—'}</dd>
      {/**
       * EL OTRO VALOR. La ficha física decía otra cosa que el sistema y no se
       * pisó nada: aquí se enseñan los dos para que quien mira decida. Ver
       * `scanImport.alternos` en models/Patient.js.
       */}
      {otros.map((o, i) => (
        <dd key={`${o.valor}-${i}`} className="text-[11px] text-amber-700 mt-0.5">
          En la ficha física: «{o.valor}»
        </dd>
      ))}
    </div>
  );
}

// ───────────────────── Ficha clínica ─────────────────────

/**
 * LA FICHA DEL TERAPEUTA.
 *
 * Es OTRA ficha, no la hoja MSP con un par de campos cambiados: el terapeuta no
 * llena la oficial. Comparte con ella los antecedentes —porque pregunta lo
 * mismo— y sustituye la rejilla de hábitos por una tabla: una fila por hábito,
 * un nivel del 1 al 3 (uno solo, es una escala) y lo que el paciente hace a
 * diario.
 *
 * Y es PRIVADA: el servidor no se la manda a nadie más y tampoco deja que nadie
 * más la guarde (ver `hideTherapyNotes` y `canReadTherapy`).
 */
function FichaTerapiaTab({ patientId }) {
  const { hasRole } = useAuth();
  const esAdmin = hasRole('admin');
  const [record, setRecord] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get(`/clinical-records/${patientId}`);
      setRecord(res.data);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al cargar la ficha');
    } finally {
      setLoading(false);
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [patientId]);

  const ficha = record?.fichaTerapia || {};
  const setFicha = (patch) =>
    setRecord((r) => ({ ...r, fichaTerapia: { ...(r.fichaTerapia || {}), ...patch } }));

  // Los hábitos se guardan como lista; para pintarlos va mejor un mapa por fila.
  const habitosPorFila = Object.fromEntries((ficha.habitos || []).map((h) => [h.fila, h]));
  const setHabito = (fila, patch) => {
    const actual = habitosPorFila[fila] || { fila, nivel: '', diario: '' };
    const next = { ...actual, ...patch };
    const resto = (ficha.habitos || []).filter((h) => h.fila !== fila);
    // Una fila sin nivel y sin nota no dice nada: no se guarda.
    const lista = next.nivel || String(next.diario || '').trim() ? [...resto, next] : resto;
    // En el orden del catálogo, para que el dato no dependa de por dónde empezó
    // a escribir el terapeuta.
    setFicha({
      habitos: TERAPIA_HABITOS_FILAS.filter((f) => lista.some((h) => h.fila === f.key)).map(
        (f) => lista.find((h) => h.fila === f.key)
      ),
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.put(`/clinical-records/${patientId}`, {
        fichaTerapia: {
          patologicosPersonales: ficha.patologicosPersonales || [],
          patologicosFamiliares: ficha.patologicosFamiliares || [],
          datosRelevantes: ficha.datosRelevantes || '',
          datosRelevantesFamiliares: ficha.datosRelevantesFamiliares || '',
          antecedentesQuirurgicos: ficha.antecedentesQuirurgicos || '',
          antecedentesMedicamentos: ficha.antecedentesMedicamentos || '',
          alergias: ficha.alergias || '',
          habitos: ficha.habitos || [],
          habitosDetalle: ficha.habitosDetalle || '',
        },
      });
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
      <div className="bg-violet-50 border border-violet-200 text-violet-900 text-xs sm:text-sm rounded-xl px-3 py-2">
        {esAdmin ? (
          <><b>Ficha de terapia.</b> Reservada: solo la ven el terapeuta y la administración.</>
        ) : (
          <>Esta ficha es <b>solo tuya</b>: no la ve ningún otro profesional de la clínica.</>
        )}
      </div>

      <div className="space-y-3">
        <div>
          <h3 className="font-semibold text-slate-800">Antecedentes personales</h3>
          <p className="text-xs text-slate-400">Marque los que tenga y anote el detalle.</p>
        </div>
        <MspChecklist
          catalog={ANTECEDENTES_CATEGORIAS}
          value={ficha.patologicosPersonales}
          onChange={(v) => setFicha({ patologicosPersonales: v })}
          cols="md:grid-cols-3"
        />
        <Field label="Datos relevantes">
          <textarea
            rows={2}
            value={ficha.datosRelevantes || ''}
            onChange={(e) => setFicha({ datosRelevantes: e.target.value })}
            className="input resize-none"
          />
        </Field>
      </div>

      <div className="space-y-3 pt-2 border-t border-slate-100">
        <h3 className="font-semibold text-slate-800">Antecedentes familiares</h3>
        <MspChecklist
          catalog={ANTECEDENTES_CATEGORIAS}
          value={ficha.patologicosFamiliares}
          onChange={(v) => setFicha({ patologicosFamiliares: v })}
          cols="md:grid-cols-3"
        />
        <Field label="Datos relevantes familiares">
          <textarea
            rows={2}
            value={ficha.datosRelevantesFamiliares || ''}
            onChange={(e) => setFicha({ datosRelevantesFamiliares: e.target.value })}
            className="input resize-none"
          />
        </Field>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-2 border-t border-slate-100">
        <Field label="Antecedentes quirúrgicos">
          <textarea
            rows={2}
            value={ficha.antecedentesQuirurgicos || ''}
            onChange={(e) => setFicha({ antecedentesQuirurgicos: e.target.value })}
            className="input resize-none"
          />
        </Field>
        <Field label="Medicación habitual">
          <textarea
            rows={2}
            value={ficha.antecedentesMedicamentos || ''}
            onChange={(e) => setFicha({ antecedentesMedicamentos: e.target.value })}
            className="input resize-none"
          />
        </Field>
        <Field label="Alergias">
          <textarea
            rows={2}
            value={ficha.alergias || ''}
            onChange={(e) => setFicha({ alergias: e.target.value })}
            className="input resize-none"
          />
        </Field>
      </div>

      {/* ── Hábitos, en tabla ── */}
      <div className="space-y-3 pt-2 border-t border-slate-100">
        <div>
          <h3 className="font-semibold text-slate-800">Hábitos</h3>
          <p className="text-xs text-slate-400">
            Marque el nivel de cada uno (1, 2 o 3 — solo uno) y anote con qué frecuencia.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse min-w-[520px]">
            <thead>
              <tr className="bg-slate-50">
                <th className="border border-slate-200 px-3 py-2 text-left font-semibold w-40">Hábito</th>
                {TERAPIA_HABITOS_NIVELES.map((n) => (
                  <th key={n} className="border border-slate-200 px-3 py-2 font-semibold w-16">{n}</th>
                ))}
                {/* La columna se llama FRECUENCIA (antes «Diario»). El campo
                    guardado sigue siendo `diario`: renombrarlo habría dejado en
                    blanco lo escrito en las fichas ya llenas. */}
                <th className="border border-slate-200 px-3 py-2 text-left font-semibold">Frecuencia</th>
              </tr>
            </thead>
            <tbody>
              {TERAPIA_HABITOS_FILAS.map((f) => {
                const h = habitosPorFila[f.key] || {};
                return (
                  <tr key={f.key}>
                    <td className="border border-slate-200 px-3 py-2 font-medium text-slate-700">{f.label}</td>
                    {TERAPIA_HABITOS_NIVELES.map((n) => (
                      <td key={n} className="border border-slate-200 px-3 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={h.nivel === n}
                          /* Volver a pulsar el nivel marcado lo desmarca: si no,
                             una marca puesta por error no habría forma de quitarla. */
                          onChange={() => setHabito(f.key, { nivel: h.nivel === n ? '' : n })}
                          className="w-4 h-4 cursor-pointer accent-emerald-600"
                        />
                      </td>
                    ))}
                    <td className="border border-slate-200 px-2 py-1">
                      <input
                        type="text"
                        value={h.diario || ''}
                        onChange={(e) => setHabito(f.key, { diario: e.target.value })}
                        className="w-full text-xs border border-slate-200 rounded px-2 py-1 outline-none focus:border-emerald-500"
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Field label="Otras observaciones">
          <textarea
            rows={2}
            value={ficha.habitosDetalle || ''}
            onChange={(e) => setFicha({ habitosDetalle: e.target.value })}
            className="input resize-none"
          />
        </Field>
      </div>

      <div className="flex justify-end">
        <button
          onClick={save}
          disabled={saving}
          className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-medium disabled:opacity-50 cursor-pointer border-none"
        >
          {saving ? 'Guardando…' : 'Guardar ficha'}
        </button>
      </div>
      <FichaStyles />
    </div>
  );
}

/**
 * TERAPIAS COMPLEMENTARIAS (rol terapeuta).
 *
 * La pestaña existe, el contenido todavía no: se abrió a petición de la clínica
 * para tenerla en su sitio —junto a Seguimientos, que es donde el terapeuta
 * trabaja— y lo que va dentro se define aparte. Se deja dicho en pantalla para
 * que nadie la lea como una pestaña rota.
 */
function TerapiasComplementariasTab() {
  return (
    <div className="max-w-xl mx-auto text-center py-10 space-y-2">
      <HiOutlineSparkles className="w-10 h-10 mx-auto text-violet-300" />
      <h3 className="font-semibold text-slate-800">Terapias complementarias</h3>
      <p className="text-sm text-slate-500">
        Este apartado está reservado para las terapias complementarias del paciente.
        Todavía no tiene contenido: se definirá lo que va aquí.
      </p>
    </div>
  );
}

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
        antecedentesQuirurgicos: record.antecedentesQuirurgicos || '',
        antecedentesMedicamentos: record.antecedentesMedicamentos || '',
        alergias: record.alergias || '',
        habitos: record.habitos || [],
        habitosDetalle: record.habitosDetalle || '',
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

      {/* Antecedentes quirúrgicos, medicación habitual y alergias.
          Son tres preguntas que se hacen por separado y hasta ahora acababan las
          tres en el mismo renglón de "datos relevantes" —cuando alguien se
          acordaba—. La alergia sobre todo: es lo primero que hay que mirar antes
          de recetar y estaba a la altura de una nota suelta. */}
      <div className="space-y-3 pt-2 border-t border-slate-100">
        <div>
          <h3 className="font-semibold text-slate-800">Antecedentes quirúrgicos, medicación y alergias</h3>
          <p className="text-xs text-slate-400">Lo que hay que saber antes de recetar o intervenir.</p>
        </div>
        <div className="grid grid-cols-1 gap-4">
          <Field label="Antecedentes quirúrgicos">
            <textarea
              rows={2}
              value={record.antecedentesQuirurgicos || ''}
              onChange={(e) => update('antecedentesQuirurgicos', e.target.value)}
              placeholder="Cirugías previas, con el año si se sabe"
              className="input resize-none"
            />
          </Field>
          <Field label="Antecedentes de medicamentos (medicación habitual)">
            <textarea
              rows={2}
              value={record.antecedentesMedicamentos || ''}
              onChange={(e) => update('antecedentesMedicamentos', e.target.value)}
              placeholder="Lo que el paciente ya toma: fármaco, dosis y desde cuándo"
              className="input resize-none"
            />
          </Field>
          <Field label="Alergias">
            <textarea
              rows={2}
              value={record.alergias || ''}
              onChange={(e) => update('alergias', e.target.value)}
              placeholder="Medicamentosas, alimentarias, ambientales… y qué reacción produjeron"
              className="input resize-none"
            />
          </Field>
        </div>
      </div>

      {/* Hábitos. Con detalle por casilla: "fuma" sin el "10 al día desde los
          20" no dice nada clínicamente. */}
      <div className="space-y-3 pt-2 border-t border-slate-100">
        <div>
          <h3 className="font-semibold text-slate-800">Hábitos</h3>
          <p className="text-xs text-slate-400">Marque los que tenga y anote la cantidad y desde cuándo en el recuadro de cada uno.</p>
        </div>
        <MspChecklist
          catalog={HABITOS_CATEGORIAS}
          value={record.habitos}
          onChange={(v) => update('habitos', v)}
          cols="md:grid-cols-3"
        />
        <Field label="Otros hábitos / observaciones">
          <textarea
            rows={2}
            value={record.habitosDetalle || ''}
            onChange={(e) => update('habitosDetalle', e.target.value)}
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
function ItemsTable({ variant, items, onAdd, onUpdate, onRemove, titulo, ayuda, etiquetas }) {
  const isReceta = variant === 'receta';
  // Cómo se llama la primera columna de la receta. El terapeuta no receta
  // fármacos —manda suplementos, naturales y homeopáticos— y en su pantalla
  // tiene que poner eso. El dato guardado es el mismo (ver RECETA_ETIQUETAS).
  const rotulos = etiquetas || recetaEtiquetas(false);
  // El rótulo se puede sobreescribir: la misma tabla es la «Receta» del doctor y
  // el «Qué se aplicó» del enfermero, que no receta nada — anota lo que puso.
  const label = titulo || (isReceta ? 'Receta' : 'Derivaciones');
  /**
   * Qué línea tiene abierto el catálogo de ampollas (null = ninguna).
   *
   * Vive AQUÍ y no dentro del editor del suero porque `pie()` se pinta dos
   * veces —la tabla del escritorio y las tarjetas del móvil, las dos montadas a
   * la vez, una oculta con `display:none`—. Un modal se pinta con un portal a
   * `document.body`, y un portal NO hereda el `display:none` de su ancestro: con
   * el estado dentro del editor habría dos modales posibles para la misma línea
   * y el de la copia invisible se vería igual. Con el estado aquí solo hay uno.
   */
  const [selectorFila, setSelectorFila] = useState(null);
  const hint = ayuda || (isReceta
    ? rotulos.ayuda
    : 'servicios o programas a los que se deriva');

  // Columnas por variante. En Derivaciones manda el orden de trabajo: cuántas
  // sesiones, de qué, y con qué indicaciones.
  //
  // LAS INDICACIONES YA NO SON UNA COLUMNA. Compartiendo el ancho con otras
  // cinco quedaba una ranura de dos centímetros para el campo donde más se
  // escribe: "tomar después de comer, si aparece dolor de estómago suspender y
  // avisar" se leía de tres en tres letras. Ahora va en una fila propia, a todo
  // el ancho de la tabla y como área de texto. Para TODAS las líneas, no solo
  // las de suero.
  const columnas = isReceta
    ? [
        { key: 'name', label: rotulos.item, placeholder: 'Paracetamol 500 mg', ancho: 'min-w-[200px]' },
        { key: 'quantity', label: 'Cant.', numero: true, ancho: 'w-16' },
        { key: 'dose', label: 'Dosis', placeholder: '1 tableta' },
        { key: 'frequency', label: 'Frecuencia', placeholder: 'c/8 h' },
        { key: 'duration', label: 'Duración', placeholder: '7 días' },
        // Marcarlo como suero es lo que hace que enfermería pueda ir anotando
        // cada aplicación y que la receta lleve la cuenta ("3 de 7, faltan 4"),
        // y lo que abre el recuadro de la preparación (cloruro + ampollas).
        { key: 'isSerum', label: 'Suero', check: true, ancho: 'w-16', ayuda: 'Se administra por dosis' },
      ]
    : [
        { key: 'quantity', label: 'Cant.', numero: true, ancho: 'w-16' },
        { key: 'name', label: 'Servicio / Programa', placeholder: 'Fisioterapia, ecografía, laboratorio…', ancho: 'min-w-[240px]' },
      ];

  const placeholderIndicaciones = isReceta
    ? 'Después de comer, con abundante agua… todo lo que el paciente tiene que saber para tomarlo bien'
    : 'Motivo de la derivación o instrucciones para quien lo atienda';

  // Bloque que va DEBAJO de cada línea: las indicaciones a todo el ancho y, si
  // es un suero, su preparación. Lo comparten la tabla del escritorio y las
  // tarjetas del móvil.
  const pie = (row, idx) => (
    <>
      <label className="block">
        <span className="block text-[11px] font-medium text-slate-500 mb-0.5">Indicaciones</span>
        <textarea
          rows={2}
          value={row.instructions || ''}
          onChange={(e) => onUpdate(idx, 'instructions', e.target.value)}
          placeholder={placeholderIndicaciones}
          className="input text-xs py-1.5 resize-y w-full"
        />
      </label>
      {isReceta && row.isSerum && (
        <SueroComposicionEditor
          base={row.serumBase}
          componentes={row.serumComponents}
          onChangeBase={(v) => onUpdate(idx, 'serumBase', v)}
          onChangeComponentes={(v) => onUpdate(idx, 'serumComponents', v)}
          onAbrirCatalogo={() => setSelectorFila(idx)}
        />
      )}
    </>
  );

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
              <Fragment key={idx}>
                <tr className="border-t border-slate-200">
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
                {/* Indicaciones (y la preparación del suero) a todo el ancho. */}
                <tr>
                  <td colSpan={columnas.length + 1} className="px-2 pb-2 pt-0 align-top">
                    {pie(row, idx)}
                  </td>
                </tr>
              </Fragment>
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
            {pie(row, idx)}
          </div>
        ))}
      </div>

      {/* Uno solo para toda la tabla: ver el comentario de `selectorFila`. */}
      {selectorFila !== null && (
        <SelectorComponentesSuero
          isOpen
          seleccionados={items[selectorFila]?.serumComponents || []}
          onClose={() => setSelectorFila(null)}
          onConfirm={(comps) => {
            onUpdate(selectorFila, 'serumComponents', comps);
            setSelectorFila(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * COMPOSICIÓN DE UN SUERO: el cloruro que hace de base y lo que va dentro.
 *
 * Un suero no es una línea de receta, es una preparación. Hasta ahora la línea
 * decía "suero x7" y lo que llevaba dentro se quedaba en la cabeza del médico o
 * en un papel; enfermería, que es quien lo prepara, tenía que preguntar. Aquí se
 * escribe una vez y se lee tal cual al aplicarlo.
 *
 * El catálogo del laboratorio se elige en `SelectorComponentesSuero`, a pantalla
 * completa: aquí no cabía. Lo que queda en la línea es el RESUMEN de la bolsa,
 * que es lo que el médico necesita mirar —qué lleva, cuánto de cada cosa, y si
 * va a descontarse del inventario o no—.
 *
 * NO ES UNA LISTA CERRADA: se puede escribir algo que no esté en el catálogo y
 * se receta igual. Pero eso se AVISA, porque no es lo mismo: sin código no hay
 * de dónde descontar la ampolla, y antes esa diferencia era invisible.
 */
function SueroComposicionEditor({ base, componentes, onChangeBase, onChangeComponentes, onAbrirCatalogo }) {
  const volumen = base?.volumeMl ?? null;
  const filas = Array.isArray(componentes) ? componentes : [];

  const setFila = (idx, patch) =>
    onChangeComponentes(filas.map((f, i) => (i === idx ? { ...f, ...patch } : f)));

  // Escribir a mano re-resuelve contra el catálogo en cada pulsación: si lo
  // tecleado acaba coincidiendo con una ampolla de verdad, recupera su CÓDIGO y
  // vuelve a descontarse del inventario. Sin esto, quien prefiere teclear se
  // quedaba siempre sin código aunque escribiera el nombre exacto.
  const setNombreLibre = (idx, texto) => {
    const cat = buscarComponenteSuero({ name: texto });
    setFila(idx, { name: texto, code: cat?.code || '', grupo: cat?.grupo || 'otro' });
  };

  return (
    <div className="mt-2 rounded-lg border border-sky-200 bg-sky-50/60 p-2.5 space-y-2">
      <p className="m-0 text-[11px] font-semibold uppercase tracking-wide text-sky-700">
        Preparación del suero
      </p>

      {/**
        * El cloruro va en todos: lo único que se elige es el tamaño de la bolsa,
        * y ELEGIRLO ES OPCIONAL.
        *
        * Antes el campo se pintaba en ámbar con un «falta el volumen de la
        * bolsa», que se lee como un error por corregir: el médico que no quiere
        * fijar el tamaño —porque lo decide enfermería con lo que haya en la
        * sala— se quedaba con una advertencia permanente en la receta. La
        * preocupación de entonces era que sin volumen el cloruro desapareciera
        * de la receta impresa; eso está resuelto en `describeSuero`, que ahora
        * nombra la base aunque no lleve medida.
        */}
      <label className="flex flex-wrap items-center gap-2 text-xs text-slate-700">
        <span className="font-medium">{base?.name || SUERO_CLORURO_NOMBRE}</span>
        {/* El ancho lo pone el contenedor, no una utilidad encima del campo:
            `.input` ya trae `width:100%`. */}
        <span className="block w-32">
          <select
            value={volumen ?? ''}
            onChange={(e) =>
              onChangeBase({
                name: base?.name || SUERO_CLORURO_NOMBRE,
                volumeMl: e.target.value === '' ? null : Number(e.target.value),
              })
            }
            className="input input-sm cursor-pointer"
          >
            <option value="">Sin especificar</option>
            {SUERO_CLORURO_VOLUMENES.map((v) => (
              <option key={v} value={v}>{v} ml</option>
            ))}
          </select>
        </span>
        <span className="text-slate-400">
          {volumen ? 'va en todos los sueros' : 'volumen opcional: lo decide enfermería'}
        </span>
      </label>

      {filas.length > 0 && (
        <ul className="m-0 p-0 list-none space-y-1">
          {filas.map((f, idx) => {
            const delCatalogo = !!f.code;
            return (
              /**
               * DOS LÍNEAS, no una fila de columnas.
               *
               * El nombre va SOLO, a todo el ancho, y no compite con nada: es lo
               * único que no puede encogerse. Con el nombre y la cantidad en la
               * misma fila, bastaba que el ancho del campo de cantidad no ganara
               * la cascada para que se llevara toda la línea y el nombre se
               * pintara en vertical, una letra por renglón.
               */
              <li
                key={idx}
                className="rounded-md bg-white/80 border border-sky-100 px-2 py-1.5"
              >
                {delCatalogo ? (
                  // Del catálogo: el nombre NO se edita. Cambiarle una letra lo
                  // dejaría con el código de otra ampolla, y el inventario
                  // descontaría la que no es. Para cambiarla, se quita y se
                  // elige otra.
                  <p className="m-0 text-xs text-slate-800 leading-snug">{f.name}</p>
                ) : (
                  <input
                    type="text"
                    value={f.name || ''}
                    onChange={(e) => setNombreLibre(idx, e.target.value)}
                    placeholder="Escribe la ampolla o molécula…"
                    className="input input-sm"
                  />
                )}

                <div className="mt-1 flex items-center gap-2">
                  <span className="flex-1 min-w-0 truncate">
                    {delCatalogo ? (
                      <span className="inline-flex items-center gap-1 text-[10px] text-emerald-700">
                        <HiOutlineCheckCircle className="w-3 h-3 shrink-0" />
                        {SUERO_GRUPO_LABEL[f.grupo] || 'Otro'} · {f.code}
                      </span>
                    ) : (
                      <span className="text-[10px] text-amber-700">
                        escrito a mano · no se descuenta del inventario
                      </span>
                    )}
                  </span>
                  <label className="flex items-center gap-1 shrink-0">
                    <span className="text-[10px] text-slate-500">Cant.</span>
                    {/* El ancho lo pone ESTE contenedor, no una utilidad encima
                        del campo: `.input` ya trae `width:100%` y pelearse con
                        él en la cascada es lo que rompió esta fila. */}
                    <span className="block w-16">
                      <NumericInput
                        min={1}
                        value={f.quantity ?? 1}
                        onChange={(e) =>
                          setFila(idx, { quantity: e.target.value === '' ? '' : Number(e.target.value) })
                        }
                        title="Cantidad"
                        className="input input-sm text-center"
                      />
                    </span>
                  </label>
                  <button
                    type="button"
                    onClick={() => onChangeComponentes(filas.filter((_, i) => i !== idx))}
                    title="Quitar"
                    className="p-1 text-red-500 bg-transparent border-none cursor-pointer shrink-0"
                  >
                    <HiOutlineTrash className="w-3.5 h-3.5" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onAbrirCatalogo}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-white bg-sky-600 border-none cursor-pointer"
        >
          <HiOutlinePlus className="w-3.5 h-3.5" />
          {filas.length ? 'Añadir o quitar del catálogo' : 'Añadir ampollas o moléculas'}
        </button>
        <button
          type="button"
          onClick={() => onChangeComponentes([...filas, { name: '', code: '', grupo: 'otro', quantity: 1 }])}
          className="text-xs font-medium text-sky-700 hover:text-sky-800 bg-transparent border-none cursor-pointer p-0"
        >
          Escribir a mano
        </button>
      </div>
    </div>
  );
}

/**
 * La preparación de un suero, en solo lectura. Es lo que enfermería mira justo
 * antes de pinchar, así que las cantidades van SIEMPRE, también cuando son una:
 * "APIMEL ×1" no se puede confundir; "APIMEL" a secas sí.
 */
function SueroResumen({ item, className = '' }) {
  const vol = item?.serumBase?.volumeMl;
  const comps = Array.isArray(item?.serumComponents) ? item.serumComponents : [];
  if (!vol && !comps.length) return null;
  return (
    <div className={`text-[11px] text-slate-700 ${className}`}>
      {/* El volumen es opcional (ver SueroComposicionEditor): sin él se nombra la
          base igual, porque las ampollas van diluidas en ALGO y quien prepara
          tiene que leerlo. Es el mismo criterio que `describeSuero` en el PDF. */}
      <div>
        <span className="text-slate-500">Base:</span>{' '}
        <b>{item.serumBase?.name || SUERO_CLORURO_NOMBRE}{vol ? ` ${vol} ml` : ''}</b>
        {!vol && <span className="text-slate-400"> · volumen a criterio de enfermería</span>}
      </div>
      {comps.length > 0 && (
        <ul className="mt-0.5 mb-0 pl-4 list-disc space-y-0.5">
          {comps.map((c, i) => (
            <li key={i}>
              {c.name} <b>×{c.quantity || 1}</b>
            </li>
          ))}
        </ul>
      )}
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
  /**
   * TERAPEUTA: su hoja no es la MSP.
   *
   * No explora por sistemas, no diagnostica con CIE-10 y no narra una evolución;
   * su consulta son los cinco elementos, el reparto en cuadrantes y el plan. Se
   * le podan las secciones que no le tocan en vez de enseñarle veinte campos
   * para llegar a los tres suyos — la misma decisión que se tomó con enfermería.
   */
  const isTerapeuta = hasRole('terapeuta');
  // Cómo se llaman la receta y las recomendaciones en ESTA consulta.
  const etiquetasReceta = recetaEtiquetas(isTerapeuta);
  const isAdmin = hasRole('admin') || user?.isSuperAdmin;

  /**
   * ENFERMERÍA lee la consulta ENTERA y ESCRIBE lo que aplicó.
   *
   * Lo primero es de ago-2026: quien canaliza una vía y mete tres ampollas es
   * justo quien necesita saber a qué es alérgico el paciente y qué diagnóstico
   * hay detrás. Esconderlo no protegía nada.
   *
   * Lo segundo es de sep-2026. Antes no redactaba nada: el sistema le generaba
   * una nota automática al cerrar el turno y ahí acababa su registro. Eso dejaba
   * fuera el caso más común de la clínica — el paciente que ya dejó pagada su
   * serie de sueros, entra y pasa directo con el enfermero, sin cita ninguna —
   * y obligaba a inventarle una cita para poder anotar la aplicación.
   *
   * Lo que NO hace es la consulta médica: su formulario va podado (ver
   * `esConsultaMedica`). No diagnostica con CIE-10, no receta y no llena la hoja
   * MSP; escribe qué aplicó, a quién y cómo quedó.
   */
  const esEnfermero = hasRole('enfermero') && !isAdmin;
  const puedeEscribir = true;
  /**
   * ¿El formulario es una CONSULTA médica completa? Enfermería no: se le
   * esconden las secciones que no le tocan en vez de enseñarle veinte campos
   * para llegar a los tres suyos. La poda va en el cliente, como se hizo siempre
   * con las especialidades: lo que no se manda, no se guarda.
   */
  const esConsultaMedica = !esEnfermero;
  /**
   * ¿Se llena la HOJA MSP? Enfermería no (no hace consulta) y el TERAPEUTA
   * tampoco: se le quitan la revisión por sistemas, el examen físico, los
   * diagnósticos CIE-10 y la evolución, que no son de su oficio. Lo suyo va en
   * `TerapiaSection`, y su plan es el «plan de tratamiento terapéutico» de ahí.
   */
  const esHojaMsp = esConsultaMedica && !isTerapeuta;
  const puedeAdministrarSuero = hasRole('admin', 'doctor', 'enfermero');

  /**
   * Enfermería cierra SU turno desde aquí, sin pasar por la agenda.
   *
   * Es el mismo endpoint que el botón «Terminar» de la agenda: cierra el turno,
   * pasa la cita al siguiente profesional si lo hay y la completa si no queda
   * nadie. Después se vuelve a la agenda, igual que hace el doctor al guardar:
   * quedarse en la ficha con todo igual se lee como «no pasó nada».
   */
  const [cerrandoTurno, setCerrandoTurno] = useState(false);
  const terminarTurnoEnfermeria = async () => {
    if (cerrandoTurno) return;
    setCerrandoTurno(true);
    try {
      const { data } = await api.post(`/appointments/${appointmentId}/nurse-complete`, {});
      // Se dice la verdad sobre lo que pasó: si detrás queda otro profesional, la
      // cita NO está completada y decirlo evitaría que alguien la dé por cerrada.
      const quedaAlguien = data?.status !== 'completada';
      toast.success(quedaAlguien ? 'Tu parte quedó cerrada. La cita sigue con el siguiente.' : 'Atención finalizada.');
      navigate('/appointments');
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo cerrar tu parte');
    } finally {
      setCerrandoTurno(false);
    }
  };

  // Borrar un seguimiento sigue siendo solo del administrador: es historia
  // clínica y se corrige, no se hace desaparecer.
  const canDelete = isAdmin;
  /**
   * ¿Puedo corregir ESTE seguimiento? El autor (lo suyo) y el administrador
   * (cualquiera). Un doctor no reescribe la consulta de otro. La regla de verdad
   * la aplica el servidor; esto solo evita enseñar un botón que dará 403.
   */
  const miId = String(user?.id || user?._id || '');
  /**
   * Los mismos roles que acepta la ruta PUT (ver routes/clinicalRecords.js).
   * Mostrador puede REGISTRAR por otro, pero no reescribir una consulta médica:
   * enseñarle el lápiz solo le daría un 403 al pulsarlo. ('optica' se nombra a
   * mano: en el cliente no expande desde 'doctor'.)
   */
  const puedeEditarSeguimientos = hasRole('admin', 'doctor', 'enfermero', 'optica');
  const canEditFollowUp = (fu) =>
    puedeEditarSeguimientos
    && (isAdmin || (miId && String(fu?.createdBy?._id || fu?.createdBy || '') === miId));
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
    // Composición del suero. Solo se usa si se marca la casilla; el servidor la
    // descarta en cualquier otra línea.
    serumBase: { name: SUERO_CLORURO_NOMBRE, volumeMl: null },
    serumComponents: [],
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
  const emptyTerapia = () => ({
    elementos: [],
    // Las flechas del esquema las dibuja el terapeuta: el lienzo nace limpio.
    flechas: [],
    foda: Object.fromEntries(TERAPIA_FODA_KEYS.map((k) => [k, ''])),
    plan: '',
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
    recomendacionesNoFarmacologicas: '', // va justo debajo del plan
    evolucion: '',           // evolución respecto de controles anteriores
    indicaciones: '',        // lo que observa y recomienda quien hizo el estudio
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
    terapia: emptyTerapia(),
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
  /**
   * SEGUIMIENTO QUE SE ESTÁ CORRIGIENDO.
   *
   * Al guardar, la cita pasa a «completada» y el doctor se quedaba fuera: si
   * había mandado algo por error o se acordaba de un dato después, no podía
   * entrar. Con esto el mismo formulario sirve para escribir y para corregir; lo
   * que cambia es a dónde va (POST nuevo o PUT sobre el existente).
   */
  const [editandoId, setEditandoId] = useState(null);
  const formRef = useRef(null);
  // Odontología ve solo sus seguimientos; esto abre la historia completa cuando
  // hace falta (alergias, anticoagulantes, embarazo). Ver `filtraOdonto` abajo.
  const [verTodo, setVerTodo] = useState(false);

  /**
   * Carga un seguimiento guardado en el formulario.
   *
   * Cada sección arranca de su `empty…()` y encima se pone lo guardado: un
   * seguimiento viejo puede no tener una sección que hoy existe, y sin la base
   * el formulario reventaría al leer `form.ginecologia.gpac.gestas`.
   *
   * Receta y derivaciones se vuelven a separar por `isService`, que es como el
   * modelo las distingue (se guardan juntas en `recetaItems`). Los `_id` de cada
   * línea VIAJAN: es lo que permite al servidor conservar los sueros que
   * enfermería ya aplicó en ella.
   */
  const cargarParaEditar = (fu) => {
    /**
     * NO SE PISA UNA CONSULTA A MEDIO ESCRIBIR.
     *
     * El lápiz está pegado a los botones de PDF e imprimir en la lista de abajo.
     * Un doctor con la consulta entera escrita que lo pulse por error perdería
     * todo sin un solo aviso — y no hay «deshacer».
     */
    const hayAlgoEscrito =
      String(form.descripcion || '').trim()
      || String(form.enfermedadActual || '').trim()
      || String(form.evolucion || '').trim()
      || String(form.planTratamiento || '').trim()
      || String(form.indicaciones || '').trim()
      || (form.diagnosticos || []).length > 0
      || pendingFiles.length > 0
      || [...(form.recetaItems || []), ...(form.derivacionItems || [])].some(
        (it) => String(it.name || '').trim() || filaConDatos(it)
      );
    if (hayAlgoEscrito && editandoId !== fu._id) {
      const aviso = editandoId
        ? '¿Descartar los cambios de la corrección en curso y pasar a este seguimiento?'
        : 'Tienes una consulta a medio escribir. ¿Descartarla y corregir este seguimiento?';
      if (!confirm(aviso)) return;
    }

    const conBase = (base, guardado) =>
      guardado && typeof guardado === 'object' ? { ...base, ...guardado } : base;
    const lineas = (fu.recetaItems || []).map((it) => ({
      ...emptyRow(),
      ...it,
      quantity: it.quantity ?? 1,
      serumBase: it.serumBase || { name: SUERO_CLORURO_NOMBRE, volumeMl: null },
      serumComponents: it.serumComponents || [],
    }));
    const receta = lineas.filter((it) => !it.isService);
    const derivaciones = lineas.filter((it) => it.isService);
    setForm({
      ...emptyForm(),
      fecha: fu.fecha ? String(fu.fecha).slice(0, 10) : todayEc(),
      tipoConsulta: fu.tipoConsulta || '',
      descripcion: fu.descripcion || fu.motivoConsulta || '',
      enfermedadActual: fu.enfermedadActual || '',
      planTratamiento: fu.planTratamiento || '',
      recomendacionesNoFarmacologicas: fu.recomendacionesNoFarmacologicas || '',
      evolucion: fu.evolucion || '',
      indicaciones: fu.indicaciones || '',
      observaciones: fu.observaciones || '',
      // Siempre queda una fila en blanco al final para poder añadir sin pulsar nada.
      recetaItems: [...receta, emptyRow()],
      derivacionItems: [...derivaciones, emptyRow()],
      revisionSistemas: fu.revisionSistemas || [],
      revisionSistemasHallazgos: fu.revisionSistemasHallazgos || '',
      examenFisico: conBase({ regional: [], sistemico: [], hallazgos: '' }, fu.examenFisico),
      diagnosticos: fu.diagnosticos || [],
      opticaRx: conBase(emptyOpticaRx(), fu.opticaRx),
      ginecologia: conBase(emptyGineco(), fu.ginecologia),
      podologia: conBase(emptyPodologia(), fu.podologia),
      odontologia: conBase(emptyOdontologia(), fu.odontologia),
      cosmetologia: conBase(emptyCosmetologia(), fu.cosmetologia),
      cardiologia: conBase(emptyCardiologia(), fu.cardiologia),
      terapia: conBase(emptyTerapia(), fu.terapia),
      vitalSigns: conBase(emptyForm().vitalSigns, fu.vitalSigns),
    });
    setEditandoId(fu._id);
    setPendingFiles([]);
    // El formulario está arriba del todo y el botón de editar abajo: sin esto
    // parece que no pasó nada.
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const cancelarEdicion = () => {
    setEditandoId(null);
    setForm(emptyForm());
    setPendingFiles([]);
  };
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
      /**
       * UN SIGNO SIN MEDIR VIAJA COMO null, NUNCA COMO 0.
       *
       * El formulario nace con cadena vacía, pero lo que devuelve el servidor es
       * `null` (así los declara el esquema). Comparar solo contra `''` dejaba
       * pasar el null a `Number(null)`, que es 0: al CORREGIR un seguimiento en
       * el que no se tomaron constantes, se grababa T 0 °C, FC 0, peso 0…
       *
       * Y en ginecología era peor: con fc 0, fr 0, temperatura 0 y saturación 0
       * el Score MAMÁ puntuaba 11 y salía en ROJO —«active la clave
       * obstétrica»— en una consulta donde nadie midió nada.
       */
      const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
      const vitalSigns = {
        // Sello del sistema: la hora real en que se guarda la toma (hora de Ecuador).
        hora: nowEcHHMM(),
        temperature: num(vs.temperature),
        bloodPressure: vs.bloodPressure || '',
        heartRate: num(vs.heartRate),
        respiratoryRate: num(vs.respiratoryRate),
        oxygenSaturation: num(vs.oxygenSaturation),
        weight: num(vs.weight),
        height: num(vs.height),
        abdominalPerimeter: num(vs.abdominalPerimeter),
        capillaryHemoglobin: num(vs.capillaryHemoglobin),
        glucose: num(vs.glucose),
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
      if (!isTerapeuta) delete payload.terapia;

      /**
       * CORREGIR un seguimiento ya guardado.
       *
       * Va por su propio endpoint y no por el de crear: editar no puede volver a
       * cerrar la cita, ni abrir otro tratamiento, ni descontar el inventario
       * otra vez. Tampoco se manda `appointmentId` — la cita ya está cerrada.
       */
      if (editandoId) {
        const r = await api.put(`/clinical-records/${patientId}/follow-ups/${editandoId}`, payload);
        let actualizado = r.data;
        // Los adjuntos que se hayan añadido durante la corrección van después,
        // ya con el seguimiento a salvo (misma razón que al crear).
        if (pendingFiles.length > 0) {
          try {
            for (const f of pendingFiles) {
              const fd = new FormData();
              fd.append('file', f);
              // eslint-disable-next-line no-await-in-loop
              await api.post(
                `/clinical-records/${patientId}/follow-ups/${editandoId}/attachments`,
                fd,
                { headers: { 'Content-Type': 'multipart/form-data' } }
              );
            }
            // El endpoint de adjuntos NO devuelve la ficha, así que se relee.
            const rec = await api.get(`/clinical-records/${patientId}`);
            actualizado = rec.data;
          } catch (err) {
            toast.error(
              err.response?.data?.message || 'El seguimiento se guardó, pero no se pudieron subir los archivos',
              { duration: 8000 }
            );
          }
        }
        setRecord(actualizado);
        setForm(emptyForm());
        setPendingFiles([]);
        setEditandoId(null);
        toast.success('Seguimiento actualizado');
        return; // el `finally` de abajo suelta `saving`
      }

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

      /**
       * ENFERMERÍA: lo que acaba de registrar YA SE PUSO.
       *
       * Cuando el doctor escribe un suero deja una cuenta abierta («7 dosis») y
       * enfermería las va administrando. Cuando lo escribe el enfermero está
       * contando lo que acaba de hacer, así que se administra en el acto: si no,
       * la ficha diría «0 de 1 administrado» de algo que ya está en la vena del
       * paciente, y el inventario seguiría diciendo que la ampolla está en la
       * percha.
       *
       * Se hace llamando al MISMO endpoint que usa el botón de administrar: toda
       * la lógica de stock, topes y concurrencia vive ahí y no se duplica.
       */
      if (esEnfermero && newFu) {
        const sueros = (newFu.recetaItems || []).filter((it) => it.isSerum);
        for (const it of sueros) {
          try {
            // eslint-disable-next-line no-await-in-loop
            const r = await api.post(
              `/clinical-records/${patientId}/follow-ups/${newFu._id}/receta/${it._id}/administer`,
              {
                baseVolumeMl: it.serumBase?.volumeMl ?? null,
                components: (it.serumComponents || []).map((c) => ({
                  code: c.code || '',
                  name: c.name || '',
                  quantityPrescribed: Number(c.quantity) || 0,
                  quantityApplied: Number(c.quantity) || 0,
                  omitReason: '',
                })),
              }
            );
            updated = r.data?.record || r.data || updated;
          } catch (err) {
            // No se pierde el registro por esto: el seguimiento ya está guardado
            // y la dosis se puede anotar desde la propia línea.
            toast.error(
              `${it.name}: ${err.response?.data?.message || 'no se pudo descontar del inventario'}. Anótalo desde la línea del suero.`,
              { duration: 8000 }
            );
          }
        }
      }
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
        /**
         * Sin cita de partida, el servidor la registra solo y lo dice aquí.
         *
         * Decirlo importa: quien atiende no tiene forma de saber que la
         * atención quedó registrada, y si no se le cuenta acaba yendo a la
         * agenda a crear la cita a mano — y entonces hay dos.
         */
        const auto = updated.autoAppointment || res.data?.autoAppointment;
        /**
         * Mostrador receta un suero: la cita no registra algo que ya pasó, deja
         * al paciente EN LA COLA de enfermería. Decirlo con las mismas palabras
         * que una atención ya cerrada haría que el cajero se fuera pensando que
         * ahí se acabó, cuando lo que falta es que alguien ponga el suero.
         */
        toast.success(
          auto?.paraEnfermeria
            ? 'Suero recetado. El paciente ya le aparece a enfermería para que se lo apliquen.'
            : auto
              ? `Seguimiento guardado. Se registró la atención de las ${auto.startTime}.`
              : 'Seguimiento guardado'
        );
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

  /**
   * Historia clínica COMPLETA en la hoja oficial MSP HCU-form.005 (Evolución y
   * prescripciones): todas las consultas en orden, con lo que se recetó y lo que
   * enfermería aplicó de verdad.
   */
  const openHcu005 = async () => {
    try {
      const res = await api.get(`/clinical-records/${patientId}/hcu005`, { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
      window.open(url, '_blank');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al generar la historia clínica');
    }
  };

  if (loading) return <div className="text-slate-500 text-sm">Cargando...</div>;
  if (!record) return null;

  // Todas las consultas, para todos. A enfermería se le escondían las que no
  // recetaban nada; ahora que lee la historia entera, una consulta sin receta
  // sigue diciéndole algo (el diagnóstico, la evolución, los signos vitales).
  const todosLosSeguimientos = [...(record.followUps || [])]
    .sort((a, b) => new Date(b.fecha) - new Date(a.fecha));

  /**
   * ODONTOLOGÍA VE LO SUYO.
   *
   * El odontólogo entra al paciente para consultar SU historia, y las consultas
   * de las demás especialidades solo le hacen scrollear. La lista se filtra por
   * el rol con el que se escribió cada seguimiento (`createdByRole`), con dos
   * respaldos para lo que ya estaba guardado antes de que ese campo existiera:
   * que la consulta traiga ficha de odontología, o que la haya escrito él mismo.
   *
   * El enlace de «ver la historia completa» NO es un descuido: antes de una
   * extracción hay que poder mirar alergias, anticoagulantes o un embarazo, y
   * esos datos están en las consultas de los demás. Está deliberadamente
   * discreto — hay que pedirlo — pero está.
   */
  const filtraOdonto = isOdonto && !isAdmin;
  const esDeOdontologia = (fu) =>
    fu.createdByRole === 'odontologia'
    || odontologiaHasData(fu.odontologia)
    || (miId && String(fu.createdBy?._id || fu.createdBy || '') === miId);
  const followUps = filtraOdonto && !verTodo
    ? todosLosSeguimientos.filter(esDeOdontologia)
    : todosLosSeguimientos;
  const ocultos = filtraOdonto && !verTodo
    ? todosLosSeguimientos.length - followUps.length
    : 0;

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* HISTORIA CLÍNICA COMPLETA en el formulario oficial del MSP. La hoja 002
          es UNA consulta; la 005 es el registro secuencial de todas, que es lo
          que se pide cuando alguien dice «imprímeme la historia del paciente».
          Lleva la cédula en la cabecera, así que no es para enfermería. */}
      {!esEnfermero && followUps.length > 0 && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={openHcu005}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-200 bg-white text-sm text-slate-700 hover:text-emerald-700 hover:border-emerald-300 cursor-pointer"
            title="Historia clínica completa · MSP HCU-form.005 (Evolución y prescripciones)"
          >
            <HiOutlineDocumentText className="w-4 h-4" />
            Historia clínica (HCU-005)
          </button>
        </div>
      )}

      {/* Ya no promete que la cita se completa: con varios profesionales, guardar
          cierra TU turno y puede pasarla al siguiente. Decir "completada" hacía
          que el segundo doctor creyera que el primero ya había cerrado todo. */}
      {appointmentId && puedeEscribir && !editandoId && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 text-xs sm:text-sm rounded-xl px-3 py-2">
          Al guardar cierras tu parte de la consulta y vuelves a la agenda.
        </div>
      )}

      {/* Corrigiendo: el aviso de arriba mentiría (editar no cierra nada) y
          además hay que poder salirse sin guardar. */}
      {editandoId && (
        <div className="flex flex-wrap items-center justify-between gap-2 bg-indigo-50 border border-indigo-200 text-indigo-900 text-xs sm:text-sm rounded-xl px-3 py-2">
          <span>
            Estás <b>corrigiendo un seguimiento ya guardado</b>. Al guardar se actualiza
            y queda registrado que lo modificaste.
          </span>
          <button
            type="button"
            onClick={cancelarEdicion}
            className="shrink-0 px-3 py-1.5 rounded-lg bg-white text-indigo-700 border border-indigo-300 text-xs font-semibold cursor-pointer"
          >
            Cancelar corrección
          </button>
        </div>
      )}

      {/**
       * ENFERMERÍA TAMBIÉN TIENE QUE PODER TERMINAR.
       *
       * El doctor cierra su turno al guardar el seguimiento; enfermería no
       * redacta ninguno, así que no tenía forma de cerrar el suyo desde aquí: se
       * aplicaba el suero y la cita se quedaba abierta para siempre, y el botón
       * «Terminar» solo existía en la agenda —había que salir a buscarlo—.
       */}
      {appointmentId && esEnfermero && !editandoId && (
        <div className="flex flex-wrap items-center justify-between gap-2 bg-sky-50 border border-sky-200 text-sky-900 text-xs sm:text-sm rounded-xl px-3 py-2">
          <span>
            Cuando acabes de aplicar lo indicado, cierra tu parte de la atención — o
            guarda abajo lo que aplicaste, que también la cierra.
          </span>
          <button
            type="button"
            onClick={terminarTurnoEnfermeria}
            disabled={cerrandoTurno}
            className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-600 text-white text-xs font-semibold border-none cursor-pointer disabled:opacity-50"
          >
            <HiOutlineCheck className="w-4 h-4" />
            {cerrandoTurno ? 'Cerrando…' : 'Terminar mi parte'}
          </button>
        </div>
      )}

      {/* El formulario es el mismo para todos; lo que cambia es cuánto se ve
          (ver `esConsultaMedica`). `puedeEscribir` se conserva por si mañana
          vuelve a haber un rol de solo lectura. */}
      {puedeEscribir && (
      <form
        ref={formRef}
        onSubmit={submit}
        onKeyDown={evitarEnvioConEnter}
        className={`rounded-xl p-4 grid grid-cols-1 gap-3 md:grid-cols-3 ${
          editandoId ? 'bg-indigo-50/60 ring-2 ring-indigo-200' : 'bg-slate-50'
        }`}
      >
        <Field label="Fecha">
          <DateInput
            value={form.fecha}
            onChange={(e) => setForm((f) => ({ ...f, fecha: e.target.value }))}
            className="input"
          />
        </Field>
        {/* Enfermería no hace una consulta: hace algo concreto. Preguntarle el
            «motivo de consulta» la obligaba a escribir ahí el nombre del
            servicio, que no es lo mismo y descuadraba el historial. */}
        <Field
          label={esConsultaMedica ? 'Motivo de consulta' : 'Servicio aplicado'}
          className="md:col-span-2"
        >
          <input
            type="text"
            value={form.descripcion}
            onChange={(e) => setForm((f) => ({ ...f, descripcion: e.target.value }))}
            placeholder={esConsultaMedica ? '' : 'Ej.: sueroterapia, curación, inyección…'}
            className="input"
            required
          />
        </Field>

        {/**
          * De aquí abajo empieza la CONSULTA MÉDICA (hoja MSP, diagnósticos,
          * receta, plan, derivaciones). Enfermería no la ve: no diagnostica ni
          * receta, y enseñarle veinte campos para llegar a los tres suyos es
          * exactamente lo que hacía que se registrara todo «a mano» en las
          * observaciones. Lo suyo —fecha, servicio, signos vitales, qué aplicó y
          * archivos— sí lo tiene, intercalado en su sitio.
          */}
        {esConsultaMedica && (<>
        {/* INDICACIONES del estudio: lo que se ve en la imagen y lo que se
            recomienda a partir de ello. Va aquí arriba, junto al motivo, porque
            cuando la consulta ES el estudio esto es su cuerpo — no una nota al
            pie como la evolución lo es para los demás. */}
        <Field label="Indicaciones" className="md:col-span-3">
          <textarea
            rows={4}
            value={form.indicaciones}
            onChange={(e) => setForm((f) => ({ ...f, indicaciones: e.target.value }))}
            placeholder="Lo que se observa en el estudio y lo que se recomienda a partir de ello"
            className="input resize-none"
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
        </>)}

        {/* F. Signos vitales. Enfermería SÍ los toma: es media consulta suya. */}
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

        {esHojaMsp && (<>
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

        </>)}

        {/* Ficha de la especialidad: va pegada al diagnóstico, antes de recetar.
            Fuera del bloque MSP a propósito: el terapeuta no llena aquella hoja
            pero SÍ tiene la suya. */}
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
        {isTerapeuta && <TerapiaSection value={form.terapia} onChange={(t) => setForm((f) => ({ ...f, terapia: t }))} />}

        {/* Orden de la consulta: cómo va el paciente → qué se le receta → el
            plan narrado → lo que hace por su cuenta → y, al final, a dónde se le
            deriva. La derivación se decide DESPUÉS de tener el plan, y es lo
            último que se le explica al paciente antes de que salga. */}
        {esHojaMsp && (
        <Field label="Evolución" className="md:col-span-3">
          <textarea
            rows={2}
            value={form.evolucion}
            onChange={(e) => setForm((f) => ({ ...f, evolucion: e.target.value }))}
            placeholder="Cómo evoluciona el paciente respecto de los controles anteriores"
            className="input resize-none"
          />
        </Field>
        )}

        {/**
          * QUÉ SE APLICÓ / QUÉ SE RECETA.
          *
          * Es la misma tabla para los dos, y a propósito: el suero se describe
          * igual lo mande el médico o lo ponga el enfermero por su cuenta
          * (cloruro, volumen, ampollas y moléculas). Lo que cambia es el
          * significado — el doctor deja una cuenta abierta de N dosis; el
          * enfermero anota lo que acaba de poner —, y de eso se encarga el
          * guardado: lo que registra enfermería se administra en el acto (ver
          * `submit`), así que sale del inventario en ese momento.
          */}
        <ItemsTable
          variant="receta"
          titulo={esConsultaMedica ? undefined : 'Qué se aplicó'}
          ayuda={esConsultaMedica ? undefined : 'marca «suero» para anotar el cloruro y las ampollas que entraron'}
          etiquetas={etiquetasReceta}
          items={form.recetaItems}
          onAdd={() => addRow('recetaItems')}
          onUpdate={(idx, key, val) => updateRow('recetaItems', idx, key, val)}
          onRemove={(idx) => removeRow('recetaItems', idx)}
        />

        {esConsultaMedica && (<>
        {/* J. Plan de tratamiento (narrado; la receta va arriba y las
            derivaciones justo debajo) */}
        {esHojaMsp && (
        <Field label="Plan de tratamiento" className="md:col-span-3">
          <textarea
            rows={2}
            value={form.planTratamiento}
            onChange={(e) => setForm((f) => ({ ...f, planTratamiento: e.target.value }))}
            placeholder="Diagnóstico, terapéutico y educacional"
            className="input resize-none"
          />
        </Field>
        )}

        {/* Lo que el paciente tiene que hacer por su cuenta, sin receta de por
            medio. Campo aparte del plan a propósito: se le explica y se le
            entrega distinto, y mezclado con los fármacos se perdía.
            En la consulta del terapeuta esto es el «coaching de cambio de
            hábitos» — mismo campo, otro nombre (ver RECETA_ETIQUETAS). */}
        <Field label={etiquetasReceta.consejos} className="md:col-span-3">
          <textarea
            rows={2}
            value={form.recomendacionesNoFarmacologicas}
            onChange={(e) => setForm((f) => ({ ...f, recomendacionesNoFarmacologicas: e.target.value }))}
            placeholder="Dieta, ejercicio, reposo, higiene del sueño, hidratación…"
            className="input resize-none"
          />
        </Field>

        {/* Derivaciones: a dónde se manda al paciente. Va DESPUÉS del plan
            porque es donde encaja en la consulta — primero se decide el
            tratamiento y de ahí sale a quién hay que derivarlo. */}
        <ItemsTable
          variant="derivacion"
          items={form.derivacionItems}
          onAdd={() => addRow('derivacionItems')}
          onUpdate={(idx, key, val) => updateRow('derivacionItems', idx, key, val)}
          onRemove={(idx) => removeRow('derivacionItems', idx)}
        />
        </>)}

        {/* Archivos (PDF o imágenes) antes de guardar el seguimiento. Cuando la
            consulta es un estudio, esto NO es un anexo: es el estudio. */}
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
          {editandoId && (
            <button
              type="button"
              onClick={cancelarEdicion}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-white text-slate-600 border border-slate-300 cursor-pointer"
            >
              Cancelar
            </button>
          )}
          {/* ÚNICA forma de enviar el seguimiento (ver evitarEnvioConEnter). */}
          <button
            type="submit"
            disabled={saving}
            className={`flex items-center gap-1 px-5 py-2 text-white rounded-lg text-sm font-medium disabled:opacity-50 cursor-pointer border-none ${
              editandoId ? 'bg-indigo-600 hover:bg-indigo-700' : 'bg-emerald-600 hover:bg-emerald-700'
            }`}
          >
            <HiOutlineCheck className="w-4 h-4" />
            {saving
              ? 'Guardando…'
              : editandoId
                ? 'Guardar cambios'
                : appointmentId ? 'Guardar y finalizar' : 'Guardar'}
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
              {filtraOdonto && !verTodo && todosLosSeguimientos.length > 0
                ? 'Este paciente no tiene consultas de odontología.'
                : 'No hay seguimientos.'}
            </p>
          )}
          {/* Aviso del recorte. Antes de una extracción hay que poder mirar
              alergias o anticoagulantes, y eso está en las consultas de otras
              especialidades: se puede pedir, pero no se enseña por defecto. */}
          {filtraOdonto && (ocultos > 0 || verTodo) && (
            <div className="px-4 py-2 bg-slate-50 text-xs text-slate-500 flex flex-wrap items-center justify-between gap-2">
              <span>
                {verTodo
                  ? 'Viendo la historia clínica completa del paciente.'
                  : `${ocultos} consulta${ocultos === 1 ? '' : 's'} de otras especialidades no se ${ocultos === 1 ? 'muestra' : 'muestran'}.`}
              </span>
              <button
                type="button"
                onClick={() => setVerTodo((v) => !v)}
                className="text-emerald-700 hover:underline bg-transparent border-none cursor-pointer p-0 font-medium"
              >
                {verTodo ? 'Ver solo odontología' : 'Ver historia completa'}
              </button>
            </div>
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
              const hasTerapiaData = terapiaHasData(fu.terapia);
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
                    {/* Un seguimiento corregido tiene que decirlo: es historia
                        clínica y quien la lea después debe saber que se tocó. */}
                    {fu.editedAt && (
                      <span
                        className="text-[10px] text-indigo-600 italic ml-2 md:ml-0 md:mt-0.5 md:block"
                        title={new Date(fu.editedAt).toLocaleString('es-EC')}
                      >
                        Modificado{fu.updatedBy?.name ? ` por ${fu.updatedBy.name}` : ''} · {fmtDate(fu.editedAt)}
                      </span>
                    )}
                  </div>
                  <div className="flex-1 min-w-0 break-words md:px-4 md:py-2.5 text-slate-800">
                    {fu.kind === 'enfermeria' && (
                      <span className="inline-block mb-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-sky-100 text-sky-700">Enfermería</span>
                    )}
                    {/* Consulta del terapeuta vista por quien no le corresponde.
                        El servidor ya la vació (`hideTherapyNotes`); aquí solo
                        se dice qué es, para que no parezca una consulta a la que
                        le faltan los campos. */}
                    {fu.redacted && (
                      <span className="inline-block mb-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-violet-100 text-violet-700">
                        Terapia · reservado
                      </span>
                    )}
                    {fu.createdByRole === 'terapeuta' && !fu.redacted && (
                      <span className="inline-block mb-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-violet-100 text-violet-700">Terapia</span>
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
                    {hasOpticaData && <OpticaRxSummary rx={fu.opticaRx} />}
                    {hasGinecoData && <GinecologiaSummary g={fu.ginecologia} fecha={fu.fecha} />}
                    {hasPodoData && <PodologiaSummary p={fu.podologia} />}
                    {hasOdontoData && <OdontologiaSummary o={fu.odontologia} />}
                    {hasCosmeData && <CosmetologiaSummary c={fu.cosmetologia} />}
                    {hasCardioData && <CardiologiaSummary value={fu.cardiologia} />}
                    {hasTerapiaData && <TerapiaSummary value={fu.terapia} />}
                    {/* LO QUE ENFERMERÍA APLICÓ DE VERDAD. Antes aquí solo ponía
                        «Servicio aplicado por enfermería»: la aplicación vive
                        dentro de la receta del doctor que la mandó, que es otra
                        tarjeta y otro día, así que quien leía el parte no sabía
                        ni qué suero ni qué ampollas se pusieron. */}
                    <AplicacionesEnfermeria lista={fu.aplicaciones} />
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
                        // Las indicaciones van en su PROPIA línea, no pegadas al
                        // final con un guion: es lo que hay que leer entero y
                        // arrastradas detrás de la dosis se saltaban.
                        return (
                          <li key={it._id || i}>
                            <div>
                              <b>{it.name}</b>
                              {it.quantity ? ` ×${it.quantity}` : ''}
                              {it.dose ? ` · ${it.dose}` : ''}
                              {it.frequency ? ` · ${it.frequency}` : ''}
                              {it.duration ? ` · ${it.duration}` : ''}
                            </div>
                            {it.instructions && (
                              <div className="mt-0.5 whitespace-pre-wrap">
                                <span className="text-slate-400">Indicaciones:</span> {it.instructions}
                              </div>
                            )}
                          </li>
                        );
                      };
                      return (
                        <>
                          {recetaOnly.length > 0 && (
                            <div className="mt-2 bg-slate-50 border border-slate-200 rounded p-2">
                              <p className="text-[11px] font-semibold text-slate-600 uppercase mb-1">Receta</p>
                              <ul className="text-xs text-slate-700 space-y-1.5">
                                {recetaOnly.map(renderItem)}
                              </ul>
                            </div>
                          )}
                          {derivOnly.length > 0 && (
                            <div className="mt-2 bg-indigo-50 border border-indigo-200 rounded p-2">
                              <p className="text-[11px] font-semibold text-indigo-600 uppercase mb-1">Derivaciones</p>
                              <ul className="text-xs text-slate-700 space-y-1.5">
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
                    {fu.recomendacionesNoFarmacologicas && (
                      <div className="mt-2 text-xs text-slate-600 whitespace-pre-wrap">
                        {/* El rótulo lo manda el rol con el que se ESCRIBIÓ la
                            consulta, no quien la está leyendo: lo del terapeuta
                            se llama igual lo abra él o lo abra el administrador. */}
                        <b>{recetaEtiquetas(fu.createdByRole === 'terapeuta').consejos}:</b> {fu.recomendacionesNoFarmacologicas}
                      </div>
                    )}
                    {fu.evolucion && (
                      <div className="mt-2 text-xs text-slate-600 whitespace-pre-wrap">
                        <b>Evolución:</b> {fu.evolucion}
                      </div>
                    )}
                    {/* Lo que escribió quien hizo el estudio. Se destaca porque
                        muchas veces es TODO el contenido del seguimiento —el
                        resto es el archivo— y tiene que leerse sin abrir el PDF. */}
                    {fu.indicaciones && (
                      <div className="mt-2 text-xs text-slate-700 whitespace-pre-wrap bg-sky-50 border border-sky-100 rounded p-2">
                        <b className="text-sky-700">Indicaciones:</b> {fu.indicaciones}
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
                  </div>
                  <div className="md:w-32 md:shrink-0 md:px-4 md:py-2.5 border-t border-slate-100 pt-2 md:border-t-0 md:pt-0">
                    <div className="flex items-center gap-1 md:justify-end">
                      {/* De una consulta reservada no hay nada que imprimir ni
                          que corregir: el servidor da 403 en los tres PDF. Los
                          botones se esconden para no ofrecer lo que no se puede. */}
                      {fu.redacted ? null : (<>
                      {/* CORREGIR. Antes, guardado el seguimiento, no había
                          vuelta atrás: un dato mal escrito o un olvido obligaban
                          a pedirle al admin que borrara la consulta entera. */}
                      {puedeEscribir && canEditFollowUp(fu) && (
                        <button
                          onClick={() => cargarParaEditar(fu)}
                          title="Corregir o ampliar este seguimiento"
                          className={`p-1 cursor-pointer bg-transparent border-none ${
                            editandoId === fu._id ? 'text-indigo-600' : 'text-slate-500 hover:text-indigo-600'
                          }`}
                        >
                          <HiOutlinePencilSquare className="w-4 h-4" />
                        </button>
                      )}
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
                      {/* La hoja oficial lleva la cédula del paciente en la
                          cabecera, que es dato de administración. Enfermería lee
                          la historia dentro de la app, pero no se lleva el PDF
                          con la identificación (ver routes/clinicalRecords.js). */}
                      {!esEnfermero && (
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
                      </>)}
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

// ──────────────── Archivos: estudios del paciente ────────────────

/**
 * PESTAÑA «ARCHIVOS».
 *
 * ─── POR QUÉ EXISTE ────────────────────────────────────────────────────────────
 * Hay médicos que no hacen seguimiento y no recetan: hacen la ecografía, suben la
 * imagen y escriben su impresión diagnóstica. Para dejar esas dos cosas tenían
 * que abrir el formulario de la consulta entera —hoja MSP, revisión de sistemas,
 * examen físico, CIE-10, receta, derivaciones— e ignorarlo todo; y encima el
 * sistema les exigía un «motivo de consulta» que en un estudio no existe.
 *
 * Guarda un seguimiento normal con `kind: 'estudio'`, y por eso cierra la cita
 * igual que guardar una consulta: es el mismo mecanismo, no uno paralelo.
 * También se puede volver a entrar y corregir, como en Seguimientos.
 *
 * NO es la bitácora de Observaciones: aquello es recepción anotando cosas del
 * paciente, esto es un acto médico que cuelga de una cita.
 */
function ArchivosTab({ patientId, appointmentId }) {
  const navigate = useNavigate();
  const { hasRole, user } = useAuth();
  const isAdmin = hasRole('admin') || user?.isSuperAdmin;
  const miId = String(user?.id || user?._id || '');
  // Mismos roles que acepta el PUT (ver routes/clinicalRecords.js): mostrador no
  // reescribe un acto médico, aunque pueda registrarlo.
  const puedeCorregir = hasRole('admin', 'doctor', 'enfermero', 'optica');

  const [record, setRecord] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editandoId, setEditandoId] = useState(null);
  const [fecha, setFecha] = useState(todayEc());
  const [titulo, setTitulo] = useState('');
  const [impresion, setImpresion] = useState('');
  const [pendientes, setPendientes] = useState([]);
  const [subiendoEn, setSubiendoEn] = useState(null);
  const [previewAtt, setPreviewAtt] = useState(null);
  const formRef = useRef(null);

  const load = async () => {
    try {
      const res = await api.get(`/clinical-records/${patientId}`);
      setRecord(res.data);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al cargar los archivos');
    } finally {
      setLoading(false);
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [patientId]);

  // Solo los estudios. El resto de la historia vive en Seguimientos y mezclarlos
  // aquí convertiría esta pestaña en una segunda copia de aquella.
  const estudios = useMemo(
    () => (record?.followUps || [])
      .filter((fu) => fu.kind === 'estudio')
      .slice()
      .sort((a, b) => new Date(b.fecha || 0) - new Date(a.fecha || 0)),
    [record]
  );

  const puedeEditar = (fu) =>
    puedeCorregir
    && (isAdmin || (miId && String(fu?.createdBy?._id || fu?.createdBy || '') === miId));

  const limpiar = () => {
    setEditandoId(null);
    setFecha(todayEc());
    setTitulo('');
    setImpresion('');
    setPendientes([]);
  };

  const cargarParaEditar = (fu) => {
    setEditandoId(fu._id);
    setFecha(fu.fecha ? String(fu.fecha).slice(0, 10) : todayEc());
    setTitulo(fu.descripcion || fu.motivoConsulta || '');
    setImpresion(fu.indicaciones || '');
    setPendientes([]);
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const subirA = async (fuId, files) => {
    for (const f of files) {
      const fd = new FormData();
      fd.append('file', f);
      // eslint-disable-next-line no-await-in-loop
      await api.post(
        `/clinical-records/${patientId}/follow-ups/${fuId}/attachments`,
        fd,
        { headers: { 'Content-Type': 'multipart/form-data' } }
      );
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    /**
     * No se exige motivo de consulta —ese es justo el campo que sobraba— pero sí
     * que el registro DIGA algo: guardar una fecha sola y nada más deja una
     * entrada en blanco en la historia clínica que nadie sabe interpretar.
     */
    if (!pendientes.length && !impresion.trim() && !editandoId) {
      toast.error('Sube al menos un archivo o escribe la impresión diagnóstica');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        kind: 'estudio',
        fecha,
        // El título es opcional. Si no lo escriben, la entrada se llama por lo
        // que es, para que el historial no muestre una fila sin nombre.
        descripcion: titulo.trim() || 'Estudio',
        indicaciones: impresion,
      };

      if (editandoId) {
        await api.put(`/clinical-records/${patientId}/follow-ups/${editandoId}`, payload);
        // Los archivos van en su propio try, igual que al crear: si falla la
        // subida y el error subiera al catch de fuera, se leería «error al
        // guardar» con el estudio YA guardado, y el reintento duplicaría los
        // archivos que sí habían subido.
        let falloArchivos = null;
        if (pendientes.length) {
          try {
            await subirA(editandoId, pendientes);
          } catch (err) {
            falloArchivos = err.response?.data?.message || 'No se pudieron subir todos los archivos';
          }
        }
        await load();
        limpiar();
        if (falloArchivos) {
          toast.error(`${falloArchivos}. Adjúntalos desde el estudio ya guardado.`, { duration: 8000 });
        } else {
          toast.success('Estudio actualizado');
        }
        return;
      }

      if (appointmentId) payload.appointmentId = appointmentId;
      const res = await api.post(`/clinical-records/${patientId}/follow-ups`, payload);
      const nuevo = (res.data.followUps || []).slice(-1)[0];

      // Los archivos van DESPUÉS y en su propio try: si falla la subida y el
      // error subiera al catch de fuera, el usuario leería «error al guardar»
      // con el formulario intacto, volvería a darle y crearía un estudio
      // duplicado en la historia clínica.
      let falloArchivos = null;
      if (nuevo && pendientes.length) {
        try {
          await subirA(nuevo._id, pendientes);
        } catch (err) {
          falloArchivos = err.response?.data?.message || 'No se pudieron subir todos los archivos';
        }
      }
      await load();
      limpiar();

      if (falloArchivos) {
        toast.error(`${falloArchivos}. Adjúntalos desde el estudio ya guardado.`, { duration: 8000 });
        return;
      }
      // Guardar desde una cita la cierra y devuelve a la agenda, igual que un
      // seguimiento: quedarse aquí con el formulario en blanco se lee como
      // «no pasó nada».
      if (appointmentId) {
        const siguiente = res.data.nextTurn;
        toast.success(
          siguiente
            ? 'Estudio guardado. Pasa al siguiente profesional.'
            : 'Estudio guardado. Cita finalizada.'
        );
        navigate('/appointments');
      } else {
        const auto = res.data.autoAppointment;
        toast.success(
          auto
            ? `Estudio guardado. Se registró la atención de las ${auto.startTime}.`
            : 'Estudio guardado'
        );
      }
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al guardar el estudio');
    } finally {
      setSaving(false);
    }
  };

  const borrarAdjunto = async (fuId, attId) => {
    if (!confirm('¿Eliminar este archivo?')) return;
    try {
      await api.delete(`/clinical-records/${patientId}/follow-ups/${fuId}/attachments/${attId}`);
      await load();
      toast.success('Archivo eliminado');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    }
  };

  const adjuntarA = async (fuId, files) => {
    setSubiendoEn(fuId);
    try {
      await subirA(fuId, files);
      await load();
      toast.success(files.length > 1 ? 'Archivos adjuntados' : 'Archivo adjuntado');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al subir archivo');
    } finally {
      setSubiendoEn(null);
    }
  };

  if (loading) return <p className="text-sm text-slate-400 py-6 text-center">Cargando…</p>;

  return (
    <div className="space-y-4">
      {appointmentId && !editandoId && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 text-xs sm:text-sm rounded-xl px-3 py-2">
          Al guardar cierras tu parte de la consulta y vuelves a la agenda.
        </div>
      )}
      {editandoId && (
        <div className="flex flex-wrap items-center justify-between gap-2 bg-indigo-50 border border-indigo-200 text-indigo-900 text-xs sm:text-sm rounded-xl px-3 py-2">
          <span>Estás <b>corrigiendo un estudio ya guardado</b>.</span>
          <button
            type="button"
            onClick={limpiar}
            className="shrink-0 px-3 py-1.5 rounded-lg bg-white text-indigo-700 border border-indigo-300 text-xs font-semibold cursor-pointer"
          >
            Cancelar corrección
          </button>
        </div>
      )}

      <form
        ref={formRef}
        onSubmit={submit}
        /* Igual que en Seguimientos: Enter dentro de un campo no puede enviar
           el formulario y dar la cita por terminada sin querer. */
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'BUTTON') return;
          e.preventDefault();
        }}
        className={`rounded-xl p-4 grid grid-cols-1 gap-3 md:grid-cols-3 ${
          editandoId ? 'bg-indigo-50/60 ring-2 ring-indigo-200' : 'bg-slate-50'
        }`}
      >
        <Field label="Fecha">
          <DateInput value={fecha} onChange={(e) => setFecha(e.target.value)} className="input" />
        </Field>
        <Field label="Estudio (opcional)" className="md:col-span-2">
          <input
            type="text"
            value={titulo}
            onChange={(e) => setTitulo(e.target.value)}
            placeholder="Ej.: ecografía abdominal, rayos X de tórax…"
            className="input"
          />
        </Field>
        <Field label="Impresión diagnóstica" className="md:col-span-3">
          <textarea
            rows={5}
            value={impresion}
            onChange={(e) => setImpresion(e.target.value)}
            placeholder="Lo que se observa en el estudio y lo que se recomienda a partir de ello"
            className="input resize-none"
          />
        </Field>

        <div className="md:col-span-3">
          <label className="text-sm font-medium text-slate-700 block mb-2">
            Archivos (PDF o imágenes)
          </label>
          <div className="bg-white rounded-lg border border-slate-200 p-3 space-y-2">
            <input
              type="file"
              accept="application/pdf,image/*"
              multiple
              onChange={(e) => {
                const files = Array.from(e.target.files || []).filter(isAllowedAttachment);
                if (files.length !== (e.target.files?.length || 0)) {
                  toast.error('Solo se permiten archivos PDF o imágenes');
                }
                setPendientes((prev) => [...prev, ...files]);
                e.target.value = '';
              }}
              className="text-sm"
            />
            {pendientes.length > 0 && (
              <ul className="m-0 p-0 list-none space-y-1">
                {pendientes.map((f, i) => (
                  <li key={i} className="flex items-center gap-2 text-xs text-slate-600">
                    <span>{f.type.startsWith('image/') ? '🖼️' : '📎'}</span>
                    <span className="truncate">{f.name}</span>
                    <span className="text-slate-400">({Math.round(f.size / 1024)} KB)</span>
                    <button
                      type="button"
                      onClick={() => setPendientes((prev) => prev.filter((_, j) => j !== i))}
                      className="text-red-500 bg-transparent border-none cursor-pointer p-0"
                      title="Quitar"
                    >
                      <HiOutlineTrash className="w-3.5 h-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="md:col-span-3 flex justify-end gap-2">
          {editandoId && (
            <button
              type="button"
              onClick={limpiar}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-white text-slate-600 border border-slate-300 cursor-pointer"
            >
              Cancelar
            </button>
          )}
          <button
            type="submit"
            disabled={saving}
            className={`flex items-center gap-1 px-5 py-2 text-white rounded-lg text-sm font-medium disabled:opacity-50 cursor-pointer border-none ${
              editandoId ? 'bg-indigo-600 hover:bg-indigo-700' : 'bg-emerald-600 hover:bg-emerald-700'
            }`}
          >
            <HiOutlineCheck className="w-4 h-4" />
            {saving
              ? 'Guardando…'
              : editandoId
                ? 'Guardar cambios'
                : appointmentId ? 'Guardar y finalizar' : 'Guardar'}
          </button>
        </div>
      </form>

      {/* El historial de estudios, por fecha (el más reciente arriba). */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        {estudios.length === 0 && (
          <p className="text-center py-6 text-slate-400 text-sm m-0">
            Todavía no hay estudios ni archivos.
          </p>
        )}
        <div className="divide-y divide-slate-100">
          {estudios.map((fu) => (
            <article key={fu._id} className="flex flex-col md:flex-row md:items-start gap-2 md:gap-0 p-4 md:p-0 text-sm">
              <div className="md:w-40 md:shrink-0 md:px-4 md:py-3 text-slate-600 whitespace-nowrap font-medium md:font-normal">
                {fmtDate(fu.fecha)}
                {fu.createdBy?.name && (
                  <span className="text-[11px] text-emerald-700 font-medium ml-2 md:ml-0 md:mt-0.5 md:block">
                    Dr. {fu.createdBy.name}
                  </span>
                )}
                {fu.editedAt && (
                  <span
                    className="text-[10px] text-indigo-600 italic ml-2 md:ml-0 md:mt-0.5 md:block"
                    title={new Date(fu.editedAt).toLocaleString('es-EC')}
                  >
                    Modificado{fu.updatedBy?.name ? ` por ${fu.updatedBy.name}` : ''}
                  </span>
                )}
              </div>
              <div className="flex-1 min-w-0 break-words md:px-4 md:py-3 text-slate-800">
                <div className="font-medium">{fu.descripcion || fu.motivoConsulta || 'Estudio'}</div>
                {fu.indicaciones && (
                  <div className="mt-1.5 text-xs text-slate-700 whitespace-pre-wrap bg-sky-50 border border-sky-100 rounded p-2">
                    <b className="text-sky-700">Impresión diagnóstica:</b> {fu.indicaciones}
                  </div>
                )}
                <div className="mt-2 space-y-1">
                  {(fu.attachments || []).map((att) => (
                    <div key={att._id} className="flex items-center gap-2 text-xs text-slate-600">
                      <span>{String(att.mimeType || '').startsWith('image/') ? '🖼️' : '📎'}</span>
                      <button
                        type="button"
                        onClick={() => setPreviewAtt({ fuId: fu._id, att })}
                        title="Ver el archivo"
                        className="underline text-emerald-700 hover:text-emerald-800 bg-transparent border-none cursor-pointer p-0 text-left"
                      >
                        {att.originalName}
                      </button>
                      <span className="text-slate-400">({Math.round((att.size || 0) / 1024)} KB)</span>
                      <button
                        type="button"
                        onClick={() => downloadFile(
                          `/clinical-records/${patientId}/follow-ups/${fu._id}/attachments/${att._id}`,
                          { filename: att.originalName || 'archivo' }
                        ).catch((err) => toast.error(err.message || 'Error al descargar'))}
                        className="text-slate-400 hover:text-emerald-700 bg-transparent border-none cursor-pointer p-0"
                        title="Descargar"
                      >
                        <HiOutlineArrowDownTray className="w-3.5 h-3.5" />
                      </button>
                      {isAdmin && (
                        <button
                          type="button"
                          onClick={() => borrarAdjunto(fu._id, att._id)}
                          className="text-red-500 bg-transparent border-none cursor-pointer p-0"
                          title="Eliminar"
                        >
                          <HiOutlineTrash className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  ))}
                  <label className="inline-flex items-center gap-1 text-xs text-emerald-700 cursor-pointer mt-1">
                    <HiOutlinePlus className="w-3 h-3" />
                    {subiendoEn === fu._id ? 'Subiendo…' : 'Adjuntar archivos'}
                    <input
                      type="file"
                      accept="application/pdf,image/*"
                      multiple
                      className="hidden"
                      disabled={subiendoEn === fu._id}
                      onChange={(e) => {
                        const files = Array.from(e.target.files || []).filter(isAllowedAttachment);
                        e.target.value = '';
                        if (files.length) adjuntarA(fu._id, files);
                      }}
                    />
                  </label>
                </div>
              </div>
              <div className="md:w-24 md:shrink-0 md:px-4 md:py-3 border-t border-slate-100 pt-2 md:border-t-0 md:pt-0">
                <div className="flex items-center gap-1 md:justify-end">
                  {puedeEditar(fu) && (
                    <button
                      onClick={() => cargarParaEditar(fu)}
                      title="Corregir o ampliar este estudio"
                      className={`p-1 cursor-pointer bg-transparent border-none ${
                        editandoId === fu._id ? 'text-indigo-600' : 'text-slate-500 hover:text-indigo-600'
                      }`}
                    >
                      <HiOutlinePencilSquare className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            </article>
          ))}
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
    </div>
  );
}

// ──────────────── Enfermería: qué se aplicó ────────────────

/**
 * LO QUE ENFERMERÍA PUSO, en su propio parte.
 *
 * La aplicación se guarda dentro de la línea de la receta del DOCTOR que la
 * mandó, así que la tarjeta del turno de enfermería salía diciendo «Servicio
 * aplicado por enfermería» y punto: ni el suero, ni el volumen, ni las ampollas,
 * ni lo que el paciente rechazó. El servidor copia aquí esa información al
 * cerrar el turno (`followUps[].aplicaciones`).
 *
 * Los partes ANTERIORES a este cambio no tienen el arreglo: se degrada en
 * silencio y la tarjeta se queda como estaba, sin un bloque vacío.
 */
function AplicacionesEnfermeria({ lista }) {
  if (!Array.isArray(lista) || lista.length === 0) return null;
  const hhmm = (at) =>
    at ? new Date(at).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Guayaquil' }) : '';

  return (
    <div className="mt-2 bg-sky-50 border border-sky-200 rounded p-2">
      <p className="text-[11px] font-semibold text-sky-700 uppercase mb-1">Lo que se aplicó</p>
      <ul className="text-xs text-slate-700 space-y-1.5 m-0 p-0 list-none">
        {lista.map((a, i) => {
          const puestos = (a.components || []).filter((c) => Number(c.quantityApplied) > 0);
          // Lo que NO se puso es tan clínico como lo que sí: el paciente pudo
          // rechazar una ampolla y eso tiene que quedar escrito con su motivo.
          const omitidos = (a.components || []).filter(
            (c) => Number(c.quantityApplied) < Number(c.quantityPrescribed)
          );
          return (
            <li key={i} className="border-l-2 border-sky-300 pl-2">
              <div className="font-medium text-slate-800">
                {a.itemName || 'Aplicación'}
                {a.at && <span className="font-normal text-slate-500"> · {hhmm(a.at)}</span>}
              </div>
              {a.baseVolumeMl != null && (
                <div className="text-[11px] text-slate-600">
                  {a.baseName || 'Cloruro'} {a.baseVolumeMl} ml
                </div>
              )}
              {puestos.length > 0 && (
                <div className="text-[11px] text-slate-600">
                  {puestos.map((c) => `${c.name}${Number(c.quantityApplied) > 1 ? ` ×${c.quantityApplied}` : ''}`).join(' · ')}
                </div>
              )}
              {omitidos.length > 0 && (
                <div className="text-[11px] text-amber-700">
                  No se aplicó:{' '}
                  {omitidos
                    .map((c) => `${c.name}${c.omitReason ? ` (${c.omitReason})` : ''}`)
                    .join(' · ')}
                </div>
              )}
              {a.note && <div className="text-[11px] text-slate-500 italic">{a.note}</div>}
              {a.byName && <div className="text-[11px] text-sky-700">{a.byName}</div>}
            </li>
          );
        })}
      </ul>
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

  const receta = Array.isArray(item.serumComponents) ? item.serumComponents : [];

  /**
   * QUÉ SE VA A PONER EN ESTA DOSIS.
   *
   * Arranca con TODO lo que recetó el médico marcado: lo normal es ponerlo
   * entero, y obligar a marcar seis casillas cada vez acabaría con alguien
   * dándole a "todas" sin mirar. Lo que hay que poder hacer es lo contrario —
   * quitar la ampolla que el paciente no quiere— y eso es un clic.
   */
  const dosisInicial = () =>
    receta.map((c) => ({
      code: c.code || '',
      name: c.name || '',
      quantityPrescribed: Number(c.quantity) || 0,
      quantityApplied: Number(c.quantity) || 0,
      omitReason: '',
    }));
  const [dosis, setDosis] = useState(dosisInicial);
  // Cloruro que se pone HOY. Arranca en lo recetado, pero se puede cambiar: en la
  // sala puede no haber la bolsa que pidió el médico, y el parte tiene que decir
  // lo que entró de verdad, no lo que estaba escrito.
  const [volumen, setVolumen] = useState(item.serumBase?.volumeMl ?? '');

  const abrirConfirmacion = () => {
    // Se rearma cada vez: la dosis de ayer no puede venir marcada a medias.
    setDosis(dosisInicial());
    setVolumen(item.serumBase?.volumeMl ?? '');
    setNota('');
    setConfirmar(true);
  };

  const setComp = (idx, patch) =>
    setDosis((d) => d.map((c, i) => (i === idx ? { ...c, ...patch } : c)));

  const omitidas = dosis.filter((c) => c.quantityApplied < c.quantityPrescribed);

  const registrar = async () => {
    setBusy(true);
    try {
      const { data } = await api.post(
        `/clinical-records/${patientId}/follow-ups/${followUpId}/receta/${item._id}/administer`,
        {
          note: nota.trim(),
          ...(volumen ? { baseVolumeMl: Number(volumen) } : {}),
          // Solo se manda si el suero TIENE composición: sin ella el servidor
          // debe seguir comportándose como siempre (dosis completa).
          ...(receta.length ? { components: dosis } : {}),
        }
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
        {item.frequency && <span className="text-slate-600">· {item.frequency}</span>}
        {item.duration && <span className="text-slate-600">· {item.duration}</span>}
      </div>

      {/* Enfermería tiene que leer esto ENTERO antes de preparar nada, así que va
          en su propia línea y no de coletilla detrás de la dosis. */}
      {item.instructions && (
        <p className="mt-1 mb-0 text-[11px] text-slate-700 whitespace-pre-wrap">
          <span className="text-slate-400">Indicaciones:</span> {item.instructions}
        </p>
      )}

      {/* Qué lleva la bolsa. Es lo que hay que preparar. */}
      <SueroResumen item={item} className="mt-1.5 rounded border border-sky-200 bg-white/70 px-2 py-1.5" />

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
            onClick={abrirConfirmacion}
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
        <div className="mt-1 text-[11px] text-slate-500">
          <p className="m-0">
            Última: {fmtDateTime(ultima.at)}
            {ultima.byName ? ` · ${ultima.byName}` : ''}
            {ultima.note ? ` · ${ultima.note}` : ''}
          </p>
          {/* Lo que se dejó de poner en la última dosis. Se enseña SIEMPRE que
              hay algo omitido: es la diferencia entre lo recetado y lo que el
              paciente recibió de verdad, y quien mire mañana tiene que verla. */}
          {(ultima.components || []).some((c) => c.quantityApplied < c.quantityPrescribed) && (
            <p className="m-0 mt-0.5 text-amber-700">
              No se aplicó:{' '}
              {(ultima.components || [])
                .filter((c) => c.quantityApplied < c.quantityPrescribed)
                .map((c) => `${c.name}${c.omitReason ? ` (${c.omitReason})` : ''}`)
                .join(' · ')}
            </p>
          )}
        </div>
      )}

      <Modal
        isOpen={confirmar}
        onClose={() => setConfirmar(false)}
        title="Administrar suero"
        size={receta.length ? 'md' : 'sm'}
      >
        <div className="space-y-3">
          <p className="text-sm text-slate-700 m-0">
            ¿Confirmas que se le administró <b>{item.name}</b> al paciente?
          </p>
          <p className="text-xs text-slate-500 m-0">
            Van {puestos} de {recetados}. Con este quedarían {Math.max(0, faltan - 1)} por poner.
          </p>

          {/* El cloruro que se pone hoy. Se puede corregir: si el médico recetó
              1000 ml y en la sala solo hay bolsas de 500, el parte tiene que
              decir 500, no repetir lo que estaba escrito. */}
          <label className="flex flex-wrap items-center gap-2 text-xs text-slate-700">
            <span className="font-medium">{item.serumBase?.name || SUERO_CLORURO_NOMBRE}</span>
            {/* El ancho lo pone el contenedor: `.input` ya trae `width:100%` y
                ponerle una utilidad encima deja el campo a merced de la cascada. */}
            <span className="block w-32">
            <select
              value={volumen}
              onChange={(e) => setVolumen(e.target.value)}
              className="input input-sm cursor-pointer"
            >
              <option value="">Sin consignar</option>
              {SUERO_CLORURO_VOLUMENES.map((v) => (
                <option key={v} value={v}>{v} ml</option>
              ))}
            </select>
            </span>
            {item.serumBase?.volumeMl && Number(volumen) !== item.serumBase.volumeMl && (
              <span className="text-amber-700">Se recetó {item.serumBase.volumeMl} ml</span>
            )}
          </label>

          {/* Lo que recetó el médico, con la casilla puesta. Se desmarca lo que
              el paciente NO quiera: se aplica el resto, queda escrito por qué y
              del inventario sale solo lo que entró en la vena. */}
          {receta.length > 0 && (
            <div className="rounded-xl border border-slate-200 overflow-hidden">
              <p className="m-0 px-3 py-1.5 bg-slate-50 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Qué se le pone
              </p>
              <ul className="m-0 p-0 list-none divide-y divide-slate-100">
                {dosis.map((c, idx) => {
                  const puesta = c.quantityApplied > 0;
                  return (
                    <li key={idx} className="px-3 py-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <input
                          type="checkbox"
                          id={`comp-${item._id}-${idx}`}
                          checked={puesta}
                          onChange={(e) =>
                            setComp(idx, {
                              quantityApplied: e.target.checked ? c.quantityPrescribed : 0,
                              omitReason: e.target.checked ? '' : c.omitReason,
                            })
                          }
                          className="w-4 h-4 accent-sky-600 cursor-pointer"
                        />
                        <label
                          htmlFor={`comp-${item._id}-${idx}`}
                          className={`text-sm cursor-pointer flex-1 min-w-0 ${puesta ? 'text-slate-800' : 'text-slate-400 line-through'}`}
                        >
                          {c.name} <span className="text-slate-400">×{c.quantityPrescribed}</span>
                        </label>
                        {/* Media dosis también existe: recetadas 2, el paciente
                            acepta 1. El campo se queda SIEMPRE que se recetó más
                            de una, marcada o no: si desapareciera al llegar a 0
                            no se podría corregir un 3 borrando para escribir 2
                            —el campo se esfumaba a mitad de la corrección—. */}
                        {c.quantityPrescribed > 1 && (
                          <NumericInput
                            min={0}
                            max={c.quantityPrescribed}
                            value={c.quantityApplied}
                            onChange={(e) => {
                              const v = e.target.value;
                              setComp(idx, {
                                // Vacío mientras se escribe: se guarda 0 pero no
                                // se toca nada más, para que el campo siga ahí.
                                quantityApplied:
                                  v === '' ? 0 : Math.min(c.quantityPrescribed, Math.max(0, Number(v) || 0)),
                              });
                            }}
                            title="Cuántas se pusieron"
                            className={`input text-xs py-1 w-16 ${puesta ? '' : 'text-slate-400'}`}
                          />
                        )}
                      </div>
                      {c.quantityApplied < c.quantityPrescribed && (
                        <input
                          type="text"
                          value={c.omitReason}
                          onChange={(e) => setComp(idx, { omitReason: e.target.value })}
                          placeholder="¿Por qué no se puso? (el paciente no la quiso, no había…)"
                          className="input text-xs py-1 mt-1.5 w-full"
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {omitidas.length > 0 && (
            <p className="m-0 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              Queda registrado que {omitidas.length === 1 ? 'no se aplicó' : 'no se aplicaron'}{' '}
              {omitidas.map((c) => c.name).join(', ')}. Del inventario solo sale lo aplicado.
            </p>
          )}

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

// ──────────────── Terapia (rol terapeuta) ────────────────

function terapiaHasData(t) {
  if (!t) return false;
  return (
    (t.elementos || []).some((e) => String(e?.texto || '').trim())
    // Un esquema con flechas y sin una sola nota SÍ es una consulta: las
    // relaciones que dibujó son el hallazgo.
    || (t.flechas || []).length > 0
    || TERAPIA_FODA_KEYS.some((k) => String(t.foda?.[k] || '').trim())
    || String(t.plan || '').trim()
  );
}

/**
 * LA CONSULTA DEL TERAPEUTA.
 *
 * Tres bloques y ninguno más: los cinco elementos, el reparto en cuatro
 * cuadrantes y el plan escrito. La hoja MSP (examen físico, CIE-10, evolución,
 * revisión por sistemas) no se le enseña — ver `isTerapeuta` en SeguimientosTab.
 */
function TerapiaSection({ value, onChange }) {
  const t = value || {};
  const setFoda = (k, v) => onChange({ ...t, foda: { ...(t.foda || {}), [k]: v } });

  return (
    <div className="md:col-span-3 space-y-4">
      <div className="space-y-2">
        <div className="text-sm font-semibold text-slate-700">Análisis de 5 elementos</div>
        <div className="bg-white rounded-lg border border-slate-200 p-3">
          <CincoElementos value={t} onChange={onChange} />
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-sm font-semibold text-slate-700">Plan de tratamiento terapéutico</div>
        {/**
          * Los cuatro cuadrantes. Se lee como un FODA: el cuadro del paciente
          * repartido en cuatro, y DEBAJO el plan escrito que sale de ese reparto.
          * Por eso el plano va antes que el campo de texto y no al revés.
          */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-px bg-slate-300 border border-slate-300 rounded-lg overflow-hidden">
          {TERAPIA_FODA.map((c) => (
            <div key={c.key} className="bg-white p-2">
              <div className="text-[11px] font-semibold text-slate-600 mb-1">{c.label}</div>
              <textarea
                rows={3}
                value={t.foda?.[c.key] || ''}
                onChange={(e) => setFoda(c.key, e.target.value)}
                className="w-full text-xs border border-slate-200 rounded px-2 py-1 outline-none focus:border-emerald-500 resize-none"
              />
            </div>
          ))}
        </div>
        <textarea
          rows={4}
          value={t.plan || ''}
          onChange={(e) => onChange({ ...t, plan: e.target.value })}
          placeholder="El plan que sale del análisis de arriba"
          className="input resize-none"
        />
      </div>
    </div>
  );
}

function TerapiaSummary({ value }) {
  const t = value || {};
  if (!terapiaHasData(t)) return null;
  const conTexto = (t.elementos || []).filter((e) => String(e.texto || '').trim());
  const cuadrantes = TERAPIA_FODA.filter((c) => String(t.foda?.[c.key] || '').trim());
  // El gráfico se pinta si hay algo QUE PINTAR: notas en los elementos o
  // flechas dibujadas. Con solo flechas también, que es media consulta.
  const hayGrafico = conTexto.length > 0 || (t.flechas || []).length > 0;

  return (
    <SpecialtySummary title="Terapia" tone="violet">
      {hayGrafico && (
        <span className="w-full">
          {/* En lectura se pinta el MISMO gráfico: quien escribió la hoja tiene
              que reconocerla, no leer un resumen que no se le parece. */}
          <div className="bg-white rounded-lg border border-violet-200 p-2 mt-1">
            <CincoElementos value={t} onChange={() => {}} readOnly />
          </div>
        </span>
      )}
      {cuadrantes.map((c) => (
        <span key={c.key} className="w-full whitespace-pre-wrap">
          <b>{c.label}:</b> {t.foda[c.key]}
        </span>
      ))}
      {t.plan && (
        <span className="w-full whitespace-pre-wrap">
          <b>Plan de tratamiento terapéutico:</b> {t.plan}
        </span>
      )}
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

/**
 * El odontograma del historial, MEMOIZADO y plegable.
 *
 * Cada hoja son ~1.300 elementos (52 dientes × 5 caras, las casillas de grado,
 * la tabla de higiene, los índices y la simbología), y el historial monta una
 * por cada consulta de odontología. Sin `memo`, además, se volvían a dibujar
 * TODAS en cada tecla del formulario de arriba: un paciente con diez visitas
 * dejaba la ficha pegajosa al escribir.
 *
 * `fu.odontologia` es una referencia estable mientras no se recargue la ficha,
 * así que `memo` corta el 100% de esos redibujados. Y el botón de plegar deja
 * salida a quien tiene un historial largo: se abre por defecto porque el dibujo
 * es justo lo que se venía a ver.
 */
const OdontogramaLectura = memo(function OdontogramaLectura({ value }) {
  const [abierto, setAbierto] = useState(true);
  return (
    <div className="w-full bg-white rounded-lg border border-cyan-200 p-2 mb-1">
      <button
        type="button"
        onClick={() => setAbierto((v) => !v)}
        className="text-[11px] text-cyan-700 font-semibold bg-transparent border-none cursor-pointer p-0 mb-1"
      >
        {abierto ? '▾ Ocultar el odontograma' : '▸ Ver el odontograma'}
      </button>
      {abierto && <Odontograma value={value} onChange={() => {}} readOnly />}
    </div>
  );
});

/**
 * El odontograma en el HISTORIAL, dibujado igual que al llenarlo.
 *
 * Antes aquí salía solo un resumen en texto («11 Caries (Vestibular: Caries)»)
 * y el odontólogo no reconocía su propia hoja: lo que había dibujado y lo que
 * leía después no se parecían en nada. Ahora se monta el MISMO componente en
 * modo lectura — mismo esquema, mismos indicadores, misma simbología — y el
 * resumen de texto se queda DEBAJO, que es lo que hace el dato buscable y
 * copiable (y lo único que se ve si el seguimiento es antiguo).
 */
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
      {/* La hoja, tal cual se llenó. `w-full` porque el resumen es un flex de
          chips y el dibujo tiene que ocupar su propia fila entera. */}
      <OdontogramaLectura value={o} />
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
