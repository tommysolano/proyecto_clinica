import { useState, useEffect, useRef, useMemo, Fragment } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/axios';
import Modal from '../components/Modal';
import { downloadFile } from '../utils/download';
import ProductAutocomplete from '../components/ProductAutocomplete';
import ServiceItemPicker from '../components/ServiceItemPicker';
import { inicioDeMiTurno } from '../utils/appointmentTurns';
import SameSlotPanel from '../components/SameSlotPanel';
import AssignAttentionModal from '../components/AssignAttentionModal';
import AppointmentServiceValueModal from '../components/AppointmentServiceValueModal';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { useSocketEvent } from '../context/SocketContext';
import { fmtDateTime, fmtTimeEc, todayEc, nowEcHHMM } from '../utils/date';
import NumericInput from '../components/NumericInput';
import {
  HiOutlinePlus,
  HiOutlinePencil,
  HiOutlineTrash,
  HiOutlineEye,
  HiOutlineDocumentArrowDown,
  HiOutlinePlay,
  HiOutlineStop,
  HiOutlineMagnifyingGlass,
  HiOutlineUserPlus,
  HiOutlineAdjustmentsHorizontal,
  HiOutlineChevronDown,
} from 'react-icons/hi2';
import DateInput from '../components/DateInput';
import TimeSlotInput from '../components/TimeSlotInput';
import { doctorOptionLabel, roleSatisfies, ROLE_LABELS } from '../utils/roles';

// 6 estados soportados por el backend.
const statusColors = {
  pendiente: 'bg-slate-100 text-slate-700',
  confirmada: 'bg-blue-100 text-blue-700',
  asistida: 'bg-emerald-100 text-emerald-700',
  no_asistio: 'bg-rose-100 text-rose-700',
  cancelada: 'bg-amber-100 text-amber-700',
  completada: 'bg-teal-100 text-teal-700',
};

const statusLabels = {
  pendiente: 'Pendiente',
  confirmada: 'Confirmada',
  asistida: 'Asistida',
  no_asistio: 'No asistió',
  cancelada: 'Cancelada',
  completada: 'Completada',
};

const normalizeStatus = (s) => {
  const valid = ['pendiente', 'confirmada', 'asistida', 'no_asistio', 'cancelada', 'completada'];
  return valid.includes(s) ? s : 'pendiente';
};

const emptyForm = {
  patient: '',
  // El doctor YA NO se asigna al crear la cita; lo asigna recepción al marcar 'asistida'.
  doctor: '',
  date: '',
  startTime: '',
  // endTime eliminado del flujo de creación
  status: 'pendiente',
  reason: '',
  notes: '',
  diagnosis: '',
  treatment: '',
  // Servicio del catálogo propio de la agenda: { _id, name } o null.
  serviceItem: null,
  clinic: '',
  // Citas adicionales para agendar en una sola operación (solo al crear).
  // Cada entrada: { date, startTime, reason, services: [productId] }
  extraAppointments: [],
};

const roleLabels = ROLE_LABELS;

/**
 * Quién agendó la cita, con su rol. Tres fuentes, en este orden:
 *  1. el usuario poblado — lo normal;
 *  2. `createdByName`, el snapshot — cubre a quien ya no está en el sistema;
 *  3. `createdByRole === 'online'` — la reserva que hizo el propio paciente por
 *     internet, que no tiene usuario detrás y antes no mostraba nada.
 */
function quienAgendo(apt) {
  if (!apt) return '';
  if (apt.createdByRole === 'online' && !apt.createdBy) return 'El paciente (reserva online)';
  const nombre = apt.createdBy?.name || apt.createdByName || '';
  if (!nombre) return '';
  const rol = apt.createdByRole ? roleLabels[apt.createdByRole] || apt.createdByRole : '';
  return rol ? `${nombre} (${rol})` : nombre;
}

/** Quién movió la cita la última vez, y cuándo. */
function ultimoReagendamiento(apt) {
  const h = apt?.rescheduleHistory;
  if (!Array.isArray(h) || !h.length) return '';
  const ultimo = h[h.length - 1];
  const nombre = ultimo.rescheduledByName || ultimo.rescheduledBy?.name || 'alguien';
  const rol = ultimo.rescheduledByRole ? roleLabels[ultimo.rescheduledByRole] || ultimo.rescheduledByRole : '';
  const cuando = ultimo.at ? new Date(ultimo.at).toLocaleDateString('es-EC') : '';
  return `${nombre}${rol ? ` (${rol})` : ''}${cuando ? ` · ${cuando}` : ''}`;
}

/** Servicio de la cita: el del catálogo de agenda y, si no, el del inventario. */
function nombreServicio(apt) {
  if (!apt) return '';
  return (
    apt.serviceName ||
    apt.serviceItem?.name ||
    (apt.services || []).map((s) => s.name || s.product?.name).filter(Boolean).join(', ')
  );
}

/** Los OTROS servicios de la visita, sin el principal. Nombres, ya en snapshot. */
function serviciosExtra(apt) {
  return (apt?.additionalServices || [])
    .map((s) => s.name || s.serviceItem?.name)
    .filter(Boolean);
}

/**
 * A QUÉ HORA se atendió de verdad, frente a la hora agendada.
 *
 * No hay un único campo que lo diga porque la atención no siempre se cronometra:
 *  · el reloj de la cita (`consultationStartedAt`) lo pone el doctor al pulsar
 *    «iniciar consulta» o el enfermero al reclamar el turno, y muchos no pulsan
 *    nada: entran, atienden y guardan el seguimiento;
 *  · los turnos guardan su propio `startedAt`, que existe aunque el reloj de la
 *    cita no se haya arrancado;
 *  · el cierre (`consultationEndedAt`) sí se escribe SIEMPRE al completar.
 *
 * Por eso se devuelven las dos puntas y quien pinta decide: con inicio se dice
 * «atendida a las…», y cuando solo hay cierre se dice «terminó a las…» en vez de
 * hacer pasar el final por el principio, que es la lectura que importa —cuánto
 * esperó el paciente— y sería justo la equivocada.
 */
function horaAtencion(apt) {
  if (!apt) return null;
  const fechas = (lista) => lista.map((v) => (v ? new Date(v) : null)).filter((d) => d && !Number.isNaN(d.getTime()));
  const turnos = apt.turns || [];

  const inicios = fechas([apt.consultationStartedAt, apt.nurseClaimedAt, ...turnos.map((t) => t.startedAt)]);
  const finales = fechas([apt.consultationEndedAt, apt.nurseAttendedAt, ...turnos.map((t) => t.completedAt)]);

  const inicio = inicios.length ? new Date(Math.min(...inicios)) : null;
  const fin = finales.length ? new Date(Math.max(...finales)) : null;
  if (!inicio && !fin) return null;
  return { inicio, fin };
}

/** Texto corto de la atención para la columna de la hora, o null si no la hubo. */
function textoAtencion(apt) {
  const a = horaAtencion(apt);
  if (!a) return null;
  if (a.inicio) {
    const desde = fmtTimeEc(a.inicio);
    const hasta = a.fin && a.fin.getTime() !== a.inicio.getTime() ? fmtTimeEc(a.fin) : '';
    return {
      texto: `Atendida ${desde}`,
      detalle: hasta ? `Atendida de ${desde} a ${hasta}` : `Atendida a las ${desde}`,
    };
  }
  const hasta = fmtTimeEc(a.fin);
  return { texto: `Terminó ${hasta}`, detalle: `Se terminó de atender a las ${hasta}` };
}

// Formatea una fecha ISO usando los componentes de fecha (sin convertir a UTC).
const formatLocalDate = (iso) => {
  if (!iso) return '';
  const str = String(iso);
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const [, y, mo, d] = m;
    return `${d}/${mo}/${y}`;
  }
  const dt = new Date(str);
  return Number.isNaN(dt.getTime()) ? '' : dt.toLocaleDateString('es-EC');
};

// YYYY-MM-DD a partir de componentes locales (sin desfase UTC).
const toYmd = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const MONTH_NAMES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];
const WEEKDAY_NAMES = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

// Convierte HH:MM a minutos
const hhmmToMin = (s) => {
  if (!s) return null;
  const m = String(s).match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
};


export default function Appointments() {
  const navigate = useNavigate();
  const { user, role, hasRole, activeClinic, clinics } = useAuth();
  // Espacios de la agenda de esta sucursal: 0 = cualquier hora (Configuración → Agenda).
  const slotMinutes = Number(activeClinic?.appointmentSlotMinutes) || 0;
  const canWrite = hasRole('admin', 'cajero', 'call_center');
  const isAdmin = hasRole('admin') || user?.isSuperAdmin;
  // 'optica' no se expande desde 'doctor' en el cliente, por eso va aparte.
  const isDoctor = roleSatisfies(role, ['doctor']) || role === 'optica';
  const isNurse = role === 'enfermero';
  const isCallCenter = role === 'call_center';
  const isReception = hasRole('admin', 'cajero', 'enfermero');
  // Quién puede ejecutar el flujo asistir → cobrar → derivar (requiere cobrar).
  const canCharge = hasRole('admin', 'cajero');
  // Mostrar selector de clínica si el usuario tiene más de una asignada
  const showClinicSelector = (clinics?.length || 0) > 1;

  const [appointments, setAppointments] = useState([]);
  const [doctors, setDoctors] = useState([]);
  // Enfermeros de la sucursal, para poder nombrar un turno de enfermería en vez
  // de dejarlo abierto a todos.
  const [nurses, setNurses] = useState([]);
  const [patients, setPatients] = useState([]);
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [detailModal, setDetailModal] = useState(null);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  // Modal para asignar doctor al marcar 'asistida'
  const [assignModal, setAssignModal] = useState(null); // { appointment }
  // Corregir el servicio y el valor de una cita, incluso ya completada. Es lo
  // único que mostrador puede tocar después de que el paciente fue atendido.
  const [serviceValueModal, setServiceValueModal] = useState(null); // cita
  /**
   * Filtros secundarios plegados EN EL MÓVIL (en pantalla grande siempre se ven).
   * Desplegados ocupaban media pantalla y empujaban las citas —que es a lo que
   * se entra— fuera de la vista. Lo que queda siempre a mano es lo que se usa
   * en cada visita: el buscador y el día.
   */
  const [filtrosAbiertos, setFiltrosAbiertos] = useState(false);
  // Modal de finalización de enfermería (cita reclamada por el enfermero)
  const [filter, setFilter] = useState({
    startDate: '',
    endDate: '',
    status: '',
    isFirstVisit: '',
    clinic: '',
    service: '',
    timeFrom: '',
    timeTo: '',
    patientQuery: '',
  });
  const [view, setView] = useState(isDoctor || isNurse ? 'list' : 'calendar'); // 'calendar' | 'list'
  // Mes visible en la vista calendario
  const [calMonth, setCalMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  // Día seleccionado en la vista lista (YYYY-MM-DD). La lista muestra solo ese día.
  const [listDay, setListDay] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const [patientSearch, setPatientSearch] = useState('');
  const [showPatientList, setShowPatientList] = useState(false);
  const [patientSearchLoading, setPatientSearchLoading] = useState(false);
  const [patientSearchError, setPatientSearchError] = useState(false);
  // Impide que una respuesta lenta de una búsqueda anterior reemplace a la
  // respuesta del texto que el usuario tiene escrito en este momento.
  const patientRequestRef = useRef(0);

  const [now, setNow] = useState(Date.now());
  const [timeUpModal, setTimeUpModal] = useState(null);
  const notifiedRef = useRef(new Set());

  /**
   * SECUENCIA DE PETICIONES.
   *
   * Sin esto, la lista enseñaba citas de OTRO día. Dos formas, las dos reales:
   *
   *  1. Respuestas fuera de orden. Se pulsa «día siguiente» dos veces seguidas y
   *     salen dos peticiones; si la primera tarda más que la segunda, llega
   *     DESPUÉS y pisa la lista buena. La pantalla se queda con las citas de un
   *     día que ya nadie está mirando.
   *  2. El día se quedaba en blanco mientras cargaba: como `loading` solo se
   *     apagaba y nunca se volvía a encender, entre pulsar y recibir se seguían
   *     viendo las citas del día anterior como si fueran las nuevas.
   *
   * Cada petición se numera y solo la ÚLTIMA puede escribir en el estado.
   */
  const peticionRef = useRef(0);
  /**
   * A QUÉ CORRESPONDE lo que hay pintado ahora mismo.
   *
   * El «Cargando…» solo se enseña cuando cambia el PERIODO que se mira (otro
   * día, otro mes, otra vista): ahí lo que está en pantalla es de otro momento y
   * dejarlo puesto es justo el error que se venía a arreglar.
   *
   * En un refresco del MISMO periodo —una tecla en el buscador, un evento de
   * socket— la lista se queda a la vista. Vaciarla en cada pulsación hacía
   * parpadear la tabla mientras se escribe el nombre de un paciente.
   */
  const periodoRef = useRef(null);

  const fetchAppointments = async () => {
    const miTurno = ++peticionRef.current;
    const periodo = view === 'calendar'
      ? `mes:${calMonth.getFullYear()}-${calMonth.getMonth()}`
      : `dia:${listDay}`;
    if (periodoRef.current !== periodo) {
      periodoRef.current = periodo;
      setLoading(true);
    }
    try {
      const params = {};
      if (view === 'calendar') {
        // Trae todas las citas del mes visible para pintarlas en la cuadrícula.
        const first = new Date(calMonth.getFullYear(), calMonth.getMonth(), 1);
        const last = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 0);
        params.startDate = toYmd(first);
        params.endDate = toYmd(last);
        if (filter.status) params.status = filter.status;
      } else {
        // Lista = un solo día (navegable por flechas).
        params.startDate = listDay;
        params.endDate = listDay;
        if (filter.status) params.status = filter.status;
      }
      if (filter.isFirstVisit) params.isFirstVisit = filter.isFirstVisit;
      if (filter.patientQuery && filter.patientQuery.trim()) params.q = filter.patientQuery.trim();
      // Vista unificada: trae las citas de TODAS las sucursales del usuario para que
      // ninguna quede oculta por la sucursal activa (la cita puede tener otra
      // "sucursal destino"). Cada tarjeta muestra a qué sucursal pertenece.
      params.clinic = 'all';
      const res = await api.get('/appointments', { params });
      // Llegó tarde: ya hay otra petición más nueva en marcha (o resuelta). Su
      // respuesta es de un día que el usuario ya dejó atrás.
      if (miTurno !== peticionRef.current) return;
      const list = (res.data || []).map((a) => ({
        ...a,
        status: normalizeStatus(a.status),
      }));
      setAppointments(list);
    } catch {
      if (miTurno !== peticionRef.current) return;
      toast.error('Error al cargar citas');
    } finally {
      if (miTurno === peticionRef.current) setLoading(false);
    }
  };

  const fetchDoctors = async () => {
    try {
      const res = await api.get('/users/doctors');
      setDoctors(res.data);
    } catch {
      // silent
    }
  };

  /**
   * SUCURSALES PARA EL FILTRO.
   *
   * `clinics` (del contexto) son solo las ASIGNADAS al usuario, y el cajero
   * suele tener una sola: por eso el filtro por sucursal no le aparecía nunca.
   * Mostrador y administración piden aquí la lista completa de la organización
   * —solo nombres, ver `scope=names` en clinicController—; el resto de roles se
   * queda con las suyas, como hasta ahora.
   */
  const [clinicasFiltro, setClinicasFiltro] = useState([]);
  const fetchClinicasFiltro = async () => {
    if (!canCharge) { setClinicasFiltro(clinics || []); return; }
    try {
      const res = await api.get('/clinics', { params: { scope: 'names' } });
      setClinicasFiltro(res.data || []);
    } catch {
      // Sin la lista completa se sigue pudiendo filtrar por las propias.
      setClinicasFiltro(clinics || []);
    }
  };

  /**
   * LA VISTA POR DEFECTO NO CAMBIA: SU SUCURSAL.
   *
   * El servidor ahora le devuelve a mostrador la agenda de TODA la organización,
   * y sin esto la cajera de Norte abriría la lista del día y se encontraría
   * mezcladas las citas de Sur y Centro — «Total filtrado: 37» donde antes veía
   * 9. Ver las demás sucursales es algo que se PIDE con el desplegable, no algo
   * que aparezca solo.
   *
   * Se preselecciona a quien AHORA VE MÁS de lo que veía antes, tenga una
   * sucursal asignada o cinco: la comparación es contra las suyas, no contra el
   * número uno. Quien ya veía todas las de la organización no nota nada.
   */
  useEffect(() => {
    if (!canCharge) return;
    const propia = activeClinic?._id;
    if (!propia) return;
    if (clinicasFiltro.length <= (clinics?.length || 0)) return;
    setFilter((f) => (f.clinic ? f : { ...f, clinic: propia }));
  }, [canCharge, clinics?.length, activeClinic?._id, clinicasFiltro.length]);

  const fetchNurses = async () => {
    try {
      const res = await api.get('/users/nurses');
      setNurses(res.data);
    } catch {
      // silent: sin la lista, el turno sigue pudiendo quedar abierto a todos.
    }
  };

  const fetchServices = async () => {
    try {
      const res = await api.get('/products', { params: { limit: 500 } });
      // Incluir también los programas (paquetes de varios servicios) al agendar.
      const list = (res.data || []).filter(
        (p) => p.active !== false && (p.category === 'servicio' || p.category === 'programa' || p.unlimited === true)
      );
      setServices(list);
    } catch {
      // silent
    }
  };

  useEffect(() => {
    fetchDoctors();
    fetchNurses();
    fetchServices();
    fetchClinicasFiltro();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * BUSCADOR DE PACIENTES DE LA CITA.
   *
   * Antes la agenda descargaba solo los 1.000 pacientes más recientes y
   * filtraba ese recorte en el navegador. Un paciente más antiguo seguía
   * apareciendo en Clientes —que sí busca en el servidor—, pero aquí era
   * imposible encontrarlo incluso escribiendo su cédula exacta.
   *
   * Ahora cada texto se busca en la colección completa mediante el mismo
   * endpoint de Clientes. El pequeño debounce evita una petición por tecla y el
   * número de turno evita que respuestas fuera de orden pinten resultados viejos.
   */
  useEffect(() => {
    const miTurno = ++patientRequestRef.current;
    if (!modalOpen || form.patient) {
      setPatientSearchLoading(false);
      return undefined;
    }

    const controller = new AbortController();
    const search = patientSearch.trim();
    setPatientSearchLoading(true);
    setPatientSearchError(false);

    const timer = setTimeout(async () => {
      try {
        const res = await api.get('/patients', {
          params: { limit: 30, ...(search ? { search } : {}) },
          signal: controller.signal,
        });
        if (miTurno !== patientRequestRef.current) return;
        setPatients(res.data?.patients || []);
      } catch {
        if (miTurno !== patientRequestRef.current || controller.signal.aborted) return;
        setPatients([]);
        setPatientSearchError(true);
      } finally {
        if (miTurno === patientRequestRef.current) setPatientSearchLoading(false);
      }
    }, 250);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [modalOpen, patientSearch, form.patient]);

  useEffect(() => {
    fetchAppointments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, filter, calMonth, listDay]);

  /**
   * Tiempo real: cuando llega un cambio de cita, refrescar la lista.
   *
   * VA POR REF, y no directo. `useSocketEvent` se suscribe UNA vez (sus `deps`
   * están vacías) y se quedaba con el `fetchAppointments` del PRIMER render —el
   * que tiene dentro `listDay = hoy` y la vista inicial—. Resultado: el usuario
   * abría el día 12, alguien tocaba cualquier cita en la clínica, y la lista se
   * repintaba sola con las citas de HOY sin que él hubiera hecho nada. Ese era el
   * «me muestra citas que no son de ese día».
   *
   * La ref siempre apunta a la función del render actual, así que el refresco
   * recarga el día que se está mirando.
   */
  const fetchRef = useRef(fetchAppointments);
  fetchRef.current = fetchAppointments;
  useSocketEvent('appointment:created', () => fetchRef.current());
  useSocketEvent('appointment:updated', () => fetchRef.current());
  useSocketEvent('appointment:deleted', () => fetchRef.current());

  // Tick global del cronómetro (1s)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  /**
   * Aviso de «tiempo de consulta finalizado».
   *
   * Tenía dos fallos que lo hacían saltar cuando no tocaba:
   *
   *  1. SIN HORA DE FIN saltaba SIEMPRE, al instante. `hhmmToMin('')` devuelve
   *     null y `null - startMin` da un número NEGATIVO, así que la condición se
   *     cumplía en el primer tic. Y la hora de fin se quitó del formulario de
   *     agendar, o sea que le pasaba a TODAS las citas nuevas. Sin duración
   *     programada no hay nada que avisar.
   *  2. Le salía al SEGUNDO doctor con el reloj del primero, porque
   *     `consultationStartedAt` es de la cita entera. Ahora se mide desde que
   *     empezó SU turno, y solo se avisa a quien tiene el turno vigente —
   *     nunca a enfermería, que no lleva cronómetro.
   */
  useEffect(() => {
    if (!isDoctor || isNurse) return;
    appointments.forEach((apt) => {
      if (apt.consultationEndedAt || apt.status === 'completada') return;
      // Solo a quien le toca ahora.
      if (String(apt.currentTurnUser?._id || apt.currentTurnUser || '') !== String(user?.id)) return;

      const startMin = hhmmToMin(apt.startTime);
      const endMin = hhmmToMin(apt.endTime);
      if (startMin == null || endMin == null || endMin <= startMin) return;

      const inicio = inicioDeMiTurno(apt);
      if (!inicio) return;

      const durationMs = (endMin - startMin) * 60 * 1000;
      if (now - inicio >= durationMs && !notifiedRef.current.has(apt._id)) {
        notifiedRef.current.add(apt._id);
        setTimeUpModal(apt);
      }
    });
  }, [now, appointments, isDoctor, isNurse, user?.id]);

  const canEdit = (apt) => {
    // Una cita completada solo puede ser editada por administradores
    if (apt.status === 'completada' && !isAdmin) return false;
    if (isAdmin) return true;
    if (isDoctor && String(apt.doctor?._id || apt.doctor) === String(user?.id)) return true;
    return String(apt.createdBy?._id || apt.createdBy) === String(user?.id);
  };

  // Cita que se está editando: hace falta su estado real (no solo el del
  // formulario) para saber si el doctor todavía se puede reasignar.
  const editingAppointment = editing ? appointments.find((a) => a._id === editing) : null;
  // Una vez atendida, el doctor queda fijo: la consulta y su comisión ya son
  // suyas. El backend aplica la misma regla; esto solo evita el intento.
  const doctorLocked =
    !!editingAppointment?.doctor &&
    (editingAppointment.status === 'completada' || !!editingAppointment.consultationEndedAt);

  const openNew = () => {
    setEditing(null);
    setForm({
      ...emptyForm,
      clinic: activeClinic?._id || '',
    });
    setPatients([]);
    setPatientSearch('');
    setPatientSearchError(false);
    setModalOpen(true);
  };

  const openEdit = (apt) => {
    if (!canEdit(apt)) {
      toast.error('Solo el creador o un administrador puede editar esta cita.');
      return;
    }
    setEditing(apt._id);
    setForm({
      patient: apt.patient?._id || '',
      doctor: apt.doctor?._id || '',
      date: apt.date ? apt.date.split('T')[0] : '',
      startTime: apt.startTime,
      endTime: apt.endTime,
      status: normalizeStatus(apt.status),
      reason: apt.reason || '',
      notes: apt.notes || '',
      diagnosis: apt.diagnosis || '',
      treatment: apt.treatment || '',
      // El servicio viene poblado del servidor; si la cita es anterior al
      // catálogo propio, se muestra el nombre que tenga guardado.
      serviceItem: apt.serviceItem
        ? { _id: apt.serviceItem._id || apt.serviceItem, name: apt.serviceItem.name || apt.serviceName || '' }
        : null,
      clinic: apt.clinic || activeClinic?._id || '',
    });
    setPatientSearch(
      apt.patient
        ? [`${apt.patient.firstName} ${apt.patient.lastName}`, apt.patient.cedula].filter(Boolean).join(' - ')
        : ''
    );
    setModalOpen(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.patient) {
      toast.error('Selecciona un paciente');
      return;
    }
    // El servicio dejó de ser obligatorio para poder agendar: se puede citar a
    // alguien y decidir después a qué viene.
    setSaving(true);
    try {
      const basePayload = {
        ...form,
        serviceItem: form.serviceItem?._id || null,
      };
      //  (inventario) ya no se manda: enviarlo vacío BORRARÍA los de
      // una cita antigua que se esté editando, y con ellos su cobro.
      delete basePayload.services;
      delete basePayload.extraAppointments;
      if (!basePayload.endTime) delete basePayload.endTime;
      if (editing) {
        await api.put(`/appointments/${editing}`, basePayload);
        toast.success('Cita actualizada');
      } else {
        // Primero la cita principal
        await api.post('/appointments', basePayload);
        // Luego cada cita adicional con los mismos datos compartidos
        const extras = (form.extraAppointments || []).filter((it) => it.date && it.startTime);
        for (const it of extras) {
          const extraPayload = {
            ...basePayload,
            date: it.date,
            startTime: it.startTime,
            reason: it.reason || basePayload.reason,
            // Cada cita adicional puede llevar su propio servicio; si no se
            // eligió, hereda el de la principal.
            serviceItem: it.serviceItem?._id || basePayload.serviceItem || null,
          };
          await api.post('/appointments', extraPayload);
        }
        const totalCreated = 1 + extras.length;
        toast.success(totalCreated > 1 ? `${totalCreated} citas creadas` : 'Cita creada');
      }
      setModalOpen(false);
      fetchAppointments();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (apt) => {
    if (!canEdit(apt)) {
      toast.error('Solo el creador o un administrador puede eliminar esta cita.');
      return;
    }
    if (!window.confirm('¿Eliminar esta cita?')) return;
    try {
      await api.delete(`/appointments/${apt._id}`);
      toast.success('Cita eliminada');
      fetchAppointments();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al eliminar');
    }
  };

  const handleChange = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  const downloadPdf = async (id) => {
    try {
      await downloadFile(`/appointments/${id}/pdf`, { filename: `cita_${id}.pdf` });
    } catch (err) {
      toast.error(err.message || 'Error al descargar PDF');
    }
  };

  const exportExcel = async () => {
    try {
      const params = {};
      if (view === 'calendar') {
        const first = new Date(calMonth.getFullYear(), calMonth.getMonth(), 1);
        const last = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 0);
        params.startDate = toYmd(first);
        params.endDate = toYmd(last);
        if (filter.status) params.status = filter.status;
      } else {
        params.startDate = listDay;
        params.endDate = listDay;
        if (filter.status) params.status = filter.status;
      }
      await downloadFile('/reports/appointments.xlsx', { params, filename: `citas_${Date.now()}.xlsx` });
    } catch (err) {
      toast.error(err.message || 'Error al exportar');
    }
  };

  const openDetail = async (id) => {
    try {
      const res = await api.get(`/appointments/${id}`);
      setDetailModal({ ...res.data, status: normalizeStatus(res.data.status) });
    } catch {
      toast.error('Error al cargar detalle');
    }
  };

  const startConsultation = async (apt) => {
    try {
      await api.post(`/appointments/${apt._id}/start`);
      toast.success('Consulta iniciada');
      fetchAppointments();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al iniciar');
    }
  };

  const endConsultation = async (apt) => {
    try {
      await api.post(`/appointments/${apt._id}/end`);
      toast.success('Consulta finalizada');
      fetchAppointments();
      setTimeUpModal(null);
      notifiedRef.current.delete(apt._id);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al finalizar');
    }
  };

  /**
   * El enfermero toma la cita y ENTRA A LA FICHA, igual que un doctor.
   *
   * Antes solo se la quedaba y salía un aviso; había que buscar otro botón para
   * un modal que apuntaba signos vitales y cerraba la cita sin seguimiento. Los
   * enfermeros escriben su propio seguimiento, así que el camino es el mismo que
   * el del doctor: reclamar, abrir la ficha y guardar. Ese guardado cierra su
   * turno y, si detrás hay alguien, le pasa la cita.
   */
  const nurseClaim = async (apt) => {
    if (!window.confirm(`¿Confirmas que vas a atender a ${apt.patient?.firstName || ''} ${apt.patient?.lastName || ''}?`)) return;
    try {
      await api.post(`/appointments/${apt._id}/nurse-claim`);
      abrirAtencion(apt);
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo reclamar la cita');
      // Si otro se le adelantó (409), la lista tiene que reflejarlo ya.
      fetchAppointments();
    }
  };

  /**
   * Enfermería termina su parte.
   *
   * No redacta el seguimiento —eso es de quien atiende la consulta—, así que su
   * turno se cierra desde aquí: queda constancia de la aplicación y, si detrás
   * hay un doctor, la cita pasa a sus manos en ese momento.
   */
  const nurseFinish = async (apt) => {
    if (!window.confirm(`¿Terminaste con ${apt.patient?.firstName || 'el paciente'}?`)) return;
    try {
      await api.post(`/appointments/${apt._id}/nurse-complete`, {});
      toast.success('Atención registrada');
      fetchAppointments();
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo finalizar');
    }
  };

  /**
   * Abre la ficha del paciente para atender esta cita (doctores y enfermería).
   *
   * El cronómetro solo se arranca para el doctor: enfermería no lo usa y esa
   * ruta además es suya (`requireRole('admin', 'doctor')`), así que llamarla
   * como enfermero solo dejaría un 403 en el camino.
   */
  const abrirAtencion = (apt, opciones = {}) => {
    /**
     * El cronómetro NO se arranca al volver a entrar en una cita ya completada.
     *
     * `POST /appointments/:id/start` limpia `consultationEndedAt`: si se llamara
     * al reentrar a corregir un seguimiento, la consulta volvería a figurar como
     * abierta —con su reloj corriendo— para algo que terminó hace dos días.
     * Corregir no es reabrir la atención.
     */
    const soloVolver = opciones.soloVolver || apt.status === 'completada';
    // Se arranca si MI turno no ha empezado, no si la cita no ha empezado: con
    // varios profesionales, el segundo tiene su propio reloj desde cero.
    if (!soloVolver && !isNurse && !inicioDeMiTurno(apt)) {
      api.post(`/appointments/${apt._id}/start`).catch(() => {});
    }
    // Enfermería entra a Seguimientos a leer la receta y anotar los sueros; el
    // doctor abre por la ficha, donde repasa antecedentes antes de la consulta.
    // Al VOLVER, en cambio, se entra directo a seguimientos: a lo que se vuelve
    // es a lo que se escribió, no a los antecedentes.
    const destino = opciones.tab || (isNurse || soloVolver ? 'seguimientos' : 'ficha');
    navigate(`/patients/${apt.patient?._id}?appointment=${apt._id}&tab=${destino}`);
  };

  const handlePatientSelect = (p) => {
    setForm((f) => ({ ...f, patient: p._id }));
    setPatientSearch([`${p.firstName} ${p.lastName}`, p.cedula].filter(Boolean).join(' - '));
    setShowPatientList(false);
  };

  // Aplica filtros en el cliente para servicio/sucursal/rango horario.
  // Ordena cronológicamente (por fecha y hora) para verlas en forma de HORARIO,
  // no en el orden en que se agendaron.
  const filteredAppointments = useMemo(() => {
    return appointments
      .filter((apt) => {
        if (filter.service) {
          const has = (apt.services || []).some(
            (s) => String(s.product?._id || s.product) === String(filter.service)
          );
          if (!has) return false;
        }
        if (filter.clinic) {
          const c = apt.clinic?._id || apt.clinic;
          if (String(c) !== String(filter.clinic)) return false;
        }
        if (filter.timeFrom && apt.startTime && apt.startTime < filter.timeFrom) return false;
        if (filter.timeTo && apt.startTime && apt.startTime > filter.timeTo) return false;
        return true;
      })
      .sort((a, b) => {
        const da = new Date(a.date).getTime();
        const db = new Date(b.date).getTime();
        if (da !== db) return da - db;
        return String(a.startTime || '').localeCompare(String(b.startTime || ''));
      });
  }, [appointments, filter.service, filter.clinic, filter.timeFrom, filter.timeTo]);

  /**
   * Cuántos filtros SECUNDARIOS están puestos. Es lo que lleva el globito del
   * botón "Filtros" del móvil: plegados, un filtro olvidado explicaría una lista
   * vacía sin que se vea por qué.
   *
   * El buscador de paciente no cuenta: su campo está siempre a la vista.
   */
  const filtrosActivos = [
    filter.status, filter.isFirstVisit, filter.clinic,
    filter.service, filter.timeFrom, filter.timeTo,
  ].filter(Boolean).length;

  // Agrupa las citas (ya filtradas) por día YYYY-MM-DD para pintar la cuadrícula.
  const calApptsByDay = useMemo(() => {
    const map = new Map();
    filteredAppointments.forEach((a) => {
      const k = String(a.date || '').slice(0, 10);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(a);
    });
    return map;
  }, [filteredAppointments]);

  // Celdas del mes (con relleno para alinear a lunes). null = celda vacía.
  const calendarCells = useMemo(() => {
    const year = calMonth.getFullYear();
    const month = calMonth.getMonth();
    const first = new Date(year, month, 1);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const leading = (first.getDay() + 6) % 7; // lunes = 0
    const cells = [];
    for (let i = 0; i < leading; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [calMonth]);

  const moveMonth = (dir) => {
    setCalMonth((m) => new Date(m.getFullYear(), m.getMonth() + dir, 1));
  };

  // Click en un día del calendario → ver la tabla de ese día (orden por horario).
  const openDay = (d) => {
    setListDay(toYmd(d));
    setView('list');
  };

  // Navegación de día (vista lista): ±1 día.
  const moveDay = (delta) => {
    setListDay((cur) => {
      const [y, m, d] = cur.split('-').map(Number);
      const nd = new Date(y, m - 1, d + delta);
      return toYmd(nd);
    });
  };

  // Cronómetro de la cita: cuenta desde que empezó EL TURNO en curso, no desde
  // que el primer profesional abrió la consulta.
  const elapsedSeconds = (apt) => {
    const start = inicioDeMiTurno(apt);
    if (!start) return 0;
    return Math.max(0, Math.floor((now - start) / 1000));
  };

  const fmtSeconds = (s) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  };

  return (
    <div>
      {/**
        * SIN TÍTULO. La barra superior de la app ya dice «Calendario y Citas»
        * (sale del propio menú, ver `pageTitle` en Layout.jsx): repetirlo aquí a
        * tamaño grande, con un subtítulo que no aporta nada, gastaba dos filas
        * justo encima de lo único que se viene a mirar — la tabla del día. En un
        * portátil eso era la diferencia entre ver cuatro citas y ver ocho.
        */}
      <div className="flex flex-row items-center justify-end gap-2 mb-2 sm:mb-3">
        <div className="flex gap-2">
          {/* Enfermería, como los doctores, solo ve el día que tiene delante:
              el calendario del mes le llena la pantalla de días que no trabaja. */}
          {!isDoctor && !isNurse && (
            <div className="inline-flex rounded-xl border border-slate-200 overflow-hidden bg-white">
              {[['calendar', 'Calendario'], ['list', 'Lista']].map(([v, label]) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={`px-4 py-2.5 text-sm font-medium cursor-pointer border-none transition-colors ${
                    view === v
                      ? 'bg-emerald-600 text-white'
                      : 'bg-white text-slate-600 hover:bg-emerald-50'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {isAdmin && (
            <button
              onClick={exportExcel}
              className="px-4 py-2.5 rounded-xl text-sm font-medium cursor-pointer border bg-white text-emerald-700 border-emerald-200 hover:bg-emerald-50"
            >
              Excel
            </button>
          )}
          {canWrite && (
            <button
              onClick={openNew}
              className="flex items-center gap-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white px-5 py-2.5 rounded-xl text-sm font-medium cursor-pointer border-none shadow-lg shadow-emerald-200/50 transition-all"
            >
              <HiOutlinePlus className="w-5 h-5" /> Nueva Cita
            </button>
          )}
        </div>
      </div>

      {/**
        * LOS FILTROS OCUPAN LO MÍNIMO.
        *
        * Antes esta tarjeta se llevaba media pantalla —buscador, fila del día y
        * seis desplegables, cada uno en su renglón— y la tabla de citas, que es a
        * lo que se entra, empezaba por debajo del pliegue. Y los filtros no se
        * usan en cada visita: el día y el buscador sí, el resto casi nunca.
        *
        * Lo que se hizo: el buscador y la navegación del día comparten fila en
        * pantalla ancha, los desplegables van a cuatro columnas en vez de tres,
        * y todo con menos aire (`py-2` en vez de `py-2.5`, `gap-2`). En el móvil
        * sigue plegado como estaba.
        */}
      {(view === 'list' || view === 'calendar') && (
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 mb-3 md:mb-4 p-2.5 md:p-3 space-y-2">
          <div className="flex flex-col lg:flex-row lg:items-center gap-2">
          <div className="relative flex-1 min-w-0">
            <HiOutlineMagnifyingGlass className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              value={filter.patientQuery}
              onChange={(e) => setFilter({ ...filter, patientQuery: e.target.value })}
              placeholder="Buscar paciente por nombre, cédula o teléfono..."
              className="w-full pl-9 pr-4 py-2 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50"
            />
          </div>
          {/* Navegación de día (solo lista): la lista muestra un único día.
              En el móvil las flechas son solo el símbolo y la fecha se estira:
              con el texto completo esto se partía en tres líneas. */}
          {view === 'list' && (
            <div className="flex items-center gap-1.5 lg:shrink-0">
              <button
                onClick={() => moveDay(-1)}
                title="Día anterior"
                aria-label="Día anterior"
                className="px-3 py-2 rounded-lg bg-white border border-slate-200 hover:bg-slate-50 cursor-pointer text-sm shrink-0"
              >
                <span className="md:hidden">‹</span>
                <span className="hidden md:inline">‹ Día anterior</span>
              </button>
              <DateInput
                value={listDay}
                onChange={(e) => setListDay(e.target.value)}
                className="flex-1 md:flex-none min-w-0 px-3 md:px-4 py-2 border border-slate-200 rounded-xl text-sm bg-slate-50/50"
              />
              <button
                onClick={() => moveDay(1)}
                title="Día siguiente"
                aria-label="Día siguiente"
                className="px-3 py-2 rounded-lg bg-white border border-slate-200 hover:bg-slate-50 cursor-pointer text-sm shrink-0"
              >
                <span className="md:hidden">›</span>
                <span className="hidden md:inline">Día siguiente ›</span>
              </button>
              <button
                onClick={() => setListDay(toYmd(new Date()))}
                className={`px-3 py-2 rounded-lg cursor-pointer text-sm transition-colors shrink-0 ${
                  listDay === toYmd(new Date())
                    ? 'bg-emerald-600 text-white border-none'
                    : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
                }`}
              >
                Hoy
              </button>
            </div>
          )}
          </div>

          {/* Los filtros de abajo se usan de vez en cuando; las citas, siempre.
              En el móvil van plegados, con el número de los que estén puestos
              para que no se queden activos sin que se vea. */}
          <button
            type="button"
            onClick={() => setFiltrosAbiertos((v) => !v)}
            className="md:hidden w-full flex items-center justify-between px-3 py-2 rounded-lg border border-slate-200 bg-slate-50/50 text-sm text-slate-600 cursor-pointer"
          >
            <span className="flex items-center gap-2">
              <HiOutlineAdjustmentsHorizontal className="w-4 h-4" />
              Filtros
              {filtrosActivos > 0 && (
                <span className="px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-[10px] font-bold">
                  {filtrosActivos}
                </span>
              )}
            </span>
            <HiOutlineChevronDown
              className={`w-4 h-4 transition-transform ${filtrosAbiertos ? 'rotate-180' : ''}`}
            />
          </button>

          <div
            className={`${filtrosAbiertos ? 'grid' : 'hidden'} md:grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2`}
          >
            <select
              value={filter.status}
              onChange={(e) => setFilter({ ...filter, status: e.target.value })}
              className="px-3 py-2 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50"
            >
              <option value="">Todos los estados</option>
              {Object.entries(statusLabels).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
            <select
              value={filter.isFirstVisit}
              onChange={(e) => setFilter({ ...filter, isFirstVisit: e.target.value })}
              className="px-3 py-2 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50"
            >
              <option value="">Todos los pacientes</option>
              <option value="true">Solo pacientes nuevos</option>
              <option value="false">Solo pacientes recurrentes</option>
            </select>
            {!isDoctor && (
              <ProductAutocomplete
                products={services}
                value={filter.service}
                onSelect={(p) => setFilter({ ...filter, service: p?._id || '' })}
                placeholder="Filtrar por servicio..."
              />
            )}
            {!isDoctor && clinicasFiltro.length > 1 && (
              <select
                value={filter.clinic}
                onChange={(e) => setFilter({ ...filter, clinic: e.target.value })}
                className="px-3 py-2 border border-slate-200 rounded-xl text-sm bg-slate-50/50"
              >
                <option value="">Todas las sucursales</option>
                {clinicasFiltro.map((c) => (
                  <option key={c._id} value={c._id}>{c.nombreComercial || c.name}</option>
                ))}
              </select>
            )}
            {/* Filtros por hora: solo tienen sentido en la lista (un día).
                Llevan rótulo porque `placeholder` no hace nada en un input de
                hora: se veían dos campos "--:--" idénticos, sin saber cuál era
                el desde y cuál el hasta. */}
            {view === 'list' && (
              <>
                <label className="flex items-center gap-2 px-3 py-1.5 border border-slate-200 rounded-xl text-sm bg-slate-50/50">
                  <span className="text-xs text-slate-500 shrink-0">Desde</span>
                  <input
                    type="time"
                    value={filter.timeFrom}
                    onChange={(e) => setFilter({ ...filter, timeFrom: e.target.value })}
                    className="flex-1 min-w-0 bg-transparent border-none outline-none text-sm"
                  />
                </label>
                <label className="flex items-center gap-2 px-3 py-1.5 border border-slate-200 rounded-xl text-sm bg-slate-50/50">
                  <span className="text-xs text-slate-500 shrink-0">Hasta</span>
                  <input
                    type="time"
                    value={filter.timeTo}
                    onChange={(e) => setFilter({ ...filter, timeTo: e.target.value })}
                    className="flex-1 min-w-0 bg-transparent border-none outline-none text-sm"
                  />
                </label>
              </>
            )}
          </div>
          <div className="flex items-center justify-between text-[11px] text-slate-500">
            <span>Total filtrado: <strong className="text-slate-800">{filteredAppointments.length}</strong> citas</span>
            {(filter.service || filter.clinic || filter.timeFrom || filter.timeTo || filter.status || filter.isFirstVisit || filter.patientQuery) && (
              <button
                onClick={() => setFilter({ startDate: '', endDate: '', status: '', isFirstVisit: '', clinic: '', service: '', timeFrom: '', timeTo: '', patientQuery: '' })}
                className="text-emerald-600 hover:underline border-none bg-transparent cursor-pointer"
              >Limpiar filtros</button>
            )}
          </div>
        </div>
      )}

      {view === 'calendar' && (
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 overflow-hidden mb-6">
          {/* Navegación de mes */}
          <div className="flex items-center justify-between px-5 py-3 border-b border-emerald-50">
            <button
              onClick={() => moveMonth(-1)}
              className="px-3 py-1.5 rounded-lg bg-white border border-slate-200 hover:bg-slate-50 cursor-pointer"
            >
              ‹
            </button>
            <h2 className="text-base font-semibold text-slate-800">
              {MONTH_NAMES[calMonth.getMonth()]} {calMonth.getFullYear()}
            </h2>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setCalMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}
                className="px-3 py-1.5 rounded-lg text-sm bg-white border border-slate-200 hover:bg-slate-50 cursor-pointer"
              >
                Hoy
              </button>
              <button
                onClick={() => moveMonth(1)}
                className="px-3 py-1.5 rounded-lg bg-white border border-slate-200 hover:bg-slate-50 cursor-pointer"
              >
                ›
              </button>
            </div>
          </div>
          {/* Cabecera de días */}
          <div className="grid grid-cols-7 bg-emerald-50/40 text-emerald-700 text-xs font-semibold">
            {WEEKDAY_NAMES.map((w) => (
              <div key={w} className="text-center py-2">{w}</div>
            ))}
          </div>
          {/* Cuadrícula del mes */}
          <div className="grid grid-cols-7">
            {calendarCells.map((d, idx) => {
              if (!d) return <div key={`e${idx}`} className="border-t border-l border-slate-100 min-h-[92px] bg-slate-50/30" />;
              const ymd = toYmd(d);
              const dayAppts = calApptsByDay.get(ymd) || [];
              const isToday = ymd === toYmd(new Date());
              const counts = dayAppts.reduce((acc, a) => {
                if (['asistida', 'completada'].includes(a.status)) acc.asistida += 1;
                else if (a.status === 'no_asistio') acc.no_asistio += 1;
                else if (a.status !== 'cancelada') acc.pendiente += 1;
                return acc;
              }, { pendiente: 0, asistida: 0, no_asistio: 0 });
              return (
                <button
                  key={ymd}
                  onClick={() => openDay(d)}
                  className={`text-left border-t border-l border-slate-100 min-h-[92px] p-1.5 cursor-pointer hover:bg-emerald-50/60 transition-colors bg-transparent ${
                    isToday ? 'ring-2 ring-inset ring-emerald-400' : ''
                  }`}
                >
                  <div className={`text-xs font-semibold mb-1 ${isToday ? 'text-emerald-700' : 'text-slate-600'}`}>
                    {d.getDate()}
                  </div>
                  {dayAppts.length > 0 ? (
                    <div className="space-y-0.5">
                      <div className="text-[11px] font-bold text-slate-700">{dayAppts.length} cita{dayAppts.length !== 1 ? 's' : ''}</div>
                      <div className="flex flex-wrap gap-1">
                        {counts.pendiente > 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">{counts.pendiente} pend.</span>
                        )}
                        {counts.asistida > 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">{counts.asistida} asist.</span>
                        )}
                        {counts.no_asistio > 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-100 text-rose-700">{counts.no_asistio} no</span>
                        )}
                      </div>
                    </div>
                  ) : null}
                </button>
              );
            })}
          </div>
          <div className="px-5 py-2 text-xs text-slate-400 border-t border-slate-100">
            Haz clic en un día para ver sus citas en forma de tabla, ordenadas por horario.
          </div>
        </div>
      )}

      {view !== 'calendar' && (
      // En móvil la tabla se recompone como tarjetas (.tbl-cards, ver index.css):
      // seis columnas no caben, y arrastrar de lado escondía justo el estado y
      // los botones. El contenedor pierde el marco ahí porque cada tarjeta trae
      // el suyo.
      <div className="md:bg-white md:rounded-2xl md:shadow-md md:shadow-slate-200/60 md:border md:border-emerald-100 overflow-hidden">
        <div className="md:overflow-x-auto">
          <table className="tbl tbl-cards">
            <thead>
              <tr className="bg-emerald-50/50 border-b border-emerald-100">
                <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">
                  Fecha
                </th>
                <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">
                  Hora
                </th>
                <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">
                  Paciente
                </th>
                {/* Ya no se oculta en móvil: ahí no es una columna que estorbe,
                    es una línea más de la tarjeta. */}
                <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">
                  Servicio / Programa
                </th>
                <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">
                  Estado
                </th>
                <th className="text-right px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">
                  Acciones
                </th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan="6" className="text-center py-10 text-slate-500">
                    Cargando...
                  </td>
                </tr>
              ) : filteredAppointments.length === 0 ? (
                <tr>
                  <td colSpan="6" className="text-center py-10 text-slate-500">
                    No se encontraron citas
                  </td>
                </tr>
              ) : (
                filteredAppointments.map((apt, aptIdx) => {
                  const editable = canEdit(apt);
                  /**
                   * QUIÉN TIENE LA PELOTA AHORA. Todo lo que ofrece esta fila se
                   * decide con `currentTurnUser`, NO con los espejos `doctor` /
                   * `attendedByNurse`: esos apuntan al ÚLTIMO que atendió cuando
                   * ya no queda turno suyo pendiente —es lo correcto para
                   * comisiones y reportes— y por eso el doctor que ya había
                   * guardado su seguimiento seguía viendo «Atender» de un
                   * paciente que ya estaba con enfermería.
                   */
                  const idDe = (v) => String(v?._id || v || '');
                  const conTurnos = (apt.turns || []).length > 0;
                  const esMiTurno = idDe(apt.currentTurnUser) === String(user?.id);
                  const yaAtendi = (apt.turns || []).some(
                    (t) => t.status === 'completado' && idDe(t.user) === String(user?.id)
                  );
                  // Turno de enfermería LIBRE: lo puede tomar cualquiera. En las
                  // citas viejas (sin turnos) sigue mandando el campo de antes.
                  const enfermeriaLibre = conTurnos
                    ? apt.currentTurnKind === 'enfermeria' && !apt.currentTurnUser
                    : !apt.attendedByNurse;
                  // Ya es suyo: puede ver la receta y cerrar su parte.
                  const enfermeriaMia = conTurnos
                    ? apt.currentTurnKind === 'enfermeria' && esMiTurno
                    : idDe(apt.attendedByNurse) === String(user?.id);
                  const showDoctorTimer =
                    isDoctor && esMiTurno && apt.status !== 'completada';
                  const inProgress =
                    apt.consultationStartedAt && !apt.consultationEndedAt;
                  // Separador de fecha: cabecera cuando cambia el día (vista de agenda).
                  const prev = filteredAppointments[aptIdx - 1];
                  const dayKey = formatLocalDate(apt.date);
                  const showDayHeader = !prev || formatLocalDate(prev.date) !== dayKey;
                  const atencion = textoAtencion(apt);
                  const extras = serviciosExtra(apt);
                  return (
                    <Fragment key={apt._id}>
                    {showDayHeader && (
                      <tr className="bg-emerald-50/70">
                        <td colSpan="6" className="px-3 md:px-6 py-2 text-xs font-bold text-emerald-800 uppercase tracking-wide">
                          📅 {dayKey}
                        </td>
                      </tr>
                    )}
                    <tr
                      className="md:border-b md:border-emerald-50 hover:bg-emerald-50/30 transition-colors"
                    >
                      <td data-cell="fecha" className="md:px-6 md:py-3.5 text-sm text-slate-600">
                        {formatLocalDate(apt.date)}
                      </td>
                      <td data-cell="hora" className="md:px-6 md:py-3.5 text-sm text-slate-800 font-medium">
                        {apt.startTime}{apt.endTime ? ` - ${apt.endTime}` : ''}
                        {atencion && (
                          <div
                            className="text-[11px] font-normal text-emerald-700 mt-0.5 whitespace-nowrap"
                            title={atencion.detalle}
                          >
                            {atencion.texto}
                          </div>
                        )}
                      </td>
                      <td data-cell="principal" className="md:px-6 md:py-3.5 text-sm text-slate-800">
                        <div className="flex items-center flex-wrap gap-2">
                          <span>
                            {apt.patient?.firstName} {apt.patient?.lastName}
                          </span>
                          {apt.isFirstVisit && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-700 uppercase">
                              Nuevo
                            </span>
                          )}
                          {clinics.length > 1 && apt.clinic && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-indigo-100 text-indigo-700">
                              {apt.clinic.nombreComercial || apt.clinic.name}
                            </span>
                          )}
                        </div>
                        {/* Quién agendó. El snapshot del nombre es el respaldo:
                            si esa persona se dio de baja, el populate viene
                            vacío pero el nombre debe seguir apareciendo. */}
                        {quienAgendo(apt) && (
                          <div className="text-[11px] text-slate-400 mt-0.5">
                            Agendó: {quienAgendo(apt)}
                          </div>
                        )}
                        {ultimoReagendamiento(apt) && (
                          <div className="text-[11px] text-amber-600 mt-0.5">
                            Reagendó: {ultimoReagendamiento(apt)}
                          </div>
                        )}
                      </td>
                      <td data-cell="detalle" className="md:px-6 md:py-3.5 text-sm text-slate-600">
                        {nombreServicio(apt) || <span className="text-slate-400 italic">Sin servicio</span>}
                        {/* Lo que además se hizo en la visita. Va debajo y no
                            pegado con comas para que se siga leyendo de un
                            vistazo cuál fue el servicio por el que vino. */}
                        {extras.map((nombre) => (
                          <div key={nombre} className="text-[11px] text-violet-700 mt-0.5">
                            + {nombre}
                          </div>
                        ))}
                        {apt.reason && (
                          <div className="text-[11px] text-slate-500 mt-0.5 italic" title={apt.reason}>
                            Motivo: {apt.reason.length > 60 ? apt.reason.slice(0, 60) + '…' : apt.reason}
                          </div>
                        )}
                        {apt.doctor?.name && (
                          <div className="text-[11px] text-emerald-700 mt-0.5">
                            Dr. {apt.doctor.name}
                          </div>
                        )}
                        {apt.attendedByNurse?.name && (
                          <div className="text-[11px] text-sky-700 mt-0.5">
                            Enf. {apt.attendedByNurse.name}
                          </div>
                        )}
                      </td>
                      <td data-cell="estado" className="md:px-6 md:py-3.5">
                        <span
                          className={`inline-block px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap ${
                            statusColors[apt.status] || statusColors.pendiente
                          }`}
                        >
                          {statusLabels[apt.status] || 'Pendiente'}
                        </span>
                      </td>
                      <td data-cell="acciones" className="md:px-6 md:py-3.5 text-right">
                        {/* Recepción: a quién pasa el paciente. También en las ya
                            asistidas, para poder añadir un doctor o mandarla a
                            enfermería cuando la consulta ya empezó. */}
                        {canCharge && ['pendiente', 'confirmada', 'asistida'].includes(apt.status) && (
                          <button
                            onClick={() => setAssignModal({ appointment: apt })}
                            className="p-1.5 rounded-lg hover:bg-emerald-50 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer transition-colors"
                            title="Asignar atención (doctores o enfermería)"
                          >
                            <HiOutlineUserPlus className="w-4 h-4" />
                          </button>
                        )}
                        {/**
                          * Doctor: abrir la ficha SOLO si le toca AHORA.
                          *
                          * Antes se miraba `apt.doctor`, que es el ESPEJO para
                          * comisiones y reportes: cuando ya no queda ningún turno
                          * de doctor pendiente, ese espejo se queda apuntando al
                          * ÚLTIMO que atendió. Con la cola «doctor → enfermería»,
                          * el doctor que ya había guardado su seguimiento seguía
                          * viendo «Atender» para un paciente que ya estaba con
                          * enfermería. `currentTurnUser` es quien tiene la pelota
                          * ahora, que es justo lo que hay que preguntar.
                          */}
                        {isDoctor &&
                          apt.status === 'asistida' &&
                          esMiTurno && (
                            <button
                              onClick={() => abrirAtencion(apt)}
                              className="p-1.5 rounded-lg hover:bg-emerald-50 text-emerald-600 bg-transparent border border-emerald-200 cursor-pointer transition-colors text-xs font-semibold mr-1"
                              title="Atender ahora"
                            >
                              Atender
                            </button>
                          )}
                        {/* Ya atendió y la cita sigue viva con otro: se le dice,
                            en vez de dejarle un botón que no le corresponde. */}
                        {isDoctor && apt.status === 'asistida' && !esMiTurno && yaAtendi && (
                            <span
                              className="inline-block px-2 py-1 rounded-lg text-[11px] font-medium text-slate-500 bg-slate-100 mr-1 align-middle"
                              title="Ya guardaste tu seguimiento de esta cita"
                            >
                              Ya atendida
                            </span>
                          )}
                        {/* Enfermero: reclamar una cita de enfermería libre */}
                        {isNurse && apt.status === 'asistida' && enfermeriaLibre && (
                          <button
                            onClick={() => nurseClaim(apt)}
                            className="p-1.5 rounded-lg hover:bg-sky-50 text-sky-700 bg-transparent border border-sky-200 cursor-pointer transition-colors text-xs font-semibold mr-1"
                            title="Atender: marcar que la estoy atendiendo"
                          >
                            Atender
                          </button>
                        )}
                        {/* Enfermero: ver la receta del paciente que ya tomó */}
                        {isNurse && apt.status === 'asistida' && enfermeriaMia && (
                          <button
                            onClick={() => abrirAtencion(apt)}
                            className="p-1.5 rounded-lg hover:bg-sky-50 text-sky-700 bg-transparent border border-sky-200 cursor-pointer transition-colors text-xs font-semibold mr-1"
                            title="Ver la receta y anotar los sueros"
                          >
                            Receta
                          </button>
                        )}
                        {/* Enfermero: cerrar su turno (no escribe seguimiento) */}
                        {isNurse && apt.status === 'asistida' && enfermeriaMia && (
                          <button
                            onClick={() => nurseFinish(apt)}
                            className="p-1.5 rounded-lg hover:bg-emerald-50 text-emerald-700 bg-transparent border border-emerald-200 cursor-pointer transition-colors text-xs font-semibold mr-1"
                            title="Terminar mi parte"
                          >
                            Terminar
                          </button>
                        )}
                        {showDoctorTimer && !inProgress && apt.status !== 'completada' && (
                          <button
                            onClick={() => startConsultation(apt)}
                            className="p-1.5 rounded-lg hover:bg-emerald-50 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer transition-colors"
                            title="Iniciar consulta"
                          >
                            <HiOutlinePlay className="w-4 h-4" />
                          </button>
                        )}
                        {showDoctorTimer && inProgress && (
                          <button
                            onClick={() => endConsultation(apt)}
                            className="p-1.5 rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-600 bg-transparent border-none cursor-pointer transition-colors"
                            title="Finalizar consulta"
                          >
                            <HiOutlineStop className="w-4 h-4" />
                          </button>
                        )}
                        {/**
                          * VOLVER A LA CONSULTA que ya se cerró.
                          *
                          * Al guardar el seguimiento la cita pasa a «completada»
                          * y quien la atendió se quedaba fuera: si había mandado
                          * algo por error o se acordaba de un dato después, no
                          * tenía por dónde volver. Lo único que le quedaba era
                          * «ver» e «imprimir», que no sirven para corregir.
                          *
                          * No reabre la cita ni reinicia el cronómetro (ver
                          * `abrirAtencion`): entra a la ficha, y desde ahí se
                          * corrige el seguimiento con su propio botón.
                          */}
                        {(isDoctor || isNurse) && apt.status === 'completada' && (
                          yaAtendi
                          // Citas anteriores a los turnos: ahí manda el espejo,
                          // que es lo único que dice quién atendió.
                          || (!conTurnos && (idDe(apt.doctor) === String(user?.id)
                              || idDe(apt.attendedByNurse) === String(user?.id)))
                        ) && (
                          <button
                            onClick={() => abrirAtencion(apt, { soloVolver: true })}
                            className="p-1.5 rounded-lg hover:bg-indigo-50 text-indigo-600 bg-transparent border border-indigo-200 cursor-pointer transition-colors text-xs font-semibold mr-1"
                            title="Volver a la consulta para corregirla o ampliarla"
                          >
                            Ver / corregir
                          </button>
                        )}
                        {/* «Ver» e «imprimir» son de mostrador: quien atiende no
                            los usa —lo suyo es entrar a la consulta— y le
                            llenaban la fila de botones que no le sirven. */}
                        {!isDoctor && !isNurse && (
                          <>
                            <button
                              onClick={() => openDetail(apt._id)}
                              title="Ver la cita"
                              className="p-1.5 rounded-lg hover:bg-emerald-50 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer transition-colors"
                            >
                              <HiOutlineEye className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => downloadPdf(apt._id)}
                              className="p-1.5 rounded-lg hover:bg-emerald-50 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer transition-colors"
                              title="Descargar PDF"
                            >
                              <HiOutlineDocumentArrowDown className="w-4 h-4" />
                            </button>
                          </>
                        )}
                        {editable && (
                          <button
                            onClick={() => openEdit(apt)}
                            className="p-1.5 rounded-lg hover:bg-emerald-50 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer transition-colors"
                          >
                            <HiOutlinePencil className="w-4 h-4" />
                          </button>
                        )}
                        {editable && canWrite && (
                          <button
                            onClick={() => handleDelete(apt)}
                            className="p-1.5 rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-600 bg-transparent border-none cursor-pointer transition-colors"
                          >
                            <HiOutlineTrash className="w-4 h-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                    </Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
      )}

      {/* Create/Edit Modal */}
      <Modal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? 'Editar Cita' : 'Nueva Cita'}
        size="2xl"
      >
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-5">
          <form onSubmit={handleSubmit} className="space-y-4 min-w-0">
          {/* Selector de consultorio médico: visible para todos los roles con >1 clínica */}
          {showClinicSelector && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                Sucursal destino *
              </label>
              <select
                name="clinic"
                value={form.clinic}
                onChange={handleChange}
                required
                className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50"
              >
                <option value="">Seleccionar sucursal</option>
                {clinics.map((c) => (
                  <option key={c._id} value={c._id}>
                    {c.nombreComercial || c.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Buscador de pacientes */}
          <div className="relative">
            <label className="block text-sm font-medium text-slate-700 mb-1.5">
              Paciente *
            </label>
            <div className="relative">
              <HiOutlineMagnifyingGlass className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="text"
                value={patientSearch}
                onChange={(e) => {
                  setPatientSearch(e.target.value);
                  setPatients([]);
                  setShowPatientList(true);
                  if (form.patient) setForm((f) => ({ ...f, patient: '' }));
                }}
                onFocus={() => setShowPatientList(true)}
                placeholder="Buscar por nombre o cédula..."
                className="w-full pl-10 pr-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50"
              />
              {form.patient && (
                <button
                  type="button"
                  onClick={() => {
                    setForm((f) => ({ ...f, patient: '' }));
                    setPatients([]);
                    setPatientSearch('');
                    setShowPatientList(true);
                  }}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-emerald-600 bg-transparent border-none cursor-pointer"
                >
                  Limpiar
                </button>
              )}
            </div>
            {showPatientList && !form.patient && (
              <div className="absolute z-20 left-0 right-0 mt-1 max-h-56 overflow-y-auto bg-white border border-emerald-100 rounded-xl shadow-lg">
                {patientSearchLoading ? (
                  <p className="px-4 py-2 text-xs text-slate-400">Buscando pacientes...</p>
                ) : patientSearchError ? (
                  <p className="px-4 py-2 text-xs text-rose-500">No se pudo buscar. Intenta nuevamente.</p>
                ) : patients.length === 0 ? (
                  <p className="px-4 py-2 text-xs text-slate-400">Sin coincidencias</p>
                ) : (
                  patients.map((p) => (
                    <button
                      type="button"
                      key={p._id}
                      onClick={() => handlePatientSelect(p)}
                      className="w-full text-left px-4 py-2 text-sm hover:bg-emerald-50 cursor-pointer bg-white border-none border-b border-emerald-50"
                    >
                      <span className="font-medium text-slate-800">
                        {p.firstName} {p.lastName}
                      </span>
                      {p.cedula && <span className="text-slate-400 ml-2">{p.cedula}</span>}
                      {p.phone && (
                        <span className="text-slate-400 ml-2">• {p.phone}</span>
                      )}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Doctor: visible al EDITAR para admin y para quienes asignan doctores
                (cajero / recepción). La comisión se atribuye al doctor asignado. */}
            {editing && (isAdmin || isReception) && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">
                  Doctor asignado
                </label>
                <select
                  name="doctor"
                  value={form.doctor}
                  onChange={handleChange}
                  disabled={doctorLocked}
                  className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50 disabled:bg-slate-100 disabled:text-slate-500 disabled:cursor-not-allowed"
                >
                  <option value="">Sin asignar</option>
                  {doctors.map((d) => (
                    <option key={d._id} value={d._id}>
                      {doctorOptionLabel(d)}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-slate-400 mt-1">
                  {doctorLocked
                    ? 'La consulta ya fue atendida: el doctor no se puede cambiar.'
                    : 'La comisión por el servicio se asigna al doctor seleccionado.'}
                </p>
              </div>
            )}
            {editing && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">
                  Estado
                </label>
                <select
                  name="status"
                  value={form.status}
                  onChange={handleChange}
                  className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50"
                >
                  {Object.entries(statusLabels).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                Fecha *
              </label>
              <DateInput
                name="date"
                value={form.date}
                min={todayEc()}
                onChange={handleChange}
                required
                className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                Hora *
              </label>
              <TimeSlotInput
                name="startTime"
                value={form.startTime}
                slotMinutes={slotMinutes}
                min={form.date === todayEc() ? nowEcHHMM() : undefined}
                onChange={handleChange}
                required
                className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">
              Motivo de consulta
            </label>
            <textarea
              name="reason"
              value={form.reason}
              onChange={handleChange}
              rows={2}
              className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50 resize-none"
            />
          </div>

          {/* Servicio de la AGENDA: catálogo propio, no el inventario. El
              consultorio y el "pagado por adelantado" se retiraron con el mismo
              cambio (lo segundo es cobro, y eso va por contabilidad). */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">
              Servicio <span className="font-normal text-slate-400">(opcional)</span>
            </label>
            <ServiceItemPicker
              value={form.serviceItem}
              onChange={(item) => setForm((f) => ({ ...f, serviceItem: item }))}
            />
            <p className="text-[11px] text-slate-400 mt-1">
              Pincha para ver la lista. Si no está, escríbelo y se crea para todos.
            </p>
          </div>

          {/* Citas adicionales: solo al crear (no al editar). */}
          {!editing && (
            <div className="space-y-2">
              {(form.extraAppointments || []).map((it, idx) => (
                <div key={idx} className="border border-emerald-200 rounded-xl p-3 bg-emerald-50/40 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-emerald-700">Cita adicional #{idx + 2}</span>
                    <button
                      type="button"
                      onClick={() => setForm((f) => ({
                        ...f,
                        extraAppointments: f.extraAppointments.filter((_, i) => i !== idx),
                      }))}
                      className="text-rose-600 text-xs bg-transparent border-none cursor-pointer hover:underline"
                    >
                      Quitar
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <DateInput
                      value={it.date}
                      min={todayEc()}
                      onChange={(e) => setForm((f) => ({
                        ...f,
                        extraAppointments: f.extraAppointments.map((x, i) => i === idx ? { ...x, date: e.target.value } : x),
                      }))}
                      className="px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white"
                    />
                    <TimeSlotInput
                      value={it.startTime}
                      slotMinutes={slotMinutes}
                      min={it.date === todayEc() ? nowEcHHMM() : undefined}
                      onChange={(e) => setForm((f) => ({
                        ...f,
                        extraAppointments: f.extraAppointments.map((x, i) => i === idx ? { ...x, startTime: e.target.value } : x),
                      }))}
                      className="px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white"
                    />
                  </div>
                  <input
                    type="text"
                    placeholder="Motivo (opcional)"
                    value={it.reason}
                    onChange={(e) => setForm((f) => ({
                      ...f,
                      extraAppointments: f.extraAppointments.map((x, i) => i === idx ? { ...x, reason: e.target.value } : x),
                    }))}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white"
                  />
                  <div>
                    <label className="text-xs font-medium text-slate-600 block mb-1">Servicio</label>
                    <ServiceItemPicker
                      value={it.serviceItem || null}
                      onChange={(item) => setForm((f) => ({
                        ...f,
                        extraAppointments: f.extraAppointments.map((x, i) => (i === idx ? { ...x, serviceItem: item } : x)),
                      }))}
                    />
                  </div>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setForm((f) => ({
                  ...f,
                  extraAppointments: [...(f.extraAppointments || []), { date: '', startTime: '', reason: '', serviceItem: null }],
                }))}
                className="w-full text-xs py-2 rounded-lg border border-dashed border-emerald-300 text-emerald-700 bg-emerald-50/40 hover:bg-emerald-100 cursor-pointer"
              >
                + Agregar otra cita (mismo paciente)
              </button>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-3">
            <button
              type="button"
              onClick={() => setModalOpen(false)}
              className="px-5 py-2.5 border border-slate-200 rounded-xl text-sm text-slate-600 hover:bg-slate-50 cursor-pointer bg-white transition-colors"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-5 py-2.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white rounded-xl text-sm font-medium disabled:opacity-50 cursor-pointer border-none shadow-lg shadow-emerald-200/50"
            >
              {saving ? 'Guardando...' : editing ? 'Actualizar' : 'Crear Cita'}
            </button>
          </div>
          </form>

          {/* Panel lateral: citas agendadas en el horario seleccionado */}
          <SameSlotPanel
            date={form.date}
            startTime={form.startTime}
            excludeId={editing}
            clinicId={form.clinic || activeClinic?._id}
            // Con el servicio elegido, el panel también avisa de las citas que
            // empiezan DENTRO de lo que va a durar esta.
            serviceItemId={form.serviceItem?._id || null}
          />
        </div>
      </Modal>

      {/* Detail Modal */}
      <Modal
        isOpen={!!detailModal}
        onClose={() => setDetailModal(null)}
        title="Detalle de Cita"
        size="lg"
      >
        {detailModal && (
          <div className="space-y-4">
            {detailModal.isFirstVisit && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-2 text-amber-700 text-sm font-semibold uppercase tracking-wide">
                ✨ Paciente Nuevo
              </div>
            )}
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-emerald-50/50 rounded-xl p-3">
                <p className="text-xs text-emerald-600 font-medium">Paciente</p>
                <p className="text-sm font-medium text-slate-800 mt-0.5">
                  {detailModal.patient?.firstName} {detailModal.patient?.lastName}
                </p>
              </div>
              <div className="bg-emerald-50/50 rounded-xl p-3">
                <p className="text-xs text-emerald-600 font-medium">Cédula</p>
                <p className="text-sm text-slate-800 mt-0.5">
                  {detailModal.patient?.cedula || '—'}
                </p>
              </div>
              <div className="bg-emerald-50/50 rounded-xl p-3">
                <p className="text-xs text-emerald-600 font-medium">Doctor</p>
                <p className="text-sm font-medium text-slate-800 mt-0.5">
                  Dr. {detailModal.doctor?.name}
                </p>
              </div>
              <div className="bg-emerald-50/50 rounded-xl p-3">
                <p className="text-xs text-emerald-600 font-medium">Especialidad</p>
                <p className="text-sm text-slate-800 mt-0.5">
                  {detailModal.doctor?.specialty || '—'}
                </p>
              </div>
              <div className="bg-emerald-50/50 rounded-xl p-3">
                <p className="text-xs text-emerald-600 font-medium">Fecha</p>
                <p className="text-sm text-slate-800 mt-0.5">
                  {formatLocalDate(detailModal.date)}
                </p>
              </div>
              <div className="bg-emerald-50/50 rounded-xl p-3">
                <p className="text-xs text-emerald-600 font-medium">Horario</p>
                <p className="text-sm text-slate-800 mt-0.5">
                  {detailModal.startTime} - {detailModal.endTime}
                </p>
                {/* La agendada de arriba y la real, juntas: es la comparación
                    que interesa (cuánto esperó el paciente). */}
                {textoAtencion(detailModal) && (
                  <p className="text-xs text-emerald-700 mt-1">
                    {textoAtencion(detailModal).detalle}
                  </p>
                )}
              </div>
              <div className="bg-emerald-50/50 rounded-xl p-3">
                <p className="text-xs text-emerald-600 font-medium">Estado</p>
                <span
                  className={`px-2.5 py-1 rounded-full text-xs font-medium ${
                    statusColors[detailModal.status] || statusColors.pendiente
                  }`}
                >
                  {statusLabels[detailModal.status] || 'Pendiente'}
                </span>
              </div>
              <div className="bg-emerald-50/50 rounded-xl p-3">
                <p className="text-xs text-emerald-600 font-medium">Teléfono</p>
                <p className="text-sm text-slate-800 mt-0.5">
                  {detailModal.patient?.phone || '—'}
                </p>
              </div>
            </div>
            {detailModal.reason && (
              <div className="bg-emerald-50/50 rounded-xl p-3">
                <p className="text-xs text-emerald-600 font-medium">Motivo</p>
                <p className="text-sm text-slate-800 mt-0.5">{detailModal.reason}</p>
              </div>
            )}
            {detailModal.diagnosis && (
              <div className="bg-emerald-50/50 rounded-xl p-3">
                <p className="text-xs text-emerald-600 font-medium">Diagnóstico</p>
                <p className="text-sm text-slate-800 mt-0.5">{detailModal.diagnosis}</p>
              </div>
            )}
            {detailModal.treatment && (
              <div className="bg-emerald-50/50 rounded-xl p-3">
                <p className="text-xs text-emerald-600 font-medium">Tratamiento</p>
                <p className="text-sm text-slate-800 mt-0.5">{detailModal.treatment}</p>
              </div>
            )}
            {detailModal.services && detailModal.services.length > 0 && (
              <div className="bg-emerald-50/50 rounded-xl p-3">
                <p className="text-xs text-emerald-600 font-medium mb-1">Servicios</p>
                <ul className="text-sm text-slate-800 space-y-1">
                  {detailModal.services.map((s, i) => (
                    <li key={i} className="flex justify-between">
                      <span>{s.name}</span>
                      <span className="font-medium">
                        ${Number(s.price || 0).toFixed(2)}
                      </span>
                    </li>
                  ))}
                  <li className="flex justify-between border-t border-emerald-200 pt-1 font-bold">
                    <span>Total</span>
                    <span>
                      $
                      {detailModal.services
                        .reduce((s, x) => s + Number(x.price || 0), 0)
                        .toFixed(2)}
                    </span>
                  </li>
                </ul>
              </div>
            )}
            {(canCharge || quienAgendo(detailModal) || detailModal.serviceName || detailModal.serviceItem) && (
              <div className="bg-emerald-50/50 rounded-xl p-3 space-y-1">
                {nombreServicio(detailModal) && (
                  <>
                    <p className="text-xs text-emerald-600 font-medium">Servicio</p>
                    <p className="text-sm text-slate-800">{nombreServicio(detailModal)}</p>
                  </>
                )}
                {serviciosExtra(detailModal).length > 0 && (
                  <>
                    <p className="text-xs text-emerald-600 font-medium pt-1">Otros servicios</p>
                    <div className="flex flex-wrap gap-1.5">
                      {serviciosExtra(detailModal).map((nombre) => (
                        <span
                          key={nombre}
                          className="px-2 py-0.5 rounded-full bg-violet-100 text-violet-700 text-xs font-medium"
                        >
                          {nombre}
                        </span>
                      ))}
                    </div>
                  </>
                )}
                {/* Valor acordado de la cita. Es un dato operativo —lo que se le
                    va a cobrar al paciente—, no el cobro en sí. Solo mostrador lo
                    ve y lo cambia. */}
                {canCharge && (detailModal.isCanje || detailModal.agreedValue != null) && (
                  <>
                    <p className="text-xs text-emerald-600 font-medium pt-1">Valor</p>
                    <p className="text-sm text-slate-800">
                      {detailModal.isCanje ? (
                        <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-800 text-xs font-semibold">
                          Canje
                        </span>
                      ) : (
                        `$${Number(detailModal.agreedValue).toFixed(2)}`
                      )}
                    </p>
                  </>
                )}
                {quienAgendo(detailModal) && (
                  <>
                    <p className="text-xs text-emerald-600 font-medium pt-1">Agendada por</p>
                    <p className="text-sm text-slate-800">
                      {quienAgendo(detailModal)}
                      {detailModal.conversation ? ' · desde el chat' : ''}
                    </p>
                  </>
                )}
                {/* Sin condición de estado a propósito: el servicio real y el
                    precio muchas veces se saben al terminar, y antes una cita
                    completada obligaba a llamar a un administrador. */}
                {canCharge && (
                  <button
                    type="button"
                    onClick={() => {
                      setServiceValueModal(detailModal);
                      setDetailModal(null);
                    }}
                    className="mt-2 px-3 py-1.5 rounded-lg text-xs font-medium bg-white border border-emerald-200 text-emerald-700 hover:bg-emerald-50 cursor-pointer"
                  >
                    Cambiar servicio y valor
                  </button>
                )}
              </div>
            )}
            {(detailModal.origin && detailModal.origin !== 'standalone') && (
              <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-3">
                <p className="text-xs text-indigo-700 font-medium">Origen de la cita</p>
                <p className="text-sm text-slate-800 mt-0.5">
                  {detailModal.origin === 'referral' && (
                    <>Generada por derivación{detailModal.referral?.specialty ? ` — ${detailModal.referral.specialty}` : ''}</>
                  )}
                  {detailModal.origin === 'treatment' && (
                    <>Forma parte del tratamiento {detailModal.treatmentRef?.name ? `"${detailModal.treatmentRef.name}"` : ''}</>
                  )}
                </p>
              </div>
            )}
            {Array.isArray(detailModal.rescheduleHistory) && detailModal.rescheduleHistory.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
                <p className="text-xs text-amber-700 font-medium mb-2">
                  Historial de reagendamientos ({detailModal.rescheduleHistory.length})
                </p>
                <ul className="space-y-2 text-xs text-slate-700">
                  {detailModal.rescheduleHistory.map((h, i) => (
                    <li key={i} className="border-l-2 border-amber-300 pl-2">
                      <div>
                        <span className="line-through text-slate-500">
                          {formatLocalDate(h.previousDate)} {h.previousStartTime}–{h.previousEndTime}
                        </span>{' '}
                        →{' '}
                        <span className="font-semibold">
                          {formatLocalDate(h.newDate)} {h.newStartTime}–{h.newEndTime}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-500">
                        por {h.rescheduledBy?.name || h.rescheduledByName || '—'}
                        {h.rescheduledByRole ? ` (${roleLabels[h.rescheduledByRole] || h.rescheduledByRole})` : ''}
                        {' • '}{fmtDateTime(h.at)}
                      </div>
                      {h.reason && <div className="italic text-slate-600">"{h.reason}"</div>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {hasRole('admin', 'cajero', 'enfermero') && detailModal.status !== 'completada' && (
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 space-y-2">
                <p className="text-xs font-medium text-slate-600 uppercase tracking-wide">Cambiar estado</p>
                <div className="flex flex-wrap gap-2">
                  {detailModal.status !== 'confirmada' && detailModal.status !== 'asistida' && detailModal.status !== 'no_asistio' && (
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await api.post(`/appointments/${detailModal._id}/confirm`);
                          toast.success('Cita confirmada');
                          setDetailModal(null);
                          fetchAppointments();
                        } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
                      }}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-100 text-blue-700 hover:bg-blue-200 border-none cursor-pointer"
                    >Confirmar</button>
                  )}
                  {canCharge && !['completada', 'cancelada', 'no_asistio'].includes(detailModal.status) && (
                    <button
                      type="button"
                      onClick={() => {
                        setAssignModal({ appointment: detailModal });
                        setDetailModal(null);
                      }}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-100 text-emerald-700 hover:bg-emerald-200 border-none cursor-pointer"
                    >Asignar atención</button>
                  )}
                  {detailModal.status !== 'no_asistio' && (
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await api.post(`/appointments/${detailModal._id}/no-show`);
                          toast.success('Marcada como no asistió');
                          setDetailModal(null);
                          fetchAppointments();
                        } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
                      }}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium bg-rose-100 text-rose-700 hover:bg-rose-200 border-none cursor-pointer"
                    >No asistió</button>
                  )}
                </div>
              </div>
            )}
            {!isCallCenter && (
              <div className="flex justify-end pt-2">
                <button
                  onClick={() => downloadPdf(detailModal._id)}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm bg-emerald-600 hover:bg-emerald-700 text-white border-none cursor-pointer"
                >
                  <HiOutlineDocumentArrowDown className="w-4 h-4" /> Descargar PDF
                </button>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Modal de aviso de fin de cita (cronómetro) */}
      <Modal
        isOpen={!!timeUpModal}
        onClose={() => setTimeUpModal(null)}
        title="⏰ Tiempo de consulta finalizado"
        size="md"
      >
        {timeUpModal && (
          <div className="space-y-4">
            <p className="text-sm text-slate-700">
              El tiempo programado para la consulta de{' '}
              <span className="font-bold">
                {timeUpModal.patient?.firstName} {timeUpModal.patient?.lastName}
              </span>{' '}
              ha terminado.
            </p>
            <p className="text-xs text-slate-500">
              Programada: {timeUpModal.startTime} – {timeUpModal.endTime}
            </p>
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-amber-800 text-sm">
              Tiempo transcurrido:{' '}
              <span className="font-mono font-bold">
                {fmtSeconds(elapsedSeconds(timeUpModal))}
              </span>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setTimeUpModal(null)}
                className="px-4 py-2 rounded-xl text-sm border border-slate-200 bg-white hover:bg-slate-50 cursor-pointer"
              >
                Continuar consulta
              </button>
              <button
                onClick={() => endConsultation(timeUpModal)}
                className="px-4 py-2 rounded-xl text-sm bg-emerald-600 hover:bg-emerald-700 text-white border-none cursor-pointer"
              >
                Finalizar y completar
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Recepción: a quién pasa el paciente (uno o varios doctores, o enfermería) */}
      {assignModal && (
        <AssignAttentionModal
          appointment={assignModal.appointment}
          doctors={doctors}
          nurses={nurses}
          onClose={() => setAssignModal(null)}
          onDone={fetchAppointments}
        />
      )}

      {serviceValueModal && (
        <AppointmentServiceValueModal
          appointment={serviceValueModal}
          onClose={() => setServiceValueModal(null)}
          onDone={fetchAppointments}
        />
      )}

    </div>
  );
}

// Buscador autocompletable de servicios. Permite escribir y elegir entre coincidencias,
// y muestra las ya seleccionadas como chips removibles.
function ServiceAutocomplete({ services, selectedIds, onAdd, onRemove }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const available = services.filter((s) => !selectedIds.includes(s._id));
    if (!q) return available.slice(0, 15);
    return available
      .filter((s) =>
        (s.name || '').toLowerCase().includes(q) ||
        (s.code || '').toLowerCase().includes(q)
      )
      .slice(0, 15);
  }, [query, services, selectedIds]);

  const selectedServices = selectedIds
    .map((id) => services.find((s) => s._id === id))
    .filter(Boolean);

  return (
    <div className="space-y-2">
      <div className="relative">
        <HiOutlineMagnifyingGlass className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <input
          type="text"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 180)}
          placeholder={services.length === 0 ? 'No hay servicios disponibles. Créalos en Inventario.' : 'Buscar servicio por nombre o código...'}
          className="w-full pl-10 pr-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50"
        />
        {open && matches.length > 0 && (
          <div className="absolute z-30 left-0 right-0 mt-1 max-h-56 overflow-y-auto bg-white border border-emerald-100 rounded-xl shadow-lg">
            {matches.map((s) => (
              <button
                type="button"
                key={s._id}
                onMouseDown={(e) => { e.preventDefault(); onAdd(s._id); setQuery(''); setOpen(false); }}
                className="w-full text-left px-4 py-2 text-sm hover:bg-emerald-50 cursor-pointer bg-white border-none border-b border-emerald-50 flex items-center justify-between"
              >
                <span className="flex-1">
                  <span className="font-medium text-slate-800">{s.name}</span>
                  {s.category === 'programa' && (
                    <span className="ml-2 text-[10px] text-purple-600 font-semibold">(programa)</span>
                  )}
                  {s.excludeFromFirstVisit && (
                    <span className="ml-2 text-[10px] text-slate-400">(recurrente)</span>
                  )}
                </span>
                <span className="text-xs text-slate-500">${Number(s.salePrice).toFixed(2)}</span>
              </button>
            ))}
          </div>
        )}
        {open && query.trim() && matches.length === 0 && (
          <div className="absolute z-30 left-0 right-0 mt-1 bg-white border border-emerald-100 rounded-xl shadow-lg px-4 py-2 text-xs text-slate-400">
            Sin coincidencias
          </div>
        )}
      </div>
      {selectedServices.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedServices.map((s) => (
            <span
              key={s._id}
              className="inline-flex items-center gap-1.5 bg-emerald-100 text-emerald-800 text-xs px-2.5 py-1 rounded-full"
            >
              {s.name}
              <span className="text-emerald-600">${Number(s.salePrice).toFixed(2)}</span>
              <button
                type="button"
                onClick={() => onRemove(s._id)}
                className="text-emerald-700 hover:text-emerald-900 bg-transparent border-none cursor-pointer text-base leading-none"
                title="Quitar"
              >×</button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// SameSlotPanel ahora vive en components/SameSlotPanel.jsx y se reutiliza también
// desde el modal de citas del chat.
