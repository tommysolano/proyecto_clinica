import { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import {
  HiOutlineArrowUpTray,
  HiOutlineMagnifyingGlass,
  HiOutlinePlus,
  HiOutlineTrash,
  HiOutlinePencilSquare,
  HiOutlineNoSymbol,
  HiOutlineTag,
  HiOutlineFolderPlus,
  HiOutlineCheckBadge,
} from 'react-icons/hi2';
import api from '../../api/axios';
import Modal from '../Modal';
import ImportWizard from './ImportWizard';
import { formatPhone, contactName } from '../../utils/phone';

const SOURCE_LABEL = {
  import: 'Importado',
  chat: 'Chat',
  manual: 'Manual',
  patient: 'Paciente',
  ad: 'Anuncio',
};

const EMPTY_FILTERS = {
  q: '',
  tags: [],
  sources: [],
  groups: [],
  optIn: '',
  isPatient: '',
  importBatch: '',
};

/** Los filtros viajan al backend como querystring: arrays en "a,b". */
function toParams(f, page) {
  const p = { page };
  if (f.q.trim()) p.q = f.q.trim();
  if (f.tags.length) p.tags = f.tags.join(',');
  if (f.sources.length) p.sources = f.sources.join(',');
  if (f.groups.length) p.groups = f.groups.join(',');
  if (f.optIn) p.optIn = f.optIn;
  if (f.isPatient) p.isPatient = f.isPatient;
  if (f.importBatch) p.importBatch = f.importBatch;
  return p;
}

export default function ContactsTab({ groups, onGroupsChanged }) {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [debouncedQ, setDebouncedQ] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ items: [], total: 0, pages: 1 });
  const [loading, setLoading] = useState(true);
  const [allTags, setAllTags] = useState([]);

  // Selección. `selectAll` = "todo lo que casa con el filtro", no solo la página.
  const [selected, setSelected] = useState(() => new Set());
  const [selectAll, setSelectAll] = useState(false);

  const [wizardOpen, setWizardOpen] = useState(false);
  const [editing, setEditing] = useState(undefined); // undefined = cerrado, null = nuevo
  const [bulkAction, setBulkAction] = useState(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(filters.q), 350);
    return () => clearTimeout(t);
  }, [filters.q]);

  const effective = useMemo(() => ({ ...filters, q: debouncedQ }), [filters, debouncedQ]);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const r = await api.get('/contacts', { params: toParams(effective, page) });
      setData(r.data || { items: [], total: 0, pages: 1 });
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al cargar contactos');
    } finally {
      setLoading(false);
    }
  }, [effective, page]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    api.get('/contacts/tags').then((r) => setAllTags(r.data || [])).catch(() => {});
  }, []);

  // Cambiar el filtro invalida la selección: "los 1.240 del filtro" ya no son los mismos.
  useEffect(() => {
    setSelected(new Set());
    setSelectAll(false);
    setPage(1);
  }, [effective]);

  const toggle = (id) => {
    setSelectAll(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const togglePage = () => {
    const ids = data.items.map((c) => c._id);
    const allOn = ids.every((id) => selected.has(id));
    setSelectAll(false);
    setSelected((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => (allOn ? next.delete(id) : next.add(id)));
      return next;
    });
  };

  const affected = selectAll ? data.total : selected.size;

  const runBulk = async (action, payload = {}) => {
    // O la selección explícita, o el filtro entero. Nunca las dos cosas.
    const body = selectAll
      ? { action, ...payload, filters: toParams(effective, 1) }
      : { action, ...payload, ids: [...selected] };
    try {
      const r = await api.post('/contacts/bulk', body);
      const n = r.data.deleted ?? r.data.modified ?? 0;
      toast.success(`${n} contacto${n === 1 ? '' : 's'} actualizado${n === 1 ? '' : 's'}`);
      setSelected(new Set());
      setSelectAll(false);
      setBulkAction(null);
      load();
      if (action === 'addGroup' || action === 'removeGroup') onGroupsChanged?.();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error en la acción masiva');
    }
  };

  const activeFilterCount =
    (filters.tags.length ? 1 : 0) + (filters.sources.length ? 1 : 0) + (filters.groups.length ? 1 : 0) +
    (filters.optIn ? 1 : 0) + (filters.isPatient ? 1 : 0) + (filters.importBatch ? 1 : 0);

  return (
    <div>
      <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
        <div className="text-sm text-slate-500">
          {loading ? 'Cargando…' : <><b className="text-slate-700">{data.total.toLocaleString('es-EC')}</b> contactos</>}
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setWizardOpen(true)}
            className="px-3 py-1.5 text-sm border border-emerald-200 text-emerald-700 bg-white rounded-xl hover:bg-emerald-50 flex items-center gap-1 cursor-pointer"
          >
            <HiOutlineArrowUpTray className="w-4 h-4" /> Importar Excel
          </button>
          <button
            onClick={() => setEditing(null)}
            className="px-3 py-1.5 text-sm bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 hover:bg-emerald-700 flex items-center gap-1 border-none cursor-pointer"
          >
            <HiOutlinePlus className="w-4 h-4" /> Nuevo contacto
          </button>
        </div>
      </div>

      {/* Filtros */}
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <div className="relative">
          <HiOutlineMagnifyingGlass className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 w-4 h-4" />
          <input
            value={filters.q}
            onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
            placeholder="Buscar nombre o teléfono..."
            className="w-64 pl-8 pr-3 py-1.5 text-sm border border-slate-200 rounded-lg bg-white"
          />
        </div>

        <select
          value={filters.sources[0] || ''}
          onChange={(e) => setFilters((f) => ({ ...f, sources: e.target.value ? [e.target.value] : [] }))}
          className="text-sm border border-slate-200 rounded-lg px-2 py-1.5 bg-white"
        >
          <option value="">Origen: todos</option>
          {Object.entries(SOURCE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>

        <select
          value={filters.groups[0] || ''}
          onChange={(e) => setFilters((f) => ({ ...f, groups: e.target.value ? [e.target.value] : [] }))}
          className="text-sm border border-slate-200 rounded-lg px-2 py-1.5 bg-white"
        >
          <option value="">Grupo: todos</option>
          {groups.map((g) => (
            <option key={g._id} value={g._id}>{g.kind === 'dynamic' ? '⚡ ' : '📌 '}{g.name}</option>
          ))}
        </select>

        <select
          value={filters.optIn}
          onChange={(e) => setFilters((f) => ({ ...f, optIn: e.target.value }))}
          className="text-sm border border-slate-200 rounded-lg px-2 py-1.5 bg-white"
        >
          <option value="">Consentimiento: da igual</option>
          <option value="yes">Con permiso</option>
          <option value="no">Dado de baja</option>
        </select>

        <select
          value={filters.isPatient}
          onChange={(e) => setFilters((f) => ({ ...f, isPatient: e.target.value }))}
          className="text-sm border border-slate-200 rounded-lg px-2 py-1.5 bg-white"
        >
          <option value="">¿Paciente?: da igual</option>
          <option value="yes">Ya es paciente</option>
          <option value="no">Todavía no</option>
        </select>

        <select
          value={filters.tags[0] || ''}
          onChange={(e) => setFilters((f) => ({ ...f, tags: e.target.value ? [e.target.value] : [] }))}
          className="text-sm border border-slate-200 rounded-lg px-2 py-1.5 bg-white max-w-[180px]"
        >
          <option value="">Etiqueta: todas</option>
          {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>

        {activeFilterCount > 0 && (
          <button
            onClick={() => setFilters((f) => ({ ...EMPTY_FILTERS, q: f.q }))}
            className="text-xs text-slate-500 hover:text-slate-700 underline bg-transparent border-none cursor-pointer"
          >
            Limpiar filtros
          </button>
        )}
      </div>

      {/* Barra de acciones masivas: lo que hace usable una lista de 47k. */}
      {affected > 0 && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2 mb-3 flex items-center gap-2 flex-wrap">
          <span className="text-sm text-emerald-900 font-semibold">
            {affected.toLocaleString('es-EC')} seleccionado{affected === 1 ? '' : 's'}
          </span>
          {!selectAll && selected.size < data.total && (
            <button
              onClick={() => setSelectAll(true)}
              className="text-xs text-emerald-700 underline bg-transparent border-none cursor-pointer"
            >
              Seleccionar los {data.total.toLocaleString('es-EC')} que coinciden con el filtro
            </button>
          )}
          {selectAll && (
            <button
              onClick={() => { setSelectAll(false); setSelected(new Set()); }}
              className="text-xs text-emerald-700 underline bg-transparent border-none cursor-pointer"
            >
              Quitar selección
            </button>
          )}
          <div className="flex-1" />
          <button onClick={() => setBulkAction('tag')} className="px-2.5 py-1 text-xs bg-white border border-emerald-200 rounded-lg hover:bg-emerald-50 cursor-pointer flex items-center gap-1">
            <HiOutlineTag className="w-3.5 h-3.5" /> Etiquetar
          </button>
          <button onClick={() => setBulkAction('untag')} className="px-2.5 py-1 text-xs bg-white border border-emerald-200 rounded-lg hover:bg-emerald-50 cursor-pointer">
            Quitar etiqueta
          </button>
          <button onClick={() => setBulkAction('addGroup')} className="px-2.5 py-1 text-xs bg-white border border-emerald-200 rounded-lg hover:bg-emerald-50 cursor-pointer flex items-center gap-1">
            <HiOutlineFolderPlus className="w-3.5 h-3.5" /> Añadir a grupo
          </button>
          <button
            onClick={() => {
              if (window.confirm(`¿Dar de baja de marketing a ${affected} contacto(s)? Dejarán de recibir campañas.`)) runBulk('optOut');
            }}
            className="px-2.5 py-1 text-xs bg-white border border-amber-200 text-amber-700 rounded-lg hover:bg-amber-50 cursor-pointer flex items-center gap-1"
          >
            <HiOutlineNoSymbol className="w-3.5 h-3.5" /> Dar de baja
          </button>
          <button
            onClick={() => {
              if (window.confirm(`¿Borrar ${affected} contacto(s)? Esto no se puede deshacer.`)) runBulk('delete');
            }}
            className="px-2.5 py-1 text-xs bg-white border border-rose-200 text-rose-700 rounded-lg hover:bg-rose-50 cursor-pointer flex items-center gap-1"
          >
            <HiOutlineTrash className="w-3.5 h-3.5" /> Borrar
          </button>
        </div>
      )}

      {/* Tabla */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 text-left text-xs text-slate-500 uppercase tracking-wide">
                <th className="px-3 py-2.5 w-8">
                  <input
                    type="checkbox"
                    className="cursor-pointer"
                    checked={data.items.length > 0 && data.items.every((c) => selected.has(c._id))}
                    onChange={togglePage}
                  />
                </th>
                <th className="px-3 py-2.5 font-semibold">Nombre</th>
                <th className="px-3 py-2.5 font-semibold">Teléfono</th>
                <th className="px-3 py-2.5 font-semibold">Etiquetas</th>
                <th className="px-3 py-2.5 font-semibold">Origen</th>
                <th className="px-3 py-2.5 font-semibold">Paciente</th>
                <th className="px-3 py-2.5 font-semibold text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="px-4 py-10 text-center text-slate-400">Cargando…</td></tr>
              ) : data.items.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-slate-400 text-sm">
                    {data.total === 0 && activeFilterCount === 0 && !debouncedQ ? (
                      <>
                        Aún no hay contactos.{' '}
                        <button onClick={() => setWizardOpen(true)} className="text-emerald-700 underline bg-transparent border-none cursor-pointer">
                          Importa tu Excel
                        </button>{' '}
                        para empezar.
                      </>
                    ) : (
                      'Sin resultados para el filtro actual.'
                    )}
                  </td>
                </tr>
              ) : (
                data.items.map((c) => (
                  <tr key={c._id} className="border-t border-slate-100 hover:bg-slate-50/60">
                    <td className="px-3 py-2.5">
                      <input type="checkbox" className="cursor-pointer" checked={selectAll || selected.has(c._id)} onChange={() => toggle(c._id)} />
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="font-semibold text-slate-700">{contactName(c)}</div>
                      {c.email && <div className="text-[11px] text-slate-400">{c.email}</div>}
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap font-mono text-xs text-slate-600">
                      {formatPhone(c.phone)}
                      {c.marketing?.optOutAt && (
                        <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700">baja</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex gap-1 flex-wrap">
                        {(c.tags || []).slice(0, 3).map((t) => (
                          <span key={t} className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-600">{t}</span>
                        ))}
                        {(c.tags || []).length > 3 && <span className="text-[10px] text-slate-400">+{c.tags.length - 3}</span>}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-slate-500">{SOURCE_LABEL[c.source] || c.source}</td>
                    <td className="px-3 py-2.5 text-xs">
                      {c.patient ? (
                        <span className="inline-flex items-center gap-1 text-emerald-700">
                          <HiOutlineCheckBadge className="w-4 h-4" /> ficha
                        </span>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      <button
                        onClick={() => setEditing(c)}
                        title="Editar"
                        className="p-1.5 text-slate-500 hover:text-emerald-700 hover:bg-emerald-50 rounded-lg bg-transparent border-none cursor-pointer"
                      >
                        <HiOutlinePencilSquare className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {data.pages > 1 && (
          <div className="flex items-center justify-between px-4 py-2.5 border-t border-slate-100 text-xs text-slate-500">
            <span>Página {data.page} de {data.pages}</span>
            <div className="flex gap-1">
              <button
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
                className="px-2.5 py-1 border border-slate-200 rounded-lg bg-white hover:bg-slate-50 cursor-pointer disabled:opacity-40 disabled:cursor-default"
              >
                ◂ Anterior
              </button>
              <button
                disabled={page >= data.pages}
                onClick={() => setPage((p) => p + 1)}
                className="px-2.5 py-1 border border-slate-200 rounded-lg bg-white hover:bg-slate-50 cursor-pointer disabled:opacity-40 disabled:cursor-default"
              >
                Siguiente ▸
              </button>
            </div>
          </div>
        )}
      </div>

      {wizardOpen && (
        <ImportWizard
          groups={groups}
          onClose={() => setWizardOpen(false)}
          onDone={() => { setWizardOpen(false); load(); onGroupsChanged?.(); }}
        />
      )}

      {editing !== undefined && (
        <ContactModal
          contact={editing}
          onClose={() => setEditing(undefined)}
          onSaved={() => { setEditing(undefined); load(); }}
        />
      )}

      {bulkAction && (
        <BulkModal
          action={bulkAction}
          count={affected}
          groups={groups}
          allTags={allTags}
          onClose={() => setBulkAction(null)}
          onRun={runBulk}
        />
      )}
    </div>
  );
}

// ───────────────────────── Crear / editar contacto ─────────────────────────

function ContactModal({ contact, onClose, onSaved }) {
  const [form, setForm] = useState({
    phone: contact?.phone || '',
    firstName: contact?.firstName || '',
    lastName: contact?.lastName || '',
    email: contact?.email || '',
    notes: contact?.notes || '',
    tags: (contact?.tags || []).join(', '),
  });
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!form.phone.trim()) return toast.error('El teléfono es obligatorio: es lo que identifica al contacto');
    setSaving(true);
    try {
      const payload = {
        phone: form.phone.trim(),
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        email: form.email.trim(),
        notes: form.notes.trim(),
        tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
      };
      if (contact) await api.put(`/contacts/${contact._id}`, payload);
      else await api.post('/contacts', payload);
      toast.success('Guardado');
      onSaved();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  const toggleOptOut = async () => {
    const optOut = !contact.marketing?.optOutAt;
    try {
      await api.post(`/contacts/${contact._id}/opt-out`, { optOut });
      toast.success(optOut ? 'Contacto dado de baja' : 'Contacto reactivado');
      onSaved();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    }
  };

  const remove = async () => {
    if (!window.confirm('¿Borrar este contacto? Podrás restaurarlo desde la papelera de reciclaje.')) return;
    try {
      await api.delete(`/contacts/${contact._id}`);
      toast.success('Movido a la papelera de reciclaje');
      onSaved();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al borrar');
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={contact ? 'Editar contacto' : 'Nuevo contacto'} size="lg">
      <div className="space-y-3">
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">Teléfono (WhatsApp) *</label>
          <input
            value={form.phone}
            onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
            placeholder="0999111222 o +593 99 911 1222"
            className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm font-mono"
          />
          <p className="text-[10px] text-slate-400 mt-1">
            Se guarda normalizado. Si el número ya existe, el sistema te avisa en vez de duplicarlo.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-semibold text-slate-600 block mb-1">Nombres</label>
            <input
              value={form.firstName}
              onChange={(e) => setForm((f) => ({ ...f, firstName: e.target.value }))}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-slate-600 block mb-1">Apellidos</label>
            <input
              value={form.lastName}
              onChange={(e) => setForm((f) => ({ ...f, lastName: e.target.value }))}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm"
            />
          </div>
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">Correo</label>
          <input
            value={form.email}
            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">Etiquetas (separadas por coma)</label>
          <input
            value={form.tags}
            onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))}
            placeholder="feria-julio, interesado-botox"
            className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">Notas</label>
          <textarea
            value={form.notes}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            rows={3}
            className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm"
          />
        </div>

        {contact && (
          <div className="border border-slate-200 rounded-xl p-3 flex items-center justify-between gap-2 flex-wrap">
            <div className="text-xs">
              <div className="font-semibold text-slate-600">Marketing</div>
              <div className="text-slate-400">
                {contact.marketing?.optOutAt
                  ? 'Dado de baja: no recibe campañas.'
                  : 'Con permiso: puede recibir campañas.'}
                {contact.marketing?.consentSource && ` · Origen: ${contact.marketing.consentSource}`}
              </div>
            </div>
            <button
              onClick={toggleOptOut}
              className="px-2.5 py-1 text-xs border border-slate-200 rounded-lg bg-white hover:bg-slate-50 cursor-pointer"
            >
              {contact.marketing?.optOutAt ? 'Reactivar' : 'Dar de baja'}
            </button>
          </div>
        )}
      </div>

      <div className="flex justify-between gap-2 mt-5 pt-4 border-t border-slate-100">
        <div>
          {contact && (
            <button
              onClick={remove}
              className="px-3 py-2 text-sm border border-rose-200 text-rose-700 rounded-xl bg-white hover:bg-rose-50 cursor-pointer"
            >
              Borrar
            </button>
          )}
        </div>
        <div className="flex gap-2">
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
      </div>
    </Modal>
  );
}

// ───────────────────────── Acciones masivas ─────────────────────────

const BULK_TITLE = {
  tag: 'Etiquetar contactos',
  untag: 'Quitar etiqueta',
  addGroup: 'Añadir a un grupo',
};

function BulkModal({ action, count, groups, allTags, onClose, onRun }) {
  const [tags, setTags] = useState('');
  const [group, setGroup] = useState('');
  // Los grupos por filtro se calculan solos: meter gente a mano no tendría efecto.
  const staticGroups = groups.filter((g) => g.kind === 'static');

  const run = () => {
    if (action === 'addGroup') {
      if (!group) return toast.error('Elige un grupo');
      return onRun('addGroup', { group });
    }
    const list = tags.split(',').map((t) => t.trim()).filter(Boolean);
    if (!list.length) return toast.error('Escribe al menos una etiqueta');
    onRun(action, { tags: list });
  };

  return (
    <Modal isOpen onClose={onClose} title={BULK_TITLE[action]} size="md">
      <p className="text-sm text-slate-500 mb-3">
        Se aplicará a <b className="text-slate-700">{count.toLocaleString('es-EC')}</b> contacto{count === 1 ? '' : 's'}.
      </p>

      {action === 'addGroup' ? (
        <>
          <label className="text-xs font-semibold text-slate-600 block mb-1">Grupo</label>
          <select value={group} onChange={(e) => setGroup(e.target.value)} className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white">
            <option value="">Elige un grupo…</option>
            {staticGroups.map((g) => <option key={g._id} value={g._id}>{g.name}</option>)}
          </select>
          {staticGroups.length === 0 && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-2 mt-2">
              No tienes listas fijas. Créala en la pestaña Grupos: a los grupos por filtro no se les
              añade gente a mano, se calculan solos.
            </p>
          )}
        </>
      ) : (
        <>
          <label className="text-xs font-semibold text-slate-600 block mb-1">Etiquetas (separadas por coma)</label>
          <input
            list="bulk-tags"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="feria-julio, interesado-botox"
            className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm"
          />
          <datalist id="bulk-tags">
            {allTags.map((t) => <option key={t} value={t} />)}
          </datalist>
        </>
      )}

      <div className="flex justify-end gap-2 mt-5 pt-4 border-t border-slate-100">
        <button onClick={onClose} className="px-4 py-2 text-sm border border-slate-200 rounded-xl bg-white hover:bg-slate-50 cursor-pointer">
          Cancelar
        </button>
        <button onClick={run} className="px-4 py-2 text-sm bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 border-none cursor-pointer">
          Aplicar
        </button>
      </div>
    </Modal>
  );
}
