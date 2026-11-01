// End-to-end check of Phase 3 against your database: npm run test:cards
// Covers corporate consolidated invoicing, lump-sum payments, scheduled invoicing, contract renewal,
// family credit and prepaid cards, mode switching, capacity limits, statements, and service-aware eligibility.
// !! Run on a DEVELOPMENT database only. It creates throwaway records, removes them afterwards, and restores
//    the numbering counters.
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { connectDB, disconnectDB } from '../src/config/db.js';
import { Payer } from '../src/models/Payer.js';
import { Service } from '../src/models/Service.js';
import { Invoice } from '../src/models/Invoice.js';
import { Payment } from '../src/models/Payment.js';
import { createPatient } from '../src/services/patients.service.js';
import { createPayer, updatePayer, renewContract, changeFamilyCardMode, listExpiringContracts } from '../src/services/payers.service.js';
import { addCoverage, bulkAddCoverage, getEligibility } from '../src/services/coverage.service.js';
import { createTariff, setTariffPrices } from '../src/services/catalog.service.js';
import { openEncounter } from '../src/services/encounters.service.js';
import { captureCharge } from '../src/services/charges.service.js';
import { recordManualPayment, allocateExistingCredit } from '../src/services/payments.service.js';
import { invoicePayerPeriod, generateDueInvoices } from '../src/services/billing-cycle.service.js';
import { getAccountStatement, getPayerSummary } from '../src/services/statements.service.js';
import { reconcilePayer } from '../src/services/ledger.service.js';

if (env.isProd) { console.error('Refusing to run with NODE_ENV=production.'); process.exit(1); }
if (env.WALKIN_PAYMENT_POLICY !== 'after') { console.error("Set WALKIN_PAYMENT_POLICY=after in .env while running this test."); process.exit(1); }

await connectDB();
const db = mongoose.connection;
const ctx = { actorId: null, actorRole: 'admin', ip: 'local', userAgent: 'cards-smoke-test' };
const sfx = Date.now().toString(36).toUpperCase();
const created = { patients: [], payers: [], services: [], tariffs: [] };
const countersBefore = await db.collection('counters').find().toArray();
const step = (m) => console.log(`ok  ${m}`);
const bal = async (id) => (await Payer.findById(id).lean()).balanceKobo;
const expectCode = (p, code) => assert.rejects(p, (e) => { assert.equal(e.code, code, `expected ${code} but got ${e.code}: ${e.message}`); return true; });
const rnd = () => String(Math.floor(Math.random() * 1e7)).padStart(7, '0');
const soon = (ms) => new Date(Date.now() + ms);

async function person(label, tariffId) {
  const p = await createPatient({ firstName: label, lastName: `Card${sfx}`, dob: new Date('1988-03-05T00:00:00Z'), sex: 'male', phone: `0801${rnd()}` }, ctx);
  created.patients.push(p._id); created.payers.push(p.selfPayerId);
  await Payer.updateOne({ _id: p.selfPayerId }, { $set: { tariffId } });
  return p;
}
async function visit(patient, payerId, items) {
  const enc = await openEncounter({ patientId: patient._id, type: 'outpatient', payerId }, ctx);
  for (const [serviceId, qty] of items) await captureCharge({ encounterId: enc._id, serviceId, qty }, ctx);
  return enc;
}

try {
  // ---------------------------------------------------------------- setup
  const mk = async (code, name, department, category) => { const s = await Service.create({ code: `${code}-${sfx}`, name, department, category }); created.services.push(s._id); return s; };
  const consult = await mk('C-CONS', 'Consultation', 'consultation', 'consultation');
  const lab = await mk('C-LAB', 'Lab test', 'laboratory', 'lab-test');
  const tariff = await createTariff({ code: `C-${sfx}`, name: 'Cards test tariff' }, ctx);
  created.tariffs.push(tariff._id);
  await setTariffPrices(tariff._id, [{ serviceId: consult._id, priceKobo: 500_000 }, { serviceId: lab._id, priceKobo: 250_000 }], ctx);

  // ---------------------------------------------------------------- 1. corporate consolidated invoicing
  const corp = await createPayer({
    type: 'corporate', name: `Cards Corp ${sfx}`, billingContact: { name: 'HR Desk', email: 'hr@example.com' },
    creditLimitKobo: 5_000_000, paymentTermsDays: 30, billingCycle: 'monthly', tariffId: tariff._id,
    contract: { startsAt: soon(-86_400_000), endsAt: soon(365 * 86_400_000), coveredServices: [], excludedServices: [] },
  }, ctx);
  created.payers.push(corp._id);
  const E1 = await person('Employee1', tariff._id);
  const E2 = await person('Employee2', tariff._id);

  const bulk = await bulkAddCoverage(corp._id, [
    { hospitalNumber: E1.hospitalNumber, relationship: 'employee', employeeRef: 'S-001' },
    { hospitalNumber: E2.hospitalNumber, relationship: 'employee', employeeRef: 'S-002' },
    { hospitalNumber: 'HN-9999999', relationship: 'employee' },
    { hospitalNumber: E1.hospitalNumber, relationship: 'employee' },
  ], ctx);
  assert.deepEqual([bulk.added, bulk.notFound, bulk.alreadyCovered, bulk.failed], [2, 1, 1, 0], JSON.stringify(bulk));
  step('bulk member import: 2 added, 1 unknown hospital number, 1 duplicate reported per row');

  await visit(E1, corp._id, [[consult._id, 1], [lab._id, 1]]);
  await visit(E2, corp._id, [[consult._id, 2]]);
  assert.equal(await bal(corp._id), 1_750_000);

  const r1 = await invoicePayerPeriod(corp._id, { periodEnd: soon(60_000) }, ctx);
  assert.equal(r1.status, 'invoiced');
  const inv1 = r1.invoice;
  assert.equal(inv1.type, 'consolidated'); assert.equal(inv1.totalKobo, 1_750_000); assert.equal(inv1.lines.length, 3);
  assert.deepEqual([...new Set(inv1.lines.map((l) => l.employeeRef))].sort(), ['S-001', 'S-002']);
  assert.ok(inv1.lines.every((l) => l.patientName && l.hospitalNumber && l.encounterNo));
  assert.ok(inv1.dueAt > soon(29 * 86_400_000));
  assert.equal((await invoicePayerPeriod(corp._id, { periodEnd: soon(60_000) }, ctx)).status, 'nothing_to_invoice');
  step('consolidated invoice lists each employee\'s treatments with staff refs; running again finds nothing new');

  await captureCharge({ encounterId: (await openEncounter({ patientId: E1._id, type: 'outpatient', payerId: corp._id, allowSecondOpen: true }, ctx))._id, serviceId: lab._id }, ctx);
  const end2 = soon(120_000);
  const c1 = await invoicePayerPeriod(corp._id, { periodEnd: end2, claim: true }, ctx);
  const c2 = await invoicePayerPeriod(corp._id, { periodEnd: end2, claim: true }, ctx);
  assert.equal(c1.status, 'invoiced'); assert.equal(c2.status, 'already_done');
  assert.ok((await Payer.findById(corp._id).lean()).lastInvoicedThrough >= end2);
  step('periodic claim: the same period cannot be invoiced twice');

  const lump = await recordManualPayment({ payerId: corp._id, amountKobo: 2_500_000, method: 'transfer', externalRef: 'NIP-LUMP', autoAllocate: true }, ctx);
  assert.equal(lump.payment.allocations.length, 2); assert.equal(lump.payment.unallocatedKobo, 500_000);
  assert.equal((await Invoice.findById(inv1._id).lean()).status, 'paid'); assert.equal((await Invoice.findById(c1.invoice._id).lean()).status, 'paid');
  assert.equal(await bal(corp._id), -500_000);
  step('lump-sum transfer cleared two invoices oldest-first; 5,000.00 left as credit');

  const E2again = await openEncounter({ patientId: E2._id, type: 'outpatient', payerId: corp._id, allowSecondOpen: true }, ctx);
  await captureCharge({ encounterId: E2again._id, serviceId: consult._id }, ctx);
  const r3 = await invoicePayerPeriod(corp._id, { periodEnd: soon(180_000) }, ctx);
  assert.equal(r3.invoice.status, 'paid'); assert.equal(await bal(corp._id), 0);
  step('leftover credit applied automatically to the next invoice, which came out already paid');

  await captureCharge({ encounterId: E2again._id, serviceId: lab._id }, ctx);
  const r4 = await invoicePayerPeriod(corp._id, { periodEnd: soon(240_000) }, ctx);
  assert.equal(r4.invoice.status, 'issued');
  const topUp = await recordManualPayment({ payerId: corp._id, amountKobo: 250_000, method: 'transfer', externalRef: 'NIP-2' }, ctx);
  assert.equal(topUp.payment.unallocatedKobo, 250_000);
  const al = await allocateExistingCredit(topUp.payment._id, {}, ctx);
  assert.equal(al.unallocatedKobo, 0); assert.equal((await Invoice.findById(r4.invoice._id).lean()).status, 'paid');
  await expectCode(allocateExistingCredit(topUp.payment._id, {}, ctx), 'NOTHING_TO_ALLOCATE');
  step('credit on an existing payment can be applied to an open invoice afterwards, once only');

  const sum = await getPayerSummary(corp._id);
  assert.equal(sum.activeMembers, 2); assert.equal(sum.openInvoices.count, 0); assert.equal(sum.uninvoicedCharges.count, 0);
  assert.ok(sum.contract.daysRemaining >= 364); assert.equal(sum.payer.availableKobo, 5_000_000);
  step('account summary reports members, open invoices, uninvoiced charges and contract days left');

  // scheduled job (restricted to this payer; "now" is two months ahead so the last completed month covers today's charges)
  const t = new Date(); const future = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 2, 5, 12));
  await captureCharge({ encounterId: E2again._id, serviceId: lab._id }, ctx);
  const job1 = await generateDueInvoices({ payerIds: [corp._id], now: future });
  const job2 = await generateDueInvoices({ payerIds: [corp._id], now: future });
  assert.equal(job1.invoiced, 1, JSON.stringify(job1)); assert.equal(job2.notDue, 1, JSON.stringify(job2)); assert.equal(job2.invoiced, 0);
  step('scheduled job invoices the completed period once; a second run does nothing');

  const exp = await listExpiringContracts({ days: 500 });
  assert.ok(exp.some((p) => String(p._id) === String(corp._id)));
  await expectCode(renewContract(corp._id, { endsAt: soon(100 * 86_400_000), reason: 'test earlier date' }, ctx), 'NOT_AN_EXTENSION');
  const renewed = await renewContract(corp._id, { endsAt: soon(700 * 86_400_000), creditLimitKobo: 6_000_000, reason: 'annual renewal' }, ctx);
  assert.equal(renewed.creditLimitKobo, 6_000_000);
  step('expiring-contract list works; renewal must extend the date and records the new limit');
  assert.equal((await reconcilePayer(corp._id)).ok, true);

  // ---------------------------------------------------------------- 2. family credit card
  const H = await person('Holder', tariff._id);
  const M1 = await person('Member1', tariff._id);
  const M2 = await person('Member2', tariff._id);
  const card = await createPayer({
    type: 'family', holderPatientId: H._id, mode: 'credit', creditLimitKobo: 1_000_000, tariffId: tariff._id,
    guarantor: { name: 'Guarantor One', phone: '08011112222' }, maxMembers: 2,
  }, ctx);
  created.payers.push(card._id);
  assert.equal(card.mode, 'credit'); assert.equal(card.maxMembers, 2);
  await addCoverage(card._id, { patientId: M1._id, relationship: 'member' }, ctx);
  await expectCode(addCoverage(card._id, { patientId: M2._id, relationship: 'member' }, ctx), 'CARD_FULL');
  step('family card enforces its member capacity (holder counts as one)');

  await visit(M1, card._id, [[consult._id, 1]]);
  await visit(H, card._id, [[lab._id, 1]]);
  assert.equal(await bal(card._id), 750_000);
  const encM1 = await openEncounter({ patientId: M1._id, type: 'outpatient', payerId: card._id, allowSecondOpen: true }, ctx);
  await expectCode(captureCharge({ encounterId: encM1._id, serviceId: consult._id }, ctx), 'CREDIT_LIMIT_EXCEEDED');
  step('credit card: shared limit across members enforced');

  const stmt = await invoicePayerPeriod(card._id, { periodEnd: soon(60_000) }, ctx);
  assert.equal(stmt.invoice.type, 'statement'); assert.equal(new Set(stmt.invoice.lines.map((l) => String(l.patientId))).size, 2);
  await expectCode(changeFamilyCardMode(card._id, { mode: 'prepaid', reason: 'family request' }, ctx), 'OUTSTANDING_INVOICES');
  await recordManualPayment({ payerId: card._id, amountKobo: 750_000, method: 'cash', invoiceId: stmt.invoice._id }, ctx);
  const pre = await changeFamilyCardMode(card._id, { mode: 'prepaid', reason: 'family request' }, ctx);
  assert.equal(pre.mode, 'prepaid'); assert.equal(pre.creditLimitKobo, 0);
  await expectCode(invoicePayerPeriod(card._id, {}, ctx), 'PREPAID_CARD');
  step('statement issued to the card holder; switch to prepaid refused while owing, allowed once settled');

  await recordManualPayment({ payerId: card._id, amountKobo: 600_000, method: 'cash' }, ctx); // top-up
  assert.equal(await bal(card._id), -600_000);
  await captureCharge({ encounterId: encM1._id, serviceId: consult._id }, ctx);
  assert.equal(await bal(card._id), -100_000);
  await expectCode(captureCharge({ encounterId: encM1._id, serviceId: lab._id }, ctx), 'CREDIT_LIMIT_EXCEEDED');
  step('prepaid card: top-up creates a deposit, charges draw it down, overspending is refused');

  await updatePayer(card._id, { lowBalanceThresholdKobo: 150_000 }, ctx);
  assert.equal((await getPayerSummary(card._id)).lowBalance, true);
  const elig = await getEligibility(M1._id, { serviceId: consult._id });
  const cardOpt = elig.options.find((o) => o.payer.type === 'family');
  assert.equal(cardOpt.service.priceKobo, 500_000); assert.equal(cardOpt.availableKobo, 100_000); assert.equal(cardOpt.service.withinLimit, false);
  assert.equal(elig.options.find((o) => o.payer.type === 'individual').service.withinLimit, true);
  step('low-balance flag raised; eligibility shows price and that the card cannot afford the service');

  const st = await getAccountStatement(card._id, { from: soon(-86_400_000), to: soon(60_000) });
  assert.equal(st.openingKobo, 0); assert.equal(st.closingKobo, -100_000); assert.equal(st.closingKobo, await bal(card._id));
  assert.equal(st.totals.chargesKobo - st.totals.paymentsKobo, st.closingKobo - st.openingKobo);
  assert.ok(st.entries.every((e, i, a) => i === 0 || a[i - 1].seq < e.seq));
  step('account statement: opening + movements = closing, and closing equals the live balance');

  await expectCode(changeFamilyCardMode(card._id, { mode: 'credit', creditLimitKobo: 1_000_000, reason: 'back to credit' }, ctx), 'MODE_CHANGE_BLOCKED');
  const back = await changeFamilyCardMode(card._id, { mode: 'credit', creditLimitKobo: 1_000_000, carryOverDeposit: true, reason: 'back to credit' }, ctx);
  assert.equal(back.mode, 'credit'); assert.equal(back.availableKobo, 1_100_000);
  step('prepaid to credit: held deposit must be carried over explicitly, then counts toward the available limit');
  assert.equal((await reconcilePayer(card._id)).ok, true);

  console.log('\nAll card and corporate checks passed.');
} finally {
  const pid = created.patients; const yid = created.payers; const raw = (n) => db.collection(n);
  await raw('ledgerentries').deleteMany({ payerId: { $in: yid } });
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
