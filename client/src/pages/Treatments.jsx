import { useEffect, useMemo, useState } from 'react';
import api from '../api/axios';
import { downloadFile } from '../utils/download';
import toast from 'react-hot-toast';
import Modal from '../components/Modal';
import NumericInput from '../components/NumericInput';
import {
  HiOutlinePlus,
  HiOutlinePencilSquare,
  HiOutlineTrash,
  HiOutlineHeart,
  HiOutlineChatBubbleLeftRight,
  HiOutlineArrowDownTray,
} from 'react-icons/hi2';
import { useAuth } from '../context/AuthContext';
import { useSocketEvent } from '../context/SocketContext';
import { fmtDate } from '../utils/date';
import DateInput from '../components/DateInput';

const STATUSES = [
  { value: 'activo', label: 'Activo', color: 'bg-emerald-100 text-emerald-800' },
  { value: 'completado', label: 'Completado', color: 'bg-sky-100 text-sky-800' },
  { value: 'abandonado', label: 'Abandonado', color: 'bg-rose-100 text-rose-800' },
];

const EMPTY = {
  patient: '',
  name: '',
  description: '',
  prescribedBy: '',
  startDate: new Date().toISOString().slice(0, 10),
  targetEndDate: '',
  notes: '',
  items: [{ product: '', quantity: 1 }],
};

export default function Treatments() {
  const { hasRole } = useAuth();
  const canEdit = hasRole('admin', 'doctor');
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [alertFilter, setAlertFilter] = useState(''); // '', 'completed', 'warning', 'abandoned'
  const [selectedIds, setSelectedIds] = useState([]);
  const [waModal, setWaModal] = useState(false);
  const [waMessage, setWaMessage] = useState(
    'Hola {{name}}, queremos recordarte que tu tratamiento "{{treatment}}" está pendiente. ¡Te esperamos en la clínica!'
  );
  const [waSending, setWaSending] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [patients, setPatients] = useState([]);
  const [products, setProducts] = useState([]);
  const [doctors, setDoctors] = useState([]);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const params = {};
      if (statusFilter) params.status = statusFilter;
      const res = await api.get('/treatments', { params });
      setList(res.data || []);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al cargar tratamientos');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    Promise.all([
      api.get('/patients').then((r) => setPatients(r.data.patients || r.data || [])),
      api.get('/products').then((r) => setProducts((r.data.products || r.data || []).filter((p) => p.category === 'servicio' || p.category === 'programa'))),
      api.get('/users').then((r) => setDoctors(r.data || [])),
    ]).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  // Realtime
  useSocketEvent('treatment:created', () => load(), []);
  useSocketEvent('treatment:updated', () => load(), []);
  useSocketEvent('treatment:deleted', () => load(), []);

  // Apply alert filter client-side using the virtual `abandonAlert`
  const filteredList = useMemo(() => {
    if (!alertFilter) return list;
    if (alertFilter === 'completed') return list.filter((t) => t.status === 'completado');
    if (alertFilter === 'zero') return list.filter((t) => (t.progress || 0) === 0);
    return list.filter((t) => t.abandonAlert === alertFilter);
  }, [list, alertFilter]);

  const toggleSelect = (id) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };
  const toggleSelectAll = () => {
    if (selectedIds.length === filteredList.length) setSelectedIds([]);
    else setSelectedIds(filteredList.map((t) => t._id));
  };

  const downloadExcel = async () => {
    try {
      await downloadFile('/treatments/reminders.xlsx', {
        params: { alert: alertFilter || 'abandoned' },
        filename: `recordatorios-${alertFilter || 'abandoned'}.xlsx`,
      });
    } catch (err) {
      toast.error(err.message || 'Error al descargar Excel');
    }
  };

  const sendBroadcast = async () => {
    if (!waMessage.trim()) {
      toast.error('El mensaje es requerido');
      return;
    }
    setWaSending(true);
    try {
      const body = { message: waMessage };
      if (selectedIds.length) body.treatmentIds = selectedIds;
      else body.alert = alertFilter || 'abandoned';
      const res = await api.post('/treatments/whatsapp-broadcast', body);
      const msg = res.data.simulated
        ? `Simulado (sin WhatsApp configurado): ${res.data.sent}/${res.data.total}`
        : `Enviados ${res.data.sent}/${res.data.total} (fallidos: ${res.data.failed})`;
      toast.success(msg);
      setWaModal(false);
      setSelectedIds([]);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al enviar WhatsApp');
    } finally {
      setWaSending(false);
    }
  };

  const openNew = () => {
    setEditing(null);
    setForm(EMPTY);
    setShowModal(true);
  };

  const openEdit = (t) => {
    setEditing(t);
    setForm({
      patient: t.patient?._id || '',
      name: t.name || '',
      description: t.description || '',
      prescribedBy: t.prescribedBy?._id || '',
      startDate: (t.startDate || '').slice(0, 10),
      targetEndDate: (t.targetEndDate || '').slice(0, 10),
      notes: t.notes || '',
      items: (t.items || []).map((it) => ({
        product: it.product?._id || it.product,
        quantity: it.quantity,
      })),
    });
    setShowModal(true);
  };

  const updateItem = (idx, field, value) => {
    const items = [...form.items];
    items[idx] = { ...items[idx], [field]: value };
    setForm({ ...form, items });
  };

  const addItem = () =>
    setForm({ ...form, items: [...form.items, { product: '', quantity: 1 }] });

  const removeItem = (idx) =>
    setForm({ ...form, items: form.items.filter((_, i) => i !== idx) });

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const body = {
        ...form,
        items: form.items.filter((it) => it.product),
      };
      if (editing) {
        await api.put(`/treatments/${editing._id}`, body);
        toast.success('Tratamiento actualizado');
      } else {
        await api.post('/treatments', body);
        toast.success('Tratamiento creado');
      }
      setShowModal(false);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (t) => {
    if (!confirm(`¿Eliminar tratamiento "${t.name}"?`)) return;
    try {
      await api.delete(`/treatments/${t._id}`);
      toast.success('Eliminado');
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    }
  };

  const completeItem = async (t, itemIndex) => {
    try {
      await api.post(`/treatments/${t._id}/complete-item`, { itemIndex });
      toast.success('Cumplimiento registrado');
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
            <HiOutlineHeart className="text-emerald-600" /> Tratamientos
          </h1>
          <p className="text-sm text-slate-500">
            Sigue el avance de los planes de tratamiento de cada paciente.
          </p>
        </div>
        {canEdit && (
          <button
            onClick={openNew}
            className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center gap-2 hover:bg-emerald-700"
          >
            <HiOutlinePlus className="w-4 h-4" /> Nuevo tratamiento
          </button>
        )}
      </div>

      <div className="flex gap-2 flex-wrap items-center">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm"
        >
          <option value="">Todos los estados</option>
          {STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <select
          value={alertFilter}
          onChange={(e) => setAlertFilter(e.target.value)}
          className="border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm"
        >
          <option value="">Todas las alertas</option>
          <option value="zero">Sin avance (0%)</option>
          <option value="completed">Completados</option>
          <option value="warning">Aviso antes de 30 días</option>
          <option value="abandoned">Abandonados (+30 días)</option>
        </select>
        {canEdit && (
          <>
            <button
              onClick={() => setWaModal(true)}
              className="px-3 py-2 bg-green-600 text-white rounded-lg flex items-center gap-1 text-sm hover:bg-green-700"
            >
              <HiOutlineChatBubbleLeftRight className="w-4 h-4" /> WhatsApp masivo
              {selectedIds.length > 0 ? ` (${selectedIds.length})` : ''}
            </button>
            <button
              onClick={downloadExcel}
              className="px-3 py-2 bg-slate-700 text-white rounded-lg flex items-center gap-1 text-sm hover:bg-slate-800"
            >
              <HiOutlineArrowDownTray className="w-4 h-4" /> Excel ausentes
            </button>
            {filteredList.length > 0 && (
              <button
                onClick={toggleSelectAll}
                className="px-3 py-2 border border-slate-300 text-slate-700 rounded-lg text-sm hover:bg-slate-50"
              >
                {selectedIds.length === filteredList.length
                  ? 'Deseleccionar todos'
                  : 'Seleccionar todos'}
              </button>
            )}
          </>
        )}
      </div>

      <div className="grid gap-3">
        {loading && <div className="text-slate-500">Cargando...</div>}
        {filteredList.map((t) => {
          const status = STATUSES.find((s) => s.value === t.status) || STATUSES[0];
          const sourceMap = {
            referral: { label: 'Por derivación', cls: 'bg-violet-100 text-violet-700' },
            appointment: { label: 'Por cita', cls: 'bg-sky-100 text-sky-700' },
            manual: { label: 'Manual', cls: 'bg-slate-100 text-slate-700' },
          };
          const src = sourceMap[t.source] || sourceMap.manual;
          const alert = t.abandonAlert; // 'ok' | 'warning' | 'abandoned'
          const daysIdle = t.daysSinceLastActivity || 0;
          const limit = t.inactivityDaysToAbandon || 30;
          return (
            <div key={t._id} className="bg-white rounded-xl border border-slate-200 p-4">
              <div className="flex items-start justify-between flex-wrap gap-2">
                <div className="flex items-start gap-2 flex-1 min-w-0">
                  {canEdit && (
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(t._id)}
                      onChange={() => toggleSelect(t._id)}
                      className="mt-1.5 cursor-pointer"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-bold text-slate-800">{t.name}</h3>
                    <span className={`px-2 py-0.5 rounded-md text-[11px] font-semibold ${src.cls}`}>
                      {src.label}
                    </span>
                    <span className={`px-2 py-0.5 rounded-md text-[11px] font-semibold ${status.color}`}>
                      {status.label}
                    </span>
                  </div>
                  <div className="text-sm text-slate-500 mt-1">
                    Paciente: {t.patient?.firstName} {t.patient?.lastName} ·
                    Doctor: {t.prescribedBy?.name || '—'}
                  </div>
                  <div className="text-xs text-slate-400 mt-1">
                    Inicio: {fmtDate(t.startDate)}
                    {t.targetEndDate ? ` · Meta: ${fmtDate(t.targetEndDate)}` : ''}
                  </div>
                </div>
                </div>
                <div className="flex items-center gap-2">
                  {canEdit && (
                    <>
                      <button
                        onClick={() => openEdit(t)}
                        className="p-2 text-sky-600 hover:bg-sky-50 rounded-lg"
                      >
                        <HiOutlinePencilSquare className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => remove(t)}
                        className="p-2 text-rose-600 hover:bg-rose-50 rounded-lg"
                      >
                        <HiOutlineTrash className="w-4 h-4" />
                      </button>
                    </>
                  )}
                </div>
              </div>

              {alert === 'warning' && t.status === 'activo' && (
                <div className="mt-3 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-800">
                  ⚠️ Sin actividad hace <strong>{daysIdle} días</strong>. Se marcará como abandonado al llegar a {limit} días.
                </div>
              )}
              {alert === 'abandoned' && t.status === 'abandonado' && (
                <div className="mt-3 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 text-xs text-rose-800">
                  ⛔ Tratamiento abandonado por inactividad ({daysIdle} días). Completa un servicio para reactivarlo.
                </div>
              )}

              {/* Porcentaje grande */}
              <div className="mt-4 flex items-baseline gap-3">
                <div className="text-5xl font-extrabold text-emerald-600 leading-none">
                  {Math.min(t.progress || 0, 100)}%
                </div>
                <div className="text-xs text-slate-500">
                  completado · {(t.items || []).reduce((s, it) => s + (it.completed || 0), 0)} de{' '}
                  {(t.items || []).reduce((s, it) => s + (it.quantity || 0), 0)} sesiones realizadas
                </div>
              </div>

              {/* Barras por servicio */}
              <div className="mt-4 space-y-2">
                {(t.items || []).map((it, idx) => {
                  const done = it.completed || 0;
                  const qty = it.quantity || 0;
                  const pct = qty > 0 ? Math.min((done / qty) * 100, 100) : 0;
                  const fullyDone = qty > 0 && done >= qty;
                  return (
                    <div key={idx} className="bg-slate-50 rounded-lg px-3 py-2">
                      <div className="flex items-center justify-between text-sm">
                        <div className="font-medium text-slate-700 truncate">
                          {it.name || it.product?.name}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={`text-xs font-semibold ${fullyDone ? 'text-emerald-700' : 'text-slate-600'}`}>
                            {done} / {qty}
                          </span>
                          {canEdit && !fullyDone && (
                            <button
                              onClick={() => completeItem(t, idx)}
                              className="text-xs px-2 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700"
                            >
                              +1
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="mt-1 h-1.5 rounded-full bg-white border border-slate-200 overflow-hidden">
                        <div
                          className={`h-full ${fullyDone ? 'bg-emerald-500' : 'bg-teal-400'}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title={editing ? 'Editar tratamiento' : 'Nuevo tratamiento'}>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Paciente</span>
              <select
                required
                value={form.patient}
                onChange={(e) => setForm({ ...form, patient: e.target.value })}
                className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm"
              >
                <option value="">Seleccionar...</option>
                {patients.map((p) => (
                  <option key={p._id} value={p._id}>
                    {p.firstName} {p.lastName}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Doctor</span>
              <select
                value={form.prescribedBy}
                onChange={(e) => setForm({ ...form, prescribedBy: e.target.value })}
                className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm"
              >
                <option value="">—</option>
                {doctors.map((d) => (
                  <option key={d._id} value={d._id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="block">
            <span className="text-xs font-medium text-slate-600">Nombre del tratamiento</span>
            <input
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-slate-600">Descripción</span>
            <textarea
              rows={2}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm"
            />
          </label>
          <div className="grid sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Inicio</span>
              <DateInput
                value={form.startDate}
                onChange={(e) => setForm({ ...form, startDate: e.target.value })}
                className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Fecha objetivo</span>
              <DateInput
                value={form.targetEndDate}
                onChange={(e) => setForm({ ...form, targetEndDate: e.target.value })}
                className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm"
              />
            </label>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-slate-600">
                Servicios / programas (si eliges un programa, se expandirán sus servicios)
              </span>
              <button
                type="button"
                onClick={addItem}
                className="text-xs text-emerald-600 hover:underline"
              >
                + Agregar
              </button>
            </div>
            <div className="space-y-2">
              {form.items.map((it, idx) => (
                <div key={idx} className="flex gap-2">
                  <select
                    value={it.product}
                    onChange={(e) => updateItem(idx, 'product', e.target.value)}
                    className="flex-1 border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm"
                  >
                    <option value="">Servicio o programa...</option>
                    {products.map((p) => (
                      <option key={p._id} value={p._id}>
                        {p.name} {p.category === 'programa' ? '(programa)' : ''}
                      </option>
                    ))}
                  </select>
                  <NumericInput
                    min="1"
                    value={it.quantity}
                    onChange={(e) => updateItem(idx, 'quantity', Number(e.target.value))}
                    className="w-20 border border-slate-200 rounded-xl px-2 py-2 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => removeItem(idx)}
                    className="px-2 text-rose-600"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>

          <label className="block">
            <span className="text-xs font-medium text-slate-600">Notas</span>
            <textarea
              rows={2}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm"
            />
          </label>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => setShowModal(false)} className="px-4 py-2 rounded-lg border border-slate-200">
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60"
            >
              {saving ? 'Guardando...' : 'Guardar'}
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={waModal}
        onClose={() => setWaModal(false)}
        title="Enviar WhatsApp masivo"
      >
        <div className="space-y-3 text-sm">
          <p className="text-slate-600">
            {selectedIds.length > 0
              ? `Se enviará a los pacientes de ${selectedIds.length} tratamiento(s) seleccionado(s).`
              : `Se enviará a los pacientes según el filtro actual: ${
                  alertFilter || 'abandoned'
                }.`}
          </p>
          <p className="text-xs text-slate-500">
            Puedes usar <code>{'{{name}}'}</code> y <code>{'{{treatment}}'}</code> en el mensaje.
          </p>
          <textarea
            rows={5}
            value={waMessage}
            onChange={(e) => setWaMessage(e.target.value)}
            className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm"
          />
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setWaModal(false)}
              className="px-4 py-2 rounded-lg border border-slate-200 text-slate-700"
            >
              Cancelar
            </button>
            <button
              onClick={sendBroadcast}
              disabled={waSending}
              className="px-4 py-2 rounded-lg bg-green-600 text-white hover:bg-green-700 disabled:opacity-60"
            >
              {waSending ? 'Enviando...' : 'Enviar'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
