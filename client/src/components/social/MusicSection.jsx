import { useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { HiOutlineMusicalNote, HiOutlineArrowPath, HiOutlineXMark } from 'react-icons/hi2';
import api from '../../api/axios';
import { uploadSocialAudio } from '../../utils/socialMedia';
import { isImage, isVideo } from '../../utils/socialRules';

/**
 * MÚSICA de la publicación.
 *
 * Las APIs oficiales de Instagram, Facebook y TikTok NO dejan elegir canciones
 * de su biblioteca: eso solo se hace en la app del teléfono. Por eso hay dos
 * caminos, y la pantalla lo dice claro:
 *   - «Mi propio audio»: se sube un MP3/M4A y el servidor lo monta en el video
 *     (o arma un video desde una imagen). Sale publicado automáticamente con la
 *     música puesta.
 *   - «Canción de la app»: se anota cuál; ese destino se publica A MANO y el
 *     aviso al responsable dice qué canción poner.
 */
export default function MusicSection({ form, set, editable }) {
  const music = form.music || { mode: '', name: '' };
  const fileRef = useRef(null);
  const [audio, setAudio] = useState(null); // { media, name, url }
  const [subiendo, setSubiendo] = useState(0);
  const [montando, setMontando] = useState(false);
  const candidatos = (form.media || []).filter((m) => (isVideo(m) || isImage(m)) && !m.original);
  const [baseId, setBaseId] = useState('');
  const [modo, setModo] = useState('replace');
  const [volumen, setVolumen] = useState(1);
  const [segundos, setSegundos] = useState(15);
  const [formato, setFormato] = useState('vertical');

  const setMusic = (patch) => set({ music: { ...music, ...patch } });
  const base = candidatos.find((m) => String(m.media) === baseId) || candidatos[0] || null;

  const subirAudio = async (file) => {
    if (!file) return;
    setSubiendo(1);
    try {
      const data = await uploadSocialAudio(file, (p) => setSubiendo(Math.max(1, p)));
      setAudio(data);
      if (!music.name) setMusic({ name: data.name.replace(/\.[^.]+$/, '') });
    } catch (e) {
      toast.error(e.response?.data?.message || e.message || 'No se pudo subir el audio');
    } finally {
      setSubiendo(0);
    }
  };

  const montar = async () => {
    if (!audio || !base) return;
    setMontando(true);
    try {
      const { data } = await api.post(
        '/social/media/music',
        { base: base.media, audio: audio.media, mode: modo, volume: volumen, seconds: segundos, format: formato },
        { timeout: 0 }
      );
      set({
        media: form.media.map((m) => (String(m.media) === String(base.media) ? data : m)),
        music: { mode: 'file', name: music.name || data.musicName },
      });
      toast.success(isImage(base) ? 'Video con música creado a partir de la imagen' : 'Música puesta en el video');
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudo poner la música', { duration: 8000 });
    } finally {
      setMontando(false);
    }
  };

  const conMusica = (form.media || []).filter((m) => m.original);

  return (
    <section className="space-y-2">
      <p className="lbl flex items-center gap-1"><HiOutlineMusicalNote className="w-4 h-4" /> Música</p>
      <div className="flex flex-wrap gap-4 text-xs text-slate-600">
        {[
          ['', 'Sin música'],
          ['file', 'Mi propio audio (se publica solo)'],
          ['app', 'Canción de la app (se publica a mano)'],
        ].map(([v, label]) => (
          <label key={v || 'none'} className="flex items-center gap-1.5">
            <input type="radio" disabled={!editable} checked={music.mode === v} onChange={() => setMusic({ mode: v })} /> {label}
          </label>
        ))}
      </div>

      {music.mode === 'app' && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 space-y-2">
          <p className="text-[11px] text-amber-800">
            Instagram, Facebook y TikTok no dejan elegir canciones de su biblioteca desde fuera de la app. Escribe cuál va; a la hora
            programada se avisa al responsable para que la publique desde el teléfono con esa canción.
          </p>
          <input
            className="input input-sm"
            disabled={!editable}
            value={music.name}
            onChange={(e) => setMusic({ name: e.target.value })}
            placeholder="Canción y artista (ej.: Flowers — Miley Cyrus)"
          />
        </div>
      )}

      {music.mode === 'file' && (
        <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 space-y-3 text-xs text-slate-600">
          <p className="text-[11px] text-slate-500">
            Sube un MP3 o M4A y ponlo en un video (cambiando o mezclando su sonido) o conviértelo con una imagen en un video para
            historias y reels. Usa música con derechos: una canción comercial puede hacer que la red silencie o bloquee el video.
          </p>

          {conMusica.length > 0 && (
            <ul className="list-none p-0 m-0 space-y-1">
              {conMusica.map((m) => (
                <li key={String(m.media)} className="flex items-center gap-2">
                  <HiOutlineMusicalNote className="w-4 h-4 text-emerald-600" />
                  <span className="truncate flex-1">{m.name}{m.musicName ? ` · ${m.musicName}` : ''}</span>
                  {editable && (
                    <button
                      type="button"
                      onClick={() => set({
                        media: form.media.map((x) => (String(x.media) === String(m.media)
                          ? { media: m.original, url: m.originalUrl, mimeType: m.originalMimeType, name: m.name.replace(' (con música)', '') }
                          : x)),
                      })}
                      className="btn-ghost !px-2 !py-1 !text-xs"
                    >
                      <HiOutlineXMark className="w-3.5 h-3.5" /> Quitar música
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {editable && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => fileRef.current?.click()} disabled={!!subiendo} className="btn-secondary !py-1.5 !text-xs">
                  {subiendo ? `Subiendo audio… ${subiendo}%` : audio ? 'Cambiar audio' : 'Subir audio (MP3/M4A)'}
                </button>
                <input ref={fileRef} type="file" accept="audio/mpeg,audio/mp3,audio/mp4,audio/x-m4a,audio/aac,audio/wav" hidden onChange={(e) => { subirAudio(e.target.files?.[0]); e.target.value = ''; }} />
                {audio && <audio src={audio.url} controls className="h-8 max-w-full" />}
              </div>
              <label className="block">
                <span className="lbl">Nombre de la música</span>
                <input className="input input-sm" value={music.name} onChange={(e) => setMusic({ name: e.target.value })} placeholder="Para identificarla en el calendario" />
              </label>

              {candidatos.length === 0 ? (
                <p className="text-[11px] text-slate-400">Agrega primero el video o la imagen en «Imágenes y videos».</p>
              ) : (
                <div className="grid sm:grid-cols-2 gap-2">
                  <label>
                    <span className="lbl">Ponerla en</span>
                    <select className="input input-sm" value={base ? String(base.media) : ''} onChange={(e) => setBaseId(e.target.value)}>
                      {candidatos.map((m, i) => (
                        <option key={String(m.media)} value={String(m.media)}>
                          {i + 1}. {isVideo(m) ? 'Video' : 'Imagen'} — {m.name || 'sin nombre'}
                        </option>
                      ))}
                    </select>
                  </label>
                  {base && isVideo(base) ? (
                    <label>
                      <span className="lbl">Sonido del video</span>
                      <select className="input input-sm" value={modo} onChange={(e) => setModo(e.target.value)}>
                        <option value="replace">Reemplazarlo por la música</option>
                        <option value="mix">Mezclarlo con la música</option>
                      </select>
                    </label>
                  ) : (
                    <div className="grid grid-cols-2 gap-2">
                      <label>
                        <span className="lbl">Duración (s)</span>
                        <input type="number" min={3} max={30} className="input input-sm" value={segundos} onChange={(e) => setSegundos(Math.min(30, Math.max(3, Number(e.target.value) || 15)))} />
                      </label>
                      <label>
                        <span className="lbl">Formato</span>
                        <select className="input input-sm" value={formato} onChange={(e) => setFormato(e.target.value)}>
                          <option value="vertical">Vertical 9:16</option>
                          <option value="retrato">Retrato 4:5</option>
                          <option value="cuadrado">Cuadrado 1:1</option>
                        </select>
                      </label>
                    </div>
                  )}
                  <label className="sm:col-span-2">
                    <span className="lbl">Volumen de la música: {Math.round(volumen * 100)}%</span>
                    <input type="range" min={0.1} max={1.5} step={0.05} value={volumen} onChange={(e) => setVolumen(Number(e.target.value))} className="w-full" />
                  </label>
                  <div className="sm:col-span-2">
                    <button type="button" onClick={montar} disabled={!audio || !base || montando} className="btn-primary !py-2 !text-xs">
                      {montando ? <><HiOutlineArrowPath className="w-4 h-4 animate-spin" /> Poniendo la música…</> : 'Poner la música'}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
