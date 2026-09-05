const {
  SUERO_CLORURO_NOMBRE,
  SUERO_CLORURO_VOLUMENES,
  buscarComponenteSuero,
} = require('../constants/sueroterapia');

/**
 * SANEO DE LA COMPOSICIÓN DE UN SUERO — fuente única.
 *
 * Vivía dentro de `clinicalRecordController` porque solo la receta escribía
 * sueros. Ya no: el servicio de agenda puede traer su suero de serie (Detox
 * Plus) y la cita puede llevar uno indicado al agendar, así que hay tres sitios
 * que construyen la misma estructura. Dos copias de esta función es como acaba
 * un suero guardándose sin `code` por un lado —y por tanto sin descontar la
 * ampolla del inventario— mientras por el otro sí.
 *
 * El cloruro es la base y va en todos: lo único que se elige es el volumen, y
 * solo se aceptan los cuatro que existen (100/250/500/1000 ml) — un "750"
 * tecleado de más es una bolsa que no está en la nevera.
 *
 * Las ampollas y moléculas se resuelven contra el catálogo para quedarse con el
 * NOMBRE y el CÓDIGO buenos: es lo que luego permite encontrar la ampolla en el
 * inventario y descontarla. Lo que no está en el catálogo NO se descarta —el
 * médico puede recetar algo que la lista no tiene— pero se guarda sin código, y
 * entonces simplemente no habrá stock que mover.
 */
const saneaComposicionSuero = (it) => {
  const base = it?.serumBase || {};
  const volumen = Number(base.volumeMl);
  const serumBase = {
    name: String(base.name || '').trim() || SUERO_CLORURO_NOMBRE,
    volumeMl: SUERO_CLORURO_VOLUMENES.includes(volumen) ? volumen : null,
  };
  const serumComponents = (Array.isArray(it?.serumComponents) ? it.serumComponents : [])
    .map((c) => {
      const nombre = String(c?.name || '').trim();
      if (!nombre) return null;
      const delCatalogo = buscarComponenteSuero({ code: c?.code, name: nombre });
      const cantidad = Number(c?.quantity);
      return {
        code: delCatalogo?.code || String(c?.code || '').trim(),
        name: delCatalogo?.name || nombre,
        grupo:
          delCatalogo?.grupo ||
          (['ampolla', 'molecula', 'otro'].includes(c?.grupo) ? c.grupo : 'otro'),
        // Una ampolla "de 0" no es una ampolla: si no viene un número válido se
        // asume 1, que es lo que el médico quiso decir al añadirla a la lista.
        quantity: Number.isFinite(cantidad) && cantidad > 0 ? cantidad : 1,
      };
    })
    .filter(Boolean);
  return { serumBase, serumComponents };
};

/**
 * Composición que llega en el formato del SERVICIO DE AGENDA (`autoSerum`) o de
 * la cita (`serum`), donde los campos se llaman `base` y `components` porque ahí
 * no hay una línea de receta de la que colgar — es la preparación a secas.
 *
 * Devuelve `null` cuando no hay ni una sola ampolla: un suero sin nada dentro es
 * media bolsa de cloruro que nadie pidió, y dejarlo pasar llenaría la ficha de
 * líneas vacías cada vez que alguien agenda.
 */
const saneaSueroPlano = (spec) => {
  if (!spec) return null;
  const { serumBase, serumComponents } = saneaComposicionSuero({
    serumBase: spec.base || spec.serumBase,
    serumComponents: spec.components || spec.serumComponents,
  });
  if (!serumComponents.length) return null;
  return { serumBase, serumComponents };
};

/**
 * La preparación convertida en LÍNEA DE RECETA, que es como la lee enfermería
 * para aplicarla (`recetaItems[]` con `isSerum`).
 *
 * `name` es lo que se ve en la ficha y en el aviso: el nombre del servicio si lo
 * hay ("Detox Plus"), y si no, el de la propia ampolla. «Suero» a secas no dice
 * nada cuando hay tres esperando.
 */
const lineaDeRecetaDeSuero = ({ serumBase, serumComponents }, nombre) => ({
  name:
    String(nombre || '').trim() ||
    serumComponents.map((c) => c.name).filter(Boolean).join(' + ') ||
    'Suero',
  quantity: 1,
  dose: '',
  frequency: '',
  duration: '',
  instructions: '',
  isService: false,
  isSerum: true,
  serumBase,
  serumComponents,
  administrations: [],
  isComposite: false,
  componentsUsed: [],
});

module.exports = { saneaComposicionSuero, saneaSueroPlano, lineaDeRecetaDeSuero };
