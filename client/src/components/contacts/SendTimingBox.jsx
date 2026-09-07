/**
 * "¿Desde qué número?" + "¿cuándo sale el primer mensaje?" + goteo.
 *
 * Lo comparten los DOS envíos masivos —los contactos importados de un Excel y los
 * recordatorios a las citas de la agenda— porque las preguntas son las mismas y,
 * sobre todo, porque las respuestas correctas son las mismas: el goteo protege el
 * número igual en los dos casos y el "número automático" significa lo mismo. Vivía
 * dentro del asistente de importación; se sacó aquí al aparecer el segundo envío,
 * para no tener dos copias que se separen con el tiempo.
 */
const HHMM_RE = /^\d{1,2}:\d{2}$/;

/**
 * "Hora de envío" que trae configurada el disparador del flujo ("HH:MM") o '' si
 * no trae ninguna. Sirve para avisar al usuario y dejarle elegir entre la hora
 * del flujo y una que indique en el momento del envío.
 *
 * `type` es el disparador al que preguntar: 'contact_import' para la importación
 * de contactos, 'appointment_bulk' para los recordatorios de citas.
 */
export function flowSendHourOf(wf, type = 'contact_import') {
  if (!wf) return '';
  const triggerNodes = (wf.nodes || []).filter((n) => n.type === 'trigger');
  // Se MEZCLAN las dos fuentes en vez de elegir una. Antes, si el flujo traía
  // nodos disparadores se usaban SOLO ellos; bastaba que llegaran sin `data`
  // (p. ej. desde un listado proyectado) para perder la hora de envío y mandar
  // el goteo de inmediato. Ahora la ausencia de `data` simplemente no aporta
  // nada y sigue valiendo la configuración a nivel workflow.
  const triggers = [
    ...triggerNodes.flatMap((n) => n.data?.triggers || []),
    wf.trigger,
    ...(wf.triggers || []),
  ].filter(Boolean);
  for (const t of triggers) {
    if (t?.type === type && HHMM_RE.test(t.sendHour || '')) return t.sendHour;
  }
  return '';
}

/**
 * `noun` es cómo se llama cada destinatario en esta pantalla ("contacto" en la
 * importación, "cita" en los recordatorios): el texto explica lo mismo, pero
 * hablando de lo que el usuario tiene delante.
 */
export default function SendTimingBox({
  opts,
  setOpts,
  workflows,
  accounts = [],
  triggerType = 'contact_import',
  noun = 'contacto',
}) {
  const selectedWf = workflows.find((w) => w._id === opts.workflows[0]);
  const flowHour = flowSendHourOf(selectedWf, triggerType);
  const autoAccount = !opts.whatsappAccount;
  const plural = noun === 'cita' ? 'citas' : 'contactos';

  const OptionRow = ({ value, title, desc, children }) => (
    <label
      className={`flex items-start gap-2 border rounded-lg px-2.5 py-2 cursor-pointer ${
        opts.sendMode === value ? 'border-violet-300 bg-white' : 'border-slate-200 hover:bg-white/60'
      }`}
    >
      <input
        type="radio"
        name="send-mode"
        checked={opts.sendMode === value}
        onChange={() => setOpts((s) => ({ ...s, sendMode: value }))}
        className="mt-0.5 cursor-pointer"
      />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-slate-700">{title}</div>
        {desc && <div className="text-[11px] text-slate-400">{desc}</div>}
        {children}
      </div>
    </label>
  );

  return (
    <div className="border border-violet-200 bg-violet-50/40 rounded-xl p-3 space-y-2.5">
      {/* Desde qué número. Automático = cada destinatario recibe el mensaje por el
          número al que ÉL escribió la última vez; quien nunca escribió, por el
          principal. Es lo que evita contestar por la API a quien nos habló al QR. */}
      <div>
        <div className="text-xs font-semibold text-slate-600 mb-1">¿Desde qué número se envía?</div>
        <select
          value={opts.whatsappAccount}
          onChange={(e) => setOpts((s) => ({ ...s, whatsappAccount: e.target.value }))}
          className="w-full border border-slate-200 rounded-lg px-2.5 py-2 text-sm bg-white"
        >
          <option value="">Automático — el último número con el que habló cada {noun === 'cita' ? 'paciente' : noun}</option>
          {accounts.map((a) => (
            <option key={a._id} value={a._id}>
              Siempre desde {a.label} — {a.connectionType === 'cloud_api' ? 'Cloud API' : 'QR (WhatsApp Web)'}
            </option>
          ))}
        </select>
        <p className="text-[11px] text-slate-500 mt-1">
          {autoAccount
            ? 'A quien nos escribió por el número del QR se le responde por el QR, y a quien escribió por el de la API, por la API. Si nunca nos ha escrito, sale por el número principal.'
            : `Todo este envío saldrá por ese número, aunque el ${noun === 'cita' ? 'paciente' : noun} nos haya escrito a otro.`}
        </p>
      </div>

      <div className="text-xs font-semibold text-slate-600 pt-1 border-t border-violet-200">
        ¿Cuándo enviar el primer mensaje?
      </div>

      {flowHour && (
        <div className="text-[11px] text-violet-900 bg-white border border-violet-200 rounded-lg px-2.5 py-2">
          ⏰ Esta automatización ya tiene una <b>hora de envío programada ({flowHour})</b>. Puedes
          respetarla o indicar otra aquí para este envío.
        </div>
      )}

      <div className="space-y-1.5">
        {flowHour && (
          <OptionRow
            value="flow"
            title={`Usar la hora del flujo (${flowHour})`}
            desc="Respeta lo configurado en la automatización. Hoy si aún no pasa, mañana si ya pasó."
          />
        )}
        <OptionRow
          value="now"
          title="Enviar de inmediato"
          desc={`El primer mensaje sale ya (con el goteo entre una ${noun} y la siguiente).`}
        />
        <OptionRow
          value="at"
          title="A una hora específica"
          desc="Elige la hora a la que quieres que salgan. Hoy si aún no pasa, mañana si ya pasó."
        >
          {opts.sendMode === 'at' && (
            <input
              type="time"
              value={opts.sendAt}
              onChange={(e) => setOpts((s) => ({ ...s, sendAt: e.target.value }))}
              className="mt-1.5 w-32 border border-slate-200 rounded-lg px-2 py-1.5 text-sm"
            />
          )}
        </OptionRow>
      </div>

      <div className="pt-1">
        <label className="text-xs font-semibold text-slate-600 block mb-1">
          Goteo: segundos de espera entre cada mensaje
        </label>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            max={3600}
            value={opts.dripSeconds}
            onChange={(e) => setOpts((s) => ({ ...s, dripSeconds: e.target.value }))}
            onBlur={(e) => {
              const n = Math.min(3600, Math.max(1, Math.round(Number(e.target.value) || 20)));
              setOpts((s) => ({ ...s, dripSeconds: n }));
            }}
            className="w-24 border border-slate-200 rounded-lg px-3 py-2 text-sm"
          />
          <span className="text-xs text-slate-500">segundos entre {plural}</span>
        </div>
        <p className="text-[10px] text-slate-400 mt-1">
          Protege tu número: más segundos = más lento y más seguro. Los que comparten hora se separan
          por este intervalo.
        </p>
      </div>
    </div>
  );
}
