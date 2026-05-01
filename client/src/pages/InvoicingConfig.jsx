import { useEffect, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import {
  HiOutlineDocumentText,
  HiOutlineLockClosed,
  HiOutlineCheckCircle,
  HiOutlineExclamationTriangle,
} from 'react-icons/hi2';

const EMPTY = {
  ruc: '',
  razonSocial: '',
  nombreComercial: '',
  direccionMatriz: '',
  direccionEstablecimiento: '',
  establecimiento: '001',
  puntoEmision: '001',
  secuencial: 1,
  ambiente: 'pruebas',
  obligadoContabilidad: false,
  agenteRetencion: '',
  contribuyenteEspecial: '',
};

export default function InvoicingConfig() {
  const { hasRole } = useAuth();
  const canEdit = hasRole('admin');
  const [form, setForm] = useState(EMPTY);
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [certFile, setCertFile] = useState(null);
  const [certPassword, setCertPassword] = useState('');
  const [uploadingCert, setUploadingCert] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get('/invoicing-config');
      if (res.data) {
        setConfig(res.data);
        setForm({
          ruc: res.data.ruc || '',
          razonSocial: res.data.razonSocial || '',
          nombreComercial: res.data.nombreComercial || '',
          direccionMatriz: res.data.direccionMatriz || '',
          direccionEstablecimiento: res.data.direccionEstablecimiento || '',
          establecimiento: res.data.establecimiento || '001',
          puntoEmision: res.data.puntoEmision || '001',
          secuencial: res.data.secuencial || 1,
          ambiente: res.data.ambiente || 'pruebas',
          obligadoContabilidad: !!res.data.obligadoContabilidad,
          agenteRetencion: res.data.agenteRetencion || '',
          contribuyenteEspecial: res.data.contribuyenteEspecial || '',
        });
      }
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al cargar configuración');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleChange = (field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await api.put('/invoicing-config', form);
      setConfig(res.data);
      toast.success('Configuración guardada');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  const handleUploadCert = async (e) => {
    e.preventDefault();
    if (!certFile) {
      toast.error('Seleccione un archivo .p12 o .pfx');
      return;
    }
    if (!certPassword) {
      toast.error('Ingrese la contraseña del certificado');
      return;
    }
    setUploadingCert(true);
    try {
      const fd = new FormData();
      fd.append('certificate', certFile);
      fd.append('password', certPassword);
      const res = await api.post('/invoicing-config/certificate', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setConfig(res.data);
      setCertFile(null);
      setCertPassword('');
      toast.success('Certificado cargado correctamente');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al cargar certificado');
    } finally {
      setUploadingCert(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-600"></div>
      </div>
    );
  }

  const certInfo = config?.certificateInfo;
  const certValid = certInfo && new Date(certInfo.validTo) > new Date();

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
          <HiOutlineDocumentText className="w-7 h-7 text-emerald-600" />
          Configuración de facturación SRI
        </h1>
        <p className="text-slate-500 text-sm mt-1">
          Datos de la empresa y certificado digital para firma electrónica.
        </p>
      </div>

      {/* Datos de empresa */}
      <form
        onSubmit={handleSubmit}
        className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 space-y-5"
      >
        <h2 className="text-lg font-semibold text-slate-800">Datos del emisor</h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="RUC (13 dígitos)" required>
            <input
              type="text"
              value={form.ruc}
              maxLength={13}
              disabled={!canEdit}
              onChange={(e) => handleChange('ruc', e.target.value.replace(/\D/g, ''))}
              className="input"
            />
          </Field>
          <Field label="Razón social" required>
            <input
              type="text"
              value={form.razonSocial}
              disabled={!canEdit}
              onChange={(e) => handleChange('razonSocial', e.target.value)}
              className="input"
            />
          </Field>
          <Field label="Nombre comercial">
            <input
              type="text"
              value={form.nombreComercial}
              disabled={!canEdit}
              onChange={(e) => handleChange('nombreComercial', e.target.value)}
              className="input"
            />
          </Field>
          <Field label="Ambiente" required>
            <select
              value={form.ambiente}
              disabled={!canEdit}
              onChange={(e) => handleChange('ambiente', e.target.value)}
              className="input"
            >
              <option value="pruebas">Pruebas</option>
              <option value="produccion">Producción</option>
            </select>
          </Field>
          <Field label="Dirección matriz" required>
            <input
              type="text"
              value={form.direccionMatriz}
              disabled={!canEdit}
              onChange={(e) => handleChange('direccionMatriz', e.target.value)}
              className="input"
            />
          </Field>
          <Field label="Dirección establecimiento">
            <input
              type="text"
              value={form.direccionEstablecimiento}
              disabled={!canEdit}
              onChange={(e) => handleChange('direccionEstablecimiento', e.target.value)}
              className="input"
            />
          </Field>
          <Field label="Establecimiento (3 dígitos)">
            <input
              type="text"
              maxLength={3}
              value={form.establecimiento}
              disabled={!canEdit}
              onChange={(e) =>
                handleChange('establecimiento', e.target.value.replace(/\D/g, '').padStart(3, '0'))
              }
              className="input"
            />
          </Field>
          <Field label="Punto de emisión (3 dígitos)">
            <input
              type="text"
              maxLength={3}
              value={form.puntoEmision}
              disabled={!canEdit}
              onChange={(e) =>
                handleChange('puntoEmision', e.target.value.replace(/\D/g, '').padStart(3, '0'))
              }
              className="input"
            />
          </Field>
          <Field label="Secuencial inicial">
            <input
              type="number"
              min={1}
              value={form.secuencial}
              disabled={!canEdit}
              onChange={(e) => handleChange('secuencial', Number(e.target.value))}
              className="input"
            />
          </Field>
          <Field label="Agente de retención (resolución)">
            <input
              type="text"
              value={form.agenteRetencion}
              disabled={!canEdit}
              onChange={(e) => handleChange('agenteRetencion', e.target.value)}
              className="input"
            />
          </Field>
          <Field label="Contribuyente especial (resolución)">
            <input
              type="text"
              value={form.contribuyenteEspecial}
              disabled={!canEdit}
              onChange={(e) => handleChange('contribuyenteEspecial', e.target.value)}
              className="input"
            />
          </Field>
          <div className="flex items-center gap-2 mt-2">
            <input
              type="checkbox"
              id="obligadoContabilidad"
              checked={form.obligadoContabilidad}
              disabled={!canEdit}
              onChange={(e) => handleChange('obligadoContabilidad', e.target.checked)}
              className="w-4 h-4"
            />
            <label htmlFor="obligadoContabilidad" className="text-sm text-slate-700">
              Obligado a llevar contabilidad
            </label>
          </div>
        </div>

        {canEdit && (
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={saving}
              className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-medium disabled:opacity-50 cursor-pointer border-none text-sm"
            >
              {saving ? 'Guardando...' : 'Guardar configuración'}
            </button>
          </div>
        )}
      </form>

      {/* Certificado digital */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 space-y-5">
        <h2 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
          <HiOutlineLockClosed className="w-5 h-5 text-emerald-600" />
          Certificado digital (.p12 / .pfx)
        </h2>

        {certInfo ? (
          <div
            className={`flex items-start gap-3 p-4 rounded-xl border ${
              certValid
                ? 'bg-emerald-50 border-emerald-200'
                : 'bg-red-50 border-red-200'
            }`}
          >
            {certValid ? (
              <HiOutlineCheckCircle className="w-6 h-6 text-emerald-600 flex-shrink-0" />
            ) : (
              <HiOutlineExclamationTriangle className="w-6 h-6 text-red-600 flex-shrink-0" />
            )}
            <div className="text-sm">
              <p className="font-semibold text-slate-800">
                {certValid ? 'Certificado válido' : 'Certificado vencido'}
              </p>
              <p className="text-slate-600 mt-1">
                <strong>Sujeto:</strong> {certInfo.subject}
              </p>
              <p className="text-slate-600">
                <strong>Emisor:</strong> {certInfo.issuer}
              </p>
              <p className="text-slate-600">
                <strong>Vigencia:</strong>{' '}
                {new Date(certInfo.validFrom).toLocaleDateString()} →{' '}
                {new Date(certInfo.validTo).toLocaleDateString()}
              </p>
              <p className="text-slate-600">
                <strong>Serie:</strong> {certInfo.serialNumber}
              </p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-slate-500">No hay certificado cargado.</p>
        )}

        {canEdit && (
          <form onSubmit={handleUploadCert} className="space-y-4 pt-2 border-t border-slate-100">
            <p className="text-sm text-slate-600">
              {certInfo ? 'Reemplazar certificado:' : 'Cargar certificado:'}
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="Archivo .p12 / .pfx">
                <input
                  type="file"
                  accept=".p12,.pfx"
                  onChange={(e) => setCertFile(e.target.files?.[0] || null)}
                  className="input"
                />
              </Field>
              <Field label="Contraseña del certificado">
                <input
                  type="password"
                  value={certPassword}
                  onChange={(e) => setCertPassword(e.target.value)}
                  className="input"
                  autoComplete="new-password"
                />
              </Field>
            </div>
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={uploadingCert}
                className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-medium disabled:opacity-50 cursor-pointer border-none text-sm"
              >
                {uploadingCert ? 'Cargando...' : 'Cargar certificado'}
              </button>
            </div>
          </form>
        )}
      </div>

      <style>{`
        .input {
          width: 100%;
          padding: 0.625rem 0.875rem;
          border: 1px solid #e2e8f0;
          border-radius: 0.5rem;
          font-size: 0.875rem;
          background: #f8fafc;
          outline: none;
        }
        .input:focus { border-color: #10b981; background: white; }
        .input:disabled { opacity: 0.6; cursor: not-allowed; }
      `}</style>
    </div>
  );
}

function Field({ label, required, children }) {
  return (
    <div>
      <label className="block text-sm font-semibold text-slate-700 mb-1.5">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      {children}
    </div>
  );
}
