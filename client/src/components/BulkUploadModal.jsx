import { useState } from 'react';
import toast from 'react-hot-toast';
import {
  HiOutlineArrowDownTray,
  HiOutlineArrowUpTray,
  HiOutlineCloudArrowUp,
  HiOutlineCheckCircle,
  HiOutlineExclamationTriangle,
} from 'react-icons/hi2';
import api from '../api/axios';
import { downloadFile } from '../utils/download';
import Modal from './Modal';

/**
 * Modal reutilizable de carga masiva por Excel (mismo patrón que Importar Datos):
 * 1) descargar la plantilla, 2) llenarla, 3) subirla. Muestra el resultado
 * (creados / omitidos / errores / advertencias).
 *
 * Props:
 *  - open, onClose
 *  - title, description, steps (líneas de ayuda)
 *  - templateUrl  : GET que devuelve el .xlsx de plantilla
 *  - templateFilename
 *  - uploadUrl    : POST multipart `file` que importa y devuelve el resumen
 *  - onImported() : callback tras una importación (para recargar la lista)
 */
export default function BulkUploadModal({
  open,
  onClose,
  title = 'Carga masiva',
  description,
  steps = [],
  templateUrl,
  templateFilename,
  uploadUrl,
  onImported,
}) {
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState(null);

  const close = () => {
    if (uploading) return;
    setFile(null);
    setResult(null);
    onClose?.();
  };

  const downloadTemplate = async () => {
    try {
      await downloadFile(templateUrl, { filename: templateFilename });
    } catch (e) {
      toast.error(e.message || 'No se pudo descargar la plantilla');
    }
  };

  const upload = async () => {
    if (!file) return toast.error('Selecciona el archivo Excel lleno');
    setUploading(true);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api.post(uploadUrl, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setResult(r.data);
      const errs = r.data?.errors?.length || 0;
      toast[errs ? 'error' : 'success'](
        `${r.data.created || 0} creados${r.data.updated ? `, ${r.data.updated} actualizados` : ''}${r.data.skipped ? `, ${r.data.skipped} omitidos` : ''}${errs ? `, ${errs} con error` : ''}`
      );
      setFile(null);
      onImported?.();
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al importar');
    } finally {
      setUploading(false);
    }
  };

  return (
    <Modal isOpen={open} onClose={close} title={title} size="lg">
      <div className="space-y-4">
        {description && <p className="text-sm text-slate-600">{description}</p>}

        <ol className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded-xl p-3 space-y-1 list-decimal list-inside">
          <li>Descarga la plantilla de Excel.</li>
          <li>Llénala (trae una hoja de <b>Instrucciones</b> con ejemplos).</li>
          <li>Súbela aquí. Revisa el resultado antes de continuar.</li>
          {steps.map((s, i) => (
            <li key={i} className="list-none text-xs text-slate-500 ml-4">• {s}</li>
          ))}
        </ol>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={downloadTemplate}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm bg-slate-700 text-white rounded-lg cursor-pointer border-none"
          >
            <HiOutlineArrowDownTray className="w-4 h-4" /> Descargar plantilla
          </button>
          <label className="inline-flex items-center gap-1.5 px-3 py-2 text-sm bg-slate-100 text-slate-700 rounded-lg cursor-pointer border border-slate-200 max-w-full">
            <HiOutlineArrowUpTray className="w-4 h-4 shrink-0" />
            <span className="truncate">{file ? file.name : 'Elegir archivo…'}</span>
            <input
              type="file"
              accept=".xlsx"
              className="hidden"
              onChange={(e) => { setResult(null); setFile(e.target.files?.[0] || null); }}
            />
          </label>
          <button
            type="button"
            onClick={upload}
            disabled={!file || uploading}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm bg-emerald-600 text-white rounded-lg disabled:opacity-40 cursor-pointer border-none"
          >
            <HiOutlineCloudArrowUp className="w-4 h-4" /> {uploading ? 'Importando…' : 'Importar'}
          </button>
        </div>

        {result && (
          <div className="text-sm rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-2">
            <p className="flex items-center gap-1.5 text-emerald-700 font-medium">
              <HiOutlineCheckCircle className="w-4 h-4" />
              {result.created || 0} creados
              {result.updated ? ` · ${result.updated} actualizados` : ''}
              {result.fichas ? ` · ${result.fichas} fichas` : ''}
              {result.seguimientos ? ` · ${result.seguimientos} seguimientos` : ''}
              {result.skipped ? ` · ${result.skipped} omitidos` : ''}
              {result.total ? ` · ${result.total} filas leídas` : ''}
            </p>
            {!!result.errors?.length && (
              <div className="text-rose-700">
                <p className="flex items-center gap-1.5 font-medium">
                  <HiOutlineExclamationTriangle className="w-4 h-4" /> {result.errors.length} con error (no se crearon):
                </p>
                <ul className="list-disc ml-5 max-h-40 overflow-y-auto text-xs">
                  {result.errors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              </div>
            )}
            {!!result.warnings?.length && (
              <div className="text-amber-700">
                <p className="flex items-center gap-1.5 font-medium">
                  <HiOutlineExclamationTriangle className="w-4 h-4" /> {result.warnings.length} advertencias:
                </p>
                <ul className="list-disc ml-5 max-h-40 overflow-y-auto text-xs">
                  {result.warnings.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
