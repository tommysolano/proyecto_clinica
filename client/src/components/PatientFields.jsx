import { useState, useEffect } from 'react';
import api from '../api/axios';
import { edadDesdeFecha } from '../utils/date';
import { unirTelefonos, partirTelefonos } from '../utils/phone';
import NumericInput from './NumericInput';
import DateInput from './DateInput';
import Spinner from './Spinner';
import SriStatus from './SriStatus';
import useSriLookup, { fillField } from '../hooks/useSriLookup';
import EmailStatus from './EmailStatus';
import useEmailValidation from '../hooks/useEmailValidation';
import { ROLES_VEN_CEDULA, ROLES_VEN_CORREO, ROLES_VEN_DIRECCION, ROLES_VEN_TELEFONO } from '../utils/roles';
import { useAuth } from '../context/AuthContext';

/**
 * LOS DATOS DEL PACIENTE, EN UN SOLO SITIO.
 *
 * Este bloque vivía dentro de la página de Pacientes y nada más. Desde sep-2026
 * también se edita DESDE LA AGENDA, en la propia cita: mostrador tiene al
 * paciente delante, descubre que la cédula está mal o que cambió de número, y
 * tenía que abandonar la agenda, buscarlo en Clientes, corregirlo y volver.
 *
 * Se extrajo aquí en vez de copiarlo porque las reglas de estos campos no son
 * obvias y se pierden al duplicarlas: qué se enseña a quién (los datos de
 * contacto van por rol, campo a campo), que la edad es un dato DERIVADO de la
 * fecha de nacimiento, que los dos teléfonos comparten un único campo separado
 * por «/», y que la cédula autocompleta contra el SRI solo al REGISTRAR.
 *
 * No incluye el bloque de agendar cita ni el de atención inmediata: eso es del
 * alta de un paciente nuevo y sigue viviendo en la página de Pacientes.
 */

export const emptyPatientForm = {
  cedula: '',
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  whatsapp: '',
  birthDate: '',
  age: '',
  gender: '',
  address: '',
  source: '',
  referredByName: '',
  referredById: '',
  referredByType: '',
};

/**
 * Del paciente guardado al formulario. Devuelve también el campo único de
 * teléfonos, que no es un campo del paciente sino de la pantalla.
 */
export function formDesdePaciente(patient) {
  /**
   * El paciente llega CENSURADO para quien no ve los datos de contacto (ver
   * CONTACT_FIELDS en patientController). Si esos `undefined` entran al
   * formulario, sus inputs dejan de estar controlados y React se queja.
   */
  const visible = Object.fromEntries(
    Object.entries(patient || {}).filter(([, v]) => v !== undefined && v !== null)
  );
  const nacimiento = patient?.birthDate ? String(patient.birthDate).split('T')[0] : '';
  return {
    form: {
      ...emptyPatientForm,
      ...visible,
      birthDate: nacimiento,
      // Con fecha de nacimiento la edad se recalcula al abrir: la guardada puede
      // ser de hace tres años y el campo ya no se puede corregir a mano.
      age: nacimiento ? edadDesdeFecha(nacimiento) : (patient?.age ?? ''),
    },
    telefonos: unirTelefonos(patient?.phone, patient?.whatsapp),
  };
}

/**
 * Del formulario al cuerpo de la petición.
 *
 * Los campos vacíos van como `undefined`: Mongoose no sabe convertir '' a
 * ObjectId/número/fecha y el guardado fallaba con un error opaco.
 */
export function payloadDePaciente(form, telefonos) {
  return {
    ...form,
    // El campo único vuelve a ser `phone` + `whatsapp`, que es lo que entiende
    // el resto del sistema.
    ...partirTelefonos(telefonos),
    age: form.age === '' ? undefined : Number(form.age),
    birthDate: form.birthDate || undefined,
    referredById: form.referredById || undefined,
  };
}

/**
 * Campo con etiqueta, con el tamaño del formulario de pacientes (el `Field`
 * compartido de components/Field.jsx es más pequeño y aquí desentonaría).
 */
export function Field({ label, required, children }) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 mb-1.5">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      {children}
    </div>
  );
}

// Buscador de "¿Quién lo refirió?" — pacientes y personal registrados.
export function ReferralPicker({ value, onSelect, onClear }) {
  const [query, setQuery] = useState(value || '');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(!!value);

  useEffect(() => {
    if (selected || query.trim().length < 2) {
      setResults([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const res = await api.get('/patients/referral-options', { params: { q: query } });
        setResults(res.data || []);
        setOpen(true);
      } catch {
        setResults([]);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query, selected]);

  return (
    <Field label="¿Quién lo refirió?">
      <div className="relative">
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(false);
          }}
          className="input"
          placeholder="Buscar paciente o personal..."
        />
        {selected && query && (
          <button
            type="button"
            onClick={() => {
              setQuery('');
              setSelected(false);
              onClear();
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-400 hover:text-red-500 bg-transparent border-none cursor-pointer"
          >
            ✕
          </button>
        )}
        {open && !selected && results.length > 0 && (
          <div className="absolute z-10 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
            {results.map((r) => (
              <button
                key={`${r.type}-${r.id}`}
                type="button"
                onClick={() => {
                  onSelect(r);
                  setQuery(r.name);
                  setSelected(true);
                  setOpen(false);
                }}
                className="w-full text-left px-3 py-2 text-sm hover:bg-emerald-50 bg-transparent border-none cursor-pointer flex justify-between gap-2"
              >
                <span>{r.name}</span>
                <span className="text-xs text-slate-400">{r.type === 'user' ? 'Personal' : r.detail}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Field>
  );
}

/**
 * Los campos del paciente. `editing` cambia dos cosas y las dos importan:
 *  · al REGISTRAR se piden todos (la persona está dando sus datos en el
 *    mostrador); al EDITAR, un campo de contacto solo se enseña a quien lo VE,
 *    porque el resto lo recibiría vacío y guardaría un borrado sin querer;
 *  · el autocompletado del SRI solo corre al registrar: sobre un paciente ya
 *    guardado reescribiría a mano lo que alguien corrigió.
 */
export default function PatientFields({ form, setForm, telefonos, setTelefonos, editing = false }) {
  const { hasRole } = useAuth();
  // Espejo de las capacidades del servidor, que es quien manda: esto solo decide
  // si se pinta el hueco (ver CONTACT_FIELDS en patientController).
  const showCedula = hasRole(...ROLES_VEN_CEDULA);
  const showEmail = hasRole(...ROLES_VEN_CORREO);
  const showDireccion = hasRole(...ROLES_VEN_DIRECCION);
  const showContact = hasRole(...ROLES_VEN_TELEFONO);

  // Autocompletado por cédula/RUC desde el SRI (nombres/apellidos + dirección).
  // La fecha de nacimiento y el género no están en fuentes públicas gratuitas en
  // Ecuador, así que esos se ingresan a mano.
  const cedulaLookup = useSriLookup(form.cedula, {
    enabled: !editing,
    existingIsError: true,
    onData: (d, prev) => {
      setForm((f) => ({
        ...f,
        firstName: fillField(f.firstName, d.found ? (d.firstName || '').toUpperCase() : '', (prev?.firstName || '').toUpperCase()),
        lastName: fillField(f.lastName, d.found ? (d.lastName || '').toUpperCase() : '', (prev?.lastName || '').toUpperCase()),
        address: fillField(f.address, d.found ? d.address || '' : '', prev?.address),
      }));
    },
  });
  const emailCheck = useEmailValidation(form.email, { enabled: true });

  const handleChange = (e) => {
    const { name, value } = e.target;
    /**
     * LA EDAD SE CALCULA SOLA en cuanto hay fecha de nacimiento.
     *
     * Los dos campos decían lo mismo y se tecleaban por separado, así que se
     * contradecían: la ficha de un paciente de 1990 podía decir «28 años» porque
     * la edad se escribió una vez y ahí se quedó. Con la fecha puesta, la edad
     * es un dato derivado y se comporta como tal (el campo queda de solo
     * lectura); borrando la fecha se vuelve a poder escribir a mano, que es como
     * se registra a quien no se acuerda del día en que nació.
     */
    if (name === 'birthDate') {
      const edad = edadDesdeFecha(value);
      setForm((f) => ({ ...f, birthDate: value, age: value ? edad : f.age }));
      return;
    }
    setForm((f) => ({
      ...f,
      [name]: (name === 'firstName' || name === 'lastName') ? value.toUpperCase() : value,
    }));
  };

  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* Al REGISTRAR se piden siempre (la persona los está dando en el
            mostrador); al EDITAR ya son datos guardados: solo el admin —y la
            cédula, además, mostrador y quien atiende. */}
        {(showCedula || !editing) && (
          <Field label="Cédula / RUC / Pasaporte">
            <div className="relative">
              <input
                name="cedula"
                value={form.cedula}
                onChange={handleChange}
                className="input pr-9"
                placeholder="Cédula, RUC o pasaporte"
                maxLength={20}
              />
              {cedulaLookup.loading && (
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-emerald-500 pointer-events-none">
                  <Spinner />
                </span>
              )}
            </div>
            <SriStatus status={cedulaLookup} />
          </Field>
        )}
        {/* Ni género, ni nombres, ni apellidos son obligatorios: el paciente
            se registra muchas veces con lo que se tiene a mano (a veces solo
            el teléfono, o solo la cédula) y se completa después. Exigirlos
            obligaba a inventarse datos para poder guardar. */}
        <Field label="Género">
          <select name="gender" value={form.gender} onChange={handleChange} className="input">
            <option value="">Seleccionar</option>
            <option value="masculino">Masculino</option>
            <option value="femenino">Femenino</option>
            <option value="otro">Otro</option>
          </select>
        </Field>
        <Field label="Nombres">
          <input name="firstName" value={form.firstName} onChange={handleChange} className="input" />
        </Field>
        <Field label="Apellidos">
          <input name="lastName" value={form.lastName} onChange={handleChange} className="input" />
        </Field>
        {/* Al EDITAR, un campo de contacto solo se enseña a quien lo ve: el
            resto lo recibiría vacío y guardaría un borrado sin querer (el
            servidor lo descarta igual, ver CONTACT_FIELDS). El correo lo ve
            también quien atiende, así que también lo corrige. */}
        {(showEmail || !editing) && (
          <Field label="Email">
            <input
              name="email"
              type="email"
              value={form.email}
              onChange={handleChange}
              className="input"
            />
            <EmailStatus status={emailCheck} onApplySuggestion={(s) => setForm((f) => ({ ...f, email: s }))} />
          </Field>
        )}
        {(showContact || !editing) && (
          <Field label="Teléfono">
            <input
              name="telefonos"
              value={telefonos}
              onChange={(e) => setTelefonos(e.target.value)}
              placeholder="0991234567"
              className="input"
            />
            <p className="text-[11px] text-slate-400 mt-1">
              ¿Tiene dos números? Escríbelos separados por «/». El segundo es el que se usa
              para WhatsApp.
            </p>
          </Field>
        )}
        <Field label="Fecha de nacimiento">
          <DateInput
            name="birthDate"
            value={form.birthDate}
            onChange={handleChange}
            className="input"
          />
        </Field>
        {/* Con fecha de nacimiento la edad es un dato derivado: se enseña,
            pero no se teclea (así no puede contradecir a la fecha). */}
        <Field label={form.birthDate ? 'Edad (calculada)' : 'Edad (si no tiene fecha)'}>
          <NumericInput
            name="age"
            min="0"
            max="150"
            value={form.age}
            onChange={handleChange}
            readOnly={!!form.birthDate}
            className={`input ${form.birthDate ? 'bg-slate-50 text-slate-500' : ''}`}
            placeholder="Ej: 35"
            title={form.birthDate ? 'Se calcula con la fecha de nacimiento' : ''}
          />
        </Field>
      </div>
      {(showDireccion || !editing) && (
        <Field label="Dirección">
          <input name="address" value={form.address} onChange={handleChange} className="input" />
        </Field>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="¿Cómo nos conoció?">
          <select name="source" value={form.source} onChange={handleChange} className="input">
            <option value="">Sin especificar</option>
            <option value="anuncio">Anuncio</option>
            <option value="referido">Referido</option>
            <option value="recepcion">Recepción</option>
            <option value="organico">Orgánico</option>
          </select>
        </Field>
        {form.source === 'referido' && (
          <ReferralPicker
            value={form.referredByName}
            onSelect={(sel) =>
              setForm((f) => ({
                ...f,
                referredByName: sel.name,
                referredById: sel.id || '',
                referredByType: sel.type || '',
              }))
            }
            onClear={() =>
              setForm((f) => ({ ...f, referredByName: '', referredById: '', referredByType: '' }))
            }
          />
        )}
      </div>
    </>
  );
}
