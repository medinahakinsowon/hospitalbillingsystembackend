import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { Invoice } from '../models/Invoice.js';
import { Payer } from '../models/Payer.js';
import { enqueueNotifications } from './notifications.service.js';
import { recordAudit } from './audit.service.js';

const DAY = 86400000;
const OPEN = ['issued', 'partial'];
const SYSTEM_CTX = { actorId: null, actorRole: 'system', ip: null, userAgent: 'overdue-job' };
const owes = { $gt: [{ $subtract: ['$totalKobo', '$paidKobo'] }, 0] };

/**
 * Daily overdue handling:
 *  1. reminders at each stage in OVERDUE_REMINDER_DAYS (only the latest stage reached is sent, never a burst);
 *  2. corporate and credit-card payers with a balance more than OVERDUE_SUSPEND_AFTER_DAYS past due are suspended
 *     (new charges are refused; emergencies must be moved to the patient's own account);
 *  3. payers the job suspended are reinstated once the overdue balance is cleared. Manual suspensions are never lifted by it.
 * `payerIds` limits the run to certain payers (used by tests and for one-off runs).
 */
export async function processOverdue({ payerIds, now = new Date(), maxInvoices = 500 } = {}) {
  const ids = payerIds?.map((i) => new mongoose.Types.ObjectId(String(i)));
  const payerFilter = ids ? { payerId: { $in: ids } } : {};
  const summary = { invoicesReminded: 0, remindersQueued: 0, suspended: [], reinstated: [] };

  // 1. reminders
  const stages = env.OVERDUE_REMINDER_DAYS;
  const overdue = await Invoice.find({
    status: { $in: OPEN }, dueAt: { $lt: new Date(now - Math.min(...stages) * DAY) }, remindersSent: { $ne: Math.max(...stages) }, ...payerFilter,
  }).sort({ dueAt: 1 }).limit(maxInvoices).select('payerId invoiceNo totalKobo paidKobo dueAt remindersSent').lean();
  const payers = new Map((await Payer.find({ _id: { $in: [...new Set(overdue.map((i) => String(i.payerId)))] } }).lean()).map((p) => [String(p._id), p]));
  for (const inv of overdue) {
    const balanceKobo = inv.totalKobo - inv.paidKobo;
    const daysOverdue = Math.floor((now - inv.dueAt) / DAY);
    const due = stages.filter((d) => d <= daysOverdue && !(inv.remindersSent ?? []).includes(d));
    const payer = payers.get(String(inv.payerId));
    if (balanceKobo <= 0 || !due.length || !payer) continue;
    const stage = Math.max(...due);
    summary.remindersQueued += await enqueueNotifications({
      template: 'overdue_reminder', payer, data: { payerName: payer.name, invoiceNo: inv.invoiceNo, balanceKobo, daysOverdue },
      dedupeKey: `overdue:${inv._id}:${stage}`, relatedType: 'invoice', relatedId: inv._id,
    });
    await Invoice.updateOne({ _id: inv._id }, { $addToSet: { remindersSent: { $each: due } }, $set: { lastReminderAt: now } }); // earlier stages count as done
    summary.invoicesReminded++;
  }

  // 2 and 3. suspension and reinstatement
  const days = env.OVERDUE_SUSPEND_AFTER_DAYS;
  const cutoff = new Date(now - days * DAY);
  const badInvoice = { status: { $in: OPEN }, dueAt: { $lt: cutoff }, $expr: owes };
  if (days > 0) {
    const bad = await Invoice.aggregate([
      { $match: { ...badInvoice, payerType: { $in: ['corporate', 'family'] }, ...payerFilter } }, { $group: { _id: '$payerId' } }, { $limit: 500 },
    ]);
    for (const { _id } of bad) {
      const p = await Payer.findOneAndUpdate({ _id, status: 'active' }, { $set: { status: 'suspended', suspendedReason: 'overdue', suspendedAt: now } }, { returnDocument: 'after' });
      if (!p) continue;
      await recordAudit(SYSTEM_CTX, { action: 'payer.suspend.overdue', entity: 'Payer', entityId: p._id, meta: { afterDays: days } });
      summary.suspended.push(p.code);
    }
  }
  const held = await Payer.find({ status: 'suspended', suspendedReason: 'overdue', ...(ids ? { _id: { $in: ids } } : {}) }).limit(500).lean();
  for (const p of held) {
    if (days > 0 && (await Invoice.exists({ ...badInvoice, payerId: p._id }))) continue;
    const r = await Payer.updateOne({ _id: p._id, status: 'suspended', suspendedReason: 'overdue' }, { $set: { status: 'active' }, $unset: { suspendedReason: 1, suspendedAt: 1 } });
    if (r.modifiedCount) {
      await recordAudit(SYSTEM_CTX, { action: 'payer.reinstate.overdue_cleared', entity: 'Payer', entityId: p._id });
      summary.reinstated.push(p.code);
    }
  }
  return summary;
}

/** Warn prepaid card holders when their deposit falls to the card's threshold: at most one message per week per card. */
export async function queueLowBalanceAlerts({ payerIds, now = new Date() } = {}) {
  const ids = payerIds?.map((i) => new mongoose.Types.ObjectId(String(i)));
  const cards = await Payer.find({
    type: 'family', mode: 'prepaid', status: 'active', lowBalanceThresholdKobo: { $gt: 0 },
    $expr: { $lte: [{ $subtract: ['$creditLimitKobo', '$balanceKobo'] }, '$lowBalanceThresholdKobo'] }, ...(ids ? { _id: { $in: ids } } : {}),
  }).limit(500).lean();
  const week = Math.floor(now.getTime() / (7 * DAY));
  let queued = 0;
  for (const c of cards) {
    queued += await enqueueNotifications({
      template: 'low_balance', payer: c, data: { payerName: c.name, availableKobo: c.creditLimitKobo - c.balanceKobo },
      dedupeKey: `lowbal:${c._id}:${week}`, relatedType: 'payer', relatedId: c._id,
    });
  }
  return { cardsLow: cards.length, queued };
}
