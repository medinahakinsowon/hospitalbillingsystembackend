import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { withTransaction } from '../config/db.js';
import { Invoice } from '../models/Invoice.js';
import { Patient } from '../models/Patient.js';
import { Payer } from '../models/Payer.js';
import { Payment } from '../models/Payment.js';
import { PaystackEvent } from '../models/PaystackEvent.js';
import { Encounter } from '../models/Encounter.js';
import { AppError } from '../utils/AppError.js';
import { nextSequence, pad } from '../utils/counters.js';
import { bumpInvoicePaid } from './invoices.service.js';
import { postLedgerEntry } from './ledger.service.js';
import { recordAudit } from './audit.service.js';
import * as paystack from './paystack.service.js';

const SYSTEM_CTX = { actorId: null, actorRole: 'system', ip: null, userAgent: 'paystack' };
const OPEN_INVOICE = { $in: ['issued', 'partial'] };

/** Validate what a payment is for, and that the amount does not exceed what is owed on it. */
async function resolveTarget({ payerId, amountKobo, invoiceId, encounterId }) {
  const payer = await Payer.findById(payerId).lean();
  if (!payer) throw new AppError(404, 'PAYER_NOT_FOUND', 'Payer not found');
  let patientId = payer.type === 'individual' ? payer.holderPatientId : undefined;

  if (invoiceId) {
    const inv = await Invoice.findById(invoiceId).lean();
    if (!inv) throw new AppError(404, 'INVOICE_NOT_FOUND', 'Invoice not found');
    if (String(inv.payerId) !== String(payerId)) throw new AppError(422, 'PAYER_MISMATCH', 'That invoice belongs to a different payer');
    const due = inv.totalKobo - inv.paidKobo;
    if (!['issued', 'partial'].includes(inv.status) || due <= 0) throw new AppError(422, 'INVOICE_NOT_PAYABLE', 'That invoice has nothing left to pay');
    if (amountKobo > due) throw new AppError(422, 'EXCEEDS_BALANCE', 'Amount is more than the invoice balance', { balanceKobo: due });
    patientId = inv.patientId ?? patientId;
  } else if (encounterId) {
    const enc = await Encounter.findById(encounterId).select('patientId').lean();
    if (!enc) throw new AppError(404, 'ENCOUNTER_NOT_FOUND', 'Encounter not found');
    const invs = await Invoice.find({ encounterId, payerId, status: OPEN_INVOICE }).select('totalKobo paidKobo').lean();
    const due = invs.reduce((s, i) => s + i.totalKobo - i.paidKobo, 0);
    if (due <= 0) throw new AppError(422, 'NOTHING_DUE', 'There is no open invoice for this payer on that encounter');
    if (amountKobo > due) throw new AppError(422, 'EXCEEDS_BALANCE', 'Amount is more than the outstanding balance', { balanceKobo: due });
    patientId = enc.patientId;
  }
  return { payer, patientId };
}

/** Apply a successful payment to its target invoices (oldest first). Anything left over stays as credit. */
async function allocatePayment(payment, session) {
  let remaining = payment.amountKobo;
  let invoices = [];
  if (payment.invoiceId) {
    invoices = await Invoice.find({ _id: payment.invoiceId, payerId: payment.payerId, status: OPEN_INVOICE }).session(session).lean();
  } else if (payment.encounterId) {
    invoices = await Invoice.find({ encounterId: payment.encounterId, payerId: payment.payerId, status: OPEN_INVOICE }).sort({ issuedAt: 1 }).session(session).lean();
  }
  const allocations = [];
  for (const inv of invoices) {
    if (remaining <= 0) break;
    const apply = Math.min(inv.totalKobo - inv.paidKobo, remaining);
    if (apply <= 0) continue;
    await bumpInvoicePaid(inv._id, apply, session);
    allocations.push({ invoiceId: inv._id, amountKobo: apply });
    remaining -= apply;
  }
  return { allocations, remaining };
}

/** Shared "money arrived" step: receipt number, ledger entry, allocation. Runs inside a transaction. */
async function completePayment(payment, extra, ctx, session) {
  const receiptNo = `RCT-${pad(await nextSequence('receipt', session))}`;
  const { entry } = await postLedgerEntry({
    payerId: payment.payerId, type: 'payment', amountKobo: -payment.amountKobo,
    description: `Payment ${receiptNo} (${payment.method})`,
    refType: 'payment', refId: payment._id, idempotencyKey: `payment:${payment._id}`, createdBy: ctx.actorId,
  }, session);
  const { allocations, remaining } = await allocatePayment(payment, session);
  const done = await Payment.findOneAndUpdate(
    { _id: payment._id, status: { $ne: 'success' } },
    { $set: { ...extra, status: 'success', receiptNo, ledgerEntryId: entry._id, completedAt: new Date(), unallocatedKobo: remaining, allocations } },
    { returnDocument: 'after', session }
  );
  if (!done) throw new AppError(409, 'PAYMENT_CHANGED', 'Payment changed while completing. Please retry.');
  return done;
}

// ---------------------------------------------------------------- manual (cash / POS / transfer)
export async function recordManualPayment(input, ctx) {
  const { payerId, amountKobo, method, invoiceId, encounterId, externalRef, idempotencyKey } = input;
  if (idempotencyKey) {
    const existing = await Payment.findOne({ idempotencyKey }).lean();
    if (existing) {
      if (String(existing.payerId) !== String(payerId) || existing.amountKobo !== amountKobo) {
        throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key was already used for a different payment');
      }
      return { payment: existing, duplicate: true };
    }
  }
  const { patientId } = await resolveTarget({ payerId, amountKobo, invoiceId, encounterId });

  const payment = await withTransaction(async (session) => {
    const [created] = await Payment.create([{
      payerId, patientId, invoiceId, encounterId, method, amountKobo, externalRef, idempotencyKey,
      status: 'pending', unallocatedKobo: 0, receivedBy: ctx.actorId,
    }], { session });
    const done = await completePayment(created, {}, ctx, session);
    await recordAudit(ctx, {
      action: 'payment.record', entity: 'Payment', entityId: done._id,
      after: { receiptNo: done.receiptNo, method, amountKobo, payerId, invoiceId, encounterId },
    }, session);
    return done.toObject();
  });
  return { payment, duplicate: false };
}

// ---------------------------------------------------------------- Paystack
export async function initiatePaystackPayment({ payerId, amountKobo, invoiceId, encounterId, email }, ctx) {
  if (!env.PAYSTACK_SECRET_KEY) throw new AppError(503, 'PAYSTACK_NOT_CONFIGURED', 'Paystack is not configured on this server');
  const { payer, patientId } = await resolveTarget({ payerId, amountKobo, invoiceId, encounterId });

  let payerEmail = email;
  if (!payerEmail && patientId) payerEmail = (await Patient.findById(patientId).select('email').lean())?.email;
  payerEmail ||= payer.billingContact?.email || env.PAYSTACK_FALLBACK_EMAIL;
  if (!payerEmail) throw new AppError(400, 'EMAIL_REQUIRED', 'Paystack needs an email address. Provide one, or set PAYSTACK_FALLBACK_EMAIL.');

  // Our own reference, stored BEFORE the customer is redirected, so any later webhook can be matched.
  const reference = `HB-${crypto.randomBytes(10).toString('hex')}`;
  const [payment] = await Payment.create([{
    payerId, patientId, invoiceId, encounterId, method: 'paystack', amountKobo,
    status: 'pending', receivedBy: ctx.actorId, paystack: { reference },
  }]);
  await recordAudit(ctx, { action: 'payment.paystack.initiate', entity: 'Payment', entityId: payment._id, after: { amountKobo, payerId, reference } });

  try {
    const init = await paystack.initializeTransaction({
      email: payerEmail, amount: amountKobo, currency: 'NGN', reference,
      ...(env.PAYSTACK_CALLBACK_URL ? { callback_url: env.PAYSTACK_CALLBACK_URL } : {}),
      metadata: { paymentId: String(payment._id), payerCode: payer.code },
    });
    await Payment.updateOne({ _id: payment._id }, { $set: {
      'paystack.accessCode': init.data.access_code, 'paystack.authorizationUrl': init.data.authorization_url,
    } });
    return { paymentId: payment._id, reference, authorizationUrl: init.data.authorization_url, accessCode: init.data.access_code };
  } catch (err) {
    // Not final: if Paystack did create the transaction, a later verify can still complete it.
    await Payment.updateOne({ _id: payment._id, status: 'pending' }, { $set: { status: 'failed', 'paystack.note': `initialize failed: ${err.code || err.name}` } });
    throw err;
  }
}

/**
 * The single place a Paystack payment becomes "paid". Called by the webhook, the verify endpoint and the
 * reconciliation job. Safe to call any number of times: a successful payment is never processed twice.
 * `gw` is the `data` object from Paystack's verify API (never trust webhook payloads directly).
 */
export async function finalizePaystackPayment(reference, gw) {
  return withTransaction(async (session) => {
    const payment = await Payment.findOne({ 'paystack.reference': reference }).session(session);
    if (!payment) return { outcome: 'unknown_reference' };
    if (payment.status === 'success') return { outcome: 'already_processed', payment: payment.toObject() };

    if (gw.status === 'success') {
      if (gw.currency !== 'NGN' || gw.amount !== payment.amountKobo) {
        await Payment.updateOne({ _id: payment._id }, { $set: {
          status: 'flagged',
          'paystack.note': `Mismatch: expected NGN ${payment.amountKobo} kobo, gateway reported ${gw.currency} ${gw.amount}`,
        } }, { session });
        await recordAudit(SYSTEM_CTX, {
          action: 'payment.paystack.mismatch', entity: 'Payment', entityId: payment._id,
          meta: { expectedKobo: payment.amountKobo, gatewayAmount: gw.amount, gatewayCurrency: gw.currency },
        }, session);
        return { outcome: 'amount_mismatch', payment: { ...payment.toObject(), status: 'flagged' } };
      }
      const done = await completePayment(payment, {
        'paystack.transactionId': gw.id, 'paystack.channel': gw.channel,
        'paystack.paidAt': gw.paid_at ? new Date(gw.paid_at) : new Date(),
        'paystack.gatewayResponse': gw.gateway_response, 'paystack.fees': gw.fees,
      }, SYSTEM_CTX, session);
      await recordAudit(SYSTEM_CTX, {
        action: 'payment.paystack.success', entity: 'Payment', entityId: done._id,
        after: { receiptNo: done.receiptNo, amountKobo: done.amountKobo, payerId: done.payerId },
      }, session);
      return { outcome: 'success', payment: done.toObject() };
    }

    if (gw.status === 'failed' || gw.status === 'abandoned') {
      await Payment.updateOne({ _id: payment._id, status: 'pending' }, { $set: { status: gw.status, 'paystack.gatewayResponse': gw.gateway_response } }, { session });
      return { outcome: gw.status };
    }
    return { outcome: 'still_pending' }; // ongoing / queued / pending at Paystack
  });
}

/** Staff-triggered check of one payment with Paystack (e.g. when the customer returns from checkout). */
export async function verifyPaymentById(paymentId) {
  const payment = await Payment.findById(paymentId).lean();
  if (!payment) throw new AppError(404, 'PAYMENT_NOT_FOUND', 'Payment not found');
  if (payment.method !== 'paystack') throw new AppError(422, 'NOT_PAYSTACK', 'Only Paystack payments can be verified');
  if (payment.status === 'success') return { outcome: 'already_processed', payment };
  const v = await paystack.verifyTransaction(payment.paystack.reference);
  return finalizePaystackPayment(payment.paystack.reference, v.data);
}

/**
 * Webhook entry point. The route has already verified the signature.
 * Payload contents are never trusted: we re-confirm the transaction with Paystack before crediting anything.
 */
export async function handlePaystackWebhook(rawBody) {
  const event = JSON.parse(rawBody.toString('utf8'));
  const eventType = event?.event;
  const reference = event?.data?.reference;
  if (eventType !== 'charge.success' || !reference) return { handled: false, reason: 'ignored_event' };

  const log = await PaystackEvent.findOneAndUpdate(
    { eventType, reference },
    { $setOnInsert: { receivedAt: new Date(), status: 'received', summary: {
      amount: event.data.amount, currency: event.data.currency, channel: event.data.channel, gatewayStatus: event.data.status,
    } }, $inc: { attempts: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  if (log.status === 'processed') return { handled: true, reason: 'duplicate' };

  try {
    const verified = await paystack.verifyTransaction(reference);
    const result = await finalizePaystackPayment(reference, verified.data);
    await PaystackEvent.updateOne({ _id: log._id }, { $set: { status: result.outcome === 'amount_mismatch' ? 'failed' : 'processed', outcome: result.outcome, processedAt: new Date() } });
    return { handled: true, reason: result.outcome };
  } catch (err) {
    await PaystackEvent.updateOne({ _id: log._id }, { $set: { status: 'failed', error: `${err.code || err.name}: ${err.message}`.slice(0, 300) } });
    throw err; // non-2xx makes Paystack retry later
  }
}

/** Sweep stuck pending Paystack payments. Run from a scheduled job or by staff. */
export async function reconcilePendingPayments({ olderThanMinutes = 5, limit = 50 } = {}) {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60000);
  const pending = await Payment.find({ method: 'paystack', status: 'pending', createdAt: { $lte: cutoff } }).sort({ createdAt: 1 }).limit(limit).lean();
  const results = [];
  for (const p of pending) {
    const reference = p.paystack.reference;
    try {
      const v = await paystack.verifyTransaction(reference);
      const r = await finalizePaystackPayment(reference, v.data);
      results.push({ reference, outcome: r.outcome });
    } catch (err) {
      // Paystack has no record of it. After 24h assume the customer never started checkout.
      if (Date.now() - p.createdAt.getTime() > 24 * 3600 * 1000) {
        await Payment.updateOne({ _id: p._id, status: 'pending' }, { $set: { status: 'abandoned', 'paystack.note': 'No Paystack record after 24h' } });
        results.push({ reference, outcome: 'abandoned' });
      } else {
        results.push({ reference, outcome: 'error', error: err.code || err.name });
      }
    }
  }
  return { checked: pending.length, results };
}

export async function listPayments({ payerId, patientId, status, method, page, limit }) {
  const filter = {};
  if (payerId) filter.payerId = payerId;
  if (patientId) filter.patientId = patientId;
  if (status) filter.status = status;
  if (method) filter.method = method;
  const [items, total] = await Promise.all([
    Payment.find(filter).select('-paystack.accessCode').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Payment.countDocuments(filter),
  ]);
  return { items, page, limit, total };
}

export async function getPayment(id) {
  const payment = await Payment.findById(id).select('-paystack.accessCode').lean();
  if (!payment) throw new AppError(404, 'PAYMENT_NOT_FOUND', 'Payment not found');
  return payment;
}
