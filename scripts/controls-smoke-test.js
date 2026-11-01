// End-to-end check of Phase 4A against your database: npm run test:controls
// Covers co-payments, member limits (incl. a concurrency race), authorizations, discounts, credit notes on a
// paid invoice, waivers, write-offs and refunds, all with maker-checker approval.
// !! Run on a DEVELOPMENT database only. It creates throwaway records, removes them afterwards, and restores
//    the numbering counters. Requires ALLOW_SELF_APPROVAL=false and WALKIN_PAYMENT_POLICY=after in .env.
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { connectDB, disconnectDB } from '../src/config/db.js';
import { Payer } from '../src/models/Payer.js';
import { Service } from '../src/models/Service.js';
import { Charge } from '../src/models/Charge.js';
import { Invoice } from '../src/models/Invoice.js';
import { Payment } from '../src/models/Payment.js';
import { Authorization } from '../src/models/Authorization.js';
import { createPatient } from '../src/services/patients.service.js';
import { createPayer } from '../src/services/payers.service.js';
import { addCoverage } from '../src/services/coverage.service.js';
import { createTariff, setTariffPrices } from '../src/services/catalog.service.js';
import { openEncounter, closeEncounter, reassignEncounterPayer } from '../src/services/encounters.service.js';
import { captureCharge, voidCharge } from '../src/services/charges.service.js';
import { invoicePayerPeriod } from '../src/services/billing-cycle.service.js';
import { recordManualPayment } from '../src/services/payments.service.js';
import { requestAuthorization, decideAuthorization } from '../src/services/authorizations.service.js';
import { requestAdjustment, decideAdjustment } from '../src/services/adjustments.service.js';
import { requestRefund, decideRefund, payRefund, cancelRefund } from '../src/services/refunds.service.js';
import { reconcilePayer } from '../src/services/ledger.service.js';

if (env.isProd) { console.error('Refusing to run with NODE_ENV=production.'); process.exit(1); }
if (env.ALLOW_SELF_APPROVAL || env.WALKIN_PAYMENT_POLICY !== 'after') {
  console.error('Set ALLOW_SELF_APPROVAL=false and WALKIN_PAYMENT_POLICY=after in .env while running this test.'); process.exit(1);
}

await connectDB();
const db = mongoose.connection;
const person = () => new mongoose.Types.ObjectId();
const who = (role) => ({ actorId: role === 'admin' ? null : person(), actorRole: role, ip: 'local', userAgent: 'controls-smoke-test' });
const admin = who('admin'); const cashier = who('cashier'); const billing = who('billing_officer'); const finance = who('finance_manager'); const doctor = who('doctor');
const sfx = Date.now().toString(36).toUpperCase();
const created = { patients: [], payers: [], services: [], tariffs: [] };
const countersBefore = await db.collection('counters').find().toArray();
const step = (m) => console.log(`ok  ${m}`);
const bal = async (id) => (await Payer.findById(id).lean()).balanceKobo;
const inv = (id) => Invoice.findById(id).lean();
const expectCode = (p, code) => assert.rejects(p, (e) => { assert.equal(e.code, code, `expected ${code} but got ${e.code}: ${e.message}`); return true; });
const rnd = () => String(Math.floor(Math.random() * 1e7)).padStart(7, '0');
const soon = (ms) => new Date(Date.now() + ms);

async function newPerson(label, tariffId) {
  const p = await createPatient({ firstName: label, lastName: `Ctl${sfx}`, dob: new Date('1985-06-15T00:00:00Z'), sex: 'female', phone: `0802${rnd()}` }, admin);
  created.patients.push(p._id); created.payers.push(p.selfPayerId);
  await Payer.updateOne({ _id: p.selfPayerId }, { $set: { tariffId } });
  return p;
}
const newCorp = async (name, extra, tariffId) => {
  const c = await createPayer({
    type: 'corporate', name: `${name} ${sfx}`, billingContact: { name: 'HR', email: 'hr@example.com' }, creditLimitKobo: 5_000_000,
    paymentTermsDays: 30, billingCycle: 'monthly', tariffId,
    contract: { startsAt: soon(-86_400_000), endsAt: soon(365 * 86_400_000), coveredServices: [], excludedServices: [] }, ...extra,
  }, admin);
  created.payers.push(c._id);
  return c;
};
const open = (patient, payerId, type = 'outpatient') => openEncounter({ patientId: patient._id, type, payerId }, admin);

try {
  // ---------------------------------------------------------------- setup
  const mk = async (code, name, department, category, extra = {}) => { const s = await Service.create({ code: `${code}-${sfx}`, name, department, category, ...extra }); created.services.push(s._id); return s; };
  const consult = await mk('K-CONS', 'Consultation', 'consultation', 'consultation');
  const lab = await mk('K-LAB', 'Lab test', 'laboratory', 'lab-test');
  const mri = await mk('K-MRI', 'MRI scan', 'radiology', 'imaging', { requiresAuthorization: true });
  const tariff = await createTariff({ code: `K-${sfx}`, name: 'Controls test tariff' }, admin);
  created.tariffs.push(tariff._id);
  await setTariffPrices(tariff._id, [
    { serviceId: consult._id, priceKobo: 500_000 }, { serviceId: lab._id, priceKobo: 250_000 }, { serviceId: mri._id, priceKobo: 800_000 },
  ], admin);

  // ---------------------------------------------------------------- 1. co-payment
  const corpA = await newCorp('Copay Corp', { copay: { patientSharePercent: 20, appliesTo: [] } }, tariff._id);
  const corpB = await newCorp('Pharmacy-only Copay Corp', { copay: { patientSharePercent: 20, appliesTo: ['pharmacy'] } }, tariff._id);
  const E1 = await newPerson('Staff1', tariff._id);
  await addCoverage(corpA._id, { patientId: E1._id, relationship: 'employee', employeeRef: 'A-1' }, admin);
  await addCoverage(corpB._id, { patientId: E1._id, relationship: 'employee', employeeRef: 'B-1' }, admin);

  const encE1 = await open(E1, corpA._id);
  const key = `ctl-${sfx}-consult-1`;
  const split = await captureCharge({ encounterId: encE1._id, serviceId: consult._id, idempotencyKey: key }, admin);
  assert.equal(split.charges.length, 2);
  const [pc, cc] = [split.charges.find((c) => c.splitRole === 'payer'), split.charges.find((c) => c.splitRole === 'copay')];
  assert.deepEqual([pc.totalKobo, cc.totalKobo, pc.fullTotalKobo], [400_000, 100_000, 500_000]);
  assert.equal(String(pc.splitGroupId), String(cc.splitGroupId)); assert.equal(String(cc.payerId), String(E1.selfPayerId));
  assert.match(cc.description, /20% patient co-pay/);
  assert.equal(await bal(corpA._id), 400_000); assert.equal(await bal(E1.selfPayerId), 100_000);
  step('20% co-pay: one consultation became a 400,000 plan charge and a 100,000 patient charge');

  const replay = await captureCharge({ encounterId: encE1._id, serviceId: consult._id, idempotencyKey: key }, admin);
  assert.equal(replay.duplicate, true); assert.equal(replay.charges.length, 2); assert.equal(await bal(corpA._id), 400_000);
  const voided = await voidCharge(pc._id, 'entered in error', admin);
  assert.equal(voided.chargesVoided, 2); assert.equal(await bal(corpA._id), 0); assert.equal(await bal(E1.selfPayerId), 0);
  step('a retried request does not double-charge; voiding one half voids both and restores both balances');

  await captureCharge({ encounterId: encE1._id, serviceId: lab._id }, admin); // 200,000 plan + 50,000 patient
  await expectCode(closeEncounter(encE1._id, {}, admin), 'PAYMENT_REQUIRED');
  const [selfInv] = await Invoice.find({ encounterId: encE1._id, payerType: 'individual' }).lean();
  assert.equal(selfInv.totalKobo, 50_000); assert.match(selfInv.lines[0].description, /co-pay/);
  await recordManualPayment({ payerId: E1.selfPayerId, amountKobo: 50_000, method: 'cash', invoiceId: selfInv._id }, cashier);
  await closeEncounter(encE1._id, {}, admin);
  const planInv = await invoicePayerPeriod(corpA._id, { periodEnd: soon(60_000) }, admin);
  assert.equal(planInv.invoice.totalKobo, 200_000);
  step('patient pays only their co-pay at discharge; the company is invoiced only for its share');

  const encB = await open(E1, corpB._id);
  const noSplit = await captureCharge({ encounterId: encB._id, serviceId: consult._id }, admin);
  assert.equal(noSplit.charges.length, 1); assert.equal(noSplit.charge.totalKobo, 500_000);
  step('a co-pay limited to pharmacy leaves a consultation un-split');

  const P = await newPerson('Emergency', tariff._id);
  await addCoverage(corpA._id, { patientId: P._id, relationship: 'employee' }, admin);
  await addCoverage(corpB._id, { patientId: P._id, relationship: 'employee' }, admin);
  const encP = await open(P, undefined, 'emergency');
  await captureCharge({ encounterId: encP._id, serviceId: consult._id }, admin);
  const balA0 = await bal(corpA._id); const balB0 = await bal(corpB._id);
  const toA = await reassignEncounterPayer(encP._id, { payerId: corpA._id, reason: 'employer identified' }, admin);
  assert.equal(toA.moved[0].split, true);
  assert.equal(await bal(P.selfPayerId), 100_000); assert.equal(await bal(corpA._id), balA0 + 400_000);
  await reassignEncounterPayer(encP._id, { payerId: corpB._id, reason: 'wrong company' }, admin);
  assert.equal(await bal(P.selfPayerId), 0); assert.equal(await bal(corpA._id), balA0); assert.equal(await bal(corpB._id), balB0 + 500_000);
  step('reassigning payer moves a split charge as a whole and re-applies the new payer\'s co-pay rule');

  // ---------------------------------------------------------------- 2. member limit
  const M = await newPerson('Limited', tariff._id);
  await addCoverage(corpB._id, { patientId: M._id, relationship: 'employee', memberLimitKobo: 600_000 }, admin);
  const encM = await open(M, corpB._id);
  await captureCharge({ encounterId: encM._id, serviceId: lab._id }, admin);
  await captureCharge({ encounterId: encM._id, serviceId: lab._id }, admin);
  await assert.rejects(captureCharge({ encounterId: encM._id, serviceId: lab._id }, admin), (e) => { assert.equal(e.code, 'MEMBER_LIMIT_EXCEEDED'); assert.equal(e.details.remainingKobo, 100_000); return true; });
  const ov = await captureCharge({ encounterId: encM._id, serviceId: lab._id, overrideLimit: true, overrideReason: 'approved by medical director' }, admin);
  assert.equal(ov.charge.totalKobo, 250_000);
  step('member limit: charges stop at the limit; a finance override with a reason is the only way past it');

  const M2 = await newPerson('Raced', tariff._id);
  await addCoverage(corpB._id, { patientId: M2._id, relationship: 'employee', memberLimitKobo: 1_000_000 }, admin);
  const encM2 = await open(M2, corpB._id);
  const race = await Promise.allSettled(Array.from({ length: 4 }, () => captureCharge({ encounterId: encM2._id, serviceId: consult._id }, admin)));
  const wins = race.filter((r) => r.status === 'fulfilled').length;
  const codes = race.filter((r) => r.status === 'rejected').map((r) => r.reason.code);
  assert.equal(wins, 2, JSON.stringify(codes)); assert.ok(codes.every((c) => c === 'MEMBER_LIMIT_EXCEEDED'), JSON.stringify(codes));
  assert.equal((await Charge.aggregate([{ $match: { patientId: M2._id, status: 'posted' } }, { $group: { _id: null, t: { $sum: '$totalKobo' } } }]))[0].t, 1_000_000);
  step('4 simultaneous charges against a 1,000,000 member limit: exactly 2 succeeded');

  // ---------------------------------------------------------------- 3. authorization
  const corpC = await newCorp('Auth Corp', { authorizationThresholdKobo: 300_000 }, tariff._id);
  const N = await newPerson('Needs', tariff._id);
  await addCoverage(corpC._id, { patientId: N._id, relationship: 'employee' }, admin);
  const encN = await open(N, corpC._id);
  await captureCharge({ encounterId: encN._id, serviceId: lab._id }, admin); // under the threshold
  await expectCode(captureCharge({ encounterId: encN._id, serviceId: consult._id }, admin), 'AUTHORIZATION_REQUIRED');
  await expectCode(captureCharge({ encounterId: encN._id, serviceId: mri._id }, admin), 'AUTHORIZATION_REQUIRED');
  step('charges above the payer threshold, and services that always need approval, are refused without one');

  await expectCode(requestAuthorization({ payerId: N.selfPayerId, patientId: N._id, requestedAmountKobo: 1000 }, doctor), 'NOT_APPLICABLE');
  const au = await requestAuthorization({ payerId: corpC._id, patientId: N._id, serviceId: consult._id, requestedAmountKobo: 500_000, description: 'specialist review' }, doctor);
  assert.match(au.authNo, /^AUTH-\d{6}$/);
  const okBody = { decision: 'approve', approvedAmountKobo: 500_000, expiresAt: soon(7 * 86_400_000), externalRef: 'ACME/2026/001' };
  await expectCode(decideAuthorization(au._id, okBody, doctor), 'SELF_APPROVAL');
  await expectCode(decideAuthorization(au._id, { ...okBody, externalRef: undefined }, finance), 'REFERENCE_REQUIRED');
  await expectCode(decideAuthorization(au._id, { ...okBody, expiresAt: soon(200 * 86_400_000) }, finance), 'EXPIRY_TOO_FAR');
  const approved = await decideAuthorization(au._id, okBody, finance);
  assert.equal(approved.status, 'approved');
  await expectCode(decideAuthorization(au._id, okBody, finance), 'ALREADY_DECIDED');
  step('authorization: requester cannot approve own request; payer reference and sensible expiry are mandatory');

  const used = await captureCharge({ encounterId: encN._id, serviceId: consult._id }, admin);
  assert.equal(String(used.charge.authorizationId), String(au._id));
  assert.equal((await Authorization.findById(au._id).lean()).usedKobo, 500_000);
  await expectCode(captureCharge({ encounterId: encN._id, serviceId: consult._id }, admin), 'AUTHORIZATION_REQUIRED');
  await voidCharge(used.charge._id, 'wrong patient file', admin);
  assert.equal((await Authorization.findById(au._id).lean()).usedKobo, 0);
  await db.collection('authorizations').updateOne({ _id: au._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  await expectCode(captureCharge({ encounterId: encN._id, serviceId: consult._id }, admin), 'AUTHORIZATION_REQUIRED');
  step('authorization is consumed by charges, handed back by a void, and useless once expired');

  const N2 = await newPerson('Urgent', tariff._id);
  await addCoverage(corpC._id, { patientId: N2._id, relationship: 'employee' }, admin);
  const encN2 = await open(N2, corpC._id, 'emergency');
  const em = await captureCharge({ encounterId: encN2._id, serviceId: mri._id }, admin);
  assert.equal(em.charge.authorizationBypassed, true);
  step('emergency: treated first, flagged "authorization bypassed" for billing to follow up');

  // ---------------------------------------------------------------- 4. adjustments (discount, credit note, waiver, write-off)
  const W = await newPerson('Walkin', tariff._id);
  const encW = await open(W, undefined);
  await captureCharge({ encounterId: encW._id, serviceId: consult._id }, admin);
  const labW = await captureCharge({ encounterId: encW._id, serviceId: lab._id }, admin);
  await expectCode(closeEncounter(encW._id, {}, admin), 'PAYMENT_REQUIRED');
  const [invW] = await Invoice.find({ encounterId: encW._id }).lean();
  assert.equal(invW.totalKobo, 750_000);

  const d1 = await requestAdjustment({ invoiceId: invW._id, kind: 'discount', percent: 10, reason: 'staff relative' }, cashier);
  assert.equal(d1.amountKobo, 75_000); assert.equal(d1.status, 'pending'); assert.equal((await inv(invW._id)).creditedKobo, 0);
  await expectCode(decideAdjustment(d1._id, { decision: 'approve' }, cashier), 'SELF_APPROVAL');
  await expectCode(requestAdjustment({ invoiceId: invW._id, kind: 'discount', amountKobo: 9_000_000, reason: 'too much' }, cashier), 'EXCEEDS_INVOICE');
  const d1ok = await decideAdjustment(d1._id, { decision: 'approve', note: 'ok' }, finance);
  assert.equal(d1ok.status, 'applied'); assert.match(d1ok.creditNoteNo, /^CN-\d{6}$/);
  const i1 = await inv(invW._id);
  assert.deepEqual([i1.creditedKobo, i1.paidKobo, i1.status], [75_000, 75_000, 'partial']); assert.equal(await bal(W.selfPayerId), 675_000);
  step('10% discount: nothing changes until a different person approves; then invoice and ledger both drop by 75,000');

  const rj = await requestAdjustment({ invoiceId: invW._id, kind: 'discount', amountKobo: 1000, reason: 'try it on' }, cashier);
  assert.equal((await decideAdjustment(rj._id, { decision: 'reject', note: 'no' }, finance)).status, 'rejected');
  assert.equal((await inv(invW._id)).creditedKobo, 75_000);

  const pay = await recordManualPayment({ payerId: W.selfPayerId, amountKobo: 675_000, method: 'cash', invoiceId: invW._id }, cashier);
  assert.equal((await inv(invW._id)).status, 'paid'); assert.equal(await bal(W.selfPayerId), 0);
  await closeEncounter(encW._id, {}, admin);

  // overcharge discovered after payment: credit note on a PAID invoice
  const cn = await requestAdjustment({ invoiceId: invW._id, kind: 'credit_note', chargeIds: [labW.charge._id], reason: 'test not performed' }, billing);
  assert.equal(cn.amountKobo, 250_000);
  const cnOk = await decideAdjustment(cn._id, { decision: 'approve' }, finance);
  assert.equal(cnOk.releasedToCreditKobo, 250_000);
  const i2 = await inv(invW._id); const pay2 = await Payment.findById(pay.payment._id).lean();
  assert.deepEqual([i2.creditedKobo, i2.paidKobo, i2.status], [325_000, 750_000, 'paid']);
  assert.equal(i2.lines.find((l) => String(l.chargeId) === String(labW.charge._id)).credited, true);
  assert.equal((await Charge.findById(labW.charge._id).lean()).status, 'reversed');
  assert.equal(pay2.unallocatedKobo, 250_000); assert.equal(pay2.allocations.reduce((s, a) => s + a.amountKobo, 0), 425_000);
  assert.equal(await bal(W.selfPayerId), -250_000);
  await expectCode(requestAdjustment({ invoiceId: invW._id, kind: 'credit_note', chargeIds: [labW.charge._id], reason: 'again' }, billing), 'CHARGES_NOT_CREDITABLE');
  step('credit note on an already-paid invoice: charge reversed, 250,000 released back to the patient as held credit');

  // refund that credit
  const rf = await requestRefund({ paymentId: pay.payment._id, amountKobo: 250_000, method: 'cash', reason: 'credit note refund' }, cashier);
  assert.match(rf.refundNo, /^RF-\d{6}$/);
  await expectCode(requestRefund({ paymentId: pay.payment._id, amountKobo: 1, method: 'cash', reason: 'while one is pending' }, cashier), 'INSUFFICIENT_CREDIT');
  await expectCode(decideRefund(rf._id, { decision: 'approve' }, cashier), 'SELF_APPROVAL');
  const rfOk = await decideRefund(rf._id, { decision: 'approve' }, finance);
  assert.equal(rfOk.status, 'approved'); assert.equal(await bal(W.selfPayerId), 0);
  assert.equal((await Payment.findById(pay.payment._id).lean()).unallocatedKobo, 0);
  const paidOut = await payRefund(rf._id, { payoutRef: 'CASH-VOUCHER-1' }, cashier);
  assert.equal(paidOut.status, 'paid');
  await expectCode(payRefund(rf._id, { payoutRef: 'again' }, cashier), 'NOT_PAYABLE');
  assert.equal((await Payment.findById(pay.payment._id).lean()).unallocatedKobo, 0);
  await expectCode(cancelRefund(rf._id, 'too late', finance), 'ALREADY_PAID');
  step('refund: requested, approved by someone else, paid out once; cannot be refunded twice or cancelled after payout');

  const topup = await recordManualPayment({ payerId: W.selfPayerId, amountKobo: 100_000, method: 'cash' }, cashier);
  const rf2 = await requestRefund({ paymentId: topup.payment._id, amountKobo: 100_000, method: 'cash', reason: 'changed mind' }, cashier);
  await decideRefund(rf2._id, { decision: 'approve' }, finance);
  assert.equal(await bal(W.selfPayerId), 0);
  await cancelRefund(rf2._id, 'patient decided to keep the deposit', finance);
  assert.equal(await bal(W.selfPayerId), -100_000); assert.equal((await Payment.findById(topup.payment._id).lean()).unallocatedKobo, 100_000);
  step('cancelling an approved refund puts the credit back exactly as it was');

  // waiver
  const W2 = await newPerson('Waived', tariff._id);
  const encW2 = await open(W2, undefined);
  await captureCharge({ encounterId: encW2._id, serviceId: lab._id }, admin);
  await expectCode(closeEncounter(encW2._id, {}, admin), 'PAYMENT_REQUIRED');
  const [invW2] = await Invoice.find({ encounterId: encW2._id }).lean();
  const wv = await requestAdjustment({ invoiceId: invW2._id, kind: 'waiver', reason: 'indigent patient, approved by CMD' }, billing);
  await decideAdjustment(wv._id, { decision: 'approve' }, finance);
  assert.equal((await inv(invW2._id)).status, 'paid'); assert.equal(await bal(W2.selfPayerId), 0);
  await closeEncounter(encW2._id, {}, admin);
  step('waiver clears the whole balance; the visit can then be closed without payment');

  // write-off on an overdue corporate invoice
  const encC = await openEncounter({ patientId: E1._id, type: 'outpatient', payerId: corpA._id, allowSecondOpen: true }, admin);
  await captureCharge({ encounterId: encC._id, serviceId: lab._id }, admin); // 200,000 plan share
  const cinv = await invoicePayerPeriod(corpA._id, { periodEnd: soon(120_000) }, admin);
  await expectCode(requestAdjustment({ invoiceId: cinv.invoice._id, kind: 'writeoff', amountKobo: 50_000, reason: 'uncollectable' }, billing), 'NOT_OVERDUE');
  await db.collection('invoices').updateOne({ _id: cinv.invoice._id }, { $set: { dueAt: new Date(Date.now() - 86_400_000) } });
  await expectCode(requestAdjustment({ invoiceId: cinv.invoice._id, kind: 'writeoff', amountKobo: 999_999_999, reason: 'too big' }, billing), 'EXCEEDS_OUTSTANDING');
  const balBefore = await bal(corpA._id);
  const wo = await requestAdjustment({ invoiceId: cinv.invoice._id, kind: 'writeoff', amountKobo: 50_000, reason: 'company insolvent, partial loss' }, billing);
  await decideAdjustment(wo._id, { decision: 'approve' }, finance);
  assert.equal(await bal(corpA._id), balBefore - 50_000); assert.equal((await inv(cinv.invoice._id)).creditedKobo, 50_000);
  step('write-off only on overdue invoices, never above the unpaid balance, reduces the ledger by the written-off amount');

  for (const id of [corpA._id, corpB._id, corpC._id, W.selfPayerId, W2.selfPayerId, E1.selfPayerId, P.selfPayerId, M.selfPayerId, N.selfPayerId]) {
    const r = await reconcilePayer(id); assert.equal(r.ok, true, JSON.stringify(r));
  }
  step('every payer touched by this test reconciles exactly with its ledger');
  console.log('\nAll money-control checks passed.');
} finally {
  const pid = created.patients; const yid = created.payers; const raw = (n) => db.collection(n);
  await raw('ledgerentries').deleteMany({ payerId: { $in: yid } });
  await raw('refunds').deleteMany({ payerId: { $in: yid } });
  await raw('adjustments').deleteMany({ payerId: { $in: yid } });
  await raw('authorizations').deleteMany({ payerId: { $in: yid } });
  await raw('payments').deleteMany({ payerId: { $in: yid } });
  await raw('invoices').deleteMany({ payerId: { $in: yid } });
  await raw('charges').deleteMany({ patientId: { $in: pid } });
  await raw('encounters').deleteMany({ patientId: { $in: pid } });
  await raw('coverages').deleteMany({ $or: [{ patientId: { $in: pid } }, { payerId: { $in: yid } }] });
  await raw('payers').deleteMany({ _id: { $in: yid } });
  await raw('patients').deleteMany({ _id: { $in: pid } });
  await raw('tariffitems').deleteMany({ tariffId: { $in: created.tariffs } });
  await raw('tariffs').deleteMany({ _id: { $in: created.tariffs } });
  await raw('services').deleteMany({ _id: { $in: created.services } });
  const before = new Map(countersBefore.map((c) => [c._id, c.seq]));
  for (const c of await raw('counters').find().toArray()) {
    if (before.has(c._id)) await raw('counters').updateOne({ _id: c._id }, { $set: { seq: before.get(c._id) } });
    else await raw('counters').deleteOne({ _id: c._id });
  }
  await disconnectDB();
}
