// End-to-end check of Phase 2 against your database: npm run test:billing
// Covers walk-in, deposit credit, corporate limits/exclusions, emergency + payer reassignment, and the
// Paystack finalize logic (idempotency, amount mismatch, retry after failure, concurrent finalize).
// !! Run on a DEVELOPMENT database only. It creates throwaway records and removes them afterwards, and it
//    restores the numbering counters (hospital/invoice/receipt numbers) to their previous values.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { connectDB, disconnectDB } from '../src/config/db.js';
import { Payer } from '../src/models/Payer.js';
import { Patient } from '../src/models/Patient.js';
import { Service } from '../src/models/Service.js';
import { Charge } from '../src/models/Charge.js';
import { Invoice } from '../src/models/Invoice.js';
import { Payment } from '../src/models/Payment.js';
import { LedgerEntry } from '../src/models/LedgerEntry.js';
import { createPatient } from '../src/services/patients.service.js';
import { createPayer } from '../src/services/payers.service.js';
import { addCoverage } from '../src/services/coverage.service.js';
import { createTariff, setTariffPrices } from '../src/services/catalog.service.js';
import { openEncounter, closeEncounter, reassignEncounterPayer } from '../src/services/encounters.service.js';
import { captureCharge, voidCharge } from '../src/services/charges.service.js';
import { invoiceEncounter } from '../src/services/invoices.service.js';
import { recordManualPayment, finalizePaystackPayment } from '../src/services/payments.service.js';
import { reconcilePayer } from '../src/services/ledger.service.js';

if (env.isProd) { console.error('Refusing to run with NODE_ENV=production.'); process.exit(1); }
if (env.WALKIN_PAYMENT_POLICY !== 'after') {
  console.error("This test assumes WALKIN_PAYMENT_POLICY=after. Set it to 'after' in .env while running it.");
  process.exit(1);
}

await connectDB();
const db = mongoose.connection;
const ctx = { actorId: null, actorRole: 'admin', ip: 'local', userAgent: 'billing-smoke-test' };
const sfx = Date.now().toString(36).toUpperCase();
const created = { patients: [], payers: [], services: [], tariffs: [], refs: [] };
const countersBefore = await db.collection('counters').find().toArray();
const step = (m) => console.log(`ok  ${m}`);
const bal = async (id) => (await Payer.findById(id).lean()).balanceKobo;
const expectCode = (p, code) => assert.rejects(p, (e) => { assert.equal(e.code, code, `expected ${code} but got ${e.code}: ${e.message}`); return true; });
const rnd = () => String(Math.floor(Math.random() * 1e7)).padStart(7, '0');

async function newPatient(label, tariffId) {
  const p = await createPatient({
    firstName: label, lastName: `Smoke${sfx}`, dob: new Date('1990-01-01T00:00:00Z'), sex: 'female', phone: `0800${rnd()}`,
  }, ctx);
  created.patients.push(p._id); created.payers.push(p.selfPayerId);
  if (tariffId) await Payer.updateOne({ _id: p.selfPayerId }, { $set: { tariffId } });
  return p;
}
const svcKobo = { consult: 500_000, lab: 250_000, drug: 50_000, cosmetic: 800_000 };

try {
  // ---------------------------------------------------------------- setup: services + a private tariff
  const mk = async (code, name, department, category) => { const s = await Service.create({ code: `${code}-${sfx}`, name, department, category }); created.services.push(s._id); return s; };
  const consult = await mk('T-CONS', 'Test consultation', 'consultation', 'consultation');
  const lab = await mk('T-LAB', 'Test lab test', 'laboratory', 'lab-test');
  const drug = await mk('T-DRUG', 'Test drug', 'pharmacy', 'drug');
  const cosmetic = await mk('T-COSM', 'Test cosmetic procedure', 'procedure', 'cosmetic');
  const tariff = await createTariff({ code: `T-${sfx}`, name: 'Smoke test tariff', isDefault: false }, ctx);
  created.tariffs.push(tariff._id);
  await setTariffPrices(tariff._id, [
    { serviceId: consult._id, priceKobo: svcKobo.consult }, { serviceId: lab._id, priceKobo: svcKobo.lab },
    { serviceId: drug._id, priceKobo: svcKobo.drug }, { serviceId: cosmetic._id, priceKobo: svcKobo.cosmetic },
  ], ctx);
  step('services and a tariff created');

  // price versioning: a changed price closes the old version; backdating is refused
  await setTariffPrices(tariff._id, [{ serviceId: drug._id, priceKobo: 60_000, effectiveFrom: new Date(Date.now() + 86_400_000) }], ctx);
  await expectCode(setTariffPrices(tariff._id, [{ serviceId: drug._id, priceKobo: 70_000, effectiveFrom: new Date(Date.now() - 86_400_000) }], ctx), 'BACKDATED_PRICE');
  step('tariff price versions: future-dated change accepted, backdating refused (drug still 500 today)');

  // ---------------------------------------------------------------- 1. walk-in
  const A = await newPatient('Walkin', tariff._id);
  assert.match(A.hospitalNumber, new RegExp(`^${env.HOSPITAL_NUMBER_PREFIX}-\\d{6}$`));
  await expectCode(createPatient({ firstName: 'Walkin', lastName: `Smoke${sfx}`, dob: new Date('1990-01-01T00:00:00Z'), sex: 'female', phone: A.phone }, ctx), 'POSSIBLE_DUPLICATE');
  step('patient registered with self payer; duplicate registration detected');

  const encA = await openEncounter({ patientId: A._id, type: 'outpatient' }, ctx);
  assert.equal(String(encA.primaryPayerId), String(A.selfPayerId));
  await expectCode(openEncounter({ patientId: A._id, type: 'outpatient' }, ctx), 'ENCOUNTER_ALREADY_OPEN');
  step('walk-in encounter opens on the self payer; a second open one is refused');

  const k1 = `smoke-${sfx}-consult-1`;
  const c1 = await captureCharge({ encounterId: encA._id, serviceId: consult._id, qty: 1, idempotencyKey: k1 }, ctx);
  const c1again = await captureCharge({ encounterId: encA._id, serviceId: consult._id, qty: 1, idempotencyKey: k1 }, ctx);
  assert.equal(c1again.duplicate, true); assert.equal(String(c1again.charge._id), String(c1.charge._id));
  await captureCharge({ encounterId: encA._id, serviceId: lab._id, qty: 2 }, ctx);
  assert.equal(await bal(A.selfPayerId), 500_000 + 500_000); step('charges priced from the tariff; retried request not double-charged');

  const d = await captureCharge({ encounterId: encA._id, serviceId: drug._id, qty: 1 }, ctx);
  assert.equal(d.charge.unitPriceKobo, 50_000);
  await voidCharge(d.charge._id, 'entered in error', ctx);
  assert.equal(await bal(A.selfPayerId), 1_000_000); step('charge voided via ledger reversal; balance restored');

  await expectCode(closeEncounter(encA._id, {}, ctx), 'PAYMENT_REQUIRED');
  const [invA] = await Invoice.find({ encounterId: encA._id }).lean();
  assert.equal(invA.totalKobo, 1_000_000); assert.equal(invA.status, 'issued'); assert.match(invA.invoiceNo, /^INV-\d{6}$/);
  step('closing with an unpaid balance is blocked; invoice was issued automatically');

  const p1 = await recordManualPayment({ payerId: A.selfPayerId, amountKobo: 400_000, method: 'cash', invoiceId: invA._id }, ctx);
  assert.match(p1.payment.receiptNo, /^RCT-\d{6}$/);
  assert.equal((await Invoice.findById(invA._id).lean()).status, 'partial');
  await expectCode(recordManualPayment({ payerId: A.selfPayerId, amountKobo: 700_000, method: 'cash', invoiceId: invA._id }, ctx), 'EXCEEDS_BALANCE');
  await recordManualPayment({ payerId: A.selfPayerId, amountKobo: 600_000, method: 'pos', externalRef: 'RRN123', invoiceId: invA._id }, ctx);
  assert.equal((await Invoice.findById(invA._id).lean()).status, 'paid'); assert.equal(await bal(A.selfPayerId), 0);
  await closeEncounter(encA._id, {}, ctx);
  step('part-payment then final payment; invoice paid, balance 0, encounter closed');

  // deposit first, charge later: credit is applied automatically when the invoice is issued
  const dep = await recordManualPayment({ payerId: A.selfPayerId, amountKobo: 700_000, method: 'transfer', externalRef: 'NIP-1' }, ctx);
  assert.equal(dep.payment.unallocatedKobo, 700_000); assert.equal(await bal(A.selfPayerId), -700_000);
  const encA2 = await openEncounter({ patientId: A._id, type: 'outpatient' }, ctx);
  await captureCharge({ encounterId: encA2._id, serviceId: consult._id }, ctx);
  assert.equal(await bal(A.selfPayerId), -200_000);
  await closeEncounter(encA2._id, {}, ctx); // no payment needed: deposit covers it
  assert.equal((await Payment.findById(dep.payment._id).lean()).unallocatedKobo, 200_000);
  step('deposit held as credit, applied to the next invoice automatically, 200,000 kobo remains');

  // ---------------------------------------------------------------- 2. Paystack finalize logic (no network)
  const mkPending = async (amountKobo) => {
    const reference = `HB-SMOKE-${crypto.randomBytes(6).toString('hex')}`;
    created.refs.push(reference);
    return Payment.create({ payerId: A.selfPayerId, patientId: A._id, method: 'paystack', amountKobo, status: 'pending', paystack: { reference } });
  };
  const gw = (ref, amount, status = 'success') => ({ id: 1, status, reference: ref, amount, currency: 'NGN', channel: 'card', paid_at: new Date().toISOString() });

  const pp = await mkPending(300_000);
  const before = await bal(A.selfPayerId);
  const f1 = await finalizePaystackPayment(pp.paystack.reference, gw(pp.paystack.reference, 300_000));
  const f2 = await finalizePaystackPayment(pp.paystack.reference, gw(pp.paystack.reference, 300_000));
  assert.equal(f1.outcome, 'success'); assert.equal(f2.outcome, 'already_processed');
  assert.equal(await bal(A.selfPayerId), before - 300_000);
  assert.equal(await LedgerEntry.countDocuments({ refType: 'payment', refId: pp._id }), 1);
  step('Paystack success credited exactly once; replay ignored');

  const pm = await mkPending(100_000);
  const fm = await finalizePaystackPayment(pm.paystack.reference, gw(pm.paystack.reference, 90_000));
  assert.equal(fm.outcome, 'amount_mismatch'); assert.equal((await Payment.findById(pm._id).lean()).status, 'flagged');
  assert.equal(await LedgerEntry.countDocuments({ refType: 'payment', refId: pm._id }), 0);
  step('amount mismatch flagged for review, nothing credited');

  const pf = await mkPending(50_000);
  assert.equal((await finalizePaystackPayment(pf.paystack.reference, gw(pf.paystack.reference, 50_000, 'failed'))).outcome, 'failed');
  assert.equal((await finalizePaystackPayment(pf.paystack.reference, gw(pf.paystack.reference, 50_000))).outcome, 'success');
  step('a failed attempt can still be completed by a later successful verify');

  const pc = await mkPending(120_000);
  const race = await Promise.allSettled(Array.from({ length: 4 }, () => finalizePaystackPayment(pc.paystack.reference, gw(pc.paystack.reference, 120_000))));
  assert.ok(race.every((r) => r.status === 'fulfilled'), JSON.stringify(race.filter((r) => r.status === 'rejected').map((r) => r.reason?.message)));
  assert.equal(await LedgerEntry.countDocuments({ refType: 'payment', refId: pc._id }), 1);
  assert.equal(race.filter((r) => r.value.outcome === 'success').length, 1);
  step('4 simultaneous webhook/verify calls produced exactly one credit');
  assert.equal((await reconcilePayer(A.selfPayerId)).ok, true); step('walk-in payer ledger reconciles');

  // ---------------------------------------------------------------- 3. corporate
  const corp = await createPayer({
    type: 'corporate', name: `Smoke Corp ${sfx}`, billingContact: { name: 'HR', email: 'hr@example.com' },
    creditLimitKobo: 1_000_000, paymentTermsDays: 30, billingCycle: 'monthly', tariffId: tariff._id,
    contract: { startsAt: new Date(Date.now() - 86_400_000), endsAt: new Date(Date.now() + 365 * 86_400_000), coveredServices: [], excludedServices: ['cosmetic'] },
  }, ctx);
  created.payers.push(corp._id);
  const B = await newPatient('Employee', tariff._id);
  const C = await newPatient('Outsider', tariff._id);
  await addCoverage(corp._id, { patientId: B._id, relationship: 'employee', employeeRef: 'E-1' }, ctx);
  await expectCode(openEncounter({ patientId: C._id, type: 'outpatient', payerId: corp._id }, ctx), 'NOT_COVERED');
  const encB = await openEncounter({ patientId: B._id, type: 'outpatient', payerId: corp._id }, ctx);
  await captureCharge({ encounterId: encB._id, serviceId: consult._id }, ctx);
  await captureCharge({ encounterId: encB._id, serviceId: lab._id }, ctx);
  assert.equal(await bal(corp._id), 750_000);
  await expectCode(captureCharge({ encounterId: encB._id, serviceId: lab._id, qty: 2 }, ctx), 'CREDIT_LIMIT_EXCEEDED');
  assert.equal(await bal(corp._id), 750_000);
  step('corporate: uncovered patient refused; charges within limit accepted; over-limit charge rejected');

  const ex = await expectCode(captureCharge({ encounterId: encB._id, serviceId: cosmetic._id }, ctx), 'SERVICE_NOT_COVERED');
  const cs = await captureCharge({ encounterId: encB._id, serviceId: cosmetic._id, payerId: B.selfPayerId }, ctx);
  assert.equal(String(cs.charge.payerId), String(B.selfPayerId)); assert.equal(await bal(B.selfPayerId), 800_000);
  assert.equal(await bal(corp._id), 750_000);
  step('contract exclusion blocked, then charged to the patient\'s own payer instead');

  await expectCode(closeEncounter(encB._id, {}, ctx), 'PAYMENT_REQUIRED'); // the self-pay cosmetic invoice
  const [invB] = await Invoice.find({ encounterId: encB._id, payerType: 'individual' }).lean();
  await recordManualPayment({ payerId: B.selfPayerId, amountKobo: 800_000, method: 'cash', invoiceId: invB._id }, ctx);
  await closeEncounter(encB._id, {}, ctx);
  const corpInv = await invoiceEncounter(encB._id, { payerId: corp._id }, ctx);
  assert.equal(corpInv.length, 1); assert.equal(corpInv[0].totalKobo, 750_000); assert.equal(corpInv[0].payerType, 'corporate');
  assert.ok(corpInv[0].dueAt > new Date(Date.now() + 29 * 86_400_000));
  assert.equal((await invoiceEncounter(encB._id, { payerId: corp._id }, ctx)).length, 0);
  step('corporate invoice issued with 30-day terms; running it twice creates no duplicate');

  // ---------------------------------------------------------------- 4. emergency + payer reassignment
  const D = await newPatient('Emergency', tariff._id);
  await addCoverage(corp._id, { patientId: D._id, relationship: 'employee' }, ctx);
  const encD = await openEncounter({ patientId: D._id, type: 'emergency' }, ctx);
  await captureCharge({ encounterId: encD._id, serviceId: consult._id }, ctx);
  assert.equal(await bal(D.selfPayerId), 500_000);
  const re = await reassignEncounterPayer(encD._id, { payerId: corp._id, reason: 'employer identified' }, ctx);
  assert.equal(re.moved.length, 1);
  assert.equal(await bal(D.selfPayerId), 0);
  assert.equal(await bal(corp._id), 1_250_000); // emergency may exceed the corporate limit
  assert.equal((await Charge.findById(re.moved[0].from).lean()).status, 'reversed');
  step('emergency: treated before billing; payer reassigned, charges moved and re-priced, emergency overrode the limit');

  await closeEncounter(encD._id, {}, ctx); // corporate charges wait for periodic invoicing; nothing self-pay is owed
  const encD2 = await openEncounter({ patientId: D._id, type: 'emergency' }, ctx);
  await captureCharge({ encounterId: encD2._id, serviceId: lab._id }, ctx);
  const closedD = await closeEncounter(encD2._id, {}, ctx);
  assert.equal(closedD.closeOverride.unpaidKobo, 250_000);
  step('emergency encounter can close with a balance owing (recorded, invoice stays open)');

  for (const id of [A.selfPayerId, B.selfPayerId, D.selfPayerId, corp._id]) {
    const r = await reconcilePayer(id); assert.equal(r.ok, true, JSON.stringify(r));
  }
  step('every payer touched by this test reconciles exactly with its ledger');
  console.log('\nAll billing checks passed.');
} finally {
  const pid = created.patients; const yid = created.payers;
  const raw = (n) => db.collection(n);
  await raw('ledgerentries').deleteMany({ payerId: { $in: yid } });
  await raw('payments').deleteMany({ payerId: { $in: yid } });
  await raw('paystackevents').deleteMany({ reference: { $in: created.refs } });
  await raw('invoices').deleteMany({ patientId: { $in: pid } });
  await raw('invoices').deleteMany({ payerId: { $in: yid } });
  await raw('charges').deleteMany({ patientId: { $in: pid } });
  await raw('encounters').deleteMany({ patientId: { $in: pid } });
  await raw('coverages').deleteMany({ $or: [{ patientId: { $in: pid } }, { payerId: { $in: yid } }] });
  await raw('payers').deleteMany({ _id: { $in: yid } });
  await raw('patients').deleteMany({ _id: { $in: pid } });
  await raw('tariffitems').deleteMany({ tariffId: { $in: created.tariffs } });
  await raw('tariffs').deleteMany({ _id: { $in: created.tariffs } });
  await raw('services').deleteMany({ _id: { $in: created.services } });
  // restore numbering so test runs leave no gaps in real hospital/invoice/receipt numbers
  const before = new Map(countersBefore.map((c) => [c._id, c.seq]));
  for (const c of await raw('counters').find().toArray()) {
    if (before.has(c._id)) await raw('counters').updateOne({ _id: c._id }, { $set: { seq: before.get(c._id) } });
    else await raw('counters').deleteOne({ _id: c._id });
  }
  await disconnectDB();
}
