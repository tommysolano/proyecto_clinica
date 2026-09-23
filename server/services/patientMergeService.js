const mongoose = require('mongoose');

const Patient = require('../models/Patient');
const PatientMerge = require('../models/PatientMerge');
const ClinicalRecord = require('../models/ClinicalRecord');
const PatientObservation = require('../models/PatientObservation');
const Appointment = require('../models/Appointment');
const AgentTask = require('../models/AgentTask');
const Call = require('../models/Call');
const Contact = require('../models/Contact');
const Conversation = require('../models/Conversation');
const DeferredIncome = require('../models/DeferredIncome');
const EmailSend = require('../models/EmailSend');
const Quotation = require('../models/Quotation');
const Referral = require('../models/Referral');
const ReviewRequest = require('../models/ReviewRequest');
const Sale = require('../models/Sale');
const ScheduledMessage = require('../models/ScheduledMessage');
const Treatment = require('../models/Treatment');
const WorkflowEnrollment = require('../models/WorkflowEnrollment');
const WorkflowTriggerEvent = require('../models/WorkflowTriggerEvent');
const Payment = require('../models/Payment');
const CashFlowManualItem = require('../models/CashFlowManualItem');
const Receivable = require('../models/Receivable');
const Payable = require('../models/Payable');
const CashFlowMapping = require('../models/CashFlowMapping');

const PATIENT_MODELS = [
  Appointment,
  AgentTask,
  Call,
  Contact,
  Conversation,
  DeferredIncome,
  EmailSend,
  PatientObservation,
  Quotation,
  Referral,
  ReviewRequest,
  Sale,
  ScheduledMessage,
  Treatment,
  WorkflowEnrollment,
  WorkflowTriggerEvent,
];

const PATIENT_SKIP = new Set([
  '_id', '__v', 'clinic', 'active', 'mergedInto', 'mergedAt', 'mergedBy',
  'createdAt', 'updatedAt', 'cedula', 'identificationAliases', 'tags', 'marketing',
]);
const RECORD_SKIP = new Set([
  '_id', '__v', 'clinic', 'patient', 'followUps', 'createdAt', 'updatedAt',
]);

const isObjectId = (v) => v instanceof mongoose.Types.ObjectId;
const isPlainObject = (v) =>
  v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !isObjectId(v);
const isEmpty = (v) =>
  v === null || v === undefined || (typeof v === 'string' && !v.trim()) ||
  (Array.isArray(v) && v.length === 0) || (isPlainObject(v) && Object.keys(v).length === 0);

const arrayItemKey = (item) => {
  if (!isPlainObject(item)) return `value:${String(item)}`;
  if (item._id) return `_id:${String(item._id)}`;
  if (item.key) return `key:${item.key}`;
  if (item.fila) return `fila:${item.fila}`;
  if (item.diente) return `diente:${item.diente}`;
  if (item.organo) return `organo:${item.organo}`;
  if (item.campo || item.scan) return `alterno:${item.campo || ''}:${item.scan || ''}`;
  if (item.code || item.name) return `named:${item.code || ''}:${item.name || ''}`;
  return `json:${JSON.stringify(item)}`;
};

function mergeArrays(primary, secondary) {
  const out = primary.map((item) => item);
  const positions = new Map(out.map((item, index) => [arrayItemKey(item), index]));
  for (const item of secondary) {
    const key = arrayItemKey(item);
    const index = positions.get(key);
    if (index === undefined) {
      positions.set(key, out.length);
      out.push(item);
    } else if (isPlainObject(out[index]) && isPlainObject(item)) {
      out[index] = fillMissing(out[index], item);
    }
  }
  return out;
}

/** Rellena huecos de `primary` sin pisar ningún valor ya elegido. */
function fillMissing(primary, secondary) {
  if (isEmpty(primary)) return secondary;
  if (Array.isArray(primary) && Array.isArray(secondary)) return mergeArrays(primary, secondary);
  if (!isPlainObject(primary) || !isPlainObject(secondary)) return primary;
  const out = { ...primary };
  for (const [key, value] of Object.entries(secondary)) {
    out[key] = key in out ? fillMissing(out[key], value) : value;
  }
  return out;
}

const uniqStrings = (values) => [...new Set(values.map((v) => String(v || '').trim()).filter(Boolean))];
const mergeText = (...values) => uniqStrings(values).join('\n\n');

function mergePatientProfile(target, source) {
  const merged = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (PATIENT_SKIP.has(key)) continue;
    merged[key] = key in merged ? fillMissing(merged[key], value) : value;
  }

  merged.tags = uniqStrings([...(target.tags || []), ...(source.tags || [])]);
  // En estos campos dos textos distintos pueden ser verdaderos a la vez. No se
  // descarta el del duplicado: se anexan ambos, sin repetirlos.
  for (const field of ['notes', 'antecedentesFamiliares', 'antecedentesPatologicos']) {
    merged[field] = mergeText(target[field], source[field]);
  }
  const primaryId = String(target.cedula || source.cedula || '').trim();
  merged.cedula = primaryId;
  merged.identificationAliases = uniqStrings([
    ...(target.identificationAliases || []),
    ...(source.identificationAliases || []),
    target.cedula,
    source.cedula,
  ]).filter((id) => id !== primaryId);

  // Consentimiento conservador: si cualquiera de las dos fichas pidió no ser
  // contactada, la ficha unificada sigue respetando esa decisión.
  const tm = target.marketing || {};
  const sm = source.marketing || {};
  merged.marketing = fillMissing(tm, sm);
  merged.marketing.whatsappOptIn = tm.whatsappOptIn !== false && sm.whatsappOptIn !== false;
  merged.marketing.emailOptIn = tm.emailOptIn !== false && sm.emailOptIn !== false;
  const optOuts = [tm.optOutAt, sm.optOutAt].filter(Boolean).map((d) => new Date(d));
  if (optOuts.length) merged.marketing.optOutAt = new Date(Math.min(...optOuts));
  merged.marketing.optOutReason = uniqStrings([tm.optOutReason, sm.optOutReason]).join(' · ');

  merged.active = true;
  return merged;
}

function mergeClinicalRecords(targetRecord, sourceRecord, targetPatientId) {
  if (!targetRecord && !sourceRecord) return null;
  const base = targetRecord ? { ...targetRecord } : { ...sourceRecord, patient: targetPatientId };
  if (targetRecord && sourceRecord) {
    for (const [key, value] of Object.entries(sourceRecord)) {
      if (RECORD_SKIP.has(key)) continue;
      base[key] = key in base ? fillMissing(base[key], value) : value;
    }
  }
  const seen = new Set();
  base.followUps = [
    ...(targetRecord?.followUps || []),
    ...(sourceRecord?.followUps || []),
  ].filter((fu) => {
    const key = String(fu?._id || '');
    if (key && seen.has(key)) return false;
    if (key) seen.add(key);
    return true;
  }).sort((a, b) => new Date(a.fecha || a.createdAt || 0) - new Date(b.fecha || b.createdAt || 0));
  base.patient = targetPatientId;
  return base;
}

const queryOptions = (session) => (session ? { session } : {});

/** Ejecuta con transacción donde Mongo la soporte (producción y tests usan replica set). */
async function atomically(work) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await work(session); });
    return result;
  } catch (error) {
    const unsupported = /Transaction numbers are only allowed|Transactions are not supported|not supported.*transaction|replica set/i;
    if (!unsupported.test(error.message || '')) throw error;
    return work(null);
  } finally {
    await session.endSession();
  }
}

async function updatePatientReferences(sourceId, targetId, session) {
  const moved = {};
  for (const Model of PATIENT_MODELS) {
    // eslint-disable-next-line no-await-in-loop
    const result = await Model.updateMany(
      { patient: sourceId },
      { $set: { patient: targetId } },
      queryOptions(session)
    );
    moved[Model.modelName] = result.modifiedCount || 0;
  }

  const special = [
    [Payment, { partyModel: 'Patient', partyRef: sourceId }, { partyRef: targetId }],
    [CashFlowManualItem, { partyModel: 'Patient', partyRef: sourceId }, { partyRef: targetId }],
    [Receivable, { 'party.model': 'Patient', 'party.ref': sourceId }, { 'party.ref': targetId }],
    [Payable, { 'party.model': 'Patient', 'party.ref': sourceId }, { 'party.ref': targetId }],
    [Patient, { referredByType: 'patient', referredById: sourceId }, { referredById: targetId }],
  ];
  for (const [Model, filter, patch] of special) {
    // eslint-disable-next-line no-await-in-loop
    const result = await Model.updateMany(filter, { $set: patch }, queryOptions(session));
    moved[`${Model.modelName}:special`] = result.modifiedCount || 0;
  }

  // Estas reglas tienen índice único por paciente/sede/dirección. Si ya existe
  // una regla para el perfil principal, se conserva esa y se elimina la repetida.
  const sourceMappings = await CashFlowMapping.find({
    matchType: 'CUSTOMER', matchValue: String(sourceId),
  }).session(session || null);
  let mappingCount = 0;
  for (const mapping of sourceMappings) {
    // eslint-disable-next-line no-await-in-loop
    const duplicate = await CashFlowMapping.findOne({
      _id: { $ne: mapping._id },
      clinic: mapping.clinic,
      direction: mapping.direction,
      matchType: 'CUSTOMER',
      matchValue: String(targetId),
    }).session(session || null);
    if (duplicate) {
      // eslint-disable-next-line no-await-in-loop
      await CashFlowMapping.deleteOne({ _id: mapping._id }, queryOptions(session));
    } else {
      mapping.matchValue = String(targetId);
      // eslint-disable-next-line no-await-in-loop
      await mapping.save(queryOptions(session));
    }
    mappingCount += 1;
  }
  moved.CashFlowMapping = mappingCount;
  return moved;
}

async function mergePatients({ targetPatientId, sourcePatientId, clinicId, userId }) {
  if (!mongoose.Types.ObjectId.isValid(targetPatientId) || !mongoose.Types.ObjectId.isValid(sourcePatientId)) {
    const error = new Error('Identificador de paciente no válido');
    error.status = 400;
    throw error;
  }
  if (String(targetPatientId) === String(sourcePatientId)) {
    const error = new Error('Selecciona dos pacientes diferentes');
    error.status = 400;
    throw error;
  }

  return atomically(async (session) => {
    const [target, source] = await Promise.all([
      Patient.findById(targetPatientId).session(session || null).lean(),
      Patient.findById(sourcePatientId).session(session || null).lean(),
    ]);
    if (!target || !target.active) {
      const error = new Error('El paciente que deseas conservar no existe o ya fue fusionado');
      error.status = 404;
      throw error;
    }
    if (!source || !source.active) {
      const error = new Error('El paciente duplicado no existe o ya fue fusionado');
      error.status = 404;
      throw error;
    }

    const [audit] = await PatientMerge.create([{
      clinic: clinicId,
      targetPatient: target._id,
      sourcePatient: source._id,
      mergedBy: userId,
      targetSnapshot: target,
      sourceSnapshot: source,
      status: 'RUNNING',
    }], queryOptions(session));

    const [targetRecord, sourceRecord] = await Promise.all([
      ClinicalRecord.findOne({ patient: target._id }).session(session || null).lean(),
      ClinicalRecord.findOne({ patient: source._id }).session(session || null).lean(),
    ]);
    const combinedRecord = mergeClinicalRecords(targetRecord, sourceRecord, target._id);
    if (combinedRecord) {
      if (targetRecord) {
        const { _id, ...recordData } = combinedRecord;
        await ClinicalRecord.collection.updateOne(
          { _id: targetRecord._id }, { $set: recordData }, queryOptions(session)
        );
      } else {
        const { _id, ...recordData } = combinedRecord;
        await ClinicalRecord.collection.updateOne(
          { _id: sourceRecord._id }, { $set: recordData }, queryOptions(session)
        );
      }
      if (targetRecord && sourceRecord) {
        await ClinicalRecord.deleteOne({ _id: sourceRecord._id }, queryOptions(session));
      }
    }

    const profile = mergePatientProfile(target, source);
    // Si el principal no tenía identificación, primero se libera la del
    // duplicado para no chocar con el índice único al trasladarla.
    if (!target.cedula && source.cedula) {
      await Patient.updateOne({ _id: source._id }, { $set: { cedula: '' } }, queryOptions(session));
    }
    const profilePatch = { ...profile };
    for (const key of ['_id', '__v', 'createdAt', 'updatedAt']) delete profilePatch[key];
    await Patient.updateOne({ _id: target._id }, { $set: profilePatch }, queryOptions(session));

    const moved = await updatePatientReferences(source._id, target._id, session);
    moved.ClinicalRecord = sourceRecord ? 1 : 0;
    moved.followUps = sourceRecord?.followUps?.length || 0;

    await Patient.updateOne(
      { _id: source._id },
      {
        $set: {
          active: false,
          cedula: '',
          identificationAliases: [],
          mergedInto: target._id,
          mergedAt: new Date(),
          mergedBy: userId,
        },
      },
      queryOptions(session)
    );
    audit.status = 'DONE';
    audit.moved = moved;
    await audit.save(queryOptions(session));

    return { targetPatientId: String(target._id), sourcePatientId: String(source._id), moved };
  });
}

module.exports = {
  mergePatients,
  mergePatientProfile,
  mergeClinicalRecords,
  fillMissing,
};
