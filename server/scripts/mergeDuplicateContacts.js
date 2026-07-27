/**
 * Fusiona las fichas REPETIDAS de un mismo teléfono.
 *
 * POR QUÉ EXISTEN: `Contact` es único por (SEDE, teléfono), no por teléfono. Si dos
 * importaciones mandaron el mismo número a sucursales distintas (la columna
 * "Sucursal" del Excel), la misma persona quedó como DOS contactos. Eso mandaba el
 * mismo mensaje dos veces —Meta cobra los dos— y partía los datos de la campaña
 * entre las dos fichas: el recordatorio salía con el {{servicio}} y la {{hora}} del
 * Excel VIEJO.
 *
 * El código ya no crea gemelos y el envío ya no duplica aunque existan, pero en el
 * CRM se siguen viendo dos contactos de la misma persona con datos distintos. Esto
 * los deja en uno.
 *
 * CÓMO FUSIONA (la ficha que se queda es la MÁS ANTIGUA: es la que tiene el
 * histórico y a la que apuntan las inscripciones y los grupos):
 *   - Campos vacíos de la que se queda se rellenan con los de la repetida.
 *   - `customFields` (las columnas del Excel): gana el valor de la ficha
 *     ACTUALIZADA más recientemente — es el dato de la última campaña.
 *   - Etiquetas y grupos: se suman sin repetir.
 *   - Consentimiento: si CUALQUIERA está dada de baja, la fusionada queda de baja
 *     (nunca se resucita un opt-out).
 *   - `patient`: se conserva el que haya (si las dos tienen uno distinto, NO se
 *     fusiona y se avisa: eso es un caso a mirar a mano).
 *
 *   node scripts/mergeDuplicateContacts.js            (dry-run: informe)
 *   node scripts/mergeDuplicateContacts.js --commit   (aplica)
 */
const { parseArgs, connect, disconnect, banner } = require('./_common');
const Contact = require('../models/Contact');

/** Mapa plano de customFields (acepta Map de mongoose u objeto suelto). */
function cfOf(doc) {
  const cf = doc.customFields;
  if (!cf) return {};
  if (cf instanceof Map) return Object.fromEntries(cf);
  return { ...cf };
}

async function run() {
  const opts = parseArgs();
  banner('Fusión de contactos repetidos (mismo teléfono en varias sedes)', opts);

  await connect();
  try {
    const dups = await Contact.aggregate([
      { $group: { _id: '$phone', ids: { $push: '$_id' }, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
    ]);
    console.log(`Teléfonos con más de una ficha: ${dups.length}`);
    if (!dups.length) return;

    let merged = 0;
    let skipped = 0;

    for (const d of dups) {
      // eslint-disable-next-line no-await-in-loop
      const fichas = await Contact.find({ phone: d._id }).sort({ createdAt: 1 });
      const base = fichas[0];              // la más antigua: se queda
      const resto = fichas.slice(1);

      // Dos pacientes DISTINTOS enlazados: no se toca, es decisión humana.
      const pacientes = new Set(fichas.map((f) => String(f.patient || '')).filter(Boolean));
      if (pacientes.size > 1) {
        console.log(`  ⚠ ${d._id}: fichas enlazadas a pacientes distintos (${[...pacientes].join(', ')}) — se deja como está`);
        skipped++;
        continue;
      }

      // customFields: gana la ficha tocada más recientemente (última campaña).
      const porFecha = [...fichas].sort((a, b) => new Date(a.updatedAt || 0) - new Date(b.updatedAt || 0));
      const cf = {};
      for (const f of porFecha) Object.assign(cf, cfOf(f));

      const tags = new Set(base.tags || []);
      const groups = new Set((base.groups || []).map(String));
      let optOutAt = base.marketing?.optOutAt || null;
      let optOutReason = base.marketing?.optOutReason || '';
      let whatsappOptIn = base.marketing?.whatsappOptIn !== false;
      let emailOptIn = base.marketing?.emailOptIn !== false;

      for (const f of resto) {
        (f.tags || []).forEach((t) => tags.add(t));
        (f.groups || []).forEach((g) => groups.add(String(g)));
        // Campos de identidad: se rellena solo lo que falta.
        for (const k of ['firstName', 'lastName', 'displayName', 'email', 'notes']) {
          if (!String(base[k] || '').trim() && String(f[k] || '').trim()) base[k] = f[k];
        }
        if (!base.patient && f.patient) {
          base.patient = f.patient;
          base.convertedAt = base.convertedAt || f.convertedAt;
        }
        // El opt-out NUNCA se resucita.
        if (f.marketing?.optOutAt && (!optOutAt || f.marketing.optOutAt < optOutAt)) {
          optOutAt = f.marketing.optOutAt;
          optOutReason = f.marketing.optOutReason || optOutReason;
        }
        if (f.marketing?.whatsappOptIn === false) whatsappOptIn = false;
        if (f.marketing?.emailOptIn === false) emailOptIn = false;
      }

      const nombre = `${base.firstName || ''} ${base.lastName || ''}`.trim() || base.displayName || '(sin nombre)';
      console.log(
        `  ${d._id} — ${nombre}: ${fichas.length} fichas → 1` +
        `  ·  ${JSON.stringify(cf)}${optOutAt ? '  ·  DE BAJA' : ''}`
      );

      if (opts.commit) {
        base.customFields = cf;
        base.tags = [...tags];
        base.groups = [...groups];
        base.marketing = {
          ...(base.marketing?.toObject ? base.marketing.toObject() : base.marketing || {}),
          whatsappOptIn,
          emailOptIn,
          optOutAt,
          optOutReason,
        };
        // eslint-disable-next-line no-await-in-loop
        await base.save();
        // eslint-disable-next-line no-await-in-loop
        await Contact.deleteMany({ _id: { $in: resto.map((f) => f._id) } });
      }
      merged++;
    }

    console.log(`\nFusionados: ${merged}   ·   Sin tocar (revisar a mano): ${skipped}`);
    if (!opts.commit) console.log('\nDRY-RUN: no se escribió nada. Repite con --commit para aplicar.');
  } finally {
    await disconnect();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
