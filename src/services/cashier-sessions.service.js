import mongoose from "mongoose";
import { env } from "../config/env.js";
import { withTransaction } from "../config/db.js";
import { can } from "../config/permissions.js";
import { CashierSession } from "../models/CashierSession.js";
import { Payment } from "../models/Payment.js";
import { Refund } from "../models/Refund.js";
import { AppError } from "../utils/AppError.js";
import { nextSequence, pad } from "../utils/counters.js";
import { assertDifferentPerson } from "../utils/makerChecker.js";
import { recordAudit } from "./audit.service.js";

/*
 * Every cash/POS/transfer payment and every refund payout must belong to the acting cashier's open shift,
 * so each shift can be reconciled against what was physically counted. Scripts and system actions (no actor) are exempt.
 */
export async function requireOpenSession(ctx) {
  if (!env.REQUIRE_CASHIER_SESSION || !ctx.actorId) return null;
  const s = await CashierSession.findOne({
    cashierId: ctx.actorId,
    status: "open",
  })
    .select("_id")
    .lean();
  if (!s)
    throw new AppError(
      422,
      "CASHIER_SESSION_REQUIRED",
      "Open your cashier session before taking payments or paying out refunds",
    );
  return s;
}

/*
 * Write to the session inside the payment's transaction. Closing a shift also writes to it, so a payment and a close
 * can never slip past each other: one of them retries and sees the other.
 */
export async function touchSession(sessionId, mongoSession) {

  const r = await CashierSession.updateOne(
    { _id: sessionId, status: "open" },
    { $inc: { paymentCount: 1 } },
    { session: mongoSession },
  );

  if (r.matchedCount !== 1)
    throw new AppError(
      422,
      "CASHIER_SESSION_REQUIRED",
      "Your cashier session was closed. Open a new one to continue.",
  );
  
}

/** What the ledger says should be in the till for this shift. Cash leaving as refunds is subtracted. */
async function computeTotals(sessionId, floatKobo, mongoSession) {
  const run = (q) => (mongoSession ? q.session(mongoSession) : q);
  const [received, paidOut] = await Promise.all([
    run(
      Payment.aggregate([
        { $match: { cashierSessionId: sessionId, status: "success" } },
        {
          $group: {
            _id: "$method",
            totalKobo: { $sum: "$amountKobo" },
            count: { $sum: 1 },
          },
        },
      ]),
    ),
    run(
      Refund.aggregate([
        { $match: { paidSessionId: sessionId, status: "paid" } },
        {
          $group: {
            _id: "$method",
            totalKobo: { $sum: "$amountKobo" },
            count: { $sum: 1 },
          },
        },
      ]),
    ),
  ]);
  const get = (rows, m) =>
    rows.find((r) => r._id === m) ?? { totalKobo: 0, count: 0 };
  return {
    counts: {
      payments: received.reduce((s, r) => s + r.count, 0),
      refundsPaid: paidOut.reduce((s, r) => s + r.count, 0),
    },
    expected: {
      cashKobo:
        floatKobo +
        get(received, "cash").totalKobo -
        get(paidOut, "cash").totalKobo,
      posKobo: get(received, "pos").totalKobo,
      transferKobo:
        get(received, "transfer").totalKobo -
        get(paidOut, "transfer").totalKobo,
    },
  };
}

export async function openSession({ openingFloatKobo = 0 }, ctx) {
  if (!ctx.actorId)
    throw new AppError(
      400,
      "USER_REQUIRED",
      "A cashier session must belong to a signed-in user",
    );
  return withTransaction(async (session) => {
    const sessionNo = `CS-${pad(await nextSequence("cashiersession", session))}`;
    let created;
    try {
      [created] = await CashierSession.create(
        [{ sessionNo, cashierId: ctx.actorId, openingFloatKobo }],
        { session },
      );
    } catch (err) {
      if (err.code === 11000)
        throw new AppError(
          409,
          "SESSION_ALREADY_OPEN",
          "You already have an open cashier session. Close it first.",
        );
      throw err;
    }
    await recordAudit(
      ctx,
      {
        action: "cashier_session.open",
        entity: "CashierSession",
        entityId: created._id,
        after: { sessionNo, openingFloatKobo },
      },
      session,
    );
    return created.toObject();
  });
}

/** Strip what a cashier must not see while their shift is open, so the count at close is a genuine blind count. */
function visibleTo(sess, ctx, totals) {
  const reviewer = can(ctx.actorRole, "sessions:review");
  const blind = sess.status === "open" && !reviewer;
  const { expected, variance, ...rest } = sess;
  return {
    ...rest,
    ...(blind ? {} : { expected: sess.expected, variance: sess.variance }),
    ...(totals
      ? {
          activity: totals.counts,
          ...(blind ? {} : { liveExpected: totals.expected }),
        }
      : {}),
  };
}

export async function getCurrentSession(ctx) {
  const sess = await CashierSession.findOne({
    cashierId: ctx.actorId,
    status: "open",
  }).lean();
  if (!sess) return { open: false };
  const totals = await computeTotals(sess._id, sess.openingFloatKobo);
  return { open: true, session: visibleTo(sess, ctx, totals) };
}

/** Close a shift: the cashier reports what they counted; the system compares it with what it expected. */
export async function closeSession(
  id,
  { countedCashKobo, countedPosKobo, countedTransferKobo, note },
  ctx,
) {
  const reviewer = can(ctx.actorRole, "sessions:review"); // a finance manager may close a shift a cashier forgot to close
  return withTransaction(async (session) => {
    const sess = await CashierSession.findOneAndUpdate(
      {
        _id: id,
        status: "open",
        ...(reviewer ? {} : { cashierId: ctx.actorId }),
      },
      { $set: { status: "closed", closedAt: new Date() } },
      { returnDocument: "after", session },
    );
    if (!sess) {
      const existing = await CashierSession.findById(id)
        .session(session)
        .lean();
      if (!existing)
        throw new AppError(
          404,
          "SESSION_NOT_FOUND",
          "Cashier session not found",
        );
      if (String(existing.cashierId) !== String(ctx.actorId) && !reviewer)
        throw new AppError(
          403,
          "NOT_YOUR_SESSION",
          "This is another cashier's session",
        );
      throw new AppError(
        422,
        "SESSION_NOT_OPEN",
        `This session is already ${existing.status}`,
      );
    }

    const { expected } = await computeTotals(
      sess._id,
      sess.openingFloatKobo,
      session,
    );
    const counted = {
      cashKobo: countedCashKobo,
      posKobo: countedPosKobo,
      transferKobo: countedTransferKobo,
    };
    const variance = {
      cashKobo: counted.cashKobo - expected.cashKobo,
      posKobo: counted.posKobo - expected.posKobo,
      transferKobo: counted.transferKobo - expected.transferKobo,
    };
    const flagged = Object.values(variance).some(
      (v) => Math.abs(v) > env.CASH_VARIANCE_ALERT_KOBO,
    );
    sess.set({ expected, counted, variance, flagged, closeNote: note });
    await sess.save({ session });
    await recordAudit(
      ctx,
      {
        action: "cashier_session.close",
        entity: "CashierSession",
        entityId: sess._id,
        after: {
          sessionNo: sess.sessionNo,
          expected,
          counted,
          variance,
          flagged,
        },
        meta:
          String(sess.cashierId) !== String(ctx.actorId)
            ? { closedOnBehalfOf: sess.cashierId }
            : undefined,
      },
      session,
    );
    return sess.toObject(); // the cashier now learns the variance
  });
}

/** A second person signs off a closed shift, acknowledging any variance. */
export async function reviewSession(id, { note }, ctx) {
  const existing = await CashierSession.findById(id).lean();
  if (!existing)
    throw new AppError(404, "SESSION_NOT_FOUND", "Cashier session not found");
  assertDifferentPerson(existing.cashierId, ctx, "cashier session");
  const sess = await CashierSession.findOneAndUpdate(
    { _id: id, status: "closed" },
    {
      $set: {
        status: "reviewed",
        reviewedBy: ctx.actorId,
        reviewedAt: new Date(),
        reviewNote: note,
      },
    },
    { returnDocument: "after" },
  );
  if (!sess)
    throw new AppError(
      422,
      "NOT_REVIEWABLE",
      `Only closed sessions can be reviewed (this one is ${existing.status})`,
    );
  await recordAudit(ctx, {
    action: "cashier_session.review",
    entity: "CashierSession",
    entityId: sess._id,
    meta: { note, flagged: sess.flagged, variance: sess.variance },
  });
  return sess.toObject();
}

export async function getSession(id, ctx) {
  const sess = await CashierSession.findById(id).lean();
  if (!sess)
    throw new AppError(404, "SESSION_NOT_FOUND", "Cashier session not found");
  const reviewer = can(ctx.actorRole, "sessions:review");
  if (!reviewer && String(sess.cashierId) !== String(ctx.actorId))
    throw new AppError(
      403,
      "NOT_YOUR_SESSION",
      "This is another cashier's session",
    );
  const totals = await computeTotals(sess._id, sess.openingFloatKobo);
  const out = visibleTo(sess, ctx, totals);
  if (sess.status !== "open" || reviewer) {
    const payments = await Payment.find({
      cashierSessionId: sess._id,
      status: "success",
    })
      .sort({ completedAt: 1 })
      .limit(500)
      .select("receiptNo method amountKobo payerId completedAt externalRef")
      .lean();
    const refunds = await Refund.find({
      paidSessionId: sess._id,
      status: "paid",
    })
      .select("refundNo method amountKobo payerId paidAt payoutRef")
      .lean();
    return { ...out, payments, refunds };
  }
  return out;
}

export async function listSessions(
  { status, cashierId, flagged, from, to, page, limit },
  ctx,
) {
  const filter = {};
  if (!can(ctx.actorRole, "sessions:review"))
    filter.cashierId = ctx.actorId; // cashiers only ever see their own
  else if (cashierId) filter.cashierId = new mongoose.Types.ObjectId(cashierId);
  if (status) filter.status = status;
  if (flagged !== undefined) filter.flagged = flagged;
  if (from || to)
    filter.openedAt = { ...(from && { $gte: from }), ...(to && { $lt: to }) };
  const [items, total] = await Promise.all([
    CashierSession.find(filter)
      .populate("cashierId", "name")
      .sort({ openedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    CashierSession.countDocuments(filter),
  ]);
  const reviewer = can(ctx.actorRole, "sessions:review");
  return {
    items: items.map((s) =>
      s.status === "open" && !reviewer ? visibleTo(s, ctx) : s,
    ),
    page,
    limit,
    total,
  };
}
