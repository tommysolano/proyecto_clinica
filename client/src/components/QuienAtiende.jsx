import { useEffect, useState } from 'react';
import api from '../api/axios';
import SearchableSelect from './SearchableSelect';
import { doctorOptionLabel } from '../utils/roles';

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
 * ENFERMERÍA YA NO SE ESCOGE EN ESTE BLOQUE. La cola inicial solo prepara al
 * doctor. Cuando la cita exista, «Asignar atención» permite agregar el turno de
 * enfermería, nombrar a la persona y escoger el suero desde la ficha o crear
 * uno nuevo. Así no se confunde «quién atiende la consulta» con «qué aplicación
 * de enfermería hay que ejecutar».
 */
export default function QuienAtiende({ form, setForm, doctors }) {
  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-slate-700 mb-1.5">
        Doctor que atiende <span className="font-normal text-slate-400">(opcional)</span>
      </label>
      <SearchableSelect
        options={doctors || []}
        value={form.attendant}
        onChange={(v) => setForm((f) => ({ ...f, attendant: v || '' }))}
        getLabel={doctorOptionLabel}
        getSearchText={(d) => `${d.name || ''} ${d.specialty || ''} ${doctorOptionLabel(d)}`}
        placeholder="Se decide en el mostrador"
        searchPlaceholder="Buscar doctor o especialidad…"
        allowClear
      />
      <p className="text-[11px] text-slate-400 mt-1">
        Solo se asignan doctores en esta cola. Enfermería y el suero se asignan desde «Asignar atención» en la cita.
      </p>
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
export function pasosDeAtencion(form, { doctors = [] } = {}) {
  const elegido = doctors.find((p) => String(p._id) === String(form.attendant)) || null;
  return elegido ? [{ kind: 'doctor', user: elegido._id }] : undefined;
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
