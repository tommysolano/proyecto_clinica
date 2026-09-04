const mongoose = require('mongoose');

const patientSchema = new mongoose.Schema(
  {
    clinic: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Clinic',
      required: true,
      index: true,
    },
    cedula: {
      type: String,
      trim: true,
      default: '',
    },
    /**
     * NOMBRE Y APELLIDO NO SON OBLIGATORIOS. Al paciente se le registra con lo
     * que se tiene en el momento —a veces solo el teléfono de quien llamó, o la
     * cédula que trae en la mano— y se completa después. Exigirlos obligaba a
     * inventarse un nombre para poder guardar, que es peor dato que ninguno.
     *
     * Van con `default: ''` (y no sin valor) para que `fullName` y las búsquedas
     * por nombre no se topen con `undefined`.
     */
    firstName: {
      type: String,
      trim: true,
      uppercase: true,
      default: '',
    },
    lastName: {
      type: String,
      trim: true,
      uppercase: true,
      default: '',
    },
    email: { type: String, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    whatsapp: { type: String, trim: true },
    birthDate: { type: Date },
    age: { type: Number, min: 0, max: 150 },
    gender: { type: String, enum: ['masculino', 'femenino', 'otro'] },
    address: { type: String, trim: true },
    notes: { type: String, trim: true },
    // De dónde viene el paciente: anuncio, referido, recepción, orgánico
    source: {
      type: String,
      enum: ['anuncio', 'referido', 'recepcion', 'organico', ''],
      default: '',
    },
    sourceDetail: { type: String, trim: true },
    // Persona que refirió al paciente (cuando source === 'referido').
    // Puede ser un paciente o un miembro del personal; guardamos snapshot del nombre.
    referredByName: { type: String, trim: true, default: '' },
    referredById: { type: mongoose.Schema.Types.ObjectId, default: null },
    referredByType: { type: String, enum: ['patient', 'user', ''], default: '' },
    // Antecedentes
    antecedentesFamiliares: { type: String, trim: true, default: '' },
    antecedentesPatologicos: { type: String, trim: true, default: '' },
    tags: { type: [String], default: [], index: true },
    /**
     * Pacientes creados leyendo una ficha FÍSICA escaneada (/scanner).
     *
     * Es letra manuscrita, así que algunos campos se leen con dudas. En vez de
     * dejarlos fuera, el paciente se crea igual y aquí queda constancia de QUÉ hay
     * que revisar y contra QUÉ documento: la pantalla de revisión los lista con su
     * PDF al lado para corregirlos a mano.
     *
     * `revisadoAt` se sella al corregir; a partir de ahí el paciente sale de la lista.
     */
    scanImport: {
      scan: { type: mongoose.Schema.Types.ObjectId, ref: 'ScannedDocument', default: null },
      importadoAt: { type: Date, default: null },
      // Nombres de campo ('cedula', 'celular'…) que quedaron dudosos o vacíos.
      dudas: { type: [String], default: [] },
      // Lo que la IA leyó literalmente en los campos dudosos, para comparar con el PDF.
      crudo: { type: mongoose.Schema.Types.Mixed, default: null },
      /**
       * EL OTRO VALOR. Cuando la ficha física dice algo distinto de lo que ya
       * tiene el paciente, NO se pisa el dato bueno… pero tampoco se tira lo que
       * decía el papel: se guarda aquí y la ficha del paciente enseña los dos.
       *
       * Nace de la tanda de 6.000 fichas: el paciente ya existía (vino de
       * Contífico, con la cédula tecleada por una persona) y la transcripción de
       * la letra a mano difería en un carácter. Pisar habría degradado la base;
       * descartar habría ocultado el papel. Así quien revisa decide, con el PDF
       * al lado, cuál de los dos es el bueno.
       *
       * Es una LISTA porque un paciente puede tener varias fichas físicas, cada
       * una con su lectura. Se guarda de qué escaneo salió cada valor para poder
       * abrir ese PDF concreto.
       */
      alternos: {
        type: [
          {
            _id: false,
            // 'cedula' | 'celular' | 'correo' | 'direccion' | 'edad' | 'nombre'
            campo: { type: String, required: true },
            valor: { type: String, default: '' },
            scan: { type: mongoose.Schema.Types.ObjectId, ref: 'ScannedDocument', default: null },
            // Fecha escrita en esa ficha, para ordenar por antigüedad del papel.
            fecha: { type: Date, default: null },
          },
        ],
        default: [],
      },
      revisadoAt: { type: Date, default: null },
      revisadoBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    },
    marketing: {
      whatsappOptIn: { type: Boolean, default: true },
      emailOptIn: { type: Boolean, default: true },
      optOutAt: { type: Date, default: null },
      optOutReason: { type: String, trim: true, default: '' },
    },
    attribution: {
      utmSource: { type: String, trim: true, default: '' },
      utmMedium: { type: String, trim: true, default: '' },
      utmCampaign: { type: String, trim: true, default: '' },
      adId: { type: String, trim: true, default: '' },
      // Click-to-WhatsApp click id (anuncios Meta): matching fuerte para la
      // Conversions API — se traspasa desde la conversación al vincular paciente.
      ctwaClid: { type: String, trim: true, default: '' },
      firstTouchAt: { type: Date, default: null },
    },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Cédula única solo cuando está presente (sparse permite varios documentos sin cédula).
patientSchema.index(
  { cedula: 1 },
  { unique: true, partialFilterExpression: { cedula: { $type: 'string', $ne: '' } } }
);

// Nombre y apellido pueden faltar (ver arriba): sin el trim, un paciente sin
// apellido se leía como "MARÍA " y uno sin ninguno de los dos como " ", que en
// pantalla es una fila en blanco. Quien lo pinta decide qué poner si sale vacío.
patientSchema.virtual('fullName').get(function () {
  return `${this.firstName || ''} ${this.lastName || ''}`.trim();
});

/**
 * EDAD CALCULADA. Manda la fecha de nacimiento; el campo `age` es el respaldo
 * para quien se registró sin acordarse del día en que nació.
 *
 * Se cuenta POR CUMPLEAÑOS, no restando milisegundos: el reparto por duración se
 * equivoca en un año justo el día del cumpleaños, que es cuando alguien lo mira.
 *
 * Dos zonas horarias a la vez, y las dos a propósito:
 *  · la fecha de nacimiento se lee en UTC, porque así se guardó ('1990-05-10'
 *    entra como …T00:00:00Z); leída en hora de Ecuador (UTC-5) ese instante es
 *    la tarde del día 9 y todos cumplirían años un día antes;
 *  · «hoy» se lee en local, que es Ecuador (index.js fuerza process.env.TZ).
 *
 * Es el mismo cálculo que hace el formulario al teclear la fecha (ver
 * `edadDesdeFecha` en el cliente): si no coincidieran, la ficha diría una edad y
 * el formulario otra.
 */
patientSchema.virtual('computedAge').get(function () {
  if (this.birthDate) {
    const nacimiento = new Date(this.birthDate);
    const año = nacimiento.getUTCFullYear();
    const mes = nacimiento.getUTCMonth();
    const dia = nacimiento.getUTCDate();
    const hoy = new Date();
    let edad = hoy.getFullYear() - año;
    // Todavía no ha cumplido este año.
    if (hoy.getMonth() < mes || (hoy.getMonth() === mes && hoy.getDate() < dia)) edad -= 1;
    return edad < 0 ? null : edad;
  }
  return this.age ?? null;
});

patientSchema.set('toJSON', { virtuals: true });
patientSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Patient', patientSchema);
