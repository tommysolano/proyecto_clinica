import { useEffect, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import Modal from '../components/Modal';
import ServiceItemPicker from '../components/ServiceItemPicker';
import { HiOutlinePlus, HiOutlineTrash, HiOutlineNoSymbol } from 'react-icons/hi2';
import { fmtDate } from '../utils/date';
import DateInput from '../components/DateInput';
import { useAuth } from '../context/AuthContext';

const EMPTY = {
  doctor: '',
  clinic: '',
  service: null,
  startDate: new Date().toISOString().slice(0, 10),
  endDate: new Date().toISOString().slice(0, 10),
  allDay: true,
  startTime: '08:00',
  endTime: '18:00',
  reason: '',
};

/**
 * BLOQUEOS DE HORARIOS (sep-2026).
 *
 * Administración y marketing impiden que se agende en fechas u horarios
 * concretos. Un bloqueo puede ser:
 *   · GENERAL (sin restricciones): nada se agenda en esa franja de SU sucursal;
 *   · para un SERVICIO del catálogo de la agenda («no se agenda Limpieza el
 *     martes de 9 a 10»);
 *   · para un DOCTOR.
 *
 * LA SUCURSAL SE ESCOGE EN EL FORMULARIO (sep-2026): antes era siempre la
 * activa y bloquear otra sede obligaba a cambiar de sucursal y volver. El
 * listado enseña los de todas las que el usuario alcanza, con su columna.
 * (La casilla de CONSULTORIO se retiró del formulario: no se pedía y los
 * bloqueos ya guardados con ella se siguen leyendo y aplicando.)
 *
 * La vista del día de la agenda pinta un recuadro en el horario bloqueado para
 * que quien agenda lo vea ANTES de chocar con el rechazo del servidor.
 */
export default function Blocks() {
  const { activeClinic, clinics } = useAuth();
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [doctors, setDoctors] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(EMPTY);

  // Las sucursales que se pueden bloquear: las del usuario, operativas. La
  // activa va primera y es el valor por defecto.
  const sucursales = (clinics || []).filter((c) => c.active !== false);
  const sucursalPorDefecto = activeClinic?._id
    || sucursales[0]?._id
    || '';

  const load = async () => {
    setLoading(true);
    try {
      // clinic=all: el formulario bloquea cualquier sucursal del alcance, así
      // que el listado enseña TODAS las que este usuario alcanza (la misma
      // regla de la vista del día de la agenda).
      const r = await api.get('/time-blocks', { params: { clinic: 'all' } });
      setList(r.data || []);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // allSettled: un catálogo que falle (permisos, red) no se lleva por delante
    // a los demás; el bloqueo se puede crear igual con lo que haya.
    Promise.allSettled([
      api.get('/users/doctors'),
    ]).then(([d]) => {
      setDoctors(d.status === 'fulfilled' ? d.value.data || [] : []);
    });
    load();
  }, []);

  const abrirModal = () => {
    setForm({ ...EMPTY, clinic: sucursalPorDefecto });
    setShowModal(true);
  };

  const submit = async (e) => {
    e.preventDefault();
    try {
      await api.post('/time-blocks', {
        ...form,
        // Sin sucursal escogida (o sin selector disponible) la activa decide.
        clinic: form.clinic || undefined,
        doctor: form.doctor || null,
        service: form.service?._id || null,
      });
      toast.success('Bloqueo creado');
      setShowModal(false);
      setForm({ ...EMPTY, clinic: sucursalPorDefecto });
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    }
  };

  const remove = async (b) => {
    if (!confirm('¿Eliminar bloqueo?')) return;
    try {
      await api.delete(`/time-blocks/${b._id}`);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    }
  };

  const nombreDeSucursal = (b) =>
    b.clinic?.nombreComercial || b.clinic?.name || '';

  const alcanceDe = (b) => {
    if (b.service?.name) return `Solo «${b.service.name}»`;
    if (b.doctor?.name) return `Solo Dr. ${b.doctor.name}`;
    if (b.room?.name) return `Consultorio ${b.room.name}`;
    return 'Toda la sucursal';
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
            <HiOutlineNoSymbol className="text-rose-600 shrink-0" /> Bloqueos de horarios
          </h1>
          <p className="text-sm text-slate-500">
            Impide agendar citas en fechas u horarios concretos. General, por
            servicio o por doctor — y la <b>sucursal</b> se escoge en el
            formulario.
          </p>
        </div>
        <button onClick={abrirModal} className="shrink-0 px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center justify-center gap-2 hover:bg-emerald-700">
          <HiOutlinePlus className="w-4 h-4" /> Nuevo bloqueo
        </button>
      </div>

      {/**
        * EN EL MÓVIL, TARJETAS (como la agenda). Siete columnas solo se leen
        * arrastrando; con `tbl-cards` cada fila se recompone como tarjeta:
        * el rango de fechas arriba con su horario, la sucursal a la derecha,
        * el alcance debajo y el motivo con la acción al pie. La lógica es la
        * MISMA para los dos tamaños — el recompuesto lo hace el CSS.
        */}
      <div className="tbl-wrap">
        <div className="tbl-scroll">
          <table className="tbl tbl-cards">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="text-left px-3 py-2">Inicio</th>
                <th className="text-left px-3 py-2">Fin</th>
                <th className="text-left px-3 py-2">Fechas y horario</th>
                <th className="text-left px-3 py-2">Sucursal</th>
                <th className="text-left px-3 py-2">Alcance</th>
                <th className="text-left px-3 py-2">Motivo</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={7} className="text-center py-4 text-slate-400">Cargando...</td></tr>}
              {list.map((b) => (
                <tr key={b._id} className="border-t border-slate-100">
                  <td data-cell="fecha" className="px-3 py-2 whitespace-nowrap">{fmtDate(b.startDate)}</td>
                  <td data-cell="fecha" className="px-3 py-2 whitespace-nowrap">{fmtDate(b.endDate)}</td>
                  <td data-cell="hora" className="px-3 py-2">
                    <div className="md:hidden text-sm font-semibold text-slate-800">
                      {fmtDate(b.startDate)}{b.endDate !== b.startDate ? ` – ${fmtDate(b.endDate)}` : ''}
                    </div>
                    <div className="text-sm text-slate-700">
                      {b.allDay ? 'Todo el día' : `${b.startTime} – ${b.endTime}`}
                    </div>
                  </td>
                  <td data-cell="estado" className="px-3 py-2">
                    <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-100 whitespace-nowrap">
                      {nombreDeSucursal(b) || '—'}
                    </span>
                  </td>
                  <td data-cell="principal" className="px-3 py-2">
                    <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-700">
                      {alcanceDe(b)}
                    </span>
                  </td>
                  <td data-cell="detalle" className="px-3 py-2 text-slate-600 break-words">{b.reason}</td>
                  <td data-cell="acciones" className="px-3 py-2 text-right">
                    <button onClick={() => remove(b)} title="Eliminar bloqueo" className="p-1 text-rose-600 hover:bg-rose-50 rounded cursor-pointer"><HiOutlineTrash className="w-4 h-4" /></button>
                  </td>
                </tr>
              ))}
              {!loading && list.length === 0 && <tr><td colSpan={7} className="text-center py-6 text-slate-400">Sin bloqueos</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title="Nuevo bloqueo">
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Desde</span>
              <DateInput required value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Hasta</span>
              <DateInput required value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" />
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.allDay} onChange={(e) => setForm({ ...form, allDay: e.target.checked })} />
            Todo el día
          </label>
          {!form.allDay && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block">
                <span className="text-xs font-medium text-slate-600">Hora inicio</span>
                <input type="time" value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-slate-600">Hora fin</span>
                <input type="time" value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" />
              </label>
            </div>
          )}
          <label className="block">
            <span className="text-xs font-medium text-slate-600">Alcance del bloqueo</span>
            {/* Servicio del catálogo de la agenda: si se escoge uno, el bloqueo
                SOLO impide agendar ese servicio en la franja; vacío = general. */}
            <div className="mt-1">
              <ServiceItemPicker
                value={form.service}
                onChange={(p) => setForm({ ...form, service: p || null })}
              />
            </div>
            <p className="text-[11px] text-slate-400 mt-1">
              Déjalo vacío para bloquear de forma general. Con servicio, solo se
              bloquea el agendamiento de ese servicio.
            </p>
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Doctor (opcional)</span>
              <select value={form.doctor} onChange={(e) => setForm({ ...form, doctor: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm">
                <option value="">Todos</option>
                {doctors.map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Sucursal</span>
              <select
                required
                value={form.clinic}
                onChange={(e) => setForm({ ...form, clinic: e.target.value })}
                className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm"
              >
                {!sucursalPorDefecto && <option value="">—</option>}
                {sucursales.map((c) => (
                  <option key={c._id} value={c._id}>
                    {c.nombreComercial || c.name}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-slate-400 mt-1">
                La sucursal donde rige el bloqueo, no la del menú de arriba.
              </p>
            </label>
          </div>
          <label className="block">
            <span className="text-xs font-medium text-slate-600">Motivo</span>
            <input required value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" />
          </label>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => setShowModal(false)} className="px-4 py-2 rounded-lg border border-slate-200">Cancelar</button>
            <button type="submit" className="px-4 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700">Guardar</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
