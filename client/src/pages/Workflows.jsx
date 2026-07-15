import { Fragment, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/axios';
import toast from 'react-hot-toast';
import {
  HiOutlinePlus,
  HiOutlineTrash,
  HiOutlineBolt,
  HiOutlinePencil,
  HiOutlineFolder,
  HiOutlineFolderPlus,
} from 'react-icons/hi2';
import Modal from '../components/Modal';

const TRIGGERS = [
  { value: 'appointment_created', label: 'Cita agendada' },
  { value: 'appointment_confirmed', label: 'Cita confirmada' },
  { value: 'appointment_rescheduled', label: 'Cita reagendada' },
  { value: 'appointment_attended', label: 'Cita asistida' },
  { value: 'appointment_no_show', label: 'No asistió (no-show)' },
  { value: 'appointment_cancelled', label: 'Cita cancelada' },
  { value: 'treatment_abandoned', label: 'Tratamiento abandonado' },
  { value: 'patient_birthday', label: 'Cumpleaños del paciente' },
  { value: 'patient_created', label: 'Paciente creado' },
  { value: 'sale_created', label: 'Venta registrada' },
  { value: 'payment_received', label: 'Pago recibido' },
  { value: 'quotation_sent', label: 'Cotización enviada' },
  { value: 'inbound_message', label: 'Mensaje entrante (chat)' },
  { value: 'keyword', label: 'Palabra clave (chat)' },
  { value: 'new_conversation', label: 'Nueva conversación (chat)' },
  { value: 'tag_added', label: 'Etiqueta añadida' },
  { value: 'ctwa_ad', label: 'Mensaje desde anuncio (Meta Ads)' },
];

// Resumen de disparadores para la lista (soporta varios; lógica OR).
function triggerSummary(wf) {
  const trs = wf.triggers?.length ? wf.triggers : (wf.trigger?.type ? [wf.trigger] : []);
  const first = TRIGGERS.find((t) => t.value === trs[0]?.type)?.label || '—';
  return trs.length > 1 ? `${first} +${trs.length - 1}` : first;
}

export default function Workflows() {
  const navigate = useNavigate();
  const [list, setList] = useState([]);
  const [folders, setFolders] = useState([]);
  const [selectedFolder, setSelectedFolder] = useState('__all__');
  const [presets, setPresets] = useState([]);
  const [enrollView, setEnrollView] = useState(null); // workflow cuyas inscripciones se ven
  const [activityView, setActivityView] = useState(null); // workflow cuya actividad de disparador se ve

  const load = async () => {
    try {
      const [wfs, fld, ps] = await Promise.all([
        api.get('/workflows'),
        api.get('/workflows/folders').catch(() => ({ data: [] })),
        api.get('/workflows/presets').catch(() => ({ data: [] })),
      ]);
      setList(wfs.data);
      setFolders(fld.data || []);
      setPresets(ps.data);
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al cargar workflows');
    }
  };
  useEffect(() => { load(); }, []);

  // Nombres de carpeta = carpetas creadas + las usadas por algún workflow.
  const folderNames = useMemo(() => {
    const set = new Set(folders.map((f) => f.name));
    list.forEach((wf) => set.add(wf.folder || 'General'));
    return [...set].sort();
  }, [folders, list]);

  const visibleList = useMemo(
    () => (selectedFolder === '__all__' ? list : list.filter((wf) => (wf.folder || 'General') === selectedFolder)),
    [list, selectedFolder]
  );

  const createFolder = async () => {
    const name = window.prompt('Nombre de la nueva carpeta:');
    if (!name || !name.trim()) return;
    try {
      await api.post('/workflows/folders', { name: name.trim() });
      toast.success('Carpeta creada');
      setSelectedFolder(name.trim());
      load();
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al crear carpeta');
    }
  };
  const deleteFolder = async (folder) => {
    if (!window.confirm(`¿Eliminar la carpeta "${folder.name}"?`)) return;
    try {
      await api.delete(`/workflows/folders/${folder._id}`);
      toast.success('Carpeta eliminada');
      if (selectedFolder === folder.name) setSelectedFolder('__all__');
      load();
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al eliminar carpeta');
    }
  };

  const openNew = () => {
    const folder = selectedFolder === '__all__' ? '' : `?folder=${encodeURIComponent(selectedFolder)}`;
    navigate(`/workflows/new${folder}`);
  };

  const openEdit = (wf) => navigate(`/workflows/${wf._id}/edit`);

  const installPreset = async (key) => {
    try {
      await api.post(`/workflows/presets/${key}`);
      toast.success('Automatización instalada (pausada). Revísala y actívala.');
      load();
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al instalar');
    }
  };

  const toggleActive = async (wf) => {
    try {
      await api.put(`/workflows/${wf._id}`, { active: !wf.active });
      load();
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error');
    }
  };

  const remove = async (id) => {
    if (!window.confirm('¿Eliminar este workflow? Se cancelan sus inscripciones activas.')) return;
    try {
      await api.delete(`/workflows/${id}`);
      toast.success('Eliminado');
      load();
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error');
    }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><HiOutlineBolt className="text-emerald-600" /> Automatizaciones (Workflows)</h1>
          <p className="text-sm text-slate-500 mt-1">Organízalas en carpetas. Cada automatización se dispara por eventos (citas, tratamientos, ventas, cumpleaños) o por chat (palabra clave, mensaje entrante).</p>
        </div>
        <button onClick={openNew} className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm flex items-center gap-1 cursor-pointer border-none"><HiOutlinePlus /> Nuevo workflow</button>
      </div>

      {presets.length > 0 && (
        <div className="mb-5 border border-emerald-100 bg-emerald-50/50 rounded-xl p-4">
          <p className="text-sm font-semibold text-slate-600 mb-2">Instalar automatización de clínica (se crea pausada para revisar):</p>
          <div className="flex flex-wrap gap-2">
            {presets.map((p) => (
              <button key={p.key} onClick={() => installPreset(p.key)} className="px-3 py-1.5 bg-white border border-emerald-200 text-emerald-700 rounded-lg text-xs cursor-pointer hover:border-emerald-400">
                + {p.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[240px_1fr] gap-4">
        {/* Sidebar de carpetas */}
        <aside className="bg-white rounded-2xl border border-slate-200 shadow-sm p-3 h-max">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Carpetas</span>
            <button onClick={createFolder} title="Nueva carpeta" className="p-1 text-emerald-600 hover:bg-emerald-50 rounded-lg bg-transparent border-none cursor-pointer">
              <HiOutlineFolderPlus className="w-5 h-5" />
            </button>
          </div>
          <button onClick={() => setSelectedFolder('__all__')} className={`w-full text-left px-3 py-2 rounded-lg text-sm mb-1 cursor-pointer border-none flex items-center justify-between ${selectedFolder === '__all__' ? 'bg-emerald-600 text-white' : 'bg-transparent text-slate-700 hover:bg-slate-50'}`}>
            <span>Todas</span>
            <span className="text-xs opacity-70">{list.length}</span>
          </button>
          {folderNames.map((name) => {
            const folderDoc = folders.find((f) => f.name === name);
            const count = list.filter((wf) => (wf.folder || 'General') === name).length;
            return (
              <div key={name} className="group flex items-center">
                <button onClick={() => setSelectedFolder(name)} className={`flex-1 text-left px-3 py-2 rounded-lg text-sm mb-1 cursor-pointer border-none flex items-center justify-between gap-2 ${selectedFolder === name ? 'bg-emerald-600 text-white' : 'bg-transparent text-slate-700 hover:bg-slate-50'}`}>
                  <span className="flex items-center gap-2 truncate"><HiOutlineFolder className="w-4 h-4 shrink-0" /> {name}</span>
                  <span className="text-xs opacity-70">{count}</span>
                </button>
                {folderDoc && (
                  <button onClick={() => deleteFolder(folderDoc)} title="Eliminar carpeta" className="p-1 text-slate-300 hover:text-red-500 bg-transparent border-none cursor-pointer opacity-0 group-hover:opacity-100">
                    <HiOutlineTrash className="w-4 h-4" />
                  </button>
                )}
              </div>
            );
          })}
          {folderNames.length === 0 && <p className="text-xs text-slate-400 px-2 py-3">Crea una carpeta para organizar tus automatizaciones.</p>}
        </aside>

        {/* Lista de automatizaciones (filtrada por carpeta) */}
        <div className="grid gap-3 content-start">
          {visibleList.length === 0 && (
            <div className="text-center py-16 text-slate-400 border border-dashed border-slate-200 rounded-xl">
              {selectedFolder === '__all__' ? 'Aún no hay automatizaciones.' : 'Sin automatizaciones en esta carpeta.'}
            </div>
          )}
          {visibleList.map((wf) => (
            <div key={wf._id} className="border border-slate-200 rounded-xl p-4 bg-white flex justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold">{wf.name}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${wf.active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{wf.active ? 'Activo' : 'Pausado'}</span>
                  <span className="text-xs text-slate-400 inline-flex items-center gap-1"><HiOutlineFolder className="w-3.5 h-3.5" /> {wf.folder || 'General'}</span>
                  <span className="text-xs text-slate-400">{triggerSummary(wf)} · {((wf.nodes || []).filter((n) => n.type !== 'trigger').length) || wf.steps?.length || 0} paso(s)</span>
                </div>
                <div className="text-xs text-slate-400 mt-1">Inscritos: {wf.stats?.enrolled || 0} · Completados: {wf.stats?.completed || 0}</div>
              </div>
              <div className="flex items-start gap-1 shrink-0">
                <button onClick={() => toggleActive(wf)} className="px-3 py-1.5 border border-slate-200 rounded-lg text-xs bg-white cursor-pointer">{wf.active ? 'Pausar' : 'Activar'}</button>
                <button onClick={() => setEnrollView(wf)} className="px-3 py-1.5 border border-slate-200 rounded-lg text-xs bg-white cursor-pointer">Inscritos</button>
                <button
                  onClick={() => setActivityView(wf)}
                  title="Por cada evento (cita, pago…): si inscribió al paciente o por qué no"
                  className="px-3 py-1.5 border border-slate-200 rounded-lg text-xs bg-white cursor-pointer"
                >
                  Actividad
                </button>
                <button onClick={() => openEdit(wf)} className="p-2 text-slate-500 hover:text-emerald-600 bg-transparent border-none cursor-pointer"><HiOutlinePencil /></button>
                <button onClick={() => remove(wf._id)} className="p-2 text-slate-500 hover:text-red-600 bg-transparent border-none cursor-pointer"><HiOutlineTrash /></button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {enrollView && (
        <EnrollmentsModal workflow={enrollView} onClose={() => setEnrollView(null)} />
      )}
      {activityView && (
        <ActivityModal workflow={activityView} onClose={() => setActivityView(null)} />
      )}
    </div>
  );
}

const ACTIVITY_DECISION = {
  enrolled: { label: 'Inscrito ✓', cls: 'bg-emerald-100 text-emerald-700' },
  skipped_duplicate: { label: 'Saltado (duplicado)', cls: 'bg-amber-100 text-amber-700' },
  no_match: { label: 'No coincidió', cls: 'bg-slate-100 text-slate-500' },
};

// Actividad del disparador: cada evento evaluado y la decisión tomada. Es la
// respuesta a "ocurrió el evento y no pasó nada" cuando ni siquiera hay inscripción.
function ActivityModal({ workflow, onClose }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get(`/workflows/${workflow._id}/activity`)
      .then((r) => setRows(r.data || []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [workflow._id]);

  const fmt = (d) =>
    d
      ? new Date(d).toLocaleString('es-EC', {
          timeZone: 'America/Guayaquil',
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '—';
  const evLabel = (t) => TRIGGERS.find((x) => x.value === t)?.label || t;

  return (
    <Modal isOpen onClose={onClose} title={`Actividad del disparador — ${workflow.name}`} size="xl">
      <div>
        <p className="text-xs text-slate-500 -mt-1 mb-4">
          Cada vez que ocurre un evento (cita agendada, pago, etc.) aquí queda registrado si este
          workflow <b>inscribió</b> al paciente o <b>por qué no</b>. Si un evento ni aparece, el
          workflow estaba pausado o el evento no llegó a emitirse. Se conserva 30 días.
        </p>
        {loading ? (
          <div className="text-center py-10 text-slate-400 text-sm">Cargando…</div>
        ) : rows.length === 0 ? (
          <div className="text-center py-10 text-slate-400 text-sm">
            Sin actividad registrada aún. Ocurre a partir de ahora: provoca el evento (p. ej. agenda
            una cita) y vuelve a abrir esta ventana.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl w-full">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="text-left px-3 py-2">Cuándo</th>
                  <th className="text-left px-3 py-2">Evento</th>
                  <th className="text-left px-3 py-2">Paciente</th>
                  <th className="text-center px-3 py-2">Decisión</th>
                  <th className="text-left px-3 py-2">Detalle</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const d = ACTIVITY_DECISION[r.decision] || ACTIVITY_DECISION.no_match;
                  return (
                    <tr key={r._id} className="border-t border-slate-100">
                      <td className="px-3 py-2 whitespace-nowrap">{fmt(r.createdAt)}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{evLabel(r.eventType)}</td>
                      <td className="px-3 py-2">{r.patientName || '—'}</td>
                      <td className="px-3 py-2 text-center">
                        <span className={`text-[11px] px-2 py-0.5 rounded-full whitespace-nowrap ${d.cls}`}>{d.label}</span>
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-500 max-w-[340px]">{r.detail}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex justify-end mt-4">
          <button onClick={onClose} className="px-4 py-2 border border-slate-200 rounded-lg text-sm bg-white cursor-pointer">
            Cerrar
          </button>
        </div>
      </div>
    </Modal>
  );
}

const ENROLL_STATUS = {
  active: { label: 'Ejecutando', cls: 'bg-blue-100 text-blue-700' },
  waiting: { label: 'En espera', cls: 'bg-amber-100 text-amber-700' },
  done: { label: 'Completado', cls: 'bg-emerald-100 text-emerald-700' },
  cancelled: { label: 'Cancelado', cls: 'bg-slate-100 text-slate-500' },
};

// Etiquetas legibles de los tipos de paso para el registro de ejecución.
const STEP_LABELS = {
  send_message: 'Enviar mensaje',
  send_media: 'Enviar imagen / video',
  send_template: 'Enviar plantilla',
  send_email: 'Enviar email',
  wait: 'Espera',
  wait_until: 'Espera hasta la cita',
  wait_reply: 'Esperar respuesta',
  condition: 'Condición',
  goal: 'Objetivo',
  add_tag: 'Añadir etiqueta',
  remove_tag: 'Quitar etiqueta',
  move_stage: 'Mover etapa',
  set_appointment_status: 'Cambiar estado de cita',
  assign_agent: 'Asignar agente',
  create_task: 'Crear tarea',
  webhook: 'Webhook',
  ai_reply: 'Respuesta IA',
  request_review: 'Pedir reseña',
};

// Vista de inscripciones de un workflow (quién está en qué paso) para depurar,
// con el registro de ejecución de cada inscripción (estilo "Registros" de GHL).
function EnrollmentsModal({ workflow, onClose }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [openLog, setOpenLog] = useState(null); // _id de la inscripción expandida

  useEffect(() => {
    setLoading(true);
    api
      .get(`/workflows/${workflow._id}/enrollments`, { params: statusFilter ? { status: statusFilter } : {} })
      .then((r) => setRows(r.data || []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [workflow._id, statusFilter]);

  const fmt = (d) => (d ? new Date(d).toLocaleString('es-EC', { timeZone: 'America/Guayaquil', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');

  return (
    <Modal isOpen onClose={onClose} title={`Inscritos — ${workflow.name}`} size="xl">
      <div>
        <p className="text-xs text-slate-500 -mt-1 mb-4">
          Pacientes que pasaron por esta automatización. Haz clic en una fila para ver el
          <b> registro de ejecución</b>: qué hizo cada paso y por qué falló un envío (p.ej. ventana de 24h de WhatsApp).
        </p>
        <div className="mb-3">
          <label className="text-xs text-slate-500 mr-2">Filtrar por estado</label>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
            <option value="">Todos</option>
            <option value="active">Ejecutando</option>
            <option value="waiting">En espera</option>
            <option value="done">Completado</option>
            <option value="cancelled">Cancelado</option>
          </select>
        </div>
        {loading ? (
          <div className="text-center py-10 text-slate-400 text-sm">Cargando…</div>
        ) : rows.length === 0 ? (
          <div className="text-center py-10 text-slate-400 text-sm">Sin inscripciones.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl w-full">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="text-left px-3 py-2">Paciente / Teléfono</th>
                  <th className="text-center px-3 py-2">Estado</th>
                  <th className="text-center px-3 py-2">Pasos OK / fallidos</th>
                  <th className="text-left px-3 py-2">Próxima ejecución</th>
                  <th className="text-left px-3 py-2">Último error</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => {
                  const st = ENROLL_STATUS[e.status] || ENROLL_STATUS.active;
                  const name = e.patient ? `${e.patient.firstName || ''} ${e.patient.lastName || ''}`.trim() : '';
                  const log = e.log || [];
                  const fails = log.filter((l) => l.ok === false).length;
                  const isOpen = openLog === e._id;
                  return (
                    <Fragment key={e._id}>
                      <tr
                        className={`border-t border-slate-100 cursor-pointer hover:bg-slate-50 ${isOpen ? 'bg-slate-50' : ''}`}
                        onClick={() => setOpenLog(isOpen ? null : e._id)}
                      >
                        <td className="px-3 py-2">{name || e.patient?.phone || e.context?.phone || 'Contacto'}</td>
                        <td className="px-3 py-2 text-center"><span className={`text-[11px] px-2 py-0.5 rounded-full ${st.cls}`}>{st.label}</span></td>
                        <td className="px-3 py-2 text-center">
                          <span className="text-emerald-600 font-medium">{log.length - fails}</span>
                          {fails > 0 && <span className="text-rose-600 font-medium"> / {fails} ✗</span>}
                        </td>
                        <td className="px-3 py-2">{e.status === 'waiting' ? fmt(e.nextRunAt) : '—'}</td>
                        <td className="px-3 py-2 max-w-[260px]">
                          {e.lastError ? <span className="text-[11px] text-rose-600 line-clamp-2">{e.lastError}</span> : <span className="text-slate-300">—</span>}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="border-t border-slate-100 bg-slate-50/60">
                          <td colSpan={5} className="px-4 py-3">
                            {log.length === 0 ? (
                              <p className="text-xs text-slate-400">Sin registro de ejecución (inscripción anterior a esta versión o aún sin pasos ejecutados).</p>
                            ) : (
                              <ol className="grid gap-1">
                                {log.map((l, i) => (
                                  <li key={i} className="text-xs flex items-start gap-2">
                                    <span className={l.ok === false ? 'text-rose-500' : 'text-emerald-500'}>{l.ok === false ? '✗' : '✓'}</span>
                                    <span className="text-slate-400 shrink-0">{fmt(l.at)}</span>
                                    <span className="font-medium text-slate-600 shrink-0">{STEP_LABELS[l.type] || l.type}</span>
                                    {l.info && <span className={l.ok === false ? 'text-rose-600' : 'text-slate-500'}>{l.info}</span>}
                                  </li>
                                ))}
                              </ol>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}
