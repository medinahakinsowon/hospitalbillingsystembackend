import { withTransaction } from '../config/db.js';
import { Invoice } from '../models/Invoice.js';
import { Charge } from '../models/Charge.js';
import { Encounter } from '../models/Encounter.js';
import { Patient } from '../models/Patient.js';
import { Payer } from '../models/Payer.js';
import { Payment } from '../models/Payment.js';
import { AppError } from '../utils/AppError.js';
import { nextSequence, pad } from '../utils/counters.js';
import { recordAudit } from './audit.service.js';

export const invoiceStatusOf = (paid, total) => (paid >= total ? 'paid' : paid > 0 ? 'partial' : 'issued');

/**
 * Atomically add `amountKobo` to an invoice's paid total and refresh its status.
 * The filter makes over-payment impossible, even with two payments racing.
 */
export async function bumpInvoicePaid(invoiceId, amountKobo, session) {
  const inv = await Invoice.findOneAndUpdate(
    { _id: invoiceId, status: { $in: ['issued', 'partial'] }, $expr: { $lte: [{ $add: ['$paidKobo', amountKobo] }, '$totalKobo'] } },
    { $inc: { paidKobo: amountKobo } },
    { returnDocument: 'after', session }
  );
  if (!inv) throw new AppError(422, 'INVOICE_NOT_PAYABLE', 'Invoice is already paid, void, or the amount exceeds its balance');
  const status = invoiceStatusOf(inv.paidKobo, inv.totalKobo);
  if (status !== inv.status) await Invoice.updateOne({ _id: invoiceId }, { $set: { status } }, { session });
  return { ...inv.toObject(), status };
}

/** Apply a payer's unallocated credit (deposits, top-ups) to a newly issued invoice. No ledger change: the money is already counted. */
export async function applyCreditToInvoice(invoiceId, session) {
  const invoice = await Invoice.findById(invoiceId).session(session).lean();
  let outstanding = invoice.totalKobo - invoice.paidKobo;
  if (outstanding <= 0) return;
  const payments = await Payment.find({ payerId: invoice.payerId, status: 'success', unallocatedKobo: { $gt: 0 } })
    .sort({ completedAt: 1 }).session(session).lean();
  for (const p of payments) {
    if (outstanding <= 0) break;
    const apply = Math.min(p.unallocatedKobo, outstanding);
    const r = await Payment.updateOne(
      { _id: p._id, unallocatedKobo: { $gte: apply } },
      { $inc: { unallocatedKobo: -apply }, $push: { allocations: { invoiceId, amountKobo: apply } } },
      { session }
    );
    if (r.modifiedCount !== 1) continue;
    await bumpInvoicePaid(invoiceId, apply, session);
    outstanding -= apply;
  }
}

/**
 * Issue invoices for an encounter's posted, not-yet-invoiced charges: one invoice per payer.
 * Optionally limit to one payer or to certain payer types. Safe to call repeatedly.
 */
export async function invoiceEncounter(encounterId, { payerId, payerTypes } = {}, ctx) {
  const encounter = await Encounter.findById(encounterId).lean();
  if (!encounter) throw new AppError(404, 'ENCOUNTER_NOT_FOUND', 'Encounter not found');
  const patient = await Patient.findById(encounter.patientId).select('firstName lastName hospitalNumber').lean();

  const filter = { encounterId, status: 'posted', invoiceId: null };
  if (payerId) filter.payerId = payerId;
  const payerIds = await Charge.distinct('payerId', filter);
  if (!payerIds.length) return [];
  const targets = (await Payer.find({ _id: { $in: payerIds } }).lean()).filter((p) => !payerTypes || payerTypes.includes(p.type));
  if (!targets.length) return [];

  return withTransaction(async (session) => {
    const issued = [];
    for (const payer of targets) {
      const charges = await Charge.find({ encounterId, payerId: payer._id, status: 'posted', invoiceId: null })
        .sort({ capturedAt: 1 }).session(session).lean();
      if (!charges.length) continue;

      const invoiceNo = `INV-${pad(await nextSequence('invoice', session))}`;
      const now = new Date();
      const [invoice] = await Invoice.create([{
        invoiceNo, type: 'visit', payerId: payer._id, payerType: payer.type, payerCode: payer.code, payerName: payer.name,
        patientId: encounter.patientId, patientName: `${patient.firstName} ${patient.lastName}`, hospitalNumber: patient.hospitalNumber,
        encounterId: encounter._id, encounterNo: encounter.encounterNo,
        lines: charges.map((c) => ({
          chargeId: c._id, date: c.capturedAt, description: c.description, department: c.department,
          qty: c.qty, unitPriceKobo: c.unitPriceKobo, totalKobo: c.totalKobo,
        })),
        totalKobo: charges.reduce((sum, c) => sum + c.totalKobo, 0),
        status: charges.reduce((sum, c) => sum + c.totalKobo, 0) === 0 ? 'paid' : 'issued', // free services need no payment
        issuedAt: now,
        dueAt: new Date(now.getTime() + (payer.paymentTermsDays ?? 0) * 86400000),
        createdBy: ctx.actorId,
      }], { session });

      const upd = await Charge.updateMany(
        { _id: { $in: charges.map((c) => c._id) }, invoiceId: null },
        { $set: { invoiceId: invoice._id } },
        { session }
      );
      if (upd.modifiedCount !== charges.length) throw new AppError(409, 'CHARGES_CHANGED', 'Charges changed while invoicing. Please retry.');

      await applyCreditToInvoice(invoice._id, session);
      await recordAudit(ctx, {
        action: 'invoice.issue', entity: 'Invoice', entityId: invoice._id,
        after: { invoiceNo, payerId: payer._id, totalKobo: invoice.totalKobo, lines: charges.length },
      }, session);
      issued.push(await Invoice.findById(invoice._id).session(session).lean());
    }
    return issued;
  });
}

export async function listInvoices({ payerId, patientId, encounterId, status, overdue, page, limit }) {
  const filter = {};
  if (overdue) { filter.status = { $in: ['issued', 'partial'] }; filter.dueAt = { $lt: new Date() }; }
  if (payerId) filter.payerId = payerId;
  if (patientId) filter.patientId = patientId;
  if (encounterId) filter.encounterId = encounterId;
  if (status) filter.status = overdue ? { $in: ['issued', 'partial'].filter((s) => s === status) } : status;
  const [items, total] = await Promise.all([
    Invoice.find(filter).select('-lines').sort({ issuedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Invoice.countDocuments(filter),
  ]);
  return { items: items.map(withBalance), page, limit, total };
}

export const withBalance = (inv) => {
  const balanceKobo = inv.totalKobo - inv.paidKobo;
  const overdue = ['issued', 'partial'].includes(inv.status) && balanceKobo > 0 && Boolean(inv.dueAt) && inv.dueAt < new Date();
  return { ...inv, balanceKobo, overdue, daysOverdue: overdue ? Math.floor((Date.now() - inv.dueAt) / 86400000) : 0 };
};

export async function getInvoice(id) {
  const inv = await Invoice.findById(id).lean();
  if (!inv) throw new AppError(404, 'INVOICE_NOT_FOUND', 'Invoice not found');
  const payments = await Payment.find({ 'allocations.invoiceId': inv._id, status: 'success' })
    .select('receiptNo method amountKobo completedAt allocations').lean();
  return {
    ...withBalance(inv),
    payments: payments.map((p) => ({
      id: p._id, receiptNo: p.receiptNo, method: p.method, completedAt: p.completedAt,
      appliedKobo: p.allocations.filter((a) => String(a.invoiceId) === String(inv._id)).reduce((s, a) => s + a.amountKobo, 0),
    })),
  };
}
