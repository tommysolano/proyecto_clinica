import { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
import {
  HiOutlineBanknotes, HiOutlineLink, HiOutlineCheckCircle, HiOutlineMagnifyingGlass,
} from 'react-icons/hi2';
import api from '../../api/axios';
import Modal from '../../components/Modal';
import AccountSelect from '../../components/AccountSelect';
import { fmt, fmtDate, today } from './_utils';
import { newIdempotencyKey, withIdempotencyKey } from '../../utils/idempotency';
import DateInput from '../../components/DateInput';

/**
 * LIQUIDAR una partida manual: convertir una PREVISIÓN en un movimiento real.
 *
 * Una partida no se vuelve real cambiando su estado. Solo hay dos caminos, los mismos que
 * acepta el backend:
 *
 *   A · CREAR    → se contabiliza el movimiento (asiento balanceado + movimiento bancario)
 *                  dentro de una transacción. El estado cambia solo después de contabilizar.
 *   B · VINCULAR → se enlaza un cobro/pago o movimiento bancario YA registrado.
 *
 * La `Idempotency-Key` es por INTENCIÓN: se reutiliza al reintentar (un timeout no duplica el
 * asiento) y se renueva si cambia el contenido del formulario (así el backend puede devolver
 * 409 en vez de contabilizar otra cosa con la misma clave).
 */

/** Nunca se enseña un error interno de Mongo al usuario. */
const mensajeError = (e, fallback = 'No se pudo liquidar la partida') => {
  const m = e?.response?.data?.message || e?.message || '';
  if (/E11000|duplicate key|MongoServerError/i.test(m)) {
    return 'Esa operación ya se estaba registrando. Actualiza la pantalla y revisa si quedó liquidada.';
  }
  return m || fallback;
};

const METODOS = ['TRANSFERENCIA', 'EFECTIVO', 'CHEQUE', 'TARJETA', 'DEPOSITO', 'OTRO'];

export default function ManualSettleModal({ item, onClose, onSettled }) {
  const [modo, setModo] = useState('CREAR');
  const [busy, setBusy] = useState(false);
  const [hecho, setHecho] = useState(null);          // partida ya liquidada (resultado)
  const [key, setKey] = useState(newIdempotencyKey());

  // Catálogos
  const [accounts, setAccounts] = useState([]);
  const [banks, setBanks] = useState([]);
  const [costCenters, setCostCenters] = useState([]);

  // A · crear
  const [f, setF] = useState({
    date: today(),
    liquidez: 'BANCO',                 // BANCO | CAJA
    bankAccountId: '',
    cashAccountId: '',
    counterAccountId: '',
    method: 'TRANSFERENCIA',
    reference: '',
    costCenter: '',
    amount: item.amount,
  });

  // B · vincular
  const [busqueda, setBusqueda] = useState({ from: '', to: '', q: '' });
  const [candidatos, setCandidatos] = useState(null);
  const [elegido, setElegido] = useState(null);

  useEffect(() => {
    api.get('/chart-of-accounts').then((r) => setAccounts(r.data || [])).catch(() => {});
    api.get('/banks/accounts').then((r) => setBanks(r.data || [])).catch(() => {});
    api.get('/cost-centers', { params: { active: true } }).then((r) => setCostCenters(r.data || [])).catch(() => {});
  }, []);

  const set = (patch) => { setF((s) => ({ ...s, ...patch })); setKey(newIdempotencyKey()); };

  const buscar = useCallback(async () => {
    try {
      const r = await api.get('/cash-flow/settlement-candidates', {
        params: {
          itemId: item.id,
          from: busqueda.from || undefined,
          to: busqueda.to || undefined,
          q: busqueda.q || undefined,
        },
      });
      setCandidatos(r.data.rows || []);
    } catch (e) { toast.error(mensajeError(e, 'No se pudieron buscar los movimientos')); }
  }, [item.id, busqueda]);

  useEffect(() => { if (modo === 'VINCULAR' && candidatos === null) buscar(); }, [modo, candidatos, buscar]);

  // La cuenta de liquidez elegida (para no permitir que sea también la contrapartida).
  const cuentaLiquidez = f.liquidez === 'BANCO'
    ? banks.find((b) => b._id === f.bankAccountId)?.chartAccount
    : f.cashAccountId;

  const errores = [];
  if (modo === 'CREAR') {
    if (!(Number(f.amount) > 0)) errores.push('El importe debe ser mayor que cero.');
    if (!f.date) errores.push('Indica la fecha real del movimiento.');
    if (f.liquidez === 'BANCO' && !f.bankAccountId) errores.push('Elige la cuenta bancaria.');
    if (f.liquidez === 'CAJA' && !f.cashAccountId) errores.push('Elige la cuenta de caja.');
    if (!f.counterAccountId) errores.push('Elige la cuenta de contrapartida.');
    if (f.counterAccountId && cuentaLiquidez && String(f.counterAccountId) === String(cuentaLiquidez)) {
      errores.push('La contrapartida no puede ser la misma cuenta de caja/banco.');
    }
  } else if (!elegido) {
    errores.push('Elige el movimiento real que respalda esta partida.');
  }

  const liquidar = async () => {
    if (busy || errores.length) return;
    setBusy(true);
    try {
      const body = modo === 'CREAR'
        ? {
          mode: 'CREAR',
          date: f.date,
          amount: Number(f.amount),
          bankAccountId: f.liquidez === 'BANCO' ? f.bankAccountId : undefined,
          cashAccountId: f.liquidez === 'CAJA' ? f.cashAccountId : undefined,
          counterAccountId: f.counterAccountId,
          method: f.method,
          reference: f.reference,
          costCenter: f.costCenter || undefined,
        }
        : { mode: 'VINCULAR', settledByModel: elegido.settledByModel, settledByRef: elegido.id };

      const r = await api.post(`/cash-flow/manual-items/${item.id}/settle`, body, withIdempotencyKey(key));
      setHecho(r.data);
      toast.success(r.data.idempotentReplay
        ? 'La partida ya estaba liquidada (no se contabilizó dos veces).'
        : 'Partida liquidada. El movimiento ya está en la contabilidad.');
      onSettled?.(r.data);
    } catch (e) {
      toast.error(mensajeError(e));
    } finally { setBusy(false); }
  };

  // ── Liquidada: trazabilidad ─────────────────────────────────────────────────────────────
  if (hecho) {
    return (
      <Modal isOpen onClose={onClose} size="md" title="Partida liquidada">
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2">
            <HiOutlineCheckCircle className="w-5 h-5 shrink-0" />
            <p className="text-sm">
              <b>{hecho.description}</b> por <b className="font-mono">{fmt(hecho.amount)}</b> ya es un movimiento real.
              La previsión deja de proyectarse y conserva su historial.
            </p>
          </div>
          <div className="text-xs text-slate-600 space-y-1">
            <p>Estado: <b>REALIZADO</b> · Fecha contable: <b>{fmtDate(hecho.settledAt || hecho.accountingDate)}</b></p>
            <p>Respaldada por: <b>{hecho.settledByModel}</b></p>
          </div>
          <div className="flex justify-end gap-2">
            {hecho.journalEntry && (
              <button onClick={() => onSettled?.(hecho, { verAsiento: hecho.journalEntry })}
                className="px-4 py-2 rounded-xl bg-slate-700 text-white text-sm">Ver asiento</button>
            )}
            <button onClick={onClose} className="px-4 py-2 rounded-xl border border-slate-200 text-slate-600">Cerrar</button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal isOpen onClose={onClose} size="lg" title="Liquidar partida planificada">
      <div className="space-y-4">
        {/* Qué se está liquidando */}
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          <p><span className="text-slate-500">Tipo:</span>{' '}
            <b className={item.direction === 'INGRESO' ? 'text-emerald-700' : 'text-rose-600'}>
              {item.direction === 'INGRESO' ? 'Ingreso' : 'Egreso'}
            </b>
          </p>
          <p><span className="text-slate-500">Estado:</span> <b>{item.estado || 'PLANIFICADO'}</b></p>
          <p><span className="text-slate-500">Categoría:</span>{' '}
            <b>{item.category}{item.subcategory ? ` · ${item.subcategory}` : ''}</b></p>
          <p><span className="text-slate-500">Tercero:</span> <b>{item.tercero || '—'}</b></p>
          <p className="col-span-2"><span className="text-slate-500">Descripción:</span> <b>{item.descripcion}</b></p>
          <p><span className="text-slate-500">Importe:</span>{' '}
            <b className="font-mono">{fmt(item.amount)}</b></p>
          <p><span className="text-slate-500">Fecha planificada:</span> <b>{fmtDate(item.plannedDate)}</b></p>
          {item.notas && <p className="col-span-2"><span className="text-slate-500">Notas:</span> {item.notas}</p>}
        </div>

        {/* Camino */}
        <div className="grid grid-cols-2 gap-2">
          {[
            ['CREAR', 'Crear movimiento real', 'Contabiliza el asiento y el movimiento bancario ahora.', <HiOutlineBanknotes key="a" className="w-4 h-4" />],
            ['VINCULAR', 'Vincular uno existente', 'El dinero ya se movió y está registrado: solo se enlaza.', <HiOutlineLink key="b" className="w-4 h-4" />],
          ].map(([k, label, ayuda, icon]) => (
            <button key={k} onClick={() => { setModo(k); setKey(newIdempotencyKey()); }}
              className={`text-left p-3 rounded-xl border-2 cursor-pointer bg-white ${
                modo === k ? 'border-emerald-500 bg-emerald-50/50' : 'border-slate-200'
              }`}>
              <span className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">{icon}{label}</span>
              <span className="block text-[11px] text-slate-500 mt-0.5">{ayuda}</span>
            </button>
          ))}
        </div>

        {/* A · CREAR */}
        {modo === 'CREAR' && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-xs text-slate-500">Fecha real del movimiento</span>
                <DateInput value={f.date} onChange={(e) => set({ date: e.target.value })}
                  className="w-full border border-slate-200 rounded-xl px-3 py-2" />
              </label>
              <label className="block">
                <span className="text-xs text-slate-500">Importe</span>
                <input type="number" step="0.01" min="0" value={f.amount}
                  onChange={(e) => set({ amount: e.target.value })}
                  className="w-full border border-slate-200 rounded-xl px-3 py-2 font-mono" />
              </label>
              <label className="block">
                <span className="text-xs text-slate-500">El dinero sale/entra por</span>
                <select value={f.liquidez} onChange={(e) => set({ liquidez: e.target.value, bankAccountId: '', cashAccountId: '' })}
                  className="w-full border border-slate-200 rounded-xl px-3 py-2">
                  <option value="BANCO">Banco</option>
                  <option value="CAJA">Caja</option>
                </select>
              </label>
              {f.liquidez === 'BANCO' ? (
                <label className="block">
                  <span className="text-xs text-slate-500">Cuenta bancaria</span>
                  <select value={f.bankAccountId} onChange={(e) => set({ bankAccountId: e.target.value })}
                    className="w-full border border-slate-200 rounded-xl px-3 py-2">
                    <option value="">— elegir —</option>
                    {banks.map((b) => <option key={b._id} value={b._id}>{b.bank} · {b.name}</option>)}
                  </select>
                </label>
              ) : (
                <div className="block">
                  <span className="text-xs text-slate-500">Cuenta de caja</span>
                  <AccountSelect accounts={accounts} value={f.cashAccountId}
                    onChange={(v) => set({ cashAccountId: v })}
                    filter={(a) => /^1\.1\.01/.test(a.code || '')}
                    placeholder="Cuenta de caja…" />
                </div>
              )}
              <div className="block col-span-2">
                <span className="text-xs text-slate-500">
                  Cuenta de contrapartida ({item.direction === 'INGRESO' ? 'de dónde viene el dinero' : 'contra qué se paga'})
                </span>
                <AccountSelect accounts={accounts} value={f.counterAccountId}
                  onChange={(v) => set({ counterAccountId: v })}
                  placeholder="Cuenta de gasto, ingreso, préstamo…" />
              </div>
              <label className="block">
                <span className="text-xs text-slate-500">Método</span>
                <select value={f.method} onChange={(e) => set({ method: e.target.value })}
                  className="w-full border border-slate-200 rounded-xl px-3 py-2">
                  {METODOS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="text-xs text-slate-500">Referencia</span>
                <input value={f.reference} onChange={(e) => set({ reference: e.target.value })}
                  placeholder="N.º de transferencia, cheque…"
                  className="w-full border border-slate-200 rounded-xl px-3 py-2" />
              </label>
              {costCenters.length > 0 && (
                <label className="block col-span-2">
                  <span className="text-xs text-slate-500">Centro de costo (opcional)</span>
                  <select value={f.costCenter} onChange={(e) => set({ costCenter: e.target.value })}
                    className="w-full border border-slate-200 rounded-xl px-3 py-2">
                    <option value="">— sin centro de costo —</option>
                    {costCenters.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
                  </select>
                </label>
              )}
            </div>
            <p className="text-[11px] text-slate-500 bg-slate-50 rounded-lg p-2">
              Se generará un asiento cuadrado ({item.direction === 'INGRESO' ? 'debe caja/banco · haber contrapartida' : 'debe contrapartida · haber caja/banco'})
              {f.liquidez === 'BANCO' ? ' y su movimiento bancario' : ''}. El período debe estar abierto. Si algo falla,
              no se contabiliza nada y la partida sigue planificada.
            </p>
          </div>
        )}

        {/* B · VINCULAR */}
        {modo === 'VINCULAR' && (
          <div className="space-y-3">
            <div className="flex gap-2 items-end flex-wrap">
              <label className="block">
                <span className="text-xs text-slate-500">Desde</span>
                <DateInput value={busqueda.from} onChange={(e) => setBusqueda({ ...busqueda, from: e.target.value })}
                  className="border border-slate-200 rounded-xl px-3 py-2" />
              </label>
              <label className="block">
                <span className="text-xs text-slate-500">Hasta</span>
                <DateInput value={busqueda.to} onChange={(e) => setBusqueda({ ...busqueda, to: e.target.value })}
                  className="border border-slate-200 rounded-xl px-3 py-2" />
              </label>
              <label className="block flex-1 min-w-[160px]">
                <span className="text-xs text-slate-500">Tercero, referencia o número</span>
                <input value={busqueda.q} onChange={(e) => setBusqueda({ ...busqueda, q: e.target.value })}
                  className="w-full border border-slate-200 rounded-xl px-3 py-2" />
              </label>
              <button onClick={buscar} className="px-3 py-2 bg-slate-700 text-white rounded-xl text-sm flex items-center gap-1.5">
                <HiOutlineMagnifyingGlass className="w-4 h-4" /> Buscar
              </button>
            </div>

            <div className="border border-slate-200 rounded-xl overflow-hidden max-h-64 overflow-y-auto">
              <table className="min-w-full text-xs">
                <thead className="bg-slate-50 text-slate-600 uppercase text-[10px] sticky top-0">
                  <tr>
                    <th className="px-2 py-2 text-left">Fecha</th>
                    <th className="px-2 py-2 text-left">Movimiento</th>
                    <th className="px-2 py-2 text-left">Tercero / descripción</th>
                    <th className="px-2 py-2 text-left">Cuenta</th>
                    <th className="px-2 py-2 text-right">Importe</th>
                    <th className="px-2 py-2 text-left">Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {(candidatos || []).map((c) => {
                    const bloqueado = !!c.yaVinculado || !c.compatible;
                    const sel = elegido?.id === c.id;
                    return (
                      <tr key={`${c.settledByModel}:${c.id}`}
                        onClick={() => !bloqueado && setElegido(c)}
                        className={`border-t border-slate-100 ${bloqueado ? 'opacity-50' : 'cursor-pointer hover:bg-emerald-50'} ${sel ? 'bg-emerald-50' : ''}`}>
                        <td className="px-2 py-2">{fmtDate(c.date)}</td>
                        <td className="px-2 py-2">
                          {c.settledByModel === 'Payment' ? 'Cobro/Pago' : 'Mov. bancario'}
                          {c.numero && <span className="font-mono text-slate-500"> {c.numero}</span>}
                        </td>
                        <td className="px-2 py-2">{c.tercero || '—'}{c.referencia && <span className="text-slate-400"> · {c.referencia}</span>}</td>
                        <td className="px-2 py-2">{c.cuenta || c.metodo || '—'}</td>
                        <td className="px-2 py-2 text-right font-mono">{fmt(c.amount)}</td>
                        <td className="px-2 py-2">
                          {c.yaVinculado && (
                            <span className="text-[10px] font-bold text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded"
                              title={`Ya respalda "${c.yaVinculado}"`}>YA VINCULADO</span>
                          )}
                          {!c.yaVinculado && !c.compatible && (
                            <span className="text-[10px] font-bold text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded">
                              DIFERENCIA {fmt(c.diferencia)}
                            </span>
                          )}
                          {!c.yaVinculado && c.compatible && sel && (
                            <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded">ELEGIDO</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {candidatos && !candidatos.length && (
                    <tr><td colSpan={6} className="px-2 py-6 text-center text-slate-400">
                      No hay movimientos de {item.direction === 'INGRESO' ? 'entrada' : 'salida'} en ese rango.
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>

            {elegido && (
              <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-xs space-y-1">
                <p className="font-semibold text-emerald-800">Se va a enlazar este movimiento:</p>
                <p>Fecha <b>{fmtDate(elegido.date)}</b> · Cuenta <b>{elegido.cuenta || elegido.metodo || '—'}</b> ·
                  Importe <b className="font-mono">{fmt(elegido.amount)}</b></p>
                <p>Asiento: <b className="font-mono">{elegido.journalEntry || 'sin asiento'}</b></p>
                <p>Diferencia con la partida:{' '}
                  <b className={Math.abs(elegido.diferencia) > 0.01 ? 'text-rose-600' : 'text-emerald-700'}>
                    {fmt(elegido.diferencia)}
                  </b>
                </p>
                <p className="text-emerald-700">
                  No se contabiliza nada nuevo: el movimiento ya existe. La partida solo deja de proyectarse.
                </p>
              </div>
            )}
          </div>
        )}

        {errores.length > 0 && (
          <ul className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2 space-y-0.5">
            {errores.map((e) => <li key={e}>· {e}</li>)}
          </ul>
        )}

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-xl border border-slate-200 text-slate-600">Cancelar</button>
          <button onClick={liquidar} disabled={busy || errores.length > 0}
            className="px-4 py-2 rounded-xl bg-emerald-600 text-white disabled:opacity-50">
            {busy ? 'Liquidando…' : (modo === 'CREAR' ? 'Contabilizar y liquidar' : 'Vincular y liquidar')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
