import { useEffect, useMemo, useState } from 'react';
import api from '../api/axios';
import Modal from './Modal';
import Spinner from './Spinner';
import { Seguimiento } from './SeguimientoLectura';
import { HiOutlineClipboardDocumentList } from 'react-icons/hi2';

/**
 * TODOS LOS SEGUIMIENTOS DE UN PACIENTE, desde la agenda y sin salir de ella.
 *
 * «Ver consulta y receta» enseña lo que se escribió EN UNA cita; esta ventana
 * enseña la historia entera — cuándo vino, quién lo atendió y qué se le
 * recetó en cada consulta — para quien en la agenda necesita el contexto del
 * paciente completo: mostrador para cobrar o dispensar, enfermería para saber
 * qué poner, el doctor para repasar, el call center para responder.
 *
 * Es de SOLO LECTURA a propósito, igual que la de una cita: escribir se hace
 * desde la ficha del paciente, no desde la agenda.
 *
 * Props: patientId, nombre (para el título), onClose
 */
export default function SeguimientosPacienteModal({ patientId, nombre, onClose }) {
  const [record, setRecord] = useState(null);
  const [error, setError] = useState('');

  // Sin `setLoading(true)` aquí: el estado ya nace en `true` y la ventana se
  // monta de nuevo por cada paciente, así que no hay nada que reiniciar.
  useEffect(() => {
    let vivo = true;
    api
      .get(`/clinical-records/${patientId}`)
      .then((r) => { if (vivo) { setRecord(r.data); setError(''); } })
      .catch((e) => {
        if (vivo) setError(e.response?.data?.message || 'No se pudo cargar la historia clínica');
      });
    return () => { vivo = false; };
  }, [patientId]);

  // Lo más reciente arriba: para entender a un paciente se empieza por lo último.
  const seguimientos = useMemo(
    () => [...(record?.followUps || [])].sort(
      (a, b) => new Date(b.fecha || b.createdAt) - new Date(a.fecha || a.createdAt)
    ),
    [record]
  );

  return (
    <Modal isOpen onClose={onClose} title={`Seguimientos · ${nombre || 'Paciente'}`} size="lg">
      <div className="space-y-4">
        <p className="text-xs text-slate-400 m-0">
          Solo lectura — corregir una consulta se hace desde la ficha del paciente, por su autor.
        </p>

        {!record && !error && (
          <div className="py-10 flex justify-center"><Spinner /></div>
        )}

        {error && (
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {error}
          </p>
        )}

        {record && seguimientos.length === 0 && (
          <div className="text-center py-8 text-slate-500 text-sm">
            <HiOutlineClipboardDocumentList className="w-8 h-8 mx-auto mb-2 text-slate-300" />
            Este paciente todavía no tiene consultas registradas.
          </div>
        )}

        {seguimientos.map((fu) => (
          <Seguimiento key={fu._id} fu={fu} conFecha />
        ))}

        <div className="flex justify-end pt-1">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-slate-200 bg-white text-sm text-slate-600 cursor-pointer"
          >
            Cerrar
          </button>
        </div>
      </div>
    </Modal>
  );
}
