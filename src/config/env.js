import 'dotenv/config';
import { z } from 'zod';

// Treat empty strings in .env (e.g. `PAYSTACK_SECRET_KEY=`) as "not set".
const optional = (schema) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  MONGODB_URI: z
    .string()
    .min(1, 'is required')
    .refine((v) => v.startsWith('mongodb://') || v.startsWith('mongodb+srv://'), 'must start with mongodb:// or mongodb+srv://'),
  JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('8h'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(14).default(12),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  HOSPITAL_NUMBER_PREFIX: z.string().min(1).max(6).default('HN'),

  // Hospital details printed on invoices and receipts
  HOSPITAL_NAME: z.string().default('Hospital'),
  HOSPITAL_ADDRESS: z.string().default(''),
  HOSPITAL_PHONE: z.string().default(''),

  // Walk-in policy: 'after' = charges accumulate and must be paid before discharge;
  // 'before' = a deposit must cover each charge before the service is recorded.
  WALKIN_PAYMENT_POLICY: z.enum(['after', 'before']).default('after'),

  // Paystack (leave empty until you have keys; payment initiation returns 503 without it)
  PAYSTACK_SECRET_KEY: optional(z.string().min(10)),
  PAYSTACK_CALLBACK_URL: optional(z.string().url()),
  PAYSTACK_FALLBACK_EMAIL: optional(z.string().email()), // used when a payer has no email on file

  // Protects the scheduled reconciliation endpoint (Vercel Cron sends it as a Bearer token)
  CRON_SECRET: optional(z.string().min(16)),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Print field names and problems only, never values (they may be secrets).
  const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${lines}`);
}

export const env = {
  ...parsed.data,
  isProd: parsed.data.NODE_ENV === 'production',
  corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
};
