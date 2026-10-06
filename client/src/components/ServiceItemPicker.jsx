import SearchableSelect from './SearchableSelect';
import { useServiciosAgenda } from '../utils/serviciosAgenda';

/**
 * Selector del SERVICIO de una cita.
 *
 * OCT-2026: LA LISTA SON LOS SERVICIOS DEL INVENTARIO y es CERRADA. Antes se
 * podía escribir cualquier cosa y se creaba al vuelo; eso llenó la agenda de
 * servicios que no existen en el inventario y no hay forma de cobrar ni de
 * medir. Ahora solo se escoge, con buscador. Si falta algo, se da de alta como
 * servicio en Inventario y aparece aquí solo.
 *
 * Los nombres del inventario son LARGOS («ANTICUERPOS IgA ANTI MYCOPLASMA
 * PNEUMONIAE EN SUERO») y lo que distingue a dos suele estar al final, así que
 * ni la lista ni lo elegido se recortan: van en varias líneas.
 *
 * Lo que se guarda en la cita sigue siendo el servicio de la agenda
 * (`AppointmentServiceItem`), enlazado a su producto por el servidor (ver
 * server/utils/serviciosInventario.js).
 *
 * Props:
 *   value    : { _id, name } | null — el servicio elegido
 *   onChange : (item|null) => void
 *   clinic   : sucursal donde se agenda; cada empresa tiene su catálogo (oct-2026).
 *              Sin ella, el de la sucursal activa.
 */
export default function ServiceItemPicker({ value, onChange, clinic = '', placeholder = 'Escoge un servicio del inventario…' }) {
  const items = useServiciosAgenda(clinic);

  return (
    <SearchableSelect
      options={items}
      value={value?._id ? String(value._id) : ''}
      onChange={(id) => {
        if (!id) return onChange(null);
        const it = items.find((i) => String(i._id) === String(id));
        if (it) onChange(it);
      }}
      getLabel={(i) => i.name || ''}
      // Una cita antigua puede traer un servicio del catálogo viejo, que ya no
      // se ofrece: se sigue viendo cuál es hasta que alguien lo cambie.
      fallbackLabel={value?.name || ''}
      placeholder={placeholder}
      searchPlaceholder="Buscar servicio… (varias palabras valen)"
      allowClear
      wrapOptions
      wrapLabel
      menuMinWidth={340}
      // Ya elegido: en verde, para ver de un vistazo que la cita tiene servicio.
      className={value?._id ? 'border-emerald-300! bg-emerald-50! text-emerald-900 font-medium' : ''}
    />
  );
}
