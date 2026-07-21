import { useState, useCallback, useEffect } from 'react';
import toast from 'react-hot-toast';
import {
  HiOutlineArrowsRightLeft, HiOutlineArrowDownTray, HiOutlineExclamationTriangle,
  HiOutlinePlus, HiOutlineCog6Tooth, HiOutlineBanknotes, HiOutlineCheckCircle,
  HiOutlinePencilSquare, HiOutlineXCircle, HiOutlineEye,
} from 'react-icons/hi2';
import api from '../../api/axios';
import { useAuth } from '../../context/AuthContext';
import Modal from '../../components/Modal';
import JournalEntryViewModal from '../../components/JournalEntryViewModal';
import { fmt, fmtDate } from './_utils';
import { newIdempotencyKey, withIdempotencyKey } from '../../utils/idempotency';
import CashFlowMatrix from './_CashFlowMatrix';
import CashFlowCellModal from './_CashFlowCellModal';
import ManualSettleModal from './_ManualSettleModal';

/** Estado de una partida manual: nunca solo por color (también lleva su texto). */
const ESTADO_PARTIDA = {
  PLANIFICADO: { label: 'PLANIFICADA', cls: 'text-sky-700 bg-sky-50' },
  REALIZADO: { label: 'LIQUIDADA', cls: 'text-emerald-700 bg-emerald-50' },
  CANCELADO: { label: 'CANCELADA', cls: 'text-slate-600 bg-slate-100' },
};

/**
 * Flujo de caja: proyección diaria (lo que va a pasar) y movimientos reales (lo que pasó).
 * Son dos pestañas SEPARADAS a propósito: mezclar previsto y realizado es la forma más fácil
 * de contar el mismo dinero dos veces.
 *
 * Ningún saldo se calcula aquí: todo viene del motor del backend.
 */

/**
 * Fecha LOCAL 'YYYY-MM-DD' desplazada `n` días. Se arma con getFullYear/Month/Date (hora
 * local) y NO con toISOString (UTC): en Ecuador (UTC−5) el ISO de la tarde ya es "mañana", y
 * por eso el flujo arrancaba un día tarde. `enDias(0)` = HOY.
 */
const enDias = (n = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const SEVERIDAD = {
  alta: 'bg-rose-50 border-rose-200 text-rose-700',
  media: 'bg-amber-50 border-amber-200 text-amber-800',
  baja: 'bg-slate-50 border-slate-200 text-slate-600',
};

export default function CashFlow() {
  // Solo admin/contabilidad configuran (clasifican, reglas, saldo, partidas). El resto de roles
  // con acceso (cashflow.view) SOLO visualiza: se ocultan los controles de edición. El backend
  // igual bloquea la escritura (cashflow.manage), esto es coherencia de UI.
  const { hasRole } = useAuth();
  const canManage = hasRole('admin', 'contabilidad');
  const [tab, setTab] = useState('proyeccion');
  const [from, setFrom] = useState(enDias(0)); // arranca HOY
  const [to, setTo] = useState(enDias(30));
  const [filtros, setFiltros] = useState({ onlyOverdue: false, onlyUnclassified: false, party: '' });
  const [data, setData] = useState(null);
  const [movs, setMovs] = useState(null);
  const [cell, setCell] = useState(null);
  const [nueva, setNueva] = useState(null);
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(false);
  // Partidas manuales: listado, liquidación y trazabilidad al asiento.
  const [items, setItems] = useState(null);
  const [estadoItems, setEstadoItems] = useState('');
  const [liquidar, setLiquidar] = useState(null);
  const [entryModal, setEntryModal] = useState(null);
  // Asignación de proveedores a categorías de egreso.
  const [providerModal, setProviderModal] = useState(null); // { mode, category?, categoryLabel?, supplier? }
  const [suppliers, setSuppliers] = useState(null);          // { disponibles, asignados }

  const params = useCallback(() => ({
    from,
    to,
    party: filtros.party || undefined,
    onlyOverdue: filtros.onlyOverdue || undefined,
    onlyUnclassified: filtros.onlyUnclassified || undefined,
  }), [from, to, filtros]);

  const cargar = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get('/cash-flow/projection', { params: params() });
      setData(r.data);
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al generar el flujo');
    } finally { setLoading(false); }
  }, [params]);

  const cargarMovs = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get('/cash-flow/movements', { params: { from, to, pageSize: 500 } });
      setMovs(r.data);
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al cargar los movimientos');
    } finally { setLoading(false); }
  }, [from, to]);

  const cargarItems = useCallback(async () => {
    try {
      const r = await api.get('/cash-flow/manual-items', { params: { status: estadoItems || undefined } });
      setItems(r.data || []);
    } catch (e) { toast.error(e.response?.data?.message || 'Error al cargar las partidas'); }
  }, [estadoItems]);

  useEffect(() => { cargar(); }, [cargar]);
  useEffect(() => { if (tab === 'reales') cargarMovs(); }, [tab, cargarMovs]);
  useEffect(() => { if (tab === 'manuales') cargarItems(); }, [tab, cargarItems]);

  /**
   * Tras liquidar: la previsión desaparece del futuro y el movimiento aparece en lo real, así
   * que se refrescan las dos vistas. El modal NO se cierra aquí: se queda mostrando la
   * confirmación y los enlaces al asiento (cerrarlo es cosa del usuario).
   */
  const trasLiquidar = (item, opts = {}) => {
    cargarItems();
    cargar();
    cargarMovs();
    if (opts.verAsiento) { setLiquidar(null); setEntryModal(opts.verAsiento); }
  };

  const cancelarItem = async (item) => {
    const reason = window.prompt('Motivo de la cancelación (obligatorio):');
    if (!reason?.trim()) return;
    try {
      await api.post(`/cash-flow/manual-items/${item._id}/cancel`, { reason });
      toast.success('Partida cancelada. Deja de proyectarse y conserva su historial.');
      cargarItems();
      cargar();
    } catch (e) { toast.error(e.response?.data?.message || 'No se pudo cancelar'); }
  };

  const exportar = async () => {
    try {
      const res = await api.get('/cash-flow/projection.xlsx', { params: params(), responseType: 'blob' });
      const u = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = u; a.download = `flujo_caja_${from}_${to}.xlsx`; a.click();
      URL.revokeObjectURL(u);
    } catch { toast.error('Error al exportar'); }
  };

  const abrirConfig = async () => {
    try {
      const r = await api.get('/cash-flow/config');
      setConfig(r.data);
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  // ── Asignación de proveedores a categorías de egreso ──
  const cargarSuppliers = useCallback(async () => {
    try { const r = await api.get('/cash-flow/suppliers'); setSuppliers(r.data); }
    catch (e) { toast.error(e.response?.data?.message || 'Error al cargar proveedores'); }
  }, []);

  const abrirAgregar = (category, categoryLabel) => { setProviderModal({ mode: 'category', category, categoryLabel }); cargarSuppliers(); };
  const abrirClasificar = (supplier) => { setProviderModal({ mode: 'supplier', supplier }); cargarSuppliers(); };

  const asignarProveedor = async (supplierId, category, cerrar) => {
    try {
      await api.post('/cash-flow/suppliers/assign', { supplierId, category });
      toast.success('Proveedor asignado a la categoría.');
      if (cerrar) setProviderModal(null); else await cargarSuppliers();
      cargar(); // refresca la proyección: sale de pendientes y cae en su categoría
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  const quitarProveedor = async (supplierId) => {
    try {
      await api.post('/cash-flow/suppliers/unassign', { supplierId });
      toast.success('Proveedor quitado: vuelve a estar disponible en todas las categorías.');
      await cargarSuppliers();
      cargar();
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
          <HiOutlineArrowsRightLeft className="text-emerald-600" /> Flujo de Caja
        </h1>
        <div className="flex gap-2">
          {canManage && (
            <button onClick={() => setNueva({ direction: 'EGRESO', plannedDate: enDias(0), key: newIdempotencyKey() })}
              className="px-3 py-2 bg-emerald-600 text-white rounded-xl text-sm flex items-center gap-1.5 shadow-sm shadow-emerald-600/20">
              <HiOutlinePlus className="w-4 h-4" /> Partida manual
            </button>
          )}
          <button onClick={exportar} className="px-3 py-2 bg-slate-700 text-white rounded-xl text-sm flex items-center gap-1.5">
            <HiOutlineArrowDownTray className="w-4 h-4" /> Excel
          </button>
          {canManage && (
            <button onClick={abrirConfig} className="px-3 py-2 border border-slate-200 rounded-xl text-sm flex items-center gap-1.5 text-slate-600">
              <HiOutlineCog6Tooth className="w-4 h-4" /> Configuración
            </button>
          )}
        </div>
      </div>

      {/* Pestañas */}
      <div className="flex gap-1 border-b border-slate-200">
        {[
          ['proyeccion', 'Flujo diario proyectado'],
          ['reales', 'Movimientos reales'],
          ['manuales', 'Partidas manuales'],
        ].map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px bg-transparent cursor-pointer ${
              tab === k ? 'border-emerald-600 text-emerald-700' : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Filtros */}
      <div className="bg-white p-3 rounded-xl shadow-sm flex gap-2 items-end flex-wrap">
        <div>
          <label className="text-xs text-slate-500 block">Desde</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
            className="border border-slate-200 rounded-xl px-3 py-2" />
        </div>
        <div>
          <label className="text-xs text-slate-500 block">Hasta</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
            className="border border-slate-200 rounded-xl px-3 py-2" />
        </div>
        {tab === 'proyeccion' && (
          <>
            <div>
              <label className="text-xs text-slate-500 block">Tercero</label>
              <input value={filtros.party} onChange={(e) => setFiltros({ ...filtros, party: e.target.value })}
                placeholder="Buscar…" className="border border-slate-200 rounded-xl px-3 py-2" />
            </div>
            <label className="flex items-center gap-1.5 text-sm text-slate-600 pb-2">
              <input type="checkbox" checked={filtros.onlyOverdue}
                onChange={(e) => setFiltros({ ...filtros, onlyOverdue: e.target.checked })} />
              Solo vencidos
            </label>
            <label className="flex items-center gap-1.5 text-sm text-slate-600 pb-2">
              <input type="checkbox" checked={filtros.onlyUnclassified}
                onChange={(e) => setFiltros({ ...filtros, onlyUnclassified: e.target.checked })} />
              Sin clasificar
            </label>
          </>
        )}
        <button onClick={tab === 'proyeccion' ? cargar : cargarMovs} disabled={loading}
          className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 disabled:opacity-50">
          {loading ? 'Generando…' : 'Generar'}
        </button>
      </div>

      {tab === 'proyeccion' && data && (
        <>
          {data.alertas?.length > 0 && (
            <div className="space-y-1.5">
              {data.alertas.slice(0, 6).map((a, i) => (
                <div key={i} className={`border rounded-xl px-3 py-2 flex items-center gap-2 text-sm ${SEVERIDAD[a.severidad]}`}>
                  <HiOutlineExclamationTriangle className="w-4 h-4 shrink-0" />
                  <span>{a.mensaje}</span>
                </div>
              ))}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <div className="lg:col-span-2 grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat title="Disponible al inicio" value={fmt(data.saldoInicial)} icon={<HiOutlineBanknotes />}
                subtitle={data.config?.openingBalanceMode === 'MANUAL' ? 'Saldo inicial manual' : 'Del libro mayor'} />
              <Stat title="Ingresos del rango" value={fmt(data.totales.ingresos)} color="text-emerald-700" />
              <Stat title="Egresos del rango" value={fmt(data.totales.egresos)} color="text-rose-600" />
              <Stat title="Saldo proyectado" value={fmt(data.saldoFinal)}
                color={data.saldoFinal < 0 ? 'text-rose-600' : 'text-slate-800'} />
            </div>
            {canManage && <PendingProvidersPanel proveedores={data.proveedoresPendientes || []} onClasificar={abrirClasificar} />}
          </div>

          <CashFlowMatrix data={data} onCell={setCell} onAddProvider={canManage ? abrirAgregar : undefined} />

          <div className="text-xs text-slate-500 flex flex-wrap gap-x-4 gap-y-1">
            <span>{data.documentos} documento(s) en el rango.</span>
            {data.excluidos > 0 && <span>{data.excluidos} excluido(s) a mano.</span>}
            {data.sinProyectar > 0 && <span>{data.sinProyectar} fuera del horizonte.</span>}
            <span>
              Calendario: lunes a {data.config.includeSaturdays ? 'sábado' : 'viernes'}; el domingo se
              proyecta al lunes siguiente. El vencimiento legal nunca se modifica.
            </span>
          </div>
        </>
      )}

      {tab === 'reales' && movs && (
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden">
          <div className="px-4 pt-3 pb-2 flex items-center justify-between">
            <p className="text-sm font-semibold text-slate-700">Movimientos realizados de caja y bancos</p>
            <p className="text-xs text-slate-500">
              Ingresos <b className="text-emerald-700 font-mono">{fmt(movs.totalIn)}</b> ·
              Egresos <b className="text-rose-600 font-mono ml-1">{fmt(movs.totalOut)}</b>
              {movs.totalTransferenciasInternas > 0 && (
                <> · Traspasos internos <b className="font-mono ml-1">{fmt(movs.totalTransferenciasInternas)}</b>{' '}
                  <span className="text-slate-400">(no suman)</span></>
              )}
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead className="bg-slate-50 text-slate-600 uppercase text-[10px]">
                <tr>
                  <th className="px-3 py-2 text-left">Fecha</th>
                  <th className="px-3 py-2 text-left">Cuenta</th>
                  <th className="px-3 py-2 text-left">Contraparte</th>
                  <th className="px-3 py-2 text-left">Método</th>
                  <th className="px-3 py-2 text-left">Origen</th>
                  <th className="px-3 py-2 text-left">Asiento</th>
                  <th className="px-3 py-2 text-left">Referencia</th>
                  <th className="px-3 py-2 text-right">Ingreso</th>
                  <th className="px-3 py-2 text-right">Egreso</th>
                </tr>
              </thead>
              <tbody>
                {movs.rows.map((m) => (
                  <tr key={m.id} className={`border-t border-slate-100 ${m.transferenciaInterna ? 'bg-slate-50' : ''}`}>
                    <td className="px-3 py-2">{fmtDate(m.date)}</td>
                    <td className="px-3 py-2">
                      {m.transferenciaInterna ? (
                        <span className="text-slate-600">
                          {m.origenCuentas.map((c) => c.code).join(', ')} → {m.destinoCuentas.map((c) => c.code).join(', ')}
                        </span>
                      ) : (m.cuenta ? `${m.cuenta.code} ${m.cuenta.name}` : '—')}
                    </td>
                    <td className="px-3 py-2">{m.contraparte}</td>
                    <td className="px-3 py-2">
                      {m.transferenciaInterna
                        ? <span className="text-[10px] font-bold text-slate-600 bg-slate-200 px-1.5 py-0.5 rounded">TRANSFERENCIA INTERNA</span>
                        : (m.metodo || '—')}
                    </td>
                    <td className="px-3 py-2">{m.origen}</td>
                    <td className="px-3 py-2 font-mono">{m.numeroAsiento}</td>
                    <td className="px-3 py-2">{m.referencia || '—'}</td>
                    <td className="px-3 py-2 text-right font-mono text-emerald-600">{m.ingreso ? fmt(m.ingreso) : ''}</td>
                    <td className="px-3 py-2 text-right font-mono text-rose-600">{m.egreso ? fmt(m.egreso) : ''}</td>
                  </tr>
                ))}
                {!movs.rows.length && (
                  <tr><td colSpan={9} className="px-3 py-8 text-center text-slate-400">Sin movimientos en el período</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'manuales' && (
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden">
          <div className="px-4 pt-3 pb-2 flex items-center justify-between flex-wrap gap-2">
            <p className="text-sm font-semibold text-slate-700">Previsiones sin documento contable</p>
            <select value={estadoItems} onChange={(e) => setEstadoItems(e.target.value)}
              className="border border-slate-200 rounded-xl px-3 py-1.5 text-sm">
              <option value="">Todas</option>
              <option value="PLANIFICADO">Planificadas</option>
              <option value="REALIZADO">Liquidadas</option>
              <option value="CANCELADO">Canceladas</option>
            </select>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead className="bg-slate-50 text-slate-600 uppercase text-[10px]">
                <tr>
                  <th className="px-3 py-2 text-left">Fecha planificada</th>
                  <th className="px-3 py-2 text-left">Tipo</th>
                  <th className="px-3 py-2 text-left">Categoría</th>
                  <th className="px-3 py-2 text-left">Tercero</th>
                  <th className="px-3 py-2 text-left">Descripción</th>
                  <th className="px-3 py-2 text-right">Importe</th>
                  <th className="px-3 py-2 text-left">Estado</th>
                  <th className="px-3 py-2 text-right">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {(items || []).map((m) => {
                  const est = ESTADO_PARTIDA[m.status] || { label: m.status, cls: 'text-slate-600 bg-slate-100' };
                  return (
                    <tr key={m._id} className="border-t border-slate-100">
                      <td className="px-3 py-2">{fmtDate(m.plannedDate)}</td>
                      <td className={`px-3 py-2 font-semibold ${m.direction === 'INGRESO' ? 'text-emerald-700' : 'text-rose-600'}`}>
                        {m.direction === 'INGRESO' ? 'Ingreso' : 'Egreso'}
                      </td>
                      <td className="px-3 py-2">{m.category}{m.subcategory ? ` · ${m.subcategory}` : ''}</td>
                      <td className="px-3 py-2">{m.partyName || '—'}</td>
                      <td className="px-3 py-2">{m.description}</td>
                      <td className="px-3 py-2 text-right font-mono">{fmt(m.amount)}</td>
                      <td className="px-3 py-2">
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${est.cls}`}>{est.label}</span>
                        {m.status === 'REALIZADO' && (
                          <span className="block text-[10px] text-slate-400 mt-0.5">
                            {fmtDate(m.settledAt)} · {m.settledByModel}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1 justify-end">
                          {canManage && m.status === 'PLANIFICADO' && (
                            <>
                              <button onClick={() => setLiquidar(m)} title="Liquidar"
                                className="px-2 py-1 rounded-lg bg-emerald-600 text-white flex items-center gap-1 border-none cursor-pointer">
                                <HiOutlineCheckCircle className="w-4 h-4" /> Liquidar
                              </button>
                              <button onClick={() => setNueva({ ...m, id: m._id, key: newIdempotencyKey() })} title="Editar"
                                className="p-1 rounded hover:bg-slate-100 text-slate-500 bg-transparent border-none cursor-pointer">
                                <HiOutlinePencilSquare className="w-4 h-4" />
                              </button>
                              <button onClick={() => cancelarItem(m)} title="Cancelar"
                                className="p-1 rounded hover:bg-slate-100 text-rose-500 bg-transparent border-none cursor-pointer">
                                <HiOutlineXCircle className="w-4 h-4" />
                              </button>
                            </>
                          )}
                          {m.status === 'REALIZADO' && m.journalEntry && (
                            <button onClick={() => setEntryModal(m.journalEntry)} title="Ver asiento"
                              className="px-2 py-1 rounded-lg border border-slate-200 text-slate-600 flex items-center gap-1 bg-white cursor-pointer">
                              <HiOutlineEye className="w-4 h-4" /> Asiento
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {items && !items.length && (
                  <tr><td colSpan={8} className="px-3 py-8 text-center text-slate-400">Sin partidas manuales</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="px-4 py-2 text-[11px] text-slate-500 border-t border-slate-100">
            Una partida planificada <b>no tiene asiento</b>. Liquidarla lo crea (o enlaza uno ya existente):
            cambiar el estado a mano no la convierte en un movimiento real. Una partida liquidada no se
            cancela ni se edita: se anula su movimiento contable desde su propio documento.
          </p>
        </div>
      )}

      {cell && (
        <CashFlowCellModal
          cell={cell}
          range={{ from, to }}
          categories={data?.config?.categories}
          canManage={canManage}
          onClose={() => setCell(null)}
          onChanged={() => { cargar(); cargarItems(); }}
          onSettled={trasLiquidar}
        />
      )}

      {nueva && (
        <ManualItemModal
          item={nueva}
          categories={data?.config?.categories}
          onClose={() => setNueva(null)}
          onSaved={() => { setNueva(null); cargar(); cargarItems(); }}
        />
      )}

      {liquidar && (
        <ManualSettleModal
          item={{
            id: liquidar._id,
            direction: liquidar.direction,
            category: liquidar.category,
            subcategory: liquidar.subcategory,
            tercero: liquidar.partyName,
            descripcion: liquidar.description,
            amount: liquidar.amount,
            plannedDate: liquidar.plannedDate,
            estado: liquidar.status,
            notas: liquidar.notes,
          }}
          onClose={() => setLiquidar(null)}
          onSettled={trasLiquidar}
        />
      )}

      <JournalEntryViewModal
        isOpen={!!entryModal}
        onClose={() => setEntryModal(null)}
        entryId={entryModal}
        title="Asiento de la partida"
      />

      {config && <ConfigModal data={config} onClose={() => setConfig(null)} onSaved={() => { setConfig(null); cargar(); }} />}

      {providerModal && (
        <ProviderAssignModal
          modal={providerModal}
          suppliers={suppliers}
          categories={data?.config?.categories}
          onAssign={asignarProveedor}
          onUnassign={quitarProveedor}
          onClose={() => setProviderModal(null)}
        />
      )}
    </div>
  );
}

function Stat({ title, value, color = 'text-slate-800', icon, subtitle }) {
  return (
    <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-4">
      <p className="text-xs text-slate-500 flex items-center gap-1">{icon}{title}</p>
      <p className={`text-2xl font-bold font-mono ${color}`}>{value}</p>
      {subtitle && <p className="text-[10px] text-slate-400 mt-0.5">{subtitle}</p>}
    </div>
  );
}

/**
 * Recuadro (derecha del resumen) con los NOMBRES de los proveedores que tienen deudas
 * pendientes pero aún no están en ninguna categoría. Al asignarlos, desaparecen. Sin montos:
 * solo el aviso para ir a clasificarlos.
 */
function PendingProvidersPanel({ proveedores, onClasificar }) {
  return (
    <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-4">
      <p className="text-xs font-semibold text-slate-700 flex items-center gap-1">
        <HiOutlineExclamationTriangle className="w-4 h-4 text-amber-500" />
        Proveedores pendientes de clasificar
      </p>
      {proveedores.length ? (
        <>
          <p className="text-[11px] text-slate-400 mt-0.5">Tienen deudas pendientes y no están en una categoría. Clic para asignarlos.</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {proveedores.map((p) => (
              <button key={p.ref} onClick={() => onClasificar(p)}
                className="text-xs px-2 py-1 rounded-lg bg-amber-50 text-amber-800 border border-amber-200 hover:bg-amber-100 cursor-pointer">
                {p.name}
              </button>
            ))}
          </div>
        </>
      ) : (
        <p className="text-xs text-slate-400 mt-2">Todos los proveedores con deudas ya están clasificados.</p>
      )}
    </div>
  );
}

/**
 * Asignación de proveedores a categorías de egreso.
 *  · mode 'category': el botón «Agregar» de una categoría → lista de proveedores DISPONIBLES
 *    (con deudas y sin categoría; los ya asignados a otra categoría no salen) + los ya
 *    asignados a ESTA categoría (para quitarlos).
 *  · mode 'supplier': un proveedor pendiente → se elige a qué categoría va.
 */
function ProviderAssignModal({ modal, suppliers, categories, onAssign, onUnassign, onClose }) {
  const egresoCats = (categories?.EGRESO || []).filter((c) => c.isActive !== false && !c.isLoan && c.key !== 'SIN_CLASIFICAR');

  if (modal.mode === 'supplier') {
    return (
      <Modal isOpen onClose={onClose} title={`Clasificar a ${modal.supplier.name}`}>
        <p className="text-sm text-slate-600 mb-3">
          Elige la categoría de egreso para <b>{modal.supplier.name}</b>. Todas sus cuentas por pagar caerán ahí con su vencimiento.
        </p>
        <div className="grid grid-cols-2 gap-2">
          {egresoCats.map((c) => (
            <button key={c.key} onClick={() => onAssign(modal.supplier.ref, c.key, true)}
              className="px-3 py-2 rounded-xl border border-slate-200 text-sm hover:bg-emerald-50 hover:border-emerald-300 cursor-pointer text-left">
              {c.label}
            </button>
          ))}
        </div>
      </Modal>
    );
  }

  const disponibles = suppliers?.disponibles || [];
  const asignados = (suppliers?.asignados || []).filter((s) => s.category === modal.category);
  return (
    <Modal isOpen onClose={onClose} size="lg" title={`Proveedores · ${modal.categoryLabel}`}>
      <div className="space-y-4">
        <div>
          <p className="text-xs font-semibold text-slate-700 mb-1">Disponibles (con deudas, sin categoría)</p>
          <p className="text-[11px] text-slate-400 mb-2">Un proveedor ya asignado a otra categoría no aparece aquí.</p>
          <div className="border border-slate-200 rounded-xl divide-y divide-slate-100 max-h-64 overflow-auto">
            {disponibles.map((s) => (
              <div key={s.ref} className="px-3 py-2 flex items-center justify-between gap-2 text-sm">
                <span>{s.name}<span className="text-[11px] text-slate-400 ml-2">{s.docs} doc · pendiente {fmt(s.pendiente)}</span></span>
                <button onClick={() => onAssign(s.ref, modal.category, false)}
                  className="text-xs px-2.5 py-1 rounded-lg bg-emerald-600 text-white cursor-pointer">Agregar</button>
              </div>
            ))}
            {suppliers && !disponibles.length && (
              <div className="px-3 py-6 text-center text-xs text-slate-400">No hay proveedores disponibles sin clasificar.</div>
            )}
            {!suppliers && <div className="px-3 py-6 text-center text-xs text-slate-400">Cargando…</div>}
          </div>
        </div>
        {asignados.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-slate-700 mb-1">Ya en «{modal.categoryLabel}»</p>
            <div className="border border-slate-200 rounded-xl divide-y divide-slate-100">
              {asignados.map((s) => (
                <div key={s.ref} className="px-3 py-2 flex items-center justify-between text-sm">
                  <span>{s.name}<span className="text-[11px] text-slate-400 ml-2">pendiente {fmt(s.pendiente)}</span></span>
                  <button onClick={() => onUnassign(s.ref)}
                    className="text-xs px-2.5 py-1 rounded-lg border border-rose-200 text-rose-600 hover:bg-rose-50 cursor-pointer">Quitar</button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

/** Alta (o edición) de una partida manual. NO contabiliza nada: es una previsión. */
function ManualItemModal({ item, categories, onClose, onSaved }) {
  const editar = !!item.id;
  const [f, setF] = useState({
    direction: item.direction,
    category: item.category || '',
    subcategory: item.subcategory || '',
    description: item.description || '',
    partyName: item.partyName || '',
    amount: item.amount ?? '',
    plannedDate: String(item.plannedDate || '').slice(0, 10),
    origin: item.origin || 'OTRO',
    loan: {
      creditor: item.loan?.creditor || '', principal: item.loan?.principal ?? '',
      interest: item.loan?.interest ?? '', fee: item.loan?.fee ?? '',
    },
    reason: '',
  });
  const [busy, setBusy] = useState(false);
  // Una clave por INTENCIÓN: se reutiliza al reintentar y se renueva si cambia el contenido.
  const [key, setKey] = useState(item.key);

  const cats = categories?.[f.direction] || [];
  const subs = cats.find((c) => c.key === f.category)?.subcategories || [];

  const guardar = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const body = {
        ...f,
        amount: Number(f.amount),
        loan: f.origin === 'PRESTAMO' ? {
          creditor: f.loan.creditor,
          principal: Number(f.loan.principal) || 0,
          interest: Number(f.loan.interest) || 0,
          fee: Number(f.loan.fee) || 0,
        } : undefined,
      };
      if (editar) {
        // Cambiar la fecha planificada exige un motivo: queda auditado en el historial.
        await api.put(`/cash-flow/manual-items/${item.id}`, body);
        toast.success('Partida actualizada.');
      } else {
        await api.post('/cash-flow/manual-items', body, withIdempotencyKey(key));
        toast.success('Partida creada. No genera asiento: es una previsión.');
        setKey(newIdempotencyKey());
      }
      onSaved();
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error');
    } finally { setBusy(false); }
  };

  const set = (patch) => { setF((s) => ({ ...s, ...patch })); setKey(newIdempotencyKey()); };

  return (
    <Modal isOpen onClose={onClose} size="lg" title={editar ? 'Editar partida manual' : 'Nueva partida manual'}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs text-slate-500">Tipo</span>
            <select value={f.direction} onChange={(e) => set({ direction: e.target.value, category: '', subcategory: '' })}
              className="w-full border border-slate-200 rounded-xl px-3 py-2">
              <option value="EGRESO">Egreso</option>
              <option value="INGRESO">Ingreso</option>
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-slate-500">Origen</span>
            <select value={f.origin} onChange={(e) => set({ origin: e.target.value })}
              className="w-full border border-slate-200 rounded-xl px-3 py-2">
              <option value="OTRO">Otro</option>
              <option value="PRESTAMO">Préstamo</option>
              <option value="APORTE">Aporte de socio</option>
              <option value="GASTO_EXTRAORDINARIO">Gasto extraordinario</option>
              <option value="DEVOLUCION">Devolución</option>
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-slate-500">Categoría</span>
            <select value={f.category} onChange={(e) => set({ category: e.target.value, subcategory: '' })}
              className="w-full border border-slate-200 rounded-xl px-3 py-2">
              <option value="">— elegir —</option>
              {cats.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-slate-500">Subcategoría</span>
            <select value={f.subcategory} onChange={(e) => set({ subcategory: e.target.value })}
              className="w-full border border-slate-200 rounded-xl px-3 py-2">
              <option value="">— sin subcategoría —</option>
              {subs.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </label>
          <label className="block col-span-2">
            <span className="text-xs text-slate-500">Descripción</span>
            <input value={f.description} onChange={(e) => set({ description: e.target.value })}
              className="w-full border border-slate-200 rounded-xl px-3 py-2" />
          </label>
          <label className="block">
            <span className="text-xs text-slate-500">Tercero</span>
            <input value={f.partyName} onChange={(e) => set({ partyName: e.target.value })}
              className="w-full border border-slate-200 rounded-xl px-3 py-2" />
          </label>
          <label className="block">
            <span className="text-xs text-slate-500">Importe</span>
            <input type="number" step="0.01" min="0" value={f.amount} onChange={(e) => set({ amount: e.target.value })}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 font-mono" />
          </label>
          <label className="block">
            <span className="text-xs text-slate-500">Fecha planificada</span>
            <input type="date" value={f.plannedDate} onChange={(e) => set({ plannedDate: e.target.value })}
              className="w-full border border-slate-200 rounded-xl px-3 py-2" />
          </label>
        </div>

        {f.origin === 'PRESTAMO' && (
          <div className="bg-violet-50 border border-violet-200 rounded-xl p-3 space-y-2">
            <p className="text-xs font-semibold text-violet-800">Desglose de la cuota</p>
            <div className="grid grid-cols-4 gap-2">
              {[['creditor', 'Acreedor', 'text'], ['principal', 'Capital', 'number'],
                ['interest', 'Interés', 'number'], ['fee', 'Comisión', 'number']].map(([k, label, type]) => (
                  <label key={k} className="block">
                    <span className="text-[11px] text-slate-500">{label}</span>
                    <input type={type} step="0.01" value={f.loan[k]}
                      onChange={(e) => set({ loan: { ...f.loan, [k]: e.target.value } })}
                      className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
                  </label>
                ))}
            </div>
            <p className="text-[11px] text-violet-700">
              El capital y el interés se capturan aquí: no se deducen automáticamente de ningún asiento.
            </p>
          </div>
        )}

        {editar && (
          <label className="block">
            <span className="text-xs text-slate-500">Motivo del cambio (obligatorio si mueves la fecha)</span>
            <input value={f.reason} onChange={(e) => setF((s) => ({ ...s, reason: e.target.value }))}
              placeholder="Se retrasa el pago, cambia el importe acordado…"
              className="w-full border border-slate-200 rounded-xl px-3 py-2" />
          </label>
        )}

        <p className="text-[11px] text-slate-500 bg-slate-50 rounded-lg p-2">
          Una partida planificada <b>no genera asiento contable</b>. Cuando el dinero se mueva de verdad,
          liquídala: se contabiliza el movimiento (o se enlaza el cobro/pago ya registrado). Cambiarle el
          estado a mano no la convierte en real.
        </p>

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-xl border border-slate-200 text-slate-600">Cancelar</button>
          <button onClick={guardar} disabled={busy} className="px-4 py-2 rounded-xl bg-emerald-600 text-white disabled:opacity-50">
            {busy ? 'Guardando…' : (editar ? 'Guardar cambios' : 'Crear partida')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Configuración: cuentas del disponible, calendario, horizonte y umbral de alerta. */
function ConfigModal({ data, onClose, onSaved }) {
  const [c, setC] = useState(data.config);
  const [busy, setBusy] = useState(false);

  const guardar = async () => {
    setBusy(true);
    try {
      await api.put('/cash-flow/config', {
        defaultHorizonDays: Number(c.defaultHorizonDays),
        maxRangeDays: Number(c.maxRangeDays),
        includeSaturdays: c.includeSaturdays,
        minimumBalanceThreshold: Number(c.minimumBalanceThreshold) || 0,
        showEmptyCategories: c.showEmptyCategories,
        overdueBucket: c.overdueBucket,
        openingBalanceMode: c.openingBalanceMode || 'AUTO',
        openingBalanceManual: Number(c.openingBalanceManual) || 0,
      });
      toast.success('Configuración guardada');
      onSaved();
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error');
    } finally { setBusy(false); }
  };

  return (
    <Modal isOpen onClose={onClose} size="lg" title="Configuración del flujo de caja">
      <div className="space-y-4">
        <div>
          <p className="text-xs font-semibold text-slate-700 mb-1">Cuentas que forman el disponible</p>
          <div className="border border-slate-200 rounded-xl divide-y divide-slate-100">
            {data.cuentasResueltas.map((a) => (
              <div key={a._id} className="px-3 py-1.5 flex justify-between text-sm">
                <span className="font-mono text-slate-500">{a.code}</span>
                <span className="flex-1 px-3">{a.name}</span>
                <span className="text-xs text-slate-400">{a.kind}</span>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-slate-500 mt-1">
            Se resuelven por rol contable (caja, caja chica, bancos) e incluyen sus cuentas hijas.
          </p>
        </div>

        {/* Saldo inicial de la proyección: del mayor (auto) o tecleado (manual). */}
        <div>
          <p className="text-xs font-semibold text-slate-700 mb-1">Saldo bancario inicial de la proyección</p>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-slate-500">Modo</span>
              <select value={c.openingBalanceMode || 'AUTO'}
                onChange={(e) => setC({ ...c, openingBalanceMode: e.target.value })}
                className="w-full border border-slate-200 rounded-xl px-3 py-2">
                <option value="AUTO">Automático (saldo del libro mayor)</option>
                <option value="MANUAL">Manual (lo escribo yo)</option>
              </select>
            </label>
            <label className="block">
              <span className="text-xs text-slate-500">Saldo inicial manual</span>
              <input type="number" step="0.01" value={c.openingBalanceManual ?? 0}
                disabled={(c.openingBalanceMode || 'AUTO') !== 'MANUAL'}
                onChange={(e) => setC({ ...c, openingBalanceManual: e.target.value })}
                className="w-full border border-slate-200 rounded-xl px-3 py-2 font-mono disabled:bg-slate-50 disabled:text-slate-400" />
            </label>
          </div>
          <p className="text-[11px] text-slate-500 mt-1">
            <b>Automático</b>: la suma de las cuentas de caja/banco al cierre del día anterior, leída del libro
            mayor. <b>Manual</b>: el valor que escribas aquí (útil al arrancar el módulo, cuando el mayor aún no
            refleja el efectivo real). El resto de la proyección no cambia.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs text-slate-500">Horizonte por defecto (días)</span>
            <input type="number" min="1" value={c.defaultHorizonDays}
              onChange={(e) => setC({ ...c, defaultHorizonDays: e.target.value })}
              className="w-full border border-slate-200 rounded-xl px-3 py-2" />
          </label>
          <label className="block">
            <span className="text-xs text-slate-500">Rango máximo (días)</span>
            <input type="number" min="1" value={c.maxRangeDays}
              onChange={(e) => setC({ ...c, maxRangeDays: e.target.value })}
              className="w-full border border-slate-200 rounded-xl px-3 py-2" />
          </label>
          <label className="block">
            <span className="text-xs text-slate-500">Saldo mínimo para alertar</span>
            <input type="number" step="0.01" value={c.minimumBalanceThreshold}
              onChange={(e) => setC({ ...c, minimumBalanceThreshold: e.target.value })}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 font-mono" />
          </label>
          <label className="block">
            <span className="text-xs text-slate-500">Obligaciones ya vencidas</span>
            <select value={c.overdueBucket} onChange={(e) => setC({ ...c, overdueBucket: e.target.value })}
              className="w-full border border-slate-200 rounded-xl px-3 py-2">
              <option value="FIRST_DAY">Acumularlas en el primer día del rango</option>
              <option value="HIDE">No mostrarlas</option>
            </select>
          </label>
        </div>

        <label className="flex items-start gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={c.includeSaturdays !== false}
            onChange={(e) => setC({ ...c, includeSaturdays: e.target.checked })} className="mt-0.5" />
          <span>
            El <b>sábado</b> es día hábil (no se desplaza). Si lo desactivas, un vencimiento en sábado se
            proyectará el lunes. El <b>domingo</b> siempre se proyecta al lunes. En ningún caso se modifica
            el vencimiento legal del documento.
          </span>
        </label>

        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={!!c.showEmptyCategories}
            onChange={(e) => setC({ ...c, showEmptyCategories: e.target.checked })} />
          Mostrar también las categorías sin importes
        </label>

        <p className="text-[11px] text-slate-500 bg-amber-50 border border-amber-200 rounded-lg p-2">
          Todavía no hay catálogo de feriados: solo se aplica la regla de fin de semana. La estructura ya
          está preparada para cargarlos por clínica cuando se defina.
        </p>

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-xl border border-slate-200 text-slate-600">Cancelar</button>
          <button onClick={guardar} disabled={busy} className="px-4 py-2 rounded-xl bg-emerald-600 text-white disabled:opacity-50">
            {busy ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
