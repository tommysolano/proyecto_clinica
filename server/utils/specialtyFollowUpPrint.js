/**
 * Bloques HTML de las fichas por especialidad para el PDF del seguimiento
 * («Receta médica / Indicaciones», ver clinicalRecordController.printFollowUp).
 *
 * Regla: si la especialidad no tiene datos, devuelve ''. Así el PDF de un doctor
 * general sale EXACTAMENTE igual que antes; solo crece cuando hay algo que decir.
 *
 * Usa las mismas clases del documento (.box / .label / table / th), así que no
 * hace falta tocar el CSS del controlador.
 */
const {
  CARDIOLOGIA_ANTECEDENTES,
  CARDIOLOGIA_ESTUDIOS,
  PODOLOGIA_HALLAZGOS,
  PODOLOGIA_EVALUACION,
  PODOLOGIA_HALLAZGOS_GENERALES,
  labelOdonto,
  ODONTOGRAMA_CARAS,
  HIGIENE_ORAL_FILAS,
  HIGIENE_ORAL_INDICES,
  ENFERMEDAD_PERIODONTAL,
  MALOCLUSION,
  FLUOROSIS,
  INDICE_CPO,
  INDICE_CEO,
  TERAPIA_ELEMENTOS,
  TERAPIA_FODA,
  COSMETOLOGIA_BIOTIPOS,
  COSMETOLOGIA_ARRUGAS,
  COSMETOLOGIA_ACNE,
  COSMETOLOGIA_LESIONES,
  COSMETOLOGIA_HIPERPIGMENTACION,
  COSMETOLOGIA_CABELLO,
  COSMETOLOGIA_CABELLO_TRATAMIENTOS,
  COSMETOLOGIA_CUERO_CABELLUDO,
  COSMETOLOGIA_FIBRA_CAPILAR,
  COSMETOLOGIA_AFECCIONES_CUERO,
  COSMETOLOGIA_OPTION_LABELS,
} = require('../constants/specialtyCatalogs');

/** Escapa el texto del usuario: una nota con `<` no debe romper el documento. */
const esc = (v) =>
  String(v ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

const optionLabel = (v) => COSMETOLOGIA_OPTION_LABELS[v] || v || '';
const labelOf = (catalog, key) => catalog.find((c) => c.key === key)?.label || key;

/** Casillas marcadas de un checklist, con su detalle si lo tiene. */
const marcados = (catalog, arr) =>
  (Array.isArray(arr) ? arr : [])
    .filter((c) => c && (c.marked || String(c.detail || '').trim()))
    .map((c) => {
      const detalle = String(c.detail || '').trim();
      const label = labelOf(catalog, c.key);
      return detalle ? `${label}: ${detalle}` : label;
    });

/** «Piel: seca · Uñas: engrosadas» — descarta los pares sin valor. */
const inline = (pares) =>
  pares
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `<b>${esc(k)}:</b> ${esc(v)}`)
    .join(' &nbsp;·&nbsp; ');

const box = (titulo, cuerpo) =>
  cuerpo ? `<div class="box"><div class="label">${esc(titulo)}</div><div>${cuerpo}</div></div>` : '';

const td = (v) => `<td style="padding:6px 8px;border:1px solid #e2e8f0">${v}</td>`;

// ───────────────────────── Podología ─────────────────────────

function podologiaHtml(p) {
  if (!p) return '';
  const hg = p.hallazgosGenerales || {};
  const vn = p.vascularNeurologica || {};
  const ev = p.evaluacion || {};

  const generales = inline([
    ...PODOLOGIA_HALLAZGOS_GENERALES.map((f) => [f.label, hg[f.key]]),
    ['Edema', hg.edema == null ? '' : hg.edema ? 'Sí' : 'No'],
  ]);
  const vascular = inline([
    ['Pulso pedio', optionLabel(vn.pulsoPedio)],
    ['Pulso tibial posterior', optionLabel(vn.pulsoTibialPosterior)],
    ['Llenado capilar', vn.llenadoCapilar],
    ['Sensibilidad (monofilamento)', optionLabel(vn.sensibilidadMonofilamento)],
    ['Reflejos', optionLabel(vn.reflejos)],
  ]);
  const evaluacion = inline(PODOLOGIA_EVALUACION.map((r) => [r.label, ev[r.key]]));
  const hallazgos = marcados(PODOLOGIA_HALLAZGOS, p.hallazgos).map(esc).join(', ');
  const detalle = String(p.hallazgosDetalle || '').trim();

  const cuerpo = [
    box('Hallazgos generales', generales),
    box('Evaluación vascular y neurológica', vascular),
    box('Evaluación podológica', evaluacion),
    box(
      'Hallazgos podológicos',
      [hallazgos, detalle ? `<div style="white-space:pre-wrap;margin-top:4px">${esc(detalle)}</div>` : '']
        .filter(Boolean)
        .join(''),
    ),
  ].join('');

  return cuerpo ? `<div class="label" style="margin-top:8px">Ficha podológica</div>${cuerpo}` : '';
}

// ───────────────────────── Cardiología ───────────────────────

function cardiologiaHtml(c) {
  if (!c) return '';
  const ecg = c.electrocardiograma || {};
  const est = c.estudios || {};
  const plan = c.plan || {};

  // Los antecedentes son de tres estados: se imprime lo que consta, y lo que
  // consta que NO también — que el paciente niegue ser hipertenso es un dato
  // clínico, no un hueco.
  const valor = (key) => {
    const a = (c.antecedentes || []).find((x) => x.key === key);
    return typeof a?.value === 'boolean' ? a.value : null;
  };
  const positivos = CARDIOLOGIA_ANTECEDENTES.filter((a) => valor(a.key) === true).map((a) => a.label);
  const negativos = CARDIOLOGIA_ANTECEDENTES.filter((a) => valor(a.key) === false).map((a) => a.label);

  const antecedentes = inline([
    ['Presenta', positivos.join(', ')],
    ['Niega', negativos.join(', ')],
    ['Otros', c.antecedentesOtros],
    ['Alergias', c.alergias],
  ]);
  const electro = inline([
    ['Ritmo', ecg.ritmo],
    ['FC', ecg.fc == null ? '' : `${ecg.fc} lpm`],
    ['Hallazgos', ecg.hallazgos],
  ]);
  const estudios = inline(CARDIOLOGIA_ESTUDIOS.map((e) => [e.label, est[e.key]]));
  const planTexto = inline([
    ['Estudios solicitados', plan.estudiosSolicitados],
    ['Próximo control', plan.proximoControl],
  ]);
  const medicacion = String(c.medicacionActual || '').trim();

  const cuerpo = [
    box('Antecedentes relevantes', antecedentes),
    box('Medicación actual', medicacion ? `<div style="white-space:pre-wrap">${esc(medicacion)}</div>` : ''),
    box('Electrocardiograma', electro),
    box('Estudios relevantes', estudios),
    box('Plan cardiológico', planTexto),
  ].join('');

  return cuerpo ? `<div class="label" style="margin-top:8px">Ficha cardiológica</div>${cuerpo}` : '';
}

// ──────────────────────── Odontología ────────────────────────

function odontologiaHtml(o) {
  if (!o) return '';
  const piezas = (o.odontograma || []).filter(
    (d) =>
      d &&
      (d.estado ||
        String(d.nota || '').trim() ||
        d.recesion ||
        d.movilidad ||
        Object.values(d.caras || {}).some(Boolean)),
  );
  const higiene = (o.higieneOral || []).filter((f) => f && (f.pieza || f.placa || f.calculo || f.gingivitis));
  const suma = (obj, cols) => cols.reduce((s, c) => s + (Number.parseInt(obj?.[c.key], 10) || 0), 0);
  const cpoTotal = suma(o.cpo, INDICE_CPO);
  const ceoTotal = suma(o.ceo, INDICE_CEO);
  // Se imprime si hay algo capturado, no si la suma es > 0: un CPO todo en ceros
  // es un hallazgo válido (paciente sin caries) y debe salir en la hoja.
  const hayCpo = INDICE_CPO.some((c) => String(o.cpo?.[c.key] ?? '') !== '');
  const hayCeo = INDICE_CEO.some((c) => String(o.ceo?.[c.key] ?? '') !== '');
  const indicadores = inline([
    ['Enfermedad periodontal', labelOf(ENFERMEDAD_PERIODONTAL, o.enfermedadPeriodontal) || ''],
    ['Maloclusión', labelOf(MALOCLUSION, o.maloclusion) || ''],
    ['Fluorosis', labelOf(FLUOROSIS, o.fluorosis) || ''],
  ]);
  const observaciones = String(o.observaciones || '').trim();
  if (!piezas.length && !higiene.length && !indicadores && !hayCpo && !hayCeo && !observaciones) return '';

  const filas = piezas
    .map((d) => {
      // Cada cara con SU estado: «Oclusal: Caries, Mesial: Obturado».
      const caras = ODONTOGRAMA_CARAS.filter((c) => d.caras?.[c.key])
        .map((c) => `${c.label}: ${labelOdonto(d.caras[c.key])}`)
        .join(', ');
      const grados = [d.recesion && `Recesión ${d.recesion}`, d.movilidad && `Movilidad ${d.movilidad}`]
        .filter(Boolean)
        .join(', ');
      return `<tr>${td(`<b>${esc(d.diente)}</b>`)}${td(esc(labelOdonto(d.estado) || '—'))}${td(esc(caras || '—'))}${td(esc(grados || '—'))}${td(esc(d.nota || '—'))}</tr>`;
    })
    .join('');

  const tabla = filas
    ? `<div class="label" style="margin-top:8px">Odontograma (FDI)</div><table><thead><tr><th>Pieza</th><th>Estado</th><th>Caras</th><th>Recesión / movilidad</th><th>Nota</th></tr></thead><tbody>${filas}</tbody></table>`
    : '';

  const filasHigiene = higiene
    .map((f) => {
      const def = HIGIENE_ORAL_FILAS.find((x) => x.key === f.fila);
      return `<tr>${td(esc(def?.label || f.fila))}${td(esc(f.pieza || '—'))}${td(esc(f.placa || '—'))}${td(esc(f.calculo || '—'))}${td(esc(f.gingivitis || '—'))}</tr>`;
    })
    .join('');
  // Los totales de la hoja son la suma de la columna, no un dato que se digite.
  const totales = HIGIENE_ORAL_INDICES.map((i) =>
    higiene.reduce((s, f) => s + (Number.parseInt(f[i.key], 10) || 0), 0),
  );
  const tablaHigiene = filasHigiene
    ? `<div class="label" style="margin-top:8px">Indicadores de salud bucal</div><table><thead><tr><th>Sextante</th><th>Pieza</th><th>Placa</th><th>Cálculo</th><th>Gingivitis</th></tr></thead><tbody>${filasHigiene}<tr>${td('<b>Totales</b>')}${td('')}${totales.map((t) => td(`<b>${t}</b>`)).join('')}</tr></tbody></table>`
    : '';

  const indices = [
    hayCpo ? `<b>CPO:</b> ${INDICE_CPO.map((c) => `${c.label} ${esc(o.cpo?.[c.key] || 0)}`).join(' · ')} — Total ${cpoTotal}` : '',
    hayCeo ? `<b>ceo:</b> ${INDICE_CEO.map((c) => `${c.label} ${esc(o.ceo?.[c.key] || 0)}`).join(' · ')} — Total ${ceoTotal}` : '',
  ]
    .filter(Boolean)
    .join('<br/>');

  return `${tabla}${tablaHigiene}${box('Evaluación', indicadores)}${box('Índices CPO-ceo', indices)}${
    observaciones ? box('Observaciones del odontograma', `<div style="white-space:pre-wrap">${esc(observaciones)}</div>`) : ''
  }`;
}

// ─────────────────────── Cosmetología ────────────────────────

function cosmetologiaHtml(c) {
  if (!c) return '';
  const de = c.datosEsteticos || {};
  const ev = c.evaluacion || {};
  const hi = c.higiene || {};
  const ca = c.cabello || {};
  const tr = ca.tratamientos || {};
  const cc = c.cueroCabelludo || {};
  const pr = c.procedimiento || {};

  const hiper = (ev.hiperpigmentaciones || [])
    .map((z) => {
      const zona = labelOf(COSMETOLOGIA_HIPERPIGMENTACION, z.key);
      const lados = [z.derecho && 'D', z.izquierdo && 'I'].filter(Boolean).join('/');
      return lados ? `${zona} (${lados})` : zona;
    })
    .map(esc)
    .join(', ');

  const evaluacion = inline([
    ['Fototipo', ev.fototipo],
    ['Glogau', ev.glogau],
    ['Rosácea (estadio)', ev.rosacea],
    ['Biotipo', marcados(COSMETOLOGIA_BIOTIPOS, ev.biotipo).join(', ')],
    ['Arrugas', marcados(COSMETOLOGIA_ARRUGAS, ev.arrugas).join(', ')],
    ['Acné', marcados(COSMETOLOGIA_ACNE, ev.acne).join(', ')],
    ['Lesiones elementales', marcados(COSMETOLOGIA_LESIONES, ev.lesionesElementales).join(', ')],
    ['Deshidratación facial', optionLabel(ev.deshidratacionFacial)],
    ['Bioestimulación', ev.bioestimulacion],
    ['Nutrición dérmica', ev.nutricionDermica],
  ]);
  // Las hiperpigmentaciones ya vienen escapadas: se añaden sin volver a escapar.
  const evaluacionCompleta = [evaluacion, hiper ? `<b>Hiperpigmentaciones:</b> ${hiper}` : '']
    .filter(Boolean)
    .join(' &nbsp;·&nbsp; ');

  const cuerpo = [
    box(
      'Datos estéticos',
      inline([
        ['Tratamientos estéticos', de.tratamientosEsteticos],
        ['Autotratamientos', de.autotratamientos],
        ['Cosméticos de uso actual', de.cosmeticosUsoActual],
      ]),
    ),
    box(
      'Evaluación',
      [
        evaluacionCompleta,
        ev.observaciones ? `<div style="white-space:pre-wrap;margin-top:4px">${esc(ev.observaciones)}</div>` : '',
      ]
        .filter(Boolean)
        .join(''),
    ),
    box(
      'Datos de higiene',
      inline([
        ['Frecuencia de lavado', hi.frecuenciaLavado],
        ['Shampoo', hi.shampoo],
        ['Acondicionador', hi.acondicionador],
        ['Otros', hi.otros],
      ]),
    ),
    box(
      'Características del cabello',
      inline([
        ...COSMETOLOGIA_CABELLO.map((f) => [f.label, optionLabel(ca[f.key])]),
        ['Tratamientos', COSMETOLOGIA_CABELLO_TRATAMIENTOS.filter((t) => tr[t.key]).map((t) => t.label).join(', ')],
      ]),
    ),
    box(
      'Características del cuero cabelludo',
      inline(COSMETOLOGIA_CUERO_CABELLUDO.map((f) => [f.label, optionLabel(cc[f.key])])),
    ),
    box('Alteración de la fibra capilar', marcados(COSMETOLOGIA_FIBRA_CAPILAR, c.fibraCapilar).map(esc).join(', ')),
    box('Afecciones del cuero cabelludo', marcados(COSMETOLOGIA_AFECCIONES_CUERO, c.afeccionesCuero).map(esc).join(', ')),
    box(
      'Procedimiento y productos utilizados',
      inline([
        ['Procedimiento', pr.procedimiento],
        ['Productos', pr.productos],
        ['Apoyo domiciliario', pr.apoyoDomiciliario],
      ]),
    ),
  ].join('');

  return cuerpo ? `<div class="label" style="margin-top:8px">Ficha cosmetológica</div>${cuerpo}` : '';
}

/**
 * FICHA DEL TERAPEUTA para el PDF.
 *
 * Sale en TEXTO, no como el gráfico de la pantalla: el pentágono con sus flechas
 * es una herramienta para pensar, y en un papel lo que hace falta es leer qué se
 * anotó en cada elemento. Cada uno con su nombre completo — en el papel no hay
 * colores que distingan las dos M.
 *
 * Ojo: este bloque solo llega al PDF de quien PUEDE ver la consulta del
 * terapeuta. El filtro está en el controlador (`esDelTerapeuta` /
 * `canReadTherapy`), no aquí: una función de pintar no es sitio para un permiso.
 */
function terapiaHtml(t) {
  if (!t) return '';
  const elementos = TERAPIA_ELEMENTOS
    .map((e) => {
      const dato = (t.elementos || []).find((x) => x.key === e.key);
      const texto = String(dato?.texto || '').trim();
      return texto ? [e.label, texto] : null;
    })
    .filter(Boolean);
  const cuadrantes = TERAPIA_FODA
    .map((c) => {
      const texto = String(t.foda?.[c.key] || '').trim();
      return texto ? [c.label, texto] : null;
    })
    .filter(Boolean);

  const cuerpo = [
    elementos.length ? box('Análisis de 5 elementos', inline(elementos)) : '',
    cuadrantes.length ? box('Plan de tratamiento terapéutico', inline(cuadrantes)) : '',
    box('Plan', esc(String(t.plan || '').trim())),
  ].join('');

  return cuerpo ? `<div class="label" style="margin-top:8px">Ficha de terapia</div>${cuerpo}` : '';
}

/** Todo lo que aporte la especialidad de este seguimiento ('' si no aporta nada). */
function specialtyFollowUpHtml(fu) {
  if (!fu) return '';
  return [
    cardiologiaHtml(fu.cardiologia),
    podologiaHtml(fu.podologia),
    odontologiaHtml(fu.odontologia),
    cosmetologiaHtml(fu.cosmetologia),
    terapiaHtml(fu.terapia),
  ].join('');
}

module.exports = { specialtyFollowUpHtml, cardiologiaHtml, podologiaHtml, odontologiaHtml, cosmetologiaHtml, terapiaHtml };
