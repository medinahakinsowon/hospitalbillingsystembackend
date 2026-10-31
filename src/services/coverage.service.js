import { env } from '../config/env.js';
import { Coverage } from '../models/Coverage.js';
import { Service } from '../models/Service.js';
import { Payer } from '../models/Payer.js';
import { Patient } from '../models/Patient.js';
import { AppError } from '../utils/AppError.js';
import { recordAudit, changedFields } from './audit.service.js';
import { checkServiceCoverage, resolvePrice } from './catalog.service.js';

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

  if (payer.type === 'family') {
    const capacity = payer.maxMembers ?? env.FAMILY_CARD_MAX_MEMBERS;
    const used = await Coverage.countDocuments({ payerId, status: 'active' });
    if (used >= capacity) throw new AppError(422, 'CARD_FULL', `This card already has its maximum of ${capacity} people`, { capacity, used });
  }

  // Duplicate active coverage is rejected by the partial unique index (409 DUPLICATE).
  const coverage = await Coverage.create({ ...data, payerId, createdBy: ctx.actorId });
  await recordAudit(ctx, {
    action: 'coverage.create', entity: 'Coverage', entityId: coverage._id,
    after: { payerId, patientId: data.patientId, relationship: data.relationship },
  });
  return coverage.toObject();
}

export async function listPayerCoverages(payerId, { status, page = 1, limit = 50 }) {
  const filter = { payerId, ...(status ? { status } : {}) };
  const [items, total] = await Promise.all([
    Coverage.find(filter).populate('patientId', 'hospitalNumber firstName lastName dob phone')
      .sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Coverage.countDocuments(filter),
  ]);
  return { items, page, limit, total };
}

/**
 * Add many people at once by hospital number (e.g. a company's staff list).
 * Each row succeeds or fails on its own; the response says what happened to every row.
 */
export async function bulkAddCoverage(payerId, members, ctx) {
  const payer = await Payer.findById(payerId).select('_id').lean();
  if (!payer) throw new AppError(404, 'PAYER_NOT_FOUND', 'Payer not found');
  const results = [];
  for (const [index, m] of members.entries()) {
    const row = { row: index + 1, hospitalNumber: m.hospitalNumber };
    try {
      const patient = await Patient.findOne({ hospitalNumber: m.hospitalNumber.toUpperCase(), deletedAt: null }).select('_id').lean();
      if (!patient) { results.push({ ...row, result: 'not_found', message: 'No patient with this hospital number' }); continue; }
      await addCoverage(payerId, {
        patientId: patient._id, relationship: m.relationship, employeeRef: m.employeeRef,
        memberLimitKobo: m.memberLimitKobo, validFrom: m.validFrom, validTo: m.validTo,
      }, ctx);
      results.push({ ...row, result: 'added' });
    } catch (err) {
      if (err.code === 11000 || err.code === 'DUPLICATE') results.push({ ...row, result: 'already_covered' });
      else results.push({ ...row, result: 'failed', code: err.code || err.name, message: err.message });
    }
  }
  const count = (r) => results.filter((x) => x.result === r).length;
  return { added: count('added'), alreadyCovered: count('already_covered'), notFound: count('not_found'), failed: count('failed'), results };
}

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

/**
 * Registration-time check: which payers can this patient use right now, and is each usable?
 * Pass serviceId (and qty) to also check that specific service: covered by the contract, its price, and whether it fits the payer's available limit.
 */
export async function getEligibility(patientId, { serviceId, qty = 1 } = {}) {
  const patient = await Patient.findOne({ _id: patientId, deletedAt: null }).select('hospitalNumber firstName lastName status').lean();
  if (!patient) throw new AppError(404, 'PATIENT_NOT_FOUND', 'Patient not found');
  const service = serviceId ? await Service.findById(serviceId).select('code name department category active').lean() : null;
  if (serviceId && !service) throw new AppError(404, 'SERVICE_NOT_FOUND', 'Service not found');

  const now = new Date();
  const coverages = await Coverage.find({ patientId, status: 'active', validFrom: { $lte: now } })
    .populate('payerId')
    .lean();

  const options = [];
  for (const c of coverages.filter((x) => x.payerId && (!x.validTo || x.validTo >= now))) {
    const p = c.payerId;
    const found = payerReasons(p, now);
    const option = {
      coverageId: c._id, relationship: c.relationship, memberLimitKobo: c.memberLimitKobo,
      payer: { id: p._id, type: p.type, mode: p.mode, code: p.code, name: p.name, status: p.status },
      availableKobo: p.enforceLimit ? p.creditLimitKobo - p.balanceKobo : null,
      eligible: found.length === 0, reasons: found.map((r) => r.message), reasonCodes: found.map((r) => r.code),
    };
    if (service) {
      const cover = checkServiceCoverage(p, service);
      option.service = { code: service.code, name: service.name, covered: cover.covered, coverageReason: cover.reason ?? null, priceKobo: null, totalKobo: null, withinLimit: null };
      if (cover.covered) {
        try {
          const price = await resolvePrice(p, service._id, now);
          option.service.priceKobo = price.priceKobo;
          option.service.totalKobo = price.priceKobo * qty;
          option.service.withinLimit = option.availableKobo === null || option.availableKobo >= option.service.totalKobo;
        } catch (err) {
          if (err.code !== 'PRICE_NOT_FOUND') throw err;
          option.service.priceError = 'No price set';
        }
      }
    }
    options.push(option);
  }
  return { patient, options };
}
