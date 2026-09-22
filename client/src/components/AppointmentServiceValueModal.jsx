import { useEffect, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import Modal from './Modal';
import ServiceItemPicker from './ServiceItemPicker';
import AppointmentValueFields from './AppointmentValueFields';
import SearchableSelect from './SearchableSelect';
import { useAuth } from '../context/AuthContext';
import { doctorOptionLabel } from '../utils/roles';
import { HiOutlineCheck, HiOutlineLockClosed, HiOutlineXMark, HiOutlinePlus, HiOutlineBeaker } from 'react-icons/hi2';

/**
 * CORREGIR EL SERVICIO Y EL VALOR de una cita, también después de atenderla.
 *
 * El servicio real se sabe muchas veces al final —el paciente entró por una
 * consulta y salió con un procedimiento—, y el importe se cierra ahí mismo.
 * Hasta ahora eso obligaba a llamar a un administrador, porque una cita
 * completada estaba cerrada para todo el mundo.
 *
 * Va contra `PATCH /appointments/:id/service-value`, una puerta que SOLO deja
 * cambiar servicio, valor y —cuando la cita ya terminó— QUIÉN LO ATENDIÓ. Es la
 * puerta por la que mostrador arregla una cita que se cerró mal: asignaron solo
 * a enfermería y el doctor que la vio quedó fuera, o quedó otro. Lo que no se
 * toca nunca: el enfermero que atendió y lo que hizo cada uno en su turno.
 *
 * Y, desde sep-2026, también contra `PATCH /appointments/:id/cobro-items`: los
 * MEDICAMENTOS que el doctor recetó se escogen con CHECKS —igual que las
 * ampollas del suero— y se anota lo que el paciente paga por ellos, aparte del
 * valor de la cita. Ahí queda también quién registró el cobro.
 *
 * Props: appointment, doctors (de la sucursal activa), onClose, onDone(citaActualizada)
 */
export default function AppointmentServiceValueModal({
  appointment,
  doctors: doctorsDeLaSedeActiva = [],
  onClose,
  onDone,
}) {
  const apt = appointment;
  const { activeClinic } = useAuth();

  /**
   * EL PERSONAL ES EL DE LA SUCURSAL DE LA CITA, igual que en «Asignar
   * atención»: caja agenda para cualquier sede y el doctor que atiende debe ser
   * de la de la cita — el servidor lo rechaza si no (ver validarPersonalDeLaSede).
   */
  const sedeDeLaCita = String(apt?.clinic?._id || apt?.clinic || '');
  const esOtraSede = !!sedeDeLaCita && String(activeClinic?._id || '') !== sedeDeLaCita;
  const [personalDeLaSede, setPersonalDeLaSede] = useState(null);

  useEffect(() => {
    if (!esOtraSede) {
      setPersonalDeLaSede(null);
      return undefined;
    }
    let vivo = true;
    api
      .get('/users/doctors', { params: { clinic: sedeDeLaCita } })
      .then((d) => {
        if (vivo) setPersonalDeLaSede(d.data || []);
      })
      .catch(() => {
        if (vivo) setPersonalDeLaSede([]);
      });
    return () => {
      vivo = false;
    };
  }, [esOtraSede, sedeDeLaCita]);

  const doctors = personalDeLaSede || doctorsDeLaSedeActiva;

  const [servicio, setServicio] = useState(
    apt?.serviceItem
      ? {
          _id: apt.serviceItem._id || apt.serviceItem,
          name: apt.serviceItem.name || apt.serviceName || '',
        }
      : null
  );
  const [valor, setValor] = useState(
    apt?.agreedValue === null || apt?.agreedValue === undefined ? '' : String(apt.agreedValue)
  );
  const [canje, setCanje] = useState(!!apt?.isCanje);
  // Lo que el paciente dejó pagado (normalmente por teléfono, al agendar). Se
  // corrige aquí junto al valor: al cobrar es cuando se sabe si aquello cubría
  // lo que al final se hizo.
  const [adelanto, setAdelanto] = useState(apt?.advancePayment || '');
  const [abonado, setAbonado] = useState(apt?.advanceAmount ? String(apt.advanceAmount) : '');
  const [formaPago, setFormaPago] = useState(apt?.advanceMethod || '');
  const [busy, setBusy] = useState(false);

  /**
   * QUIÉN LO ATENDIÓ, editable SOLO cuando la cita ya terminó. Antes de eso la
   * cola manda: se corrige por «Asignar atención», no desde aquí.
   */
  const sePuedeCorregirAtendido = apt?.status === 'completada' || !!apt?.consultationEndedAt;
  const doctorAtendidoInicial = apt?.doctor
    ? String(apt.doctor._id || apt.doctor)
    : '';
  const [atendido, setAtendido] = useState(doctorAtendidoInicial);

  // Los OTROS servicios de la visita, como {_id, name}. El nombre guardado es el
  // que manda: si alguien renombró el ítem del catálogo, aquí sigue diciendo lo
  // que se hizo ese día.
  const [extras, setExtras] = useState(() =>
    (apt?.additionalServices || [])
      .map((s) => ({
        _id: String(s.serviceItem?._id || s.serviceItem || ''),
        name: s.name || s.serviceItem?.name || '',
      }))
      .filter((s) => s._id && s.name)
  );
  /**
   * El selector de abajo es de «añadir», no de «elegir»: se queda siempre vacío.
   * Como su texto interno solo se resincroniza cuando cambia el `value` —y aquí
   * es null siempre—, se le cambia la llave para que vuelva a nacer limpio; si
   * no, el nombre recién añadido se quedaba escrito en el campo.
   */
  const [llaveSelector, setLlaveSelector] = useState(0);

  /**
   * LO QUE EL DOCTOR RECETÓ, en checks (sep-2026). Sale de los seguimientos
   * sellados a esta cita: cada medicamento/insumo de la receta es una casilla,
   * y mostrador marca los que el paciente se lleva. Lo elegido va a la cita
   * (`prescribedItems`) con su valor aparte (`itemsValue`).
   */
  const [itemsRecetados, setItemsRecetados] = useState([]);
  const [elegidos, setElegidos] = useState(() =>
    new Set((apt?.prescribedItems || []).map((it) => String(it.item || it.name || '')))
  );
  const [itemsValue, setItemsValue] = useState(
    apt?.itemsValue === null || apt?.itemsValue === undefined ? '' : String(apt.itemsValue)
  );
  const [itemsMethod, setItemsMethod] = useState(apt?.itemsMethod || '');

  useEffect(() => {
    let vivo = true;
    api
      .get(`/clinical-records/by-appointment/${apt._id}`)
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
      .catch(() => {
        if (vivo) setItemsRecetados([]);
      });
    return () => { vivo = false; };
  }, [apt._id]);

  const claveDe = (it) => String(it.item || it.name || '');
  const toggleItem = (it) => {
    const clave = claveDe(it);
    setElegidos((prev) => {
      const next = new Set(prev);
      if (next.has(clave)) next.delete(clave);
      else next.add(clave);
      return next;
    });
  };
  const itemsElegidos = itemsRecetados.filter((it) => elegidos.has(claveDe(it)));

  const agregarExtra = (item) => {
    if (!item?._id) return;
    const id = String(item._id);
    // Ni repetido ni igual al principal: la cita no puede decir que la misma
    // ecografía se hizo dos veces.
    if (id === String(servicio?._id || '')) {
      toast('Ese ya es el servicio principal de la cita', { icon: 'ℹ️' });
      return;
    }
    setExtras((prev) => (prev.some((s) => s._id === id) ? prev : [...prev, { _id: id, name: item.name }]));
    setLlaveSelector((k) => k + 1);
  };

  const quitarExtra = (id) => setExtras((prev) => prev.filter((s) => s._id !== id));

  const paciente = apt?.patient
    ? `${apt.patient.firstName || ''} ${apt.patient.lastName || ''}`.trim() || 'Paciente'
    : 'Paciente';

  const guardar = async () => {
    setBusy(true);
    try {
      const { data } = await api.patch(`/appointments/${apt._id}/service-value`, {
        serviceItem: servicio?._id || null,
        // La lista COMPLETA, no un "añade este": quitar uno es mandarla sin él.
        additionalServices: extras.map((s) => s._id),
        agreedValue: canje ? 0 : valor === '' ? null : Number(valor),
        isCanje: canje,
        advancePayment: adelanto || '',
        advanceAmount: abonado === '' ? 0 : Number(abonado),
        advanceMethod: formaPago || '',
        // Quién lo atendió, SOLO si se cambió: mandarlo igual sería pedirle al
        // servidor una corrección que no lo es.
        ...(sePuedeCorregirAtendido && atendido && atendido !== doctorAtendidoInicial
          ? { attendedDoctor: atendido }
          : {}),
      });
      /**
       * EL COBRO DE LOS ITEMS, por su propia puerta. Va en el mismo guardar para
       * que sea UN gesto: marcó los checks, puso el valor, guardó. El servidor
       * deja anotado quién registró el cobro.
       */
      let actualizada = data;
      try {
        const { data: conCobro } = await api.patch(`/appointments/${apt._id}/cobro-items`, {
          items: itemsElegidos.map((it) => ({
            followUp: it.followUp,
            item: it.item,
            name: it.name,
            quantity: it.quantity,
          })),
          itemsValue: itemsValue === '' ? null : Number(itemsValue),
          itemsMethod,
        });
        actualizada = conCobro;
      } catch (e) {
        toast.error(e.response?.data?.message || 'La cita se guardó, pero el cobro de los items no');
      }
      toast.success('Servicio y valor actualizados');
      onDone?.(actualizada);
      onClose?.();
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo actualizar la cita');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title="Servicio y valor de la cita" size="md">
      <div className="space-y-4">
        <div className="bg-slate-50 border border-slate-200 rounded-xl px-4 py-3">
          <p className="font-semibold text-slate-800">{paciente}</p>
          <p className="text-sm text-slate-500">
            {apt?.startTime}
            {apt?.serviceName ? ` · ${apt.serviceName}` : ''}
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">
            Servicio por el que asistió
          </label>
          <ServiceItemPicker value={servicio} onChange={setServicio} />
        </div>

        {/* OTROS SERVICIOS de la misma visita. El paciente entra por una consulta
            y de paso le hacen una ecografía: antes había que elegir cuál de los
            dos se anotaba y el otro se perdía. */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">
            Otros servicios de esta visita
          </label>

          {extras.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {extras.map((s) => (
                <span
                  key={s._id}
                  className="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-full bg-violet-100 text-violet-800 text-xs font-medium"
                >
                  {s.name}
                  <button
                    type="button"
                    onClick={() => quitarExtra(s._id)}
                    title={`Quitar ${s.name}`}
                    className="p-0.5 rounded-full hover:bg-violet-200 text-violet-600 bg-transparent border-none cursor-pointer"
                  >
                    <HiOutlineXMark className="w-3.5 h-3.5" />
                  </button>
                </span>
              ))}
            </div>
          )}

          <ServiceItemPicker
            key={llaveSelector}
            value={null}
            onChange={agregarExtra}
            placeholder="Añade otro servicio…"
          />
          <p className="flex items-center gap-1 text-[11px] text-slate-400 mt-1">
            <HiOutlinePlus className="w-3 h-3 shrink-0" />
            Se añaden uno a uno. El valor de abajo es el total de la visita, con
            estos incluidos.
          </p>
        </div>

        {/**
          * LO QUE EL DOCTOR RECETÓ, EN CHECKS (sep-2026). Igual que las
          * ampollas del suero: una casilla por línea, y mostrador marca lo que
          * el paciente se lleva. El valor de lo marcado va en SU cuadro, aparte
          * del valor de la cita.
          */}
        {(itemsRecetados.length > 0 || (apt?.prescribedItems || []).length > 0) && (
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">
              <HiOutlineBeaker className="inline w-4 h-4 mr-1 -mt-0.5 text-violet-600" />
              Receta del doctor — marca lo que el paciente va a comprar
            </label>
            <div className="rounded-xl border border-violet-200 bg-violet-50/60 p-2.5 space-y-1 max-h-60 overflow-y-auto">
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
                      onChange={() => toggleItem(it)}
                      className="w-4 h-4 accent-violet-600 cursor-pointer shrink-0"
                    />
                    <span className="text-sm text-slate-800 min-w-0 truncate flex-1">
                      {it.name}
                      {it.quantity > 1 ? ` × ${it.quantity}` : ''}
                    </span>
                  </label>
                );
              })}
              {itemsRecetados.length === 0 && (apt?.prescribedItems || []).length > 0 && (
                <p className="text-xs text-violet-800 m-0">
                  {(apt.prescribedItems || []).map((it) => `${it.name}${it.quantity > 1 ? ` ×${it.quantity}` : ''}`).join(', ')}
                </p>
              )}
            </div>
            <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  Valor de los items (lo que paga por ellos)
                </label>
                <div className="relative">
                  <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 text-sm">$</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={itemsValue}
                    onChange={(e) => setItemsValue(e.target.value)}
                    placeholder="0.00"
                    className="w-full pl-7 pr-4 py-2 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-violet-500 bg-slate-50/50"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  ¿Cómo pagó los items?
                </label>
                <select
                  value={itemsMethod}
                  onChange={(e) => setItemsMethod(e.target.value)}
                  className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white"
                >
                  <option value="">No se dijo</option>
                  <option value="efectivo">Efectivo</option>
                  <option value="transferencia">Transferencia</option>
                  <option value="tarjeta_credito">T. crédito</option>
                  <option value="tarjeta_debito">T. débito</option>
                </select>
              </div>
            </div>
            <p className="text-[11px] text-slate-400 mt-1">
              Aparte del valor de la cita. Queda anotado quién registró el cobro.
            </p>
          </div>
        )}

        <AppointmentValueFields
          value={valor}
          onValueChange={setValor}
          isCanje={canje}
          onCanjeChange={setCanje}
          advancePayment={adelanto}
          onAdvancePaymentChange={setAdelanto}
          advanceAmount={abonado}
          advanceMethod={formaPago}
          onAdvanceMethodChange={setFormaPago}
          onAdvanceAmountChange={setAbonado}
        />

        {sePuedeCorregirAtendido ? (
          /**
           * QUIÉN LO ATENDIÓ, corregible en una cita que ya terminó. Es el caso
           * de la cita que se cerró mal —se asignó solo a enfermería y el doctor
           * que la vio quedó fuera, o quedó otro—: se corrige aquí y la agenda,
           * los reportes y las comisiones pasan a decir quién estuvo de verdad.
           */
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">
              Quién lo atendió
            </label>
            <SearchableSelect
              options={doctors}
              value={atendido}
              onChange={setAtendido}
              getLabel={doctorOptionLabel}
              getSearchText={(d) => `${d.name || ''} ${d.specialty || ''} ${doctorOptionLabel(d)}`}
              placeholder="Sin doctor anotado — escoge al doctor que atendió"
              searchPlaceholder="Buscar por nombre o especialidad…"
              size="sm"
            />
            <p className="flex items-start gap-1 text-[11px] text-slate-400 mt-1">
              <HiOutlineLockClosed className="w-3.5 h-3.5 shrink-0 mt-px" />
              <span>
                Cambia quién figura como el doctor que atendió la cita (en el
                enfermero no se toca). El seguimiento ya escrito no se mueve.
              </span>
            </p>
          </div>
        ) : (
          <p className="flex items-start gap-2 text-[11px] text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
            <HiOutlineLockClosed className="w-4 h-4 shrink-0 mt-px text-slate-400" />
            <span>
              Quién atendió al paciente se corrige desde «Asignar atención» hasta
              que la cita se completa.
            </span>
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-slate-200 bg-white text-sm text-slate-600 cursor-pointer"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={guardar}
            disabled={busy}
            className="flex items-center gap-1.5 px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium border-none cursor-pointer disabled:opacity-50"
          >
            {busy ? 'Guardando…' : <><HiOutlineCheck className="w-4 h-4" /> Guardar</>}
          </button>
        </div>
      </div>
    </Modal>
  );
}
