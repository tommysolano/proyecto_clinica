import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { HiOutlinePlus, HiOutlinePencilSquare, HiOutlineTrash, HiOutlineBolt, HiOutlineBookmark } from 'react-icons/hi2';
import api from '../../api/axios';
import Modal from '../Modal';
import { contactName } from '../../utils/phone';
import DateInput from '../DateInput';

const SOURCE_LABEL = {
  import: 'Importado',
  chat: 'Chat',
  manual: 'Manual',
  patient: 'Paciente',
  ad: 'Anuncio',
};

const EMPTY_FILTERS = {
  tags: [],
  anyTags: [],
  sources: [],
  whatsappOptIn: '',
  isPatient: '',
  createdFrom: null,
  createdTo: null,
};

export default function GroupsTab({ groups, onGroupsChanged }) {
  const [editing, setEditing] = useState(undefined); // undefined = cerrado, null = nuevo

  const remove = async (g) => {
    if (!window.confirm(`¿Eliminar el grupo "${g.name}"? Los contactos NO se borran, solo dejan de pertenecer al grupo.`)) return;
    try {
      await api.delete(`/contacts/groups/${g._id}`);
      toast.success('Grupo eliminado');
      onGroupsChanged();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al eliminar');
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
        <p className="text-xs text-slate-500 max-w-2xl">
          Una <b>lista fija</b> se llena a mano o al importar. Un <b>grupo por filtro</b> se recalcula solo:
          si entra alguien que cumple las condiciones, aparece; si un contacto agenda y se vuelve paciente,
          sale. Ese es el que quieres para “leads por convertir”.
        </p>
        <button
          onClick={() => setEditing(null)}
          className="px-3 py-1.5 text-sm bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 hover:bg-emerald-700 flex items-center gap-1 border-none cursor-pointer whitespace-nowrap"
        >
          <HiOutlinePlus className="w-4 h-4" /> Nuevo grupo
        </button>
      </div>

      {groups.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl py-12 text-center text-sm text-slate-400">
          Aún no hay grupos. Crea el primero para poder enviar campañas segmentadas.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {groups.map((g) => (
            <div key={g._id} className="bg-white border border-slate-200 rounded-xl p-3.5 hover:border-emerald-200 transition-colors">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold text-slate-700 truncate">{g.name}</div>
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded-full inline-flex items-center gap-1 mt-0.5 ${
                      g.kind === 'dynamic' ? 'bg-violet-100 text-violet-700' : 'bg-sky-100 text-sky-700'
                    }`}
                  >
                    {g.kind === 'dynamic' ? <><HiOutlineBolt className="w-3 h-3" /> Por filtro</> : <><HiOutlineBookmark className="w-3 h-3" /> Lista fija</>}
                  </span>
                </div>
                <div className="flex gap-0.5 shrink-0">
                  <button
                    onClick={() => setEditing(g)}
                    title="Editar"
                    className="p-1.5 text-slate-400 hover:text-emerald-700 hover:bg-emerald-50 rounded-lg bg-transparent border-none cursor-pointer"
                  >
                    <HiOutlinePencilSquare className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => remove(g)}
                    title="Eliminar"
                    className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg bg-transparent border-none cursor-pointer"
                  >
                    <HiOutlineTrash className="w-4 h-4" />
                  </button>
                </div>
              </div>
              {g.description && <p className="text-xs text-slate-400 mt-1.5 line-clamp-2">{g.description}</p>}
              <div className="text-2xl font-bold text-slate-800 mt-2">
                {(g.count ?? 0).toLocaleString('es-EC')}
                <span className="text-xs font-normal text-slate-400 ml-1">contactos</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing !== undefined && (
        <GroupModal
          group={editing}
          onClose={() => setEditing(undefined)}
          onSaved={() => { setEditing(undefined); onGroupsChanged(); }}
        />
      )}
    </div>
  );
}

// ───────────────────────── Crear / editar grupo ─────────────────────────

function GroupModal({ group, onClose, onSaved }) {
  const isNew = !group;
  const [form, setForm] = useState({
    name: group?.name || '',
    description: group?.description || '',
    kind: group?.kind || 'static',
    filters: { ...EMPTY_FILTERS, ...(group?.filters || {}) },
  });
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(null);
  const [allTags, setAllTags] = useState([]);

  useEffect(() => {
    api.get('/contacts/tags').then((r) => setAllTags(r.data || [])).catch(() => {});
  }, []);

  // Vista previa en vivo de un grupo YA guardado (el backend resuelve sobre lo
  // que hay en la BD, así que un grupo nuevo aún no se puede previsualizar).
  useEffect(() => {
    if (!group || group.kind !== 'dynamic') return;
    api.get(`/contacts/groups/${group._id}/preview`).then((r) => setPreview(r.data)).catch(() => {});
  }, [group]);

  const setFilter = (k, v) => setForm((f) => ({ ...f, filters: { ...f.filters, [k]: v } }));

  const save = async () => {
    if (!form.name.trim()) return toast.error('El grupo necesita un nombre');
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        description: form.description.trim(),
        kind: form.kind,
        filters: form.kind === 'dynamic' ? form.filters : {},
      };
      if (group) await api.put(`/contacts/groups/${group._id}`, payload);
      else await api.post('/contacts/groups', payload);
      toast.success('Guardado');
      onSaved();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={group ? 'Editar grupo' : 'Nuevo grupo'} size="lg">
      <div className="space-y-3">
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">Nombre *</label>
          <input
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="Leads por convertir"
            className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">Descripción</label>
          <input
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1.5">Tipo de grupo</label>
          {!isNew && (
            <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 mb-2">
              El tipo no se puede cambiar: una lista fija guarda a sus miembros y un grupo por filtro no,
              así que convertirlo lo dejaría vacío.
            </p>
          )}
          <div className="grid grid-cols-2 gap-2">
            {[
              { v: 'static', t: 'Lista fija', d: 'La llenas a mano o al importar.' },
              { v: 'dynamic', t: 'Por filtro', d: 'Se recalcula sola con condiciones.' },
            ].map((o) => (
              <label
                key={o.v}
                className={`border rounded-xl px-3 py-2 ${!isNew ? 'opacity-60' : 'cursor-pointer'} ${
                  form.kind === o.v ? 'border-emerald-300 bg-emerald-50/50' : 'border-slate-200'
                }`}
              >
                <input
                  type="radio"
                  name="group-kind"
                  disabled={!isNew}
                  checked={form.kind === o.v}
                  onChange={() => setForm((f) => ({ ...f, kind: o.v }))}
                  className={isNew ? 'cursor-pointer' : ''}
                />
                <span className="text-sm font-semibold text-slate-700 ml-1.5">{o.t}</span>
                <div className="text-[11px] text-slate-400 mt-0.5">{o.d}</div>
              </label>
            ))}
          </div>
        </div>

        {form.kind === 'dynamic' && (
          <div className="border border-slate-200 rounded-xl p-3 space-y-3">
            <div className="text-xs font-semibold text-slate-600">Condiciones (se combinan con Y)</div>

            <div>
              <label className="text-[11px] text-slate-500 block mb-1">Tiene TODAS estas etiquetas</label>
              <TagInput value={form.filters.tags} onChange={(v) => setFilter('tags', v)} allTags={allTags} />
            </div>
            <div>
              <label className="text-[11px] text-slate-500 block mb-1">…o ALGUNA de estas</label>
              <TagInput value={form.filters.anyTags} onChange={(v) => setFilter('anyTags', v)} allTags={allTags} />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div>
                <label className="text-[11px] text-slate-500 block mb-1">Origen</label>
                <select
                  value={form.filters.sources[0] || ''}
                  onChange={(e) => setFilter('sources', e.target.value ? [e.target.value] : [])}
                  className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs bg-white"
                >
                  <option value="">Todos</option>
                  {Object.entries(SOURCE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              <div>
                <label className="text-[11px] text-slate-500 block mb-1">Consentimiento</label>
                <select
                  value={form.filters.whatsappOptIn}
                  onChange={(e) => setFilter('whatsappOptIn', e.target.value)}
                  className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs bg-white"
                >
                  <option value="">Da igual</option>
                  <option value="yes">Solo con permiso</option>
                  <option value="no">Solo dados de baja</option>
                </select>
              </div>
              <div>
                <label className="text-[11px] text-slate-500 block mb-1">¿Ya es paciente?</label>
                <select
                  value={form.filters.isPatient}
                  onChange={(e) => setFilter('isPatient', e.target.value)}
                  className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs bg-white"
                >
                  <option value="">Da igual</option>
                  <option value="yes">Ya es paciente</option>
                  <option value="no">Todavía no</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[11px] text-slate-500 block mb-1">Creados desde</label>
                <DateInput
                  value={(form.filters.createdFrom || '').slice(0, 10)}
                  onChange={(e) => setFilter('createdFrom', e.target.value || null)}
                  className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs"
                />
              </div>
              <div>
                <label className="text-[11px] text-slate-500 block mb-1">…hasta</label>
                <DateInput
                  value={(form.filters.createdTo || '').slice(0, 10)}
                  onChange={(e) => setFilter('createdTo', e.target.value || null)}
                  className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs"
                />
              </div>
            </div>

            {preview ? (
              <div className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs">
                <div className="text-slate-700">
                  <b>{preview.total.toLocaleString('es-EC')}</b> contactos ·{' '}
                  <b className="text-emerald-700">{preview.sendable.toLocaleString('es-EC')}</b> alcanzables ·{' '}
                  <span className="text-slate-400">{preview.excluded.toLocaleString('es-EC')} fuera</span>
                </div>
                {preview.sample?.length > 0 && (
                  <div className="text-slate-400 mt-1 truncate">
                    {preview.sample.map((c) => contactName(c)).join(' · ')}
                  </div>
                )}
                <p className="text-[10px] text-slate-400 mt-1">
                  El número que manda al enviar es <b>alcanzables</b>: descuenta bajas y sin teléfono.
                  Se actualiza al guardar.
                </p>
              </div>
            ) : (
              <p className="text-[10px] text-slate-400">
                Guarda el grupo para ver a cuántos alcanza.
              </p>
            )}
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2 mt-5 pt-4 border-t border-slate-100">
        <button onClick={onClose} className="px-4 py-2 text-sm border border-slate-200 rounded-xl bg-white hover:bg-slate-50 cursor-pointer">
          Cancelar
        </button>
        <button
          disabled={saving}
          onClick={save}
          className="px-4 py-2 text-sm bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 border-none cursor-pointer disabled:opacity-50"
        >
          {saving ? 'Guardando…' : 'Guardar'}
        </button>
      </div>
    </Modal>
  );
}

/** Entrada de etiquetas en chips. */
function TagInput({ value, onChange, allTags }) {
  const [draft, setDraft] = useState('');
  const add = (t) => {
    const tag = t.trim();
    if (!tag || value.includes(tag)) return setDraft('');
    onChange([...value, tag]);
    setDraft('');
  };
  return (
    <div className="border border-slate-200 rounded-lg px-2 py-1.5 flex flex-wrap gap-1 items-center bg-white">
      {value.map((t) => (
        <span key={t} className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 flex items-center gap-1">
          {t}
          <button
            onClick={() => onChange(value.filter((x) => x !== t))}
            className="bg-transparent border-none cursor-pointer text-emerald-700 p-0 leading-none"
          >
            ×
          </button>
        </span>
      ))}
      <input
        list="group-tags"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(draft); }
          if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={() => add(draft)}
        placeholder={value.length ? '' : 'escribe y pulsa Enter'}
        className="flex-1 min-w-[100px] text-xs border-none outline-none py-0.5"
      />
      <datalist id="group-tags">
        {allTags.map((t) => <option key={t} value={t} />)}
      </datalist>
    </div>
  );
}
