import { useEffect, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import {
  HiOutlineCog6Tooth,
  HiOutlineCheckCircle,
  HiOutlineXCircle,
  HiOutlineClipboardDocumentList,
} from 'react-icons/hi2';

const TABS = [
  { key: 'whatsapp', label: 'WhatsApp', color: 'emerald' },
  { key: 'messenger', label: 'Messenger', color: 'blue' },
  { key: 'instagram', label: 'Instagram', color: 'pink' },
  { key: 'tiktok', label: 'TikTok', color: 'slate' },
  { key: 'email', label: 'Email', color: 'amber' },
];

const FIELD_DEFS = {
  whatsapp: [
    { key: 'phoneNumberId', label: 'Phone Number ID', help: 'En Meta → WhatsApp Business → API Setup', sensitive: false },
    { key: 'businessAccountId', label: 'WhatsApp Business Account ID (WABA ID)', sensitive: false },
    { key: 'accessToken', label: 'Access Token (long-lived)', sensitive: true },
    { key: 'verifyToken', label: 'Verify Token (lo defines tú, debe coincidir en Meta)', sensitive: true },
    { key: 'appSecret', label: 'App Secret', help: 'Para validar firma X-Hub-Signature', sensitive: true },
    { key: 'displayPhone', label: 'Teléfono visible (E.164, ej. +593987654321)', sensitive: false },
  ],
  messenger: [
    { key: 'pageId', label: 'Page ID de la página de Facebook', sensitive: false },
    { key: 'pageAccessToken', label: 'Page Access Token', sensitive: true },
    { key: 'verifyToken', label: 'Verify Token', sensitive: true },
    { key: 'appSecret', label: 'App Secret', sensitive: true },
  ],
  instagram: [
    { key: 'igBusinessAccountId', label: 'Instagram Business Account ID', sensitive: false },
    { key: 'pageId', label: 'Page ID de la página de FB vinculada', sensitive: false },
    { key: 'pageAccessToken', label: 'Page Access Token (mismo de FB)', sensitive: true },
    { key: 'verifyToken', label: 'Verify Token', sensitive: true },
    { key: 'appSecret', label: 'App Secret', sensitive: true },
  ],
  tiktok: [
    { key: 'appId', label: 'App ID', sensitive: false },
    { key: 'appSecret', label: 'App Secret', sensitive: true },
    { key: 'accessToken', label: 'Access Token', sensitive: true },
    { key: 'businessId', label: 'Business ID', sensitive: false },
    { key: 'verifyToken', label: 'Verify Token', sensitive: true },
  ],
  email: [
    { key: 'apiKey', label: 'API Key de Resend', help: 'En resend.com → API Keys', sensitive: true },
    { key: 'fromEmail', label: 'Email remitente (verificado en Resend)', sensitive: false },
    { key: 'fromName', label: 'Nombre remitente', sensitive: false },
    { key: 'replyTo', label: 'Responder a (opcional)', sensitive: false },
  ],
};

export default function CallCenterConfig() {
  const [config, setConfig] = useState({
    whatsapp: { enabled: false },
    messenger: { enabled: false },
    instagram: { enabled: false },
    tiktok: { enabled: false },
    email: { enabled: false },
  });
  const [webhookUrls, setWebhookUrls] = useState(null);
  const [tab, setTab] = useState('whatsapp');
  const [draft, setDraft] = useState({});
  const [repDraft, setRepDraft] = useState(null); // { googleReviewUrl, minRating }
  const [savingRep, setSavingRep] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [c, u] = await Promise.all([
        api.get('/call-center-config'),
        api.get('/call-center-config/webhook-urls'),
      ]);
      setConfig(c.data);
      setRepDraft({
        googleReviewUrl: c.data.reputation?.googleReviewUrl || '',
        minRating: c.data.reputation?.minRating || 4,
      });
      setWebhookUrls(u.data);
      setDraft({});
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al cargar configuración');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    setDraft({});
  }, [tab]);

  const currentChannel = config[tab] || {};
  const fields = FIELD_DEFS[tab] || [];

  const setField = (key, value) => {
    setDraft((d) => ({ ...d, [key]: value }));
  };

  const toggleEnabled = async (next) => {
    try {
      const r = await api.put('/call-center-config', {
        channel: tab,
        data: { enabled: next },
      });
      setConfig(r.data);
      toast.success(next ? 'Canal activado' : 'Canal desactivado');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    }
  };

  const save = async () => {
    if (Object.keys(draft).length === 0) {
      toast.error('No hay cambios');
      return;
    }
    setSaving(true);
    try {
      const r = await api.put('/call-center-config', { channel: tab, data: draft });
      setConfig(r.data);
      setDraft({});
      toast.success('Configuración guardada');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    setTesting(true);
    try {
      const r = await api.post(`/call-center-config/${tab}/test`);
      toast.success('Conexión exitosa');
      console.log('Test result:', r.data);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error de conexión');
    } finally {
      setTesting(false);
    }
  };

  const saveReputation = async () => {
    setSavingRep(true);
    try {
      const r = await api.put('/call-center-config/reputation', repDraft);
      setConfig(r.data);
      toast.success('Reputación guardada');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al guardar reputación');
    } finally {
      setSavingRep(false);
    }
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text).then(
      () => toast.success('Copiado'),
      () => toast.error('No se pudo copiar')
    );
  };

  if (loading) {
    return <div className="text-slate-500 text-sm">Cargando…</div>;
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
            <span className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-md">
              <HiOutlineCog6Tooth className="w-5 h-5" />
            </span>
            Configuración del Call Center
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Conecta las APIs de WhatsApp, Messenger, Instagram y TikTok para recibir y enviar
            mensajes desde la bandeja de chats.
          </p>
        </div>
      </div>

      {/* Tabs por canal */}
      <div className="flex flex-wrap gap-2 border-b border-slate-200">
        {TABS.map((t) => {
          const enabled = !!config[t.key]?.enabled;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px flex items-center gap-2 cursor-pointer bg-transparent ${
                tab === t.key
                  ? 'border-emerald-600 text-emerald-700'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              {t.label}
              {enabled ? (
                <HiOutlineCheckCircle className="w-4 h-4 text-emerald-600" />
              ) : (
                <HiOutlineXCircle className="w-4 h-4 text-slate-300" />
              )}
            </button>
          );
        })}
      </div>

      {/* Panel de configuración */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-800">
              {TABS.find((x) => x.key === tab).label}
            </h2>
            <p className="text-xs text-slate-500">
              {currentChannel.enabled
                ? '✓ Activo. Los mensajes entrantes se reciben en la bandeja de chats.'
                : 'Inactivo. Configura las credenciales y actívalo cuando esté listo.'}
            </p>
          </div>
          <label className="flex items-center gap-2 cursor-pointer text-sm">
            <input
              type="checkbox"
              checked={!!currentChannel.enabled}
              onChange={(e) => toggleEnabled(e.target.checked)}
              className="w-5 h-5 accent-emerald-600"
            />
            <span className="font-medium text-slate-700">
              {currentChannel.enabled ? 'Activo' : 'Inactivo'}
            </span>
          </label>
        </div>

        {/* URLs del webhook que el usuario debe pegar en Meta/TikTok */}
        {webhookUrls && (
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs space-y-2">
            <p className="font-semibold text-slate-700">URL del webhook (cópiala al panel del proveedor)</p>
            <div className="flex items-center gap-2 bg-white border border-slate-200 rounded-xl px-2 py-1.5">
              <code className="flex-1 text-slate-700 break-all">{webhookUrls[tab]}</code>
              <button
                type="button"
                onClick={() => copyToClipboard(webhookUrls[tab])}
                className="px-2 py-1 text-[11px] bg-emerald-600 text-white rounded cursor-pointer border-none"
                title="Copiar"
              >
                <HiOutlineClipboardDocumentList className="w-3.5 h-3.5 inline" /> Copiar
              </button>
            </div>
            <p className="text-[11px] text-slate-500">{webhookUrls.note}</p>
          </div>
        )}

        {/* Formulario de credenciales */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {fields.map((f) => {
            const stored = currentChannel[f.key];
            const draftVal = draft[f.key];
            const showValue = draftVal !== undefined ? draftVal : stored || '';
            return (
              <label key={f.key} className="block text-sm">
                <span className="text-slate-700 font-medium">{f.label}</span>
                <input
                  type={f.sensitive ? 'password' : 'text'}
                  value={showValue}
                  onChange={(e) => setField(f.key, e.target.value)}
                  placeholder={f.sensitive ? '••••••' : ''}
                  autoComplete="off"
                  className="block w-full mt-1 border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm font-mono"
                />
                {f.help && <span className="text-[11px] text-slate-400">{f.help}</span>}
                {f.sensitive && stored && draftVal === undefined && (
                  <span className="text-[11px] text-emerald-600">
                    Ya configurado · escribe para reemplazarlo
                  </span>
                )}
              </label>
            );
          })}
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
          <button
            type="button"
            onClick={testConnection}
            disabled={testing}
            className="px-4 py-2 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 bg-white cursor-pointer disabled:opacity-50"
          >
            {testing ? 'Probando…' : 'Probar conexión'}
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving || Object.keys(draft).length === 0}
            className="px-5 py-2 rounded-lg bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-medium border-none cursor-pointer disabled:opacity-50"
          >
            {saving ? 'Guardando…' : 'Guardar cambios'}
          </button>
        </div>
      </div>

      {/* Reputación / reseñas */}
      {repDraft && (
        <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-800">Reputación (reseñas)</h2>
            <p className="text-xs text-slate-500">
              El workflow post-visita invita a calificar (1-5). Si la calificación es alta, el
              paciente es redirigido a dejar una reseña en Google; si es baja, se captura su
              comentario internamente.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block text-sm">
              <span className="text-slate-700 font-medium">URL de reseñas de Google</span>
              <input
                value={repDraft.googleReviewUrl}
                onChange={(e) => setRepDraft({ ...repDraft, googleReviewUrl: e.target.value })}
                placeholder="https://g.page/r/..."
                className="block w-full mt-1 border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm"
              />
              <span className="text-[11px] text-slate-400">
                Enlace "Escribir una reseña" de tu ficha de Google Business.
              </span>
            </label>
            <label className="block text-sm">
              <span className="text-slate-700 font-medium">Calificación mínima para reseña pública</span>
              <select
                value={repDraft.minRating}
                onChange={(e) => setRepDraft({ ...repDraft, minRating: Number(e.target.value) })}
                className="block w-full mt-1 border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm"
              >
                {[3, 4, 5].map((n) => (
                  <option key={n} value={n}>{n} estrellas o más</option>
                ))}
              </select>
              <span className="text-[11px] text-slate-400">
                Por debajo de este valor no se envía a Google (feedback interno).
              </span>
            </label>
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={saveReputation}
              disabled={savingRep}
              className="px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-medium border-none cursor-pointer disabled:opacity-50"
            >
              {savingRep ? 'Guardando…' : 'Guardar reputación'}
            </button>
          </div>
        </div>
      )}

      {/* Guía rápida */}
      <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-sm text-amber-900">
        <p className="font-semibold mb-2">Notas importantes</p>
        <ul className="list-disc list-inside space-y-1 text-xs">
          <li>
            <b>WhatsApp / Messenger / Instagram</b>: Usan Meta for Developers. Necesitas un App ID y
            permisos aprobados (whatsapp_business_messaging, pages_messaging, instagram_manage_messages).
          </li>
          <li>
            <b>TikTok</b>: Requiere tener una app aprobada en TikTok Developers con permisos de
            mensajería del producto que uses (Business Messaging / Customer Service).
          </li>
          <li>
            El <b>Verify Token</b> lo eliges tú. Debe ser el mismo aquí y en el panel del
            proveedor para que la verificación pase.
          </li>
          <li>
            Los campos sensibles se muestran enmascarados (•••• + últimos 4) una vez guardados.
            Para reemplazar un valor, simplemente escribe encima.
          </li>
        </ul>
      </div>
    </div>
  );
}
