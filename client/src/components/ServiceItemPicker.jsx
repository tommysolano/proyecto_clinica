import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { HiOutlineMagnifyingGlass } from 'react-icons/hi2';
import api from '../api/axios';
import SuggestInput from './SuggestInput';

/**
 * Selector del SERVICIO de una cita.
 *
 * Busca en el catálogo propio de la agenda (no en el inventario) y, si lo que
 * hace falta no está, lo crea al vuelo: quien agenda no puede quedarse
 * bloqueado con el paciente al teléfono porque falte una opción, y lo que cree
 * queda disponible para todos los demás desde ese momento.
 *
 * Se apoya en SuggestInput, que ya resuelve lo difícil: enseña lo más usado
 * primero (que es el nombre bueno) y evita que acaben conviviendo «Botox»,
 * «botox» y «BOTOX» como tres servicios distintos.
 *
 * Props:
 *   value    : { _id, name } | null — el servicio elegido
 *   onChange : (item|null) => void
 */
export default function ServiceItemPicker({ value, onChange, placeholder = 'Busca un servicio o escribe uno nuevo…', autoFocus = false }) {
  const [items, setItems] = useState([]);
  const [texto, setTexto] = useState(value?.name || '');
  const [creando, setCreando] = useState(false);

  useEffect(() => {
    let vivo = true;
    api
      .get('/appointment-service-items')
      .then((r) => { if (vivo) setItems(Array.isArray(r.data) ? r.data : []); })
      .catch(() => {});
    return () => { vivo = false; };
  }, []);

  // El padre puede cambiar el valor (abrir la edición de otra cita, limpiar el
  // formulario): el texto visible tiene que seguirlo.
  useEffect(() => { setTexto(value?.name || ''); }, [value?._id, value?.name]);

  const elegir = async (nombre) => {
    const limpio = String(nombre || '').trim();
    if (!limpio) {
      onChange(null);
      return;
    }
    // Si ya está en el catálogo, se usa ese: no se crea un duplicado por una
    // tilde o una mayúscula de diferencia.
    const plano = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
    const existente = items.find((i) => plano(i.name) === plano(limpio));
    if (existente) {
      setTexto(existente.name);
      onChange(existente);
      return;
    }

    setCreando(true);
    try {
      // El servidor también hace buscar-o-crear: si otro lo creó hace un segundo,
      // devuelve el suyo en vez de fallar por duplicado.
      const { data } = await api.post('/appointment-service-items', { name: limpio });
      setItems((prev) => (prev.some((i) => i._id === data._id) ? prev : [...prev, data]));
      setTexto(data.name);
      onChange(data);
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo crear el servicio');
      setTexto(value?.name || '');
    } finally {
      setCreando(false);
    }
  };

  // Ya elegido: se tiñe de verde para que se vea de un vistazo que la cita tiene
  // servicio, sin tener que leer el texto.
  const elegido = !!value?._id;

  return (
    <SuggestInput
      value={texto}
      onChange={(t) => {
        setTexto(t);
        // Borrar el texto quita el servicio: la cita puede guardarse sin él.
        if (!String(t).trim()) onChange(null);
      }}
      onSelect={elegir}
      // Al salir del campo se confirma lo escrito, para que no se pierda por no
      // haber pulsado Enter.
      onBlur={() => {
        const limpio = texto.trim();
        if (limpio && limpio !== (value?.name || '')) elegir(limpio);
      }}
      options={items.map((i) => ({ name: i.name, count: i.usageCount || 0 }))}
      placeholder={creando ? 'Creando…' : placeholder}
      emptyHint="Todavía no hay servicios. Escribe el primero."
      autoFocus={autoFocus}
      icon={<HiOutlineMagnifyingGlass className="w-4 h-4" />}
      onClear={() => { setTexto(''); onChange(null); }}
      className={
        'w-full pl-10 pr-9 py-2.5 border rounded-xl text-sm outline-none ' +
        'focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 ' +
        (elegido
          ? 'border-emerald-300 bg-emerald-50/60 text-emerald-900 font-medium'
          : 'border-slate-200 bg-slate-50/50 text-slate-800')
      }
    />
  );
}
