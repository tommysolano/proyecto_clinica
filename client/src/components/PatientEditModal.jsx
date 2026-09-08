import { useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import api from '../api/axios';
import Modal from './Modal';
import PatientFields, { emptyPatientForm, formDesdePaciente, payloadDePaciente } from './PatientFields';

/**
 * CORREGIR LOS DATOS DEL PACIENTE SIN SALIR DE DONDE SE ESTÁ (sep-2026).
 *
 * Nació para la AGENDA: mostrador tiene al paciente delante, descubre que la
 * cédula está mal escrita o que cambió de número, y para arreglarlo tenía que
 * abandonar la cita, irse a Clientes, buscarlo, corregirlo y volver a buscar la
 * cita. Con la cola esperando, eso no se hace: el dato se queda mal.
 *
 * Es la MISMA edición que la de la página de Pacientes —los mismos campos, las
 * mismas reglas por rol, el mismo `PUT /patients/:id`—, en una ventana. Lo que
 * NO trae es el bloque de agendar cita: aquí ya hay una.
 *
 * SE VUELVE A PEDIR EL PACIENTE al abrir. El que viaja dentro de la cita llega
 * recortado (`POPULATE_PATIENT` no trae dirección, ni origen, ni quién lo
 * refirió), y guardar el formulario con esos campos en blanco los habría
 * borrado. Se pide entero —y ya censurado según el rol— antes de enseñar nada.
 */
export default function PatientEditModal({ patientId, isOpen, onClose, onSaved }) {
  const [form, setForm] = useState(emptyPatientForm);
  const [telefonos, setTelefonos] = useState('');
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  // Referencia viva a `onClose` para no tener que meterla en las dependencias
  // del efecto: la define el padre y cambia en cada render suyo, así que
  // listarla volvería a pedir el paciente sin motivo (mismo truco que Modal.jsx).
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });

  useEffect(() => {
    if (!isOpen || !patientId) return undefined;
    let vivo = true;
    setCargando(true);
    api.get(`/patients/${patientId}`)
      .then((r) => {
        if (!vivo) return;
        const { form: f, telefonos: t } = formDesdePaciente(r.data);
        setForm(f);
        setTelefonos(t);
      })
      .catch((err) => {
        if (!vivo) return;
        toast.error(err.response?.data?.message || 'No se pudo cargar el paciente');
        onCloseRef.current?.();
      })
      .finally(() => { if (vivo) setCargando(false); });
    return () => { vivo = false; };
  }, [isOpen, patientId]);

  const guardar = async () => {
    setGuardando(true);
    try {
      const { data } = await api.put(`/patients/${patientId}`, payloadDePaciente(form, telefonos));
      toast.success('Paciente actualizado');
      onSaved?.(data);
      onClose?.();
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo guardar el paciente');
    } finally {
      setGuardando(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Editar datos del paciente" size="lg">
      {cargando ? (
        <p className="text-sm text-slate-500 m-0">Cargando…</p>
      ) : (
        /* Enter NO envía: aquí se rellenan quince campos y una pulsación por
           inercia guardaba a medias (mismo criterio que en Pacientes). */
        <form
          onSubmit={(e) => { e.preventDefault(); guardar(); }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            const tag = e.target.tagName;
            if (tag === 'TEXTAREA' || tag === 'BUTTON') return;
            e.preventDefault();
          }}
          className="space-y-4"
        >
          <PatientFields
            form={form}
            setForm={setForm}
            telefonos={telefonos}
            setTelefonos={setTelefonos}
            editing
          />
          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl border border-slate-200 bg-white text-sm text-slate-600 cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={guardando}
              className="px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm font-medium border-none cursor-pointer disabled:opacity-50"
            >
              {guardando ? 'Guardando…' : 'Guardar cambios'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
