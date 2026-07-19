import React from 'react';

// Renderiza el formato de texto de WhatsApp de forma segura (sin HTML crudo):
//   *negrita*   _cursiva_   ~tachado~   ```monoespaciado```   `monoespaciado`
// Devuelve nodos React. Pensado para usarse dentro de un contenedor con
// `whitespace-pre-wrap` (respeta saltos de línea y espacios).
//
// Reglas simplificadas al estilo WhatsApp: cada marcador envuelve texto en la
// MISMA línea y no puede estar vacío. No se anidan formatos (igual que WhatsApp
// en la práctica para estos casos comunes).
const TOKEN = /(```[^`]+```|`[^`\n]+`|\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~)/g;

export function renderWhatsappText(text) {
  const str = String(text ?? '');
  if (!str) return str;
  const parts = str.split(TOKEN);
  return parts.map((part, i) => {
    if (!part) return null;
    if (part.startsWith('```') && part.endsWith('```') && part.length > 6) {
      return (
        <code key={i} className="font-mono text-[0.9em] whitespace-pre-wrap">
          {part.slice(3, -3)}
        </code>
      );
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code key={i} className="font-mono text-[0.9em]">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      return <strong key={i} className="font-semibold">{part.slice(1, -1)}</strong>;
    }
    if (part.startsWith('_') && part.endsWith('_') && part.length > 2) {
      return <em key={i}>{part.slice(1, -1)}</em>;
    }
    if (part.startsWith('~') && part.endsWith('~') && part.length > 2) {
      return <span key={i} className="line-through">{part.slice(1, -1)}</span>;
    }
    return <React.Fragment key={i}>{part}</React.Fragment>;
  });
}

export default renderWhatsappText;
