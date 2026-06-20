import { useEffect, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import NumericInput from '../components/NumericInput';
import {
  HiOutlinePlus,
  HiOutlineMegaphone,
  HiOutlinePaperAirplane,
  HiOutlineNoSymbol,
  HiOutlineClock,
} from 'react-icons/hi2';
import Modal from '../components/Modal';

const STATUS_BADGE = {
  draft: { label: 'Borrador', cls: 'bg-slate-100 text-slate-600' },
  scheduled: { label: 'Programada', cls: 'bg-indigo-100 text-indigo-700' },
  sending: { label: 'Enviando', cls: 'bg-amber-100 text-amber-700' },
  done: { label: 'Finalizada', cls: 'bg-emerald-100 text-emerald-700' },
  cancelled: { label: 'Cancelada', cls: 'bg-red-100 text-red-700' },
};

const blank = () => ({
  name: '',
  channel: 'whatsapp',
  segment: '',
  mode: 'body', // 'body' | 'template'
  template: '',
  body: '',
  subject: '',
  when: 'now', // 'now' | 'later'
  scheduledFor: '',
  maxRecipients: '',
  dripEnabled: false,
  dripBatchSize: 50,
  dripIntervalMinutes: 60,
});

export default function Campaigns() {
  const [list, setList] = useState([]);
  const [segments, setSegments] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [emailTemplates, setEmailTemplates] = useState([]);
  const [creating, setCreating] = useState(null);
  const [segPreview, setSegPreview] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try {
      const [cs, segs, tpls, etpls] = await Promise.all([
        api.get('/campaigns'),
        api.get('/segments'),
        api.get('/message-templates?channel=whatsapp'),
        api.get('/message-templates?channel=email').catch(() => ({ data: [] })),
      ]);
      setList(cs.data);
      setSegments(segs.data);
      setTemplates(tpls.data.filter((t) => t.status === 'approved'));
      setEmailTemplates(etpls.data || []);
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al cargar campañas');
    }
  };

  useEffect(() => {
    load();
  }, []);

  // Refresca periódicamente mientras haya campañas en curso.
  useEffect(() => {
    const active = list.some((c) => c.status === 'sending' || c.status === 'scheduled');
    if (!active) return;
    const id = setInterval(load, 8000);
    return () => clearInterval(id);
  }, [list]);

  const previewSegment = async (segmentId) => {
    setSegPreview(null);
    if (!segmentId) return;
    try {
      const { data } = await api.get(`/segments/${segmentId}/resolve?preview=true`);
      setSegPreview(data.count);
    } catch {
      setSegPreview(null);
    }
  };

  const create = async () => {
    const c = creating;
    if (!c.name.trim()) return toast.error('Ponle un nombre a la campaña');
    if (!c.segment) return toast.error('Selecciona un segmento');
    const isEmail = c.channel === 'email';
    if (!isEmail && c.mode === 'template' && !c.template) return toast.error('Selecciona una plantilla');
    if ((isEmail || c.mode === 'body') && !c.body.trim()) return toast.error('Escribe el mensaje');
    if (isEmail && !c.subject.trim()) return toast.error('El email requiere un asunto');
    if (c.when === 'later' && !c.scheduledFor) return toast.error('Indica fecha y hora');

    setSaving(true);
    try {
      await api.post('/campaigns', {
        name: c.name,
        channel: c.channel,
        segment: c.segment,
        template: !isEmail && c.mode === 'template' ? c.template : undefined,
        body: isEmail || c.mode === 'body' ? c.body : undefined,
        subject: isEmail ? c.subject : undefined,
        scheduledFor: c.when === 'later' ? c.scheduledFor : undefined,
        maxRecipients: c.maxRecipients ? Number(c.maxRecipients) : undefined,
        drip: c.dripEnabled
          ? { batchSize: Number(c.dripBatchSize) || 0, intervalMinutes: Number(c.dripIntervalMinutes) || 60 }
          : undefined,
      });
      toast.success('Campaña creada');
      setCreating(null);
      setSegPreview(null);
      load();
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al crear campaña');
    } finally {
      setSaving(false);
    }
  };

  const cancel = async (id) => {
    if (!window.confirm('¿Cancelar los envíos pendientes de esta campaña?')) return;
    try {
      await api.post(`/campaigns/${id}/cancel`);
      toast.success('Campaña cancelada');
      load();
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al cancelar');
    }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <HiOutlineMegaphone className="text-emerald-600" /> Campañas
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Envíos masivos a un segmento, ahora o programados. Respetan opt-out y ventana de 24h.
          </p>
        </div>
        <button onClick={() => setCreating(blank())} className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm flex items-center gap-1 cursor-pointer border-none">
          <HiOutlinePlus /> Nueva campaña
        </button>
      </div>

      <div className="grid gap-3">
        {list.length === 0 && (
          <div className="text-center py-16 text-slate-400 border border-dashed border-slate-200 rounded-xl">
            Aún no has creado campañas.
          </div>
        )}
        {list.map((c) => {
          const badge = STATUS_BADGE[c.status] || STATUS_BADGE.draft;
          const s = c.stats || {};
          return (
            <div key={c._id} className="border border-slate-200 rounded-xl p-4 bg-white">
              <div className="flex justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold">{c.name}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${badge.cls}`}>{badge.label}</span>
                    <span className="text-xs text-slate-400">
                      {c.channel} · {c.segment?.name || 'segmento'} · {c.templateName || 'texto libre'}
                    </span>
                  </div>
                  {c.status === 'scheduled' && (
                    <div className="text-xs text-indigo-600 mt-1 flex items-center gap-1">
                      <HiOutlineClock /> Programada para {new Date(c.scheduledFor).toLocaleString()}
                    </div>
                  )}
                  <div className="flex gap-4 text-xs mt-2 text-slate-600 flex-wrap">
                    <span>🎯 {s.targeted || 0}</span>
                    <span className="text-emerald-600">✓ {s.sent || 0} enviados</span>
                    <span className="text-amber-600">⏳ {s.queued || 0} en cola</span>
                    <span className="text-slate-400">⊘ {s.skipped || 0} omitidos</span>
                    <span className="text-red-500">✗ {s.failed || 0} fallidos</span>
                    {c.channel === 'email' && (
                      <>
                        <span className="text-sky-600" title="Aperturas">👁 {s.opened || 0} abiertos</span>
                        <span className="text-violet-600" title="Clics">🔗 {s.clicked || 0} clics</span>
                      </>
                    )}
                  </div>
                </div>
                {['scheduled', 'sending'].includes(c.status) && (
                  <button onClick={() => cancel(c._id)} className="self-start px-3 py-1.5 border border-red-200 text-red-600 rounded-lg text-xs flex items-center gap-1 bg-white cursor-pointer">
                    <HiOutlineNoSymbol /> Cancelar
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <Modal isOpen={!!creating} onClose={() => { setCreating(null); setSegPreview(null); }} title="Nueva campaña" size="md">
        {creating && (
          <>
            <div className="grid gap-3">
              <label className="text-sm">
                <span className="text-slate-600 block mb-1">Nombre de la campaña</span>
                <input value={creating.name} onChange={(e) => setCreating({ ...creating, name: e.target.value })} placeholder="ej. Promo limpieza octubre" className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" />
              </label>

              <div>
                <span className="text-sm text-slate-600 block mb-1">Canal de envío</span>
                <div className="flex gap-2 text-sm">
                  <button type="button" onClick={() => setCreating({ ...creating, channel: 'whatsapp' })} className={`px-3 py-1.5 rounded-lg border cursor-pointer ${creating.channel === 'whatsapp' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-600 border-slate-200'}`}>WhatsApp</button>
                  <button type="button" onClick={() => setCreating({ ...creating, channel: 'email', mode: 'body' })} className={`px-3 py-1.5 rounded-lg border cursor-pointer ${creating.channel === 'email' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-600 border-slate-200'}`}>Email</button>
                </div>
              </div>

              <label className="text-sm">
                <span className="text-slate-600">Segmento de destino</span>
                <select
                  value={creating.segment}
                  onChange={(e) => { setCreating({ ...creating, segment: e.target.value }); previewSegment(e.target.value); }}
                  className="w-full mt-1 border border-slate-200 rounded-lg px-2 py-2 text-sm"
                >
                  <option value="">Selecciona…</option>
                  {segments.map((s) => <option key={s._id} value={s._id}>{s.name}</option>)}
                </select>
                {segPreview != null && (
                  <span className="text-xs text-emerald-700 font-semibold">{segPreview} destinatario(s)</span>
                )}
              </label>

              {creating.channel === 'email' ? (
                <>
                  {emailTemplates.length > 0 && (
                    <label className="text-sm">
                      <span className="text-slate-600">Usar plantilla de email (opcional)</span>
                      <select
                        value=""
                        onChange={(e) => {
                          const t = emailTemplates.find((x) => x._id === e.target.value);
                          if (t) setCreating({ ...creating, subject: t.subject || creating.subject, body: t.body || creating.body });
                        }}
                        className="w-full mt-1 border border-slate-200 rounded-lg px-2 py-2 text-sm"
                      >
                        <option value="">— Empezar desde una plantilla —</option>
                        {emailTemplates.map((t) => <option key={t._id} value={t._id}>{t.name}</option>)}
                      </select>
                      <span className="text-xs text-slate-400">Rellena el asunto y cuerpo; puedes editarlos antes de enviar.</span>
                    </label>
                  )}
                  <label className="text-sm">
                    <span className="text-slate-600">Asunto</span>
                    <input value={creating.subject} onChange={(e) => setCreating({ ...creating, subject: e.target.value })} className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm" placeholder="Asunto del correo (usa {{nombre}})" />
                  </label>
                  <label className="text-sm">
                    <span className="text-slate-600">Cuerpo del email</span>
                    <textarea value={creating.body} onChange={(e) => setCreating({ ...creating, body: e.target.value })} rows={5} className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm" />
                    <span className="text-xs text-slate-400">Se añade automáticamente un enlace de baja. Solo se envía a pacientes con email y opt-in.</span>
                  </label>
                </>
              ) : (
                <>
                  <div className="flex gap-2 text-sm">
                    <button type="button" onClick={() => setCreating({ ...creating, mode: 'body' })} className={`px-3 py-1.5 rounded-lg border cursor-pointer ${creating.mode === 'body' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-600 border-slate-200'}`}>Texto libre</button>
                    <button type="button" onClick={() => setCreating({ ...creating, mode: 'template' })} className={`px-3 py-1.5 rounded-lg border cursor-pointer ${creating.mode === 'template' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-600 border-slate-200'}`}>Plantilla</button>
                  </div>
                  {creating.mode === 'body' ? (
                    <label className="text-sm">
                      <span className="text-slate-600">Mensaje (usa {'{{nombre}}'})</span>
                      <textarea value={creating.body} onChange={(e) => setCreating({ ...creating, body: e.target.value })} rows={4} className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm" />
                      <span className="text-xs text-amber-600">⚠ El texto libre solo llega a quien escribió en las últimas 24h. Para inactivos usa una plantilla.</span>
                    </label>
                  ) : (
                    <label className="text-sm">
                      <span className="text-slate-600">Plantilla aprobada</span>
                      <select value={creating.template} onChange={(e) => setCreating({ ...creating, template: e.target.value })} className="w-full mt-1 border border-slate-200 rounded-lg px-2 py-2 text-sm">
                        <option value="">Selecciona…</option>
                        {templates.map((t) => <option key={t._id} value={t._id}>{t.name} ({t.language})</option>)}
                      </select>
                      {templates.length === 0 && <span className="text-xs text-slate-400">No hay plantillas aprobadas. Crea/sincroniza en "Plantillas de mensaje".</span>}
                    </label>
                  )}
                </>
              )}

              <div className="flex gap-2 text-sm">
                <button type="button" onClick={() => setCreating({ ...creating, when: 'now' })} className={`px-3 py-1.5 rounded-lg border cursor-pointer ${creating.when === 'now' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-600 border-slate-200'}`}>Enviar ahora</button>
                <button type="button" onClick={() => setCreating({ ...creating, when: 'later' })} className={`px-3 py-1.5 rounded-lg border cursor-pointer ${creating.when === 'later' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-600 border-slate-200'}`}>Programar</button>
              </div>
              {creating.when === 'later' && (
                <input type="datetime-local" value={creating.scheduledFor} onChange={(e) => setCreating({ ...creating, scheduledFor: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2 text-sm" />
              )}

              {/* Tope de destinatarios + goteo (drip) */}
              <div className="border-t border-slate-100 pt-3 grid gap-2">
                <label className="text-sm">
                  <span className="text-slate-600">Máximo de personas (opcional)</span>
                  <NumericInput
                    min="1"
                    value={creating.maxRecipients}
                    onChange={(e) => setCreating({ ...creating, maxRecipients: e.target.value })}
                    placeholder="Sin límite"
                    className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
                  />
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={creating.dripEnabled} onChange={(e) => setCreating({ ...creating, dripEnabled: e.target.checked })} />
                  Enviar por lotes (goteo)
                </label>
                {creating.dripEnabled && (
                  <div className="flex items-center gap-2 text-sm flex-wrap pl-6">
                    <span className="text-slate-600">Enviar</span>
                    <NumericInput min="1" value={creating.dripBatchSize} onChange={(e) => setCreating({ ...creating, dripBatchSize: e.target.value })} className="w-20 border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
                    <span className="text-slate-600">personas cada</span>
                    <NumericInput min="1" value={creating.dripIntervalMinutes} onChange={(e) => setCreating({ ...creating, dripIntervalMinutes: e.target.value })} className="w-20 border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
                    <span className="text-slate-600">minutos</span>
                  </div>
                )}
                {creating.dripEnabled && Number(creating.dripBatchSize) > 0 && (
                  <p className="text-[11px] text-slate-400 pl-6">
                    Se escalonan los envíos en lotes de {creating.dripBatchSize} cada {creating.dripIntervalMinutes} min para no saturar el número y mejorar la entrega.
                  </p>
                )}
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <button onClick={() => { setCreating(null); setSegPreview(null); }} className="px-4 py-2 border border-slate-200 rounded-lg text-sm bg-white cursor-pointer">Cancelar</button>
              <button onClick={create} disabled={saving} className="px-5 py-2 bg-emerald-600 text-white rounded-lg text-sm cursor-pointer border-none flex items-center gap-1 disabled:opacity-50">
                <HiOutlinePaperAirplane /> {saving ? 'Creando…' : creating.when === 'now' ? 'Enviar' : 'Programar'}
              </button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
