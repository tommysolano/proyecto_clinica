/**
 * Odontograma del rol ODONTOLOGÍA NEUROFOCAL.
 *
 * FUNCIONA DIFERENTE al odontograma del MSP (components/Odontograma.jsx), que
 * sigue intacto para el rol 'odontologia'. Aquí NO se elige color, NO hay
 * simbología, NO hay indicadores de salud bucal ni índices CPO-ceo, y no se
 * pincha cada cuadro: el esquema va FILA POR FILA — a la izquierda los cuadros
 * de los dientes de esa fila (de muestra, no interactivos) y a la derecha un
 * cuadro de texto grande donde se escribe lo que se debe realizar en esa fila.
 *
 * Las filas van en el orden de la hoja: hemiarco derecho (permanentes y
 * temporales superiores/inferiores) y después hemiarco izquierdo (ver
 * ODONTO_NEUROFOCAL_FILAS en constants/specialtyCatalogs.js — espejo del
 * servidor, que valida contra esa lista).
 *
 * Vive fuera de PatientDetail.jsx por lo mismo que el odontograma original: es
 * un bloque grande y autocontenido, y se consume con `{ value, onChange }`.
 */
import {
  ODONTO_NEUROFOCAL_FILAS,
} from '../constants/specialtyCatalogs';

/**
 * Los cuadros de una fila, de MUESTRA: números FDI dentro de un cuadrito con
 * borde, redondos los temporales (como en la hoja). No se pinchan — la
 * indicación se escribe al lado, en el texto de la fila.
 */
function CuadroDiente({ num }) {
  const temporal = ['5', '6', '7', '8'].includes(String(num)[0]);
  return (
    <div
      className={`w-8 h-8 shrink-0 flex items-center justify-center bg-white border border-slate-400 text-[11px] font-semibold text-slate-700 tabular-nums ${
        temporal ? 'rounded-full' : 'rounded-sm'
      }`}
      title={`Pieza ${num}`}
    >
      {num}
    </div>
  );
}

/**
 * @param {boolean} [readOnly] modo LECTURA: se dibuja igual pero sin editar. Es
 *   lo que se enseña en el historial de seguimientos (ver NeurofocalSummary).
 */
export default function OdontogramaNeurofocal({ value, onChange, readOnly = false }) {
  const o = value || {};
  const filas = Array.isArray(o.dientes) ? o.dientes : [];
  const byFila = Object.fromEntries(filas.map((f) => [f.fila, f]));

  const setTexto = (filaKey, texto) => {
    if (readOnly) return;
    const cur = byFila[filaKey] || { fila: filaKey, texto: '' };
    const next = { ...cur, texto };
    const resto = filas.filter((f) => f.fila !== filaKey);
    // Una fila sin texto no es un hallazgo, es un hueco: se quita de la lista
    // (misma regla que el saneador del servidor).
    onChange({
      ...o,
      dientes: String(texto).trim() ? [...resto, next] : resto,
    });
  };

  return (
    <div className="space-y-3">
      {!readOnly && (
        <p className="text-[11px] text-slate-500 m-0">
          En cada fila escribe a la derecha lo que se debe realizar en esas piezas.
          Se guarda junto con el seguimiento.
        </p>
      )}
      <div className="space-y-2">
        {ODONTO_NEUROFOCAL_FILAS.map((fila) => (
          <div key={fila.key} className="flex flex-col sm:flex-row gap-2 sm:items-start">
            <div className="shrink-0">
              <div className="text-[10px] text-slate-400 leading-tight mb-1" title={fila.label}>
                {fila.label}
              </div>
              <div className="flex flex-wrap gap-0.5">
                {fila.piezas.map((num) => (
                  <CuadroDiente key={num} num={num} />
                ))}
              </div>
            </div>
            <textarea
              rows={3}
              value={byFila[fila.key]?.texto || ''}
              onChange={(e) => setTexto(fila.key, e.target.value)}
              readOnly={readOnly}
              placeholder="Lo que se debe realizar en estas piezas…"
              className="flex-1 min-w-0 sm:mt-4 text-xs border border-slate-200 rounded px-2 py-1.5 outline-none focus:border-emerald-500 resize-y"
            />
          </div>
        ))}
      </div>
    </div>
  );
}
