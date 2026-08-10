function templateButtonId(nodeId, index) {
  const safeNodeId = String(nodeId || 'template').replace(/[^a-zA-Z0-9_-]/g, '').slice(-40) || 'template';
  return `tb_${safeNodeId}_${index + 1}`;
}

function previousButtonsOf(data = {}) {
  return (Array.isArray(data.buttons) ? data.buttons : [])
    .filter((button) => button?.id)
    .slice(0, 3);
}

/**
 * Copia al nodo los botones de la plantilla aprobada. El id se conserva por
 * posición para no romper las conexiones del diagrama cuando Meta sincroniza el
 * texto o el destino de un botón.
 */
export function syncTemplateNodeData(data = {}, template, nodeId) {
  if (!template) return { ...data, buttons: [] };
  const previous = previousButtonsOf(data);
  const buttons = (Array.isArray(template.buttons) ? template.buttons : [])
    .filter((button) => button && String(button.text || '').trim())
    .slice(0, 3)
    .map((button, index) => ({
      id: previous[index]?.id || templateButtonId(nodeId, index),
      type: ['quick_reply', 'url', 'phone'].includes(button.type) ? button.type : 'quick_reply',
      text: String(button.text || '').trim(),
      url: String(button.url || '').trim(),
    }));
  return {
    ...data,
    buttons,
    templateLanguage: template.language || data.templateLanguage || 'es',
  };
}

export function syncTemplateNodes(nodes = [], templates = []) {
  return nodes.map((node) => {
    if (node?.type !== 'send_template') return node;
    const template = templates.find((item) => item.name === node.data?.templateName);
    const data = syncTemplateNodeData(node.data || {}, template, node.id);
    return { ...node, data };
  });
}
