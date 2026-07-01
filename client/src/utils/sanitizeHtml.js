// Sanitiza HTML para renderizarlo de forma segura (dangerouslySetInnerHTML).
// Reconstruye el árbol permitiendo SOLO un conjunto de etiquetas de formato y
// eliminando todos los atributos, comentarios y cualquier otra etiqueta
// (script, style, on*=..., href javascript:, etc.). Es seguro por construcción:
// el texto se escapa y solo se emiten etiquetas de la allowlist sin atributos.
const ALLOWED = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'UL', 'OL', 'LI', 'P', 'BR']);

const escapeText = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function sanitizeHtml(html) {
  if (!html || typeof html !== 'string') return '';
  // Si no trae etiquetas, es texto plano heredado: escápalo y respeta saltos.
  const doc = new DOMParser().parseFromString(html, 'text/html');

  const clean = (node) => {
    let out = '';
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        out += escapeText(child.textContent);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName;
        if (tag === 'BR') {
          out += '<br>';
        } else if (ALLOWED.has(tag)) {
          const t = tag.toLowerCase();
          out += `<${t}>${clean(child)}</${t}>`;
        } else {
          // Etiqueta no permitida: conserva solo su contenido ya saneado.
          out += clean(child);
        }
      }
      // Comentarios y otros tipos de nodo se ignoran.
    });
    return out;
  };

  return clean(doc.body);
}
