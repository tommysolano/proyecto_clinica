import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import toast from 'react-hot-toast';
import api from '../api/axios';
import Modal from '../components/Modal';
import Spinner from '../components/Spinner';
import useDebounce from '../hooks/useDebounce';
import { downloadFile } from '../utils/download';
import { useAuth } from '../context/AuthContext';
import {
  canvasToJpeg,
  thumbnailUrl,
  loadImage,
  fitToPage,
  PAGE_QUALITY,
} from '../utils/photoPage';
import {
  HiOutlineDocumentText,
  HiOutlineCamera,
  HiOutlinePhoto,
  HiOutlineTrash,
  HiOutlineArrowDownTray,
  HiOutlineEye,
  HiOutlinePencil,
  HiOutlineMagnifyingGlass,
  HiOutlineArrowUturnLeft,
  HiOutlineCheck,
  HiOutlineXMark,
  HiOutlinePlus,
  HiOutlineChevronUp,
  HiOutlineChevronDown,
} from 'react-icons/hi2';

/**
 * Una foto subida entra al PDF TAL CUAL. Solo se vuelve a codificar cuando el
 * formato no sirve para el PDF (el servidor solo admite JPG y PNG) o cuando el
 * archivo pesa tanto que reventaría el envío; y aun así se respeta la imagen
 * entera, sin recortar nada.
 */
const SUBIDA_OK_TYPES = ['image/jpeg', 'image/png'];
const SUBIDA_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Tope de cada ENVÍO al servidor: nginx corta el cuerpo en 50 MB y multer no
 * admite más de 40 archivos por petición. Veinte fotos de teléfono sin comprimir
 * se pasan de largo, así que las páginas se mandan por tandas.
 *
 * NO es un tope de imágenes: un documento puede tener las páginas que haga falta.
 * Con «un PDF por imagen» cada tanda crea sus PDF, y en un PDF único las tandas
 * se apartan en el servidor bajo un mismo `sessionId` y la última las junta.
 */
const MAX_ENVIO_BYTES = 24 * 1024 * 1024;
const MAX_POR_ENVIO = 40;

/**
 * Identificador de la tanda para el servidor. Uno NUEVO por cada intento de
 * guardar: si un envío se cortó a la mitad, reintentar con el mismo id
 * duplicaría las páginas que sí habían llegado.
 */
const nuevaSesion = () =>
  (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`)
    .replace(/-/g, '');

/** Suelta las URL temporales de una página (vista previa y miniatura). */
const freePage = (p) => {
  for (const url of [p?.preview, p?.thumb]) {
    if (typeof url === 'string' && url.startsWith('blob:')) URL.revokeObjectURL(url);
  }
};

const fmtSize = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round((b || 0) / 1024)} KB`);
const fmtDate = (d) =>
  new Date(d).toLocaleString('es-EC', { timeZone: 'America/Guayaquil', dateStyle: 'short', timeStyle: 'short' });

/** Nombre por defecto igual al del servidor: "Escaneo 10-08-2026". */
const defaultName = () => {
  const d = new Date();
  return `Escaneo ${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
};

let pageSeq = 0;

export default function Scanner() {
  const { user } = useAuth();
  const [tab, setTab] = useState('escanear');
  // Las páginas viven aquí y no dentro del estudio: al cambiar de pestaña el
  // estudio se desmonta (para apagar la cámara) y si no, se perderían.
  const [pages, setPages] = useState([]);

  /**
   * Al SALIR de la pantalla se sueltan las páginas que quedaron sin generar.
   *
   * Sin esto, irse por el menú con la tanda a medias dejaba vivo el blob de
   * cada foto hasta recargar el navegador. Con el tope de imágenes puesto era
   * medio incómodo; sin tope son 300 fotos y varios cientos de MB colgados,
   * que en un teléfono es la pestaña muerta. Se lee de un ref para que el
   * efecto se monte UNA vez y aun así vea la lista final.
   */
  const pagesRef = useRef(pages);
  useEffect(() => { pagesRef.current = pages; }, [pages]);
  useEffect(() => () => pagesRef.current.forEach(freePage), []);

  return (
    <div className="space-y-5 sm:space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 sm:gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 sm:w-11 sm:h-11 rounded-2xl bg-emerald-100 text-emerald-700 flex items-center justify-center shadow-sm shrink-0">
            <HiOutlineDocumentText className="w-5 h-5 sm:w-6 sm:h-6" />
          </div>
          <div className="min-w-0">
            <h1 className="page-title">Escáner de documentos</h1>
            <p className="page-subtitle">Toma fotos de un documento y conviértelas en un PDF</p>
          </div>
        </div>
        <div className="flex w-full sm:w-auto gap-1 bg-slate-100 rounded-xl p-1">
          {[
            { k: 'escanear', l: 'Escanear' },
            { k: 'documentos', l: 'Mis documentos' },
          ].map((t) => (
            <button
              key={t.k}
              onClick={() => setTab(t.k)}
              className={`flex-1 sm:flex-none px-3 sm:px-4 py-2 rounded-lg text-sm font-medium cursor-pointer border-none whitespace-nowrap ${
                tab === t.k ? 'bg-white text-emerald-700 shadow-sm' : 'bg-transparent text-slate-600'
              }`}
            >
              {t.l}
              {t.k === 'escanear' && pages.length > 0 && (
                <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-600 text-white">
                  {pages.length}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {tab === 'escanear' ? (
        <ScanStudio pages={pages} setPages={setPages} onSaved={() => setTab('documentos')} />
      ) : (
        <DocumentList currentUserId={user?.id || user?._id} />
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
//  ESTUDIO: lanza la cámara a pantalla completa y administra las páginas
//
//  Aquí NO hay software de escaneo: ni detección del borde de la hoja, ni
//  corrección de perspectiva, ni filtros. Las fotos —de la cámara o subidas—
//  entran al PDF tal cual (ver utils/photoPage.js).
// ═════════════════════════════════════════════════════════════════════════════

function ScanStudio({ pages, setPages, onSaved }) {
  const [cameraOpen, setCameraOpen] = useState(false);
  const [busy, setBusy] = useState(null); // { done, total } mientras se procesan fotos
  const [name, setName] = useState('');
  // false = todas las imágenes en un mismo PDF; true = un PDF por imagen.
  const [separado, setSeparado] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef(null);
  const nameInputRef = useRef(null);

  const addPage = useCallback((page) => setPages((prev) => [...prev, page]), [setPages]);

  /** Cierra la cámara; con `goToSave` deja al usuario sobre el cuadro del nombre. */
  const closeCamera = useCallback((opts) => {
    setCameraOpen(false);
    if (opts?.goToSave) {
      setTimeout(() => {
        nameInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        nameInputRef.current?.focus();
      }, 100);
    }
  }, []);

  /**
   * Convierte la foto de la cámara en página: la imagen TAL CUAL.
   *
   * No se le busca el borde de la hoja, no se corrige la perspectiva y no se le
   * pasa ningún filtro; lo único que se hace es bajarla al tamaño de página para
   * que un documento de muchas hojas no pese de más.
   */
  const buildPage = useCallback(async (source) => {
    const canvas = fitToPage(source);
    const blob = await canvasToJpeg(canvas, PAGE_QUALITY);
    return {
      id: `p${++pageSeq}`,
      blob,
      preview: URL.createObjectURL(blob),
      thumb: thumbnailUrl(canvas),
      // Nombre del archivo del que salió (solo al subir fotos): con «un PDF por
      // imagen» y sin nombre escrito, cada PDF se llama como su imagen.
      sourceName: '',
    };
  }, []);

  /** Convierte un archivo subido en página: la imagen tal cual. */
  const buildUploadedPage = useCallback(async (file) => {
    let blob = file;
    if (!SUBIDA_OK_TYPES.includes(file.type) || file.size > SUBIDA_MAX_BYTES) {
      // WEBP/HEIC/GIF no entran en un PDF, y un archivo enorme no cabe en el
      // envío: se recodifica a JPEG entera (sin recortar ni filtrar nada).
      const img = await loadImage(file);
      blob = await canvasToJpeg(fitToPage(img), PAGE_QUALITY);
    }
    // Miniatura de 320 px: se decodifica una vez y se suelta. Pintar la foto
    // original en la rejilla obligaría al navegador a sostener veinte mapas de
    // bits de 12 MP a la vez. Si falla, se muestra la propia imagen y ya.
    let thumb = null;
    try {
      const img = await loadImage(blob);
      const t = document.createElement('canvas');
      const k = Math.min(1, 320 / Math.max(img.naturalWidth, img.naturalHeight));
      t.width = Math.max(1, Math.round(img.naturalWidth * k));
      t.height = Math.max(1, Math.round(img.naturalHeight * k));
      t.getContext('2d').drawImage(img, 0, 0, t.width, t.height);
      thumb = t.toDataURL('image/jpeg', 0.7);
    } catch { /* sin miniatura: abajo se usa la imagen tal cual */ }

    return {
      id: `p${++pageSeq}`,
      blob,
      preview: URL.createObjectURL(blob),
      thumb: thumb || URL.createObjectURL(blob),
      sourceName: file.name,
    };
  }, []);

  const addFromFiles = async (files) => {
    setBusy({ done: 0, total: files.length });
    const fallidas = [];
    for (const [i, file] of files.entries()) {
      setBusy({ done: i, total: files.length });
      // Respiro para que el contador se pinte entre foto y foto.
      await new Promise((r) => setTimeout(r, 0));
      try {
        addPage(await buildUploadedPage(file));
      } catch {
        // Una imagen que el navegador no sabe abrir (un HEIC en el escritorio, un
        // archivo a medio copiar) NO puede llevarse por delante a las demás.
        // Antes el bucle entero vivía dentro de un try: la primera que fallaba
        // cortaba la tanda y de quince fotos entraban una o dos.
        fallidas.push(file.name);
      }
    }
    setBusy(null);
    if (fallidas.length) {
      const muestra = fallidas.slice(0, 3).join(', ');
      toast.error(
        `No se pudieron leer ${fallidas.length} de ${files.length}: ${muestra}${fallidas.length > 3 ? '…' : ''}`,
        { duration: 8000 }
      );
    }
  };

  const removePage = (id) =>
    setPages((p) => {
      const victim = p.find((x) => x.id === id);
      if (victim) freePage(victim);
      return p.filter((x) => x.id !== id);
    });

  const movePage = (id, dir) =>
    setPages((prev) => {
      const i = prev.findIndex((p) => p.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  /**
   * Reparte las páginas en envíos que quepan en una petición (ver MAX_ENVIO_*).
   * Respeta el orden, así que las N primeras páginas son siempre las de los
   * primeros envíos: eso es lo que permite saber qué quedó subido si algo falla.
   */
  const envíosDe = (lista) => {
    const out = [];
    let actual = [];
    let peso = 0;
    for (const p of lista) {
      const s = p.blob.size || 0;
      if (actual.length && (peso + s > MAX_ENVIO_BYTES || actual.length >= MAX_POR_ENVIO)) {
        out.push(actual);
        actual = [];
        peso = 0;
      }
      actual.push(p);
      peso += s;
    }
    if (actual.length) out.push(actual);
    return out;
  };

  // ── Cuánto llevas ─────────────────────────────────────────────────────────
  // Se recalcula en cada render (es una suma sobre unas decenas de páginas) para
  // que el contador vaya subiendo mientras se procesan las fotos, no al final.
  const pesoTotal = pages.reduce((t, p) => t + (p.blob?.size || 0), 0);
  const tandas = envíosDe(pages).length;

  const postPáginas = async (grupo, campos) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(campos)) fd.append(k, v);
    grupo.forEach((p, i) => fd.append('pages', p.blob, `pagina-${i + 1}.jpg`));
    const r = await api.post('/scans', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
    return r.data;
  };

  const savePdf = async () => {
    // Con una tanda grande, «Subir fotos» tarda: si se genera a media carga solo
    // viajan las que hubiera y el resto se perdía al vaciar la rejilla.
    if (busy) return toast.error('Espera a que terminen de procesarse las fotos');
    if (!pages.length) return toast.error('Sube o escanea al menos una imagen');
    const envíos = envíosDe(pages);

    /**
     * Las páginas se quitan de la rejilla por ID, nunca por posición.
     *
     * Una tanda de 500 fotos son decenas de peticiones y varios minutos: en ese
     * rato el usuario puede borrar, mover o agregar miniaturas. Recortando por
     * índice (`prev.slice(subidas)`) se descartaban imágenes que NO se habían
     * subido y se conservaban las que sí, que se volvían a subir duplicadas.
     */
    const subidasIds = new Set();
    const fallidasIds = new Set();
    /** Saca de la rejilla lo que ya está en el servidor y deja intacto el resto. */
    const soltarSubidas = () => setPages((prev) => {
      prev.filter((p) => subidasIds.has(p.id)).forEach(freePage);
      return prev.filter((p) => !subidasIds.has(p.id));
    });

    setSaving({ done: 0, total: pages.length });
    try {
      if (!separado) {
        // Un PDF único no cabe en una sola petición cuando son muchas páginas:
        // se mandan por tandas bajo un mismo `sessionId` y el último envío
        // (`finish`) es el que arma el documento en el servidor.
        if (envíos.length === 1) {
          const data = await postPáginas(pages, { name: name.trim() || defaultName() });
          toast.success(`PDF creado: ${data.name}`);
        } else {
          const sessionId = nuevaSesion();
          let subidas = 0;
          let creado = null;
          for (const [i, grupo] of envíos.entries()) {
            const último = i === envíos.length - 1;
            const data = await postPáginas(grupo, {
              name: name.trim() || defaultName(),
              sessionId,
              startIndex: subidas,
              finish: último ? 'true' : 'false',
            });
            subidas += grupo.length;
            setSaving({ done: subidas, total: pages.length });
            if (último) creado = data;
          }
          toast.success(`PDF creado: ${creado?.name || name.trim() || defaultName()} (${pages.length} páginas)`);
        }
        // El documento existe: todas estas páginas ya están en el servidor.
        pages.forEach((p) => subidasIds.add(p.id));
      } else {
        // Cada envío es independiente: si el 4º falla, los tres primeros ya
        // crearon sus PDF y solo hay que reintentar lo que quedó.
        let creados = 0;
        let subidas = 0;
        const errores = [];
        let fallo = null;
        for (const grupo of envíos) {
          try {
            const data = await postPáginas(grupo, {
              name: name.trim(),
              mode: 'split',
              startIndex: subidas,
              pageNames: JSON.stringify(grupo.map((p) => p.sourceName || '')),
            });
            creados += data.documents?.length || 0;
            if (data.errors?.length) errores.push(...data.errors);
            // El servidor dice QUÉ imágenes no pudo convertir (`failed[].index`,
            // relativo a este envío): esas se quedan en la rejilla para poder
            // reintentarlas. El resto del grupo ya tiene su PDF.
            for (const f of data.failed || []) {
              const p = grupo[f.index];
              if (p) fallidasIds.add(p.id);
            }
            grupo.forEach((p) => { if (!fallidasIds.has(p.id)) subidasIds.add(p.id); });
            subidas += grupo.length;
            setSaving({ done: subidas, total: pages.length });
          } catch (e) {
            fallo = e;
            break;
          }
        }
        if (creados) toast.success(`${creados} PDF creados, uno por imagen`);
        if (fallo) {
          toast.error(
            `${fallo.response?.data?.message || 'Se cortó el envío'}. Quedan ${pages.length - subidas} imágenes sin subir: vuelve a darle a «Generar».`,
            { duration: 9000 }
          );
          // Se quitan solo las que SÍ se subieron, para que el reintento no las
          // duplique y el usuario no tenga que volver a elegir los archivos.
          soltarSubidas();
          return;
        }
        if (fallidasIds.size) {
          // Fallo PARCIAL: se creó casi todo, pero unas cuantas imágenes no. Se
          // dejan a la vista (con su nombre) en vez de borrarlas en silencio.
          const rotas = pages.filter((p) => fallidasIds.has(p.id));
          const muestra = rotas.map((p) => p.sourceName).filter(Boolean).slice(0, 3).join(', ');
          soltarSubidas();
          toast.error(
            `${rotas.length} ${rotas.length === 1 ? 'imagen' : 'imágenes'} no se pudieron convertir`
            + `${muestra ? ` (${muestra}${rotas.length > 3 ? '…' : ''})` : ''}`
            + ` y siguen en la lista. ${errores[0] || ''}`.trim(),
            { duration: 10000 }
          );
          return;
        }
        if (errores.length) {
          // Servidor antiguo, sin `failed`: no se puede señalar cuál fue.
          toast.error(`${errores.length} no se pudo generar. ${errores[0]}`, { duration: 7000 });
        }
      }
      // Solo se suelta lo que de verdad llegó al servidor: si el usuario agregó
      // fotos durante la subida, siguen en la rejilla en vez de evaporarse.
      soltarSubidas();
      setName('');
      onSaved?.();
    } catch (e) {
      // Nada se guardó a medias: un PDF único solo existe cuando llega el último
      // envío. Las imágenes siguen en la lista, así que reintentar es un clic.
      toast.error(
        `${e.response?.data?.message || 'No se pudo crear el PDF'}. Las imágenes siguen aquí: vuelve a darle a «Generar».`,
        { duration: 8000 }
      );
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="space-y-5">
      {/* ── Acciones principales ─────────────────────────────────────────── */}
      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 p-4 sm:p-5">
        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
          <div className="flex-1 min-w-0">
            <h2 className="font-semibold text-slate-800">Tomar fotos</h2>
            <p className="text-sm text-slate-500 mt-0.5">
              La cámara se abre a pantalla completa. Tras disparar te muestra la foto para que la
              uses o la repitas, y puedes seguir tomando todas las que necesites: cada una es una
              página.
            </p>
            <p className="text-sm text-slate-500 mt-1.5">
              Las fotos entran al PDF <b className="font-medium text-slate-600">tal cual</b>: encuadra
              bien al tomarlas, porque el sistema no recorta ni retoca nada.
            </p>
          </div>
          <div className="flex flex-col sm:flex-row gap-2 sm:shrink-0">
            <button
              onClick={() => setCameraOpen(true)}
              disabled={!!saving}
              className="btn-primary justify-center"
            >
              <HiOutlineCamera className="w-5 h-5" /> Abrir cámara
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={!!busy || !!saving}
              className="btn-secondary justify-center whitespace-nowrap"
            >
              {busy ? <Spinner /> : <HiOutlinePhoto className="w-4 h-4" />}
              {busy && busy.total > 1 ? `Procesando ${busy.done + 1} de ${busy.total}…` : 'Subir fotos'}
            </button>
          </div>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files || []);
            e.target.value = '';
            if (files.length) addFromFiles(files);
          }}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* ── Páginas ────────────────────────────────────────────────────── */}
        <div className="lg:col-span-2 bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 p-4 sm:p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="min-w-0">
              <h2 className="font-semibold text-slate-800 text-sm">
                {separado ? `Imágenes (${pages.length})` : `Páginas del PDF (${pages.length})`}
              </h2>
              {pages.length > 0 && (
                <p className="text-[11px] mt-0.5 text-slate-400">
                  {fmtSize(pesoTotal)}
                  {tandas > 1 && ` · se envía en ${tandas} tandas de hasta ${MAX_POR_ENVIO}`}
                </p>
              )}
            </div>
            {pages.length > 0 && (
              <button
                onClick={() => { pages.forEach(freePage); setPages([]); }}
                disabled={!!saving}
                className="text-xs text-rose-600 bg-transparent border-none cursor-pointer p-0 disabled:opacity-40 disabled:cursor-default"
              >
                Vaciar
              </button>
            )}
          </div>

          {pages.length === 0 ? (
            <div className="empty-state">
              <HiOutlineCamera className="w-10 h-10 text-slate-300" />
              <p className="font-medium text-slate-500">Todavía no hay páginas</p>
              <p className="text-xs text-slate-400">Abre la cámara y toma la primera foto, o sube fotos que ya tengas.</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
              {pages.map((p, i) => (
                <div key={p.id} className="rounded-xl border border-slate-200 bg-slate-50 overflow-hidden">
                  <div className="relative bg-white">
                    <img src={p.thumb} alt={`Página ${i + 1}`} loading="lazy" decoding="async" className="w-full block" />
                    <span className="absolute top-1.5 left-1.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-slate-900/70 text-white">
                      {i + 1}
                    </span>
                  </div>
                  <div className="p-1.5 flex flex-wrap gap-1 justify-center">
                    {/* Bloqueados mientras se sube: quitar una página cuya tanda ya
                        va en vuelo no la saca del PDF (el envío se calculó al empezar),
                        así que solo dejaría al usuario creyendo que la quitó. */}
                    <IconBtn title="Mover antes" onClick={() => movePage(p.id, -1)} disabled={!!saving || i === 0}>
                      <HiOutlineChevronUp className="w-3.5 h-3.5" />
                    </IconBtn>
                    <IconBtn title="Mover después" onClick={() => movePage(p.id, 1)} disabled={!!saving || i === pages.length - 1}>
                      <HiOutlineChevronDown className="w-3.5 h-3.5" />
                    </IconBtn>
                    <IconBtn title="Eliminar" onClick={() => removePage(p.id)} disabled={!!saving} danger>
                      <HiOutlineTrash className="w-3.5 h-3.5" />
                    </IconBtn>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Guardar ────────────────────────────────────────────────────── */}
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 p-4 sm:p-5 space-y-3 lg:sticky lg:top-4 lg:self-start">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">¿Cómo se guarda?</label>
            <div className="flex gap-1 bg-slate-100 rounded-xl p-1">
              {[
                { sep: false, l: 'Un solo PDF' },
                { sep: true, l: 'Un PDF por imagen' },
              ].map((o) => (
                <button
                  key={String(o.sep)}
                  type="button"
                  onClick={() => setSeparado(o.sep)}
                  className={`flex-1 px-2 py-2 rounded-lg text-xs font-medium cursor-pointer border-none ${
                    separado === o.sep ? 'bg-white text-emerald-700 shadow-sm' : 'bg-transparent text-slate-600'
                  }`}
                >
                  {o.l}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-slate-400 mt-1">
              {separado
                ? 'Cada imagen se guarda como un documento aparte.'
                : 'Todas las imágenes quedan como páginas de un mismo documento.'}
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">
              {separado ? 'Nombre base (opcional)' : 'Nombre del archivo'}
            </label>
            <input
              ref={nameInputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={separado ? 'El de cada imagen' : defaultName()}
              className="w-full px-3 py-2.5 border border-slate-200 rounded-xl bg-slate-50/50 outline-none text-sm"
            />
            <p className="text-[11px] text-slate-400 mt-1">
              {separado ? (
                <>
                  Con un nombre se guardan como «{name.trim() || 'Receta'} 1», «{name.trim() || 'Receta'} 2»…
                  Si lo dejas vacío, cada PDF toma el nombre del archivo de su imagen (las fotos de
                  la cámara usan «{defaultName()} 1», «{defaultName()} 2»…).
                </>
              ) : (
                <>
                  Si lo dejas vacío se usa «{defaultName()}». Si el nombre ya existe, el sistema le
                  agrega (2), (3)… para que no se repita.
                </>
              )}
            </p>
          </div>
          <button
            onClick={savePdf}
            disabled={saving || !pages.length}
            className="btn-primary w-full justify-center"
          >
            {saving ? <Spinner /> : <HiOutlineDocumentText className="w-5 h-5" />}
            {saving
              ? (saving.total > 1
                  ? `Generando ${saving.done} de ${saving.total}…`
                  : 'Generando…')
              : separado
                ? `Generar ${pages.length} PDF`
                : `Generar PDF (${pages.length})`}
          </button>
        </div>
      </div>

      {cameraOpen && (
        <CameraOverlay
          pageCount={pages.length}
          buildPage={buildPage}
          onAddPage={addPage}
          onClose={closeCamera}
        />
      )}

    </div>
  );
}

function IconBtn({ children, title, onClick, disabled, danger }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`p-1.5 rounded-lg border border-slate-200 bg-white cursor-pointer disabled:opacity-30 ${
        danger ? 'text-rose-500 hover:bg-rose-50' : 'text-slate-500 hover:bg-emerald-50 hover:text-emerald-600'
      }`}
    >
      {children}
    </button>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
//  CÁMARA A PANTALLA COMPLETA (vista en vivo → revisión de la foto)
//
//  Es una cámara y nada más: no busca el borde de la hoja, no corrige la
//  perspectiva y no aplica filtros. Disparas, ves la foto, la usas o la repites.
// ═════════════════════════════════════════════════════════════════════════════

/** El fotograma del vídeo tal cual, a la resolución de la vista previa. */
function videoFrame(video) {
  const c = document.createElement('canvas');
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0);
  return c;
}

/**
 * Toma la foto con TODO el detalle que dé el equipo.
 *
 * El fotograma del vídeo va a la resolución de la vista previa: 1080p en el
 * mejor de los casos, o sea ~2 MP para una hoja A4 completa —unos 120 ppp— y con
 * eso la letra chica no se lee, ni a ojo ni con un OCR. `ImageCapture.takePhoto`
 * dispara la cámara de verdad y devuelve la foto del sensor entero (12 MP y
 * más). No está en todos los navegadores (Safari no lo trae) y en algunos
 * equipos falla o se queda colgado, así que se le pone un límite de tiempo y se
 * compara con el fotograma: se usa la que traiga más píxeles.
 */
async function grabStill(video, track) {
  if (!track || typeof window.ImageCapture !== 'function') return videoFrame(video);
  const frameArea = video.videoWidth * video.videoHeight;
  try {
    const blob = await Promise.race([
      new window.ImageCapture(track).takePhoto(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('takePhoto tardó demasiado')), 4000)),
    ]);
    const img = await loadImage(blob);
    // Un 20% más de píxeles no compensa: hay equipos donde `takePhoto` devuelve
    // lo mismo que el vídeo pero recomprimido, y ahí es peor el remedio.
    if (img.naturalWidth * img.naturalHeight <= frameArea * 1.2) return videoFrame(video);
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    return c;
  } catch {
    return videoFrame(video);
  }
}

function CameraOverlay({ pageCount, buildPage, onAddPage, onClose }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const trackRef = useRef(null);

  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [shot, setShot] = useState(null); // foto tomada, a la espera de «usar» o «repetir»
  /**
   * Espejo de `shot` para poder soltarlo si el overlay se desmonta con una
   * foto sin confirmar (el botón atrás del móvil sobre una pantalla completa).
   *
   * Tiene que ser un ref y NO un efecto con dependencia en `shot`: al pulsar
   * «Añadir página» la foto pasa a la rejilla y `shot` vuelve a null, así que
   * ese efecto la liberaría justo cuando acaba de empezar a usarse. Aquí se
   * pone a null a mano y en el acto, en cuanto la foto cambia de dueño.
   */
  const shotRef = useRef(null);
  /** Único sitio que toca la foto en revisión: deja estado y ref a la par. */
  const ponerShot = (s) => { shotRef.current = s; setShot(s); };
  useEffect(() => () => { if (shotRef.current) freePage(shotRef.current); }, []);
  const [added, setAdded] = useState(pageCount);

  // ── Encendido / apagado ───────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('Este navegador no permite usar la cámara. Cierra y usa «Subir fotos».');
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            // Se pide lo más grande que dé el equipo: cada píxel de más sobre el
            // documento es texto que después se puede leer. Al ser `ideal`, si la
            // cámara no llega, el navegador baja solo al modo más cercano.
            width: { ideal: 3840 },
            height: { ideal: 2160 },
          },
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        trackRef.current = stream.getVideoTracks()[0] || null;
        const v = videoRef.current;
        if (v) {
          v.srcObject = stream;
          await v.play().catch(() => {});
        }
        setReady(true);
      } catch (e) {
        if (cancelled) return;
        setError(
          e.name === 'NotAllowedError'
            ? 'No diste permiso para usar la cámara. Habilítala en el navegador y vuelve a intentar.'
            : e.name === 'NotFoundError'
              ? 'Este equipo no tiene cámara. Cierra y usa «Subir fotos».'
              : e.message || 'No se pudo abrir la cámara'
        );
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      trackRef.current = null;
    };
  }, []);

  // El fondo no debe desplazarse mientras la cámara ocupa toda la pantalla.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  /**
   * Dispara. La foto se convierte en página directamente: entra tal cual, sin
   * buscarle el borde al documento, sin corregir perspectiva y sin filtros.
   */
  const capture = async () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    setWorking(true);
    try {
      ponerShot(await buildPage(await grabStill(v, trackRef.current)));
    } catch (e) {
      toast.error(e.message || 'No se pudo tomar la foto');
    } finally {
      setWorking(false);
    }
  };

  /** Descarta la foto en revisión (sin guardarla como página). */
  const discardShot = () => {
    if (shot) freePage(shot);
    ponerShot(null);
  };

  const keepShot = () => {
    onAddPage(shot);
    setAdded((n) => n + 1);
    ponerShot(null);
  };

  // "Crear PDF": guarda la última foto, cierra la cámara y lleva al usuario al
  // cuadro del nombre (el PDF se genera con el botón de ahí, ya con nombre).
  const finish = () => {
    onAddPage(shot);
    ponerShot(null);
    onClose({ goToSave: true });
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[9000] bg-black flex flex-col"
      style={{ height: '100dvh' }}
    >
      {/* ── Barra superior ─────────────────────────────────────────────── */}
      <div className="shrink-0 flex items-center justify-between gap-3 px-3 py-2.5 bg-black/80 text-white">
        <button
          onClick={() => { discardShot(); onClose(); }}
          className="w-10 h-10 rounded-full flex items-center justify-center bg-white/10 hover:bg-white/20 text-white border-none cursor-pointer"
          aria-label="Cerrar"
        >
          <HiOutlineXMark className="w-6 h-6" />
        </button>
        <p className="text-sm font-medium truncate">
          {shot
            ? '¿Se ve bien?'
            : added > 0
              ? `${added} foto${added === 1 ? '' : 's'} lista${added === 1 ? '' : 's'}`
              : 'Encuadra el documento'}
        </p>
        <span className="w-10 shrink-0" />
      </div>

      {/* ── Imagen / vídeo ─────────────────────────────────────────────── */}
      <div className="relative flex-1 min-h-0">
        <video
          ref={videoRef}
          playsInline
          muted
          className={`absolute inset-0 w-full h-full ${shot ? 'invisible' : ''}`}
          style={{ objectFit: 'contain' }}
        />

        {shot && (
          <img src={shot.preview} alt="Foto tomada" className="absolute inset-0 w-full h-full" style={{ objectFit: 'contain' }} />
        )}

        {(!ready || working) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 text-white px-6 text-center">
            {error ? (
              <>
                <HiOutlineCamera className="w-12 h-12 text-slate-400" />
                <p className="text-sm max-w-sm">{error}</p>
                <button onClick={onClose} className="btn-secondary">Cerrar</button>
              </>
            ) : (
              <>
                <Spinner />
                <p className="text-sm">{working ? 'Guardando la foto…' : 'Encendiendo la cámara…'}</p>
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Barra inferior ─────────────────────────────────────────────── */}
      {shot ? (
        <div className="shrink-0 bg-black/90 px-3 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <OverlayBtn onClick={discardShot} icon={HiOutlineArrowUturnLeft} label="Volver a tomar" />
            <OverlayBtn onClick={() => { discardShot(); onClose(); }} icon={HiOutlineTrash} label="Eliminar" danger />
            <OverlayBtn onClick={keepShot} icon={HiOutlinePlus} label="Añadir página" />
            <OverlayBtn onClick={finish} icon={HiOutlineCheck} label="Crear PDF" primary />
          </div>
        </div>
      ) : (
        <div className="shrink-0 bg-black/90 px-3 py-3 space-y-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <p className="text-center text-[11px] leading-tight text-white/70 px-4">
            {ready
              ? 'La foto entra al PDF tal cual: encuadra el documento y busca buena luz.'
              : 'Encendiendo la cámara…'}
          </p>
          <div className="flex items-center justify-center gap-8">
            <span className="w-12" />
            <button
              onClick={capture}
              disabled={!ready || working}
              aria-label="Capturar"
              className="rounded-full bg-white border-4 border-white/40 disabled:opacity-40 cursor-pointer flex items-center justify-center shrink-0"
              style={{ width: 72, height: 72 }}
            >
              <span className="block w-14 h-14 rounded-full bg-white ring-2 ring-slate-300" />
            </button>
            <button
              onClick={onClose}
              className="w-12 text-xs text-white/80 bg-transparent border-none cursor-pointer"
            >
              Listo
            </button>
          </div>
        </div>
      )}
    </div>,
    document.body
  );
}

function OverlayBtn({ onClick, icon, label, primary, danger }) {
  const Icon = icon;
  const tone = primary
    ? 'bg-emerald-500 text-white'
    : danger
      ? 'bg-rose-500/90 text-white'
      : 'bg-white/12 text-white';
  return (
    <button
      onClick={onClick}
      className={`${tone} rounded-xl px-2 py-2.5 text-xs font-medium border-none cursor-pointer flex flex-col items-center gap-1`}
    >
      <Icon className="w-5 h-5" />
      <span className="leading-tight text-center">{label}</span>
    </button>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
//  LISTA de PDFs generados
// ═════════════════════════════════════════════════════════════════════════════

/** Documentos por página. El servidor admite hasta 100. */
const POR_PAGINA = 50;

function DocumentList({ currentUserId }) {
  const { hasRole, user } = useAuth();
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search, 300);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  // Cuántos hay en TOTAL (no en esta página): es lo que se ofrece descargar entero.
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState([]);
  const [renaming, setRenaming] = useState(null);
  const [preview, setPreview] = useState(null);
  const [working, setWorking] = useState(false);
  // Descarga repartida en varios ZIP: { hecho, total }. Con veinte archivos en
  // cola hay que poder ver por dónde va, o parece que se quedó colgado.
  const [progreso, setProgreso] = useState(null);

  const fetchDocs = useCallback(async () => {
    try {
      const r = await api.get('/scans', { params: { search: debounced, page, limit: POR_PAGINA } });
      setDocs(r.data.documents || []);
      setTotalPages(r.data.pages || 1);
      setTotal(r.data.total || 0);
    } catch {
      toast.error('No se pudieron cargar los documentos');
    } finally {
      setLoading(false);
    }
  }, [debounced, page]);

  useEffect(() => { fetchDocs(); }, [fetchDocs]);
  useEffect(() => () => { if (preview?.url) URL.revokeObjectURL(preview.url); }, [preview]);

  const toggle = (id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const allShown = docs.length > 0 && docs.every((d) => selected.includes(d._id));
  const toggleAll = () =>
    setSelected((s) =>
      allShown ? s.filter((id) => !docs.some((d) => d._id === id)) : [...new Set([...s, ...docs.map((d) => d._id)])]
    );

  const downloadOne = async (doc) => {
    try {
      await downloadFile(`/scans/${doc._id}/download`, { filename: `${doc.name}.pdf` });
    } catch (e) {
      toast.error(e.message || 'No se pudo descargar');
    }
  };

  /**
   * DESCARGA EN VARIOS ZIP. Con miles de escaneos no cabe todo en un archivo: el
   * servidor arma el ZIP en memoria y tiene un tope (300 MB), así que primero se
   * le pregunta en cuántas partes hay que repartirlo y luego se bajan una a una.
   *
   * El plan trae los IDS de cada parte, no un "dame la página 3": así se bajan
   * exactamente los documentos que se contaron, y que alguien escanee algo
   * mientras corren las veinte descargas no descoloca el reparto.
   *
   * `filtro` es el mismo cuerpo que entiende /scans/download-zip:
   *   { ids: [...] }  ó  { all: true, search }
   */
  const descargarEnPartes = async (filtro) => {
    setWorking(true);
    setProgreso(null);
    try {
      const { data: plan } = await api.post('/scans/zip-plan', filtro);
      const partes = plan.parts || [];
      if (!partes.length) throw new Error('No hay documentos para descargar');

      const fecha = new Date().toISOString().slice(0, 10);
      const mb = (b) => (b / 1048576).toFixed(0);

      // Con una sola parte no hay nada que explicar: se baja y ya.
      if (partes.length > 1) {
        const ok = window.confirm(
          `Son ${plan.total} documentos (${mb(plan.totalBytes)} MB).\n\n`
          + `No caben en un solo ZIP —el máximo es ${mb(plan.maxBytes)} MB—, así que se `
          + `descargarán en ${partes.length} archivos, uno detrás de otro.\n\n`
          + 'El navegador puede pedirte permiso para "descargar varios archivos": acéptalo '
          + 'o solo se guardará el primero.\n\n¿Empezamos?'
        );
        if (!ok) return;
      }

      for (const parte of partes) {
        setProgreso({ hecho: parte.index - 1, total: partes.length });
        const nombre = partes.length === 1
          ? `escaneos_${fecha}.zip`
          // Con ceros delante para que el explorador los ordene bien: sin ellos,
          // "parte_10" se cuela entre "parte_1" y "parte_2".
          : `escaneos_${fecha}_parte_${String(parte.index).padStart(2, '0')}_de_${partes.length}.zip`;
        try {
          await downloadFile('/scans/download-zip', {
            method: 'post',
            data: { ids: parte.ids },
            filename: nombre,
          });
        } catch (e) {
          // Un reintento por parte: una descarga de veinte archivos no puede
          // abortarse entera por un tropiezo de red en la número quince.
          await downloadFile('/scans/download-zip', {
            method: 'post',
            data: { ids: parte.ids },
            filename: nombre,
          }).catch(() => {
            throw new Error(
              `Falló la parte ${parte.index} de ${partes.length} (${e.message || 'error de red'}). `
              + 'Las anteriores sí se descargaron.'
            );
          });
        }
      }

      setProgreso({ hecho: partes.length, total: partes.length });
      toast.success(
        partes.length > 1
          ? `${plan.total} documentos descargados en ${partes.length} archivos ZIP`
          : `${plan.total} documentos descargados`
      );
    } catch (e) {
      toast.error(e.response?.data?.message || e.message || 'No se pudo preparar el ZIP');
    } finally {
      setWorking(false);
      setProgreso(null);
    }
  };

  const downloadSelected = () => {
    if (!selected.length) return;
    return descargarEnPartes({ ids: selected });
  };

  /**
   * Descarga TODOS los documentos, no solo los de la página.
   *
   * La lista la resuelve el servidor: recorrer aquí todas las páginas para juntar
   * los ids dejaría fuera lo que alguien escanee entremedias, sin que se note.
   */
  const downloadAll = () => {
    if (!total) return;
    return descargarEnPartes({ all: true, search: debounced });
  };

  const openPreview = async (doc) => {
    try {
      const r = await api.get(`/scans/${doc._id}/download`, { params: { inline: 1 }, responseType: 'blob' });
      setPreview({ url: URL.createObjectURL(new Blob([r.data], { type: 'application/pdf' })), name: doc.name });
    } catch {
      toast.error('No se pudo abrir el documento');
    }
  };

  const remove = async (doc) => {
    if (!window.confirm(`¿Eliminar "${doc.name}"? Esta acción no se puede deshacer.`)) return;
    try {
      await api.delete(`/scans/${doc._id}`);
      toast.success('Documento eliminado');
      setSelected((s) => s.filter((x) => x !== doc._id));
      fetchDocs();
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudo eliminar');
    }
  };

  /**
   * Elimina los seleccionados de una vez. Se mandan TODOS los ids marcados (la
   * selección sobrevive al cambio de página) y el servidor descarta los que este
   * usuario no puede borrar, avisando cuáles fueron.
   */
  const removeSelected = async () => {
    if (!selected.length) return;
    const n = selected.length;
    if (!window.confirm(`¿Eliminar ${n} documento${n === 1 ? '' : 's'}? Esta acción no se puede deshacer.`)) return;
    setWorking(true);
    try {
      const r = await api.post('/scans/delete-many', { ids: selected });
      toast.success(r.data.message || 'Documentos eliminados');
      if (r.data.skipped?.length) {
        toast.error(
          `${r.data.skipped.length} no se eliminaron: los escaneó otra persona y no eres administrador.`,
          { duration: 7000 }
        );
      }
      setSelected([]);
      fetchDocs();
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudieron eliminar');
    } finally {
      setWorking(false);
    }
  };

  const saveRename = async (newName) => {
    try {
      const r = await api.patch(`/scans/${renaming._id}`, { name: newName });
      toast.success(`Renombrado a "${r.data.name}"`);
      setRenaming(null);
      fetchDocs();
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudo renombrar');
    }
  };

  /**
   * Misma regla que el servidor (puedeBorrar en scanController): el admin y el
   * super-admin borran cualquiera; el resto, solo lo que escanearon.
   *
   * El super-admin faltaba aquí: con un rol de sucursal distinto de 'admin' no
   * veía el botón, aunque el servidor sí le dejaba borrar.
   */
  const canDelete = (doc) =>
    hasRole('admin')
    || !!user?.isSuperAdmin
    || String(doc.createdBy?._id || doc.createdBy) === String(currentUserId);

  const Actions = ({ d }) => (
    <>
      <IconBtn title="Ver" onClick={() => openPreview(d)}><HiOutlineEye className="w-4 h-4" /></IconBtn>
      <IconBtn title="Descargar" onClick={() => downloadOne(d)}><HiOutlineArrowDownTray className="w-4 h-4" /></IconBtn>
      <IconBtn title="Renombrar" onClick={() => setRenaming(d)}><HiOutlinePencil className="w-4 h-4" /></IconBtn>
      {/* Apagado en vez de escondido: si no se puede borrar, que se vea por qué. */}
      <IconBtn
        title={canDelete(d) ? 'Eliminar' : 'Solo quien lo escaneó (o un administrador) puede eliminarlo'}
        onClick={() => remove(d)}
        disabled={!canDelete(d)}
        danger
      >
        <HiOutlineTrash className="w-4 h-4" />
      </IconBtn>
    </>
  );

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 p-4">
        <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
          <div className="relative flex-1 min-w-0">
            <HiOutlineMagnifyingGlass className="absolute left-3.5 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              type="text"
              placeholder="Buscar por nombre..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              className="w-full pl-11 pr-4 py-3 border border-slate-200 rounded-xl bg-slate-50/50 outline-none text-sm"
            />
          </div>
          <button
            onClick={downloadSelected}
            disabled={!selected.length || working}
            className="btn-primary justify-center disabled:opacity-40 whitespace-nowrap"
          >
            {working ? <Spinner /> : <HiOutlineArrowDownTray className="w-4 h-4" />}
            Descargar {selected.length ? `(${selected.length})` : 'seleccionados'}
          </button>
          <button
            onClick={downloadAll}
            disabled={!total || working}
            className="btn-secondary justify-center disabled:opacity-40 whitespace-nowrap"
            title={debounced
              ? 'Descarga todos los documentos que coinciden con la búsqueda'
              : 'Descarga todos los documentos escaneados. Si no caben en un ZIP, se reparten en varios.'}
          >
            {working ? <Spinner /> : <HiOutlineArrowDownTray className="w-4 h-4" />}
            {/* Con miles de documentos esto tarda varios minutos: el botón dice
                por qué parte va en vez de quedarse en "cargando". */}
            {progreso && progreso.total > 1
              ? `Descargando ${Math.min(progreso.hecho + 1, progreso.total)} de ${progreso.total}…`
              : debounced
                ? `Descargar los ${total} encontrados`
                : `Descargar todos (${total})`}
          </button>
          <button
            onClick={removeSelected}
            disabled={!selected.length || working}
            className="btn-danger justify-center disabled:opacity-40 whitespace-nowrap"
            title="Elimina los documentos seleccionados"
          >
            <HiOutlineTrash className="w-4 h-4" />
            Eliminar {selected.length ? `(${selected.length})` : 'seleccionados'}
          </button>
        </div>
      </div>

      {/* Tarjetas en móvil */}
      <div className="md:hidden space-y-2">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bg-white rounded-2xl border border-emerald-100 p-4"><div className="skeleton h-4 w-2/3" /></div>
          ))
        ) : docs.length === 0 ? (
          <div className="bg-white rounded-2xl border border-emerald-100">
            <div className="empty-state">
              <HiOutlineDocumentText className="w-10 h-10 text-slate-300" />
              <p className="font-medium text-slate-500">Todavía no hay documentos</p>
              <p className="text-xs text-slate-400">Ve a «Escanear» y toma la primera foto.</p>
            </div>
          </div>
        ) : (
          docs.map((d) => (
            <div key={d._id} className="bg-white rounded-2xl shadow-sm border border-emerald-100 p-3">
              <div className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={selected.includes(d._id)}
                  onChange={() => toggle(d._id)}
                  className="w-4 h-4 accent-emerald-600 cursor-pointer mt-1"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-800 break-words">{d.name}</p>
                  <p className="text-[11px] text-slate-400">
                    {d.pages} pág. · {fmtSize(d.size)} · {fmtDate(d.createdAt)}
                  </p>
                  <p className="text-[11px] text-slate-400">{d.createdBy?.name || '—'}</p>
                </div>
              </div>
              <div className="flex gap-1 justify-end mt-2"><Actions d={d} /></div>
            </div>
          ))
        )}
      </div>

      {/* Tabla en escritorio */}
      <div className="hidden md:block bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr className="bg-emerald-50/50 border-b border-emerald-100">
                <th className="px-4 py-3.5 w-10">
                  <input type="checkbox" checked={allShown} onChange={toggleAll} className="w-4 h-4 accent-emerald-600 cursor-pointer" />
                </th>
                <th className="text-left px-4 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Nombre</th>
                <th className="text-left px-4 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Páginas</th>
                <th className="text-left px-4 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Tamaño</th>
                <th className="text-left px-4 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider hidden lg:table-cell">Escaneado por</th>
                <th className="text-right px-4 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={`sk-${i}`} className="border-b border-emerald-50">
                    {Array.from({ length: 6 }).map((__, j) => (
                      <td key={j} className="px-4 py-3.5"><div className="skeleton h-4 w-full max-w-[160px]" /></td>
                    ))}
                  </tr>
                ))
              ) : docs.length === 0 ? (
                <tr>
                  <td colSpan="6">
                    <div className="empty-state">
                      <HiOutlineDocumentText className="w-10 h-10 text-slate-300" />
                      <p className="font-medium text-slate-500">Todavía no hay documentos escaneados</p>
                      <p className="text-xs text-slate-400">Ve a la pestaña «Escanear» y toma la primera foto.</p>
                    </div>
                  </td>
                </tr>
              ) : (
                docs.map((d) => (
                  <tr key={d._id} className="border-b border-emerald-50 hover:bg-emerald-50/30">
                    <td className="px-4 py-3.5">
                      <input type="checkbox" checked={selected.includes(d._id)} onChange={() => toggle(d._id)} className="w-4 h-4 accent-emerald-600 cursor-pointer" />
                    </td>
                    <td className="px-4 py-3.5 text-sm font-medium text-slate-800">
                      {d.name}
                      <div className="text-[11px] text-slate-400 font-normal">{fmtDate(d.createdAt)}</div>
                    </td>
                    <td className="px-4 py-3.5 text-sm text-slate-600">{d.pages}</td>
                    <td className="px-4 py-3.5 text-sm text-slate-600">{fmtSize(d.size)}</td>
                    <td className="px-4 py-3.5 text-sm text-slate-600 hidden lg:table-cell">{d.createdBy?.name || '—'}</td>
                    <td className="px-4 py-3.5 text-right whitespace-nowrap">
                      <div className="inline-flex gap-1"><Actions d={d} /></div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="btn-secondary disabled:opacity-50">Anterior</button>
          <span className="text-sm text-slate-500">Página {page} de {totalPages}</span>
          <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="btn-secondary disabled:opacity-50">Siguiente</button>
        </div>
      )}

      {renaming && <RenameModal doc={renaming} onClose={() => setRenaming(null)} onSave={saveRename} />}

      {preview && (
        <Modal isOpen onClose={() => setPreview(null)} title={preview.name} size="xl">
          <iframe title={preview.name} src={preview.url} className="w-full rounded-xl border border-slate-200" style={{ height: '70vh' }} />
        </Modal>
      )}
    </div>
  );
}

function RenameModal({ doc, onClose, onSave }) {
  const [value, setValue] = useState(doc.name);
  return (
    <Modal isOpen onClose={onClose} title="Renombrar documento" size="sm">
      <form
        onSubmit={(e) => { e.preventDefault(); if (value.trim()) onSave(value.trim()); }}
        className="space-y-3"
      >
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-full px-3 py-2.5 border border-slate-200 rounded-xl bg-slate-50/50 outline-none text-sm"
        />
        <p className="text-[11px] text-slate-400">
          Si el nombre ya está usado, se guardará con (2), (3)… al final.
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancelar</button>
          <button type="submit" className="btn-primary">Guardar</button>
        </div>
      </form>
    </Modal>
  );
}
