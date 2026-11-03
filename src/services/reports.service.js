import mongoose from 'mongoose';
import { Adjustment } from '../models/Adjustment.js';
import { Charge } from '../models/Charge.js';
import { Coverage } from '../models/Coverage.js';
import { Invoice } from '../models/Invoice.js';
import { Patient } from '../models/Patient.js';
import { Payer } from '../models/Payer.js';
import { Payment } from '../models/Payment.js';
import { Refund } from '../models/Refund.js';
import { User } from '../models/User.js';
import { AppError } from '../utils/AppError.js';

const DAY = 86400000;
const oid = (id) => new mongoose.Types.ObjectId(String(id));

/** Reports cover a date range (default: the last 30 days, at most 366 days). */
export function resolveRange({ from, to } = {}) {
  const end = to ?? new Date();
  const start = from ?? new Date(end.getTime() - 30 * DAY);
  if (start >= end) throw new AppError(400, 'INVALID_RANGE', '"from" must be before "to"');
  if (end - start > 366 * DAY) throw new AppError(400, 'RANGE_TOO_LARGE', 'A report can cover at most 366 days. Run it in parts.');
  return { from: start, to: end };
}

const meta = (name, extra = {}) => ({ report: name, generatedAt: new Date(), ...extra });
const sum = (rows, key) => rows.reduce((s, r) => s + (r[key] ?? 0), 0);

// ------------------------------------------------------------------ ageing of unpaid invoices
const AGE_COLUMNS = [
  { key: 'payerCode', header: 'Payer code' }, { key: 'payerName', header: 'Payer' }, { key: 'payerType', header: 'Type' },
  { key: 'current', header: 'Not yet due (NGN)', type: 'kobo' }, { key: 'd1_30', header: '1-30 days overdue (NGN)', type: 'kobo' },
  { key: 'd31_60', header: '31-60 days overdue (NGN)', type: 'kobo' }, { key: 'd61_90', header: '61-90 days overdue (NGN)', type: 'kobo' },
  { key: 'd90_plus', header: 'Over 90 days overdue (NGN)', type: 'kobo' }, { key: 'total', header: 'Total owed (NGN)', type: 'kobo' },
  { key: 'invoiceCount', header: 'Open invoices', type: 'number' }, { key: 'oldestDueAt', header: 'Oldest due date' },
];

/** Who owes what, and for how long: open invoices grouped by payer and by how far past due they are. */
export async function agingReport({ payerType, payerId } = {}) {
  const now = new Date();
  const match = { status: { $in: ['issued', 'partial'] }, ...(payerType ? { payerType } : {}), ...(payerId ? { payerId: oid(payerId) } : {}) };
  const grouped = await Invoice.aggregate([
    { $match: match },
    { $project: { payerId: 1, dueAt: 1, outstanding: { $subtract: ['$totalKobo', '$paidKobo'] } } },
    { $match: { outstanding: { $gt: 0 } } },
    { $addFields: { daysPast: { $floor: { $divide: [{ $subtract: [now, '$dueAt'] }, DAY] } } } },
    { $addFields: { bucket: { $switch: { branches: [
      { case: { $lte: ['$daysPast', 0] }, then: 'current' }, { case: { $lte: ['$daysPast', 30] }, then: 'd1_30' },
      { case: { $lte: ['$daysPast', 60] }, then: 'd31_60' }, { case: { $lte: ['$daysPast', 90] }, then: 'd61_90' },
    ], default: 'd90_plus' } } } },
    { $group: { _id: { payerId: '$payerId', bucket: '$bucket' }, kobo: { $sum: '$outstanding' }, count: { $sum: 1 }, oldestDueAt: { $min: '$dueAt' } } },
  ]);

  const byPayer = new Map();
  for (const g of grouped) {
    const key = String(g._id.payerId);
    const row = byPayer.get(key) ?? { payerId: g._id.payerId, current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, total: 0, invoiceCount: 0, oldestDueAt: null };
    row[g._id.bucket] += g.kobo; row.total += g.kobo; row.invoiceCount += g.count;
    if (!row.oldestDueAt || g.oldestDueAt < row.oldestDueAt) row.oldestDueAt = g.oldestDueAt;
    byPayer.set(key, row);
  }
  const payers = await Payer.find({ _id: { $in: [...byPayer.values()].map((r) => r.payerId) } }).select('code name type').lean();
  const info = new Map(payers.map((p) => [String(p._id), p]));
  const rows = [...byPayer.values()]
    .map((r) => ({ ...r, payerCode: info.get(String(r.payerId))?.code, payerName: info.get(String(r.payerId))?.name, payerType: info.get(String(r.payerId))?.type }))
    .sort((a, b) => b.total - a.total).slice(0, 1000);
  const totals = Object.fromEntries(['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus', 'total', 'invoiceCount'].map((k) => [k, sum(rows, k)]));
  return { meta: meta('aging', { note: 'Open invoices as of now. "Overdue" is counted from each invoice\'s due date.' }), columns: AGE_COLUMNS, rows, totals };
}

// ------------------------------------------------------------------ revenue by department
const REV_COLUMNS = [
  { key: 'department', header: 'Department' }, { key: 'corporate', header: 'Corporate (NGN)', type: 'kobo' },
  { key: 'family', header: 'Family cards (NGN)', type: 'kobo' }, { key: 'individual', header: 'Self-pay (NGN)', type: 'kobo' },
  { key: 'total', header: 'Total (NGN)', type: 'kobo' }, { key: 'charges', header: 'Charges', type: 'number' },
];

/**
 * Services charged in the period, by department and who pays. Voided and credit-noted charges are excluded.
 * Discounts, waivers and write-offs approved in the period are shown separately and deducted for the net figure.
 */
export async function revenueByDepartment({ from, to, payerId, payerType } = {}) {
  const range = resolveRange({ from, to });
  const payerMatch = payerId ? { payerId: oid(payerId) } : {};
  const typeStage = payerType ? [{ $match: { 'p.type': payerType } }] : [];
  const lookup = [{ $lookup: { from: 'payers', localField: 'payerId', foreignField: '_id', pipeline: [{ $project: { type: 1 } }], as: 'p' } }, { $unwind: '$p' }, ...typeStage];

  const [byDept, adj] = await Promise.all([
    Charge.aggregate([
      { $match: { status: 'posted', capturedAt: { $gte: range.from, $lt: range.to }, ...payerMatch } }, ...lookup,
      { $group: { _id: { department: '$department', type: '$p.type' }, kobo: { $sum: '$totalKobo' }, charges: { $sum: 1 } } },
    ]),
    Adjustment.aggregate([
      { $match: { status: 'applied', decidedAt: { $gte: range.from, $lt: range.to }, ...payerMatch } },
      { $lookup: { from: 'payers', localField: 'payerId', foreignField: '_id', pipeline: [{ $project: { type: 1 } }], as: 'p' } }, { $unwind: '$p' }, ...typeStage,
      { $group: { _id: '$kind', kobo: { $sum: '$appliedKobo' }, count: { $sum: 1 } } },
    ]),
  ]);

  const depts = new Map();
  for (const g of byDept) {
    const name = g._id.department ?? 'other';
    const row = depts.get(name) ?? { department: name, corporate: 0, family: 0, individual: 0, total: 0, charges: 0 };
    row[g._id.type] += g.kobo; row.total += g.kobo; row.charges += g.charges;
    depts.set(name, row);
  }
  const rows = [...depts.values()].sort((a, b) => b.total - a.total);
  const adjusts = Object.fromEntries(adj.map((a) => [a._id, { kobo: a.kobo, count: a.count }]));
  const grossKobo = sum(rows, 'total');
  const deductionsKobo = (adjusts.discount?.kobo ?? 0) + (adjusts.waiver?.kobo ?? 0) + (adjusts.writeoff?.kobo ?? 0);
  return {
    meta: meta('revenue-by-department', { ...range, note: 'Credit notes and voids remove the charge itself, so they are not deducted again.' }),
    columns: REV_COLUMNS, rows,
    totals: {
      grossKobo, corporateKobo: sum(rows, 'corporate'), familyKobo: sum(rows, 'family'), individualKobo: sum(rows, 'individual'),
      discountsKobo: adjusts.discount?.kobo ?? 0, waiversKobo: adjusts.waiver?.kobo ?? 0, writeoffsKobo: adjusts.writeoff?.kobo ?? 0,
      creditNotesKobo: adjusts.credit_note?.kobo ?? 0, netKobo: grossKobo - deductionsKobo,
    },
  };
}

// ------------------------------------------------------------------ collections by cashier
const COLL_COLUMNS = [
  { key: 'cashier', header: 'Cashier' }, { key: 'cash', header: 'Cash (NGN)', type: 'kobo' }, { key: 'pos', header: 'POS (NGN)', type: 'kobo' },
  { key: 'transfer', header: 'Transfer (NGN)', type: 'kobo' }, { key: 'online', header: 'Online / Paystack (NGN)', type: 'kobo' },
  { key: 'refundsPaid', header: 'Refunds paid out (NGN)', type: 'kobo' }, { key: 'net', header: 'Net collected (NGN)', type: 'kobo' },
  { key: 'payments', header: 'Payments', type: 'number' },
];

/** Money received by each person (and online), less refunds they paid out. */
export async function collectionsByCashier({ from, to } = {}) {
  const range = resolveRange({ from, to });
  const [paid, refunded] = await Promise.all([
    Payment.aggregate([
      { $match: { status: 'success', completedAt: { $gte: range.from, $lt: range.to } } },
      { $group: { _id: { by: '$receivedBy', method: '$method' }, kobo: { $sum: '$amountKobo' }, count: { $sum: 1 } } },
    ]),
    Refund.aggregate([
      { $match: { status: 'paid', paidAt: { $gte: range.from, $lt: range.to } } },
      { $group: { _id: '$paidBy', kobo: { $sum: '$amountKobo' } } },
    ]),
  ]);
  const people = new Map();
  const get = (id) => {
    const key = id ? String(id) : 'system';
    if (!people.has(key)) people.set(key, { userId: id ?? null, cash: 0, pos: 0, transfer: 0, online: 0, refundsPaid: 0, net: 0, payments: 0 });
    return people.get(key);
  };
  for (const p of paid) {
    const r = get(p._id.by); const slot = p._id.method === 'paystack' ? 'online' : p._id.method;
    r[slot] += p.kobo; r.payments += p.count;
  }
  for (const f of refunded) get(f._id).refundsPaid += f.kobo;
  const users = await User.find({ _id: { $in: [...people.values()].map((r) => r.userId).filter(Boolean) } }).select('name').lean();
  const names = new Map(users.map((u) => [String(u._id), u.name]));
  const rows = [...people.values()].map((r) => {
    const net = r.cash + r.pos + r.transfer + r.online - r.refundsPaid;
    return { ...r, net, cashier: r.userId ? names.get(String(r.userId)) ?? 'Unknown user' : 'System / online' };
  }).sort((a, b) => b.net - a.net);
  const totals = Object.fromEntries(['cash', 'pos', 'transfer', 'online', 'refundsPaid', 'net', 'payments'].map((k) => [k, sum(rows, k)]));
  return { meta: meta('collections-by-cashier', range), columns: COLL_COLUMNS, rows, totals };
}

// ------------------------------------------------------------------ family card usage
const CARD_COLUMNS = [
  { key: 'code', header: 'Card' }, { key: 'name', header: 'Name' }, { key: 'mode', header: 'Mode' }, { key: 'status', header: 'Status' },
  { key: 'creditLimitKobo', header: 'Credit limit (NGN)', type: 'kobo' }, { key: 'balanceKobo', header: 'Balance (NGN)', type: 'kobo' },
  { key: 'availableKobo', header: 'Available (NGN)', type: 'kobo' }, { key: 'utilizationPct', header: 'Limit used (%)', type: 'number' },
  { key: 'chargedKobo', header: 'Charged in period (NGN)', type: 'kobo' }, { key: 'chargeCount', header: 'Charges', type: 'number' },
  { key: 'membersCharged', header: 'People charged', type: 'number' }, { key: 'lowBalance', header: 'Low balance' },
];
const MEMBER_COLUMNS = [
  { key: 'hospitalNumber', header: 'Hospital no.' }, { key: 'name', header: 'Name' }, { key: 'relationship', header: 'Relationship' },
  { key: 'chargedKobo', header: 'Charged in period (NGN)', type: 'kobo' }, { key: 'chargeCount', header: 'Charges', type: 'number' },
  { key: 'memberLimitKobo', header: 'Member limit (NGN)', type: 'kobo' },
];

/** How family cards are being used. Give payerId to see one card broken down by person. */
export async function cardUsageReport({ from, to, payerId } = {}) {
  const range = resolveRange({ from, to });
  const when = { $gte: range.from, $lt: range.to };

  if (payerId) {
    const card = await Payer.findById(payerId).select('code name type').lean();
    if (!card || card.type !== 'family') throw new AppError(404, 'CARD_NOT_FOUND', 'Family card not found');
    const [usage, coverages] = await Promise.all([
      Charge.aggregate([{ $match: { payerId: card._id, status: 'posted', capturedAt: when } }, { $group: { _id: '$patientId', kobo: { $sum: '$totalKobo' }, count: { $sum: 1 } } }]),
      Coverage.find({ payerId: card._id, status: 'active' }).select('patientId relationship memberLimitKobo').lean(),
    ]);
    const ids = [...new Set([...usage.map((u) => String(u._id)), ...coverages.map((c) => String(c.patientId))])];
    const patients = await Patient.find({ _id: { $in: ids } }).select('hospitalNumber firstName lastName').lean();
    const pm = new Map(patients.map((p) => [String(p._id), p])); const cm = new Map(coverages.map((c) => [String(c.patientId), c]));
    const um = new Map(usage.map((u) => [String(u._id), u]));
    const rows = ids.map((id) => ({
      hospitalNumber: pm.get(id)?.hospitalNumber, name: pm.get(id) ? `${pm.get(id).firstName} ${pm.get(id).lastName}` : 'Unknown',
      relationship: cm.get(id)?.relationship ?? 'former member', chargedKobo: um.get(id)?.kobo ?? 0, chargeCount: um.get(id)?.count ?? 0,
      memberLimitKobo: cm.get(id)?.memberLimitKobo ?? null,
    })).sort((a, b) => b.chargedKobo - a.chargedKobo);
    return { meta: meta('card-usage-members', { ...range, card: card.code }), columns: MEMBER_COLUMNS, rows, totals: { chargedKobo: sum(rows, 'chargedKobo'), chargeCount: sum(rows, 'chargeCount') } };
  }

  const cards = await Payer.find({ type: 'family', status: { $ne: 'closed' } }).sort({ code: 1 }).limit(2000)
    .select('code name mode status creditLimitKobo balanceKobo lowBalanceThresholdKobo').lean();
  const usage = await Charge.aggregate([
    { $match: { payerId: { $in: cards.map((c) => c._id) }, status: 'posted', capturedAt: when } },
    { $group: { _id: '$payerId', kobo: { $sum: '$totalKobo' }, count: { $sum: 1 }, people: { $addToSet: '$patientId' } } },
  ]);
  const um = new Map(usage.map((u) => [String(u._id), u]));
  const rows = cards.map((c) => {
    const u = um.get(String(c._id)); const available = c.creditLimitKobo - c.balanceKobo;
    return {
      code: c.code, name: c.name, mode: c.mode, status: c.status, creditLimitKobo: c.creditLimitKobo, balanceKobo: c.balanceKobo, availableKobo: available,
      utilizationPct: c.mode === 'credit' && c.creditLimitKobo > 0 ? Math.round((Math.max(0, c.balanceKobo) / c.creditLimitKobo) * 1000) / 10 : null,
      chargedKobo: u?.kobo ?? 0, chargeCount: u?.count ?? 0, membersCharged: u?.people.length ?? 0,
      lowBalance: c.mode === 'prepaid' && c.lowBalanceThresholdKobo > 0 && available <= c.lowBalanceThresholdKobo ? 'yes' : '',
    };
  });
  return { meta: meta('card-usage', range), columns: CARD_COLUMNS, rows, totals: { cards: rows.length, chargedKobo: sum(rows, 'chargedKobo'), chargeCount: sum(rows, 'chargeCount') } };
}
