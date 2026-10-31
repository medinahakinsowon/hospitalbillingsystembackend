// Creates the first admin from SEED_ADMIN_* values in .env: npm run seed:admin
import bcrypt from 'bcryptjs';
import { env } from '../src/config/env.js';
import { connectDB, disconnectDB } from '../src/config/db.js';
import { User } from '../src/models/User.js';

const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
const pw = process.env.SEED_ADMIN_PASSWORD;
const name = process.env.SEED_ADMIN_NAME?.trim() || 'System Admin';
if (!email || !pw || pw.length < 10) {
  console.error('Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD (min 10 characters) in .env first.');
  process.exit(1);
}

await connectDB();
if (await User.findOne({ email })) {
  console.log(`A user with ${email} already exists. Nothing to do.`);
} else {
  await User.create({ name, email, role: 'admin', passwordHash: await bcrypt.hash(pw, env.BCRYPT_ROUNDS), mustChangePassword: true });
  console.log(`Admin created: ${email}. You will be asked to change the password at first login.`);
  console.log('Now remove SEED_ADMIN_PASSWORD from your .env.');
}
await disconnectDB();
