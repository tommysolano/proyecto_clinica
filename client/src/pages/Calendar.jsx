import { useEffect, useMemo, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import { Link } from 'react-router-dom';
import {
  HiOutlineChevronLeft,
  HiOutlineChevronRight,
  HiOutlinePlus,
  HiOutlineFunnel,
} from 'react-icons/hi2';

// Calendario semanal estilo Google Calendar.
const HOURS = Array.from({ length: 14 }, (_, i) => i + 7); // 07:00 - 20:00
const DAYS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

const STATUS_COLORS = {
  pendiente: 'bg-amber-100 text-amber-800 border-amber-300',
  confirmada: 'bg-sky-100 text-sky-800 border-sky-300',
  asistida: 'bg-emerald-100 text-emerald-800 border-emerald-300',
  completada: 'bg-emerald-200 text-emerald-900 border-emerald-400',
  no_asistio: 'bg-rose-100 text-rose-800 border-rose-300',
  cancelada: 'bg-slate-200 text-slate-700 border-slate-300 line-through',
};

const startOfWeek = (d) => {
  const date = new Date(d);
  const day = (date.getDay() + 6) % 7; // lunes = 0
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - day);
  return date;
};

const formatDate = (d) =>
  d.toLocaleDateString('es-EC', { day: '2-digit', month: 'short' });
const ymd = (d) => d.toISOString().slice(0, 10);

const minutesFromTime = (t) => {
  const [h, m] = (t || '00:00').split(':').map(Number);
  return h * 60 + m;
};

export default function Calendar() {
  const [weekStart, setWeekStart] = useState(startOfWeek(new Date()));
  const [appointments, setAppointments] = useState([]);
  const [blocks, setBlocks] = useState([]);
  const [doctors, setDoctors] = useState([]);
  const [doctorFilter, setDoctorFilter] = useState('');
  const [loading, setLoading] = useState(true);

  const days = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(weekStart);
      d.setDate(weekStart.getDate() + i);
      return d;
    });
  }, [weekStart]);

  const load = async () => {
    setLoading(true);
    try {
      const start = ymd(days[0]);
      const end = ymd(days[6]);
      const params = { startDate: start, endDate: end };
      if (doctorFilter) params.doctor = doctorFilter;
      const [aRes, bRes] = await Promise.all([
        api.get('/appointments', { params }),
        api.get('/time-blocks', { params: { startDate: start, endDate: end } }),
      ]);
      setAppointments(aRes.data.appointments || aRes.data || []);
      setBlocks(bRes.data || []);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al cargar calendario');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    api
      .get('/users', { params: { role: 'doctor' } })
      .then((r) => setDoctors((r.data || []).filter((u) => u.role === 'doctor' || (u.clinics || []).some((c) => c.role === 'doctor'))))
      .catch(() => setDoctors([]));
  }, []);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart, doctorFilter]);

  const moveWeek = (dir) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + dir * 7);
    setWeekStart(d);
  };

  const goToday = () => setWeekStart(startOfWeek(new Date()));

  const apptsByDay = useMemo(() => {
    const map = new Map();
    days.forEach((d) => map.set(ymd(d), []));
    appointments.forEach((a) => {
      const k = (a.date || '').slice(0, 10);
      if (map.has(k)) map.get(k).push(a);
    });
    return map;
  }, [appointments, days]);

  const blocksByDay = useMemo(() => {
    const map = new Map();
    days.forEach((d) => map.set(ymd(d), []));
    blocks.forEach((b) => {
      const start = new Date(b.startDate);
      const end = new Date(b.endDate);
      days.forEach((d) => {
        if (d >= new Date(start.toDateString()) && d <= new Date(end.toDateString())) {
          map.get(ymd(d)).push(b);
        }
      });
    });
    return map;
  }, [blocks, days]);

  const ROW_HEIGHT = 48; // px por hora
  const baseMin = HOURS[0] * 60;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Calendario de citas</h1>
          <p className="text-sm text-slate-500">
            Vista semanal estilo Google Calendar.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => moveWeek(-1)}
            className="px-3 py-2 rounded-lg bg-white border border-slate-200 hover:bg-slate-50"
          >
            <HiOutlineChevronLeft className="w-4 h-4" />
          </button>
          <button
            onClick={goToday}
            className="px-3 py-2 rounded-lg bg-emerald-600 text-white text-sm hover:bg-emerald-700"
          >
            Hoy
          </button>
          <button
            onClick={() => moveWeek(1)}
            className="px-3 py-2 rounded-lg bg-white border border-slate-200 hover:bg-slate-50"
          >
            <HiOutlineChevronRight className="w-4 h-4" />
          </button>
          <Link
            to="/appointments"
            className="ml-2 inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-white border border-slate-200 text-sm hover:bg-slate-50"
          >
            <HiOutlinePlus className="w-4 h-4" /> Nueva cita
          </Link>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-3 flex flex-wrap items-center gap-3">
        <HiOutlineFunnel className="w-4 h-4 text-slate-500" />
        <span className="text-sm text-slate-600">
          {formatDate(days[0])} - {formatDate(days[6])}
        </span>
        <select
          value={doctorFilter}
          onChange={(e) => setDoctorFilter(e.target.value)}
          className="ml-auto border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
        >
          <option value="">Todos los doctores</option>
          {doctors.map((d) => (
            <option key={d._id} value={d._id}>
              {d.name}
            </option>
          ))}
        </select>
        <span className="text-sm text-slate-500">{appointments.length} citas</span>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="grid grid-cols-[60px_repeat(7,minmax(0,1fr))]">
          <div className="bg-slate-50 border-b border-r border-slate-200 py-2" />
          {days.map((d, i) => {
            const isToday = ymd(d) === ymd(new Date());
            return (
              <div
                key={i}
                className={`text-center py-2 text-sm font-semibold border-b border-slate-200 ${
                  isToday ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-50 text-slate-700'
                }`}
              >
                {DAYS[i]} <span className="font-normal text-slate-500">{formatDate(d)}</span>
              </div>
            );
          })}
        </div>

        <div className="relative grid grid-cols-[60px_repeat(7,minmax(0,1fr))]">
          <div>
            {HOURS.map((h) => (
              <div
                key={h}
                style={{ height: ROW_HEIGHT }}
                className="text-[11px] text-slate-400 text-right pr-1 border-r border-slate-200 -mt-2"
              >
                {String(h).padStart(2, '0')}:00
              </div>
            ))}
          </div>

          {days.map((d, i) => {
            const k = ymd(d);
            const dayAppts = apptsByDay.get(k) || [];
            const dayBlocks = blocksByDay.get(k) || [];
            return (
              <div
                key={i}
                className="relative border-r border-slate-200"
                style={{ height: HOURS.length * ROW_HEIGHT }}
              >
                {HOURS.map((h) => (
                  <div
                    key={h}
                    style={{ height: ROW_HEIGHT }}
                    className="border-b border-slate-100"
                  />
                ))}

                {/* Bloqueos como bandas grises */}
                {dayBlocks.map((b) => {
                  const startM = b.allDay ? baseMin : minutesFromTime(b.startTime);
                  const endM = b.allDay ? (HOURS[HOURS.length - 1] + 1) * 60 : minutesFromTime(b.endTime);
                  const top = ((startM - baseMin) / 60) * ROW_HEIGHT;
                  const h = Math.max(((endM - startM) / 60) * ROW_HEIGHT, 16);
                  return (
                    <div
                      key={b._id}
                      className="absolute left-1 right-1 bg-slate-200/70 border border-slate-300 rounded-md text-[10px] p-1 text-slate-700"
                      style={{ top, height: h }}
                      title={b.reason}
                    >
                      🚫 {b.reason || 'Bloqueado'}
                    </div>
                  );
                })}

                {/* Citas */}
                {dayAppts.map((a) => {
                  const startM = minutesFromTime(a.startTime);
                  const endM = minutesFromTime(a.endTime || a.startTime);
                  const top = ((startM - baseMin) / 60) * ROW_HEIGHT;
                  const h = Math.max(((endM - startM) / 60) * ROW_HEIGHT, 22);
                  const cls = STATUS_COLORS[a.status] || STATUS_COLORS.pendiente;
                  return (
                    <Link
                      key={a._id}
                      to={`/appointments?id=${a._id}`}
                      className={`absolute left-1 right-1 border rounded-md p-1 text-[11px] overflow-hidden ${cls}`}
                      style={{ top, height: h }}
                    >
                      <div className="font-semibold leading-tight">
                        {a.startTime} {a.patient?.firstName} {a.patient?.lastName}
                      </div>
                      <div className="opacity-80 truncate">
                        {a.doctor?.name || ''}
                      </div>
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {loading && <div className="text-sm text-slate-500">Cargando...</div>}
    </div>
  );
}
