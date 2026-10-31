import { withTransaction } from '../config/db.js';
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

const UPDATABLE = ['name', 'status', 'billingContact', 'creditLimitKobo', 'paymentTermsDays', 'billingCycle', 'guarantor', 'contract', 'tariffId'];

export async function updatePayer(id, patch, ctx) {
  const payer = await Payer.findById(id);
  if (!payer) throw new AppError(404, 'PAYER_NOT_FOUND', 'Payer not found');
  if (payer.type === 'individual' && (patch.creditLimitKobo !== undefined || patch.contract || patch.guarantor)) {
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
