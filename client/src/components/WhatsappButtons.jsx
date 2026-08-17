import { HiOutlineArrowTopRightOnSquare, HiOutlinePhone, HiOutlineArrowUturnLeft } from 'react-icons/hi2';

/**
 * Botones de un mensaje interactivo, pintados COMO LOS PINTA WHATSAPP.
 *
 * En WhatsApp los botones no son cajitas sueltas con borde: son una hoja BLANCA
 * pegada al fondo de la burbuja, a todo su ancho, con el texto centrado en azul,
 * un icono según el tipo y una línea finísima separando un botón del siguiente.
 *
 * Este componente es la ÚNICA fuente del diseño: lo usan la burbuja del chat
 * (client/src/pages/Chats.jsx) y las dos previsualizaciones (WhatsappPreview y
 * la del nodo "Enviar mensaje" del editor de automatizaciones). Antes cada sitio
 * lo pintaba a su manera y el chat no se parecía en nada a la previsualización.
 *
 * Props:
 *  - buttons: [{ id?, type: 'url'|'phone'|'quick_reply', text }]
 *  - attached: true  → hoja pegada al fondo de la burbuja (necesita que el padre
 *                      tenga overflow-hidden y las esquinas inferiores redondeadas).
 *              false → tarjeta suelta debajo de la burbuja (previsualizaciones).
 *  - bleed:   clases de margen negativo para que la hoja llegue a los bordes de
 *             una burbuja con padding (p.ej. '-mx-3 -mb-2' para px-3 py-2).
 */
const ICONS = {
  url: HiOutlineArrowTopRightOnSquare,
  phone: HiOutlinePhone,
  quick_reply: HiOutlineArrowUturnLeft,
};

export default function WhatsappButtons({ buttons = [], attached = false, bleed = '', className = '' }) {
  const list = Array.isArray(buttons) ? buttons.filter(Boolean) : [];
  if (!list.length) return null;

  return (
    <div
      className={`${attached ? `${bleed} mt-2 overflow-hidden rounded-b-lg bg-white` : 'overflow-hidden rounded-lg bg-white shadow-sm'} ${className}`}
    >
      {list.map((button, index) => {
        // Respuesta rápida es el tipo por defecto: es lo que manda el motor cuando
        // el botón no lleva url ni teléfono.
        const Icon = ICONS[button.type] || ICONS.quick_reply;
        return (
          <div
            key={button.id || index}
            className={`flex items-center justify-center gap-1.5 px-3 py-2.5 text-[13px] font-medium leading-none text-sky-600 ${
              index > 0 ? 'border-t border-slate-100' : ''
            }`}
          >
            <Icon className="w-4 h-4 shrink-0" />
            <span className="truncate">{button.text || 'Botón'}</span>
          </div>
        );
      })}
    </div>
  );
}
