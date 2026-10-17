import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { HiOutlineArrowPath, HiOutlineTrash, HiOutlineExclamationTriangle, HiOutlineKey } from 'react-icons/hi2';
import api from '../../api/axios';
import Modal from '../Modal';
import NetworkIcon from './NetworkIcon';
import { fmtDateTime } from '../../utils/date';
import { NETWORK_LABELS } from '../../utils/socialRules';

/**
 * Cuentas conectadas para publicar. La conexión abre la pantalla de permisos
 * de cada red en una VENTANA EMERGENTE; al terminar, el servidor responde una
 * página que avisa aquí por postMessage (ver server/utils/social/oauth).
 *
 * La ventana se abre ANTES de pedir la URL al servidor: abrirla después de un
 * `await` la bloquean los navegadores (ya no cuenta como clic del usuario).
 */
function openOAuthPopup() {
  const w = 600;
  const h = 760;
  const left = window.screenX + Math.max(0, (window.outerWidth - w) / 2);
  const top = window.screenY + Math.max(0, (window.outerHeight - h) / 2);
  return window.open('about:blank', 'social-oauth', `width=${w},height=${h},left=${left},top=${top}`);
}

const CONNECT = [
  { network: 'meta', label: 'Facebook e Instagram', icons: ['facebook', 'instagram'], cfgKey: 'meta' },
  { network: 'tiktok', label: 'TikTok', icons: ['tiktok'], cfgKey: 'tiktok' },
  { network: 'youtube', label: 'YouTube', icons: ['youtube'], cfgKey: 'google' },
];

export default function SocialAccountsPanel({ accounts, config, onChanged }) {
  const [pagesOpen, setPagesOpen] = useState(false);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [busy, setBusy] = useState(null);

  useEffect(() => {
    const onMsg = (e) => {
      const d = e.data;
      if (!d || d.type !== 'social-oauth') return;
      if (!d.ok) {
        toast.error(d.message || 'No se pudo conectar', { duration: 8000 });
        return;
      }
      if (d.network === 'meta') setPagesOpen(true);
      else toast.success(d.message || 'Cuenta conectada');
      onChanged?.();
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [onChanged]);

  const connect = async (network) => {
    const popup = openOAuthPopup();
    try {
      const { data } = await api.get(`/social/oauth/${network}/url`);
      if (popup) popup.location.href = data.url;
      else window.location.href = data.url;
    } catch (e) {
      popup?.close();
      toast.error(e.response?.data?.message || 'No se pudo iniciar la conexión', { duration: 8000 });
    }
  };

  const check = async (a) => {
    setBusy(a._id);
    try {
      const { data } = await api.post(`/social/accounts/${a._id}/check`);
      if (data.status === 'connected') toast.success('Conexión correcta');
      else toast.error(data.lastError || 'La conexión falló', { duration: 8000 });
      onChanged?.();
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudo verificar');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (a) => {
    if (!window.confirm(`¿Quitar ${a.name || a.username}? Las publicaciones programadas en esta cuenta fallarán en ese destino.`)) return;
    try {
      const { data } = await api.delete(`/social/accounts/${a._id}`);
      toast.success(data.message || 'Cuenta quitada');
      onChanged?.();
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudo quitar');
    }
  };

  const configured = (key) => Boolean(config?.[key]?.[key === 'meta' ? 'appId' : key === 'tiktok' ? 'clientKey' : 'clientId'] && config?.[key]?.hasSecret);

  return (
    <div className="space-y-4">
      <div className="grid md:grid-cols-3 gap-3">
        {CONNECT.map((c) => {
          const ok = configured(c.cfgKey);
          return (
            <div key={c.network} className="card p-4 flex flex-col gap-2">
              <div className="flex items-center gap-2">
                {c.icons.map((n) => <NetworkIcon key={n} network={n} className="w-5 h-5" />)}
                <span className="font-semibold text-slate-800 text-sm">{c.label}</span>
              </div>
              {ok ? (
                <button type="button" onClick={() => connect(c.network)} className="btn-primary !py-2 !text-xs">Conectar cuenta</button>
              ) : (
                <p className="text-xs text-slate-500">Falta configurar la app de {c.label} en la pestaña <b>Configuración</b>.</p>
              )}
              {c.network === 'meta' && (
                <div className="flex flex-wrap gap-1">
                  <button type="button" onClick={() => setTokenOpen(true)} className="btn-ghost !px-2 !py-1 !text-xs"><HiOutlineKey className="w-4 h-4" /> Usar token de usuario del sistema</button>
                  {config?.metaPending && (
                    <button type="button" onClick={() => setPagesOpen(true)} className="btn-ghost !px-2 !py-1 !text-xs">Elegir páginas pendientes</button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="card overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100 text-sm font-semibold text-slate-700">Cuentas conectadas</div>
        {(accounts || []).length === 0 ? (
          <p className="text-sm text-slate-400 text-center py-10">Todavía no hay cuentas conectadas.</p>
        ) : (
          <ul className="divide-y divide-slate-100 list-none p-0 m-0">
            {accounts.map((a) => (
              <li key={a._id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                {a.avatarUrl ? <img src={a.avatarUrl} alt="" className="w-9 h-9 rounded-full object-cover" /> : <div className="w-9 h-9 rounded-full bg-slate-100" />}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <NetworkIcon network={a.network} />
                    <span className="text-sm font-medium text-slate-800 truncate">{a.name || a.username}</span>
                    {a.username && <span className="text-xs text-slate-400">@{a.username}</span>}
                  </div>
                  <p className="text-[11px] text-slate-400">
                    {NETWORK_LABELS[a.network]} · {a.connectedVia === 'token' ? 'token del sistema' : 'conectada con su cuenta'}
                    {a.lastCheckedAt ? ` · verificada ${fmtDateTime(a.lastCheckedAt)}` : ''}
                    {a.refreshExpiresAt ? ` · renovar antes del ${fmtDateTime(a.refreshExpiresAt).slice(0, 10)}` : ''}
                  </p>
                  {a.status === 'error' && (
                    <p className="text-xs text-rose-600 flex items-start gap-1 mt-0.5"><HiOutlineExclamationTriangle className="w-4 h-4 shrink-0" /> {a.lastError || 'La conexión falló'} — vuelve a conectarla.</p>
                  )}
                </div>
                <span className={`badge ${a.status === 'connected' ? 'badge-success' : 'badge-danger'}`}>{a.status === 'connected' ? 'Conectada' : 'Con error'}</span>
                <button type="button" onClick={() => check(a)} disabled={busy === a._id} className="btn-ghost !p-2" title="Verificar conexión"><HiOutlineArrowPath className={`w-4 h-4 ${busy === a._id ? 'animate-spin' : ''}`} /></button>
                <button type="button" onClick={() => remove(a)} className="btn-ghost !p-2 hover:!text-rose-600" title="Quitar"><HiOutlineTrash className="w-4 h-4" /></button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <MetaPagesModal isOpen={pagesOpen} onClose={() => setPagesOpen(false)} onDone={() => { setPagesOpen(false); onChanged?.(); }} />
      <MetaTokenModal isOpen={tokenOpen} onClose={() => setTokenOpen(false)} onDone={() => { setTokenOpen(false); setPagesOpen(true); onChanged?.(); }} />
    </div>
  );
}

function MetaPagesModal({ isOpen, onClose, onDone }) {
  const [pages, setPages] = useState(null);
  const [fb, setFb] = useState({});
  const [ig, setIg] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setPages(null);
    api
      .get('/social/meta/pages')
      .then(({ data }) => {
        setPages(data);
        // Se proponen marcadas las que aún no están conectadas.
        setFb(Object.fromEntries(data.map((p) => [p.id, !p.connected])));
        setIg(Object.fromEntries(data.filter((p) => p.instagram).map((p) => [p.instagram.id, !p.instagram.connected])));
      })
      .catch((e) => {
        toast.error(e.response?.data?.message || 'No se pudieron leer las páginas', { duration: 8000 });
        onClose();
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const save = async () => {
    setSaving(true);
    try {
      const { data } = await api.post('/social/meta/accounts', {
        facebook: Object.keys(fb).filter((k) => fb[k]),
        instagram: Object.keys(ig).filter((k) => ig[k]),
      });
      toast.success(`${data.added} cuenta(s) agregada(s)`);
      onDone();
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudieron agregar', { duration: 8000 });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Elegir páginas e Instagram" size="lg">
      {!pages ? (
        <p className="text-sm text-slate-400 text-center py-8">Leyendo las páginas…</p>
      ) : pages.length === 0 ? (
        <p className="text-sm text-slate-500">La cuenta autorizada no administra ninguna página.</p>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-slate-500">
            Instagram se publica a través de la Página de Facebook a la que está vinculado. Si una cuenta de Instagram no aparece,
            vincúlala a la Página desde la configuración de Instagram (cuenta profesional).
          </p>
          {pages.map((p) => (
            <div key={p.id} className="border border-slate-200 rounded-xl p-3">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={Boolean(fb[p.id])} onChange={(e) => setFb({ ...fb, [p.id]: e.target.checked })} />
                <NetworkIcon network="facebook" />
                <span className="font-medium">{p.name}</span>
                {p.connected && <span className="badge badge-success">ya conectada</span>}
              </label>
              {p.instagram ? (
                <label className="flex items-center gap-2 text-sm mt-2 pl-6">
                  <input type="checkbox" checked={Boolean(ig[p.instagram.id])} onChange={(e) => setIg({ ...ig, [p.instagram.id]: e.target.checked })} />
                  <NetworkIcon network="instagram" />
                  <span>@{p.instagram.username || p.instagram.name}</span>
                  {p.instagram.connected && <span className="badge badge-success">ya conectada</span>}
                </label>
              ) : (
                <p className="text-[11px] text-slate-400 mt-1 pl-6">Sin Instagram profesional vinculado.</p>
              )}
            </div>
          ))}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="btn-secondary">Cancelar</button>
            <button type="button" onClick={save} disabled={saving} className="btn-primary">Agregar seleccionadas</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function MetaTokenModal({ isOpen, onClose, onDone }) {
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (isOpen) setToken(''); }, [isOpen]);
  const save = async () => {
    setSaving(true);
    try {
      await api.post('/social/meta/token', { token });
      onDone();
    } catch (e) {
      toast.error(e.response?.data?.message || 'Token no válido', { duration: 8000 });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Token de usuario del sistema (Meta)" size="md">
      <div className="space-y-3 text-sm">
        <p className="text-xs text-slate-500">
          Business Manager → Configuración del negocio → Usuarios del sistema → Generar token (caducidad «Nunca») con los permisos
          <code className="mx-1">pages_show_list</code>, <code>pages_read_engagement</code>, <code>pages_manage_posts</code>,
          <code className="mx-1">instagram_basic</code>, <code>instagram_content_publish</code>, <code>business_management</code> y <code>ads_read</code>
          (y para el primer comentario <code>pages_manage_engagement</code> e <code>instagram_manage_comments</code>). El usuario del sistema debe tener
          asignadas las Páginas y las cuentas de Instagram.
        </p>
        <textarea className="input min-h-[90px] font-mono text-xs" value={token} onChange={(e) => setToken(e.target.value)} placeholder="EAAG…" />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancelar</button>
          <button type="button" onClick={save} disabled={saving || !token.trim()} className="btn-primary">Continuar</button>
        </div>
      </div>
    </Modal>
  );
}
