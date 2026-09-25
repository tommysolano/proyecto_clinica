// Bitácora libre del paciente: cualquiera del equipo anota lo que haga falta y
// adjunta archivos. La más reciente aparece primero, con su fecha y su autor.
//
// Quién puede corregir una nota: SOLO quien la escribió… y el administrador. Que
// el admin pueda no significa que se disimule: la tarjeta muestra siempre "Creado
// por" y, en cuanto alguien la toca, "Modificado por".
//
// VIVE EN SU PROPIO ARCHIVO (sep-2026) porque la usa DOS pantallas: la ficha del
// paciente (pestaña "Observaciones") y la agenda, donde mostrador la abre desde
// el menú de acciones de la cita.
import { useState, useEffect, useRef } from 'react';
import api from '../api/axios';
import { downloadFile } from '../utils/download';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { fmtDateTime } from '../utils/date';
import AttachmentPreviewModal from './AttachmentPreviewModal';
import {
  HiOutlinePaperClip,
  HiOutlineXMark,
  HiOutlineChatBubbleLeftRight,
  HiOutlinePencilSquare,
  HiOutlineTrash,
  HiOutlinePlus,
  HiOutlineEye,
  HiOutlineArrowDownTray,
} from 'react-icons/hi2';

// Observaciones: mismo tope que acepta el servidor (multer .array('files', 10)).
export const OBSERVATION_MAX_FILES = 10;

/**
 * El 413 ya no debería aparecer por tamaño (el servidor ya no corta y nginx
 * admite hasta 1 GB), pero si llega —nginx sin actualizar, o un disco lleno—
 * el aviso sigue siendo claro en vez de un error vacío.
 */
const observationUploadError = (err, fallback) => {
  if (err?.response?.status === 413) return 'El archivo es demasiado grande para subirlo';
  return err?.response?.data?.message || fallback;
};

/** Tamaño legible de un adjunto: «820 KB», «3.4 MB». */
const observationFileSize = (bytes) => {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

/** Lo que el visor sabe dibujar sin descargar: PDF e imágenes. */
const sePuedeVer = (att) => {
  const mime = String(att?.mimeType || '');
  return mime === 'application/pdf' || mime.startsWith('image/') || /\.pdf$/i.test(att?.originalName || '');
};

export default function ObservacionesTab({ patientId }) {
  const { user, hasRole } = useAuth();
  const isAdmin = hasRole('admin');
  const meId = user?.id || user?._id; // /auth/me devuelve los dos

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [pendingFiles, setPendingFiles] = useState([]);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);   // observación con una acción en curso
  const [editing, setEditing] = useState(null); // { id, text }
  const [previewAtt, setPreviewAtt] = useState(null); // { obsId, att }
  const newFileRef = useRef(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get(`/patients/${patientId}/observations`);
      setRows(Array.isArray(r.data) ? r.data : []);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al cargar las observaciones');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId]);

  const canEdit = (obs) =>
    isAdmin || String(obs.createdBy?._id || obs.createdBy) === String(meId);

  /** Reemplaza una observación en la lista sin recargarlas todas. */
  const replaceRow = (obs) => setRows((prev) => prev.map((o) => (o._id === obs._id ? obs : o)));

  const addFiles = (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    if (files.length + pendingFiles.length > OBSERVATION_MAX_FILES) {
      toast.error(`Puedes adjuntar hasta ${OBSERVATION_MAX_FILES} archivos por observación`);
    }
    setPendingFiles((prev) => [...prev, ...files].slice(0, OBSERVATION_MAX_FILES));
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!text.trim() && pendingFiles.length === 0) {
      toast.error('Escribe una observación o adjunta un archivo');
      return;
    }
    setSaving(true);
    try {
      // Un archivo por petición: diez de 20 MB juntos se pasan del
      // `client_max_body_size` de nginx y el 413 llega sin explicación.
      const fd = new FormData();
      fd.append('text', text.trim());
      if (pendingFiles[0]) fd.append('files', pendingFiles[0]);
      const r = await api.post(`/patients/${patientId}/observations`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      let saved = r.data;
      for (const file of pendingFiles.slice(1)) {
        const one = new FormData();
        one.append('files', file);
        // eslint-disable-next-line no-await-in-loop
        const extra = await api.post(
          `/patients/${patientId}/observations/${saved._id}/attachments`,
          one,
          { headers: { 'Content-Type': 'multipart/form-data' } }
        );
        saved = extra.data;
      }
      setRows((prev) => [saved, ...prev]); // la más nueva, arriba
      setText('');
      setPendingFiles([]);
      toast.success('Observación agregada');
    } catch (err) {
      toast.error(observationUploadError(err, 'No se pudo guardar la observación'));
    } finally {
      setSaving(false);
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    setBusyId(editing.id);
    try {
      const r = await api.put(`/patients/${patientId}/observations/${editing.id}`, {
        text: editing.text.trim(),
      });
      replaceRow(r.data);
      setEditing(null);
      toast.success('Observación modificada');
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo modificar');
    } finally {
      setBusyId(null);
    }
  };

  const removeObservation = async (obs) => {
    if (!confirm('¿Eliminar esta observación y sus archivos?')) return;
    setBusyId(obs._id);
    try {
      await api.delete(`/patients/${patientId}/observations/${obs._id}`);
      setRows((prev) => prev.filter((o) => o._id !== obs._id));
      toast.success('Observación eliminada');
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo eliminar');
    } finally {
      setBusyId(null);
    }
  };

  const uploadTo = async (obs, fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setBusyId(obs._id);
    try {
      let saved = obs;
      for (const file of files.slice(0, OBSERVATION_MAX_FILES)) {
        const fd = new FormData();
        fd.append('files', file);
        // eslint-disable-next-line no-await-in-loop
        const r = await api.post(
          `/patients/${patientId}/observations/${obs._id}/attachments`,
          fd,
          { headers: { 'Content-Type': 'multipart/form-data' } }
        );
        saved = r.data;
      }
      replaceRow(saved);
      toast.success(files.length > 1 ? 'Archivos adjuntados' : 'Archivo adjuntado');
    } catch (err) {
      toast.error(observationUploadError(err, 'No se pudo adjuntar'));
    } finally {
      setBusyId(null);
    }
  };

  const downloadAttachment = async (obs, att) => {
    try {
      await downloadFile(
        `/patients/${patientId}/observations/${obs._id}/attachments/${att._id}`,
        { filename: att.originalName || 'archivo' }
      );
    } catch (err) {
      toast.error(err.message || 'Error al descargar');
    }
  };

  const removeAttachment = async (obs, att) => {
    if (!confirm(`¿Eliminar "${att.originalName}"?`)) return;
    setBusyId(obs._id);
    try {
      const r = await api.delete(
        `/patients/${patientId}/observations/${obs._id}/attachments/${att._id}`
      );
      replaceRow(r.data);
      toast.success('Archivo eliminado');
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo eliminar el archivo');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Nueva observación */}
      <form onSubmit={submit} className="bg-slate-50 rounded-xl border border-slate-200 p-4 space-y-3">
        <textarea
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Escribe una observación sobre el paciente…"
          className="input resize-y"
        />
        <input
          ref={newFileRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = '';
          }}
        />
        {pendingFiles.length > 0 && (
          <ul className="space-y-1">
            {pendingFiles.map((f, i) => (
              <li key={`${f.name}-${i}`} className="text-xs text-slate-600 flex items-center gap-2">
                <HiOutlinePaperClip className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                <span className="truncate">{f.name}</span>
                <span className="text-slate-400 shrink-0">({observationFileSize(f.size)})</span>
                <button
                  type="button"
                  title="Quitar"
                  onClick={() => setPendingFiles((prev) => prev.filter((_, idx) => idx !== i))}
                  className="text-slate-400 hover:text-red-600 bg-transparent border-none cursor-pointer p-0"
                >
                  <HiOutlineXMark className="w-3.5 h-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => newFileRef.current?.click()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-dashed border-slate-300 bg-white hover:bg-emerald-50 hover:border-emerald-400 text-xs text-slate-600 hover:text-emerald-700 cursor-pointer transition-colors"
          >
            <HiOutlinePaperClip className="w-4 h-4" /> Adjuntar archivos
          </button>
          <button
            type="submit"
            disabled={saving}
            className="flex items-center gap-1 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-medium disabled:opacity-50 cursor-pointer border-none"
          >
            <HiOutlinePlus className="w-4 h-4" /> {saving ? 'Guardando…' : 'Agregar observación'}
          </button>
        </div>
      </form>

      {/* Historial: la última que se escribió, primera */}
      {loading ? (
        <div className="text-sm text-slate-400">Cargando…</div>
      ) : rows.length === 0 ? (
        <div className="text-center py-10">
          <HiOutlineChatBubbleLeftRight className="w-10 h-10 text-slate-300 mx-auto" />
          <p className="text-sm text-slate-500 mt-2">Todavía no hay observaciones.</p>
          <p className="text-xs text-slate-400">La primera que escribas aparecerá aquí.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((obs) => {
            const mine = canEdit(obs);
            const busy = busyId === obs._id;
            const isEditing = editing?.id === obs._id;
            return (
              <div key={obs._id} className="border border-slate-200 rounded-xl p-4 space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="text-xs text-slate-500">
                    <div className="font-semibold text-slate-700">
                      Creado por {obs.createdBy?.name || 'usuario eliminado'}
                    </div>
                    <div>{fmtDateTime(obs.createdAt)}</div>
                    {obs.updatedBy && (
                      <div className="text-amber-700">
                        Modificado por {obs.updatedBy.name || 'otro usuario'} ·{' '}
                        {fmtDateTime(obs.editedAt || obs.updatedAt)}
                      </div>
                    )}
                  </div>
                  {mine && !isEditing && (
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        title="Modificar"
                        disabled={busy}
                        onClick={() => setEditing({ id: obs._id, text: obs.text || '' })}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 bg-transparent border-none cursor-pointer disabled:opacity-50"
                      >
                        <HiOutlinePencilSquare className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        title="Eliminar"
                        disabled={busy}
                        onClick={() => removeObservation(obs)}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 bg-transparent border-none cursor-pointer disabled:opacity-50"
                      >
                        <HiOutlineTrash className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                </div>

                {isEditing ? (
                  <div className="space-y-2">
                    <textarea
                      rows={3}
                      value={editing.text}
                      onChange={(e) => setEditing((s) => ({ ...s, text: e.target.value }))}
                      className="input resize-y"
                    />
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setEditing(null)}
                        className="px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-xs text-slate-600 hover:bg-slate-50 cursor-pointer"
                      >
                        Cancelar
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={saveEdit}
                        className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium border-none cursor-pointer disabled:opacity-50"
                      >
                        Guardar cambios
                      </button>
                    </div>
                  </div>
                ) : (
                  obs.text && (
                    <p className="text-sm text-slate-700 whitespace-pre-wrap break-words">{obs.text}</p>
                  )
                )}

                {(obs.attachments || []).length > 0 && (
                  <div className="space-y-1 pt-1">
                    {obs.attachments.map((att) => (
                      <div key={att._id} className="flex items-center gap-2 text-xs text-slate-600">
                        <span>{String(att.mimeType || '').startsWith('image/') ? '🖼️' : '📎'}</span>
                        {/* Igual que en los seguimientos: el PDF o la imagen se
                            ABREN en el visor; descargar es su propio botón. */}
                        <button
                          type="button"
                          onClick={() =>
                            sePuedeVer(att)
                              ? setPreviewAtt({ obsId: obs._id, att })
                              : downloadAttachment(obs, att)
                          }
                          title={sePuedeVer(att) ? 'Ver el archivo' : 'Descargar'}
                          className="underline text-emerald-700 hover:text-emerald-800 bg-transparent border-none cursor-pointer p-0 truncate text-left"
                        >
                          {att.originalName}
                        </button>
                        <span className="text-slate-400 shrink-0">({observationFileSize(att.size)})</span>
                        {sePuedeVer(att) && (
                          <button
                            type="button"
                            title="Ver"
                            onClick={() => setPreviewAtt({ obsId: obs._id, att })}
                            className="text-slate-400 hover:text-emerald-700 bg-transparent border-none cursor-pointer p-0 shrink-0"
                          >
                            <HiOutlineEye className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <button
                          type="button"
                          title="Descargar"
                          onClick={() => downloadAttachment(obs, att)}
                          className="text-slate-400 hover:text-emerald-700 bg-transparent border-none cursor-pointer p-0 shrink-0"
                        >
                          <HiOutlineArrowDownTray className="w-3.5 h-3.5" />
                        </button>
                        {mine && (
                          <button
                            type="button"
                            title="Eliminar archivo"
                            disabled={busy}
                            onClick={() => removeAttachment(obs, att)}
                            className="text-slate-400 hover:text-red-600 bg-transparent border-none cursor-pointer p-0 disabled:opacity-50"
                          >
                            <HiOutlineTrash className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {mine && (
                  <label className="inline-flex items-center gap-1 text-xs text-emerald-700 cursor-pointer">
                    <HiOutlinePlus className="w-3.5 h-3.5" />
                    {busy ? 'Trabajando…' : 'Adjuntar archivos'}
                    <input
                      type="file"
                      multiple
                      className="hidden"
                      disabled={busy}
                      onChange={(e) => {
                        const files = e.target.files;
                        e.target.value = '';
                        uploadTo(obs, files);
                      }}
                    />
                  </label>
                )}
              </div>
            );
          })}
        </div>
      )}

      {previewAtt && (
        <AttachmentPreviewModal
          key={previewAtt.att._id}
          url={`/patients/${patientId}/observations/${previewAtt.obsId}/attachments/${previewAtt.att._id}`}
          filename={previewAtt.att.originalName}
          mimeType={previewAtt.att.mimeType}
          onClose={() => setPreviewAtt(null)}
        />
      )}
    </div>
  );
}
