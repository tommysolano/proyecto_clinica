import { useEffect, useMemo, useState } from 'react';
import { HiOutlineBeaker } from 'react-icons/hi2';
import api from '../api/axios';
import SearchableSelect from './SearchableSelect';
import SelectorComponentesSuero from './SelectorComponentesSuero';
import SueroComposicionEditor from './SueroComposicionEditor';
import { SUERO_CLORURO_NOMBRE } from '../constants/sueroterapia';
import { doctorOptionLabel } from '../utils/roles';

/** Preparación en blanco: el cloruro va en todos y el volumen lo decide quien la pone. */
export const sueroVacio = () => ({ base: { name: SUERO_CLORURO_NOMBRE, volumeMl: null }, components: [] });

/** Los campos que este bloque añade al formulario de una cita nueva. */
export const CAMPOS_QUIEN_ATIENDE = { attendant: '', nursing: false, serum: null };

/**
 * QUIÉN ATIENDE, elegido ya al agendar — y si la cita PASA POR ENFERMERÍA.
 *
 * Antes la cola se repartía SIEMPRE después, en el mostrador («Asignar
 * atención»). Pero muchas citas se agendan sabiendo de sobra quién las atiende
 * —el paciente pide con su doctora, o viene a su serie de sueros— y repetir esa
 * elección al día siguiente es un paso que se olvida: la cita llega sin dueño y
 * hay que buscar a alguien con el paciente delante.
 *
 * Queda ELEGIDO, no atendido: la cita sigue pendiente hasta que el paciente
 * entre por la puerta. Marcarla asistida aquí daría por venido a quien viene la
 * semana que viene, y con eso se falsean los reportes y el no-show.
 *
 * ENFERMERÍA ES UNA MARCA APARTE, no «escoger a un enfermero». Lo normal es que
 * el suero lo ponga quien esté libre, así que la cita tiene que poder ir a la
 * bandeja de TODOS sin nombrar a nadie; y una cita puede pasar primero por el
 * doctor y después por enfermería, que es el caso de siempre. Nombrar a alguien
 * en «Quién atiende» sigue valiendo: si es enfermero, ese paso es suyo.
 *
 * Y CON ENFERMERÍA SE ESCOGE EL SUERO, del catálogo, igual que el médico en la
 * receta. No es un campo para escribir: lo que enfermería puede dar por aplicado
 * —y lo que descuenta la ampolla— es una línea de receta en la ficha, y un texto
 * suelto no lo es.
 */
export default function QuienAtiende({ form, setForm, doctors, nurses }) {
  const [catalogoAbierto, setCatalogoAbierto] = useState(false);

  // Una sola lista: la pregunta es «quién», no «de qué clase». El rol se enseña
  // en la etiqueta y es lo que decide la clase del turno al guardar.
  const personal = useMemo(
    () => [
      ...(doctors || []).map((d) => ({ ...d, _kind: 'doctor' })),
      ...(nurses || []).map((n) => ({ ...n, _kind: 'enfermeria' })),
    ],
    [doctors, nurses]
  );

  const elegido = personal.find((p) => String(p._id) === String(form.attendant)) || null;
  const esEnfermero = elegido?._kind === 'enfermeria';
  // Va a enfermería si se marcó la casilla o si quien atiende YA es un enfermero.
  const vaAEnfermeria = esEnfermero || !!form.nursing;

  // El servicio ya trae su suero: decirlo evita la duplicación más obvia —
  // agendar un Detox Plus y escoger además la ampolla de detox a mano.
  const sueroDelServicio = form.serviceItem?.autoSerum?.enabled ? form.serviceItem : null;

  const serum = form.serum;
  const setSerum = (patch) =>
    setForm((f) => ({ ...f, serum: { ...(f.serum || sueroVacio()), ...patch } }));

  return (
    <div className="space-y-2">
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1.5">
          Quién atiende <span className="font-normal text-slate-400">(opcional)</span>
        </label>
        <SearchableSelect
          options={personal}
          value={form.attendant}
          onChange={(v) => setForm((f) => ({ ...f, attendant: v || '' }))}
          getLabel={(p) => (p._kind === 'enfermeria' ? `${p.name} — Enfermería` : doctorOptionLabel(p))}
          getSearchText={(p) =>
            `${p.name || ''} ${p.specialty || ''} ${p._kind === 'enfermeria' ? 'enfermeria enfermero' : doctorOptionLabel(p)}`
          }
          placeholder="Se decide en el mostrador"
          searchPlaceholder="Buscar por nombre o especialidad…"
          allowClear
        />
        <p className="text-[11px] text-slate-400 mt-1">
          Queda preparado para esa persona. La cita sigue pendiente hasta que el paciente llegue.
        </p>
      </div>

      {/* La marca de enfermería. Con un enfermero ya elegido sobra: su paso YA es
          de enfermería, y enseñar la casilla marcada e inerte solo confunde. */}
      {!esEnfermero && (
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={!!form.nursing}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                nursing: e.target.checked,
                // Desmarcar tira el suero: sin paso de enfermería no hay quien lo
                // ponga, y dejarlo escribiría en la ficha algo que nadie va a dar
                // por aplicado.
                serum: e.target.checked ? f.serum : null,
              }))
            }
            className="mt-0.5 cursor-pointer"
          />
          <span className="text-sm text-slate-800">
            El servicio es de enfermería (suero, inyectable, curación)
            <span className="block text-xs text-slate-500">
              {form.attendant
                ? 'Pasa primero por quien elegiste y después por enfermería.'
                : 'Le aparece a todos los enfermeros y lo toma el primero que lo vea.'}
            </span>
          </span>
        </label>
      )}

      {vaAEnfermeria && (
        <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
          {sueroDelServicio ? (
            <div className="rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-xs text-violet-900">
              <b>«{sueroDelServicio.name}» ya crea su suero.</b> Se escribirá solo en los
              seguimientos (
              {(sueroDelServicio.autoSerum.components || [])
                .map((c) => `${c.name} ×${c.quantity || 1}`)
                .join(', ')}
              ), así que no hace falta escogerlo aquí.
            </div>
          ) : !serum ? (
            <button
              type="button"
              onClick={() => setSerum({})}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-sky-700 bg-transparent border-none cursor-pointer p-0"
            >
              <HiOutlineBeaker className="w-4 h-4" /> Escoger el suero que se va a aplicar
              <span className="text-slate-400 font-normal">(opcional)</span>
            </button>
          ) : (
            <>
              <SueroComposicionEditor
                base={serum.base}
                componentes={serum.components}
                onChangeBase={(base) => setSerum({ base })}
                onChangeComponentes={(components) => setSerum({ components })}
                onAbrirCatalogo={() => setCatalogoAbierto(true)}
              />
              <button
                type="button"
                onClick={() => setForm((f) => ({ ...f, serum: null }))}
                className="mt-1 text-[11px] text-red-500 bg-transparent border-none cursor-pointer p-0"
              >
                Quitar el suero
              </button>
            </>
          )}
        </div>
      )}

      {catalogoAbierto && (
        <SelectorComponentesSuero
          isOpen
          seleccionados={serum?.components || []}
          onClose={() => setCatalogoAbierto(false)}
          onConfirm={(components) => {
            setSerum({ components });
            setCatalogoAbierto(false);
          }}
        />
      )}
    </div>
  );
}

/**
 * El formulario → la COLA de atención que entiende el servidor (`steps`).
 *
 * Fuente única de las dos pantallas que agendan (la agenda y el alta de
 * paciente): si cada una montara la cola a su manera, una acabaría mandando el
 * suero fuera del paso y el servidor lo ignoraría en silencio.
 *
 * Enfermería puede ir sola (le sale a todos los enfermeros), detrás de un doctor
 * —consulta y después el suero, el caso de siempre— o nombrada, cuando quien
 * atiende YA es un enfermero. El suero cuelga de su paso: es ahí donde se pone.
 */
export function pasosDeAtencion(form, { doctors = [], nurses = [] } = {}) {
  const elegido =
    [...doctors, ...nurses].find((p) => String(p._id) === String(form.attendant)) || null;
  const esEnfermero = !!elegido && nurses.some((n) => String(n._id) === String(elegido._id));
  // Sin ampollas no se manda nada: una bolsa vacía no es un suero.
  const suero = form.serum?.components?.some((c) => c.name?.trim()) ? form.serum : null;

  const pasoEnfermeria = (user) => ({
    kind: 'enfermeria',
    user: user || null,
    serviceName: form.serviceItem?.name || '',
    serviceItem: form.serviceItem?._id || null,
    serum: suero || undefined,
  });

  const pasos = esEnfermero
    ? [pasoEnfermeria(elegido._id)]
    : [
        ...(elegido ? [{ kind: 'doctor', user: elegido._id }] : []),
        ...(form.nursing ? [pasoEnfermeria(null)] : []),
      ];
  return pasos.length ? pasos : undefined;
}

/**
 * Carga el personal de una sucursal para el selector.
 *
 * `clinicId` importa: mostrador agenda para cualquier sede y quien puede
 * atenderla es el personal DE ESA SEDE, no el de la sucursal en la que está el
 * cajero. Sin esto el selector ofrece a alguien que el servidor va a rechazar
 * («no atiende en la sucursal de esta cita»).
 */
export function usePersonalDeLaSede(clinicId, activo = true) {
  const [personal, setPersonal] = useState({ doctors: [], nurses: [] });

  useEffect(() => {
    if (!activo) return undefined;
    let vivo = true;
    const params = clinicId ? { clinic: clinicId } : {};
    Promise.all([
      api.get('/users/doctors', { params }),
      api.get('/users/nurses', { params }),
    ])
      .then(([d, n]) => {
        if (vivo) setPersonal({ doctors: d.data || [], nurses: n.data || [] });
      })
      // Sin lista no se puede elegir a ciegas: se queda vacía y el campo dice
      // «Se decide en el mostrador», que es el comportamiento de siempre.
      .catch(() => { if (vivo) setPersonal({ doctors: [], nurses: [] }); });
    return () => { vivo = false; };
  }, [clinicId, activo]);

  return personal;
}
