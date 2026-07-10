import { useEffect, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import { useSocketEvent } from '../context/SocketContext';
import Modal from '../components/Modal';
import {
  HiOutlineCog6Tooth,
  HiOutlineCheckCircle,
  HiOutlineXCircle,
  HiOutlineClipboardDocumentList,
  HiOutlinePlus,
  HiOutlinePencil,
  HiOutlineTrash,
  HiOutlineStar,
  HiStar,
  HiOutlineQrCode,
  HiOutlineCloud,
  HiOutlineExclamationTriangle,
} from 'react-icons/hi2';

const TABS = [
  { key: 'whatsapp', label: 'WhatsApp', color: 'emerald' },
  { key: 'messenger', label: 'Messenger', color: 'blue' },
  { key: 'instagram', label: 'Instagram', color: 'pink' },
  { key: 'tiktok', label: 'TikTok', color: 'slate' },
  { key: 'email', label: 'Email', color: 'amber' },
  { key: 'ai', label: 'Inteligencia Artificial', color: 'violet' },
];

const FIELD_DEFS = {
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
  ai: [
    { key: 'apiKey', label: 'API Key de Anthropic (Claude)', help: 'En console.anthropic.com → API Keys. Se guarda cifrada.', sensitive: true },
    { key: 'model', label: 'Modelo', help: 'Por defecto: claude-opus-4-8', sensitive: false },
  ],
};

const copyToClipboard = (text) => {
  navigator.clipboard.writeText(text).then(
    () => toast.success('Copiado'),
    () => toast.error('No se pudo copiar')
  );
};

export default function CallCenterConfig() {
  const [config, setConfig] = useState({
    whatsapp: { enabled: false },
    messenger: { enabled: false },
    instagram: { enabled: false },
    tiktok: { enabled: false },
    email: { enabled: false },
    ai: { enabled: false },
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
      await api.post(`/call-center-config/${tab}/test`);
      toast.success('Conexión exitosa');
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
            Conecta WhatsApp (varios números, Cloud API o QR), Messenger, Instagram, TikTok y Email
            para recibir y enviar mensajes desde la bandeja de chats.
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
              {t.key !== 'whatsapp' &&
                (enabled ? (
                  <HiOutlineCheckCircle className="w-4 h-4 text-emerald-600" />
                ) : (
                  <HiOutlineXCircle className="w-4 h-4 text-slate-300" />
                ))}
            </button>
          );
        })}
      </div>

      {/* WhatsApp: gestor de números (multi-número, Cloud API o QR) */}
      {tab === 'whatsapp' ? (
        <WhatsappNumbersManager />
      ) : (
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
          {webhookUrls && webhookUrls[tab] && (
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
      )}

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
    </div>
  );
}

// ════════════════ Gestor de números de WhatsApp (global / multi-número) ════════════════

const QR_STATUS_META = {
  connected: { label: 'Conectado', cls: 'bg-emerald-100 text-emerald-700' },
  qr_pending: { label: 'Escanea el QR', cls: 'bg-amber-100 text-amber-700' },
  connecting: { label: 'Conectando…', cls: 'bg-sky-100 text-sky-700' },
  auth_failure: { label: 'Falló la conexión', cls: 'bg-red-100 text-red-700' },
  disconnected: { label: 'Desconectado', cls: 'bg-slate-100 text-slate-500' },
};

const blankAccount = () => ({
  connectionType: 'cloud_api',
  label: '',
  displayPhone: '',
  phoneNumberId: '',
  businessAccountId: '',
  accessToken: '',
});

function WhatsappNumbersManager() {
  const [appCfg, setAppCfg] = useState(null);
  const [appDraft, setAppDraft] = useState({ appSecret: '', verifyToken: '' });
  const [capiDraft, setCapiDraft] = useState({ enabled: false, datasetId: '', accessToken: '', testEventCode: '' });
  const [savingApp, setSavingApp] = useState(false);
  const [testingCapi, setTestingCapi] = useState(false);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [addModal, setAddModal] = useState(null);
  const [editModal, setEditModal] = useState(null);
  const [qrModal, setQrModal] = useState(null); // { accountId, label, qr, status }

  const load = async () => {
    setLoading(true);
    try {
      const [a, acc] = await Promise.all([
        api.get('/call-center-config/whatsapp/app-config'),
        api.get('/call-center-config/whatsapp/accounts'),
      ]);
      setAppCfg(a.data);
      setAppDraft({ appSecret: '', verifyToken: '' });
      setCapiDraft({
        enabled: Boolean(a.data?.conversionsApi?.enabled),
        datasetId: a.data?.conversionsApi?.datasetId || '',
        accessToken: '',
        testEventCode: a.data?.conversionsApi?.testEventCode || '',
      });
      setAccounts(acc.data || []);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al cargar números de WhatsApp');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  // QR en vivo del número que se está conectando.
  useSocketEvent('whatsapp:qr', (p) => {
    setQrModal((m) =>
      m && String(m.accountId) === String(p.accountId) ? { ...m, qr: p.qr, status: p.status } : m
    );
  });

  // Cambios de estado de cualquier número (lista + modal de QR).
  useSocketEvent('whatsapp:status', (p) => {
    setAccounts((list) =>
      list.map((x) =>
        String(x._id) === String(p.accountId)
          ? { ...x, status: p.status, liveStatus: p.status, connectedPhone: p.connectedPhone || x.connectedPhone }
          : x
      )
    );
    setQrModal((m) => {
      if (!m || String(m.accountId) !== String(p.accountId)) return m;
      if (p.status === 'connected') {
        toast.success('Número conectado');
        return null;
      }
      // Si falló, se limpia el QR viejo y se muestra el motivo.
      return { ...m, status: p.status, error: p.error || '', qr: p.status === 'auth_failure' ? '' : m.qr };
    });
  });

  const saveApp = async () => {
    setSavingApp(true);
    try {
      const payload = {
        capiEnabled: capiDraft.enabled,
        capiDatasetId: capiDraft.datasetId,
        capiTestEventCode: capiDraft.testEventCode,
      };
      if (appDraft.appSecret) payload.appSecret = appDraft.appSecret;
      if (appDraft.verifyToken) payload.verifyToken = appDraft.verifyToken;
      if (capiDraft.accessToken) payload.capiAccessToken = capiDraft.accessToken;
      const r = await api.put('/call-center-config/whatsapp/app-config', payload);
      setAppCfg(r.data);
      setAppDraft({ appSecret: '', verifyToken: '' });
      setCapiDraft({
        enabled: Boolean(r.data?.conversionsApi?.enabled),
        datasetId: r.data?.conversionsApi?.datasetId || '',
        accessToken: '',
        testEventCode: r.data?.conversionsApi?.testEventCode || '',
      });
      toast.success('Configuración de WhatsApp guardada');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al guardar');
    } finally {
      setSavingApp(false);
    }
  };

  const testCapi = async () => {
    setTestingCapi(true);
    try {
      await api.post('/call-center-config/whatsapp/capi/test');
      toast.success('Evento de prueba enviado. Revísalo en "Probar eventos" del Administrador de Eventos de Meta.');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al probar la Conversions API');
    } finally {
      setTestingCapi(false);
    }
  };

  const refreshQuality = async (acc) => {
    try {
      const r = await api.post(`/call-center-config/whatsapp/accounts/${acc._id}/quality`);
      setAccounts((l) => l.map((x) => (x._id === acc._id ? { ...x, ...r.data.account } : x)));
      toast.success(`Calidad actualizada: ${r.data.qualityRating}${r.data.messagingLimit ? ` · límite ${r.data.messagingLimit}` : ''}`);
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo consultar la calidad');
    }
  };

  const openConnect = async (acc) => {
    setQrModal({ accountId: acc._id, label: acc.label, qr: '', status: 'connecting' });
    try {
      await api.post(`/call-center-config/whatsapp/accounts/${acc._id}/connect`);
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo iniciar la conexión');
      setQrModal(null);
    }
  };

  const disconnect = async (acc) => {
    if (!window.confirm(`¿Desconectar "${acc.label}"? Tendrás que volver a escanear el QR.`)) return;
    try {
      await api.post(`/call-center-config/whatsapp/accounts/${acc._id}/disconnect`);
      setAccounts((l) => l.map((x) => (x._id === acc._id ? { ...x, status: 'disconnected', liveStatus: 'disconnected' } : x)));
      toast.success('Número desconectado');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    }
  };

  const createAccount = async () => {
    const a = addModal;
    if (!a.label.trim()) return toast.error('Ponle un nombre al número');
    if (a.connectionType === 'cloud_api' && !a.phoneNumberId.trim()) {
      return toast.error('Cloud API requiere Phone Number ID');
    }
    try {
      const payload = {
        connectionType: a.connectionType,
        label: a.label,
        displayPhone: a.displayPhone,
      };
      if (a.connectionType === 'cloud_api') {
        payload.phoneNumberId = a.phoneNumberId;
        payload.businessAccountId = a.businessAccountId;
        if (a.accessToken) payload.accessToken = a.accessToken;
      }
      const created = (await api.post('/call-center-config/whatsapp/accounts', payload)).data;
      setAccounts((l) => [...l, created]);
      setAddModal(null);
      toast.success('Número agregado');
      if (created.connectionType === 'qr') openConnect(created);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al crear número');
    }
  };

  const saveEdit = async () => {
    const a = editModal;
    try {
      const payload = { label: a.label, displayPhone: a.displayPhone };
      if (a.connectionType === 'cloud_api') {
        payload.phoneNumberId = a.phoneNumberId;
        payload.businessAccountId = a.businessAccountId;
        if (a.accessToken) payload.accessToken = a.accessToken;
      }
      const updated = (await api.put(`/call-center-config/whatsapp/accounts/${a._id}`, payload)).data;
      setAccounts((l) => l.map((x) => (x._id === a._id ? updated : x)));
      setEditModal(null);
      toast.success('Número actualizado');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al actualizar');
    }
  };

  const removeAccount = async (acc) => {
    if (!window.confirm(`¿Eliminar el número "${acc.label}"?`)) return;
    try {
      await api.delete(`/call-center-config/whatsapp/accounts/${acc._id}`);
      setAccounts((l) => l.filter((x) => x._id !== acc._id));
      toast.success('Número eliminado');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    }
  };

  const setDefault = async (acc) => {
    try {
      await api.post(`/call-center-config/whatsapp/accounts/${acc._id}/default`);
      setAccounts((l) => l.map((x) => ({ ...x, isDefault: x._id === acc._id })));
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    }
  };

  const toggleEnabled = async (acc) => {
    try {
      const updated = (await api.put(`/call-center-config/whatsapp/accounts/${acc._id}`, { enabled: !acc.enabled })).data;
      setAccounts((l) => l.map((x) => (x._id === acc._id ? updated : x)));
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    }
  };

  const testAccount = async (acc) => {
    try {
      const r = await api.post(`/call-center-config/whatsapp/accounts/${acc._id}/test`);
      toast.success(`Conexión OK: ${r.data?.info?.display_phone_number || 'verificado'}`);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error de conexión');
    }
  };

  if (loading) return <div className="text-slate-500 text-sm">Cargando números…</div>;

  return (
    <div className="space-y-4">
      {/* Ajustes a nivel de app (compartidos por todos los números Cloud API) */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-800">Ajustes de WhatsApp (compartidos)</h2>
          <p className="text-xs text-slate-500">
            El call center atiende a todas las sedes: los números de WhatsApp son globales. Estos datos
            (webhook, App Secret y Verify Token) son a nivel de tu app de Meta y valen para todos los
            números Cloud API.
          </p>
        </div>

        <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs space-y-2">
          <p className="font-semibold text-slate-700">URL del webhook (una sola, pégala en Meta)</p>
          <div className="flex items-center gap-2 bg-white border border-slate-200 rounded-xl px-2 py-1.5">
            <code className="flex-1 text-slate-700 break-all">{appCfg?.webhookUrl}</code>
            <button
              type="button"
              onClick={() => copyToClipboard(appCfg?.webhookUrl || '')}
              className="px-2 py-1 text-[11px] bg-emerald-600 text-white rounded cursor-pointer border-none"
              title="Copiar"
            >
              <HiOutlineClipboardDocumentList className="w-3.5 h-3.5 inline" /> Copiar
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block text-sm">
            <span className="text-slate-700 font-medium">App Secret</span>
            <input
              type="password"
              value={appDraft.appSecret}
              onChange={(e) => setAppDraft({ ...appDraft, appSecret: e.target.value })}
              placeholder={appCfg?.appSecret || '••••••'}
              autoComplete="off"
              className="block w-full mt-1 border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm font-mono"
            />
            <span className="text-[11px] text-slate-400">Valida la firma del webhook.</span>
          </label>
          <label className="block text-sm">
            <span className="text-slate-700 font-medium">Verify Token</span>
            <input
              type="password"
              value={appDraft.verifyToken}
              onChange={(e) => setAppDraft({ ...appDraft, verifyToken: e.target.value })}
              placeholder={appCfg?.verifyToken || '••••••'}
              autoComplete="off"
              className="block w-full mt-1 border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm font-mono"
            />
            <span className="text-[11px] text-slate-400">El mismo que pongas en Meta.</span>
          </label>
        </div>
        {/* Conversions API (CAPI): reporta Lead/Cita/Compra a Meta para optimizar anuncios */}
        <div className="border-t border-slate-100 pt-3 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <h3 className="text-sm font-semibold text-slate-800">Conversions API (optimización de anuncios)</h3>
              <p className="text-xs text-slate-500">
                Reporta a Meta las conversiones reales del CRM (nuevo lead, cita agendada, venta pagada)
                para que tus campañas se optimicen por resultados y no solo por clics.
              </p>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
              <input
                type="checkbox"
                checked={capiDraft.enabled}
                onChange={(e) => setCapiDraft({ ...capiDraft, enabled: e.target.checked })}
                className="w-4 h-4 accent-emerald-600"
              />
              Habilitada
            </label>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="block text-sm">
              <span className="text-slate-700 font-medium">Dataset ID (Pixel ID)</span>
              <input
                value={capiDraft.datasetId}
                onChange={(e) => setCapiDraft({ ...capiDraft, datasetId: e.target.value })}
                placeholder="1234567890"
                className="block w-full mt-1 border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm font-mono"
              />
              <span className="text-[11px] text-slate-400">Del Administrador de Eventos de Meta.</span>
            </label>
            <label className="block text-sm">
              <span className="text-slate-700 font-medium">Access Token (CAPI)</span>
              <input
                type="password"
                value={capiDraft.accessToken}
                onChange={(e) => setCapiDraft({ ...capiDraft, accessToken: e.target.value })}
                placeholder={appCfg?.conversionsApi?.accessToken || '••••••'}
                autoComplete="off"
                className="block w-full mt-1 border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm font-mono"
              />
              <span className="text-[11px] text-slate-400">Se genera en Configuración del dataset.</span>
            </label>
            <label className="block text-sm">
              <span className="text-slate-700 font-medium">Código de prueba (opcional)</span>
              <input
                value={capiDraft.testEventCode}
                onChange={(e) => setCapiDraft({ ...capiDraft, testEventCode: e.target.value })}
                placeholder="TEST12345"
                className="block w-full mt-1 border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm font-mono"
              />
              <span className="text-[11px] text-slate-400">
                Solo para pruebas ("Probar eventos"). Déjalo vacío en producción.
              </span>
            </label>
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={testCapi}
            disabled={testingCapi}
            className="px-4 py-2 rounded-lg border border-slate-200 bg-white text-slate-700 text-sm cursor-pointer disabled:opacity-50"
          >
            {testingCapi ? 'Probando…' : 'Probar Conversions API'}
          </button>
          <button
            type="button"
            onClick={saveApp}
            disabled={savingApp}
            className="px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-medium border-none cursor-pointer disabled:opacity-50"
          >
            {savingApp ? 'Guardando…' : 'Guardar ajustes'}
          </button>
        </div>
      </div>

      {/* Lista de números */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h2 className="text-lg font-semibold text-slate-800">Números de WhatsApp</h2>
            <p className="text-xs text-slate-500">
              Conecta hasta 5 números por Cloud API (Meta, oficial) o por QR (estilo WhatsApp Web).
            </p>
          </div>
          <button
            onClick={() => setAddModal(blankAccount())}
            className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm flex items-center gap-1 cursor-pointer border-none"
          >
            <HiOutlinePlus /> Agregar número
          </button>
        </div>

        {accounts.length === 0 ? (
          <div className="text-center py-10 text-slate-400 border border-dashed border-slate-200 rounded-xl text-sm">
            Aún no hay números. Agrega el primero con "Agregar número".
          </div>
        ) : (
          <div className="grid gap-2">
            {accounts.map((acc) => (
              <AccountCard
                key={acc._id}
                acc={acc}
                onSetDefault={() => setDefault(acc)}
                onToggleEnabled={() => toggleEnabled(acc)}
                onEdit={() => setEditModal({ ...acc, accessToken: '' })}
                onDelete={() => removeAccount(acc)}
                onConnect={() => openConnect(acc)}
                onDisconnect={() => disconnect(acc)}
                onTest={() => testAccount(acc)}
                onRefreshQuality={() => refreshQuality(acc)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Aviso de hosting para QR */}
      <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-xs text-amber-900 flex gap-2">
        <HiOutlineExclamationTriangle className="w-5 h-5 shrink-0 text-amber-500" />
        <div>
          <p className="font-semibold mb-1">Sobre la conexión por QR</p>
          <ul className="list-disc list-inside space-y-1">
            <li>Es una sesión tipo WhatsApp Web (no oficial): no usa plantillas y puede enviar texto libre.</li>
            <li>WhatsApp puede bloquear números que envían mucho contenido automatizado: úsala con criterio.</li>
            <li>
              Requiere el servidor siempre encendido. En hosting gratuito (Render) será inestable; es
              plenamente funcional en un VPS. Los números <b>Cloud API</b> funcionan en cualquier hosting.
            </li>
          </ul>
        </div>
      </div>

      {/* Modal: agregar número */}
      <Modal isOpen={!!addModal} onClose={() => setAddModal(null)} title="Agregar número de WhatsApp" size="md">
        {addModal && (
          <AccountForm
            value={addModal}
            onChange={setAddModal}
            allowMethod
            onCancel={() => setAddModal(null)}
            onSubmit={createAccount}
            submitLabel="Agregar"
          />
        )}
      </Modal>

      {/* Modal: editar número */}
      <Modal isOpen={!!editModal} onClose={() => setEditModal(null)} title="Editar número" size="md">
        {editModal && (
          <AccountForm
            value={editModal}
            onChange={setEditModal}
            allowMethod={false}
            onCancel={() => setEditModal(null)}
            onSubmit={saveEdit}
            submitLabel="Guardar"
          />
        )}
      </Modal>

      {/* Modal: QR */}
      <Modal isOpen={!!qrModal} onClose={() => setQrModal(null)} title={`Conectar "${qrModal?.label || ''}"`} size="sm">
        {qrModal && (
          <div className="text-center space-y-3">
            <p className="text-sm text-slate-600">
              Abre WhatsApp en el teléfono → <b>Dispositivos vinculados</b> → <b>Vincular un dispositivo</b> y
              escanea este código.
            </p>
            <div className="flex items-center justify-center min-h-[240px]">
              {qrModal.qr ? (
                <img src={qrModal.qr} alt="Código QR" className="w-56 h-56" />
              ) : (
                <div className="text-slate-400 text-sm flex flex-col items-center gap-2">
                  <HiOutlineQrCode className="w-10 h-10 animate-pulse" />
                  Generando código QR…
                </div>
              )}
            </div>
            <div className="text-xs">
              <span className={`px-2 py-0.5 rounded-full ${(QR_STATUS_META[qrModal.status] || QR_STATUS_META.connecting).cls}`}>
                {(QR_STATUS_META[qrModal.status] || QR_STATUS_META.connecting).label}
              </span>
            </div>
            {qrModal.error && (
              <p className="text-xs text-red-600">{qrModal.error}</p>
            )}
            <div className="flex items-center justify-center gap-2">
              {qrModal.status === 'auth_failure' && (
                <button
                  onClick={() => openConnect({ _id: qrModal.accountId, label: qrModal.label })}
                  className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm cursor-pointer border-none"
                >
                  Reintentar
                </button>
              )}
              <button
                onClick={() => setQrModal(null)}
                className="px-4 py-2 border border-slate-200 rounded-lg text-sm bg-white cursor-pointer"
              >
                Cerrar
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

const QUALITY_META = {
  GREEN: { label: 'Calidad: Verde', cls: 'bg-emerald-100 text-emerald-700' },
  YELLOW: { label: 'Calidad: Amarilla', cls: 'bg-amber-100 text-amber-700' },
  RED: { label: 'Calidad: Roja', cls: 'bg-red-100 text-red-700' },
};

function AccountCard({ acc, onSetDefault, onToggleEnabled, onEdit, onDelete, onConnect, onDisconnect, onTest, onRefreshQuality }) {
  const isQr = acc.connectionType === 'qr';
  const status = acc.liveStatus || acc.status;
  const phone = acc.connectedPhone || acc.displayPhone || acc.phoneNumberId || '—';
  const badge = isQr
    ? QR_STATUS_META[status] || QR_STATUS_META.disconnected
    : acc.enabled
    ? { label: 'Activo', cls: 'bg-emerald-100 text-emerald-700' }
    : { label: 'Inactivo', cls: 'bg-slate-100 text-slate-500' };
  const quality = !isQr ? QUALITY_META[acc.qualityRating] : null;

  return (
    <div className="border border-slate-200 rounded-xl p-3 bg-white flex items-center gap-3 flex-wrap">
      <button
        onClick={onSetDefault}
        title={acc.isDefault ? 'Número por defecto (campañas/automatizaciones)' : 'Marcar como por defecto'}
        className="bg-transparent border-none cursor-pointer p-0"
      >
        {acc.isDefault ? <HiStar className="w-5 h-5 text-amber-500" /> : <HiOutlineStar className="w-5 h-5 text-slate-300" />}
      </button>
      <span
        className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full ${
          isQr ? 'bg-violet-100 text-violet-700' : 'bg-sky-100 text-sky-700'
        }`}
      >
        {isQr ? <HiOutlineQrCode className="w-3.5 h-3.5" /> : <HiOutlineCloud className="w-3.5 h-3.5" />}
        {isQr ? 'QR' : 'Cloud API'}
      </span>
      <div className="flex-1 min-w-[140px]">
        <div className="font-semibold text-slate-800 text-sm">{acc.label}</div>
        <div className="text-xs text-slate-400">{phone}</div>
      </div>
      <span className={`text-[11px] px-2 py-0.5 rounded-full ${badge.cls}`}>{badge.label}</span>
      {quality && (
        <button
          onClick={onRefreshQuality}
          title={`Calidad del número según Meta${acc.messagingLimit ? ` · Límite: ${acc.messagingLimit}` : ''}. Clic para actualizar.`}
          className={`text-[11px] px-2 py-0.5 rounded-full border-none cursor-pointer ${quality.cls}`}
        >
          {quality.label}
        </button>
      )}
      {!isQr && !quality && (
        <button
          onClick={onRefreshQuality}
          title="Consultar a Meta la calidad del número (Verde/Amarillo/Rojo)"
          className="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 border-none cursor-pointer"
        >
          Calidad: consultar
        </button>
      )}

      <label className="flex items-center gap-1 text-xs text-slate-500 cursor-pointer">
        <input type="checkbox" checked={!!acc.enabled} onChange={onToggleEnabled} className="w-4 h-4 accent-emerald-600" />
        Activo
      </label>

      <div className="flex items-center gap-1">
        {isQr ? (
          status === 'connected' ? (
            <button onClick={onDisconnect} className="px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg bg-white cursor-pointer">
              Desconectar
            </button>
          ) : (
            <button onClick={onConnect} className="px-2.5 py-1.5 text-xs bg-emerald-600 text-white rounded-lg cursor-pointer border-none">
              Conectar
            </button>
          )
        ) : (
          <button onClick={onTest} className="px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg bg-white cursor-pointer">
            Probar
          </button>
        )}
        <button onClick={onEdit} className="p-2 text-slate-500 hover:text-emerald-600 bg-transparent border-none cursor-pointer" title="Editar">
          <HiOutlinePencil className="w-4 h-4" />
        </button>
        <button onClick={onDelete} className="p-2 text-slate-500 hover:text-red-600 bg-transparent border-none cursor-pointer" title="Eliminar">
          <HiOutlineTrash className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

function AccountForm({ value, onChange, allowMethod, onCancel, onSubmit, submitLabel }) {
  const set = (patch) => onChange({ ...value, ...patch });
  const isCloud = value.connectionType === 'cloud_api';
  return (
    <div className="grid gap-3">
      {allowMethod && (
        <div>
          <span className="text-sm text-slate-600 block mb-1">Método de conexión</span>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => set({ connectionType: 'cloud_api' })}
              className={`px-3 py-2 rounded-lg border text-sm flex items-center justify-center gap-1.5 cursor-pointer ${
                isCloud ? 'bg-sky-50 border-sky-300 text-sky-700' : 'bg-white border-slate-200 text-slate-600'
              }`}
            >
              <HiOutlineCloud className="w-4 h-4" /> Cloud API (Meta)
            </button>
            <button
              type="button"
              onClick={() => set({ connectionType: 'qr' })}
              className={`px-3 py-2 rounded-lg border text-sm flex items-center justify-center gap-1.5 cursor-pointer ${
                !isCloud ? 'bg-violet-50 border-violet-300 text-violet-700' : 'bg-white border-slate-200 text-slate-600'
              }`}
            >
              <HiOutlineQrCode className="w-4 h-4" /> QR (WhatsApp Web)
            </button>
          </div>
          <p className="text-[11px] text-slate-400 mt-1">
            {isCloud
              ? 'Oficial. Requiere credenciales de Meta y permite plantillas aprobadas.'
              : 'Vincula escaneando un QR. No usa plantillas; envía texto libre.'}
          </p>
        </div>
      )}

      <label className="text-sm">
        <span className="text-slate-600">Nombre del número</span>
        <input
          value={value.label}
          onChange={(e) => set({ label: e.target.value })}
          placeholder="ej. Recepción principal"
          className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
        />
      </label>

      <label className="text-sm">
        <span className="text-slate-600">Teléfono visible (opcional)</span>
        <input
          value={value.displayPhone}
          onChange={(e) => set({ displayPhone: e.target.value })}
          placeholder="+593987654321"
          className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
        />
      </label>

      {isCloud && (
        <>
          <label className="text-sm">
            <span className="text-slate-600">Phone Number ID</span>
            <input
              value={value.phoneNumberId}
              onChange={(e) => set({ phoneNumberId: e.target.value })}
              className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono"
            />
          </label>
          <label className="text-sm">
            <span className="text-slate-600">WhatsApp Business Account ID (WABA)</span>
            <input
              value={value.businessAccountId}
              onChange={(e) => set({ businessAccountId: e.target.value })}
              className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono"
            />
          </label>
          <label className="text-sm">
            <span className="text-slate-600">Access Token</span>
            <input
              type="password"
              autoComplete="off"
              value={value.accessToken}
              onChange={(e) => set({ accessToken: e.target.value })}
              placeholder={value._id ? '•••••• (escribe para reemplazar)' : ''}
              className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono"
            />
          </label>
        </>
      )}

      <div className="flex justify-end gap-2 mt-2">
        <button onClick={onCancel} className="px-4 py-2 border border-slate-200 rounded-lg text-sm bg-white cursor-pointer">
          Cancelar
        </button>
        <button onClick={onSubmit} className="px-5 py-2 bg-emerald-600 text-white rounded-lg text-sm cursor-pointer border-none">
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
