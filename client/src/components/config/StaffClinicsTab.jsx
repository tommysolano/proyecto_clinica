import { useMemo, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import { EmptyState } from '../PageHeader';
import { ROLE_LABELS } from '../../utils/roles';
import { nombreSucursal } from '../../utils/clinicName';
import { HiOutlineBuildingOffice2, HiOutlineMagnifyingGlass } from 'react-icons/hi2';

/**
 * PERSONAL POR SUCURSAL: una fila por persona y UNA columna, la sucursal.
 *
 * POR QUÉ ESTA PANTALLA. La asignación persona→sucursal ya existía en el modelo
 * (`User.clinics[]`), pero solo se tocaba desde «Usuarios», que enseña
 * ÚNICAMENTE la sucursal activa: para saber si Karla también estaba en Norte
 * había que cambiar de sede en el menú y volver a mirar. El resultado práctico
 * era gente asignada a sedes donde ya no trabaja — o, peor, TODOS en la matriz,
 * que es como se llegó aquí: se agendaba una cita en Extensión y al ir a asignar
 * doctor no aparecía ninguno, porque ninguno estaba puesto en esa sede.
 *
 * ANTES ERA UNA REJILLA de persona × sucursal con el ROL en cada cruce. Se
 * cambió (sep-2026) por dos motivos:
 *  · con tres sedes eran tres desplegables por persona para contestar una
 *    pregunta que tiene UNA respuesta: dónde trabaja;
 *  · y el rol se editaba desde aquí. El rol de alguien no es un ajuste de
 *    agenda: cambia lo que ve y lo que puede hacer en TODO el sistema, y se
 *    decide en Configuración → Usuarios. Aquí ahora se enseña, no se toca.
 *
 * Y de esto dependen los avisos: cuando una cita pasa a enfermería, el aviso
 * sale a los enfermeros DE ESA SUCURSAL.
 */

// El "sin asignar" de un desplegable. Cadena vacía y no null: es el value de un
// <option>, y con null React lo trataría como no controlado.
const SIN_SEDE = '';

// Roles que se reparten por sucursal, para el filtro de arriba. Primero los que
// atienden en una sede física, que son los que se mueven de sitio.
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
  // Cambios sin guardar: { [userId]: { sede: clinicId | '', todas: boolean } }
  const [borrador, setBorrador] = useState({});
  const [guardando, setGuardando] = useState(null);
  const [q, setQ] = useState('');
  const [filtroRol, setFiltroRol] = useState('');
  const [filtroSede, setFiltroSede] = useState('');

  const idDe = (c) => String(c?.clinic?._id || c?.clinic || '');
  /** Las asignaciones de `u` que caen en las sedes que este admin gestiona. */
  const asignacionesVisibles = (u) =>
    (u.clinics || []).filter((c) => clinics.some((k) => String(k._id) === idDe(c)));

  /** Sucursal guardada ('' si no trabaja en ninguna de las visibles). */
  const sedeGuardada = (u) => idDe(asignacionesVisibles(u)[0]) || SIN_SEDE;

  /** Lo que se está MOSTRANDO: el borrador si se tocó la fila, si no lo guardado. */
  const estado = (u) => borrador[u._id] || { sede: sedeGuardada(u), todas: !!u.worksInAllClinics };
  const sedeActual = (u) => estado(u).sede;
  const todasActual = (u) => estado(u).todas;

  /** ¿Esta persona sale en el desplegable de ESTA sede? */
  const trabajaEn = (u, clinicId) =>
    todasActual(u) || String(sedeActual(u)) === String(clinicId);

  /**
   * EL ROL SE CONSERVA, NO SE ELIGE.
   *
   * Al mover a alguien de sede se lleva el rol que ya tenía. Si no tiene ninguna
   * asignación visible no hay rol que llevarse: esa persona se arregla en
   * Usuarios, y aquí se dice en vez de dejar un desplegable que no guardaría.
   */
  const rolDe = (u) =>
    asignacionesVisibles(u)[0]?.role
    // Respaldo: su rol en una sede que este admin NO gestiona. Es el mismo rol y
    // es el que hay que llevarse al moverlo, no un hueco.
    || (u.clinics || [])[0]?.role
    || '';

  const cambiar = (u, campos) =>
    setBorrador((b) => ({ ...b, [u._id]: { ...estado(u), ...campos } }));

  const descartar = (u) =>
    setBorrador((b) => {
      const copia = { ...b };
      delete copia[u._id];
      return copia;
    });

  const guardar = async (u) => {
    const { sede, todas } = estado(u);
    const role = rolDe(u);
    if (sede && !role) {
      toast.error(`${u.name} no tiene rol. Asígnaselo en Configuración → Usuarios.`);
      return;
    }
    setGuardando(u._id);
    try {
      /**
       * Se manda la lista COMPLETA de las sedes visibles —aquí, una o ninguna—:
       * lo que no va, el servidor lo entiende como «ya no trabaja ahí», y así
       * mover a alguien lo QUITA de la anterior en la misma operación. Las sedes
       * que este admin no gestiona no viajan y el servidor las conserva.
       *
       * La sucursal viaja también con el check puesto: de ella sale el ROL, que
       * es lo que se extiende a todas las sedes.
       */
      const assignments = sede ? [{ clinic: sede, role }] : [];
      const { data } = await api.put(`/users/${u._id}/assignments`, {
        assignments,
        worksInAllClinics: todas,
      });
      onUsersChange((list) =>
        list.map((x) =>
          x._id === u._id
            ? { ...x, clinics: data.clinics, worksInAllClinics: data.worksInAllClinics }
            : x,
        ),
      );
      descartar(u);
      const nombre = clinics.find((c) => String(c._id) === String(sede));
      toast.success(
        todas
          ? `${u.name} aparece en todas las sucursales`
          : sede
            ? `${u.name} trabaja en ${nombreSucursal(nombre)}`
            : `${u.name} ya no está en ninguna sucursal`,
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
      if (filtroRol && rolDe(u) !== filtroRol) return false;
      // Quien rota por todas sale en el filtro de cualquier sede: es la verdad
      // de lo que va a pasar en esa sucursal.
      if (filtroSede && !trabajaEn(u, filtroSede)) return false;
      return true;
    });
    // `borrador` entra a propósito: al cambiar la sede la fila debe seguir (o
    // dejar de) cumplir el filtro sin esperar a guardar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [users, clinics, q, filtroRol, filtroSede, borrador]);

  // Cuánta gente activa hay por sede: es el número que de verdad se viene a
  // mirar («¿cuántos enfermeros tengo en Norte?»).
  const conteo = useMemo(() => {
    const acc = {};
    clinics.forEach((c) => {
      acc[c._id] = users.filter(
        (u) =>
          trabajaEn(u, c._id)
          && (!filtroRol || rolDe(u) === filtroRol)
          && u.active !== false,
      ).length;
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
        Cada persona trabaja en <b>una</b> sucursal, salvo que marques <b>En todas</b> — para
        quien rota entre sedes según el horario. De aquí sale quién aparece al asignar la
        atención de una cita y a quién le suenan los avisos de enfermería.
      </div>

      {/* El recuento por sede, que es lo que se venía a mirar en las columnas. */}
      <div className="flex flex-wrap gap-2">
        {clinics.map((c) => (
          <button
            key={c._id}
            type="button"
            onClick={() => setFiltroSede((s) => (String(s) === String(c._id) ? '' : c._id))}
            className={`px-3 py-1.5 rounded-xl border text-xs font-medium cursor-pointer ${
              String(filtroSede) === String(c._id)
                ? 'bg-emerald-600 text-white border-emerald-600'
                : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
            }`}
          >
            {nombreSucursal(c)}
            <span className="ml-1.5 opacity-70">
              {conteo[c._id] || 0} {conteo[c._id] === 1 ? 'persona' : 'personas'}
            </span>
          </button>
        ))}
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
              <th className="text-left px-4 py-3 font-semibold min-w-[220px]">Persona</th>
              <th className="text-left px-3 py-3 font-semibold">Rol</th>
              <th className="text-left px-3 py-3 font-semibold min-w-[220px]">Sucursal</th>
              <th className="text-left px-3 py-3 font-semibold w-32">En todas</th>
              <th className="px-3 py-3 w-40"></th>
            </tr>
          </thead>
          <tbody>
            {visibles.length === 0 && (
              <tr>
                <td colSpan={5}>
                  <EmptyState
                    icon={HiOutlineBuildingOffice2}
                    title="Nadie coincide"
                    hint="Prueba con otro nombre, rol o sucursal."
                  />
                </td>
              </tr>
            )}
            {visibles.map((u) => {
              const { sede, todas } = estado(u);
              const sucio = sede !== sedeGuardada(u) || todas !== !!u.worksInAllClinics;
              const rol = rolDe(u);
              return (
                <tr
                  key={u._id}
                  className={`border-t border-slate-100 ${sucio ? 'bg-amber-50/60' : 'hover:bg-slate-50'}`}
                >
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-800 flex items-center gap-1.5 flex-wrap">
                      {u.name}
                      {u.isSuperAdmin && (
                        <span className="text-[10px] px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded">super</span>
                      )}
                      {u.active === false && (
                        <span className="text-[10px] px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded">inactivo</span>
                      )}
                    </div>
                    <div className="text-xs text-slate-500 truncate max-w-[260px]">{u.email}</div>
                  </td>

                  {/* EL ROL SE ENSEÑA, NO SE EDITA: se cambia en Usuarios, donde
                      se ve todo lo que ese rol abre en el resto del sistema. */}
                  <td className="px-3 py-3 text-slate-600">
                    {rol ? (
                      ROLE_LABELS[rol] || rol
                    ) : (
                      <span className="text-amber-700 text-xs">Sin rol — ponlo en Usuarios</span>
                    )}
                  </td>

                  <td className="px-3 py-2">
                    <select
                      value={sede}
                      onChange={(e) => cambiar(u, { sede: e.target.value })}
                      className={`input text-xs py-1.5 ${
                        sucio ? 'border-amber-400 bg-amber-50' : sede ? '' : 'border-amber-300 bg-amber-50 text-amber-800'
                      }`}
                    >
                      {/**
                        * «Sin sucursal» SE VE PERO NO SE ELIGE (`disabled`).
                        *
                        * Alguien sin sede no le aparece a nadie —ni en la agenda,
                        * ni al asignar la atención, ni en los avisos— y además
                        * DESAPARECE de esta pantalla y de Usuarios en cuanto se
                        * recarga: las dos filtran por sucursal, así que no habría
                        * forma de traerlo de vuelta salvo el super-admin. Para
                        * alguien que se va, lo correcto es desactivarlo en
                        * Usuarios: conserva su sede y su rol, y se reactiva.
                        */}
                      <option value={SIN_SEDE} disabled>— Sin sucursal —</option>
                      {clinics.map((c) => (
                        <option key={c._id} value={c._id}>{nombreSucursal(c)}</option>
                      ))}
                    </select>
                    {todas && (
                      <p className="text-[11px] text-emerald-700 mt-1">
                        De aquí sale su rol; aparece en todas.
                      </p>
                    )}
                  </td>

                  {/**
                    * «EN TODAS»: para quien rota por sedes según el horario.
                    *
                    * No sustituye a la sucursal, la extiende — de la fila de al
                    * lado sale el rol y este check dice que vale en cualquier
                    * sede. Por eso la sucursal se sigue eligiendo igual.
                    */}
                  <td className="px-3 py-2">
                    <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-600">
                      <input
                        type="checkbox"
                        checked={todas}
                        onChange={(e) => cambiar(u, { todas: e.target.checked })}
                        className="w-4 h-4 accent-emerald-600 cursor-pointer"
                      />
                      <span>Todas</span>
                    </label>
                  </td>

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
        Para crear personas nuevas, cambiar su rol o su contraseña y desactivarlas, ve a
        Configuración → Usuarios.
      </p>
    </div>
  );
}
