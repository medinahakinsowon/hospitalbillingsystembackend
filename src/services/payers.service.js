import { env } from '../config/env.js';
import { withTransaction } from '../config/db.js';
import { Invoice } from '../models/Invoice.js';
import { Payer } from '../models/Payer.js';
import { Patient } from '../models/Patient.js';
import { Coverage } from '../models/Coverage.js';
import { AppError } from '../utils/AppError.js';
import { nextSequence, pad } from '../utils/counters.js';
import { escapeRegex } from '../utils/escapeRegex.js';
import { recordAudit, changedFields } from './audit.service.js';

const PREFIX = { corporate: 'COR', family: 'FAM', individual: 'IND' };

export const toPayerView = (p) => ({
  ...p,
  availableKobo: p.enforceLimit ? p.creditLimitKobo - p.balanceKobo : null,
});

export async function createPayer(data, ctx) {
  let holder = null;
  const doc = { ...data, createdBy: ctx.actorId };

  if (data.type === 'family') {
    holder = await Patient.findOne({ _id: data.holderPatientId, deletedAt: null }).lean();
    if (!holder) throw new AppError(404, 'PATIENT_NOT_FOUND', 'Card holder patient not found');
    const existingCard = await Payer.findOne({ type: 'family', holderPatientId: holder._id, status: { $ne: 'closed' } }).lean();
    if (existingCard) throw new AppError(409, 'CARD_EXISTS', 'This patient already holds a family card', { code: existingCard.code });

    doc.mode = data.mode ?? 'credit';
    doc.enforceLimit = true;
    doc.name = data.name ?? `${holder.lastName} Family Card`;
    doc.paymentTermsDays = data.paymentTermsDays ?? 30;
    doc.billingCycle = data.billingCycle ?? 'monthly';
    doc.maxMembers = data.maxMembers ?? env.FAMILY_CARD_MAX_MEMBERS;
    if (doc.mode === 'prepaid') {
      doc.creditLimitKobo = 0; // available = deposit held (negative balance)
    } else {
      // Credit is the default. The card holder is liable, so vet them before issuing.
      if (!(data.creditLimitKobo > 0)) throw new AppError(400, 'CREDIT_LIMIT_REQUIRED', 'A credit-mode family card needs a credit limit above zero');
      if (!data.guarantor?.name || !data.guarantor?.phone) throw new AppError(400, 'GUARANTOR_REQUIRED', 'A credit-mode family card needs a guarantor name and phone');
    }
  } else {
    doc.enforceLimit = true;
  }

  return withTransaction(async (session) => {
    const code = `${PREFIX[data.type]}-${pad(await nextSequence(`payer:${data.type}`, session))}`;
    const [payer] = await Payer.create([{ ...doc, code }], { session });
    if (holder) {
      await Coverage.create([{ payerId: payer._id, patientId: holder._id, relationship: 'holder', createdBy: ctx.actorId }], { session });
    }
    await recordAudit(ctx, {
      action: 'payer.create', entity: 'Payer', entityId: payer._id,
      after: { type: payer.type, code: payer.code, name: payer.name, mode: payer.mode, creditLimitKobo: payer.creditLimitKobo },
    }, session);
    return toPayerView(payer.toObject());
  });
}

export async function listPayers({ type, status, q, page, limit }) {
  const filter = {};
  if (type) filter.type = type;
  if (status) filter.status = status;
  if (q) {
    const rx = new RegExp(escapeRegex(q.trim()), 'i');
    filter.$or = [{ name: rx }, { code: rx }];
  }
  const [items, total] = await Promise.all([
    Payer.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Payer.countDocuments(filter),
  ]);
  return { items: items.map(toPayerView), page, limit, total };
}

export async function getPayer(id) {
  const payer = await Payer.findById(id).lean();
  if (!payer) throw new AppError(404, 'PAYER_NOT_FOUND', 'Payer not found');
  return toPayerView(payer);
}

const UPDATABLE = ['name', 'status', 'billingContact', 'creditLimitKobo', 'paymentTermsDays', 'billingCycle', 'guarantor', 'contract', 'tariffId', 'maxMembers', 'lowBalanceThresholdKobo', 'copay', 'authorizationThresholdKobo'];

export async function updatePayer(id, patch, ctx) {
  const payer = await Payer.findById(id);
  if (!payer) throw new AppError(404, 'PAYER_NOT_FOUND', 'Payer not found');
  if (payer.type === 'individual' && (patch.creditLimitKobo !== undefined || patch.contract || patch.guarantor || patch.copay || patch.authorizationThresholdKobo)) {
    throw new AppError(422, 'NOT_ALLOWED', 'Individual payers do not have credit limits, contracts or guarantors');
  }
  if (payer.type === 'family' && payer.mode === 'prepaid' && patch.creditLimitKobo) {
    throw new AppError(422, 'NOT_ALLOWED', 'Prepaid cards cannot have a credit limit');
  }
  const before = payer.toObject();
  const diff = changedFields(before, patch, UPDATABLE);
  if (!Object.keys(diff.after).length) return toPayerView(before);

  payer.set(diff.after);
  await payer.save();
  await recordAudit(ctx, { action: 'payer.update', entity: 'Payer', entityId: payer._id, ...diff });
  return toPayerView(payer.toObject());
}

// ------------------------------------------------------------------ Phase 3: contracts and card modes

/** Corporate payers whose contract ends within `days` (including contracts already expired but still active). */
export async function listExpiringContracts({ days }) {
  const horizon = new Date(Date.now() + days * 86400000);
  const items = await Payer.find({ type: 'corporate', status: { $ne: 'closed' }, 'contract.endsAt': { $lte: horizon } })
    .sort({ 'contract.endsAt': 1 }).limit(200).lean();
  const now = Date.now();
  return items.map((p) => ({
    ...toPayerView(p),
    contractDaysRemaining: Math.ceil((p.contract.endsAt - now) / 86400000),
    contractExpired: p.contract.endsAt < now,
  }));
}

/** Extend a corporate contract (and optionally revise its limit or tariff) with a recorded reason. */
export async function renewContract(id, { endsAt, creditLimitKobo, tariffId, reason }, ctx) {
  const payer = await Payer.findById(id);
  if (!payer) throw new AppError(404, 'PAYER_NOT_FOUND', 'Payer not found');
  if (payer.type !== 'corporate') throw new AppError(422, 'NOT_CORPORATE', 'Only corporate payers have contracts');
  const currentEnd = payer.contract?.endsAt;
  if (currentEnd && endsAt <= currentEnd) throw new AppError(422, 'NOT_AN_EXTENSION', 'The new end date must be later than the current end date', { currentEndsAt: currentEnd });
  if (endsAt <= new Date()) throw new AppError(422, 'DATE_IN_PAST', 'The new end date must be in the future');

  const before = { 'contract.endsAt': currentEnd ?? null, creditLimitKobo: payer.creditLimitKobo, tariffId: payer.tariffId };
  payer.set('contract.endsAt', endsAt);
  if (creditLimitKobo !== undefined) payer.creditLimitKobo = creditLimitKobo;
  if (tariffId !== undefined) payer.tariffId = tariffId;
  await payer.save();
  await recordAudit(ctx, {
    action: 'payer.contract.renew', entity: 'Payer', entityId: payer._id, before,
    after: { 'contract.endsAt': endsAt, creditLimitKobo: payer.creditLimitKobo, tariffId: payer.tariffId }, meta: { reason },
  });
  return toPayerView(payer.toObject());
}

/**
 * Switch a family card between credit and prepaid. Only done when it is safe:
 *  - to prepaid: nothing may be owed (no balance, no open invoices);
 *  - to credit: needs a limit and guarantor; a held deposit must be explicitly carried over (refunds arrive in Phase 4).
 */
export async function changeFamilyCardMode(id, { mode, creditLimitKobo, guarantor, carryOverDeposit = false, reason }, ctx) {
  const payer = await Payer.findById(id).lean();
  if (!payer) throw new AppError(404, 'PAYER_NOT_FOUND', 'Payer not found');
  if (payer.type !== 'family') throw new AppError(422, 'NOT_FAMILY_CARD', 'Only family cards have a credit/prepaid mode');
  if (payer.mode === mode) throw new AppError(400, 'SAME_MODE', `This card is already ${mode}`);

  let set;
  const guard = { _id: id, mode: payer.mode };
  if (mode === 'prepaid') {
    if (await Invoice.exists({ payerId: id, status: { $in: ['issued', 'partial'] } })) {
      throw new AppError(422, 'OUTSTANDING_INVOICES', 'Settle all open invoices before switching this card to prepaid');
    }
    guard.balanceKobo = { $lte: 0 }; // checked atomically with the update, so a charge cannot slip in between
    set = { mode: 'prepaid', creditLimitKobo: 0 };
  } else {
    const g = guarantor ?? payer.guarantor;
    if (!(creditLimitKobo > 0)) throw new AppError(400, 'CREDIT_LIMIT_REQUIRED', 'A credit card needs a credit limit above zero');
    if (!g?.name || !g?.phone) throw new AppError(400, 'GUARANTOR_REQUIRED', 'A credit card needs a guarantor name and phone');
    if (!carryOverDeposit) guard.balanceKobo = { $gte: 0 };
    set = { mode: 'credit', creditLimitKobo, guarantor: g, paymentTermsDays: payer.paymentTermsDays ?? 30, billingCycle: payer.billingCycle ?? 'monthly' };
  }

  return withTransaction(async (session) => {
    const updated = await Payer.findOneAndUpdate(guard, { $set: set }, { returnDocument: 'after', session });
    if (!updated) {
      throw new AppError(422, 'MODE_CHANGE_BLOCKED',
        mode === 'prepaid' ? 'This card has an outstanding balance. It must be settled first.'
          : 'This card holds a deposit. Set carryOverDeposit: true to keep it as credit against future charges.');
    }
    await recordAudit(ctx, {
      action: 'payer.mode.change', entity: 'Payer', entityId: updated._id,
      before: { mode: payer.mode, creditLimitKobo: payer.creditLimitKobo }, after: { mode: updated.mode, creditLimitKobo: updated.creditLimitKobo },
      meta: { reason, balanceKobo: updated.balanceKobo, carryOverDeposit },
    }, session);
    return toPayerView(updated.toObject());
  });
}
