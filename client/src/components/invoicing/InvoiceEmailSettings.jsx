import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import api from '../../api/axios';

const empty = { enabled: false, provider: 'smtp', from: '', host: '', port: 587, secure: false, user: '', password: '', gmailClientId: '', gmailClientSecret: '' };

export default function InvoiceEmailSettings({ config, onSaved }) {
  const [form, setForm] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [verification, setVerification] = useState(null);
  useEffect(() => {
    setForm({ enabled: !!config?.smtpEnabled, provider: config?.emailProvider || 'smtp', from: config?.emailRemitente || '', host: config?.smtpHost || '',
      port: config?.smtpPort || 587, secure: !!config?.smtpSecure, user: config?.smtpUser || '', password: '', gmailClientId: config?.gmailClientId || '', gmailClientSecret: '' });
  }, [config]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('state') || (!params.has('code') && !params.has('error'))) return;
    const state = params.get('state'); const code = params.get('code');
    params.delete('state'); params.delete('code'); params.delete('scope'); params.delete('authuser'); params.delete('prompt'); params.delete('error');
    window.history.replaceState({}, '', `${window.location.pathname}${params.size ? `?${params}` : ''}${window.location.hash}`);
    if (!code) { setVerification({ ok: false, message: 'Se canceló la autorización de Google.' }); return; }
    setBusy(true);
    api.post('/invoicing-config/email/gmail/complete', { state, code })
      .then((res) => { onSaved(res.data); setVerification({ ok: true, message: 'Cuenta de Gmail conectada. Active el envío automático y guarde.' }); })
      .catch((err) => setVerification({ ok: false, message: err.response?.data?.message || 'No se pudo conectar Gmail.' }))
      .finally(() => setBusy(false));
  }, [onSaved]);
  const set = (key, value) => { setVerification(null); setForm((f) => ({ ...f, [key]: value })); };
  const save = async (e) => {
    e.preventDefault(); setBusy(true); setVerification(null);
    try { const res = await api.put('/invoicing-config/email', form); onSaved(res.data); toast.success('Correo de facturación guardado'); }
    catch (err) { toast.error(err.response?.data?.error || err.response?.data?.message || 'No se pudo guardar'); }
    finally { setBusy(false); }
  };
  const verify = async () => {
    setBusy(true); setVerification(null);
    try { const res = await api.post('/invoicing-config/email/verify'); setVerification({ ok: true, message: res.data.message }); }
    catch (err) { setVerification({ ok: false, message: err.response?.data?.message || 'No se pudo verificar la conexión con el sistema.', details: err.response?.data?.details }); }
    finally { setBusy(false); }
  };
  const connectGmail = async () => {
    setBusy(true); setVerification(null);
    try { const res = await api.post('/invoicing-config/email/gmail/start'); window.location.assign(res.data.url); }
    catch (err) { setVerification({ ok: false, message: err.response?.data?.message || 'No se pudo iniciar la conexión.' }); setBusy(false); }
  };
  return (
    <form onSubmit={save} className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-slate-200 p-6 space-y-4">
      <h2 className="text-lg font-semibold text-slate-800">Correo para facturas electrónicas</h2>
      <p className="text-sm text-slate-600">Después de la autorización del SRI, las nuevas facturas se envían al correo del comprador con el RIDE en PDF y el XML. La configuración aplica a la empresa.</p>
      <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} /> Activar envío automático</label>
      <Field label="Método de envío"><select className="input" value={form.provider} onChange={(e) => { setVerification(null); setForm((f) => ({ ...f, provider: e.target.value, enabled: false })); }}><option value="smtp">SMTP</option><option value="gmail">API de Gmail</option></select></Field>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Correo remitente"><input className="input" type="email" value={form.from} onChange={(e) => set('from', e.target.value)} required={form.enabled} /></Field>
        {form.provider === 'smtp' ? <>
        <Field label="Servidor SMTP"><input className="input" value={form.host} onChange={(e) => set('host', e.target.value)} placeholder="smtp.ejemplo.com" required={form.enabled} /></Field>
        <Field label="Puerto SMTP"><input className="input" type="number" min="1" max="65535" value={form.port} onChange={(e) => set('port', e.target.value)} required={form.enabled} /></Field>
        <Field label="Usuario SMTP"><input className="input" value={form.user} onChange={(e) => set('user', e.target.value)} autoComplete="off" required={form.enabled} /></Field>
        <Field label="Contraseña SMTP"><input className="input" type="password" value={form.password} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" placeholder={config?.smtpPasswordConfigured ? 'Dejar vacía para conservar la actual' : ''} required={form.enabled && !config?.smtpPasswordConfigured} /></Field>
        <label className="flex items-center gap-2 text-sm text-slate-700 self-end pb-3"><input type="checkbox" checked={form.secure} onChange={(e) => set('secure', e.target.checked)} /> SSL/TLS directo (normalmente puerto 465)</label>
        </> : <>
          <Field label="ID de cliente de Google"><input className="input" value={form.gmailClientId} onChange={(e) => set('gmailClientId', e.target.value)} /></Field>
          <Field label="Secreto de cliente de Google"><input className="input" type="password" autoComplete="new-password" value={form.gmailClientSecret} onChange={(e) => set('gmailClientSecret', e.target.value)} placeholder={config?.gmailClientSecretConfigured ? 'Dejar vacío para conservar el actual' : ''} /></Field>
        </>}
      </div>
      {form.provider === 'smtp' ? <p className="text-xs text-slate-500">Sin SSL directo se exige STARTTLS (normalmente puerto 587). Algunos proveedores requieren una contraseña de aplicación. Las facturas anteriores se pueden enviar desde su detalle.</p> : <div className="text-sm text-slate-600 space-y-2">
        <p>Guarde los datos con el envío automático desactivado, conecte la cuenta de Google y luego active el envío. La cuenta conectada debe coincidir con el remitente.</p>
        <p>{config?.gmailConnected ? `Cuenta conectada: ${config.gmailAccount}` : 'Cuenta de Gmail no conectada.'}</p>
        {config?.gmailRedirectUri ? <p>URI de redirección para Google Cloud: <code className="break-all">{config.gmailRedirectUri}</code></p> : <p>El administrador debe configurar GMAIL_OAUTH_REDIRECT_URI en el servidor.</p>}
        <button type="button" disabled={busy || config?.emailProvider !== 'gmail'} onClick={connectGmail} className="px-4 py-2 border border-slate-300 rounded-lg disabled:opacity-50">Conectar cuenta de Google</button>
      </div>}
      {verification && <div role="status" className={`rounded-xl border p-3 text-sm ${verification.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-800'}`}>
        <p className="font-semibold">{verification.ok ? 'Conexión verificada' : 'No se pudo verificar la conexión'}</p>
        <p className="mt-1">{verification.message}</p>
        {verification.details && <p className="mt-1 text-xs">{verification.details}</p>}
      </div>}
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
