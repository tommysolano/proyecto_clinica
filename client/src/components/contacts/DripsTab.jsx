import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import {
  HiOutlinePlus,
  HiOutlinePlay,
  HiOutlinePause,
  HiOutlineTrash,
  HiOutlineExclamationTriangle,
} from 'react-icons/hi2';
import api from '../../api/axios';
import Modal from '../Modal';
import { useSocketEvent } from '../../context/SocketContext';
import { fmtDateTime } from '../../utils/date';
import { templateKeys, suggestVarMapping, previewBody, VAR_SOURCES } from '../../utils/templateVars';

const STATUS_META = {
  draft: { label: 'Borrador', chip: 'bg-slate-100 text-slate-600' },
  running: { label: 'En marcha', chip: 'bg-emerald-100 text-emerald-700' },
  paused: { label: 'Pausada', chip: 'bg-amber-100 text-amber-700' },
  done: { label: 'Terminada', chip: 'bg-sky-100 text-sky-700' },
  failed: { label: 'Falló', chip: 'bg-rose-100 text-rose-700' },
};

const DAYS = [
  { v: 1, l: 'L' }, { v: 2, l: 'M' }, { v: 3, l: 'X' }, { v: 4, l: 'J' },
  { v: 5, l: 'V' }, { v: 6, l: 'S' }, { v: 0, l: 'D' },
];

export default function DripsTab({ groups }) {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(undefined);

  const load = async () => {
    try {
      setLoading(true);
      const r = await api.get('/contacts/drips');
      setList(r.data || []);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al cargar campañas');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // El goteo avanza solo en el servidor: sin esto la pantalla mentiría hasta recargar.
  useSocketEvent('drip:progress', () => { load(); }, []);

  const act = async (camp, action) => {
    try {
      await api.post(`/contacts/drips/${camp._id}/${action}`);
      toast.success(action === 'start' ? 'Goteo en marcha' : 'Campaña pausada');
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    }
  };

  const remove = async (camp) => {
    if (!window.confirm(`¿Eliminar la campaña "${camp.name}"?`)) return;
    try {
      await api.delete(`/contacts/drips/${camp._id}`);
      toast.success('Campaña eliminada');
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al eliminar');
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
        <p className="text-xs text-slate-500 max-w-2xl">
          El goteo manda el mensaje en tandas pequeñas y espaciadas, dentro de un horario. Es lo que
          evita que una ráfaga tumbe el número por QR o rebote contra el límite de Meta.
        </p>
        <button
          onClick={() => setEditing(null)}
          className="px-3 py-1.5 text-sm bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 hover:bg-emerald-700 flex items-center gap-1 border-none cursor-pointer whitespace-nowrap"
        >
          <HiOutlinePlus className="w-4 h-4" /> Nueva campaña
        </button>
      </div>

      {loading ? (
        <div className="bg-white border border-slate-200 rounded-xl py-12 text-center text-sm text-slate-400">Cargando…</div>
      ) : list.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl py-12 text-center text-sm text-slate-400">
          Aún no hay campañas de goteo.
        </div>
      ) : (
        <div className="space-y-2">
          {list.map((c) => {
            const meta = STATUS_META[c.status] || STATUS_META.draft;
            const total = c.stats?.total || 0;
            const done = (c.stats?.sent || 0) + (c.stats?.failed || 0) + (c.stats?.skipped || 0);
            const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
            return (
              <div key={c._id} className="bg-white border border-slate-200 rounded-xl p-3.5">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-slate-700">{c.name}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${meta.chip}`}>{meta.label}</span>
                    </div>
                    <div className="text-xs text-slate-400 mt-0.5">
                      {c.group?.name ? `Grupo: ${c.group.name}` : 'Todos los contactos'}
                      {' · '}
                      {c.templateName ? `Plantilla: ${c.templateName}` : 'Texto libre'}
                      {' · '}
                      Tandas de {c.batchSize} cada {c.intervalMinutes} min, {c.hourFrom}–{c.hourTo}
                    </div>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    {c.status === 'running' ? (
                      <button
                        onClick={() => act(c, 'pause')}
                        className="px-2.5 py-1 text-xs border border-amber-200 text-amber-700 rounded-lg bg-white hover:bg-amber-50 cursor-pointer flex items-center gap-1"
                      >
                        <HiOutlinePause className="w-3.5 h-3.5" /> Pausar
                      </button>
                    ) : c.status !== 'done' ? (
                      <button
                        onClick={() => act(c, 'start')}
                        className="px-2.5 py-1 text-xs border border-emerald-200 text-emerald-700 rounded-lg bg-white hover:bg-emerald-50 cursor-pointer flex items-center gap-1"
                      >
                        <HiOutlinePlay className="w-3.5 h-3.5" /> {c.status === 'paused' ? 'Reanudar' : 'Arrancar'}
                      </button>
                    ) : null}
                    <button
                      onClick={() => setEditing(c)}
                      className="px-2.5 py-1 text-xs border border-slate-200 rounded-lg bg-white hover:bg-slate-50 cursor-pointer"
                    >
                      Ver
                    </button>
                    <button
                      onClick={() => remove(c)}
                      title="Eliminar"
                      className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg bg-transparent border-none cursor-pointer"
                    >
                      <HiOutlineTrash className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {total > 0 && (
                  <div className="mt-2.5">
                    <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                      <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-slate-400 mt-1">
                      <span>
                        Enviados {(c.stats?.sent || 0).toLocaleString('es-EC')} de {total.toLocaleString('es-EC')}
                        {c.stats?.failed > 0 && <span className="text-rose-600"> · {c.stats.failed} fallidos</span>}
                        {c.stats?.skipped > 0 && <span className="text-amber-600"> · {c.stats.skipped} omitidos</span>}
                      </span>
                      {c.status === 'running' && c.nextRunAt && (
                        <span>Próxima tanda: {fmtDateTime(c.nextRunAt)}</span>
                      )}
                    </div>
                  </div>
                )}

                {c.lastError && (
                  <div className="text-[11px] text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-2 py-1 mt-2">
                    Último error: {c.lastError}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {editing !== undefined && (
        <DripModal
          campaign={editing}
          groups={groups}
          onClose={() => setEditing(undefined)}
          onSaved={() => { setEditing(undefined); load(); }}
        />
      )}
    </div>
  );
}

// ───────────────────────── Crear / ver campaña ─────────────────────────

function DripModal({ campaign, groups, onClose, onSaved }) {
  const readOnly = !!campaign;
  const [form, setForm] = useState({
    name: campaign?.name || '',
    group: campaign?.group?._id || campaign?.group || '',
    whatsappAccount: campaign?.whatsappAccount || '',
    template: campaign?.template || '',
    templateVars: campaign?.templateVars || [],
    body: campaign?.body || '',
    batchSize: campaign?.batchSize ?? 20,
    intervalMinutes: campaign?.intervalMinutes ?? 15,
    hourFrom: campaign?.hourFrom || '09:00',
    hourTo: campaign?.hourTo || '20:00',
    days: campaign?.days || [],
  });
  const [accounts, setAccounts] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [preview, setPreview] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get('/contacts/whatsapp-accounts').then((r) => setAccounts(r.data || [])).catch(() => {});
    api.get('/message-templates').then((r) => setTemplates(r.data || [])).catch(() => {});
  }, []);

  useEffect(() => {
    if (!campaign) return;
    api.get(`/contacts/drips/${campaign._id}/preview`).then((r) => setPreview(r.data)).catch(() => {});
  }, [campaign]);

  // La cuenta elegida decide qué se puede mandar: Cloud API exige plantilla
  // aprobada (los contactos importados no tienen ventana de 24h abierta); el QR
  // no admite plantillas de Meta y manda texto libre.
  //
  // Sin número elegido el envío es AUTOMÁTICO (cada contacto por el número con el
  // que él escribió), así que puede salir por varios a la vez: si entre los
  // conectados hay uno de Cloud API, hace falta plantilla igual.
  const autoAccount = !form.whatsappAccount;
  const account = accounts.find((a) => a._id === form.whatsappAccount) || null;
  const anyCloud = accounts.some((a) => a.connectionType === 'cloud_api');
  const isCloud = autoAccount ? anyCloud : account?.connectionType === 'cloud_api';
  const approved = templates.filter((t) => t.status === 'approved');
  const selectedTpl = templates.find((t) => t._id === form.template) || null;
  const tplKeys = templateKeys(selectedTpl);

  // Al elegir plantilla se propone de dónde sale cada variable ({{nombre}} → el
  // nombre del contacto). Las que el sistema no reconoce quedan en blanco a
  // propósito: enviarían "-" a todos, y eso hay que verlo y decidirlo.
  const pickTemplate = (id) => {
    const tpl = templates.find((t) => t._id === id) || null;
    setForm((f) => ({ ...f, template: id, templateVars: tpl ? suggestVarMapping(tpl) : [] }));
  };

  const setVar = (key, patch) => {
    setForm((f) => ({
      ...f,
      templateVars: f.templateVars.map((v) => (v.key === key ? { ...v, ...patch } : v)),
    }));
  };

  const unmappedVars = tplKeys.filter((k) => !form.templateVars.find((v) => v.key === k)?.source);

  // Mismo cálculo que el backend (dripController.preview), para verlo mientras se edita.
  const perDay = (() => {
    const [fh, fm] = form.hourFrom.split(':').map(Number);
    const [th, tm] = form.hourTo.split(':').map(Number);
    const minutes = Math.max(0, (th * 60 + tm) - (fh * 60 + fm));
    const batches = Math.floor(minutes / Math.max(1, form.intervalMinutes)) + 1;
    return batches * form.batchSize;
  })();

  const groupCount = groups.find((g) => g._id === form.group)?.count ?? null;
  const estDays = groupCount && perDay > 0 ? Math.ceil(groupCount / perDay) : null;

  const save = async () => {
    if (!form.name.trim()) return toast.error('La campaña necesita un nombre');
    if (isCloud && !form.template) {
      return toast.error(
        autoAccount
          ? 'Habrá contactos que salgan por Cloud API: elige una plantilla aprobada'
          : 'Este número es de Cloud API: elige una plantilla aprobada'
      );
    }
    if (!isCloud && !form.body.trim()) return toast.error('El número es QR: escribe el texto del mensaje');
    setSaving(true);
    try {
      const r = await api.post('/contacts/drips', {
        ...form,
        group: form.group || null,
        template: form.template || null,
        whatsappAccount: form.whatsappAccount || null,
      });
      toast.success('Campaña creada. Revisa la vista previa y arráncala cuando quieras.');
      onSaved(r.data);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al crear la campaña');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={campaign ? campaign.name : 'Nueva campaña de goteo'} size="2xl">
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-5">
        <div className="space-y-4 min-w-0">
          {!readOnly && (
            <div>
              <label className="text-xs font-semibold text-slate-600 block mb-1">Nombre de la campaña *</label>
              <input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Promo julio"
                className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm"
              />
            </div>
          )}

          {/* ① A quién */}
          <Section n="1" title="A quién">
            <select
              disabled={readOnly}
              value={form.group}
              onChange={(e) => setForm((f) => ({ ...f, group: e.target.value }))}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white disabled:bg-slate-50"
            >
              <option value="">Todos los contactos</option>
              {groups.map((g) => (
                <option key={g._id} value={g._id}>
                  {g.kind === 'dynamic' ? '⚡ ' : '📌 '}{g.name} ({(g.count ?? 0).toLocaleString('es-EC')})
                </option>
              ))}
            </select>
          </Section>

          {/* ② Qué les mando */}
          <Section n="2" title="Qué les mando">
            <label className="text-[11px] text-slate-500 block mb-1">¿Desde qué número se envía?</label>
            <select
              disabled={readOnly}
              value={form.whatsappAccount}
              onChange={(e) => setForm((f) => ({ ...f, whatsappAccount: e.target.value }))}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white disabled:bg-slate-50 mb-2"
            >
              <option value="">Automático — el último número con el que habló cada contacto</option>
              {accounts.map((a) => (
                <option key={a._id} value={a._id}>
                  Siempre desde {a.label} — {a.connectionType === 'cloud_api' ? 'Cloud API' : 'QR (WhatsApp Web)'}
                </option>
              ))}
            </select>
            {autoAccount && (
              <p className="text-[10px] text-slate-500 mb-2 -mt-1">
                A cada contacto le llega por el número al que él escribió la última vez. Si nunca nos
                ha escrito, sale por el número principal.
              </p>
            )}

            {isCloud ? (
              <>
                <div className="text-[11px] text-sky-800 bg-sky-50 border border-sky-200 rounded-lg px-2.5 py-1.5 mb-2">
                  Cloud API: a un contacto sin conversación abierta solo se le puede mandar una{' '}
                  <b>plantilla aprobada</b> por Meta.
                  {autoAccount && accounts.some((a) => a.connectionType !== 'cloud_api') && (
                    <>
                      {' '}A los contactos que vengan de un número QR se les manda el texto de la
                      plantilla como mensaje normal, y ese <b>no te lo cobra Meta</b>.
                    </>
                  )}
                </div>
                <select
                  disabled={readOnly}
                  value={form.template}
                  onChange={(e) => pickTemplate(e.target.value)}
                  className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white disabled:bg-slate-50"
                >
                  <option value="">Elige una plantilla aprobada…</option>
                  {approved.map((t) => <option key={t._id} value={t._id}>{t.name}</option>)}
                </select>
                {approved.length === 0 && (
                  <p className="text-[11px] text-amber-700 mt-1">
                    No tienes plantillas aprobadas. Créalas en Marketing → Plantillas de Mensaje y espera
                    la aprobación de Meta.
                  </p>
                )}

                {/* De dónde sale cada variable. Sin esto, Meta recibiría el ejemplo
                    de la plantilla y TODOS leerían el mismo nombre. */}
                {selectedTpl && tplKeys.length > 0 && (
                  <div className="border border-slate-200 rounded-xl p-2.5 mt-2 space-y-2">
                    <div className="text-[11px] font-semibold text-slate-600">
                      ¿De dónde sale cada dato de la plantilla?
                    </div>
                    {tplKeys.map((key) => {
                      const v = form.templateVars.find((x) => x.key === key) || { key, source: '', fixed: '' };
                      return (
                        <div key={key} className="flex items-center gap-2">
                          <code className="text-[10px] font-mono bg-slate-100 text-slate-600 px-1.5 py-1 rounded shrink-0">
                            {`{{${key}}}`}
                          </code>
                          <select
                            disabled={readOnly}
                            value={v.source}
                            onChange={(e) => setVar(key, { source: e.target.value })}
                            className={`flex-1 border rounded-lg px-2 py-1 text-xs bg-white disabled:bg-slate-50 ${
                              v.source ? 'border-slate-200' : 'border-amber-300 bg-amber-50'
                            }`}
                          >
                            <option value="">Elige el origen…</option>
                            {VAR_SOURCES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                          </select>
                          {v.source === 'fixed' && (
                            <input
                              disabled={readOnly}
                              value={v.fixed}
                              onChange={(e) => setVar(key, { fixed: e.target.value })}
                              placeholder="JULIO20"
                              className="w-24 border border-slate-200 rounded-lg px-2 py-1 text-xs disabled:bg-slate-50"
                            />
                          )}
                        </div>
                      );
                    })}

                    {unmappedVars.length > 0 && (
                      <p className="text-[10px] text-amber-800">
                        Sin origen, {unmappedVars.map((k) => `{{${k}}}`).join(', ')} se enviará como
                        “-” a todos los contactos.
                      </p>
                    )}

                    <div className="bg-[#d9fdd3] rounded-lg px-2.5 py-1.5 text-[11px] text-slate-800">
                      <div className="text-[9px] text-slate-500 mb-0.5">Así lo recibiría Emily Torres:</div>
                      {previewBody(selectedTpl, form.templateVars, {
                        firstName: 'Emily', lastName: 'Torres', phone: '593999111222',
                      })}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 mb-2">
                  El número QR <b>no admite plantillas de Meta</b>: se manda el texto que escribas aquí.
                </div>
                <textarea
                  disabled={readOnly}
                  value={form.body}
                  onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
                  rows={4}
                  placeholder="Hola {{nombre}}, en julio tenemos…"
                  className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm disabled:bg-slate-50"
                />
                <p className="text-[10px] text-slate-400 mt-1">
                  Variables: <code className="font-mono bg-slate-100 px-1 rounded">{'{{nombre}}'}</code>{' '}
                  <code className="font-mono bg-slate-100 px-1 rounded">{'{{nombre_completo}}'}</code>
                </p>
              </>
            )}
          </Section>

          {/* ③ A qué ritmo */}
          <Section n="3" title="A qué ritmo (el goteo)">
            <div className="flex items-center gap-1.5 flex-wrap text-sm text-slate-600">
              <span>Enviar tandas de</span>
              <input
                type="number"
                min={1}
                max={500}
                disabled={readOnly}
                value={form.batchSize}
                onChange={(e) => setForm((f) => ({ ...f, batchSize: Math.max(1, Number(e.target.value) || 1) }))}
                className="w-16 border border-slate-200 rounded-lg px-2 py-1 text-sm disabled:bg-slate-50"
              />
              <span>mensajes, cada</span>
              <input
                type="number"
                min={1}
                disabled={readOnly}
                value={form.intervalMinutes}
                onChange={(e) => setForm((f) => ({ ...f, intervalMinutes: Math.max(1, Number(e.target.value) || 1) }))}
                className="w-16 border border-slate-200 rounded-lg px-2 py-1 text-sm disabled:bg-slate-50"
              />
              <span>minutos</span>
            </div>

            <div className="flex items-center gap-1.5 flex-wrap text-sm text-slate-600 mt-2">
              <span>Entre las</span>
              <input
                type="time"
                disabled={readOnly}
                value={form.hourFrom}
                onChange={(e) => setForm((f) => ({ ...f, hourFrom: e.target.value }))}
                className="border border-slate-200 rounded-lg px-2 py-1 text-sm disabled:bg-slate-50"
              />
              <span>y las</span>
              <input
                type="time"
                disabled={readOnly}
                value={form.hourTo}
                onChange={(e) => setForm((f) => ({ ...f, hourTo: e.target.value }))}
                className="border border-slate-200 rounded-lg px-2 py-1 text-sm disabled:bg-slate-50"
              />
            </div>

            <div className="flex items-center gap-1.5 mt-2">
              <span className="text-sm text-slate-600 mr-1">Días:</span>
              {DAYS.map((d) => {
                const on = form.days.length === 0 || form.days.includes(d.v);
                return (
                  <button
                    key={d.v}
                    disabled={readOnly}
                    onClick={() => {
                      // days vacío = todos. Al tocar el primero se materializa la lista.
                      const base = form.days.length ? form.days : DAYS.map((x) => x.v);
                      const next = base.includes(d.v) ? base.filter((x) => x !== d.v) : [...base, d.v];
                      setForm((f) => ({ ...f, days: next.length === 7 ? [] : next }));
                    }}
                    className={`w-7 h-7 rounded-lg text-xs border cursor-pointer disabled:cursor-default ${
                      on ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-400 border-slate-200'
                    }`}
                  >
                    {d.l}
                  </button>
                );
              })}
            </div>
          </Section>
        </div>

        {/* Vista previa */}
        <div className="lg:sticky lg:top-2 self-start w-full">
          <div className="border border-slate-200 rounded-xl overflow-hidden">
            <div className="bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-600 border-b border-slate-200">
              Vista previa
            </div>
            <div className="p-3 space-y-1.5 text-xs">
              {preview ? (
                <>
                  <Stat label="Alcance" value={`${preview.audience.toLocaleString('es-EC')} contactos`} />
                  <Stat label="Ya enviados" value={preview.alreadySent.toLocaleString('es-EC')} />
                  <Stat label="Pendientes" value={preview.remaining.toLocaleString('es-EC')} strong />
                  <Stat label="Al día" value={`${preview.perDay.toLocaleString('es-EC')} mensajes`} />
                  <Stat label="Tardará" value={preview.estimatedDays ? `~${preview.estimatedDays} días` : '—'} strong />
                  {preview.account && (
                    <div className="text-[11px] text-slate-400 pt-1.5 border-t border-slate-100">
                      {preview.account.label} ·{' '}
                      {preview.account.connectionType === 'cloud_api' ? 'Cloud API' : 'WhatsApp Web'}
                      {preview.account.messagingLimit ? ` · ${preview.account.messagingLimit}` : ''}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <Stat label="Alcance" value={groupCount != null ? `${groupCount.toLocaleString('es-EC')} contactos` : '—'} />
                  <Stat label="Al día" value={`${perDay.toLocaleString('es-EC')} mensajes`} />
                  <Stat label="Tardará" value={estDays ? `~${estDays} días` : '—'} strong />
                  <p className="text-[10px] text-slate-400 pt-1.5 border-t border-slate-100">
                    Estimación con los números del grupo. Al guardar verás el cálculo real, que descuenta
                    bajas y contactos sin teléfono.
                  </p>
                </>
              )}
            </div>
          </div>

          {/* Avisos: el backend es la fuente de verdad; este es el aviso en vivo. */}
          {!preview && !isCloud && perDay > 200 && (
            <Warn>
              Vas a mandar ~{perDay.toLocaleString('es-EC')} mensajes al día desde un número QR. Un volumen
              así es el motivo más común de bloqueo de la sesión: baja la tanda o sube el intervalo.
            </Warn>
          )}
          {preview?.warnings?.map((w) => <Warn key={w}>{w}</Warn>)}
        </div>
      </div>

      <div className="flex justify-end gap-2 mt-5 pt-4 border-t border-slate-100">
        <button onClick={onClose} className="px-4 py-2 text-sm border border-slate-200 rounded-xl bg-white hover:bg-slate-50 cursor-pointer">
          {readOnly ? 'Cerrar' : 'Cancelar'}
        </button>
        {!readOnly && (
          <button
            disabled={saving}
            onClick={save}
            className="px-4 py-2 text-sm bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 border-none cursor-pointer disabled:opacity-50"
          >
            {saving ? 'Creando…' : 'Crear campaña'}
          </button>
        )}
      </div>
    </Modal>
  );
}

function Section({ n, title, children }) {
  return (
    <div className="border border-slate-200 rounded-xl p-3">
      <div className="text-xs font-semibold text-slate-600 mb-2 flex items-center gap-1.5">
        <span className="w-4 h-4 rounded-full bg-emerald-100 text-emerald-700 text-[10px] flex items-center justify-center">{n}</span>
        {title}
      </div>
      {children}
    </div>
  );
}

function Stat({ label, value, strong }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-slate-500">{label}</span>
      <span className={strong ? 'font-bold text-slate-800' : 'text-slate-700'}>{value}</span>
    </div>
  );
}

function Warn({ children }) {
  return (
    <div className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-2.5 py-2 mt-2 flex gap-1.5">
      <HiOutlineExclamationTriangle className="w-4 h-4 shrink-0 mt-px" />
      <span>{children}</span>
    </div>
  );
}
