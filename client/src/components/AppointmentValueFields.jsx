import NumericInput from './NumericInput';

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
];

export default function AppointmentValueFields({
  value,
  onValueChange,
  isCanje,
  onCanjeChange,
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
  className = '',
}) {
  const conAdelanto = typeof onAdvancePaymentChange === 'function';
  return (
    <div className={className}>
      <label className="block text-sm font-medium text-slate-700 mb-1.5">
        Valor de la cita <span className="font-normal text-slate-400">(opcional)</span>
      </label>
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 text-sm">$</span>
          <NumericInput
            value={isCanje ? '' : value}
            onChange={(e) => onValueChange(e.target.value)}
            disabled={!!isCanje}
            placeholder={isCanje ? 'Canje — sin importe' : '0.00'}
            className="w-full pl-7 pr-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 bg-slate-50/50 disabled:bg-slate-100 disabled:text-slate-400"
          />
        </div>
        <label className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-amber-200 bg-amber-50 text-sm font-medium text-amber-900 cursor-pointer shrink-0">
          <input
            type="checkbox"
            checked={!!isCanje}
            onChange={(e) => onCanjeChange(e.target.checked)}
            className="w-4 h-4 accent-amber-600"
          />
          Fue canje
        </label>
      </div>
      <p className="text-[11px] text-slate-400 mt-1">
        Cuánto paga el paciente por esta visita. Es informativo para la agenda: no genera
        venta ni cobro. <b>Canje</b> = no pagó con dinero.
      </p>

      {/* Un canje no es un pago: si no entró dinero, no hay adelanto que anotar
          (el servidor lo borra igual, ver `aplicarValorDeCita`). */}
      {conAdelanto && !isCanje && (
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
                  onClick={() => onAdvancePaymentChange(o.valor)}
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
          {advancePayment === 'total' && (
            <p className="text-[11px] text-emerald-700 mt-1.5">
              Al llegar no hay que cobrarle nada.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
