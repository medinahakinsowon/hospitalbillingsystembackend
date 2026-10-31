import { Charge } from '../models/Charge.js';
import { Coverage } from '../models/Coverage.js';
import { Invoice } from '../models/Invoice.js';
import { LedgerEntry } from '../models/LedgerEntry.js';
import { Payer } from '../models/Payer.js';
import { Payment } from '../models/Payment.js';
import { AppError } from '../utils/AppError.js';
import { lastCompletedPeriod } from './billing-cycle.service.js';
import { toPayerView } from './payers.service.js';

const DAY = 86400000;

/**
 * Ledger-based account statement: opening balance, every movement in the period, closing balance.
 * Positive balance = the payer owes the hospital; negative = credit (deposit) held.
 */
export async function getAccountStatement(payerId, { from, to, limit = 1000 } = {}) {
  const payer = await Payer.findById(payerId).lean();
  if (!payer) throw new AppError(404, 'PAYER_NOT_FOUND', 'Payer not found');
  const end = to ?? new Date();
  const start = from ?? new Date(end.getTime() - 30 * DAY);
  if (start >= end) throw new AppError(400, 'INVALID_PERIOD', '"from" must be before "to"');

  const range = { payerId: payer._id, createdAt: { $gte: start, $lt: end } };
  const [openingEntry, entries, lastInRange] = await Promise.all([
    LedgerEntry.findOne({ payerId: payer._id, createdAt: { $lt: start } }).sort({ seq: -1 }).select('balanceAfterKobo').lean(),
    LedgerEntry.find(range).sort({ seq: 1 }).limit(limit + 1).lean(),
    LedgerEntry.findOne(range).sort({ seq: -1 }).select('balanceAfterKobo').lean(),
  ]);
  const openingKobo = openingEntry?.balanceAfterKobo ?? 0;
  const truncated = entries.length > limit;
  const rows = truncated ? entries.slice(0, limit) : entries;
  const closingKobo = lastInRange?.balanceAfterKobo ?? openingKobo;

  return {
    payer: { id: payer._id, code: payer.code, name: payer.name, type: payer.type, mode: payer.mode },
    from: start, to: end, openingKobo, closingKobo, truncated,
    totals: {
      chargesKobo: rows.filter((e) => e.amountKobo > 0).reduce((s, e) => s + e.amountKobo, 0),
      paymentsKobo: -rows.filter((e) => e.amountKobo < 0).reduce((s, e) => s + e.amountKobo, 0),
    },
    entries: rows.map((e) => ({
      seq: e.seq, at: e.createdAt, type: e.type, description: e.description,
      amountKobo: e.amountKobo, balanceAfterKobo: e.balanceAfterKobo,
    })),
  };
}

/** One-screen overview of an account for billing officers. */
export async function getPayerSummary(payerId) {
  const payer = await Payer.findById(payerId).lean();
  if (!payer) throw new AppError(404, 'PAYER_NOT_FOUND', 'Payer not found');
  const now = new Date();
  const open = { $in: ['issued', 'partial'] };
  const owed = { $subtract: ['$totalKobo', '$paidKobo'] };

  const [members, invoices, uninvoiced, credit] = await Promise.all([
    Coverage.countDocuments({ payerId: payer._id, status: 'active' }),
    Invoice.aggregate([
      { $match: { payerId: payer._id, status: open } },
      { $group: { _id: null, count: { $sum: 1 }, outstandingKobo: { $sum: owed }, overdueKobo: { $sum: { $cond: [{ $lt: ['$dueAt', now] }, owed, 0] } } } },
    ]),
    Charge.aggregate([
      { $match: { payerId: payer._id, status: 'posted', invoiceId: null } },
      { $group: { _id: null, count: { $sum: 1 }, totalKobo: { $sum: '$totalKobo' } } },
    ]),
    Payment.aggregate([
      { $match: { payerId: payer._id, status: 'success', unallocatedKobo: { $gt: 0 } } },
      { $group: { _id: null, totalKobo: { $sum: '$unallocatedKobo' } } },
    ]),
  ]);

  const view = toPayerView(payer);
  const summary = {
    payer: view,
    activeMembers: members,
    openInvoices: { count: invoices[0]?.count ?? 0, outstandingKobo: invoices[0]?.outstandingKobo ?? 0, overdueKobo: invoices[0]?.overdueKobo ?? 0 },
    uninvoicedCharges: { count: uninvoiced[0]?.count ?? 0, totalKobo: uninvoiced[0]?.totalKobo ?? 0 },
    unappliedCreditKobo: credit[0]?.totalKobo ?? 0,
  };

  if (payer.type === 'corporate' && payer.contract?.endsAt) {
    summary.contract = { endsAt: payer.contract.endsAt, daysRemaining: Math.ceil((payer.contract.endsAt - now) / DAY), expired: payer.contract.endsAt < now };
  }
  if (payer.type === 'family' && payer.mode === 'prepaid') {
    summary.lowBalance = (view.availableKobo ?? 0) <= (payer.lowBalanceThresholdKobo ?? 0);
  }
  if (payer.billingCycle && (payer.type === 'corporate' || payer.mode === 'credit')) {
    const { start, end } = lastCompletedPeriod(payer.billingCycle, now);
    summary.billing = {
      cycle: payer.billingCycle, lastInvoicedThrough: payer.lastInvoicedThrough ?? null,
      pendingPeriod: { start, end }, invoiceDue: !payer.lastInvoicedThrough || payer.lastInvoicedThrough < end,
    };
  }
  return summary;
}
