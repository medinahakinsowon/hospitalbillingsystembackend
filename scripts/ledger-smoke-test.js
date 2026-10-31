// End-to-end check of the ledger against your real database: npm run test:ledger
// Creates a throwaway payer, exercises limits, idempotency, reversals and reconciliation, then cleans up.
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { connectDB, disconnectDB } from '../src/config/db.js';
import { Payer } from '../src/models/Payer.js';
import { LedgerEntry } from '../src/models/LedgerEntry.js';
import { postEntry, reverseLedgerEntry, reconcilePayer } from '../src/services/ledger.service.js';

await connectDB();
const payer = await Payer.create({
  type: 'corporate', code: `SMOKE-${Date.now()}`, name: 'SMOKE TEST (safe to delete)',
  creditLimitKobo: 100_000, enforceLimit: true,
});
const id = payer._id;
const key = (s) => `smoke:${id}:${s}`;
const bal = async () => (await Payer.findById(id).lean()).balanceKobo;
const step = (msg) => console.log(`ok  ${msg}`);

try {
  await postEntry({ payerId: id, type: 'charge', amountKobo: 60_000, idempotencyKey: key('c1') });
  assert.equal(await bal(), 60_000); step('charge within limit');

  await assert.rejects(
    postEntry({ payerId: id, type: 'charge', amountKobo: 50_000, idempotencyKey: key('c2') }),
    (e) => e.code === 'CREDIT_LIMIT_EXCEEDED'
  );
  assert.equal(await bal(), 60_000); step('charge over limit rejected, balance unchanged');

  const first = await postEntry({ payerId: id, type: 'payment', amountKobo: -20_000, idempotencyKey: key('p1') });
  const replay = await postEntry({ payerId: id, type: 'payment', amountKobo: -20_000, idempotencyKey: key('p1') });
  assert.equal(replay.duplicate, true);
  assert.equal(String(replay.entry._id), String(first.entry._id));
  assert.equal(await bal(), 40_000); step('payment applied once; replay with same key ignored');

  await assert.rejects(
    postEntry({ payerId: id, type: 'payment', amountKobo: 5_000, idempotencyKey: key('bad') }),
    (e) => e.code === 'INVALID_SIGN'
  ); step('wrong-sign payment rejected');

  // Concurrency: 5 simultaneous charges of 30,000 against 60,000 available. At most 2 may succeed.
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, (_, i) => postEntry({ payerId: id, type: 'charge', amountKobo: 30_000, idempotencyKey: key(`race${i}`) }))
  );
  const wins = results.filter((r) => r.status === 'fulfilled').length;
  assert.ok(wins <= 2, `limit breached: ${wins} charges succeeded`);
  assert.ok((await bal()) <= 100_000); step(`concurrent charges respected the limit (${wins} of 5 succeeded)`);

  const ctx = { actorId: null, actorRole: 'system', ip: 'local', userAgent: 'smoke-test' };
  await reverseLedgerEntry({ entryId: first.entry._id, reason: 'smoke test reversal' }, ctx);
  await reverseLedgerEntry({ entryId: first.entry._id, reason: 'smoke test reversal' }, ctx); // second call is a no-op
  assert.equal(await LedgerEntry.countDocuments({ payerId: id, type: 'reversal' }), 1); step('reversal posted once, never duplicated');

  await assert.rejects(LedgerEntry.updateOne({ payerId: id }, { amountKobo: 1 }), /append-only/);
  step('ledger entries cannot be updated through the app models');

  const rec = await reconcilePayer(id);
  assert.equal(rec.ok, true, JSON.stringify(rec)); step('cached balance matches the ledger exactly');
  console.log('\nAll ledger checks passed.');
} finally {
  // Raw collection access bypasses the append-only guard; only possible with a full-access DB user.
  await mongoose.connection.collection('ledgerentries').deleteMany({ payerId: id });
  await mongoose.connection.collection('payers').deleteOne({ _id: id });
  await disconnectDB();
}
