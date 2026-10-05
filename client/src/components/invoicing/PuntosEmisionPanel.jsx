import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { HiOutlinePlus, HiOutlinePencilSquare, HiOutlineTrash, HiOutlineComputerDesktop } from 'react-icons/hi2';
import api from '../../api/axios';
import Modal from '../Modal';
import NumericInput from '../NumericInput';

const ROLE_LABEL = { admin: 'Administrador', cajero: 'Cajero', contabilidad: 'Contabilidad' };
const pad9 = (n) => String(n || 1).padStart(9, '0');
const solo3 = (v) => String(v || '').replace(/\D/g, '').slice(0, 3);

const EMPTY = {
  establecimiento: '001',
  codigo: '',
  nombre: '',
  direccionEstablecimiento: '',
  usuario: '',
  secuencialFactura: '',
  secuencialNotaCredito: '',
  activo: true,
};

/**
 * PUNTOS DE EMISIÓN (cajas). Cada uno es una serie estab-ptoEmi con su numeración propia y un
 * único usuario: lo que ese usuario factura, sus notas de crédito y su caja salen de su punto.
 * Mientras no haya ninguno, la sucursal sigue facturando con la serie única de arriba.
 */
export default function PuntosEmisionPanel({ canEdit }) {
  const [data, setData] = useState({ puntos: [], usuarios: [], legacy: null });
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null); // { punto|null }
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try {
      const res = await api.get('/puntos-emision');
      setData(res.data || { puntos: [], usuarios: [], legacy: null });
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al cargar los puntos de emisión');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const { puntos, usuarios, legacy } = data;
  const usuarioOcupado = new Map(puntos.filter((p) => p.usuario).map((p) => [String(p.usuario._id), p]));

  const abrirNuevo = () => {
    // El primer punto propone la serie que ya se venía usando, para que la numeración siga.
    const primero = puntos.length === 0 && legacy;
    const usados = new Set(puntos.map((p) => `${p.establecimiento}-${p.codigo}`));
    const estab = legacy?.establecimiento || '001';
    let siguiente = 1;
    while (usados.has(`${estab}-${String(siguiente).padStart(3, '0')}`)) siguiente += 1;
    setForm({
      ...EMPTY,
      establecimiento: estab,
      codigo: primero ? legacy.puntoEmision : String(siguiente).padStart(3, '0'),
      nombre: primero ? 'Caja principal' : `Caja ${siguiente}`,
    });
    setModal({ punto: null });
  };

  const abrirEdicion = (p) => {
    setForm({
      establecimiento: p.establecimiento,
      codigo: p.codigo,
      nombre: p.nombre || '',
      direccionEstablecimiento: p.direccionEstablecimiento || '',
      usuario: p.usuario?._id || '',
      secuencialFactura: p.secuencialFactura,
      secuencialNotaCredito: p.secuencialNotaCredito,
      activo: p.activo,
    });
    setModal({ punto: p });
  };

  const guardar = async (e) => {
    e.preventDefault();
    if (!/^\d{3}$/.test(form.establecimiento) || !/^\d{3}$/.test(form.codigo)) {
      return toast.error('Establecimiento y punto de emisión deben tener 3 dígitos (001, 002…)');
    }
    setSaving(true);
    try {
      const body = {
        ...form,
        usuario: form.usuario || null,
        secuencialFactura: form.secuencialFactura === '' ? undefined : Number(form.secuencialFactura),
        secuencialNotaCredito: form.secuencialNotaCredito === '' ? undefined : Number(form.secuencialNotaCredito),
      };
      if (modal.punto) await api.put(`/puntos-emision/${modal.punto._id}`, body);
      else await api.post('/puntos-emision', body);
      toast.success(modal.punto ? 'Punto de emisión actualizado' : 'Punto de emisión creado');
      setModal(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al guardar el punto de emisión');
    } finally {
      setSaving(false);
    }
  };

  const eliminar = async (p) => {
    if (!window.confirm(`¿Eliminar el punto ${p.establecimiento}-${p.codigo}?`)) return;
    try {
      await api.delete(`/puntos-emision/${p._id}`);
      toast.success('Punto de emisión eliminado');
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo eliminar');
    }
  };

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-slate-200 p-6 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
            <HiOutlineComputerDesktop className="w-5 h-5 text-emerald-600" />
            Puntos de emisión (cajas)
          </h2>
          <p className="text-sm text-slate-500 mt-1 max-w-2xl">
            Cada caja tiene su serie (establecimiento-punto), su numeración y un solo usuario. Lo que ese usuario
            factura, sus notas de crédito y su cierre de caja salen de su punto.
          </p>
        </div>
        {canEdit && (
          <button
            type="button"
            onClick={abrirNuevo}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-medium cursor-pointer border-none"
          >
            <HiOutlinePlus className="w-4 h-4" /> Nuevo punto
          </button>
        )}
      </div>

      {!loading && puntos.length === 0 && (
        <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 text-sm text-amber-800">
          Aún no hay puntos de emisión: todas las facturas salen con la serie única{' '}
          <strong className="font-mono">{legacy ? `${legacy.establecimiento}-${legacy.puntoEmision}` : '001-001'}</strong>{' '}
          de arriba. Al crear el primero, <strong>solo podrán facturar y abrir caja los usuarios que tengan un punto asignado</strong>.
        </div>
      )}

      {puntos.length > 0 && (
        <div className="overflow-x-auto">
          <table className="tbl tbl-cards w-full">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase text-slate-500">
                <th className="text-left px-3 py-2">Serie</th>
                <th className="text-left px-3 py-2">Caja</th>
                <th className="text-left px-3 py-2">Usuario</th>
                <th className="text-right px-3 py-2">Próx. factura</th>
                <th className="text-right px-3 py-2">Próx. N/C</th>
                <th className="text-left px-3 py-2">Estado</th>
                {canEdit && <th className="px-3 py-2"></th>}
              </tr>
            </thead>
            <tbody>
              {puntos.map((p) => (
                <tr key={p._id} className="md:border-b md:border-slate-100">
                  <td data-cell="principal" className="md:px-3 md:py-2.5 text-sm text-slate-800">
                    <span className="font-mono font-semibold">{p.establecimiento}-{p.codigo}</span>
                    {p.nombre && <span className="md:hidden"> · {p.nombre}</span>}
                  </td>
                  {/* Móvil: la tarjeta tiene una sola franja de detalle; en escritorio, columnas. */}
                  <td data-cell="detalle" className="md:hidden text-slate-600">
                    {p.usuario ? p.usuario.name : <span className="text-amber-600">Sin asignar</span>}
                    {' · '}Próx. factura <span className="font-mono">{pad9(p.secuencialFactura)}</span>
                    {' · '}N/C <span className="font-mono">{pad9(p.secuencialNotaCredito)}</span>
                  </td>
                  <td className="hidden md:table-cell md:px-3 md:py-2.5 text-sm text-slate-700">
                    {p.nombre || '—'}
                    {p.direccionEstablecimiento && <span className="block text-xs text-slate-400">{p.direccionEstablecimiento}</span>}
                  </td>
                  <td className="hidden md:table-cell md:px-3 md:py-2.5 text-sm">
                    {p.usuario ? <span className="text-slate-800">{p.usuario.name}</span> : <span className="text-amber-600">Sin asignar</span>}
                  </td>
                  <td className="hidden md:table-cell md:px-3 md:py-2.5 text-xs font-mono text-slate-600 text-right">
                    {pad9(p.secuencialFactura)}
                  </td>
                  <td className="hidden md:table-cell md:px-3 md:py-2.5 text-xs font-mono text-slate-600 text-right">
                    {pad9(p.secuencialNotaCredito)}
                  </td>
                  <td data-cell="estado" className="md:px-3 md:py-2.5 text-xs">
                    <span className={`px-2 py-0.5 rounded-full font-medium ${p.activo ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}`}>
                      {p.activo ? 'Activo' : 'Inactivo'}
                    </span>
                    {p.cajaAbiertaDesde && (
                      <span className="ml-1 px-2 py-0.5 rounded-full font-medium bg-blue-100 text-blue-700">Caja abierta</span>
                    )}
                  </td>
                  {canEdit && (
                    <td data-cell="acciones" className="md:px-3 md:py-2.5 text-right whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => abrirEdicion(p)}
                        className="p-1.5 rounded-lg hover:bg-emerald-50 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer"
                        title="Editar"
                      >
                        <HiOutlinePencilSquare className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => eliminar(p)}
                        className="p-1.5 rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-600 bg-transparent border-none cursor-pointer"
                        title="Eliminar"
                      >
                        <HiOutlineTrash className="w-4 h-4" />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        isOpen={!!modal}
        onClose={() => setModal(null)}
        title={modal?.punto ? `Punto de emisión ${modal.punto.establecimiento}-${modal.punto.codigo}` : 'Nuevo punto de emisión'}
        size="lg"
      >
        <form onSubmit={guardar} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Campo label="Establecimiento (3 dígitos)" required>
              <input
                className="input font-mono"
                inputMode="numeric"
                maxLength={3}
                value={form.establecimiento}
                onChange={(e) => set('establecimiento', solo3(e.target.value))}
                onBlur={() => form.establecimiento && set('establecimiento', form.establecimiento.padStart(3, '0'))}
              />
            </Campo>
            <Campo label="Punto de emisión (3 dígitos)" required>
              <input
                className="input font-mono"
                inputMode="numeric"
                maxLength={3}
                value={form.codigo}
                onChange={(e) => set('codigo', solo3(e.target.value))}
                onBlur={() => form.codigo && set('codigo', form.codigo.padStart(3, '0'))}
              />
            </Campo>
            <Campo label="Nombre de la caja">
              <input className="input" value={form.nombre} onChange={(e) => set('nombre', e.target.value)} placeholder="Caja recepción" />
            </Campo>
            <Campo label="Usuario asignado">
              <select className="input" value={form.usuario} onChange={(e) => set('usuario', e.target.value)}>
                <option value="">— Sin asignar —</option>
                {usuarios.map((u) => {
                  const ocupado = usuarioOcupado.get(String(u._id));
                  const deOtro = ocupado && String(ocupado._id) !== String(modal?.punto?._id || '');
                  return (
                    <option key={u._id} value={u._id} disabled={deOtro}>
                      {u.name} · {ROLE_LABEL[u.role] || u.role}
                      {deOtro ? ` (ya tiene ${ocupado.establecimiento}-${ocupado.codigo})` : ''}
                    </option>
                  );
                })}
              </select>
            </Campo>
            <div className="sm:col-span-2">
              <Campo label="Dirección del establecimiento">
                <input
                  className="input"
                  value={form.direccionEstablecimiento}
                  onChange={(e) => set('direccionEstablecimiento', e.target.value)}
                  placeholder={legacy?.direccionEstablecimiento || 'Vacía = la dirección de la configuración'}
                />
              </Campo>
            </div>
            <Campo label="Próximo número de factura">
              <NumericInput
                className="input font-mono"
                min={1}
                allowDecimal={false}
                value={form.secuencialFactura}
                onChange={(e) => set('secuencialFactura', e.target.value)}
                placeholder="Automático"
              />
            </Campo>
            <Campo label="Próximo número de nota de crédito">
              <NumericInput
                className="input font-mono"
                min={1}
                allowDecimal={false}
                value={form.secuencialNotaCredito}
                onChange={(e) => set('secuencialNotaCredito', e.target.value)}
                placeholder="Automático"
              />
            </Campo>
          </div>
          {!modal?.punto && (
            <p className="text-xs text-slate-500">
              Si deja los números vacíos, el punto continúa la numeración que ya tenga esa serie
              {legacy ? ` (la serie ${legacy.establecimiento}-${legacy.puntoEmision} va por la factura ${pad9(legacy.secuencial)})` : ''}.
            </p>
          )}
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" className="w-4 h-4" checked={form.activo} onChange={(e) => set('activo', e.target.checked)} />
            Punto activo
          </label>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setModal(null)}
              className="px-4 py-2 rounded-lg text-sm border border-slate-200 bg-white text-slate-600 cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-medium disabled:opacity-50 cursor-pointer border-none"
            >
              {saving ? 'Guardando...' : 'Guardar'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

function Campo({ label, required, children }) {
  return (
    <div>
      <label className="block text-sm font-semibold text-slate-700 mb-1.5">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      {children}
    </div>
  );
}
