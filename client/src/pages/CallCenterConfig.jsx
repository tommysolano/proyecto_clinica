import { useEffect, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
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
  HiOutlineUsers,
  HiOutlineClock,
  HiOutlineEye,
  HiOutlineEyeSlash,
  HiOutlineClipboardDocument,
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
  const [section, setSection] = useState('system');
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
          <span className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-600 text-white shadow-md">
            <HiOutlineCog6Tooth className="w-5 h-5" />
          </span>
          Configuración del Call Center
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Administra las conexiones del sistema y los turnos del equipo desde un solo lugar.
        </p>
      </div>

      <div className="grid sm:grid-cols-2 gap-3 max-w-4xl">
        {[
          {
            key: 'system',
            title: 'Sistema e integraciones',
            description: 'WhatsApp, Messenger, Instagram, TikTok, Email e Inteligencia Artificial.',
            icon: HiOutlineCog6Tooth,
          },
          {
            key: 'agents',
            title: 'Usuarios call center',
            description: 'Turnos por asesor para supervisión y tiempo real de primera respuesta.',
            icon: HiOutlineUsers,
          },
        ].map((item) => {
          const Icon = item.icon;
          const active = section === item.key;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => setSection(item.key)}
              className={`text-left rounded-xl border p-4 cursor-pointer transition-colors flex items-start gap-3 ${
                active
                  ? 'border-violet-400 bg-violet-50 ring-1 ring-violet-200'
                  : 'border-slate-200 bg-white hover:border-slate-300'
              }`}
            >
              <span className={`rounded-lg p-2 ${active ? 'bg-violet-600 text-white' : 'bg-slate-100 text-slate-500'}`}>
                <Icon className="w-5 h-5" />
              </span>
              <span>
                <span className={`block font-semibold ${active ? 'text-violet-800' : 'text-slate-800'}`}>{item.title}</span>
                <span className="block text-xs text-slate-500 mt-0.5">{item.description}</span>
              </span>
            </button>
          );
        })}
      </div>

      {section === 'system' ? <SystemIntegrations /> : <AgentSchedules />}
    </div>
  );
}

function SystemIntegrations() {
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
          <h2 className="text-xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
            <span className="inline-flex items-center justify-center w-9 h-9 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-sm">
              <HiOutlineCog6Tooth className="w-4.5 h-4.5" />
            </span>
            Sistema e integraciones
          </h2>
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

// Fecha+hora corta en hora de Ecuador para el panel de diagnóstico.
const fmtHealthTime = (d) =>
  d
    ? new Date(d).toLocaleString('es-EC', {
        timeZone: 'America/Guayaquil',
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';

const HEALTH_DOT = { ok: 'bg-emerald-500', warn: 'bg-amber-500', error: 'bg-rose-500' };

/**
 * Panel de SALUD del canal de WhatsApp. Responde de un vistazo a "¿por qué no se
 * envían los mensajes?": ¿hay más de un backend vivo (duplica envíos y crea
 * "fallidos" falsos)?, ¿los tokens se descifran?, ¿qué causas de fallo hubo hoy?
 */
function HealthPanel({ health, loading, healing, onRefresh, onHeal, accounts = [] }) {
  // A qué número traspasar los chats del número borrado. Por defecto el principal.
  const [healTarget, setHealTarget] = useState('');
  const duplicated = health?.cluster?.duplicated;
  const instances = health?.cluster?.instances || [];
  const anyAccountBad = (health?.accounts || []).some((a) => a.health === 'error');
  const banner = duplicated
    ? { cls: 'bg-rose-50 border-rose-200 text-rose-800', dot: 'bg-rose-500', text: 'Hay MÁS DE UN backend vivo contra la misma base de datos.' }
    : anyAccountBad
      ? { cls: 'bg-amber-50 border-amber-200 text-amber-800', dot: 'bg-amber-500', text: 'Hay números con problemas de envío.' }
      : { cls: 'bg-emerald-50 border-emerald-200 text-emerald-800', dot: 'bg-emerald-500', text: 'El canal de WhatsApp está sano.' };

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-semibold text-slate-800">Diagnóstico de WhatsApp</h2>
          <p className="text-xs text-slate-500">
            Salud del canal: procesos vivos, tokens, sesiones y por qué fallan los envíos.
          </p>
        </div>
        <button
          onClick={onRefresh}
          disabled={loading}
          className="px-3 py-2 border border-slate-200 rounded-lg text-sm text-slate-600 bg-white flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
        >
          <HiOutlineArrowPath className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Volver a analizar
        </button>
      </div>

      {!health ? (
        <div className="text-sm text-slate-400 py-6 text-center">
          {loading ? 'Analizando…' : 'Pulsa "Volver a analizar" para ver el estado del canal.'}
        </div>
      ) : (
        <>
          <div className={`flex items-start gap-2 border rounded-xl px-3 py-2 text-sm ${banner.cls}`}>
            <span className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${banner.dot}`} />
            <div>
              <div className="font-medium">{banner.text}</div>
              {duplicated && (
                <div className="text-xs mt-0.5">
                  Un backend de sobra <b>duplica los envíos</b> y marca mensajes como "no enviado" aunque el otro
                  proceso sí los entregó. Revisa los pm2 de todos los usuarios en el VPS
                  (<code>sudo -iu clinica pm2 ls</code> y <code>sudo pm2 ls</code>) y deja UNO solo.
                </div>
              )}
            </div>
          </div>

          {/* Tiempo real */}
          {health.realtime && (
            <div className="flex items-center gap-2 flex-wrap text-xs border border-slate-100 rounded-lg px-2.5 py-1.5 bg-slate-50/60">
              <span className={`w-1.5 h-1.5 rounded-full ${health.realtime.callcenterSockets > 0 ? 'bg-emerald-500' : 'bg-amber-500'}`} />
              <span className="font-medium text-slate-700">Tiempo real</span>
              <span className="text-slate-500">
                {health.realtime.up ? 'servidor activo' : 'servidor caído'} · {health.realtime.callcenterSockets} agente(s)
                conectados a la bandeja en vivo · {health.realtime.totalSockets} socket(s) en total
              </span>
            </div>
          )}

          {/* Procesos vivos */}
          <div>
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
              Backends vivos ({instances.length})
            </div>
            <div className="grid gap-1.5">
              {instances.map((i) => (
                <div
                  key={i.instanceId}
                  className="flex items-center gap-2 flex-wrap text-xs border border-slate-100 rounded-lg px-2.5 py-1.5 bg-slate-50/60"
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${i.isLeader ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                  <span className="font-medium text-slate-700">{i.host}</span>
                  <span className="text-slate-400">pid {i.pid}</span>
                  {i.isLeader && (
                    <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">líder (ejecuta jobs)</span>
                  )}
                  {i.isMe && <span className="px-1.5 py-0.5 rounded bg-slate-200 text-slate-600">este</span>}
                  <span className="text-slate-400">commit {i.commit || '?'}</span>
                  <span className={i.hasSecretsKey ? 'text-emerald-600' : 'text-rose-600 font-medium'}>
                    SECRETS_KEY {i.hasSecretsKey ? 'ok' : 'FALTA'}
                  </span>
                  <span className={i.jobsEnabled ? 'text-slate-500' : 'text-amber-600'}>
                    jobs {i.jobsEnabled ? 'on' : 'off'}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Números */}
          <div>
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Estado de los números</div>
            <div className="grid gap-1.5">
              {(health.accounts || []).map((a) => (
                <div key={a._id} className="flex items-start gap-2 text-sm border border-slate-100 rounded-lg px-2.5 py-1.5">
                  <span className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${HEALTH_DOT[a.health]}`} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-slate-700">{a.label}</span>
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">
                        {a.connectionType === 'qr' ? 'QR' : 'Cloud API'}
                      </span>
                      {a.isDefault && <span className="text-[11px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600">por defecto</span>}
                      {a.displayPhone && <span className="text-xs text-slate-400">{a.displayPhone}</span>}
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">{a.detail}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Fallidos por causa (24 h) */}
          <div>
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
              Envíos fallidos (últimas 24 h)
            </div>
            {(health.failures || []).length === 0 ? (
              <div className="text-xs text-emerald-600 flex items-center gap-1">
                <HiOutlineCheckCircle className="w-4 h-4" /> Sin fallos en las últimas 24 horas.
              </div>
            ) : (
              <div className="grid gap-1.5">
                {health.failures.map((f) => (
                  <div key={String(f.code)} className="text-xs border border-rose-100 bg-rose-50/40 rounded-lg px-2.5 py-1.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-rose-700">{f.count}×</span>
                      <span className="font-mono text-slate-600">{f.code}</span>
                      <span className="text-slate-400">último: {fmtHealthTime(f.last)}</span>
                    </div>
                    {f.hint && <div className="text-slate-600 mt-0.5">{f.hint}</div>}
                    {!f.hint && f.sample && <div className="text-slate-500 mt-0.5">{f.sample}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Media entrante (fotos, audios y archivos que mandan los pacientes) */}
          {(health.incomingMedia || []).length > 0 && (
            <div>
              <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                Archivos recibidos (últimos 7 días)
              </div>
              <div className="grid gap-1.5">
                {health.incomingMedia.map((m) => (
                  <div
                    key={String(m._id)}
                    className={`text-xs border rounded-lg px-2.5 py-1.5 ${
                      m.hint ? 'border-amber-200 bg-amber-50/50' : 'border-slate-200'
                    }`}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-slate-700">{m.label}</span>
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">
                        {m.connectionType === 'qr' ? 'QR' : 'Cloud API'}
                      </span>
                      <span className="text-slate-500">
                        {m.received} mensajes · <b>{m.ok}</b> de {m.withMedia} archivo(s) descargados
                      </span>
                      {m.last && <span className="text-slate-400">último: {fmtHealthTime(m.last)}</span>}
                    </div>
                    {m.hint && <div className="text-amber-800 mt-0.5">{m.hint}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Chats colgando de un número borrado. NO es cosmético: mientras estén
              así se responden por el número POR DEFECTO, que puede ser otro
              teléfono al que el contacto jamás escribió, y Meta rechaza el texto
              libre con 131047 (el mensaje no le llega al paciente). */}
          {health.orphanLinks > 0 && (
            <div className="border border-red-200 bg-red-50 rounded-xl px-3 py-2 space-y-2">
              <div className="text-xs text-red-800">
                <b>{health.orphanLinks}</b> conversaciones enlazadas a un número <b>ya borrado</b>. Mientras sigan así, sus
                respuestas salen por el número por defecto — uno al que esos contactos no han escrito — y WhatsApp las
                rechaza por “ventana de 24h cerrada”. Elige a qué número pasan (normalmente el mismo teléfono
                reconectado).
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <select
                  value={healTarget}
                  onChange={(e) => setHealTarget(e.target.value)}
                  className="px-2 py-1.5 border border-slate-200 rounded-lg text-xs bg-white cursor-pointer"
                >
                  <option value="">Elige el número que se los queda…</option>
                  {accounts
                    .filter((a) => a.enabled)
                    .map((a) => (
                      <option key={a._id} value={a._id}>
                        Pasar a: {a.label} · {a.displayPhone || a.connectedPhone || (a.connectionType === 'qr' ? 'QR' : 'Cloud API')}
                      </option>
                    ))}
                </select>
                <button
                  onClick={() => onHeal(healTarget)}
                  disabled={healing || !healTarget}
                  className="px-3 py-1.5 bg-red-600 text-white rounded-lg text-xs cursor-pointer border-none disabled:opacity-50"
                >
                  {healing ? 'Reparando…' : 'Traspasar conversaciones'}
                </button>
              </div>
            </div>
          )}

          <div className="text-[11px] text-slate-400 text-right">Analizado: {fmtHealthTime(health.generatedAt)}</div>
        </>
      )}
    </div>
  );
}

function WhatsappNumbersManager() {
  const { hasRole, user } = useAuth();
  const canRevealTokens = Boolean(user?.isSuperAdmin || hasRole('admin'));
  const [appCfg, setAppCfg] = useState(null);
  const [appDraft, setAppDraft] = useState({ appSecret: '', verifyToken: '' });
  const [capiDraft, setCapiDraft] = useState({ enabled: false, datasetId: '', accessToken: '', testEventCode: '', wabaId: '' });
  const [marketingDraft, setMarketingDraft] = useState({ enabled: false, accessToken: '', adAccountId: '' });
  const [savingApp, setSavingApp] = useState(false);
  const [testingCapi, setTestingCapi] = useState(false);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [addModal, setAddModal] = useState(null);
  const [editModal, setEditModal] = useState(null);
  const [qrModal, setQrModal] = useState(null); // { accountId, label, qr, status, percent, error }
  const [diagModal, setDiagModal] = useState(null); // { label, loading, ok, checks }
  const [deleteModal, setDeleteModal] = useState(null); // { acc, replacementId, deleting }
  // Diagnóstico de SALUD del canal (backends vivos, tokens, fallidos, enlaces).
  const [health, setHealth] = useState(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healing, setHealing] = useState(false);
  const { connected: liveConnected } = useSocket();

  const loadHealth = async () => {
    setHealthLoading(true);
    try {
      const r = await api.get('/call-center-config/whatsapp/diagnostics');
      setHealth(r.data);
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo cargar el diagnóstico');
    } finally {
      setHealthLoading(false);
    }
  };

  const healLinks = async (accountId = null) => {
    setHealing(true);
    try {
      const r = await api.post('/call-center-config/whatsapp/diagnostics/heal', { accountId });
      toast.success(`${r.data.healed} chats y ${r.data.messages} mensajes pasados a "${r.data.movedTo}"`);
      loadHealth();
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudieron reparar los enlaces');
    } finally {
      setHealing(false);
    }
  };

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
        wabaId: a.data?.conversionsApi?.whatsappBusinessAccountId || '',
      });
      setMarketingDraft({
        enabled: Boolean(a.data?.marketingApi?.enabled),
        accessToken: '',
        adAccountId: a.data?.marketingApi?.adAccountId || '',
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
    loadHealth();
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
        capiWabaId: capiDraft.wabaId,
        marketingEnabled: marketingDraft.enabled,
      };
      if (appDraft.appSecret) payload.appSecret = appDraft.appSecret;
      if (appDraft.verifyToken) payload.verifyToken = appDraft.verifyToken;
      if (capiDraft.accessToken) payload.capiAccessToken = capiDraft.accessToken;
      if (marketingDraft.accessToken) payload.marketingAccessToken = marketingDraft.accessToken;
      payload.marketingAdAccountId = marketingDraft.adAccountId;
      const r = await api.put('/call-center-config/whatsapp/app-config', payload);
      setAppCfg(r.data);
      setAppDraft({ appSecret: '', verifyToken: '' });
      setCapiDraft({
        enabled: Boolean(r.data?.conversionsApi?.enabled),
        datasetId: r.data?.conversionsApi?.datasetId || '',
        accessToken: '',
        testEventCode: r.data?.conversionsApi?.testEventCode || '',
        wabaId: r.data?.conversionsApi?.whatsappBusinessAccountId || '',
      });
      setMarketingDraft({
        enabled: Boolean(r.data?.marketingApi?.enabled),
        accessToken: '',
        adAccountId: r.data?.marketingApi?.adAccountId || '',
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

  // Borrar un número deja sus conversaciones sin dueño, y eso NO es inocuo: pasan
  // a responderse por el número por defecto, al que esos contactos nunca han
  // escrito, y WhatsApp rechaza el texto libre (131047). Por eso el borrado pasa
  // por un paso en el que se elige quién se queda los chats.
  const removeAccount = (acc) => setDeleteModal({ acc, replacementId: '' });

  const confirmRemoveAccount = async () => {
    const { acc, replacementId } = deleteModal;
    setDeleteModal((m) => ({ ...m, deleting: true }));
    try {
      const r = await api.delete(`/call-center-config/whatsapp/accounts/${acc._id}`, {
        data: replacementId ? { replacementId } : {},
      });
      setAccounts((l) => l.filter((x) => x._id !== acc._id));
      setDeleteModal(null);
      toast.success(
        r.data?.movedTo
          ? `Número eliminado · ${r.data.conversations} chats pasados a "${r.data.movedTo}"`
          : r.data?.orphaned
            ? `Número eliminado · sus ${r.data.orphaned} chats vuelven solos si reconectas este teléfono`
            : 'Número eliminado'
      );
      loadHealth();
    } catch (err) {
      setDeleteModal((m) => ({ ...m, deleting: false }));
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

  // Registra el número en Cloud API (POST /register con PIN de 6 dígitos). Se
  // ofrece cuando el diagnóstico ve el número PENDING/no CONNECTED (típico tras
  // migrarlo de WABA). Al terminar re-corre el diagnóstico para ver el estado.
  const registerNumber = async () => {
    if (!diagModal?.accId) return;
    setDiagModal((m) => ({ ...m, registering: true }));
    try {
      const r = await api.post(`/call-center-config/whatsapp/accounts/${diagModal.accId}/register`, { pin: diagModal.pin });
      toast.success(r.data?.message || 'Número registrado en Cloud API');
      setDiagModal((m) => ({ ...m, registering: false }));
      testAccount({ _id: diagModal.accId, label: diagModal.label });
    } catch (err) {
      toast.error(err.response?.data?.message || 'Meta rechazó el registro');
      setDiagModal((m) => ({ ...m, registering: false }));
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
            <label className="block text-sm">
              <span className="text-slate-700 font-medium">WABA ID (opcional)</span>
              <input
                value={capiDraft.wabaId}
                onChange={(e) => setCapiDraft({ ...capiDraft, wabaId: e.target.value })}
                placeholder="Auto (número Cloud API)"
                className="block w-full mt-1 border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm font-mono"
              />
              <span className="text-[11px] text-slate-400">
                Cuenta de WhatsApp Business. Si lo dejas vacío se toma del número Cloud API por defecto.
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
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block text-sm">
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
            <label className="block text-sm">
              <span className="text-slate-700 font-medium">Cuenta publicitaria (opcional)</span>
              <input
                value={marketingDraft.adAccountId}
                onChange={(e) => setMarketingDraft({ ...marketingDraft, adAccountId: e.target.value })}
                placeholder="act_1234567890"
                className="block w-full mt-1 border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm font-mono"
              />
              <span className="text-[11px] text-slate-400">
                Si lo dejas vacío, se descubren automáticamente las cuentas del token. Útil si el token
                tiene acceso a varias cuentas y quieres una en concreto.
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

      {/* Diagnóstico de salud del canal */}
      <HealthPanel
        health={health}
        loading={healthLoading}
        healing={healing}
        onRefresh={loadHealth}
        onHeal={healLinks}
        accounts={accounts}
      />

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
            canRevealToken={canRevealTokens}
            onCancel={() => setEditModal(null)}
            onSubmit={saveEdit}
            submitLabel="Guardar"
          />
        )}
      </Modal>

      {/* Modal: eliminar número. Lo importante no es el "¿seguro?", es decidir
          quién hereda los chats: sin destino se responden por el número por
          defecto y WhatsApp los rechaza por ventana de 24h. */}
      <Modal isOpen={!!deleteModal} onClose={() => setDeleteModal(null)} title="Eliminar número" size="sm">
        {deleteModal && (
          <div className="space-y-3">
            <p className="text-sm text-slate-700">
              Vas a eliminar <b>{deleteModal.acc.label}</b>
              {deleteModal.acc.displayPhone ? ` (${deleteModal.acc.displayPhone})` : ''}.
            </p>
            <div className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
              Sus conversaciones <b>no se pierden</b>: el número queda guardado con todo su historial. Si más adelante
              vuelves a conectar <b>este mismo teléfono</b> —aunque sea creándolo de nuevo— los chats, el historial y la
              ventana de 24 h vuelven a él solos.
            </div>
            <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              Elige un destino solo si el teléfono <b>no va a volver</b> y quieres que otro número se quede desde ya con
              sus chats. Mientras no vuelva ni se traspase, esas conversaciones solo podrán recibir plantillas (su
              ventana de 24 h es de un número que no está en línea).
            </div>
            <label className="block text-xs font-medium text-slate-600">
              Traspasar las conversaciones a
              <select
                value={deleteModal.replacementId}
                onChange={(e) => setDeleteModal((m) => ({ ...m, replacementId: e.target.value }))}
                className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white cursor-pointer"
              >
                <option value="">Ninguno — el número volverá (recuperará sus chats solo)</option>
                {accounts
                  .filter((a) => a._id !== deleteModal.acc._id && a.enabled)
                  .map((a) => (
                    <option key={a._id} value={a._id}>
                      {a.label} · {a.displayPhone || a.connectedPhone || (a.connectionType === 'qr' ? 'QR' : 'Cloud API')}
                    </option>
                  ))}
              </select>
            </label>
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setDeleteModal(null)}
                className="px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white cursor-pointer"
              >
                Cancelar
              </button>
              <button
                onClick={confirmRemoveAccount}
                disabled={deleteModal.deleting}
                className="px-3 py-2 text-sm bg-red-600 text-white rounded-lg cursor-pointer border-none disabled:opacity-50"
              >
                {deleteModal.deleting ? 'Eliminando…' : 'Eliminar número'}
              </button>
            </div>
          </div>
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
                {diagModal.checks.some((c) => c.label === 'Estado del número en Cloud API' && !c.ok) && (
                  <div className="border-t border-slate-100 pt-3">
                    <label className="text-xs font-semibold text-slate-600 block mb-1">
                      Registrar número en Cloud API
                    </label>
                    <div className="flex gap-2">
                      <input
                        value={diagModal.pin || ''}
                        onChange={(e) => setDiagModal({ ...diagModal, pin: e.target.value.replace(/[^\d]/g, '').slice(0, 6) })}
                        placeholder="Elige un PIN de 6 dígitos"
                        maxLength={6}
                        className="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono"
                      />
                      <button
                        onClick={registerNumber}
                        disabled={!/^\d{6}$/.test(diagModal.pin || '') || diagModal.registering}
                        className="px-3 py-2 bg-emerald-600 text-white rounded-lg text-sm cursor-pointer border-none disabled:opacity-50"
                      >
                        {diagModal.registering ? 'Registrando…' : 'Registrar'}
                      </button>
                    </div>
                    <p className="text-[10px] text-slate-400 mt-1">
                      Este PIN queda como la verificación en dos pasos del número — <b>guárdalo</b>. Si el número
                      ya tenía un PIN activo, escribe ese mismo.
                    </p>
                  </div>
                )}
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

const AGENT_DAY_LABELS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const defaultAgentDays = () => AGENT_DAY_LABELS.map((_, day) => ({
  day,
  enabled: day >= 1 && day <= 5,
  start: '09:00',
  end: '18:00',
  intervals: [{ start: '09:00', end: '18:00' }],
}));

function normalizeAgentSchedule(value = {}) {
  const byDay = new Map((value.days || []).map((day) => [Number(day.day), day]));
  return {
    enabled: value.enabled === true,
    timezone: 'America/Guayaquil',
    days: defaultAgentDays().map((fallback) => {
      const saved = byDay.get(fallback.day) || {};
      const intervals = Array.isArray(saved.intervals) && saved.intervals.length
        ? saved.intervals.map((interval) => ({ start: interval.start, end: interval.end }))
        : [{ start: saved.start || fallback.start, end: saved.end || fallback.end }];
      return {
        ...fallback,
        ...saved,
        day: fallback.day,
        start: intervals[0].start,
        end: intervals[0].end,
        intervals,
      };
    }),
  };
}

function AgentSchedules() {
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState('');
  const [dirty, setDirty] = useState(() => new Set());

  useEffect(() => {
    let alive = true;
    api.get('/call-center-config/agents')
      .then(({ data }) => {
        if (!alive) return;
        setAgents((data || []).map((agent) => ({
          ...agent,
          callCenterSchedule: normalizeAgentSchedule(agent.callCenterSchedule),
        })));
      })
      .catch((err) => toast.error(err.response?.data?.message || 'No se pudieron cargar los asesores'))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, []);

  const updateSchedule = (agentId, updater) => {
    setAgents((current) => current.map((agent) => {
      if (String(agent._id) !== String(agentId)) return agent;
      return { ...agent, callCenterSchedule: updater(agent.callCenterSchedule) };
    }));
    setDirty((current) => new Set(current).add(String(agentId)));
  };

  const updateDay = (agentId, dayNumber, patch) => updateSchedule(agentId, (schedule) => ({
    ...schedule,
    days: schedule.days.map((day) => day.day === dayNumber ? { ...day, ...patch } : day),
  }));

  const updateInterval = (agentId, dayNumber, intervalIndex, patch) => updateSchedule(agentId, (schedule) => ({
    ...schedule,
    days: schedule.days.map((day) => {
      if (day.day !== dayNumber) return day;
      const intervals = day.intervals.map((interval, index) => (
        index === intervalIndex ? { ...interval, ...patch } : interval
      ));
      return { ...day, intervals, start: intervals[0].start, end: intervals[0].end };
    }),
  }));

  const addInterval = (agentId, dayNumber) => updateSchedule(agentId, (schedule) => ({
    ...schedule,
    days: schedule.days.map((day) => day.day === dayNumber
      ? { ...day, intervals: [...day.intervals, { start: '16:00', end: '21:00' }] }
      : day),
  }));

  const removeInterval = (agentId, dayNumber, intervalIndex) => updateSchedule(agentId, (schedule) => ({
    ...schedule,
    days: schedule.days.map((day) => {
      if (day.day !== dayNumber || day.intervals.length <= 1) return day;
      const intervals = day.intervals.filter((_, index) => index !== intervalIndex);
      return { ...day, intervals, start: intervals[0].start, end: intervals[0].end };
    }),
  }));

  const saveAgent = async (agent) => {
    setSavingId(String(agent._id));
    try {
      const { data } = await api.put(`/call-center-config/agents/${agent._id}/schedule`, {
        callCenterSchedule: agent.callCenterSchedule,
      });
      setAgents((current) => current.map((item) => String(item._id) === String(agent._id)
        ? { ...item, ...data, callCenterSchedule: normalizeAgentSchedule(data.callCenterSchedule) }
        : item));
      setDirty((current) => {
        const next = new Set(current);
        next.delete(String(agent._id));
        return next;
      });
      toast.success(`Horario de ${agent.name} guardado`);
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo guardar el horario');
    } finally {
      setSavingId('');
    }
  };

  if (loading) return <div className="text-sm text-slate-500 py-5">Cargando asesores…</div>;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 flex gap-3">
        <HiOutlineClock className="w-5 h-5 text-indigo-600 shrink-0 mt-0.5" />
        <div>
          <h2 className="font-semibold text-indigo-900">Horarios para supervisión</h2>
          <p className="text-xs text-indigo-700 mt-0.5">
            Al activar el horario de un asesor, el panel <b>Tiempo de primera respuesta por agente</b>
            descuenta noches y días libres. Los asesores sin horario configurado se siguen midiendo 24/7.
            Puedes agregar varias franjas en un mismo día, por ejemplo 08:00–12:00 y 16:00–21:00.
            Todas las horas corresponden a Ecuador (America/Guayaquil).
          </p>
        </div>
      </div>

      {agents.map((agent) => {
        const schedule = agent.callCenterSchedule;
        const isDirty = dirty.has(String(agent._id));
        return (
          <section key={agent._id} className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="p-4 flex items-center gap-3 flex-wrap border-b border-slate-100">
              <div className="w-10 h-10 rounded-full bg-violet-100 text-violet-700 flex items-center justify-center font-bold">
                {(agent.name || '?').slice(0, 2).toUpperCase()}
              </div>
              <div className="flex-1 min-w-[180px]">
                <div className="font-semibold text-slate-800">{agent.name}</div>
                <div className="text-xs text-slate-400">{agent.email}</div>
              </div>
              <span className={`text-[11px] px-2 py-1 rounded-full ${
                isDirty
                  ? 'bg-violet-100 text-violet-700'
                  : !schedule.enabled
                  ? 'bg-slate-100 text-slate-500'
                  : agent.inShift
                    ? 'bg-emerald-100 text-emerald-700'
                    : 'bg-amber-100 text-amber-700'
              }`}>
                {isDirty
                  ? 'Cambios sin guardar'
                  : !schedule.enabled
                    ? 'Medición 24/7'
                    : agent.inShift ? 'En turno ahora' : 'Fuera de turno ahora'}
              </span>
              <label className="inline-flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                <Toggle
                  checked={schedule.enabled}
                  onChange={() => updateSchedule(agent._id, (current) => ({ ...current, enabled: !current.enabled }))}
                  title="Aplicar este horario a la medición de primera respuesta"
                />
                Aplicar horario
              </label>
            </div>

            <div className="p-4 grid gap-2">
              <div className="grid grid-cols-[minmax(110px,1fr)_minmax(260px,2fr)] gap-3 px-3 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                <span>Día</span><span>Franjas de trabajo</span>
              </div>
              {schedule.days.map((day) => (
                <div
                  key={day.day}
                  className={`grid grid-cols-1 sm:grid-cols-[minmax(130px,1fr)_minmax(300px,2fr)] items-start gap-2 sm:gap-3 rounded-lg px-3 py-3 ${
                    day.enabled && schedule.enabled ? 'bg-violet-50/60' : 'bg-slate-50'
                  }`}
                >
                  <label className="inline-flex items-center gap-2 text-sm text-slate-700 cursor-pointer min-h-9">
                    <input
                      type="checkbox"
                      checked={day.enabled}
                      disabled={!schedule.enabled}
                      onChange={(e) => updateDay(agent._id, day.day, { enabled: e.target.checked })}
                      className="accent-violet-600"
                    />
                    <span className={day.enabled && schedule.enabled ? 'font-medium' : 'text-slate-400'}>
                      {AGENT_DAY_LABELS[day.day]}
                    </span>
                  </label>
                  <div className="grid gap-2">
                    {day.intervals.map((interval, intervalIndex) => (
                      <div key={intervalIndex} className="flex items-center gap-2 flex-wrap sm:flex-nowrap">
                        <label className="flex items-center gap-1.5 text-[11px] text-slate-500">
                          <span>Inicio</span>
                          <input
                            type="time"
                            value={interval.start}
                            disabled={!schedule.enabled || !day.enabled}
                            onChange={(e) => updateInterval(agent._id, day.day, intervalIndex, { start: e.target.value })}
                            aria-label={`Inicio ${AGENT_DAY_LABELS[day.day]} franja ${intervalIndex + 1}`}
                            className="w-[118px] border border-slate-200 rounded-lg px-2 py-1.5 text-sm text-slate-700 disabled:text-slate-300 disabled:bg-white"
                          />
                        </label>
                        <label className="flex items-center gap-1.5 text-[11px] text-slate-500">
                          <span>Fin</span>
                          <input
                            type="time"
                            value={interval.end}
                            disabled={!schedule.enabled || !day.enabled}
                            onChange={(e) => updateInterval(agent._id, day.day, intervalIndex, { end: e.target.value })}
                            aria-label={`Fin ${AGENT_DAY_LABELS[day.day]} franja ${intervalIndex + 1}`}
                            className="w-[118px] border border-slate-200 rounded-lg px-2 py-1.5 text-sm text-slate-700 disabled:text-slate-300 disabled:bg-white"
                          />
                        </label>
                        <button
                          type="button"
                          onClick={() => removeInterval(agent._id, day.day, intervalIndex)}
                          disabled={!schedule.enabled || !day.enabled || day.intervals.length <= 1}
                          title={day.intervals.length <= 1 ? 'Debe existir al menos una franja' : 'Eliminar franja'}
                          aria-label={`Eliminar franja ${intervalIndex + 1} de ${AGENT_DAY_LABELS[day.day]}`}
                          className="w-8 h-8 inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 hover:text-red-600 hover:border-red-200 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          <HiOutlineTrash className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => addInterval(agent._id, day.day)}
                      disabled={!schedule.enabled || !day.enabled || day.intervals.length >= 12}
                      className="w-fit inline-flex items-center gap-1.5 text-xs font-medium text-violet-700 bg-transparent border-none p-0 cursor-pointer disabled:text-slate-300 disabled:cursor-not-allowed"
                    >
                      <HiOutlinePlus className="w-4 h-4" /> Agregar franja
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="px-4 pb-4 flex justify-end">
              <button
                type="button"
                onClick={() => saveAgent(agent)}
                disabled={!isDirty || savingId === String(agent._id)}
                className="px-4 py-2 rounded-lg bg-violet-600 text-white text-sm border-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {savingId === String(agent._id) ? 'Guardando…' : isDirty ? 'Guardar horario' : 'Horario guardado'}
              </button>
            </div>
          </section>
        );
      })}

      {!agents.length && (
        <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-400">
          No hay usuarios activos con rol call center.
        </div>
      )}
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
  // Una caída que NO exige QR nuevo la resuelve el propio servidor (reintenta
  // solo cada pocos segundos): decirle al usuario "escanea el QR" en ese caso lo
  // mandaba a hacer un trabajo que no hacía falta.
  const seReconectaSolo = status === 'disconnected' && acc.connectedPhone && !acc.lastDisconnectNeedsQr;
  const qrDetail = !isQr
    ? ''
    : status === 'connected'
    ? // "Conectado" NO quiere decir "recibiendo": una sesión puede quedar zombi
      // (envía pero no le entra nada). La hora del último mensaje recibido es lo
      // único que deja verlo de un vistazo.
      [
        acc.lastConnectedAt ? `Vinculado desde ${fmtDateTime(acc.lastConnectedAt)}` : '',
        acc.lastInboundAt
          ? `último mensaje recibido ${fmtDateTime(acc.lastInboundAt)}`
          : 'aún no ha recibido ningún mensaje',
      ]
        .filter(Boolean)
        .join(' · ')
    : seReconectaSolo
    ? `Caído${acc.lastDisconnectAt ? ` desde ${fmtDateTime(acc.lastDisconnectAt)}` : ''} · el servidor lo está reconectando solo${
        acc.lastDisconnectReason ? ` (${acc.lastDisconnectReason})` : ''
      }`
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

function AccountForm({ value, onChange, allowMethod, canRevealToken = false, onCancel, onSubmit, submitLabel }) {
  const set = (patch) => onChange({ ...value, ...patch });
  const isCloud = value.connectionType === 'cloud_api';
  const [revealOpen, setRevealOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [revealedToken, setRevealedToken] = useState('');
  const [showRevealedToken, setShowRevealedToken] = useState(false);
  const [revealingToken, setRevealingToken] = useState(false);

  useEffect(() => {
    if (!revealedToken) return undefined;
    const timeoutId = window.setTimeout(() => {
      setRevealedToken('');
      setShowRevealedToken(false);
      setRevealOpen(false);
    }, 60000);
    return () => window.clearTimeout(timeoutId);
  }, [revealedToken]);

  const closeTokenReveal = () => {
    setRevealOpen(false);
    setCurrentPassword('');
    setRevealedToken('');
    setShowRevealedToken(false);
  };

  const revealToken = async () => {
    if (!currentPassword) {
      toast.error('Ingresa tu contraseña actual');
      return;
    }
    setRevealingToken(true);
    try {
      const response = await api.post(
        `/call-center-config/whatsapp/accounts/${value._id}/reveal-token`,
        { currentPassword }
      );
      const accessToken = response.data?.accessToken || '';
      if (!accessToken) throw new Error('La respuesta no contiene un token');
      setRevealedToken(accessToken);
      setShowRevealedToken(true);
      setCurrentPassword('');
      toast.success('Token mostrado durante 60 segundos');
    } catch (err) {
      toast.error(err.response?.data?.message || err.message || 'No se pudo mostrar el token');
    } finally {
      setRevealingToken(false);
    }
  };

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
          <div className="text-sm">
            <label htmlFor={`whatsapp-access-token-${value._id || 'new'}`} className="text-slate-600">
              Access Token
            </label>
            <input
              id={`whatsapp-access-token-${value._id || 'new'}`}
              type="password"
              autoComplete="off"
              value={value.accessToken}
              onChange={(e) => set({ accessToken: e.target.value })}
              placeholder={value._id ? '•••••• (escribe para reemplazar)' : ''}
              className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono"
            />

            {value._id && canRevealToken && !revealOpen && (
              <button
                type="button"
                onClick={() => setRevealOpen(true)}
                className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-sky-700 bg-transparent border-none p-0 cursor-pointer hover:text-sky-900"
              >
                <HiOutlineEye className="w-4 h-4" /> Mostrar token guardado
              </button>
            )}

            {value._id && canRevealToken && revealOpen && (
              <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
                {!revealedToken ? (
                  <>
                    <p className="text-xs text-amber-900 mb-2">
                      Por seguridad, confirma tu contraseña actual. Esta consulta quedará registrada.
                    </p>
                    <input
                      type="password"
                      autoComplete="current-password"
                      value={currentPassword}
                      onChange={(event) => setCurrentPassword(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !revealingToken) revealToken();
                      }}
                      placeholder="Contraseña actual"
                      className="w-full border border-amber-300 bg-white rounded-lg px-3 py-2 text-sm"
                    />
                    <div className="flex justify-end gap-2 mt-2">
                      <button
                        type="button"
                        onClick={closeTokenReveal}
                        className="px-3 py-1.5 border border-slate-200 rounded-lg text-xs bg-white cursor-pointer"
                      >
                        Cancelar
                      </button>
                      <button
                        type="button"
                        onClick={revealToken}
                        disabled={revealingToken}
                        className="px-3 py-1.5 border-none rounded-lg text-xs text-white bg-sky-600 cursor-pointer disabled:opacity-60"
                      >
                        {revealingToken ? 'Verificando...' : 'Confirmar y mostrar'}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="text-xs text-amber-900 mb-2">
                      El token se ocultará automáticamente en 60 segundos.
                    </p>
                    <div className="flex gap-2">
                      <input
                        readOnly
                        type={showRevealedToken ? 'text' : 'password'}
                        value={revealedToken}
                        aria-label="Token guardado"
                        className="min-w-0 flex-1 border border-amber-300 bg-white rounded-lg px-3 py-2 text-sm font-mono"
                      />
                      <button
                        type="button"
                        onClick={() => setShowRevealedToken((visible) => !visible)}
                        title={showRevealedToken ? 'Ocultar token' : 'Mostrar token'}
                        className="p-2 border border-amber-300 rounded-lg bg-white text-slate-600 cursor-pointer"
                      >
                        {showRevealedToken
                          ? <HiOutlineEyeSlash className="w-5 h-5" />
                          : <HiOutlineEye className="w-5 h-5" />}
                      </button>
                      <button
                        type="button"
                        onClick={() => copyToClipboard(revealedToken)}
                        title="Copiar token"
                        className="inline-flex items-center gap-1.5 px-3 py-2 border border-sky-200 rounded-lg bg-sky-50 text-sky-700 text-xs font-medium cursor-pointer"
                      >
                        <HiOutlineClipboardDocument className="w-4 h-4" /> Copiar
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={closeTokenReveal}
                      className="mt-2 text-xs text-slate-600 bg-transparent border-none p-0 cursor-pointer hover:text-slate-900"
                    >
                      Ocultar ahora
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
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
