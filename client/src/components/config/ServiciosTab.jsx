import { useEffect, useMemo, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import { EmptyState } from '../PageHeader';
import Modal from '../Modal';
import SelectorComponentesSuero from '../SelectorComponentesSuero';
import SueroComposicionEditor from '../SueroComposicionEditor';
import { SUERO_CLORURO_NOMBRE } from '../../constants/sueroterapia';
import {
  HiOutlineBeaker,
  HiOutlineClock,
  HiOutlineMagnifyingGlass,
  HiOutlineTag,
} from 'react-icons/hi2';

/**
 * CUÁNTO DURA CADA SERVICIO de la agenda — y QUÉ SUERO LLEVA de serie.
 *
 * No todos ocupan lo mismo: un control son diez minutos y un tratamiento puede
 * llevar una hora. Antes la disponibilidad se miraba minuto a minuto, así que
 * una cita de 40 minutos empezada a las 14:00 desaparecía del panel en cuanto se
 * consultaba las 14:20: el hueco parecía libre y se agendaba encima del
 * paciente que todavía estaba dentro.
 *
 * Son los servicios de la AGENDA (los que salen al agendar una cita), no los del
 * inventario. Ver el modelo AppointmentServiceItem para el porqué de que sean
 * dos catálogos distintos.
 *
 * «Lo que dure la cita normal» es el valor por defecto y sigue siendo lo
 * correcto para la mayoría: solo hace falta configurar los que se salen de la
 * norma, que son unos pocos.
 */

// Duraciones habituales. No es un campo libre para que la agenda no acabe con
// servicios de 37 minutos que no cuadran con ninguna rejilla.
const DURACIONES = [
  { value: 0, label: 'Lo que dure la cita normal' },
  { value: 10, label: '10 minutos' },
  { value: 15, label: '15 minutos' },
  { value: 20, label: '20 minutos' },
  { value: 30, label: '30 minutos' },
  { value: 45, label: '45 minutos' },
  { value: 60, label: '1 hora' },
  { value: 90, label: '1 h 30 min' },
  { value: 120, label: '2 horas' },
  { value: 180, label: '3 horas' },
];

/**
 * EL SUERO QUE LLEVA EL SERVICIO, editable aquí y no en el código.
 *
 * Hay servicios que SON un suero concreto y siempre el mismo: «Detox Plus» es
 * una bolsa con la ampolla de detox dentro. Escribirlo a mano en la ficha de
 * cada paciente para que enfermería tenga qué dar por aplicado era un copiar y
 * pegar que se olvida justo los días de trabajo — y entonces la aplicación no
 * queda registrada ni descuenta la ampolla.
 *
 * Es una PLANTILLA, no un candado: lo que se escribe aquí aparece como una línea
 * de receta más en el seguimiento, y el médico puede cambiarla o quitarla.
 */
function SueroDeServicioModal({ item, onClose, onGuardado }) {
  const [enabled, setEnabled] = useState(!!item.autoSerum?.enabled);
  const [base, setBase] = useState(
    item.autoSerum?.base?.name || item.autoSerum?.base?.volumeMl != null
      ? { ...item.autoSerum.base }
      : { name: SUERO_CLORURO_NOMBRE, volumeMl: null }
  );
  const [componentes, setComponentes] = useState(item.autoSerum?.components || []);
  const [catalogoAbierto, setCatalogoAbierto] = useState(false);
  const [guardando, setGuardando] = useState(false);

  const guardar = async () => {
    // Sin ampollas no hay suero que sembrar: el servidor lo apaga igualmente,
    // pero decirlo aquí evita el «lo activé y no pasa nada».
    if (enabled && !componentes.filter((c) => c.name?.trim()).length) {
      toast.error('Añade al menos una ampolla o molécula, o desactiva el suero.');
      return;
    }
    setGuardando(true);
    try {
      const { data } = await api.put(`/appointment-service-items/${item._id}`, {
        autoSerum: { enabled, base, components: componentes },
      });
      toast.success(
        data.autoSerum?.enabled
          ? `«${item.name}» creará su suero al agendarse`
          : `«${item.name}» ya no crea suero`
      );
      onGuardado(data);
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo guardar');
    } finally {
      setGuardando(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={`Suero de «${item.name}»`} size="lg">
      <div className="space-y-3">
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="mt-0.5 cursor-pointer"
          />
          <span className="text-sm text-slate-800">
            Al agendar este servicio, escribir el suero en los seguimientos
            <span className="block text-xs text-slate-500">
              El enfermero lo ve en la ficha del paciente y puede darlo por aplicado, sin que
              nadie tenga que escribirlo a mano.
            </span>
          </span>
        </label>

        <div className={enabled ? '' : 'opacity-50 pointer-events-none'}>
          <SueroComposicionEditor
            base={base}
            componentes={componentes}
            onChangeBase={setBase}
            onChangeComponentes={setComponentes}
            onAbrirCatalogo={() => setCatalogoAbierto(true)}
          />
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary">
            Cancelar
          </button>
          <button type="button" onClick={guardar} disabled={guardando} className="btn-primary">
            {guardando ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </div>

      {catalogoAbierto && (
        <SelectorComponentesSuero
          isOpen
          seleccionados={componentes}
          onClose={() => setCatalogoAbierto(false)}
          onConfirm={(comps) => {
            setComponentes(comps);
            setCatalogoAbierto(false);
          }}
        />
      )}
    </Modal>
  );
}

export default function ServiciosTab() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [guardando, setGuardando] = useState(null);
  const [busca, setBusca] = useState('');
  // El servicio cuyo suero se está configurando (modal abierto).
  const [sueroDe, setSueroDe] = useState(null);

  useEffect(() => {
    let vivo = true;
    api
      .get('/appointment-service-items')
      .then((r) => { if (vivo) setItems(Array.isArray(r.data) ? r.data : []); })
      .catch((err) => toast.error(err.response?.data?.message || 'No se pudo cargar el catálogo'))
      .finally(() => { if (vivo) setLoading(false); });
    return () => { vivo = false; };
  }, []);

  const guardar = async (item, minutos) => {
    setGuardando(item._id);
    // Optimista: el select ya muestra lo elegido y se revierte si falla. Con una
    // lista larga, esperar a la respuesta en cada cambio se siente roto.
    const antes = item.durationMinutes || 0;
    setItems((l) => l.map((i) => (i._id === item._id ? { ...i, durationMinutes: minutos } : i)));
    try {
      await api.put(`/appointment-service-items/${item._id}`, { durationMinutes: minutos });
      toast.success(
        minutos > 0
          ? `${item.name}: ${DURACIONES.find((d) => d.value === minutos)?.label || `${minutos} min`}`
          : `${item.name}: lo que dure la cita normal`,
      );
    } catch (err) {
      setItems((l) => l.map((i) => (i._id === item._id ? { ...i, durationMinutes: antes } : i)));
      toast.error(err.response?.data?.message || 'No se pudo guardar');
    } finally {
      setGuardando(null);
    }
  };

  const visibles = useMemo(() => {
    const q = busca.trim().toLowerCase();
    const lista = q ? items.filter((i) => i.name.toLowerCase().includes(q)) : items;
    // Los que YA tienen una duración propia van arriba: son los que el
    // administrador viene a revisar.
    return [...lista].sort((a, b) => {
      const da = a.durationMinutes || 0;
      const db = b.durationMinutes || 0;
      if (!!da !== !!db) return da ? -1 : 1;
      return a.name.localeCompare(b.name, 'es');
    });
  }, [items, busca]);

  const configurados = items.filter((i) => i.durationMinutes > 0).length;
  const conSuero = items.filter((i) => i.autoSerum?.enabled).length;

  if (loading) return <p className="text-sm text-slate-400 py-8 text-center">Cargando servicios…</p>;

  if (items.length === 0) {
    return (
      <EmptyState
        icon={HiOutlineTag}
        title="Todavía no hay servicios de agenda"
        hint="Se crean solos al agendar: quien agenda escribe el servicio y queda disponible para los demás."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="bg-sky-50 border border-sky-200 text-sky-900 text-xs sm:text-sm rounded-xl px-3 py-2">
        La duración es lo que el servicio <b>ocupa</b> en la agenda. Al agendar, «Disponibilidad en
        este horario» enseña las citas que siguen en curso aunque hayan empezado antes: una de una
        hora que empezó a las 14:00 aparece también al mirar las 14:30.
      </div>
      <div className="bg-violet-50 border border-violet-200 text-violet-900 text-xs sm:text-sm rounded-xl px-3 py-2">
        <b>Suero:</b> los servicios que siempre llevan la misma preparación (un detox, un plasma) la
        escriben solos en los seguimientos del paciente al agendarse. El enfermero la ve en la ficha
        y puede darla por aplicada sin que nadie la teclee.
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[12rem]">
          <HiOutlineMagnifyingGlass className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Buscar un servicio…"
            className="input pl-9"
          />
        </div>
        <span className="text-xs text-slate-500 whitespace-nowrap">
          {configurados} de {items.length} con duración propia
          {conSuero > 0 && <> · {conSuero} con suero</>}
        </span>
      </div>

      <ul className="m-0 p-0 list-none space-y-1.5">
        {visibles.map((item) => (
          <li
            key={item._id}
            className="flex flex-wrap items-center gap-2 bg-white border border-slate-200 rounded-xl px-3 py-2"
          >
            <span
              className="w-2.5 h-2.5 rounded-full shrink-0"
              style={{ backgroundColor: item.color || '#0f766e' }}
            />
            <span className="flex-1 min-w-[8rem] text-sm text-slate-800 break-words">
              {item.name}
              {item.nursingService && (
                <span className="ml-1.5 text-[10px] rounded bg-sky-100 text-sky-800 px-1 py-px align-middle">
                  enfermería
                </span>
              )}
              {item.autoSerum?.enabled && (
                <span
                  className="ml-1.5 text-[10px] rounded bg-violet-100 text-violet-800 px-1 py-px align-middle"
                  title={(item.autoSerum.components || []).map((c) => `${c.name} ×${c.quantity || 1}`).join(', ')}
                >
                  crea suero
                </span>
              )}
            </span>
            {/* Configurar el suero de serie. Va en cada fila y no en una pantalla
                aparte porque la pregunta es «¿qué lleva ESTE servicio?», y se
                contesta mirando su nombre. */}
            <button
              type="button"
              onClick={() => setSueroDe(item)}
              title="Suero que se crea al agendar este servicio"
              className={
                'inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium border cursor-pointer shrink-0 ' +
                (item.autoSerum?.enabled
                  ? 'bg-violet-50 text-violet-700 border-violet-200'
                  : 'bg-white text-slate-500 border-slate-200')
              }
            >
              <HiOutlineBeaker className="w-4 h-4" />
              <span className="hidden sm:inline">Suero</span>
            </button>
            <span className="flex items-center gap-1.5 shrink-0">
              <HiOutlineClock
                className={`w-4 h-4 ${item.durationMinutes > 0 ? 'text-emerald-600' : 'text-slate-300'}`}
              />
              {/* El ancho lo pone el contenedor: `.input` ya trae `width:100%`
                  y ponerle una utilidad encima deja el campo a merced de la
                  cascada. */}
              <span className="block w-52">
                <select
                  value={item.durationMinutes || 0}
                  disabled={guardando === item._id}
                  onChange={(e) => guardar(item, Number(e.target.value))}
                  className="input input-sm cursor-pointer disabled:opacity-60"
                >
                  {DURACIONES.map((d) => (
                    <option key={d.value} value={d.value}>{d.label}</option>
                  ))}
                </select>
              </span>
            </span>
          </li>
        ))}
        {visibles.length === 0 && (
          <li className="text-center text-sm text-slate-400 py-6">Nada coincide con «{busca}».</li>
        )}
      </ul>

      {sueroDe && (
        <SueroDeServicioModal
          item={sueroDe}
          onClose={() => setSueroDe(null)}
          onGuardado={(actualizado) =>
            setItems((l) => l.map((i) => (i._id === actualizado._id ? actualizado : i)))
          }
        />
      )}
    </div>
  );
}
