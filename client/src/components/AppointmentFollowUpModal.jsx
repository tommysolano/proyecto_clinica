import { useEffect, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import Modal from './Modal';
import Spinner from './Spinner';
import { fmtDate } from '../utils/date';
import { Seguimiento } from './SeguimientoLectura';
import { useAuth } from '../context/AuthContext';
import {
  HiOutlineClipboardDocumentList,
  HiOutlineExclamationTriangle,
  HiOutlineBeaker,
  HiOutlineCheck,
} from 'react-icons/hi2';

const FORMAS_DE_PAGO_ITEMS = [
  { valor: 'efectivo', etiqueta: 'Efectivo' },
  { valor: 'transferencia', etiqueta: 'Transferencia' },
  { valor: 'tarjeta_credito', etiqueta: 'T. crédito' },
  { valor: 'tarjeta_debito', etiqueta: 'T. débito' },
];

/**
 * LO QUE SE ESCRIBIÓ EN ESTA CITA, desde la agenda y sin salir de ella.
 *
 * Antes había que abrir la ficha del paciente y buscar el seguimiento por fecha
 * entre todos los suyos. Con dos consultas el mismo día —o con la enfermera y el
 * doctor escribiendo cada uno lo suyo— eso es adivinar, y una receta no se
 * adivina.
 *
 * Es de SOLO LECTURA a propósito: corregir una consulta se hace desde la ficha,
 * por su autor, con su propio botón (ver `puedoCorregir` en Appointments). Esto
 * es para mirar — mostrador para cobrar o dispensar, enfermería para saber qué
 * poner, el médico para repasar.
 *
 * EXCEPCIÓN — EL COBRO DE LA RECETA (sep-2026): para administración y caja,
 * los MEDICAMENTOS que el doctor recetó se ven como CHECKS —igual que las
 * ampollas del suero— y aquí mismo se marca lo que el paciente se lleva, lo que
 * paga por ellos y con qué método. Informativo: no genera venta ni asiento
 * contable; queda en la cita, junto al valor de la visita, y dice quién cobró.
 *
 * Props: appointment (la cita), onClose
 */
export default function AppointmentFollowUpModal({ appointment, onClose }) {
  const { hasRole, user } = useAuth();
  const puedeRegistrarCobro = user?.isSuperAdmin || hasRole('admin', 'cajero');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let vivo = true;
    api
      .get(`/clinical-records/by-appointment/${appointment._id}`)
      .then((r) => { if (vivo) setData(r.data); })
      .catch((e) => {
        if (vivo) setError(e.response?.data?.message || 'No se pudo cargar la consulta');
      });
    return () => { vivo = false; };
  }, [appointment._id]);

  const paciente =
    `${appointment.patient?.firstName || ''} ${appointment.patient?.lastName || ''}`.trim() || 'Paciente';

  return (
    <Modal isOpen onClose={onClose} title="Consulta de esta cita" size="lg">
      <div className="space-y-4">
        <div className="bg-slate-50 border border-slate-200 rounded-xl px-4 py-3">
          <p className="font-semibold text-slate-800">{paciente}</p>
          <p className="text-sm text-slate-500">
            {fmtDate(appointment.date)} · {appointment.startTime}
            {appointment.serviceName ? ` · ${appointment.serviceName}` : ''}
          </p>
        </div>

        {puedeRegistrarCobro && <CobroReceta appointment={appointment} />}

        {!data && !error && (
          <div className="py-10 flex justify-center"><Spinner /></div>
        )}

        {error && (
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {error}
          </p>
        )}

        {data && data.followUps.length === 0 && (
          <div className="text-center py-8 text-slate-500 text-sm">
            <HiOutlineClipboardDocumentList className="w-8 h-8 mx-auto mb-2 text-slate-300" />
            En esta cita no se escribió ninguna consulta.
          </div>
        )}

        {/**
          * Cuando el seguimiento no viene sellado con la cita se busca por el día
          * y por quién atendió. Se DICE, en vez de presentarlo como si fuera
          * exacto: quien lo lee tiene que saber cuánto puede fiarse.
          */}
        {data?.aproximado && (
          <p className="flex items-start gap-2 text-[12px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            <HiOutlineExclamationTriangle className="w-4 h-4 shrink-0 mt-px" />
            <span>
              Esta cita es anterior al registro por turnos, así que esto es lo que
              se escribió <b>ese día</b> por quien la atendió.
            </span>
          </p>
        )}

        {data?.followUps.map((fu) => (
          <Seguimiento key={fu._id} fu={fu} />
        ))}

        <div className="flex justify-end pt-1">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-slate-200 bg-white text-sm text-slate-600 cursor-pointer"
          >
            Cerrar
          </button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * EL COBRO DE LA RECETA, EN CHECKS (sep-2026).
 *
 * Los medicamentos/insumos que el doctor recetó en ESTA cita, tal como llegan
 * del seguimiento, se ven como casillas: mostrador marca lo que el paciente se
 * lleva, anota lo que paga por ellos y con qué método, y queda registrado quién
 * cobró. Es la misma lógica del valor de la cita: OPERATIVO, no contable.
 */
function CobroReceta({ appointment }) {
  const [itemsRecetados, setItemsRecetados] = useState([]);
  const [elegidos, setElegidos] = useState(() =>
    new Set((appointment.prescribedItems || []).map((it) => String(it.item || it.name || '')))
  );
  const [itemsValue, setItemsValue] = useState(
    appointment.itemsValue === null || appointment.itemsValue === undefined ? '' : String(appointment.itemsValue)
  );
  const [itemsMethod, setItemsMethod] = useState(appointment.itemsMethod || '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let vivo = true;
    api
      .get(`/clinical-records/by-appointment/${appointment._id}`)
      .then(({ data }) => {
        if (!vivo) return;
        const lista = [];
        for (const fu of data?.followUps || []) {
          for (const it of fu.recetaItems || []) {
            if (it.isService || it.isSerum) continue;
            lista.push({
              followUp: fu._id,
              item: it._id,
              name: it.name || '',
              quantity: it.quantity || 1,
            });
          }
        }
        setItemsRecetados(lista);
      })
      .catch(() => { if (vivo) setItemsRecetados([]); });
    return () => { vivo = false };
  }, [appointment._id]);

  const claveDe = (it) => String(it.item || it.name || '');
  const itemsElegidos = itemsRecetados.filter((it) => elegidos.has(claveDe(it)));
  const hayCobroPrevio = (appointment.prescribedItems || []).length > 0
    || appointment.itemsValue != null
    || appointment.itemsMethod;

  const guardar = async () => {
    setSaving(true);
    try {
      await api.patch(`/appointments/${appointment._id}/cobro-items`, {
        items: itemsElegidos.map((it) => ({
          followUp: it.followUp,
          item: it.item,
          name: it.name,
          quantity: it.quantity,
        })),
        itemsValue: itemsValue === '' ? null : Number(itemsValue),
        itemsMethod,
      });
      toast.success('Cobro de los medicamentos registrado');
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo registrar el cobro');
    } finally {
      setSaving(false);
    }
  };

  if (itemsRecetados.length === 0 && !hayCobroPrevio) return null;

  return (
    <div className="border border-violet-200 rounded-xl overflow-hidden">
      <div className="bg-violet-50 px-3 py-2 border-b border-violet-200">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-violet-800 m-0">
          <HiOutlineBeaker className="w-4 h-4" />
          Receta del doctor — lo que el paciente va a comprar
        </p>
      </div>
      <div className="p-3 space-y-2">
        <div className="rounded-lg bg-violet-50/60 border border-violet-100 p-2 space-y-1 max-h-60 overflow-y-auto">
          {itemsRecetados.map((it) => {
            const clave = claveDe(it);
            const marcado = elegidos.has(clave);
            return (
              <label
                key={clave}
                className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 cursor-pointer transition-colors ${
                  marcado ? 'border-violet-500 bg-white ring-2 ring-violet-200' : 'border-violet-200 bg-white hover:border-violet-400'
                }`}
              >
                <input
                  type="checkbox"
                  checked={marcado}
                  onChange={() => setElegidos((prev) => {
                    const next = new Set(prev);
                    if (next.has(clave)) next.delete(clave);
                    else next.add(clave);
                    return next;
                  })}
                  className="w-4 h-4 accent-violet-600 cursor-pointer shrink-0"
                />
                <span className="text-sm text-slate-800 min-w-0 truncate flex-1">
                  {it.name}
                  {it.quantity > 1 ? ` × ${it.quantity}` : ''}
                </span>
              </label>
            );
          })}
          {itemsRecetados.length === 0 && (
            <p className="text-xs text-violet-800 m-0">
              {(appointment.prescribedItems || [])
                .map((it) => `${it.name}${it.quantity > 1 ? ` ×${it.quantity}` : ''}`)
                .join(', ')}
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <label className="block">
            <span className="block text-xs font-medium text-slate-600 mb-1">Valor de los medicamentos</span>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">$</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={itemsValue}
                onChange={(e) => setItemsValue(e.target.value)}
                placeholder="0.00"
                className="w-full pl-7 pr-3 py-2 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-violet-500 bg-slate-50/50"
              />
            </div>
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-slate-600 mb-1">¿Cómo pagó los medicamentos?</span>
            <select
              value={itemsMethod}
              onChange={(e) => setItemsMethod(e.target.value)}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white"
            >
              <option value="">No se dijo</option>
              {FORMAS_DE_PAGO_ITEMS.map((f) => (
                <option key={f.valor} value={f.valor}>{f.etiqueta}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="flex items-center justify-between gap-2 pt-1">
          <p className="text-[11px] text-slate-400 m-0">
            Aparte del valor de la cita. Informativo: no genera venta ni factura.
          </p>
          <button
            type="button"
            onClick={guardar}
            disabled={saving}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-violet-600 text-white hover:bg-violet-700 cursor-pointer border-none disabled:opacity-50"
          >
            {saving ? 'Guardando…' : 'Registrar cobro'}
          </button>
        </div>
      </div>
    </div>
  );
}
