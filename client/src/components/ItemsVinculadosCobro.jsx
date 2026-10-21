import NumericInput from './NumericInput';
import SearchableSelect from './SearchableSelect';
import { HiOutlineTrash } from 'react-icons/hi2';
import { fmtDate } from '../utils/date';
import { FUENTES_VINCULADO as FUENTES } from '../constants/itemsVinculados';

/**
 * ÍTEMS VINCULADOS DE UNA LÍNEA DEL COBRO (oct-2026).
 *
 * El producto trae en el inventario los ítems que se pueden usar con él (las
 * ampollas y moléculas de una «Sueroterapia», por ejemplo). Aquí se escoge cuáles
 * se usaron y cuántos: salen del inventario al cobrar y NO suman al precio.
 *
 * De dónde sale cada uno:
 *   · Del inventario       — lo pone la clínica.
 *   · Guardado del paciente — lo compró antes y lo dejó aquí: no se le cobra otra
 *                             vez; sale del inventario ahora.
 *   · Lo trajo el paciente  — lo compró y se lo llevó: no se descuenta.
 *
 * Props:
 *   item        la línea del cobro (`linkOptions`, `linked`)
 *   guardados   Map(idProducto → { enClinica, llevado, compras[] }) del paciente,
 *               ya sumado lo que deja en la clínica en este mismo cobro
 *   hayPaciente la venta es de un paciente (sin él solo cabe «del inventario»)
 *   onChange(linked)
 */
export default function ItemsVinculadosCobro({ item, guardados, hayPaciente, onChange }) {
  const opciones = item.linkOptions || [];
  const elegidos = item.linked || [];
  if (!opciones.length) return null;
  // Lo que el cajero toca deja de seguir solo: la cantidad a la de la línea, el origen a lo
  // que el paciente tenga guardado.
  const set = (idx, patch) => onChange(elegidos.map((l, i) => (i === idx
    ? { ...l, ...patch, ...('quantity' in patch ? { cantAuto: false } : {}), ...('source' in patch ? { fuenteAuto: false } : {}) }
    : l)));
  const quitar = (idx) => onChange(elegidos.filter((_, i) => i !== idx));
  const agregar = (productId, source) => {
    const op = opciones.find((o) => String(o.product) === String(productId));
    if (!op) return;
    const g = guardados.get(String(op.product));
    const fuente = source || (hayPaciente && g?.enClinica > 0 ? 'paciente' : 'inventario');
    onChange([...elegidos, {
      product: op.product,
      productName: op.productName,
      code: op.code,
      base: op.quantity,
      quantity: +(Number(op.quantity || 1) * Number(item.quantity || 1)).toFixed(4),
      source: fuente,
      cantAuto: true,
      fuenteAuto: !source,
    }]);
  };
  const libres = opciones.filter((o) => !elegidos.some((l) => String(l.product) === String(o.product)));
  // Lo del paciente que este producto puede usar y todavía no está escogido: se ofrece arriba.
  const delPaciente = hayPaciente
    ? libres.filter((o) => {
        const g = guardados.get(String(o.product));
        return g && (g.enClinica > 0 || g.llevado > 0);
      })
    : [];

  return (
    <div className="mt-1.5 rounded-lg border border-cyan-200 bg-cyan-50/50 p-2 space-y-1.5 text-left">
      <p className="text-[11px] font-semibold text-cyan-800 m-0">
        Ítems que se usan <span className="font-normal text-cyan-700">· no suman al precio</span>
      </p>

      {delPaciente.map((o) => {
        const g = guardados.get(String(o.product));
        return (
          <div key={`p-${o.product}`} className="flex flex-wrap items-center gap-1.5 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-900">
            <span className="flex-1 min-w-0 break-words">
              <strong>{o.productName}</strong>
              {g.enClinica > 0 && <> · el paciente tiene <strong>{g.enClinica}</strong> guardado{g.enClinica === 1 ? '' : 's'} aquí (ya pagado{g.enClinica === 1 ? '' : 's'})</>}
              {g.llevado > 0 && <> · compró y se llevó <strong>{g.llevado}</strong>{g.ultimaLlevada ? ` (${fmtDate(g.ultimaLlevada)})` : ''}</>}
            </span>
            {g.enClinica > 0 && (
              <button type="button" onClick={() => agregar(o.product, 'paciente')}
                className="px-2 py-0.5 rounded bg-amber-600 text-white border-none cursor-pointer text-[11px]">
                Usar lo suyo
              </button>
            )}
            {g.llevado > 0 && (
              <button type="button" onClick={() => agregar(o.product, 'trajo')}
                className="px-2 py-0.5 rounded bg-white text-amber-800 border border-amber-400 cursor-pointer text-[11px]">
                Lo trajo
              </button>
            )}
          </div>
        );
      })}

      {elegidos.map((l, idx) => {
        const g = guardados.get(String(l.product));
        const puedePaciente = hayPaciente && ((g?.enClinica || 0) > 0 || l.source === 'paciente');
        const falta = l.source === 'paciente' && Number(l.quantity) > (g?.enClinica || 0);
        return (
          <div key={`${l.product}-${idx}`} className="flex flex-wrap items-center gap-1.5 rounded bg-white border border-slate-200 px-2 py-1">
            <span className="flex-1 min-w-[8rem] text-xs text-slate-700 break-words">
              {l.productName}
              {l.code && <span className="ml-1 text-[10px] text-slate-400 font-mono">{l.code}</span>}
            </span>
            <NumericInput
              value={l.quantity}
              onChange={(e) => set(idx, { quantity: e.target.value })}
              title="Cantidad usada"
              className="input-sm w-14 text-center"
            />
            <select
              value={l.source}
              onChange={(e) => set(idx, { source: e.target.value })}
              title="De dónde sale"
              className="input-sm w-auto"
            >
              <option value="inventario">{FUENTES.inventario}</option>
              {puedePaciente && <option value="paciente">{FUENTES.paciente}{g?.enClinica ? ` (${g.enClinica})` : ''}</option>}
              {hayPaciente && <option value="trajo">{FUENTES.trajo}</option>}
            </select>
            <button type="button" onClick={() => quitar(idx)} title="No se usó"
              className="p-0.5 text-red-400 hover:text-red-600 bg-transparent border-none cursor-pointer">
              <HiOutlineTrash className="w-3.5 h-3.5" />
            </button>
            {falta && (
              <span className="basis-full text-[10px] text-rose-600">
                El paciente solo tiene {g?.enClinica || 0} guardado{(g?.enClinica || 0) === 1 ? '' : 's'}.
              </span>
            )}
            {l.source === 'trajo' && (
              <span className="basis-full text-[10px] text-slate-500">No se descuenta del inventario.</span>
            )}
          </div>
        );
      })}

      {libres.length > 0 && (
        <SearchableSelect
          options={libres}
          value=""
          onChange={(v) => v && agregar(v)}
          getValue={(o) => o.product}
          getLabel={(o) => o.productName}
          getSearchText={(o) => `${o.productName} ${o.code || ''}`}
          placeholder={elegidos.length ? '+ Agregar otro ítem' : '+ Escoger los ítems que se usan'}
          searchPlaceholder="Buscar ítem vinculado…"
          size="sm"
          wrapOptions
        />
      )}
    </div>
  );
}
