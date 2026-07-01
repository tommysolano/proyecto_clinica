import { useEffect, useState } from 'react';

// Devuelve una copia de `value` que solo se actualiza cuando `value` deja de
// cambiar durante `delay` ms. Sirve para no disparar una búsqueda en el
// servidor por cada tecla: la petición se lanza una vez que el usuario deja de
// escribir. Reduce peticiones y evita respuestas fuera de orden.
export default function useDebounce(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}
