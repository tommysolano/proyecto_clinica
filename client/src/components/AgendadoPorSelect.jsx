import { useEffect, useState } from 'react';
import api from '../api/axios';
import SearchableSelect from './SearchableSelect';
import { useAuth } from '../context/AuthContext';
import { ROLE_LABELS } from '../utils/roles';

/**
 * «AGENDADA POR»: a quién se le apunta la cita.
 *
 * En el call center las citas se cierran en pareja —una asesora habla con el
 * paciente y otra la escribe, porque la primera sigue en llamada o porque el
 * turno cambió a media conversación— y hasta ahora la cita se apuntaba SIEMPRE a
 * quien tecleaba. Con eso, el reporte de citas por asesor y el panel de
 * supervisión medían quién digita, no quién agenda.
 *
 * Por defecto queda quien la está escribiendo (lo de siempre): esto es la
 * excepción, no el camino normal. Quien la escribe queda igualmente guardado
 * («registrada por»), que es lo que impide que esto sea una forma de firmar por
 * otro. La misma regla la vuelve a aplicar el servidor
 * (utils/appointmentBooker.js), que es quien manda.
 *
 * Props: value (id o ''), onChange(id), className, label
 */
export default function AgendadoPorSelect({ value, onChange, className = '', label = 'Agendada por' }) {
  const { user, hasRole } = useAuth();
  const miId = String(user?.id || user?._id || '');
  // Solo quien agenda puede acreditar la cita a otro (espejo de ROLES_QUE_AGENDAN
  // en el servidor, que devuelve 403 al resto). Marketing agenda desde el chat
  // igual que el call center, así que también elige.
  const puedeElegir = hasRole('admin', 'cajero', 'call_center', 'marketing');
  const [gente, setGente] = useState([]);

  useEffect(() => {
    if (!puedeElegir) return undefined;
    let vivo = true;
    api.get('/users/schedulers')
      .then((r) => { if (vivo) setGente(Array.isArray(r.data) ? r.data : []); })
      // Sin lista no se elige a ciegas: el campo desaparece y la cita queda a
      // nombre de quien la escribe, que es el comportamiento de siempre.
      .catch(() => { if (vivo) setGente([]); })
    return () => { vivo = false; };
  }, [puedeElegir]);

  // Con una sola persona (o ninguna) no hay nada que escoger.
  if (!puedeElegir || gente.length <= 1) return null;

  const opciones = gente.map((g) => ({
    ...g,
    esYo: String(g._id) === miId,
  }));

  return (
    <div className={className}>
      <label className="block text-sm font-medium text-slate-700 mb-1.5">
        {label} <span className="font-normal text-slate-400">(opcional)</span>
      </label>
      <SearchableSelect
        options={opciones}
        value={value || ''}
        onChange={(v) => onChange(v || '')}
        getLabel={(g) =>
          `${g.name}${g.esYo ? ' (yo)' : ''}${g.role ? ` — ${ROLE_LABELS[g.role] || g.role}` : ''}`
        }
        getSearchText={(g) => `${g.name || ''} ${ROLE_LABELS[g.role] || g.role || ''}`}
        placeholder="Yo mismo"
        searchPlaceholder="Buscar por nombre…"
        allowClear
      />
      <p className="text-[11px] text-slate-400 mt-1">
        Déjalo vacío si la agendaste tú. Si la cerró otra persona, escógela: la cita se cuenta a
        su nombre y queda anotado que la escribiste tú.
      </p>
    </div>
  );
}
