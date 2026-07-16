import { useEffect, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import { useSocket, useSocketEvent } from '../context/SocketContext';
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
  HiOutlineArrowPath,
  HiOutlineDevicePhoneMobile,
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

// Interruptor visual (reemplaza los checkboxes "Activo", que confundían).
function Toggle({ checked, onChange, title }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      title={title}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border-none cursor-pointer transition-colors ${
        checked ? 'bg-emerald-500' : 'bg-slate-300'
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-[19px]' : 'translate-x-[3px]'
        }`}
      />
    </button>
  );
}

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
            <div className="flex items-center gap-2 text-sm">
              <Toggle
                checked={!!currentChannel.enabled}
                onChange={() => toggleEnabled(!currentChannel.enabled)}
                title={currentChannel.enabled ? 'Canal activo: clic para desactivarlo' : 'Canal inactivo: clic para activarlo'}
              />
              <span className={`font-medium ${currentChannel.enabled ? 'text-emerald-700' : 'text-slate-400'}`}>
                {currentChannel.enabled ? 'Activo' : 'Inactivo'}
              </span>
            </div>
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
  connected: { label: 'Conectado', cls: 'bg-emerald-100 text-emerald-700', dot: 'bg-emerald-500' },
  qr_pending: { label: 'Esperando escaneo del QR', cls: 'bg-amber-100 text-amber-700', dot: 'bg-amber-500 animate-pulse' },
  connecting: { label: 'Iniciando sesión…', cls: 'bg-sky-100 text-sky-700', dot: 'bg-sky-500 animate-pulse' },
  syncing: { label: 'QR escaneado · sincronizando…', cls: 'bg-sky-100 text-sky-700', dot: 'bg-sky-500 animate-pulse' },
  auth_failure: { label: 'Falló la conexión', cls: 'bg-red-100 text-red-700', dot: 'bg-red-500' },
  disconnected: { label: 'Desconectado', cls: 'bg-slate-100 text-slate-500', dot: 'bg-slate-400' },
};

const fmtDateTime = (d) =>
  d
    ? new Date(d).toLocaleString('es-EC', {
        timeZone: 'America/Guayaquil',
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';

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
  const [marketingDraft, setMarketingDraft] = useState({ enabled: false, accessToken: '' });
  const [savingApp, setSavingApp] = useState(false);
  const [testingCapi, setTestingCapi] = useState(false);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [addModal, setAddModal] = useState(null);
  const [editModal, setEditModal] = useState(null);
  const [qrModal, setQrModal] = useState(null); // { accountId, label, qr, status, percent, error }
  const [diagModal, setDiagModal] = useState(null); // { label, loading, ok, checks }
  const { connected: liveConnected } = useSocket();

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
      setMarketingDraft({
        enabled: Boolean(a.data?.marketingApi?.enabled),
        accessToken: '',
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

  // Recarga silenciosa de la lista. El backend reconcilia el estado real de las
  // sesiones QR al listar, así que esto también detecta "desvinculé desde el
  // celular" aunque no haya llegado ningún evento por socket.
  const refreshAccounts = async () => {
    try {
      const r = await api.get('/call-center-config/whatsapp/accounts');
      const list = r.data || [];
      setAccounts(list);
      setQrModal((m) => {
        if (!m) return m;
        const acc = list.find((x) => String(x._id) === String(m.accountId));
        if (acc && (acc.liveStatus || acc.status) === 'connected') {
          toast.success(`"${acc.label}" conectado`, { id: `wa-conn-${m.accountId}` });
          return null;
        }
        return m;
      });
    } catch {
      /* silencioso: es un respaldo */
    }
  };

  const manualRefresh = async () => {
    setRefreshing(true);
    await refreshAccounts();
    setRefreshing(false);
  };

  // Respaldo por sondeo: si el socket se cae o se pierde un evento, la página
  // igual se entera (cada 20 s y al volver a la pestaña).
  useEffect(() => {
    const t = setInterval(refreshAccounts, 20000);
    const onFocus = () => refreshAccounts();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Al (re)conectar el socket pudo perderse algún evento: sincronizar la lista.
  useEffect(() => {
    if (liveConnected) refreshAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveConnected]);

  // Mientras el modal de conexión está abierto, sondear el estado + QR por HTTP
  // (al abrir y cada 4 s). Así el QR aparece y el "Conectado" llega aunque el
  // socket falle, y "Ver progreso" muestra el QR vigente sin reiniciar nada.
  useEffect(() => {
    const id = qrModal?.accountId;
    if (!id) return undefined;
    let alive = true;
    const tick = async () => {
      try {
        const r = await api.get(`/call-center-config/whatsapp/accounts/${id}/qr`);
        if (!alive) return;
        const { status, qr, percent } = r.data || {};
        if (status === 'connected') {
          toast.success('Número conectado', { id: `wa-conn-${id}` });
          setQrModal((m) => (m && String(m.accountId) === String(id) ? null : m));
          refreshAccounts();
          return;
        }
        setQrModal((m) => {
          if (!m || String(m.accountId) !== String(id)) return m;
          const next = status || m.status;
          // Mientras el arranque está en vuelo, no degradar a estados viejos.
          if (m.starting && (next === 'disconnected' || next === 'auth_failure')) {
            return { ...m, qr: qr || m.qr, percent: percent ?? m.percent };
          }
          return { ...m, status: next, qr: qr || m.qr, percent: percent ?? m.percent };
        });
      } catch {
        /* silencioso: es un respaldo */
      }
    };
    tick();
    const t = setInterval(tick, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qrModal?.accountId]);

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
          ? {
              ...x,
              status: p.status,
              liveStatus: p.status,
              connectedPhone: p.connectedPhone || x.connectedPhone,
              lastConnectedAt: p.status === 'connected' ? new Date().toISOString() : x.lastConnectedAt,
            }
          : x
      )
    );
    if (p.status === 'connected') {
      toast.success(`Número conectado${p.connectedPhone ? ` (+${p.connectedPhone})` : ''}`, {
        id: `wa-conn-${p.accountId}`,
      });
      setQrModal((m) => (m && String(m.accountId) === String(p.accountId) ? null : m));
      return;
    }
    // Sesión cerrada con motivo (p.ej. desvinculada desde el teléfono): avisar.
    if (p.status === 'disconnected' && p.error) {
      toast.error(p.error, { id: `wa-disc-${p.accountId}` });
    }
    setQrModal((m) => {
      if (!m || String(m.accountId) !== String(p.accountId)) return m;
      // Si falló, se limpia el QR viejo y se muestra el motivo.
      return {
        ...m,
        status: p.status,
        percent: p.percent ?? m.percent,
        error: p.error || '',
        qr: p.status === 'auth_failure' ? '' : m.qr,
      };
    });
  });

  const saveApp = async () => {
    setSavingApp(true);
    try {
      const payload = {
        capiEnabled: capiDraft.enabled,
        capiDatasetId: capiDraft.datasetId,
        capiTestEventCode: capiDraft.testEventCode,
        marketingEnabled: marketingDraft.enabled,
      };
      if (appDraft.appSecret) payload.appSecret = appDraft.appSecret;
      if (appDraft.verifyToken) payload.verifyToken = appDraft.verifyToken;
      if (capiDraft.accessToken) payload.capiAccessToken = capiDraft.accessToken;
      if (marketingDraft.accessToken) payload.marketingAccessToken = marketingDraft.accessToken;
      const r = await api.put('/call-center-config/whatsapp/app-config', payload);
      setAppCfg(r.data);
      setAppDraft({ appSecret: '', verifyToken: '' });
      setCapiDraft({
        enabled: Boolean(r.data?.conversionsApi?.enabled),
        datasetId: r.data?.conversionsApi?.datasetId || '',
        accessToken: '',
        testEventCode: r.data?.conversionsApi?.testEventCode || '',
      });
      setMarketingDraft({
        enabled: Boolean(r.data?.marketingApi?.enabled),
        accessToken: '',
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
    // starting=true: mientras el POST /connect está en vuelo, el sondeo no debe
    // pisar el modal con el estado viejo de la BD (aún no existe el cliente).
    setQrModal({ accountId: acc._id, label: acc.label, qr: '', status: 'connecting', starting: true });
    try {
      await api.post(`/call-center-config/whatsapp/accounts/${acc._id}/connect`);
      setQrModal((m) => (m && String(m.accountId) === String(acc._id) ? { ...m, starting: false } : m));
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

  // Diagnóstico completo del número Cloud API: token vigente, permisos, WABA
  // asignada, acceso al número y (opcional) un envío real de prueba que
  // reproduce el error exacto de Meta (#200, ventana 24h, lista de prueba…).
  const testAccount = async (acc, to = '') => {
    setDiagModal((m) => ({ ...(m || {}), accId: acc._id, label: acc.label, loading: true, checks: m?.checks || [], testTo: to || m?.testTo || '' }));
    try {
      const r = await api.post(`/call-center-config/whatsapp/accounts/${acc._id}/test`, to ? { to } : {});
      setDiagModal((m) => ({ ...(m || {}), accId: acc._id, label: acc.label, loading: false, ok: r.data?.ok, checks: r.data?.checks || [] }));
    } catch (err) {
      setDiagModal((m) => ({
        ...(m || {}),
        accId: acc._id,
        label: acc.label,
        loading: false,
        ok: false,
        checks: [{ ok: false, label: 'Diagnóstico', detail: err.response?.data?.message || 'Error de conexión', fix: '' }],
      }));
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
        {/* Marketing API: token para añadir/quitar contactos de Públicos Personalizados */}
        <div className="border-t border-slate-100 pt-3 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <h3 className="text-sm font-semibold text-slate-800">Marketing API (Públicos Personalizados)</h3>
              <p className="text-xs text-slate-500">
                Permite que las automatizaciones <b>añadan o quiten contactos de un Público Personalizado</b> de
                Facebook (retargeting). Necesita un token de <b>Usuario del Sistema</b> con permiso <code>ads_management</code>.
                El ID de cada público se pone en el propio nodo del flujo.
              </p>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
              <input
                type="checkbox"
                checked={marketingDraft.enabled}
                onChange={(e) => setMarketingDraft({ ...marketingDraft, enabled: e.target.checked })}
                className="w-4 h-4 accent-emerald-600"
              />
              Habilitada
            </label>
          </div>
          <label className="block text-sm max-w-md">
            <span className="text-slate-700 font-medium">Access Token (ads_management)</span>
            <input
              type="password"
              value={marketingDraft.accessToken}
              onChange={(e) => setMarketingDraft({ ...marketingDraft, accessToken: e.target.value })}
              placeholder={appCfg?.marketingApi?.accessToken || '••••••'}
              autoComplete="off"
              className="block w-full mt-1 border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm font-mono"
            />
            <span className="text-[11px] text-slate-400">
              Business Manager → Configuración → Usuarios del sistema → Generar token con <code>ads_management</code>.
            </span>
          </label>
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
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={`text-[11px] inline-flex items-center gap-1.5 px-2 py-1 rounded-full ${
                liveConnected ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
              }`}
              title={
                liveConnected
                  ? 'Los cambios de estado de los números se reflejan al instante.'
                  : 'Sin conexión en tiempo real: la lista se actualiza sola cada 20 segundos, o al pulsar Actualizar.'
              }
            >
              <span className={`w-1.5 h-1.5 rounded-full ${liveConnected ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse'}`} />
              {liveConnected ? 'Actualización en vivo' : 'Sin tiempo real · refresco cada 20 s'}
            </span>
            <button
              onClick={manualRefresh}
              disabled={refreshing}
              title="Verificar ahora el estado real de los números"
              className="px-3 py-2 border border-slate-200 rounded-lg text-sm text-slate-600 bg-white flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              <HiOutlineArrowPath className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
              Actualizar
            </button>
            <button
              onClick={() => setAddModal(blankAccount())}
              className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm flex items-center gap-1 cursor-pointer border-none"
            >
              <HiOutlinePlus /> Agregar número
            </button>
          </div>
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
                onShowProgress={() =>
                  setQrModal({ accountId: acc._id, label: acc.label, qr: '', status: acc.liveStatus || acc.status })
                }
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
            <li>
              Si desvinculas el dispositivo desde el teléfono, el sistema lo detecta solo (puede tardar
              hasta ~1 minuto) y el número pasará a "Desconectado".
            </li>
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
          <div className="space-y-3">
            {/* Instrucciones paso a paso (solo mientras hay algo que escanear) */}
            {qrModal.status !== 'syncing' && qrModal.status !== 'auth_failure' && (
              <ol className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-xl p-3 space-y-1.5">
                <li className="flex gap-2">
                  <b className="text-emerald-600">1.</b>
                  <span>Abre <b>WhatsApp</b> en el teléfono del número que quieres conectar.</span>
                </li>
                <li className="flex gap-2">
                  <b className="text-emerald-600">2.</b>
                  <span>Ve a <b>Ajustes → Dispositivos vinculados → Vincular un dispositivo</b>.</span>
                </li>
                <li className="flex gap-2">
                  <b className="text-emerald-600">3.</b>
                  <span>Apunta la cámara a este código.</span>
                </li>
              </ol>
            )}

            <div className="flex items-center justify-center min-h-[240px] text-center">
              {qrModal.status === 'syncing' ? (
                <div className="space-y-3">
                  <div className="w-12 h-12 mx-auto rounded-full border-4 border-emerald-100 border-t-emerald-600 animate-spin" />
                  <p className="text-sm font-semibold text-emerald-700">¡Código escaneado!</p>
                  <p className="text-xs text-slate-500 max-w-[240px] mx-auto">
                    WhatsApp está sincronizando la sesión
                    {typeof qrModal.percent === 'number' ? ` (${qrModal.percent}%)` : ''}. Puede tardar
                    hasta un minuto; te avisaremos aquí cuando quede conectado.
                  </p>
                </div>
              ) : qrModal.status === 'auth_failure' ? (
                <div className="space-y-2">
                  <HiOutlineExclamationTriangle className="w-10 h-10 mx-auto text-red-400" />
                  <p className="text-sm font-semibold text-red-600">No se pudo conectar</p>
                  <p className="text-xs text-slate-500 max-w-[260px] mx-auto">
                    {qrModal.error || 'La vinculación falló o expiró. Pulsa "Reintentar" para generar un código nuevo.'}
                  </p>
                </div>
              ) : qrModal.qr ? (
                <div className="space-y-2">
                  <img src={qrModal.qr} alt="Código QR" className="w-56 h-56 mx-auto border border-slate-100 rounded-xl" />
                  <p className="text-[11px] text-slate-400 flex items-center justify-center gap-1">
                    <HiOutlineDevicePhoneMobile className="w-3.5 h-3.5" />
                    El código se renueva solo cada ~30 s; no hace falta recargar.
                  </p>
                </div>
              ) : (
                <div className="text-slate-400 text-sm flex flex-col items-center gap-2">
                  <HiOutlineQrCode className="w-10 h-10 animate-pulse" />
                  <span>Preparando la sesión de WhatsApp…</span>
                  <span className="text-[11px] text-slate-300">Suele tardar 10–30 segundos.</span>
                </div>
              )}
            </div>

            <div className="text-xs text-center">
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full ${
                  (QR_STATUS_META[qrModal.status] || QR_STATUS_META.connecting).cls
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${(QR_STATUS_META[qrModal.status] || QR_STATUS_META.connecting).dot}`}
                />
                {(QR_STATUS_META[qrModal.status] || QR_STATUS_META.connecting).label}
              </span>
            </div>
            {qrModal.error && qrModal.status !== 'auth_failure' && (
              <p className="text-xs text-red-600 text-center">{qrModal.error}</p>
            )}
            <p className="text-[11px] text-slate-400 text-center">
              Puedes cerrar esta ventana: la conexión sigue en el servidor y el estado se verá en la
              lista de números.
            </p>
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

      {/* Modal: diagnóstico Cloud API (token, permisos, WABA, número) */}
      <Modal isOpen={!!diagModal} onClose={() => setDiagModal(null)} title={`Diagnóstico — ${diagModal?.label || ''}`} size="md">
        {diagModal && (
          <div className="space-y-3">
            {diagModal.loading ? (
              <p className="text-sm text-slate-500 text-center py-6">Consultando a Meta…</p>
            ) : (
              <>
                <p className={`text-sm font-semibold ${diagModal.ok ? 'text-emerald-700' : 'text-rose-700'}`}>
                  {diagModal.ok
                    ? '✓ Todo en orden: este número puede enviar mensajes.'
                    : '✗ Se encontraron problemas. Corrige lo marcado en rojo:'}
                </p>
                <div className="grid gap-2">
                  {diagModal.checks.map((c, i) => (
                    <div key={i} className={`rounded-xl border px-3 py-2.5 ${c.ok ? 'border-slate-200 bg-white' : 'border-rose-200 bg-rose-50/60'}`}>
                      <div className="flex items-start gap-2">
                        <span className={`mt-0.5 ${c.ok ? 'text-emerald-500' : 'text-rose-500'}`}>{c.ok ? '✓' : '✗'}</span>
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-slate-700">{c.label}</div>
                          {c.detail && <div className="text-xs text-slate-500 mt-0.5">{c.detail}</div>}
                          {!c.ok && c.fix && (
                            <div className="text-xs text-rose-700 mt-1.5 bg-white border border-rose-200 rounded-lg px-2 py-1.5">
                              <b>Cómo corregirlo:</b> {c.fix}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                <p className="text-[11px] text-slate-400">
                  El error de Meta “(#200) You do not have the necessary permissions…” aparece cuando el token
                  no tiene el permiso de mensajería o no tiene asignada esta cuenta de WhatsApp Business (WABA).
                </p>
                <div className="border-t border-slate-100 pt-3">
                  <label className="text-xs font-semibold text-slate-600 block mb-1">
                    Prueba de envío REAL (reproduce el error exacto de Meta)
                  </label>
                  <div className="flex gap-2">
                    <input
                      value={diagModal.testTo || ''}
                      onChange={(e) => setDiagModal({ ...diagModal, testTo: e.target.value })}
                      placeholder="5939XXXXXXXX (con código de país)"
                      className="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono"
                    />
                    <button
                      onClick={() => diagModal.testTo && testAccount({ _id: diagModal.accId, label: diagModal.label }, diagModal.testTo)}
                      disabled={!diagModal.testTo}
                      className="px-3 py-2 bg-emerald-600 text-white rounded-lg text-sm cursor-pointer border-none disabled:opacity-50"
                    >
                      Enviar prueba
                    </button>
                  </div>
                  <p className="text-[10px] text-slate-400 mt-1">
                    Ideal: un teléfono que ya le haya escrito a este número (así la ventana de 24h no interfiere).
                  </p>
                </div>
              </>
            )}
            <div className="flex justify-end">
              <button onClick={() => setDiagModal(null)} className="px-4 py-2 border border-slate-200 rounded-lg text-sm bg-white cursor-pointer">
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

function AccountCard({ acc, onSetDefault, onToggleEnabled, onEdit, onDelete, onConnect, onShowProgress, onDisconnect, onTest, onRefreshQuality }) {
  const isQr = acc.connectionType === 'qr';
  const status = acc.liveStatus || acc.status;
  const inProgress = isQr && ['connecting', 'qr_pending', 'syncing'].includes(status);
  const phone = acc.connectedPhone ? `+${acc.connectedPhone}` : acc.displayPhone || acc.phoneNumberId || '—';
  // Insignia de estado de CONEXIÓN (solo QR; en Cloud API el interruptor
  // "Activo" ya lo dice y la insignia duplicada confundía).
  const badge = isQr ? QR_STATUS_META[status] || QR_STATUS_META.disconnected : null;
  const quality = !isQr ? QUALITY_META[acc.qualityRating] : null;
  // Detalle humano de la conexión QR: desde cuándo está vinculado, o cuándo se
  // vio por última vez (ayuda a notar que se desconectó desde el teléfono).
  const qrDetail = !isQr
    ? ''
    : status === 'connected' && acc.lastConnectedAt
    ? `Vinculado desde ${fmtDateTime(acc.lastConnectedAt)}`
    : status === 'disconnected' && acc.lastConnectedAt
    ? `Última conexión: ${fmtDateTime(acc.lastConnectedAt)} · pulsa "Conectar" y escanea el QR`
    : status === 'disconnected'
    ? 'Nunca se ha vinculado · pulsa "Conectar" y escanea el QR'
    : '';

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
        title={isQr ? 'Sesión tipo WhatsApp Web (no oficial)' : 'API oficial de Meta'}
      >
        {isQr ? <HiOutlineQrCode className="w-3.5 h-3.5" /> : <HiOutlineCloud className="w-3.5 h-3.5" />}
        {isQr ? 'QR' : 'Cloud API'}
      </span>
      <div className="flex-1 min-w-[160px]">
        <div className="font-semibold text-slate-800 text-sm">{acc.label}</div>
        <div className="text-xs text-slate-400">{phone}</div>
        {qrDetail && <div className="text-[11px] text-slate-400 mt-0.5">{qrDetail}</div>}
      </div>
      {badge && (
        <span className={`inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-full ${badge.cls}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${badge.dot}`} />
          {badge.label}
        </span>
      )}
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

      <div className="flex items-center gap-1.5 text-xs">
        <Toggle
          checked={!!acc.enabled}
          onChange={onToggleEnabled}
          title={
            acc.enabled
              ? 'Este número recibe y envía mensajes. Clic para desactivarlo.'
              : 'Número desactivado: no se usa para enviar ni recibir. Clic para activarlo.'
          }
        />
        <span className={acc.enabled ? 'text-emerald-700 font-medium' : 'text-slate-400'}>
          {acc.enabled ? 'Activo' : 'Inactivo'}
        </span>
      </div>

      <div className="flex items-center gap-1">
        {isQr ? (
          status === 'connected' ? (
            <button onClick={onDisconnect} className="px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg bg-white cursor-pointer">
              Desconectar
            </button>
          ) : inProgress ? (
            // Hay una conexión en curso: abrir el modal SIN reiniciar la sesión
            // (reconectar aquí destruiría el cliente que ya está sincronizando).
            <button
              onClick={onShowProgress}
              className="px-2.5 py-1.5 text-xs bg-sky-600 text-white rounded-lg cursor-pointer border-none"
            >
              Ver progreso
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
