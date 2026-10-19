import NumericInput from './NumericInput';
import ServiciosSinCobro from './ServiciosSinCobro';
import { todosSinCobro } from '../utils/serviciosSinCobro';

/**
 * VALOR DE LA CITA + CANJE. Es un dato OPERATIVO: lo que se acordó que va a
 * pagar el paciente por esta visita. No genera venta, ni factura, ni cobro —
 * todo eso vive en su propio módulo, y separarlos fue una decisión del proyecto.
 *
 * Vive en su propio componente porque se pide en DOS sitios que tienen que
 * comportarse igual: al recibir al paciente (AssignAttentionModal) y al
 * corregirlo después (AppointmentServiceValueModal).
 *
 * El canje y el importe son EXCLUYENTES, y aquí se ve: al marcar canje el campo
 * se apaga. Un canje es que no entró dinero; dejarle un importe encima haría que
 * el mismo servicio se contara dos veces al sumar lo cobrado.
 *
 * Props: value, onValueChange(str), isCanje, onCanjeChange(bool), className
 */
/**
 * Las tres respuestas posibles a «¿pagó algo por adelantado?». Las palabras son
 * las de la clínica, no las del modelo: quien agenda por teléfono dice «abonó»
 * y «pagó todo».
 */
const OPCIONES_ADELANTO = [
  { valor: '', etiqueta: 'No pagó aún' },
  { valor: 'abono', etiqueta: 'Abonó una parte' },
  { valor: 'total', etiqueta: 'Pagó todo' },
  { valor: 'prepagado', etiqueta: 'Prepagado' },
];

/**
 * CÓMO pagó ese adelanto. Saber que abonó 20 no basta cuando el paciente llega:
 * un efectivo tiene que estar en la caja del día y una transferencia hay que ir
 * a buscarla al banco. Los valores son los del enum del modelo
 * (Appointment.advanceMethod).
 */
const FORMAS_DE_PAGO = [
  { valor: 'efectivo', etiqueta: 'Efectivo' },
  { valor: 'transferencia', etiqueta: 'Transferencia' },
  { valor: 'tarjeta_credito', etiqueta: 'T. crédito' },
  { valor: 'tarjeta_debito', etiqueta: 'T. débito' },
];

export default function AppointmentValueFields({
  value,
  onValueChange,
  isCanje,
  onCanjeChange,
  /**
   * CORTESÍA (oct-2026): la cita no se cobra porque se regala (una revisión, un
   * control). Se guarda como el canje —su propio campo, valor 0— y los dos son
   * excluyentes. Opcional: sin onCortesiaChange no se enseña.
   */
  isCortesia = false,
  onCortesiaChange,
  /**
   * PAGO ADELANTADO (opcional). Se enseña solo si quien pinta el formulario lo
   * pasa: el call center cierra la cita por teléfono y cobra en el momento, y
   * mostrador necesita saber al recibir al paciente si le cobra el resto, todo,
   * o nada. Sin estas props el componente es exactamente el de antes.
   */
  advancePayment,
  onAdvancePaymentChange,
  advanceAmount,
  onAdvanceAmountChange,
  /**
   * Forma de pago del adelanto. Opcional como el resto del bloque: sin
   * `onAdvanceMethodChange` el componente se comporta como antes.
   */
  advanceMethod,
  onAdvanceMethodChange,
  /**
   * CANJE/CORTESÍA POR SERVICIO (oct-2026). Con dos o más `servicios` y
   * `onSinCobroChange`, en vez de las casillas de la visita sale una fila por
   * servicio («Se cobra / Canje / Cortesía»): uno puede pagarse y otro no.
   * `sinCobro` es la lista [{serviceItem, kind}]; se manda al servidor como
   * `noChargeServices` y él deduce la marca de la visita.
   */
  servicios = [],
  sinCobro = [],
  onSinCobroChange,
  className = '',
}) {
  const conAdelanto = typeof onAdvancePaymentChange === 'function';
  const conCortesia = typeof onCortesiaChange === 'function';
  const porServicio = typeof onSinCobroChange === 'function' && servicios.length > 1;
  // Canje o cortesía: no entra dinero, no hay importe ni adelanto.
  const sinDinero = porServicio ? todosSinCobro(servicios, sinCobro) : !!isCanje || !!isCortesia;
  const algunoSinCobro = porServicio && (sinCobro || []).length > 0 && !sinDinero;
  return (
    <div className={className}>
      <label className="block text-sm font-medium text-slate-700 mb-1.5">
        Valor de la cita <span className="font-normal text-slate-400">(opcional)</span>
      </label>
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 text-sm">$</span>
          <NumericInput
            value={sinDinero ? '' : value}
            onChange={(e) => onValueChange(e.target.value)}
            disabled={sinDinero}
            placeholder={porServicio
              ? (sinDinero ? 'Ningún servicio se cobra' : algunoSinCobro ? 'Solo lo de los servicios que se cobran' : '0.00')
              : isCanje ? 'Canje — sin importe' : isCortesia ? 'Cortesía — sin importe' : '0.00'}
            className="w-full pl-7 pr-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 bg-slate-50/50 disabled:bg-slate-100 disabled:text-slate-400"
          />
        </div>
        {!porServicio && (<>
        <label className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-amber-200 bg-amber-50 text-sm font-medium text-amber-900 cursor-pointer shrink-0">
          <input
            type="checkbox"
            checked={!!isCanje}
            onChange={(e) => {
              onCanjeChange(e.target.checked);
              if (e.target.checked && isCortesia) onCortesiaChange?.(false);
            }}
            className="w-4 h-4 accent-amber-600"
          />
          Fue canje
        </label>
        {conCortesia && (
          <label className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-violet-200 bg-violet-50 text-sm font-medium text-violet-900 cursor-pointer shrink-0">
            <input
              type="checkbox"
              checked={!!isCortesia}
              onChange={(e) => {
                onCortesiaChange(e.target.checked);
                if (e.target.checked && isCanje) onCanjeChange(false);
              }}
              className="w-4 h-4 accent-violet-600"
            />
            Fue cortesía
          </label>
        )}
        </>)}
      </div>
      {porServicio && (
        <ServiciosSinCobro
          className="mt-2"
          servicios={servicios}
          value={sinCobro}
          onChange={onSinCobroChange}
        />
      )}
      <p className="text-[11px] text-slate-400 mt-1">
        Cuánto paga el paciente por esta visita. Es informativo para la agenda: no genera
        venta ni cobro. <b>Canje</b> = no pagó con dinero.{conCortesia && <> <b>Cortesía</b> = se regaló, no se cobra.</>}
      </p>

      {/* Un canje no es un pago: si no entró dinero, no hay adelanto que anotar
          (el servidor lo borra igual, ver `aplicarValorDeCita`). */}
      {conAdelanto && !sinDinero && (
        <div className="mt-3">
          <label className="block text-sm font-medium text-slate-700 mb-1.5">
            ¿Pagó por adelantado?
          </label>
          <div className="flex flex-wrap gap-1.5">
            {OPCIONES_ADELANTO.map((o) => {
              const activa = (advancePayment || '') === o.valor;
              return (
                <button
                  key={o.valor || 'no'}
                  type="button"
                  onClick={() => {
                    onAdvancePaymentChange(o.valor);
                    // Sin adelanto no hay forma de pago que anotar: si se vuelve
                    // a «No pagó aún», el efectivo que se había marcado se cae
                    // con él (el servidor hace lo mismo al guardar).
                    if (!o.valor) onAdvanceMethodChange?.('');
                  }}
                  className={`px-3 py-1.5 rounded-xl border text-xs font-medium cursor-pointer ${
                    activa
                      ? 'bg-emerald-600 text-white border-emerald-600'
                      : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  {o.etiqueta}
                </button>
              );
            })}
          </div>
          {/* Solo el abono pide importe: «pagó todo» ES el valor de la cita, y
              tenerlo en dos campos es la forma segura de que no cuadren. */}
          {advancePayment === 'abono' && (
            <div className="relative mt-2 max-w-[200px]">
              <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 text-sm">$</span>
              <NumericInput
                value={advanceAmount ?? ''}
                onChange={(e) => onAdvanceAmountChange(e.target.value)}
                placeholder="Cuánto abonó"
                className="w-full pl-7 pr-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 bg-slate-50/50"
              />
            </div>
          )}
          {(advancePayment === 'total' || advancePayment === 'prepagado') && (
            <p className="text-[11px] text-emerald-700 mt-1.5">
              {advancePayment === 'prepagado'
                ? 'El paciente dejó el pago completo por adelantado: al llegar no hay que cobrarle nada.'
                : 'Al llegar no hay que cobrarle nada.'}
            </p>
          )}

          {/* CON QUÉ pagó. Solo si pagó algo, y solo si quien pinta el
              formulario pasa el manejador (igual que el resto del bloque). */}
          {!!advancePayment && typeof onAdvanceMethodChange === 'function' && (
            <div className="mt-2">
              <label className="block text-xs font-medium text-slate-600 mb-1">¿Cómo pagó?</label>
              <div className="flex flex-wrap gap-1.5">
                {FORMAS_DE_PAGO.map((f) => {
                  const activa = (advanceMethod || '') === f.valor;
                  return (
                    <button
                      key={f.valor}
                      type="button"
                      // Volver a pulsar la forma marcada la quita: es la única
                      // manera de dejarlo en «no se dijo» sin borrar el adelanto.
                      onClick={() => onAdvanceMethodChange(activa ? '' : f.valor)}
                      className={`px-3 py-1.5 rounded-xl border text-xs font-medium cursor-pointer ${
                        activa
                          ? 'bg-sky-600 text-white border-sky-600'
                          : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                      }`}
                    >
                      {f.etiqueta}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
