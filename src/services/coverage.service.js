import { Coverage } from '../models/Coverage.js';
import { Payer } from '../models/Payer.js';
import { Patient } from '../models/Patient.js';
import { AppError } from '../utils/AppError.js';
import { recordAudit, changedFields } from './audit.service.js';

const ALLOWED_RELATIONSHIPS = {
  corporate: ['employee', 'dependant'],
  family: ['member'], // the card holder is added automatically when the card is created
  individual: [],     // the patient's own coverage is created automatically at registration
};

export async function addCoverage(payerId, data, ctx) {
  const payer = await Payer.findById(payerId).lean();
  if (!payer) throw new AppError(404, 'PAYER_NOT_FOUND', 'Payer not found');
  if (payer.status !== 'active') throw new AppError(422, 'PAYER_NOT_ACTIVE', `Payer is ${payer.status}`);
  if (!ALLOWED_RELATIONSHIPS[payer.type].includes(data.relationship)) {
    throw new AppError(422, 'INVALID_RELATIONSHIP',
      `Relationship '${data.relationship}' is not valid for a ${payer.type} payer. Allowed: ${ALLOWED_RELATIONSHIPS[payer.type].join(', ') || 'none (added automatically)'}`);
  }
  const patient = await Patient.findOne({ _id: data.patientId, deletedAt: null }).lean();
  if (!patient) throw new AppError(404, 'PATIENT_NOT_FOUND', 'Patient not found');

  // Duplicate active coverage is rejected by the partial unique index (409 DUPLICATE).
  const coverage = await Coverage.create({ ...data, payerId, createdBy: ctx.actorId });
  await recordAudit(ctx, {
    action: 'coverage.create', entity: 'Coverage', entityId: coverage._id,
    after: { payerId, patientId: data.patientId, relationship: data.relationship },
  });
  return coverage.toObject();
}

export const listPayerCoverages = (payerId, { status }) =>
  Coverage.find({ payerId, ...(status ? { status } : {}) })
    .populate('patientId', 'hospitalNumber firstName lastName dob phone')
    .sort({ createdAt: -1 })
    .lean();

export const listPatientCoverages = (patientId) =>
  Coverage.find({ patientId })
    .populate('payerId', 'type code name status mode')
    .sort({ createdAt: -1 })
    .lean();

const UPDATABLE = ['status', 'validTo', 'memberLimitKobo', 'employeeRef'];

export async function updateCoverage(id, patch, ctx) {
  const coverage = await Coverage.findById(id);
  if (!coverage) throw new AppError(404, 'COVERAGE_NOT_FOUND', 'Coverage not found');
  if (coverage.relationship === 'self' && patch.status && patch.status !== 'active') {
    throw new AppError(422, 'NOT_ALLOWED', "A patient's own coverage cannot be deactivated");
  }
  const before = coverage.toObject();
  const diff = changedFields(before, patch, UPDATABLE);
  if (!Object.keys(diff.after).length) return before;
  coverage.set(diff.after);
  await coverage.save();
  await recordAudit(ctx, { action: 'coverage.update', entity: 'Coverage', entityId: coverage._id, ...diff });
  return coverage.toObject();
}

/**
 * Why a payer cannot currently be used. Codes let callers decide what is a hard block:
 * LIMIT_REACHED is advisory here because the ledger enforces limits exactly, at the moment of charging.
 */
export function payerReasons(payer, at = new Date()) {
  const reasons = [];
  if (payer.status !== 'active') reasons.push({ code: 'PAYER_INACTIVE', message: `Payer is ${payer.status}` });
  if (payer.type === 'corporate' && payer.contract) {
    if (payer.contract.startsAt && payer.contract.startsAt > at) reasons.push({ code: 'CONTRACT_NOT_STARTED', message: 'Contract has not started' });
    if (payer.contract.endsAt && payer.contract.endsAt < at) reasons.push({ code: 'CONTRACT_EXPIRED', message: 'Contract has expired' });
  }
  if (payer.enforceLimit && payer.creditLimitKobo - payer.balanceKobo <= 0) {
    reasons.push({
      code: 'LIMIT_REACHED',
      message: payer.type === 'family' && payer.mode === 'prepaid' ? 'Deposit balance is empty' : 'Credit limit reached',
    });
  }
  return reasons;
}

/** Is this patient covered by this payer right now, and is the payer usable? */
export async function assessEligibility(patientId, payerId, at = new Date()) {
  const payer = await Payer.findById(payerId).lean();
  if (!payer) throw new AppError(404, 'PAYER_NOT_FOUND', 'Payer not found');
  const coverage = await Coverage.findOne({
    patientId, payerId, status: 'active', validFrom: { $lte: at },
    $or: [{ validTo: null }, { validTo: { $gte: at } }],
  }).lean();
  if (!coverage) {
    return {
      covered: false, eligible: false, payer, coverage: null,
      reasons: ['Patient is not covered by this payer'], reasonCodes: ['NOT_COVERED'],
    };
  }
  const found = payerReasons(payer, at);
  return {
    covered: true, eligible: found.length === 0, payer, coverage,
    reasons: found.map((r) => r.message), reasonCodes: found.map((r) => r.code),
  };
}

/** Registration-time check: which payers can this patient use right now, and is each usable? */
export async function getEligibility(patientId) {
  const patient = await Patient.findOne({ _id: patientId, deletedAt: null }).select('hospitalNumber firstName lastName status').lean();
  if (!patient) throw new AppError(404, 'PATIENT_NOT_FOUND', 'Patient not found');

  const now = new Date();
  const coverages = await Coverage.find({ patientId, status: 'active', validFrom: { $lte: now } })
    .populate('payerId')
    .lean();

  const options = coverages
    .filter((c) => c.payerId && (!c.validTo || c.validTo >= now))
    .map((c) => {
      const p = c.payerId;
      const found = payerReasons(p, now);
      return {
        coverageId: c._id, relationship: c.relationship, memberLimitKobo: c.memberLimitKobo,
        payer: { id: p._id, type: p.type, mode: p.mode, code: p.code, name: p.name, status: p.status },
        availableKobo: p.enforceLimit ? p.creditLimitKobo - p.balanceKobo : null,
        eligible: found.length === 0, reasons: found.map((r) => r.message), reasonCodes: found.map((r) => r.code),
      };
    });
  return { patient, options };
}
