import 'dotenv/config';
import { z } from 'zod';
import { ROLES } from './permissions.js';

// Treat empty strings in .env (e.g. `PAYSTACK_SECRET_KEY=`) as "not set".
const optional = (schema) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

const flag = (def) => z.enum(['true', 'false']).default(def).transform((v) => v === 'true');
const list = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);

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

  // Family cards: default maximum number of people (holder included) on one card
  FAMILY_CARD_MAX_MEMBERS: z.coerce.number().int().min(2).max(50).default(10),

  // Maker-checker: the person who requests an adjustment, refund or authorization may not approve it.
  // Set to 'true' ONLY on a single-user development machine.
  ALLOW_SELF_APPROVAL: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),

  // ---- Phase 4B ----
  // Cashiers must open a session (a till shift) before taking cash, POS or transfer payments or paying refunds.
  REQUIRE_CASHIER_SESSION: flag('true'),
  // A counted amount differing from the expected amount by more than this (kobo) flags the session for review.
  CASH_VARIANCE_ALERT_KOBO: z.coerce.number().int().min(0).default(0),

  // Notifications. 'log' providers send nothing (they only record), which is the safe default.
  NOTIFICATIONS_ENABLED: flag('true'),
  NOTIFY_EMAIL_PROVIDER: z.enum(['log', 'resend']).default('log'),
  NOTIFY_SMS_PROVIDER: z.enum(['log', 'termii']).default('log'),
  RESEND_API_KEY: optional(z.string().min(10)),
  EMAIL_FROM: optional(z.string().min(5).max(200)), // e.g. Hospital Billing <billing@yourhospital.com>
  TERMII_API_KEY: optional(z.string().min(10)),
  TERMII_SENDER_ID: optional(z.string().min(3).max(11)),

  // Overdue handling: reminder after each of these many days past due; suspend credit payers after N days (0 = never)
  OVERDUE_REMINDER_DAYS: z.string().default('1,7,14,30').transform((s) => list(s).map(Number))
    .refine((a) => a.length > 0 && a.every((n) => Number.isInteger(n) && n > 0 && n <= 365), 'must be a comma-separated list of whole days, e.g. 1,7,14,30'),
  OVERDUE_SUSPEND_AFTER_DAYS: z.coerce.number().int().min(0).max(365).default(30),

  // Roles that must use two-factor authentication (comma-separated), e.g. admin,finance_manager
  MFA_REQUIRED_ROLES: z.string().default('').transform(list)
    .refine((a) => a.every((r) => ROLES.includes(r)), `must be a comma-separated list of roles from: ${ROLES.join(', ')}`),
  // Key that encrypts authenticator secrets in the database. Set a dedicated one (32+ characters); falls back to JWT_SECRET.
  MFA_ENCRYPTION_KEY: optional(z.string().min(32)),

  // Protects the scheduled reconciliation endpoint (Vercel Cron sends it as a Bearer token)
  CRON_SECRET: optional(z.string().min(16)),
});

const checked = schema.superRefine((v, ctx) => {
  const need = (cond, path, message) => { if (cond) ctx.addIssue({ code: 'custom', path: [path], message }); };
  if (v.NOTIFY_EMAIL_PROVIDER === 'resend') {
    need(!v.RESEND_API_KEY, 'RESEND_API_KEY', 'is required when NOTIFY_EMAIL_PROVIDER=resend');
    need(!v.EMAIL_FROM, 'EMAIL_FROM', 'is required when NOTIFY_EMAIL_PROVIDER=resend');
  }
  if (v.NOTIFY_SMS_PROVIDER === 'termii') {
    need(!v.TERMII_API_KEY, 'TERMII_API_KEY', 'is required when NOTIFY_SMS_PROVIDER=termii');
    need(!v.TERMII_SENDER_ID, 'TERMII_SENDER_ID', 'is required when NOTIFY_SMS_PROVIDER=termii');
  }
});

const parsed = checked.safeParse(process.env);
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
