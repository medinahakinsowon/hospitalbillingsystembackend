import { withTransaction } from '../config/db.js';
import { Charge } from '../models/Charge.js';
import { Coverage } from '../models/Coverage.js';
import { Encounter } from '../models/Encounter.js';
import { Invoice } from '../models/Invoice.js';
import { Patient } from '../models/Patient.js';
import { Payer } from '../models/Payer.js';
import { AppError } from '../utils/AppError.js';
import { nextSequence, pad } from '../utils/counters.js';
import { applyCreditToInvoice } from './invoices.service.js';
import { recordAudit } from './audit.service.js';

const HOUR = 3600e3;
const MAX_LINES = 10_000; // lines are embedded in the invoice document; keep it far below MongoDB's 16 MB limit
const SYSTEM_CTX = { actorId: null, actorRole: 'system', ip: null, userAgent: 'billing-cycle-job' };

// Billing periods follow Nigerian local time (WAT, UTC+1, no daylight saving).
const watParts = (d) => {
  const w = new Date(d.getTime() + HOUR);
  return { y: w.getUTCFullYear(), m: w.getUTCMonth(), day: w.getUTCDate(), dow: w.getUTCDay() };
};
const watMidnight = (y, m, d) => new Date(Date.UTC(y, m, d) - HOUR); // Date.UTC rolls over months/days that overflow

/** 00:00 on 1 January (Lagos time) of the year containing `now`. Member limits reset on this date. */
export function startOfYearWat(now = new Date()) {
  return watMidnight(watParts(now).y, 0, 1);
}

/** The most recent COMPLETED billing period for a cycle, as of `now`. [start, end) in real instants. */
export function lastCompletedPeriod(cycle, now = new Date()) {
  const { y, m, day, dow } = watParts(now);
  if (cycle === 'monthly') return { start: watMidnight(y, m - 1, 1), end: watMidnight(y, m, 1) };
  if (cycle === 'quarterly') {
    const q = Math.floor(m / 3) * 3;
    return { start: watMidnight(y, q - 3, 1), end: watMidnight(y, q, 1) };
  }
  if (cycle === 'weekly') {
    const end = watMidnight(y, m, day - ((dow + 6) % 7)); // most recent Monday 00:00
    return { start: new Date(end.getTime() - 7 * 24 * HOUR), end };
  }
  throw new AppError(400, 'INVALID_CYCLE', `Unknown billing cycle: ${cycle}`);
}

/**
 * Issue one invoice (corporate: "consolidated"; family credit card: "statement") covering a payer's
 * posted, not-yet-invoiced charges before `periodEnd`. Each person's treatments are listed separately.
 * With `claim`, the payer's lastInvoicedThrough marker is advanced atomically first, so two runs
 * (or a run and a manual request) can never invoice the same period twice.
 */
export async function invoicePayerPeriod(payerId, { periodStart, periodEnd, claim = false } = {}, ctx) {
  const payer = await Payer.findById(payerId).lean();
  if (!payer) throw new AppError(404, 'PAYER_NOT_FOUND', 'Payer not found');
  if (payer.type === 'individual') throw new AppError(422, 'NOT_PERIODIC', 'Individual payers are invoiced per visit');
  if (payer.type === 'family' && payer.mode === 'prepaid') {
    throw new AppError(422, 'PREPAID_CARD', 'Prepaid cards are not invoiced. Use the account statement instead.');
  }
  const end = periodEnd ?? new Date();
  if (periodStart && periodStart >= end) throw new AppError(400, 'INVALID_PERIOD', 'periodStart must be before periodEnd');

  return withTransaction(async (session) => {
    if (claim) {
      const claimed = await Payer.findOneAndUpdate(
        { _id: payerId, $or: [{ lastInvoicedThrough: null }, { lastInvoicedThrough: { $lt: end } }] },
        { $set: { lastInvoicedThrough: end } },
        { session }
      );
      if (!claimed) return { status: 'already_done' };
    }

    const filter = { payerId, status: 'posted', invoiceId: null, capturedAt: { $lt: end, ...(periodStart ? { $gte: periodStart } : {}) } };
    const charges = await Charge.find(filter).sort({ capturedAt: 1 }).session(session).lean();
    if (!charges.length) return { status: 'nothing_to_invoice' };
    if (charges.length > MAX_LINES) {
      throw new AppError(422, 'TOO_MANY_LINES', `This period has ${charges.length} charges (limit ${MAX_LINES} per invoice). Invoice a shorter period instead.`);
    }

    const patientIds = [...new Set(charges.map((c) => String(c.patientId)))];
    const encounterIds = [...new Set(charges.map((c) => String(c.encounterId)))];
    const [patients, coverages, encounters] = await Promise.all([
      Patient.find({ _id: { $in: patientIds } }).select('firstName lastName hospitalNumber').session(session).lean(),
      Coverage.find({ payerId, patientId: { $in: patientIds } }).select('patientId employeeRef').sort({ createdAt: 1 }).session(session).lean(),
      Encounter.find({ _id: { $in: encounterIds } }).select('encounterNo').session(session).lean(),
    ]);
    const pById = new Map(patients.map((p) => [String(p._id), p]));
    const refByPatient = new Map(coverages.filter((c) => c.employeeRef).map((c) => [String(c.patientId), c.employeeRef]));
    const encNo = new Map(encounters.map((e) => [String(e._id), e.encounterNo]));

    const lines = charges.map((c) => {
      const p = pById.get(String(c.patientId));
      return {
        chargeId: c._id, date: c.capturedAt, description: c.description, department: c.department,
        patientId: c.patientId, patientName: p ? `${p.firstName} ${p.lastName}` : 'Unknown', hospitalNumber: p?.hospitalNumber,
        employeeRef: refByPatient.get(String(c.patientId)), encounterNo: encNo.get(String(c.encounterId)),
        qty: c.qty, unitPriceKobo: c.unitPriceKobo, totalKobo: c.totalKobo,
      };
    }).sort((a, b) => a.patientName.localeCompare(b.patientName) || a.date - b.date);

    const totalKobo = lines.reduce((s, l) => s + l.totalKobo, 0);
    const now = new Date();
    const invoiceNo = `INV-${pad(await nextSequence('invoice', session))}`;
    const [invoice] = await Invoice.create([{
      invoiceNo, type: payer.type === 'corporate' ? 'consolidated' : 'statement', status: totalKobo === 0 ? 'paid' : 'issued',
      payerId: payer._id, payerType: payer.type, payerCode: payer.code, payerName: payer.name,
      lines, totalKobo, periodStart, periodEnd: end, issuedAt: now,
      dueAt: new Date(now.getTime() + (payer.paymentTermsDays ?? 0) * 86400000), createdBy: ctx.actorId,
    }], { session });

    const upd = await Charge.updateMany({ _id: { $in: charges.map((c) => c._id) }, invoiceId: null }, { $set: { invoiceId: invoice._id } }, { session });
    if (upd.modifiedCount !== charges.length) throw new AppError(409, 'CHARGES_CHANGED', 'Charges changed while invoicing. Please retry.');

    await applyCreditToInvoice(invoice._id, session);
    await recordAudit(ctx, {
      action: 'invoice.issue', entity: 'Invoice', entityId: invoice._id,
      after: { invoiceNo, type: invoice.type, payerId: payer._id, totalKobo, lines: lines.length, people: patientIds.length, periodEnd: end },
    }, session);
    return { status: 'invoiced', invoice: await Invoice.findById(invoice._id).session(session).lean() };
  });
}

/**
 * Scheduled job: invoice every active corporate and credit-mode family payer whose last completed
 * billing period has not been invoiced yet. Safe to run as often as you like. Works through payers
 * oldest-first within a time budget, so a large run simply continues on the next call.
 */
export async function generateDueInvoices({ payerIds, now = new Date(), maxPayers = 300, budgetMs = 45_000 } = {}) {
  const filter = {
    status: { $ne: 'closed' }, billingCycle: { $exists: true, $ne: null },
    $or: [{ type: 'corporate' }, { type: 'family', mode: 'credit' }],
  };
  if (payerIds) filter._id = { $in: payerIds };
  const payers = await Payer.find(filter).select('billingCycle lastInvoicedThrough code').sort({ lastInvoicedThrough: 1 }).limit(maxPayers).lean();

  const started = Date.now();
  const summary = { checked: 0, invoiced: 0, nothingToInvoice: 0, alreadyDone: 0, notDue: 0, errors: [], stoppedEarly: false };
  for (const p of payers) {
    if (Date.now() - started > budgetMs) { summary.stoppedEarly = true; break; }
    summary.checked++;
    const { end } = lastCompletedPeriod(p.billingCycle, now);
    if (p.lastInvoicedThrough && p.lastInvoicedThrough >= end) { summary.notDue++; continue; }
    try {
      const r = await invoicePayerPeriod(p._id, { periodEnd: end, claim: true }, SYSTEM_CTX);
      if (r.status === 'invoiced') summary.invoiced++;
      else if (r.status === 'nothing_to_invoice') summary.nothingToInvoice++;
      else summary.alreadyDone++;
    } catch (err) {
      summary.errors.push({ payer: p.code, error: err.code || err.name });
    }
  }
  return summary;
}
