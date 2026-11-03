import { withTransaction } from '../config/db.js';
import { can } from '../config/permissions.js';
import { Payment } from '../models/Payment.js';
import { Refund } from '../models/Refund.js';
import { AppError } from '../utils/AppError.js';
import { nextSequence, pad } from '../utils/counters.js';
import { assertDifferentPerson } from '../utils/makerChecker.js';
import { postLedgerEntry, reverseLedgerEntryInTx } from './ledger.service.js';
import { recordAudit } from './audit.service.js';
import { requireOpenSession, touchSession } from './cashier-sessions.service.js';

/** Ask to return money from credit a payer holds on a payment (unused deposit, overpayment, credit released by a credit note). */
export async function requestRefund({ paymentId, amountKobo, method, reason }, ctx) {
  const payment = await Payment.findById(paymentId).lean();
  if (!payment) throw new AppError(404, 'PAYMENT_NOT_FOUND', 'Payment not found');
  if (payment.status !== 'success') throw new AppError(422, 'PAYMENT_NOT_COMPLETE', 'Only successful payments can be refunded');

  const [reserved] = await Refund.aggregate([
    { $match: { paymentId: payment._id, status: 'pending' } }, { $group: { _id: null, total: { $sum: '$amountKobo' } } },
  ]);
  const availableKobo = payment.unallocatedKobo - (reserved?.total ?? 0);
  if (amountKobo > availableKobo) {
    throw new AppError(422, 'INSUFFICIENT_CREDIT', 'That is more than the unused credit on this payment (after other pending refunds)', { availableKobo });
  }

  return withTransaction(async (session) => {
    const refundNo = `RF-${pad(await nextSequence('refund', session))}`;
    const [refund] = await Refund.create([{ refundNo, payerId: payment.payerId, paymentId: payment._id, amountKobo, method, reason, requestedBy: ctx.actorId }], { session });
    await recordAudit(ctx, { action: 'refund.request', entity: 'Refund', entityId: refund._id, after: { refundNo, amountKobo, method, paymentId: payment._id }, meta: { reason } }, session);
    return refund.toObject();
  });
}

/** Approving reserves the money immediately (credit leaves the payment and the ledger), so it cannot be spent twice. */
export async function decideRefund(id, { decision, note }, ctx) {
  return withTransaction(async (session) => {
    const refund = await Refund.findById(id).session(session);
    if (!refund) throw new AppError(404, 'REFUND_NOT_FOUND', 'Refund not found');
    if (refund.status !== 'pending') throw new AppError(422, 'ALREADY_DECIDED', `This refund is already ${refund.status}`);

    if (decision === 'reject') {
      refund.set({ status: 'rejected', decidedBy: ctx.actorId, decidedAt: new Date(), decisionNote: note });
      await refund.save({ session });
      await recordAudit(ctx, { action: 'refund.reject', entity: 'Refund', entityId: refund._id, meta: { note } }, session);
      return refund.toObject();
    }

    assertDifferentPerson(refund.requestedBy, ctx, 'refund request');
    const taken = await Payment.findOneAndUpdate(
      { _id: refund.paymentId, status: 'success', unallocatedKobo: { $gte: refund.amountKobo } },
      { $inc: { unallocatedKobo: -refund.amountKobo } },
      { session }
    );
    if (!taken) throw new AppError(422, 'INSUFFICIENT_CREDIT', 'The credit on this payment has since been used, so this refund can no longer be approved');

    const { entry } = await postLedgerEntry({
      payerId: refund.payerId, type: 'refund', amountKobo: refund.amountKobo,
      description: `Refund ${refund.refundNo}: ${refund.reason}`.slice(0, 300),
      refType: 'refund', refId: refund._id, idempotencyKey: `refund:${refund._id}`, createdBy: ctx.actorId,
    }, session);
    refund.set({ status: 'approved', decidedBy: ctx.actorId, decidedAt: new Date(), decisionNote: note, ledgerEntryId: entry._id });
    await refund.save({ session });
    await recordAudit(ctx, { action: 'refund.approve', entity: 'Refund', entityId: refund._id, after: { refundNo: refund.refundNo, amountKobo: refund.amountKobo }, meta: { note } }, session);
    return refund.toObject();
  });
}

/** The cashier hands over the money and records how. The payout belongs to their open shift, so the till reconciles. */
export async function payRefund(id, { payoutRef }, ctx) {
  const till = await requireOpenSession(ctx);
  return withTransaction(async (session) => {
    if (till) await touchSession(till._id, session);
    const refund = await Refund.findOneAndUpdate(
      { _id: id, status: 'approved' },
      { $set: { status: 'paid', paidBy: ctx.actorId, paidAt: new Date(), payoutRef, paidSessionId: till?._id } },
      { returnDocument: 'after', session }
    );
    if (!refund) {
      const existing = await Refund.findById(id).select('status').session(session).lean();
      if (!existing) throw new AppError(404, 'REFUND_NOT_FOUND', 'Refund not found');
      throw new AppError(422, 'NOT_PAYABLE', `Only approved refunds can be paid out (this one is ${existing.status})`);
    }
    await recordAudit(ctx, { action: 'refund.pay', entity: 'Refund', entityId: refund._id, meta: { payoutRef, amountKobo: refund.amountKobo, method: refund.method } }, session);
    return refund.toObject();
  });
}

/** Cancel before money is handed over. If it was already approved, the credit is put back exactly as it was. */
export async function cancelRefund(id, reason, ctx) {
  return withTransaction(async (session) => {
    const refund = await Refund.findById(id).session(session);
    if (!refund) throw new AppError(404, 'REFUND_NOT_FOUND', 'Refund not found');
    if (refund.status === 'paid') throw new AppError(422, 'ALREADY_PAID', 'Money has already been handed over. This cannot be cancelled.');
    if (!['pending', 'approved'].includes(refund.status)) throw new AppError(422, 'NOT_CANCELLABLE', `This refund is ${refund.status}`);
    const isOwner = refund.requestedBy && String(refund.requestedBy) === String(ctx.actorId);
    if (refund.status === 'approved' && !can(ctx.actorRole, 'refunds:approve')) throw new AppError(403, 'FORBIDDEN', 'Only an approver can cancel an approved refund');
    if (refund.status === 'pending' && !isOwner && !can(ctx.actorRole, 'refunds:approve')) throw new AppError(403, 'FORBIDDEN', 'Only the requester or an approver can cancel this refund');

    if (refund.status === 'approved') {
      await reverseLedgerEntryInTx({ entryId: refund.ledgerEntryId, reason: `Refund ${refund.refundNo} cancelled: ${reason}` }, ctx, session);
      await Payment.updateOne({ _id: refund.paymentId }, { $inc: { unallocatedKobo: refund.amountKobo } }, { session });
    }
    refund.set({ status: 'cancelled', decisionNote: reason });
    await refund.save({ session });
    await recordAudit(ctx, { action: 'refund.cancel', entity: 'Refund', entityId: refund._id, meta: { reason } }, session);
    return refund.toObject();
  });
}

export async function listRefunds({ payerId, paymentId, status, page, limit }) {
  const filter = {};
  if (payerId) filter.payerId = payerId;
  if (paymentId) filter.paymentId = paymentId;
  if (status) filter.status = status;
  const [items, total] = await Promise.all([
    Refund.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Refund.countDocuments(filter),
  ]);
  return { items, page, limit, total };
}

export async function getRefund(id) {
  const r = await Refund.findById(id).lean();
  if (!r) throw new AppError(404, 'REFUND_NOT_FOUND', 'Refund not found');
  return r;
}
