const mongoose = require('mongoose');

/**
 * ACCIONISTA / SOCIO / PARTÍCIPE de la sociedad — composición societaria.
 *
 * Alimenta el ANEXO DE ACCIONISTAS, PARTÍCIPES, SOCIOS, MIEMBROS DEL DIRECTORIO Y
 * ADMINISTRADORES (APS) que el SRI exige a las sociedades. A diferencia del 103/104 y del
 * RDEP —que se CALCULAN de compras, ventas y nóminas—, esta información no existe en ningún
 * otro punto del sistema: se captura aquí y de aquí sale el anexo.
 *
 * Reglas del anexo que este modelo hace cumplibles:
 *   - La suma de `porcentajeParticipacion` de los titulares de capital VIGENTES debe dar 100 %.
 *     (Se valida al generar el anexo, no al guardar cada titular: durante la captura es normal
 *     que la suma esté incompleta.)
 *   - Un miembro del directorio / administrador puede tener 0 % (no es titular de capital).
 *   - Residencia y paraíso fiscal condicionan la retención de dividendos (103), por eso se piden.
 */

// Calidad en la que la persona figura en el anexo.
const ROLES = ['ACCIONISTA', 'SOCIO', 'PARTICIPE', 'MIEMBRO_DIRECTORIO', 'ADMINISTRADOR', 'BENEFICIARIO_EFECTIVO'];
// Solo estas calidades son titulares de capital: son las que deben sumar 100 %.
const CAPITAL_ROLES = ['ACCIONISTA', 'SOCIO', 'PARTICIPE'];

const shareholderSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    tipoPersona: { type: String, enum: ['NATURAL', 'JURIDICA'], default: 'NATURAL' },
    tipoIdentificacion: { type: String, enum: ['CEDULA', 'RUC', 'PASAPORTE'], default: 'CEDULA' },
    identificacion: { type: String, required: true, trim: true },
    // Apellidos y nombres (persona natural) o razón social (sociedad).
    razonSocial: { type: String, required: true, trim: true },
    role: { type: String, enum: ROLES, default: 'ACCIONISTA' },
    // Residencia fiscal. El anexo la pide y decide la tarifa de retención de dividendos.
    paisResidencia: { type: String, trim: true, default: 'ECUADOR' },
    // Régimen fiscal preferente / paraíso fiscal (retención de dividendos distinta).
    paraisoFiscal: { type: Boolean, default: false },
    // Participación en el capital (0–100). Los miembros del directorio van en 0.
    porcentajeParticipacion: { type: Number, default: 0, min: 0, max: 100 },
    capitalInvertido: { type: Number, default: 0, min: 0 },
    numeroAcciones: { type: Number, default: 0, min: 0 },
    // Vigencia: `fechaHasta` con valor = ya no es titular (queda para el histórico del anexo).
    fechaDesde: { type: Date, default: null },
    fechaHasta: { type: Date, default: null },
    active: { type: Boolean, default: true },
    notes: { type: String, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Una persona no puede figurar dos veces con la misma calidad en la misma sociedad.
shareholderSchema.index({ clinic: 1, identificacion: 1, role: 1 }, { unique: true });

/** ¿El titular estaba vigente al corte indicado? (sin `fechaHasta` o posterior al corte) */
shareholderSchema.methods.vigenteAl = function vigenteAl(cutoff) {
  if (!this.active) return false;
  const d = cutoff ? new Date(cutoff) : new Date();
  if (this.fechaDesde && new Date(this.fechaDesde) > d) return false;
  if (this.fechaHasta && new Date(this.fechaHasta) < d) return false;
  return true;
};

module.exports = mongoose.model('Shareholder', shareholderSchema);
module.exports.ROLES = ROLES;
module.exports.CAPITAL_ROLES = CAPITAL_ROLES;
