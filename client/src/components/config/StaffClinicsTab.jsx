import { useMemo, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import { EmptyState } from '../PageHeader';
import { ROLE_LABELS } from '../../utils/roles';
import { nombreSucursal } from '../../utils/clinicName';
import { HiOutlineBuildingOffice2, HiOutlineMagnifyingGlass } from 'react-icons/hi2';

/**
 * PERSONAL POR SUCURSAL.
 *
 * Una rejilla: una fila por persona, una columna por sucursal, y en cada cruce
 * el rol que tiene ahí (o nada, si no trabaja en esa sede).
 *
 * POR QUÉ ESTA PANTALLA. La asignación persona→sucursal ya existía en el modelo
 * (`User.clinics[]`), pero solo se tocaba desde «Usuarios», que enseña
 * ÚNICAMENTE la sucursal activa: para saber si Karla también estaba en Norte
 * había que cambiar de sede en el menú y volver a mirar. El resultado práctico
 * era gente asignada a sedes donde ya no trabaja.
 *
 * Y de esto dependen los avisos. Cuando una cita pasa a enfermería, el aviso
 * sale a los enfermeros DE ESA SUCURSAL. Un enfermero asignado a tres sedes
 * recibe los avisos de las tres, se acostumbra a ignorarlos, y el día que le
 * toca a él tampoco lo mira.
 */

// El "sin asignar" de un desplegable. Cadena vacía y no null: es el value de un
// <option>, y con null React lo trataría como no controlado.
const SIN_ASIGNAR = '';

// Roles que se reparten por sucursal. Primero los que atienden en una sede
// física, que son los que se mueven de sitio.
const ROLES_OPERATIVOS = [
  'doctor',
  'optica',
  'ginecologia',
  'podologia',
  'odontologia',
  'cosmetologia',
  'cardiologia',
  'terapeuta',
  'enfermero',
  'cajero',
  'admin',
  'contabilidad',
  'call_center',
  'marketing',
];

/** Sin tildes y en minúsculas, para que "Perez" encuentre a "Pérez". */
const plano = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export default function StaffClinicsTab({ clinics, users, onUsersChange }) {
  // Cambios sin guardar: { [userId]: { [clinicId]: role | '' } }
  const [borrador, setBorrador] = useState({});
  const [guardando, setGuardando] = useState(null);
  const [q, setQ] = useState('');
  const [filtroRol, setFiltroRol] = useState('');
  const [filtroSede, setFiltroSede] = useState('');

  /** Rol guardado de `u` en la sucursal `clinicId` ('' si no trabaja ahí). */
  const rolGuardado = (u, clinicId) =>
    (u.clinics || []).find((c) => String(c.clinic?._id || c.clinic) === String(clinicId))?.role || SIN_ASIGNAR;

  /** Rol que se está mostrando: el del borrador si se tocó, si no el guardado. */
  const rolActual = (u, clinicId) => {
    const cambio = borrador[u._id]?.[clinicId];
    return cambio === undefined ? rolGuardado(u, clinicId) : cambio;
  };

  const tieneCambios = (u) => clinics.some((c) => rolActual(u, c._id) !== rolGuardado(u, c._id));

  const cambiar = (u, clinicId, role) =>
    setBorrador((b) => ({ ...b, [u._id]: { ...(b[u._id] || {}), [clinicId]: role } }));

  const descartar = (u) =>
    setBorrador((b) => {
      const copia = { ...b };
      delete copia[u._id];
      return copia;
    });

  const guardar = async (u) => {
    setGuardando(u._id);
    try {
      // Se manda la lista COMPLETA de las sucursales visibles: lo que no va, el
      // servidor lo entiende como "ya no trabaja ahí". Las sedes que este admin
      // no gestiona no viajan y el servidor las conserva.
      const assignments = clinics
        .map((c) => ({ clinic: c._id, role: rolActual(u, c._id) }))
        .filter((a) => a.role);
      const { data } = await api.put(`/users/${u._id}/assignments`, { assignments });
      onUsersChange((list) => list.map((x) => (x._id === u._id ? { ...x, clinics: data.clinics } : x)));
      descartar(u);
      const sedes = assignments.length;
      toast.success(
        sedes === 0
          ? `${u.name} ya no está en ninguna sucursal`
          : `${u.name}: ${sedes} ${sedes === 1 ? 'sucursal' : 'sucursales'}`,
      );
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo guardar');
    } finally {
      setGuardando(null);
    }
  };

  const visibles = useMemo(() => {
    const texto = plano(q.trim());
    return users.filter((u) => {
      if (texto && !plano(u.name).includes(texto) && !plano(u.email).includes(texto)) return false;
      const roles = clinics.map((c) => rolActual(u, c._id)).filter(Boolean);
      if (filtroRol && !roles.includes(filtroRol)) return false;
      if (filtroSede && !rolActual(u, filtroSede)) return false;
      return true;
    });
    // `borrador` entra a propósito: al cambiar un rol la fila debe seguir (o
    // dejar de) cumplir el filtro sin esperar a guardar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [users, clinics, q, filtroRol, filtroSede, borrador]);

  // Cuánta gente activa hay por sede: es el número que de verdad se viene a
  // mirar («¿cuántos enfermeros tengo en Norte?»).
  const conteo = useMemo(() => {
    const acc = {};
    clinics.forEach((c) => {
      acc[c._id] = users.filter((u) => {
        const r = rolActual(u, c._id);
        return r && (!filtroRol || r === filtroRol) && u.active !== false;
      }).length;
    });
    return acc;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [users, clinics, filtroRol, borrador]);

  if (clinics.length === 0) {
    return (
      <EmptyState
        icon={HiOutlineBuildingOffice2}
        title="No administras ninguna sucursal"
        hint="Solo puedes repartir personal en las sedes donde eres administrador."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="bg-sky-50 border border-sky-200 text-sky-900 text-xs sm:text-sm rounded-xl px-3 py-2">
        Cuando una cita necesita enfermería, el aviso llega solo a los enfermeros de
        <b> esa</b> sucursal. Si alguien está asignado a varias, le suenan todas.
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <HiOutlineMagnifyingGlass className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar por nombre o correo…"
            className="input pl-9"
          />
        </div>
        <select value={filtroRol} onChange={(e) => setFiltroRol(e.target.value)} className="input w-auto">
          <option value="">Todos los roles</option>
          {ROLES_OPERATIVOS.map((r) => (
            <option key={r} value={r}>{ROLE_LABELS[r] || r}</option>
          ))}
        </select>
        <select value={filtroSede} onChange={(e) => setFiltroSede(e.target.value)} className="input w-auto">
          <option value="">Todas las sucursales</option>
          {clinics.map((c) => (
            <option key={c._id} value={c._id}>{nombreSucursal(c)}</option>
          ))}
        </select>
      </div>

      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-slate-200 overflow-x-auto">
        <table className="tbl">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="text-left px-4 py-3 font-semibold sticky left-0 bg-slate-50 z-10 min-w-[200px]">
                Persona
              </th>
              {clinics.map((c) => (
                <th key={c._id} className="text-left px-3 py-3 font-semibold min-w-[170px]">
                  {nombreSucursal(c)}
                  <span className="block text-[11px] font-normal text-slate-400">
                    {conteo[c._id] || 0} {conteo[c._id] === 1 ? 'persona' : 'personas'}
                  </span>
                </th>
              ))}
              <th className="px-3 py-3 w-40"></th>
            </tr>
          </thead>
          <tbody>
            {visibles.length === 0 && (
              <tr>
                <td colSpan={clinics.length + 2}>
                  <EmptyState
                    icon={HiOutlineBuildingOffice2}
                    title="Nadie coincide"
                    hint="Prueba con otro nombre, rol o sucursal."
                  />
                </td>
              </tr>
            )}
            {visibles.map((u) => {
              const sucio = tieneCambios(u);
              const sinSede = clinics.every((c) => !rolActual(u, c._id));
              return (
                <tr
                  key={u._id}
                  className={`border-t border-slate-100 ${sucio ? 'bg-amber-50/60' : 'hover:bg-slate-50'}`}
                >
                  <td className={`px-4 py-3 sticky left-0 z-10 ${sucio ? 'bg-amber-50' : 'bg-white'}`}>
                    <div className="font-medium text-slate-800 flex items-center gap-1.5 flex-wrap">
                      {u.name}
                      {u.isSuperAdmin && (
                        <span className="text-[10px] px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded">super</span>
                      )}
                      {u.active === false && (
                        <span className="text-[10px] px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded">inactivo</span>
                      )}
                    </div>
                    <div className="text-xs text-slate-500 truncate max-w-[220px]">{u.email}</div>
                    {/* Alguien sin sede no le aparece a nadie: ni en la agenda ni
                        en los avisos. Es un estado válido (se fue, está de baja)
                        pero tiene que verse, no adivinarse. */}
                    {sinSede && (
                      <div className="text-[11px] text-amber-700 mt-0.5">Sin sucursal asignada</div>
                    )}
                  </td>

                  {clinics.map((c) => {
                    const valor = rolActual(u, c._id);
                    const cambiado = valor !== rolGuardado(u, c._id);
                    return (
                      <td key={c._id} className="px-3 py-2">
                        <select
                          value={valor}
                          onChange={(e) => cambiar(u, c._id, e.target.value)}
                          className={`input text-xs py-1.5 ${
                            cambiado ? 'border-amber-400 bg-amber-50' : valor ? '' : 'text-slate-400'
                          }`}
                        >
                          <option value={SIN_ASIGNAR}>— No trabaja aquí —</option>
                          {ROLES_OPERATIVOS.map((r) => (
                            <option key={r} value={r}>{ROLE_LABELS[r] || r}</option>
                          ))}
                          {/**
                            * UN ROL RETIRADO SIGUE SIENDO UN ROL HASTA QUE SE MIGRE.
                            *
                            * Sin esta opción, el <select> de alguien que todavía
                            * tiene guardado un rol que se quitó de la lista (pasó
                            * con 'ecografista') sale EN BLANCO. Y como guardar
                            * manda la fila entera y descarta las sedes sin rol,
                            * abrir esta pantalla y darle a guardar le borraba la
                            * sucursal a esa persona sin decir nada.
                            */}
                          {valor && !ROLES_OPERATIVOS.includes(valor) && (
                            <option value={valor}>{ROLE_LABELS[valor] || valor} (rol retirado)</option>
                          )}
                        </select>
                      </td>
                    );
                  })}

                  <td className="px-3 py-2">
                    {sucio && (
                      <div className="flex items-center gap-1.5 justify-end">
                        <button
                          type="button"
                          onClick={() => descartar(u)}
                          className="text-xs text-slate-500 hover:text-slate-700 bg-transparent border-none cursor-pointer underline p-0"
                        >
                          Descartar
                        </button>
                        <button
                          type="button"
                          onClick={() => guardar(u)}
                          disabled={guardando === u._id}
                          className="text-xs font-medium px-2.5 py-1 rounded-lg bg-emerald-600 text-white border-none cursor-pointer hover:bg-emerald-700 disabled:opacity-50"
                        >
                          {guardando === u._id ? 'Guardando…' : 'Guardar'}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-400">
        Para crear personas nuevas, cambiar contraseñas o desactivarlas, ve a Configuración → Usuarios.
      </p>
    </div>
  );
}
