import { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/axios';
import useDebounce from '../hooks/useDebounce';
import { downloadFile } from '../utils/download';
import { todayEc, nowEcHHMM } from '../utils/date';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { useSocketEvent } from '../context/SocketContext';
import { ROLES_VEN_CEDULA, ROLES_VEN_CORREO, ROLES_VEN_TELEFONO } from '../utils/roles';
// Los campos del paciente (y sus reglas por rol) se comparten con la agenda,
// donde mostrador los corrige desde la propia cita.
import PatientFields, {
  emptyPatientForm,
  formDesdePaciente,
  payloadDePaciente,
  Field,
} from '../components/PatientFields';
import { nombreSucursal } from '../utils/clinicName';
import {
  HiOutlinePlus,
  HiOutlinePencil,
  HiOutlineTrash,
  HiOutlineMagnifyingGlass,
  HiOutlineEye,
  HiOutlineUsers,
  HiOutlineArrowDownTray,
  HiOutlineCloudArrowUp,
  HiOutlineDocumentMagnifyingGlass,
} from 'react-icons/hi2';
import BulkUploadModal from '../components/BulkUploadModal';
import ServiceItemPicker from '../components/ServiceItemPicker';
import TimeSlotInput from '../components/TimeSlotInput';
import AppointmentValueFields from '../components/AppointmentValueFields';
import AgendadoPorSelect from '../components/AgendadoPorSelect';
import QuienAtiende, {
  CAMPOS_QUIEN_ATIENDE,
  pasosDeAtencion,
  usePersonalDeLaSede,
} from '../components/QuienAtiende';

const emptyApt = {
  enabled: false,
  clinic: '',
  date: '',
  startTime: '',
  reason: '',
  // Servicio del catálogo propio de la agenda: { _id, name } o null.
  serviceItem: null,
  /**
   * Valor acordado y canje, igual que en la agenda: esta cita se agenda desde
   * mostrador y ahí es donde se sabe lo que va a pagar el paciente. Solo lo ve
   * —y solo lo acepta el servidor a— admin y caja.
   */
  agreedValue: '',
  isCanje: false,
  // Quién atiende, si pasa por enfermería y el suero que se le va a poner. Es el
  // mismo bloque que la agenda (ver components/QuienAtiende): quien registra al
  // paciente en el mostrador ya sabe a qué viene, y hacerle volver a la agenda
  // para decirlo es el paso que se olvida.
  ...CAMPOS_QUIEN_ATIENDE,
  // A quién se le acredita la cita ('' = a quien la escribe). Ver AgendadoPorSelect.
  bookedBy: '',
  // Atención inmediata: en vez de agendar para más tarde, se abre la consulta
  // ya, asignada a quien está registrando al paciente.
  ahora: false,
};

export default function Patients() {
  const navigate = useNavigate();
  const { hasRole, clinics, activeClinic } = useAuth();
  /**
   * LAS SUCURSALES PARA AGENDAR SON LAS DE LA ORGANIZACIÓN, no las del usuario.
   *
   * Quien agenda desde aquí (mostrador, administración, call center) suele estar
   * asignado a UNA sede, y con `clinics` de la sesión el selector ni aparecía:
   * la cita caía siempre en su sucursal. Es la misma lista que usa la agenda
   * (`/clinics?scope=names`); si no llega, se cae a las suyas.
   */
  const [sedes, setSedes] = useState(clinics || []);
  useEffect(() => {
    let vivo = true;
    api.get('/clinics', { params: { scope: 'names' } })
      .then((r) => {
        const lista = (r.data || []).filter((c) => c.active !== false);
        if (vivo && lista.length) setSedes(lista);
      })
      .catch(() => {});
    return () => { vivo = false; };
  }, []);
  const showClinicSelector = (sedes?.length || 0) > 1;
  // 'doctor' entra aquí porque expande a las especialidades: en óptica el
  // paciente llega sin cita y quien lo registra es el propio optómetra.
  //
  // 'optica' hay que NOMBRARLA APARTE: en el cliente es el único rol de doctor
  // que no expande desde 'doctor' (ver utils/roles.js, donde se dejó fuera a
  // propósito), así que el `hasRole('doctor')` de arriba la dejaba sin ninguna
  // de las dos cosas — justo al rol para el que se escribió el comentario.
  const canWrite = hasRole('admin', 'cajero', 'call_center', 'doctor', 'optica');
  // Quien atiende puede además abrir la consulta en el momento de registrarlo.
  const puedeAtenderYa = hasRole('doctor', 'optica');
  /**
   * El VALOR de la cita es de mostrador (misma regla que en la agenda: ver
   * `puedeFijarValor` en appointmentController). A quien atiende ni se le
   * enseña el campo, y el servidor tampoco se lo aceptaría.
   */
  const puedeFijarValor = hasRole('admin', 'cajero');
  // Teléfono y WhatsApp: admin y mostrador, que es quien llama. Al resto el
  // servidor ni se los envía (ver CONTACT_FIELDS en patientController).
  const showContact = hasRole(...ROLES_VEN_TELEFONO);
  // CÉDULA, DIRECCIÓN y CORREO: mostrador los ve Y LOS CORRIGE, porque es quien
  // descubre que están mal al facturar. El correo lo ve además quien atiende.
  // Capacidades `patients.cedula` / `patients.address` / `patients.email` en el
  // servidor, que es quien manda.
  // (Qué campos se enseñan DENTRO del formulario lo decide PatientFields, que
  // usa estas mismas listas; aquí solo quedan los de las columnas de la tabla.)
  const showCedula = hasRole(...ROLES_VEN_CEDULA);
  const showEmail = hasRole(...ROLES_VEN_CORREO);
  // Nombre + Edad + Acciones siempre; las demás según quién mire. El número
  // tiene que cuadrar con las columnas de verdad: es el colSpan del "no se
  // encontraron pacientes" y el ancho del esqueleto.
  const columnCount = 3 + (showCedula ? 1 : 0) + (showContact ? 1 : 0) + (showEmail ? 1 : 0);
  const canDelete = hasRole('admin');

  const [patients, setPatients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);
  const [onlyNew, setOnlyNew] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyPatientForm);
  // Los dos números en un solo campo (los junta y reparte PatientFields, ver
  // unirTelefonos/partirTelefonos). Va como texto suelto para que escribir el
  // separador no se deshaga solo.
  const [telefonos, setTelefonos] = useState('');
  const [saving, setSaving] = useState(false);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);


  // Para crear cita junto al paciente
  const [aptForm, setAptForm] = useState(emptyApt);
  const [dayApts, setDayApts] = useState([]);
  const [loadingApts, setLoadingApts] = useState(false);
  /**
   * ESPACIOS de la agenda de la sucursal DESTINO (Configuración → Agenda).
   *
   * Aquí se agenda igual que en la página de Citas, y allí la hora va por
   * tramos. Con un `<input type="time">` suelto se podía teclear las 18:37, y
   * el servidor —que valida lo mismo— devolvía SLOT_INVALID después de haber
   * creado ya el paciente: se quedaba registrado y sin cita.
   */
  const slotMinutes =
    Number(
      (sedes || []).find((c) => String(c._id) === String(aptForm.clinic || activeClinic?._id))
        ?.appointmentSlotMinutes ?? activeClinic?.appointmentSlotMinutes
    ) || 0;

  /**
   * Personal de la sucursal DESTINO, no de la mía. Mostrador registra pacientes
   * que se atienden en otra sede, y quien puede atender esa cita es el personal
   * de allí: ofrecer al de aquí acaba en un «no atiende en la sucursal de esta
   * cita» del servidor, con el paciente ya creado.
   */
  const personalCita = usePersonalDeLaSede(
    aptForm.clinic || activeClinic?._id,
    aptForm.enabled && !aptForm.ahora
  );

  useEffect(() => {
    if (!aptForm.enabled || !aptForm.date) { setDayApts([]); return; }
    setLoadingApts(true);
    api.get('/appointments', { params: { startDate: aptForm.date, endDate: aptForm.date } })
      .then((r) => setDayApts(r.data || []))
      .catch(() => setDayApts([]))
      .finally(() => setLoadingApts(false));
  }, [aptForm.date, aptForm.enabled]);

  // Solo la respuesta de la última búsqueda actualiza la lista: descarta
  // respuestas fuera de orden que sobrescribirían con datos obsoletos.
  const reqRef = useRef(0);
  const fetchPatients = async () => {
    const reqId = ++reqRef.current;
    try {
      const params = { search: debouncedSearch, page, limit: 15 };
      if (onlyNew) params.isNew = 'true';
      const res = await api.get('/patients', { params });
      if (reqId !== reqRef.current) return; // respuesta obsoleta: descartar
      setPatients(res.data.patients);
      setTotalPages(res.data.pages);
    } catch {
      if (reqId === reqRef.current) toast.error('Error al cargar pacientes');
    } finally {
      if (reqId === reqRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    fetchPatients();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, page, onlyNew]);

  useSocketEvent('patient:created', () => fetchPatients(), [debouncedSearch, page, onlyNew]);
  useSocketEvent('patient:updated', () => fetchPatients(), [debouncedSearch, page, onlyNew]);

  const openNew = () => {
    setEditing(null);
    setForm(emptyPatientForm);
    setTelefonos('');
    /**
     * QUIEN ATIENDE ENTRA A LA CONSULTA, no agenda.
     *
     * En óptica el paciente está delante del optómetra cuando se le registra:
     * el camino normal —guardar, marcar "agendar cita", elegir día y hora— es
     * papeleo para algo que está pasando ya. Para esos roles el registro ES la
     * atención: no hay casilla que marcar ni que desmarcar (ver el bloque de la
     * cita en el formulario). Agendar para otro día se hace desde la agenda.
     */
    setAptForm({ ...emptyApt, enabled: puedeAtenderYa, ahora: puedeAtenderYa });
    setDayApts([]);
    setModalOpen(true);
  };

  const openEdit = (patient) => {
    setEditing(patient._id);
    const { form: f, telefonos: t } = formDesdePaciente(patient);
    setForm(f);
    setTelefonos(t);
    setAptForm(emptyApt);
    setModalOpen(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    /**
     * NADA DEL PACIENTE ES OBLIGATORIO, tampoco el género.
     *
     * Aquí quedaba una guardia que lo exigía, de antes de que se retirara la
     * obligatoriedad (ago-2026): el formulario decía en su propio comentario
     * que no hacía falta y luego se negaba a guardar. Se registra a mucha
     * gente con lo que se tiene a mano —a veces solo el teléfono— y exigirlo
     * empujaba a inventárselo, que es peor dato que ninguno.
     */
    // Validaciones de cita inline si está habilitada
    // Con 'atender ahora' no hay fecha ni hora que pedir: es esta.
    if (aptForm.enabled && !editing && !aptForm.ahora) {
      if (!aptForm.date || !aptForm.startTime) {
        toast.error('Completa los datos de la cita (fecha y hora)');
        return;
      }
      // Con varias sedes, la sucursal es obligatoria y ya no se hereda de la
      // activa: agendar en la equivocada no se descubre hasta que el paciente
      // llega a la otra puerta.
      if (showClinicSelector && !aptForm.clinic) {
        toast.error('Escoge la sucursal de la cita');
        return;
      }
    }
    setSaving(true);
    try {
      const payload = payloadDePaciente(form, telefonos);
      let createdId = editing;
      if (editing) {
        await api.put(`/patients/${editing}`, payload);
        toast.success('Paciente actualizado');
      } else {
        const res = await api.post('/patients', payload);
        createdId = res.data._id;
        toast.success('Paciente creado');
      }
      // Crear cita asociada si se solicitó
      if (aptForm.enabled && !editing && createdId) {
        try {
          if (aptForm.ahora) {
            // ATENCIÓN INMEDIATA: el servidor crea la cita a la hora actual, ya
            // asignada a quien la pide, y la deja abierta para atender.
            const { data } = await api.post('/appointments/walk-in', {
              patient: createdId,
              serviceItem: aptForm.serviceItem?._id || null,
              reason: aptForm.reason,
            });
            toast.success('Paciente registrado. Abriendo la consulta…');
            navigate(`/patients/${createdId}?tab=seguimientos&appointment=${data._id}`);
            return;
          }
          const aptClinic = aptForm.clinic || activeClinic?._id;
          const { data: creada } = await api.post('/appointments', {
            patient: createdId,
            clinic: aptClinic,
            date: aptForm.date,
            startTime: aptForm.startTime,
            reason: aptForm.reason,
            status: 'pendiente',
            serviceItem: aptForm.serviceItem?._id || null,
            // A nombre de quién queda (vacío = de quien la escribe).
            bookedBy: aptForm.bookedBy || undefined,
            // Quién atiende, enfermería y el suero, por la misma función que la
            // agenda (ver components/QuienAtiende).
            steps: pasosDeAtencion(aptForm, personalCita),
            // Valor acordado. Solo se manda si este rol puede fijarlo; el
            // servidor lo comprueba otra vez (`puedeFijarValor`). Vacío = «no
            // lo anotaron», que no es lo mismo que cero.
            ...(puedeFijarValor
              ? { agreedValue: aptForm.isCanje ? 0 : aptForm.agreedValue, isCanje: aptForm.isCanje }
              : {}),
          });
          toast.success('Cita agendada');
          // El suero ya quedó escrito en la ficha: si no se dice, mostrador lo
          // vuelve a escribir a mano y acaba duplicado.
          if (creada?.autoSerum?.items?.length) {
            toast.success(
              `Suero anotado en los seguimientos: ${creada.autoSerum.items.join(', ')}`,
              { icon: '💧', duration: 5000 }
            );
          }
        } catch (err) {
          toast.error(
            err.response?.data?.message ||
              'Paciente creado pero no se pudo agendar la cita'
          );
        }
      }
      setModalOpen(false);
      fetchPatients();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('¿Eliminar este paciente?')) return;
    try {
      await api.delete(`/patients/${id}`);
      toast.success('Paciente eliminado');
      fetchPatients();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al eliminar');
    }
  };


  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-emerald-100 text-emerald-700 flex items-center justify-center shadow-sm">
            <HiOutlineUsers className="w-6 h-6" />
          </div>
          <div>
            <h1 className="page-title">Pacientes</h1>
            <p className="page-subtitle">Gestión de pacientes registrados</p>
          </div>
        </div>
        {canWrite && (
          <div className="flex gap-2">
            <button
              onClick={async () => {
                try {
                  await downloadFile('/reports/patients.xlsx', { filename: `pacientes_${Date.now()}.xlsx` });
                } catch (err) {
                  toast.error(err.message || 'Error al exportar');
                }
              }}
              className="btn-secondary"
            >
              <HiOutlineArrowDownTray className="w-4 h-4" /> Excel
            </button>
            {hasRole('admin') && (
              <button onClick={() => setBulkOpen(true)} className="btn-secondary">
                <HiOutlineCloudArrowUp className="w-4 h-4" /> Carga masiva
              </button>
            )}
            <button onClick={openNew} className="btn-primary">
              <HiOutlinePlus className="w-5 h-5" /> Nuevo Paciente
            </button>
          </div>
        )}
      </div>

      <FichasPorRevisar canWrite={canWrite} />

      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 p-4">
        <div className="flex gap-3 items-center flex-wrap">
          <div className="relative flex-1 min-w-[240px]">
            <HiOutlineMagnifyingGlass className="absolute left-3.5 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            {/* Buscar por cédula o teléfono NO es lo mismo que verlos: para
                buscar hay que traerlos ya sabidos. Por eso el buscador es igual
                para todos los roles, aunque la columna de cédula de la tabla
                siga siendo solo del admin. */}
            <input
              type="text"
              placeholder="Buscar por nombre, cédula o teléfono..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="w-full pl-11 pr-4 py-3 border border-slate-200 rounded-xl bg-slate-50/50 outline-none text-sm"
            />
          </div>
          <button
            onClick={() => {
              setOnlyNew((v) => !v);
              setPage(1);
            }}
            className={`px-4 py-3 rounded-xl text-sm font-medium border whitespace-nowrap cursor-pointer ${
              onlyNew
                ? 'bg-emerald-600 text-white border-emerald-600'
                : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
            }`}
          >
            {onlyNew ? '✓ Solo pacientes nuevos' : 'Solo pacientes nuevos'}
          </button>
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr className="bg-emerald-50/50 border-b border-emerald-100">
                {showCedula && <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Cédula</th>}
                <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Nombre</th>
                {/* La EDAD no es un dato de contacto: la ve todo el mundo, y a
                    quien atiende le sirve de un vistazo (de ella salen las
                    dosis) sin tener que abrir la ficha de uno en uno. */}
                <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Edad</th>
                {showContact && <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider hidden md:table-cell">Teléfono</th>}
                {showEmail && <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider hidden lg:table-cell">Email</th>}
                <th className="text-right px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={`sk-${i}`} className="border-b border-emerald-50">
                    {Array.from({ length: columnCount }).map((__, j) => (
                      <td key={j} className="px-6 py-3.5"><div className="skeleton h-4 w-full max-w-[160px]" /></td>
                    ))}
                  </tr>
                ))
              ) : patients.length === 0 ? (
                <tr>
                  <td colSpan={columnCount}>
                    <div className="empty-state">
                      <HiOutlineUsers className="w-10 h-10 text-slate-300" />
                      <p className="font-medium text-slate-500">No se encontraron pacientes</p>
                      <p className="text-xs text-slate-400">Ajusta la búsqueda o registra un nuevo paciente.</p>
                    </div>
                  </td>
                </tr>
              ) : (
                patients.map((p) => (
                  <tr key={p._id} className="border-b border-emerald-50 hover:bg-emerald-50/30">
                    {showCedula && <td className="px-6 py-3.5 text-sm text-slate-600">{p.cedula || '—'}</td>}
                    <td className="px-6 py-3.5 text-sm font-medium text-slate-800">
                      {/* El nombre ya no es obligatorio: sin este respaldo, un
                          paciente registrado solo con la cédula o el teléfono
                          salía como una fila en blanco, imposible de abrir. */}
                      {`${p.firstName || ''} ${p.lastName || ''}`.trim() || (
                        <span className="text-slate-400 italic">Sin nombre</span>
                      )}
                      {(p.marketing?.optOutAt || p.marketing?.whatsappOptIn === false) && (
                        <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-rose-100 text-rose-700">
                          Opt-out
                        </span>
                      )}
                    </td>
                    {/* `computedAge` lo calcula el servidor con la fecha de
                        nacimiento; `age` es el respaldo de quien se registró sin
                        acordarse del día (ver el virtual en models/Patient.js). */}
                    <td className="px-6 py-3.5 text-sm text-slate-600">
                      {p.computedAge ?? p.age ?? '—'}
                    </td>
                    {showContact && (
                      <td className="px-6 py-3.5 text-sm text-slate-600 hidden md:table-cell">
                        {p.phone || '—'}
                      </td>
                    )}
                    {showEmail && (
                      <td className="px-6 py-3.5 text-sm text-slate-600 hidden lg:table-cell">
                        {p.email || '—'}
                      </td>
                    )}
                    <td className="px-6 py-3.5 text-right">
                      <Link
                        to={`/patients/${p._id}`}
                        className="inline-flex p-1.5 rounded-lg hover:bg-emerald-50 text-slate-400 hover:text-emerald-600 transition-colors"
                        title="Ver ficha clínica"
                      >
                        <HiOutlineEye className="w-4 h-4" />
                      </Link>
                      {canWrite && (
                        <button
                          onClick={() => openEdit(p)}
                          className="p-1.5 rounded-lg hover:bg-emerald-50 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer ml-1"
                          title="Editar"
                        >
                          <HiOutlinePencil className="w-4 h-4" />
                        </button>
                      )}
                      {canDelete && (
                        <button
                          onClick={() => handleDelete(p._id)}
                          className="p-1.5 rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-600 bg-transparent border-none cursor-pointer ml-1"
                          title="Eliminar"
                        >
                          <HiOutlineTrash className="w-4 h-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 px-6 py-4 border-t border-emerald-100">
            <button
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
              className="px-4 py-2 rounded-xl text-sm border border-slate-200 disabled:opacity-50 cursor-pointer bg-white hover:bg-emerald-50"
            >
              Anterior
            </button>
            <span className="text-sm text-slate-500">
              Página {page} de {totalPages}
            </span>
            <button
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
              className="px-4 py-2 rounded-xl text-sm border border-slate-200 disabled:opacity-50 cursor-pointer bg-white hover:bg-emerald-50"
            >
              Siguiente
            </button>
          </div>
        )}
      </div>

      <Modal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? 'Editar Paciente' : 'Nuevo Paciente'}
        size="lg"
      >
        {/* Enter NO envía el formulario. Aquí se rellenan quince campos, y una
            pulsación por inercia —muy fácil viniendo de la cédula, que autocompleta—
            guardaba el paciente a medias sin que nadie lo pidiera. Se guarda solo
            desde el botón; el <textarea> conserva su salto de línea, y sobre un
            botón se deja pasar porque ahí Enter ES el clic. */}
        <form
          onSubmit={handleSubmit}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            const tag = e.target.tagName;
            if (tag === 'TEXTAREA' || tag === 'BUTTON') return;
            e.preventDefault();
          }}
          className="space-y-4"
        >
          {/* Los campos del paciente son los MISMOS aquí y en la agenda, donde
              mostrador los corrige con el paciente delante: viven en
              components/PatientFields.jsx para que las reglas por rol y el
              cálculo de la edad no se dupliquen. */}
          <PatientFields
            form={form}
            setForm={setForm}
            telefonos={telefonos}
            setTelefonos={setTelefonos}
            editing={!!editing}
          />
          {!editing && (
            <div className="border-t border-emerald-100 pt-4">
              {/**
                * QUIEN ATIENDE NO AGENDA: ATIENDE.
                *
                * En óptica el cliente entra por la puerta y está delante del
                * optómetra mientras lo registra. Agendarse a sí mismo una cita
                * —elegir día, elegir hora, guardar, y luego buscarla en la
                * agenda para abrirla— es papeleo para algo que está pasando ya.
                *
                * Antes esto era una casilla marcada por defecto que se podía
                * desmarcar para volver al camino de agendar. Ya no: para estos
                * roles el registro ABRE LA CONSULTA, y la cita la escribe el
                * sistema con la hora real y a su nombre (`POST /appointments/
                * walk-in`). Quien necesite agendar para otro día lo hace desde
                * la agenda, que es donde se agenda.
                *
                * Lo único que queda debajo es «solo registrar», que NO crea
                * cita: registrar a alguien no siempre es atenderlo.
                */}
              {puedeAtenderYa ? (
                <>
                  {aptForm.ahora ? (
                    <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2.5 mb-2">
                      <span className="block text-sm font-medium text-slate-800">
                        Al guardar se abre la consulta
                      </span>
                      <span className="block text-[11px] text-slate-500">
                        El sistema registra la atención de ahora —a esta hora y a tu nombre— y entras
                        directo a llenar la ficha. No hay que agendar nada.
                      </span>
                    </div>
                  ) : (
                    <div className="bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 mb-2 text-[11px] text-slate-500">
                      Se guarda solo la ficha del paciente. No se registra ninguna atención.
                    </div>
                  )}
                  {/**
                    * LA SALIDA para cuando NO se está atendiendo: tomar los datos
                    * por teléfono, corregir un duplicado, dejar a alguien creado
                    * para más tarde. Sin esto, cada registro abriría una consulta
                    * y dejaría una cita fantasma —que cuenta en los reportes, en
                    * «paciente nuevo» y en las comisiones— por haber tecleado una
                    * ficha. Va discreta y desmarcada: lo normal es lo de arriba.
                    */}
                  <label className="flex items-center gap-2 cursor-pointer text-[11px] text-slate-500 mb-1">
                    <input
                      type="checkbox"
                      checked={!aptForm.ahora}
                      onChange={(e) =>
                        setAptForm({ ...aptForm, ahora: !e.target.checked, enabled: !e.target.checked })
                      }
                      className="w-3.5 h-3.5 accent-slate-400"
                    />
                    Solo registrar al paciente (no lo estoy atendiendo ahora)
                  </label>
                </>
              ) : (
                <label className="flex items-center gap-2 cursor-pointer text-sm font-medium text-slate-700">
                  <input
                    type="checkbox"
                    checked={aptForm.enabled}
                    onChange={(e) => setAptForm({ ...aptForm, enabled: e.target.checked })}
                    className="w-4 h-4 accent-emerald-600"
                  />
                  Agendar cita para este paciente
                </label>
              )}
              {aptForm.enabled && (
                <div className="mt-3 space-y-3 bg-emerald-50/40 rounded-xl p-3">
                  {/* La atención inmediata siempre es en la sucursal activa (la
                      decide el servidor), así que el selector no pinta nada. */}
                  {/* La sucursal se ESCOGE: venía puesta la activa y la cita se
                      agendaba en la sede equivocada sin que nadie lo notara
                      (mismo cambio que en la agenda). */}
                  {showClinicSelector && !aptForm.ahora && (
                    <Field label="Sucursal destino" required>
                      <select
                        value={aptForm.clinic}
                        onChange={(e) => setAptForm({ ...aptForm, clinic: e.target.value, room: '' })}
                        className="input"
                        required
                      >
                        <option value="">Seleccionar sucursal…</option>
                        {sedes.map((c) => (
                          <option key={c._id} value={c._id}>{nombreSucursal(c)}</option>
                        ))}
                      </select>
                    </Field>
                  )}
                  <div className={"grid grid-cols-1 sm:grid-cols-2 gap-3 " + (aptForm.ahora ? 'hidden' : '')}>
                    <Field label="Fecha" required>
                      <DateInput
                        value={aptForm.date}
                        min={todayEc()}
                        onChange={(e) => setAptForm({ ...aptForm, date: e.target.value })}
                        className="input"
                      />
                    </Field>
                    <Field label="Hora" required>
                      {/* Por tramos, como en la agenda: los espacios los fija
                          la sucursal y el servidor los valida igual. */}
                      <TimeSlotInput
                        value={aptForm.startTime}
                        slotMinutes={slotMinutes}
                        min={aptForm.date === todayEc() ? nowEcHHMM() : undefined}
                        onChange={(e) => setAptForm({ ...aptForm, startTime: e.target.value })}
                        className="input"
                      />
                    </Field>
                  </div>
                  <Field label="Servicio">
                    <ServiceItemPicker
                      value={aptForm.serviceItem}
                      onChange={(item) => setAptForm({ ...aptForm, serviceItem: item })}
                    />
                  </Field>
                  <Field label="Motivo">
                    <textarea
                      value={aptForm.reason}
                      onChange={(e) => setAptForm({ ...aptForm, reason: e.target.value })}
                      rows={2}
                      className="input resize-none"
                    />
                  </Field>
                  {/* Quién atiende, si pasa por enfermería y el suero. El mismo
                      bloque que la agenda, y por eso vive en su componente: dos
                      copias es como una de las dos pantallas se queda sin el
                      selector de ampollas (que es justo lo que pasó).

                      En «atender ahora» no se pinta: esa cita la abre el
                      servidor a nombre de quien está registrando al paciente, y
                      un segundo dueño la dejaría en manos de otro. */}
                  {!aptForm.ahora && (
                    <QuienAtiende
                      form={aptForm}
                      setForm={setAptForm}
                      doctors={personalCita.doctors}
                      nurses={personalCita.nurses}
                    />
                  )}
                  {/* A nombre de quién queda la cita. En «atender ahora» no:
                      esa la abre quien atiende, a su nombre. */}
                  {!aptForm.ahora && (
                    <AgendadoPorSelect
                      value={aptForm.bookedBy}
                      onChange={(v) => setAptForm((f) => ({ ...f, bookedBy: v }))}
                    />
                  )}
                  {/* Valor y canje: el mismo bloque que usa la agenda al recibir
                      al paciente. En «atender ahora» no se pide —esa cita la abre
                      quien atiende, que no fija importes—. */}
                  {puedeFijarValor && !aptForm.ahora && (
                    <AppointmentValueFields
                      value={aptForm.agreedValue}
                      onValueChange={(v) => setAptForm((f) => ({ ...f, agreedValue: v }))}
                      isCanje={aptForm.isCanje}
                      onCanjeChange={(v) => setAptForm((f) => ({ ...f, isCanje: v }))}
                    />
                  )}
                  {aptForm.date && !aptForm.ahora && (
                    <div className="bg-white rounded-lg border border-emerald-100 p-2">
                      <p className="text-xs font-medium text-slate-600 mb-1">
                        Citas agendadas para este día
                      </p>
                      {loadingApts ? (
                        <p className="text-xs text-slate-400 py-1">Cargando...</p>
                      ) : dayApts.length === 0 ? (
                        <p className="text-xs text-emerald-600 py-1">Sin citas — horario disponible</p>
                      ) : (
                        <div className="max-h-24 overflow-y-auto space-y-0.5">
                          {dayApts
                            .slice()
                            .sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''))
                            .map((a) => (
                              <div key={a._id} className="flex items-center gap-2 text-xs text-slate-600 py-0.5">
                                <span className="font-medium text-slate-800 w-12 shrink-0">{a.startTime || '—'}</span>
                                <span className="truncate">{a.patient?.firstName} {a.patient?.lastName}</span>
                                {a.services?.length > 0 && (
                                  <span className="text-slate-400 truncate hidden sm:block">· {a.services.map(s => s.name).join(', ')}</span>
                                )}
                              </div>
                            ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          <div className="flex justify-end gap-3 pt-3">
            <button
              type="button"
              onClick={() => setModalOpen(false)}
              className="px-5 py-2.5 border border-slate-200 rounded-xl text-sm text-slate-600 hover:bg-slate-50 cursor-pointer bg-white"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-5 py-2.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white rounded-xl text-sm font-medium disabled:opacity-50 cursor-pointer border-none shadow-lg shadow-emerald-200/50"
            >
              {saving
                ? 'Guardando...'
                : editing
                  ? 'Actualizar'
                  : aptForm.ahora
                    ? 'Registrar y atender'
                    : 'Crear Paciente'}
            </button>
          </div>
        </form>
      </Modal>

      <BulkUploadModal
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        title="Carga masiva de pacientes"
        description="Sube pacientes con toda su historia: datos generales, ficha clínica (antecedentes) y seguimientos. La plantilla trae una hoja para cada cosa."
        steps={[
          'Hoja "Pacientes": datos generales. Obligatorio nombres, apellidos y género.',
          'Hoja "FichaClinica": antecedentes patológicos personales y familiares.',
          'Hoja "Seguimientos": una fila por consulta (signos vitales, examen físico, CIE-10, plan).',
          'Las hojas se enlazan por la columna identificacion (o por nombres + apellidos).',
          'Si la identificación ya existe, el paciente se actualiza. Los seguimientos SIEMPRE se agregan.',
        ]}
        templateUrl="/patients/import-template"
        templateFilename="plantilla_pacientes_historia_clinica.xlsx"
        uploadUrl="/patients/import"
        onImported={fetchPatients}
      />

      <style>{`
        .input {
          width: 100%;
          padding: 0.625rem 0.875rem;
          border: 1px solid #e2e8f0;
          border-radius: 0.75rem;
          font-size: 0.875rem;
          background: rgba(248, 250, 252, 0.5);
          outline: none;
        }
        .input:focus { border-color: #10b981; background: white; }
      `}</style>
    </div>
  );
}

/**
 * Aviso de las fichas físicas escaneadas que se importaron con datos dudosos.
 *
 * Solo aparece cuando queda alguna pendiente: terminada la tanda, la página
 * vuelve a verse como siempre en lugar de arrastrar un cartel muerto.
 */
function FichasPorRevisar({ canWrite }) {
  const [pendientes, setPendientes] = useState(0);

  useEffect(() => {
    if (!canWrite) return;
    api.get('/patients/scan-review/count')
      .then(({ data }) => setPendientes(data.pendientes || 0))
      .catch(() => {});
  }, [canWrite]);

  if (!canWrite || !pendientes) return null;

  return (
    <Link
      to="/patients/scan-review"
      className="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-2xl p-4 no-underline hover:bg-amber-100/70"
    >
      <div className="w-10 h-10 rounded-xl bg-amber-100 text-amber-700 flex items-center justify-center shrink-0">
        <HiOutlineDocumentMagnifyingGlass className="w-5 h-5" />
      </div>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-amber-900">
          {pendientes} ficha{pendientes === 1 ? '' : 's'} escaneada{pendientes === 1 ? '' : 's'} por revisar
        </p>
        <p className="text-xs text-amber-700">
          Se registraron desde el papel y algunos datos quedaron con dudas. Revísalos contra el documento.
        </p>
      </div>
    </Link>
  );
}
