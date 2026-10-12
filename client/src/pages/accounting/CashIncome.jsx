import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import api from '../../api/axios';
import Modal from '../../components/Modal';
import Field from '../../components/Field';
import DateInput from '../../components/DateInput';
import NumericInput from '../../components/NumericInput';
import AccountSelect from '../../components/AccountSelect';
import { useAuth } from '../../context/AuthContext';
import { todayEc } from '../../utils/date';
import { newIdempotencyKey, withIdempotencyKey, intentKey } from '../../utils/idempotency';
import { fmt, fmtDate } from './_utils';
import {
  HiOutlineArrowPath, HiOutlineBanknotes, HiOutlineChevronDown, HiOutlineLockClosed,
} from 'react-icons/hi2';

/**
 * CAJA E INGRESOS (oct-2026) — la pantalla que el contador usaba en micartaonline.
 *
 * Arriba, el CUADRE del período en tres bloques: «Ingreso de caja» (todo lo que se cobró),
 * «Egreso de caja» (todo lo que no se quedó en el cajón) y el saldo, contrastado contra el
 * libro mayor. Lo cobrado con tarjeta, transferencia o saldo a favor aparece en los DOS
 * bloques (NETEO): entra como venta y sale porque ese dinero nunca estuvo en el cajón.
 *
 * Debajo, el historial de DEPÓSITOS y el de SALIDAS de efectivo del período, cada fila con
 * su detalle. Las acciones de escritura van en un solo menú: pasar efectivo al banco,
 * registrar un vale y abrir/cerrar caja (esto último en su página de siempre, que es la que
 * hace el arqueo).
 *
 * Todo es de la SUCURSAL activa, como Cierre de caja y Depósitos.
 */

const money = (n) => (Number(n) < 0 ? `-$${fmt(-Number(n))}` : `$${fmt(n)}`);
const POR_PAGINA = 10;

function primeroDelMes() {
  return `${todayEc().slice(0, 7)}-01`;
}

/** Paginación en el navegador. Una lista nueva (otro período) vuelve a la página 1. */
function usePagina(lista) {
  const [sel, setSel] = useState({ lista, pagina: 1 });
  const paginas = Math.max(1, Math.ceil(lista.length / POR_PAGINA));
  const pagina = Math.min(sel.lista === lista ? sel.pagina : 1, paginas);
  const visibles = lista.slice((pagina - 1) * POR_PAGINA, pagina * POR_PAGINA);
  return { pagina, paginas, visibles, setPagina: (n) => setSel({ lista, pagina: n }) };
}

function Paginacion({ p, total, etiqueta }) {
  if (p.paginas <= 1) return null;
  return (
    <div className="flex items-center justify-between text-xs text-slate-500 mt-2">
      <span>{total} {etiqueta}</span>
      <div className="flex items-center gap-1">
        <button type="button" disabled={p.pagina <= 1} onClick={() => p.setPagina(p.pagina - 1)} className="px-2.5 py-1 rounded-lg border border-slate-200 bg-white disabled:opacity-40 cursor-pointer">‹</button>
        <span className="px-2">{p.pagina} / {p.paginas}</span>
        <button type="button" disabled={p.pagina >= p.paginas} onClick={() => p.setPagina(p.pagina + 1)} className="px-2.5 py-1 rounded-lg border border-slate-200 bg-white disabled:opacity-40 cursor-pointer">›</button>
      </div>
    </div>
  );
}

function Dato({ etiqueta, children }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-slate-400">{etiqueta}</div>
      <div className="text-sm font-semibold text-slate-700 break-words">{children || '—'}</div>
    </div>
  );
}

export default function CashIncome() {
  const navigate = useNavigate();
  const { hasRole, user } = useAuth();
  const esAdminConta = hasRole('admin', 'contabilidad') || !!user?.isSuperAdmin;

  // El período manda sobre todo lo que se ve: cuadre y los dos historiales.
  const [periodo, setPeriodo] = useState(() => ({ from: todayEc(), to: todayEc() }));
  const [panel, setPanel] = useState(null);
  const [depositos, setDepositos] = useState([]);
  const [salidas, setSalidas] = useState({ items: [], truncado: false, limit: 0 });
  const [cargando, setCargando] = useState(false);

  const [menu, setMenu] = useState(false);
  const [mostrarDeposito, setMostrarDeposito] = useState(false);
  const [mostrarVale, setMostrarVale] = useState(false);
  const [depositoAbierto, setDepositoAbierto] = useState(null);
  const [salidaAbierta, setSalidaAbierta] = useState(null);
  const [lineaAbierta, setLineaAbierta] = useState(null);
  const [anulando, setAnulando] = useState(null);

  // Solo la ÚLTIMA consulta escribe: cambiar de fecha rápido no deja números de otro período.
  const consultaRef = useRef(0);
  const cargar = useCallback(async () => {
    const yo = ++consultaRef.current;
    const params = { from: periodo.from, to: periodo.to || periodo.from };
    setCargando(true);
    try {
      const [p, d, s] = await Promise.all([
        api.get('/cash-panel', { params }),
        api.get('/cash-panel/depositos', { params }),
        api.get('/cash-panel/salidas', { params }),
      ]);
      if (yo !== consultaRef.current) return;
      setPanel(p.data);
      setDepositos(d.data?.items || []);
      setSalidas(s.data || { items: [] });
    } catch (e) {
      if (yo === consultaRef.current) toast.error(e.response?.data?.message || 'No se pudo cargar la caja.');
    } finally {
      if (yo === consultaRef.current) setCargando(false);
    }
  }, [periodo.from, periodo.to]);

  useEffect(() => { cargar(); }, [cargar]);

  const paginaDepositos = usePagina(depositos);
  const paginaSalidas = usePagina(salidas.items || []);

  const anularSalida = async (fila) => {
    if (!fila.canVoid) { toast.error(fila.voidBlockedMessage || 'Esta salida no se puede anular desde aquí.'); return; }
    const esDeposito = fila.tipo === 'DEPOSITO';
    const motivo = window.prompt(
      `¿Anular ${esDeposito ? 'el depósito al banco' : 'el vale'} de ${money(fila.amount)}?\n\n`
      + `Se genera un asiento de reverso y el efectivo vuelve a caja.${esDeposito ? ' La entrada del banco también se retira y sus ventas vuelven a quedar pendientes de depositar.' : ''}\n\nMotivo:`,
    );
    if (motivo === null) return;
    setAnulando(fila.entryId);
    try {
      const r = await api.post(`/cash-panel/salidas/${fila.entryId}/void`, { reason: motivo });
      toast.success(r.data?.message || 'Anulado');
      setSalidaAbierta(null);
      cargar();
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudo anular');
    } finally {
      setAnulando(null);
    }
  };

  const cuadra = panel && Math.abs(Number(panel.diferencia) || 0) < 0.01;
  const accion = (fn) => () => { setMenu(false); fn(); };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
            <HiOutlineBanknotes className="text-emerald-600" /> Caja e ingresos
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            El cuadre de caja del período, los depósitos al banco y todo el efectivo que salió de la caja.
          </p>
        </div>
        <button
          type="button"
          onClick={cargar}
          disabled={cargando}
          className="px-3 py-2 rounded-xl border border-slate-200 bg-white text-sm text-slate-600 flex items-center gap-1.5 cursor-pointer hover:bg-slate-50 disabled:opacity-60"
        >
          <HiOutlineArrowPath className={`w-4 h-4 ${cargando ? 'animate-spin' : ''}`} /> Actualizar
        </button>
      </div>

      {/* ── Período + acciones ─────────────────────────────────────────────── */}
      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 p-3 flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-500">
          Desde
          <DateInput value={periodo.from} onChange={(e) => setPeriodo((p) => ({ ...p, from: e.target.value }))} className="mt-1 block border border-slate-200 rounded-xl px-3 py-2 text-sm w-40" />
        </label>
        <label className="text-xs text-slate-500">
          Hasta
          <DateInput value={periodo.to} onChange={(e) => setPeriodo((p) => ({ ...p, to: e.target.value }))} className="mt-1 block border border-slate-200 rounded-xl px-3 py-2 text-sm w-40" />
        </label>
        <div className="flex gap-1.5">
          <button type="button" onClick={() => setPeriodo({ from: todayEc(), to: todayEc() })} className="px-3 py-2 rounded-xl border border-slate-200 bg-white text-xs text-slate-600 cursor-pointer hover:bg-slate-50">Hoy</button>
          <button type="button" onClick={() => setPeriodo({ from: primeroDelMes(), to: todayEc() })} className="px-3 py-2 rounded-xl border border-slate-200 bg-white text-xs text-slate-600 cursor-pointer hover:bg-slate-50">Este mes</button>
        </div>
        <div className="relative ml-auto">
          {menu && <div className="fixed inset-0 z-20" onClick={() => setMenu(false)} />}
          <button
            type="button"
            onClick={() => setMenu((v) => !v)}
            className="px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm font-medium flex items-center gap-1.5 border-none cursor-pointer hover:bg-emerald-700"
          >
            Acciones de caja <HiOutlineChevronDown className="w-4 h-4" />
          </button>
          {menu && (
            <div className="absolute right-0 top-full mt-1 z-30 bg-white border border-slate-200 rounded-xl shadow-lg p-1.5 min-w-[250px] flex flex-col">
              <button type="button" onClick={accion(() => setMostrarDeposito((v) => !v))} className="text-left px-3 py-2 rounded-lg text-sm text-slate-700 hover:bg-emerald-50 bg-transparent border-none cursor-pointer">
                {mostrarDeposito ? 'Ocultar el depósito' : 'Pasar efectivo al banco'}
              </button>
              <button type="button" onClick={accion(() => setMostrarVale(true))} className="text-left px-3 py-2 rounded-lg text-sm text-slate-700 hover:bg-emerald-50 bg-transparent border-none cursor-pointer">
                Registrar vale
              </button>
              <button type="button" onClick={accion(() => navigate('/cash-register'))} className="text-left px-3 py-2 rounded-lg text-sm text-emerald-700 hover:bg-emerald-50 bg-transparent border-none cursor-pointer border-t border-slate-100">
                Abrir / cerrar caja y ver cierres
              </button>
            </div>
          )}
        </div>
      </div>

      <div aria-live="polite" className="text-xs text-emerald-700 min-h-[16px] -mt-2">
        {cargando ? 'Cargando la caja del período…' : ''}
      </div>

      {panel?.sinCuentaCaja && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Esta sucursal no tiene configurada la cuenta contable de Caja: configúrala en Contabilidad → Config. Cuentas.
        </div>
      )}

      {/* ── El cuadre ──────────────────────────────────────────────────────── */}
      <PanelDeCaja panel={panel} cuadra={cuadra} cargando={cargando} alAbrir={setLineaAbierta} />

      {mostrarDeposito && (
        <PasarAlBanco
          alCerrar={() => setMostrarDeposito(false)}
          alTerminar={() => { setMostrarDeposito(false); cargar(); }}
        />
      )}

      {/* ── Historial de depósitos ─────────────────────────────────────────── */}
      <section>
        <h3 className="text-sm font-semibold text-slate-700">Historial de depósitos</h3>
        <p className="text-xs text-slate-500 mb-2">Pulsa un depósito para ver qué ventas y cobros lo forman.</p>
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="text-left px-3 py-2">Fecha</th>
                <th className="text-left px-3 py-2">Número</th>
                <th className="text-left px-3 py-2">Banco</th>
                <th className="text-left px-3 py-2">Papeleta</th>
                <th className="text-center px-3 py-2">Documentos</th>
                <th className="text-right px-3 py-2">Monto</th>
                <th className="text-left px-3 py-2">Estado</th>
              </tr>
            </thead>
            <tbody>
              {paginaDepositos.visibles.map((d) => (
                <tr
                  key={d._id}
                  onClick={() => setDepositoAbierto(d)}
                  className={`border-t border-slate-100 cursor-pointer hover:bg-emerald-50/50 ${d.status === 'ANULADO' ? 'opacity-55' : ''}`}
                  title="Ver el detalle del depósito"
                >
                  <td className="px-3 py-2 whitespace-nowrap">{fmtDate(d.date)}</td>
                  <td className="px-3 py-2 font-mono text-xs">{d.number}</td>
                  <td className="px-3 py-2">{d.bankAccount?.name || d.bankAccount?.bank || '—'}</td>
                  <td className="px-3 py-2">{d.voucherNumber}</td>
                  <td className="px-3 py-2 text-center">{(d.items || []).length + (Number(d.manualAmount) > 0 ? 1 : 0)}</td>
                  <td className="px-3 py-2 text-right font-semibold">{money(d.total)}</td>
                  <td className="px-3 py-2">
                    {d.status === 'ANULADO'
                      ? <span className="px-2 py-0.5 rounded-full text-[11px] bg-rose-50 text-rose-700">anulado</span>
                      : <span className="px-2 py-0.5 rounded-full text-[11px] bg-emerald-50 text-emerald-700">contabilizado</span>}
                  </td>
                </tr>
              ))}
              {!cargando && depositos.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-6 text-center text-xs text-slate-400">Sin depósitos en el período.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <Paginacion p={paginaDepositos} total={depositos.length} etiqueta="depósitos" />
      </section>

      {/* ── Historial de salidas de efectivo ───────────────────────────────── */}
      <section>
        <h3 className="text-sm font-semibold text-slate-700">Historial de salidas de efectivo</h3>
        <p className="text-xs text-slate-500 mb-2">
          Todo lo que salió de la caja (la principal y sus subcuentas), incluidos los pagos y depósitos que registran
          otros módulos. Los vales y los depósitos se anulan aquí; lo demás, desde su módulo. Pulsa una fila para ver
          su detalle.
        </p>
        {salidas.truncado && (
          <p className="text-xs font-semibold text-amber-700 mb-2">
            Se muestran las {salidas.limit} salidas más recientes del período: hay más. Acota las fechas para verlas todas.
          </p>
        )}
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="text-left px-3 py-2">Fecha</th>
                <th className="text-left px-3 py-2">Salió de</th>
                <th className="text-left px-3 py-2">Cuenta</th>
                <th className="text-left px-3 py-2">Detalle</th>
                <th className="text-right px-3 py-2">Monto</th>
                <th className="text-left px-3 py-2">Asiento</th>
                <th className="text-left px-3 py-2">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {paginaSalidas.visibles.map((e) => (
                <tr
                  key={e._id}
                  onClick={() => setSalidaAbierta(e)}
                  className={`border-t border-slate-100 cursor-pointer hover:bg-emerald-50/50 ${e.reversed ? 'opacity-55' : ''}`}
                  title="Ver el detalle de esta salida"
                >
                  <td className="px-3 py-2 whitespace-nowrap">{fmtDate(e.date)}</td>
                  <td className="px-3 py-2">{e.cajaNombre || e.cajaCodigo || '—'}</td>
                  <td className="px-3 py-2">{e.accountName || e.accountCode || '—'}</td>
                  <td className={`px-3 py-2 ${e.reversed ? 'line-through' : ''}`}>{e.description}</td>
                  <td className="px-3 py-2 text-right font-semibold">{money(e.amount)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className="px-2 py-0.5 rounded-full text-[11px] bg-slate-100 text-slate-600 font-mono">{e.entryNumber}</span>
                    {e.reversed && <span className="ml-1 px-2 py-0.5 rounded-full text-[11px] bg-rose-50 text-rose-700">anulado</span>}
                  </td>
                  <td className="px-3 py-2" onClick={(ev) => ev.stopPropagation()}>
                    {e.canVoid ? (
                      <button
                        type="button"
                        onClick={() => anularSalida(e)}
                        disabled={anulando === e.entryId}
                        className="px-2.5 py-1 rounded-lg text-xs bg-rose-50 text-rose-700 border border-rose-200 cursor-pointer hover:bg-rose-100 disabled:opacity-50"
                      >
                        {anulando === e.entryId ? 'Anulando…' : 'Anular'}
                      </button>
                    ) : (
                      <span title={e.voidBlockedMessage || ''} className="text-[11px] text-slate-400 cursor-help inline-flex items-center gap-1">
                        <HiOutlineLockClosed className="w-3.5 h-3.5" /> {e.reversed ? 'anulado' : 'otro módulo'}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {!cargando && (salidas.items || []).length === 0 && (
                <tr><td colSpan={7} className="px-3 py-6 text-center text-xs text-slate-400">Sin salidas de efectivo en el período.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <Paginacion p={paginaSalidas} total={(salidas.items || []).length} etiqueta="salidas" />
      </section>

      {mostrarVale && (
        <RegistrarVale
          alCerrar={() => setMostrarVale(false)}
          alTerminar={() => { setMostrarVale(false); cargar(); }}
        />
      )}
      {lineaAbierta && <DetalleDeLinea fila={lineaAbierta} alCerrar={() => setLineaAbierta(null)} />}
      {depositoAbierto && <DetalleDeposito deposito={depositoAbierto} alCerrar={() => setDepositoAbierto(null)} />}
      {salidaAbierta && (
        <DetalleSalida
          salida={salidaAbierta}
          anulando={anulando === salidaAbierta.entryId}
          alAnular={() => anularSalida(salidaAbierta)}
          alCerrar={() => setSalidaAbierta(null)}
        />
      )}
      {!esAdminConta && (
        <p className="text-[11px] text-slate-400">Los depósitos al banco los anulan administración o contabilidad.</p>
      )}
    </div>
  );
}

/**
 * EL CUADRE: lo que entró, lo que salió y el saldo, contrastado contra el mayor.
 * Cada línea con documentos detrás se abre: un importe que no se puede abrir no se cree.
 */
function PanelDeCaja({ panel, cuadra, cargando, alAbrir }) {
  if (!panel) {
    return <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-6 text-sm text-slate-400">{cargando ? 'Cargando…' : 'Sin datos.'}</div>;
  }

  const fila = (f, sentido) => {
    const neteo = f.grupo === 'NETEO';
    const docs = f.detalle?.contados || 0;
    const contenido = (
      <>
        <span className="min-w-0">
          {f.etiqueta}
          {neteo && (
            <span className="ml-1.5 px-1.5 py-0.5 rounded text-[10px] bg-amber-100 text-amber-800 whitespace-nowrap">
              {sentido === 'entra' ? 'no entró a la caja' : 'no salió de la caja'}
            </span>
          )}
          {docs > 0 && <span className="ml-1.5 text-[11px] font-semibold text-emerald-700 whitespace-nowrap">ver {docs} doc.</span>}
        </span>
        <span className={`font-semibold tabular-nums whitespace-nowrap ${f.monto === 0 ? 'text-slate-300' : ''}`}>{money(f.monto)}</span>
      </>
    );
    const clase = 'w-full flex justify-between gap-3 px-3 py-2 text-[13px] text-left border-t border-slate-100 first:border-t-0 bg-transparent';
    return docs > 0
      ? <button key={f.clave} type="button" onClick={() => alAbrir(f)} className={`${clase} cursor-pointer hover:bg-emerald-50/60 border-x-0 border-b-0`}>{contenido}</button>
      : <div key={f.clave} className={clase}>{contenido}</div>;
  };

  const bloque = (titulo, filas, total, colores, sentido, nota) => (
    <div className="flex-1 min-w-[280px]">
      <div className={`flex justify-between items-baseline gap-2 px-3 py-2 rounded-t-xl ${colores}`}>
        <b className="text-xs uppercase tracking-wide">{titulo}</b>
        <b className="text-base tabular-nums">{money(total)}</b>
      </div>
      <div className="border border-t-0 border-slate-200 rounded-b-xl bg-white overflow-hidden">
        {filas.map((f) => fila(f, sentido))}
      </div>
      <p className="text-[11px] text-slate-500 mt-1.5 leading-snug">{nota}</p>
    </div>
  );

  return (
    <div className={`bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 p-4 ${cargando ? 'opacity-60' : ''}`}>
      <div className="flex flex-wrap gap-4">
        {bloque(
          'Ingreso de caja · todo lo que se cobró',
          panel.ingresos || [], panel.totalIngresos,
          'bg-emerald-50 text-emerald-800', 'entra',
          'Las líneas marcadas se cobraron, pero no en billetes: la tarjeta, la transferencia y el saldo a favor nunca pasan por la caja. Se anotan aquí para que el total sea todo lo cobrado y vuelven a salir por el bloque de al lado.',
        )}
        {bloque(
          'Egreso de caja · lo que no se quedó en la caja',
          panel.egresos || [], panel.totalEgresos,
          'bg-rose-50 text-rose-800', 'sale',
          'Las líneas marcadas NO son un retiro de efectivo: son cobros con tarjeta, por transferencia o con saldo a favor, que nunca estuvieron en la caja.',
        )}
      </div>

      <div className={`mt-4 rounded-xl border px-4 py-3 flex flex-wrap gap-4 items-center justify-between ${cuadra ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200'}`}>
        <div>
          <div className="text-xs text-slate-600">Saldo en caja al {fmtDate(panel.to)}</div>
          <b className="text-2xl text-emerald-700 tabular-nums">{money(panel.saldoMayor)}</b>
          <div className="text-[11px] text-slate-500 mt-0.5">
            Según el libro mayor: venía {money(panel.saldoInicialMayor)} y el período movió <b>{money(panel.movimientoMayor)}</b>.
          </div>
          <div className="text-[11px] text-slate-500">
            Movimiento de caja del período (lo cobrado en efectivo menos lo que salió): <b>{money(panel.saldoCaja)}</b>
          </div>
        </div>
        <div className={`text-xs max-w-md ${cuadra ? 'text-emerald-800' : 'text-amber-800'}`}>
          {cuadra
            ? 'Coincide con el libro mayor: lo que pasó por la caja es lo que dicen los asientos.'
            : `Difiere del libro mayor en ${money(Math.abs(Number(panel.diferencia) || 0))}. El cuadre sale de las ventas cobradas y de los asientos que no son ventas; el mayor, de todos los asientos de caja. La diferencia es una venta sin contabilizar o un movimiento de efectivo sin registrar.`}
        </div>
      </div>
    </div>
  );
}

/** Los documentos detrás de una línea del cuadre. */
function DetalleDeLinea({ fila, alCerrar }) {
  const docs = fila.detalle?.items || [];
  const suma = docs.reduce((s, d) => s + (Number(d.monto) || 0), 0);
  const queEs = fila.grupo === 'NETEO'
    ? 'Esta línea no es dinero que saliera ni entrara al cajón: se cobró por un medio que nunca pasó por la caja, y aparece en los dos bloques con el mismo importe para que se anule sola.'
    : 'Este importe sí pasó por el cajón: al contar el efectivo tiene que estar (o faltar) de verdad.';
  return (
    <Modal isOpen onClose={alCerrar} title={`${fila.etiqueta} · ${money(fila.monto)}`} size="xl">
      {fila.detalle?.truncado && (
        <p className="text-xs text-amber-700 mb-2">Se muestran los primeros {docs.length} de {fila.detalle.contados} documentos: acota el período para verlos todos.</p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">Fecha</th>
              <th className="text-left px-3 py-2">Documento</th>
              <th className="text-left px-3 py-2">Detalle</th>
              <th className="text-left px-3 py-2">Cuenta / medio</th>
              <th className="text-right px-3 py-2">Monto</th>
            </tr>
          </thead>
          <tbody>
            {docs.map((d, i) => (
              <tr key={`${d.tipo}-${d.asientoId || d.saleId || i}-${i}`} className="border-t border-slate-100">
                <td className="px-3 py-1.5 whitespace-nowrap">{fmtDate(d.fecha)}</td>
                <td className="px-3 py-1.5 whitespace-nowrap">
                  <span className="font-mono text-xs">{d.documento || '—'}</span>
                  {d.factura && <div className="text-[11px] text-slate-500">Fact. {d.factura}</div>}
                </td>
                <td className="px-3 py-1.5">{d.detalle || '—'}</td>
                <td className="px-3 py-1.5 text-xs text-slate-600">{d.cuenta || '—'}</td>
                <td className="px-3 py-1.5 text-right font-semibold">{money(d.monto)}</td>
              </tr>
            ))}
            {docs.length === 0 && <tr><td colSpan={5} className="px-3 py-6 text-center text-xs text-slate-400">Esta línea no tiene documentos.</td></tr>}
          </tbody>
          <tfoot>
            <tr className="border-t border-slate-200">
              <td colSpan={4} className="px-3 py-2 text-right text-xs text-slate-500">{fila.detalle?.truncado ? 'Total de lo que se ve' : 'Total'}</td>
              <td className="px-3 py-2 text-right font-bold text-emerald-700">{money(suma)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="text-[11px] text-slate-500 mt-3">{queEs}</p>
    </Modal>
  );
}

/** Detalle de un depósito: los documentos que lo forman y su suma. */
function DetalleDeposito({ deposito: d, alCerrar }) {
  const partidas = [
    ...(d.items || []).map((i) => ({
      clase: i.docModel === 'Sale' ? 'Venta' : i.docModel === 'Payment' ? 'Cobro de cartera' : 'Cobro de venta',
      numero: i.number, fecha: i.docDate, detalle: i.party, monto: i.amount,
    })),
    ...(Number(d.manualAmount) > 0 ? [{ clase: 'Saldo libre de caja', numero: '', fecha: d.date, detalle: d.manualReason, monto: d.manualAmount }] : []),
  ];
  const suma = partidas.reduce((s, p) => s + (Number(p.monto) || 0), 0);
  return (
    <Modal isOpen onClose={alCerrar} title={`Depósito ${d.number} · ${money(d.total)}`} size="xl">
      {d.status === 'ANULADO' && (
        <p className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 mb-3">
          Este depósito está ANULADO{d.voidReason ? `: ${d.voidReason}` : ''}.
        </p>
      )}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 bg-slate-50 border border-slate-200 rounded-xl p-3 mb-3">
        <Dato etiqueta="Fecha">{fmtDate(d.date)}</Dato>
        <Dato etiqueta="Banco">{[d.bankAccount?.name, d.bankAccount?.accountNumber].filter(Boolean).join(' · ')}</Dato>
        <Dato etiqueta="Papeleta">{d.voucherNumber}</Dato>
        <Dato etiqueta="Asiento">{d.journalEntry?.number}</Dato>
        <Dato etiqueta="Registró">{d.createdBy?.name}</Dato>
      </div>
      {d.description && <p className="text-sm text-slate-600 mb-3"><b>Concepto:</b> {d.description}</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">Tipo</th>
              <th className="text-left px-3 py-2">Documento</th>
              <th className="text-left px-3 py-2">Fecha</th>
              <th className="text-left px-3 py-2">Cliente / detalle</th>
              <th className="text-right px-3 py-2">Efectivo</th>
            </tr>
          </thead>
          <tbody>
            {partidas.map((p, i) => (
              <tr key={i} className="border-t border-slate-100">
                <td className="px-3 py-1.5">{p.clase}</td>
                <td className="px-3 py-1.5 font-mono text-xs">{p.numero || '—'}</td>
                <td className="px-3 py-1.5 whitespace-nowrap">{fmtDate(p.fecha)}</td>
                <td className="px-3 py-1.5">{p.detalle || '—'}</td>
                <td className="px-3 py-1.5 text-right font-semibold">{money(p.monto)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-slate-200">
              <td colSpan={4} className="px-3 py-2 text-right text-xs text-slate-500">Suma de los documentos</td>
              <td className="px-3 py-2 text-right font-bold text-emerald-700">{money(suma)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      {Math.abs(suma - Number(d.total || 0)) > 0.01 && (
        <p className="text-xs text-amber-700 mt-2">La suma de los documentos no coincide con el importe depositado ({money(d.total)}).</p>
      )}
    </Modal>
  );
}

/** Detalle de una salida de efectivo: sus contrapartidas, su asiento y de qué módulo salió. */
function DetalleSalida({ salida: e, anulando, alAnular, alCerrar }) {
  const suma = (e.contrapartidas || []).reduce((s, c) => s + (Number(c.amount) || 0), 0);
  return (
    <Modal isOpen onClose={alCerrar} title={`Salida de ${money(e.amount)} · ${fmtDate(e.date)}`} size="lg">
      {e.reversed && (
        <p className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 mb-3">Esta salida está ANULADA: su asiento tiene reverso.</p>
      )}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 bg-slate-50 border border-slate-200 rounded-xl p-3 mb-3">
        <Dato etiqueta="Salió de">{e.cajaNombre || e.cajaCodigo}</Dato>
        <Dato etiqueta="Importe">{money(e.amount)}</Dato>
        <Dato etiqueta="Asiento">{e.entryNumber}</Dato>
        <Dato etiqueta="Origen">{e.origen}</Dato>
      </div>
      <p className="text-sm text-slate-600 mb-3"><b>Concepto:</b> {e.description || '—'}</p>
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-xs text-slate-500">
          <tr><th className="text-left px-3 py-2">Cuenta</th><th className="text-left px-3 py-2">Nombre</th><th className="text-right px-3 py-2">Monto</th></tr>
        </thead>
        <tbody>
          {(e.contrapartidas || []).map((c, i) => (
            <tr key={`${c.code}-${i}`} className="border-t border-slate-100">
              <td className="px-3 py-1.5 font-mono text-xs">{c.code || '—'}</td>
              <td className="px-3 py-1.5">{c.name || '—'}</td>
              <td className="px-3 py-1.5 text-right font-semibold">{money(c.amount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-slate-200">
            <td colSpan={2} className="px-3 py-2 text-right text-xs text-slate-500">Total</td>
            <td className="px-3 py-2 text-right font-bold text-emerald-700">{money(suma)}</td>
          </tr>
        </tfoot>
      </table>
      <div className="flex items-center justify-between gap-3 mt-4">
        <p className="text-[11px] text-slate-500">
          {e.canVoid
            ? (e.tipo === 'DEPOSITO'
              ? 'Este depósito se puede anular aquí: el efectivo vuelve a caja y se retira la entrada del banco.'
              : 'Este vale se puede anular aquí: se reversa su asiento y el efectivo vuelve a caja.')
            : (e.voidBlockedMessage || 'Esta salida no se puede anular desde aquí.')}
        </p>
        {e.canVoid && (
          <button type="button" onClick={alAnular} disabled={anulando} className="px-3 py-1.5 rounded-lg text-xs bg-rose-600 text-white border-none cursor-pointer hover:bg-rose-700 disabled:opacity-50 shrink-0">
            {anulando ? 'Anulando…' : 'Anular'}
          </button>
        )}
      </div>
    </Modal>
  );
}

/**
 * EL VALE DE CAJA: efectivo del cajón usado para una compra o un gasto (un taxi, insumos,
 * un mensajero). Sale de caja contra la cuenta que se elija y baja el saldo, igual que un
 * depósito. Las cuentas son las de la sucursal (gasto, costo, pasivo o activo); las de
 * los bancos no se ofrecen: llevar efectivo al banco es un depósito.
 */
function RegistrarVale({ alCerrar, alTerminar }) {
  const [cuentas, setCuentas] = useState([]);
  const [form, setForm] = useState({ date: todayEc(), amount: '', account: '', description: '' });
  const [guardando, setGuardando] = useState(false);
  const guardandoRef = useRef(false);

  useEffect(() => {
    api.get('/cash-panel/cuentas')
      .then((r) => setCuentas(r.data || []))
      .catch(() => toast.error('No se pudieron cargar las cuentas contables.'));
  }, []);

  const importe = Math.max(0, Number(form.amount) || 0);
  const listo = importe > 0.005 && !!form.account;

  const guardar = async (ev) => {
    ev.preventDefault();
    if (!listo || guardandoRef.current) return;
    guardandoRef.current = true;
    setGuardando(true);
    try {
      const r = await api.post('/cash-panel/vales', { ...form, amount: importe });
      toast.success(r.data?.message || 'Vale registrado');
      alTerminar();
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudo registrar el vale.');
    } finally {
      guardandoRef.current = false;
      setGuardando(false);
    }
  };

  return (
    <Modal isOpen onClose={guardando ? () => {} : alCerrar} title="Registrar vale de caja" size="lg">
      <form onSubmit={guardar} className="space-y-3">
        <p className="text-xs text-slate-600">
          El efectivo que salió de la caja para una compra, un taxi o cualquier gasto pagado con el dinero de la caja.
          Se registra como <b>salida de efectivo</b> contra la cuenta que elijas y baja el saldo de caja.
          Si tienes tu caja abierta, entra en su arqueo.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Valor ($)" required>
            <NumericInput step="0.01" placeholder="0.00" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" />
          </Field>
          <Field label="Fecha" required>
            <DateInput value={form.date} max={todayEc()} onChange={(e) => setForm({ ...form, date: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" />
          </Field>
        </div>
        <Field label="Cuenta contable" required>
          <AccountSelect
            accounts={cuentas}
            value={form.account}
            onChange={(v) => setForm({ ...form, account: v })}
            placeholder="Buscar cuenta por nombre… (por ejemplo: movilización)"
          />
          <p className="text-[11px] text-slate-400 mt-1">
            Es la cuenta que se DEBITA (gasto, costo, pasivo o activo). Para llevar efectivo al banco usa «Pasar efectivo al banco».
          </p>
        </Field>
        <Field label="Detalle">
          <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Para qué se usó el dinero" className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" />
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={alCerrar} disabled={guardando} className="px-4 py-2 bg-slate-200 rounded-xl border-none cursor-pointer">Cancelar</button>
          <button type="submit" disabled={!listo || guardando} className="px-4 py-2 bg-emerald-600 text-white rounded-xl border-none cursor-pointer disabled:opacity-50">
            {guardando ? 'Registrando…' : `Agregar vale de ${money(importe)}`}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * PASAR EFECTIVO AL BANCO: el depósito de siempre (Bancos → Depósitos), desde aquí.
 * Lista el efectivo pendiente —ventas cobradas en efectivo (la parte en efectivo de las
 * mixtas) y cobros de cartera en efectivo— con su propio filtro de fechas: arranca SIN
 * filtro y enseña todo lo que sigue sin depositar, sea del día que sea. Un saldo de caja
 * que no viene de esos documentos se deposita aparte, como «saldo libre», con su origen.
 */
function PasarAlBanco({ alCerrar, alTerminar }) {
  const [bancos, setBancos] = useState([]);
  const [pendientes, setPendientes] = useState([]);
  const [saldoLibre, setSaldoLibre] = useState(0);
  const [cargando, setCargando] = useState(false);
  const [filtro, setFiltro] = useState({ desde: '', hasta: '' });
  const [marcados, setMarcados] = useState(() => new Set());
  const [modo, setModo] = useState('documentos');
  const [form, setForm] = useState({ bankAccount: '', voucher: '', date: todayEc(), description: '', manualAmount: '', manualReason: '' });
  const [guardando, setGuardando] = useState(false);
  const claveRef = useRef(newIdempotencyKey());

  useEffect(() => {
    api.get('/banks/payment-options')
      .then((r) => {
        const lista = r.data?.accounts || [];
        setBancos(lista);
        if (lista.length === 1) setForm((f) => ({ ...f, bankAccount: lista[0]._id }));
      })
      .catch(() => setBancos([]));
  }, []);

  useEffect(() => {
    let vivo = true;
    setCargando(true);
    api.get('/cash-deposits/pending', { params: { startDate: filtro.desde || undefined, cutDate: filtro.hasta || undefined } })
      .then((r) => {
        if (!vivo) return;
        setPendientes(r.data?.items || []);
        setSaldoLibre(Number(r.data?.manualAvailable || 0));
        setMarcados(new Set());
      })
      .catch((e) => { if (vivo) toast.error(e.response?.data?.message || 'No se pudo leer el efectivo pendiente.'); })
      .finally(() => { if (vivo) setCargando(false); });
    return () => { vivo = false; };
  }, [filtro.desde, filtro.hasta]);

  const claveDe = (i) => `${i.docModel}:${i.docRef}`;
  const total = useMemo(
    () => pendientes.filter((i) => marcados.has(claveDe(i))).reduce((s, i) => s + Number(i.amount || 0), 0),
    [pendientes, marcados],
  );
  const alternar = (k) => setMarcados((prev) => {
    const n = new Set(prev);
    if (n.has(k)) n.delete(k); else n.add(k);
    return n;
  });
  const todos = pendientes.length > 0 && marcados.size === pendientes.length;

  const confirmar = async () => {
    if (!form.bankAccount) return toast.error('Escoge la cuenta bancaria.');
    if (!form.voucher.trim()) return toast.error('Escribe el número de papeleta del banco.');
    if (modo === 'documentos' && marcados.size === 0) return toast.error('Marca al menos un documento.');
    const manual = Number(form.manualAmount) || 0;
    if (modo === 'libre') {
      if (!(manual > 0) || manual > saldoLibre + 0.001) return toast.error(`El saldo libre disponible es ${money(saldoLibre)}.`);
      if (!form.manualReason.trim()) return toast.error('Indica de dónde viene ese efectivo.');
    }
    setGuardando(true);
    try {
      const r = await api.post('/cash-deposits', {
        items: modo === 'documentos'
          ? pendientes.filter((i) => marcados.has(claveDe(i))).map((i) => ({ docModel: i.docModel, docRef: i.docRef }))
          : [],
        manualAmount: modo === 'libre' ? manual : 0,
        manualReason: modo === 'libre' ? form.manualReason.trim() : '',
        bankAccount: form.bankAccount,
        voucherNumber: form.voucher.trim(),
        date: form.date,
        description: form.description.trim()
          || (modo === 'libre' ? 'Depósito de saldo libre de caja' : `Depósito de efectivo (${marcados.size} documento(s))`),
      }, withIdempotencyKey(intentKey(claveRef.current, [
        form.bankAccount, form.voucher.trim(), form.date, modo, manual,
        [...marcados].sort().join(','),
      ])));
      toast.success(`Depósito registrado: ${money(r.data?.total)}`);
      claveRef.current = newIdempotencyKey();
      alTerminar();
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudo registrar el depósito.');
    } finally {
      setGuardando(false);
    }
  };

  return (
    <section className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-200 p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-700">Pasar efectivo al banco</h3>
        <button type="button" onClick={alCerrar} className="text-xs text-slate-500 hover:underline bg-transparent border-none cursor-pointer">Cerrar</button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Field label="Cuenta bancaria" required>
          <select value={form.bankAccount} onChange={(e) => setForm({ ...form, bankAccount: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm">
            <option value="">— Seleccionar —</option>
            {bancos.map((b) => <option key={b._id} value={b._id}>{b.name}{b.accountNumber ? ` · ${b.accountNumber}` : ''}</option>)}
          </select>
        </Field>
        <Field label="N° de papeleta" required>
          <input value={form.voucher} onChange={(e) => setForm({ ...form, voucher: e.target.value })} placeholder="DEP-12345" className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm" />
        </Field>
        <Field label="Fecha del depósito" required>
          <DateInput value={form.date} max={todayEc()} onChange={(e) => setForm({ ...form, date: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm" />
        </Field>
        <Field label="Notas">
          <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Opcional" className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm" />
        </Field>
      </div>

      <div className="flex gap-1.5">
        <button type="button" onClick={() => setModo('documentos')} className={`px-3 py-1.5 rounded-lg text-xs border cursor-pointer ${modo === 'documentos' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-600 border-slate-200'}`}>
          Ventas y cobros en efectivo
        </button>
        <button type="button" onClick={() => setModo('libre')} className={`px-3 py-1.5 rounded-lg text-xs border cursor-pointer ${modo === 'libre' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-600 border-slate-200'}`}>
          Saldo libre de caja ({money(saldoLibre)})
        </button>
      </div>

      {modo === 'libre' ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Importe ($)" required>
            <NumericInput step="0.01" value={form.manualAmount} onChange={(e) => setForm({ ...form, manualAmount: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm" />
          </Field>
          <Field label="Origen del efectivo" required>
            <input value={form.manualReason} onChange={(e) => setForm({ ...form, manualReason: e.target.value })} placeholder="Ej.: fondo de caja sobrante" className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm" />
          </Field>
          <p className="text-[11px] text-slate-500 sm:col-span-2">
            Es el efectivo de caja que no viene de una venta o un cobro pendiente de depositar (por ejemplo, un fondo que sobró).
          </p>
        </div>
      ) : (
        <>
          <div className="bg-slate-50 rounded-xl p-3 flex flex-wrap items-end gap-3">
            <span className="text-xs font-semibold text-slate-600 w-full">Efectivo pendiente de depositar — filtrar por fecha:</span>
            <label className="text-xs text-slate-500">Desde
              <DateInput value={filtro.desde} onChange={(e) => setFiltro((f) => ({ ...f, desde: e.target.value }))} className="mt-1 block border border-slate-200 rounded-xl px-3 py-2 text-sm w-40 bg-white" />
            </label>
            <label className="text-xs text-slate-500">Hasta
              <DateInput value={filtro.hasta} onChange={(e) => setFiltro((f) => ({ ...f, hasta: e.target.value }))} className="mt-1 block border border-slate-200 rounded-xl px-3 py-2 text-sm w-40 bg-white" />
            </label>
            <button type="button" onClick={() => setFiltro({ desde: '', hasta: '' })} className="px-3 py-2 rounded-xl border border-slate-200 bg-white text-xs text-slate-600 cursor-pointer">Sin filtro (todas)</button>
            <p className="text-[11px] text-slate-500 w-full m-0">
              Ventas cobradas en efectivo, la <b>parte en efectivo</b> de las ventas mixtas y los cobros de cartera en efectivo:
              lo que de verdad está en la caja. Esta lista tiene su propio filtro y no usa el período de arriba.
            </p>
          </div>
          <div className="overflow-x-auto max-h-80 overflow-y-auto border border-slate-200 rounded-xl">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 sticky top-0">
                <tr>
                  <th className="px-3 py-2 w-8">
                    <input type="checkbox" checked={todos} onChange={(e) => setMarcados(e.target.checked ? new Set(pendientes.map(claveDe)) : new Set())} />
                  </th>
                  <th className="text-left px-3 py-2">Documento</th>
                  <th className="text-left px-3 py-2">Fecha</th>
                  <th className="text-left px-3 py-2">Cliente</th>
                  <th className="text-right px-3 py-2">Total</th>
                  <th className="text-right px-3 py-2">En efectivo</th>
                </tr>
              </thead>
              <tbody>
                {cargando ? (
                  <tr><td colSpan={6} className="px-3 py-6 text-center text-xs text-slate-400">Buscando…</td></tr>
                ) : pendientes.map((i) => {
                  const k = claveDe(i);
                  return (
                    <tr key={k} onClick={() => alternar(k)} className={`border-t border-slate-100 cursor-pointer ${marcados.has(k) ? 'bg-emerald-50' : 'hover:bg-slate-50'}`}>
                      <td className="px-3 py-1.5" onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" checked={marcados.has(k)} onChange={() => alternar(k)} />
                      </td>
                      <td className="px-3 py-1.5">
                        <span className="font-mono text-xs">{i.number || '—'}</span>
                        {i.docModel !== 'Sale' && <span className="ml-1.5 px-1.5 py-0.5 rounded text-[10px] bg-slate-100 text-slate-600">Cobro</span>}
                        {i.mixta && <span className="ml-1.5 px-1.5 py-0.5 rounded text-[10px] bg-amber-100 text-amber-800">Mixta</span>}
                      </td>
                      <td className="px-3 py-1.5 whitespace-nowrap">{fmtDate(i.docDate)}</td>
                      <td className="px-3 py-1.5">{i.party || '—'}</td>
                      <td className={`px-3 py-1.5 text-right ${i.mixta ? 'text-slate-400' : ''}`}>{money(i.total ?? i.amount)}</td>
                      <td className="px-3 py-1.5 text-right font-semibold">{money(i.amount)}</td>
                    </tr>
                  );
                })}
                {!cargando && pendientes.length === 0 && (
                  <tr><td colSpan={6} className="px-3 py-6 text-center text-xs text-slate-400">No hay efectivo pendiente de depositar.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className={`flex flex-wrap items-center justify-between gap-3 rounded-xl px-3 py-2.5 ${modo === 'documentos' && marcados.size ? 'bg-emerald-50' : 'bg-slate-50'}`}>
        <span className="text-sm">
          {modo === 'documentos'
            ? <><b>{marcados.size}</b> documento(s) · Total a depositar: <b className="text-lg">{money(total)}</b></>
            : <>Total a depositar: <b className="text-lg">{money(Number(form.manualAmount) || 0)}</b></>}
        </span>
        <button
          type="button"
          onClick={confirmar}
          disabled={guardando || (modo === 'documentos' && marcados.size === 0)}
          className="px-4 py-2 bg-emerald-600 text-white rounded-xl border-none cursor-pointer disabled:opacity-50"
        >
          {guardando ? 'Registrando…' : 'Confirmar depósito'}
        </button>
      </div>
    </section>
  );
}
