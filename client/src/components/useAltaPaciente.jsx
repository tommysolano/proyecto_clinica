import { useCallback, useState } from 'react';
import api from '../api/axios';
import Modal from './Modal';

/**
 * ALTA DE PACIENTE CON AVISO DE DUPLICADO (nov-2026).
 *
 * POST /patients responde 409 `POSSIBLE_DUPLICATE` cuando ya hay alguien que
 * parece la misma persona (mismo nombre sin importar tildes, o mismo celular en
 * cualquier formato). Caso que lo originó: «ABEL DARÍO PONCE MARTÍNEZ» y «ABEL
 * DARIO PONCE MARTINEZ», dos fichas del mismo paciente.
 *
 * Uso:
 *   const { crearPaciente, modalDuplicado } = useAltaPaciente();
 *   const r = await crearPaciente(payload);   // null = canceló
 *   r.patient → el creado o el existente; r.existente → true si eligió el que ya estaba
 *   ...y renderizar {modalDuplicado} en el componente.
 *
 * Los demás errores se lanzan tal cual, para que cada pantalla los muestre
 * como ya lo hacía.
 */
export default function useAltaPaciente() {
  const [pregunta, setPregunta] = useState(null); // { info, resolve }

  const crearPaciente = useCallback(async (payload) => {
    try {
      const { data } = await api.post('/patients', payload);
      return { patient: data, existente: false };
    } catch (err) {
      if (err.response?.status !== 409 || err.response?.data?.code !== 'POSSIBLE_DUPLICATE') throw err;
      const eleccion = await new Promise((resolve) => setPregunta({ info: err.response.data, resolve }));
      setPregunta(null);
      if (eleccion.accion === 'cancelar') return null;
      if (eleccion.accion === 'usar') {
        const { data } = await api.get(`/patients/${eleccion.patientId}`);
        return { patient: data, existente: true };
      }
      const { data } = await api.post('/patients', { ...payload, confirmDuplicate: true });
      return { patient: data, existente: false };
    }
  }, []);

  const responder = (eleccion) => pregunta?.resolve(eleccion);

  const modalDuplicado = (
    <Modal
      isOpen={!!pregunta}
      onClose={() => responder({ accion: 'cancelar' })}
      title="¿Esta persona ya está registrada?"
      size="md"
    >
      <div className="space-y-4">
        <p className="text-sm text-slate-600">
          {pregunta?.info?.message} Si es la misma persona, usa su ficha para no duplicarla
          (las tildes y el formato del teléfono no cuentan).
        </p>
        <ul className="space-y-2">
          {(pregunta?.info?.matches || []).map((m) => (
            <li key={m._id} className="flex items-center justify-between gap-3 border border-slate-200 rounded-lg px-3 py-2">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-slate-800 truncate">{m.name}</div>
                <div className="text-xs text-slate-500">
                  Coincide por {m.motivo}
                  {m.cedulaTail ? ` · cédula …${m.cedulaTail}` : ' · sin cédula'}
                  {m.phoneTail ? ` · tel. …${m.phoneTail}` : ''}
                  {m.createdAt ? ` · registrado ${new Date(m.createdAt).toLocaleDateString('es-EC', { timeZone: 'America/Guayaquil' })}` : ''}
                </div>
              </div>
              <button
                type="button"
                onClick={() => responder({ accion: 'usar', patientId: m._id })}
                className="shrink-0 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg px-3 py-1.5"
              >
                Es esta persona
              </button>
            </li>
          ))}
        </ul>
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-2 border-t border-slate-100">
          <button
            type="button"
            onClick={() => responder({ accion: 'cancelar' })}
            className="text-sm text-slate-600 hover:text-slate-800 px-3 py-2"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => responder({ accion: 'crear' })}
            className="text-sm font-semibold text-slate-700 border border-slate-300 hover:bg-slate-50 rounded-lg px-3 py-2"
          >
            Es otra persona: crear igual
          </button>
        </div>
      </div>
    </Modal>
  );

  return { crearPaciente, modalDuplicado };
}
