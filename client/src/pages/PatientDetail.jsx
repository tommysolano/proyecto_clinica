import { useEffect, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import api from '../api/axios';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
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
} from 'react-icons/hi2';

const TABS = [
  { id: 'datos', label: 'Datos', icon: HiOutlineUser },
  { id: 'ficha', label: 'Ficha clínica', icon: HiOutlineClipboardDocumentList },
  { id: 'seguimientos', label: 'Seguimientos', icon: HiOutlineHeart },
  { id: 'citas', label: 'Citas', icon: HiOutlineCalendar },
  { id: 'facturas', label: 'Facturas', icon: HiOutlineDocumentText },
];

export default function PatientDetail() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const appointmentId = searchParams.get('appointment') || null;
  const tabParam = searchParams.get('tab') || null;
  const { hasRole } = useAuth();
  const initialTab = tabParam
    ? tabParam
    : appointmentId
      ? (hasRole('doctor') ? 'ficha' : 'seguimientos')
      : 'datos';
  const [tab, setTab] = useState(initialTab);
  const [patient, setPatient] = useState(null);
  const [loading, setLoading] = useState(true);

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

      <div className="bg-white rounded-2xl shadow-sm border border-emerald-100 p-6 mb-6">
        <div className="flex items-start gap-4">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-white font-bold text-xl">
            {patient.firstName?.[0]}
            {patient.lastName?.[0]}
          </div>
          <div className="flex-1">
            <h1 className="text-2xl font-bold text-slate-800">
              {patient.firstName} {patient.lastName}
            </h1>
            <p className="text-sm text-slate-500 mt-1">
              {hasRole('doctor') ? (
                <>Edad: {patient.computedAge ?? patient.age ?? '—'}</>
              ) : (
                <>
                  CI: {patient.cedula} {patient.phone ? ` · ${patient.phone}` : ''}
                  {patient.email ? ` · ${patient.email}` : ''}
                </>
              )}
            </p>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-emerald-100 overflow-hidden">
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
  const isDoctor = hasRole('doctor');
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
          label="Fecha de nacimiento"
          value={patient.birthDate ? new Date(patient.birthDate).toLocaleDateString() : '—'}
        />
        <Item label="Edad" value={patient.computedAge ?? patient.age ?? '—'} />
        <Item label="Género" value={patient.gender} />
        {!isDoctor && <Item label="Dirección" value={patient.address} />}
        <Item
          label="Origen del paciente"
          value={
            patient.source
              ? `${sourceLabels[patient.source] || patient.source}${patient.sourceDetail ? ` (${patient.sourceDetail})` : ''}`
              : '—'
          }
        />
        <Item label="Notas" value={patient.notes} full />
      </dl>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-amber-800 mb-2">Antecedentes familiares</h3>
          <p className="text-sm text-slate-700 whitespace-pre-wrap">
            {patient.antecedentesFamiliares || '— Sin información registrada —'}
          </p>
        </div>
        <div className="bg-rose-50 border border-rose-200 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-rose-800 mb-2">Antecedentes patológicos</h3>
          <p className="text-sm text-slate-700 whitespace-pre-wrap">
            {patient.antecedentesPatologicos || '— Sin información registrada —'}
          </p>
        </div>
      </div>
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
        tomaMedicamentos: record.tomaMedicamentos,
        tieneAlergias: record.tieneAlergias,
        tieneCirugias: record.tieneCirugias,
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
          <input
            type="date"
            value={record.fecha ? record.fecha.substring(0, 10) : ''}
            onChange={(e) => update('fecha', e.target.value)}
            className="input"
          />
        </Field>
        <Field label="Edad">
          <input
            type="number"
            value={record.edad ?? ''}
            onChange={(e) => update('edad', Number(e.target.value))}
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

      <div className="space-y-4 pt-2 border-t border-slate-100">
        <h3 className="font-semibold text-slate-800">Antecedentes</h3>
        <YesNo
          label="Medicamentos"
          item={record.tomaMedicamentos}
          onChange={(v) => update('tomaMedicamentos', v)}
        />
        <YesNo
          label="Alergias"
          item={record.tieneAlergias}
          onChange={(v) => update('tieneAlergias', v)}
        />
        <YesNo
          label="Cirugías"
          item={record.tieneCirugias}
          onChange={(v) => update('tieneCirugias', v)}
        />
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

function YesNo({ label, item, onChange }) {
  const value = !!item?.value;
  const detail = item?.detail || '';
  return (
    <div className="bg-slate-50 rounded-xl p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-slate-700">{label}</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onChange({ value: true, detail })}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer border-none ${
              value ? 'bg-emerald-600 text-white' : 'bg-white text-slate-600 border border-slate-200'
            }`}
          >
            Sí
          </button>
          <button
            type="button"
            onClick={() => onChange({ value: false, detail })}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer border-none ${
              !value ? 'bg-slate-700 text-white' : 'bg-white text-slate-600 border border-slate-200'
            }`}
          >
            No
          </button>
        </div>
      </div>
      {value && (
        <textarea
          value={detail}
          onChange={(e) => onChange({ value: true, detail: e.target.value })}
          rows={2}
          placeholder="Detalle (cuáles, cuándo, etc.)"
          className="input mt-3 resize-none"
        />
      )}
    </div>
  );
}

// ──────────────────── Seguimientos ────────────────────
function SeguimientosTab({ patientId, appointmentId }) {
  const { hasRole } = useAuth();
  const canDelete = hasRole('admin', 'doctor');
  const showPayment = !hasRole('doctor');
  const [record, setRecord] = useState(null);
  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState([]);
  const emptyRow = () => ({
    product: '',
    name: '',
    quantity: 1,
    dose: '',
    frequency: '',
    duration: '',
    instructions: '',
  });
  const emptyForm = () => ({
    fecha: new Date().toISOString().substring(0, 10),
    descripcion: '',
    estudioSintomas: '',
    observaciones: '',
    recetaItems: [],
    valor: 0,
    metodoPago: 'efectivo',
  });
  const [form, setForm] = useState(emptyForm());
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get(`/clinical-records/${patientId}`);
      setRecord(res.data);
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
            ['medicamento', 'servicio', 'programa'].includes(String(p.category || '').toLowerCase())
          )
        );
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId]);

  const updateRow = (idx, key, val) => {
    setForm((f) => {
      const items = [...f.recetaItems];
      items[idx] = { ...items[idx], [key]: val };
      if (key === 'product') {
        const p = products.find((x) => x._id === val);
        if (p) items[idx].name = p.name;
      }
      return { ...f, recetaItems: items };
    });
  };

  const addRow = () =>
    setForm((f) => ({ ...f, recetaItems: [...f.recetaItems, emptyRow()] }));
  const removeRow = (idx) =>
    setForm((f) => ({
      ...f,
      recetaItems: f.recetaItems.filter((_, i) => i !== idx),
    }));

  const submit = async (e) => {
    e.preventDefault();
    if (!form.descripcion) {
      toast.error('Motivo de consulta requerido');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        ...form,
        recomendaciones: form.estudioSintomas, // legacy alias
      };
      if (appointmentId) payload.appointmentId = appointmentId;
      const res = await api.post(`/clinical-records/${patientId}/follow-ups`, payload);
      setRecord(res.data);
      setForm(emptyForm());
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
        className={`bg-slate-50 rounded-xl p-4 grid grid-cols-1 gap-3 ${showPayment ? 'md:grid-cols-5' : 'md:grid-cols-3'}`}
      >
        <Field label="Fecha">
          <input
            type="date"
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
        <Field label="Estudio o síntomas" className={showPayment ? 'md:col-span-5' : 'md:col-span-3'}>
          <textarea
            rows={2}
            value={form.estudioSintomas}
            onChange={(e) => setForm((f) => ({ ...f, estudioSintomas: e.target.value }))}
            className="input resize-none"
          />
        </Field>

        <div className={showPayment ? 'md:col-span-5' : 'md:col-span-3'}>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-medium text-slate-700">Receta</label>
            <button
              type="button"
              onClick={addRow}
              className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-emerald-600 text-white border-none cursor-pointer"
            >
              <HiOutlinePlus className="w-3 h-3" /> Agregar ítem
            </button>
          </div>
          {form.recetaItems.length === 0 && (
            <p className="text-xs text-slate-400 italic">Sin ítems. Agrega medicamentos o servicios.</p>
          )}
          {form.recetaItems.length > 0 && (
            <div className="overflow-x-auto bg-white rounded-lg border border-slate-200">
              <table className="w-full text-xs">
                <thead className="bg-slate-100 text-slate-600">
                  <tr>
                    <th className="text-left px-2 py-1.5">Producto / Servicio</th>
                    <th className="text-left px-2 py-1.5 w-16">Cant.</th>
                    <th className="text-left px-2 py-1.5">Dosis</th>
                    <th className="text-left px-2 py-1.5">Frecuencia</th>
                    <th className="text-left px-2 py-1.5">Duración</th>
                    <th className="text-left px-2 py-1.5">Indicaciones</th>
                    <th className="px-2 py-1.5 w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {form.recetaItems.map((row, idx) => (
                    <tr key={idx} className="border-t border-slate-100">
                      <td className="px-2 py-1">
                        <select
                          value={row.product}
                          onChange={(e) => updateRow(idx, 'product', e.target.value)}
                          className="input text-xs py-1"
                        >
                          <option value="">— Seleccionar —</option>
                          {products.map((p) => (
                            <option key={p._id} value={p._id}>
                              {p.name} ({p.category})
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-2 py-1">
                        <input
                          type="number"
                          min={1}
                          value={row.quantity}
                          onChange={(e) => updateRow(idx, 'quantity', Number(e.target.value))}
                          className="input text-xs py-1"
                        />
                      </td>
                      <td className="px-2 py-1">
                        <input
                          type="text"
                          value={row.dose}
                          onChange={(e) => updateRow(idx, 'dose', e.target.value)}
                          className="input text-xs py-1"
                          placeholder="500mg"
                        />
                      </td>
                      <td className="px-2 py-1">
                        <input
                          type="text"
                          value={row.frequency}
                          onChange={(e) => updateRow(idx, 'frequency', e.target.value)}
                          className="input text-xs py-1"
                          placeholder="c/8h"
                        />
                      </td>
                      <td className="px-2 py-1">
                        <input
                          type="text"
                          value={row.duration}
                          onChange={(e) => updateRow(idx, 'duration', e.target.value)}
                          className="input text-xs py-1"
                          placeholder="7 días"
                        />
                      </td>
                      <td className="px-2 py-1">
                        <input
                          type="text"
                          value={row.instructions}
                          onChange={(e) => updateRow(idx, 'instructions', e.target.value)}
                          className="input text-xs py-1"
                        />
                      </td>
                      <td className="px-2 py-1 text-right">
                        <button
                          type="button"
                          onClick={() => removeRow(idx)}
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
          )}
        </div>

        <Field label="Observaciones" className={showPayment ? 'md:col-span-5' : 'md:col-span-3'}>
          <textarea
            rows={2}
            value={form.observaciones}
            onChange={(e) => setForm((f) => ({ ...f, observaciones: e.target.value }))}
            className="input resize-none"
          />
        </Field>
        {showPayment && (
          <>
            <Field label="Valor">
              <input
                type="number"
                min={0}
                step="0.01"
                value={form.valor}
                onChange={(e) => setForm((f) => ({ ...f, valor: Number(e.target.value) }))}
                className="input"
              />
            </Field>
            <Field label="Método de pago">
              <select
                value={form.metodoPago}
                onChange={(e) => setForm((f) => ({ ...f, metodoPago: e.target.value }))}
                className="input"
              >
                <option value="efectivo">Efectivo</option>
                <option value="tarjeta">Tarjeta</option>
                <option value="transferencia">Transferencia</option>
                <option value="otro">Otro</option>
              </select>
            </Field>
          </>
        )}
        <div className={`${showPayment ? 'md:col-span-5' : 'md:col-span-3'} flex justify-end`}>
          <button
            type="submit"
            disabled={saving}
            className="flex items-center gap-1 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-medium disabled:opacity-50 cursor-pointer border-none"
          >
            <HiOutlinePlus className="w-4 h-4" /> {appointmentId ? 'Guardar y finalizar' : 'Agregar'}
          </button>
        </div>
      </form>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="text-left px-4 py-2.5 font-semibold">Fecha</th>
              <th className="text-left px-4 py-2.5 font-semibold">Motivo de consulta</th>
              {showPayment && <th className="text-right px-4 py-2.5 font-semibold">Valor</th>}
              {showPayment && <th className="text-left px-4 py-2.5 font-semibold">Pago</th>}
              <th className="px-4 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {followUps.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center py-6 text-slate-400">
                  No hay seguimientos.
                </td>
              </tr>
            )}
            {followUps.map((fu) => (
              <tr key={fu._id} className="border-t border-slate-100">
                <td className="px-4 py-2.5 text-slate-600">
                  {new Date(fu.fecha).toLocaleDateString()}
                </td>
                <td className="px-4 py-2.5 text-slate-800">{fu.descripcion}</td>
                {showPayment && (
                  <td className="px-4 py-2.5 text-right text-slate-700">
                    ${Number(fu.valor || 0).toFixed(2)}
                  </td>
                )}
                {showPayment && (
                  <td className="px-4 py-2.5 capitalize text-slate-600">
                    {fu.metodoPago || '—'}
                  </td>
                )}
                <td className="px-4 py-2.5 text-right">
                  <div className="flex items-center justify-end gap-1">
                    <button
                      onClick={() => printFollowUp(fu._id)}
                      title="Imprimir receta"
                      className="p-1 text-slate-500 hover:text-emerald-600 cursor-pointer bg-transparent border-none"
                    >
                      <HiOutlinePrinter className="w-4 h-4" />
                    </button>
                    {canDelete && (
                      <button
                        onClick={() => remove(fu._id)}
                        className="p-1 text-slate-400 hover:text-red-600 cursor-pointer bg-transparent border-none"
                      >
                        <HiOutlineTrash className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <FichaStyles />
    </div>
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
            <p className="text-2xl font-bold text-slate-800">{stats.total || appts.length}</p>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
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
                  {new Date(a.date).toLocaleDateString()}
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
      <table className="w-full text-sm">
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
                {new Date(inv.createdAt).toLocaleDateString()}
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
