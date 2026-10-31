import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { withTransaction } from '../config/db.js';
import { Patient } from '../models/Patient.js';
import { Payer } from '../models/Payer.js';
import { Coverage } from '../models/Coverage.js';
import { AppError } from '../utils/AppError.js';
import { nextSequence, pad } from '../utils/counters.js';
import { normalizePhone } from '../utils/phone.js';
import { escapeRegex } from '../utils/escapeRegex.js';
import { recordAudit, changedFields } from './audit.service.js';

const searchNameOf = (p) => [p.lastName, p.firstName, p.otherNames].filter(Boolean).join(' ').toLowerCase();

/**
 * Registers a patient AND their personal ("self") payer and coverage in one transaction,
 * so walk-ins use exactly the same charge and ledger flow as corporate and family patients.
 */
export async function createPatient(data, ctx) {
  const { confirmNotDuplicate, ...fields } = data;
  fields.phone = normalizePhone(fields.phone);
  if (fields.nextOfKin?.phone) fields.nextOfKin.phone = normalizePhone(fields.nextOfKin.phone);

  if (!confirmNotDuplicate) {
    const candidates = await Patient.find({
      deletedAt: null,
      dob: fields.dob,
      $or: [{ phone: fields.phone }, { searchName: searchNameOf(fields) }],
    })
      .select('hospitalNumber firstName lastName dob phone')
      .limit(5)
      .lean();
    if (candidates.length) {
      throw new AppError(409, 'POSSIBLE_DUPLICATE',
        'A patient with matching details may already exist. Resend with confirmNotDuplicate: true if this is a different person.',
        candidates);
    }
  }

  return withTransaction(async (session) => {
    const hospitalNumber = `${env.HOSPITAL_NUMBER_PREFIX}-${pad(await nextSequence('patient', session))}`;
    const payerCode = `IND-${pad(await nextSequence('payer:individual', session))}`;
    const patientId = new mongoose.Types.ObjectId();
    const payerId = new mongoose.Types.ObjectId();

    await Payer.create([{
      _id: payerId, type: 'individual', code: payerCode, name: `${fields.firstName} ${fields.lastName}`,
      enforceLimit: false, holderPatientId: patientId, createdBy: ctx.actorId,
    }], { session });

    const [patient] = await Patient.create([{
      _id: patientId, hospitalNumber, ...fields, selfPayerId: payerId, createdBy: ctx.actorId,
    }], { session });

    await Coverage.create([{
      payerId, patientId, relationship: 'self', validFrom: new Date(), createdBy: ctx.actorId,
    }], { session });

    await recordAudit(ctx, { action: 'patient.create', entity: 'Patient', entityId: patientId, after: { hospitalNumber } }, session);
    return patient.toObject();
  });
}

export async function listPatients({ q, page, limit }) {
  const filter = { deletedAt: null };
  if (q) {
    const term = q.trim();
    if (/^[a-z]{1,6}-?\d+$/i.test(term)) {
      filter.hospitalNumber = new RegExp(`^${escapeRegex(term)}`, 'i');
    } else if (/^[\d+\s-]{4,}$/.test(term)) {
      filter.phone = new RegExp(`^${escapeRegex(normalizePhone(term))}`);
    } else {
      filter.searchName = new RegExp(`(^|\\s)${escapeRegex(term.toLowerCase())}`);
    }
  }
  const [items, total] = await Promise.all([
    Patient.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Patient.countDocuments(filter),
  ]);
  return { items, page, limit, total };
}

export async function getPatient(id, ctx) {
  const patient = await Patient.findOne({ _id: id, deletedAt: null }).lean();
  if (!patient) throw new AppError(404, 'PATIENT_NOT_FOUND', 'Patient not found');
  // Viewing a medical-adjacent record is itself auditable.
  await recordAudit(ctx, { action: 'patient.view', entity: 'Patient', entityId: patient._id });
  return patient;
}

const UPDATABLE = ['firstName', 'lastName', 'otherNames', 'dob', 'sex', 'phone', 'email', 'address', 'nextOfKin', 'status'];

export async function updatePatient(id, patch, ctx) {
  const patient = await Patient.findOne({ _id: id, deletedAt: null });
  if (!patient) throw new AppError(404, 'PATIENT_NOT_FOUND', 'Patient not found');
  if (patch.phone) patch.phone = normalizePhone(patch.phone);

  const before = patient.toObject();
  const diff = changedFields(before, patch, UPDATABLE);
  if (!Object.keys(diff.after).length) return before;

  patient.set(diff.after);
  await patient.save();
  await recordAudit(ctx, { action: 'patient.update', entity: 'Patient', entityId: patient._id, ...diff });
  return patient.toObject();
}
