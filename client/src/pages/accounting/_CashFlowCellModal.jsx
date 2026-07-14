import { useEffect, useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import {
  HiOutlineArrowTopRightOnSquare, HiOutlineCalendarDays, HiOutlineTag,
  HiOutlineEyeSlash, HiOutlineEye, HiOutlineDocumentText, HiOutlineCheckCircle,
  HiOutlineXCircle,
} from 'react-icons/hi2';
import api from '../../api/axios';
import Modal from '../../components/Modal';
import { fmt, fmtDate } from './_utils';
import { SOURCE_ROUTES } from './sourceDocs';
import ManualSettleModal from './_ManualSettleModal';

/**
 * Detalle de una celda del flujo: los documentos que la componen y las acciones sobre ellos.
 *
 * El total del modal se compara contra el valor de la celda que devolvió la API: si no
 * cuadraran, se avisa en vez de mostrar dos números distintos sin explicación.
 */
export default function CashFlowCellModal({ cell, range, categories, onClose, onChanged, onSettled }) {
  const [data, setData] = useState(null);
  const [accion, setAccion] = useState(null);   // { tipo, row }
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const [liquidar, setLiquidar] = useState(null);   // partida manual a liquidar

  const cargar = useCallback(async () => {
    try {
      const r = await api.get('/cash-flow/projection/cell', {
        params: {
          from: range.from, to: range.to,
          date: cell.date, direction: cell.direction,
          category: cell.category, subcategory: cell.subcategory || undefined,
        },
      });
      setData(r.data);
    } catch (e) { toast.error(e.response?.data?.message || 'Error al cargar el detalle'); }
  }, [cell, range]);

  useEffect(() => { cargar(); }, [cargar]);

  const descuadre = data && data.celda != null && Math.abs(data.total - data.celda) > 0.01;

  const ejecutar = async () => {
    if (busy) return;
    setBusy(true);
    const { tipo, row } = accion;
    const base = { docModel: row.docModel, docRef: row.id };
    try {
      if (tipo === 'reprogramar') {
        if (!form.reason?.trim()) throw new Error('El motivo es obligatorio.');
        await api.post('/cash-flow/reschedule', { ...base, newDate: form.newDate, reason: form.reason });
        toast.success('Reprogramado. El vencimiento legal no cambió.');
      } else if (tipo === 'reclasificar') {
        await api.post('/cash-flow/classify', {
          ...base,
          category: form.category,
          subcategory: form.subcategory || null,
          saveRule: !!form.saveRule,
          ruleMatch: form.saveRule && row.terceroRef
            ? { matchType: row.direction === 'EGRESO' ? 'SUPPLIER' : 'CUSTOMER', matchValue: row.terceroRef }
            : undefined,
        });
        toast.success(form.saveRule ? 'Clasificado y regla guardada para los futuros' : 'Clasificado');
      } else if (tipo === 'excluir') {
        if (!form.reason?.trim()) throw new Error('El motivo es obligatorio.');
        await api.post('/cash-flow/exclude', { ...base, excluded: true, reason: form.reason });
        toast.success('Excluido de la proyección');
      } else if (tipo === 'incluir') {
        await api.post('/cash-flow/exclude', { ...base, excluded: false });
        toast.success('Incluido de nuevo');
      } else if (tipo === 'nota') {
        await api.post('/cash-flow/note', { ...base, note: form.note || '' });
        toast.success('Nota guardada');
      } else if (tipo === 'cancelar') {
        if (!form.reason?.trim()) throw new Error('El motivo es obligatorio.');
        await api.post(`/cash-flow/manual-items/${row.id}/cancel`, { reason: form.reason });
        toast.success('Partida cancelada. Deja de proyectarse y conserva su historial.');
      }
      setAccion(null);
      setForm({});
      await cargar();
      onChanged?.();
    } catch (e) {
      toast.error(e.response?.data?.message || e.message || 'Error');
    } finally { setBusy(false); }
  };

  const abrirDoc = (row) => {
    const ruta = SOURCE_ROUTES[row.sourceModel];
    if (!ruta?.deep) { toast('Este origen no tiene pantalla propia'); return; }
    window.open(`${ruta.path}?doc=${row.docRef}`, '_blank');
  };

  const cats = categories?.[cell.direction] || [];
  const subsDe = (k) => cats.find((c) => c.key === k)?.subcategories || [];

  return (
    <Modal isOpen onClose={onClose} size="full" title={`${cell.label} · ${fmtDate(cell.date)}`}>
      {!data ? <p className="text-sm text-slate-400 py-8 text-center">Cargando…</p> : (
        <div className="space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <p className="text-sm text-slate-600">
              {data.count} documento(s) · Total{' '}
              <span className="font-mono font-bold text-slate-800">{fmt(data.total)}</span>
            </p>
            {descuadre && (
              <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-2 py-1">
                El detalle ({fmt(data.total)}) no cuadra con la celda ({fmt(data.celda)}). Revísalo con contabilidad.
              </p>
            )}
          </div>

          <div className="overflow-x-auto border border-slate-200 rounded-xl">
            <table className="min-w-full text-xs">
              <thead className="bg-slate-50 text-slate-600 uppercase text-[10px]">
                <tr>
                  <th className="px-2 py-2 text-left">Tercero</th>
                  <th className="px-2 py-2 text-left">Documento</th>
                  <th className="px-2 py-2 text-left">Vence (legal)</th>
                  <th className="px-2 py-2 text-left">Planificada</th>
                  <th className="px-2 py-2 text-right">Original</th>
                  <th className="px-2 py-2 text-right">Pagado</th>
                  <th className="px-2 py-2 text-right">Pendiente</th>
                  <th className="px-2 py-2 text-left">Estado</th>
                  <th className="px-2 py-2 text-left">Categoría</th>
                  <th className="px-2 py-2 text-right">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.id} className={`border-t border-slate-100 ${row.excluida ? 'opacity-50' : ''}`}>
                    <td className="px-2 py-2">{row.tercero}</td>
                    <td className="px-2 py-2 font-mono">{row.numero || row.descripcion || '—'}</td>
                    <td className="px-2 py-2">{row.dueDate ? fmtDate(row.dueDate) : '—'}</td>
                    <td className="px-2 py-2">
                      {row.plannedDate ? fmtDate(row.plannedDate) : <span className="text-slate-300">—</span>}
                      {row.desplazadaAHabil && <span className="ml-1 text-[10px] text-amber-600">(día hábil)</span>}
                    </td>
                    <td className="px-2 py-2 text-right font-mono">{fmt(row.total)}</td>
                    <td className="px-2 py-2 text-right font-mono text-slate-500">{fmt(row.aplicado)}</td>
                    <td className="px-2 py-2 text-right font-mono font-semibold">{fmt(row.esReal ? row.total : row.saldo)}</td>
                    <td className="px-2 py-2">
                      {row.esReal && <span className="text-[10px] font-bold text-sky-700 bg-sky-50 px-1.5 py-0.5 rounded">REALIZADO</span>}
                      {row.docModel === 'CashFlowManualItem' && !row.esReal && (
                        <span className="text-[10px] font-bold text-sky-700 bg-sky-50 px-1.5 py-0.5 rounded">
                          {row.estado === 'PLANIFICADO' ? 'PLANIFICADA' : row.estado}
                        </span>
                      )}
                      {row.vencida && <span className="text-[10px] font-bold text-rose-700 bg-rose-50 px-1.5 py-0.5 rounded ml-1">VENCIDA {row.diasVencidos}d</span>}
                      {row.reprogramada && <span className="text-[10px] font-bold text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded ml-1">REPROGRAMADA</span>}
                      {row.excluida && <span className="text-[10px] font-bold text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded ml-1" title={row.excludedReason}>EXCLUIDA</span>}
                      {/* Una venta y su factura son la misma obligación: la otra cartera se ve, pero no suma. */}
                      {row.duplicada && (
                        <span className="text-[10px] font-bold text-violet-700 bg-violet-50 px-1.5 py-0.5 rounded ml-1"
                          title={`${row.resolutionReason || ''} · Ya representada por ${row.duplicadaDe?.sourceModel} ${row.duplicadaDe?.numero || ''}`}>
                          DUPLICADA · NO SUMA
                        </span>
                      )}
                      {/* No es un cobro confirmado: es la estimación conservadora de una
                          obligación cuyas dos carteras no concilian. */}
                      {row.estimado && (
                        <span className="text-[10px] font-bold text-rose-700 bg-rose-50 px-1.5 py-0.5 rounded ml-1"
                          title={`${row.resolutionReason || ''} · ${row.formula || ''}`}>
                          ESTIMADO · REQUIERE CONCILIACIÓN
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2">
                      <span title={`Asignada por: ${row.clasificadaPor}`}>{row.category}</span>
                      <span className="block text-[10px] text-slate-400">{row.clasificadaPor}</span>
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex items-center gap-1 justify-end">
                        {/* Una obligación venta+factura se puede abrir por CUALQUIERA de sus dos
                            documentos: la fila es una obligación, no un papel. */}
                        {row.vinculos ? (
                          <>
                            <button onClick={() => window.open(`/sales?doc=${row.vinculos.venta.id}`, '_blank')}
                              title="Abrir la venta"
                              className="px-1.5 py-0.5 rounded text-[10px] font-semibold border border-slate-200 text-slate-600 bg-white cursor-pointer">
                              Venta
                            </button>
                            <button onClick={() => window.open(`/invoices?doc=${row.vinculos.factura.id}`, '_blank')}
                              title="Abrir la factura"
                              className="px-1.5 py-0.5 rounded text-[10px] font-semibold border border-slate-200 text-slate-600 bg-white cursor-pointer">
                              Factura
                            </button>
                          </>
                        ) : (
                          <button onClick={() => abrirDoc(row)} title="Abrir documento"
                            className="p-1 rounded hover:bg-slate-100 text-slate-500 bg-transparent border-none cursor-pointer">
                            <HiOutlineArrowTopRightOnSquare className="w-4 h-4" />
                          </button>
                        )}
                        {/* Una PREVISIÓN se liquida (contabilizando el movimiento o enlazando uno
                            real): no basta con cambiarle el estado. Solo si sigue planificada. */}
                        {row.docModel === 'CashFlowManualItem' && row.estado === 'PLANIFICADO' && (
                          <>
                            <button onClick={() => setLiquidar(row)} title="Liquidar (crear o vincular el movimiento real)"
                              className="p-1 rounded hover:bg-emerald-50 text-emerald-600 bg-transparent border-none cursor-pointer">
                              <HiOutlineCheckCircle className="w-4 h-4" />
                            </button>
                            <button onClick={() => { setAccion({ tipo: 'cancelar', row }); setForm({ reason: '' }); }}
                              title="Cancelar la previsión"
                              className="p-1 rounded hover:bg-rose-50 text-rose-500 bg-transparent border-none cursor-pointer">
                              <HiOutlineXCircle className="w-4 h-4" />
                            </button>
                          </>
                        )}
                        {!row.esReal && (
                          <>
                            <button
                              onClick={() => { setAccion({ tipo: 'reprogramar', row }); setForm({ newDate: cell.date, reason: '' }); }}
                              title="Reprogramar" className="p-1 rounded hover:bg-slate-100 text-slate-500 bg-transparent border-none cursor-pointer">
                              <HiOutlineCalendarDays className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => { setAccion({ tipo: 'reclasificar', row }); setForm({ category: row.category, subcategory: row.subcategory || '' }); }}
                              title="Reclasificar" className="p-1 rounded hover:bg-slate-100 text-slate-500 bg-transparent border-none cursor-pointer">
                              <HiOutlineTag className="w-4 h-4" />
                            </button>
                            {row.excluida ? (
                              <button onClick={() => { setAccion({ tipo: 'incluir', row }); setForm({}); }}
                                title="Volver a incluir" className="p-1 rounded hover:bg-slate-100 text-emerald-600 bg-transparent border-none cursor-pointer">
                                <HiOutlineEye className="w-4 h-4" />
                              </button>
                            ) : (
                              <button onClick={() => { setAccion({ tipo: 'excluir', row }); setForm({ reason: '' }); }}
                                title="Excluir temporalmente" className="p-1 rounded hover:bg-slate-100 text-slate-500 bg-transparent border-none cursor-pointer">
                                <HiOutlineEyeSlash className="w-4 h-4" />
                              </button>
                            )}
                            <button onClick={() => { setAccion({ tipo: 'nota', row }); setForm({ note: row.notas || '' }); }}
                              title="Agregar nota" className="p-1 rounded hover:bg-slate-100 text-slate-500 bg-transparent border-none cursor-pointer">
                              <HiOutlineDocumentText className="w-4 h-4" />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {!data.rows.length && (
                  <tr><td colSpan={10} className="px-2 py-8 text-center text-slate-400">Sin documentos en esta celda</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {liquidar && (
        <ManualSettleModal
          item={{
            id: liquidar.id,
            direction: liquidar.direction,
            category: liquidar.category,
            subcategory: liquidar.subcategory,
            tercero: liquidar.tercero,
            descripcion: liquidar.descripcion,
            amount: liquidar.saldo,
            plannedDate: liquidar.plannedDate,
            estado: liquidar.estado,
            notas: liquidar.notas,
          }}
          onClose={() => setLiquidar(null)}
          onSettled={(it, opts) => {
            cargar();
            onChanged?.();
            // Solo al pedir el asiento se cierra: la confirmación se queda visible.
            if (opts?.verAsiento) { setLiquidar(null); onSettled?.(it, opts); }
          }}
        />
      )}

      {accion && (
        <Modal isOpen onClose={() => { setAccion(null); setForm({}); }} size="md" title={{
          reprogramar: 'Reprogramar', reclasificar: 'Reclasificar',
          excluir: 'Excluir de la proyección', incluir: 'Volver a incluir', nota: 'Nota',
          cancelar: 'Cancelar la partida planificada',
        }[accion.tipo]}>
          <div className="space-y-3">
            {accion.tipo === 'reprogramar' && (
              <>
                <div className="bg-slate-50 rounded-xl p-3 text-xs space-y-1">
                  <p><span className="text-slate-500">Vencimiento legal:</span>{' '}
                    <b>{accion.row.dueDate ? fmtDate(accion.row.dueDate) : '—'}</b>{' '}
                    <span className="text-slate-400">(no se modifica)</span></p>
                  <p><span className="text-slate-500">Se proyecta hoy en:</span> <b>{fmtDate(accion.row.day)}</b></p>
                  <p><span className="text-slate-500">Pendiente:</span> <b className="font-mono">{fmt(accion.row.saldo)}</b></p>
                </div>
                <label className="block">
                  <span className="text-xs text-slate-500">Nueva fecha de pago/cobro</span>
                  <input type="date" value={form.newDate || ''} onChange={(e) => setForm({ ...form, newDate: e.target.value })}
                    className="w-full border border-slate-200 rounded-xl px-3 py-2" />
                </label>
                <label className="block">
                  <span className="text-xs text-slate-500">Motivo (obligatorio)</span>
                  <input value={form.reason || ''} onChange={(e) => setForm({ ...form, reason: e.target.value })}
                    placeholder="Acuerdo con el proveedor, falta de liquidez…"
                    className="w-full border border-slate-200 rounded-xl px-3 py-2" />
                </label>
                <p className="text-[11px] text-slate-500">
                  El documento seguirá marcado como vencido si su fecha legal ya pasó: reprogramar solo cambia
                  cuándo se espera mover el dinero.
                </p>
              </>
            )}

            {accion.tipo === 'reclasificar' && (
              <>
                <label className="block">
                  <span className="text-xs text-slate-500">Categoría</span>
                  <select value={form.category || ''} onChange={(e) => setForm({ ...form, category: e.target.value, subcategory: '' })}
                    className="w-full border border-slate-200 rounded-xl px-3 py-2">
                    {cats.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className="text-xs text-slate-500">Subcategoría</span>
                  <select value={form.subcategory || ''} onChange={(e) => setForm({ ...form, subcategory: e.target.value })}
                    className="w-full border border-slate-200 rounded-xl px-3 py-2">
                    <option value="">— sin subcategoría —</option>
                    {subsDe(form.category).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                  </select>
                </label>
                {accion.row.terceroRef && (
                  <label className="flex items-start gap-2 text-xs text-slate-600">
                    <input type="checkbox" checked={!!form.saveRule} onChange={(e) => setForm({ ...form, saveRule: e.target.checked })} className="mt-0.5" />
                    <span>
                      Guardar también una regla: <b>{accion.row.tercero}</b> se clasificará así automáticamente
                      en los documentos futuros.
                    </span>
                  </label>
                )}
              </>
            )}

            {accion.tipo === 'excluir' && (
              <label className="block">
                <span className="text-xs text-slate-500">Motivo (obligatorio)</span>
                <input value={form.reason || ''} onChange={(e) => setForm({ ...form, reason: e.target.value })}
                  placeholder="En disputa, se va a renegociar…"
                  className="w-full border border-slate-200 rounded-xl px-3 py-2" />
              </label>
            )}

            {accion.tipo === 'incluir' && (
              <p className="text-sm text-slate-600">El documento volverá a sumar en la proyección.</p>
            )}

            {accion.tipo === 'cancelar' && (
              <>
                <p className="text-sm text-slate-600">
                  La previsión dejará de proyectarse y conservará su historial. No se borra ni se reversa
                  ningún movimiento contable: una partida ya liquidada no se puede cancelar desde aquí.
                </p>
                <label className="block">
                  <span className="text-xs text-slate-500">Motivo (obligatorio)</span>
                  <input value={form.reason || ''} onChange={(e) => setForm({ ...form, reason: e.target.value })}
                    placeholder="Ya no se va a pagar, se duplicó…"
                    className="w-full border border-slate-200 rounded-xl px-3 py-2" />
                </label>
              </>
            )}

            {accion.tipo === 'nota' && (
              <label className="block">
                <span className="text-xs text-slate-500">Nota</span>
                <textarea value={form.note || ''} onChange={(e) => setForm({ ...form, note: e.target.value })} rows={3}
                  className="w-full border border-slate-200 rounded-xl px-3 py-2" />
              </label>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => { setAccion(null); setForm({}); }}
                className="px-4 py-2 rounded-xl border border-slate-200 text-slate-600">Cancelar</button>
              <button onClick={ejecutar} disabled={busy}
                className="px-4 py-2 rounded-xl bg-emerald-600 text-white disabled:opacity-50">
                {busy ? 'Guardando…' : 'Guardar'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </Modal>
  );
}
