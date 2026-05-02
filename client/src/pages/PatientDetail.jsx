import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
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
  const { hasRole } = useAuth();
  const [tab, setTab] = useState('datos');
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
              CI: {patient.cedula} {patient.phone ? ` · ${patient.phone}` : ''}
              {patient.email ? ` · ${patient.email}` : ''}
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
          {tab === 'seguimientos' && <SeguimientosTab patientId={id} />}
          {tab === 'citas' && <CitasTab patientId={id} />}
          {tab === 'facturas' && <FacturasTab patientId={id} />}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── Datos ─────────────────────────
function DatosTab({ patient }) {
  return (
    <dl className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
      <Item label="Cédula" value={patient.cedula} />
      <Item label="Nombre completo" value={`${patient.firstName} ${patient.lastName}`} />
      <Item label="Email" value={patient.email} />
      <Item label="Teléfono" value={patient.phone} />
      <Item label="WhatsApp" value={patient.whatsapp} />
      <Item
        label="Fecha de nacimiento"
        value={patient.birthDate ? new Date(patient.birthDate).toLocaleDateString() : '—'}
      />
      <Item label="Género" value={patient.gender} />
      <Item label="Dirección" value={patient.address} />
      <Item label="Notas" value={patient.notes} full />
    </dl>
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
        <Field label="Cédula">
          <input
            type="text"
            value={record.cedula || ''}
            onChange={(e) => update('cedula', e.target.value)}
            className="input"
          />
        </Field>
        <Field label="Dirección">
          <input
            type="text"
            value={record.direccion || ''}
            onChange={(e) => update('direccion', e.target.value)}
            className="input"
          />
        </Field>
        <Field label="Celular">
          <input
            type="text"
            value={record.celular || ''}
            onChange={(e) => update('celular', e.target.value)}
            className="input"
          />
        </Field>
      </div>

      <div className="space-y-4 pt-2 border-t border-slate-100">
        <h3 className="font-semibold text-slate-800">Antecedentes</h3>
        <YesNo
          label="¿Toma medicamentos?"
          item={record.tomaMedicamentos}
          onChange={(v) => update('tomaMedicamentos', v)}
        />
        <YesNo
          label="¿Tiene alergias?"
          item={record.tieneAlergias}
          onChange={(v) => update('tieneAlergias', v)}
        />
        <YesNo
          label="¿Ha tenido cirugías?"
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
function SeguimientosTab({ patientId }) {
  const { hasRole } = useAuth();
  const canDelete = hasRole('admin', 'doctor');
  const showPayment = !hasRole('doctor');
  const [record, setRecord] = useState(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({
    fecha: new Date().toISOString().substring(0, 10),
    descripcion: '',
    valor: 0,
    metodoPago: 'efectivo',
  });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId]);

  const submit = async (e) => {
    e.preventDefault();
    if (!form.descripcion) {
      toast.error('Descripción requerida');
      return;
    }
    setSaving(true);
    try {
      const res = await api.post(`/clinical-records/${patientId}/follow-ups`, form);
      setRecord(res.data);
      setForm({
        fecha: new Date().toISOString().substring(0, 10),
        descripcion: '',
        valor: 0,
        metodoPago: 'efectivo',
      });
      toast.success('Seguimiento agregado');
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

  if (loading) return <div className="text-slate-500 text-sm">Cargando...</div>;
  if (!record) return null;

  const followUps = [...(record.followUps || [])].sort(
    (a, b) => new Date(b.fecha) - new Date(a.fecha)
  );

  return (
    <div className="space-y-6">
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
        <Field label="Descripción" className="md:col-span-2">
          <input
            type="text"
            value={form.descripcion}
            onChange={(e) => setForm((f) => ({ ...f, descripcion: e.target.value }))}
            className="input"
            required
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
            <HiOutlinePlus className="w-4 h-4" /> Agregar
          </button>
        </div>
      </form>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="text-left px-4 py-2.5 font-semibold">Fecha</th>
              <th className="text-left px-4 py-2.5 font-semibold">Descripción</th>
              {showPayment && <th className="text-right px-4 py-2.5 font-semibold">Valor</th>}
              {showPayment && <th className="text-left px-4 py-2.5 font-semibold">Pago</th>}
              {canDelete && <th className="px-4 py-2.5"></th>}
            </tr>
          </thead>
          <tbody>
            {followUps.length === 0 && (
              <tr>
                <td colSpan={5} className="text-center py-6 text-slate-400">
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
                {canDelete && (
                  <td className="px-4 py-2.5 text-right">
                    <button
                      onClick={() => remove(fu._id)}
                      className="p-1 text-slate-400 hover:text-red-600 cursor-pointer bg-transparent border-none"
                    >
                      <HiOutlineTrash className="w-4 h-4" />
                    </button>
                  </td>
                )}
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
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get('/appointments');
        setAppts(
          res.data.filter((a) => String(a.patient?._id || a.patient) === String(patientId))
        );
      } catch (err) {
        toast.error(err.response?.data?.message || 'Error al cargar citas');
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
