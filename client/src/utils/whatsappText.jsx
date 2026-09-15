import React from 'react';

// Renderiza el formato de texto de WhatsApp de forma segura (sin HTML crudo):
//   *negrita*   _cursiva_   ~tachado~   ```monoespaciado```   `monoespaciado`
// y ahora también LINKIFICA las URLs que llegan en el mensaje: un enlace que
// manda un contacto se muestra clicable y abre en pestaña nueva, como en
// WhatsApp Web. Devuelve nodos React. Pensado para usarse dentro de un
// contenedor con `whitespace-pre-wrap` (respeta saltos de línea y espacios).
//
// Reglas simplificadas al estilo WhatsApp: cada marcador envuelve texto en la
// MISMA línea y no puede estar vacío. No se anidan formatos (igual que WhatsApp
// en la práctica para estos casos comunes).
const TOKEN = /(```[^`]+```|`[^`\n]+`|\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~)/g;

// URLs en texto plano: con esquema (https://…), con www. inicial, o un dominio
// pelado con TLD alfabético (wa.me, clinica.com, agenda.clinica.com.ec…). La
// rama del dominio pelado exige TLD de LETRAS (≥ 2) para no linkificar
// versiones ("1.2.3"), horas ("10.30") ni números sueltos.
const URL_RE = /(?:https?:\/\/|www\.)[^\s<>"']+|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d{1,5})?(?:\/\S*)?/gi;

// Puntuación de prosa que queda pegada al final de la URL ("mira https://x.com.")
// y no forma parte del enlace.
const COLA_PUNTUACION = /[.,;:!?]+$/;

// Coincidencia de cierre: solo se recorta si no hay apertura equivalente DENTRO
// de la URL (p.ej. "(https://x.com)" no debe perder el ")" de fuera… y sí lo
// pierde, pero "https://es.wikipedia.org/wiki/Java_(lenguaje)" NO lo pierde).
const COLA_CIERRE = [')', ']', '}', '"', "'"];

function recortaCola(url) {
  let s = url;
  let cola = s.match(COLA_PUNTUACION);
  if (cola) s = s.slice(0, -cola[0].length);
  for (const cierre of COLA_CIERRE) {
    const apertura = { ')': '(', ']': '[', '}': '{', '"': '"', "'": "'" }[cierre];
    while (s.endsWith(cierre)) {
      const dentro = (s.match(new RegExp(`\\${apertura}`, 'g')) || []).length;
      const dentroCierre = (s.split(cierre).length - 1) - 1;
      if (dentro > dentroCierre) break; // la apertura equivalente está en la URL: el cierre es suyo
      s = s.slice(0, -1);
    }
  }
  return s;
}

function hrefDe(url) {
  if (/^https?:\/\//i.test(url)) return url;
  return `https://${url}`;
}

/** Renderiza un trozo de texto PLANO linkificando sus URLs. */
function renderPlain(part, keyBase) {
  const nodos = [];
  let last = 0;
  let n = 0;
  URL_RE.lastIndex = 0;
  let m;
  while ((m = URL_RE.exec(part)) !== null) {
    // Un correo ("ana@clinica.com") no debe linkificar el dominio.
    if (m.index > 0 && part[m.index - 1] === '@') continue;
    let url = recortaCola(m[0]);
    const cola = m[0].slice(url.length);
    if (!url) continue;
    const hasta = m.index + url.length;
    if (m.index > last) {
      nodos.push(<React.Fragment key={`${keyBase}t${n++}`}>{part.slice(last, m.index)}</React.Fragment>);
    }
    nodos.push(
      <a
        key={`${keyBase}u${n++}`}
        href={hrefDe(url)}
        target="_blank"
        rel="noreferrer noopener"
        className="underline underline-offset-2 break-all cursor-pointer"
      >
        {url}
      </a>
    );
    last = hasta;
    if (cola) {
      nodos.push(<React.Fragment key={`${keyBase}c${n++}`}>{cola}</React.Fragment>);
      last = m.index + m[0].length;
    }
  }
  if (last < part.length) {
    nodos.push(<React.Fragment key={`${keyBase}f${n++}`}>{part.slice(last)}</React.Fragment>);
  }
  return nodos;
}

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
    return <React.Fragment key={i}>{renderPlain(part, `${i}-`)}</React.Fragment>;
  });
}

export default renderWhatsappText;
