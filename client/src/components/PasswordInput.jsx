import { useState } from 'react';
import { HiOutlineEye, HiOutlineEyeSlash } from 'react-icons/hi2';

/**
 * Campo de contraseña con "ojito" para verla mientras se escribe, igual que en
 * el login.
 *
 * Escribir a ciegas es la causa número uno del "contraseña incorrecta", y en
 * Configuración de cuenta se teclea tres veces seguidas —actual, nueva y
 * confirmación—: una tecla mal puesta ahí se paga con el formulario entero.
 *
 * El botón es `type="button"` A PROPÓSITO: dentro de un <form>, un <button> sin
 * tipo envía el formulario, y pulsar el ojo mandaría el cambio a medio escribir.
 * `tabIndex={-1}` deja que Tab salte de campo a campo sin pararse en el icono.
 *
 * `className` viste el <input> (para que cada página conserve su estilo) y
 * `wrapperClassName` el contenedor: el margen va ahí, no en el input, porque el
 * botón se posiciona contra el contenedor y un `mt-*` dentro lo descentraría.
 */
export default function PasswordInput({ className = '', wrapperClassName = '', ...props }) {
  const [visible, setVisible] = useState(false);

  return (
    <div className={`relative ${wrapperClassName}`}>
      <input {...props} type={visible ? 'text' : 'password'} className={`${className} pr-11`} />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setVisible((v) => !v)}
        title={visible ? 'Ocultar contraseña' : 'Mostrar contraseña'}
        aria-label={visible ? 'Ocultar contraseña' : 'Mostrar contraseña'}
        className="absolute inset-y-0 right-0 px-3 flex items-center text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer"
      >
        {visible ? <HiOutlineEyeSlash className="w-5 h-5" /> : <HiOutlineEye className="w-5 h-5" />}
      </button>
    </div>
  );
}
