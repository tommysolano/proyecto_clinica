import { useState, useEffect, useRef, useCallback } from 'react';
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
  HiOutlineArrowLeft,
  HiOutlineArrowRight,
  HiOutlineCheck,
  HiOutlineXMark,
  HiOutlineArrowPath,
} from 'react-icons/hi2';

const FILTERS = [
  { key: 'documento', label: 'Documento', hint: 'Fondo blanco parejo, sin sombras' },
  { key: 'bn', label: 'Blanco y negro', hint: 'Solo texto, archivo liviano' },
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
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-emerald-100 text-emerald-700 flex items-center justify-center shadow-sm">
            <HiOutlineDocumentText className="w-6 h-6" />
          </div>
          <div>
            <h1 className="page-title">Escáner de documentos</h1>
            <p className="page-subtitle">Toma fotos de una hoja y conviértelas en un PDF</p>
          </div>
        </div>
        <div className="flex gap-1 bg-slate-100 rounded-xl p-1">
          {[
            { k: 'escanear', l: 'Escanear' },
            { k: 'documentos', l: 'Mis documentos' },
          ].map((t) => (
            <button
              key={t.k}
              onClick={() => setTab(t.k)}
              className={`px-4 py-2 rounded-lg text-sm font-medium cursor-pointer border-none ${
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
//  ESCANEAR: cámara con detección en vivo → páginas → PDF
// ═════════════════════════════════════════════════════════════════════════════

function ScanStudio({ pages, setPages, onSaved }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const detectRef = useRef(null);   // último cuadrilátero detectado (relativo)
  const busyRef = useRef(false);

  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [starting, setStarting] = useState(false);
  const [quad, setQuad] = useState(null);
  const [filter, setFilter] = useState('documento');
  const [capturing, setCapturing] = useState(false);
  const [cropping, setCropping] = useState(null); // { pageId, src, w, h, quad }
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef(null);

  // ── Cámara ────────────────────────────────────────────────────────────────
  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraOn(false);
    setQuad(null);
  }, []);

  const startCamera = useCallback(async () => {
    setCameraError('');
    setStarting(true);
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Este navegador no permite usar la cámara. Puedes subir fotos desde el dispositivo.');
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      setCameraOn(true);
    } catch (e) {
      const msg =
        e.name === 'NotAllowedError'
          ? 'No diste permiso para usar la cámara. Habilítala en el navegador y vuelve a intentar.'
          : e.name === 'NotFoundError'
            ? 'Este equipo no tiene cámara. Puedes subir fotos desde el dispositivo.'
            : e.message || 'No se pudo abrir la cámara';
      setCameraError(msg);
    } finally {
      setStarting(false);
    }
  }, []);

  useEffect(() => () => stopCamera(), [stopCamera]);

  // ── Detección en vivo: analiza el cuadro ANTES de disparar ────────────────
  useEffect(() => {
    if (!cameraOn || cropping) return undefined;
    let alive = true;
    const tick = () => {
      if (!alive) return;
      const v = videoRef.current;
      if (v && v.videoWidth && !busyRef.current) {
        try {
          const q = detectDocument(v, v.videoWidth, v.videoHeight);
          detectRef.current = q;
          setQuad(q);
        } catch {
          detectRef.current = null;
        }
      }
    };
    const id = setInterval(tick, 220);
    return () => { alive = false; clearInterval(id); };
  }, [cameraOn, cropping]);

  // ── Convertir un fotograma/imagen en página ───────────────────────────────
  const addPageFrom = useCallback(async (source, sw, sh, detectedQuad) => {
    const useQuad = detectedQuad || FULL_QUAD;
    const warped = warpDocument(source, sw, sh, useQuad);
    if (!warped) throw new Error('No se pudo recortar la imagen');
    applyFilter(warped, filter);
    const blob = await canvasToJpeg(warped, 0.85);

    // El original se guarda reducido para poder reencuadrar después sin
    // quedarnos con fotos de 5 MP en memoria por cada página.
    const orig = document.createElement('canvas');
    const k = Math.min(1, 1600 / Math.max(sw, sh));
    orig.width = Math.round(sw * k);
    orig.height = Math.round(sh * k);
    orig.getContext('2d').drawImage(source, 0, 0, orig.width, orig.height);

    setPages((prev) => [
      ...prev,
      {
        id: `p${++pageSeq}`,
        blob,
        thumb: thumbnailUrl(warped),
        original: orig.toDataURL('image/jpeg', 0.8),
        originalW: orig.width,
        originalH: orig.height,
        quad: useQuad,
        filter,
        detected: !!detectedQuad,
      },
    ]);
  }, [filter, setPages]);

  const capture = async () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    setCapturing(true);
    busyRef.current = true;
    try {
      // Fotograma congelado a resolución completa.
      const frame = document.createElement('canvas');
      frame.width = v.videoWidth;
      frame.height = v.videoHeight;
      frame.getContext('2d').drawImage(v, 0, 0);
      // Se vuelve a detectar sobre la foto quieta (más fino que en vivo).
      const q = detectDocument(frame, frame.width, frame.height, 320) || detectRef.current;
      await addPageFrom(frame, frame.width, frame.height, q);
      if (!q) toast('No se distinguió la hoja: se guardó la foto completa. Usa "Reencuadrar".', { icon: '✂️' });
    } catch (e) {
      toast.error(e.message || 'No se pudo capturar');
    } finally {
      busyRef.current = false;
      setCapturing(false);
    }
  };

  const addFromFiles = async (files) => {
    setCapturing(true);
    try {
      for (const file of files) {
        const img = await loadImage(file);
        const q = detectDocument(img, img.naturalWidth, img.naturalHeight, 320);
        await addPageFrom(img, img.naturalWidth, img.naturalHeight, q);
      }
    } catch (e) {
      toast.error(e.message || 'No se pudieron leer las imágenes');
    } finally {
      setCapturing(false);
    }
  };

  const removePage = (id) => setPages((p) => p.filter((x) => x.id !== id));
  const movePage = (id, dir) =>
    setPages((prev) => {
      const i = prev.findIndex((p) => p.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const openCrop = (page) =>
    setCropping({ pageId: page.id, src: page.original, w: page.originalW, h: page.originalH, quad: page.quad });

  const applyCrop = async (newQuad) => {
    const page = pages.find((p) => p.id === cropping.pageId);
    if (!page) return setCropping(null);
    try {
      const img = await loadImage(page.original);
      const warped = warpDocument(img, page.originalW, page.originalH, newQuad);
      if (!warped) throw new Error('El recorte no es válido');
      applyFilter(warped, page.filter);
      const blob = await canvasToJpeg(warped, 0.85);
      setPages((prev) =>
        prev.map((p) => (p.id === page.id ? { ...p, blob, thumb: thumbnailUrl(warped), quad: newQuad, detected: true } : p))
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
      setPages([]);
      setName('');
      stopCamera();
      onSaved?.();
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudo crear el PDF');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* ── Cámara ─────────────────────────────────────────────────────────── */}
      <div className="lg:col-span-2 space-y-4">
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 p-4 space-y-3">
          <div className="relative bg-slate-900 rounded-xl overflow-hidden">
            {/* Sin max-height ni object-fit: la caja del vídeo debe medir
                EXACTAMENTE lo que el fotograma, o el marco verde (que se dibuja
                en coordenadas relativas encima) quedaría desplazado. */}
            <video
              ref={videoRef}
              playsInline
              muted
              className={`w-full h-auto block ${cameraOn ? '' : 'hidden'}`}
            />
            {/* El marco verde se dibuja en coordenadas relativas sobre el vídeo. */}
            {cameraOn && quad && (
              <svg
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                className="absolute inset-0 w-full h-full pointer-events-none"
              >
                <polygon
                  points={quad.map((p) => `${p.x * 100},${p.y * 100}`).join(' ')}
                  fill="rgba(16,185,129,0.18)"
                  stroke="#10b981"
                  strokeWidth="0.6"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
            )}
            {cameraOn && (
              <div className="absolute top-2 left-2 text-[11px] px-2 py-1 rounded-full bg-black/55 text-white">
                {quad ? '✓ Hoja detectada — se recortará sola' : 'Buscando la hoja…'}
              </div>
            )}
            {!cameraOn && (
              <div className="flex flex-col items-center justify-center gap-3 py-16 px-4 text-center">
                <HiOutlineCamera className="w-12 h-12 text-slate-500" />
                <p className="text-slate-300 text-sm max-w-md">
                  Enciende la cámara y apunta a la hoja. El sistema detecta sus bordes y recorta
                  automáticamente, ignorando la mesa y todo lo que esté alrededor.
                </p>
                {cameraError && <p className="text-amber-300 text-xs max-w-md">{cameraError}</p>}
                <button onClick={startCamera} disabled={starting} className="btn-primary">
                  {starting ? <Spinner /> : <HiOutlineCamera className="w-5 h-5" />} Encender cámara
                </button>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {cameraOn && (
              <>
                <button onClick={capture} disabled={capturing} className="btn-primary">
                  {capturing ? <Spinner /> : <HiOutlineCamera className="w-5 h-5" />} Capturar página
                </button>
                <button onClick={stopCamera} className="btn-secondary">
                  <HiOutlineXMark className="w-4 h-4" /> Apagar cámara
                </button>
              </>
            )}
            <button onClick={() => fileInputRef.current?.click()} className="btn-secondary" disabled={capturing}>
              <HiOutlinePhoto className="w-4 h-4" /> Subir fotos
            </button>
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

          <div>
            <p className="text-xs font-medium text-slate-500 mb-1.5">Modo de imagen (se aplica al capturar)</p>
            <div className="flex flex-wrap gap-2">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key)}
                  title={f.hint}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer border ${
                    filter === f.key
                      ? 'bg-emerald-600 text-white border-emerald-600'
                      : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ── Páginas + guardar ──────────────────────────────────────────────── */}
      <div className="space-y-4">
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-slate-800 text-sm">Páginas ({pages.length})</h2>
            {pages.length > 0 && (
              <button
                onClick={() => setPages([])}
                className="text-xs text-rose-600 bg-transparent border-none cursor-pointer p-0"
              >
                Vaciar
              </button>
            )}
          </div>

          {pages.length === 0 ? (
            <p className="text-xs text-slate-400 py-6 text-center">
              Todavía no hay páginas. Captura la primera y se irán acumulando aquí en orden.
            </p>
          ) : (
            <div className="space-y-2 max-h-[46vh] overflow-y-auto pr-1">
              {pages.map((p, i) => (
                <div key={p.id} className="flex gap-2 items-start bg-slate-50 rounded-xl p-2 border border-slate-200">
                  <img src={p.thumb} alt={`Página ${i + 1}`} className="w-16 rounded-lg border border-slate-200 bg-white" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-slate-700">Página {i + 1}</p>
                    <p className="text-[11px] text-slate-400">
                      {p.detected ? 'Recortada automáticamente' : 'Sin recorte'}
                    </p>
                    <div className="flex flex-wrap gap-1 mt-1">
                      <IconBtn title="Reencuadrar" onClick={() => openCrop(p)}>
                        <HiOutlineArrowsPointingOut className="w-3.5 h-3.5" />
                      </IconBtn>
                      <IconBtn title="Subir" onClick={() => movePage(p.id, -1)} disabled={i === 0}>
                        <HiOutlineArrowLeft className="w-3.5 h-3.5 rotate-90" />
                      </IconBtn>
                      <IconBtn title="Bajar" onClick={() => movePage(p.id, 1)} disabled={i === pages.length - 1}>
                        <HiOutlineArrowRight className="w-3.5 h-3.5 rotate-90" />
                      </IconBtn>
                      <IconBtn title="Quitar" onClick={() => removePage(p.id)} danger>
                        <HiOutlineTrash className="w-3.5 h-3.5" />
                      </IconBtn>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 p-4 space-y-3">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Nombre del archivo</label>
            <input
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
//  Reencuadre manual: 4 esquinas arrastrables sobre la foto original
// ═════════════════════════════════════════════════════════════════════════════

function CropModal({ src, width, height, initialQuad, onCancel, onConfirm }) {
  const boxRef = useRef(null);
  const [quad, setQuad] = useState(initialQuad || FULL_QUAD);
  const [dragging, setDragging] = useState(null);

  const pointToRelative = (e) => {
    const rect = boxRef.current.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  };

  useEffect(() => {
    if (dragging === null) return undefined;
    const move = (e) => {
      const p = pointToRelative(e);
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
              strokeWidth="0.5"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          {quad.map((p, i) => (
            <button
              key={i}
              type="button"
              title={labels[i]}
              onPointerDown={(e) => { e.preventDefault(); setDragging(i); }}
              className="absolute w-7 h-7 -ml-3.5 -mt-3.5 rounded-full bg-white border-2 border-emerald-500 shadow cursor-grab touch-none"
              style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
            />
          ))}
        </div>
        <div className="flex flex-wrap justify-between gap-2">
          <button type="button" onClick={() => setQuad(FULL_QUAD)} className="btn-secondary">
            <HiOutlineArrowPath className="w-4 h-4" /> Usar la foto completa
          </button>
          <div className="flex gap-2">
            <button type="button" onClick={onCancel} className="btn-secondary">Cancelar</button>
            <button type="button" onClick={() => onConfirm(quad)} className="btn-primary">
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
  const [preview, setPreview] = useState(null); // { url, name }
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

  const toggle = (id) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const allShown = docs.length > 0 && docs.every((d) => selected.includes(d._id));

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

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 p-4">
        <div className="flex gap-3 items-center flex-wrap">
          <div className="relative flex-1 min-w-[240px]">
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
            className="btn-primary disabled:opacity-40"
          >
            {working ? <Spinner /> : <HiOutlineArrowDownTray className="w-4 h-4" />}
            Descargar {selected.length ? `(${selected.length})` : 'seleccionados'}
          </button>
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr className="bg-emerald-50/50 border-b border-emerald-100">
                <th className="px-4 py-3.5 w-10">
                  <input
                    type="checkbox"
                    checked={allShown}
                    onChange={() =>
                      setSelected((s) =>
                        allShown ? s.filter((id) => !docs.some((d) => d._id === id)) : [...new Set([...s, ...docs.map((d) => d._id)])]
                      )
                    }
                    className="w-4 h-4 accent-emerald-600 cursor-pointer"
                  />
                </th>
                <th className="text-left px-4 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Nombre</th>
                <th className="text-left px-4 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Páginas</th>
                <th className="text-left px-4 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider hidden md:table-cell">Tamaño</th>
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
                      <input
                        type="checkbox"
                        checked={selected.includes(d._id)}
                        onChange={() => toggle(d._id)}
                        className="w-4 h-4 accent-emerald-600 cursor-pointer"
                      />
                    </td>
                    <td className="px-4 py-3.5 text-sm font-medium text-slate-800">
                      {d.name}
                      <div className="text-[11px] text-slate-400 font-normal">{fmtDate(d.createdAt)}</div>
                    </td>
                    <td className="px-4 py-3.5 text-sm text-slate-600">{d.pages}</td>
                    <td className="px-4 py-3.5 text-sm text-slate-600 hidden md:table-cell">{fmtSize(d.size)}</td>
                    <td className="px-4 py-3.5 text-sm text-slate-600 hidden lg:table-cell">{d.createdBy?.name || '—'}</td>
                    <td className="px-4 py-3.5 text-right whitespace-nowrap">
                      <IconBtn title="Ver" onClick={() => openPreview(d)}><HiOutlineEye className="w-4 h-4" /></IconBtn>
                      <span className="inline-block w-1" />
                      <IconBtn title="Descargar" onClick={() => downloadOne(d)}><HiOutlineArrowDownTray className="w-4 h-4" /></IconBtn>
                      <span className="inline-block w-1" />
                      <IconBtn title="Renombrar" onClick={() => setRenaming(d)}><HiOutlinePencil className="w-4 h-4" /></IconBtn>
                      {canDelete(d) && (
                        <>
                          <span className="inline-block w-1" />
                          <IconBtn title="Eliminar" onClick={() => remove(d)} danger><HiOutlineTrash className="w-4 h-4" /></IconBtn>
                        </>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 px-6 py-4 border-t border-emerald-100">
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="btn-secondary disabled:opacity-50">Anterior</button>
            <span className="text-sm text-slate-500">Página {page} de {totalPages}</span>
            <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="btn-secondary disabled:opacity-50">Siguiente</button>
          </div>
        )}
      </div>

      {renaming && (
        <RenameModal doc={renaming} onClose={() => setRenaming(null)} onSave={saveRename} />
      )}

      {preview && (
        <Modal isOpen onClose={() => setPreview(null)} title={preview.name} size="xl">
          <iframe title={preview.name} src={preview.url} className="w-full rounded-xl border border-slate-200" style={{ height: '72vh' }} />
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
