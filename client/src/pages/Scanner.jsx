import { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import toast from 'react-hot-toast';
import api from '../api/axios';
import Modal from '../components/Modal';
import Spinner from '../components/Spinner';
import useDebounce from '../hooks/useDebounce';
import { downloadFile } from '../utils/download';
import { useAuth } from '../context/AuthContext';
import {
  detectDocument,
  warpDocument,
  applyFilter,
  canvasToJpeg,
  thumbnailUrl,
  loadImage,
  FULL_QUAD,
} from '../utils/docScan';
import {
  HiOutlineDocumentText,
  HiOutlineCamera,
  HiOutlinePhoto,
  HiOutlineTrash,
  HiOutlineArrowDownTray,
  HiOutlineArrowsPointingOut,
  HiOutlineEye,
  HiOutlinePencil,
  HiOutlineMagnifyingGlass,
  HiOutlineArrowUturnLeft,
  HiOutlineCheck,
  HiOutlineXMark,
  HiOutlinePlus,
  HiOutlineArrowPath,
  HiOutlineChevronUp,
  HiOutlineChevronDown,
} from 'react-icons/hi2';

const FILTERS = [
  { key: 'documento', label: 'Documento', hint: 'Fondo blanco parejo, sin sombras' },
  { key: 'bn', label: 'B / N', hint: 'Solo texto, archivo liviano' },
  { key: 'gris', label: 'Grises', hint: 'Escala de grises' },
  { key: 'color', label: 'Color', hint: 'Tal como se ve' },
];

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

  return (
    <div className="space-y-5 sm:space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 sm:gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 sm:w-11 sm:h-11 rounded-2xl bg-emerald-100 text-emerald-700 flex items-center justify-center shadow-sm shrink-0">
            <HiOutlineDocumentText className="w-5 h-5 sm:w-6 sm:h-6" />
          </div>
          <div className="min-w-0">
            <h1 className="page-title">Escáner de documentos</h1>
            <p className="page-subtitle">Toma fotos de una hoja y conviértelas en un PDF</p>
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
// ═════════════════════════════════════════════════════════════════════════════

function ScanStudio({ pages, setPages, onSaved }) {
  const [cameraOpen, setCameraOpen] = useState(false);
  const [filter, setFilter] = useState('documento');
  const [busy, setBusy] = useState(false);
  const [cropping, setCropping] = useState(null); // { pageId, src, w, h, quad }
  const [name, setName] = useState('');
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

  /** Recorta + limpia una imagen y la deja lista como página. */
  const buildPage = useCallback(async (source, sw, sh, detectedQuad, mode) => {
    const useQuad = detectedQuad || FULL_QUAD;
    const warped = warpDocument(source, sw, sh, useQuad);
    if (!warped) throw new Error('No se pudo recortar la imagen');
    applyFilter(warped, mode);
    const blob = await canvasToJpeg(warped, 0.85);

    // El original se guarda reducido para poder reencuadrar después sin
    // quedarnos con fotos de 5 MP en memoria por cada página.
    const orig = document.createElement('canvas');
    const k = Math.min(1, 1600 / Math.max(sw, sh));
    orig.width = Math.round(sw * k);
    orig.height = Math.round(sh * k);
    orig.getContext('2d').drawImage(source, 0, 0, orig.width, orig.height);

    return {
      id: `p${++pageSeq}`,
      blob,
      preview: URL.createObjectURL(blob),
      thumb: thumbnailUrl(warped),
      original: orig.toDataURL('image/jpeg', 0.8),
      originalW: orig.width,
      originalH: orig.height,
      quad: useQuad,
      filter: mode,
      detected: !!detectedQuad,
    };
  }, []);

  const addFromFiles = async (files) => {
    setBusy(true);
    try {
      for (const file of files) {
        const img = await loadImage(file);
        const q = detectDocument(img, img.naturalWidth, img.naturalHeight, 320);
        addPage(await buildPage(img, img.naturalWidth, img.naturalHeight, q, filter));
      }
    } catch (e) {
      toast.error(e.message || 'No se pudieron leer las imágenes');
    } finally {
      setBusy(false);
    }
  };

  const removePage = (id) =>
    setPages((p) => {
      const victim = p.find((x) => x.id === id);
      if (victim?.preview) URL.revokeObjectURL(victim.preview);
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

  const applyCrop = async (newQuad) => {
    const page = pages.find((p) => p.id === cropping.pageId);
    if (!page) return setCropping(null);
    try {
      const img = await loadImage(page.original);
      const warped = warpDocument(img, page.originalW, page.originalH, newQuad);
      if (!warped) throw new Error('El recorte no es válido');
      applyFilter(warped, page.filter);
      const blob = await canvasToJpeg(warped, 0.85);
      if (page.preview) URL.revokeObjectURL(page.preview);
      setPages((prev) =>
        prev.map((p) =>
          p.id === page.id
            ? { ...p, blob, preview: URL.createObjectURL(blob), thumb: thumbnailUrl(warped), quad: newQuad, detected: true }
            : p
        )
      );
    } catch (e) {
      toast.error(e.message || 'No se pudo reencuadrar');
    } finally {
      setCropping(null);
    }
  };

  const savePdf = async () => {
    if (!pages.length) return toast.error('Escanea al menos una página');
    setSaving(true);
    try {
      const fd = new FormData();
      fd.append('name', name.trim() || defaultName());
      pages.forEach((p, i) => fd.append('pages', p.blob, `pagina-${i + 1}.jpg`));
      const r = await api.post('/scans', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success(`PDF creado: ${r.data.name}`);
      pages.forEach((p) => p.preview && URL.revokeObjectURL(p.preview));
      setPages([]);
      setName('');
      onSaved?.();
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudo crear el PDF');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* ── Acciones principales ─────────────────────────────────────────── */}
      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 p-4 sm:p-5">
        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
          <div className="flex-1 min-w-0">
            <h2 className="font-semibold text-slate-800">Escanear una hoja</h2>
            <p className="text-sm text-slate-500 mt-0.5">
              La cámara se abre a pantalla completa, reconoce los bordes de la hoja y recorta sola:
              la mesa y todo lo de alrededor quedan fuera.
            </p>
          </div>
          <div className="flex flex-col sm:flex-row gap-2 sm:shrink-0">
            <button onClick={() => setCameraOpen(true)} className="btn-primary justify-center">
              <HiOutlineCamera className="w-5 h-5" /> Abrir cámara
            </button>
            <button onClick={() => fileInputRef.current?.click()} disabled={busy} className="btn-secondary justify-center">
              {busy ? <Spinner /> : <HiOutlinePhoto className="w-4 h-4" />} Subir fotos
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
            <h2 className="font-semibold text-slate-800 text-sm">Páginas del PDF ({pages.length})</h2>
            {pages.length > 0 && (
              <button
                onClick={() => { pages.forEach((p) => p.preview && URL.revokeObjectURL(p.preview)); setPages([]); }}
                className="text-xs text-rose-600 bg-transparent border-none cursor-pointer p-0"
              >
                Vaciar
              </button>
            )}
          </div>

          {pages.length === 0 ? (
            <div className="empty-state">
              <HiOutlineCamera className="w-10 h-10 text-slate-300" />
              <p className="font-medium text-slate-500">Todavía no hay páginas</p>
              <p className="text-xs text-slate-400">Abre la cámara y toma la primera foto.</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
              {pages.map((p, i) => (
                <div key={p.id} className="rounded-xl border border-slate-200 bg-slate-50 overflow-hidden">
                  <div className="relative bg-white">
                    <img src={p.thumb} alt={`Página ${i + 1}`} className="w-full block" />
                    <span className="absolute top-1.5 left-1.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-slate-900/70 text-white">
                      {i + 1}
                    </span>
                  </div>
                  <div className="p-1.5 flex flex-wrap gap-1 justify-center">
                    <IconBtn title="Reencuadrar" onClick={() => setCropping({ pageId: p.id, src: p.original, w: p.originalW, h: p.originalH, quad: p.quad })}>
                      <HiOutlineArrowsPointingOut className="w-3.5 h-3.5" />
                    </IconBtn>
                    <IconBtn title="Mover antes" onClick={() => movePage(p.id, -1)} disabled={i === 0}>
                      <HiOutlineChevronUp className="w-3.5 h-3.5" />
                    </IconBtn>
                    <IconBtn title="Mover después" onClick={() => movePage(p.id, 1)} disabled={i === pages.length - 1}>
                      <HiOutlineChevronDown className="w-3.5 h-3.5" />
                    </IconBtn>
                    <IconBtn title="Eliminar" onClick={() => removePage(p.id)} danger>
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
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Nombre del archivo</label>
            <input
              ref={nameInputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={defaultName()}
              className="w-full px-3 py-2.5 border border-slate-200 rounded-xl bg-slate-50/50 outline-none text-sm"
            />
            <p className="text-[11px] text-slate-400 mt-1">
              Si lo dejas vacío se usa «{defaultName()}». Si el nombre ya existe, el sistema le
              agrega (2), (3)… para que no se repita.
            </p>
          </div>
          <button onClick={savePdf} disabled={saving || !pages.length} className="btn-primary w-full justify-center">
            {saving ? <Spinner /> : <HiOutlineDocumentText className="w-5 h-5" />}
            {saving ? 'Generando…' : `Generar PDF (${pages.length})`}
          </button>
        </div>
      </div>

      {cameraOpen && (
        <CameraOverlay
          filter={filter}
          setFilter={setFilter}
          pageCount={pages.length}
          buildPage={buildPage}
          onAddPage={addPage}
          onClose={closeCamera}
        />
      )}

      {cropping && (
        <CropModal
          src={cropping.src}
          width={cropping.w}
          height={cropping.h}
          initialQuad={cropping.quad}
          onCancel={() => setCropping(null)}
          onConfirm={applyCrop}
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
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Calcula el rectángulo REAL que ocupa el contenido dentro de un elemento con
 * `object-fit: contain` (el vídeo/imagen queda centrado con franjas negras).
 * Sin esto, el marco verde —que se dibuja en coordenadas relativas— aparecería
 * desplazado en cuanto la pantalla no tiene la misma proporción que la cámara.
 */
function useContentBox(ref, naturalW, naturalH) {
  const [box, setBox] = useState(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !naturalW || !naturalH) return undefined;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (!w || !h) return;
      const scale = Math.min(w / naturalW, h / naturalH);
      const cw = naturalW * scale;
      const ch = naturalH * scale;
      setBox({ left: (w - cw) / 2, top: (h - ch) / 2, width: cw, height: ch });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('orientationchange', measure);
    return () => { ro.disconnect(); window.removeEventListener('orientationchange', measure); };
  }, [ref, naturalW, naturalH]);
  return box;
}

function CameraOverlay({ filter, setFilter, pageCount, buildPage, onAddPage, onClose }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const detectRef = useRef(null);
  const busyRef = useRef(false);

  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [quad, setQuad] = useState(null);
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const [working, setWorking] = useState(false);
  const [shot, setShot] = useState(null);   // foto tomada, a la espera de revisión
  const [cropping, setCropping] = useState(false);
  const [added, setAdded] = useState(pageCount);

  const box = useContentBox(videoRef, dims.w, dims.h);

  // ── Encendido / apagado ───────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('Este navegador no permite usar la cámara. Cierra y usa «Subir fotos».');
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        const v = videoRef.current;
        if (v) {
          v.srcObject = stream;
          await v.play().catch(() => {});
          setDims({ w: v.videoWidth, h: v.videoHeight });
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
    };
  }, []);

  // El fondo no debe desplazarse mientras la cámara ocupa toda la pantalla.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  // ── Detección en vivo (pausada mientras se revisa la foto) ────────────────
  useEffect(() => {
    if (!ready || shot) return undefined;
    const id = setInterval(() => {
      const v = videoRef.current;
      if (!v || !v.videoWidth || busyRef.current) return;
      if (v.videoWidth !== dims.w || v.videoHeight !== dims.h) setDims({ w: v.videoWidth, h: v.videoHeight });
      try {
        const q = detectDocument(v, v.videoWidth, v.videoHeight);
        detectRef.current = q;
        setQuad(q);
      } catch {
        detectRef.current = null;
      }
    }, 220);
    return () => clearInterval(id);
  }, [ready, shot, dims.w, dims.h]);

  // ── Disparar ──────────────────────────────────────────────────────────────
  const capture = async () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    setWorking(true);
    busyRef.current = true;
    try {
      const frame = document.createElement('canvas');
      frame.width = v.videoWidth;
      frame.height = v.videoHeight;
      frame.getContext('2d').drawImage(v, 0, 0);
      // Se vuelve a detectar sobre la foto quieta (más fino que en vivo).
      const q = detectDocument(frame, frame.width, frame.height, 320) || detectRef.current;
      setShot(await buildPage(frame, frame.width, frame.height, q, filter));
    } catch (e) {
      toast.error(e.message || 'No se pudo capturar');
    } finally {
      busyRef.current = false;
      setWorking(false);
    }
  };

  /** Descarta la foto en revisión (sin guardarla como página). */
  const discardShot = () => {
    if (shot?.preview) URL.revokeObjectURL(shot.preview);
    setShot(null);
  };

  const keepShot = () => {
    onAddPage(shot);
    setAdded((n) => n + 1);
    setShot(null);
  };

  // "Crear PDF": guarda la última página, cierra la cámara y lleva al usuario al
  // cuadro del nombre (el PDF se genera con el botón de ahí, ya con nombre).
  const finish = () => {
    onAddPage(shot);
    setShot(null);
    onClose({ goToSave: true });
  };

  // Reencuadre desde la revisión: recalcula la foto con las esquinas nuevas.
  const recrop = async (newQuad) => {
    setCropping(false);
    setWorking(true);
    try {
      const img = await loadImage(shot.original);
      const warped = warpDocument(img, shot.originalW, shot.originalH, newQuad);
      if (!warped) throw new Error('El recorte no es válido');
      applyFilter(warped, shot.filter);
      const blob = await canvasToJpeg(warped, 0.85);
      URL.revokeObjectURL(shot.preview);
      setShot({ ...shot, blob, preview: URL.createObjectURL(blob), thumb: thumbnailUrl(warped), quad: newQuad, detected: true });
    } catch (e) {
      toast.error(e.message || 'No se pudo reencuadrar');
    } finally {
      setWorking(false);
    }
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
          {shot ? '¿Se ve bien?' : added > 0 ? `${added} página${added === 1 ? '' : 's'} lista${added === 1 ? '' : 's'}` : 'Apunta a la hoja'}
        </p>
        <span className="w-10 shrink-0" />
      </div>

      {/* ── Imagen / vídeo ─────────────────────────────────────────────── */}
      <div className="relative flex-1 min-h-0">
        <video
          ref={videoRef}
          playsInline
          muted
          onLoadedMetadata={(e) => setDims({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight })}
          className={`absolute inset-0 w-full h-full ${shot ? 'invisible' : ''}`}
          style={{ objectFit: 'contain' }}
        />

        {/* Marco verde: se coloca EXACTAMENTE sobre el área del fotograma. */}
        {!shot && quad && box && (
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="absolute pointer-events-none"
            style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
          >
            <polygon
              points={quad.map((p) => `${p.x * 100},${p.y * 100}`).join(' ')}
              fill="rgba(16,185,129,0.16)"
              stroke="#10b981"
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        )}

        {shot && (
          <img src={shot.preview} alt="Foto tomada" className="absolute inset-0 w-full h-full" style={{ objectFit: 'contain' }} />
        )}

        {!shot && ready && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 text-[11px] px-3 py-1.5 rounded-full bg-black/60 text-white whitespace-nowrap">
            {quad ? '✓ Hoja detectada — se recortará sola' : 'Buscando la hoja…'}
          </div>
        )}

        {shot && !shot.detected && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 text-[11px] px-3 py-1.5 rounded-full bg-amber-500 text-white max-w-[90%] text-center">
            No se distinguió la hoja: se guardó la foto completa. Usa «Recortar».
          </div>
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
                <p className="text-sm">{working ? 'Procesando la foto…' : 'Encendiendo la cámara…'}</p>
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Barra inferior ─────────────────────────────────────────────── */}
      {shot ? (
        <div className="shrink-0 bg-black/90 px-3 py-3 space-y-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <OverlayBtn onClick={() => { discardShot(); }} icon={HiOutlineArrowUturnLeft} label="Volver a tomar" />
            <OverlayBtn onClick={() => { discardShot(); onClose(); }} icon={HiOutlineTrash} label="Eliminar" danger />
            <OverlayBtn onClick={keepShot} icon={HiOutlinePlus} label="Añadir página" />
            <OverlayBtn onClick={finish} icon={HiOutlineCheck} label="Crear PDF" primary />
          </div>
          <button
            onClick={() => setCropping(true)}
            className="w-full py-2 text-xs text-white/80 bg-white/10 rounded-lg border-none cursor-pointer flex items-center justify-center gap-1.5"
          >
            <HiOutlineArrowsPointingOut className="w-4 h-4" /> Recortar a mano
          </button>
        </div>
      ) : (
        <div className="shrink-0 bg-black/90 px-3 py-3 space-y-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <div className="flex gap-1.5 overflow-x-auto pb-0.5">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                title={f.hint}
                className={`px-3 py-1.5 rounded-full text-xs font-medium cursor-pointer border whitespace-nowrap ${
                  filter === f.key ? 'bg-emerald-500 text-white border-emerald-500' : 'bg-white/10 text-white/80 border-white/20'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
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

      {cropping && shot && (
        <CropModal
          src={shot.original}
          width={shot.originalW}
          height={shot.originalH}
          initialQuad={shot.quad}
          onCancel={() => setCropping(false)}
          onConfirm={recrop}
        />
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
//  Reencuadre manual: 4 esquinas arrastrables sobre la foto original
// ═════════════════════════════════════════════════════════════════════════════

function CropModal({ src, width, height, initialQuad, onCancel, onConfirm }) {
  const boxRef = useRef(null);
  const [quad, setQuad] = useState(initialQuad || FULL_QUAD);
  const [dragging, setDragging] = useState(null);

  useEffect(() => {
    if (dragging === null) return undefined;
    const move = (e) => {
      const rect = boxRef.current?.getBoundingClientRect();
      if (!rect) return;
      const p = {
        x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
        y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
      };
      setQuad((q) => q.map((c, i) => (i === dragging ? p : c)));
    };
    const up = () => setDragging(null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [dragging]);

  const labels = ['Sup. izq.', 'Sup. der.', 'Inf. der.', 'Inf. izq.'];

  return (
    <Modal isOpen onClose={onCancel} title="Ajustar el recorte" size="lg">
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          Arrastra las cuatro esquinas hasta que el marco calce con la hoja. Lo de afuera se descarta.
        </p>
        {/* La imagen va sin recortes de alto: su caja tiene que coincidir con la
            foto para que las esquinas arrastrables caigan donde el usuario ve. */}
        <div ref={boxRef} className="relative select-none touch-none bg-slate-900 rounded-xl overflow-hidden">
          <img src={src} alt="Original" className="w-full h-auto block" />
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 w-full h-full">
            <polygon
              points={quad.map((p) => `${p.x * 100},${p.y * 100}`).join(' ')}
              fill="rgba(16,185,129,0.2)"
              stroke="#10b981"
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          {quad.map((p, i) => (
            <button
              key={i}
              type="button"
              title={labels[i]}
              onPointerDown={(e) => { e.preventDefault(); setDragging(i); }}
              className="absolute w-8 h-8 -ml-4 -mt-4 rounded-full bg-white border-2 border-emerald-500 shadow cursor-grab touch-none"
              style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
            />
          ))}
        </div>
        <div className="flex flex-col sm:flex-row sm:justify-between gap-2">
          <button type="button" onClick={() => setQuad(FULL_QUAD)} className="btn-secondary justify-center">
            <HiOutlineArrowPath className="w-4 h-4" /> Usar la foto completa
          </button>
          <div className="flex gap-2">
            <button type="button" onClick={onCancel} className="btn-secondary flex-1 justify-center">Cancelar</button>
            <button type="button" onClick={() => onConfirm(quad)} className="btn-primary flex-1 justify-center">
              <HiOutlineCheck className="w-4 h-4" /> Aplicar
            </button>
          </div>
        </div>
        <p className="text-[11px] text-slate-400">Original: {width}×{height} px</p>
      </div>
    </Modal>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
//  LISTA de PDFs generados
// ═════════════════════════════════════════════════════════════════════════════

function DocumentList({ currentUserId }) {
  const { hasRole } = useAuth();
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search, 300);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [selected, setSelected] = useState([]);
  const [renaming, setRenaming] = useState(null);
  const [preview, setPreview] = useState(null);
  const [working, setWorking] = useState(false);

  const fetchDocs = useCallback(async () => {
    try {
      const r = await api.get('/scans', { params: { search: debounced, page, limit: 20 } });
      setDocs(r.data.documents || []);
      setTotalPages(r.data.pages || 1);
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

  const downloadSelected = async () => {
    if (!selected.length) return;
    setWorking(true);
    try {
      await downloadFile('/scans/download-zip', {
        method: 'post',
        data: { ids: selected },
        filename: `escaneos_${new Date().toISOString().slice(0, 10)}.zip`,
      });
      toast.success(`${selected.length} documentos descargados`);
    } catch (e) {
      toast.error(e.message || 'No se pudo preparar el ZIP');
    } finally {
      setWorking(false);
    }
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

  const canDelete = (doc) => hasRole('admin') || String(doc.createdBy?._id || doc.createdBy) === String(currentUserId);

  const Actions = ({ d }) => (
    <>
      <IconBtn title="Ver" onClick={() => openPreview(d)}><HiOutlineEye className="w-4 h-4" /></IconBtn>
      <IconBtn title="Descargar" onClick={() => downloadOne(d)}><HiOutlineArrowDownTray className="w-4 h-4" /></IconBtn>
      <IconBtn title="Renombrar" onClick={() => setRenaming(d)}><HiOutlinePencil className="w-4 h-4" /></IconBtn>
      {canDelete(d) && (
        <IconBtn title="Eliminar" onClick={() => remove(d)} danger><HiOutlineTrash className="w-4 h-4" /></IconBtn>
      )}
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
