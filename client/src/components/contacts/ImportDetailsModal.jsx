import { useEffect, useMemo, useState } from 'react';
import {
  HiOutlineArrowTopRightOnSquare,
  HiOutlineChevronLeft,
  HiOutlineChevronRight,
  HiOutlineExclamationTriangle,
  HiOutlineMagnifyingGlass,
} from 'react-icons/hi2';
import api from '../../api/axios';
import Modal from '../Modal';
import useDebounce from '../../hooks/useDebounce';
import { formatPhone } from '../../utils/phone';

const OUTCOMES = {
  created: { label: 'Creados', singular: 'Creado', chip: 'bg-emerald-100 text-emerald-700' },
  updated: { label: 'Actualizados', singular: 'Actualizado', chip: 'bg-sky-100 text-sky-700' },
  skipped: { label: 'Omitidos', singular: 'Omitido', chip: 'bg-amber-100 text-amber-700' },
  failed: { label: 'Fallidos', singular: 'Fallido', chip: 'bg-rose-100 text-rose-700' },
};

function nameOf(item) {
  return item.displayName
    || `${item.firstName || ''} ${item.lastName || ''}`.trim()
    || item.value
    || 'Sin nombre';
}

function phoneOf(item) {
  const phone = item.phone || item.value || '';
  return /^\+?\d{8,15}$/.test(String(phone).replace(/\s/g, '')) ? formatPhone(phone) : phone;
}

/**
 * Teléfono con el que se puede abrir el chat de esta fila, o '' si no hay.
 *
 * La normalización de verdad la hace el servidor al abrir la conversación
 * (utils/phoneNormalize.js); aquí solo se descarta lo que claramente no es un
 * número, porque una fila fallida trae el valor tal cual venía en el Excel.
 */
function chatPhoneOf(item) {
  const raw = String(item.phone || item.value || '').replace(/[\s()-]/g, '');
  return /^\+?\d{8,15}$/.test(raw) ? raw : '';
}

/**
 * Abre el chat del contacto en una pestaña nueva. Va por teléfono: la
 * conversación se identifica por el número, así que si ya existe se abre esa
 * misma y si no, /chats la crea al llegar (ver el enlace directo en Chats.jsx).
 */
function openChatTab(item) {
  const phone = chatPhoneOf(item);
  if (!phone) return;
  const params = new URLSearchParams({ phone });
  const name = nameOf(item);
  // El nombre solo sirve para bautizar un chat que aún no existe; si lo único
  // que hay es el propio número, no aporta nada.
  if (name && name !== 'Sin nombre' && name.replace(/[\s()-]/g, '') !== phone) params.set('name', name);
  window.open(`/chats?${params.toString()}`, '_blank', 'noopener');
}

export default function ImportDetailsModal({ batch, initialOutcome = '', onClose }) {
  const [outcome, setOutcome] = useState(initialOutcome);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const debouncedSearch = useDebounce(search, 300);

  const changeOutcome = (nextOutcome) => {
    setOutcome(nextOutcome);
    setPage(1);
    setLoading(true);
    setError('');
  };

  const changeSearch = (value) => {
    setSearch(value);
    setPage(1);
    setLoading(true);
    setError('');
  };

  const changePage = (nextPage) => {
    setPage(nextPage);
    setLoading(true);
    setError('');
  };

  useEffect(() => {
    if (!batch?._id) return undefined;
    let active = true;
    api.get(`/contacts/imports/${batch._id}/rows`, {
      params: { outcome: outcome || undefined, q: debouncedSearch || undefined, page, limit: 50 },
    })
      .then((response) => { if (active) setData(response.data); })
      .catch((err) => {
        if (active) setError(err.response?.data?.message || 'No se pudo cargar el detalle');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [batch?._id, outcome, debouncedSearch, page]);

  const summary = useMemo(() => data?.summary || ({
    created: batch?.created || 0,
    updated: batch?.updated || 0,
    skipped: batch?.skipped || 0,
    failed: batch?.failed || 0,
  }), [data?.summary, batch?.created, batch?.updated, batch?.skipped, batch?.failed]);
  const totalOutcomes = useMemo(
    () => Object.values(summary).reduce((sum, value) => sum + Number(value || 0), 0),
    [summary]
  );

  return (
    <Modal
      isOpen={!!batch}
      onClose={onClose}
      title={`Detalle de importación · ${batch?.fileName || ''}`}
      size="2xl"
    >
      <div className="grid gap-4 min-w-0">
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          <TabButton active={!outcome} onClick={() => changeOutcome('')} label="Todos" value={totalOutcomes} />
          {Object.entries(OUTCOMES).map(([key, meta]) => (
            <TabButton
              key={key}
              active={outcome === key}
              onClick={() => changeOutcome(key)}
              label={meta.label}
              value={summary[key] || 0}
            />
          ))}
        </div>

        <label className="relative block">
          <HiOutlineMagnifyingGlass className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            value={search}
            onChange={(event) => changeSearch(event.target.value)}
            placeholder="Buscar por nombre, teléfono, correo o motivo…"
            className="w-full border border-slate-200 rounded-xl pl-9 pr-3 py-2 text-sm outline-none focus:border-emerald-400"
          />
        </label>

        <p className="-mt-2 text-[11px] text-slate-400">
          Haz clic en un contacto para abrir su chat en una pestaña nueva.
        </p>

        {data?.message && (
          <div className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-xs ${data.detailAvailable ? 'bg-sky-50 border-sky-200 text-sky-700' : 'bg-amber-50 border-amber-200 text-amber-800'}`}>
            <HiOutlineExclamationTriangle className="w-4 h-4 shrink-0 mt-px" />
            <span>{data.message}</span>
          </div>
        )}

        {loading ? (
          <div className="py-14 text-center text-sm text-slate-400">Cargando detalle…</div>
        ) : error ? (
          <div className="py-10 text-center text-sm text-rose-600">{error}</div>
        ) : data?.detailAvailable === false ? (
          <div className="py-10 text-center text-sm text-slate-400">
            No hay información individual disponible para este resultado histórico.
          </div>
        ) : !data?.items?.length ? (
          <div className="py-10 text-center text-sm text-slate-400">
            {debouncedSearch ? 'No hay coincidencias para esta búsqueda.' : 'No hay filas en esta categoría.'}
          </div>
        ) : (
          <div className="border border-slate-200 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-xs">
                <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2.5 w-16">Fila</th>
                    <th className="px-3 py-2.5">Contacto</th>
                    <th className="px-3 py-2.5">Teléfono / correo</th>
                    <th className="px-3 py-2.5 w-28">Resultado</th>
                    <th className="px-3 py-2.5">Detalle</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.items.map((item, index) => {
                    const meta = OUTCOMES[item.outcome] || OUTCOMES.failed;
                    // Una fila sin teléfono utilizable (un fallo de formato, una
                    // fila solo con correo) no lleva a ningún chat: se deja tal cual.
                    const abrible = !!chatPhoneOf(item);
                    return (
                      <tr
                        key={item._id || `${item.row}-${index}`}
                        onClick={abrible ? () => openChatTab(item) : undefined}
                        title={abrible ? 'Abrir el chat de este contacto en una pestaña nueva' : undefined}
                        className={`align-top ${abrible ? 'cursor-pointer hover:bg-emerald-50/60' : 'hover:bg-slate-50/60'}`}
                      >
                        <td className="px-3 py-3 text-slate-400">{item.row || '—'}</td>
                        <td className="px-3 py-3">
                          <div className={`font-semibold break-words flex items-center gap-1.5 ${abrible ? 'text-emerald-700' : 'text-slate-700'}`}>
                            <span>{nameOf(item)}</span>
                            {abrible && <HiOutlineArrowTopRightOnSquare className="w-3.5 h-3.5 shrink-0 text-emerald-500" />}
                          </div>
                        </td>
                        <td className="px-3 py-3 text-slate-600">
                          <div>{phoneOf(item) || '—'}</div>
                          {item.email && <div className="text-slate-400 break-all mt-0.5">{item.email}</div>}
                        </td>
                        <td className="px-3 py-3">
                          <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${meta.chip}`}>
                            {meta.singular}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-slate-500 break-words">{item.reason || '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {!loading && !error && data?.detailAvailable !== false && data?.total > 0 && (
          <div className="flex items-center justify-between gap-3 text-xs text-slate-500">
            <span>{Number(data.total || 0).toLocaleString('es-EC')} resultado(s)</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => changePage(Math.max(1, page - 1))}
                disabled={page <= 1}
                className="p-1.5 rounded-lg border border-slate-200 bg-white disabled:opacity-40 cursor-pointer disabled:cursor-default"
                title="Página anterior"
              >
                <HiOutlineChevronLeft className="w-4 h-4" />
              </button>
              <span>Página {data.page || page} de {data.pages || 1}</span>
              <button
                type="button"
                onClick={() => changePage(Math.min(data.pages || 1, page + 1))}
                disabled={page >= (data.pages || 1)}
                className="p-1.5 rounded-lg border border-slate-200 bg-white disabled:opacity-40 cursor-pointer disabled:cursor-default"
                title="Página siguiente"
              >
                <HiOutlineChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function TabButton({ active, onClick, label, value }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 rounded-lg border px-3 py-1.5 text-xs font-medium cursor-pointer ${active ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'}`}
    >
      {label} <b>{Number(value || 0).toLocaleString('es-EC')}</b>
    </button>
  );
}
