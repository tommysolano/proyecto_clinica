import { useEffect, useState } from 'react';
import api from '../api/axios';
import Modal from './Modal';
import { HiOutlineArrowDownTray } from 'react-icons/hi2';
import { triggerBlobDownload } from '../utils/download';

/**
 * Visor de un archivo adjunto (PDF o imagen) SIN descargarlo a disco.
 *
 * POR QUÉ SE BAJA A BLOB Y NO SE APUNTA EL <iframe> A LA URL DIRECTAMENTE.
 * Los adjuntos de la ficha clínica no son públicos: viven fuera del alcance de
 * la web (server/storage/followups) y solo se sirven por una ruta autenticada
 * que exige la cabecera `Authorization`. Un `<iframe src="/api/…">` no envía esa
 * cabecera —el navegador no le pasa el token— y el visor saldría en blanco con
 * un 401. Aquí lo descarga axios, que sí lleva el token, y al iframe se le pasa
 * un `blob:` local. Es el mismo patrón que ya usa el escáner de documentos.
 *
 * Props:
 *   url        ruta de la API que devuelve el archivo (sin baseURL)
 *   filename   nombre real, para el título y para la descarga
 *   mimeType   'application/pdf' | 'image/…'
 *   onClose    cerrar
 */
export default function AttachmentPreviewModal({ url, filename, mimeType, onClose }) {
  const [blobUrl, setBlobUrl] = useState(null);
  const [blob, setBlob] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!url) return undefined;
    let vivo = true;
    let creada = null;
    api
      .get(url, { responseType: 'blob' })
      .then((r) => {
        if (!vivo) return;
        // El tipo lo pone el servidor; `mimeType` es solo el respaldo, porque un
        // Blob sin tipo se abre como descarga en vez de verse.
        const b = new Blob([r.data], { type: r.data?.type || mimeType || 'application/pdf' });
        creada = URL.createObjectURL(b);
        setBlob(b);
        setBlobUrl(creada);
      })
      .catch((e) => {
        if (vivo) setError(e.response?.data?.message || 'No se pudo abrir el archivo');
      });
    return () => {
      vivo = false;
      // Se revoca al cerrar, no antes: mientras el iframe lo esté mostrando, la
      // URL tiene que seguir viva.
      if (creada) URL.revokeObjectURL(creada);
    };
  }, [url, mimeType]);

  const esImagen = String(mimeType || '').startsWith('image/');

  return (
    <Modal isOpen onClose={onClose} title={filename || 'Archivo adjunto'} size="2xl">
      <div className="space-y-3">
        <div className="flex justify-end">
          <button
            type="button"
            disabled={!blob}
            onClick={() => triggerBlobDownload(blob, filename || 'archivo')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-sm text-slate-600 hover:text-emerald-700 hover:border-emerald-300 cursor-pointer disabled:opacity-50"
          >
            <HiOutlineArrowDownTray className="w-4 h-4" /> Descargar
          </button>
        </div>

        {error && <p className="text-center text-sm text-red-600 py-10">{error}</p>}
        {!error && !blobUrl && <p className="text-center text-slate-500 py-10">Abriendo archivo…</p>}

        {blobUrl && !esImagen && (
          <iframe
            title={filename || 'Archivo adjunto'}
            src={blobUrl}
            className="w-full rounded-xl border border-slate-200 bg-slate-50"
            style={{ height: '72vh' }}
          />
        )}
        {blobUrl && esImagen && (
          <div className="flex justify-center bg-slate-50 rounded-xl border border-slate-200 p-3">
            <img
              src={blobUrl}
              alt={filename || 'Archivo adjunto'}
              className="max-w-full object-contain"
              style={{ maxHeight: '72vh' }}
            />
          </div>
        )}
      </div>
    </Modal>
  );
}
