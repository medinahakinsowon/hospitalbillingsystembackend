import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { can } from '../config/permissions.js';
import { withTransaction } from '../config/db.js';
import { Authorization } from '../models/Authorization.js';
import { Charge } from '../models/Charge.js';
import { Coverage } from '../models/Coverage.js';
import { Encounter } from '../models/Encounter.js';
import { Patient } from '../models/Patient.js';
import { Payer } from '../models/Payer.js';
import { Service } from '../models/Service.js';
import { AppError } from '../utils/AppError.js';
import { assertKobo } from '../utils/money.js';
import { assessEligibility } from './coverage.service.js';
import { checkServiceCoverage, resolvePrice, serviceKeys } from './catalog.service.js';
import { postLedgerEntry, reverseLedgerEntryInTx } from './ledger.service.js';
import { startOfYearWat } from './billing-cycle.service.js';
import { recordAudit } from './audit.service.js';

const CONTRACT_CODES = ['CONTRACT_NOT_STARTED', 'CONTRACT_EXPIRED'];

// ------------------------------------------------------------------ co-payment
/** Does this payer's co-pay rule apply to this service? Individual payers never have one. */
export function copayApplies(payer, service) {
  const c = payer.copay;
  if (payer.type === 'individual' || !c || !(c.patientSharePercent > 0)) return false;
  const list = (c.appliesTo || []).map((x) => String(x).toLowerCase());
  return !list.length || serviceKeys(service).some((k) => list.includes(k));
}

/**
 * Split a price between the payer and the patient. The patient's share is rounded to the nearest kobo
 * and the payer takes the remainder, so the two shares always add up to the full price exactly.
 */
export function computeShares({ payer, service, totalKobo, selfPayer }) {
  if (!selfPayer || String(selfPayer._id) === String(payer._id) || !copayApplies(payer, service)) {
    return [{ payer, shareKobo: totalKobo, role: 'payer', percent: 100 }];
  }
  const pct = payer.copay.patientSharePercent;
  const patientShare = Math.round((totalKobo * pct) / 100);
  const payerShare = totalKobo - patientShare;
  const out = [];
  if (payerShare > 0) out.push({ payer, shareKobo: payerShare, role: 'payer', percent: 100 - pct });
  if (patientShare > 0) out.push({ payer: selfPayer, shareKobo: patientShare, role: 'copay', percent: pct });
  return out.length ? out : [{ payer, shareKobo: totalKobo, role: 'payer', percent: 100 }];
}

/** Price a service for a payer and work out who pays what. Writes nothing. */
async function quote({ payer, service, qty, patientId, session }) {
  const cover = checkServiceCoverage(payer, service);
  const patient = await Patient.findById(patientId).select('selfPayerId').session(session ?? null).lean();
  if (!cover.covered) {
    throw new AppError(422, 'SERVICE_NOT_COVERED',
      `${service.code} is ${cover.reason === 'excluded' ? 'excluded from' : 'not covered by'} this payer's contract. Charge it to the patient's own account instead.`,
      { selfPayerId: patient?.selfPayerId });
  }
  const price = await resolvePrice(payer, service._id);
  const totalKobo = assertKobo(price.priceKobo * qty, 'total');
  const selfPayer = copayApplies(payer, service) ? await Payer.findById(patient.selfPayerId).session(session ?? null).lean() : null;
  return { price, totalKobo, shares: computeShares({ payer, service, totalKobo, selfPayer }) };
}

/** All checks that must pass before money is recorded. Does not write anything. */
async function prepareCharge({ encounter, payerId, service, qty }) {
  const payer = await Payer.findById(payerId).lean();
  if (!payer) throw new AppError(404, 'PAYER_NOT_FOUND', 'Payer not found');
  if (!service.active) throw new AppError(422, 'SERVICE_INACTIVE', `Service ${service.code} is not active`);

  const assess = await assessEligibility(encounter.patientId, payerId);
  if (!assess.covered) throw new AppError(422, 'NOT_COVERED', 'This patient is not covered by that payer');

  // Limits are enforced exactly by the ledger. Here we only block on status and contract problems.
  // In an emergency we treat first, so expired or not-yet-started contracts do not block care.
  let blockers = assess.reasonCodes.filter((c) => c !== 'LIMIT_REACHED');
  if (encounter.type === 'emergency') blockers = blockers.filter((c) => !CONTRACT_CODES.includes(c));
  if (blockers.length) throw new AppError(422, 'PAYER_NOT_USABLE', 'This payer cannot be charged right now', assess.reasons);

  return { payer, ...(await quote({ payer, service, qty, patientId: encounter.patientId })) };
}

// ------------------------------------------------------------------ member limits and authorizations
/**
 * A member's limit covers everything charged to them under this payer in the calendar year (Lagos time).
 * Concurrent charges for the same limited member are serialised by writing to their coverage record first.
 */
async function enforceMemberLimit(session, { encounter, payer, shareKobo, allowOverLimit }) {
  if (payer.type === 'individual') return;
  const cov = await Coverage.findOne({ payerId: payer._id, patientId: encounter.patientId, status: 'active' }).session(session);
  if (!cov || cov.memberLimitKobo === null || cov.memberLimitKobo === undefined) return;
  await Coverage.updateOne({ _id: cov._id }, { $inc: { usageVersion: 1 } }, { session });
  const [agg] = await Charge.aggregate([
    { $match: { payerId: payer._id, patientId: encounter.patientId, status: 'posted', capturedAt: { $gte: startOfYearWat() } } },
    { $group: { _id: null, used: { $sum: '$totalKobo' } } },
  ]).session(session);
  const usedKobo = agg?.used ?? 0;
  if (!allowOverLimit && usedKobo + shareKobo > cov.memberLimitKobo) {
    throw new AppError(422, 'MEMBER_LIMIT_EXCEEDED', 'This charge would exceed the member\'s limit for the year', {
      memberLimitKobo: cov.memberLimitKobo, usedKobo, requestedKobo: shareKobo, remainingKobo: Math.max(0, cov.memberLimitKobo - usedKobo),
    });
  }
}

/** Expensive services need a payer's pre-approval. Uses up an approved authorization atomically. */
async function consumeAuthorization(session, { encounter, payer, service, shareKobo, emergency }) {
  if (payer.type === 'individual') return {};
  const needed = service.requiresAuthorization || (payer.authorizationThresholdKobo > 0 && shareKobo > payer.authorizationThresholdKobo);
  if (!needed) return {};

  const base = {
    payerId: payer._id, patientId: encounter.patientId, status: 'approved', expiresAt: { $gt: new Date() },
    $expr: { $gte: [{ $subtract: ['$approvedAmountKobo', '$usedKobo'] }, shareKobo] },
    $or: [{ encounterId: encounter._id }, { encounterId: null }],
  };
  for (const scope of [{ serviceId: service._id }, { serviceId: null }]) { // an approval for this exact service first
    const auth = await Authorization.findOneAndUpdate({ ...base, ...scope }, { $inc: { usedKobo: shareKobo } }, { returnDocument: 'after', session });
    if (auth) return { authorizationId: auth._id };
  }
  if (emergency) return { authorizationBypassed: true }; // treat first; billing follows up with the payer
  throw new AppError(422, 'AUTHORIZATION_REQUIRED', 'This service needs an approved authorization from the payer first', {
    payerId: payer._id, serviceCode: service.code, payerShareKobo: shareKobo,
    thresholdKobo: payer.authorizationThresholdKobo, serviceRequiresAuthorization: Boolean(service.requiresAuthorization),
  });
}

// ------------------------------------------------------------------ posting
/** Post one share of a charge: ledger entry + charge record. Must run inside a transaction. */
async function postChargeInTx(session, p, ctx) {
  const chargeId = new mongoose.Types.ObjectId();
  const base = `${p.service.name}${p.qty > 1 ? ` x${p.qty}` : ''}`;
  const note = p.splitRole ? ` (${p.sharePercent}% ${p.splitRole === 'copay' ? 'patient co-pay' : 'covered by plan'})` : '';
  const { entry } = await postLedgerEntry({
    payerId: p.payer._id, type: 'charge', amountKobo: p.shareKobo, description: (base + note).slice(0, 300),
    refType: 'charge', refId: chargeId, encounterId: p.encounter._id,
    idempotencyKey: `charge:${chargeId}`, createdBy: ctx.actorId, allowOverLimit: p.allowOverLimit, forceEnforce: p.forceEnforce,
  }, session);

  const [charge] = await Charge.create([{
    _id: chargeId, encounterId: p.encounter._id, patientId: p.encounter.patientId, payerId: p.payer._id, serviceId: p.service._id,
    serviceCode: p.service.code, description: (base + note).slice(0, 200), department: p.service.department,
    qty: p.qty, unitPriceKobo: p.price.priceKobo, totalKobo: p.shareKobo, fullTotalKobo: p.fullTotalKobo,
    sharePercent: p.splitRole ? p.sharePercent : undefined, splitGroupId: p.splitGroupId, splitRole: p.splitRole,
    tariffId: p.price.tariffId, tariffItemId: p.price.tariffItemId, priceSource: p.price.source,
    authorizationId: p.authorizationId, authorizationBypassed: p.authorizationBypassed || false,
    ledgerEntryId: entry._id, idempotencyKey: p.idempotencyKey, overrideReason: p.overrideReason, capturedBy: ctx.actorId,
  }], { session });
  return charge;
}

/** Record every share of a priced service (one charge, or payer share + patient co-pay). Inside a transaction. */
async function postShares(session, { encounter, service, qty, price, totalKobo, shares, allowOverLimit, emergency, idempotencyKey, overrideReason }, ctx) {
  const split = shares.length > 1;
  const splitGroupId = split ? new mongoose.Types.ObjectId() : undefined;
  const charges = [];
  for (const [i, share] of shares.entries()) {
    let extra = {};
    if (share.role === 'payer') {
      await enforceMemberLimit(session, { encounter, payer: share.payer, shareKobo: share.shareKobo, allowOverLimit });
      extra = await consumeAuthorization(session, { encounter, payer: share.payer, service, shareKobo: share.shareKobo, emergency });
    }
    // Deposit-first policy for walk-ins (also covers a patient's co-pay share). Never applied to emergencies.
    const forceEnforce = share.payer.type === 'individual' && env.WALKIN_PAYMENT_POLICY === 'before' && !allowOverLimit;
    try {
      charges.push(await postChargeInTx(session, {
        encounter, payer: share.payer, service, qty, price, shareKobo: share.shareKobo, fullTotalKobo: totalKobo,
        sharePercent: share.percent, splitGroupId, splitRole: split ? share.role : undefined,
        allowOverLimit, forceEnforce, idempotencyKey: i === 0 ? idempotencyKey : undefined, overrideReason, ...extra,
      }, ctx));
    } catch (err) {
      if (err.code === 'CREDIT_LIMIT_EXCEEDED' && forceEnforce) {
        const d = err.details;
        throw new AppError(422, 'DEPOSIT_REQUIRED', 'The patient must pay a deposit before this service is recorded', {
          requiredKobo: d.requestedKobo - d.availableKobo, depositHeldKobo: d.availableKobo, chargeKobo: d.requestedKobo,
        });
      }
      throw err;
    }
  }
  return charges;
}

export async function captureCharge(input, ctx) {
  const { encounterId, serviceId, qty = 1, payerId: requestedPayerId, idempotencyKey, overrideLimit = false, overrideReason } = input;

  if (idempotencyKey) {
    const existing = await Charge.findOne({ idempotencyKey }).lean();
    if (existing) {
      if (String(existing.encounterId) !== String(encounterId) || String(existing.serviceId) !== String(serviceId) || existing.qty !== qty) {
        throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key was already used for a different charge');
      }
      const charges = await Charge.find(existing.splitGroupId ? { splitGroupId: existing.splitGroupId } : { _id: existing._id }).sort({ _id: 1 }).lean();
      return { charge: existing, charges, duplicate: true };
    }
  }

  const encounter = await Encounter.findById(encounterId).lean();
  if (!encounter) throw new AppError(404, 'ENCOUNTER_NOT_FOUND', 'Encounter not found');
  if (encounter.status !== 'open') throw new AppError(422, 'ENCOUNTER_CLOSED', `Encounter is ${encounter.status}; charges can only be added to open encounters`);
  const service = await Service.findById(serviceId).lean();
  if (!service) throw new AppError(404, 'SERVICE_NOT_FOUND', 'Service not found');

  const payerId = requestedPayerId ?? encounter.primaryPayerId;
  const { payer, price, totalKobo, shares } = await prepareCharge({ encounter, payerId, service, qty });

  const emergency = encounter.type === 'emergency';
  let allowOverLimit = emergency; // treat first, bill later
  if (overrideLimit) {
    if (!can(ctx.actorRole, 'charges:override')) throw new AppError(403, 'FORBIDDEN', 'You are not allowed to override credit limits');
    if (!overrideReason) throw new AppError(400, 'REASON_REQUIRED', 'A reason is required to override a limit');
    allowOverLimit = true;
  }

  const charges = await withTransaction(async (session) => {
    const posted = await postShares(session, { encounter, service, qty, price, totalKobo, shares, allowOverLimit, emergency, idempotencyKey, overrideReason }, ctx);
    for (const c of posted) {
      await recordAudit(ctx, {
        action: 'charge.create', entity: 'Charge', entityId: c._id,
        after: { encounterId, payerId: c.payerId, serviceCode: service.code, qty, totalKobo: c.totalKobo, fullTotalKobo: totalKobo, splitRole: c.splitRole },
        meta: {
          ...(allowOverLimit && (overrideLimit || emergency) ? { limitOverride: overrideLimit ? 'manual' : 'emergency', reason: overrideReason } : {}),
          ...(c.authorizationBypassed ? { authorizationBypassed: true } : {}),
        },
      }, session);
    }
    return posted.map((c) => c.toObject());
  });
  return { charge: charges[0], charges, duplicate: false };
}

export async function listCharges(encounterId) {
  const items = await Charge.find({ encounterId }).sort({ capturedAt: 1, _id: 1 }).lean();
  const postedTotalKobo = items.filter((c) => c.status === 'posted').reduce((s, c) => s + c.totalKobo, 0);
  return { items, postedTotalKobo };
}

/**
 * Reverse one charge: ledger entry, the charge record, and any authorization amount it used.
 * Credit notes pass allowInvoiced to reverse a charge that is already on an invoice; voids never do.
 */
export async function reverseCharge(session, charge, { reason, allowInvoiced = false }, ctx) {
  await reverseLedgerEntryInTx({ entryId: charge.ledgerEntryId, reason }, ctx, session);
  const r = await Charge.updateOne(
    { _id: charge._id, status: 'posted', ...(allowInvoiced ? {} : { invoiceId: null }) },
    { $set: { status: 'reversed', reversalReason: reason, reversedAt: new Date(), reversedBy: ctx.actorId } },
    { session }
  );
  if (r.modifiedCount !== 1) throw new AppError(409, 'CHARGE_CHANGED', 'Charge changed while reversing. Please retry.');
  if (charge.authorizationId) {
    await Authorization.updateOne({ _id: charge.authorizationId, usedKobo: { $gte: charge.totalKobo } }, { $inc: { usedKobo: -charge.totalKobo } }, { session });
  }
}

/** The whole co-payment group a charge belongs to (just the charge itself when it was not split). */
async function groupOf(session, charge) {
  return charge.splitGroupId ? Charge.find({ splitGroupId: charge.splitGroupId }).session(session) : [charge];
}

/** Void charges that have not been invoiced yet. A split charge is voided as a whole. Invoiced charges need a credit note. */
export async function voidCharge(chargeId, reason, ctx) {
  return withTransaction(async (session) => {
    const charge = await Charge.findById(chargeId).session(session);
    if (!charge) throw new AppError(404, 'CHARGE_NOT_FOUND', 'Charge not found');
    const group = await groupOf(session, charge);
    for (const c of group) {
      if (c.status !== 'posted') throw new AppError(422, 'ALREADY_REVERSED', 'This charge has already been reversed');
      if (c.invoiceId) throw new AppError(422, 'CHARGE_INVOICED', 'This charge is already on an invoice and needs a credit note instead of a void');
    }
    for (const c of group) {
      await reverseCharge(session, c, { reason }, ctx);
      await recordAudit(ctx, {
        action: 'charge.void', entity: 'Charge', entityId: c._id,
        meta: { reason, totalKobo: c.totalKobo, payerId: c.payerId, encounterId: c.encounterId, splitRole: c.splitRole },
      }, session);
    }
    return { ...charge.toObject(), status: 'reversed', reversalReason: reason, chargesVoided: group.length };
  });
}

/**
 * Move an encounter's uninvoiced charges from its current primary payer to a new one, re-pricing under the new
 * payer's tariff and applying the new payer's co-pay, limit and authorization rules. A split charge moves as a
 * whole. Entirely transactional: if any charge cannot move, nothing changes.
 */
export async function reassignCharges({ encounter, newPayer, reason }, ctx, session) {
  const emergency = encounter.type === 'emergency';
  const seeds = await Charge.find({
    encounterId: encounter._id, payerId: encounter.primaryPayerId, status: 'posted', invoiceId: null, splitRole: { $ne: 'copay' },
  }).session(session);

  const moved = [];
  for (const seed of seeds) {
    const group = await groupOf(session, seed);
    if (group.some((c) => c.status !== 'posted' || c.invoiceId)) {
      throw new AppError(422, 'GROUP_INVOICED', 'Part of a split charge has already been invoiced, so it cannot be moved');
    }
    const service = await Service.findById(seed.serviceId).session(session).lean();
    const q = await quote({ payer: newPayer, service, qty: seed.qty, patientId: encounter.patientId, session });

    for (const c of group) await reverseCharge(session, c, { reason: `Payer reassigned: ${reason}` }, ctx);
    const fresh = await postShares(session, {
      encounter, service, qty: seed.qty, price: q.price, totalKobo: q.totalKobo, shares: q.shares,
      allowOverLimit: emergency, emergency,
    }, ctx);
    await Charge.updateMany({ _id: { $in: group.map((c) => c._id) } }, { $set: { replacedBy: fresh[0]._id } }, { session });
    moved.push({ from: seed._id, to: fresh[0]._id, oldTotalKobo: group.reduce((s, c) => s + c.totalKobo, 0), newTotalKobo: q.totalKobo, split: fresh.length > 1 });
  }
  return moved;
}
