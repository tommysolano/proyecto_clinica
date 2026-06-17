import { useEffect, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import {
  HiOutlinePlus,
  HiOutlineTrash,
  HiOutlineBolt,
  HiOutlineArrowUp,
  HiOutlineArrowDown,
  HiOutlinePencil,
} from 'react-icons/hi2';

const TRIGGERS = [
  { value: 'appointment_created', label: 'Cita agendada' },
  { value: 'appointment_attended', label: 'Cita asistida' },
  { value: 'appointment_no_show', label: 'No asistió (no-show)' },
  { value: 'treatment_abandoned', label: 'Tratamiento abandonado' },
  { value: 'patient_birthday', label: 'Cumpleaños del paciente' },
];
const AUDIENCES = [
  { value: 'all', label: 'Todos' },
  { value: 'new', label: 'Solo primera visita' },
  { value: 'existing', label: 'Solo recurrentes' },
];
const STAGES = ['nuevo', 'contactado', 'interesado', 'agendado', 'ganado', 'perdido'];
const STEP_DEFS = {
  send_message: 'Enviar mensaje',
  send_template: 'Enviar plantilla',
  wait: 'Esperar (tiempo)',
  wait_until: 'Esperar hasta la cita',
  wait_reply: 'Esperar respuesta',
  condition: 'Condición (si/no)',
  add_tag: 'Añadir etiqueta',
  remove_tag: 'Quitar etiqueta',
  move_stage: 'Mover etapa',
  set_appointment_status: 'Cambiar estado de cita',
  goal: 'Objetivo (terminar si)',
};
const FIELDS = [
  { value: 'tag', label: 'Etiqueta del paciente' },
  { value: 'stage', label: 'Etapa de oportunidad' },
  { value: 'source', label: 'Fuente del paciente' },
  { value: 'lastReply', label: 'Última respuesta del paciente' },
  { value: 'hasPatient', label: 'Tiene paciente vinculado' },
];
const REPLY_VALUES = [
  { value: 'yes', label: 'Sí (confirmó)' },
  { value: 'no', label: 'No (canceló)' },
  { value: 'other', label: 'Otra' },
];
const OPS = [
  { value: 'eq', label: 'es igual a' },
  { value: 'neq', label: 'es distinto de' },
  { value: 'contains', label: 'contiene' },
  { value: 'exists', label: 'existe' },
];

const newStep = (type) => ({ type, body: '', templateName: '', templateLanguage: 'es', waitMinutes: 60, waitEvent: 'appointment_date', offsetMinutes: -1440, timeoutMinutes: 720, appointmentStatus: 'confirmada', field: 'tag', op: 'eq', value: '', onFailGoTo: null, tag: '', stage: 'contactado' });
const blank = () => ({ name: '', folder: 'General', active: false, trigger: { type: 'appointment_created', audience: 'all', serviceFilter: null }, steps: [] });

export default function Workflows() {
  const [list, setList] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [presets, setPresets] = useState([]);
  const [editing, setEditing] = useState(null);

  const load = async () => {
    try {
      const [wfs, tpls, ps] = await Promise.all([
        api.get('/workflows'),
        api.get('/message-templates?channel=whatsapp').catch(() => ({ data: [] })),
        api.get('/workflows/presets').catch(() => ({ data: [] })),
      ]);
      setList(wfs.data);
      setTemplates(tpls.data.filter((t) => t.status === 'approved'));
      setPresets(ps.data);
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al cargar workflows');
    }
  };
  useEffect(() => { load(); }, []);

  const installPreset = async (key) => {
    try {
      await api.post(`/workflows/presets/${key}`);
      toast.success('Automatización instalada (pausada). Revísala y actívala.');
      load();
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al instalar');
    }
  };

  const save = async () => {
    if (!editing.name.trim()) return toast.error('Ponle un nombre al workflow');
    if (!editing.steps.length) return toast.error('Agrega al menos un paso');
    try {
      if (editing._id) await api.put(`/workflows/${editing._id}`, editing);
      else await api.post('/workflows', editing);
      toast.success('Workflow guardado');
      setEditing(null);
      load();
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al guardar');
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

  // ---- edición de pasos ----
  const setStep = (idx, patch) => {
    const steps = editing.steps.map((s, i) => (i === idx ? { ...s, ...patch } : s));
    setEditing({ ...editing, steps });
  };
  const moveStep = (idx, dir) => {
    const j = idx + dir;
    if (j < 0 || j >= editing.steps.length) return;
    const steps = [...editing.steps];
    [steps[idx], steps[j]] = [steps[j], steps[idx]];
    setEditing({ ...editing, steps });
  };
  const removeStep = (idx) => setEditing({ ...editing, steps: editing.steps.filter((_, i) => i !== idx) });
  const addStep = (type) => setEditing({ ...editing, steps: [...editing.steps, newStep(type)] });

  const isApptTrigger = editing?.trigger?.type?.startsWith('appointment');

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><HiOutlineBolt className="text-emerald-600" /> Automatizaciones (Workflows)</h1>
          <p className="text-sm text-slate-500 mt-1">Secuencias disparadas por eventos: citas, tratamientos, cumpleaños.</p>
        </div>
        <button onClick={() => setEditing(blank())} className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm flex items-center gap-1 cursor-pointer border-none"><HiOutlinePlus /> Nuevo workflow</button>
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

      <div className="grid gap-3">
        {list.length === 0 && <div className="text-center py-16 text-slate-400 border border-dashed border-slate-200 rounded-xl">Aún no hay automatizaciones.</div>}
        {list.map((wf) => (
          <div key={wf._id} className="border border-slate-200 rounded-xl p-4 bg-white flex justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold">{wf.name}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full ${wf.active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{wf.active ? 'Activo' : 'Pausado'}</span>
                <span className="text-xs text-slate-400">{TRIGGERS.find((t) => t.value === wf.trigger?.type)?.label} · {wf.steps?.length || 0} paso(s)</span>
              </div>
              <div className="text-xs text-slate-400 mt-1">Inscritos: {wf.stats?.enrolled || 0} · Completados: {wf.stats?.completed || 0}</div>
            </div>
            <div className="flex items-start gap-1 shrink-0">
              <button onClick={() => toggleActive(wf)} className="px-3 py-1.5 border border-slate-200 rounded-lg text-xs bg-white cursor-pointer">{wf.active ? 'Pausar' : 'Activar'}</button>
              <button onClick={() => setEditing({ ...wf, trigger: { ...wf.trigger }, steps: (wf.steps || []).map((s) => ({ ...s })) })} className="p-2 text-slate-500 hover:text-emerald-600 bg-transparent border-none cursor-pointer"><HiOutlinePencil /></button>
              <button onClick={() => remove(wf._id)} className="p-2 text-slate-500 hover:text-red-600 bg-transparent border-none cursor-pointer"><HiOutlineTrash /></button>
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl p-6 w-full max-w-2xl max-h-[92vh] overflow-auto">
            <h2 className="text-lg font-bold mb-4">{editing._id ? 'Editar' : 'Nuevo'} workflow</h2>

            <div className="grid gap-3">
              <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Nombre" className="border border-slate-200 rounded-lg px-3 py-2 text-sm" />

              <div className="border border-slate-100 rounded-lg p-3 bg-slate-50">
                <p className="text-xs font-semibold text-slate-500 uppercase mb-2">Disparador</p>
                <select value={editing.trigger.type} onChange={(e) => setEditing({ ...editing, trigger: { ...editing.trigger, type: e.target.value } })} className="w-full border border-slate-200 rounded-lg px-2 py-2 text-sm">
                  {TRIGGERS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                {isApptTrigger && (
                  <select value={editing.trigger.audience} onChange={(e) => setEditing({ ...editing, trigger: { ...editing.trigger, audience: e.target.value } })} className="w-full mt-2 border border-slate-200 rounded-lg px-2 py-2 text-sm">
                    {AUDIENCES.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                  </select>
                )}
              </div>

              <div>
                <p className="text-xs font-semibold text-slate-500 uppercase mb-2">Pasos</p>
                <div className="grid gap-2">
                  {editing.steps.map((s, idx) => (
                    <div key={idx} className="border border-slate-200 rounded-lg p-3">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm font-medium">{idx + 1}. {STEP_DEFS[s.type]}</span>
                        <div className="flex gap-1">
                          <button onClick={() => moveStep(idx, -1)} className="p-1 text-slate-400 bg-transparent border-none cursor-pointer"><HiOutlineArrowUp /></button>
                          <button onClick={() => moveStep(idx, 1)} className="p-1 text-slate-400 bg-transparent border-none cursor-pointer"><HiOutlineArrowDown /></button>
                          <button onClick={() => removeStep(idx)} className="p-1 text-red-400 bg-transparent border-none cursor-pointer"><HiOutlineTrash /></button>
                        </div>
                      </div>
                      {s.type === 'send_message' && (
                        <textarea value={s.body} onChange={(e) => setStep(idx, { body: e.target.value })} rows={2} placeholder="Mensaje (usa {{nombre}})" className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
                      )}
                      {s.type === 'send_template' && (
                        <select value={s.templateName} onChange={(e) => setStep(idx, { templateName: e.target.value })} className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
                          <option value="">Selecciona plantilla…</option>
                          {templates.map((t) => <option key={t._id} value={t.name}>{t.name}</option>)}
                        </select>
                      )}
                      {s.type === 'wait' && (
                        <div className="flex items-center gap-2 text-sm">
                          <span className="text-slate-600">Esperar</span>
                          <input type="number" value={s.waitMinutes} onChange={(e) => setStep(idx, { waitMinutes: Number(e.target.value) })} className="w-24 border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
                          <span className="text-slate-500">minutos</span>
                        </div>
                      )}
                      {s.type === 'wait_until' && (
                        <div className="flex items-center gap-2 text-sm flex-wrap">
                          <span className="text-slate-600">Esperar hasta</span>
                          <input type="number" value={Math.abs(s.offsetMinutes / 60)} onChange={(e) => setStep(idx, { offsetMinutes: (s.offsetMinutes < 0 ? -1 : 1) * Number(e.target.value) * 60 })} className="w-20 border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
                          <span className="text-slate-500">horas</span>
                          <select value={s.offsetMinutes < 0 ? 'before' : 'after'} onChange={(e) => setStep(idx, { offsetMinutes: (e.target.value === 'before' ? -1 : 1) * Math.abs(s.offsetMinutes) })} className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
                            <option value="before">antes de la cita</option>
                            <option value="after">después de la cita</option>
                          </select>
                        </div>
                      )}
                      {(s.type === 'condition' || s.type === 'goal') && (
                        <div className="flex items-center gap-2 text-sm flex-wrap">
                          <select value={s.field} onChange={(e) => setStep(idx, { field: e.target.value })} className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
                            {FIELDS.map((ff) => <option key={ff.value} value={ff.value}>{ff.label}</option>)}
                          </select>
                          <select value={s.op} onChange={(e) => setStep(idx, { op: e.target.value })} className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
                            {OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                          {s.op !== 'exists' && s.field === 'lastReply' && (
                            <select value={s.value} onChange={(e) => setStep(idx, { value: e.target.value })} className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
                              {REPLY_VALUES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                            </select>
                          )}
                          {s.op !== 'exists' && s.field !== 'hasPatient' && s.field !== 'lastReply' && (
                            <input value={s.value} onChange={(e) => setStep(idx, { value: e.target.value })} placeholder="valor" className="w-28 border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
                          )}
                        </div>
                      )}
                      {s.type === 'wait_reply' && (
                        <div className="flex items-center gap-2 text-sm">
                          <span className="text-slate-600">Esperar respuesta hasta</span>
                          <input type="number" value={Math.round(s.timeoutMinutes / 60)} onChange={(e) => setStep(idx, { timeoutMinutes: Number(e.target.value) * 60 })} className="w-20 border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
                          <span className="text-slate-500">horas (luego continúa sin respuesta)</span>
                        </div>
                      )}
                      {s.type === 'set_appointment_status' && (
                        <select value={s.appointmentStatus} onChange={(e) => setStep(idx, { appointmentStatus: e.target.value })} className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
                          <option value="confirmada">Marcar cita como CONFIRMADA</option>
                          <option value="cancelada">Marcar cita como CANCELADA</option>
                        </select>
                      )}
                      {(s.type === 'add_tag' || s.type === 'remove_tag') && (
                        <input value={s.tag} onChange={(e) => setStep(idx, { tag: e.target.value })} placeholder="etiqueta" className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
                      )}
                      {s.type === 'move_stage' && (
                        <select value={s.stage} onChange={(e) => setStep(idx, { stage: e.target.value })} className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
                          {STAGES.map((st) => <option key={st} value={st}>{st}</option>)}
                        </select>
                      )}
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap gap-1 mt-2">
                  {Object.entries(STEP_DEFS).map(([type, label]) => (
                    <button key={type} onClick={() => addStep(type)} className="px-2 py-1 border border-slate-200 rounded-lg text-xs bg-white cursor-pointer hover:border-emerald-400">+ {label}</button>
                  ))}
                </div>
              </div>

              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} />
                Activar al guardar
              </label>
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <button onClick={() => setEditing(null)} className="px-4 py-2 border border-slate-200 rounded-lg text-sm bg-white cursor-pointer">Cancelar</button>
              <button onClick={save} className="px-5 py-2 bg-emerald-600 text-white rounded-lg text-sm cursor-pointer border-none">Guardar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
