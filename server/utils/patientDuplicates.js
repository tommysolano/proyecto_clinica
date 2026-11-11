/**
 * ¿YA ESTÁ REGISTRADA ESTA PERSONA? (nov-2026)
 *
 * Caso real: «ABEL DARÍO PONCE MARTÍNEZ» entró por el chat (sin cédula, con
 * tildes, teléfono 593961211936) y una hora después recepción lo volvió a
 * registrar como «ABEL DARIO PONCE MARTINEZ» con cédula y el MISMO celular
 * escrito 0961211936. El alta general (POST /patients) no miraba nada salvo la
 * cédula, así que salieron dos fichas y el buscador enseñaba «dos personas».
 *
 * Aquí se buscan las fichas que probablemente son la misma persona:
 *  - MISMO NOMBRE: las mismas palabras, sin tildes ni eñes y en cualquier orden
 *    («PONCE MARTINEZ ABEL DARIO» = «Abel Darío Ponce Martínez»).
 *  - MISMO TELÉFONO (en cualquier formato, también entre los «otros» números)
 *    y al menos dos palabras del nombre en común — un teléfono compartido por
 *    la madre y el hijo NO es la misma persona, y avisar de cada familiar
 *    convertiría el aviso en ruido que se acaba ignorando.
 *
 * Dos fichas con cédulas DISTINTAS (las dos puestas) nunca son la misma
 * persona: homónimos de verdad, no se avisa.
 *
 * No prohíbe nada: quien llama decide (el cliente pregunta y reenvía con
 * `confirmDuplicate: true`).
 */
const { nameSearchFilter, palabrasDe } = require('./nameSearch');
const { colaTelefono } = require('./patientIdentity');

const clave = (p) => palabrasDe(`${p.firstName || ''} ${p.lastName || ''}`).sort().join(' ');

async function posiblesDuplicados(datos, { excluirId = null, limite = 5 } = {}) {
  const Patient = require('../models/Patient');
  const palabras = palabrasDe(`${datos.firstName || ''} ${datos.lastName || ''}`);
  const cedula = String(datos.cedula || '').trim();
  const colas = [...new Set(
    [datos.phone, datos.whatsapp, ...(datos.otherPhones || [])]
      .map(colaTelefono)
      .filter((c) => c.length >= 7)
  )];

  const base = { active: { $ne: false }, mergedInto: null, ...(excluirId ? { _id: { $ne: excluirId } } : {}) };
  const ors = [];
  // Un nombre de una sola palabra («MARIA») casaría con medio sistema.
  if (palabras.length >= 2) {
    const f = nameSearchFilter(palabras.join(' '), ['firstName', 'lastName']);
    if (f) ors.push(f);
  }
  for (const c of colas) {
    const re = { $regex: `${c}$` };
    ors.push({ phone: re }, { whatsapp: re }, { otherPhones: re });
  }
  if (!ors.length) return [];

  const candidatos = await Patient.find({ ...base, $or: ors })
    .select('firstName lastName cedula phone whatsapp otherPhones createdAt')
    .limit(50)
    .lean();

  const buscada = palabras.slice().sort().join(' ');
  const mias = new Set(palabras);
  const out = [];
  for (const p of candidatos) {
    const suCedula = String(p.cedula || '').trim();
    if (cedula && suCedula && suCedula !== cedula) continue; // dos cédulas = dos personas
    const mismoNombre = palabras.length >= 2 && clave(p) === buscada;
    const susColas = [p.phone, p.whatsapp, ...(p.otherPhones || [])].map(colaTelefono).filter(Boolean);
    const mismoTelefono = colas.some((c) => susColas.includes(c));
    const suyas = palabrasDe(`${p.firstName || ''} ${p.lastName || ''}`);
    const comunes = suyas.filter((w) => mias.has(w)).length;
    const sinNombre = suyas.length === 0;
    if (!mismoNombre && !(mismoTelefono && (comunes >= 2 || sinNombre))) continue;
    out.push({
      _id: p._id,
      name: `${p.firstName || ''} ${p.lastName || ''}`.trim() || '(sin nombre)',
      // Solo los 4 últimos dígitos: basta para reconocer el dato sin enseñar
      // el contacto completo a quien no tiene esa capacidad.
      cedulaTail: suCedula ? suCedula.slice(-4) : '',
      phoneTail: String(p.phone || p.whatsapp || '').replace(/\D/g, '').slice(-4),
      createdAt: p.createdAt,
      motivo: mismoNombre && mismoTelefono ? 'nombre y teléfono' : mismoNombre ? 'nombre' : 'teléfono',
    });
    if (out.length >= limite) break;
  }
  return out;
}

module.exports = { posiblesDuplicados };
