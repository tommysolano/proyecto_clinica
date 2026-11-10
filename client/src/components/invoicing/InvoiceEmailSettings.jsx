import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import api from '../../api/axios';

const empty = { enabled: false, from: '', host: '', port: 587, secure: false, user: '', password: '' };

export default function InvoiceEmailSettings({ config, onSaved }) {
  const [form, setForm] = useState(empty);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setForm({ enabled: !!config?.smtpEnabled, from: config?.emailRemitente || '', host: config?.smtpHost || '',
      port: config?.smtpPort || 587, secure: !!config?.smtpSecure, user: config?.smtpUser || '', password: '' });
  }, [config]);
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const save = async (e) => {
    e.preventDefault(); setBusy(true);
    try { const res = await api.put('/invoicing-config/email', form); onSaved(res.data); toast.success('Correo de facturación guardado'); }
    catch (err) { toast.error(err.response?.data?.error || err.response?.data?.message || 'No se pudo guardar'); }
    finally { setBusy(false); }
  };
  const verify = async () => {
    setBusy(true);
    try { const res = await api.post('/invoicing-config/email/verify'); toast.success(res.data.message); }
    catch (err) { toast.error(err.response?.data?.message || 'No se pudo verificar la conexión'); }
    finally { setBusy(false); }
  };
  return (
    <form onSubmit={save} className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-slate-200 p-6 space-y-4">
      <h2 className="text-lg font-semibold text-slate-800">Correo para facturas electrónicas</h2>
      <p className="text-sm text-slate-600">Después de la autorización del SRI, las nuevas facturas se envían al correo del comprador con el RIDE en PDF y el XML. La configuración aplica a la empresa.</p>
      <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} /> Activar envío automático</label>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Correo remitente"><input className="input" type="email" value={form.from} onChange={(e) => set('from', e.target.value)} required={form.enabled} /></Field>
        <Field label="Servidor SMTP"><input className="input" value={form.host} onChange={(e) => set('host', e.target.value)} placeholder="smtp.ejemplo.com" required={form.enabled} /></Field>
        <Field label="Puerto SMTP"><input className="input" type="number" min="1" max="65535" value={form.port} onChange={(e) => set('port', e.target.value)} required={form.enabled} /></Field>
        <Field label="Usuario SMTP"><input className="input" value={form.user} onChange={(e) => set('user', e.target.value)} autoComplete="off" required={form.enabled} /></Field>
        <Field label="Contraseña SMTP"><input className="input" type="password" value={form.password} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" placeholder={config?.smtpPasswordConfigured ? 'Dejar vacía para conservar la actual' : ''} required={form.enabled && !config?.smtpPasswordConfigured} /></Field>
        <label className="flex items-center gap-2 text-sm text-slate-700 self-end pb-3"><input type="checkbox" checked={form.secure} onChange={(e) => set('secure', e.target.checked)} /> SSL/TLS directo (normalmente puerto 465)</label>
      </div>
      <p className="text-xs text-slate-500">Sin SSL directo se exige STARTTLS (normalmente puerto 587). Algunos proveedores requieren una contraseña de aplicación. Las facturas anteriores se pueden enviar desde su detalle.</p>
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" disabled={busy || !config?.smtpEnabled} onClick={verify} className="px-4 py-2 border border-slate-300 rounded-lg text-sm disabled:opacity-50">Probar conexión guardada</button>
        <button disabled={busy} className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm disabled:opacity-50">{busy ? 'Procesando...' : 'Guardar correo'}</button>
      </div>
    </form>
  );
}

function Field({ label, children }) {
  return <label className="block text-sm font-semibold text-slate-700">{label}<span className="block mt-1">{children}</span></label>;
}
