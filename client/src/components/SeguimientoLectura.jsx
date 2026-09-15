import { fmtDate } from '../utils/date';
import { nombreConTratamiento } from '../utils/roles';
import { HiOutlineBeaker, HiOutlineLockClosed } from 'react-icons/hi2';

/**
 * UN SEGUIMIENTO EN SOLO LECTURA.
 *
 * La tarjeta que usa «Ver consulta y receta» en la agenda, extraída a su
 * propio archivo para que la misma lectura sirva donde haga falta: de UNA cita
 * (AppointmentFollowUpModal) y de TODAS las de un paciente
 * (SeguimientosPacienteModal). Nada aquí escribe: corregir una consulta se
 * hace desde la ficha, por su autor.
 *
 * Props: fu (el seguimiento), conFecha (mostrar la fecha en la cabecera; la
 * modal de una cita ya la enseña en su cabecera, la lista de un paciente no).
 */
export function Seguimiento({ fu, conFecha = false }) {
  // El «Dr.» es de los médicos: el suero que manda mostrador se guarda como
  // una consulta más y su autor es un cajero (ver nombreConTratamiento).
  const autor = nombreConTratamiento(fu.createdBy?.name, fu.createdByRole) || 'Profesional';
  const receta = fu.recetaItems || [];

  // Consulta del terapeuta vista por quien no le corresponde: el servidor manda
  // un tocón, no los campos vacíos. Se dice tal cual.
  if (fu.redacted) {
    return (
      <div className="border border-slate-200 rounded-xl px-4 py-3 bg-slate-50">
        <p className="flex items-center gap-2 text-sm text-slate-600">
          <HiOutlineLockClosed className="w-4 h-4 text-slate-400" />
          Atendido por terapeuta — esta consulta es privada.
        </p>
        <p className="text-xs text-slate-400 mt-1">{autor}</p>
      </div>
    );
  }

  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden">
      <div className="bg-slate-50 px-4 py-2 border-b border-slate-200 flex items-center justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          {conFecha && <p className="text-[11px] text-slate-400 m-0">{fmtDate(fu.fecha)}</p>}
          <span className="text-sm font-semibold text-slate-700">{autor}</span>
        </div>
        <span className="text-xs text-slate-500">
          {fu.kind === 'enfermeria' ? 'Enfermería' : fu.kind === 'estudio' ? 'Estudio' : 'Consulta'}
        </span>
      </div>

      <div className="px-4 py-3 space-y-3">
        <Campo label="Motivo" valor={fu.motivoConsulta || fu.descripcion} />
        {(fu.diagnosticos || []).length > 0 && (
          <Campo
            label="Diagnóstico"
            valor={fu.diagnosticos
              .map((d) => [d.cie10, d.descripcion].filter(Boolean).join(' — '))
              .join(' · ')}
          />
        )}

        {receta.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Receta</p>
            <ul className="space-y-1.5">
              {receta.map((it) => (
                <li key={it._id} className="text-sm text-slate-700 bg-slate-50 rounded-lg px-3 py-2">
                  <span className="font-medium">
                    {it.name}
                    {it.quantity > 1 ? ` × ${it.quantity}` : ''}
                  </span>
                  {[it.dose, it.frequency, it.duration].filter(Boolean).length > 0 && (
                    <span className="text-slate-500">
                      {' — '}
                      {[it.dose, it.frequency, it.duration].filter(Boolean).join(', ')}
                    </span>
                  )}
                  {it.instructions && (
                    <p className="text-xs text-slate-500 mt-0.5">{it.instructions}</p>
                  )}
                  {/**
                    * EL SUERO SE DETALLA: enfermería tiene que leer exactamente
                    * lo que entra por la vena, y el recuento de dosis es lo que
                    * evita ponerle la octava de siete.
                    */}
                  {it.isSerum && (
                    <div className="mt-1.5 text-xs text-slate-600 space-y-0.5">
                      {it.serumBase?.name && (
                        <p className="flex items-center gap-1">
                          <HiOutlineBeaker className="w-3.5 h-3.5 text-sky-500 shrink-0" />
                          {it.serumBase.name}
                          {it.serumBase.volumeMl ? ` ${it.serumBase.volumeMl} ml` : ''}
                        </p>
                      )}
                      {(it.serumComponents || []).length > 0 && (
                        <p className="pl-4.5">
                          {it.serumComponents.map((c) => c.name).filter(Boolean).join(' · ')}
                        </p>
                      )}
                      <p className="pl-4.5 text-slate-500">
                        {(it.administrations || []).length} de {it.quantity} aplicadas
                      </p>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Lo que enfermería ya puso: la cuenta abierta del doctor, cerrada. */}
        {(fu.aplicaciones || []).length > 0 && (
          <p className="text-xs text-sky-700">
            Se le aplicó: {fu.aplicaciones.map((a) => a.itemName).filter(Boolean).join(' · ')}
          </p>
        )}

        <Campo label="Plan de tratamiento" valor={fu.planTratamiento} />
        <Campo label="Recomendaciones" valor={fu.recomendacionesNoFarmacologicas} />
        <Campo label="Evolución" valor={fu.evolucion} />
        <Campo label="Indicaciones" valor={fu.indicaciones} />
        <Campo label="Observaciones" valor={fu.observaciones} />

        {(fu.attachments || []).length > 0 && (
          <p className="text-xs text-slate-500">
            {fu.attachments.length} archivo{fu.attachments.length === 1 ? '' : 's'} adjunto
            {fu.attachments.length === 1 ? '' : 's'} — se abren desde la ficha del paciente.
          </p>
        )}
      </div>
    </div>
  );
}

function Campo({ label, valor }) {
  if (!valor) return null;
  return (
    <div>
      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{label}</p>
      <p className="text-sm text-slate-700 whitespace-pre-wrap">{valor}</p>
    </div>
  );
}
