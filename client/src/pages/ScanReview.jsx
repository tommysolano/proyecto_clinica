/**
 * FICHAS POR REVISAR (/patients/scan-review).
 *
 * Los pacientes que entraron desde una ficha física escaneada traen letra
 * manuscrita transcrita. Lo que no pasó la validación se guardó igual, pero
 * MARCADO. Aquí se corrige con el PDF original al lado, que es el único modo de
 * resolver una duda: se compara contra el papel, no contra una corazonada.
 *
 * La pantalla está pensada para tandas largas (más de cien fichas), así que al
 * guardar salta sola a la siguiente pendiente y no hay que volver a la lista.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { HiOutlineDocumentSearch } from 'react-icons/hi';
import { FiAlertTriangle, FiCheck, FiExternalLink, FiChevronRight } from 'react-icons/fi';
import toast from 'react-hot-toast';
import api from '../api/axios';
import DateInput from '../components/DateInput';
import Spinner from '../components/Spinner';

const TABS = [
  { key: 'pendientes', label: 'Por revisar' },
  { key: 'revisados', label: 'Revisadas' },
  { key: 'todos', label: 'Todas' },
];

/**
 * Fecha → 'YYYY-MM-DD' para el DateInput, leyendo sus partes LOCALES.
 *
 * No se usa `toISOString()`: pasa por UTC, y con una fecha guardada a medianoche
 * UTC (las de antes de anclar al mediodía) devolvería un día distinto del que
 * muestra el resto de la aplicación, que trabaja en hora de Ecuador.
 */
const isoDeFecha = (v) => {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export default function ScanReview() {
  const [tab, setTab] = useState('pendientes');
  const [lista, setLista] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [selId, setSelId] = useState(null);

  const cargar = useCallback(async (estado) => {
    setCargando(true);
    try {
      const { data } = await api.get('/patients/scan-review', { params: { estado } });
      setLista(data);
      setSelId((prev) => (data.some((p) => p._id === prev) ? prev : data[0]?._id || null));
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudieron cargar las fichas');
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => { cargar(tab); }, [tab, cargar]);

  const seleccionado = lista.find((p) => p._id === selId) || null;

  /** Tras guardar: se quita de la lista de pendientes y salta a la siguiente. */
  const alGuardar = (id) => {
    const i = lista.findIndex((p) => p._id === id);
    const siguiente = lista[i + 1] || lista[i - 1] || null;
    if (tab === 'pendientes') {
      setLista((l) => l.filter((p) => p._id !== id));
      setSelId(siguiente?._id || null);
    } else {
      cargar(tab);
    }
  };

  const pendientes = lista.filter((p) => !p.scanImport?.revisadoAt).length;

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
          <HiOutlineDocumentSearch className="text-emerald-600" /> Fichas por revisar
        </h1>
        <p className="text-xs text-slate-500">
          Pacientes registrados desde una ficha física escaneada. Los campos marcados en ámbar se
          leyeron con dudas: compáralos con el documento de la derecha y corrígelos.
        </p>
      </div>

      <div className="flex items-center gap-1 border-b border-slate-200 mb-4">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm border-none bg-transparent cursor-pointer -mb-px border-b-2 ${
              tab === t.key
                ? 'border-b-emerald-600 text-emerald-700 font-semibold'
                : 'border-b-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {t.label}
            {t.key === 'pendientes' && tab === 'pendientes' && pendientes > 0 && (
              <span className="ml-2 px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[11px] font-semibold">
                {pendientes}
              </span>
            )}
          </button>
        ))}
      </div>

      {cargando ? (
        <div className="py-16 flex justify-center"><Spinner /></div>
      ) : !lista.length ? (
        <div className="py-16 text-center text-slate-500">
          <FiCheck className="mx-auto mb-2 text-3xl text-emerald-500" />
          <p className="text-sm">
            {tab === 'pendientes' ? 'No queda ninguna ficha por revisar.' : 'No hay fichas importadas todavía.'}
          </p>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
          <ListaFichas lista={lista} selId={selId} onSelect={setSelId} />
          {seleccionado ? (
            <Revisor key={seleccionado._id} paciente={seleccionado} onGuardado={alGuardar} />
          ) : (
            <div className="text-sm text-slate-500 p-4">Elige una ficha de la lista.</div>
          )}
        </div>
      )}
    </div>
  );
}

function ListaFichas({ lista, selId, onSelect }) {
  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden bg-white max-h-[75vh] overflow-y-auto">
      {lista.map((p) => {
        const dudas = p.scanImport?.dudas?.length || 0;
        const activo = p._id === selId;
        return (
          <button
            key={p._id}
            onClick={() => onSelect(p._id)}
            className={`w-full text-left px-3 py-2.5 border-none border-b border-b-slate-100 cursor-pointer block ${
              activo ? 'bg-emerald-50' : 'bg-transparent hover:bg-slate-50'
            }`}
          >
            <div className={`text-sm truncate ${activo ? 'font-semibold text-emerald-800' : 'text-slate-700'}`}>
              {p.firstName} {p.lastName}
            </div>
            <div className="text-[11px] text-slate-500 flex items-center gap-1.5">
              <span>{p.cedula || 'sin cédula'}</span>
              {dudas > 0 && (
                <span className="inline-flex items-center gap-0.5 text-amber-600">
                  <FiAlertTriangle size={10} /> {dudas}
                </span>
              )}
              {p.scanImport?.revisadoAt && <FiCheck className="text-emerald-500" size={12} />}
            </div>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Un campo del formulario. Si se leyó con dudas, se resalta y se muestra el original.
 *
 * `otros` son los valores que decía la FICHA FÍSICA y no coinciden con lo que el
 * sistema ya tenía (`scanImport.alternos`). No se pisó ninguno de los dos: aquí
 * se enseñan juntos y se adoptan de un clic, con el PDF al lado para decidir.
 */
function Campo({ label, name, value, onChange, duda, crudo, otros = [], tipo = 'text' }) {
  const usar = (v) => onChange({ target: { name, value: v } });
  return (
    <label className="block">
      <span className={`block text-xs mb-1 ${duda ? 'text-amber-700 font-semibold' : 'text-slate-500'}`}>
        {label}
        {duda && <FiAlertTriangle className="inline ml-1 -mt-0.5" size={11} />}
      </span>
      {tipo === 'fecha' ? (
        <DateInput
          name={name}
          value={value}
          onChange={onChange}
          className={duda ? 'border-amber-400 bg-amber-50' : ''}
        />
      ) : (
        <input
          className={`input ${duda ? 'border-amber-400 bg-amber-50' : ''}`}
          name={name}
          value={value}
          onChange={onChange}
        />
      )}
      {otros.filter((o) => String(o.valor || '').trim() !== String(value || '').trim()).map((o, i) => (
        <button
          key={`${o.valor}-${i}`}
          type="button"
          onClick={() => usar(o.valor)}
          title="Usar el valor de la ficha física"
          className="block text-[11px] text-amber-700 mt-1 underline text-left bg-transparent border-0 p-0"
        >
          En la ficha física: «{o.valor}» — usar
        </button>
      ))}
      {!otros.length && duda && crudo ? (
        <span className="block text-[11px] text-amber-700 mt-1">Se leyó: «{crudo}»</span>
      ) : !otros.length && duda ? (
        <span className="block text-[11px] text-amber-700 mt-1">No se pudo leer en la ficha.</span>
      ) : null}
    </label>
  );
}

function Revisor({ paciente, onGuardado }) {
  const [form, setForm] = useState({
    firstName: paciente.firstName || '',
    lastName: paciente.lastName || '',
    cedula: paciente.cedula || '',
    age: paciente.age ?? '',
    phone: paciente.phone || '',
    email: paciente.email || '',
    address: paciente.address || '',
    fecha: isoDeFecha(paciente.fecha),
  });
  const [guardando, setGuardando] = useState(false);
  const [pdf, setPdf] = useState(null);
  const urlRef = useRef(null);

  const dudas = new Set(paciente.scanImport?.dudas || []);
  const crudo = paciente.scanImport?.crudo || {};
  const revisado = Boolean(paciente.scanImport?.revisadoAt);
  /** Lo que decía el papel y no coincide con lo que ya tenía el paciente. */
  const otros = (campo) => (paciente.scanImport?.alternos || []).filter((a) => a.campo === campo);

  // El PDF se pide como blob (la ruta va autenticada) y se libera al cambiar de
  // ficha: con más de cien documentos, no liberar deja la memoria por los suelos.
  useEffect(() => {
    let vivo = true;
    const scan = paciente.scanImport?.scan;
    if (!scan) return undefined;
    api.get(`/scans/${scan}/download`, { params: { inline: 1 }, responseType: 'blob' })
      .then((r) => {
        if (!vivo) return;
        const url = URL.createObjectURL(new Blob([r.data], { type: 'application/pdf' }));
        urlRef.current = url;
        setPdf(url);
      })
      .catch(() => { if (vivo) setPdf(null); });
    return () => {
      vivo = false;
      if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
    };
  }, [paciente._id, paciente.scanImport?.scan]);

  const cambiar = (e) => setForm((f) => ({ ...f, [e.target.name]: e.target.value }));

  const guardar = async () => {
    setGuardando(true);
    try {
      await api.patch(`/patients/${paciente._id}/scan-review`, form);
      toast.success('Ficha revisada');
      onGuardado(paciente._id);
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudo guardar');
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <div className="border border-slate-200 rounded-xl bg-white p-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-800">
              {paciente.scanName || 'Ficha escaneada'}
            </h2>
            <p className="text-[11px] text-slate-500">
              {revisado
                ? 'Ya revisada. Puedes volver a corregirla.'
                : `${dudas.size} campo${dudas.size === 1 ? '' : 's'} por confirmar.`}
            </p>
          </div>
          <Link
            to={`/patients/${paciente._id}`}
            className="text-xs text-emerald-700 no-underline flex items-center gap-1"
          >
            Ver paciente <FiExternalLink size={12} />
          </Link>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Campo label="Nombres" name="firstName" value={form.firstName} onChange={cambiar}
            duda={dudas.has('nombres')} crudo={crudo.nombres} />
          <Campo label="Apellidos" name="lastName" value={form.lastName} onChange={cambiar}
            duda={dudas.has('apellidos')} crudo={crudo.apellidos} />
          <Campo label="Cédula" name="cedula" value={form.cedula} onChange={cambiar}
            duda={dudas.has('cedula')} crudo={crudo.cedula} otros={otros('cedula')} />
          <Campo label="Edad" name="age" value={form.age} onChange={cambiar}
            duda={dudas.has('edad')} crudo={crudo.edad} otros={otros('edad')} />
          <Campo label="Celular" name="phone" value={form.phone} onChange={cambiar}
            duda={dudas.has('celular')} crudo={crudo.celular} otros={otros('celular')} />
          <Campo label="Fecha de la ficha" name="fecha" value={form.fecha} onChange={cambiar}
            duda={dudas.has('fecha')} crudo={crudo.fecha} tipo="fecha" />
          <div className="col-span-2">
            <Campo label="Correo" name="email" value={form.email} onChange={cambiar}
              duda={dudas.has('correo')} crudo={crudo.correo} otros={otros('correo')} />
          </div>
          <div className="col-span-2">
            <Campo label="Dirección" name="address" value={form.address} onChange={cambiar}
              duda={dudas.has('direccion')} crudo={crudo.direccion} otros={otros('direccion')} />
          </div>
        </div>

        <button
          onClick={guardar}
          disabled={guardando}
          className="mt-4 w-full px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold border-none cursor-pointer hover:bg-emerald-700 disabled:opacity-60 flex items-center justify-center gap-1.5"
        >
          {guardando ? 'Guardando…' : <>Guardar y pasar a la siguiente <FiChevronRight size={14} /></>}
        </button>
        <p className="text-[11px] text-slate-400 mt-2 text-center">
          La corrección se aplica al paciente y a su ficha clínica.
        </p>
      </div>

      <div className="border border-slate-200 rounded-xl bg-slate-50 overflow-hidden">
        {pdf ? (
          <iframe title="Ficha escaneada" src={pdf} className="w-full border-none" style={{ height: '75vh' }} />
        ) : (
          <div className="h-full min-h-[300px] flex items-center justify-center text-sm text-slate-400">
            No se pudo cargar el documento escaneado.
          </div>
        )}
      </div>
    </div>
  );
}
