import { useState } from 'react';
import NetworkIcon from './NetworkIcon';
import { composeText, isVideo, NETWORK_LABELS, FORMAT_LABELS } from '../../utils/socialRules';

/**
 * Vista previa aproximada de cómo se verá cada destino. No es pixel a pixel:
 * sirve para ver el recorte, el orden de los medios y cómo queda el texto.
 */
function MediaBox({ m, className = '', fit = 'cover' }) {
  if (!m) {
    return <div className={`bg-slate-100 flex items-center justify-center text-xs text-slate-400 ${className}`}>Sin medio</div>;
  }
  return isVideo(m) ? (
    <video src={m.url} muted playsInline preload="metadata" className={`bg-black ${className}`} style={{ objectFit: fit }} />
  ) : (
    <img src={m.url} alt="" className={`bg-slate-100 ${className}`} style={{ objectFit: fit }} />
  );
}

function Avatar({ account }) {
  return account?.avatarUrl ? (
    <img src={account.avatarUrl} alt="" className="w-7 h-7 rounded-full object-cover" />
  ) : (
    <div className="w-7 h-7 rounded-full bg-slate-200" />
  );
}

function Caption({ name, text, dark = false }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  const long = text.length > 140;
  return (
    <p className={`text-xs whitespace-pre-wrap break-words ${dark ? 'text-white' : 'text-slate-800'}`}>
      {name && <b className="mr-1">{name}</b>}
      {open || !long ? text : `${text.slice(0, 140)}… `}
      {long && !open && (
        <button type="button" onClick={() => setOpen(true)} className={`bg-transparent border-none p-0 cursor-pointer text-xs ${dark ? 'text-white/70' : 'text-slate-400'}`}>
          más
        </button>
      )}
    </p>
  );
}

function feedAspect(m) {
  if (!m?.width || !m?.height) return 1;
  return Math.min(1.91, Math.max(0.8, m.width / m.height));
}

function VerticalFrame({ m, account, text, network, story }) {
  return (
    <div className="relative mx-auto rounded-2xl overflow-hidden bg-black" style={{ width: 220, aspectRatio: '9 / 16' }}>
      <MediaBox m={m} className="absolute inset-0 w-full h-full" />
      {story && <div className="absolute top-2 left-2 right-2 h-0.5 rounded bg-white/70" />}
      <div className="absolute top-4 left-3 flex items-center gap-2">
        <Avatar account={account} />
        <span className="text-[11px] font-semibold text-white drop-shadow">{account?.username || account?.name || NETWORK_LABELS[network]}</span>
      </div>
      {!story && (
        <div className="absolute bottom-0 left-0 right-0 p-3 bg-gradient-to-t from-black/70 to-transparent">
          <Caption text={text} dark />
        </div>
      )}
    </div>
  );
}

export function TargetPreview({ post, target, account }) {
  const media = post.media || [];
  const first = media[0];
  const text = composeText(post, target, { includeLink: !(target.network === 'facebook' && target.format === 'post' && !media.length) });
  const name = account?.username || account?.name || NETWORK_LABELS[target.network];

  if (target.format === 'story') return <VerticalFrame m={first} account={account} network={target.network} story />;
  if (['reel', 'short'].includes(target.format) || (target.network === 'tiktok' && target.format === 'video')) {
    return <VerticalFrame m={first} account={account} text={target.network === 'youtube' ? target.title || post.title : text} network={target.network} />;
  }

  if (target.network === 'tiktok' && target.format === 'photo') {
    return (
      <div className="mx-auto" style={{ width: 220 }}>
        <VerticalFrame m={first} account={account} text={text} network="tiktok" />
        {media.length > 1 && <p className="text-[11px] text-slate-400 text-center mt-1">{media.length} fotos en carrusel</p>}
      </div>
    );
  }

  if (target.network === 'youtube') {
    return (
      <div className="mx-auto max-w-sm">
        <MediaBox m={first} className="w-full rounded-xl" fit="contain" />
        <div className="flex gap-2 mt-2">
          <Avatar account={account} />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-800 line-clamp-2">{target.title || post.title}</p>
            <p className="text-[11px] text-slate-500">{account?.name || 'Canal'}</p>
          </div>
        </div>
      </div>
    );
  }

  if (target.network === 'facebook') {
    return (
      <div className="mx-auto max-w-sm border border-slate-200 rounded-xl bg-white overflow-hidden">
        <div className="flex items-center gap-2 p-3">
          <Avatar account={account} />
          <div>
            <p className="text-xs font-semibold text-slate-800">{account?.name || 'Página'}</p>
            <p className="text-[10px] text-slate-400">Programado</p>
          </div>
        </div>
        {text && <div className="px-3 pb-2"><Caption text={text} /></div>}
        {media.length > 0 ? (
          <div className={`grid gap-0.5 ${media.length > 1 ? 'grid-cols-2' : ''}`}>
            {media.slice(0, 4).map((m, i) => (
              <div key={String(m.media)} className="relative">
                <MediaBox m={m} className="w-full aspect-square" />
                {i === 3 && media.length > 4 && (
                  <div className="absolute inset-0 bg-black/50 flex items-center justify-center text-white font-bold">+{media.length - 4}</div>
                )}
              </div>
            ))}
          </div>
        ) : post.link ? (
          <div className="mx-3 mb-3 border border-slate-200 rounded-lg p-3 bg-slate-50">
            <p className="text-[10px] uppercase text-slate-400">Enlace</p>
            <p className="text-xs text-slate-700 truncate">{post.link}</p>
          </div>
        ) : null}
      </div>
    );
  }

  // Instagram feed (post / carrusel)
  return (
    <div className="mx-auto max-w-xs border border-slate-200 rounded-xl bg-white overflow-hidden">
      <div className="flex items-center gap-2 p-2.5">
        <Avatar account={account} />
        <span className="text-xs font-semibold text-slate-800">{name}</span>
      </div>
      <div className="relative w-full" style={{ aspectRatio: String(feedAspect(first)) }}>
        <MediaBox m={first} className="absolute inset-0 w-full h-full" />
      </div>
      {media.length > 1 && (
        <div className="flex justify-center gap-1 py-1.5">
          {media.slice(0, 10).map((m, i) => <span key={String(m.media)} className={`w-1.5 h-1.5 rounded-full ${i === 0 ? 'bg-sky-500' : 'bg-slate-300'}`} />)}
        </div>
      )}
      <div className="p-2.5"><Caption name={name} text={text} /></div>
    </div>
  );
}

export default function PostPreview({ post, accountsById }) {
  const targets = post.targets || [];
  const [idx, setIdx] = useState(0);
  if (!targets.length) {
    return <p className="text-xs text-slate-400 text-center py-8">Elige dónde publicar para ver la vista previa.</p>;
  }
  const i = Math.min(idx, targets.length - 1);
  const t = targets[i];
  return (
    <div>
      <div className="flex flex-wrap gap-1 mb-3">
        {targets.map((x, k) => (
          <button
            key={x._id || x.key || k}
            type="button"
            onClick={() => setIdx(k)}
            className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] border cursor-pointer ${k === i ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-600 border-slate-200'}`}
          >
            <NetworkIcon network={x.network} className="w-3 h-3" colored={k !== i} />
            {FORMAT_LABELS[x.format]}
          </button>
        ))}
      </div>
      <TargetPreview post={post} target={t} account={t.account ? accountsById[String(t.account)] : null} />
    </div>
  );
}
