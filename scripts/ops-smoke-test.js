// End-to-end check of Phase 4B against your database: npm run test:ops
// Covers cashier shifts (blind count, variance, a close-versus-payment race), reports and CSV, the notification
// outbox with retries, overdue reminders/suspension/reinstatement, low-balance alerts, and a full two-factor
// login over HTTP. !! Run on a DEVELOPMENT database only. Nothing is really sent: it needs the 'log' providers.
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import app from '../src/app.js';
import { connectDB, disconnectDB } from '../src/config/db.js';
import { Payer } from '../src/models/Payer.js';
import { Patient } from '../src/models/Patient.js';
import { Service } from '../src/models/Service.js';
import { Invoice } from '../src/models/Invoice.js';
import { Payment } from '../src/models/Payment.js';
import { Notification } from '../src/models/Notification.js';
import { CashierSession } from '../src/models/CashierSession.js';
import { User } from '../src/models/User.js';
import { createPatient } from '../src/services/patients.service.js';
import { createPayer, updatePayer } from '../src/services/payers.service.js';
import { addCoverage } from '../src/services/coverage.service.js';
import { createTariff, setTariffPrices } from '../src/services/catalog.service.js';
import { openEncounter } from '../src/services/encounters.service.js';
import { captureCharge } from '../src/services/charges.service.js';
import { invoicePayerPeriod } from '../src/services/billing-cycle.service.js';
import { recordManualPayment } from '../src/services/payments.service.js';
import { requestRefund, decideRefund, payRefund } from '../src/services/refunds.service.js';
import { openSession, getCurrentSession, getSession, closeSession, reviewSession } from '../src/services/cashier-sessions.service.js';
import { revenueByDepartment, agingReport, collectionsByCashier, cardUsageReport } from '../src/services/reports.service.js';
import { dispatchNotifications, enqueueNotifications, retryNotification } from '../src/services/notifications.service.js';
import { processOverdue, queueLowBalanceAlerts } from '../src/services/overdue.service.js';
import { listInvoices } from '../src/services/invoices.service.js';
import * as mfa from '../src/services/mfa.service.js';
import { totpAt } from '../src/utils/totp.js';
import { toCsv } from '../src/utils/csv.js';

const problems = [];
if (env.isProd) problems.push('NODE_ENV must not be production');
if (!env.REQUIRE_CASHIER_SESSION) problems.push('REQUIRE_CASHIER_SESSION must be true');
if (env.NOTIFY_EMAIL_PROVIDER !== 'log' || env.NOTIFY_SMS_PROVIDER !== 'log') problems.push("NOTIFY_EMAIL_PROVIDER and NOTIFY_SMS_PROVIDER must be 'log' (this test must never send real messages)");
if (!env.NOTIFICATIONS_ENABLED) problems.push('NOTIFICATIONS_ENABLED must be true');
if (env.ALLOW_SELF_APPROVAL) problems.push('ALLOW_SELF_APPROVAL must be false');
if (env.WALKIN_PAYMENT_POLICY !== 'after') problems.push("WALKIN_PAYMENT_POLICY must be 'after'");
if (!(env.OVERDUE_SUSPEND_AFTER_DAYS > 0)) problems.push('OVERDUE_SUSPEND_AFTER_DAYS must be above 0');
if (problems.length) { console.error(`Fix .env before running this test:\n - ${problems.join('\n - ')}`); process.exit(1); }

await connectDB();
const db = mongoose.connection;
const person = () => new mongoose.Types.ObjectId();
const who = (role) => ({ actorId: role === 'admin' ? null : person(), actorRole: role, ip: 'local', userAgent: 'ops-smoke-test' });
const admin = who('admin'); const cashier1 = who('cashier'); const cashier2 = who('cashier'); const cashier3 = who('cashier'); const finance = who('finance_manager');
const sfx = Date.now().toString(36).toUpperCase();
const created = { patients: [], payers: [], services: [], tariffs: [], emails: [] };
const countersBefore = await db.collection('counters').find().toArray();
const realFetch = globalThis.fetch; const savedEnv = { ...env };
const step = (m) => console.log(`ok  ${m}`);
const bal = async (id) => (await Payer.findById(id).lean()).balanceKobo;
const expectCode = (p, code) => assert.rejects(p, (e) => { assert.equal(e.code, code, `expected ${code} but got ${e.code}: ${e.message}`); return true; });
const rnd = () => String(Math.floor(Math.random() * 1e7)).padStart(7, '0');
const soon = (ms) => new Date(Date.now() + ms);
const DAY = 86_400_000;
const hour = { from: soon(-3_600_000), to: soon(3_600_000) };

async function newPerson(label, tariffId, extra = {}) {
  const p = await createPatient({ firstName: label, lastName: `Ops${sfx}`, dob: new Date('1982-02-02T00:00:00Z'), sex: 'male', phone: `0803${rnd()}`, ...extra }, admin);
  created.patients.push(p._id); created.payers.push(p.selfPayerId);
  if (tariffId) await Payer.updateOne({ _id: p.selfPayerId }, { $set: { tariffId } });
  return p;
}
const newCorp = async (name, tariffId) => {
  const c = await createPayer({
    type: 'corporate', name: `${name} ${sfx}`, billingContact: { name: 'HR', email: 'hr@example.com', phone: '08031234567' }, creditLimitKobo: 9_000_000,
    paymentTermsDays: 30, billingCycle: 'monthly', tariffId,
    contract: { startsAt: soon(-DAY), endsAt: soon(365 * DAY), coveredServices: [], excludedServices: [] },
  }, admin);
  created.payers.push(c._id);
  return c;
};
async function visit(patient, payerId, services) {
  const enc = await openEncounter({ patientId: patient._id, type: 'outpatient', payerId, allowSecondOpen: true }, admin);
  for (const s of services) await captureCharge({ encounterId: enc._id, serviceId: s._id }, admin);
  return enc;
}

try {
  // ---------------------------------------------------------------- setup
  const mk = async (code, name, department, category) => { const s = await Service.create({ code: `${code}-${sfx}`, name, department, category }); created.services.push(s._id); return s; };
  const consult = await mk('O-CONS', 'Consultation', 'consultation', 'consultation');
  const lab = await mk('O-LAB', 'Lab test', 'laboratory', 'lab-test');
  const tariff = await createTariff({ code: `O-${sfx}`, name: 'Ops test tariff' }, admin);
  created.tariffs.push(tariff._id);
  await setTariffPrices(tariff._id, [{ serviceId: consult._id, priceKobo: 500_000 }, { serviceId: lab._id, priceKobo: 250_000 }], admin);

  // ================================================================ A. cashier shifts
  const W = await newPerson('Till', tariff._id);
  await expectCode(recordManualPayment({ payerId: W.selfPayerId, amountKobo: 1000, method: 'cash' }, cashier1), 'CASHIER_SESSION_REQUIRED');
  const sess = await openSession({ openingFloatKobo: 50_000 }, cashier1);
  await expectCode(openSession({}, cashier1), 'SESSION_ALREADY_OPEN');
  step('no payment without an open shift; one open shift per cashier');

  const p1 = await recordManualPayment({ payerId: W.selfPayerId, amountKobo: 300_000, method: 'cash' }, cashier1);
  const p2 = await recordManualPayment({ payerId: W.selfPayerId, amountKobo: 80_000, method: 'cash' }, cashier1);
  await recordManualPayment({ payerId: W.selfPayerId, amountKobo: 200_000, method: 'pos', externalRef: 'POS-BATCH-1' }, cashier1);
  await recordManualPayment({ payerId: W.selfPayerId, amountKobo: 100_000, method: 'transfer', externalRef: 'NIP-OPS-1' }, cashier1);
  assert.equal(String(p1.payment.cashierSessionId), String(sess._id));
  const rf = await requestRefund({ paymentId: p2.payment._id, amountKobo: 30_000, method: 'cash', reason: 'unused deposit returned' }, cashier1);
  await decideRefund(rf._id, { decision: 'approve' }, finance);
  await payRefund(rf._id, { payoutRef: 'CASH-OUT-1' }, cashier1);

  const mine = await getCurrentSession(cashier1);
  assert.equal(mine.open, true); assert.equal(mine.session.expected, undefined); assert.equal(mine.session.liveExpected, undefined);
  assert.deepEqual(mine.session.activity, { payments: 4, refundsPaid: 1 });
  const theirView = await getSession(sess._id, finance);
  assert.deepEqual(theirView.liveExpected, { cashKobo: 400_000, posKobo: 200_000, transferKobo: 100_000 }); // 50,000 float + 380,000 cash - 30,000 refund
  step('blind count: the cashier sees activity but not expected amounts; a reviewer sees 400,000 cash expected');

  await expectCode(closeSession(sess._id, { countedCashKobo: 0, countedPosKobo: 0, countedTransferKobo: 0 }, cashier2), 'NOT_YOUR_SESSION');
  const closed = await closeSession(sess._id, { countedCashKobo: 395_000, countedPosKobo: 200_000, countedTransferKobo: 100_000, note: 'short by a small amount' }, cashier1);
  assert.deepEqual(closed.expected, { cashKobo: 400_000, posKobo: 200_000, transferKobo: 100_000 });
  assert.deepEqual(closed.variance, { cashKobo: -5_000, posKobo: 0, transferKobo: 0 });
  assert.equal(closed.flagged, 5_000 > env.CASH_VARIANCE_ALERT_KOBO);
  await expectCode(closeSession(sess._id, { countedCashKobo: 1, countedPosKobo: 0, countedTransferKobo: 0 }, cashier1), 'SESSION_NOT_OPEN');
  await expectCode(recordManualPayment({ payerId: W.selfPayerId, amountKobo: 1000, method: 'cash' }, cashier1), 'CASHIER_SESSION_REQUIRED');
  await expectCode(reviewSession(sess._id, { note: 'ok' }, cashier1), 'SELF_APPROVAL');
  assert.equal((await reviewSession(sess._id, { note: 'short 50.00, accepted' }, finance)).status, 'reviewed');
  step('close compares counted with expected (variance -5,000 flagged); closed shifts take no payments; a different person reviews');

  const W3 = await newPerson('Race', tariff._id);
  const s3 = await openSession({ openingFloatKobo: 0 }, cashier3);
  const race = await Promise.allSettled([
    closeSession(s3._id, { countedCashKobo: 0, countedPosKobo: 0, countedTransferKobo: 0 }, cashier3),
    ...[1, 2, 3].map(() => recordManualPayment({ payerId: W3.selfPayerId, amountKobo: 10_000, method: 'cash' }, cashier3)),
  ]);
  const after = await CashierSession.findById(s3._id).lean();
  const landed = await Payment.countDocuments({ cashierSessionId: s3._id, status: 'success' });
  assert.equal(after.status, 'closed'); assert.equal(after.expected.cashKobo, landed * 10_000, 'a payment slipped past the close');
  assert.ok(race.slice(1).filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'CASHIER_SESSION_REQUIRED'));
  step(`a close racing 3 payments: ${landed} landed and all ${landed} are in the expected total; the rest were refused`);

  // ================================================================ B. reports
  const corp = await newCorp('Report Corp', tariff._id);
  const E = await newPerson('Staff', tariff._id);
  await addCoverage(corp._id, { patientId: E._id, relationship: 'employee', employeeRef: 'R-1' }, admin);
  await visit(E, corp._id, [consult, lab]);
  const rev = await revenueByDepartment({ ...hour, payerId: corp._id });
  assert.equal(rev.rows.find((r) => r.department === 'consultation').corporate, 500_000);
  assert.equal(rev.rows.find((r) => r.department === 'laboratory').corporate, 250_000);
  assert.deepEqual([rev.totals.grossKobo, rev.totals.netKobo, rev.totals.corporateKobo], [750_000, 750_000, 750_000]);
  step('revenue by department: consultation 5,000.00 + laboratory 2,500.00 = 7,500.00, all corporate');

  const inv1 = (await invoicePayerPeriod(corp._id, { periodEnd: soon(60_000) }, admin)).invoice;
  await db.collection('invoices').updateOne({ _id: inv1._id }, { $set: { dueAt: soon(-45 * DAY) } });
  await visit(E, corp._id, [lab]);
  await invoicePayerPeriod(corp._id, { periodEnd: soon(120_000) }, admin);
  const age = await agingReport({ payerId: corp._id });
  assert.equal(age.rows.length, 1);
  assert.deepEqual([age.rows[0].d31_60, age.rows[0].current, age.rows[0].total, age.rows[0].invoiceCount], [750_000, 250_000, 1_000_000, 2]);
  assert.equal(age.rows[0].payerCode, corp.code);
  step('ageing: 7,500.00 sits in 31-60 days overdue, 2,500.00 not yet due');

  const col = (await collectionsByCashier(hour)).rows.find((r) => String(r.userId) === String(cashier1.actorId));
  assert.deepEqual([col.cash, col.pos, col.transfer, col.refundsPaid, col.net, col.payments], [380_000, 200_000, 100_000, 30_000, 650_000, 4]);
  step('collections by cashier: 380,000 cash + 200,000 POS + 100,000 transfer - 30,000 refund = 650,000 net');

  const H = await newPerson('=HYPERLINK("http://evil.example","click")', tariff._id);
  const card = await createPayer({ type: 'family', holderPatientId: H._id, mode: 'credit', creditLimitKobo: 2_000_000, tariffId: tariff._id, guarantor: { name: 'G One', phone: '08011112222' } }, admin);
  created.payers.push(card._id);
  await visit(H, card._id, [consult]);
  const members = await cardUsageReport({ ...hour, payerId: card._id });
  assert.equal(members.rows.length, 1); assert.equal(members.rows[0].chargedKobo, 500_000);
  const csv = toCsv(members.columns, members.rows);
  assert.ok(csv.includes(`"'=HYPERLINK(""http://evil.example"",""click"")`) || csv.includes("'=HYPERLINK("), 'formula was not neutralised');
  assert.ok(!/(^|,|\r\n)=HYPERLINK/.test(csv));
  const cards = await cardUsageReport(hour);
  const row = cards.rows.find((r) => r.code === card.code);
  assert.deepEqual([row.chargedKobo, row.membersCharged, row.utilizationPct], [500_000, 1, 25]);
  step('card usage by member and by card (25% of limit used); a patient name that is a spreadsheet formula is defused in the CSV');

  // ================================================================ C. notifications
  const sent = await Notification.find({ payerId: W.selfPayerId }).lean();
  assert.equal(sent.length, 4); assert.ok(sent.every((n) => n.channel === 'sms' && n.template === 'payment_received' && n.status === 'queued'));
  assert.ok(sent.every((n) => /NGN [\d,]+\.\d\d/.test(n.body) && /RCT-\d{6}/.test(n.body)));
  const d1 = await dispatchNotifications({ filter: { payerId: W.selfPayerId } });
  const d2 = await dispatchNotifications({ filter: { payerId: W.selfPayerId } });
  assert.deepEqual([d1.sent, d2.sent], [4, 0]);
  step('4 payments queued 4 SMS in the same transaction; dispatched once, never twice');

  const WO = await newPerson('Optout', tariff._id);
  await Patient.updateOne({ _id: WO._id }, { $set: { notifyOptOut: true } });
  await recordManualPayment({ payerId: WO.selfPayerId, amountKobo: 5_000, method: 'cash' }, admin);
  assert.equal(await Notification.countDocuments({ payerId: WO.selfPayerId }), 0);
  const issued = await Notification.find({ payerId: corp._id, template: 'invoice_issued' }).lean();
  assert.deepEqual(issued.map((n) => n.channel).sort(), ['email', 'email', 'sms', 'sms']); // two invoices, email + SMS each
  step('a patient who opted out gets nothing; invoice notices go to the company\'s billing contact');

  const corpLean = await Payer.findById(corp._id).lean();
  await enqueueNotifications({ template: 'low_balance', payer: corpLean, data: { payerName: 'Retry test', availableKobo: 1 }, dedupeKey: `ops-${sfx}`, relatedType: 'ops-test', relatedId: corp._id });
  const only = { relatedType: 'ops-test' };
  Object.assign(env, { NOTIFY_EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 'rk_test_123456', EMAIL_FROM: 'Billing <billing@example.com>' });
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'boom' }), { status: 500 });
  const f1 = await dispatchNotifications({ filter: only });
  assert.deepEqual([f1.sent, f1.retry], [1, 1]); // the SMS (log provider) went; the email failed
  let em = await Notification.findOne({ ...only, channel: 'email' }).lean();
  assert.deepEqual([em.status, em.attempts], ['queued', 1]); assert.ok(em.sendAfter > new Date()); assert.match(em.lastError, /500/);
  for (let i = 0; i < 2; i++) { await Notification.updateOne({ _id: em._id }, { $set: { sendAfter: new Date() } }); await dispatchNotifications({ filter: only }); }
  em = await Notification.findOne({ _id: em._id }).lean();
  assert.deepEqual([em.status, em.attempts], ['failed', 3]);
  globalThis.fetch = async () => new Response(JSON.stringify({ id: 'em_ops_1' }), { status: 200 });
  await retryNotification(em._id, admin); await dispatchNotifications({ filter: only });
  em = await Notification.findOne({ _id: em._id }).lean();
  assert.deepEqual([em.status, em.providerId], ['sent', 'em_ops_1']);
  globalThis.fetch = realFetch; Object.assign(env, { NOTIFY_EMAIL_PROVIDER: savedEnv.NOTIFY_EMAIL_PROVIDER, RESEND_API_KEY: savedEnv.RESEND_API_KEY, EMAIL_FROM: savedEnv.EMAIL_FROM });
  step('a failing provider: retried with back-off, marked failed after 3 attempts, then sent after a manual retry');

  // ================================================================ D. overdue
  const od = await newCorp('Overdue Corp', tariff._id);
  const Q = await newPerson('Slow', tariff._id);
  await addCoverage(od._id, { patientId: Q._id, relationship: 'employee' }, admin);
  const encQ = await visit(Q, od._id, [consult]);
  const odInv = (await invoicePayerPeriod(od._id, { periodEnd: soon(60_000) }, admin)).invoice;
  const daysLate = env.OVERDUE_SUSPEND_AFTER_DAYS + 15;
  await db.collection('invoices').updateOne({ _id: odInv._id }, { $set: { dueAt: soon(-daysLate * DAY) } });
  const listed = await listInvoices({ payerId: od._id, overdue: true, page: 1, limit: 10 });
  assert.equal(listed.items.length, 1); assert.equal(listed.items[0].overdue, true); assert.ok(listed.items[0].daysOverdue >= daysLate);

  const stage = Math.max(...env.OVERDUE_REMINDER_DAYS.filter((d) => d <= daysLate));
  const o1 = await processOverdue({ payerIds: [od._id] });
  assert.equal(o1.invoicesReminded, 1); assert.equal(o1.remindersQueued, 2); assert.deepEqual(o1.suspended, [od.code]);
  const odAfter = await Invoice.findById(odInv._id).lean();
  assert.deepEqual([...odAfter.remindersSent].sort((a, b) => a - b), env.OVERDUE_REMINDER_DAYS.filter((d) => d <= stage));
  assert.ok(await Notification.exists({ dedupeKey: `overdue:${odInv._id}:${stage}:email` }));
  assert.match((await Notification.findOne({ dedupeKey: `overdue:${odInv._id}:${stage}:sms` }).lean()).body, /unpaid and is \d+ days overdue/);
  const odPayer = await Payer.findById(od._id).lean();
  assert.deepEqual([odPayer.status, odPayer.suspendedReason], ['suspended', 'overdue']);
  await expectCode(captureCharge({ encounterId: encQ._id, serviceId: lab._id }, admin), 'PAYER_NOT_USABLE');
  const o2 = await processOverdue({ payerIds: [od._id] });
  assert.deepEqual([o2.invoicesReminded, o2.remindersQueued, o2.suspended.length], [0, 0, 0]);
  step(`overdue ${daysLate} days: one reminder (stage ${stage}), payer suspended, new charges refused; a second run does nothing`);

  await recordManualPayment({ payerId: od._id, amountKobo: odInv.totalKobo, method: 'transfer', externalRef: 'NIP-OD', invoiceId: odInv._id }, admin);
  const o3 = await processOverdue({ payerIds: [od._id] });
  assert.deepEqual(o3.reinstated, [od.code]);
  const back = await Payer.findById(od._id).lean(); assert.equal(back.status, 'active'); assert.equal(back.suspendedReason, undefined);
  await captureCharge({ encounterId: encQ._id, serviceId: lab._id }, admin);
  step('once the overdue invoice is paid the payer is reinstated automatically and can be charged again');

  const hold = await newCorp('Manual Hold Corp', tariff._id);
  await updatePayer(hold._id, { status: 'suspended' }, admin);
  assert.equal((await Payer.findById(hold._id).lean()).suspendedReason, 'manual');
  assert.deepEqual((await processOverdue({ payerIds: [hold._id] })).reinstated, []);
  assert.equal((await Payer.findById(hold._id).lean()).status, 'suspended');
  step('a payer suspended by a person is never reinstated by the overdue job');

  const HP = await newPerson('Prepaid', tariff._id);
  const pre = await createPayer({ type: 'family', holderPatientId: HP._id, mode: 'prepaid' }, admin);
  created.payers.push(pre._id);
  await updatePayer(pre._id, { lowBalanceThresholdKobo: 150_000 }, admin);
  await recordManualPayment({ payerId: pre._id, amountKobo: 100_000, method: 'cash' }, admin);
  const lb1 = await queueLowBalanceAlerts({ payerIds: [pre._id] }); const lb2 = await queueLowBalanceAlerts({ payerIds: [pre._id] });
  assert.deepEqual([lb1.cardsLow, lb1.queued, lb2.queued], [1, 1, 0]);
  step('prepaid card at or below its threshold gets one low-balance alert per week');

  // ================================================================ E. two-factor authentication
  const mkUser = async (role, label) => {
    const email = `ops-${label}-${sfx}@example.com`.toLowerCase(); created.emails.push(email);
    return User.create({ name: `Ops ${label}`, email, role, passwordHash: await bcrypt.hash('Correct-Horse-9!', 10), mustChangePassword: false });
  };
  const withSecrets = (id) => User.findById(id).select('+mfaSecretEnc +mfaLastStep +mfaBackupCodes');
  const u1 = await mkUser('finance_manager', 'f1');
  const setup = await mfa.beginSetup(u1._id, admin);
  assert.ok(!JSON.stringify(await db.collection('users').findOne({ _id: u1._id })).includes(setup.secret));
  await expectCode(mfa.confirmSetup(u1._id, totpAt(setup.secret, Date.now() + 5 * 30_000), admin), 'INVALID_CODE');
  const enrolCode = totpAt(setup.secret);
  const conf = await mfa.confirmSetup(u1._id, enrolCode, admin);
  assert.equal(conf.backupCodes.length, 10); assert.ok(conf.backupCodes.every((c) => /^[0-9A-F]{5}-[0-9A-F]{5}$/.test(c)));
  assert.equal(await mfa.verifySecondFactor(await withSecrets(u1._id), { code: enrolCode }), false); // the enrolment code cannot be reused
  assert.equal(await mfa.verifySecondFactor(await withSecrets(u1._id), { code: totpAt(setup.secret, Date.now() + 30_000) }), true);
  assert.equal(await mfa.verifySecondFactor(await withSecrets(u1._id), { code: totpAt(setup.secret, Date.now() + 30_000) }), false);
  assert.equal(await mfa.verifySecondFactor(await withSecrets(u1._id), { backupCode: conf.backupCodes[0].toLowerCase() }), true);
  assert.equal(await mfa.verifySecondFactor(await withSecrets(u1._id), { backupCode: conf.backupCodes[0] }), false);
  assert.equal(await mfa.verifySecondFactor(await withSecrets(u1._id), { backupCode: 'AAAAA-BBBBB' }), false);
  step('MFA: secret stored encrypted; each code and each backup code works exactly once');

  const u2 = await mkUser('cashier', 'c1');
  const s2 = await mfa.beginSetup(u2._id, admin); await mfa.confirmSetup(u2._id, totpAt(s2.secret), admin);
  if (env.MFA_REQUIRED_ROLES.includes('cashier')) await expectCode(mfa.disableMfa(u2._id, { password: 'Correct-Horse-9!', code: totpAt(s2.secret, Date.now() + 30_000) }, admin), 'MFA_REQUIRED_FOR_ROLE');
  else {
    await expectCode(mfa.disableMfa(u2._id, { password: 'wrong-password', code: totpAt(s2.secret, Date.now() + 30_000) }, admin), 'INVALID_CREDENTIALS');
    await mfa.disableMfa(u2._id, { password: 'Correct-Horse-9!', code: totpAt(s2.secret, Date.now() + 30_000) }, admin);
    assert.equal((await User.findById(u2._id).lean()).mfaEnabled, false);
  }
  step('disabling MFA needs your password and a current code, and is blocked for roles that must have it');

  // full HTTP flow: a role that REQUIRES MFA logs in, is held until enrolled, then needs a code every time
  env.MFA_REQUIRED_ROLES = ['finance_manager'];
  const u3 = await mkUser('finance_manager', 'f3');
  const server = app.listen(0); const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const call = async (method, path, { token, body } = {}) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return [r.status, await r.json().catch(() => null), r];
  };
  const login = () => call('POST', '/auth/login', { body: { email: u3.email, password: 'Correct-Horse-9!' } });
  try {
    let [s, b] = await call('POST', '/auth/login', { body: { email: u3.email, password: 'wrong' } }); assert.equal(s, 401);
    [s, b] = await login(); assert.equal(s, 200); const t1 = b.token;
    [s, b] = await call('GET', '/reports/aging', { token: t1 }); assert.deepEqual([s, b.error.code], [403, 'MFA_ENROLLMENT_REQUIRED']);
    [s] = await call('GET', '/auth/me', { token: t1 }); assert.equal(s, 200);
    [s, b] = await call('POST', '/auth/mfa/setup', { token: t1 }); assert.equal(s, 200); const secret = b.secret; assert.match(b.otpauthUri, /^otpauth:\/\/totp\//);
    [s, b] = await call('POST', '/auth/mfa/confirm', { token: t1, body: { code: totpAt(secret) } }); assert.equal(s, 200); const t2 = b.token; const codes = b.backupCodes; assert.equal(codes.length, 10);
    [s] = await call('GET', '/reports/aging', { token: t1 }); assert.equal(s, 401);
    [s] = await call('GET', '/reports/aging', { token: t2 }); assert.equal(s, 200);
    let r; [s, b, r] = await call('GET', '/reports/aging?format=csv', { token: t2 }); assert.equal(s, 200);
    step('required-MFA role: blocked from everything but setup until enrolled; enrolling signs out the old session');

    [s, b] = await login(); assert.equal(b.mfaRequired, true); assert.equal(b.token, undefined); const pass = b.mfaToken;
    [s] = await call('GET', '/auth/me', { token: pass }); assert.equal(s, 401); // the half-finished login pass is not a session
    [s, b] = await call('POST', '/auth/mfa/verify', { body: { mfaToken: pass, code: totpAt(secret, Date.now() + 5 * 30_000) } }); assert.deepEqual([s, b.error.code], [401, 'INVALID_CODE']);
    const good = totpAt(secret, Date.now() + 30_000);
    [s, b] = await call('POST', '/auth/mfa/verify', { body: { mfaToken: pass, code: good } }); assert.equal(s, 200); const t3 = b.token;
    [s] = await call('GET', '/reports/aging', { token: t3 }); assert.equal(s, 200);
    [s, b] = await call('POST', '/auth/mfa/verify', { body: { mfaToken: pass, code: good } }); assert.equal(s, 401); // same code again
    [s, b] = await login(); [s, b] = await call('POST', '/auth/mfa/verify', { body: { mfaToken: b.mfaToken, backupCode: codes[3] } }); assert.equal(s, 200);
    step('login with MFA: wrong code refused, a code works once, a backup code works as a second factor, the half-login is useless alone');

    await mfa.adminResetMfa(u3._id, admin);
    [s] = await call('GET', '/reports/aging', { token: t3 }); assert.equal(s, 401);
    [s, b] = await login(); assert.equal(s, 200); assert.equal(b.mfaRequired, undefined);
    [s, b] = await call('GET', '/reports/aging', { token: b.token }); assert.deepEqual([s, b.error.code], [403, 'MFA_ENROLLMENT_REQUIRED']);
    step('an administrator reset signs the user out and sends them back to enrolment');
  } finally {
    server.close();
  }
  console.log('\nAll operations checks passed.');
} finally {
  globalThis.fetch = realFetch; Object.assign(env, savedEnv);
  const pid = created.patients; const yid = created.payers; const raw = (n) => db.collection(n);
  await raw('notifications').deleteMany({ payerId: { $in: yid } });
  await raw('cashiersessions').deleteMany({ cashierId: { $in: [cashier1.actorId, cashier2.actorId, cashier3.actorId] } });
  await raw('users').deleteMany({ email: { $in: created.emails } });
  await raw('ledgerentries').deleteMany({ payerId: { $in: yid } });
  await raw('refunds').deleteMany({ payerId: { $in: yid } });
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
