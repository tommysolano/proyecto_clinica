import { HiOutlineTicket } from 'react-icons/hi2';

/**
 * SESIONES PREPAGADAS DE UNA CITA (oct-2026). Lo arma el servidor
 * (utils/sesionesPrepagadas → enriquecerCitas):
 *   apt.sesiones = [{ productName, n, total }] — la cita ya usa una sesión
 *                  prepagada: «Sesión 2 de 5». Lo ve todo el mundo (no hay importes).
 *   apt.prepago  = { cubre: [{ productName, quedan, total }], todo } — solo mostrador:
 *                  el paciente tiene sesiones pagadas para esta cita y aún no se usaron.
 */
export default function SesionesPrepagadasBadge({ apt, mostrador = false, className = 'mt-1' }) {
  const sesiones = apt?.sesiones || [];
  const cubre = mostrador ? apt?.prepago?.cubre || [] : [];
  if (!sesiones.length && !cubre.length) return null;
  return (
    <div className={`${className} flex flex-wrap gap-1`}>
      {sesiones.map((s, i) => (
        <span
          key={`s-${i}`}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase whitespace-nowrap bg-indigo-100 text-indigo-800 cursor-default"
          title={`Servicio pagado por adelantado: ${s.productName}. Esta cita usa la sesión ${s.n} de ${s.total}.`}
        >
          <HiOutlineTicket className="w-3 h-3" /> {s.productName ? `${s.productName} · ` : ''}Sesión {s.n} de {s.total}
        </span>
      ))}
      {cubre.map((c, i) => (
        <span
          key={`c-${i}`}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold whitespace-nowrap border border-indigo-200 bg-white text-indigo-700 cursor-default"
          title="El paciente ya pagó este servicio por adelantado. Al asignar la atención se usa una sesión y no se cobra otra vez."
        >
          <HiOutlineTicket className="w-3 h-3" /> Prepagado: {c.productName} (quedan {c.quedan} de {c.total})
        </span>
      ))}
    </div>
  );
}
