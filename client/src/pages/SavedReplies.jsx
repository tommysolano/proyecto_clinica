import { useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import {
  HiOutlineChatBubbleBottomCenterText,
  HiOutlinePlus,
  HiOutlinePencilSquare,
  HiOutlineTrash,
  HiOutlineFolder,
  HiOutlinePaperClip,
  HiOutlinePaperAirplane,
  HiOutlineXMark,
  HiOutlineFilm,
  HiOutlinePhoto,
  HiOutlineDocument,
} from 'react-icons/hi2';
import api from '../api/axios';
import Modal from '../components/Modal';
import WhatsappTextArea from '../components/WhatsappTextArea';
import FolderExplorer, { normFolderPath, MoveToFolderMenu } from '../components/FolderExplorer';
import { fmtDateTime } from '../utils/date';

// Convierte los marcadores de WhatsApp (*negrita*, _cursiva_, ~tachado~) a HTML
// para la vista previa. Escapa el HTML primero: el texto es del usuario.
function waFormatHtml(text) {
  const esc = String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return esc
    .replace(/\*([^*\n]+)\*/g, '<b>$1</b>')
    .replace(/_([^_\n]+)_/g, '<i>$1</i>')
    .replace(/~([^~\n]+)~/g, '<s>$1</s>')
    .replace(/\n/g, '<br/>');
}

const ATTACH_META = {
  image: { label: 'Imagen', icon: HiOutlinePhoto, chip: 'bg-sky-100 text-sky-700' },
  video: { label: 'Video', icon: HiOutlineFilm, chip: 'bg-violet-100 text-violet-700' },
  document: { label: 'Documento', icon: HiOutlineDocument, chip: 'bg-slate-100 text-slate-600' },
};

function typeOf(reply) {
  return reply.attachment?.url ? reply.attachment.type || 'document' : 'text';
}

export default function SavedReplies() {
  const [list, setList] = useState([]);
  const [folders, setFolders] = useState([]); // carpetas persistidas (registro)
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null); // reply en edición o null (nuevo)
  const [newFolder, setNewFolder] = useState(''); // carpeta destino al crear desde una carpeta

  const load = async () => {
    try {
      setLoading(true);
      const [r, f] = await Promise.all([
        api.get('/chats/saved-replies'),
        api.get('/chats/saved-replies/folders').catch(() => ({ data: [] })),
      ]);
      setList(r.data || []);
      setFolders(f.data || []);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al cargar mensajes guardados');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const registryPaths = useMemo(() => folders.map((f) => f.name), [folders]);

  // Opciones para el datalist del modal: rutas del registro ∪ de los mensajes.
  const folderOptions = useMemo(() => {
    const set = new Set(registryPaths.map(normFolderPath).filter(Boolean));
    list.forEach((r) => { const f = normFolderPath(r.folder); if (f) set.add(f); });
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [registryPaths, list]);

  // Crea la carpeta (y sus ancestros) en el registro para que persista aunque esté vacía.
  const createFolder = async (full) => {
    try {
      await api.post('/chats/saved-replies/folders', { name: full });
      setFolders((prev) => {
        const names = new Set(prev.map((f) => f.name));
        const segs = full.split('/');
        const add = [];
        for (let i = 0; i < segs.length; i++) {
          const p = segs.slice(0, i + 1).join('/');
          if (!names.has(p)) add.push({ _id: p, name: p });
        }
        return [...prev, ...add];
      });
      return true;
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudo crear la carpeta');
      return false;
    }
  };

  // `mode`: 'empty' (vacía) | 'move' (los mensajes suben un nivel) | 'purge' (se
  // borran también). Lo elige el usuario en el diálogo del explorador.
  const deleteFolder = async (full, mode = 'empty') => {
    try {
      const { data } = await api.delete('/chats/saved-replies/folders', { params: { path: full, mode } });
      setFolders((prev) => prev.filter((f) => f.name !== full && !f.name.startsWith(full + '/')));
      if (data?.deletedItems) toast.success(`Carpeta y ${data.deletedItems} mensaje(s) eliminados`);
      else if (data?.movedItems) toast.success(`Carpeta eliminada · ${data.movedItems} mensaje(s) movidos a ${data.movedTo || 'Sin carpeta'}`);
      else toast.success('Carpeta eliminada');
      load(); // los mensajes cambiaron de carpeta (o ya no están)
      return true;
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudo eliminar la carpeta');
      return false;
    }
  };

  const renameFolder = async (full, name) => {
    try {
      const { data } = await api.put('/chats/saved-replies/folders', { path: full, name });
      toast.success(`Carpeta renombrada a "${name}"`);
      setFolders((prev) =>
        prev.map((f) =>
          f.name === full || f.name.startsWith(full + '/')
            ? { ...f, name: data.to + f.name.slice(full.length) }
            : f
        )
      );
      load(); // los mensajes de dentro cambiaron de ruta
      return true;
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudo renombrar la carpeta');
      return false;
    }
  };

  // Mueve un mensaje guardado a otra carpeta (o a "Sin carpeta" con '').
  const moveToFolder = async (r, folder) => {
    try {
      const { data } = await api.put(`/chats/saved-replies/${r._id}`, { folder });
      setList((prev) => prev.map((x) => (x._id === r._id ? data : x)));
      toast.success(folder ? `Movido a "${folder}"` : 'Movido a Sin carpeta');
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo mover');
    }
  };

  const remove = async (r) => {
    if (!window.confirm(`¿Eliminar el mensaje guardado "${r.title || `/${r.shortcut}`}"? Podrás restaurarlo desde la papelera de reciclaje.`)) return;
    try {
      await api.delete(`/chats/saved-replies/${r._id}`);
      setList((prev) => prev.filter((x) => x._id !== r._id));
      toast.success('Movido a la papelera de reciclaje');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al eliminar');
    }
  };

  const openNew = (currentPath) => {
    setEditing(null);
    setNewFolder(currentPath || '');
    setModalOpen(true);
  };

  const matchItem = (r, q) =>
    (r.title || '').toLowerCase().includes(q) ||
    (r.shortcut || '').toLowerCase().includes(q) ||
    (r.body || '').toLowerCase().includes(q) ||
    normFolderPath(r.folder).toLowerCase().includes(q);

  return (
    <div>
      <div className="flex items-center justify-between flex-wrap gap-2 mb-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
            <HiOutlineChatBubbleBottomCenterText className="text-emerald-600" /> Mensajes Guardados
          </h1>
          <p className="text-xs text-slate-500">
            Organiza tus fragmentos en carpetas y subcarpetas. En el chat se insertan
            escribiendo <code className="font-mono bg-slate-100 px-1 py-0.5 rounded">/atajo</code>.
          </p>
        </div>
      </div>

      <FolderExplorer
        rootLabel="Mensajes Guardados"
        items={list}
        getFolder={(r) => r.folder}
        matchItem={matchItem}
        registryPaths={registryPaths}
        itemNoun="mensaje(s)"
        onCreateFolder={createFolder}
        onDeleteFolder={deleteFolder}
        onRenameFolder={renameFolder}
        searchPlaceholder="Buscar en todas las carpetas..."
        toolbar={(currentPath) => (
          <button
            onClick={() => openNew(currentPath)}
            className="px-3 py-1.5 text-sm bg-emerald-600 text-white rounded-lg shadow-sm shadow-emerald-600/20 hover:bg-emerald-700 flex items-center gap-1 border-none cursor-pointer whitespace-nowrap"
          >
            <HiOutlinePlus className="w-4 h-4" /> Nuevo mensaje guardado
          </button>
        )}
        renderItems={({ rows, showFolderColumn, emptyText, folders: allFolders }) => (
          <SavedRepliesTable
            loading={loading}
            rows={rows}
            showFolderColumn={showFolderColumn}
            folders={allFolders}
            onMove={moveToFolder}
            onEdit={(r) => { setEditing(r); setNewFolder(''); setModalOpen(true); }}
            onRemove={remove}
            emptyText={
              list.length === 0
                ? 'Aún no hay mensajes guardados. Crea el primero con “Nuevo mensaje guardado”.'
                : emptyText
            }
          />
        )}
      />

      {modalOpen && (
        <SavedReplyModal
          reply={editing}
          folders={folderOptions}
          defaultFolder={editing ? '' : newFolder}
          onClose={() => setModalOpen(false)}
          onSaved={(saved) => {
            setList((prev) => {
              const exists = prev.some((x) => x._id === saved._id);
              return exists ? prev.map((x) => (x._id === saved._id ? saved : x)) : [saved, ...prev];
            });
            setModalOpen(false);
          }}
        />
      )}
    </div>
  );
}

// Tabla de mensajes guardados reutilizable (para la carpeta actual o la búsqueda).
function SavedRepliesTable({ loading, rows, showFolderColumn, folders = [], onMove, onEdit, onRemove, emptyText }) {
  const cols = showFolderColumn ? 6 : 5;
  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 text-left text-xs text-slate-500 uppercase tracking-wide">
              <th className="px-4 py-2.5 font-semibold">Nombre</th>
              <th className="px-4 py-2.5 font-semibold">Cuerpo</th>
              <th className="px-4 py-2.5 font-semibold">Tipo</th>
              {showFolderColumn && <th className="px-4 py-2.5 font-semibold">Carpeta</th>}
              <th className="px-4 py-2.5 font-semibold">Actualización</th>
              <th className="px-4 py-2.5 font-semibold text-right">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={cols} className="px-4 py-8 text-center text-slate-400">Cargando...</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={cols} className="px-4 py-10 text-center text-slate-400 text-sm">{emptyText}</td></tr>
            ) : (
              rows.map((r) => {
                const t = typeOf(r);
                const meta = ATTACH_META[t];
                return (
                  <tr key={r._id} className="border-t border-slate-100 hover:bg-slate-50/60">
                    <td className="px-4 py-2.5 align-top">
                      <div className="font-semibold text-slate-700">{r.title || '—'}</div>
                      <span className="text-[11px] font-mono bg-emerald-50 text-emerald-700 px-1.5 py-0.5 rounded">/{r.shortcut}</span>
                    </td>
                    <td className="px-4 py-2.5 align-top max-w-md">
                      <div className="text-slate-600 text-xs whitespace-pre-wrap break-words line-clamp-2">{r.body}</div>
                      {r.attachment?.url && (
                        <div className="text-[11px] text-slate-400 mt-0.5 flex items-center gap-1">
                          <HiOutlinePaperClip className="w-3 h-3" /> {r.attachment.name || 'Adjunto'}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2.5 align-top">
                      {meta ? (
                        <span className={`text-[11px] px-2 py-0.5 rounded-full inline-flex items-center gap-1 ${meta.chip}`}>
                          <meta.icon className="w-3.5 h-3.5" /> {meta.label}
                        </span>
                      ) : (
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">Texto</span>
                      )}
                    </td>
                    {showFolderColumn && (
                      <td className="px-4 py-2.5 align-top text-xs text-slate-500">
                        {r.folder ? (
                          <span className="inline-flex items-center gap-1"><HiOutlineFolder className="w-3.5 h-3.5" /> {r.folder}</span>
                        ) : '—'}
                      </td>
                    )}
                    <td className="px-4 py-2.5 align-top text-xs text-slate-500 whitespace-nowrap">{fmtDateTime(r.updatedAt)}</td>
                    <td className="px-4 py-2.5 align-top text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1 justify-end">
                        <MoveToFolderMenu
                          currentFolder={r.folder}
                          folders={folders}
                          onMove={(target) => onMove(r, target)}
                        />
                        <button
                          onClick={() => onEdit(r)}
                          title="Editar"
                          className="p-1.5 text-slate-500 hover:text-emerald-700 hover:bg-emerald-50 rounded-lg bg-transparent border-none cursor-pointer"
                        >
                          <HiOutlinePencilSquare className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => onRemove(r)}
                          title="Eliminar"
                          className="p-1.5 text-slate-500 hover:text-rose-600 hover:bg-rose-50 rounded-lg bg-transparent border-none cursor-pointer"
                        >
                          <HiOutlineTrash className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ===================== Modal crear/editar =====================

function SavedReplyModal({ reply, folders, defaultFolder = '', onClose, onSaved }) {
  const [form, setForm] = useState({
    title: reply?.title || '',
    shortcut: reply?.shortcut || '',
    folder: reply?.folder || defaultFolder || '',
    body: reply?.body || '',
    attachment: reply?.attachment?.url ? { ...reply.attachment } : null,
  });
  const [shortcutTouched, setShortcutTouched] = useState(!!reply);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [testPhone, setTestPhone] = useState('');
  const [testing, setTesting] = useState(false);
  const fileRef = useRef(null);

  // Atajo autoderivado del nombre mientras el usuario no lo edite a mano.
  const autoShortcut = (name) =>
    name
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/[^a-z0-9_-]/g, '')
      .slice(0, 40);

  const setTitle = (title) => {
    setForm((f) => ({
      ...f,
      title,
      shortcut: shortcutTouched ? f.shortcut : autoShortcut(title),
    }));
  };

  const uploadFile = (file) => {
    if (!file) return;
    const isImage = file.type.startsWith('image/');
    const isVideo = file.type.startsWith('video/');
    if (!isImage && !isVideo) return toast.error('Solo imágenes o videos');
    if (isImage && file.size > 6 * 1024 * 1024) return toast.error('Imagen: máximo 6MB');
    if (isVideo && file.size > 32 * 1024 * 1024) return toast.error('Video: máximo 32MB');
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        setUploading(true);
        const r = await api.post('/chats/saved-replies/upload', { name: file.name, dataUrl: ev.target.result });
        setForm((f) => ({ ...f, attachment: { url: r.data.url, type: r.data.type, name: file.name } }));
        toast.success('Adjunto subido');
      } catch (err) {
        toast.error(err.response?.data?.message || 'Error al subir adjunto');
      } finally {
        setUploading(false);
      }
    };
    reader.readAsDataURL(file);
  };

  const addUrlAttachment = () => {
    const url = urlInput.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) return toast.error('La URL debe empezar con http(s)://');
    const lower = url.toLowerCase().split('?')[0];
    const type = /\.(png|jpe?g|webp|gif)$/.test(lower)
      ? 'image'
      : /\.(mp4|mov|3gp|webm)$/.test(lower)
        ? 'video'
        : 'document';
    setForm((f) => ({ ...f, attachment: { url, type, name: url.split('/').pop() || 'archivo' } }));
    setUrlInput('');
  };

  const save = async () => {
    if (!form.title.trim()) return toast.error('El nombre es requerido');
    if (!form.body.trim() && !form.attachment) return toast.error('Escribe el cuerpo del mensaje');
    setSaving(true);
    try {
      const payload = {
        title: form.title.trim(),
        shortcut: form.shortcut || autoShortcut(form.title),
        folder: form.folder.trim(),
        body: form.body,
        attachment: form.attachment || { url: '', type: '', name: '' },
      };
      const r = reply
        ? await api.put(`/chats/saved-replies/${reply._id}`, payload)
        : await api.post('/chats/saved-replies', payload);
      toast.success('Guardado');
      onSaved(r.data);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    if (!testPhone.trim()) return toast.error('Escribe el número de prueba (con código de país)');
    if (!form.body.trim() && !form.attachment) return toast.error('El fragmento está vacío');
    setTesting(true);
    try {
      await api.post('/chats/saved-replies/test', {
        phone: testPhone,
        body: form.body,
        attachment: form.attachment || undefined,
      });
      toast.success('Prueba enviada');
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo enviar la prueba');
    } finally {
      setTesting(false);
    }
  };

  const chars = form.body.length;
  const words = form.body.trim() ? form.body.trim().split(/\s+/).length : 0;
  const attMeta = form.attachment ? ATTACH_META[form.attachment.type] || ATTACH_META.document : null;

  return (
    <Modal isOpen onClose={onClose} title={reply ? 'Editar mensaje guardado' : 'Crear mensaje guardado'} size="2xl">
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_260px] gap-6">
        {/* Columna izquierda: formulario */}
        <div className="space-y-3 min-w-0">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold text-slate-600 block mb-1">Nombre *</label>
              <input
                value={form.title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Introduzca el nombre del fragmento"
                className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-600 block mb-1">Atajo en el chat</label>
              <div className="flex items-center border border-slate-200 rounded-xl overflow-hidden bg-white">
                <span className="px-2 text-slate-400 text-sm font-mono">/</span>
                <input
                  value={form.shortcut}
                  onChange={(e) => {
                    setShortcutTouched(true);
                    setForm((f) => ({ ...f, shortcut: autoShortcut(e.target.value) || e.target.value.toLowerCase().replace(/\s/g, '_') }));
                  }}
                  placeholder="atajo_rapido"
                  className="flex-1 py-2 pr-3 text-sm font-mono border-none outline-none"
                />
              </div>
            </div>
          </div>

          <div>
            <label className="text-xs font-semibold text-slate-600 block mb-1">Carpeta</label>
            <input
              list="saved-reply-folders"
              value={form.folder}
              onChange={(e) => setForm((f) => ({ ...f, folder: e.target.value }))}
              placeholder="Sin carpeta — usa / para subcarpetas (ej. CITA/Recordatorios)"
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm"
            />
            <datalist id="saved-reply-folders">
              {folders.map((f) => <option key={f} value={f} />)}
            </datalist>
            <p className="text-[10px] text-slate-400 mt-1">
              Usa <code className="font-mono">/</code> para anidar (ej. <code className="font-mono">CITA/Recordatorios</code>). La carpeta se crea sola al guardar.
            </p>
          </div>

          <div>
            <label className="text-xs font-semibold text-slate-600 block mb-1">Cuerpo del mensaje *</label>
            <WhatsappTextArea
              value={form.body}
              onChange={(body) => setForm((f) => ({ ...f, body }))}
              rows={6}
              placeholder="Escriba un mensaje"
            />
            <div className="text-[11px] text-slate-400 text-right -mt-3">
              {chars} caracteres | {words} palabras
            </div>
          </div>

          {/* Adjunto */}
          <div className="border border-slate-200 rounded-xl p-3 space-y-2">
            <div className="text-xs font-semibold text-slate-600 flex items-center gap-1">
              <HiOutlinePaperClip className="w-4 h-4" /> Adjunto (imagen o video)
            </div>
            {form.attachment ? (
              <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-2">
                {attMeta && <attMeta.icon className="w-4 h-4 text-slate-500 shrink-0" />}
                <span className="text-xs text-slate-600 truncate flex-1">{form.attachment.name || form.attachment.url}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${attMeta?.chip || ''}`}>{attMeta?.label}</span>
                <button
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, attachment: null }))}
                  title="Quitar adjunto"
                  className="text-slate-400 hover:text-rose-600 bg-transparent border-none cursor-pointer p-0.5"
                >
                  <HiOutlineXMark className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*,video/*"
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) uploadFile(f); }}
                />
                <button
                  type="button"
                  disabled={uploading}
                  onClick={() => fileRef.current?.click()}
                  className="w-full text-xs py-2 rounded-lg border border-dashed border-emerald-300 text-emerald-700 bg-emerald-50/40 hover:bg-emerald-100 cursor-pointer disabled:opacity-50"
                >
                  {/* Un video puede tardar: si no viene en el formato que
                      WhatsApp entrega (H.264), el servidor lo convierte al
                      subirlo. Vale la pena avisar para que nadie crea que se
                      colgó. */}
                  {uploading ? 'Subiendo y preparando el archivo…' : '↥ Añadir adjunto (imagen máx 6MB, video máx 32MB)'}
                </button>
                <p className="text-[10px] text-slate-400 mt-1">
                  Los videos se convierten solos al formato que WhatsApp acepta (H.264); si es grande, la subida tarda un poco.
                </p>
                <div className="flex gap-2">
                  <input
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                    placeholder="…o añadir archivo a través de URL"
                    className="flex-1 border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs"
                  />
                  <button
                    type="button"
                    onClick={addUrlAttachment}
                    className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg bg-white hover:bg-slate-50 cursor-pointer whitespace-nowrap"
                  >
                    + Añadir
                  </button>
                </div>
              </>
            )}
          </div>

          {/* Fragmento de prueba */}
          <div className="border border-slate-200 rounded-xl p-3 space-y-2">
            <div className="text-xs font-semibold text-slate-600">Fragmento de prueba</div>
            <div className="flex gap-2">
              <input
                value={testPhone}
                onChange={(e) => setTestPhone(e.target.value)}
                placeholder="Introducir el número de teléfono (ej. 5939…)"
                className="flex-1 border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs"
              />
              <button
                type="button"
                disabled={testing}
                onClick={sendTest}
                className="px-3 py-1.5 text-xs border border-emerald-200 text-emerald-700 rounded-lg bg-white hover:bg-emerald-50 cursor-pointer flex items-center gap-1 disabled:opacity-50 whitespace-nowrap"
              >
                <HiOutlinePaperAirplane className="w-3.5 h-3.5" /> {testing ? 'Enviando…' : 'Enviar'}
              </button>
            </div>
            <p className="text-[10px] text-slate-400">
              Envía este fragmento tal cual a un número de WhatsApp para verificarlo antes de guardarlo.
            </p>
          </div>
        </div>

        {/* Columna derecha: vista previa estilo teléfono */}
        <div className="hidden lg:block">
          <PhonePreview body={form.body} attachment={form.attachment} />
        </div>
      </div>

      <div className="flex justify-end gap-2 mt-5 pt-4 border-t border-slate-100">
        <button
          type="button"
          onClick={onClose}
          className="px-4 py-2 text-sm border border-slate-200 rounded-xl bg-white hover:bg-slate-50 cursor-pointer"
        >
          Cancelar
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={save}
          className="px-4 py-2 text-sm bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 hover:bg-emerald-700 border-none cursor-pointer disabled:opacity-50"
        >
          {saving ? 'Guardando…' : 'Guardar'}
        </button>
      </div>
    </Modal>
  );
}

// Mock de teléfono con la burbuja verde de WhatsApp, como la vista previa de Daplox.
function PhonePreview({ body, attachment }) {
  return (
    <div className="mx-auto w-[240px] rounded-[2rem] border-[6px] border-slate-900 bg-slate-900 shadow-xl overflow-hidden sticky top-2">
      <div className="bg-slate-900 text-white text-[10px] flex items-center justify-between px-4 py-1.5">
        <span>9:41</span>
        <span className="flex items-center gap-1">▂▄▆ <span className="border border-white/60 rounded-sm px-1">75%</span></span>
      </div>
      <div className="h-[380px] bg-[#e5ddd5] p-2.5 overflow-y-auto">
        {(body || attachment) ? (
          <div className="ml-auto max-w-[90%] bg-[#d9fdd3] rounded-lg rounded-tr-none shadow-sm p-1.5 text-[12px] text-slate-800">
            {attachment?.url && attachment.type === 'image' && (
              <img src={attachment.url} alt="adjunto" className="rounded-md w-full max-h-36 object-cover mb-1" />
            )}
            {attachment?.url && attachment.type !== 'image' && (
              <div className="flex items-center gap-1.5 bg-white/60 rounded-md px-2 py-2 mb-1 text-[11px] text-slate-600">
                {attachment.type === 'video' ? <HiOutlineFilm className="w-4 h-4" /> : <HiOutlineDocument className="w-4 h-4" />}
                <span className="truncate">{attachment.name || 'archivo'}</span>
              </div>
            )}
            {body && (
              // eslint-disable-next-line react/no-danger
              <div className="break-words" dangerouslySetInnerHTML={{ __html: waFormatHtml(body) }} />
            )}
            <div className="text-[9px] text-slate-500 text-right mt-0.5">21:00 ✓✓</div>
          </div>
        ) : (
          <div className="text-center text-[11px] text-slate-400 mt-16">
            La vista previa aparecerá aquí
          </div>
        )}
      </div>
    </div>
  );
}
