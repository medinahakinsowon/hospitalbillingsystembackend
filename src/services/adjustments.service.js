import { withTransaction } from '../config/db.js';
import { can } from '../config/permissions.js';
import { Adjustment } from '../models/Adjustment.js';
import { Charge } from '../models/Charge.js';
import { Invoice } from '../models/Invoice.js';
import { Payment } from '../models/Payment.js';
import { AppError } from '../utils/AppError.js';
import { nextSequence, pad } from '../utils/counters.js';
import { assertDifferentPerson } from '../utils/makerChecker.js';
import { invoiceStatusOf } from './invoices.service.js';
import { postLedgerEntry } from './ledger.service.js';
import { reverseCharge } from './charges.service.js';
import { recordAudit } from './audit.service.js';

const LABEL = { discount: 'Discount', waiver: 'Waiver', credit_note: 'Credit note', writeoff: 'Write-off' };

/**
 * Ask for a discount, waiver, credit note or write-off on an issued invoice.
 * Nothing changes until a different person approves it.
 */
export async function requestAdjustment({ invoiceId, kind, amountKobo, percent, chargeIds, reason }, ctx) {
  const invoice = await Invoice.findById(invoiceId).lean();
  if (!invoice) throw new AppError(404, 'INVOICE_NOT_FOUND', 'Invoice not found');
  if (invoice.status === 'void') throw new AppError(422, 'INVOICE_VOID', 'This invoice is void');
  const creditable = invoice.totalKobo - invoice.creditedKobo;
  const outstanding = invoice.totalKobo - invoice.paidKobo;

  let amount = amountKobo;
  if (kind === 'discount') {
    if (percent) amount = Math.round((invoice.totalKobo * percent) / 100);
    if (!(amount > 0)) throw new AppError(400, 'AMOUNT_REQUIRED', 'Give an amount or a percentage');
    if (amount > creditable) throw new AppError(422, 'EXCEEDS_INVOICE', 'A discount cannot be more than what remains of the invoice', { creditableKobo: creditable });
  } else if (kind === 'waiver') {
    amount = outstanding;
    if (amount <= 0) throw new AppError(422, 'NOTHING_OUTSTANDING', 'There is no balance left to waive');
  } else if (kind === 'writeoff') {
    if (!invoice.dueAt || invoice.dueAt >= new Date()) throw new AppError(422, 'NOT_OVERDUE', 'Only overdue invoices can be written off');
    amount = amountKobo ?? outstanding;
    if (!(amount > 0) || amount > outstanding) throw new AppError(422, 'EXCEEDS_OUTSTANDING', 'A write-off cannot be more than the unpaid balance', { outstandingKobo: outstanding });
  } else if (kind === 'credit_note') {
    const charges = await Charge.find({ _id: { $in: chargeIds }, invoiceId: invoice._id, status: 'posted' }).select('totalKobo').lean();
    if (charges.length !== new Set(chargeIds.map(String)).size) {
      throw new AppError(422, 'CHARGES_NOT_CREDITABLE', 'Every charge must be on this invoice and not already credited');
    }
    amount = charges.reduce((s, c) => s + c.totalKobo, 0);
  }

  return withTransaction(async (session) => {
    const adjNo = `ADJ-${pad(await nextSequence('adjustment', session))}`;
    const [adj] = await Adjustment.create([{
      adjNo, kind, invoiceId: invoice._id, invoiceNo: invoice.invoiceNo, payerId: invoice.payerId,
      amountKobo: amount, percent: kind === 'discount' ? percent : undefined, chargeIds: kind === 'credit_note' ? chargeIds : [],
      reason, requestedBy: ctx.actorId,
    }], { session });
    await recordAudit(ctx, { action: 'adjustment.request', entity: 'Adjustment', entityId: adj._id, after: { adjNo, kind, invoiceNo: invoice.invoiceNo, amountKobo: amount }, meta: { reason } }, session);
    return adj.toObject();
  });
}

/**
 * Give back cash that was allocated to an invoice (most recent payments first) so it becomes credit the payer
 * holds again (refundable, or applied to a later invoice). Needed when a credit note lands on an already-paid invoice.
 */
async function releaseAllocations(invoiceId, excessKobo, session) {
  const payments = await Payment.find({ 'allocations.invoiceId': invoiceId, status: 'success' }).sort({ completedAt: -1 }).session(session);
  let left = excessKobo;
  for (const p of payments) {
    if (left <= 0) break;
    let released = 0;
    for (const a of p.allocations) {
      if (String(a.invoiceId) !== String(invoiceId) || released >= left) continue;
      const take = Math.min(a.amountKobo, left - released);
      a.amountKobo -= take;
      released += take;
    }
    if (released > 0) {
      p.allocations = p.allocations.filter((a) => a.amountKobo > 0);
      p.unallocatedKobo += released;
      await p.save({ session });
      left -= released;
    }
  }
  if (left > 0) throw new AppError(409, 'ALLOCATION_MISMATCH', 'Could not find enough payment on this invoice to release', { missingKobo: left });
}

/** Apply an approved adjustment. Runs inside the approval transaction, so it all happens or none of it does. */
async function applyAdjustment(session, adj, ctx) {
  const invoice = await Invoice.findById(adj.invoiceId).session(session);
  if (!invoice || invoice.status === 'void') throw new AppError(422, 'INVOICE_VOID', 'This invoice is void');
  const creditable = invoice.totalKobo - invoice.creditedKobo;
  const outstanding = invoice.totalKobo - invoice.paidKobo;

  // Re-check against the invoice as it is NOW: things may have changed since the request.
  let amount = adj.amountKobo;
  let charges = [];
  if (adj.kind === 'credit_note') {
    charges = await Charge.find({ _id: { $in: adj.chargeIds }, invoiceId: invoice._id, status: 'posted' }).session(session);
    if (charges.length !== adj.chargeIds.length) throw new AppError(422, 'CHARGES_NOT_CREDITABLE', 'Some of these charges were already credited');
    amount = charges.reduce((s, c) => s + c.totalKobo, 0);
  } else if (adj.kind === 'waiver') {
    amount = outstanding;
  }
  if (!(amount > 0)) throw new AppError(422, 'NOTHING_TO_APPLY', 'There is nothing left to adjust on this invoice');
  if (amount > creditable) throw new AppError(422, 'EXCEEDS_INVOICE', 'This would credit more than the invoice total', { creditableKobo: creditable });
  if ((adj.kind === 'waiver' || adj.kind === 'writeoff') && amount > outstanding) {
    throw new AppError(422, 'EXCEEDS_OUTSTANDING', 'The invoice balance is now lower than this adjustment', { outstandingKobo: outstanding });
  }

  const fromOutstanding = Math.min(amount, outstanding);
  const excess = amount - fromOutstanding; // portion that must come out of cash already paid

  if (adj.kind === 'credit_note') {
    for (const c of charges) await reverseCharge(session, c, { reason: `Credit note: ${adj.reason}`.slice(0, 200), allowInvoiced: true }, ctx);
  } else {
    await postLedgerEntry({
      payerId: invoice.payerId, type: adj.kind === 'writeoff' ? 'writeoff' : 'adjustment', amountKobo: -amount,
      description: `${LABEL[adj.kind]} ${adj.adjNo} on ${invoice.invoiceNo}: ${adj.reason}`.slice(0, 300),
      refType: 'adjustment', refId: adj._id, idempotencyKey: `adjustment:${adj._id}`, createdBy: ctx.actorId,
    }, session);
  }
  if (excess > 0) await releaseAllocations(invoice._id, excess, session);

  const newPaid = invoice.paidKobo - excess + amount;
  const updated = await Invoice.findOneAndUpdate(
    { _id: invoice._id, paidKobo: invoice.paidKobo, creditedKobo: invoice.creditedKobo },
    { $set: { paidKobo: newPaid, creditedKobo: invoice.creditedKobo + amount, status: invoiceStatusOf(newPaid, invoice.totalKobo) } },
    { returnDocument: 'after', session }
  );
  if (!updated) throw new AppError(409, 'INVOICE_CHANGED', 'The invoice changed while applying this. Please retry.');
  if (adj.kind === 'credit_note') {
    await Invoice.updateOne({ _id: invoice._id }, { $set: { 'lines.$[l].credited': true } }, { session, arrayFilters: [{ 'l.chargeId': { $in: adj.chargeIds } }] });
  }
  return { amount, excess, invoice: updated };
}

export async function decideAdjustment(id, { decision, note }, ctx) {
  return withTransaction(async (session) => {
    const adj = await Adjustment.findById(id).session(session);
    if (!adj) throw new AppError(404, 'ADJUSTMENT_NOT_FOUND', 'Adjustment not found');
    if (adj.status !== 'pending') throw new AppError(422, 'ALREADY_DECIDED', `This adjustment is already ${adj.status}`);

    if (decision === 'reject') {
      adj.set({ status: 'rejected', decidedBy: ctx.actorId, decidedAt: new Date(), decisionNote: note });
      await adj.save({ session });
      await recordAudit(ctx, { action: 'adjustment.reject', entity: 'Adjustment', entityId: adj._id, meta: { note } }, session);
      return adj.toObject();
    }

    assertDifferentPerson(adj.requestedBy, ctx, 'adjustment request');
    const { amount, excess, invoice } = await applyAdjustment(session, adj, ctx);
    const creditNoteNo = `CN-${pad(await nextSequence('creditnote', session))}`;
    adj.set({ status: 'applied', creditNoteNo, appliedKobo: amount, releasedToCreditKobo: excess, decidedBy: ctx.actorId, decidedAt: new Date(), decisionNote: note });
    await adj.save({ session });
    await recordAudit(ctx, {
      action: 'adjustment.apply', entity: 'Adjustment', entityId: adj._id,
      after: { creditNoteNo, kind: adj.kind, appliedKobo: amount, invoiceNo: invoice.invoiceNo, invoiceStatus: invoice.status }, meta: { releasedToCreditKobo: excess, note },
    }, session);
    return adj.toObject();
  });
}

export async function cancelAdjustment(id, ctx) {
  const adj = await Adjustment.findById(id).lean();
  if (!adj) throw new AppError(404, 'ADJUSTMENT_NOT_FOUND', 'Adjustment not found');
  const isOwner = adj.requestedBy && String(adj.requestedBy) === String(ctx.actorId);
  if (!isOwner && !can(ctx.actorRole, 'adjustments:approve')) throw new AppError(403, 'FORBIDDEN', 'Only the requester or an approver can cancel this request');
  const updated = await Adjustment.findOneAndUpdate({ _id: id, status: 'pending' }, { $set: { status: 'cancelled' } }, { returnDocument: 'after' });
  if (!updated) throw new AppError(422, 'NOT_CANCELLABLE', `This adjustment is ${adj.status}`);
  await recordAudit(ctx, { action: 'adjustment.cancel', entity: 'Adjustment', entityId: id });
  return updated.toObject();
}

export async function listAdjustments({ invoiceId, payerId, status, kind, page, limit }) {
  const filter = {};
  if (invoiceId) filter.invoiceId = invoiceId;
  if (payerId) filter.payerId = payerId;
  if (status) filter.status = status;
  if (kind) filter.kind = kind;
  const [items, total] = await Promise.all([
    Adjustment.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Adjustment.countDocuments(filter),
  ]);
  return { items, page, limit, total };
}

export async function getAdjustment(id) {
  const a = await Adjustment.findById(id).lean();
  if (!a) throw new AppError(404, 'ADJUSTMENT_NOT_FOUND', 'Adjustment not found');
  return a;
}
