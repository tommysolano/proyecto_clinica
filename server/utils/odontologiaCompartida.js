/**
 * LA AGENDA DE ODONTOLOGÍA ES DE TODOS LOS ODONTÓLOGOS (sep-2026).
 *
 * Lo pidieron ellos: una cita asignada a un odontólogo le salía solo a él, y en
 * el consultorio el paciente lo atiende quien esté libre —o varios, uno detrás
 * de otro—. Ahora la cita de CUALQUIER odontólogo sale en la agenda de todos, y
 * cualquiera de ellos puede entrar a atenderla.
 *
 * SOLO el rol 'odontologia', enumerado. No va por `isDoctorRole`: el resto de
 * médicos (y odontología neurofocal, que es otra consulta) siguen viendo solo
 * sus citas. Y el turno NO cambia de dueño: la cita sigue a nombre de quien se
 * le asignó (comisiones, reportes); el seguimiento lleva el nombre de quien lo
 * escribió.
 */
const ROL_COMPARTIDO = 'odontologia';

const esOdontologiaCompartida = (role) => role === ROL_COMPARTIDO;

/** Ids de todos los usuarios que tienen el rol en alguna sucursal. */
async function idsDeOdontologos() {
  const User = require('../models/User');
  const usuarios = await User.find({ 'clinics.role': ROL_COMPARTIDO }).select('_id').lean();
  return usuarios.map((u) => u._id);
}

/**
 * Sedes donde ESTE usuario es odontólogo: en ellas ve la agenda entera. La
 * activa entra siempre (el rol del token ya es 'odontologia' ahí).
 */
async function sedesDeOdontologia(req) {
  const User = require('../models/User');
  const u = await User.findById(req.user._id).select('clinics').lean();
  const sedes = (u?.clinics || [])
    .filter((c) => c.role === ROL_COMPARTIDO && c.clinic)
    .map((c) => String(c.clinic));
  if (req.clinicId) sedes.push(String(req.clinicId));
  const mongoose = require('mongoose');
  return [...new Set(sedes)].map((id) => new mongoose.Types.ObjectId(id));
}

const idDe = (v) => (v && typeof v === 'object' && v._id ? String(v._id) : v ? String(v) : '');

/**
 * ¿El turno de doctor que tiene la pelota AHORA es de un odontólogo?
 *
 * Es la pregunta de «¿puedo entrar a esta cita aunque no sea mía?». Con
 * `ids` se ahorra la consulta cuando el llamador ya los tiene.
 */
async function turnoVigenteEsDeOdontologia(apt, ids = null) {
  const { turnoVigente } = require('./appointmentTurns');
  const vigente = turnoVigente(apt);
  const dueno = vigente && vigente.kind === 'doctor'
    ? idDe(vigente.user)
    : (!(apt?.turns || []).length ? idDe(apt?.doctor) : '');
  if (!dueno) return false;
  const pool = ids || (await idsDeOdontologos());
  return pool.some((id) => String(id) === dueno);
}

module.exports = {
  ROL_COMPARTIDO,
  esOdontologiaCompartida,
  idsDeOdontologos,
  sedesDeOdontologia,
  turnoVigenteEsDeOdontologia,
};
