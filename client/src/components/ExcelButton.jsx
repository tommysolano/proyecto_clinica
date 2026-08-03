import { useState } from 'react';
import toast from 'react-hot-toast';
import { HiOutlineArrowDownTray } from 'react-icons/hi2';
import { downloadFile } from '../utils/download';

/**
 * Botón «Excel» de un reporte.
 *
 * Pedido del contador: TODO reporte o consulta se debe poder bajar en Excel. Este componente
 * unifica el patrón para que agregar una descarga sea una línea y no diez:
 *
 *   <ExcelButton url="/journal-entries/ledger.xlsx" params={{ account, startDate, endDate }}
 *                filename="mayor.xlsx" disabled={!account} />
 *
 * Usa `downloadFile`, que sabe leer el mensaje de error real cuando el servidor responde JSON
 * en vez del archivo (si no, el navegador bajaba un .xlsx corrupto y el usuario no sabía por qué).
 *
 * Props:
 *  - url       ruta del endpoint .xlsx
 *  - params    querystring del reporte (los MISMOS filtros que la pantalla)
 *  - filename  nombre sugerido del archivo
 *  - disabled  p. ej. cuando aún no se ha elegido la cuenta o el período
 *  - label     texto del botón (por defecto «Excel»)
 *  - title     tooltip
 *  - className clases extra
 */
export default function ExcelButton({
  url,
  params,
  filename = 'reporte.xlsx',
  disabled = false,
  label = 'Excel',
  title = 'Descargar este reporte en Excel',
  className = '',
}) {
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (busy || disabled) return;
    setBusy(true);
    try {
      await downloadFile(url, { filename, params });
    } catch (err) {
      toast.error(err.message || 'No se pudo generar el Excel');
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={run}
      disabled={disabled || busy}
      title={disabled ? 'Genera primero el reporte' : title}
      className={`px-4 py-2 bg-slate-700 text-white rounded-xl text-sm flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
    >
      <HiOutlineArrowDownTray className="w-4 h-4" />
      {busy ? 'Generando…' : label}
    </button>
  );
}
