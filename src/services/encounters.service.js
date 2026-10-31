import { withTransaction } from '../config/db.js';
import { can } from '../config/permissions.js';
import { Charge } from '../models/Charge.js';
import { Encounter } from '../models/Encounter.js';
import { Invoice } from '../models/Invoice.js';
import { Patient } from '../models/Patient.js';
import { Payer } from '../models/Payer.js';
import { AppError } from '../utils/AppError.js';
import { nextSequence, pad } from '../utils/counters.js';
import { assessEligibility } from './coverage.service.js';
import { invoiceEncounter, withBalance } from './invoices.service.js';
import { reassignCharges } from './charges.service.js';
import { recordAudit } from './audit.service.js';

/**
 * Open a visit. With no payerId the patient's own ("self") payer is used, which is the walk-in case.
 * Emergencies may open even when the payer is not currently eligible: treat first, sort out billing after.
 */
export async function openEncounter({ patientId, type, payerId, department, allowSecondOpen }, ctx) {
  const patient = await Patient.findOne({ _id: patientId, deletedAt: null }).lean();
  if (!patient) throw new AppError(404, 'PATIENT_NOT_FOUND', 'Patient not found');
  if (patient.status !== 'active') throw new AppError(422, 'PATIENT_NOT_ACTIVE', `Patient is ${patient.status}`);

  const primaryPayerId = payerId ?? patient.selfPayerId;
  const assess = await assessEligibility(patientId, primaryPayerId);
  if (!assess.covered) throw new AppError(422, 'NOT_COVERED', 'This patient is not covered by that payer');
  const hardBlockers = assess.reasonCodes.filter((c) => c !== 'LIMIT_REACHED');
  if (type !== 'emergency' && (hardBlockers.length || assess.reasonCodes.includes('LIMIT_REACHED') && assess.payer.type !== 'individual')) {
    throw new AppError(422, 'NOT_ELIGIBLE', 'This payer cannot be used for a new visit right now', assess.reasons);
  }

  if (!allowSecondOpen) {
    const open = await Encounter.findOne({ patientId, type, status: 'open' }).select('encounterNo').lean();
    if (open) throw new AppError(409, 'ENCOUNTER_ALREADY_OPEN', `This patient already has an open ${type} encounter (${open.encounterNo})`, { encounterId: open._id, encounterNo: open.encounterNo });
  }

  return withTransaction(async (session) => {
    const encounterNo = `ENC-${pad(await nextSequence('encounter', session))}`;
    const [enc] = await Encounter.create([{ encounterNo, patientId, type, primaryPayerId, department, openedBy: ctx.actorId }], { session });
    await recordAudit(ctx, {
      action: 'encounter.open', entity: 'Encounter', entityId: enc._id,
      after: { encounterNo, patientId, type, primaryPayerId },
      meta: assess.eligible ? undefined : { ineligibleOpened: assess.reasons },
    }, session);
    return enc.toObject();
  });
}

export async function listEncounters({ status, patientId, payerId, type, page, limit }) {
  const filter = {};
  if (status) filter.status = status;
  if (patientId) filter.patientId = patientId;
  if (payerId) filter.primaryPayerId = payerId;
  if (type) filter.type = type;
  const [items, total] = await Promise.all([
    Encounter.find(filter).populate('patientId', 'hospitalNumber firstName lastName').populate('primaryPayerId', 'code name type')
      .sort({ openedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Encounter.countDocuments(filter),
  ]);
  return { items, page, limit, total };
}

export async function getEncounterDetail(id) {
  const encounter = await Encounter.findById(id).populate('patientId', 'hospitalNumber firstName lastName dob phone').populate('primaryPayerId', 'code name type mode').lean();
  if (!encounter) throw new AppError(404, 'ENCOUNTER_NOT_FOUND', 'Encounter not found');
  const [charges, invoices] = await Promise.all([
    Charge.find({ encounterId: id }).sort({ capturedAt: 1 }).lean(),
    Invoice.find({ encounterId: id }).select('-lines').sort({ issuedAt: 1 }).lean(),
  ]);
  const posted = charges.filter((c) => c.status === 'posted');
  return {
    encounter, charges, invoices: invoices.map(withBalance),
    totals: {
      postedKobo: posted.reduce((s, c) => s + c.totalKobo, 0),
      uninvoicedKobo: posted.filter((c) => !c.invoiceId).reduce((s, c) => s + c.totalKobo, 0),
      invoicedKobo: invoices.reduce((s, i) => s + i.totalKobo, 0),
      paidKobo: invoices.reduce((s, i) => s + i.paidKobo, 0),
    },
  };
}

/**
 * Close (discharge) an encounter.
 * - Individual (self-pay) charges are invoiced automatically and must be paid first.
 *   A finance manager/admin can override with a reason; emergencies may close with a balance owing.
 * - Corporate and family charges are left for periodic invoicing (Phase 3) unless an invoice was already issued.
 */
export async function closeEncounter(id, { overrideReason } = {}, ctx) {
  const encounter = await Encounter.findById(id).lean();
  if (!encounter) throw new AppError(404, 'ENCOUNTER_NOT_FOUND', 'Encounter not found');
  if (encounter.status !== 'open') throw new AppError(422, 'ENCOUNTER_NOT_OPEN', `Encounter is already ${encounter.status}`);
  if (overrideReason && !can(ctx.actorRole, 'encounters:override')) {
    throw new AppError(403, 'FORBIDDEN', 'You are not allowed to close an encounter with an unpaid balance');
  }

  await invoiceEncounter(id, { payerTypes: ['individual'] }, ctx);

  const unpaid = await Invoice.find({ encounterId: id, payerType: 'individual', status: { $in: ['issued', 'partial'] } }).select('invoiceNo totalKobo paidKobo').lean();
  const unpaidKobo = unpaid.reduce((s, i) => s + (i.totalKobo - i.paidKobo), 0);
  const emergency = encounter.type === 'emergency';
  if (unpaidKobo > 0 && !emergency && !overrideReason) {
    throw new AppError(422, 'PAYMENT_REQUIRED', 'The patient must pay the outstanding balance before this visit can be closed', {
      unpaidKobo, invoices: unpaid.map((i) => ({ id: i._id, invoiceNo: i.invoiceNo, balanceKobo: i.totalKobo - i.paidKobo })),
    });
  }

  return withTransaction(async (session) => {
    const closed = await Encounter.findOneAndUpdate(
      { _id: id, status: 'open' },
      { $set: { status: 'closed', closedAt: new Date(), closedBy: ctx.actorId, ...(unpaidKobo > 0 ? { closeOverride: { reason: overrideReason ?? 'Emergency: bill after treatment', by: ctx.actorId, unpaidKobo } } : {}) } },
      { returnDocument: 'after', session }
    );
    if (!closed) throw new AppError(409, 'ENCOUNTER_CHANGED', 'Encounter changed while closing. Please retry.');
    await recordAudit(ctx, {
      action: 'encounter.close', entity: 'Encounter', entityId: closed._id,
      meta: unpaidKobo > 0 ? { closedWithUnpaidKobo: unpaidKobo, reason: overrideReason ?? 'emergency' } : undefined,
    }, session);
    return closed.toObject();
  });
}

export async function cancelEncounter(id, reason, ctx) {
  return withTransaction(async (session) => {
    const enc = await Encounter.findById(id).session(session);
    if (!enc) throw new AppError(404, 'ENCOUNTER_NOT_FOUND', 'Encounter not found');
    if (enc.status !== 'open') throw new AppError(422, 'ENCOUNTER_NOT_OPEN', `Encounter is already ${enc.status}`);
    if (await Charge.exists({ encounterId: id, status: 'posted' }).session(session)) {
      throw new AppError(422, 'HAS_CHARGES', 'This encounter has posted charges. Void them first, or close the encounter instead.');
    }
    enc.status = 'cancelled';
    enc.cancelReason = reason;
    enc.closedAt = new Date();
    enc.closedBy = ctx.actorId;
    await enc.save({ session });
    await recordAudit(ctx, { action: 'encounter.cancel', entity: 'Encounter', entityId: enc._id, meta: { reason } }, session);
    return enc.toObject();
  });
}

/** Identify the real payer after care has started (typical for emergencies). Uninvoiced charges move and are re-priced. */
export async function reassignEncounterPayer(id, { payerId, reason }, ctx) {
  const encounter = await Encounter.findById(id).lean();
  if (!encounter) throw new AppError(404, 'ENCOUNTER_NOT_FOUND', 'Encounter not found');
  if (encounter.status !== 'open') throw new AppError(422, 'ENCOUNTER_NOT_OPEN', 'Only open encounters can change payer');
  if (String(encounter.primaryPayerId) === String(payerId)) throw new AppError(400, 'SAME_PAYER', 'That payer is already the primary payer');

  const assess = await assessEligibility(encounter.patientId, payerId);
  if (!assess.covered) throw new AppError(422, 'NOT_COVERED', 'This patient is not covered by that payer');
  const blockers = assess.reasonCodes.filter((c) => c !== 'LIMIT_REACHED');
  if (blockers.length) throw new AppError(422, 'PAYER_NOT_USABLE', 'The new payer cannot be used right now', assess.reasons);
  const newPayer = await Payer.findById(payerId).lean();

  return withTransaction(async (session) => {
    const moved = await reassignCharges({ encounter, newPayer, reason }, ctx, session);
    const updated = await Encounter.findOneAndUpdate(
      { _id: id, status: 'open', primaryPayerId: encounter.primaryPayerId },
      { $set: { primaryPayerId: newPayer._id } },
      { returnDocument: 'after', session }
    );
    if (!updated) throw new AppError(409, 'ENCOUNTER_CHANGED', 'Encounter changed while reassigning. Please retry.');
    await recordAudit(ctx, {
      action: 'encounter.reassign_payer', entity: 'Encounter', entityId: updated._id,
      before: { primaryPayerId: encounter.primaryPayerId }, after: { primaryPayerId: newPayer._id },
      meta: { reason, chargesMoved: moved.length },
    }, session);
    return { encounter: updated.toObject(), moved };
  });
}
