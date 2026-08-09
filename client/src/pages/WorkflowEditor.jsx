import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/axios';
import toast from 'react-hot-toast';
import { HiOutlineArrowLeft, HiOutlineBolt, HiOutlineSun } from 'react-icons/hi2';
import WorkflowGraphEditor, { stepsToGraph, TRIGGERS } from '../components/WorkflowGraphEditor';
import WorkflowWindowPicker from '../components/WorkflowWindowPicker';
import { describeWindow } from '../utils/windowSchedule';
import Modal from '../components/Modal';

const defaultTrigger = () => ({ type: 'appointment_created', audience: 'all', serviceFilter: null, keywords: [], matchType: 'contains', tagFilter: '' });
// Ventana de envío por defecto: sin restricción (la automatización trabaja 24/7,
// como siempre). Al activarla se propone el horario laboral típico.
const blankWindow = () => ({ mode: 'any', days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' });
const blank = () => ({
  name: '',
  folder: 'General',
  active: false,
  steps: [],
  nodes: [],
  edges: [],
  sendWindow: blankWindow(),
});

export default function WorkflowEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = !id || id === 'new';

  const [wf, setWf] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [agents, setAgents] = useState([]);
  const [products, setProducts] = useState([]);
  const [clinics, setClinics] = useState([]);
  const [audiences, setAudiences] = useState([]);
  const [audiencesNotice, setAudiencesNotice] = useState('');
  const [metaAds, setMetaAds] = useState([]);
  const [metaAdsNotice, setMetaAdsNotice] = useState('');
  // Etiquetas EN USO (paciente / chat / oportunidad) para los desplegables del
  // nodo Condición: escribirlas a mano se presta a erratas que nunca casan.
  const [tagOptions, setTagOptions] = useState({ patient: [], chat: [], opportunity: [] });
  const [folderNames, setFolderNames] = useState([]);
  const [saving, setSaving] = useState(false);
  const [windowOpen, setWindowOpen] = useState(false);

  // Bloquea el scroll del fondo mientras el editor (portal a pantalla completa) está abierto.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const [tpls, ags, fld, list, prods, clins, auds, ads, tags] = await Promise.all([
          api.get('/message-templates?channel=whatsapp').catch(() => ({ data: [] })),
          api.get('/call-center/agents').catch(() => ({ data: [] })),
          api.get('/workflows/folders').catch(() => ({ data: [] })),
          api.get('/workflows').catch(() => ({ data: [] })),
          api.get('/products').catch(() => ({ data: [] })),
          api.get('/clinics').catch(() => ({ data: [] })),
          api.get('/workflows/meta/custom-audiences').catch((e) => ({ data: { ok: false, error: e?.response?.data?.error || 'error', audiences: [] } })),
          api.get('/workflows/meta/ads').catch((e) => ({ data: { ok: false, error: e?.response?.data?.error || 'error', ads: [] } })),
          api.get('/workflows/tags').catch(() => ({ data: { patient: [], chat: [], opportunity: [] } })),
        ]);
        if (!active) return;
        setTagOptions({
          patient: tags.data?.patient || [],
          chat: tags.data?.chat || [],
          opportunity: tags.data?.opportunity || [],
        });
        setTemplates((tpls.data || []).filter((t) => t.status === 'approved'));
        setAgents(ags.data || []);
        setProducts(Array.isArray(prods.data) ? prods.data : prods.data?.items || []);
        setClinics(Array.isArray(clins.data) ? clins.data : clins.data?.clinics || []);
        const ad = auds.data || {};
        setAudiences(ad.audiences || []);
        setAudiencesNotice(
          ad.ok
            ? ((ad.audiences || []).length ? '' : 'No hay públicos personalizados en tu cuenta de Meta todavía.')
            : ad.reason === 'marketing_api_not_configured'
              ? 'Configura el token de Marketing API en Ajustes → WhatsApp (Meta) para ver tus públicos.'
              : ad.reason === 'no_ad_accounts'
                ? 'El token no tiene cuentas publicitarias con acceso.'
                : `No se pudieron cargar los públicos de Meta${ad.error ? `: ${ad.error}` : ''}.`
        );
        const adCatalog = ads.data || {};
        setMetaAds(adCatalog.ads || []);
        setMetaAdsNotice(
          adCatalog.ok
            ? ((adCatalog.ads || []).length ? '' : 'Meta no devolvió anuncios para la cuenta configurada.')
            : adCatalog.reason === 'marketing_api_not_configured'
              ? 'Conecta Marketing API en Config. Call Center → Sistema e integraciones → WhatsApp para seleccionar el anuncio y mantener su ID estable.'
              : adCatalog.reason === 'no_ad_accounts'
                ? 'El token de Marketing API no tiene cuentas publicitarias con acceso.'
                : `No se pudieron cargar los anuncios de Meta${adCatalog.error ? `: ${adCatalog.error}` : ''}.`
        );
        const names = new Set((fld.data || []).map((f) => f.name));
        (list.data || []).forEach((w) => names.add(w.folder || 'General'));
        setFolderNames([...names].sort());

        if (isNew) {
          const folder = new URLSearchParams(window.location.search).get('folder');
          setWf({ ...blank(), folder: folder || 'General' });
        } else {
          const { data } = await api.get(`/workflows/${id}`);
          // Disparadores a nivel workflow (legacy): se migran al nodo trigger del flujo.
          const wfTriggers = Array.isArray(data.triggers) && data.triggers.length
            ? data.triggers.map((t) => ({ ...t }))
            : (data.trigger?.type ? [{ ...data.trigger }] : [defaultTrigger()]);
          const triggerLabel = TRIGGERS.find((t) => t.value === wfTriggers[0]?.type)?.label || 'Disparador';
          const hasGraph = Array.isArray(data.nodes) && data.nodes.length > 0;
          const graph = hasGraph
            ? { nodes: data.nodes.map((n) => ({ ...n, data: { ...n.data } })), edges: (data.edges || []).map((e) => ({ ...e })) }
            : stepsToGraph(data.steps || [], triggerLabel);
          // Si los nodos trigger no traen sus propios disparadores (workflows viejos),
          // se les inyecta la lista a nivel workflow (un solo flujo).
          graph.nodes = graph.nodes.map((n) =>
            n.type === 'trigger' && !(n.data?.triggers?.length)
              ? { ...n, data: { ...n.data, triggers: wfTriggers.map((t) => ({ ...t })) } }
              : n
          );
          setWf({
            ...data,
            steps: [],
            nodes: graph.nodes,
            edges: graph.edges,
            sendWindow: { ...blankWindow(), ...(data.sendWindow || {}) },
          });
        }
      } catch (e) {
        toast.error(e.response?.data?.message || 'Error al cargar');
        navigate('/workflows');
      }
    };
    load();
    return () => { active = false; };
  }, [id, isNew, navigate]);

  const save = async (close = true) => {
    if (!wf.name.trim()) return toast.error('Ponle un nombre al workflow');
    const actionNodes = (wf.nodes || []).filter((n) => n.type !== 'trigger');
    if (actionNodes.length === 0) return toast.error('Agrega al menos un paso al diagrama');
    if (actionNodes.some((n) => n.type === 'assign_agent' && n.data?.assignMode === 'user' && !n.data?.assignUser)) {
      return toast.error('Selecciona el asesor específico en cada paso “Asignar agente”');
    }
    // Unión de disparadores de todos los flujos (para el filtro/índice del motor).
    const triggers = (wf.nodes || [])
      .filter((n) => n.type === 'trigger')
      .flatMap((n) => n.data?.triggers || [])
      .filter((t) => t?.type);
    if (triggers.length === 0) return toast.error('Cada flujo necesita al menos un disparador');
    if (wf.sendWindow?.mode === 'specific' && !(wf.sendWindow.days || []).length) {
      return toast.error('El horario de silencio no tiene ningún día marcado: elige días o ponlo en “Sin silencio”');
    }
    setSaving(true);
    const payload = {
      ...wf,
      triggers,
      trigger: triggers[0],
      steps: [],
      nodes: wf.nodes || [],
      edges: wf.edges || [],
    };
    try {
      if (wf._id) await api.put(`/workflows/${wf._id}`, payload);
      else {
        const { data } = await api.post('/workflows', payload);
        setWf((p) => ({ ...p, _id: data._id }));
      }
      toast.success('Workflow guardado');
      if (close) navigate('/workflows');
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  if (!wf) {
    return createPortal(
      <div className="fixed inset-0 z-[9998] bg-white flex items-center justify-center text-slate-400 text-sm">Cargando…</div>,
      document.body
    );
  }

  return createPortal(
    <div className="fixed inset-0 z-[9998] bg-slate-50 flex flex-col">
      {/* Barra superior */}
      <header className="flex items-center gap-3 px-4 py-2.5 bg-white border-b border-slate-200 shrink-0">
        <button onClick={() => navigate('/workflows')} title="Volver" className="p-2 rounded-lg text-slate-500 hover:bg-slate-100 bg-transparent border-none cursor-pointer">
          <HiOutlineArrowLeft className="w-5 h-5" />
        </button>
        <HiOutlineBolt className="text-emerald-600 w-5 h-5 shrink-0" />
        <input
          value={wf.name}
          onChange={(e) => setWf({ ...wf, name: e.target.value })}
          placeholder="Nombre de la automatización"
          className="text-base font-semibold text-slate-800 border-none focus:ring-0 outline-none bg-transparent flex-1 min-w-0"
        />
        <input
          list="wf-folders"
          value={wf.folder || 'General'}
          onChange={(e) => setWf({ ...wf, folder: e.target.value })}
          placeholder="Carpeta"
          className="w-36 border border-slate-200 rounded-lg px-3 py-1.5 text-sm shrink-0"
        />
        <datalist id="wf-folders">{folderNames.map((f) => <option key={f} value={f} />)}</datalist>
        <button
          onClick={() => setWindowOpen(true)}
          title="Horario en el que esta automatización NO debe enviar mensajes"
          className={`px-3 py-1.5 rounded-lg text-sm shrink-0 cursor-pointer flex items-center gap-1.5 border ${
            wf.sendWindow?.mode === 'specific'
              ? 'bg-emerald-50 border-emerald-300 text-emerald-700'
              : 'bg-white border-slate-200 text-slate-600'
          }`}
        >
          <HiOutlineSun className="w-4 h-4" />
          <span className="hidden lg:inline">
            {wf.sendWindow?.mode === 'specific' ? describeWindow(wf.sendWindow) : 'Horario de silencio'}
          </span>
        </button>
        <label className="flex items-center gap-2 text-sm text-slate-600 shrink-0 cursor-pointer select-none">
          <input type="checkbox" checked={wf.active} onChange={(e) => setWf({ ...wf, active: e.target.checked })} />
          Activo
        </label>
        <button onClick={() => navigate('/workflows')} className="px-4 py-1.5 border border-slate-200 rounded-lg text-sm bg-white cursor-pointer shrink-0">Cancelar</button>
        <button onClick={() => save(true)} disabled={saving} className="px-5 py-1.5 bg-emerald-600 text-white rounded-lg text-sm cursor-pointer border-none shrink-0 disabled:opacity-60">
          {saving ? 'Guardando…' : 'Guardar'}
        </button>
      </header>

      {/* Lienzo a pantalla completa */}
      <main className="flex-1 min-h-0">
        <WorkflowGraphEditor
          nodes={wf.nodes || []}
          edges={wf.edges || []}
          onChange={({ nodes, edges }) => setWf((prev) => ({ ...prev, nodes, edges }))}
          templates={templates}
          agents={agents}
          products={products}
          clinics={clinics}
          audiences={audiences}
          audiencesNotice={audiencesNotice}
          metaAds={metaAds}
          metaAdsNotice={metaAdsNotice}
          tagOptions={tagOptions}
        />
      </main>

      {/* Horario de SILENCIO de TODO el workflow */}
      <Modal isOpen={windowOpen} onClose={() => setWindowOpen(false)} title="Horario de silencio" size="md">
        <div className="grid gap-4">
          <p className="text-sm text-slate-500">
            Define las horas en las que esta automatización <b>no debe molestar</b> (WhatsApp, plantillas,
            email, reseñas). Los pasos que no envían nada —etiquetas, tareas, oportunidades— se ejecutan
            siempre.
          </p>
          <div className="grid gap-2">
            {[
              { value: 'any', title: 'Sin silencio', desc: 'La automatización puede enviar a cualquier hora, todos los días.' },
              { value: 'specific', title: 'No enviar en un horario', desc: 'Dentro de la franja se calla. Quien entre en ella no se pierde: recibe su mensaje en cuanto el silencio termina.' },
            ].map((opt) => (
              <label
                key={opt.value}
                className={`flex gap-2.5 items-start rounded-xl border px-3 py-2.5 cursor-pointer ${
                  (wf.sendWindow?.mode || 'any') === opt.value ? 'border-emerald-400 bg-emerald-50/60' : 'border-slate-200'
                }`}
              >
                <input
                  type="radio"
                  name="wf-window-mode"
                  className="mt-1"
                  checked={(wf.sendWindow?.mode || 'any') === opt.value}
                  onChange={() => setWf({ ...wf, sendWindow: { ...blankWindow(), ...wf.sendWindow, mode: opt.value } })}
                />
                <span>
                  <span className="block text-sm font-semibold text-slate-700">{opt.title}</span>
                  <span className="block text-[11px] text-slate-500">{opt.desc}</span>
                </span>
              </label>
            ))}
          </div>
          {wf.sendWindow?.mode === 'specific' && (
            <div className="border-t border-slate-100 pt-3">
              <WorkflowWindowPicker
                value={wf.sendWindow}
                onChange={(patch) => setWf({ ...wf, sendWindow: { ...blankWindow(), ...wf.sendWindow, ...patch } })}
              />
              <p className="text-[11px] text-slate-400 mt-3">
                Horario de Ecuador. Para restringir solo una parte del flujo (y no todo), usa el paso
                <b> “Ventana horaria”</b> dentro del diagrama.
              </p>
            </div>
          )}
          <div className="flex justify-end">
            <button
              onClick={() => setWindowOpen(false)}
              className="px-4 py-1.5 bg-emerald-600 text-white rounded-lg text-sm border-none cursor-pointer"
            >
              Listo
            </button>
          </div>
        </div>
      </Modal>
    </div>,
    document.body
  );
}
