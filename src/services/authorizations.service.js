import { withTransaction } from '../config/db.js';
import { can } from '../config/permissions.js';
import { Authorization } from '../models/Authorization.js';
import { Encounter } from '../models/Encounter.js';
import { Patient } from '../models/Patient.js';
import { Service } from '../models/Service.js';
import { AppError } from '../utils/AppError.js';
import { nextSequence, pad } from '../utils/counters.js';
import { assertDifferentPerson } from '../utils/makerChecker.js';
import { assessEligibility } from './coverage.service.js';
import { recordAudit } from './audit.service.js';

const MAX_VALIDITY_DAYS = 90;

export async function requestAuthorization({ payerId, patientId, serviceId, encounterId, requestedAmountKobo, description }, ctx) {
  const patient = await Patient.findOne({ _id: patientId, deletedAt: null }).select('_id').lean();
  if (!patient) throw new AppError(404, 'PATIENT_NOT_FOUND', 'Patient not found');
  const assess = await assessEligibility(patientId, payerId);
  if (assess.payer.type === 'individual') throw new AppError(422, 'NOT_APPLICABLE', 'Self-pay patients do not need payer authorizations');
  if (!assess.covered) throw new AppError(422, 'NOT_COVERED', 'This patient is not covered by that payer');
  if (serviceId && !(await Service.exists({ _id: serviceId }))) throw new AppError(404, 'SERVICE_NOT_FOUND', 'Service not found');
  if (encounterId) {
    const enc = await Encounter.findById(encounterId).select('patientId').lean();
    if (!enc || String(enc.patientId) !== String(patientId)) throw new AppError(422, 'ENCOUNTER_MISMATCH', 'That encounter does not belong to this patient');
  }

  return withTransaction(async (session) => {
    const authNo = `AUTH-${pad(await nextSequence('authorization', session))}`;
    const [auth] = await Authorization.create([{
      authNo, payerId, patientId, serviceId: serviceId ?? null, encounterId: encounterId ?? null, description,
      requestedAmountKobo, requestedBy: ctx.actorId,
    }], { session });
    await recordAudit(ctx, { action: 'authorization.request', entity: 'Authorization', entityId: auth._id, after: { authNo, payerId, patientId, requestedAmountKobo } }, session);
    return auth.toObject();
  });
}

/** Approving records the PAYER's approval (their reference number); rejecting records why. */
export async function decideAuthorization(id, { decision, approvedAmountKobo, expiresAt, externalRef, note }, ctx) {
  const auth = await Authorization.findById(id).lean();
  if (!auth) throw new AppError(404, 'AUTHORIZATION_NOT_FOUND', 'Authorization not found');
  if (auth.status !== 'pending') throw new AppError(422, 'ALREADY_DECIDED', `This authorization is already ${auth.status}`);

  let set;
  if (decision === 'approve') {
    assertDifferentPerson(auth.requestedBy, ctx, 'authorization request');
    if (!externalRef) throw new AppError(400, 'REFERENCE_REQUIRED', "Enter the payer's own approval reference");
    if (!(approvedAmountKobo > 0)) throw new AppError(400, 'AMOUNT_REQUIRED', 'approvedAmountKobo must be above zero');
    const now = Date.now();
    if (!expiresAt || expiresAt.getTime() <= now) throw new AppError(400, 'EXPIRY_REQUIRED', 'expiresAt must be in the future');
    if (expiresAt.getTime() > now + MAX_VALIDITY_DAYS * 86400000) throw new AppError(400, 'EXPIRY_TOO_FAR', `An authorization can be valid for at most ${MAX_VALIDITY_DAYS} days`);
    set = { status: 'approved', approvedAmountKobo, expiresAt, externalRef };
  } else {
    set = { status: 'rejected' };
  }

  const updated = await Authorization.findOneAndUpdate(
    { _id: id, status: 'pending' },
    { $set: { ...set, decisionNote: note, decidedBy: ctx.actorId, decidedAt: new Date() } },
    { returnDocument: 'after' }
  );
  if (!updated) throw new AppError(409, 'ALREADY_DECIDED', 'Someone else decided this authorization first');
  await recordAudit(ctx, {
    action: `authorization.${decision}`, entity: 'Authorization', entityId: updated._id,
    after: { status: updated.status, approvedAmountKobo: updated.approvedAmountKobo, expiresAt: updated.expiresAt }, meta: { externalRef, note },
  });
  return updated.toObject();
}

export async function cancelAuthorization(id, reason, ctx) {
  const auth = await Authorization.findById(id).lean();
  if (!auth) throw new AppError(404, 'AUTHORIZATION_NOT_FOUND', 'Authorization not found');
  if (!['pending', 'approved'].includes(auth.status)) throw new AppError(422, 'NOT_CANCELLABLE', `This authorization is ${auth.status}`);
  const isOwner = auth.requestedBy && String(auth.requestedBy) === String(ctx.actorId);
  if (!isOwner && !can(ctx.actorRole, 'authorizations:decide')) throw new AppError(403, 'FORBIDDEN', 'Only the requester or an approver can cancel this authorization');
  const updated = await Authorization.findOneAndUpdate({ _id: id, status: auth.status }, { $set: { status: 'cancelled', decisionNote: reason } }, { returnDocument: 'after' });
  if (!updated) throw new AppError(409, 'CHANGED', 'This authorization changed while cancelling. Please retry.');
  await recordAudit(ctx, { action: 'authorization.cancel', entity: 'Authorization', entityId: id, meta: { reason, usedKobo: auth.usedKobo } });
  return updated.toObject();
}

export async function listAuthorizations({ payerId, patientId, status, page, limit }) {
  const filter = {};
  if (payerId) filter.payerId = payerId;
  if (patientId) filter.patientId = patientId;
  if (status) filter.status = status;
  const [items, total] = await Promise.all([
    Authorization.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Authorization.countDocuments(filter),
  ]);
  return { items: items.map(withRemaining), page, limit, total };
}

const withRemaining = (a) => ({ ...a, remainingKobo: a.status === 'approved' ? a.approvedAmountKobo - a.usedKobo : 0, expired: Boolean(a.expiresAt && a.expiresAt < new Date()) });

export async function getAuthorization(id) {
  const a = await Authorization.findById(id).lean();
  if (!a) throw new AppError(404, 'AUTHORIZATION_NOT_FOUND', 'Authorization not found');
  return withRemaining(a);
}
