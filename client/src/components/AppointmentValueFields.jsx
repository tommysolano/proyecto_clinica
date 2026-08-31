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
export default function AppointmentValueFields({
  value,
  onValueChange,
  isCanje,
  onCanjeChange,
  className = '',
}) {
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
    </div>
  );
}
