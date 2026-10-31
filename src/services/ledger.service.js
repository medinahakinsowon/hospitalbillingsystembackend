import mongoose from 'mongoose';
import { Payer } from '../models/Payer.js';
import { LedgerEntry } from '../models/LedgerEntry.js';
import { AppError } from '../utils/AppError.js';
import { withTransaction } from '../config/db.js';
import { recordAudit } from './audit.service.js';

// Sign convention: positive = payer owes more, negative = payer owes less.
const SIGN_RULES = {
  charge: (a) => a > 0,
  payment: (a) => a < 0,
  refund: (a) => a > 0, // money returned to the payer increases what they "owe" (reduces their deposit)
  writeoff: (a) => a < 0,
  adjustment: (a) => a !== 0,
  reversal: (a) => a !== 0,
};

/**
 * Append one entry to a payer's ledger and update the cached balance atomically.
 * MUST run inside a transaction (pass the session). Credit limits are enforced inside the
 * update filter itself, so two simultaneous charges can never both pass the check.
 */
export async function postLedgerEntry(input, session) {
  const {
    payerId, type, amountKobo, description, refType, refId, encounterId, invoiceId,
    idempotencyKey, reversalOf, createdBy = null, allowOverLimit = false,
    forceEnforce = false, // enforce the limit even if the payer normally has enforceLimit: false (walk-in deposit-first policy)
  } = input;

  if (!session) throw new Error('postLedgerEntry must run inside a transaction');
  if (!Number.isSafeInteger(amountKobo) || amountKobo === 0) {
    throw new AppError(400, 'INVALID_AMOUNT', 'amountKobo must be a non-zero integer number of kobo');
  }
  const signOk = SIGN_RULES[type];
  if (!signOk) throw new AppError(400, 'INVALID_TYPE', `Unknown ledger entry type: ${type}`);
  if (!signOk(amountKobo)) throw new AppError(400, 'INVALID_SIGN', `Amount sign is not valid for a ${type} entry`);
  if (!idempotencyKey) throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'idempotencyKey is required');

  // Idempotency: replaying the same operation returns the original entry instead of double-posting.
  const existing = await LedgerEntry.findOne({ idempotencyKey }).session(session).lean();
  if (existing) {
    if (String(existing.payerId) !== String(payerId) || existing.amountKobo !== amountKobo) {
      throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key was already used for a different entry');
    }
    return { entry: existing, duplicate: true };
  }

  const filter = { _id: payerId };
  if (type === 'charge') filter.status = 'active'; // only active payers can be charged
  const enforce = type === 'charge' && !allowOverLimit;
  if (enforce) {
    const withinLimit = { $expr: { $lte: [{ $add: ['$balanceKobo', amountKobo] }, '$creditLimitKobo'] } };
    filter.$or = forceEnforce ? [withinLimit] : [{ enforceLimit: false }, withinLimit];
  }

  const payer = await Payer.findOneAndUpdate(
    filter,
    { $inc: { balanceKobo: amountKobo, ledgerSeq: 1 } },
    { returnDocument: 'after', session }
  );

  if (!payer) {
    const p = await Payer.findById(payerId).session(session).lean();
    if (!p) throw new AppError(404, 'PAYER_NOT_FOUND', 'Payer not found');
    if (type === 'charge' && p.status !== 'active') {
      throw new AppError(422, 'PAYER_NOT_ACTIVE', `Payer is ${p.status} and cannot be charged`);
    }
    throw new AppError(422, 'CREDIT_LIMIT_EXCEEDED', 'This charge would exceed the payer\'s available limit', {
      creditLimitKobo: p.creditLimitKobo,
      balanceKobo: p.balanceKobo,
      availableKobo: p.creditLimitKobo - p.balanceKobo,
      requestedKobo: amountKobo,
    });
  }

  const [entry] = await LedgerEntry.create(
    [{
      payerId, seq: payer.ledgerSeq, type, amountKobo, balanceAfterKobo: payer.balanceKobo,
      description, refType, refId, encounterId, invoiceId, idempotencyKey, reversalOf, createdBy,
    }],
    { session }
  );
  return { entry: entry.toObject(), duplicate: false };
}

/** Convenience wrapper that opens its own transaction. */
export const postEntry = (input) => withTransaction((session) => postLedgerEntry(input, session));

/** Reverse an entry by posting its opposite, inside an existing transaction. Entries are never edited or deleted. */
export async function reverseLedgerEntryInTx({ entryId, reason }, ctx, session) {
  const original = await LedgerEntry.findById(entryId).session(session).lean();
  if (!original) throw new AppError(404, 'ENTRY_NOT_FOUND', 'Ledger entry not found');
  if (original.type === 'reversal') throw new AppError(422, 'CANNOT_REVERSE_REVERSAL', 'A reversal cannot be reversed');

  const { entry, duplicate } = await postLedgerEntry(
    {
      payerId: original.payerId,
      type: 'reversal',
      amountKobo: -original.amountKobo,
      description: `Reversal of #${original.seq}: ${reason}`.slice(0, 300),
      refType: 'ledgerEntry',
      refId: original._id,
      encounterId: original.encounterId,
      reversalOf: original._id,
      idempotencyKey: `reversal:${original._id}`,
      createdBy: ctx.actorId,
      allowOverLimit: true, // corrections must always be possible
    },
    session
  );
  if (!duplicate) {
    await recordAudit(ctx, {
      action: 'ledger.reverse', entity: 'LedgerEntry', entityId: original._id,
      meta: { payerId: original.payerId, amountKobo: original.amountKobo, reason },
    }, session);
  }
  return entry;
}

export const reverseLedgerEntry = (args, ctx) => withTransaction((session) => reverseLedgerEntryInTx(args, ctx, session));

export async function listLedger(payerId, { type, page, limit }) {
  const filter = { payerId: new mongoose.Types.ObjectId(payerId), ...(type ? { type } : {}) };
  const [items, total] = await Promise.all([
    LedgerEntry.find(filter).sort({ seq: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    LedgerEntry.countDocuments(filter),
  ]);
  return { items, page, limit, total };
}

/** Recompute a payer's balance from the ledger and compare with the cached value. */
export async function reconcilePayer(payerId) {
  const payer = await Payer.findById(payerId).lean();
  if (!payer) throw new AppError(404, 'PAYER_NOT_FOUND', 'Payer not found');
  const [agg] = await LedgerEntry.aggregate([
    { $match: { payerId: payer._id } },
    { $group: { _id: null, sum: { $sum: '$amountKobo' }, count: { $sum: 1 }, maxSeq: { $max: '$seq' } } },
  ]);
  const ledgerBalanceKobo = agg?.sum ?? 0;
  const entries = agg?.count ?? 0;
  const maxSeq = agg?.maxSeq ?? 0;
  const ok = payer.balanceKobo === ledgerBalanceKobo && payer.ledgerSeq === maxSeq && entries === maxSeq;
  return {
    payerId: payer._id, ok,
    cachedBalanceKobo: payer.balanceKobo, ledgerBalanceKobo,
    differenceKobo: payer.balanceKobo - ledgerBalanceKobo,
    entries, lastSeq: maxSeq, payerLedgerSeq: payer.ledgerSeq,
  };
}
