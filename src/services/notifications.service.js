import { env } from '../config/env.js';
import { Notification } from '../models/Notification.js';
import { Patient } from '../models/Patient.js';
import { AppError } from '../utils/AppError.js';
import { sendMessage } from './notify-providers.js';
import { templates } from './notification-templates.js';
import { recordAudit } from './audit.service.js';

const MAX_ATTEMPTS = 3;

/** Who to message for a payer, honouring opt-outs. Null means "do not message". */
export async function resolveContact(payer, mongoSession) {
  if (payer.notifyOptOut) return null;
  const bc = payer.billingContact ?? {};
  if (payer.type === 'corporate' || (payer.type === 'family' && (bc.email || bc.phone))) return { email: bc.email, phone: bc.phone };
  if (!payer.holderPatientId) return null;
  const q = Patient.findById(payer.holderPatientId).select('email phone notifyOptOut');
  const patient = await (mongoSession ? q.session(mongoSession) : q).lean();
  if (!patient || patient.notifyOptOut) return null;
  return { email: patient.email, phone: patient.phone };
}

/**
 * Put messages in the outbox (one per available channel). Pass the transaction's session to make this part of
 * the same transaction as the event, so a message is queued if and only if the event really happened.
 * The dedupeKey guarantees the same event never queues twice. Returns how many new messages were queued.
 */
export async function enqueueNotifications({ template, payer, data, dedupeKey, relatedType, relatedId }, mongoSession) {
  if (!env.NOTIFICATIONS_ENABLED) return 0;
  const contact = await resolveContact(payer, mongoSession);
  if (!contact) return 0;
  const msg = templates[template](data);
  let queued = 0;
  for (const [channel, to] of [['email', contact.email], ['sms', contact.phone]]) {
    if (!to) continue;
    const doc = { channel, to, body: msg.body, template, payerId: payer._id, relatedType, relatedId, status: 'queued', sendAfter: new Date(), ...(channel === 'email' ? { subject: msg.subject } : {}) };
    try {
      const r = await Notification.updateOne({ dedupeKey: `${dedupeKey}:${channel}` }, { $setOnInsert: doc }, { upsert: true, ...(mongoSession ? { session: mongoSession } : {}) });
      if (r.upsertedCount) queued++;
    } catch (err) {
      if (err.code !== 11000 || mongoSession) throw err; // two simultaneous upserts of the same event: the other one queued it
    }
  }
  return queued;
}

async function sendOne(n) {
  try {
    const r = await sendMessage(n.channel, { to: n.to, subject: n.subject, body: n.body });
    await Notification.updateOne({ _id: n._id }, { $set: { status: 'sent', sentAt: new Date(), providerId: r.providerId }, $unset: { lastError: 1 } });
    return 'sent';
  } catch (err) {
    const failed = n.attempts >= MAX_ATTEMPTS;
    await Notification.updateOne({ _id: n._id }, { $set: {
      status: failed ? 'failed' : 'queued', sendAfter: new Date(Date.now() + n.attempts * 15 * 60000), lastError: String(err.message || 'error').slice(0, 300),
    } });
    return failed ? 'failed' : 'retry';
  }
}

/** Send queued messages, oldest first. Each is claimed atomically, so overlapping runs never double-send. */
export async function dispatchNotifications({ limit = 100, budgetMs = 30000, filter = {} } = {}) {
  await Notification.updateMany({ status: 'sending', claimedAt: { $lt: new Date(Date.now() - 10 * 60000) } }, { $set: { status: 'queued' } }); // crashed mid-send
  const out = { sent: 0, retry: 0, failed: 0 };
  const started = Date.now();
  for (let i = 0; i < limit && Date.now() - started < budgetMs; i++) {
    const n = await Notification.findOneAndUpdate(
      { status: 'queued', sendAfter: { $lte: new Date() }, ...filter },
      { $set: { status: 'sending', claimedAt: new Date() }, $inc: { attempts: 1 } },
      { sort: { sendAfter: 1 }, returnDocument: 'after' }
    );
    if (!n) break;
    out[await sendOne(n)]++;
  }
  return out;
}

/** Try to send an event's messages right away without ever failing or noticeably delaying the caller. */
export async function dispatchRelatedBestEffort(relatedType, relatedId) {
  if (!env.NOTIFICATIONS_ENABLED || !relatedId) return null;
  try {
    return await Promise.race([
      dispatchNotifications({ limit: 5, budgetMs: 3000, filter: { relatedType, relatedId } }),
      new Promise((resolve) => setTimeout(() => resolve(null), 4000)),
    ]);
  } catch {
    return null; // stays queued; the daily job retries it
  }
}

export async function listNotifications({ status, channel, payerId, page, limit }) {
  const filter = {};
  if (status) filter.status = status;
  if (channel) filter.channel = channel;
  if (payerId) filter.payerId = payerId;
  const [items, total] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Notification.countDocuments(filter),
  ]);
  return { items, page, limit, total };
}

export async function retryNotification(id, ctx) {
  const n = await Notification.findOneAndUpdate({ _id: id, status: 'failed' }, { $set: { status: 'queued', attempts: 0, sendAfter: new Date() } }, { returnDocument: 'after' });
  if (!n) throw new AppError(422, 'NOT_RETRYABLE', 'Only failed notifications can be retried');
  await recordAudit(ctx, { action: 'notification.retry', entity: 'Notification', entityId: n._id });
  return n.toObject();
}
