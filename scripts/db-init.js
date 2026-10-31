// Creates collections (required before multi-document transactions touch them) and builds indexes.
// Run once after setting MONGODB_URI, and again whenever indexes change: npm run db:init
import mongoose from 'mongoose';
import { connectDB, disconnectDB } from '../src/config/db.js';
import { Counter } from '../src/models/Counter.js';
import { User } from '../src/models/User.js';
import { Patient } from '../src/models/Patient.js';
import { Payer } from '../src/models/Payer.js';
import { Coverage } from '../src/models/Coverage.js';
import { LedgerEntry } from '../src/models/LedgerEntry.js';
import { AuditLog } from '../src/models/AuditLog.js';

await connectDB();
for (const Model of [Counter, User, Patient, Payer, Coverage, LedgerEntry, AuditLog]) {
  try {
    await Model.createCollection();
  } catch (err) {
    if (err.code !== 48) throw err; // 48 = collection already exists
  }
  await Model.syncIndexes();
  console.log(`ready: ${Model.collection.name}`);
}
console.log(`Database "${mongoose.connection.name}" is initialised.`);
await disconnectDB();
