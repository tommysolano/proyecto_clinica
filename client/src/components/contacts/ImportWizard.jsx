import { useRef, useState } from 'react';
import toast from 'react-hot-toast';
import {
  HiOutlineArrowUpTray,
  HiOutlineArrowDownTray,
  HiOutlineDocumentText,
  HiOutlineCheckCircle,
  HiOutlineExclamationTriangle,
} from 'react-icons/hi2';
import api from '../../api/axios';
import Modal from '../Modal';

/**
 * Asistente de importación de contactos (4 pasos), como el de Daplox.
 *
 * El archivo se sube UNA vez en el paso 1 (`analyze` devuelve un uploadId y las
 * cabeceras); los pasos 2-4 solo mandan decisiones. Al confirmar, el backend
 * encola el lote y lo procesa en segundo plano: 47k filas no caben en una
 * petición HTTP.
 */
const STEPS = ['Subir archivo', 'Asignar columnas', 'Opciones', 'Confirmar'];

const MODE_OPTIONS = [
  { value: 'upsert', label: 'Crear y actualizar', hint: 'Lo normal: añade los nuevos y actualiza los que ya tengo.' },
  { value: 'create', label: 'Solo crear nuevos', hint: 'Ignora los teléfonos que ya existen, no los toca.' },
  { value: 'update', label: 'Solo actualizar', hint: 'No añade a nadie nuevo; solo completa datos de los que ya tengo.' },
];

export default function ImportWizard({ groups, onClose, onDone }) {
  const [step, setStep] = useState(0);
  const [analysis, setAnalysis] = useState(null); // respuesta de /analyze
  const [mapping, setMapping] = useState([]);
  const [opts, setOpts] = useState({
    mode: 'upsert',
    tags: '',
    groups: [],
    whatsappOptIn: true,
    consentSource: '',
  });
  const [busy, setBusy] = useState(false);

  const staticGroups = groups.filter((g) => g.kind === 'static');

  const analyze = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api.post('/contacts/imports/analyze', fd);
      setAnalysis(r.data);
      setMapping(r.data.mapping || []);
      setStep(1);
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo leer el archivo');
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setBusy(true);
    try {
      await api.post('/contacts/imports', {
        uploadId: analysis.uploadId,
        fileName: analysis.fileName,
        mapping,
        mode: opts.mode,
        tags: opts.tags.split(',').map((t) => t.trim()).filter(Boolean),
        groups: opts.groups,
        whatsappOptIn: opts.whatsappOptIn,
        consentSource: opts.consentSource.trim(),
      });
      toast.success('Importación encolada: verás el progreso en la pestaña Importaciones');
      onDone();
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo iniciar la importación');
    } finally {
      setBusy(false);
    }
  };

  const phoneMapped = mapping.some((m) => m.field === 'phone');
  const mappedCount = mapping.filter((m) => m.field).length;

  return (
    <Modal isOpen onClose={onClose} title="Importar contactos desde Excel" size="2xl">
      {/* Migas de pan */}
      <div className="flex items-center gap-1 mb-5">
        {STEPS.map((s, i) => (
          <div key={s} className="flex items-center gap-1 flex-1">
            <div
              className={`flex items-center gap-1.5 text-xs whitespace-nowrap ${
                i === step ? 'text-emerald-700 font-semibold' : i < step ? 'text-slate-500' : 'text-slate-300'
              }`}
            >
              <span
                className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] ${
                  i === step ? 'bg-emerald-600 text-white' : i < step ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-400'
                }`}
              >
                {i < step ? '✓' : i + 1}
              </span>
              {s}
            </div>
            {i < STEPS.length - 1 && <div className={`h-px flex-1 ${i < step ? 'bg-emerald-200' : 'bg-slate-100'}`} />}
          </div>
        ))}
      </div>

      {step === 0 && <StepUpload busy={busy} onFile={analyze} />}

      {step === 1 && (
        <StepMapping
          analysis={analysis}
          mapping={mapping}
          setMapping={setMapping}
        />
      )}

      {step === 2 && (
        <StepOptions opts={opts} setOpts={setOpts} staticGroups={staticGroups} />
      )}

      {step === 3 && (
        <StepConfirm analysis={analysis} mapping={mapping} opts={opts} groups={groups} mappedCount={mappedCount} />
      )}

      {/* Navegación */}
      {step > 0 && (
        <div className="flex justify-between gap-2 mt-5 pt-4 border-t border-slate-100">
          <button
            onClick={() => setStep((s) => s - 1)}
            className="px-4 py-2 text-sm border border-slate-200 rounded-xl bg-white hover:bg-slate-50 cursor-pointer"
          >
            ◂ Atrás
          </button>
          <div className="flex items-center gap-3">
            {step === 1 && !phoneMapped && (
              <span className="text-xs text-rose-600 flex items-center gap-1">
                <HiOutlineExclamationTriangle className="w-4 h-4" />
                Asigna una columna a Teléfono para continuar
              </span>
            )}
            {step < 3 ? (
              <button
                disabled={step === 1 && !phoneMapped}
                onClick={() => setStep((s) => s + 1)}
                className="px-4 py-2 text-sm bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 border-none cursor-pointer disabled:opacity-40 disabled:cursor-default"
              >
                Siguiente ▸
              </button>
            ) : (
              <button
                disabled={busy}
                onClick={confirm}
                className="px-4 py-2 text-sm bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 border-none cursor-pointer disabled:opacity-50"
              >
                {busy ? 'Encolando…' : 'Importar'}
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

// ───────────────────────── Paso 1: subir ─────────────────────────

function StepUpload({ busy, onFile }) {
  const inputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);

  const downloadTemplate = async () => {
    try {
      const r = await api.get('/contacts/imports/template', { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([r.data]));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'plantilla_contactos_shiluv.xlsx';
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('No se pudo descargar la plantilla');
    }
  };

  return (
    <div>
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          onFile(e.dataTransfer.files?.[0]);
        }}
        onClick={() => inputRef.current?.click()}
        className={`border-2 border-dashed rounded-2xl py-14 text-center cursor-pointer transition-colors ${
          dragOver ? 'border-emerald-400 bg-emerald-50' : 'border-slate-200 bg-slate-50/50 hover:bg-slate-50'
        }`}
      >
        <HiOutlineArrowUpTray className="w-9 h-9 mx-auto text-emerald-600 mb-2" />
        <div className="text-sm font-semibold text-slate-700">
          {busy ? 'Leyendo el archivo…' : 'Arrastra aquí tu archivo o haz clic para buscarlo'}
        </div>
        <div className="text-xs text-slate-400 mt-1">.csv · .xlsx · .xls — hasta 30 MB</div>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.xlsx,.xls"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; onFile(f); }}
        />
      </div>
      <div className="flex items-center justify-between gap-2 flex-wrap bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2.5 mt-3">
        <div className="text-xs text-emerald-900">
          <b>¿No sabes qué formato usar?</b> Descarga la plantilla, rellénala y súbela. También puedes
          subir cualquier Excel tuyo: en el paso siguiente dices qué columna es cada cosa.
        </div>
        <button
          type="button"
          onClick={downloadTemplate}
          className="px-3 py-1.5 text-xs border border-emerald-300 text-emerald-700 bg-white rounded-lg hover:bg-emerald-100 cursor-pointer flex items-center gap-1 whitespace-nowrap shrink-0"
        >
          <HiOutlineArrowDownTray className="w-4 h-4" /> Descargar plantilla
        </button>
      </div>

      <div className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 mt-2 space-y-1">
        <p><b>Solo el teléfono es obligatorio.</b> Nombre, apellido, correo y etiquetas son opcionales.</p>
        <p><b>La primera fila debe ser el nombre de cada columna</b> (Teléfono, Nombre, Correo…).</p>
        <p>
          Formatea la columna del teléfono como <b>texto</b> en Excel. Si la deja como número, Excel la
          convierte a notación científica (<code className="font-mono bg-white px-1 rounded">5,93991E+11</code>)
          y esas filas no se pueden importar.
        </p>
      </div>
    </div>
  );
}

// ───────────────────────── Paso 2: mapear ─────────────────────────

function StepMapping({ analysis, mapping, setMapping }) {
  const setField = (i, field) => {
    setMapping((prev) => prev.map((m, idx) => (idx === i ? { ...m, field } : m)));
  };
  const setCustomKey = (i, key) => {
    setMapping((prev) => prev.map((m, idx) => (idx === i ? { ...m, field: `custom:${key}` } : m)));
  };
  const setSkipEmpty = (i, skipEmpty) => {
    setMapping((prev) => prev.map((m, idx) => (idx === i ? { ...m, skipEmpty } : m)));
  };

  // Un campo del sistema solo puede recibir UNA columna: dos se pisarían.
  const usedFields = new Set(mapping.map((m) => m.field).filter((f) => f && !f.startsWith('custom:')));

  return (
    <div>
      <p className="text-xs text-slate-500 mb-3">
        Leí <b className="text-slate-700">{analysis.fileName}</b>. Ya propuse a qué campo va cada columna —
        revísalo y corrige lo que haga falta.
      </p>

      <div className="border border-slate-200 rounded-xl overflow-hidden">
        <div className="overflow-x-auto max-h-[45vh] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0">
              <tr className="bg-slate-50 text-left text-xs text-slate-500 uppercase tracking-wide">
                <th className="px-3 py-2.5 font-semibold">Columna del archivo</th>
                <th className="px-3 py-2.5 font-semibold">Ejemplos</th>
                <th className="px-3 py-2.5 font-semibold">Campo del sistema</th>
                <th className="px-3 py-2.5 font-semibold text-center whitespace-nowrap">Omitir vacíos</th>
              </tr>
            </thead>
            <tbody>
              {mapping.map((m, i) => {
                const isCustom = (m.field || '').startsWith('custom:');
                // `samples` viene como [{ column, values: [...] }], no como filas.
                const samples = ((analysis.samples || []).find((s) => s.column === m.column)?.values || [])
                  .filter((v) => String(v || '').trim());
                return (
                  <tr key={m.column} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-semibold text-slate-700 whitespace-nowrap">{m.column}</td>
                    <td className="px-3 py-2 text-xs text-slate-400 max-w-[220px] truncate">
                      {samples.length ? samples.slice(0, 3).join(' · ') : <span className="italic">(vacía)</span>}
                    </td>
                    <td className="px-3 py-2">
                      <select
                        value={isCustom ? 'custom' : m.field || ''}
                        onChange={(e) => (e.target.value === 'custom' ? setCustomKey(i, '') : setField(i, e.target.value))}
                        className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs bg-white"
                      >
                        <option value="">No importar</option>
                        {(analysis.fieldOptions || []).map((o) => (
                          <option
                            key={o.value}
                            value={o.value}
                            disabled={usedFields.has(o.value) && m.field !== o.value}
                          >
                            {o.label}{o.required ? ' *' : ''}
                          </option>
                        ))}
                        <option value="custom">Campo personalizado…</option>
                      </select>
                      {isCustom && (
                        <input
                          value={m.field.slice('custom:'.length)}
                          onChange={(e) => setCustomKey(i, e.target.value.trim())}
                          placeholder="clave: ciudad, interés…"
                          className="w-full border border-emerald-200 rounded-lg px-2 py-1 text-xs mt-1"
                        />
                      )}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <input
                        type="checkbox"
                        className="cursor-pointer"
                        checked={m.skipEmpty !== false}
                        onChange={(e) => setSkipEmpty(i, e.target.checked)}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-[11px] text-slate-400 mt-2">
        <b>Omitir vacíos</b> (recomendado): una celda vacía no toca el dato que ya tenías. Si lo
        desactivas, una celda vacía <b>borra</b> ese dato del contacto.
      </p>
    </div>
  );
}

// ───────────────────────── Paso 3: opciones ─────────────────────────

function StepOptions({ opts, setOpts, staticGroups }) {
  return (
    <div className="space-y-4">
      <div>
        <label className="text-xs font-semibold text-slate-600 block mb-1.5">
          ¿Qué hago con los teléfonos que ya existen?
        </label>
        <div className="space-y-1.5">
          {MODE_OPTIONS.map((o) => (
            <label
              key={o.value}
              className={`flex items-start gap-2 border rounded-xl px-3 py-2 cursor-pointer ${
                opts.mode === o.value ? 'border-emerald-300 bg-emerald-50/50' : 'border-slate-200 hover:bg-slate-50'
              }`}
            >
              <input
                type="radio"
                name="import-mode"
                checked={opts.mode === o.value}
                onChange={() => setOpts((s) => ({ ...s, mode: o.value }))}
                className="mt-0.5 cursor-pointer"
              />
              <div>
                <div className="text-sm font-semibold text-slate-700">{o.label}</div>
                <div className="text-[11px] text-slate-400">{o.hint}</div>
              </div>
            </label>
          ))}
        </div>
      </div>

      <div>
        <label className="text-xs font-semibold text-slate-600 block mb-1">Etiquetar todo lo importado</label>
        <input
          value={opts.tags}
          onChange={(e) => setOpts((s) => ({ ...s, tags: e.target.value }))}
          placeholder="feria-julio, lote-1"
          className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm"
        />
        <p className="text-[10px] text-slate-400 mt-1">
          Separadas por coma. Es lo que después te deja armar un grupo con esta gente y enviarles una campaña.
        </p>
      </div>

      <div>
        <label className="text-xs font-semibold text-slate-600 block mb-1">Añadir a una lista fija</label>
        <select
          value={opts.groups[0] || ''}
          onChange={(e) => setOpts((s) => ({ ...s, groups: e.target.value ? [e.target.value] : [] }))}
          className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white"
        >
          <option value="">Ninguna</option>
          {staticGroups.map((g) => <option key={g._id} value={g._id}>{g.name}</option>)}
        </select>
        <p className="text-[10px] text-slate-400 mt-1">
          Solo listas fijas: los grupos por filtro se calculan solos según las etiquetas y el origen.
        </p>
      </div>

      <div className="border border-slate-200 rounded-xl p-3 space-y-2">
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={opts.whatsappOptIn}
            onChange={(e) => setOpts((s) => ({ ...s, whatsappOptIn: e.target.checked }))}
            className="mt-0.5 cursor-pointer"
          />
          <div>
            <div className="text-sm font-semibold text-slate-700">Estos contactos aceptaron recibir mensajes</div>
            <div className="text-[11px] text-slate-400">
              Si lo desmarcas entran dados de baja y no recibirán campañas hasta que los reactives.
            </div>
          </div>
        </label>
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">Origen del consentimiento</label>
          <input
            value={opts.consentSource}
            onChange={(e) => setOpts((s) => ({ ...s, consentSource: e.target.value }))}
            placeholder="Feria de salud, julio 2026"
            className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm"
          />
          <p className="text-[10px] text-slate-400 mt-1">
            De dónde salió el permiso. Es tu respaldo si Meta pregunta por qué le escribes a esta gente.
          </p>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── Paso 4: confirmar ─────────────────────────

function StepConfirm({ analysis, mapping, opts, groups, mappedCount }) {
  const mode = MODE_OPTIONS.find((m) => m.value === opts.mode);
  const groupName = groups.find((g) => g._id === opts.groups[0])?.name;
  const tagList = opts.tags.split(',').map((t) => t.trim()).filter(Boolean);
  const assigned = mapping.filter((m) => m.field);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm text-slate-700 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5">
        <HiOutlineDocumentText className="w-5 h-5 text-emerald-600 shrink-0" />
        <div>
          <div className="font-semibold">{analysis.fileName}</div>
          <div className="text-xs text-slate-400">
            {(analysis.headers || []).length} columnas · {mappedCount} asignadas · {(analysis.fileSize / 1024).toFixed(0)} KB
          </div>
        </div>
      </div>

      <div className="border border-slate-200 rounded-xl divide-y divide-slate-100 text-sm">
        <Row label="Columnas asignadas">
          <div className="flex flex-wrap gap-1 justify-end">
            {assigned.map((m) => (
              <span key={m.column} className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700">
                {m.column} → {m.field.startsWith('custom:') ? m.field.slice(7) : m.field}
              </span>
            ))}
          </div>
        </Row>
        <Row label="Teléfonos que ya existen">{mode?.label}</Row>
        <Row label="Etiquetas">
          {tagList.length ? tagList.join(', ') : <span className="text-slate-300">ninguna</span>}
        </Row>
        <Row label="Lista fija">{groupName || <span className="text-slate-300">ninguna</span>}</Row>
        <Row label="Consentimiento">
          {opts.whatsappOptIn ? (
            <span className="text-emerald-700 inline-flex items-center gap-1">
              <HiOutlineCheckCircle className="w-4 h-4" /> Aceptaron recibir mensajes
            </span>
          ) : (
            <span className="text-amber-700">Entran dados de baja</span>
          )}
        </Row>
        {opts.consentSource && <Row label="Origen del permiso">{opts.consentSource}</Row>}
      </div>

      <p className="text-xs text-slate-500 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2.5">
        Al pulsar <b>Importar</b> no tienes que esperar: la importación corre en segundo plano y ves el
        progreso en la pestaña <b>Importaciones</b>. Si algo sale mal, desde ahí puedes descargar los
        errores y deshacer el lote entero.
      </p>
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div className="flex items-start justify-between gap-3 px-3 py-2">
      <span className="text-xs text-slate-500 shrink-0">{label}</span>
      <span className="text-xs text-slate-700 text-right">{children}</span>
    </div>
  );
}
