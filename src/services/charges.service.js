import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { can } from '../config/permissions.js';
import { withTransaction } from '../config/db.js';
import { Charge } from '../models/Charge.js';
import { Encounter } from '../models/Encounter.js';
import { Patient } from '../models/Patient.js';
import { Payer } from '../models/Payer.js';
import { Service } from '../models/Service.js';
import { AppError } from '../utils/AppError.js';
import { assertKobo } from '../utils/money.js';
import { assessEligibility } from './coverage.service.js';
import { checkServiceCoverage, resolvePrice } from './catalog.service.js';
import { postLedgerEntry, reverseLedgerEntryInTx } from './ledger.service.js';
import { recordAudit } from './audit.service.js';

const CONTRACT_CODES = ['CONTRACT_NOT_STARTED', 'CONTRACT_EXPIRED'];

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
  if (blockers.length) {
    throw new AppError(422, 'PAYER_NOT_USABLE', 'This payer cannot be charged right now', assess.reasons);
  }

  const cover = checkServiceCoverage(payer, service);
  if (!cover.covered) {
    const patient = await Patient.findById(encounter.patientId).select('selfPayerId').lean();
    throw new AppError(422, 'SERVICE_NOT_COVERED',
      `${service.code} is ${cover.reason === 'excluded' ? 'excluded from' : 'not covered by'} this payer's contract. Charge it to the patient's own account instead.`,
      { selfPayerId: patient?.selfPayerId });
  }

  const price = await resolvePrice(payer, service._id);
  const totalKobo = assertKobo(price.priceKobo * qty, 'total');
  return { payer, price, totalKobo };
}

/** Post the ledger entry and create the charge record. Must run inside a transaction. */
async function postChargeInTx(session, { encounter, payer, service, qty, price, totalKobo, allowOverLimit, forceEnforce, idempotencyKey, overrideReason }, ctx) {
  const chargeId = new mongoose.Types.ObjectId();
  const { entry } = await postLedgerEntry({
    payerId: payer._id, type: 'charge', amountKobo: totalKobo,
    description: `${service.name} x${qty}`.slice(0, 300),
    refType: 'charge', refId: chargeId, encounterId: encounter._id,
    idempotencyKey: `charge:${chargeId}`, createdBy: ctx.actorId, allowOverLimit, forceEnforce,
  }, session);

  const [charge] = await Charge.create([{
    _id: chargeId, encounterId: encounter._id, patientId: encounter.patientId, payerId: payer._id, serviceId: service._id,
    serviceCode: service.code, description: `${service.name}${qty > 1 ? ` x${qty}` : ''}`, department: service.department,
    qty, unitPriceKobo: price.priceKobo, totalKobo, tariffId: price.tariffId, tariffItemId: price.tariffItemId, priceSource: price.source,
    ledgerEntryId: entry._id, idempotencyKey, overrideReason, capturedBy: ctx.actorId,
  }], { session });
  return charge;
}

export async function captureCharge(input, ctx) {
  const { encounterId, serviceId, qty = 1, payerId: requestedPayerId, idempotencyKey, overrideLimit = false, overrideReason } = input;

  if (idempotencyKey) {
    const existing = await Charge.findOne({ idempotencyKey }).lean();
    if (existing) {
      if (String(existing.encounterId) !== String(encounterId) || String(existing.serviceId) !== String(serviceId) || existing.qty !== qty) {
        throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key was already used for a different charge');
      }
      return { charge: existing, duplicate: true };
    }
  }

  const encounter = await Encounter.findById(encounterId).lean();
  if (!encounter) throw new AppError(404, 'ENCOUNTER_NOT_FOUND', 'Encounter not found');
  if (encounter.status !== 'open') throw new AppError(422, 'ENCOUNTER_CLOSED', `Encounter is ${encounter.status}; charges can only be added to open encounters`);
  const service = await Service.findById(serviceId).lean();
  if (!service) throw new AppError(404, 'SERVICE_NOT_FOUND', 'Service not found');

  const payerId = requestedPayerId ?? encounter.primaryPayerId;
  const { payer, price, totalKobo } = await prepareCharge({ encounter, payerId, service, qty });

  let allowOverLimit = encounter.type === 'emergency'; // treat first, bill later
  if (overrideLimit) {
    if (!can(ctx.actorRole, 'charges:override')) throw new AppError(403, 'FORBIDDEN', 'You are not allowed to override credit limits');
    if (!overrideReason) throw new AppError(400, 'REASON_REQUIRED', 'A reason is required to override a limit');
    allowOverLimit = true;
  }
  // Optional deposit-first policy for walk-ins (never applied to emergencies).
  const forceEnforce = payer.type === 'individual' && env.WALKIN_PAYMENT_POLICY === 'before' && !allowOverLimit;

  try {
    const charge = await withTransaction(async (session) => {
      const c = await postChargeInTx(session, {
        encounter, payer, service, qty, price, totalKobo, allowOverLimit, forceEnforce, idempotencyKey, overrideReason,
      }, ctx);
      await recordAudit(ctx, {
        action: 'charge.create', entity: 'Charge', entityId: c._id,
        after: { encounterId, payerId, serviceCode: service.code, qty, totalKobo },
        meta: allowOverLimit && (overrideLimit || encounter.type === 'emergency') ? { limitOverride: overrideLimit ? 'manual' : 'emergency', reason: overrideReason } : undefined,
      }, session);
      return c.toObject();
    });
    return { charge, duplicate: false };
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

export async function listCharges(encounterId) {
  const items = await Charge.find({ encounterId }).sort({ capturedAt: 1 }).lean();
  const postedTotalKobo = items.filter((c) => c.status === 'posted').reduce((s, c) => s + c.totalKobo, 0);
  return { items, postedTotalKobo };
}

/** Void a charge that has not been invoiced yet. Invoiced charges need a credit note (Phase 4). */
export async function voidCharge(chargeId, reason, ctx) {
  return withTransaction(async (session) => {
    const charge = await Charge.findById(chargeId).session(session);
    if (!charge) throw new AppError(404, 'CHARGE_NOT_FOUND', 'Charge not found');
    if (charge.status !== 'posted') throw new AppError(422, 'ALREADY_REVERSED', 'This charge has already been reversed');
    if (charge.invoiceId) throw new AppError(422, 'CHARGE_INVOICED', 'This charge is already on an invoice and needs a credit note instead of a void');

    await reverseLedgerEntryInTx({ entryId: charge.ledgerEntryId, reason: `Charge voided: ${reason}` }, ctx, session);
    const r = await Charge.updateOne(
      { _id: charge._id, status: 'posted', invoiceId: null },
      { $set: { status: 'reversed', reversalReason: reason, reversedAt: new Date(), reversedBy: ctx.actorId } },
      { session }
    );
    if (r.modifiedCount !== 1) throw new AppError(409, 'CHARGE_CHANGED', 'Charge changed while voiding. Please retry.');
    await recordAudit(ctx, {
      action: 'charge.void', entity: 'Charge', entityId: charge._id,
      meta: { reason, totalKobo: charge.totalKobo, payerId: charge.payerId, encounterId: charge.encounterId },
    }, session);
    return { ...charge.toObject(), status: 'reversed', reversalReason: reason };
  });
}

/**
 * Move an encounter's uninvoiced charges from its current primary payer to a new one,
 * re-pricing under the new payer's tariff. Used when a payer is identified after care started.
 * Entirely transactional: if any charge cannot move (e.g. excluded by the new contract), nothing changes.
 */
export async function reassignCharges({ encounter, newPayer, reason }, ctx, session) {
  const old = await Charge.find({ encounterId: encounter._id, payerId: encounter.primaryPayerId, status: 'posted', invoiceId: null })
    .session(session);
  const moved = [];
  for (const c of old) {
    const service = await Service.findById(c.serviceId).session(session).lean();
    const cover = checkServiceCoverage(newPayer, service);
    if (!cover.covered) {
      throw new AppError(422, 'SERVICE_NOT_COVERED', `${service.code} is not covered by the new payer's contract`, { serviceCode: service.code });
    }
    const price = await resolvePrice(newPayer, service._id);
    const totalKobo = assertKobo(price.priceKobo * c.qty, 'total');

    await reverseLedgerEntryInTx({ entryId: c.ledgerEntryId, reason: `Payer reassigned: ${reason}` }, ctx, session);
    const fresh = await postChargeInTx(session, {
      encounter, payer: newPayer, service, qty: c.qty, price, totalKobo,
      allowOverLimit: encounter.type === 'emergency', forceEnforce: false,
    }, ctx);

    await Charge.updateOne({ _id: c._id }, {
      $set: { status: 'reversed', reversalReason: `Payer reassigned: ${reason}`, reversedAt: new Date(), reversedBy: ctx.actorId, replacedBy: fresh._id },
    }, { session });
    moved.push({ from: c._id, to: fresh._id, oldTotalKobo: c.totalKobo, newTotalKobo: totalKobo });
  }
  return moved;
}
