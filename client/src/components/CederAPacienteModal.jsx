import { useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import api from '../api/axios';
import Modal from './Modal';
import NumericInput from './NumericInput';

/**
 * CEDER A OTRO PACIENTE (nov-2026): sesiones libres de un paquete o lo que el paciente dejó
 * guardado en la clínica. Se busca al que recibe, se indica cuánto y el motivo (obligatorio).
 *
 * Props: isOpen, onClose, titulo, maximo, unidad, url (POST), onDone(respuesta), excluir (id
 * del paciente que cede), enteros (solo cantidades enteras).
 */
export default function CederAPacienteModal({ isOpen, onClose, titulo, maximo, unidad = '', url, onDone, excluir, enteros = true }) {
  const [q, setQ] = useState('');
  const [resultados, setResultados] = useState([]);
  const [destino, setDestino] = useState(null);
  const [cantidad, setCantidad] = useState('1');
  const [motivo, setMotivo] = useState('');
  const [guardando, setGuardando] = useState(false);
  const ultima = useRef(0);

  useEffect(() => {
    if (!isOpen) return;
    setQ(''); setResultados([]); setDestino(null); setCantidad('1'); setMotivo('');
  }, [isOpen]);

  useEffect(() => {
    const texto = q.trim();
    if (destino || texto.length < 2) { setResultados([]); return undefined; }
    const mia = ++ultima.current;
    const t = setTimeout(() => {
      api.get('/patients', { params: { search: texto, limit: 10 } })
        .then((r) => { if (mia === ultima.current) setResultados((r.data?.patients || []).filter((p) => String(p._id) !== String(excluir))); })
        .catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [q, destino, excluir]);

  const enviar = async () => {
    const n = Number(String(cantidad).replace(',', '.'));
    if (!destino) return toast.error('Elige al paciente que lo recibe');
    if (!(n > 0) || n > maximo || (enteros && !Number.isInteger(n))) return toast.error(`La cantidad va de 1 a ${maximo}`);
    if (!motivo.trim()) return toast.error('Escribe el motivo');
    setGuardando(true);
    try {
      const r = await api.post(url, { toPatient: destino._id, quantity: n, reason: motivo.trim() });
      toast.success(`Cedido a ${destino.firstName} ${destino.lastName}`);
      onDone?.(r.data);
      onClose();
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudo ceder');
    } finally { setGuardando(false); }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={titulo || 'Ceder a otro paciente'} size="md">
      <div className="space-y-3 text-sm">
        <div className="relative">
          <label className="block text-xs font-semibold text-slate-600 mb-1">Paciente que lo recibe</label>
          {destino ? (
            <div className="flex items-center justify-between border border-emerald-200 bg-emerald-50 rounded-lg px-3 py-2">
              <span>{destino.firstName} {destino.lastName} <span className="text-slate-400 text-xs">{destino.cedula}</span></span>
              <button type="button" onClick={() => { setDestino(null); setQ(''); }} className="text-xs text-emerald-700 bg-transparent border-none cursor-pointer">Cambiar</button>
            </div>
          ) : (
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nombre, cédula o teléfono…" className="input" autoFocus />
          )}
          {!destino && resultados.length > 0 && (
            <div className="absolute z-10 left-0 right-0 mt-1 max-h-52 overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-lg">
              {resultados.map((p) => (
                <button key={p._id} type="button" onClick={() => setDestino(p)}
                  className="w-full text-left px-3 py-2 hover:bg-emerald-50 bg-white border-none cursor-pointer">
                  {p.firstName} {p.lastName} <span className="text-slate-400 text-xs">{p.cedula}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-600 mb-1">Cantidad (máx. {maximo}{unidad ? ` ${unidad}` : ''})</label>
          <NumericInput value={cantidad} onChange={(e) => setCantidad(e.target.value)} className="input w-32" />
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-600 mb-1">Motivo <span className="text-rose-500">*</span></label>
          <input value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ej: se la regala a su esposo" className="input" />
        </div>
        <p className="text-[11px] text-slate-500">Sale del saldo de este paciente y pasa a nombre del otro. El inventario no se mueve hasta que se le aplique.</p>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl border border-slate-200 text-slate-600 bg-white cursor-pointer">Cancelar</button>
          <button type="button" onClick={enviar} disabled={guardando}
            className="px-4 py-2 rounded-xl bg-emerald-600 text-white border-none cursor-pointer disabled:opacity-50">
            {guardando ? 'Cediendo…' : 'Ceder'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
