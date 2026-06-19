import { useEffect, useState, Fragment, useRef } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import api from '../api/axios';
import { downloadFile } from '../utils/download';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { fmtDate } from '../utils/date';
import TagEditor from '../components/TagEditor';
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
  const { hasRole, user } = useAuth();
  const isOptica = hasRole('optica');
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
  const emptyForm = () => ({
    fecha: new Date().toISOString().substring(0, 10),
    descripcion: '',
    estudioSintomas: '',
    observaciones: '',
    recetaItems: [],
    opticaRx: emptyOpticaRx(),
    vitalSigns: {
      temperature: '',
      bloodPressure: '',
      heartRate: '',
      respiratoryRate: '',
      oxygenSaturation: '',
      weight: '',
      height: '',
      glucose: '',
    },
  });
  const [form, setForm] = useState(emptyForm());
  const [saving, setSaving] = useState(false);
  const [productSearch, setProductSearch] = useState('');
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
            ['medicamento', 'insumo', 'servicio', 'programa'].includes(String(p.category || '').toLowerCase())
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
        items[idx].name = p?.name || '';
        items[idx].isComposite = !!p?.isComposite;
        items[idx].componentsUsed = [];
      }
      return { ...f, recetaItems: items };
    });
  };

  // Alterna un componente de un item compuesto en la receta.
  const toggleComponent = (idx, comp, checked) => {
    setForm((f) => {
      const items = [...f.recetaItems];
      const used = [...(items[idx].componentsUsed || [])];
      const pos = used.findIndex((c) => String(c.product) === String(comp.product));
      if (checked && pos < 0) used.push({ product: comp.product, name: comp.name, quantity: comp.quantity || 1 });
      if (!checked && pos >= 0) used.splice(pos, 1);
      items[idx] = { ...items[idx], componentsUsed: used };
      return { ...f, recetaItems: items };
    });
  };

  const setComponentQty = (idx, productId, qty) => {
    setForm((f) => {
      const items = [...f.recetaItems];
      const used = (items[idx].componentsUsed || []).map((c) =>
        String(c.product) === String(productId) ? { ...c, quantity: Number(qty) } : c
      );
      items[idx] = { ...items[idx], componentsUsed: used };
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

  // Productos filtrados por búsqueda (nombre o código)
  const filteredProducts = productSearch.trim()
    ? products.filter((p) => {
        const q = productSearch.trim().toLowerCase();
        return (
          String(p.name || '').toLowerCase().includes(q) ||
          String(p.code || '').toLowerCase().includes(q) ||
          String(p.category || '').toLowerCase().includes(q)
        );
      })
    : products;

  // Subida de PDFs adjuntos a un seguimiento existente
  const uploadAttachment = async (fuId, file) => {
    if (!file) return;
    if (file.type !== 'application/pdf') {
      toast.error('Solo se permiten archivos PDF');
      return;
    }
    setUploadingFuId(fuId);
    try {
      const fd = new FormData();
      fd.append('file', file);
      await api.post(
        `/clinical-records/${patientId}/follow-ups/${fuId}/attachments`,
        fd,
        { headers: { 'Content-Type': 'multipart/form-data' } }
      );
      await load();
      toast.success('Archivo adjuntado');
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
    if (!isOptica || !hasOpticaRx) {
      if (
        !form.recetaItems.length ||
        form.recetaItems.some((it) => !it.product)
      ) {
        toast.error('Debe agregar al menos un ítem de receta (medicamento/servicio)');
        return;
      }
    }
    setSaving(true);
    try {
      const vs = form.vitalSigns || {};
      const vitalSigns = {
        temperature: vs.temperature === '' ? null : Number(vs.temperature),
        bloodPressure: vs.bloodPressure || '',
        heartRate: vs.heartRate === '' ? null : Number(vs.heartRate),
        respiratoryRate: vs.respiratoryRate === '' ? null : Number(vs.respiratoryRate),
        oxygenSaturation: vs.oxygenSaturation === '' ? null : Number(vs.oxygenSaturation),
        weight: vs.weight === '' ? null : Number(vs.weight),
        height: vs.height === '' ? null : Number(vs.height),
        glucose: vs.glucose === '' ? null : Number(vs.glucose),
      };
      const payload = {
        ...form,
        recomendaciones: form.estudioSintomas, // legacy alias
        vitalSigns,
      };
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
      setProductSearch('');
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
        <Field label="Estudio o síntomas" className="md:col-span-3">
          <textarea
            rows={2}
            value={form.estudioSintomas}
            onChange={(e) => setForm((f) => ({ ...f, estudioSintomas: e.target.value }))}
            className="input resize-none"
          />
        </Field>

        {/* Signos vitales */}
        <div className="md:col-span-3">
          <label className="text-sm font-medium text-slate-700 block mb-2">
            Signos vitales
          </label>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 bg-white rounded-lg border border-slate-200 p-3">
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
              <input
                type="number"
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
              <input
                type="number"
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
              <input
                type="number"
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
              <input
                type="number"
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
              <input
                type="number"
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
              <input
                type="number"
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
              <input
                type="number"
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
          </div>
        </div>

        <div className="md:col-span-3">
          <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
            <label className="text-sm font-medium text-slate-700">Receta *</label>
            <div className="flex items-center gap-2 flex-1 max-w-md ml-auto">
              <input
                type="search"
                value={productSearch}
                onChange={(e) => setProductSearch(e.target.value)}
                placeholder="Buscar medicamento o servicio..."
                className="input text-xs py-1.5 flex-1"
              />
              <button
                type="button"
                onClick={addRow}
                className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-emerald-600 text-white border-none cursor-pointer whitespace-nowrap"
              >
                <HiOutlinePlus className="w-3 h-3" /> Agregar ítem
              </button>
            </div>
          </div>
          {form.recetaItems.length === 0 && (
            <p className="text-xs text-slate-400 italic">Sin ítems. Agrega medicamentos o servicios.</p>
          )}
          {productSearch.trim() && (
            <p className="text-[11px] text-slate-500 mb-1">
              {filteredProducts.length} resultado(s) para "{productSearch}"
            </p>
          )}
          {form.recetaItems.length > 0 && (
            <div className="overflow-x-auto bg-white rounded-lg border border-slate-200">
              <table className="tbl text-xs">
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
                    <Fragment key={idx}>
                    <tr className="border-t border-slate-100">
                      <td className="px-2 py-1">
                        <select
                          value={row.product}
                          onChange={(e) => updateRow(idx, 'product', e.target.value)}
                          className="input text-xs py-1"
                        >
                          <option value="">— Seleccionar —</option>
                          {filteredProducts.map((p) => (
                            <option key={p._id} value={p._id}>
                              {p.name} ({p.category})
                            </option>
                          ))}
                          {/* Si la fila ya tiene un producto que quedó fuera del filtro, lo conservamos */}
                          {row.product &&
                            !filteredProducts.some((p) => p._id === row.product) &&
                            products.find((p) => p._id === row.product) && (
                              <option value={row.product}>
                                {products.find((p) => p._id === row.product).name}
                              </option>
                            )}
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
                    {row.isComposite && (() => {
                      const prod = products.find((p) => p._id === row.product);
                      const comps = prod?.components || [];
                      return (
                        <tr key={`${idx}-comp`} className="bg-amber-50/60">
                          <td colSpan={7} className="px-3 py-2">
                            <p className="text-[11px] font-semibold text-amber-800 mb-1">
                              Componentes de "{row.name}" — elige cuáles recetar:
                            </p>
                            {comps.length === 0 && (
                              <p className="text-[11px] text-slate-500">Este producto compuesto no tiene componentes configurados.</p>
                            )}
                            <div className="flex flex-wrap gap-2">
                              {comps.map((c) => {
                                const cp = products.find((p) => p._id === (c.product?._id || c.product));
                                const cid = c.product?._id || c.product;
                                const used = (row.componentsUsed || []).find((u) => String(u.product) === String(cid));
                                return (
                                  <label key={cid} className="flex items-center gap-1 bg-white border border-amber-200 rounded px-2 py-1 text-[11px] cursor-pointer">
                                    <input
                                      type="checkbox"
                                      checked={!!used}
                                      onChange={(e) =>
                                        toggleComponent(idx, { product: cid, name: cp?.name || '', quantity: c.quantity || 1 }, e.target.checked)
                                      }
                                      className="w-3 h-3 accent-amber-600"
                                    />
                                    <span>{cp?.name || 'Componente'}</span>
                                    {used && (
                                      <input
                                        type="number"
                                        min={1}
                                        value={used.quantity}
                                        onChange={(e) => setComponentQty(idx, cid, e.target.value)}
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

        <Field label="Observaciones" className="md:col-span-3">
          <textarea
            rows={2}
            value={form.observaciones}
            onChange={(e) => setForm((f) => ({ ...f, observaciones: e.target.value }))}
            className="input resize-none"
          />
        </Field>
        {isOptica && <OpticaRxTable value={form.opticaRx} onChange={(rx) => setForm((f) => ({ ...f, opticaRx: rx }))} />}

        {/* PDFs antes de guardar el seguimiento */}
        <div className="md:col-span-3">
          <label className="text-sm font-medium text-slate-700 block mb-2">
            Archivos PDF a adjuntar
          </label>
          <div className="bg-white rounded-lg border border-slate-200 p-3 space-y-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf"
              multiple
              onChange={(e) => {
                const files = Array.from(e.target.files || []).filter(
                  (f) => f.type === 'application/pdf'
                );
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
              Adjuntar PDFs
            </button>
            {pendingFiles.length > 0 && (
              <ul className="space-y-1">
                {pendingFiles.map((f, i) => (
                  <li key={i} className="text-xs text-slate-600 flex items-center gap-2">
                    <span>📎 {f.name}</span>
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
              const vs = fu.vitalSigns || {};
              const hasVitals = ['temperature', 'bloodPressure', 'heartRate', 'respiratoryRate', 'oxygenSaturation', 'weight', 'height', 'glucose']
                .some((k) => vs[k] != null && vs[k] !== '');
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
                    <div className="font-medium">{fu.descripcion || fu.motivoConsulta}</div>
                    {fu.estudioSintomas && (
                      <div className="mt-1 text-xs text-slate-600">
                        <b>Estudio/síntomas:</b> {fu.estudioSintomas}
                      </div>
                    )}
                    {Array.isArray(fu.recetaItems) && fu.recetaItems.length > 0 && (
                      <div className="mt-2 bg-slate-50 border border-slate-200 rounded p-2">
                        <p className="text-[11px] font-semibold text-slate-600 uppercase mb-1">Receta</p>
                        <ul className="text-xs text-slate-700 space-y-0.5">
                          {fu.recetaItems.map((it, i) => (
                            <li key={i}>
                              <b>{it.name}</b>
                              {it.dose ? ` · ${it.dose}` : ''}
                              {it.frequency ? ` · ${it.frequency}` : ''}
                              {it.duration ? ` · ${it.duration}` : ''}
                              {it.instructions ? ` — ${it.instructions}` : ''}
                              {it.quantity ? ` (x${it.quantity})` : ''}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {hasVitals && (
                      <div className="mt-2 text-[11px] text-slate-600 bg-emerald-50 border border-emerald-100 rounded p-2 flex flex-wrap gap-x-3 gap-y-0.5">
                        {vs.bloodPressure && <span>TA: {vs.bloodPressure}</span>}
                        {vs.heartRate && <span>FC: {vs.heartRate}lpm</span>}
                        {vs.respiratoryRate && <span>FR: {vs.respiratoryRate}rpm</span>}
                        {vs.temperature != null && <span>T°: {vs.temperature}°C</span>}
                        {vs.oxygenSaturation && <span>SatO₂: {vs.oxygenSaturation}%</span>}
                        {vs.weight && <span>Peso: {vs.weight}kg</span>}
                        {vs.height && <span>Talla: {vs.height}cm</span>}
                        {vs.glucose && <span>Glu: {vs.glucose}mg/dL</span>}
                      </div>
                    )}
                    {fu.observaciones && (
                      <div className="mt-2 text-xs text-slate-600 italic">
                        <b>Observaciones:</b> {fu.observaciones}
                      </div>
                    )}
                    {/* Adjuntos PDF */}
                    <div className="mt-2 space-y-1">
                      {(fu.attachments || []).map((att) => (
                        <div key={att._id} className="flex items-center gap-2 text-xs text-slate-600">
                          <span>📎</span>
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
                          {uploadingFuId === fu._id ? 'Subiendo...' : 'Adjuntar PDF'}
                          <input
                            type="file"
                            accept="application/pdf"
                            className="hidden"
                            disabled={uploadingFuId === fu._id}
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              e.target.value = '';
                              if (file) uploadAttachment(fu._id, file);
                            }}
                          />
                        </label>
                      )}
                    </div>
                    {hasOpticaData && <OpticaRxSummary rx={fu.opticaRx} />}
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
