import { useState } from 'react';
import toast from 'react-hot-toast';
import { HiOutlineClipboardDocument, HiOutlinePlus, HiOutlineTrash, HiOutlineInformationCircle } from 'react-icons/hi2';
import api from '../../api/axios';
import TagEditor from '../TagEditor';
import NetworkIcon from './NetworkIcon';

const copy = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    toast.success('Copiado');
  } catch {
    toast.error('No se pudo copiar');
  }
};

function RedirectRow({ label, url }) {
  if (!url) return null;
  return (
    <div className="text-xs">
      <span className="lbl">{label}</span>
      <div className="flex items-center gap-2">
        <code className="flex-1 min-w-0 truncate bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5">{url}</code>
        <button type="button" onClick={() => copy(url)} className="btn-ghost !p-1.5" title="Copiar"><HiOutlineClipboardDocument className="w-4 h-4" /></button>
      </div>
    </div>
  );
}

function CredentialsCard({ title, icons, idLabel, idValue, hasSecret, secretLabel, onSave, canEdit, redirect, children }) {
  // Se inicializa una vez: el padre lo remonta (key) cuando cambia lo guardado.
  const [id, setId] = useState(idValue || '');
  const [secret, setSecret] = useState('');
  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center gap-2">
        {icons.map((n) => <NetworkIcon key={n} network={n} className="w-5 h-5" />)}
        <h3 className="text-sm font-bold text-slate-800">{title}</h3>
        <span className={`badge ml-auto ${idValue && hasSecret ? 'badge-success' : 'badge-neutral'}`}>{idValue && hasSecret ? 'Configurada' : 'Sin configurar'}</span>
      </div>
      <label className="block">
        <span className="lbl">{idLabel}</span>
        <input className="input input-sm" value={id} disabled={!canEdit} onChange={(e) => setId(e.target.value)} />
      </label>
      <label className="block">
        <span className="lbl">{secretLabel} {hasSecret && <span className="font-normal text-slate-400">(guardado; escribe uno nuevo solo para cambiarlo)</span>}</span>
        <input className="input input-sm" type="password" autoComplete="new-password" value={secret} disabled={!canEdit} onChange={(e) => setSecret(e.target.value)} placeholder={hasSecret ? '••••••••' : ''} />
      </label>
      {redirect}
      {children}
      {canEdit && (
        <div className="flex justify-end">
          <button type="button" onClick={async () => { await onSave(id, secret); setSecret(''); }} className="btn-primary !py-2 !text-xs">Guardar</button>
        </div>
      )}
    </div>
  );
}

function HashtagGroupsCard({ initial, onChanged }) {
  const [groups, setGroups] = useState(initial || []);

  const saveGroups = async () => {
    try {
      await api.put('/social/config/hashtag-groups', { groups });
      toast.success('Grupos de hashtags guardados');
      onChanged?.();
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudo guardar');
    }
  };

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-slate-800">Grupos de hashtags</h3>
        <button type="button" onClick={() => setGroups([...groups, { name: '', tags: [] }])} className="btn-ghost !py-1 !text-xs"><HiOutlinePlus className="w-4 h-4" /> Nuevo grupo</button>
      </div>
      <p className="text-xs text-slate-500">Conjuntos que se insertan de un clic en el editor (p. ej. «Sueros», «Ginecología», «Marca»).</p>
      {groups.length === 0 && <p className="text-xs text-slate-400">Sin grupos.</p>}
      {groups.map((g, i) => (
        <div key={g._id || i} className="grid sm:grid-cols-[200px_minmax(0,1fr)_auto] gap-2 items-start">
          <input className="input input-sm" value={g.name} placeholder="Nombre del grupo" onChange={(e) => setGroups(groups.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} />
          <TagEditor value={g.tags} onChange={(tags) => setGroups(groups.map((x, k) => (k === i ? { ...x, tags } : x)))} placeholder="Escribe un hashtag y Enter…" />
          <button type="button" onClick={() => setGroups(groups.filter((_, k) => k !== i))} className="btn-ghost !p-2 hover:!text-rose-600" aria-label="Quitar grupo"><HiOutlineTrash className="w-4 h-4" /></button>
        </div>
      ))}
      <div className="flex justify-end">
        <button type="button" onClick={saveGroups} className="btn-primary !py-2 !text-xs">Guardar grupos</button>
      </div>
    </div>
  );
}

export default function SocialSettingsPanel({ config, onChanged }) {
  const canEdit = Boolean(config?.canEdit);

  const saveCreds = (section, idField) => async (id, secret) => {
    try {
      await api.put('/social/config', { [section]: { [idField]: id, ...(secret ? { secret } : {}) } });
      toast.success('Guardado');
      onChanged?.();
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudo guardar');
    }
  };

  const setApproval = async (value) => {
    try {
      await api.put('/social/config', { requireApproval: value });
      toast.success(value ? 'Aprobación activada' : 'Aprobación desactivada');
      onChanged?.();
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudo guardar');
    }
  };

  const r = config?.redirectUris || {};

  return (
    <div className="space-y-4">
      {!config?.publicApiUrl && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">
          Falta <code>PUBLIC_API_URL</code> en el servidor. Sin ella las redes no pueden volver al CRM al conectar ni descargar los medios.
        </div>
      )}

      {/* Grupos de hashtags: los usa todo el equipo. Se remonta al cambiar lo guardado. */}
      <HashtagGroupsCard key={JSON.stringify(config?.hashtagGroups || [])} initial={config?.hashtagGroups} onChanged={onChanged} />

      <div className="card p-4 flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[220px]">
          <h3 className="text-sm font-bold text-slate-800">Aprobación antes de publicar</h3>
          <p className="text-xs text-slate-500">Si está activa, lo que programa alguien que no es administrador queda «en revisión» hasta que un administrador lo apruebe.</p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={Boolean(config?.requireApproval)} disabled={!canEdit} onChange={(e) => setApproval(e.target.checked)} />
          Activa
        </label>
      </div>

      {!canEdit && (
        <p className="text-xs text-slate-500">Las credenciales de las apps solo las cambia un administrador.</p>
      )}

      <div className="grid lg:grid-cols-3 gap-4">
        <CredentialsCard
          key={`meta-${config?.meta?.appId}`}
          title="Meta (Facebook e Instagram)"
          icons={['facebook', 'instagram']}
          idLabel="App ID"
          idValue={config?.meta?.appId}
          hasSecret={config?.meta?.hasSecret}
          secretLabel="App Secret"
          canEdit={canEdit}
          onSave={saveCreds('meta', 'appId')}
          redirect={<RedirectRow label="URI de redirección OAuth válida (Inicio de sesión con Facebook → Configuración)" url={r.meta} />}
        >
          <Help>
            Permisos a pedir en la revisión de la app: <code>pages_show_list</code>, <code>pages_read_engagement</code>, <code>pages_manage_posts</code>,{' '}
            <code>instagram_basic</code>, <code>instagram_content_publish</code>, <code>business_management</code> y <code>ads_read</code> (Instagram lo
            exige si la Página está en Business Manager). Para el primer comentario: <code>pages_manage_engagement</code> e{' '}
            <code>instagram_manage_comments</code>. Puede ser la misma app de WhatsApp.
          </Help>
        </CredentialsCard>
        <CredentialsCard
          key={`tiktok-${config?.tiktok?.clientKey}`}
          title="TikTok"
          icons={['tiktok']}
          idLabel="Client Key"
          idValue={config?.tiktok?.clientKey}
          hasSecret={config?.tiktok?.hasSecret}
          secretLabel="Client Secret"
          canEdit={canEdit}
          onSave={saveCreds('tiktok', 'clientKey')}
          redirect={<RedirectRow label="Redirect URI (Login Kit)" url={r.tiktok} />}
        >
          <Help>
            Productos: <b>Login Kit</b> y <b>Content Posting API</b> (activar «Direct Post»). Scopes: <code>user.info.basic</code>, <code>video.publish</code>,{' '}
            <code>video.upload</code>. Hasta que TikTok audite la app, lo publicado sale <b>privado</b>. Para fotos hay que verificar el dominio de la API.
          </Help>
        </CredentialsCard>
        <CredentialsCard
          key={`google-${config?.google?.clientId}`}
          title="YouTube (Google Cloud)"
          icons={['youtube']}
          idLabel="Client ID (OAuth, aplicación web)"
          idValue={config?.google?.clientId}
          hasSecret={config?.google?.hasSecret}
          secretLabel="Client Secret"
          canEdit={canEdit}
          onSave={saveCreds('google', 'clientId')}
          redirect={<RedirectRow label="URI de redireccionamiento autorizado" url={r.youtube} />}
        >
          <Help>
            Habilita <b>YouTube Data API v3</b>. Scopes: <code>youtube.upload</code> y <code>youtube.readonly</code>. Sin la auditoría de la API de YouTube los
            videos quedan <b>privados</b>. Mientras la pantalla de consentimiento esté «en pruebas», agrega el correo del canal como usuario de prueba y
            ten en cuenta que Google <b>corta la conexión cada 7 días</b>: publícala («En producción») para que dure.
          </Help>
        </CredentialsCard>
      </div>
    </div>
  );
}

function Help({ children }) {
  return (
    <p className="text-[11px] text-slate-500 flex gap-1.5">
      <HiOutlineInformationCircle className="w-4 h-4 shrink-0 text-slate-400" />
      <span>{children}</span>
    </p>
  );
}
