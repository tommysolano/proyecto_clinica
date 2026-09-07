/**
 * SUEROS DUPLICADOS EN LA FICHA — diagnóstico y limpieza.
 *
 * ─── QUÉ PASÓ ──────────────────────────────────────────────────────────────────
 * El suero de serie de un servicio se escribe solo en la ficha del paciente, y la
 * cita pasa por tres puertas que pueden escribirlo: agendarla, corregirle el
 * servicio y asignar la atención. La marca `Appointment.autoSerumFollowUp` existe
 * para que se escriba UNA vez... pero la puerta de en medio no la anotaba, así
 * que la tercera volvía a escribir la MISMA bolsa. En la ficha aparecían dos y se
 * lee como que al paciente le recetaron dos sueros.
 *
 * El arreglo (7-sep-2026) cierra la puerta, pero no borra lo ya escrito. Esto es
 * para ver el tamaño real del problema y, si se quiere, limpiarlo.
 *
 * ─── HASTA DÓNDE LLEGA (y por qué no más) ──────────────────────────────────────
 * Se borra de una historia clínica, así que el script es deliberadamente cobarde:
 *
 *  · Solo mira seguimientos ESCRITOS POR EL SISTEMA — los que tienen uno de los
 *    motivos que pone `utils/sueroDeCita.js`. Lo que escribió un médico a mano no
 *    se toca nunca, aunque parezca repetido.
 *  · Solo agrupa los del MISMO paciente, el MISMO día y con la MISMA composición
 *    (bolsa base + ampollas + cantidades). Dos bolsas distintas el mismo día son
 *    dos indicaciones de verdad.
 *  · Del grupo se conserva SIEMPRE el más antiguo.
 *  · Y no se borra ninguno que tenga una APLICACIÓN registrada: si enfermería ya
 *    lo puso, eso movió inventario y es lo que de verdad pasó. Esos se reportan
 *    aparte, para mirarlos a mano.
 *
 * ─── USO ───────────────────────────────────────────────────────────────────────
 *   node scripts/diagnoseDuplicateSerums.js              (DRY-RUN: solo informa)
 *   node scripts/diagnoseDuplicateSerums.js --commit     (borra los sobrantes)
 *   node scripts/diagnoseDuplicateSerums.js --clinic=<id>
 */
const { parseArgs, connect, disconnect, banner } = require('./_common');
const ClinicalRecord = require('../models/ClinicalRecord');
const Patient = require('../models/Patient');

/**
 * Motivos con los que el sistema escribe un suero (ver `sueroDeCita.js` y
 * `appointmentController`). Se comparan por prefijo porque llevan el nombre del
 * servicio detrás.
 */
const MOTIVOS_AUTOMATICOS = [
  'suero indicado al agendar',
  'suero del servicio',
  'suero indicado al asignar la atención',
];

const esAutomatico = (fu) => {
  const motivo = String(fu?.motivoConsulta || fu?.descripcion || '').trim().toLowerCase();
  return MOTIVOS_AUTOMATICOS.some((m) => motivo.startsWith(m));
};

/** Día local 'YYYY-MM-DD' de un seguimiento (el proceso corre en hora de Ecuador). */
function diaDe(fu) {
  const d = fu.fecha ? new Date(fu.fecha) : (fu.createdAt ? new Date(fu.createdAt) : null);
  if (!d || Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Huella de la bolsa: nombre + base + ampollas con su cantidad, ordenadas. Dos
 * seguimientos con la misma huella el mismo día son la misma indicación escrita
 * dos veces.
 */
function huellaDelSuero(item) {
  const comps = (item.serumComponents || [])
    .map((c) => `${String(c.code || c.name || '').trim().toLowerCase()}x${Number(c.quantity || 1)}`)
    .sort()
    .join('+');
  const base = `${String(item.serumBase?.name || '').trim().toLowerCase()}:${item.serumBase?.volumeMl || ''}`;
  return `${String(item.name || '').trim().toLowerCase()}|${base}|${comps}`;
}

const yaAplicado = (item) => (item.administrations || []).length > 0;

/** Diagnóstico puro (sin conectar/desconectar): es lo que ejercitan las pruebas. */
async function diagnose({ clinic = null } = {}) {
  const filtro = clinic ? { clinic } : {};
  const records = await ClinicalRecord.find(filtro).lean();

  const grupos = [];   // duplicados que se pueden limpiar
  const revisar = [];  // duplicados con alguna aplicación: a mano

  for (const rec of records) {
    // clave (día + huella) → seguimientos automáticos con ese suero
    const porSuero = new Map();
    for (const fu of rec.followUps || []) {
      if (!esAutomatico(fu)) continue;
      for (const item of fu.recetaItems || []) {
        if (!item.isSerum) continue;
        const clave = `${diaDe(fu)}|${huellaDelSuero(item)}`;
        if (!porSuero.has(clave)) porSuero.set(clave, []);
        porSuero.get(clave).push({ fu, item });
      }
    }

    for (const [clave, entradas] of porSuero) {
      if (entradas.length < 2) continue;
      // El más antiguo se queda; los demás sobran.
      const ordenadas = [...entradas].sort(
        (a, b) => new Date(a.fu.createdAt || a.fu.fecha || 0) - new Date(b.fu.createdAt || b.fu.fecha || 0)
      );
      const [conservar, ...sobrantes] = ordenadas;
      const borrables = sobrantes.filter((s) => !yaAplicado(s.item));
      const aplicados = sobrantes.filter((s) => yaAplicado(s.item));

      const comun = {
        record: rec._id,
        patient: rec.patient,
        clave,
        nombre: conservar.item.name || '',
        dia: diaDe(conservar.fu),
        total: entradas.length,
        conservar: conservar.fu._id,
      };
      if (borrables.length) grupos.push({ ...comun, borrar: borrables.map((s) => s.fu._id) });
      if (aplicados.length) revisar.push({ ...comun, aplicados: aplicados.map((s) => s.fu._id) });
    }
  }

  return { grupos, revisar, revisados: records.length };
}

/** Borra los seguimientos sobrantes que el diagnóstico marcó como seguros. */
async function limpiar(grupos) {
  let borrados = 0;
  for (const g of grupos) {
    // eslint-disable-next-line no-await-in-loop
    const rec = await ClinicalRecord.findById(g.record);
    if (!rec) continue;
    for (const id of g.borrar) {
      const fu = rec.followUps.id(id);
      // Se vuelve a comprobar sobre el documento vivo: entre el diagnóstico y el
      // borrado alguien puede haber aplicado esa bolsa.
      if (!fu || !esAutomatico(fu)) continue;
      if ((fu.recetaItems || []).some((i) => yaAplicado(i))) continue;
      fu.deleteOne();
      borrados += 1;
    }
    // eslint-disable-next-line no-await-in-loop
    await rec.save();
  }
  return borrados;
}

async function main() {
  const { commit, clinic, dryRun } = parseArgs();
  banner('Sueros duplicados en la ficha', { dryRun, clinic });
  await connect();
  try {
    const { grupos, revisar, revisados } = await diagnose({ clinic });
    console.log(`Fichas revisadas: ${revisados}`);
    console.log(`Grupos duplicados que se pueden limpiar: ${grupos.length}`);
    console.log(`Grupos con alguna aplicación ya registrada (a mano): ${revisar.length}\n`);

    const nombresDe = async (lista) => {
      const ids = [...new Set(lista.map((g) => String(g.patient)))];
      const pacientes = await Patient.find({ _id: { $in: ids } }).select('firstName lastName').lean();
      return new Map(pacientes.map((p) => [String(p._id), `${p.firstName || ''} ${p.lastName || ''}`.trim()]));
    };

    if (grupos.length) {
      const nombres = await nombresDe(grupos);
      console.log('— Duplicados limpiables —');
      for (const g of grupos) {
        console.log(
          `  ${g.dia}  ${nombres.get(String(g.patient)) || g.patient}  «${g.nombre}»  ` +
          `${g.total} copias → sobran ${g.borrar.length}`
        );
      }
      console.log('');
    }
    if (revisar.length) {
      const nombres = await nombresDe(revisar);
      console.log('— Duplicados YA APLICADOS (no se tocan: movieron inventario) —');
      for (const g of revisar) {
        console.log(
          `  ${g.dia}  ${nombres.get(String(g.patient)) || g.patient}  «${g.nombre}»  ` +
          `aplicados: ${g.aplicados.length}`
        );
      }
      console.log('');
    }

    if (!commit) {
      console.log('DRY-RUN: no se borró nada. Repite con --commit para limpiar los limpiables.');
    } else if (grupos.length) {
      const borrados = await limpiar(grupos);
      console.log(`Seguimientos borrados: ${borrados}`);
    } else {
      console.log('No hay nada que limpiar.');
    }
  } finally {
    await disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { diagnose, limpiar, esAutomatico, huellaDelSuero };
